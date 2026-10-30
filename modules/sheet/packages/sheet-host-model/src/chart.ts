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

// THE chart lowering translator (spec §8.4): the engine has ALREADY
// generated the pure chart GEOMETRY IR (sheet-chart, computed in Rust);
// this turns those vector primitives into host paged.draw Mutations.
// ZERO chart semantics live here (CLAUDE.md hard rule) — it is arithmetic
// over already-decided geometry plus the host mutation vocabulary.
//
// §8.4 / §2.1: charts lower to paged.draw — a CORE SDK surface reached
// through the native wire ops (insertPath / insertTextFrame / insertText),
// NEVER another plugin. A chart on the page is document-native vector art,
// regenerated on recalc, printable/exportable like anything Paged draws.
//
// COORDINATES (mirrors lower-to-mutations.ts). The geometry IR is in
// chart-content pt space (origin top-left, y DOWN — the frame-content
// system, spec §8.5). placement.bounds is the page-local box
// [top, left, bottom, right]; we add its [top, left] origin to every
// content-space point so the paths land on the page. Frame transforms are
// core's job (§8.5) — we never anticipate them.
//
// TWO-PHASE for text (the §8.4 analogue of the S-03 sheet lower). Vector
// primitives (rect/line/polygon/wedge) lower to insertPath in ONE undoable
// batch. Text labels (title, axis ticks, legend) need a storyId that only
// exists AFTER a text frame is created, so each label mints an
// insertTextFrame in the batch and its string rides out in `texts` for the
// caller to pour (insertText) once it resolves the new frames' stories —
// exactly the resolve-the-created-element door the sheet lower uses.
//
// COLOUR (spec §8.4 swatch-coherence). The geometry IR carries each
// primitive's fill/stroke as a `#RRGGBB` literal (the palette + the
// pie-slice distinction). The host's `frameFillColor`/`frameStrokeColor`
// take a `Value::ColorRef` — a `Color/<id>` SWATCH reference, NOT inline
// hex (verified against core: `paged-mutate` stores the ref string and the
// CMM resolves it through the document's swatch table; IDML FillColor is a
// reference, the FillStrokeCluster precedent). So colours can't ride inline.
// We therefore (1) mint ONE document swatch per DISTINCT chart colour
// (createSwatch, RGB space, 0..255 channels — the IDML convention, core
// graphic.rs `v/255.0`) at a DETERMINISTIC id derived from the hex, then
// (2) reference that swatch id on each path via setElementProperty. This is
// the path the wire actually supports AND it advances swatch-coherence
// (§8.4): the chart's colours become real, named, round-trippable document
// swatches a designer can see and re-use, not anonymous one-off fills.
//
// The per-element targeting uses the SAME protocol-v34 `$created` sentinel
// the binding uses: a setElementProperty whose elementId is `$created`
// resolves to the element minted by the MOST-RECENT creating child of the
// batch (core model.rs). So each path's style ops are emitted IMMEDIATELY
// after its insertPath, while `$created` still points at it. (createSwatch
// is NOT a "creating child" — core `created_element_id` only counts
// InsertNode/CreateGroup — so the swatch ops can sit first without
// disturbing the sentinel.) The binding rides the FIRST created element, so
// it is emitted right after that element's own style ops, before the next
// create shifts the sentinel.

import type {
  ElementId,
  Mutation,
  PageId,
  PropertyPath,
  Value,
} from "@paged-media/plugin-api";

import { BINDING_KEY, withView, type Binding } from "./binding";
import {
  distinctChartHexes,
  normalizePaletteHex,
  paletteSwatchId,
  swatchMintOps,
  type KnownSwatchIds,
} from "./palette";

// ── ChartGeometry mirror (the serialized sheet_chart IR, camelCase) ─────────
//
// Mirrors sheet-chart/src/geometry.rs's serde output exactly: the tagged
// `Primitive` enum (lowercase `kind`), camelCase fields, `pts` as [x,y]
// tuples. This is the wire shape `get_chart_geometry` returns.

/** Text alignment for a chart text label's anchor point. */
export type TextAnchor = "start" | "middle" | "end";

// ── Native effects (sheet ADR 527): sheet-chart/src/native.rs's serde ──────
//
// The role's DrawingML gradient, translucency and effects as the shared
// mapper (`dml-native`) lowered them, colours as `#RRGGBB`.

/** A gradient fill. `stops` are `[location 0–100, #RRGGBB]`. */
export interface NativeGradient {
  kind: "linear" | "radial";
  stops: [number, string][];
  /** The engine's angle (counter-clockwise degrees); linear only. */
  angle?: number;
  /** The axis length (linear) or the radius (radial), pt. */
  length?: number;
  /** The axis start (linear) or the centre (radial), chart-content pt. */
  start?: [number, number];
}

/** A drop shadow. */
export interface NativeShadow {
  xOffset: number;
  yOffset: number;
  size: number;
  /** 0–100. */
  opacity: number;
  color: string;
}

