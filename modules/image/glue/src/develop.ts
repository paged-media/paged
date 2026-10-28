// DEVELOP (WP5.2) — the Camera Raw-class adjustment, in Lightroom/ACR
// units: white balance, tone, presence, HSL per colour range, colour
// grading wheels, a parametric tone curve, sharpening and noise
// reduction.
//
// ONE schema, two doors:
//
// * Filter ▸ Develop… — the one-shot filter (the generic Filter dialog,
//   live preview, OK one undo step): `apply_develop` runs the develop
//   kernels in the active layer;
// * Layer ▸ New Adjustment Layer ▸ Develop — the typed adjustment layer
//   `"develop"`: the same 61 values on the wire (`values`), evaluated by
//   the fold, edited in the layer's Properties (layer-parity.tsx draws
//   this schema there).
//
// The order of DEVELOP_SETTINGS is the wire order the engine reads; the
// all-defaults vector is the identity.

import { defineMessages } from "@paged-media/strings";

import {
  inSection,
  range,
  type FilterDef,
  type FilterValues,
  type ParamSpec,
} from "./filters-schema";

export const D = defineMessages("image.develop", {
  develop: "Develop",
  basic: "Basic",
  whiteBalance: "White balance",
  temperature: "Temperature",
  tint: "Tint",
  exposure: "Exposure",
  contrast: "Contrast",
  highlights: "Highlights",
  shadows: "Shadows",
  whites: "Whites",
  blacks: "Blacks",
  presence: "Presence",
  texture: "Texture",
  clarity: "Clarity",
  dehaze: "Dehaze",
  vibrance: "Vibrance",
  saturation: "Saturation",
  hsl: "HSL",
  hue: "Hue",
  luminance: "Luminance",
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  aqua: "Aqua",
  blue: "Blue",
  purple: "Purple",
  magenta: "Magenta",
  grading: "Colour grading",
  gradeShadows: "Shadows",
  gradeMidtones: "Midtones",
  gradeHighlights: "Highlights",
  gradeGlobal: "Global",
  blending: "Blending",
  balance: "Balance",
  toneCurve: "Tone curve",
  curveHighlights: "Highlights",
  curveLights: "Lights",
  curveDarks: "Darks",
  curveShadows: "Shadows",
  detail: "Detail",
  sharpening: "Sharpening",
  amount: "Amount",
  radius: "Radius",
  detailAmount: "Detail",
  masking: "Masking",
  noiseReduction: "Noise reduction",
  nrLuminance: "Luminance",
  nrColour: "Colour",
  reset: "Reset",
});

/** The eight HSL ranges, in Lightroom's order. */
export const HSL_RANGES = [
  D.red,
  D.orange,
  D.yellow,
  D.green,
  D.aqua,
  D.blue,
  D.purple,
  D.magenta,
] as const;

