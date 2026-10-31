// VECTORS INSIDE THE IMAGE in the image session (image ADR 476, WP5.11):
// what the Pen, Path Selection, Direct Selection and the shape tools
// edit, the shape tools' three modes, the Paths panel's verbs beyond
// WP5.5's (Save Path, Fill Path, Stroke Path) and a layer's vector mask.
// The session owns one controller (`session.vectors()`); like the masking
// controller it holds only UI state — the paths, the vector masks and
// the shape layers are engine state, and every change is one undo step
// on the image's undo list.
//
// WHAT THE TOOLS EDIT (the TARGET), as in Photoshop: the path chosen in
// the Paths panel, or the vector mask chosen on a layer. With neither,
// the Pen and the shape tools (Path mode) draw a NEW work path, which
// then becomes the target, so the next subpath joins it.

import { defineMessages, t } from "@paged-media/strings";

import type { DecodedInfo, ImageEngine, LayerInfo, StrokeTool } from "./engine";
import {
  CONTINUE_OP,
  type Geometry,
  type VectorMaskStart,
} from "./vector-engine";
import { SHAPE_DEFAULTS, type ShapeOptions } from "./vector-shapes";

export const VM = defineMessages("image.vectors", {
  noImage: "Open an image first (double-click an image frame).",
  failed: "{what} failed: {error}",
  noPath: "Choose a path in the Paths panel first.",
  noWorkPath: "There is no work path to save.",
  noVectorMask: "The active layer has no vector mask.",
  workPath: "Work path: {count} subpath(s).",
  pathSaved: "Work path saved as “{name}”.",
  pathEdited: "Path “{name}” edited.",
  maskEdited: "Vector mask of “{layer}” edited.",
  shapeLayer: "Shape layer “{layer}” added.",
  shapePixels: "Shape filled with the foreground colour.",
  filled: "Path “{name}” filled with the foreground colour.",
  stroked: "Path “{name}” stroked with the {tool}.",
  maskAdded: "Vector mask added to “{layer}”.",
  maskDeleted: "Vector mask of “{layer}” deleted.",
  maskOn: "Vector mask of “{layer}” enabled.",
  maskOff: "Vector mask of “{layer}” disabled (kept, not applied).",
  maskInverted: "Vector mask of “{layer}” inverted.",
  maskRasterized: "Vector mask of “{layer}” rasterized into its layer mask.",
  psdPaths: "{count} path(s) read from the PSD.",
  psdPathsSkipped: "{count} path(s) in the PSD could not be read: {why}",
  gpuOnly:
    "{what} needs WebGPU (the fill renders on the GPU); paths and vector masks work without it.",
});

/** What the Pen and the path tools edit. */
export type VectorTarget =
  { kind: "path"; id: number } | { kind: "vectorMask"; layer: number };

/** The shape tools' (and the Pen's) mode: a SHAPE layer, a PATH, or
 *  PIXELS filled into the active layer. */
export type ShapeMode = "shape" | "path" | "pixels";

export interface VectorUiState {
  /** The target chosen explicitly (Paths panel, a layer's vector mask). */
  target: VectorTarget | null;
  mode: ShapeMode;
  /** The path operation a new subpath joins with (0 exclude, 1 combine,
   *  2 subtract, 3 intersect — the PSD's numbering). */
  op: number;
  shape: ShapeOptions;
}

export interface VectorDeps {
  engine(): ImageEngine | null;
  source(): { handle: number; width: number; height: number } | null;
  layers(): { active: number; layers: LayerInfo[] };
  /** The foreground colour, straight RGBA 0…1. */
  foreground(): readonly [number, number, number, number];
  gpu(): boolean;
  setStatus(s: string): void;
  emit(): void;
  /** The paths or a vector mask changed: uncommitted edits. */
  markEdited(): void;
  refreshLayers(): void;
  /** Re-read the Paths panel (the masking controller's readout). */
  refreshPaths(): void;
  recomposite(): Promise<boolean>;
  /** A pixel edit through a door that answers the image (one step). */
  applyEffect(
    label: string,
    run: (handle: number) => Promise<DecodedInfo>,
  ): Promise<boolean>;
  /** The brush stroke lane (Stroke Path). */
  stroke: {
    begin(tool: StrokeTool): Promise<boolean>;
    extend(x: number, y: number): Promise<boolean>;
    commit(): Promise<boolean>;
    cancel(): void;
  };
}

