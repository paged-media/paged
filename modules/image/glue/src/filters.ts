// FILTER ▸ … — the catalogue the generic Filter dialog runs from (WP5.2).
//
// Every one-shot filter is ONE entry here: its parameters as a schema
// (what the dialog draws — a slider, an angle, a choice, a switch, a
// colour), their defaults, and how a set of values becomes an engine
// call. The ranges are the kernels' own: a radius stops where the
// kernel's window bound stops (a larger request is a different kernel,
// and the engine refuses it rather than clamping), an amount runs over
// the span the kernel's params block documents.
//
// The defaults are what the panel's buttons used to apply as constants,
// so opening a dialog and pressing OK does what the button did.
//
// A parameter marked `px` is a length in image pixels: the dialog's
// proxy preview (the image resampled to about what the frame shows)
// scales it by the proxy's factor, so the preview looks like the result
// rather than like the filter at a magnified size.

import { defineMessages } from "@paged-media/strings";

import type { DecodedInfo, ImageEngine } from "./engine";

/** One value of a dialog: a number (sliders, angles, choices), a switch,
 *  or a colour (straight RGB in [0, 1]). */
export type FilterValue = number | boolean | readonly [number, number, number];
export type FilterValues = Readonly<Record<string, FilterValue>>;

export type ParamSpec =
  | {
      kind: "range";
      key: string;
      label: string;
      min: number;
      max: number;
      step: number;
      default: number;
      /** A length in image px (scaled for the proxy preview). */
      px?: boolean;
      /** Shown as a percentage of [0, 1]. */
      percent?: boolean;
    }
  | {
      kind: "angle";
      key: string;
      label: string;
      default: number;
    }
  | {
      kind: "select";
      key: string;
      label: string;
      options: ReadonlyArray<{ value: number; label: string }>;
      default: number;
    }
  | { kind: "toggle"; key: string; label: string; default: boolean }
  | {
      kind: "color";
      key: string;
      label: string;
      default: readonly [number, number, number];
    };

export interface FilterDef {
  /** The id: the command is `filter<Id>` with the first letter raised. */
  id: FilterId;
  /** The dialog's title and the undo step's name (a message key). */
  label: string;
  /** Where the menu shows it, under Image ▸ Filter. */
  group: FilterGroup;
  params: readonly ParamSpec[];
  run(
    engine: ImageEngine,
    handle: number,
    v: FilterValues,
  ): Promise<DecodedInfo>;
}

export type FilterGroup =
  | "Blur"
  | "Noise"
  | "Other"
  | "Sharpen"
  | "Stylize"
  | "Pixelate"
  | "Filter Gallery"
  | "Adjust";

