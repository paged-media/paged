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

// LAYER STYLES (WP5.4) — the style model as the bundle sees it: the JSON
// form of `paged-psd`'s `LayerStyle` (camelCase fields, snake_case enum
// values), Photoshop's defaults for each effect, the Styles presets, and
// the small pure edits the Layer Style dialog makes. Everything here is
// data; the engine draws it (`image-js` `layers::styles`).

export type BlendModeName =
  | "normal"
  | "dissolve"
  | "darken"
  | "multiply"
  | "color_burn"
  | "linear_burn"
  | "darker_color"
  | "lighten"
  | "screen"
  | "color_dodge"
  | "linear_dodge"
  | "lighter_color"
  | "overlay"
  | "soft_light"
  | "hard_light"
  | "vivid_light"
  | "linear_light"
  | "pin_light"
  | "hard_mix"
  | "difference"
  | "exclusion"
  | "subtract"
  | "divide"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

/** The modes an effect can use, in Photoshop's menu order. */
export const STYLE_BLEND_MODES: readonly BlendModeName[] = [
  "normal",
  "dissolve",
  "darken",
  "multiply",
  "color_burn",
  "linear_burn",
  "darker_color",
  "lighten",
  "screen",
  "color_dodge",
  "linear_dodge",
  "lighter_color",
  "overlay",
  "soft_light",
  "hard_light",
  "vivid_light",
  "linear_light",
  "pin_light",
  "hard_mix",
  "difference",
  "exclusion",
  "subtract",
  "divide",
  "hue",
  "saturation",
  "color",
  "luminosity",
];

export type Rgb = [number, number, number];

export interface ContourPoint {
  x: number;
  y: number;
  corner?: boolean;
}

export interface Contour {
  name: string;
  points: ContourPoint[];
}

export interface GradientColorStop {
  at: number;
  rgb: Rgb;
  midpoint: number;
}

export interface GradientOpacityStop {
  at: number;
  opacity: number;
  midpoint: number;
}

export interface Gradient {
  name: string;
  smoothness: number;
  stops: GradientColorStop[];
  opacityStops: GradientOpacityStop[];
}

export type GradientStyle =
  "linear" | "radial" | "angle" | "reflected" | "diamond";

export interface GradientFill {
  gradient: Gradient;
  style: GradientStyle;
  angle: number;
  scale: number;
  reverse: boolean;
  dither: boolean;
  align: boolean;
  offset: [number, number];
}

export interface PatternRef {
  name: string;
  id: string;
}

export interface PatternFill {
  pattern: PatternRef;
  scale: number;
  link: boolean;
  phase: [number, number];
}

export interface Shadow {
  enabled: boolean;
  blend: BlendModeName;
  color: Rgb;
  opacity: number;
  useGlobalLight: boolean;
  angle: number;
  distance: number;
  spread: number;
  size: number;
  noise: number;
  contour: Contour;
  antiAliased: boolean;
  knocksOut: boolean;
}

export type GlowFill =
  { kind: "color"; rgb: Rgb } | { kind: "gradient"; gradient: Gradient };

export interface Glow {
  enabled: boolean;
  blend: BlendModeName;
  fill: GlowFill;
  opacity: number;
  technique: "softer" | "precise";
  spread: number;
  size: number;
  range: number;
  jitter: number;
  noise: number;
  contour: Contour;
  antiAliased: boolean;
  source: "center" | "edge";
}

export type BevelStyle =
  "outer_bevel" | "inner_bevel" | "emboss" | "pillow_emboss" | "stroke_emboss";

export type BevelTechnique = "smooth" | "chisel_hard" | "chisel_soft";

export interface BevelLight {
  blend: BlendModeName;
  color: Rgb;
  opacity: number;
}

export interface BevelContour {
  enabled: boolean;
  contour: Contour;
  antiAliased: boolean;
  range: number;
}

export interface BevelTexture {
  enabled: boolean;
  fill: PatternFill;
  depth: number;
  invert: boolean;
}

