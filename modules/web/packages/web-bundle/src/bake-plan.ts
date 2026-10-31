/*
 * This file is part of paged (https://paged.media).
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

// The BAKE PLANNER (Phase C, ADR-020 "real output") — the PURE half of
// "flatten a rendered web frame into NATIVE Paged page items", so a flowed
// web document exports to IDML/PDF through core's own native export and a
// foreign open sees real content (no plugin engine needed). Mirrors
// plugin-sheets' `lower-to-table.ts`: a pure `SceneLayer → BakePlan`
// translation with ZERO host calls, so it is fully unit-testable. The impure
// orchestrator (`bake-to-document.ts`) measures the runs, encodes the images
// and applies the plan as host mutations.
//
// `bakeBatchOps` is the second pure step: placed plans + measured run metrics
// → the ops of ONE `batch` mutation (one undo step for a whole bake, every
// created id named by a `bindCreated` handle and read back from the outcome's
// `minted` list — no collection diffing).
//
// What bakes: text runs (position, size, colour, family + style, opacity),
// solid fills (rectangles, single- and multi-subpath paths), strokes, linear
// and radial gradient fills (native gradient swatches), a translucent paint
// (item opacity), a box with one corner radius (a rectangle with rounded
// corners), an outer box shadow (the native drop-shadow effect on the
// rectangle or path that casts it) and raster images (an image frame with the
// pixels inline), an inset box shadow (the native inner shadow of the box it
// is cast in). The CSS effects of an element (ADR 415: `opacity`,
// `mix-blend-mode`, `isolation`, `filter: drop-shadow() / opacity()`,
// `clip-path`, `mask-image`) arrive as effect groups beside the layer and map
// onto the items' and native groups' transparency, clip groups and opacity
// masks (`planEffects`). What does not is COUNTED in `deferred`, never faked:
// sweep gradients, gradient strokes, per-fill blend lanes, a shadow with no
// shape of its size to carry it, translucent gradient stops (baked opaque),
// and every effect without a native twin (`filter: blur()` and the colour
// filters, a drop shadow on a group, a mask on a group or text).
// Geometry stays in the SceneLayer's own frame-content POINTS; the
// orchestrator offsets by the frame's page origin.

import type {
  MutationInput,
  PageId,
  PathAnchorSpec,
} from "@paged-media/plugin-api";
import type {
  SceneEffectGroup,
  SceneGradient,
  SceneItem,
  SceneLayer,
  SceneLayerEffects,
  ScenePathSeg,
} from "@paged-media/web-model";

/** A process RGB swatch to create (channels 0..255), keyed by a deterministic
 *  `Color/wb-RRGGBB` self-id so the plan can reference it without a read-back.
 *  Deduplicated across the layer — one swatch per distinct colour. */
export interface BakeSwatch {
  id: string;
  r: number;
  g: number;
  b: number;
}

/** A gradient swatch to create, keyed by a deterministic `Gradient/wb-…`
 *  self-id; each stop references a {@link BakeSwatch}. */
export interface BakeGradient {
  id: string;
  kind: "Linear" | "Radial";
  stops: { colorId: string; locationPct: number }[];
}

/** A stroke: a swatch id and a weight in points. */
export interface BakeStroke {
  colorId: string;
  weight: number;
}

/** How a gradient lies on the item that it fills: angle (degrees,
 *  counter-clockwise from the x axis, as InDesign measures it) and length
 *  (points). */
export interface BakeGradientPlacement {
  angle: number;
  length: number;
}

/** A native drop shadow: offsets and size in points, opacity 0..100, colour
 *  a swatch id. */
export interface BakeShadow {
  xOffset: number;
  yOffset: number;
  size: number;
  opacityPct: number;
  colorId: string;
}

/** A native inner shadow: the light's angle (degrees, IDML) and distance,
 *  size in points, opacity 0..100, colour a swatch id. */
export interface BakeInnerShadow {
  angle: number;
  distance: number;
  size: number;
  opacityPct: number;
  colorId: string;
}

/** A planned item or native group: `index` into the plan's list of that
 *  kind. */
export interface BakeRef {
  kind: "rect" | "path" | "text" | "image" | "group";
  index: number;
}

/** A native group (ADR 415) of planned items and groups — created after
 *  them, children before parents. With `clip`, the group is a clip group
 *  whose top member is a path of that outline (frame-content points). */
export interface BakeGroup {
  members: BakeRef[];
  clip?: PathAnchorSpec[][];
  /** Group opacity 0..100; absent = opaque. */
  opacity?: number;
  /** The group's blend mode, IDML spelling. */
  blend?: string;
  isolate?: boolean;
}

/** An opacity mask (CSS `mask-image`) on one planned item: a rectangle
 *  painting the mask — a gradient whose grey levels are the mask's alpha
 *  (`Luminosity`), or the mask image itself (`Alpha`). */
export type BakeMask = {
  target: BakeRef;
  bounds: [number, number, number, number];
} & (
  | {
      kind: "gradient";
      gradientId: string;
      gradient: BakeGradientPlacement;
    }
  | {
      kind: "image";
      rgba: Uint8Array | number[];
      width: number;
      height: number;
    }
);

/** A rectangle → a native rectangle frame. Bounds are frame-content points
 *  `[top, left, bottom, right]`; `fillColorId` is a {@link BakeSwatch} or
 *  {@link BakeGradient} id (`null`: no fill, a stroke-only rectangle). */
export interface BakeRect {
  bounds: [number, number, number, number];
  fillColorId: string | null;
  gradient?: BakeGradientPlacement;
  stroke?: BakeStroke;
  /** Item opacity 0..100 (a translucent paint); absent = opaque. */
  opacity?: number;
  shadow?: BakeShadow;
  innerShadow?: BakeInnerShadow;
  /** Blend mode, IDML spelling (an element's `mix-blend-mode`). */
  blend?: string;
  /** One radius (points) on all four corners, as rounded corners; absent =
   *  square corners. */
  cornerRadius?: number;
}

/** A NON-rectangular shape → a native path (`insertPath`). `anchors` (the
 *  first subpath) are in frame-content points; `subpaths` holds every
 *  subpath when there is more than one (a ring, a glyph-like shape) — the
 *  path is then given its full geometry in the same batch. */
export interface BakePath {
  anchors: PathAnchorSpec[];
  subpaths?: PathAnchorSpec[][];
  /** An open path (a stroke that does not close). */
  open?: boolean;
  fillColorId: string | null;
  gradient?: BakeGradientPlacement;
  stroke?: BakeStroke;
  opacity?: number;
  shadow?: BakeShadow;
  innerShadow?: BakeInnerShadow;
  blend?: string;
}

/** A single-line text run → a native text frame. `left`/`baseline` are the
 *  run's origin in frame-content points (the C-1 `SceneTextItem` x / y);
 *  the orchestrator sizes the frame (width: the engine's shaped advance or
 *  `host.text.measureString`, height from `sizePt`). `fillColorId` is a
 *  {@link BakeSwatch} id; `family` / `fontStyle` the face the run was
 *  shaped with (`fontStyle` in IDML spelling: `"Bold Italic"`). */