/** An inner shadow, as the engine's editors address it. */
export interface NativeInnerShadow {
  /** Counter-clockwise degrees. */
  angle: number;
  distance: number;
  size: number;
  opacity: number;
  color: string;
}

/** An outer glow. */
export interface NativeGlow {
  size: number;
  opacity: number;
  color: string;
}

/** A gradient feather: `stops` are `[location 0–100, opacity 0–100]`. */
export interface NativeFeather {
  gradientType: string;
  angle?: number;
  stops: [number, number][];
}

/** One entry of the object's effect stack (engine ADR 1008), as the
 *  wire's `EffectEntrySpec` states it with its colour as `#RRGGBB`. An
 *  InDesign kind (`dropShadow`, `innerShadow`, `outerGlow`, `feather`,
 *  `gradientFeather`) carries only its place; its parameters are the
 *  item's own fields. */
export interface NativeEffect {
  kind: string;
  blendMode?: string;
  opacityPct?: number;
  radiusPt?: number;
  color?: string;
  distancePt?: number;
  sizePct?: number;
  startOpacityPct?: number;
  endOpacityPct?: number;
  blurPt?: number;
}

/** What a primitive carries beyond its solid fill and stroke. */
export interface NativeFx {
  gradient?: NativeGradient;
  /** The item's opacity, 0–100. */
  opacity?: number;
  dropShadow?: NativeShadow;
  innerShadow?: NativeInnerShadow;
  outerGlow?: NativeGlow;
  /** A soft edge's width, pt. */
  feather?: number;
  gradientFeather?: NativeFeather;
  /** The object's effect stack, when it holds an effect InDesign has
   *  none of (a blur, a colour overlay, a reflection): every effect in the
   *  order it is drawn. */
  effectStack?: NativeEffect[];
}

/** An axis-aligned rectangle (bars, plot frame, legend swatches). */
export interface RectPrim {
  kind: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string | null;
  stroke: string | null;
  strokeW: number;
  /** The document swatch the fill names (W4 style roles): referenced
   *  instead of a minted chart swatch. */
  fillSwatchRef?: string;
  strokeSwatchRef?: string;
  /** Gradient, translucency and effects (sheet ADR 527). */
  fx?: NativeFx;
}

/** A polyline (line-chart series, axis rules). At least two points. */
export interface LinePrim {
  kind: "line";
  pts: [number, number][];
  stroke: string;
  strokeW: number;
  strokeSwatchRef?: string;
  /** `a:prstDash` of the line (`dash`, `sysDot`, …). */
  dash?: string;
  /** Translucency and effects (sheet ADR 527). */
  fx?: NativeFx;
}

/** A closed polygon (area fills, scatter diamond markers). */
export interface PolygonPrim {
  kind: "polygon";
  pts: [number, number][];
  fill: string | null;
  stroke: string | null;
  strokeW: number;
  fillSwatchRef?: string;
  strokeSwatchRef?: string;
  /** Gradient, translucency and effects (sheet ADR 527). */
  fx?: NativeFx;
}

/** A pie/donut wedge: center (cx,cy), radius r, angular span in degrees
 *  (clockwise from 12 o'clock). */
export interface WedgePrim {
  kind: "wedge";
  cx: number;
  cy: number;
  r: number;
  startDeg: number;
  endDeg: number;
  fill: string | null;
  stroke: string | null;
  /** A ring segment's inner radius (donut rings, sunburst). */
  innerR?: number;
  fillSwatchRef?: string;
  strokeSwatchRef?: string;
  /** Gradient, translucency and effects (sheet ADR 527). */
  fx?: NativeFx;
}

/** A text label (title, axis ticks, legend entries). */
export interface TextPrim {
  kind: "text";
  x: number;
  y: number;
  s: string;
  sizePt: number;
  anchor: TextAnchor;
  /** The text role's colour, and the document swatch it names. */
  color?: string;
  colorSwatchRef?: string;
  bold?: boolean;
  italic?: boolean;
  font?: string;
  /** Document paragraph / character styles the role names: applied to the
   *  label, whose frame then sizes itself to the styled text. */
  paragraphStyle?: string;
  characterStyle?: string;
  /** `title`, `axisTitle`, `tick`, `dataLabel`, `legend`, `note`. */
  role?: string;
}

/** One chart-geometry primitive (the tagged union). */
export type ChartPrimitive =
  RectPrim | LinePrim | PolygonPrim | WedgePrim | TextPrim;

/** The generated geometry for one chart: the content-box size + ordered
 *  primitive list (`get_chart_geometry`'s return shape). */
export interface ChartGeometry {
  widthPt: number;
  heightPt: number;
  prims: ChartPrimitive[];
  /** A 3-D chart drawn as its 2-D kind. */
  flattened3d?: boolean;
  /** What the chart's DrawingML asks for that the page items cannot hold,
   *  one line per kind (sheet ADR 527). */
  losses?: string[];
}

// ── Placement + result ──────────────────────────────────────────────────────

/** Where the chart frame is placed: the page + the page-local box the
 *  chart-content geometry is offset into. `bounds` is `[top, left, bottom,
 *  right]` — the same order every wire frame op uses. */
