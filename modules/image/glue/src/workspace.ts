// WP5.12 — the image's WORKSPACE (image ADR 475): rulers, guides and the
// grid inside the rasterImage context, snapping to them, and the Count,
// Ruler, Note and Slice tools' data.
//
// What lives where:
//   · the guides, count marks, notes and slices are DOCUMENT state in the
//     engine's layer stack (`workspace-engine.ts`): every change is one
//     undo step on the image's list, persisted with the layers, and the
//     guides travel through a PSD as resource 1032;
//   · the rulers, the guides' drawing and dragging and the grid are the
//     HOST's (extensions ADR 340): this controller answers the binding
//     provider's workspace lane with the frame the rulers measure in and
//     the guides they carry, and takes the guide edits back;
//   · the Info panel's image rows (the pixel under the cursor, the
//     selection, the Ruler's measurement) answer the readout lane;
//   · the ruler unit, Show / Lock Guides and Snap to Guides are view
//     settings of this session (not in the file), as Photoshop's are;
//     Show Grid and Snap to Grid are the host's View menu, handed over
//     through the lane's `workspaceView`.

import type {
  BindingGuideEdit,
  BindingProvider,
  BindingReadoutSection,
  BindingWorkspace,
  BindingWorkspaceView,
  BundleHost,
  ToolPreviewShape,
} from "@paged-media/plugin-api";
import { defineMessages, t } from "@paged-media/strings";

import type { ImageEngine } from "./engine";
import { imageToPage, resolveFrameFit, type FitTransform } from "./frame-fit";
import { EMPTY_WORKSPACE, type WorkspaceInfo } from "./workspace-engine";

export type RulerUnit = "px" | "in" | "cm" | "mm";
export const RULER_UNITS: readonly RulerUnit[] = ["px", "in", "cm", "mm"];

const PER_INCH: Record<Exclude<RulerUnit, "px">, number> = {
  in: 1,
  cm: 2.54,
  mm: 25.4,
};

/** The resolution the rulers follow when the image declares none. */
export const DEFAULT_PPI = 72;

/** Pixels per ruler unit at `ppi`. */
export function pxPerUnit(unit: RulerUnit, ppi: number): number {
  return unit === "px" ? 1 : ppi / PER_INCH[unit];
}

/** Session view settings (not saved in the image). */
export interface WorkspaceViewState {
  rulerUnit: RulerUnit;
  guidesVisible: boolean;
  guidesLocked: boolean;
  snapToGuides: boolean;
}

/** The Ruler tool's line, image px. */
export interface RulerMeasure {
  from: [number, number];
  to: [number, number];
}

/** What a Ruler line measures: Photoshop's Info readout. The angle is
 *  counter-clockwise from the x axis (y up), −180…180°. */
export interface RulerReadout {
  dx: number;
  dy: number;
  distance: number;
  angle: number;
}

export function measure(m: RulerMeasure): RulerReadout {
  const dx = m.to[0] - m.from[0];
  const dy = m.to[1] - m.from[1];
  let angle = (Math.atan2(-dy, dx) * 180) / Math.PI;
  // A level line pointing left reads 180°, not −180°.
  if (angle <= -180) angle += 360;
  return {
    dx,
    dy,
    distance: Math.hypot(dx, dy),
    angle: Object.is(angle, -0) ? 0 : angle,
  };
}

/** The clockwise turn (degrees, the canvas rotation's sign) that makes a
 *  Ruler line level — or upright when it is nearer vertical. 0 when it
 *  already is. */
export function straightenAngle(m: RulerMeasure): number {
  const a = measure(m).angle;
  let turn = a;
  if (a > 45 && a <= 135) turn = a - 90;
  else if (a < -45 && a >= -135) turn = a + 90;
  else if (a > 135) turn = a - 180;
  else if (a < -135) turn = a + 180;
  return Math.abs(turn) < 1e-9 ? 0 : turn;
}