/** One setting: its wire index is its position in DEVELOP_SETTINGS. */
export interface DevelopSetting {
  key: string;
  label: string;
  section: string;
  /** A sub-heading inside the section (the HSL range, the grading wheel). */
  group?: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

const s = (
  key: string,
  label: string,
  section: string,
  min: number,
  max: number,
  step = 1,
  dflt = 0,
  group?: string,
): DevelopSetting => ({
  key,
  label,
  section,
  min,
  max,
  step,
  default: dflt,
  ...(group ? { group } : {}),
});

const hsl: DevelopSetting[] = HSL_RANGES.flatMap((range, i) => [
  s(`hsl${i}h`, D.hue, D.hsl, -100, 100, 1, 0, range),
  s(`hsl${i}s`, D.saturation, D.hsl, -100, 100, 1, 0, range),
  s(`hsl${i}l`, D.luminance, D.hsl, -100, 100, 1, 0, range),
]);

const wheel = (key: string, group: string): DevelopSetting[] => [
  s(`${key}H`, D.hue, D.grading, 0, 360, 1, 0, group),
  s(`${key}S`, D.saturation, D.grading, 0, 100, 1, 0, group),
  s(`${key}L`, D.luminance, D.grading, -100, 100, 1, 0, group),
];

/** The 61 settings, in WIRE order (image-js `develop` layer / door). */
export const DEVELOP_SETTINGS: readonly DevelopSetting[] = [
  s("temperature", D.temperature, D.basic, -100, 100),
  s("tint", D.tint, D.basic, -100, 100),
  s("exposure", D.exposure, D.basic, -5, 5, 0.05),
  s("contrast", D.contrast, D.basic, -100, 100),
  s("highlights", D.highlights, D.basic, -100, 100),
  s("shadows", D.shadows, D.basic, -100, 100),
  s("whites", D.whites, D.basic, -100, 100),
  s("blacks", D.blacks, D.basic, -100, 100),
  s("texture", D.texture, D.presence, -100, 100),
  s("clarity", D.clarity, D.presence, -100, 100),
  s("dehaze", D.dehaze, D.presence, -100, 100),
  s("vibrance", D.vibrance, D.presence, -100, 100),
  s("saturation", D.saturation, D.presence, -100, 100),
  ...hsl,
  ...wheel("shadows", D.gradeShadows),
  ...wheel("midtones", D.gradeMidtones),
  ...wheel("highlights", D.gradeHighlights),
  ...wheel("global", D.gradeGlobal),
  s("blending", D.blending, D.grading, 0, 100, 1, 50),
  s("balance", D.balance, D.grading, -100, 100),
  s("curveHighlights", D.curveHighlights, D.toneCurve, -100, 100),
  s("curveLights", D.curveLights, D.toneCurve, -100, 100),
  s("curveDarks", D.curveDarks, D.toneCurve, -100, 100),
  s("curveShadows", D.curveShadows, D.toneCurve, -100, 100),
  s("sharpenAmount", D.amount, D.detail, 0, 150, 1, 0, D.sharpening),
  s("sharpenRadius", D.radius, D.detail, 0.5, 3, 0.1, 1, D.sharpening),
  s("sharpenDetail", D.detailAmount, D.detail, 0, 100, 1, 25, D.sharpening),
  s("sharpenMasking", D.masking, D.detail, 0, 100, 1, 0, D.sharpening),
  s("nrLuminance", D.nrLuminance, D.detail, 0, 100, 1, 0, D.noiseReduction),
  s("nrColour", D.nrColour, D.detail, 0, 100, 1, 0, D.noiseReduction),
];

/** The sections, in panel order. */
export const DEVELOP_SECTIONS: readonly string[] = [
  D.basic,
  D.presence,
  D.hsl,
  D.grading,
  D.toneCurve,
  D.detail,
];

export const DEVELOP_LENGTH = 61;
if (DEVELOP_SETTINGS.length !== DEVELOP_LENGTH)
  throw new Error(
    `develop: ${DEVELOP_SETTINGS.length} settings, the wire takes ${DEVELOP_LENGTH}`,
  );

/** The identity vector (every setting at its default). */
export const developDefaults = (): number[] =>
  DEVELOP_SETTINGS.map((x) => x.default);

/** Is this vector the identity? */
export const developIsIdentity = (v: readonly number[]): boolean =>
  DEVELOP_SETTINGS.every((x, i) => (v[i] ?? x.default) === x.default);

/** The dialog's values (by key) → the wire vector. */
export const developVector = (v: FilterValues): number[] =>
  DEVELOP_SETTINGS.map((x) => {
    const n = v[x.key];
    return typeof n === "number" ? n : x.default;
  });

/** The schema as the Filter dialog's parameters (sections as headings,
 *  the sub-group in the label). */
const params: ParamSpec[] = DEVELOP_SETTINGS.flatMap((x) =>
  inSection(x.section, [
    range(x.key, x.label, x.min, x.max, x.step, x.default),
  ]).map((p) => (x.group ? { ...p, group: x.group } : p)),
);

export const DEVELOP_FILTERS: readonly FilterDef[] = [
  {
    id: "develop",
    label: D.develop,
    group: "Adjust",
    params,
    run: (e, h, v) => e.applyDevelop(h, developVector(v)),
  },
];