export interface ChartPlacement {
  pageId: PageId;
  bounds: [number, number, number, number];
  /** The page's top-left in its spread's coordinates (`PageSummary
   *  .pageOrigin`): a page item's gradient start is in those (sheet ADR
   *  527). Without it a gradient keeps the engine's default placement. */
  pageOrigin?: [number, number];
}

/** A label text frame the caller must pour text into (phase 2): the text,
 *  its page-local anchor point, and its size — emitted in batch order so the
 *  caller can pair each `insertTextFrame` outcome with its string. */
export interface ChartTextLabel {
  /** The label string. */
  text: string;
  /** Page-local anchor point `[x, y]` (the text's baseline anchor). */
  at: [number, number];
  /** Font size in pt — what the poured text must be SET at
   *  ({@link labelStyleOps}); the frame is sized for it. */
  sizePt: number;
  /** The text alignment at the anchor. */
  anchor: TextAnchor;
  /** The page-local frame box `[top, left, bottom, right]` the label's
   *  `insertTextFrame` was given. */
  bounds: [number, number, number, number];
  /** The role's colour as a colorRef swatch id (a document swatch, or the
   *  minted chart swatch of its hex). */
  colorRef?: string;
  bold?: boolean;
  italic?: boolean;
  font?: string;
  paragraphStyle?: string;
  characterStyle?: string;
}

/** One label's measured extent at its own size: what the driver reads off
 *  the host shaper (`host.text.measureStrings`) so the label's frame is
 *  sized to its text in the face the engine lays it out in. */
export interface LabelMetrics {
  /** Advance width of the label string (pt). */
  advance: number;
  /** Face ascender (pt, positive). */
  ascender: number;
  /** Face descender (pt, negative below the baseline). */
  descender: number;
}

/** Width slack (pt) on a label frame. A label is measured with the engine's
 *  own shaper, so this is not a guess at the face — it keeps a string that
 *  measures exactly the frame's width from breaking on rounding. The text is
 *  justified to its anchor ({@link labelStyleOps}), so the slack never moves
 *  where it reads. */
export const LABEL_SLACK_PT = 2;

/** Height allowance (pt) on a label frame: the engine places a line on a
 *  1/64 pt grid, and a frame cut exactly to the line can lose it. */
export const LABEL_FIT_ALLOWANCE_PT = 0.5;

/** The ESTIMATE a label falls back to when the host cannot measure it —
 *  the chart engine's own (sheet-chart `ADVANCE_EM`, 0.55 em per char) and
 *  an ascent/descent of 0.8 / 0.2 em. */
export function estimateLabelMetrics(
  text: string,
  sizePt: number,
): LabelMetrics {
  return {
    advance: [...text].length * 0.55 * sizePt,
    ascender: 0.8 * sizePt,
    descender: -0.2 * sizePt,
  };
}

/** The paragraph justification that keeps a label's text at its anchor. */
export function labelJustification(anchor: TextAnchor): string {
  return anchor === "middle"
    ? "CenterAlign"
    : anchor === "end"
      ? "RightAlign"
      : "LeftAlign";
}

/** The ops that SET a poured label at the chart's size and justify it to its
 *  anchor, over the label's whole text in `storyId` (a real story id, or a
 *  `$h:` handle bound to the label's frame — core resolves a frame handle in
 *  a `story_id` position to the frame's story). Without them the text kept
 *  the document's 12 pt in a box sized for 8 pt. */
export function labelStyleOps(
  storyId: string,
  label: ChartTextLabel,
): Mutation[] {
  const range: ElementId = {
    kind: "storyRange",
    id: { story_id: storyId, start: 0, end: label.text.length },
  };
  const set = (path: PropertyPath, value: Value): Mutation => ({
    op: "setElementProperty",
    args: { elementId: range, path, value },
  });
  const ops: Mutation[] = [];
  // A document paragraph style names the label's look (size, face, colour
  // come from the style); the chart's own size applies only without one.
  if (label.paragraphStyle) {
    ops.push(
      set("appliedParagraphStyle", {
        type: "text",
        value: label.paragraphStyle,
      }),
    );
  } else {
    ops.push(set("characterFontSize", { type: "length", value: label.sizePt }));
  }
  if (label.characterStyle) {
    ops.push(
      set("appliedCharacterStyle", {
        type: "text",
        value: label.characterStyle,
      }),
    );
  }
  if (!label.paragraphStyle && !label.characterStyle) {
    if (label.font) {
      ops.push(set("characterFontFamily", { type: "text", value: label.font }));
    }
    if (label.bold || label.italic) {
      ops.push(
        set("characterFontStyle", {
          type: "text",
          value:
            label.bold && label.italic
              ? "Bold Italic"
              : label.bold
                ? "Bold"
                : "Italic",
        }),
      );
    }
    if (label.colorRef) {
      ops.push(
        set("characterFillColor", { type: "colorRef", value: label.colorRef }),
      );
    }
  }
  ops.push(
    set("paragraphJustification", {
      type: "text",
      value: labelJustification(label.anchor),
    }),
  );
  return ops;
}

