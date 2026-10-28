// The engine doors of VECTORS INSIDE THE IMAGE (image ADR 476, WP5.11):
// the document's paths as geometry (the work path, Save Path), Fill Path
// and the shape tools' Pixels mode, a layer's vector mask, shape layers,
// the PSD's paths, and the brush's pen-up for Stroke Path. Kept beside
// `engine.ts` (which spreads `wrapVectors` into the engine it wraps), as
// the masking doors are.
//
// THE GEOMETRY is one shape everywhere: per subpath its closed flag, how
// it joins the shape (the PSD length record's operation and fill rule)
// and its anchors in image px. `tableOf` / `geometryOf` turn it into
// draw's `AnchorTable` and back, so the Pen and Direct Selection machines
// (`@paged-media/draw-tools`) edit it unchanged.

import type { AnchorTable, AnchorTriple } from "@paged-media/draw-geometry";

/** The engine's decoded-handle shape (engine.ts `DecodedHandleWasm`). */
interface HandleWasm {
  handle: number;
  width: number;
  height: number;
  display: number;
  depth_reduced: boolean;
  free(): void;
}

/** The raw wasm exports these doors wrap. */
export interface VectorWasm {
  path_geometry(id: number): string;
  path_set(
    id: number,
    closed: Uint8Array,
    lens: Uint32Array,
    anchors: Float32Array,
    ops: Uint32Array,
  ): void;
  path_set_work(
    closed: Uint8Array,
    lens: Uint32Array,
    anchors: Float32Array,
    ops: Uint32Array,
  ): number;
  path_save(id: number, name: string): void;
  fill_geometry(
    handle: number,
    closed: Uint8Array,
    lens: Uint32Array,
    anchors: Float32Array,
    ops: Uint32Array,
    color: Float32Array,
    shape: boolean,
  ): Promise<HandleWasm>;
  layers_vector_mask_add(
    index: number,
    start: number,
    closed: Uint8Array,
    lens: Uint32Array,
    anchors: Float32Array,
    ops: Uint32Array,
  ): void;
  layers_vector_mask_set(
    index: number,
    closed: Uint8Array,
    lens: Uint32Array,
    anchors: Float32Array,
    ops: Uint32Array,
  ): void;
  layers_vector_mask_flags(
    index: number,
    enabled: boolean,
    invert: boolean,
  ): boolean;
  layers_vector_mask_delete(index: number): void;
  layers_vector_mask_rasterize(index: number): void;
  layers_vector_mask_get(index: number): string;
  layers_add_shape(
    name: string,
    rgb: Uint8Array,
    closed: Uint8Array,
    lens: Uint32Array,
    anchors: Float32Array,
    ops: Uint32Array,
  ): Promise<number>;
  psd_paths_into_stack(psdHandle: number): string;
  brush_stroke_lift(): void;
}

/** Photoshop's path operations, in the PSD's numbering. */
export const PATH_OPS = [
  "exclude",
  "combine",
  "subtract",
  "intersect",
] as const;
export type PathOp = (typeof PATH_OPS)[number];

/** A subpath continues the component before it (operation `0xFFFF`). */
export const CONTINUE_OP = 0xffff;

/** One subpath: closed or open, how it joins the shape (`op` 0–3 or
 *  `CONTINUE_OP`; `rule` 1 even-odd, 2 non-zero, 0 for a continuation)
 *  and its anchors as `[x, y, inX, inY, outX, outY]` per anchor (image
 *  px). */
export interface Subpath {
  closed: boolean;
  op: number;
  rule: number;
  anchors: number[];
}

/** A path's geometry. */
export interface Geometry {
  subpaths: Subpath[];
}

/** A stored path with its geometry. */
export interface PathGeometry {
  id: number;
  name: string;
  work: boolean;
  geometry: Geometry;
}

/** A layer's vector mask. */
export interface VectorMaskInfo {
  enabled: boolean;
  invert: boolean;
  geometry: Geometry;
}

/** What a new vector mask starts as. */
export type VectorMaskStart = "revealAll" | "hideAll" | Geometry;

interface GeometryJson {
  closed: boolean[];
  ops: [number, number][];
  anchors: number[][];
}

function geometryFromJson(j: GeometryJson): Geometry {
  return {
    subpaths: j.closed.map((closed, i) => ({
      closed,
      op: j.ops[i]?.[0] ?? 1,
      rule: j.ops[i]?.[1] ?? 1,
      anchors: j.anchors[i] ?? [],
    })),
  };
}

/** The flat arguments every geometry door takes. */
export function flatGeometry(
  g: Geometry,
): [Uint8Array, Uint32Array, Float32Array, Uint32Array] {
  return [
    Uint8Array.from(g.subpaths.map((s) => (s.closed ? 1 : 0))),
    Uint32Array.from(g.subpaths.map((s) => s.anchors.length / 6)),
    Float32Array.from(g.subpaths.flatMap((s) => s.anchors)),
    Uint32Array.from(g.subpaths.flatMap((s) => [s.op, s.rule])),
  ];
}

/** The geometry as draw's anchor table (inner space = image px): `left`
 *  is the handle ARRIVING at an anchor, `right` the one LEAVING it. */
export function tableOf(g: Geometry): AnchorTable {
  const anchors: AnchorTriple[] = [];
  const subpathStarts: number[] = [];
  const subpathOpen: boolean[] = [];
  for (const s of g.subpaths) {
    subpathStarts.push(anchors.length);
    subpathOpen.push(!s.closed);
    for (let k = 0; k + 5 < s.anchors.length; k += 6) {
      const a = s.anchors;
      anchors.push({
        anchor: [a[k], a[k + 1]],
        left: [a[k + 2], a[k + 3]],
        right: [a[k + 4], a[k + 5]],
      });
    }
  }
  return { anchors, subpathStarts, subpathOpen };
}