export const F = defineMessages("image.filter", {
  boxBlur: "Box blur",
  surfaceBlur: "Surface blur",
  motionBlur: "Motion blur",
  radialBlur: "Radial blur",
  lensBlur: "Lens blur",
  addNoise: "Add noise",
  despeckle: "Despeckle",
  dustScratches: "Dust & scratches",
  median: "Median",
  reduceNoise: "Reduce noise",
  highPass: "High pass",
  maximum: "Maximum",
  minimum: "Minimum",
  offset: "Offset",
  smartSharpen: "Smart sharpen",
  emboss: "Emboss",
  findEdges: "Find edges",
  glowingEdges: "Glowing edges",
  mosaic: "Mosaic",
  halftone: "Colour halftone",
  paintDaubs: "Paint daubs",
  posterEdges: "Poster edges",
  filmGrain: "Film grain",
  spatter: "Spatter",
  crosshatch: "Crosshatch",
  basRelief: "Bas relief",
  photocopy: "Photocopy",
  stainedGlass: "Stained glass",
  glass: "Glass",
  texturizer: "Texturizer",
  gradientMap: "Gradient map",
  selectiveColour: "Selective colour",

  // Parameter labels.
  radius: "Radius",
  threshold: "Threshold",
  angle: "Angle",
  distance: "Distance",
  amount: "Amount",
  method: "Method",
  spin: "Spin",
  zoom: "Zoom",
  centreX: "Centre X",
  centreY: "Centre Y",
  brightness: "Specular threshold",
  boost: "Highlight boost",
  distribution: "Distribution",
  uniform: "Uniform",
  gaussian: "Gaussian",
  monochromatic: "Monochromatic",
  edgeThreshold: "Edge threshold",
  strength: "Strength",
  preserve: "Preserve",
  squareness: "Squareness",
  roundness: "Roundness",
  horizontal: "Horizontal",
  vertical: "Vertical",
  undefinedAreas: "Undefined areas",
  setTransparent: "Set to transparent",
  repeatEdge: "Repeat edge pixels",
  wrapAround: "Wrap around",
  clamp: "Halo limit",
  height: "Height",
  cellSize: "Cell size",
  contrast: "Contrast",
  levels: "Levels",
  edgeAmount: "Edge intensity",
  intensity: "Edge brightness",
  smoothness: "Smoothness",
  grain: "Grain size",
  sprayRadius: "Spray radius",
  anisotropy: "Direction",
  spacing: "Spacing",
  sets: "Line sets",
  elevation: "Light elevation",
  softness: "Softness",
  border: "Border thickness",
  scale: "Scale",
  distortion: "Distortion",
  texture: "Texture",
  canvas: "Canvas",
  burlap: "Burlap",
  brick: "Brick",
  relief: "Relief",
  light: "Light direction",
  shadow: "Shadows",
  highlight: "Highlights",
  colours: "Colours",
  reds: "Reds",
  yellows: "Yellows",
  greens: "Greens",
  cyans: "Cyans",
  blues: "Blues",
  magentas: "Magentas",
  whites: "Whites",
  neutrals: "Neutrals",
  blacks: "Blacks",
  cyan: "Cyan",
  magenta: "Magenta",
  yellow: "Yellow",
  black: "Black",
  absolute: "Absolute",
  seed: "Seed",
});

// The kernels' window bounds (image-kernels): a radius past them is
// refused engine-side, so the sliders stop there.
const MEDIAN_MAX_RADIUS = 10;
const MORPH_MAX_RADIUS = 32;
const BOX_MAX_RADIUS = 32;
const SURFACE_MAX_RADIUS = 16;
const HIGH_PASS_MAX_SIGMA = 10;

const num = (v: FilterValues, k: string): number => {
  const x = v[k];
  return typeof x === "number" ? x : 0;
};
const bool = (v: FilterValues, k: string): boolean => v[k] === true;
const rgb = (v: FilterValues, k: string): readonly [number, number, number] => {
  const x = v[k];
  return Array.isArray(x) ? (x as [number, number, number]) : [0, 0, 0];
};

const range = (
  key: string,
  label: string,
  min: number,
  max: number,
  step: number,
  dflt: number,
  extra: { px?: boolean; percent?: boolean } = {},
): ParamSpec => ({
  kind: "range",
  key,
  label,
  min,
  max,
  step,
  default: dflt,
  ...extra,
});
const angle = (key: string, label: string, dflt: number): ParamSpec => ({
  kind: "angle",
  key,
  label,
  default: dflt,
});
const amount = (dflt = 1): ParamSpec =>
  range("amount", F.amount, 0, 1, 0.01, dflt, { percent: true });
const shape: ParamSpec = {
  kind: "select",
  key: "round",
  label: F.preserve,
  options: [
    { value: 0, label: F.squareness },
    { value: 1, label: F.roundness },
  ],
  default: 0,
};