export interface VectorController {
  state(): VectorUiState;
  setMode(mode: ShapeMode): void;
  setOp(op: number): void;
  setShapeOptions(patch: Partial<ShapeOptions>): void;
  /** Make a stored path the target (`null`: none). */
  selectPath(id: number | null): void;
  /** Make layer `layer`'s vector mask the target (`null`: none). */
  selectVectorMask(layer: number | null): void;
  /** The target the tools edit now: the explicit one while it exists,
   *  else nothing (the Pen then starts a work path). */
  activeTarget(): VectorTarget | null;
  /** A target's geometry (null when it is gone). */
  geometry(target: VectorTarget): Geometry | null;
  /** Replace a target's geometry. One undo step. */
  setGeometry(target: VectorTarget, g: Geometry): Promise<boolean>;
  /** A subpath or shape the Pen or a shape tool drew (image px), put
   *  where the mode says: a new shape layer, the target path (or a new
   *  work path), or the active layer's pixels. */
  addShape(g: Geometry, mode?: ShapeMode): Promise<boolean>;
  /** Save Path: the work path becomes a saved path. */
  saveWorkPath(name?: string): boolean;
  /** Fill Path with the foreground colour (the target path, or `id`). */
  fillPath(id?: number): Promise<boolean>;
  /** Stroke Path with a paint tool (the brush by default). */
  strokePath(id?: number, tool?: StrokeTool): Promise<boolean>;
  /** Layer ▸ Vector Mask ▸ Reveal All / Hide All / Current Path. */
  addVectorMask(
    start: "revealAll" | "hideAll" | "currentPath",
  ): Promise<boolean>;
  deleteVectorMask(): Promise<boolean>;
  /** Enable / Disable Vector Mask. */
  toggleVectorMask(): Promise<boolean>;
  invertVectorMask(): Promise<boolean>;
  rasterizeVectorMask(): Promise<boolean>;
  /** Read an opened PSD's paths into the Paths panel (no step). */
  importPsdPaths(psdHandle: number): void;
}

const errText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** Points along a geometry's subpaths, every ~2 px (Stroke Path). */
export function strokePoints(g: Geometry): [number, number][][] {
  return g.subpaths.map((s) => {
    const a = s.anchors;
    const n = a.length / 6;
    if (n === 0) return [];
    const out: [number, number][] = [[a[0], a[1]]];
    const segs = s.closed ? n : n - 1;
    for (let k = 0; k < segs; k++) {
      const i = k * 6;
      const j = ((k + 1) % n) * 6;
      const p0 = [a[i], a[i + 1]];
      const p1 = [a[i + 4], a[i + 5]];
      const p2 = [a[j + 2], a[j + 3]];
      const p3 = [a[j], a[j + 1]];
      const len =
        Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) +
        Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) +
        Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
      const steps = Math.max(1, Math.ceil(len / 2));
      for (let q = 1; q <= steps; q++) {
        const tt = q / steps;
        const u = 1 - tt;
        const w = [u * u * u, 3 * u * u * tt, 3 * u * tt * tt, tt * tt * tt];
        out.push([
          w[0] * p0[0] + w[1] * p1[0] + w[2] * p2[0] + w[3] * p3[0],
          w[0] * p0[1] + w[1] * p1[1] + w[2] * p2[1] + w[3] * p3[1],
        ]);
      }
    }
    return out;
  });
}

/** Append `add`'s subpaths to `base`: the first of them takes `op` (a new
 *  component), the rest keep how they join. */
export function appendGeometry(
  base: Geometry,
  add: Geometry,
  op: number,
): Geometry {
  const extra = add.subpaths.map((s, i) =>
    i === 0 && s.op !== CONTINUE_OP ? { ...s, op, rule: s.rule || 1 } : s,
  );
  return { subpaths: [...base.subpaths, ...extra] };
}