export interface Bevel {
  enabled: boolean;
  style: BevelStyle;
  technique: BevelTechnique;
  depth: number;
  down: boolean;
  size: number;
  soften: number;
  useGlobalLight: boolean;
  angle: number;
  altitude: number;
  gloss: Contour;
  glossAntiAliased: boolean;
  highlight: BevelLight;
  shadow: BevelLight;
  contour: BevelContour | null;
  texture: BevelTexture | null;
}

export interface Satin {
  enabled: boolean;
  blend: BlendModeName;
  color: Rgb;
  opacity: number;
  angle: number;
  distance: number;
  size: number;
  contour: Contour;
  antiAliased: boolean;
  invert: boolean;
}

export interface ColorFill {
  enabled: boolean;
  blend: BlendModeName;
  color: Rgb;
  opacity: number;
}

export interface GradientOverlay {
  enabled: boolean;
  blend: BlendModeName;
  opacity: number;
  fill: GradientFill;
}

export interface PatternOverlay {
  enabled: boolean;
  blend: BlendModeName;
  opacity: number;
  fill: PatternFill;
}

export type StrokeFill =
  | { kind: "color"; rgb: Rgb }
  | ({ kind: "gradient" } & GradientFill)
  | ({ kind: "pattern" } & PatternFill);

export interface Stroke {
  enabled: boolean;
  position: "outside" | "inside" | "center";
  fill: StrokeFill;
  blend: BlendModeName;
  opacity: number;
  size: number;
}

export interface LayerStyle {
  enabled: boolean;
  scale: number;
  dropShadows: Shadow[];
  innerShadows: Shadow[];
  outerGlow: Glow | null;
  innerGlow: Glow | null;
  bevel: Bevel | null;
  satin: Satin | null;
  colorOverlays: ColorFill[];
  gradientOverlays: GradientOverlay[];
  patternOverlay: PatternOverlay | null;
  strokes: Stroke[];
}

export interface GlobalLight {
  angle: number;
  altitude: number;
}

/** The ten effects, in the Layer Style dialog's order. */
export const EFFECT_KINDS = [
  "bevel",
  "stroke",
  "innerShadow",
  "innerGlow",
  "satin",
  "colorOverlay",
  "gradientOverlay",
  "patternOverlay",
  "outerGlow",
  "dropShadow",
] as const;

export type EffectKind = (typeof EFFECT_KINDS)[number];

/** The descriptor key of each effect (what a layer row lists). */
export const EFFECT_KEY: Record<EffectKind, string> = {
  bevel: "ebbl",
  stroke: "FrFX",
  innerShadow: "IrSh",
  innerGlow: "IrGl",
  satin: "ChFX",
  colorOverlay: "SoFi",
  gradientOverlay: "GrFl",
  patternOverlay: "patternFill",
  outerGlow: "OrGl",
  dropShadow: "DrSh",
};

export const linearContour = (): Contour => ({
  name: "Linear",
  points: [
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ],
});

/** The contour presets the dialog offers (Photoshop's names). */
export const CONTOURS: Record<string, () => Contour> = {
  linear: linearContour,
  cone: () => ({
    name: "Cone",
    points: [
      { x: 0, y: 0 },
      { x: 128, y: 255, corner: true },
      { x: 255, y: 0 },
    ],
  }),
  coneInverted: () => ({
    name: "Cone - Inverted",
    points: [
      { x: 0, y: 255 },
      { x: 128, y: 0, corner: true },
      { x: 255, y: 255 },
    ],
  }),
  gaussian: () => ({
    name: "Gaussian",
    points: [
      { x: 0, y: 0 },
      { x: 64, y: 20 },
      { x: 192, y: 235 },
      { x: 255, y: 255 },
    ],
  }),
  halfRound: () => ({
    name: "Half Round",
    points: [
      { x: 0, y: 0 },
      { x: 50, y: 150 },
      { x: 128, y: 230 },
      { x: 255, y: 255 },
    ],
  }),
  ring: () => ({
    name: "Ring",
    points: [
      { x: 0, y: 0 },
      { x: 64, y: 255 },
      { x: 128, y: 0 },
      { x: 192, y: 255 },
      { x: 255, y: 0 },
    ],
  }),
};

