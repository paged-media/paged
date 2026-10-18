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

// W3.2 — the edit-context + object-type registries (closes plugin-draw
// B-02 + plugin-web W-03; the last two reserved plugin-api doors).
//
// An EDIT CONTEXT is a scoped editing mode entered on a double-click
// (or programmatically) over a matching element: it restricts the
// active tool-set, emphasizes a panel-set, shows a breadcrumb, narrows
// the write-scope to the context element's subtree, and pops on Esc.
// An OBJECT TYPE is a plugin-defined object (a webFrame is a rectangle
// with attached `x-paged:<id>` source metadata) whose double-click
// enters its edit context instead of descending into a group.
//
// The REGISTRY (this file) is the registration door + lookup; the STACK
// (state/edit-context-stack.tsx) owns the active-context lifecycle and
// chrome; the canvas double-click entry consults `resolveDoubleClick`
// to decide context-enter vs. group-descent.
//
// The contribution shapes are @paged-media/plugin-api's, used as is (one
// definition, ADR 226): a bundle's contract-typed registration IS the
// shell's type, and the shell adds no field of its own.

import type * as Api from "@paged-media/plugin-api";

import type { Disposable } from "./types";

/** What a matcher sees about a candidate element — a plain snapshot the
 *  host resolves once per double-click (kind, group ancestry, and the
 *  plugin's OWN `x-paged:<manifest id>` metadata envelope on the
 *  element, `null` when absent). The contract's `EditContextCandidate`. */
export type EditContextCandidate = Api.EditContextCandidate;

/** The live handle a context's onEnter/onExit hook receives. W-19 — the
 *  entering pointer (`pageId`, page-local `pagePoint`, frame-content
 *  `contentPoint` via `pageToContentPoint`, the K-1 pointer mapping) is
 *  filled on a POINTER entry only (the double-click; the Type-tool click
 *  on plugin-owned content); absent on a programmatic entry and on
 *  `onExit`. The contract's `EnteredEditContext`. */
export type EnteredEditContext = Api.EnteredEditContext;

/**
 * An edit-context CLAIM — the contract's `EditContextContribution`.
 *
 * What the shell does with the hooks (the contract documents the
 * plugin's side):
 *  · `onContentPointerDown/Move/Up` get frame-content coordinates (the
 *    shell inverts the frame's content transform).
 *  · `onContentKey` — declaring it IS the opt-in to the context's keys
 *    (Esc→`onCancel` and Enter→`onCommit` stay the shell's):
 *      · mid sub-edit (`isDirty()`) the context owns every key;
 *      · a printable key, Backspace or Delete is always consumed;
 *      · any other key — arrows, Tab, Enter (no `onCommit`), F2, Home,
 *        PageUp/Down, Cmd/Ctrl chords — is OFFERED: the context takes it
 *        by calling `e.preventDefault()`, and only then does the shell
 *        stop it reaching its own keybindings (Tab's chrome toggle,
 *        Cmd+D Place, …). A key the context leaves alone falls through,
 *        so Cmd+S still saves inside a sheet.
 *  · `onContentWheel` returning `true` stops the canvas pan; Cmd/Ctrl
 *    wheel is always the host's zoom and never reaches it.
 *  · `onUndo`/`onRedo` (ADR-012 Tier 1): while active, Cmd-Z /
 *    Cmd-Shift-Z + Edit/Undo route to the plugin's own op-log and the
 *    document stack is suspended until the modal exit (one batch = one
 *    document step); `false` = exhausted, with no mid-session
 *    fall-through. `undoLabel`/`redoLabel` name the Edit menu's step.
 *  · `metadataKey` is HOST-STAMPED by the SDK adapter: the shell
 *    resolves a candidate's `metadata` from that envelope before calling
 *    `matches`, so a plugin only ever sees its OWN namespace.
 *
 * `entry` is `"doubleClick"` only (the contract's product rule, K-13);
 * `resolveDoubleClick` still checks it, because a bundle built without
 * the types can pass anything.
 */
export type EditContextContribution = Api.EditContextContribution;

/** K-1 — a pointer delivered to the ACTIVE edit context in FRAME-CONTENT
 *  coordinates. The contract's `ContentPointerEvent`. */
export type ContentPointerEvent = Api.ContentPointerEvent;

/** A wheel delivered to the ACTIVE edit context. `delta` is the scroll
 *  in frame-content points (the screen delta divided by the camera scale,
 *  line/page modes normalised to pixels first), x right / y down — the
 *  same axes as `contentPoint`. The contract's `ContentWheelEvent`. */
export type ContentWheelEvent = Api.ContentWheelEvent;

/** A plugin-defined OBJECT TYPE: `matches` claims an element, a
 *  double-click on a match enters `editContextType` (instead of group
 *  descent), `metadataKey` is host-stamped as for edit contexts. The
 *  contract's `ObjectTypeContribution`. */
export type ObjectTypeContribution = Api.ObjectTypeContribution;

export type EditContextRegistryEvent =
  | { kind: "registered"; contribution: EditContextContribution }
  | { kind: "unregistered"; type: string };

export type ObjectTypeRegistryEvent =
  | { kind: "registered"; contribution: ObjectTypeContribution }
  | { kind: "unregistered"; type: string };