export interface BakeText {
  left: number;
  baseline: number;
  text: string;
  sizePt: number;
  fillColorId: string;
  family?: string;
  fontStyle?: string;
  /** The run's shaped advance (points), from the engine. */
  advance?: number;
  opacity?: number;
  shadow?: BakeShadow;
  blend?: string;
}

/** A raster image → a native image frame carrying the pixels. `rgba` is
 *  straight RGBA8, `width` x `height`; the orchestrator encodes it. */
export interface BakeImage {
  bounds: [number, number, number, number];
  rgba: Uint8Array | number[];
  width: number;
  height: number;
  opacity?: number;
  shadow?: BakeShadow;
  blend?: string;
}

/** The native-content plan for one rendered web frame — pure data. */
export interface BakePlan {
  swatches: BakeSwatch[];
  gradients: BakeGradient[];
  rects: BakeRect[];
  paths: BakePath[];
  texts: BakeText[];
  images: BakeImage[];
  /** Native groups (ADR 415), children before parents; absent when none. */
  groups?: BakeGroup[];
  /** Opacity masks (ADR 415); absent when none. */
  masks?: BakeMask[];
  /** Un-baked SceneItem kinds, counted honestly (never faked). Keys are the
   *  wire `kind` (or a refinement like `dropShadow.noShape`); values are
   *  counts. */
  deferred: Record<string, number>;
}

/** Two hex nibbles for a 0..1 channel, clamped — the swatch id + value share
 *  this rounding so a colour maps to exactly one swatch. */
function channel255(v: number): number {
  const n = Math.round(Math.max(0, Math.min(1, v)) * 255);
  return n;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/** A path is an axis-aligned rectangle iff its segments visit exactly two
 *  distinct x's and two distinct y's along axis-aligned edges (a `moveTo`, up
 *  to four `lineTo`, optional `close`; any `cubicTo` disqualifies it). Returns
 *  the bounds `[top, left, bottom, right]`, or `null` when it is not a rect. */
export function pathAsRect(
  path: ScenePathSeg[],
): [number, number, number, number] | null {
  const xs = new Set<number>();
  const ys = new Set<number>();
  let pts = 0;
  for (const seg of path) {
    if (seg.op === "close") continue;
    if (seg.op === "cubicTo") return null; // a curve is not an axis-aligned rect
    // moveTo | lineTo — round to 3dp so float noise doesn't inflate the count.
    xs.add(Math.round(seg.x * 1000) / 1000);
    ys.add(Math.round(seg.y * 1000) / 1000);
    pts += 1;
  }
  // A rectangle traces 4 corners (a 5th point may repeat the first).
  if (pts < 4 || pts > 5 || xs.size !== 2 || ys.size !== 2) return null;
  const xArr = [...xs].sort((a, b) => a - b);
  const yArr = [...ys].sort((a, b) => a - b);
  return [yArr[0], xArr[0], yArr[1], xArr[1]];
}

/** The control-point distance of a cubic quarter circle, as a fraction of
 *  its radius. */
const KAPPA = 0.552284749831;

/** A path is a rectangle with ONE corner radius iff it is a single subpath of
 *  four circular quarter arcs (cubics, control points at {@link KAPPA} of the
 *  radius along the corner's edges), one at each corner of its bounds, joined
 *  by axis-aligned edges (absent when the radius takes the whole side) — how
 *  a CSS box with a uniform `border-radius` paints. Returns the bounds
 *  `[top, left, bottom, right]` and the radius, or `null`. */
export function pathAsRoundedRect(
  path: ScenePathSeg[],
): { bounds: [number, number, number, number]; radius: number } | null {
  if (path.length < 5 || path[0].op !== "moveTo") return null;
  const bounds = pathBounds(path);
  if (bounds === null) return null;
  const [t, l, b, r] = bounds;
  const eq = (a: number, c: number, tol = 0.01) => Math.abs(a - c) <= tol;
  const onX = (x: number) => eq(x, l) || eq(x, r);
  const onY = (y: number) => eq(y, t) || eq(y, b);
  let x = path[0].x;
  let y = path[0].y;
  let radius: number | null = null;
  const corners = new Set<string>();
  for (let i = 1; i < path.length; i += 1) {
    const seg = path[i];
    if (seg.op === "close") {
      if (i !== path.length - 1) return null;
      continue;
    }
    if (seg.op === "moveTo") return null;
    if (seg.op === "lineTo") {
      if (!eq(seg.x, x) && !eq(seg.y, y)) return null; // a diagonal edge
      x = seg.x;
      y = seg.y;
      continue;
    }
    // A quarter arc: from one edge of the bounds to the adjacent one.
    const rx = Math.abs(seg.x - x);
    const ry = Math.abs(seg.y - y);
    if (!(rx > 0.01) || !eq(rx, ry)) return null;
    let cx: number;
    let cy: number;
    if (onX(x) && onY(seg.y)) {
      cx = x;
      cy = seg.y;
    } else if (onY(y) && onX(seg.x)) {
      cx = seg.x;
      cy = y;
    } else return null;
    const tol = Math.max(0.02 * rx, 0.01);
    if (
      !eq(seg.cx1, x + KAPPA * (cx - x), tol) ||
      !eq(seg.cy1, y + KAPPA * (cy - y), tol) ||
      !eq(seg.cx2, seg.x + KAPPA * (cx - seg.x), tol) ||
      !eq(seg.cy2, seg.y + KAPPA * (cy - seg.y), tol)
    ) {
      return null;
    }
    if (radius === null) radius = rx;
    else if (!eq(radius, rx)) return null;
    corners.add(`${eq(cx, l) ? "l" : "r"}${eq(cy, t) ? "t" : "b"}`);
    x = seg.x;
    y = seg.y;
  }
  if (radius === null || corners.size !== 4) return null;
  if (radius > Math.min(r - l, b - t) / 2 + 0.01) return null;
  return { bounds, radius: Math.round(radius * 1000) / 1000 };
}

/** Convert a SINGLE-subpath {@link ScenePathSeg} run to `insertPath` anchors
 *  (frame-content points). Each anchor is a `{ anchor, left, right }` triple:
 *  a corner point has `left = right = anchor`; a `cubicTo` sets the PREVIOUS
 *  anchor's `right` out-handle (its first control point) and the NEW anchor's
 *  `left` in-handle (its second) — the InDesign bezier model. Returns `null`
 *  for a multi-subpath path (a second `moveTo`), a cubic with no start, or a
 *  degenerate run (< 2 anchors) — those stay deferred. A `close` is geometry-
 *  neutral (a fill is a closed region regardless). */
export function pathToAnchors(path: ScenePathSeg[]): PathAnchorSpec[] | null {
  const anchors: PathAnchorSpec[] = [];
  let started = false;
  for (const seg of path) {
    if (seg.op === "moveTo") {
      if (started) return null; // a second subpath — v1 is single-subpath only
      started = true;
      anchors.push({
        anchor: [seg.x, seg.y],
        left: [seg.x, seg.y],
        right: [seg.x, seg.y],
      });
    } else if (seg.op === "lineTo") {
      if (!started) return null;
      anchors.push({
        anchor: [seg.x, seg.y],
        left: [seg.x, seg.y],
        right: [seg.x, seg.y],
      });
    } else if (seg.op === "cubicTo") {
      if (anchors.length === 0) return null;
      anchors[anchors.length - 1].right = [seg.cx1, seg.cy1];
      anchors.push({
        anchor: [seg.x, seg.y],
        left: [seg.cx2, seg.cy2],
        right: [seg.x, seg.y],
      });
    }
    // `close` — ignored: the fill is closed by the engine either way.
  }
  return anchors.length >= 2 ? anchors : null;
}

/** Split a {@link ScenePathSeg} run into its subpaths' anchors (see
 *  {@link pathToAnchors}), and whether it is OPEN (no subpath closes — a
 *  stroked line). `null` when a subpath is degenerate (< 2 anchors) or a
 *  segment has no start. */
export function pathToSubpaths(
  path: ScenePathSeg[],
): { subpaths: PathAnchorSpec[][]; open: boolean } | null {
  const subpaths: PathAnchorSpec[][] = [];
  let cur: PathAnchorSpec[] | null = null;
  let closed = false;
  for (const seg of path) {
    if (seg.op === "moveTo") {
      cur = [
        { anchor: [seg.x, seg.y], left: [seg.x, seg.y], right: [seg.x, seg.y] },
      ];
      subpaths.push(cur);
    } else if (seg.op === "lineTo") {
      if (!cur) return null;
      cur.push({
        anchor: [seg.x, seg.y],
        left: [seg.x, seg.y],
        right: [seg.x, seg.y],
      });
    } else if (seg.op === "cubicTo") {
      if (!cur || cur.length === 0) return null;
      cur[cur.length - 1].right = [seg.cx1, seg.cy1];
      cur.push({
        anchor: [seg.x, seg.y],
        left: [seg.cx2, seg.cy2],
        right: [seg.x, seg.y],
      });
    } else {
      closed = true;
    }
  }
  if (subpaths.length === 0 || subpaths.some((sp) => sp.length < 2))
    return null;
  return { subpaths, open: !closed };
}

/** A path's axis-aligned bounds `[top, left, bottom, right]` (anchor and
 *  control points), or `null` for an empty path. */
export function pathBounds(
  path: ScenePathSeg[],
): [number, number, number, number] | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const seg of path) {
    if (seg.op === "close") continue;
    xs.push(seg.x);
    ys.push(seg.y);
    if (seg.op === "cubicTo") {
      xs.push(seg.cx1, seg.cx2);
      ys.push(seg.cy1, seg.cy2);
    }
  }
  if (xs.length === 0) return null;
  return [Math.min(...ys), Math.min(...xs), Math.max(...ys), Math.max(...xs)];
}

