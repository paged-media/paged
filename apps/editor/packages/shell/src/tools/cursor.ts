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

// Concept 1 (toolbar) — the cursor contract.
//
// A tool carries a base cursor; its active gesture handler may
// override the cursor per pointer position (Pen near an anchor vs.
// over empty canvas) via `GestureHandler.cursorAt`. The "function of
// handler state" the concept describes is NOT a third CursorSpec
// variant — it's the handler returning one of the two concrete
// shapes below per position.
//
// The two types are the contract's (`@paged-media/plugin-api`, ADR 226):
// a bundle's tool and a built-in tool name cursors in one vocabulary.
// `resolveCursorCss` (the spec → `element.style.cursor` string) is the
// shell's.

import type * as Api from "@paged-media/plugin-api";

import { scoped, useScoped } from "../state/editor-scope";

/** CSS cursor keywords we use. Cheapest option — no asset, DPR-free. */
export type CssCursorToken = Api.CssCursorToken;

/**
 * A cursor is either a CSS keyword, or a custom SVG image (an inline
 * data-URI) with an explicit hotspot. SVG (not PNG) so it scales with
 * device pixel ratio. Keep the custom set small — most tools use a CSS
 * token.
 */
export type CursorSpec = Api.CursorSpec;

/**
 * Turn a `CursorSpec` into the value for `element.style.cursor`. SVG
 * becomes `url("…") hx hy, default`; a CSS spec is its token.
 * `undefined` → "default".
 */
export function resolveCursorCss(spec: CursorSpec | undefined): string {
  if (!spec) return "default";
  if (spec.kind === "css") return spec.token;
  return `url("${spec.src}") ${spec.hotspot.x} ${spec.hotspot.y}, default`;
}

// ── The cursor controller (IC9; editor ADR 1227) ───────
//
// The interaction specification's §14.3 (`UXI-OVR-010`): the canvas's
// cursor follows the session that holds the pointer, then the modifiers
// held, then what is under the pointer, then the tool in hand — in that
// order — and it is written in ONE place. Each source sets its layer;
// nothing else writes an element's cursor (the single-owner rule
// `cursor-write`, tooling/single-owner.json: `writeCursor` and
// `holdCursor` below are the only writes).

/** The layers, the one that wins first. */
export const CURSOR_LAYERS = ["session", "modifier", "hover", "tool"] as const;
export type CursorLayer = (typeof CURSOR_LAYERS)[number];

export interface CursorController {
  /** The element whose cursor this controller writes (null: none). */
  attach(element: HTMLElement | null): void;
  /** Set one layer's cursor, a CSS value; null clears the layer. */
  set(layer: CursorLayer, css: string | null): void;
  /** The cursor shown now: the first layer set, or the fallback. */
  current(): string;
  /** What each layer holds (tests, the trace). */
  layers(): Partial<Record<CursorLayer, string>>;
}

export function createCursorController(fallback = "default"): CursorController {
  const layers = new Map<CursorLayer, string>();
  let element: HTMLElement | null = null;
  const current = () => {
    for (const l of CURSOR_LAYERS) {
      const css = layers.get(l);
      if (css) return css;
    }
    return fallback;
  };
  const apply = () => {
    if (element) writeCursor(element, current());
  };
  return {
    attach(next) {
      element = next;
      apply();
    },
    set(layer, css) {
      if ((layers.get(layer) ?? null) === css) return;
      if (css) layers.set(layer, css);
      else layers.delete(layer);
      apply();
    },
    current,
    layers: () => Object.fromEntries(layers),
  };
}

/** The canvas's cursor controller, one per editor (its fallback is the
 *  canvas's open hand). */
export const CURSOR_CONTROLLER = scoped<CursorController>(
  "cursorController",
  () => createCursorController("grab"),
);

/** This editor's cursor controller. */
export function useCursorController(): CursorController {
  return useScoped(CURSOR_CONTROLLER);
}

/** Write `css` as `element`'s cursor; null clears it. `important` outranks
 *  the cursors the chrome's own subtrees set. One of the two writes. */
export function writeCursor(
  element: HTMLElement,
  css: string | null,
  important = false,
): void {
  if (css === null) element.style.removeProperty("cursor");
  else element.style.setProperty("cursor", css, important ? "important" : "");
}

/** Show `css` on `element` over everything below it (a mode that owns
 *  every press: a loaded thread, an armed placement) until the returned
 *  function puts back what was there. The other write. */
export function holdCursor(element: HTMLElement, css: string): () => void {
  const previous = element.style.getPropertyValue("cursor");
  const priority = element.style.getPropertyPriority("cursor");
  writeCursor(element, css, true);
  return () => {
    if (previous) writeCursor(element, previous, priority === "important");
    else writeCursor(element, null);
  };
}
