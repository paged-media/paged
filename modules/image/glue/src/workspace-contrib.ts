// WP5.12 — the workspace's contributions (image ADR 475): the Ruler,
// Count, Note and Slice tools, the View-menu verbs (ruler units, Show /
// Lock / Snap to / Clear Guides, New Guide…, slices, notes, count) and the
// retained overlay of count marks, notes, slices and the Ruler line. The
// binding provider that hands the host rulers, guides, grid and Info panel
// the image (extensions ADR 340, `workspace.ts`) is registered with the
// other providers in activate.ts, after the edit context it borrows.
//
// The menu rows are scoped to the rasterImage context: outside an image
// the host's own View menu (Show grid, Snap to grid, guides of the page)
// is the whole story.

import type {
  BundleHost,
  CommandContribution,
  Disposable,
  GestureHandler,
  OverlayLayer,
  ToolContribution,
} from "@paged-media/plugin-api";
import { contributeTool } from "@paged-media/plugin-sdk";
import { defineMessages, t } from "@paged-media/strings";

import { withCanvasCapture } from "./canvas-capture";
import type { ImageSession } from "./session";
import type { RulerUnit } from "./workspace";
import {
  makeCountGesture,
  makeNoteGesture,
  makeRulerGesture,
  makeSliceGesture,
} from "./workspace-tools";

export const RULER_TOOL_ID = "media.paged.image.tool.ruler";
export const COUNT_TOOL_ID = "media.paged.image.tool.count";
export const NOTE_TOOL_ID = "media.paged.image.tool.note";
export const SLICE_TOOL_ID = "media.paged.image.tool.slice";

/** The four tools, for the context's tool set. */
export const WORKSPACE_TOOL_IDS = [
  RULER_TOOL_ID,
  COUNT_TOOL_ID,
  NOTE_TOOL_ID,
  SLICE_TOOL_ID,
] as const;

const C = "media.paged.image.command";

const CMD = defineMessages("image.command", {
  rulerUnitPx: "Rulers in pixels",
  rulerUnitIn: "Rulers in inches",
  rulerUnitCm: "Rulers in centimetres",
  rulerUnitMm: "Rulers in millimetres",
  toggleGuides: "Show or hide guides",
  toggleLockGuides: "Lock or unlock guides",
  toggleSnapGuides: "Snap to guides on or off",
  clearGuides: "Clear guides",
  newGuide: "New guide…",
  slicesFromGuides: "Slices from guides",
  clearSlices: "Delete all slices",
  exportSlices: "Export slices…",
  clearNotes: "Delete all notes",
  clearCount: "Clear count",
  newCountGroup: "New count group",
  straightenToRuler: "Straighten to ruler",
  clearRuler: "Clear ruler",
});

const TOOL = defineMessages("image.tool", {
  ruler: "Ruler",
  count: "Count",
  note: "Note",
  slice: "Slice",
});

// Menu segments (keys are global across catalogues; none of these is
// used by another package).
defineMessages("menu", {
  Rulers: "Rulers",
  Pixels: "Pixels",
  Inches: "Inches",
  Centimetres: "Centimetres",
  Millimetres: "Millimetres",
  "Show guides": "Show guides",
  "Lock guides": "Lock guides",
  "Snap to guides": "Snap to guides",
  "Clear guides": "Clear guides",
  "New guide…": "New guide…",
  "Slices from guides": "Slices from guides",
  "Delete all slices": "Delete all slices",
  "Export slices…": "Export slices…",
  "Delete all notes": "Delete all notes",
  "Clear count": "Clear count",
  "New count group": "New count group",
  "Straighten to ruler": "Straighten to ruler",
  "Clear ruler": "Clear ruler",
});

/** `[path, command suffix, group]`, all scoped to the rasterImage context. */
export const WORKSPACE_MENU_ENTRIES: [
  path: string,
  suffix: string,
  group: string,
][] = [
  ["View/Rulers/Pixels", "rulerUnitPx", "img-rulers"],
  ["View/Rulers/Inches", "rulerUnitIn", "img-rulers"],
  ["View/Rulers/Centimetres", "rulerUnitCm", "img-rulers"],
  ["View/Rulers/Millimetres", "rulerUnitMm", "img-rulers"],
  ["View/Show guides", "toggleGuides", "img-guides"],
  ["View/Lock guides", "toggleLockGuides", "img-guides"],
  ["View/Snap to guides", "toggleSnapGuides", "img-guides"],
  ["View/Clear guides", "clearGuides", "img-guides"],
  ["View/New guide…", "newGuide", "img-guides"],
  ["View/Slices from guides", "slicesFromGuides", "img-extras"],
  ["View/Delete all slices", "clearSlices", "img-extras"],
  ["View/Delete all notes", "clearNotes", "img-extras"],
  ["View/Clear count", "clearCount", "img-extras"],
  ["View/New count group", "newCountGroup", "img-extras"],
  ["View/Clear ruler", "clearRuler", "img-extras"],
  ["Image/Straighten to ruler", "straightenToRuler", "canvas"],
  ["Image/File/Export slices…", "exportSlices", "file"],
];

/** Wrap a tool's gesture so the pointer over the image feeds the Info
 *  panel's pixel readout (every image tool, whatever it does). */
export function trackCursor(
  session: ImageSession,
  factory: () => GestureHandler,
): () => GestureHandler {
  return () => {
    const g = factory();
    return {
      ...g,
      onPointerMove(e) {
        g.onPointerMove(e);
        session.workspace().setCursor(e.pagePoint ?? null);
      },
      onDeactivate(reason) {
        g.onDeactivate(reason);
        session.workspace().setCursor(null);
      },
    };
  };
}