export function createVectorController(deps: VectorDeps): VectorController {
  const ui: VectorUiState = {
    target: null,
    mode: "path",
    op: 1,
    shape: { ...SHAPE_DEFAULTS },
  };

  const engineOr = (): ImageEngine | null => {
    const e = deps.engine();
    if (!e || !deps.source()) {
      deps.setStatus(t(VM.noImage));
      return null;
    }
    return e;
  };

  const fail = (what: string, err: unknown) => {
    deps.setStatus(t(VM.failed, { what, error: errText(err) }));
    deps.refreshLayers();
    deps.emit();
    return false;
  };

  const activeLayer = () => {
    const l = deps.layers();
    return l.layers[l.active] ?? null;
  };

  const pathName = (id: number) => {
    try {
      return deps.engine()?.pathGeometry(id).name ?? String(id);
    } catch {
      return String(id);
    }
  };

  const geometry = (target: VectorTarget): Geometry | null => {
    const e = deps.engine();
    if (!e || !deps.source()) return null;
    try {
      if (target.kind === "path") return e.pathGeometry(target.id).geometry;
      return e.vectorMaskGet(target.layer)?.geometry ?? null;
    } catch {
      return null;
    }
  };

  const activeTarget = (): VectorTarget | null => {
    const tg = ui.target;
    if (!tg) return null;
    if (geometry(tg) === null) {
      ui.target = null;
      return null;
    }
    return tg;
  };

  /** After a path step: re-read the panel. */
  const pathChanged = (msg: string, vars: Record<string, string | number>) => {
    deps.refreshPaths();
    deps.markEdited();
    deps.refreshLayers();
    deps.setStatus(t(msg, vars));
    return true;
  };

  /** After a vector mask step: re-read the rows and re-fold. */
  const maskChanged = async (
    msg: string,
    vars: Record<string, string | number>,
  ) => {
    deps.markEdited();
    deps.refreshLayers();
    // The step is recorded whether or not the fold can run here (a
    // composite needs WebGPU); its failure keeps its own status line.
    if (await deps.recomposite()) deps.setStatus(t(msg, vars));
    return true;
  };

  const setGeometry = async (
    target: VectorTarget,
    g: Geometry,
  ): Promise<boolean> => {
    const e = engineOr();
    if (!e) return false;
    try {
      if (target.kind === "path") e.pathSet(target.id, g);
      else e.vectorMaskSet(target.layer, g);
    } catch (err) {
      return fail(
        target.kind === "path" ? "Edit path" : "Edit vector mask",
        err,
      );
    }
    if (target.kind === "path")
      return pathChanged(VM.pathEdited, { name: pathName(target.id) });
    return maskChanged(VM.maskEdited, {
      layer: deps.layers().layers[target.layer]?.name ?? "",
    });
  };

  const targetPathId = (id?: number): number | null => {
    if (id !== undefined) return id;
    const tg = activeTarget();
    return tg?.kind === "path" ? tg.id : null;
  };

  /** The active layer, when it has a vector mask. */
  const maskLayer = (): { index: number; info: LayerInfo } | null => {
    const l = deps.layers();
    const info = l.layers[l.active];
    if (!info?.vectorMask) {
      deps.setStatus(t(VM.noVectorMask));
      return null;
    }
    return { index: l.active, info };
  };

  const vectorMaskOp = async (
    what: string,
    run: (e: ImageEngine, index: number) => unknown,
    msg: string,
  ): Promise<boolean> => {
    const e = engineOr();
    if (!e) return false;
    const m = maskLayer();
    if (!m) return false;
    try {
      run(e, m.index);
    } catch (err) {
      return fail(what, err);
    }
    return maskChanged(msg, { layer: m.info.name });
  };

  return {
    state: () => ui,
    setMode(mode) {
      ui.mode = mode;
      deps.emit();
    },
    setOp(op) {
      ui.op = op >= 0 && op <= 3 ? Math.round(op) : 1;
      deps.emit();
    },
    setShapeOptions(patch) {
      ui.shape = { ...ui.shape, ...patch };
      deps.emit();
    },
    selectPath(id) {
      ui.target = id === null ? null : { kind: "path", id };
      deps.emit();
    },
    selectVectorMask(layer) {
      ui.target = layer === null ? null : { kind: "vectorMask", layer };
      deps.emit();
    },
    activeTarget,
    geometry,
    setGeometry,

    async addShape(g, mode = ui.mode) {
      const e = engineOr();
      if (!e) return false;
      if (mode === "shape") {
        if (!deps.gpu()) {
          deps.setStatus(t(VM.gpuOnly, { what: "A shape layer" }));
          return false;
        }
        const fg = deps.foreground();
        const rgb = [0, 1, 2].map((i) =>
          Math.round(Math.max(0, Math.min(1, fg[i])) * 255),
        ) as [number, number, number];
        let index: number;
        try {
          index = await e.addShapeLayer("", rgb, g);
        } catch (err) {
          return fail("Shape layer", err);
        }
        ui.target = { kind: "vectorMask", layer: index };
        deps.markEdited();
        deps.refreshLayers();
        const ok = await deps.recomposite();
        deps.setStatus(
          t(VM.shapeLayer, {
            layer: deps.layers().layers[index]?.name ?? "",
          }),
        );
        return ok;
      }
      if (mode === "pixels") {
        const ok = await deps.applyEffect(t(VM.shapePixels), (h) =>
          e.fillGeometry(h, g, deps.foreground(), true),
        );
        return ok;
      }
      // PATH mode: into the target, or a fresh work path.
      const tg = activeTarget();
      if (tg) {
        const base = geometry(tg) ?? { subpaths: [] };
        return setGeometry(tg, appendGeometry(base, g, ui.op));
      }
      let id: number;
      try {
        id = e.pathSetWork(appendGeometry({ subpaths: [] }, g, ui.op));
      } catch (err) {
        return fail("Work path", err);
      }
      ui.target = { kind: "path", id };
      return pathChanged(VM.workPath, { count: g.subpaths.length });
    },

    saveWorkPath(name = "") {
      const e = engineOr();
      if (!e) return false;
      const work = e.maskingList().paths.find((p) => p.work);
      if (!work) {
        deps.setStatus(t(VM.noWorkPath));
        return false;
      }
      try {
        e.pathSave(work.id, name);
      } catch (err) {
        return fail("Save path", err);
      }
      return pathChanged(VM.pathSaved, { name: pathName(work.id) });
    },

    async fillPath(id) {
      const e = engineOr();
      if (!e) return false;
      const pid = targetPathId(id);
      const g = pid === null ? null : geometry({ kind: "path", id: pid });
      if (pid === null || !g) {
        deps.setStatus(t(VM.noPath));
        return false;
      }
      const ok = await deps.applyEffect(
        t(VM.filled, { name: pathName(pid) }),
        (h) => e.fillGeometry(h, g, deps.foreground(), false),
      );
      return ok;
    },

    async strokePath(id, tool = "brush") {
      const e = engineOr();
      if (!e) return false;
      const pid = targetPathId(id);
      const g = pid === null ? null : geometry({ kind: "path", id: pid });
      if (pid === null || !g) {
        deps.setStatus(t(VM.noPath));
        return false;
      }
      if (!(await deps.stroke.begin(tool))) return false;
      try {
        for (const run of strokePoints(g)) {
          if (run.length === 0) continue;
          e.brushLift();
          for (const [x, y] of run) await deps.stroke.extend(x, y);
        }
      } catch (err) {
        deps.stroke.cancel();
        return fail("Stroke path", err);
      }
      const ok = await deps.stroke.commit();
      if (ok) deps.setStatus(t(VM.stroked, { name: pathName(pid), tool }));
      return ok;
    },

    async addVectorMask(start) {
      const e = engineOr();
      if (!e) return false;
      const l = deps.layers();
      const info = l.layers[l.active];
      if (!info) return false;
      let from: VectorMaskStart;
      if (start === "currentPath") {
        const pid = targetPathId();
        const g = pid === null ? null : geometry({ kind: "path", id: pid });
        if (!g) {
          deps.setStatus(t(VM.noPath));
          return false;
        }
        from = g;
      } else from = start;
      try {
        e.vectorMaskAdd(l.active, from);
      } catch (err) {
        return fail("Add vector mask", err);
      }
      ui.target = { kind: "vectorMask", layer: l.active };
      return maskChanged(VM.maskAdded, { layer: info.name });
    },

    deleteVectorMask() {
      return vectorMaskOp(
        "Delete vector mask",
        (e, i) => {
          e.vectorMaskDelete(i);
          if (ui.target?.kind === "vectorMask" && ui.target.layer === i)
            ui.target = null;
        },
        VM.maskDeleted,
      );
    },

    async toggleVectorMask() {
      const m = activeLayer()?.vectorMask;
      const on = !(m?.enabled ?? true);
      return vectorMaskOp(
        "Vector mask",
        (e, i) => e.vectorMaskFlags(i, on, m?.invert ?? false),
        on ? VM.maskOn : VM.maskOff,
      );
    },

    invertVectorMask() {
      const m = activeLayer()?.vectorMask;
      return vectorMaskOp(
        "Invert vector mask",
        (e, i) =>
          e.vectorMaskFlags(i, m?.enabled ?? true, !(m?.invert ?? false)),
        VM.maskInverted,
      );
    },

    rasterizeVectorMask() {
      return vectorMaskOp(
        "Rasterize vector mask",
        (e, i) => {
          e.vectorMaskRasterize(i);
          if (ui.target?.kind === "vectorMask" && ui.target.layer === i)
            ui.target = null;
        },
        VM.maskRasterized,
      );
    },

    importPsdPaths(psdHandle) {
      const e = deps.engine();
      if (!e) return;
      try {
        const r = e.psdPathsIntoStack(psdHandle);
        if (r.imported > 0) {
          deps.refreshPaths();
          deps.setStatus(t(VM.psdPaths, { count: r.imported }));
        }
        if (r.skipped.length)
          deps.setStatus(
            t(VM.psdPathsSkipped, {
              count: r.skipped.length,
              why: r.skipped.join("; "),
            }),
          );
      } catch {
        // No stack open: the paths stay in the file, which keeps them.
      }
    },
  };
}
