/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// One Escape (editor ADR 1207, the interaction specification's §12.1).
//
// Escape used to be answered by about ten listeners, each deciding for
// itself whether the press was its own: one press could cancel a drag and
// climb a group, or close a dialog and leave the text. The arbiter is the
// one listener per editor (a window capture listener through
// `listenForEditorKeys`, so it hears only its own editor's keys, ADR 277).
// Whoever answers Escape registers a HANDLER with a tier and an `isActive`;
// at a press the arbiter walks the tiers in the spec's order and the FIRST
// active handler resolves it. No other handler sees that press.
//
//   ime            an input method is composing: the press is the IME's
//   menu           an open menu or popover
//   modal          a modal dialog
//   palette        the command palette
//   layer          (built in) any other open layer the DOM shows: a Radix
//                  menu, popover, select or dialog with no handler of its own
//   gesture        an active gesture (a scrub, a canvas drag that says so)
//   focused        (built in) the focused control owns the key: a field, a
//                  composite widget, a frame surface (ADR 234's rule)
//   transient      a loaded cursor (threading), an armed placement, a guide
//                  drag, path editing
//   pointer        (built in) a pointer held down on the canvas: a gesture
//                  that has no handler here yet (the viewport's drags, the
//                  gesture spine's), which the canvas's own listener
//                  cancels. After the transient modes, because a loaded
//                  cursor or an armed placement owns the press it drags
//   context-dirty  a dirty edit context resolves its sub-edit
//   context        a clean edit context pops one level
//   text           a caret in a story leaves the text for its frame
//   group          an entered group climbs one level (ADR 250)
//   selection      the selection is cleared
//
// Nothing active: the press is nobody's, and the arbiter leaves it alone.
//
// A handler's `resolve` either HANDLES the press (the arbiter then prevents
// its default and stops its propagation, so no later listener acts on it
// too) or DEFERS it ("defer"): the owner's own listener, later in the
// event's path, does the work (a Radix menu's document listener, the
// canvas's own gesture listener) and the arbiter only guarantees that no
// other handler acts. Listeners that have not joined yet (the viewport's
// gesture cancel, the gesture spine, path editing: track IC) can ask
// `resolutionOf(event)` whether a handler already took the press.

import { useEffect, useEffectEvent } from "react";

import { canvasKeyYields, isComposingKey } from "../focus/key-ownership";
import { scoped, useScoped, type EditorScope } from "../state/editor-scope";
import { editorRootOf, listenForEditorKeys } from "../state/editor-root";

/** Is `event` an Escape press? The arbiter owns those: a key listener that
 *  handles every other key skips them with this. */
export function isEscapeKey(event: Pick<KeyboardEvent, "key">): boolean {
  return event.key === "Escape";
}

/** The tiers, in the order a press visits them (§12.1). */
export const ESCAPE_TIERS = [
  "ime",
  "menu",
  "modal",
  "palette",
  "layer",
  "gesture",
  "focused",
  "transient",
  "pointer",
  "context-dirty",
  "context",
  "text",
  "group",
  "selection",
] as const;
export type EscapeTier = (typeof ESCAPE_TIERS)[number];

/** What a handler did with the press: handled it (the default), or left
 *  it to its owner's own listener later in the event's path. */
export type EscapeOutcome = "handled" | "defer";

export interface EscapeHandler {
  /** Who answers, for diagnostics and tests (`paged.textEditing`, …). */
  id: string;
  tier: Exclude<EscapeTier, "ime">;
  /** Whether this handler answers the press now. Read at the press. */
  isActive(event: KeyboardEvent): boolean;
  /** Resolve the press. Returns "defer" when the owner's own listener
   *  does the work; anything else counts as handled. */
  resolve(event: KeyboardEvent): EscapeOutcome | void;
}

/** Which handler resolved a press. */
export interface EscapeResolution {
  id: string;
  tier: EscapeTier;
  outcome: EscapeOutcome;
}

export interface EscapeArbiter {
  /** Add a handler; returns the removal. */
  register(handler: EscapeHandler): () => void;
  /** The handler that would resolve `event` now, without resolving it. */
  winner(event: KeyboardEvent): EscapeResolution | null;
  /** How the arbiter resolved `event`, once it has seen it (null: nobody
   *  answered, or the arbiter has not seen it). */
  resolutionOf(event: Event): EscapeResolution | null;
  /** The last press's resolution (null: nobody answered it). */
  last(): EscapeResolution | null;
  /** Is a pointer held down on the canvas of this editor? */
  pointerHeld(): boolean;
}

const TIER_RANK = new Map<EscapeTier, number>(
  ESCAPE_TIERS.map((tier, i) => [tier, i]),
);

/** The canvas viewport: a pointer held down on it is a canvas gesture. */
const VIEWPORT_SELECTOR =
  '[data-canvas-surface="viewport"], [data-paged-viewport]';

/** An open layer: a menu, a dialog, a popover. A tooltip is not one: it
 *  is a hint that leaves on its own, and Escape is never spent on it. */
const OPEN_LAYER_SELECTOR = [
  '[role="menu"]:not([data-state="closed"])',
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  "[data-radix-popper-content-wrapper]",
].join(",");

function openLayerIn(scope: EditorScope): boolean {
  if (typeof document === "undefined") return false;
  const root = editorRootOf(scope) ?? document.body;
  for (const el of root.querySelectorAll(OPEN_LAYER_SELECTOR)) {
    if (el.querySelector('[role="tooltip"]')) continue;
    if (el.getAttribute("role") === "tooltip") continue;
    return true;
  }
  return false;
}