/** `contributeTool` with the cursor readout wired in, and the press
 *  offered to a dialog that draws on the canvas first (the Blur Gallery's
 *  pins, the warps' meshes, pins and strokes — `canvas-capture.ts`): the
 *  image tools registered here were not wrapped before, so with one of
 *  them in hand a drag on a dialog's geometry painted instead. */
export function contributeImageTool(
  host: BundleHost,
  session: ImageSession,
  c: ToolContribution,
): Disposable {
  const gesture = c.gesture;
  return contributeTool(host, {
    ...c,
    ...(gesture
      ? {
          gesture: trackCursor(session, () =>
            withCanvasCapture(host, session, gesture()),
          ),
        }
      : {}),
  });
}

export interface WorkspaceContribution extends Disposable {
  /** Whether the image's context is active (the overlay shows then). */
  setContextActive(on: boolean): void;
}

export function contributeWorkspace(
  host: BundleHost,
  session: ImageSession,
  command: (c: CommandContribution) => Disposable,
  panelId: string,
): WorkspaceContribution {
  const subs: Disposable[] = [];
  const ws = () => session.workspace();
  const openPanel = () => host.shell.openPanel(panelId);

  // ── tools: Ruler / Count / Note in the Eyedropper's flyout, Slice in
  // the Crop tool's (Photoshop's slots); no keys.
  const tool = (c: ToolContribution) =>
    subs.push(contributeImageTool(host, session, c));
  tool({
    id: RULER_TOOL_ID,
    title: t(TOOL.ruler),
    icon: "tool-measure",
    group: "media.paged.image.tool.eyedropper",
    section: "drawType",
    gesture: () => makeRulerGesture(host, session),
  });
  tool({
    id: COUNT_TOOL_ID,
    title: t(TOOL.count),
    icon: "tool-eyedropper",
    group: "media.paged.image.tool.eyedropper",
    section: "drawType",
    gesture: () => makeCountGesture(host, session),
  });
  tool({
    id: NOTE_TOOL_ID,
    title: t(TOOL.note),
    icon: "tool-note",
    group: "media.paged.image.tool.eyedropper",
    section: "drawType",
    gesture: () => makeNoteGesture(host, session, openPanel),
  });
  tool({
    id: SLICE_TOOL_ID,
    title: t(TOOL.slice),
    icon: "tool-crop",
    group: "media.paged.image.tool.crop",
    section: "transform",
    gesture: () => makeSliceGesture(host, session),
  });

  // ── commands
  const unit = (u: RulerUnit) => () => ws().setRulerUnit(u);
  const table: [suffix: string, title: string, run: () => unknown][] = [
    ["rulerUnitPx", t(CMD.rulerUnitPx), unit("px")],
    ["rulerUnitIn", t(CMD.rulerUnitIn), unit("in")],
    ["rulerUnitCm", t(CMD.rulerUnitCm), unit("cm")],
    ["rulerUnitMm", t(CMD.rulerUnitMm), unit("mm")],
    [
      "toggleGuides",
      t(CMD.toggleGuides),
      () => ws().setGuidesVisible(!ws().state().view.guidesVisible),
    ],
    [
      "toggleLockGuides",
      t(CMD.toggleLockGuides),
      () => ws().setGuidesLocked(!ws().state().view.guidesLocked),
    ],
    [
      "toggleSnapGuides",
      t(CMD.toggleSnapGuides),
      () => ws().setSnapToGuides(!ws().state().view.snapToGuides),
    ],
    ["clearGuides", t(CMD.clearGuides), () => ws().clearGuides()],
    [
      "newGuide",
      t(CMD.newGuide),
      () => {
        openPanel();
        session.openDialog("newGuide");
      },
    ],
    [
      "slicesFromGuides",
      t(CMD.slicesFromGuides),
      () => ws().slicesFromGuides(),
    ],
    ["clearSlices", t(CMD.clearSlices), () => ws().clearSlices()],
    ["exportSlices", t(CMD.exportSlices), () => ws().exportSlices()],
    ["clearNotes", t(CMD.clearNotes), () => ws().clearNotes()],
    ["clearCount", t(CMD.clearCount), () => ws().clearCount()],
    ["newCountGroup", t(CMD.newCountGroup), () => ws().newCountGroup()],
    ["straightenToRuler", t(CMD.straightenToRuler), () => ws().straighten()],
    ["clearRuler", t(CMD.clearRuler), () => ws().setRuler(null)],
  ];
  for (const [suffix, title, run] of table) {
    subs.push(
      command({
        id: `${C}.${suffix}`,
        title,
        category: "Image",
        handler: () => run(),
      }),
    );
  }

  // ── menu rows, while the image is the active context
  const perGroup = new Map<string, number>();
  for (const [path, suffix, group] of WORKSPACE_MENU_ENTRIES) {
    const n = (perGroup.get(group) ?? 0) + 1;
    perGroup.set(group, n);
    subs.push(
      host.contribute.menu({
        path,
        command: `${C}.${suffix}`,
        group,
        order: 500 + n * 10,
        scope: { editContext: "rasterImage" },
      }),
    );
  }

  // ── the retained overlay: count marks, notes, slices, the Ruler line
  let active = false;
  let layer: OverlayLayer | null = null;
  const draw = () => {
    if (!layer) return;
    if (!active || !session.state().source) {
      layer.clear();
      return;
    }
    layer.set(ws().shapes());
  };
  if (host.supports("overlay.layers@1")) {
    layer = host.overlay.layer("media.paged.image.workspace");
    subs.push(layer);
  }
  subs.push(session.onDidChange(draw));

  return {
    setContextActive(on) {
      active = on;
      if (on) void ws().refreshFit().then(draw);
      else draw();
    },
    dispose() {
      for (const s of subs.splice(0).reverse()) s.dispose();
    },
  };
}