/** The face name a run asks for within its family, from its CSS weight and
 *  slope — the type-menu naming core uses for a scene run (`700` + italic →
 *  `"Bold Italic"`, `400` → `"Regular"`). */
export function fontStyleName(
  weight: number | undefined,
  italic: boolean | undefined,
): string {
  const w = Math.round(weight ?? 400);
  const base =
    w < 150
      ? "Thin"
      : w < 250
        ? "ExtraLight"
        : w < 350
          ? "Light"
          : w < 450
            ? "Regular"
            : w < 550
              ? "Medium"
              : w < 650
                ? "SemiBold"
                : w < 750
                  ? "Bold"
                  : w < 850
                    ? "ExtraBold"
                    : "Black";
  if (!italic) return base;
  return base === "Regular" ? "Italic" : `${base} Italic`;
}

/** FNV-1a, 8 hex digits — deterministic ids for gradient swatches. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** An opacity percentage for a 0..1 alpha, `undefined` when opaque. */
function opacityOf(a: number): number | undefined {
  const pct = Math.round(Math.max(0, Math.min(1, a)) * 1000) / 10;
  return pct >= 100 ? undefined : pct;
}

const NEAR = (a: number, b: number) => Math.abs(a - b) <= 0.5;

/**
 * Translate a rendered {@link SceneLayer} into a {@link BakePlan}. Pure +
 * total — same layer → same plan, never throws. Colours are deduplicated into
 * `swatches` (a fully transparent paint is skipped as "nothing to paint"; a
 * translucent one becomes the item's opacity). `advances` is the engine's
 * shaped advance per `text` item, in item order (`take_text_advances`);
 * `effects` the layer's CSS effect groups (`take_effects`, ADR 415).
 */