export const twoStopGradient = (a: Rgb, b: Rgb): Gradient => ({
  name: "Custom",
  smoothness: 100,
  stops: [
    { at: 0, rgb: a, midpoint: 0.5 },
    { at: 1, rgb: b, midpoint: 0.5 },
  ],
  opacityStops: [
    { at: 0, opacity: 1, midpoint: 0.5 },
    { at: 1, opacity: 1, midpoint: 0.5 },
  ],
});

/** Photoshop's defaults for a new effect of each kind. */
export function defaultShadow(inner: boolean): Shadow {
  return {
    enabled: true,
    blend: "multiply",
    color: [0, 0, 0],
    opacity: inner ? 35 : 35,
    useGlobalLight: true,
    angle: 120,
    distance: inner ? 3 : 3,
    spread: 0,
    size: inner ? 7 : 7,
    noise: 0,
    contour: linearContour(),
    antiAliased: false,
    knocksOut: !inner,
  };
}

export function defaultGlow(inner: boolean): Glow {
  return {
    enabled: true,
    blend: "screen",
    fill: { kind: "color", rgb: [255, 255, 190] },
    opacity: 75,
    technique: "softer",
    spread: 0,
    size: 5,
    range: 50,
    jitter: 0,
    noise: 0,
    contour: linearContour(),
    antiAliased: false,
    source: inner ? "edge" : "edge",
  };
}

export function defaultBevel(): Bevel {
  return {
    enabled: true,
    style: "inner_bevel",
    technique: "smooth",
    depth: 100,
    down: false,
    size: 5,
    soften: 0,
    useGlobalLight: true,
    angle: 120,
    altitude: 30,
    gloss: linearContour(),
    glossAntiAliased: false,
    highlight: { blend: "screen", color: [255, 255, 255], opacity: 75 },
    shadow: { blend: "multiply", color: [0, 0, 0], opacity: 75 },
    contour: null,
    texture: null,
  };
}

export function defaultSatin(): Satin {
  return {
    enabled: true,
    blend: "multiply",
    color: [0, 0, 0],
    opacity: 50,
    angle: 19,
    distance: 11,
    size: 14,
    contour: CONTOURS.gaussian!(),
    antiAliased: true,
    invert: true,
  };
}

export function defaultColorOverlay(): ColorFill {
  return { enabled: true, blend: "normal", color: [255, 0, 0], opacity: 100 };
}

export function defaultGradientFill(): GradientFill {
  return {
    gradient: twoStopGradient([0, 0, 0], [255, 255, 255]),
    style: "linear",
    angle: 90,
    scale: 100,
    reverse: false,
    dither: false,
    align: true,
    offset: [0, 0],
  };
}

export function defaultGradientOverlay(): GradientOverlay {
  return {
    enabled: true,
    blend: "normal",
    opacity: 100,
    fill: defaultGradientFill(),
  };
}

export function defaultPatternFill(pattern?: PatternRef): PatternFill {
  return {
    pattern: pattern ?? { name: "", id: "" },
    scale: 100,
    link: true,
    phase: [0, 0],
  };
}

export function defaultPatternOverlay(pattern?: PatternRef): PatternOverlay {
  return {
    enabled: true,
    blend: "normal",
    opacity: 100,
    fill: defaultPatternFill(pattern),
  };
}

export function defaultStroke(): Stroke {
  return {
    enabled: true,
    position: "outside",
    fill: { kind: "color", rgb: [0, 0, 0] },
    blend: "normal",
    opacity: 100,
    size: 3,
  };
}