/** An anchor table back as geometry. `ops` gives each contour's
 *  operation and rule (by contour index; missing ones combine). */
export function geometryOf(
  t: AnchorTable,
  ops: readonly { op: number; rule: number }[] = [],
): Geometry {
  const n = t.anchors.length;
  const starts = t.subpathStarts.length ? t.subpathStarts : n ? [0] : [];
  const subpaths: Subpath[] = [];
  starts.forEach((from, i) => {
    const to = i + 1 < starts.length ? starts[i + 1] : n;
    if (to <= from) return;
    const anchors: number[] = [];
    for (const a of t.anchors.slice(from, to)) {
      anchors.push(
        a.anchor[0],
        a.anchor[1],
        a.left[0],
        a.left[1],
        a.right[0],
        a.right[1],
      );
    }
    const o = ops[i] ?? { op: 1, rule: 1 };
    subpaths.push({
      closed: !(t.subpathOpen?.[i] ?? false),
      op: o.op,
      rule: o.rule,
      anchors,
    });
  });
  return { subpaths };
}

/** The per-contour operations of a geometry (`geometryOf`'s `ops`). */
export function opsOf(g: Geometry): { op: number; rule: number }[] {
  return g.subpaths.map((s) => ({ op: s.op, rule: s.rule }));
}

/** The doors, as the engine exposes them. */
export interface VectorEngine<Info> {
  pathGeometry(id: number): PathGeometry;
  /** Replace a stored path's geometry. One undo step. */
  pathSet(id: number, g: Geometry): void;
  /** Put geometry in the work path (made, or replaced). One undo step;
   *  answers its id. */
  pathSetWork(g: Geometry): number;
  /** Save Path: the work path becomes a saved path. One undo step. */
  pathSave(id: number, name: string): void;
  /** Fill Path / the shape tools' Pixels mode: `color` (straight RGBA
   *  0…1) through the geometry's drawing on the active layer. GPU-only;
   *  one undo step. */
  fillGeometry(
    handle: number,
    g: Geometry,
    color: readonly [number, number, number, number],
    shape: boolean,
  ): Promise<Info>;
  vectorMaskAdd(index: number, start: VectorMaskStart): void;
  vectorMaskSet(index: number, g: Geometry): void;
  vectorMaskFlags(index: number, enabled: boolean, invert: boolean): boolean;
  vectorMaskDelete(index: number): void;
  vectorMaskRasterize(index: number): void;
  vectorMaskGet(index: number): VectorMaskInfo | null;
  /** A shape layer of `rgb` (0–255) cut by the geometry. GPU-only (the
   *  fill renders); one undo step; answers its index. */
  addShapeLayer(
    name: string,
    rgb: readonly [number, number, number],
    g: Geometry,
  ): Promise<number>;
  /** Read a PSD's paths into the Paths panel (no step). */
  psdPathsIntoStack(psdHandle: number): {
    imported: number;
    skipped: string[];
  };
  /** Pen up inside the stroke in flight (Stroke Path's subpaths). */
  brushLift(): void;
}

export function wrapVectors<Info>(
  wasm: VectorWasm,
  info: (h: HandleWasm) => Info,
): VectorEngine<Info> {
  return {
    pathGeometry(id) {
      const j = JSON.parse(wasm.path_geometry(id)) as {
        id: number;
        name: string;
        work: boolean;
        geometry: GeometryJson;
      };
      return { ...j, geometry: geometryFromJson(j.geometry) };
    },
    pathSet: (id, g) => wasm.path_set(id, ...flatGeometry(g)),
    pathSetWork: (g) => wasm.path_set_work(...flatGeometry(g)),
    pathSave: (id, name) => wasm.path_save(id, name),
    async fillGeometry(handle, g, color, shape) {
      return info(
        await wasm.fill_geometry(
          handle,
          ...flatGeometry(g),
          Float32Array.from(color),
          shape,
        ),
      );
    },
    vectorMaskAdd(index, start) {
      if (start === "revealAll" || start === "hideAll") {
        const empty = flatGeometry({ subpaths: [] });
        wasm.layers_vector_mask_add(
          index,
          start === "revealAll" ? 0 : 1,
          ...empty,
        );
      } else wasm.layers_vector_mask_add(index, 2, ...flatGeometry(start));
    },
    vectorMaskSet: (index, g) =>
      wasm.layers_vector_mask_set(index, ...flatGeometry(g)),
    vectorMaskFlags: (index, enabled, invert) =>
      wasm.layers_vector_mask_flags(index, enabled, invert),
    vectorMaskDelete: (index) => wasm.layers_vector_mask_delete(index),
    vectorMaskRasterize: (index) => wasm.layers_vector_mask_rasterize(index),
    vectorMaskGet(index) {
      const j = JSON.parse(wasm.layers_vector_mask_get(index)) as {
        enabled: boolean;
        invert: boolean;
        geometry: GeometryJson;
      } | null;
      return j && { ...j, geometry: geometryFromJson(j.geometry) };
    },
    addShapeLayer: (name, rgb, g) =>
      wasm.layers_add_shape(name, Uint8Array.from(rgb), ...flatGeometry(g)),
    psdPathsIntoStack: (h) =>
      JSON.parse(wasm.psd_paths_into_stack(h)) as {
        imported: number;
        skipped: string[];
      },
    brushLift: () => wasm.brush_stroke_lift(),
  };
}