export interface EditContextRegistry extends Api.EditContextRegistry {
  register(contribution: EditContextContribution): Disposable;
  unregister(type: string): void;
  get(type: string): EditContextContribution | undefined;
  list(): EditContextContribution[];
  onChange(handler: (event: EditContextRegistryEvent) => void): Disposable;
}

export interface ObjectTypeRegistry extends Api.ObjectTypeRegistry {
  register(contribution: ObjectTypeContribution): Disposable;
  unregister(type: string): void;
  get(type: string): ObjectTypeContribution | undefined;
  list(): ObjectTypeContribution[];
  onChange(handler: (event: ObjectTypeRegistryEvent) => void): Disposable;
}

/** Default in-memory `EditContextRegistry` — keyed by `type` (a content-
 *  type name, not a namespaced id). Last-writer-wins on a duplicate type
 *  is rejected loudly (multi-plugin contention policy ships at P7; for
 *  now a collision is a bug). */
export function createEditContextRegistry(): EditContextRegistry {
  const byType = new Map<string, EditContextContribution>();
  const listeners = new Set<(e: EditContextRegistryEvent) => void>();
  const emit = (e: EditContextRegistryEvent) => {
    for (const fn of listeners) fn(e);
  };
  return {
    register(contribution) {
      if (byType.has(contribution.type)) {
        throw new Error(
          `EditContextRegistry: type "${contribution.type}" already registered`,
        );
      }
      byType.set(contribution.type, contribution);
      emit({ kind: "registered", contribution });
      return {
        dispose() {
          if (byType.delete(contribution.type)) {
            emit({ kind: "unregistered", type: contribution.type });
          }
        },
      };
    },
    unregister(type) {
      if (byType.delete(type)) emit({ kind: "unregistered", type });
    },
    get: (type) => byType.get(type),
    list: () => Array.from(byType.values()),
    onChange(handler) {
      listeners.add(handler);
      return { dispose: () => void listeners.delete(handler) };
    },
  };
}

/** Default in-memory `ObjectTypeRegistry`. */
export function createObjectTypeRegistry(): ObjectTypeRegistry {
  const byType = new Map<string, ObjectTypeContribution>();
  const listeners = new Set<(e: ObjectTypeRegistryEvent) => void>();
  const emit = (e: ObjectTypeRegistryEvent) => {
    for (const fn of listeners) fn(e);
  };
  return {
    register(contribution) {
      if (byType.has(contribution.type)) {
        throw new Error(
          `ObjectTypeRegistry: type "${contribution.type}" already registered`,
        );
      }
      byType.set(contribution.type, contribution);
      emit({ kind: "registered", contribution });
      return {
        dispose() {
          if (byType.delete(contribution.type)) {
            emit({ kind: "unregistered", type: contribution.type });
          }
        },
      };
    },
    unregister(type) {
      if (byType.delete(type)) emit({ kind: "unregistered", type });
    },
    get: (type) => byType.get(type),
    list: () => Array.from(byType.values()),
    onChange(handler) {
      listeners.add(handler);
      return { dispose: () => void listeners.delete(handler) };
    },
  };
}

/**
 * The double-click ROUTING decision — the heart of B-02/W-03. Given a
 * resolved candidate (the hit leaf + its group ancestry + this-plugin's
 * metadata, pre-resolved per registered plugin namespace), decide what a
 * double-click should do:
 *
 *   1. OBJECT TYPE first (W-03): if any registered object type
 *      `matches` the candidate AND names an `editContextType`, enter
 *      that context (a webFrame opens its source context, never group
 *      descent).
 *   2. EDIT CONTEXT by kind (B-02): else if any registered edit context
 *      with `entry: "doubleClick"` `matches` the candidate, enter it
 *      (a polygon enters vectorGraphic).
 *   3. GROUP DESCENT: else null — the caller falls through to the
 *      existing outermost-group-enter behaviour.
 *
 * Pure over the candidate + registry snapshots (no React, no client) —
 * unit-testable, and the same function the isolate path will call with a
 * cloned candidate.
 */
export interface DoubleClickResolution {
  /** The edit-context type to enter. */
  contextType: string;
  /** The matching edit-context contribution (for the stack push). */
  context: EditContextContribution;
  /** The object type that routed here, when via path 1. */
  objectType?: ObjectTypeContribution;
}

export function resolveDoubleClick(
  candidate: EditContextCandidate,
  editContexts: EditContextRegistry,
  objectTypes: ObjectTypeRegistry,
): DoubleClickResolution | null {
  // 1 — object type → its edit context (metadata-claimed objects).
  for (const ot of objectTypes.list()) {
    if (!ot.editContextType) continue;
    if (!ot.matches(candidate)) continue;
    const ctx = editContexts.get(ot.editContextType);
    if (ctx) {
      return { contextType: ctx.type, context: ctx, objectType: ot };
    }
  }
  // 2 — edit context by kind (double-click entry, kind-claimed).
  for (const ec of editContexts.list()) {
    if (ec.entry !== "doubleClick") continue;
    if (!ec.matches?.(candidate)) continue;
    return { contextType: ec.type, context: ec };
  }
  // 3 — no claim; group descent.
  return null;
}
