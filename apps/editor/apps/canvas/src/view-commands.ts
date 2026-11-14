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

// Editor ADR 287 — the View menu's screen modes, grids, snapping and
// view rotation (WP4.7, over the engine's view modes and snapping, WP2.5).
//
// The toggles live in the editor's scope (`view-toggles.ts`), so a menu
// tick, the canvas and the engine (`ViewSettingsSync`) read one value; none
// of them is a document change, so none is an undo step. Rotate View turns
// the camera (`rotateCameraAbout`) — the handlers come from the canvas
// integration, which owns the camera.
//
// Chords (Illustrator's, checked against the editor's keymap and the
// module registers in modules/draw/CLAUDE.md — all free):
//   Outline ⌘Y · Overprint Preview ⌥⇧⌘Y · Pixel Preview ⌥⌘Y ·
//   Show Grid ⌘' · Snap to Grid ⇧⌘' · Smart Guides ⌘U ·
//   Reset Rotation ⇧⌘1. Snap to Pixel, Pixel Grid and the rotation
//   steps have no chord, as in Illustrator.

import {
  getViewToggle,
  isProofMode,
  scopeOf,
  toggleViewToggle,
  UNSUPPORTED_AIDS,
  type EditingAidToggle,
  type PagedEditor,
  type ViewToggle,
} from "@paged-media/shell";
import type {
  CommandContribution,
  KeybindingContribution,
  MenuItemContribution,
} from "@paged-media/shell";
import { defineMessages, t } from "@paged-media/strings";

const M = defineMessages("app.viewCommands", {
  outline: "Outline view",
  overprintPreview: "Overprint Preview",
  pixelPreview: "Pixel Preview",
  showGrid: "Show grid",
  snapToGrid: "Snap to grid",
  pixelGrid: "Show pixel grid",
  snapToPixel: "Snap to pixel",
  smartGuides: "Smart guides",
  rotateClockwise: "Rotate view 15° clockwise",
  rotateCounterclockwise: "Rotate view 15° counterclockwise",
  resetRotation: "Reset view rotation",
  preferences: "Guides & grid preferences…",
  frameEdges: "Show frame edges",
  marginsColumns: "Show margins and columns",
  guides: "Show ruler guides",
  baselineGrid: "Show baseline grid",
  oversetMarkers: "Show overset markers",
  hiddenCharacters: "Show hidden characters",
  nonprinting: "Show nonprinting items",
  notSupported: "{aid} (not supported yet)",
});

defineMessages("menu", {
  // "Outline" alone is paged.draw's Path ▸ Outline (menu keys are global).
  "Outline view": "Outline view",
  "Overprint Preview": "Overprint Preview",
  "Pixel Preview": "Pixel Preview",
  "Show grid": "Show grid",
  "Snap to grid": "Snap to grid",
  "Show pixel grid": "Show pixel grid",
  "Snap to pixel": "Snap to pixel",
  "Smart guides": "Smart guides",
  "Rotate view": "Rotate view",
  "15° clockwise": "15° clockwise",
  "15° counterclockwise": "15° counterclockwise",
  "Reset rotation": "Reset rotation",
  "Guides & grid preferences…": "Guides & grid preferences…",
  "Editing aids": "Editing aids",
  "Frame edges": "Frame edges",
  "Margins and columns": "Margins and columns",
  "Ruler guides": "Ruler guides",
  "Baseline grid": "Baseline grid",
  "Text threads": "Text threads",
  "Overset markers": "Overset markers",
  "Hidden characters": "Hidden characters",
  "Nonprinting items": "Nonprinting items",
  "Data bindings": "Data bindings",
  "Proof view": "Proof view",
});

export const PAGED_VIEW_OUTLINE = "paged.view.outline";
export const PAGED_VIEW_OVERPRINT_PREVIEW = "paged.view.overprintPreview";
export const PAGED_VIEW_PIXEL_PREVIEW = "paged.view.pixelPreview";
export const PAGED_VIEW_SHOW_GRID = "paged.view.showGrid";
export const PAGED_VIEW_SNAP_TO_GRID = "paged.view.snapToGrid";
export const PAGED_VIEW_PIXEL_GRID = "paged.view.pixelGrid";
export const PAGED_VIEW_SNAP_TO_PIXEL = "paged.view.snapToPixel";
export const PAGED_VIEW_SMART_GUIDES = "paged.view.smartGuides";
export const PAGED_VIEW_ROTATE_CW = "paged.view.rotateClockwise";
export const PAGED_VIEW_ROTATE_CCW = "paged.view.rotateCounterclockwise";
export const PAGED_VIEW_RESET_ROTATION = "paged.view.resetRotation";
export const PAGED_VIEW_PREFERENCES = "paged.view.guidesAndGridPreferences";