export function sceneLayerToBakePlan(
  layer: SceneLayer,
  advances: readonly number[] = [],
  effects?: SceneLayerEffects,
): BakePlan {
  const swatchById = new Map<string, BakeSwatch>();
  const gradientById = new Map<string, BakeGradient>();
  const rects: BakeRect[] = [];
  const paths: BakePath[] = [];
  const texts: BakeText[] = [];
  const images: BakeImage[] = [];
  const deferred: Record<string, number> = {};
  const defer = (k: string) => {
    deferred[k] = (deferred[k] ?? 0) + 1;
  };
  /** Outer shadows waiting for the rectangle that casts them (blitz paints
   *  a box's shadow just before the box), with their painted bounds. */
  const shadows: {
    bounds: [number, number, number, number];
    size: number;
    opacityPct: number;
    colorId: string;
  }[] = [];

  /** Register (dedupe) a paint as a swatch and return its id, or null when the
   *  paint is fully transparent (nothing to bake). */
  const swatchFor = (paint: {
    r: number;
    g: number;
    b: number;
    a: number;
  }): string | null => {
    if (paint.a <= 0) return null;
    const r = channel255(paint.r);
    const g = channel255(paint.g);
    const b = channel255(paint.b);
    const id = `Color/wb-${hex2(r)}${hex2(g)}${hex2(b)}`;
    if (!swatchById.has(id)) swatchById.set(id, { id, r, g, b });
    return id;
  };

  const gradientFor = (
    gradient: SceneGradient,
  ): { id: string; placement: BakeGradientPlacement } | null => {
    if (gradient.type === "sweep" || gradient.stops.length < 2) return null;
    if (gradient.stops.some((st) => st.a < 1))
      defer("fillPathGradient.translucentStop");
    const stops = gradient.stops.map((st) => ({
      colorId: swatchFor({ ...st, a: 1 }) as string,
      locationPct: Math.round(Math.max(0, Math.min(1, st.offset)) * 1000) / 10,
    }));
    const kind = gradient.type === "linear" ? "Linear" : "Radial";
    const id = `Gradient/wb-${shortHash(JSON.stringify([kind, stops]))}`;
    if (!gradientById.has(id)) gradientById.set(id, { id, kind, stops });
    const placement =
      gradient.type === "linear"
        ? {
            angle:
              (Math.atan2(
                -(gradient.y1 - gradient.y0),
                gradient.x1 - gradient.x0,
              ) *
                180) /
              Math.PI,
            length: Math.hypot(
              gradient.x1 - gradient.x0,
              gradient.y1 - gradient.y0,
            ),
          }
        : { angle: 0, length: gradient.radius };
    return { id, placement };
  };

  /** The waiting shadow cast by a shape with these bounds (same size, offset
   *  by the shadow's offset), taken off the waiting list; `undefined` when
   *  none is waiting. */
  const takeShadow = (
    bounds: [number, number, number, number],
  ): BakeShadow | undefined => {
    const h = bounds[2] - bounds[0];
    const w = bounds[3] - bounds[1];
    const i = shadows.findIndex(
      (sh) =>
        NEAR(sh.bounds[2] - sh.bounds[0], h) &&
        NEAR(sh.bounds[3] - sh.bounds[1], w),
    );
    if (i < 0) return undefined;
    const [sh] = shadows.splice(i, 1);
    return {
      xOffset: sh.bounds[1] - bounds[1],
      yOffset: sh.bounds[0] - bounds[0],
      size: sh.size,
      opacityPct: sh.opacityPct,
      colorId: sh.colorId,
    };
  };

  /** What each layer item became (`null`: nothing of its own — a shadow
   *  carried by a shape, a skipped or deferred item). */
  const refs: (BakeRef | null)[] = [];
  /** The rectangles and paths in paint order, with their bounds — where an
   *  inset shadow finds the box it is cast in. */
  const shapes: {
    ref: BakeRef;
    bounds: [number, number, number, number];
  }[] = [];

  /** A filled or stroked shape: a rectangle when it is one (square, or with
   *  one corner radius), else a path. */
  const shape = (
    path: ScenePathSeg[],
    fill: { colorId: string | null; gradient?: BakeGradientPlacement },
    extra: { stroke?: BakeStroke; opacity?: number },
    kind: string,
  ): BakeRef | null => {
    const closed =
      extra.stroke === undefined || path.some((sg) => sg.op === "close");
    const square = closed ? pathAsRect(path) : null;
    const rounded = closed && square === null ? pathAsRoundedRect(path) : null;
    const rect = square ?? rounded?.bounds ?? null;
    if (rect !== null) {
      const r: BakeRect = { bounds: rect, fillColorId: fill.colorId };
      if (rounded) r.cornerRadius = rounded.radius;
      if (fill.gradient) r.gradient = fill.gradient;
      if (extra.stroke) r.stroke = extra.stroke;
      if (extra.opacity !== undefined) r.opacity = extra.opacity;
      const shadow = takeShadow(rect);
      if (shadow) r.shadow = shadow;
      rects.push(r);
      const ref: BakeRef = { kind: "rect", index: rects.length - 1 };
      shapes.push({ ref, bounds: rect });
      return ref;
    }
    const geo = pathToSubpaths(path);
    if (geo === null) {
      defer(`${kind}.degenerate`);
      return null;
    }
    const p: BakePath = { anchors: geo.subpaths[0], fillColorId: fill.colorId };
    if (geo.subpaths.length > 1) p.subpaths = geo.subpaths;
    if (geo.open && extra.stroke) p.open = true;
    if (fill.gradient) p.gradient = fill.gradient;
    if (extra.stroke) p.stroke = extra.stroke;
    if (extra.opacity !== undefined) p.opacity = extra.opacity;
    const bounds = pathBounds(path);
    const shadow = bounds ? takeShadow(bounds) : undefined;
    if (shadow) p.shadow = shadow;
    paths.push(p);
    const ref: BakeRef = { kind: "path", index: paths.length - 1 };
    if (bounds) shapes.push({ ref, bounds });
    return ref;
  };

  let textIndex = 0;
  for (const [itemIndex, item] of layer.items.entries()) {
    refs[itemIndex] = null;
    switch (item.kind) {
      case "text": {
        const advance = advances[textIndex];
        textIndex += 1;
        if (item.text.length === 0) break;
        const colorId = swatchFor(item.paint);
        if (colorId === null) break; // transparent text → nothing to bake
        const t: BakeText = {
          left: item.x,
          baseline: item.y,
          text: item.text,
          sizePt: item.size,
          fillColorId: colorId,
        };
        if (item.family) {
          t.family = item.family;
          t.fontStyle = item.style ?? fontStyleName(item.weight, item.italic);
        }
        if (typeof advance === "number" && advance > 0) t.advance = advance;
        const opacity = opacityOf(item.paint.a);
        if (opacity !== undefined) t.opacity = opacity;
        texts.push(t);
        refs[itemIndex] = { kind: "text", index: texts.length - 1 };
        break;
      }
      case "fillPath": {
        const colorId = swatchFor(item.paint);
        if (colorId === null) break; // transparent fill → nothing to bake
        refs[itemIndex] = shape(
          item.path,
          { colorId },
          { opacity: opacityOf(item.paint.a) },
          "fillPath",
        );
        break;
      }
      case "strokePath": {
        const colorId = swatchFor(item.paint);
        if (colorId === null || !(item.width > 0)) break;
        refs[itemIndex] = shape(
          item.path,
          { colorId: null },
          {
            stroke: { colorId, weight: item.width },
            opacity: opacityOf(item.paint.a),
          },
          "strokePath",
        );
        break;
      }
      case "fillPathGradient": {
        const g = gradientFor(item.gradient);
        if (g === null) {
          defer(`fillPathGradient.${item.gradient.type}`);
          break;
        }
        refs[itemIndex] = shape(
          item.path,
          { colorId: g.id, gradient: g.placement },
          {},
          "fillPathGradient",
        );
        break;
      }
      case "dropShadow": {
        const bounds = pathBounds(item.path);
        const colorId = swatchFor({ r: item.r, g: item.g, b: item.b, a: 1 });
        if (bounds === null || colorId === null || item.a <= 0) break;
        shadows.push({
          bounds: [
            bounds[0] + item.offset_y,
            bounds[1] + item.offset_x,
            bounds[2] + item.offset_y,
            bounds[3] + item.offset_x,
          ],
          // The wire carries the CSS blur radius (the layout engine hands
          // it on as is); CSS blurs with a deviation of half of it, and
          // InDesign's Size is twice the deviation — the same number.
          size: item.blur_radius,
          opacityPct: Math.round(Math.max(0, Math.min(1, item.a)) * 1000) / 10,
          colorId,
        });
        break;
      }
      case "image": {
        if (
          !(item.width > 0 && item.height > 0) ||
          item.rgba.length !== item.width * item.height * 4
        ) {
          defer("image.malformed");
          break;
        }
        images.push({
          bounds: [item.y, item.x, item.y + item.h, item.x + item.w],
          rgba: item.rgba,
          width: item.width,
          height: item.height,
        });
        refs[itemIndex] = { kind: "image", index: images.length - 1 };
        break;
      }
      case "innerShadow": {
        // An inset box shadow: the path is the element's border box moved
        // by the shadow's offset. The box it is cast in is the latest shape
        // of that size painted before it (the element's background).
        const b = pathBounds(item.path);
        const colorId = swatchFor({ r: item.r, g: item.g, b: item.b, a: 1 });
        if (b === null || colorId === null || item.a <= 0) break;
        const h = b[2] - b[0];
        const w = b[3] - b[1];
        let host: (typeof shapes)[number] | undefined;
        for (let i = shapes.length - 1; i >= 0; i -= 1) {
          const sb = shapes[i].bounds;
          if (NEAR(sb[2] - sb[0], h) && NEAR(sb[3] - sb[1], w)) {
            host = shapes[i];
            break;
          }
        }
        if (!host) {
          defer("innerShadow.noShape");
          break;
        }
        const target =
          host.ref.kind === "rect"
            ? rects[host.ref.index]
            : paths[host.ref.index];
        if (target.innerShadow) {
          defer("innerShadow.stacked");
          break;
        }
        const dx = b[1] - host.bounds[1] + item.offset_x;
        const dy = b[0] - host.bounds[0] + item.offset_y;
        const distance = Math.hypot(dx, dy);
        target.innerShadow = {
          // IDML casts an effect at `(-d·cos a, d·sin a)` (y down).
          angle:
            distance > 0 ? round3((Math.atan2(dy, -dx) * 180) / Math.PI) : 120,
          distance: round3(distance),
          size: round3(item.blur_radius),
          opacityPct: Math.round(Math.max(0, Math.min(1, item.a)) * 1000) / 10,
          colorId,
        };
        break;
      }
      default: {
        // A wire kind the bake has no native twin for (blend modes, inner
        // shadows, gradient strokes) — counted by its tag.
        const kind = (item as { kind?: string }).kind ?? "unknown";
        defer(kind);
        break;
      }
    }
  }
  // A shadow no shape of its size took (nothing painted the box that casts
  // it).
  for (let i = 0; i < shadows.length; i += 1) defer("dropShadow.noShape");

  const plan: BakePlan = {
    swatches: [],
    gradients: [],
    rects,
    paths,
    texts,
    images,
    deferred,
  };
  if (effects) {
    planEffects(plan, refs, effects, { defer, swatchFor, gradientFor });
  }
  plan.swatches = [...swatchById.values()];
  plan.gradients = [...gradientById.values()];
  return plan;
}