export interface WorkspaceState {
  info: WorkspaceInfo;
  view: WorkspaceViewState;
  ruler: RulerMeasure | null;
  /** The pointer over the image (image px) and the composite's pixel
   *  there, or null off the image. */
  cursor: {
    at: [number, number];
    rgba: [number, number, number, number] | null;
  } | null;
  /** The host's grid and snap state (`workspaceView`), or null before
   *  the host sent any. */
  hostView: BindingWorkspaceView | null;
}

export interface WorkspaceDeps {
  host: BundleHost;
  engine(): ImageEngine | null;
  source(): {
    handle: number;
    width: number;
    height: number;
    elementId: string | null;
    name: string;
  } | null;
  ppi(): number | null;
  selection(): { x: number; y: number; w: number; h: number } | null;
  emit(): void;
  setStatus(s: string): void;
  /** A workspace step landed: the image has uncommitted edits and the
   *  history readout moved. */
  markEdited(): void;
  /** Image ▸ Image Rotation ▸ Arbitrary (clockwise degrees). */
  rotateCanvas(degrees: number): Promise<boolean>;
}

const M = defineMessages("image.workspace", {
  section: "Image",
  x: "X",
  y: "Y",
  rgb: "RGB",
  hex: "Hex",
  selection: "Selection W × H",
  rulerDistance: "Ruler D",
  rulerAngle: "Ruler A",
  rulerWidth: "Ruler W",
  rulerHeight: "Ruler H",
  count: "Count",
  noImage: "Ingest an image first.",
  guideAdded: "Guide added at {position}.",
  guidesCleared: "Guides cleared.",
  noGuides: "There are no guides to clear.",
  guidesShown: "Guides shown.",
  guidesHidden: "Guides hidden.",
  guidesLocked: "Guides locked.",
  guidesUnlocked: "Guides unlocked.",
  snapOn: "Snap to guides on.",
  snapOff: "Snap to guides off.",
  rulerUnit: "Rulers in {unit}.",
  slicesFromGuides: "{count} slices from the guides.",
  slicesCleared: "Slices cleared.",
  notesCleared: "Notes cleared.",
  countCleared: "Count cleared.",
  countGroupAdded: "{name} added.",
  noRuler: "Draw a line with the Ruler tool first.",
  alreadyStraight: "The ruler line is already straight.",
  noSlices: "There are no slices to export.",
  slicesExported: "{saved} of {count} slices saved.",
  noSaver: "This editor cannot save files (shell.saveFile@1).",
  failed: "{what} failed: {error}",
});

