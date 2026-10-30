// The SCHEMA of the Filter dialog's catalogue (WP5.2): the value and
// parameter types, the FilterDef shape, the shared message keys and the
// small builders every catalogue file (`filters*.ts`) writes its entries
// with. The catalogue itself is assembled in filters.ts; the entries live
// beside it (filters.ts — the first families, filters-families.ts —
// Distort, Render, Stylize, Pixelate, Adjust; filters-gallery.ts — the
// Filter Gallery's effects; filters-blur-gallery.ts — the Blur Gallery;
// develop.ts — Develop).

import { defineMessages } from "@paged-media/strings";

import type { DecodedInfo, ImageEngine } from "./engine";

/** One value of a dialog: a number (sliders, angles, choices), a switch,
 *  a colour (straight RGB in [0, 1]) or a list of numbers (on-canvas
 *  points: `[x, y]` or `[x, y, value]` per point, flat). */
export type FilterValue = number | boolean | readonly number[];
export type FilterValues = Readonly<Record<string, FilterValue>>;

/** What every parameter may carry besides its kind. */
interface ParamCommon {
  key: string;
  label: string;
  /** A heading the dialog groups the parameter under (a message key). */
  section?: string;
  /** A sub-heading inside the section (an HSL range, a grading wheel). */
  group?: string;
  /** Shown only while another parameter has this value (a mode's
   *  parameters under its choice, a blur's under its switch). */
  showIf?: { key: string; equals: number | boolean };
}

export type ParamSpec = ParamCommon &
  (
    | {
        kind: "range";
        min: number;
        max: number;
        step: number;
        default: number;
        /** A length in image px (scaled for the proxy preview). */
        px?: boolean;
        /** Shown as a percentage of [0, 1]. */
        percent?: boolean;
      }
    | { kind: "angle"; default: number }
    | {
        kind: "select";
        options: ReadonlyArray<{ value: number; label: string }>;
        default: number;
      }
    | { kind: "toggle"; default: boolean }
    | { kind: "color"; default: readonly [number, number, number] }
    | {
        /** Points placed ON THE CANVAS (the Blur Gallery's pins): flat
         *  `[x, y]` (stride 2) or `[x, y, value]` (stride 3), x and y
         *  NORMALISED to the image (0..1, so they survive the proxy), the
         *  value a length in px when `pxValue`. */
        kind: "points";
        stride: 2 | 3;
        min: number;
        max: number;
        default: readonly number[];
        pxValue?: boolean;
      }
    | {
        /** A second image the filter reads (Displace's map, Match
         *  Color's source): 0 = this image's composite, 1 = a file the
         *  dialog asked for (`FilterContext.resource`). */
        kind: "image";
        default: number;
      }
  );

/** What a filter's `run` may need beyond its values. */
export interface FilterContext {
  /** The size of the image the run is on (the proxy's, during a proxy
   *  preview), so normalised positions become pixels. */
  width: number;
  height: number;
  /** The foreground and background colours (Sketch, Render, Tiles). */
  fg: readonly [number, number, number];
  bg: readonly [number, number, number];
  /** The engine handle an `image` parameter resolved to (the composite,
   *  or the file the dialog decoded), or null when none is ready. */
  resource(key: string): number | null;
}

export interface FilterDef {
  /** The id: the command is `filter<Id>` with the first letter raised. */
  id: FilterId;
  /** The dialog's title and the undo step's name (a message key). */
  label: string;
  /** Where the menu shows it, under Image ▸ Filter. */
  group: FilterGroup;
  params: readonly ParamSpec[];
  /** Scale the values for the proxy preview beyond the `px` lengths and
   *  the points' `pxValue` (a percentage that is really a length, the
   *  Filter Gallery's stack). */
  scale?(values: FilterValues, factor: number): Record<string, FilterValue>;
  run(
    engine: ImageEngine,
    handle: number,
    v: FilterValues,
    ctx: FilterContext,
  ): Promise<DecodedInfo>;
}