// Editor ADR "Editing aids and Proof view" — one command per editing aid,
// each flipping its remembered toggle (`view-toggles.ts`). Text threads
// keeps its older id (app-commands.ts).
export const PAGED_VIEW_TOGGLE_FRAME_EDGES = "paged.view.toggleFrameEdges";
export const PAGED_VIEW_TOGGLE_MARGINS_COLUMNS =
  "paged.view.toggleMarginsColumns";
export const PAGED_VIEW_TOGGLE_GUIDES = "paged.view.toggleGuides";
export const PAGED_VIEW_TOGGLE_BASELINE_GRID = "paged.view.toggleBaselineGrid";
export const PAGED_VIEW_TOGGLE_OVERSET_MARKERS =
  "paged.view.toggleOversetMarkers";
export const PAGED_VIEW_TOGGLE_HIDDEN_CHARACTERS =
  "paged.view.toggleHiddenCharacters";
export const PAGED_VIEW_TOGGLE_NONPRINTING = "paged.view.toggleNonprinting";

export const EDITING_AID_COMMANDS: Readonly<Record<EditingAidToggle, string>> =
  {
    frameEdges: PAGED_VIEW_TOGGLE_FRAME_EDGES,
    marginsColumns: PAGED_VIEW_TOGGLE_MARGINS_COLUMNS,
    guides: PAGED_VIEW_TOGGLE_GUIDES,
    baselineGrid: PAGED_VIEW_TOGGLE_BASELINE_GRID,
    textThreads: "paged.view.toggleTextThreads",
    oversetMarkers: PAGED_VIEW_TOGGLE_OVERSET_MARKERS,
    hiddenCharacters: PAGED_VIEW_TOGGLE_HIDDEN_CHARACTERS,
    nonprinting: PAGED_VIEW_TOGGLE_NONPRINTING,
    // Data ADR 566 — the binding badges keep their older id (app-commands).
    dataMarkers: "paged.view.toggleDataMarkers",
  };

/** The aids' rows of View ▸ Editing aids, in the control's order. */
const AID_ROWS: ReadonlyArray<[EditingAidToggle, string]> = [
  ["frameEdges", "Frame edges"],
  ["marginsColumns", "Margins and columns"],
  ["guides", "Ruler guides"],
  ["baselineGrid", "Baseline grid"],
  ["textThreads", "Text threads"],
  ["oversetMarkers", "Overset markers"],
  ["hiddenCharacters", "Hidden characters"],
  ["nonprinting", "Nonprinting items"],
  ["dataMarkers", "Data bindings"],
];

/** Proof view is the Preview screen mode (InDesign's W, the shell's
 *  `paged.view.toggleScreenPreview`). */
const PROOF_VIEW_COMMAND = "paged.view.toggleScreenPreview";

/** The step of the Rotate View commands, degrees. */
export const ROTATE_VIEW_STEP_DEG = 15;

/** What the commands need from the canvas integration. */
export interface ViewCommandHandlers {
  /** Turn the view by `deg` degrees (clockwise positive) about the
   *  viewport's centre. */
  rotateView: (deg: number) => void;
  /** Turn the view back upright, about the viewport's centre. */
  resetRotation: () => void;
  /** Open the Guides & Grid preferences. */
  openPreferences: (paged: unknown) => void;
}

const flip = (toggle: ViewToggle) => (paged: unknown) => {
  toggleViewToggle(scopeOf(paged), toggle);
};