export const FILTERS: readonly FilterDef[] = [
  // ── Blur ───────────────────────────────────────────────────────────
  {
    id: "boxBlur",
    label: F.boxBlur,
    group: "Blur",
    params: [range("radius", F.radius, 0, BOX_MAX_RADIUS, 1, 4, { px: true })],
    run: (e, h, v) => e.applyBoxBlur(h, Math.round(num(v, "radius"))),
  },
  {
    id: "surfaceBlur",
    label: F.surfaceBlur,
    group: "Blur",
    params: [
      range("radius", F.radius, 1, SURFACE_MAX_RADIUS, 1, 5, { px: true }),
      // Photoshop's levels, 2–255.
      range("threshold", F.threshold, 2, 255, 1, 15),
    ],
    run: (e, h, v) =>
      e.applySurfaceBlur(
        h,
        Math.round(num(v, "radius")),
        num(v, "threshold") / 255,
      ),
  },
  {
    id: "motionBlur",
    label: F.motionBlur,
    group: "Blur",
    params: [
      angle("angle", F.angle, 0),
      // conv.motion's window is 32 px each way: a 64 px line at most.
      range("length", F.distance, 0, 64, 1, 24, { px: true }),
    ],
    run: (e, h, v) => e.applyMotionBlur(h, num(v, "angle"), num(v, "length")),
  },
  {
    id: "radialBlur",
    label: F.radialBlur,
    group: "Blur",
    params: [
      {
        kind: "select",
        key: "spin",
        label: F.method,
        options: [
          { value: 1, label: F.spin },
          { value: 0, label: F.zoom },
        ],
        default: 1,
      },
      range("amount", F.amount, 0, 1, 0.01, 0.15, { percent: true }),
      range("cx", F.centreX, 0, 1, 0.01, 0.5, { percent: true }),
      range("cy", F.centreY, 0, 1, 0.01, 0.5, { percent: true }),
    ],
    run: (e, h, v) =>
      e.applyRadialBlur(
        h,
        num(v, "cx"),
        num(v, "cy"),
        num(v, "amount"),
        num(v, "spin") === 1,
      ),
  },
  {
    id: "lensBlur",
    label: F.lensBlur,
    group: "Blur",
    params: [
      range("radius", F.radius, 0, 24, 0.5, 8, { px: true }),
      range("threshold", F.brightness, 0, 1, 0.01, 0.75, { percent: true }),
      range("boost", F.boost, 0, 16, 0.5, 4),
    ],
    run: (e, h, v) =>
      e.applyLensBlur(
        h,
        num(v, "radius"),
        num(v, "threshold"),
        num(v, "boost"),
      ),
  },
  // ── Noise ──────────────────────────────────────────────────────────
  {
    id: "addNoise",
    label: F.addNoise,
    group: "Noise",
    params: [
      range("amount", F.amount, 0, 1, 0.01, 0.12, { percent: true }),
      {
        kind: "select",
        key: "gaussian",
        label: F.distribution,
        options: [
          { value: 0, label: F.uniform },
          { value: 1, label: F.gaussian },
        ],
        default: 1,
      },
      { kind: "toggle", key: "mono", label: F.monochromatic, default: false },
      range("seed", F.seed, 1, 999, 1, 1),
    ],
    run: (e, h, v) =>
      e.applyAddNoise(
        h,
        Math.round(num(v, "seed")),
        num(v, "amount"),
        num(v, "gaussian") === 1,
        bool(v, "mono"),
      ),
  },
  {
    id: "despeckle",
    label: F.despeckle,
    group: "Noise",
    params: [
      range("edgeThreshold", F.edgeThreshold, 0, 1, 0.01, 0.12, {
        percent: true,
      }),
      amount(1),
    ],
    run: (e, h, v) =>
      e.applyDespeckle(h, num(v, "edgeThreshold"), num(v, "amount")),
  },
  {
    id: "dustScratches",
    label: F.dustScratches,
    group: "Noise",
    params: [
      // rank.dust_scratches' bound (a 9×9 window).
      range("radius", F.radius, 0, 4, 1, 2, { px: true }),
      range("threshold", F.threshold, 0, 1, 0.01, 0.15, { percent: true }),
    ],
    run: (e, h, v) =>
      e.applyDustScratches(
        h,
        Math.round(num(v, "radius")),
        num(v, "threshold"),
      ),
  },
  {
    id: "median",
    label: F.median,
    group: "Noise",
    params: [
      range("radius", F.radius, 0, MEDIAN_MAX_RADIUS, 1, 1, { px: true }),
      shape,
    ],
    run: (e, h, v) =>
      e.applyRankRadius(
        h,
        "median",
        Math.round(num(v, "radius")),
        num(v, "round") === 1,
      ),
  },
  {
    id: "reduceNoise",
    label: F.reduceNoise,
    group: "Noise",
    params: [
      range("radius", F.radius, 0, 8, 0.5, 4, { px: true }),
      range("sigma", F.threshold, 0.01, 0.5, 0.01, 0.12),
      amount(0.8),
    ],
    run: (e, h, v) =>
      e.applyReduceNoise(
        h,
        num(v, "radius"),
        num(v, "sigma"),
        num(v, "amount"),
      ),
  },
  // ── Other ──────────────────────────────────────────────────────────
  {
    id: "highPass",
    label: F.highPass,
    group: "Other",
    params: [
      range("radius", F.radius, 0.1, HIGH_PASS_MAX_SIGMA, 0.1, 3, { px: true }),
    ],
    run: (e, h, v) => e.applyHighPass(h, num(v, "radius")),
  },
  {
    id: "maximum",
    label: F.maximum,
    group: "Other",
    params: [
      range("radius", F.radius, 0, MORPH_MAX_RADIUS, 1, 1, { px: true }),
      shape,
    ],
    run: (e, h, v) =>
      e.applyRankRadius(
        h,
        "max",
        Math.round(num(v, "radius")),
        num(v, "round") === 1,
      ),
  },
  {
    id: "minimum",
    label: F.minimum,
    group: "Other",
    params: [
      range("radius", F.radius, 0, MORPH_MAX_RADIUS, 1, 1, { px: true }),
      shape,
    ],
    run: (e, h, v) =>
      e.applyRankRadius(
        h,
        "min",
        Math.round(num(v, "radius")),
        num(v, "round") === 1,
      ),
  },
  {
    id: "offset",
    label: F.offset,
    group: "Other",
    params: [
      range("dx", F.horizontal, -512, 512, 1, 32, { px: true }),
      range("dy", F.vertical, -512, 512, 1, 32, { px: true }),
      {
        kind: "select",
        key: "edge",
        label: F.undefinedAreas,
        options: [
          { value: 2, label: F.wrapAround },
          { value: 1, label: F.repeatEdge },
          { value: 0, label: F.setTransparent },
        ],
        default: 2,
      },
    ],
    run: (e, h, v) =>
      e.applyOffset(h, num(v, "dx"), num(v, "dy"), num(v, "edge")),
  },
  // ── Sharpen ────────────────────────────────────────────────────────
  {
    id: "smartSharpen",
    label: F.smartSharpen,
    group: "Sharpen",
    params: [
      range("amount", F.amount, 0, 5, 0.05, 1.2),
      range("radius", F.radius, 0.5, 8, 0.1, 2, { px: true }),
      range("threshold", F.threshold, 0, 0.5, 0.005, 0.02),
      range("clampHi", F.clamp, 0, 1, 0.01, 0.25, { percent: true }),
    ],
    run: (e, h, v) =>
      e.applySmartSharpen(
        h,
        num(v, "radius"),
        num(v, "amount"),
        num(v, "threshold"),
        num(v, "clampHi"),
      ),
  },
  // ── Stylize ────────────────────────────────────────────────────────
  {
    id: "emboss",
    label: F.emboss,
    group: "Stylize",
    params: [
      angle("angle", F.angle, 135),
      range("height", F.height, 0, 10, 0.1, 1),
    ],
    run: (e, h, v) => e.applyEmboss(h, num(v, "angle"), num(v, "height")),
  },
  {
    id: "findEdges",
    label: F.findEdges,
    group: "Stylize",
    params: [range("strength", F.strength, 0, 4, 0.05, 1)],
    run: (e, h, v) => e.applyFindEdges(h, num(v, "strength")),
  },
  {
    id: "glowingEdges",
    label: F.glowingEdges,
    group: "Stylize",
    params: [
      range("intensity", F.intensity, 0, 4, 0.05, 1.6),
      range("smoothness", F.smoothness, 0, 1, 0.01, 0.4, { percent: true }),
      amount(1),
    ],
    run: (e, h, v) =>
      e.galleryGlowingEdges(
        h,
        num(v, "intensity"),
        num(v, "smoothness"),
        num(v, "amount"),
      ),
  },
  // ── Pixelate ───────────────────────────────────────────────────────
  {
    id: "mosaic",
    label: F.mosaic,
    group: "Pixelate",
    params: [range("cell", F.cellSize, 1, 200, 1, 12, { px: true })],
    run: (e, h, v) => e.applyMosaic(h, num(v, "cell")),
  },
  {
    id: "halftone",
    label: F.halftone,
    group: "Pixelate",
    params: [
      range("cell", F.cellSize, 2, 64, 1, 6, { px: true }),
      angle("angle", F.angle, 45),
      range("contrast", F.contrast, 0.1, 4, 0.05, 1.2),
      amount(1),
    ],
    run: (e, h, v) =>
      e.galleryHalftone(
        h,
        num(v, "cell"),
        num(v, "angle"),
        num(v, "contrast"),
        num(v, "amount"),
      ),
  },
  // ── Filter Gallery ────────────────────────────────────────────────
  {
    id: "paintDaubs",
    label: F.paintDaubs,
    group: "Filter Gallery",
    // gallery.kuwahara's window is 8 px each way.
    params: [range("radius", F.radius, 1, 8, 1, 6, { px: true }), amount(1)],
    run: (e, h, v) => e.galleryKuwahara(h, num(v, "radius"), num(v, "amount")),
  },
  {
    id: "posterEdges",
    label: F.posterEdges,
    group: "Filter Gallery",
    params: [
      range("levels", F.levels, 2, 16, 1, 6),
      range("edgeAmount", F.edgeAmount, 0, 1, 0.01, 1, { percent: true }),
      range("edgeThreshold", F.edgeThreshold, 0, 0.5, 0.005, 0.08),
      amount(1),
    ],
    run: (e, h, v) =>
      e.galleryPosterizeEdges(
        h,
        Math.round(num(v, "levels")),
        num(v, "edgeAmount"),
        num(v, "edgeThreshold"),
        num(v, "amount"),
      ),
  },
  {
    id: "filmGrain",
    label: F.filmGrain,
    group: "Filter Gallery",
    params: [
      range("size", F.grain, 1, 8, 0.5, 1, { px: true }),
      { kind: "toggle", key: "mono", label: F.monochromatic, default: false },
      amount(0.5),
      range("seed", F.seed, 1, 999, 1, 1),
    ],
    run: (e, h, v) =>
      e.galleryGrain(
        h,
        Math.round(num(v, "seed")),
        num(v, "size"),
        bool(v, "mono"),
        num(v, "amount"),
      ),
  },
  {
    id: "spatter",
    label: F.spatter,
    group: "Filter Gallery",
    params: [
      range("radius", F.sprayRadius, 0, 8, 0.5, 4, { px: true }),
      angle("angle", F.angle, 0),
      range("anisotropy", F.anisotropy, 0, 1, 0.01, 0, { percent: true }),
      amount(1),
      range("seed", F.seed, 1, 999, 1, 1),
    ],
    run: (e, h, v) =>
      e.galleryDiffuse(
        h,
        Math.round(num(v, "seed")),
        num(v, "radius"),
        num(v, "angle"),
        num(v, "anisotropy"),
        num(v, "amount"),
      ),
  },
  {
    id: "crosshatch",
    label: F.crosshatch,
    group: "Filter Gallery",
    params: [
      angle("angle", F.angle, 45),
      range("spacing", F.spacing, 2, 32, 0.5, 6, { px: true }),
      range("strength", F.strength, 0, 2, 0.05, 0.7),
      range("sets", F.sets, 1, 3, 1, 2),
      amount(1),
    ],
    run: (e, h, v) =>
      e.galleryCrosshatch(
        h,
        num(v, "angle"),
        num(v, "spacing"),
        num(v, "strength"),
        Math.round(num(v, "sets")),
        num(v, "amount"),
      ),
  },
  {
    id: "basRelief",
    label: F.basRelief,
    group: "Filter Gallery",
    params: [
      angle("angle", F.light, 135),
      range("elevation", F.elevation, 0, 89, 1, 30),
      range("height", F.height, 0, 8, 0.1, 1.5),
      amount(1),
    ],
    run: (e, h, v) =>
      e.galleryBasRelief(
        h,
        num(v, "angle"),
        num(v, "elevation"),
        num(v, "height"),
        num(v, "amount"),
      ),
  },
  {
    id: "photocopy",
    label: F.photocopy,
    group: "Filter Gallery",
    params: [
      range("threshold", F.threshold, 0, 1, 0.01, 0.5, { percent: true }),
      range("softness", F.softness, 0, 0.5, 0.005, 0.08),
      amount(1),
    ],
    run: (e, h, v) =>
      e.galleryThresholdInk(
        h,
        num(v, "threshold"),
        num(v, "softness"),
        num(v, "amount"),
      ),
  },
  {
    id: "stainedGlass",
    label: F.stainedGlass,
    group: "Filter Gallery",
    params: [
      // gallery.stained_glass clamps the cell to 2–16 px.
      range("cell", F.cellSize, 2, 16, 1, 16, { px: true }),
      range("border", F.border, 0, 1, 0.01, 0.5, { percent: true }),
      amount(1),
      range("seed", F.seed, 1, 999, 1, 1),
    ],
    run: (e, h, v) =>
      e.galleryStainedGlass(
        h,
        Math.round(num(v, "seed")),
        num(v, "cell"),
        num(v, "border"),
        num(v, "amount"),
      ),
  },
  {
    id: "glass",
    label: F.glass,
    group: "Filter Gallery",
    params: [
      range("scale", F.scale, 2, 96, 1, 24, { px: true }),
      // gallery.glass clamps the displacement at 16 px.
      range("distortion", F.distortion, 0, 16, 0.5, 6, { px: true }),
      amount(1),
      range("seed", F.seed, 1, 999, 1, 1),
    ],
    run: (e, h, v) =>
      e.galleryGlass(
        h,
        Math.round(num(v, "seed")),
        num(v, "scale"),
        num(v, "distortion"),
        num(v, "amount"),
      ),
  },
  {
    id: "texturizer",
    label: F.texturizer,
    group: "Filter Gallery",
    params: [
      {
        kind: "select",
        key: "texture",
        label: F.texture,
        options: [
          { value: 0, label: F.canvas },
          { value: 1, label: F.burlap },
          { value: 2, label: F.brick },
        ],
        default: 0,
      },
      range("scale", F.scale, 4, 96, 1, 24, { px: true }),
      range("relief", F.relief, 0, 2, 0.05, 0.6),
      angle("angle", F.light, 135),
      amount(1),
      range("seed", F.seed, 1, 999, 1, 1),
    ],
    run: (e, h, v) =>
      e.galleryTexturizer(
        h,
        Math.round(num(v, "seed")),
        num(v, "texture"),
        num(v, "scale"),
        num(v, "relief"),
        num(v, "angle"),
        num(v, "amount"),
      ),
  },
  // ── Adjust (one-shot) ─────────────────────────────────────────────
  {
    id: "gradientMap",
    label: F.gradientMap,
    group: "Adjust",
    params: [
      {
        kind: "color",
        key: "shadow",
        label: F.shadow,
        default: [0.05, 0.1, 0.25],
      },
      {
        kind: "color",
        key: "highlight",
        label: F.highlight,
        default: [1, 0.85, 0.55],
      },
    ],
    run: (e, h, v) =>
      e.applyGradientMap(h, rgb(v, "shadow"), rgb(v, "highlight")),
  },
  {
    id: "selectiveColour",
    label: F.selectiveColour,
    group: "Adjust",
    params: [
      {
        kind: "select",
        key: "range",
        label: F.colours,
        options: [
          F.reds,
          F.yellows,
          F.greens,
          F.cyans,
          F.blues,
          F.magentas,
          F.whites,
          F.neutrals,
          F.blacks,
        ].map((label, value) => ({ value, label })),
        default: 0,
      },
      range("c", F.cyan, -1, 1, 0.01, 0, { percent: true }),
      range("m", F.magenta, -1, 1, 0.01, 0.2, { percent: true }),
      range("y", F.yellow, -1, 1, 0.01, 0.2, { percent: true }),
      range("k", F.black, -1, 1, 0.01, 0, { percent: true }),
      { kind: "toggle", key: "absolute", label: F.absolute, default: false },
    ],
    run: (e, h, v) =>
      e.applySelectiveColor(
        h,
        num(v, "range"),
        [num(v, "c"), num(v, "m"), num(v, "y"), num(v, "k")],
        bool(v, "absolute"),
      ),
  },
];

