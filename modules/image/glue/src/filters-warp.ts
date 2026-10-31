// TRANSFORM AND WARP ON PIXELS (WP5.6, image ADR 483) as Filter-dialog
// entries, so each gets the dialog's live preview (a reduced copy while a
// value moves, the full image when it rests), OK as ONE undo step and
// Cancel restoring the layer:
//
//   · WARP (Edit ▸ Transform ▸ Warp…) — Photoshop's fifteen styles with
//     bend and the two distortions, or a CUSTOM mesh whose sixteen control
//     points are dragged on the canvas (`geom.warp_mesh`). It bends the
//     selection's bounds, else what the active layer covers;
//   · PUPPET WARP (Edit ▸ Puppet warp…) — pins placed and dragged on the
//     canvas bend a mesh over the layer as rigidly as the mode allows
//     (`paged-warp`'s ARAP, `geom.warp_field`);
//   · LIQUIFY (Image ▸ Filter ▸ Liquify…) — strokes of Forward Warp,
//     Reconstruct, Smooth, Twirl, Pucker, Bloat, Push Left and the
//     Freeze / Thaw mask painted on the canvas, replayed on a mesh
//     (`geom.warp_field`); a selection freezes what lies outside it;
//   · CONTENT-AWARE SCALE (Edit ▸ Content-aware scale…) — seam carving of
//     what the layer covers, with Amount and the selection as protection.
//
// Canvas geometry is stored NORMALISED to the image (0..1, sizes to its
// longer side) and turned into px by each run, so the proxy preview and
// the full pass agree. The canvas side (what is drawn, what a drag does)
// is `warp-canvas.ts`.

import { defineMessages } from "@paged-media/strings";

import type { DecodedInfo, ImageEngine } from "./engine";
import {
  num,
  range,
  select,
  toggle,
  bool,
  type FilterContext,
  type FilterDef,
  type FilterValue,
  type FilterValues,
  type ParamSpec,
} from "./filters-schema";
import {
  LIQUIFY_TOOLS,
  WARP_STYLES,
  type LiquifyStroke,
  type PuppetOptions,
  type PuppetPin,
  type WarpRect,
  type WarpStyleName,
} from "./warp-engine";

export const W = defineMessages("image.warp", {
  warp: "Warp",
  puppetWarp: "Puppet warp",
  liquify: "Liquify",
  contentAwareScale: "Content-aware scale",
  style: "Warp",
  none: "None",
  custom: "Custom",
  arc: "Arc",
  arcLower: "Arc lower",
  arcUpper: "Arc upper",
  arch: "Arch",
  bulge: "Bulge",
  shellLower: "Shell lower",
  shellUpper: "Shell upper",
  flag: "Flag",
  wave: "Wave",
  fish: "Fish",
  rise: "Rise",
  fishEye: "Fish eye",
  inflate: "Inflate",
  squeeze: "Squeeze",
  twist: "Twist",
  bend: "Bend",
  horizontalDistortion: "Horizontal distortion",
  verticalDistortion: "Vertical distortion",
  orientation: "Orientation",
  horizontal: "Horizontal",
  vertical: "Vertical",
  mesh: "Mesh",
  meshPoints: "{count, plural, =0 {style mesh} other {custom mesh}}",
  mode: "Mode",
  rigid: "Rigid",
  normal: "Normal",
  distort: "Distort",
  density: "Density",
  fewerPoints: "Fewer points",
  morePoints: "More points",
  expansion: "Expansion",
  showMesh: "Show mesh",
  pins: "Pins",
  pinCount: "{count, plural, one {# pin} other {# pins}}",
  tool: "Tool",
  forwardWarp: "Forward warp",
  reconstruct: "Reconstruct",
  smooth: "Smooth",
  twirlClockwise: "Twirl clockwise",
  twirlCounterClockwise: "Twirl counter-clockwise",
  pucker: "Pucker",
  bloat: "Bloat",
  pushLeft: "Push left",
  freeze: "Freeze mask",
  thaw: "Thaw mask",
  brushSize: "Brush size",
  brushPressure: "Brush pressure",
  brushDensity: "Brush density",
  brushRate: "Brush rate",
  strokes: "Strokes",
  strokeCount: "{count, plural, one {# stroke} other {# strokes}}",
  width: "Width",
  height: "Height",
  amount: "Amount",
  protect: "Protect the selection",
});

/** The Warp dialog's style choice: 0 none, 1 custom, 2… the styles. */
export const WARP_STYLE_OPTIONS: readonly string[] = [
  W.none,
  W.custom,
  ...WARP_STYLES.map((s) => W[s]),
];
export const STYLE_NONE = 0;
export const STYLE_CUSTOM = 1;