export function buildViewCommands(
  handlers: ViewCommandHandlers,
): CommandContribution[] {
  return [
    {
      id: PAGED_VIEW_OUTLINE,
      title: t(M.outline),
      category: "View",
      handler: flip("outline"),
    },
    {
      id: PAGED_VIEW_OVERPRINT_PREVIEW,
      title: t(M.overprintPreview),
      category: "View",
      handler: flip("overprintPreview"),
    },
    {
      id: PAGED_VIEW_PIXEL_PREVIEW,
      title: t(M.pixelPreview),
      category: "View",
      handler: flip("pixelPreview"),
    },
    {
      id: PAGED_VIEW_SHOW_GRID,
      title: t(M.showGrid),
      category: "View",
      handler: flip("showGrid"),
    },
    {
      id: PAGED_VIEW_SNAP_TO_GRID,
      title: t(M.snapToGrid),
      category: "View",
      handler: flip("snapToGrid"),
    },
    {
      id: PAGED_VIEW_PIXEL_GRID,
      title: t(M.pixelGrid),
      category: "View",
      handler: flip("pixelGrid"),
    },
    {
      id: PAGED_VIEW_SNAP_TO_PIXEL,
      title: t(M.snapToPixel),
      category: "View",
      handler: flip("snapToPixel"),
    },
    {
      id: PAGED_VIEW_SMART_GUIDES,
      title: t(M.smartGuides),
      category: "View",
      handler: flip("smartGuides"),
    },
    {
      id: PAGED_VIEW_ROTATE_CW,
      title: t(M.rotateClockwise),
      category: "View",
      handler: () => handlers.rotateView(ROTATE_VIEW_STEP_DEG),
    },
    {
      id: PAGED_VIEW_ROTATE_CCW,
      title: t(M.rotateCounterclockwise),
      category: "View",
      handler: () => handlers.rotateView(-ROTATE_VIEW_STEP_DEG),
    },
    {
      id: PAGED_VIEW_RESET_ROTATION,
      title: t(M.resetRotation),
      category: "View",
      handler: () => handlers.resetRotation(),
    },
    {
      id: PAGED_VIEW_PREFERENCES,
      title: t(M.preferences),
      category: "View",
      handler: (paged: unknown) => handlers.openPreferences(paged),
    },
    // The editing aids. An aid the engine cannot do yet is a visible,
    // disabled command (ADR 207): listed, never pretending to work.
    {
      id: PAGED_VIEW_TOGGLE_FRAME_EDGES,
      title: t(M.frameEdges),
      category: "View",
      handler: flip("frameEdges"),
    },
    {
      id: PAGED_VIEW_TOGGLE_MARGINS_COLUMNS,
      title: t(M.marginsColumns),
      category: "View",
      handler: flip("marginsColumns"),
    },
    {
      id: PAGED_VIEW_TOGGLE_GUIDES,
      title: t(M.guides),
      category: "View",
      handler: flip("guides"),
    },
    {
      id: PAGED_VIEW_TOGGLE_BASELINE_GRID,
      title: t(M.baselineGrid),
      category: "View",
      handler: flip("baselineGrid"),
    },
    {
      id: PAGED_VIEW_TOGGLE_OVERSET_MARKERS,
      title: t(M.oversetMarkers),
      category: "View",
      handler: flip("oversetMarkers"),
    },
    {
      id: PAGED_VIEW_TOGGLE_HIDDEN_CHARACTERS,
      title: t(M.hiddenCharacters),
      category: "View",
      when: () => false,
      handler: () => {},
    },
    {
      id: PAGED_VIEW_TOGGLE_NONPRINTING,
      title: t(M.nonprinting),
      category: "View",
      when: () => false,
      handler: () => {},
    },
  ];
}

const checked =
  (toggle: ViewToggle) =>
  (paged: unknown): boolean =>
    getViewToggle(scopeOf(paged), toggle);

/** Is the editor `paged` in a proof screen mode? */
const proofOn = (paged: unknown): boolean =>
  isProofMode((paged as PagedEditor | null)?.screenMode?.screenMode);