/** The op that lets a styled label's frame size itself to its text
 *  (`textFrameAutoSizing`), for a label whose paragraph or character style
 *  the chart cannot measure. `frameId` is the frame's id or `$h:` handle. */
export function labelAutoSizeOp(
  frameId: string,
  label: ChartTextLabel,
): Mutation[] {
  if (!label.paragraphStyle && !label.characterStyle) return [];
  return [
    {
      op: "setElementProperty",
      args: {
        elementId: { kind: "textFrame", id: frameId },
        path: "textFrameAutoSizing",
        value: { type: "text", value: "HeightAndWidth" },
      },
    },
  ];
}

/** A label's page-local frame box. The chart engine anchors a label at the
 *  BOTTOM of its text (plotters `VPos::Bottom`) and at its start, middle or
 *  end horizontally; the frame is the text's own extent at that anchor —
 *  as wide as the text (plus {@link LABEL_SLACK_PT}), as tall as one line,
 *  its descent ending on the anchor — kept inside the chart's box
 *  `[ox, ox + widthPt]`. PURE. */
export function labelBox(
  prim: TextPrim,
  metrics: LabelMetrics,
  ox: number,
  oy: number,
  widthPt: number,
): [number, number, number, number] {
  const w = Math.max(metrics.advance, 0) + LABEL_SLACK_PT;
  const lineH = Math.max(metrics.ascender - metrics.descender, prim.sizePt);
  const h = lineH + LABEL_FIT_ALLOWANCE_PT;
  const ax = ox + prim.x;
  const bottom = oy + prim.y;
  let left =
    prim.anchor === "middle" ? ax - w / 2 : prim.anchor === "end" ? ax - w : ax;
  // Inside the chart: a label never hangs past the chart's own box (the
  // value-axis labels used to start 20 pt LEFT of it, off the page).
  if (w <= widthPt) {
    left = Math.min(Math.max(left, ox), ox + widthPt - w);
  }
  const top = bottom - lineH;
  return [top, left, top + h, left + w];
}

/** What the chart translator yields: the phase-1 vector batch + the phase-2
 *  text labels (poured once the caller resolves the created frames' stories).
 *  Mirrors `LowerResult` (lower-to-mutations.ts). */
export interface ChartLowerResult {
  /** One undoable `batch`: every vector path + one insertTextFrame per
   *  label + the binding metadata on the first created element. */
  batch: Mutation;
  /** The text labels, in the SAME order their `insertTextFrame`s appear in
   *  the batch — the phase-2 pour list. */
  texts: ChartTextLabel[];
  /** The page-space outline `[top, left, bottom, right]` of the element
   *  the binding rides (the first one created), as the batch draws it —
   *  recorded in the binding as its `art`. Absent on an empty chart. */
  art?: [number, number, number, number];
}

/** The outline `[top, left, bottom, right]` of a created element, from its
 *  create op: a path's anchors, a text frame's bounds. */
function createdOutline(
  op: Mutation | undefined,
): [number, number, number, number] | undefined {
  if (op?.op === "insertTextFrame") {
    const b = (op.args as { bounds: [number, number, number, number] }).bounds;
    return [b[0], b[1], b[2], b[3]];
  }
  if (op?.op !== "insertPath") return undefined;
  const anchors = (op.args as { anchors: { anchor: [number, number] }[] })
    .anchors;
  let top = Infinity;
  let left = Infinity;
  let bottom = -Infinity;
  let right = -Infinity;
  for (const { anchor } of anchors) {
    left = Math.min(left, anchor[0]);
    right = Math.max(right, anchor[0]);
    top = Math.min(top, anchor[1]);
    bottom = Math.max(bottom, anchor[1]);
  }
  return Number.isFinite(top) ? [top, left, bottom, right] : undefined;
}

// ── Arc flattening (wedges) ─────────────────────────────────────────────────

/** Wedge arc flattening density: degrees per polyline segment. A wedge's
 *  arc is approximated by a fan of straight segments at this angular step
 *  (publishing-clean; the path stays a closed polygon paged.draw fills). */
const ARC_STEP_DEG = 6;

/** Clockwise-from-12-o'clock degrees → a content-space point on a circle of
 *  radius `r` about `(cx, cy)`. y grows DOWN (frame-content space), so 0° is
 *  straight up (`y = cy - r`), 90° is to the right, matching the generator's
 *  clockwise convention. */
function arcPoint(
  cx: number,
  cy: number,
  r: number,
  deg: number,
): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
}

/** Flatten a wedge (a pie slice OR a full 0..360 disc) into a closed point
 *  ring: the center, then the arc from start to end at ~ARC_STEP_DEG steps.
 *  A full circle (≈360° span) omits the center (it is a disc, not a slice). */