const UNIT_LABEL: Record<RulerUnit, string> = {
  px: "px",
  in: "in",
  cm: "cm",
  mm: "mm",
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

/** Most guides / slices / marks drawn on the canvas at once. */
const MAX_DRAWN = 2000;

export interface WorkspaceController {
  state(): WorkspaceState;
  /** Re-read the engine's workspace (after any stack change: an undo, a
   *  redo, an open). Emits nothing. */
  sync(): void;
  /** The frame's image→page mapping, cached; resolved again on demand. */
  fit(): FitTransform | null;
  refreshFit(): Promise<FitTransform | null>;
  setHostView(view: BindingWorkspaceView): void;
  setRulerUnit(unit: RulerUnit): void;
  setGuidesVisible(on: boolean): void;
  setGuidesLocked(on: boolean): void;
  setSnapToGuides(on: boolean): void;
  addGuide(orientation: "horizontal" | "vertical", position: number): boolean;
  moveGuide(index: number, position: number): boolean;
  deleteGuide(index: number): boolean;
  clearGuides(): boolean;
  /** The host's guide machinery: create / move / delete. */
  editGuide(edit: BindingGuideEdit): boolean;
  addCount(at: [number, number]): boolean;
  moveCount(group: number, index: number, at: [number, number]): boolean;
  removeCount(group: number, index: number): boolean;
  clearCount(group?: number): boolean;
  newCountGroup(name?: string): boolean;
  setActiveCountGroup(group: number): boolean;
  setCountGroup(
    group: number,
    patch: {
      name?: string;
      color?: [number, number, number];
      visible?: boolean;
    },
  ): boolean;
  deleteCountGroup(group: number): boolean;
  addNote(at: [number, number], text?: string, author?: string): number | null;
  editNote(index: number, text: string, author?: string): boolean;
  moveNote(index: number, at: [number, number]): boolean;
  deleteNote(index: number): boolean;
  clearNotes(): boolean;
  addSlice(rect: { x: number; y: number; w: number; h: number }): boolean;
  setSlice(
    index: number,
    rect: { x: number; y: number; w: number; h: number },
    name?: string,
  ): boolean;
  deleteSlice(index: number): boolean;
  clearSlices(): boolean;
  slicesFromGuides(): boolean;
  /** Save each slice of the composite as a PNG through the host's file
   *  saver; answers how many were saved. */
  exportSlices(): Promise<number>;
  setRuler(m: RulerMeasure | null): void;
  rulerReadout(): RulerReadout | null;
  /** Rotate the canvas so the Ruler line is level (Photoshop's Straighten
   *  Layer, over the whole stack: the existing arbitrary canvas rotation). */
  straighten(): Promise<boolean>;
  /** The pointer moved over the frame (page-local pt), or left it. */
  setCursor(pagePoint: [number, number] | null): void;
  /** Snap an image point to the guides, the canvas edges and the grid
   *  that are switched on, within the host's tolerance. */
  snap(p: [number, number]): [number, number];
  /** The lane's answers. */
  workspace(): BindingWorkspace | null;
  readouts(): BindingReadoutSection[];
  /** The persistent marks the canvas shows: count marks, notes, slices
   *  and the Ruler line (the guides are the host's to draw). */
  shapes(): ToolPreviewShape[];
}

export function createWorkspaceController(
  deps: WorkspaceDeps,
): WorkspaceController {
  const st: WorkspaceState = {
    info: EMPTY_WORKSPACE,
    view: {
      rulerUnit: "px",
      guidesVisible: true,
      guidesLocked: false,
      snapToGuides: true,
    },
    ruler: null,
    cursor: null,
    hostView: null,
  };
  let fit: FitTransform | null = null;
  let fitKey = "";

  const ppi = () => deps.ppi() ?? DEFAULT_PPI;

  const sync = () => {
    const engine = deps.engine();
    if (!engine || !deps.source()) {
      st.info = EMPTY_WORKSPACE;
      return;
    }
    try {
      st.info = engine.workspace();
    } catch {
      st.info = EMPTY_WORKSPACE;
    }
  };

  /** Run one engine verb as a workspace step: re-read, mark, emit. */
  const step = <T>(what: string, run: (engine: ImageEngine) => T): T | null => {
    const engine = deps.engine();
    if (!engine || !deps.source()) {
      deps.setStatus(t(M.noImage));
      deps.emit();
      return null;
    }
    try {
      const out = run(engine);
      sync();
      deps.markEdited();
      deps.emit();
      return out;
    } catch (err) {
      deps.setStatus(t(M.failed, { what, error: errText(err) }));
      deps.emit();
      return null;
    }
  };

  const fmt = (px: number) => {
    const unit = st.view.rulerUnit;
    const v = px / pxPerUnit(unit, ppi());
    const digits = unit === "px" ? (Number.isInteger(v) ? 0 : 1) : 2;
    const n = Number(v.toFixed(digits));
    return `${Object.is(n, -0) ? 0 : n} ${UNIT_LABEL[unit]}`;
  };

  const refreshFit = async (): Promise<FitTransform | null> => {
    const src = deps.source();
    fit = await resolveFrameFit(deps.host, src, "workspace");
    fitKey = src ? `${src.elementId}:${src.width}x${src.height}` : "";
    return fit;
  };

  const currentFit = (): FitTransform | null => {
    const src = deps.source();
    const key = src ? `${src.elementId}:${src.width}x${src.height}` : "";
    if (key !== fitKey) {
      fit = null;
      void refreshFit().then(() => deps.emit());
    }
    return fit;
  };

  const toleranceImagePx = (): number => {
    const f = currentFit();
    const tolPx = st.hostView?.snapTolerancePx ?? 4;
    let scale = 1;
    try {
      scale = deps.host.viewport.camera().scale || 1;
    } catch {
      scale = 1;
    }
    // Without the frame's mapping there is no screen distance to measure:
    // no snapping until it is known.
    return f ? tolPx / (scale * f.scale) : 0;
  };

  const api: WorkspaceController = {
    state: () => st,
    sync,
    fit: () => currentFit(),
    refreshFit,
    setHostView(view) {
      st.hostView = view;
      deps.emit();
    },
    setRulerUnit(unit) {
      if (st.view.rulerUnit === unit) return;
      st.view = { ...st.view, rulerUnit: unit };
      deps.setStatus(t(M.rulerUnit, { unit: UNIT_LABEL[unit] }));
      deps.emit();
    },
    setGuidesVisible(on) {
      st.view = { ...st.view, guidesVisible: on };
      deps.setStatus(t(on ? M.guidesShown : M.guidesHidden));
      deps.emit();
    },
    setGuidesLocked(on) {
      st.view = { ...st.view, guidesLocked: on };
      deps.setStatus(t(on ? M.guidesLocked : M.guidesUnlocked));
      deps.emit();
    },
    setSnapToGuides(on) {
      st.view = { ...st.view, snapToGuides: on };
      deps.setStatus(t(on ? M.snapOn : M.snapOff));
      deps.emit();
    },
    addGuide(orientation, position) {
      const ok =
        step("New guide", (e) => e.guideAdd(orientation, position)) !== null;
      if (ok) {
        deps.setStatus(t(M.guideAdded, { position: fmt(position) }));
        deps.emit();
      }
      return ok;
    },
    moveGuide(index, position) {
      if (st.view.guidesLocked) return false;
      return step("Move guide", (e) => e.guideMove(index, position)) ?? false;
    },
    deleteGuide(index) {
      if (st.view.guidesLocked) return false;
      return step("Delete guide", (e) => e.guideDelete(index)) !== null;
    },
    clearGuides() {
      if (st.info.guides.length === 0) {
        deps.setStatus(t(M.noGuides));
        deps.emit();
        return false;
      }
      const ok = step("Clear guides", (e) => e.guidesClear()) ?? false;
      if (ok) {
        deps.setStatus(t(M.guidesCleared));
        deps.emit();
      }
      return ok;
    },
    editGuide(edit) {
      const index = (id: string) => {
        const m = /^g(\d+)$/.exec(id);
        const i = m ? Number(m[1]) : -1;
        return i >= 0 && i < st.info.guides.length ? i : -1;
      };
      if (edit.kind === "create")
        return api.addGuide(edit.orientation, edit.position);
      const i = index(edit.id);
      if (i < 0) return false;
      return edit.kind === "move"
        ? api.moveGuide(i, edit.position)
        : api.deleteGuide(i);
    },
    addCount(at) {
      return step("Count", (e) => e.countAdd(at)) !== null;
    },
    moveCount(group, index, at) {
      return step("Move count", (e) => e.countMove(group, index, at)) ?? false;
    },
    removeCount(group, index) {
      return step("Delete count", (e) => e.countRemove(group, index)) !== null;
    },
    clearCount(group) {
      const g = group ?? st.info.activeCount;
      if (!st.info.counts[g]) return false;
      const ok = step("Clear count", (e) => e.countClear(g)) ?? false;
      if (ok) {
        deps.setStatus(t(M.countCleared));
        deps.emit();
      }
      return ok;
    },
    newCountGroup(name) {
      const g = step("New count group", (e) => e.countGroupNew(name));
      if (g === null) return false;
      deps.setStatus(
        t(M.countGroupAdded, { name: st.info.counts[g]?.name ?? "" }),
      );
      deps.emit();
      return true;
    },
    setActiveCountGroup(group) {
      return step("Count group", (e) => e.countGroupActive(group)) ?? false;
    },
    setCountGroup(group, patch) {
      return step("Count group", (e) => e.countGroupSet(group, patch)) ?? false;
    },
    deleteCountGroup(group) {
      return (
        step("Delete count group", (e) => e.countGroupDelete(group)) !== null
      );
    },
    addNote(at, text = "", author = "") {
      return step("New note", (e) => e.noteAdd(at, author, text));
    },
    editNote(index, text, author) {
      const cur = st.info.notes[index];
      if (!cur) return false;
      return (
        step("Edit note", (e) =>
          e.noteEdit(index, author ?? cur.author, text),
        ) ?? false
      );
    },
    moveNote(index, at) {
      return step("Move note", (e) => e.noteMove(index, at)) ?? false;
    },
    deleteNote(index) {
      return step("Delete note", (e) => e.noteDelete(index)) !== null;
    },
    clearNotes() {
      const ok = step("Clear notes", (e) => e.notesClear()) ?? false;
      if (ok) {
        deps.setStatus(t(M.notesCleared));
        deps.emit();
      }
      return ok;
    },
    addSlice(rect) {
      return step("Slice", (e) => e.sliceAdd(rect)) !== null;
    },
    setSlice(index, rect, name) {
      return step("Edit slice", (e) => e.sliceSet(index, rect, name)) ?? false;
    },
    deleteSlice(index) {
      return step("Delete slice", (e) => e.sliceDelete(index)) !== null;
    },
    clearSlices() {
      const ok = step("Clear slices", (e) => e.slicesClear()) ?? false;
      if (ok) {
        deps.setStatus(t(M.slicesCleared));
        deps.emit();
      }
      return ok;
    },
    slicesFromGuides() {
      const n = step("Slices from guides", (e) => e.slicesFromGuides());
      if (n === null) return false;
      deps.setStatus(t(M.slicesFromGuides, { count: n }));
      deps.emit();
      return true;
    },
    async exportSlices() {
      const engine = deps.engine();
      const src = deps.source();
      if (!engine || !src) {
        deps.setStatus(t(M.noImage));
        deps.emit();
        return 0;
      }
      const slices = st.info.slices;
      if (slices.length === 0) {
        deps.setStatus(t(M.noSlices));
        deps.emit();
        return 0;
      }
      if (!deps.host.supports("shell.saveFile@1")) {
        deps.setStatus(t(M.noSaver));
        deps.emit();
        return 0;
      }
      const stem = (src.name.split(/[\\/]/).pop() ?? "image").replace(
        /\.[^.]+$/,
        "",
      );
      let saved = 0;
      for (const s of slices) {
        try {
          const rgba = engine.tile(src.handle, s.x, s.y, s.w, s.h);
          const bytes = engine.encode(rgba, s.w, s.h, "png");
          const ok = await deps.host.shell.saveFile({
            suggestedName: `${stem}_${s.name}.png`,
            bytes,
            mimeType: "image/png",
          });
          if (ok) saved++;
        } catch (err) {
          deps.setStatus(t(M.failed, { what: s.name, error: errText(err) }));
        }
      }
      deps.setStatus(t(M.slicesExported, { saved, count: slices.length }));
      deps.emit();
      return saved;
    },
    setRuler(m) {
      st.ruler = m;
      deps.emit();
    },
    rulerReadout: () => (st.ruler ? measure(st.ruler) : null),
    async straighten() {
      if (!st.ruler) {
        deps.setStatus(t(M.noRuler));
        deps.emit();
        return false;
      }
      const turn = straightenAngle(st.ruler);
      if (turn === 0) {
        deps.setStatus(t(M.alreadyStraight));
        deps.emit();
        return false;
      }
      const ok = await deps.rotateCanvas(turn);
      if (ok) {
        st.ruler = null;
        deps.emit();
      }
      return ok;
    },
    setCursor(pagePoint) {
      const f = currentFit();
      const src = deps.source();
      const engine = deps.engine();
      if (!pagePoint || !f || !src) {
        if (st.cursor !== null) {
          st.cursor = null;
          deps.emit();
        }
        return;
      }
      const at: [number, number] = [
        (pagePoint[0] - f.originX) / f.scale,
        (pagePoint[1] - f.originY) / f.scale,
      ];
      const x = Math.floor(at[0]);
      const y = Math.floor(at[1]);
      if (x < 0 || y < 0 || x >= src.width || y >= src.height) {
        if (st.cursor !== null) {
          st.cursor = null;
          deps.emit();
        }
        return;
      }
      let rgba: [number, number, number, number] | null = null;
      try {
        const px = engine?.tile(src.handle, x, y, 1, 1);
        if (px && px.length >= 4) rgba = [px[0]!, px[1]!, px[2]!, px[3]!];
      } catch {
        rgba = null;
      }
      st.cursor = { at, rgba };
      deps.emit();
    },
    snap(p) {
      const src = deps.source();
      if (!src) return p;
      const tol = toleranceImagePx();
      const xs: number[] = [];
      const ys: number[] = [];
      if (st.view.snapToGuides) {
        if (st.view.guidesVisible) {
          for (const g of st.info.guides)
            (g.orientation === "vertical" ? xs : ys).push(g.position);
        }
        xs.push(0, src.width);
        ys.push(0, src.height);
      }
      const hv = st.hostView;
      const gridStep =
        hv && hv.snapToGrid
          ? (hv.gridEveryPt / Math.max(1, hv.gridSubdivisions)) * (ppi() / 72)
          : 0;
      const best = (v: number, lines: number[]) => {
        let out = v;
        let d = tol;
        for (const l of lines) {
          const dd = Math.abs(l - v);
          if (dd <= d) {
            d = dd;
            out = l;
          }
        }
        if (gridStep > 0) {
          const g = Math.round(v / gridStep) * gridStep;
          if (Math.abs(g - v) <= d) out = g;
        }
        return out;
      };
      return [best(p[0], xs), best(p[1], ys)];
    },
    workspace() {
      const f = currentFit();
      const src = deps.source();
      if (!f || !src || !src.elementId) return null;
      const unit = st.view.rulerUnit;
      return {
        pageId: f.pageId,
        origin: [f.originX, f.originY],
        ptPerBase: f.scale,
        size: [src.width, src.height],
        unit: { label: UNIT_LABEL[unit], basePerUnit: pxPerUnit(unit, ppi()) },
        basePerPoint: ppi() / 72,
        guideStep: 1,
        guides: st.info.guides.map((g, i) => ({
          id: `g${i}`,
          orientation: g.orientation,
          position: g.position,
        })),
        guidesVisible: st.view.guidesVisible,
        guidesLocked: st.view.guidesLocked,
      };
    },
    readouts() {
      const rows: BindingReadoutSection["rows"][number][] = [];
      const c = st.cursor;
      if (c) {
        rows.push(
          { id: "Image X", label: t(M.x), value: fmt(c.at[0]) },
          { id: "Image Y", label: t(M.y), value: fmt(c.at[1]) },
        );
        if (c.rgba) {
          const [r, g, b] = c.rgba;
          const hex = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
          rows.push(
            {
              id: "Image RGB",
              label: t(M.rgb),
              value: `${r} ${g} ${b}`,
              swatch: hex,
            },
            { id: "Image hex", label: t(M.hex), value: hex },
          );
        }
      }
      const sel = deps.selection();
      if (sel) {
        rows.push({
          id: "Image selection",
          label: t(M.selection),
          value: `${fmt(sel.w)} × ${fmt(sel.h)}`,
        });
      }
      const r = api.rulerReadout();
      if (r) {
        rows.push(
          {
            id: "Ruler distance",
            label: t(M.rulerDistance),
            value: fmt(r.distance),
          },
          {
            id: "Ruler angle",
            label: t(M.rulerAngle),
            value: `${Number(r.angle.toFixed(1))}°`,
          },
          { id: "Ruler W", label: t(M.rulerWidth), value: fmt(r.dx) },
          { id: "Ruler H", label: t(M.rulerHeight), value: fmt(r.dy) },
        );
      }
      const group = st.info.counts[st.info.activeCount];
      if (group) {
        rows.push({
          id: "Count",
          label: t(M.count),
          value: `${group.marks.length} (${group.name})`,
        });
      }
      return rows.length ? [{ id: "image", title: t(M.section), rows }] : [];
    },
    shapes() {
      const f = currentFit();
      if (!f) return [];
      const out: ToolPreviewShape[] = [];
      let arm = 5;
      try {
        arm = deps.host.viewport.pxToPt(5) || 5;
      } catch {
        arm = 5;
      }
      const page = (p: [number, number]) => imageToPage(f, p);
      for (const g of st.info.counts) {
        if (!g.visible) continue;
        g.marks.slice(0, MAX_DRAWN).forEach((m, i) => {
          const [x, y] = page(m);
          out.push(
            {
              pageId: f.pageId,
              points: [
                [x - arm, y],
                [x + arm, y],
              ],
            },
            {
              pageId: f.pageId,
              points: [
                [x, y - arm],
                [x, y + arm],
              ],
            },
            {
              kind: "text",
              pageId: f.pageId,
              x: x + arm + 1,
              y: y - 2,
              text: String(i + 1),
              background: true,
            },
          );
        });
      }
      for (const n of st.info.notes.slice(0, MAX_DRAWN)) {
        const [x, y] = page(n.at);
        out.push(
          {
            pageId: f.pageId,
            points: [
              [x, y],
              [x + 2 * arm, y],
              [x + 2 * arm, y + 2 * arm],
              [x, y + 2 * arm],
            ],
            close: true,
          },
          {
            kind: "text",
            pageId: f.pageId,
            x: x + 2 * arm + 2,
            y: y + 2 * arm,
            text: n.text.split("\n")[0]!.slice(0, 40),
            background: true,
          },
        );
      }
      for (const s of st.info.slices.slice(0, MAX_DRAWN)) {
        const [x0, y0] = page([s.x, s.y]);
        const [x1, y1] = page([s.x + s.w, s.y + s.h]);
        out.push(
          {
            pageId: f.pageId,
            points: [
              [x0, y0],
              [x1, y0],
              [x1, y1],
              [x0, y1],
            ],
            close: true,
          },
          {
            kind: "text",
            pageId: f.pageId,
            x: x0 + 2,
            y: y0 + 10,
            text: s.name,
            background: true,
          },
        );
      }
      if (st.ruler) {
        const a = page(st.ruler.from);
        const b = page(st.ruler.to);
        const r = measure(st.ruler);
        out.push(
          { pageId: f.pageId, points: [a, b] },
          {
            kind: "text",
            pageId: f.pageId,
            x: b[0] + arm,
            y: b[1] - arm,
            text: `${fmt(r.distance)} · ${Number(r.angle.toFixed(1))}°`,
            background: true,
          },
        );
      }
      return out;
    },
  };
  return api;
}

/** The binding provider for the workspace and readout lanes (extensions
 *  ADR 340): the host rulers, guides and grid follow the image, and the
 *  Info panel shows its rows. */
export function makeWorkspaceBindingProvider(
  workspace: () => WorkspaceController,
): BindingProvider {
  return {
    provides: { workspace: true, readouts: ["info"] },
    readWorkspace() {
      const ws = workspace().workspace();
      return ws
        ? { kind: "workspace", workspace: ws }
        : { kind: "decline", reason: "no image frame on a page" };
    },
    editGuide(edit) {
      const ok = workspace().editGuide(edit);
      return ok
        ? {
            kind: "applied",
            outcome: { applied: true, createdId: null, pageIds: [] },
          }
        : {
            kind: "applied",
            outcome: { applied: false, error: "the guide edit did not apply" },
          };
    },
    workspaceView(view) {
      workspace().setHostView(view);
    },
    readReadouts() {
      const sections = workspace().readouts();
      return { kind: "readouts", sections };
    },
  };
}