export function emptyStyle(): LayerStyle {
  return {
    enabled: true,
    scale: 100,
    dropShadows: [],
    innerShadows: [],
    outerGlow: null,
    innerGlow: null,
    bevel: null,
    satin: null,
    colorOverlays: [],
    gradientOverlays: [],
    patternOverlay: null,
    strokes: [],
  };
}

/** A deep copy (a style is plain JSON). */
export function cloneStyle(s: LayerStyle): LayerStyle {
  return JSON.parse(JSON.stringify(s)) as LayerStyle;
}

/** Is the effect present (enabled or not) in the style? */
export function hasEffect(s: LayerStyle, kind: EffectKind): boolean {
  switch (kind) {
    case "dropShadow":
      return s.dropShadows.length > 0;
    case "innerShadow":
      return s.innerShadows.length > 0;
    case "outerGlow":
      return s.outerGlow !== null;
    case "innerGlow":
      return s.innerGlow !== null;
    case "bevel":
      return s.bevel !== null;
    case "satin":
      return s.satin !== null;
    case "colorOverlay":
      return s.colorOverlays.length > 0;
    case "gradientOverlay":
      return s.gradientOverlays.length > 0;
    case "patternOverlay":
      return s.patternOverlay !== null;
    case "stroke":
      return s.strokes.length > 0;
  }
}

/** Is the (first) effect of `kind` switched on? */
export function effectEnabled(s: LayerStyle, kind: EffectKind): boolean {
  const e = firstEffect(s, kind);
  return e !== null && e.enabled;
}

/** The first effect of `kind`, or null. */
export function firstEffect(
  s: LayerStyle,
  kind: EffectKind,
): { enabled: boolean } | null {
  switch (kind) {
    case "dropShadow":
      return s.dropShadows[0] ?? null;
    case "innerShadow":
      return s.innerShadows[0] ?? null;
    case "outerGlow":
      return s.outerGlow;
    case "innerGlow":
      return s.innerGlow;
    case "bevel":
      return s.bevel;
    case "satin":
      return s.satin;
    case "colorOverlay":
      return s.colorOverlays[0] ?? null;
    case "gradientOverlay":
      return s.gradientOverlays[0] ?? null;
    case "patternOverlay":
      return s.patternOverlay;
    case "stroke":
      return s.strokes[0] ?? null;
  }
}

/** Switch an effect on or off — adding it with Photoshop's defaults when
 *  the style has none (a new copy; the style passed in is not changed). */
export function setEffectEnabled(
  s: LayerStyle,
  kind: EffectKind,
  on: boolean,
  pattern?: PatternRef,
): LayerStyle {
  const next = cloneStyle(s);
  const existing = firstEffect(next, kind);
  if (existing) {
    existing.enabled = on;
    return next;
  }
  if (!on) return next;
  switch (kind) {
    case "dropShadow":
      next.dropShadows.push(defaultShadow(false));
      break;
    case "innerShadow":
      next.innerShadows.push(defaultShadow(true));
      break;
    case "outerGlow":
      next.outerGlow = defaultGlow(false);
      break;
    case "innerGlow":
      next.innerGlow = defaultGlow(true);
      break;
    case "bevel":
      next.bevel = defaultBevel();
      break;
    case "satin":
      next.satin = defaultSatin();
      break;
    case "colorOverlay":
      next.colorOverlays.push(defaultColorOverlay());
      break;
    case "gradientOverlay":
      next.gradientOverlays.push(defaultGradientOverlay());
      break;
    case "patternOverlay":
      next.patternOverlay = defaultPatternOverlay(pattern);
      break;
    case "stroke":
      next.strokes.push(defaultStroke());
      break;
  }
  return next;
}

/** Add one more instance of an effect that may repeat (Drop Shadow, Inner
 *  Shadow, Color and Gradient Overlay, Stroke — Photoshop's "+"). */
export const REPEATABLE: readonly EffectKind[] = [
  "dropShadow",
  "innerShadow",
  "colorOverlay",
  "gradientOverlay",
  "stroke",
];

