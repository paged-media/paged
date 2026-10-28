// FILTER ▸ BLUR GALLERY (WP5.2) — Field, Iris, Tilt-Shift, Path and Spin
// blur in ONE workspace, as Photoshop has them: each blur has its switch
// and its settings, any of them can be on at once, and they apply in
// Photoshop's order (field, iris, tilt-shift, path, spin) as one undo
// step. The geometry is ON THE CANVAS: the workspace draws each blur's
// pins, ellipse, band or path over the image (host.overlay) and any image
// tool's drag moves them (`blur-gallery-pins.ts`); the dialog's sliders
// set the same values.
//
// Positions are NORMALISED to the image (0..1) so the proxy preview, the
// full pass and a resized image agree; blur amounts and band widths are
// px, scaled for the proxy. The kernels (image-kernels `blurgal`) blur
// with a per-pixel radius from this geometry.

import { defineMessages } from "@paged-media/strings";

import {
  angle,
  chain,
  inSection,
  num,
  range,
  toggle,
  bool,
  type FilterDef,
  type FilterValues,
  type ParamSpec,
} from "./filters-schema";
import type { DecodedInfo, ImageEngine } from "./engine";

export const BG = defineMessages("image.blurGallery", {
  blurGallery: "Blur gallery",
  field: "Field blur",
  iris: "Iris blur",
  tiltShift: "Tilt-shift",
  path: "Path blur",
  spin: "Spin blur",
  pins: "Pins",
  blur: "Blur",
  centreX: "Centre X",
  centreY: "Centre Y",
  radiusX: "Radius X",
  radiusY: "Radius Y",
  rotation: "Rotation",
  feather: "Sharp area",
  angle: "Angle",
  sharpBand: "Sharp band",
  transition: "Transition",
  symmetric: "Symmetric distortion",
  points: "Path points",
  speed: "Speed",
  taper: "Taper",
  centered: "Centred blur",
  blurAngle: "Blur angle",
  rimFeather: "Feather",
  bokeh: "Light bokeh",
  effects: "Effects",
  canvasNote:
    "Drag a pin, a centre or a rim on the canvas to move it; a click with " +
    "Field blur on adds a pin. Any image tool's drag edits the blur while " +
    "the gallery is open.",
});

/** The five blurs, in Photoshop's order (the menu presets one of them). */
export const BLUR_KINDS = ["field", "iris", "tilt", "path", "spin"] as const;
export type BlurKind = (typeof BLUR_KINDS)[number];

const on = (kind: BlurKind) => ({ key: kind, equals: true });

const params: ParamSpec[] = [
  toggle("field", BG.field, true),
  ...inSection(
    BG.field,
    [
      {
        kind: "points",
        key: "fieldPins",
        label: BG.pins,
        stride: 3,
        min: 0,
        max: 128,
        default: [0.5, 0.5, 15],
        pxValue: true,
      },
    ],
    on("field"),
  ),
  toggle("iris", BG.iris, false),
  ...inSection(
    BG.iris,
    [
      range("irisBlur", BG.blur, 0, 128, 1, 15, { px: true }),
      range("irisX", BG.centreX, 0, 1, 0.01, 0.5, { percent: true }),
      range("irisY", BG.centreY, 0, 1, 0.01, 0.5, { percent: true }),
      range("irisRx", BG.radiusX, 0.02, 1, 0.01, 0.25, { percent: true }),
      range("irisRy", BG.radiusY, 0.02, 1, 0.01, 0.25, { percent: true }),
      angle("irisRot", BG.rotation, 0),
      range("irisFeather", BG.feather, 0, 1, 0.01, 0.5, { percent: true }),
    ],
    on("iris"),
  ),
  toggle("tilt", BG.tiltShift, false),
  ...inSection(
    BG.tiltShift,
    [
      range("tiltBlur", BG.blur, 0, 128, 1, 15, { px: true }),
      range("tiltX", BG.centreX, 0, 1, 0.01, 0.5, { percent: true }),
      range("tiltY", BG.centreY, 0, 1, 0.01, 0.5, { percent: true }),
      angle("tiltAngle", BG.angle, 0),
      range("tiltSharp", BG.sharpBand, 0, 2048, 1, 40, { px: true }),
      range("tiltFeather", BG.transition, 0, 2048, 1, 80, { px: true }),
      toggle("tiltSym", BG.symmetric, true),
    ],
    on("tilt"),
  ),
  toggle("path", BG.path, false),
  ...inSection(
    BG.path,
    [
      {
        kind: "points",
        key: "pathPoints",
        label: BG.points,
        stride: 2,
        min: 0,
        max: 1,
        default: [0.3, 0.5, 0.7, 0.5],
      },
      range("pathSpeed", BG.speed, 0, 128, 1, 40, { px: true }),
      range("pathTaper", BG.taper, 0, 1, 0.01, 0, { percent: true }),
      toggle("pathCentered", BG.centered, true),
    ],
    on("path"),
  ),
  toggle("spin", BG.spin, false),
  ...inSection(
    BG.spin,
    [
      range("spinAngle", BG.blurAngle, 0, 360, 1, 15),
      range("spinX", BG.centreX, 0, 1, 0.01, 0.5, { percent: true }),
      range("spinY", BG.centreY, 0, 1, 0.01, 0.5, { percent: true }),
      range("spinRx", BG.radiusX, 0.02, 1, 0.01, 0.2, { percent: true }),
      range("spinRy", BG.radiusY, 0.02, 1, 0.01, 0.2, { percent: true }),
      angle("spinRot", BG.rotation, 0),
      range("spinFeather", BG.rimFeather, 0, 1, 0.01, 0.1, { percent: true }),
    ],
    on("spin"),
  ),
  ...inSection(BG.effects, [
    range("bokeh", BG.bokeh, 0, 1, 0.01, 0, { percent: true }),
  ]),
];