// ------------------------------------------------------------ CSS effects

/** The planner's colour helpers, lent to {@link planEffects}. */
interface EffectHelpers {
  defer: (key: string) => void;
  swatchFor: (paint: {
    r: number;
    g: number;
    b: number;
    a: number;
  }) => string | null;
  gradientFor: (
    gradient: SceneGradient,
  ) => { id: string; placement: BakeGradientPlacement } | null;
}

/** The planned item a ref names (never a group). */
type PlannedItem = BakeRect | BakePath | BakeText | BakeImage;

/** Multiply an opacity percentage (absent = 100) by a 0..1 factor. */
function mulOpacity(
  pct: number | undefined,
  factor: number,
): number | undefined {
  const v =
    Math.round((pct ?? 100) * Math.max(0, Math.min(1, factor)) * 10) / 10;
  return v >= 100 ? undefined : v;
}

/**
 * Map a layer's CSS effect groups (ADR 415) onto the plan, innermost first.
 * A group whose effects one item can carry is folded into that item (its
 * opacity multiplied in, its blend mode, drop shadow and mask set on it); any
 * other becomes a native group of its members (a clip group when it has a
 * `clip-path`). What has no native twin is deferred by key, never faked:
 * `filter.blur`, `filter.<colour function>` (the image-adjustment stack is
 * not on this engine), `filter.url`, a drop shadow or mask a group or text
 * would have to carry, a second drop shadow.
 */
export function planEffects(
  plan: BakePlan,
  refs: readonly (BakeRef | null)[],
  effects: SceneLayerEffects,
  h: EffectHelpers,
): void {
  for (const [key, n] of Object.entries(effects.losses ?? {}))
    for (let i = 0; i < n; i += 1) h.defer(key);
  const groups = effects.groups;
  const groupsOut: BakeGroup[] = [];
  const masks: BakeMask[] = [];
  /** What each effect group resolved to (`null`: it baked nothing). */
  const node: (BakeRef | null)[] = groups.map(() => null);
  const children = groups.map(() => [] as number[]);
  groups.forEach((g, i) => {
    if (g.parent !== undefined && g.parent < i) children[g.parent].push(i);
  });
  const item = (ref: BakeRef): PlannedItem | undefined =>
    ref.kind === "rect"
      ? plan.rects[ref.index]
      : ref.kind === "path"
        ? plan.paths[ref.index]
        : ref.kind === "text"
          ? plan.texts[ref.index]
          : ref.kind === "image"
            ? plan.images[ref.index]
            : undefined;
  const wrap = (members: BakeRef[], clip?: PathAnchorSpec[][]): BakeRef => {
    const grp: BakeGroup = { members };
    if (clip) grp.clip = clip;
    groupsOut.push(grp);
    return { kind: "group", index: groupsOut.length - 1 };
  };

  for (let gi = groups.length - 1; gi >= 0; gi -= 1) {
    const g = groups[gi];
    for (const key of g.losses ?? []) h.defer(key);
    // The direct members, in paint order: the items no child group holds,
    // and what each child group became.
    const members: { at: number; ref: BakeRef }[] = [];
    const inChild = (i: number) =>
      children[gi].some((c) => groups[c].start <= i && i < groups[c].end);
    for (let i = g.start; i < g.end; i += 1) {
      const ref = refs[i];
      if (ref && !inChild(i)) members.push({ at: i, ref });
    }
    for (const c of children[gi]) {
      const ref = node[c];
      if (ref) members.push({ at: groups[c].start, ref });
    }
    members.sort((a, b) => a.at - b.at);
    if (members.length === 0) continue;

    // The filter list: opacity() multiplies in, a drop shadow maps, the rest
    // has no native twin.
    let opacity = g.opacity;
    const dropShadows: Extract<
      NonNullable<SceneEffectGroup["filters"]>[number],
      { kind: "dropShadow" }
    >[] = [];
    for (const f of g.filters ?? []) {
      if (f.kind === "opacity") opacity *= f.amount;
      else if (f.kind === "dropShadow") dropShadows.push(f);
      else if (f.kind === "blur") h.defer("filter.blur");
      else if (f.kind === "url") h.defer("filter.url");
      else h.defer(`filter.${f.function}`);
    }

    let clip: PathAnchorSpec[][] | undefined;
    if (g.clip) {
      const geo = pathToSubpaths(g.clip);
      if (geo) clip = geo.subpaths;
      else h.defer("clipPath.degenerate");
    }

    // One member and no clip: the member carries the effects itself.
    let ref: BakeRef =
      members.length === 1 && !clip
        ? members[0].ref
        : wrap(members.map((m) => m.ref));

    // The mask goes on the one item it masks, inside any clip group.
    if (g.mask && g.mask.length > 0) {
      const target = members.length === 1 ? members[0].ref : ref;
      const mask = planMask(g.mask, target, h);
      if (target.kind === "group") h.defer("mask.group");
      else if (target.kind === "text") h.defer("mask.text");
      else if (mask === null) h.defer("mask.unsupported");
      else masks.push(mask);
    }
    if (clip) {
      // The clip group wraps what the element painted (its members, or the
      // group made of them).
      ref =
        ref.kind === "group" && groupsOut[ref.index].clip === undefined
          ? ((groupsOut[ref.index].clip = clip), ref)
          : wrap([ref], clip);
    }

    // Blend: a node already blended (by a child group) is wrapped, so both
    // modes apply in the CSS order.
    const target = (): PlannedItem | BakeGroup =>
      ref.kind === "group" ? groupsOut[ref.index] : (item(ref) as PlannedItem);
    if (g.blend) {
      if (target().blend !== undefined) ref = wrap([ref]);
      target().blend = g.blend;
    }
    if (opacity < 1) {
      const t = target();
      t.opacity = mulOpacity(t.opacity, opacity);
    }
    if (g.isolate && ref.kind === "group") groupsOut[ref.index].isolate = true;

    for (const [i, f] of dropShadows.entries()) {
      const t = target();
      if (i > 0) h.defer("filter.dropShadow.multiple");
      else if (ref.kind === "group") h.defer("filter.dropShadow.group");
      else if ((t as BakeRect).shadow) h.defer("filter.dropShadow.stacked");
      else {
        const colorId = h.swatchFor({ r: f.r, g: f.g, b: f.b, a: 1 });
        if (colorId === null) continue;
        (t as BakeRect).shadow = {
          xOffset: f.dx,
          yOffset: f.dy,
          size: f.blur,
          opacityPct: Math.round(Math.max(0, Math.min(1, f.a)) * 1000) / 10,
          colorId,
        };
      }
    }
    node[gi] = ref;
  }
  if (groupsOut.length > 0) plan.groups = groupsOut;
  if (masks.length > 0) plan.masks = masks;
}