function wedgeRing(w: WedgePrim): [number, number][] {
  const span = w.endDeg - w.startDeg;
  const isFull = Math.abs(span - 360) < 1e-6 || Math.abs(span) >= 360;
  const steps = Math.max(1, Math.ceil(Math.abs(span) / ARC_STEP_DEG));
  const pts: [number, number][] = [];
  const inner = w.innerR ?? 0;
  if (!isFull && inner <= 0) pts.push([w.cx, w.cy]);
  for (let i = 0; i <= steps; i++) {
    const deg = w.startDeg + (span * i) / steps;
    pts.push(arcPoint(w.cx, w.cy, w.r, deg));
  }
  // A ring segment returns along its inner arc (a full ring is drawn as
  // the outer circle and the inner circle traced back, one closed path).
  if (inner > 0) {
    for (let i = steps; i >= 0; i--) {
      const deg = w.startDeg + (span * i) / steps;
      pts.push(arcPoint(w.cx, w.cy, inner, deg));
    }
  }
  return pts;
}

// ── Path building (the paged.draw heart) ────────────────────────────────────

/** A corner anchor (no bezier handles): `left`/`right` collapse onto the
 *  anchor, so the segment to/from it is straight. This is how a polyline /
 *  polygon lowers to `insertPath` — the same corner-anchor convention the
 *  draw geometry uses for straight runs. */
function corner(p: [number, number]): {
  anchor: [number, number];
  left: [number, number];
  right: [number, number];
} {
  return { anchor: p, left: p, right: p };
}

/** An `insertPath` mutation over content-space points, offset by the frame
 *  origin `[ox, oy]` into page-local pt. `open` controls whether the path
 *  closes (polyline = open; rect/polygon/wedge = closed). */
function insertPath(
  pageId: PageId,
  ox: number,
  oy: number,
  pts: [number, number][],
  open: boolean,
): Mutation {
  const anchors = pts.map((p) => corner([ox + p[0], oy + p[1]]));
  return { op: "insertPath", args: { pageId, anchors, open } };
}

/** The four corners of a rect as a closed point ring (top-left, top-right,
 *  bottom-right, bottom-left). */
function rectRing(r: RectPrim): [number, number][] {
  return [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h],
  ];
}

// ── Colour → document swatch (spec §8.4 swatch-coherence) ────────────────────

/** The `$created` sentinel as a polygon element id — an insertPath mints a
 *  polygon node, so its fill/stroke/binding address it through this. The host
 *  resolves `$created` to the most-recent creating child of the batch. */
const CREATED_POLYGON: ElementId = { kind: "polygon", id: "$created" };

/** Normalise a `#RGB` / `#RRGGBB` (case-insensitive) hex to the canonical
 *  uppercase 6-digit form WITHOUT the leading `#`, or `null` if it is not a
 *  well-formed hex colour (a defensive guard — a malformed colour degrades to
 *  "no swatch", never crashes the lower). 3-digit shorthand expands per CSS
 *  (`#abc` → `AABBCC`).
 *
 *  Delegates to `palette.ts`: the panel that SHOWS this palette (the ADR 023
 *  binding provider) must normalise identically or it would serve ids this
 *  lowering never mints. */
function normalizeHex(hex: string): string | null {
  return normalizePaletteHex(hex);
}

/** The deterministic document-swatch id for a chart colour. Keyed by the
 *  canonical hex so the SAME colour across primitives (and across re-lowers)
 *  reuses ONE swatch — the §8.4 coherence property. Lives in `palette.ts`
 *  now: it is the id the Swatches panel addresses through the ADR 023 seam,
 *  so there is exactly ONE implementation of the convention. */
function swatchIdForHex(canonHex: string): string {
  return paletteSwatchId("chart", canonHex);
}

/** A `frameFillColor` / `frameStrokeColor` colorRef Value over a swatch id. */
function colorRefValue(swatchId: string): Value {
  return { type: "colorRef", value: swatchId };
}

/** The createSwatch ops for every distinct chart colour the document does
 *  not already carry — RGB process swatches at deterministic ids, 0..255
 *  channels (IDML convention). Emitted FIRST in the batch; they are not
 *  "creating children" so they don't move the `$created` sentinel.
 *
 *  `knownSwatchIds` is not an optimisation. A chart's colours are
 *  content-addressed, so lowering the SAME chart twice — or lowering any
 *  SECOND chart, since every chart shares the axis grey — asked core to
 *  re-create a swatch it already had, and that refusal fails the WHOLE
 *  batch: the second chart never landed at all (measured; see
 *  [`swatchMintOps`], which owns the ruling). */
function swatchOps(
  geom: ChartGeometry,
  knownSwatchIds?: KnownSwatchIds,
): Mutation[] {
  return swatchMintOps("chart", distinctChartHexes(geom), knownSwatchIds);
}

/** The fill/stroke/stroke-weight style ops for a just-created path (addressed
 *  through `$created`). Order is fill → stroke colour → stroke weight; a
 *  null/malformed colour emits nothing (it falls back to the document
 *  default, never a wrong colour). `strokeW` rides only when there IS a
 *  stroke (a 0-weight stroke is no stroke). */