export const VIEW_MENU_ITEMS: MenuItemContribution[] = [
  // Editor ADR "Editing aids and Proof view": Proof view with the screen
  // modes; the aids in their own submenu with the other extras.
  {
    path: "View/Proof view",
    command: PROOF_VIEW_COMMAND,
    checked: proofOn,
    order: 16,
    group: "modes",
  },
  ...AID_ROWS.map(([aid, row], i): MenuItemContribution => ({
    path: `View/Editing aids/${row}`,
    command: EDITING_AID_COMMANDS[aid],
    // The submenu sits where its rows' order puts it: in the extras,
    // before Show heading anchors (65).
    order: 58 + i / 10,
    group: "extras",
    ...(UNSUPPORTED_AIDS[aid]
      ? {
          disabled: true,
          labelFor: () => t(M.notSupported, { aid: t(`menu.${row}`) }),
        }
      : { checked: checked(aid) }),
  })),
  // Illustrator's View menu opens with the screen modes; they sit above
  // the zoom group (orders 20–50).
  {
    path: "View/Outline view",
    command: PAGED_VIEW_OUTLINE,
    checked: checked("outline"),
    order: 10,
    group: "modes",
  },
  {
    path: "View/Overprint Preview",
    command: PAGED_VIEW_OVERPRINT_PREVIEW,
    checked: checked("overprintPreview"),
    order: 12,
    group: "modes",
  },
  {
    path: "View/Pixel Preview",
    command: PAGED_VIEW_PIXEL_PREVIEW,
    checked: checked("pixelPreview"),
    order: 14,
    group: "modes",
  },
  {
    path: "View/Rotate view/15° clockwise",
    command: PAGED_VIEW_ROTATE_CW,
    order: 52,
    group: "rotate",
  },
  {
    path: "View/Rotate view/15° counterclockwise",
    command: PAGED_VIEW_ROTATE_CCW,
    order: 53,
    group: "rotate",
  },
  {
    path: "View/Rotate view/Reset rotation",
    command: PAGED_VIEW_RESET_ROTATION,
    order: 54,
    group: "rotate",
  },
  // The extras group (60–70) holds the overlays; the grids and snapping
  // follow it in their own group, as Illustrator's View menu divides them.
  {
    path: "View/Smart guides",
    command: PAGED_VIEW_SMART_GUIDES,
    checked: checked("smartGuides"),
    order: 80,
    group: "grids",
  },
  {
    path: "View/Show grid",
    command: PAGED_VIEW_SHOW_GRID,
    checked: checked("showGrid"),
    order: 81,
    group: "grids",
  },
  {
    path: "View/Snap to grid",
    command: PAGED_VIEW_SNAP_TO_GRID,
    checked: checked("snapToGrid"),
    order: 82,
    group: "grids",
  },
  {
    path: "View/Show pixel grid",
    command: PAGED_VIEW_PIXEL_GRID,
    checked: checked("pixelGrid"),
    order: 83,
    group: "grids",
  },
  {
    path: "View/Snap to pixel",
    command: PAGED_VIEW_SNAP_TO_PIXEL,
    checked: checked("snapToPixel"),
    order: 84,
    group: "grids",
  },
  {
    path: "View/Guides & grid preferences…",
    command: PAGED_VIEW_PREFERENCES,
    order: 89,
    group: "grids",
  },
];

export const VIEW_KEYBINDINGS: KeybindingContribution[] = [
  { key: "cmd+y", command: PAGED_VIEW_OUTLINE },
  { key: "ctrl+y", command: PAGED_VIEW_OUTLINE },
  { key: "alt+shift+cmd+y", command: PAGED_VIEW_OVERPRINT_PREVIEW },
  { key: "alt+shift+ctrl+y", command: PAGED_VIEW_OVERPRINT_PREVIEW },
  { key: "alt+cmd+y", command: PAGED_VIEW_PIXEL_PREVIEW },
  { key: "alt+ctrl+y", command: PAGED_VIEW_PIXEL_PREVIEW },
  { key: "cmd+'", command: PAGED_VIEW_SHOW_GRID },
  { key: "ctrl+'", command: PAGED_VIEW_SHOW_GRID },
  // Shift turns ' into ", so these match by the physical key (Quote).
  { key: "shift+cmd+'", command: PAGED_VIEW_SNAP_TO_GRID },
  { key: "shift+ctrl+'", command: PAGED_VIEW_SNAP_TO_GRID },
  { key: "cmd+u", command: PAGED_VIEW_SMART_GUIDES },
  { key: "ctrl+u", command: PAGED_VIEW_SMART_GUIDES },
  { key: "shift+cmd+1", command: PAGED_VIEW_RESET_ROTATION },
  { key: "shift+ctrl+1", command: PAGED_VIEW_RESET_ROTATION },
];