/** The opacity mask a CSS mask's paint makes on `target`: one gradient fill
 *  (its stops' alpha as grey levels — a luminosity mask) or one image (an
 *  alpha mask). `null` for anything else. */
function planMask(
  paint: readonly SceneItem[],
  target: BakeRef,
  h: EffectHelpers,
): BakeMask | null {
  if (paint.length !== 1) return null;
  const m = paint[0];
  if (m.kind === "image") {
    if (!(m.width > 0 && m.height > 0)) return null;
    return {
      target,
      bounds: [m.y, m.x, m.y + m.h, m.x + m.w],
      kind: "image",
      rgba: m.rgba,
      width: m.width,
      height: m.height,
    };
  }
  if (m.kind === "fillPathGradient") {
    const bounds = pathBounds(m.path);
    if (bounds === null) return null;
    // White where the mask is opaque, black where it is clear.
    const grey: SceneGradient = {
      ...m.gradient,
      stops: m.gradient.stops.map((st) => ({
        offset: st.offset,
        r: st.a,
        g: st.a,
        b: st.a,
        a: 1,
      })),
    } as SceneGradient;
    const g = h.gradientFor(grey);
    if (g === null) return null;
    return {
      target,
      bounds,
      kind: "gradient",
      gradientId: g.id,
      gradient: g.placement,
    };
  }
  return null;
}

// ---------------------------------------------------------------- one batch

/** A little width slack on a baked text frame so the run never clips at the
 *  right edge (points). */
export const TEXT_PAD_PT = 2;

/** A run's measured extent in points (`host.text.measureString`'s answer, or
 *  the orchestrator's estimate). `descender` is negative below the baseline. */
export interface RunMetrics {
  advance: number;
  ascender: number;
  descender: number;
}

/** One frame's plan placed on its page: the plan's frame-content points are
 *  offset by the frame's page origin (`top`/`left`, points). `metrics` holds
 *  one entry per `plan.texts` item, same order; `imageBytes` one encoded
 *  image (PNG) per `plan.images` item, `null` where encoding failed. */
export interface PlacedBakePlan {
  plan: BakePlan;
  pageId: PageId | string;
  top: number;
  left: number;
  metrics: readonly RunMetrics[];
  imageBytes?: readonly (Uint8Array | null)[];
  /** One encoded image (PNG) per image mask in `plan.masks` order (`null`
   *  for a gradient mask or where encoding failed). */
  maskBytes?: readonly (Uint8Array | null)[];
}

/** The ops of one bake batch, plus the handle each created item is bound to
 *  (the outcome's `minted[].handle` names them back). */
export interface BakeBatch {
  ops: MutationInput[];
  /** Swatch ids the batch creates (the plans' swatches minus `existing`,
   *  each once). */
  swatchIds: string[];
  /** Gradient ids the batch creates. */
  gradientIds: string[];
  /** Handles of the rectangles, paths, images and text frames, in op order. */
  handles: {
    rects: string[];
    paths: string[];
    texts: string[];
    images: string[];
    /** Native groups (ADR 415), clip paths and mask rectangles. */
    groups: string[];
    clips: string[];
    masks: string[];
  };
}

/** Story offsets count CHARACTERS (Unicode scalar values) — the engine's
 *  `chars().count()` — not UTF-16 code units. */
export function charCount(text: string): number {
  let n = 0;
  for (const _c of text) n += 1;
  return n;
}

const storyRangeOf = (handle: string, end: number) => ({
  kind: "storyRange",
  id: { story_id: `$h:${handle}`, start: 0, end },
});

const setProp = (
  elementId: unknown,
  path: string,
  value: { type: string; value: unknown },
): MutationInput =>
  ({
    op: "setElementProperty",
    args: { elementId, path, value },
  }) as MutationInput;

const shift = (
  a: PathAnchorSpec,
  left: number,
  top: number,
): PathAnchorSpec => ({
  anchor: [a.anchor[0] + left, a.anchor[1] + top],
  left: [a.left[0] + left, a.left[1] + top],
  right: [a.right[0] + left, a.right[1] + top],
});