function styleOps(
  fill: string | null,
  stroke: string | null,
  strokeW: number,
  fillSwatchRef?: string,
  strokeSwatchRef?: string,
  fx?: NativeFx,
): Mutation[] {
  const ops: Mutation[] = [];
  const fillHex = fill == null ? null : normalizeHex(fill);
  // A gradient paints instead of the role's solid colour (its first stop).
  const gradient = fill != null ? fx?.gradient : undefined;
  const fillRef = gradient
    ? chartGradientId(gradient)
    : (fillSwatchRef ?? (fillHex != null ? swatchIdForHex(fillHex) : null));
  if (fillRef != null) {
    ops.push({
      op: "setElementProperty",
      args: {
        elementId: CREATED_POLYGON,
        path: "frameFillColor",
        value: colorRefValue(fillRef),
      },
    });
  }
  const strokeHex = stroke == null ? null : normalizeHex(stroke);
  const strokeRef =
    strokeSwatchRef ?? (strokeHex != null ? swatchIdForHex(strokeHex) : null);
  if (strokeRef != null) {
    ops.push({
      op: "setElementProperty",
      args: {
        elementId: CREATED_POLYGON,
        path: "frameStrokeColor",
        value: colorRefValue(strokeRef),
      },
    });
    if (strokeW > 0) {
      ops.push({
        op: "setElementProperty",
        args: {
          elementId: CREATED_POLYGON,
          path: "frameStrokeWeight",
          value: { type: "length", value: strokeW },
        },
      });
    }
  }
  return ops;
}

// ── Native effects (sheet ADR 527) ──────────────────────────────────────────

/** A location as an id segment: to the thousandth, `.` as `p`. */
function idNumber(v: number): string {
  return String(Math.round(v * 1000) / 1000).replace(".", "p");
}

/** The deterministic gradient-swatch id of a chart gradient, keyed by its
 *  kind and stops (content-addressed like the chart's colour swatches, so
 *  the same ramp across bars and re-lowers is ONE swatch). */
export function chartGradientId(g: NativeGradient): string {
  const stops = g.stops
    .map(([at, hex]) => `${idNumber(at)}-${normalizeHex(hex) ?? "000000"}`)
    .join("-");
  return `Gradient/uPagedSheetChart${g.kind === "radial" ? "R" : "L"}-${stops}`;
}

/** The createGradient ops for every distinct chart gradient the document
 *  does not already carry (the same ruling as {@link swatchMintOps}: a
 *  duplicate fails the whole batch; a failed read (`null`) mints nothing).
 *  Its stops reference the chart's colour swatches, minted before it. */
export function gradientMintOps(
  geom: ChartGeometry,
  knownSwatchIds?: KnownSwatchIds,
): Mutation[] {
  if (knownSwatchIds === null) return [];
  const seen = new Set<string>();
  const ops: Mutation[] = [];
  for (const prim of geom.prims) {
    if (prim.kind === "text" || prim.kind === "line") continue;
    const g = prim.fx?.gradient;
    if (!g || prim.fill == null) continue;
    const id = chartGradientId(g);
    if (seen.has(id) || knownSwatchIds?.has(id)) continue;
    seen.add(id);
    ops.push({
      op: "createGradient",
      args: {
        spec: {
          selfId: id,
          name: `paged.sheet chart gradient ${seen.size}`,
          kind: g.kind === "radial" ? "Radial" : "Linear",
          stops: g.stops.map(([at, hex]) => ({
            stopColor: swatchIdForHex(normalizeHex(hex) ?? "000000"),
            locationPct: at,
          })),
        },
      },
    });
  }
  return ops;
}

/** The ops that give a just-created path (`$created`, or `target`) the
 *  gradient's placement, the item's opacity and its effects. `[ox, oy]` is the chart's
 *  page-local origin; a gradient's start is written only with the page's
 *  origin in its spread (the engine reads it in spread coordinates). PURE. */