const LIQUIFY_LABELS: Record<(typeof LIQUIFY_TOOLS)[number], string> = {
  forwardWarp: W.forwardWarp,
  reconstruct: W.reconstruct,
  smooth: W.smooth,
  twirlClockwise: W.twirlClockwise,
  twirlCounterClockwise: W.twirlCounterClockwise,
  pucker: W.pucker,
  bloat: W.bloat,
  pushLeft: W.pushLeft,
  freeze: W.freeze,
  thaw: W.thaw,
};

const list = (v: FilterValues, k: string): number[] => {
  const x = v[k];
  return Array.isArray(x) ? [...(x as readonly number[])] : [];
};

const data = (
  key: string,
  label: string,
  extra: Pick<
    Extract<ParamSpec, { kind: "data" }>,
    "count" | "countLabel" | "default"
  >,
): ParamSpec => ({ kind: "data", key, label, ...extra });

// ── Warp ──────────────────────────────────────────────────────────────

/** The warp rectangle in px (whole pixels inside the image). */
export function warpRect(v: FilterValues, ctx: FilterContext): WarpRect {
  const r = list(v, "rect");
  const [nx = 0, ny = 0, nw = 1, nh = 1] = r;
  const x = Math.max(0, Math.min(ctx.width - 1, Math.floor(nx * ctx.width)));
  const y = Math.max(0, Math.min(ctx.height - 1, Math.floor(ny * ctx.height)));
  const x1 = Math.max(
    x + 1,
    Math.min(ctx.width, Math.ceil((nx + nw) * ctx.width)),
  );
  const y1 = Math.max(
    y + 1,
    Math.min(ctx.height, Math.ceil((ny + nh) * ctx.height)),
  );
  return { x, y, w: x1 - x, h: y1 - y };
}

/** The identity mesh of `r` (flat x/y, row-major). */
export function identityMesh(r: WarpRect): number[] {
  const out: number[] = [];
  for (let row = 0; row < 4; row++)
    for (let c = 0; c < 4; c++)
      out.push(r.x + (r.w * c) / 3, r.y + (r.h * row) / 3);
  return out;
}

/** The style the dialog's values name (null for none / custom). */
export function warpStyleOf(v: FilterValues): WarpStyleName | null {
  const i = num(v, "style") - 2;
  return WARP_STYLES[i] ?? null;
}

/** The mesh the Warp dialog's values describe, in px: the identity for
 *  None, the stored control points for Custom, the engine's style mesh
 *  (paged-warp) otherwise. */
export function warpMesh(
  e: Pick<ImageEngine, "warpStyleMesh">,
  v: FilterValues,
  ctx: FilterContext,
): number[] {
  const r = warpRect(v, ctx);
  const style = num(v, "style");
  if (style === STYLE_CUSTOM) {
    const m = list(v, "mesh");
    if (m.length !== 32) return identityMesh(r);
    return m.map((x, i) => x * (i % 2 === 0 ? ctx.width : ctx.height));
  }
  const name = warpStyleOf(v);
  if (!name) return identityMesh(r);
  const mesh = Array.from(
    e.warpStyleMesh(
      {
        style: name,
        bend: num(v, "bend") / 100,
        horizontal: num(v, "hDistort") / 100,
        vertical: num(v, "vDistort") / 100,
        verticalOrientation: num(v, "orientation") === 1,
      },
      r,
    ) as Iterable<number>,
  );
  return mesh.length === 32 ? mesh : identityMesh(r);
}

const WARP: FilterDef = {
  id: "warp",
  label: W.warp,
  group: "Transform",
  transform: true,
  params: [
    select("style", W.style, WARP_STYLE_OPTIONS, STYLE_NONE),
    range("bend", W.bend, -100, 100, 1, 50),
    range("hDistort", W.horizontalDistortion, -100, 100, 1, 0),
    range("vDistort", W.verticalDistortion, -100, 100, 1, 0),
    select("orientation", W.orientation, [W.horizontal, W.vertical], 0),
    data("rect", W.mesh, { default: [0, 0, 1, 1] }),
    data("mesh", W.mesh, {
      default: [],
      count: (m) => (m.length === 32 ? 1 : 0),
      countLabel: W.meshPoints,
    }),
  ],
  run: (e, h, v, ctx) =>
    e.applyMeshWarp(h, warpMesh(e, v, ctx), warpRect(v, ctx)),
};

// ── Puppet Warp ───────────────────────────────────────────────────────

/** Pins in px from the normalised `[at x, at y, to x, to y]` list. */
export function puppetPins(v: FilterValues, w: number, h: number): PuppetPin[] {
  const p = list(v, "pins");
  const out: PuppetPin[] = [];
  for (let i = 0; i + 3 < p.length; i += 4)
    out.push({
      at: [p[i]! * w, p[i + 1]! * h],
      to: [p[i + 2]! * w, p[i + 3]! * h],
    });
  return out;
}