function createArbiter(scope: EditorScope): EscapeArbiter {
  const handlers: EscapeHandler[] = [];
  const resolved = new WeakMap<Event, EscapeResolution>();
  let lastResolution: EscapeResolution | null = null;
  let held = false;
  let offs: Array<() => void> = [];

  const ordered = () =>
    [...handlers].sort(
      (a, b) => (TIER_RANK.get(a.tier) ?? 0) - (TIER_RANK.get(b.tier) ?? 0),
    );

  const find = (event: KeyboardEvent): EscapeHandler | null => {
    for (const h of ordered()) {
      try {
        if (h.isActive(event)) return h;
      } catch {
        // A handler that cannot answer is not active.
      }
    }
    return null;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!isEscapeKey(event)) return;
    // Seen twice (a listener re-dispatch): the first answer stands.
    if (resolved.has(event)) return;
    if (isComposingKey(event)) {
      record(event, { id: "ime", tier: "ime", outcome: "defer" });
      return;
    }
    const handler = find(event);
    if (!handler) {
      lastResolution = null;
      return;
    }
    let outcome: EscapeOutcome = "handled";
    try {
      outcome = handler.resolve(event) === "defer" ? "defer" : "handled";
    } finally {
      record(event, { id: handler.id, tier: handler.tier, outcome });
    }
    if (outcome === "handled") {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const record = (event: Event, r: EscapeResolution) => {
    resolved.set(event, r);
    lastResolution = r;
  };

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Element | null;
    if (target?.closest?.(VIEWPORT_SELECTOR)) held = true;
  };
  const release = () => {
    held = false;
  };
  const onPointerMove = (event: PointerEvent) => {
    // A release outside the window never sends pointerup; the next move
    // with no button down says the press is over.
    if (held && event.buttons === 0) held = false;
  };

  const listen = () => {
    if (offs.length > 0) return;
    offs = [
      listenForEditorKeys(scope, "keydown", onKeyDown, true),
      listenForEditorKeys(scope, "pointerdown", onPointerDown, true),
      listen0("pointerup", release, true),
      listen0("pointercancel", release, true),
      listen0("pointermove", onPointerMove, true),
      // The window's own blur (Cmd+Tab away), not a control's: a control's
      // blur does not bubble, and in the capture phase every focus move
      // mid-press would end the press.
      listen0("blur", release, false),
    ];
  };
  const unlisten = () => {
    for (const off of offs) off();
    offs = [];
    held = false;
  };

  const arbiter: EscapeArbiter = {
    register(handler) {
      handlers.push(handler);
      listen();
      return () => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
        if (handlers.length === BUILT_INS) unlisten();
      };
    },
    winner(event) {
      if (isComposingKey(event))
        return { id: "ime", tier: "ime", outcome: "defer" };
      const h = find(event);
      return h ? { id: h.id, tier: h.tier, outcome: "handled" } : null;
    },
    resolutionOf: (event) => resolved.get(event) ?? null,
    last: () => lastResolution,
    pointerHeld: () => held,
  };

  // Built in: an open layer with no handler of its own (Radix closes it
  // from its own document listener), the focused control's keys, and a
  // pointer held on the canvas (the canvas cancels its own gesture).
  handlers.push(
    {
      id: "paged.openLayer",
      tier: "layer",
      isActive: () => openLayerIn(scope),
      resolve: () => "defer",
    },
    {
      id: "paged.focusedControl",
      tier: "focused",
      isActive: (e) => canvasKeyYields(e),
      resolve: () => "defer",
    },
    {
      id: "paged.canvasPointer",
      tier: "pointer",
      isActive: () => held,
      resolve: () => "defer",
    },
  );
  return arbiter;
}

/** The built-in handlers' count: the arbiter stops listening when only
 *  they are left. */
const BUILT_INS = 3;

/** A window listener that hears every event of `type` (the release of a
 *  press ends it wherever it lands, in whichever editor). */
function listen0<K extends keyof WindowEventMap>(
  type: K,
  listener: (event: WindowEventMap[K]) => void,
  capture: boolean,
): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(type, listener, capture);
  return () => window.removeEventListener(type, listener, capture);
}

const ESCAPE_ARBITER = scoped("escapeArbiter", createArbiter);

/** `scope`'s Escape arbiter. */
export function escapeArbiterOf(scope: EditorScope): EscapeArbiter {
  return scope.get(ESCAPE_ARBITER);
}

/** This component's editor's Escape arbiter. */
export function useEscapeArbiter(): EscapeArbiter {
  return useScoped(ESCAPE_ARBITER);
}

export interface EscapeHandlerSpec {
  id: string;
  tier: EscapeHandler["tier"];
  /** Registered only while true (default true). */
  enabled?: boolean;
  isActive(event: KeyboardEvent): boolean;
  resolve(event: KeyboardEvent): EscapeOutcome | void;
}

/**
 * Register an Escape handler for as long as the component is mounted
 * (and `enabled`). `isActive` and `resolve` are read from the latest
 * render when a press arrives.
 */
export function useEscapeHandler(spec: EscapeHandlerSpec): void {
  const arbiter = useEscapeArbiter();
  const isActive = useEffectEvent((e: KeyboardEvent) => spec.isActive(e));
  const resolve = useEffectEvent((e: KeyboardEvent) => spec.resolve(e));
  const { id, tier } = spec;
  const enabled = spec.enabled !== false;
  useEffect(() => {
    if (!enabled) return;
    return arbiter.register({
      id,
      tier,
      isActive: (e) => isActive(e),
      resolve: (e) => resolve(e),
    });
  }, [arbiter, id, tier, enabled]);
}