export function nativeFxOps(
  fx: NativeFx | undefined,
  ox: number,
  oy: number,
  pageOrigin: [number, number] | undefined,
  filled: boolean,
  target: ElementId = CREATED_POLYGON,
): Mutation[] {
  if (!fx) return [];
  const ops: Mutation[] = [];
  const set = (path: PropertyPath, value: Value) =>
    ops.push({
      op: "setElementProperty",
      args: { elementId: target, path, value },
    });
  const len = (v: number): Value => ({ type: "length", value: v });
  const on: Value = { type: "bool", value: true };
  const color = (hex: string): Value =>
    colorRefValue(swatchIdForHex(normalizeHex(hex) ?? "000000"));
  const g = filled ? fx.gradient : undefined;
  if (g) {
    if (g.angle != null) set("frameGradientFillAngle", len(g.angle));
    if (g.length != null) set("frameGradientFillLength", len(g.length));
    if (g.start && pageOrigin) {
      set("frameGradientFillStart", {
        type: "lengths",
        value: [
          pageOrigin[0] + ox + g.start[0],
          pageOrigin[1] + oy + g.start[1],
        ],
      });
    }
  }
  if (fx.opacity != null) set("frameOpacity", len(fx.opacity));
  const d = fx.dropShadow;
  if (d) {
    set("frameDropShadow", on);
    set("frameDropShadowXOffset", len(d.xOffset));
    set("frameDropShadowYOffset", len(d.yOffset));
    set("frameDropShadowSize", len(d.size));
    set("frameDropShadowOpacity", len(d.opacity));
    set("frameDropShadowColor", color(d.color));
  }
  const i = fx.innerShadow;
  if (i) {
    set("frameInnerShadowEnabled", on);
    set("frameInnerShadowBlendMode", { type: "text", value: "Normal" });
    set("frameInnerShadowAngle", len(i.angle));
    set("frameInnerShadowDistance", len(i.distance));
    set("frameInnerShadowSize", len(i.size));
    set("frameInnerShadowOpacity", len(i.opacity));
    set("frameInnerShadowColor", color(i.color));
  }
  const o = fx.outerGlow;
  if (o) {
    set("frameOuterGlowEnabled", on);
    set("frameOuterGlowBlendMode", { type: "text", value: "Normal" });
    set("frameOuterGlowSize", len(o.size));
    set("frameOuterGlowOpacity", len(o.opacity));
    set("frameOuterGlowColor", color(o.color));
  }
  if (fx.feather != null) {
    set("frameFeatherEnabled", on);
    set("frameFeatherWidth", len(fx.feather));
  }
  const gf = filled ? fx.gradientFeather : undefined;
  if (gf) {
    set("frameGradientFeather", {
      type: "gradientFeather",
      value: {
        gradientType: gf.gradientType,
        ...(gf.angle != null ? { angleDeg: gf.angle } : {}),
        stops: gf.stops.map(([locationPct, alphaPct]) => ({
          locationPct,
          alphaPct,
        })),
      },
    });
  }
  // The stack last: its InDesign entries take the parameters written
  // above; a line draws no gradient feather, so it names none.
  const stack = (fx.effectStack ?? []).filter(
    (e) => filled || e.kind !== "gradientFeather",
  );
  if (stack.length > 0) {
    set("frameEffectStack", {
      type: "effectStack",
      value: {
        entries: stack.map(({ color: hex, ...e }) =>
          hex != null
            ? {
                ...e,
                color: swatchIdForHex(normalizeHex(hex) ?? "000000"),
              }
            : e,
        ),
      },
    } as Value);
  }
  return ops;
}

// ── The translator ──────────────────────────────────────────────────────────

/**
 * Translate a chart's geometry IR + a resolved placement + the frame binding
 * into the phase-1 paged.draw batch and the phase-2 text labels. PURE: no
 * host import beyond wire TYPES, no chart semantics (the geometry was already
 * decided in Rust). Deterministic — same geometry => same mutations.
 *
 * `knownSwatchIds` is what the DRIVER read from the document
 * (`document.collection("swatches")`) before calling: a colour already
 * there is referenced, never re-minted, because core's refusal of a
 * duplicate `createSwatch` would fail this entire batch and the chart
 * would not land at all. `null` (the read failed) mints nothing — the art
 * still lands, unpainted. Omitted mints everything (the pure/test case).
 * See [`swatchMintOps`] for the measurements.
 *
 * The batch emits, in order:
 *  - one createSwatch per DISTINCT chart colour the document lacks (first,
 *    swatch-coherence),
 * then in geometry order:
 *  - rect      → insertPath (closed 4-corner ring) + fill/stroke style ops,
 *  - line      → insertPath (open polyline) + stroke style ops,
 *  - polygon   → insertPath (closed ring) + fill/stroke style ops,
 *  - wedge     → insertPath (closed center+arc ring; a full disc omits the
 *                center) + fill/stroke style ops, and
 *  - text      → insertTextFrame (a 1-line box at the label anchor),
 * with a setPluginMetadata writing the binding onto the FIRST created element
 * (the `$created` sentinel) so ONE undo removes the whole chart + its binding.
 * Each colour-bearing path's fill/stroke style ops are emitted IMMEDIATELY
 * after its insertPath, so each `$created` resolves to its own element. Each
 * text's string + anchor rides out in `texts` (phase-2 pour order).
 */
