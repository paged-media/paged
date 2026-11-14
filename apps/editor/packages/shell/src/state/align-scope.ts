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

// WP4.4 — the Align panel's "Align to" and its KEY OBJECT, per editor.
//
// InDesign / Illustrator: with "Align to key object", the first object
// of the selection is the key; a click on another selected object makes
// that one the key, and the key never moves. The key is drawn with a
// thicker outline (selection-chrome.tsx). The state lives here, in the
// shell, because three places read it: the Align panel (which writes the
// scope), the canvas click path (which sets the key) and the selection
// chrome (which draws it).

import type { ElementId } from "@paged-media/client";

import { createValueStore, scoped, type ValueStore } from "./editor-scope";

/** What Align aligns against (`paged.align.objects`' `to`). */
export type AlignTo = "selection" | "keyObject" | "margins" | "page" | "spread";

export const ALIGN_TO: readonly AlignTo[] = [
  "selection",
  "keyObject",
  "margins",
  "page",
  "spread",
];

export interface AlignScopeState {
  to: AlignTo;
  /** The key the user clicked or chose; null = the selection's first
   *  object. */
  key: ElementId | null;
  /** An align control is hovered or focused: the canvas shows what it
   *  aligns against (the interaction spec's UXI-SEL-018, D-07: the
   *  preview reflects the reference). */
  previewing?: boolean;
}

/** This editor's Align scope and key object. */
export const ALIGN_SCOPE = scoped<ValueStore<AlignScopeState>>(
  "alignScope",
  () => createValueStore<AlignScopeState>({ to: "selection", key: null }),
);

const sameId = (a: ElementId, b: ElementId): boolean =>
  a.kind === b.kind && JSON.stringify(a.id) === JSON.stringify(b.id);

/** The key object in effect: the clicked key while it is still selected,
 *  else the selection's first object; null when the scope is not
 *  "keyObject" or fewer than two objects are selected. */
export function effectiveKeyObject(
  state: AlignScopeState,
  selection: readonly ElementId[],
): ElementId | null {
  if (state.to !== "keyObject" || selection.length < 2) return null;
  if (state.key && selection.some((id) => sameId(id, state.key!)))
    return state.key;
  return selection[0] ?? null;
}

/** A plain click on `hit` in key-object mode: makes it the key when it is
 *  one of two or more selected objects (answering true — the click must
 *  not reselect), else false. */
export function clickKeyObject(
  store: ValueStore<AlignScopeState>,
  selection: readonly ElementId[],
  hit: ElementId,
): boolean {
  const state = store.get();
  if (state.to !== "keyObject" || selection.length < 2) return false;
  const picked = selection.find((id) => sameId(id, hit));
  if (!picked) return false;
  store.set({ ...state, key: picked });
  return true;
}

export function isSameElement(a: ElementId, b: ElementId): boolean {
  return sameId(a, b);
}

/** Choose the key object explicitly (the Align panel's key list, D-07):
 *  `id` must be one of the selected objects; it also switches Align to
 *  "Key object". False when `id` is not selected. */
export function chooseKeyObject(
  store: ValueStore<AlignScopeState>,
  selection: readonly ElementId[],
  id: ElementId,
): boolean {
  const picked = selection.find((s) => sameId(s, id));
  if (!picked) return false;
  store.set({ ...store.get(), to: "keyObject", key: picked });
  return true;
}

/** An align control is (no longer) hovered or focused. */
export function previewAlignReference(
  store: ValueStore<AlignScopeState>,
  on: boolean,
): void {
  const state = store.get();
  if ((state.previewing ?? false) !== on)
    store.set({ ...state, previewing: on });
}

/** The arguments every align route sends with an alignment: what it aligns
 *  against and the key object, from this editor's Align scope (D-07: the
 *  control bar, the panel and a script agree). Addresses come from
 *  `addressOf`. */
export function alignScopeArgs(
  state: AlignScopeState,
  selection: readonly ElementId[],
  addressOf: (id: ElementId) => string,
): { to: AlignTo; key?: string } {
  const key = effectiveKeyObject(state, selection);
  return key ? { to: state.to, key: addressOf(key) } : { to: state.to };
}