/** The style ops of a shape (rectangle or path) addressed as `el`. */
function shapeStyleOps(
  el: { kind: string; id: string },
  s: {
    fillColorId: string | null;
    gradient?: BakeGradientPlacement;
    stroke?: BakeStroke;
    opacity?: number;
  },
): MutationInput[] {
  const ops: MutationInput[] = [];
  // A new path takes the document's default stroke (black, 1 pt in a new
  // document); a baked fill has none, so say so.
  if (!s.stroke && el.kind === "polygon") {
    ops.push(
      setProp(el, "frameStrokeColor", { type: "colorRef", value: NO_SWATCH }),
    );
  }
  if (s.fillColorId !== null)
    ops.push(
      setProp(el, "frameFillColor", { type: "colorRef", value: s.fillColorId }),
    );
  if (s.gradient) {
    ops.push(
      setProp(el, "frameGradientFillAngle", {
        type: "length",
        value: round3(s.gradient.angle),
      }),
    );
    ops.push(
      setProp(el, "frameGradientFillLength", {
        type: "length",
        value: round3(s.gradient.length),
      }),
    );
  }
  if (s.stroke) {
    ops.push(
      setProp(el, "frameStrokeColor", {
        type: "colorRef",
        value: s.stroke.colorId,
      }),
    );
    ops.push(
      setProp(el, "frameStrokeWeight", {
        type: "length",
        value: s.stroke.weight,
      }),
    );
  }
  if (s.opacity !== undefined)
    ops.push(setProp(el, "frameOpacity", { type: "length", value: s.opacity }));
  return ops;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** The native drop shadow of a shape addressed as `el` (a rectangle or a
 *  path's polygon). */
function shadowOps(
  el: { kind: string; id: string },
  sh: BakeShadow,
): MutationInput[] {
  return [
    setProp(el, "frameDropShadowMode", { type: "text", value: "Drop" }),
    setProp(el, "frameDropShadowXOffset", {
      type: "length",
      value: round3(sh.xOffset),
    }),
    setProp(el, "frameDropShadowYOffset", {
      type: "length",
      value: round3(sh.yOffset),
    }),
    setProp(el, "frameDropShadowSize", {
      type: "length",
      value: round3(sh.size),
    }),
    setProp(el, "frameDropShadowOpacity", {
      type: "length",
      value: sh.opacityPct,
    }),
    setProp(el, "frameDropShadowColor", {
      type: "colorRef",
      value: sh.colorId,
    }),
  ];
}

const CORNERS = ["TopLeft", "TopRight", "BottomLeft", "BottomRight"] as const;

/** Rounded corners of one radius on a rectangle addressed as `el`. */
function cornerOps(
  el: { kind: string; id: string },
  radius: number,
): MutationInput[] {
  return CORNERS.flatMap((c) => [
    setProp(el, `frameCornerOption${c}`, {
      type: "text",
      value: "RoundedCorner",
    }),
    setProp(el, `frameCornerRadius${c}`, { type: "length", value: radius }),
  ]);
}

/** The swatch that paints nothing (IDML `Swatch/None`). */
const NO_SWATCH = "Swatch/None";

/**
 * Translate placed plans into the ops of ONE `batch` mutation — the whole
 * bake as one undo step. Pure: same input → same ops.
 *
 * Order: every new swatch first, then every new gradient swatch
 * (deduplicated across frames, skipping `existing` — the engine refuses a
 * duplicate self-id and a refused child rolls the whole batch back), then per
 * frame its rectangles, paths, images and text runs. Each creating op is
 * followed by a `bindCreated` naming its mint, and later ops address it as
 * `$h:<handle>`: a text frame's handle in a `storyId` / `story_id` position
 * resolves to the story it minted, so a run is inserted, sized, set in its
 * face and coloured without reading the story back. Requires the engine's
 * C-15 batch handles (protocol 57; `story_id` in a `storyRange` address from
 * 66).
 */
export function bakeBatchOps(
  placed: readonly PlacedBakePlan[],
  existing: ReadonlySet<string> = new Set(),
): BakeBatch {
  const ops: MutationInput[] = [];
  const swatchIds: string[] = [];
  const gradientIds: string[] = [];
  const seen = new Set(existing);
  const handles = {
    rects: [] as string[],
    paths: [] as string[],
    texts: [] as string[],
    images: [] as string[],
    groups: [] as string[],
    clips: [] as string[],
    masks: [] as string[],
  };

  for (const { plan } of placed) {
    for (const s of plan.swatches) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      swatchIds.push(s.id);
      ops.push({
        op: "createSwatch",
        args: {
          spec: {
            selfId: s.id,
            name: s.id,
            space: "RGB",
            value: [s.r, s.g, s.b],
            model: "Process",
          },
        },
      } as MutationInput);
    }
  }
  for (const { plan } of placed) {
    for (const g of plan.gradients ?? []) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      gradientIds.push(g.id);
      ops.push({
        op: "createGradient",
        args: {
          spec: {
            selfId: g.id,
            name: g.id,
            kind: g.kind,
            stops: g.stops.map((st) => ({
              stopColor: st.colorId,
              locationPct: st.locationPct,
            })),
          },
        },
      } as MutationInput);
    }
  }

  for (const {
    plan,
    pageId: page,
    top,
    left,
    metrics,
    imageBytes,
    maskBytes,
  } of placed) {
    const pageId = page as PageId;
    // This frame's created items by plan index (`null`: not created).
    const made = {
      rect: [] as (string | null)[],
      path: [] as (string | null)[],
      image: [] as (string | null)[],
      text: [] as (string | null)[],
      group: [] as (string | null)[],
    };
    for (const rect of plan.rects) {
      const handle = `r${handles.rects.length}`;
      handles.rects.push(handle);
      made.rect.push(handle);
      const el = { kind: "rectangle", id: `$h:${handle}` };
      const [rt, rl, rb, rr] = rect.bounds;
      ops.push(
        {
          op: "insertFrame",
          args: { pageId, bounds: [rt + top, rl + left, rb + top, rr + left] },
        },
        { op: "bindCreated", args: { handle } },
        ...shapeStyleOps(el, rect),
      );
      if (rect.cornerRadius !== undefined)
        ops.push(...cornerOps(el, rect.cornerRadius));
      if (rect.shadow) ops.push(...shadowOps(el, rect.shadow));
      ops.push(...effectOps(el, rect));
    }
    for (const p of plan.paths) {
      const handle = `p${handles.paths.length}`;
      handles.paths.push(handle);
      made.path.push(handle);
      const el = { kind: "polygon", id: `$h:${handle}` };
      const anchors = p.anchors.map((a) => shift(a, left, top));
      ops.push(
        { op: "insertPath", args: { pageId, anchors, open: p.open === true } },
        { op: "bindCreated", args: { handle } },
      );
      if (p.subpaths && p.subpaths.length > 1) {
        // The full geometry: every subpath, in the path's own (inner) space —
        // the space the first subpath was inserted in.
        const all = p.subpaths.flat().map((a) => shift(a, left, top));
        const starts: number[] = [];
        let n = 0;
        for (const sp of p.subpaths) {
          starts.push(n);
          n += sp.length;
        }
        ops.push(
          setProp(el, "framePath", {
            type: "framePath",
            value: { anchors: all, subpathStarts: starts },
          }),
        );
      }
      ops.push(...shapeStyleOps(el, p));
      if (p.shadow) ops.push(...shadowOps(el, p.shadow));
      ops.push(...effectOps(el, p));
    }
    plan.images.forEach((img, i) => {
      const png = imageBytes?.[i];
      made.image.push(png ? `i${handles.images.length}` : null);
      if (!png) return;
      const handle = `i${handles.images.length}`;
      handles.images.push(handle);
      const [it, il, ib, ir] = img.bounds;
      ops.push(
        {
          op: "insertFrame",
          args: { pageId, bounds: [it + top, il + left, ib + top, ir + left] },
        },
        { op: "bindCreated", args: { handle } },
        // The pixels inline: a rectangle with image bytes and no content
        // transform draws them fitted to its bounds.
        {
          op: "replaceImageBytes",
          args: { elementId: `$h:${handle}`, bytes: Array.from(png) },
        } as MutationInput,
      );
      const el = { kind: "rectangle", id: `$h:${handle}` };
      if (img.opacity !== undefined)
        ops.push(
          setProp(el, "frameOpacity", { type: "length", value: img.opacity }),
        );
      if (img.shadow) ops.push(...shadowOps(el, img.shadow));
      ops.push(...effectOps(el, img));
    });
    plan.texts.forEach((t, i) => {
      const m = metrics[i];
      made.text.push(m ? `t${handles.texts.length}` : null);
      if (!m) return;
      const handle = `t${handles.texts.length}`;
      handles.texts.push(handle);
      const pageLeft = t.left + left;
      const pageBaseline = t.baseline + top;
      // The frame holds the run as the engine shaped it (its own face) or as
      // the host measures it, whichever is wider.
      const width = Math.max(m.advance, t.advance ?? 0);
      const bounds: [number, number, number, number] = [
        pageBaseline - m.ascender,
        pageLeft,
        pageBaseline - m.descender,
        pageLeft + Math.max(1, width) + TEXT_PAD_PT,
      ];
      const range = storyRangeOf(handle, charCount(t.text));
      ops.push(
        { op: "insertTextFrame", args: { pageId, bounds } },
        { op: "bindCreated", args: { handle } },
        {
          op: "insertText",
          args: { storyId: `$h:${handle}`, offset: 0, text: t.text },
        },
        setProp(range, "characterFontSize", {
          type: "length",
          value: t.sizePt,
        }),
        setProp(range, "characterFillColor", {
          type: "colorRef",
          value: t.fillColorId,
        }),
      );
      if (t.family) {
        // The family always (a foreign open must not fall back to its own
        // default face); the style only when it is not the family's regular
        // face, which is what a run without a style gets.
        ops.push(
          setProp(range, "characterFontFamily", {
            type: "text",
            value: t.family,
          }),
        );
        if (t.fontStyle && t.fontStyle !== "Regular") {
          ops.push(
            setProp(range, "characterFontStyle", {
              type: "text",
              value: t.fontStyle,
            }),
          );
        }
      }
      const frameEl = { kind: "textFrame", id: `$h:${handle}` };
      if (t.opacity !== undefined) {
        ops.push(
          setProp(frameEl, "frameOpacity", {
            type: "length",
            value: t.opacity,
          }),
        );
      }
      if (t.shadow) ops.push(...shadowOps(frameEl, t.shadow));
      ops.push(...effectOps(frameEl, t));
    });

    // The CSS effects (ADR 415): opacity masks on their items, then the
    // native groups, children before parents.
    const elementOf = (ref: BakeRef): { kind: string; id: string } | null => {
      const h = made[ref.kind][ref.index];
      if (!h) return null;
      const kind =
        ref.kind === "path"
          ? "polygon"
          : ref.kind === "text"
            ? "textFrame"
            : ref.kind === "group"
              ? "group"
              : "rectangle";
      return { kind, id: `$h:${h}` };
    };
    (plan.masks ?? []).forEach((mask, i) => {
      const target = elementOf(mask.target);
      const png = mask.kind === "image" ? maskBytes?.[i] : null;
      if (!target || (mask.kind === "image" && !png)) return;
      const handle = `m${handles.masks.length}`;
      handles.masks.push(handle);
      const el = { kind: "rectangle", id: `$h:${handle}` };
      const [mt, ml, mb, mr] = mask.bounds;
      ops.push(
        {
          op: "insertFrame",
          args: { pageId, bounds: [mt + top, ml + left, mb + top, mr + left] },
        },
        { op: "bindCreated", args: { handle } },
      );
      if (mask.kind === "gradient") {
        ops.push(
          setProp(el, "frameFillColor", {
            type: "colorRef",
            value: mask.gradientId,
          }),
          setProp(el, "frameGradientFillAngle", {
            type: "length",
            value: round3(mask.gradient.angle),
          }),
          setProp(el, "frameGradientFillLength", {
            type: "length",
            value: round3(mask.gradient.length),
          }),
        );
      } else if (png) {
        ops.push({
          op: "replaceImageBytes",
          args: { elementId: el.id, bytes: Array.from(png) },
        } as MutationInput);
      }
      ops.push({
        op: "applyOpacityMask",
        args: {
          targetId: target,
          maskId: el,
          maskType: mask.kind === "image" ? "alpha" : "luminosity",
        },
      } as MutationInput);
    });
    for (const g of plan.groups ?? []) {
      const members = g.members
        .map(elementOf)
        .filter((m): m is { kind: string; id: string } => m !== null);
      if (members.length === 0) {
        made.group.push(null);
        continue;
      }
      if (g.clip) {
        // The clipping path: the top member of a clip group, geometry only.
        const handle = `c${handles.clips.length}`;
        handles.clips.push(handle);
        const anchors = g.clip[0].map((a) => shift(a, left, top));
        const clipEl = { kind: "polygon", id: `$h:${handle}` };
        ops.push(
          { op: "insertPath", args: { pageId, anchors, open: false } },
          { op: "bindCreated", args: { handle } },
          setProp(clipEl, "frameStrokeColor", {
            type: "colorRef",
            value: NO_SWATCH,
          }),
        );
        if (g.clip.length > 1) {
          const starts: number[] = [];
          let n = 0;
          for (const sp of g.clip) {
            starts.push(n);
            n += sp.length;
          }
          ops.push(
            setProp(clipEl, "framePath", {
              type: "framePath",
              value: {
                anchors: g.clip.flat().map((a) => shift(a, left, top)),
                subpathStarts: starts,
              },
            }),
          );
        }
        members.push(clipEl);
      }
      const handle = `g${handles.groups.length}`;
      handles.groups.push(handle);
      made.group.push(handle);
      const el = { kind: "group", id: `$h:${handle}` };
      ops.push(
        {
          op: "createGroup",
          args: { memberIds: members, ...(g.clip ? { clip: true } : {}) },
        } as MutationInput,
        { op: "bindCreated", args: { handle } },
      );
      if (g.opacity !== undefined)
        ops.push(
          setProp(el, "frameOpacity", { type: "length", value: g.opacity }),
        );
      if (g.blend)
        ops.push(
          setProp(el, "frameBlendMode", { type: "text", value: g.blend }),
        );
      if (g.isolate)
        ops.push(
          setProp(el, "groupIsolateBlending", { type: "bool", value: true }),
        );
    }
  }

  return { ops, swatchIds, gradientIds, handles };
}