export function addInstance(s: LayerStyle, kind: EffectKind): LayerStyle {
  const next = cloneStyle(s);
  switch (kind) {
    case "dropShadow":
      next.dropShadows.push(defaultShadow(false));
      break;
    case "innerShadow":
      next.innerShadows.push(defaultShadow(true));
      break;
    case "colorOverlay":
      next.colorOverlays.push(defaultColorOverlay());
      break;
    case "gradientOverlay":
      next.gradientOverlays.push(defaultGradientOverlay());
      break;
    case "stroke":
      next.strokes.push(defaultStroke());
      break;
    default:
      return setEffectEnabled(next, kind, true);
  }
  return next;
}

/** Does the style draw anything? */
export function styleDraws(s: LayerStyle | null): boolean {
  return (
    s !== null && s.enabled && EFFECT_KINDS.some((k) => effectEnabled(s, k))
  );
}

/** Blending Options ▸ Advanced Blending's style switches, as the engine's
 *  bits: 1 interior, 2 clipped, 4 transparency shapes, 8 layer mask hides,
 *  16 vector mask hides. */
export interface StyleOptions {
  blendInterior: boolean;
  blendClipped: boolean;
  transparencyShapes: boolean;
  maskHidesEffects: boolean;
  vectorMaskHidesEffects: boolean;
}

export const DEFAULT_STYLE_OPTIONS: StyleOptions = {
  blendInterior: false,
  blendClipped: true,
  transparencyShapes: true,
  maskHidesEffects: false,
  vectorMaskHidesEffects: false,
};

export function styleOptionsFromBits(b: number): StyleOptions {
  return {
    blendInterior: (b & 1) !== 0,
    blendClipped: (b & 2) !== 0,
    transparencyShapes: (b & 4) !== 0,
    maskHidesEffects: (b & 8) !== 0,
    vectorMaskHidesEffects: (b & 16) !== 0,
  };
}

export function styleOptionsBits(o: StyleOptions): number {
  return (
    (o.blendInterior ? 1 : 0) |
    (o.blendClipped ? 2 : 0) |
    (o.transparencyShapes ? 4 : 0) |
    (o.maskHidesEffects ? 8 : 0) |
    (o.vectorMaskHidesEffects ? 16 : 0)
  );
}

/** A saved style (the Styles panel, the Preset Manager). */
export interface StylePreset {
  /** Stable for the preset's life (image ADR 477). */
  id: string;
  name: string;
  style: LayerStyle;
  /** A built-in preset (cannot be deleted). */
  builtIn?: boolean;
  /** Photoshop's style id, when it came from an `.asl`. */
  psId?: string;
}

/** The Styles panel's built-in presets. */
export function builtInPresets(): StylePreset[] {
  const shadow = setEffectEnabled(emptyStyle(), "dropShadow", true);
  const glow = setEffectEnabled(emptyStyle(), "outerGlow", true);
  const emboss = setEffectEnabled(emptyStyle(), "bevel", true);
  const outline = setEffectEnabled(emptyStyle(), "stroke", true);
  const button = ["dropShadow", "bevel", "gradientOverlay"].reduce<LayerStyle>(
    (s, k) => setEffectEnabled(s, k as EffectKind, true),
    emptyStyle(),
  );
  button.gradientOverlays[0]!.opacity = 40;
  const satin = setEffectEnabled(emptyStyle(), "satin", true);
  return [
    {
      id: "builtin-drop-shadow",
      name: "Drop Shadow",
      style: shadow,
      builtIn: true,
    },
    { id: "builtin-soft-glow", name: "Soft Glow", style: glow, builtIn: true },
    { id: "builtin-emboss", name: "Emboss", style: emboss, builtIn: true },
    { id: "builtin-outline", name: "Outline", style: outline, builtIn: true },
    { id: "builtin-button", name: "Button", style: button, builtIn: true },
    { id: "builtin-satin", name: "Satin", style: satin, builtIn: true },
  ];
}