export function chartGeometryToMutations(
  geom: ChartGeometry,
  placement: ChartPlacement,
  binding: Binding,
  knownSwatchIds?: KnownSwatchIds,
  labelMetrics?: readonly (LabelMetrics | null | undefined)[],
): ChartLowerResult {
  const { pageId, bounds } = placement;
  const [top, left] = bounds;

  // (0) The colour swatches — minted once per distinct colour the document
  // does not already carry, FIRST so the per-path frameFillColor /
  // frameStrokeColor refs resolve. Not creating children, so they leave the
  // `$created` sentinel untouched. A colour already in the document is
  // referenced, NOT re-minted: re-minting is what failed the whole batch.
  const ops: Mutation[] = [
    ...swatchOps(geom, knownSwatchIds),
    ...gradientMintOps(geom, knownSwatchIds),
  ];
  const origin = placement.pageOrigin;
  const texts: ChartTextLabel[] = [];

  // Whether a page element has been created yet (the binding rides the FIRST
  // one). `bound` flips true the moment we emit the binding so later creates
  // don't re-bind. `firstKind` records what the first created node IS so the
  // binding's `$created` placeholder carries the matching element kind.
  let bound = false;
  let art: [number, number, number, number] | undefined;

  /** Append a created path/frame's style ops, then — if this is the FIRST
   *  created element — the binding (while `$created` still points at it),
   *  with that element's outline as the chart's `art`. */
  const afterCreate = (kind: "polygon" | "textFrame", styles: Mutation[]) => {
    if (!bound) art = createdOutline(ops[ops.length - 1]);
    ops.push(...styles);
    if (!bound) {
      bound = true;
      ops.push({
        op: "setPluginMetadata",
        args: {
          elementId: { kind, id: "$created" },
          key: BINDING_KEY,
          value: JSON.stringify(art ? withView(binding, { art }) : binding),
        },
      });
    }
  };

  for (const prim of geom.prims) {
    switch (prim.kind) {
      case "rect":
        ops.push(insertPath(pageId, left, top, rectRing(prim), false));
        afterCreate("polygon", [
          ...styleOps(
            prim.fill,
            prim.stroke,
            prim.strokeW,
            prim.fillSwatchRef,
            prim.strokeSwatchRef,
            prim.fx,
          ),
          ...nativeFxOps(prim.fx, left, top, origin, prim.fill != null),
        ]);
        break;
      case "line":
        if (prim.pts.length >= 2) {
          ops.push(insertPath(pageId, left, top, prim.pts, true));
          // A polyline has no fill — only the series stroke.
          afterCreate("polygon", [
            ...styleOps(
              null,
              prim.stroke,
              prim.strokeW,
              undefined,
              prim.strokeSwatchRef,
            ),
            ...nativeFxOps(prim.fx, left, top, origin, false),
          ]);
        }
        break;
      case "polygon":
        if (prim.pts.length >= 2) {
          ops.push(insertPath(pageId, left, top, prim.pts, false));
          afterCreate("polygon", [
            ...styleOps(
              prim.fill,
              prim.stroke,
              prim.strokeW,
              prim.fillSwatchRef,
              prim.strokeSwatchRef,
              prim.fx,
            ),
            ...nativeFxOps(prim.fx, left, top, origin, prim.fill != null),
          ]);
        }
        break;
      case "wedge": {
        const ring = wedgeRing(prim);
        if (ring.length >= 3) {
          ops.push(insertPath(pageId, left, top, ring, false));
          // A wedge carries no stroke weight in the IR; a hairline default
          // applies when a stroke colour is present.
          afterCreate("polygon", [
            ...styleOps(
              prim.fill,
              prim.stroke,
              0,
              prim.fillSwatchRef,
              prim.strokeSwatchRef,
              prim.fx,
            ),
            ...nativeFxOps(prim.fx, left, top, origin, prim.fill != null),
          ]);
        }
        break;
      }
      case "text": {
        // A one-line text box SIZED TO THE LABEL: as wide as its text at
        // the chart's size (measured by the driver; estimated without
        // one), as tall as one line, at the label's anchor and inside the
        // chart. It used to be a fixed 80 pt box, left-aligned at the
        // anchor whatever the anchor said — a title wider than 80 pt broke
        // and oversat, value-axis labels hung off the page, category labels
        // ran into each other.
        const metrics =
          labelMetrics?.[texts.length] ??
          estimateLabelMetrics(prim.s, prim.sizePt);
        const bounds = labelBox(prim, metrics, left, top, geom.widthPt);
        ops.push({
          op: "insertTextFrame",
          args: { pageId, bounds },
        });
        // A text frame carries no fill/stroke style; it may still be the
        // FIRST created element (a text-only chart) and thus the binding host.
        afterCreate("textFrame", []);
        const colorHex = prim.color == null ? null : normalizeHex(prim.color);
        texts.push({
          text: prim.s,
          at: [left + prim.x, top + prim.y],
          sizePt: prim.sizePt,
          anchor: prim.anchor,
          bounds,
          colorRef:
            prim.colorSwatchRef ??
            (colorHex != null ? swatchIdForHex(colorHex) : undefined),
          bold: prim.bold,
          italic: prim.italic,
          font: prim.font,
          paragraphStyle: prim.paragraphStyle,
          characterStyle: prim.characterStyle,
        });
        break;
      }
    }
  }

  // If NOTHING was created (no primitives, or only degenerate ones) the batch
  // holds at most the swatch ops with no element to bind to — emit an empty
  // batch so the caller skips it (an empty chart binds nothing).
  if (!bound) {
    return { batch: { op: "batch", args: { ops: [] } }, texts };
  }

  return {
    batch: { op: "batch", args: { ops } },
    texts,
    ...(art ? { art } : {}),
  };
}