/** An item's own CSS effects (ADR 415): its blend mode and inner shadow. */
function effectOps(
  el: { kind: string; id: string },
  s: { blend?: string; innerShadow?: BakeInnerShadow },
): MutationInput[] {
  const ops: MutationInput[] = [];
  if (s.blend)
    ops.push(setProp(el, "frameBlendMode", { type: "text", value: s.blend }));
  const sh = s.innerShadow;
  if (sh) {
    ops.push(
      setProp(el, "frameInnerShadowEnabled", { type: "bool", value: true }),
      // CSS composites an inset shadow normally (InDesign defaults to
      // Multiply).
      setProp(el, "frameInnerShadowBlendMode", {
        type: "text",
        value: "Normal",
      }),
      setProp(el, "frameInnerShadowColor", {
        type: "colorRef",
        value: sh.colorId,
      }),
      setProp(el, "frameInnerShadowOpacity", {
        type: "length",
        value: sh.opacityPct,
      }),
      setProp(el, "frameInnerShadowAngle", { type: "length", value: sh.angle }),
      setProp(el, "frameInnerShadowDistance", {
        type: "length",
        value: sh.distance,
      }),
      setProp(el, "frameInnerShadowSize", { type: "length", value: sh.size }),
    );
  }
  return ops;
}