/** The flat field pins → `[x px, y px, blur px]` triples. */
const pinsOf = (v: FilterValues, w: number, h: number) => {
  const a = v.fieldPins;
  const out: Array<[number, number, number]> = [];
  if (!Array.isArray(a)) return out;
  for (let i = 0; i + 2 < a.length; i += 3)
    out.push([a[i]! * w, a[i + 1]! * h, a[i + 2]!]);
  return out;
};
const pathOf = (v: FilterValues, w: number, h: number) => {
  const a = v.pathPoints;
  const out: Array<[number, number]> = [];
  if (!Array.isArray(a)) return out;
  for (let i = 0; i + 1 < a.length; i += 2)
    out.push([a[i]! * w, a[i + 1]! * h]);
  return out;
};

/** The steps of the blurs that are on, in Photoshop's order. */
export function blurSteps(
  e: ImageEngine,
  v: FilterValues,
  w: number,
  h: number,
): Array<(x: number) => Promise<DecodedInfo>> {
  const span = Math.max(w, h);
  const bokeh = num(v, "bokeh");
  const steps: Array<(x: number) => Promise<DecodedInfo>> = [];
  if (bool(v, "field")) {
    const pins = pinsOf(v, w, h);
    if (pins.length > 0) steps.push((x) => e.applyBlurField(x, pins, bokeh));
  }
  if (bool(v, "iris"))
    steps.push((x) =>
      e.applyBlurIris(x, {
        cx: num(v, "irisX") * w,
        cy: num(v, "irisY") * h,
        rx: num(v, "irisRx") * span,
        ry: num(v, "irisRy") * span,
        rotation: num(v, "irisRot"),
        blur: num(v, "irisBlur"),
        feather: num(v, "irisFeather"),
        bokeh,
      }),
    );
  if (bool(v, "tilt"))
    steps.push((x) =>
      e.applyBlurTiltShift(x, {
        cx: num(v, "tiltX") * w,
        cy: num(v, "tiltY") * h,
        angle: num(v, "tiltAngle"),
        sharp: num(v, "tiltSharp"),
        feather: num(v, "tiltFeather"),
        blur: num(v, "tiltBlur"),
        symmetric: bool(v, "tiltSym"),
        bokeh,
      }),
    );
  if (bool(v, "path")) {
    const pts = pathOf(v, w, h);
    if (pts.length >= 2)
      steps.push((x) =>
        e.applyBlurPath(
          x,
          pts,
          num(v, "pathSpeed"),
          num(v, "pathTaper"),
          bool(v, "pathCentered"),
        ),
      );
  }
  if (bool(v, "spin"))
    steps.push((x) =>
      e.applyBlurSpin(x, {
        cx: num(v, "spinX") * w,
        cy: num(v, "spinY") * h,
        rx: num(v, "spinRx") * span,
        ry: num(v, "spinRy") * span,
        rotation: num(v, "spinRot"),
        angle: num(v, "spinAngle"),
        feather: num(v, "spinFeather"),
      }),
    );
  return steps;
}

export const BLUR_GALLERY: readonly FilterDef[] = [
  {
    id: "blurGallery",
    label: BG.blurGallery,
    group: "Blur Gallery",
    params,
    run(e, h, v, ctx) {
      const steps = blurSteps(e, v, ctx.width, ctx.height);
      if (steps.length === 0)
        return Promise.reject(new Error("no blur is switched on"));
      return chain(e, h, steps);
    },
  },
];

/** The workspace's values with only `kind` switched on (the menu's
 *  Field Blur… / Iris Blur… / … entries). */
export function blurPreset(
  values: Record<string, unknown>,
  kind: BlurKind,
): Record<string, unknown> {
  const out = { ...values };
  for (const k of BLUR_KINDS) out[k] = k === kind;
  return out;
}