export type FilterId =
  | "boxBlur"
  | "surfaceBlur"
  | "motionBlur"
  | "radialBlur"
  | "lensBlur"
  | "addNoise"
  | "despeckle"
  | "dustScratches"
  | "median"
  | "reduceNoise"
  | "highPass"
  | "maximum"
  | "minimum"
  | "offset"
  | "smartSharpen"
  | "emboss"
  | "findEdges"
  | "glowingEdges"
  | "mosaic"
  | "halftone"
  | "paintDaubs"
  | "posterEdges"
  | "filmGrain"
  | "spatter"
  | "crosshatch"
  | "basRelief"
  | "photocopy"
  | "stainedGlass"
  | "glass"
  | "texturizer"
  | "gradientMap"
  | "selectiveColour";

export function filterDef(id: FilterId): FilterDef {
  const def = FILTERS.find((f) => f.id === id);
  if (!def) throw new Error(`unknown filter "${id}"`);
  return def;
}

/** Every parameter at its default. */
export function filterDefaults(def: FilterDef): Record<string, FilterValue> {
  const out: Record<string, FilterValue> = {};
  for (const p of def.params) out[p.key] = p.default;
  return out;
}

/** The values with every `px` length scaled by `factor` (the proxy
 *  preview's size against the image's), clamped to the parameter's own
 *  range so a scaled radius never asks the kernel for more than it has. */
export function scaledForProxy(
  def: FilterDef,
  values: FilterValues,
  factor: number,
): Record<string, FilterValue> {
  const out: Record<string, FilterValue> = { ...values };
  for (const p of def.params) {
    if (p.kind !== "range" || !p.px) continue;
    const v = num(values, p.key) * factor;
    // Integral parameters (step 1) stay integral.
    const stepped = p.step >= 1 ? Math.round(v) : v;
    out[p.key] = Math.min(p.max, Math.max(Math.min(p.min, 0), stepped));
  }
  return out;
}

/** `boxBlur` → `filterBoxBlur`, the command suffix. */
export const filterCommandSuffix = (id: FilterId): string =>
  `filter${id[0]!.toUpperCase()}${id.slice(1)}`;
