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

// B4 — View-menu toggles that an OVERLAY reads and a COMMAND flips.
//
// A store in the editor's scope rather than a context: the writer is a
// command (its handler gets the editor, and so the scope) and the reader
// is an overlay mounted inside the canvas's SVG. Threading a boolean
// between them through React state would mean a provider that exists for
// one value and renders nothing, and the value has to survive a dock
// close/reopen, which the scope (the editor's lifetime) does for free.
// Per editor (plan task E1): two editors on a page have their own View
// menus.
//
// `useSyncExternalStore` rather than an event + local state, because the
// overlay must re-render the instant the command flips the flag — and
// that is exactly the hook's contract. Getting this wrong is not
// hypothetical: Phase E shipped 0 accelerators because a `useMemo` was
// keyed on a registry whose identity never changes while its contents
// grow. A subscription that the store itself notifies cannot drift that
// way.

import { scoped, type EditorScope } from "./editor-scope";

export type ViewToggle =
  | "textThreads"
  | "snapToPoints"
  | "headingAnchors"
  | "dataMarkers"
  // Editor ADR 287 — the screen modes and the grids / snapping of the
  // View menu. `outline` / `overprintPreview` / `pixelPreview` resolve to
  // ONE engine view mode (`viewModeOf`); Overprint Preview and Pixel
  // Preview exclude each other, as in Illustrator.
  | "outline"
  | "overprintPreview"
  | "pixelPreview"
  | "showGrid"
  | "pixelGrid"
  | "snapToGrid"
  | "snapToPixel"
  | "smartGuides";

type Listener = () => void;

const DEFAULTS: Readonly<Record<ViewToggle, boolean>> = {
  // Off by default. The thread lines are a diagnostic view, not chrome
  // the document always wears — InDesign hides them behind
  // View ▸ Extras ▸ Show Text Threads for the same reason.
  textThreads: false,
  // ON by default, as Illustrator's Snap to Point and Smart Guides are:
  // the Pen and Direct Selection snap to the page's edges and centre and
  // to anchors (RFI C-68). Read by the tools, not an overlay.
  snapToPoints: true,
  // Off by default. Where each heading anchor resolved (the engine's
  // Tier 3 numbering) is a diagnostic of the resolver, not something the
  // page carries: drawn always, every document with a heading wore a
  // green badge nobody asked for.
  headingAnchors: false,
  // Off by default. The data field markers (editor ADR 291) show which
  // frames a binding places content in and its sync state: InDesign data
  // tools keep such markers behind a View option too, and they never print.
  dataMarkers: false,
  // Preview is the default screen: overprints knock out, as Illustrator's
  // and InDesign's screens draw them until Overprint Preview is on.
  outline: false,
  overprintPreview: false,
  pixelPreview: false,
  // The document grid is hidden and not snapped to by default (both
  // apps); the pixel grid shows at 600 % and above once Pixel Preview is
  // on, Illustrator's "Show Pixel Grid" default.
  showGrid: false,
  pixelGrid: true,
  snapToGrid: false,
  snapToPixel: false,
  // On by default, as Illustrator's Smart Guides are.
  smartGuides: true,
};

/** The pairs that exclude each other: turning one on turns the other off. */
const EXCLUSIVE: Partial<Record<ViewToggle, ViewToggle>> = {
  overprintPreview: "pixelPreview",
  pixelPreview: "overprintPreview",
};

/** The engine's view mode (wire `ViewMode`) the toggles add up to. */
export type ViewModeName =
  | "preview"
  | "outline"
  | "overprintPreview"
  | "pixelPreview";

export function viewModeOf(scope: EditorScope): ViewModeName {
  const state = scope.get(TOGGLES).state;
  if (state.outline) return "outline";
  if (state.pixelPreview) return "pixelPreview";
  if (state.overprintPreview) return "overprintPreview";
  return "preview";
}

const TOGGLES = scoped("viewToggles", () => ({
  state: { ...DEFAULTS } as Record<ViewToggle, boolean>,
  listeners: new Set<Listener>(),
}));

const notify = (scope: EditorScope): void => {
  for (const l of [...scope.get(TOGGLES).listeners]) l();
};

export function getViewToggle(scope: EditorScope, which: ViewToggle): boolean {
  return scope.get(TOGGLES).state[which];
}

export function setViewToggle(
  scope: EditorScope,
  which: ViewToggle,
  on: boolean,
): void {
  const { state } = scope.get(TOGGLES);
  if (state[which] === on) return;
  state[which] = on;
  const other = EXCLUSIVE[which];
  if (on && other) state[other] = false;
  notify(scope);
}

export function toggleViewToggle(
  scope: EditorScope,
  which: ViewToggle,
): boolean {
  setViewToggle(scope, which, !getViewToggle(scope, which));
  return getViewToggle(scope, which);
}

export function subscribeViewToggles(
  scope: EditorScope,
  listener: Listener,
): () => void {
  const { listeners } = scope.get(TOGGLES);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reset to the defaults — tests only, so one spec's toggle cannot leak
 *  into the next. (The specs share a page instance per file; a leaked
 *  value would make the next test pass for the wrong reason.) */
export function resetViewToggles(scope: EditorScope): void {
  const { state } = scope.get(TOGGLES);
  let changed = false;
  for (const k of Object.keys(state) as ViewToggle[]) {
    if (state[k] !== DEFAULTS[k]) {
      state[k] = DEFAULTS[k];
      changed = true;
    }
  }
  if (changed) notify(scope);
}