/** Every filter id (the command is `filter<Id>`). */
export type FilterId =
  | "gaussianBlur"
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
  | "selectiveColour"
  | "displace"
  | "polarCoordinates"
  | "ripple"
  | "shear"
  | "zigzag"
  | "clouds"
  | "differenceClouds"
  | "fibers"
  | "lensFlare"
  | "lightingEffects"
  | "wind"
  | "extrude"
  | "tiles"
  | "traceContour"
  | "crystallize"
  | "pointillize"
  | "mezzotint"
  | "colorHalftone"
  | "shadowsHighlights"
  | "hdrToning"
  | "matchColor"
  | "replaceColor"
  | "develop"
  | "coloredPencil"
  | "cutout"
  | "dryBrush"
  | "fresco"
  | "neonGlow"
  | "paletteKnife"
  | "plasticWrap"
  | "roughPastels"
  | "smudgeStick"
  | "sponge"
  | "underpainting"
  | "watercolor"
  | "accentedEdges"
  | "angledStrokes"
  | "darkStrokes"
  | "inkOutlines"
  | "sprayedStrokes"
  | "sumiE"
  | "diffuseGlow"
  | "oceanRipple"
  | "chalkCharcoal"
  | "charcoal"
  | "chrome"
  | "conteCrayon"
  | "graphicPen"
  | "notePaper"
  | "plaster"
  | "reticulation"
  | "stamp"
  | "tornEdges"
  | "waterPaper"
  | "craquelure"
  | "grain"
  | "mosaicTiles"
  | "patchwork"
  | "filterGallery"
  | "blurGallery";

export type FilterGroup =
  | "Blur"
  | "Blur Gallery"
  | "Noise"
  | "Distort"
  | "Render"
  | "Other"
  | "Sharpen"
  | "Stylize"
  | "Pixelate"
  | "Filter Gallery"
  | "Adjust";

export const F = defineMessages("image.filter", {
  gaussianBlur: "Gaussian blur",
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
export const MEDIAN_MAX_RADIUS = 10;
export const MORPH_MAX_RADIUS = 32;
export const BOX_MAX_RADIUS = 32;
export const SURFACE_MAX_RADIUS = 16;
export const HIGH_PASS_MAX_SIGMA = 10;
/** The adjust chain's blur: its window reaches 3 sigma, up to the
 *  Gaussian kernel's radius bound, 24 (`conv::GAUSSIAN_MAX_RADIUS`). */
export const GAUSSIAN_MAX_SIGMA = 8;

export const num = (v: FilterValues, k: string): number => {
  const x = v[k];
  return typeof x === "number" ? x : 0;
};
export const bool = (v: FilterValues, k: string): boolean => v[k] === true;
export const rgb = (
  v: FilterValues,
  k: string,
): readonly [number, number, number] => {
  const x = v[k];
  return Array.isArray(x) ? (x as [number, number, number]) : [0, 0, 0];
};

export const range = (
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
export const angle = (key: string, label: string, dflt: number): ParamSpec => ({
  kind: "angle",
  key,
  label,
  default: dflt,
});
export const amount = (dflt = 1): ParamSpec =>
  range("amount", F.amount, 0, 1, 0.01, dflt, { percent: true });
export const shape: ParamSpec = {
  kind: "select",
  key: "round",
  label: F.preserve,
  options: [
    { value: 0, label: F.squareness },
    { value: 1, label: F.roundness },
  ],
  default: 0,
};

export const select = (
  key: string,
  label: string,
  options: readonly string[],
  dflt: number,
): ParamSpec => ({
  kind: "select",
  key,
  label,
  options: options.map((l, value) => ({ value, label: l })),
  default: dflt,
});
export const toggle = (
  key: string,
  label: string,
  dflt: boolean,
): ParamSpec => ({ kind: "toggle", key, label, default: dflt });
export const colour = (
  key: string,
  label: string,
  dflt: readonly [number, number, number],
): ParamSpec => ({ kind: "color", key, label, default: dflt });
export const seed = (): ParamSpec => range("seed", F.seed, 1, 999, 1, 1);
/** The same parameter under a section heading / a condition. */
export const inSection = (
  section: string,
  params: readonly ParamSpec[],
  showIf?: ParamCommon["showIf"],
): ParamSpec[] =>
  params.map((p) => ({ ...p, section, ...(showIf ? { showIf } : {}) }));

/** Run several engine steps as ONE undo step: detached on a flat copy of
 *  what the filter reads (`filterSource`), each step's intermediate freed,
 *  the last result landed through the selection (`filterLand`). One step
 *  runs directly (its own landing is already one step). */
export async function chain(
  e: ImageEngine,
  handle: number,
  steps: ReadonlyArray<(h: number) => Promise<DecodedInfo>>,
): Promise<DecodedInfo> {
  if (steps.length === 1) return steps[0]!(handle);
  const src = e.filterSource(handle);
  let cur = src.handle;
  try {
    for (const step of steps) {
      const next = (await step(cur)).handle;
      if (next !== cur) e.freeImage(cur);
      cur = next;
    }
    return await e.filterLand(handle, cur);
  } finally {
    e.freeImage(cur);
  }
}