/** Puppet Warp's options (the expansion is px, scaled for the proxy). */
export function puppetOptions(v: FilterValues): PuppetOptions {
  return {
    mode: Math.max(0, Math.min(2, num(v, "mode"))) as 0 | 1 | 2,
    density: Math.max(0, Math.min(2, num(v, "density"))) as 0 | 1 | 2,
    expansion: num(v, "expansion"),
  };
}

const PUPPET: FilterDef = {
  id: "puppetWarp",
  label: W.puppetWarp,
  group: "Transform",
  transform: true,
  params: [
    select("mode", W.mode, [W.rigid, W.normal, W.distort], 1),
    select("density", W.density, [W.fewerPoints, W.normal, W.morePoints], 1),
    range("expansion", W.expansion, -20, 60, 1, 2, { px: true }),
    toggle("showMesh", W.showMesh, true),
    data("pins", W.pins, {
      default: [],
      count: (p) => Math.floor(p.length / 4),
      countLabel: W.pinCount,
    }),
  ],
  run: (e, h, v, ctx) =>
    e.applyPuppetWarp(
      h,
      puppetPins(v, ctx.width, ctx.height),
      puppetOptions(v),
    ),
};

// ── Liquify ───────────────────────────────────────────────────────────

/** Strokes in px from the normalised list: per stroke `[tool, size,
 *  pressure, density, rate, n, x0, y0, …]`, the size a fraction of the
 *  image's longer side, positions fractions of its sides. */
export function liquifyStrokes(
  v: FilterValues,
  w: number,
  h: number,
): LiquifyStroke[] {
  const s = list(v, "strokes");
  const span = Math.max(w, h);
  const out: LiquifyStroke[] = [];
  let i = 0;
  while (i + 6 <= s.length) {
    const n = s[i + 5]!;
    const tool = LIQUIFY_TOOLS[s[i]!];
    if (!tool || i + 6 + 2 * n > s.length) break;
    const points: Array<[number, number]> = [];
    for (let k = 0; k < n; k++)
      points.push([s[i + 6 + 2 * k]! * w, s[i + 7 + 2 * k]! * h]);
    out.push({
      tool,
      size: s[i + 1]! * span,
      pressure: s[i + 2]!,
      density: s[i + 3]!,
      rate: s[i + 4]!,
      points,
    });
    i += 6 + 2 * n;
  }
  return out;
}

/** How many strokes a normalised list holds. */
export function strokeCount(s: readonly number[]): number {
  let n = 0;
  let i = 0;
  while (i + 6 <= s.length) {
    i += 6 + 2 * s[i + 5]!;
    n++;
  }
  return n;
}

const LIQUIFY: FilterDef = {
  id: "liquify",
  label: W.liquify,
  group: "Transform",
  transform: true,
  params: [
    select(
      "tool",
      W.tool,
      LIQUIFY_TOOLS.map((t) => LIQUIFY_LABELS[t]),
      0,
    ),
    range("size", W.brushSize, 2, 1500, 1, 100),
    range("pressure", W.brushPressure, 1, 100, 1, 100),
    range("density", W.brushDensity, 0, 100, 1, 50),
    range("rate", W.brushRate, 0, 100, 1, 80),
    data("strokes", W.strokes, {
      default: [],
      count: strokeCount,
      countLabel: W.strokeCount,
    }),
  ],
  run: (e, h, v, ctx) =>
    e.applyLiquify(h, liquifyStrokes(v, ctx.width, ctx.height)),
};

// ── Content-Aware Scale ───────────────────────────────────────────────

const CONTENT_AWARE_SCALE: FilterDef = {
  id: "contentAwareScale",
  label: W.contentAwareScale,
  group: "Transform",
  transform: true,
  params: [
    range("width", W.width, 10, 200, 1, 100),
    range("height", W.height, 10, 200, 1, 100),
    range("amount", W.amount, 0, 100, 1, 100),
    toggle("protect", W.protect, false),
  ],
  run: (e, h, v): Promise<DecodedInfo> =>
    e.applyContentAwareScale(
      h,
      num(v, "width") / 100,
      num(v, "height") / 100,
      num(v, "amount") / 100,
      bool(v, "protect"),
    ),
};

export const WARP_FILTERS: readonly FilterDef[] = [
  WARP,
  PUPPET,
  LIQUIFY,
  CONTENT_AWARE_SCALE,
];

/** The dialogs whose geometry is drawn and edited on the canvas. */
export const CANVAS_WARPS: ReadonlySet<string> = new Set([
  "warp",
  "puppetWarp",
  "liquify",
]);

/** The values a Warp dialog opens with: the rectangle it bends (the
 *  selection's bounds or what the layer covers, normalised) and no
 *  custom mesh. */
export function warpPreset(
  bounds: WarpRect,
  w: number,
  h: number,
): Record<string, FilterValue> {
  return {
    rect: [bounds.x / w, bounds.y / h, bounds.w / w, bounds.h / h],
    mesh: [],
  };
}
