/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// SDK Phase 5 / gallery pixel-parity — the per-effect expansion
// fields rendered inside the Effects panel's violet-railed disclosure
// blocks (one composition per effect family, per the deep1 card).
//
// W2.2 (2026-06-06) — protocol v28 lands the per-field effect paths
// (engine gap 18: blend modes + glow/bevel/satin/feather models).
// Every family flips from a disabled seam pill to a live disclosure
// mirroring the drop-shadow template: an enable pill + per-field
// editors over its `frame{Family}{Field}` PropertyPaths.
//
// The apply arms materialise a default effect struct on the enable
// toggle (set `frame{Family}Enabled = true`), so the per-field
// editors always have a target to mutate. Enum-string fields
// (`Value::Text`) carry the IDML enum strings the parser stores:
//   • Blend mode → InDesign `BlendMode` (Normal / Multiply / Screen…)
//   • Bevel style/technique/direction → InnerBevel / Smooth / Up …
//   • Inner-glow source → EdgeGlow / CenterGlow
//   • Feather corner type → Sharp / Rounded / Diffusion
//
// Engine 0.71.8 (core ADR 135) adds the drop shadow's own blend mode,
// spread, noise, "object knocks out shadow" and "use global light" — the
// rest of InDesign's Drop Shadow dialog. The global light itself is a
// document setting (Object ▸ Effects ▸ Global light…).

import type { CompositionNode } from "@paged-media/catalog";
import type { PropertyPath } from "@paged-media/client";
import {
  PAGED_INPUT_COLOR_SWATCH,
  PAGED_INPUT_LENGTH,
  PAGED_INPUT_NUMERIC_SCRUB,
  PAGED_INPUT_SELECT,
  PAGED_INPUT_TOGGLE_SWITCH,
  PAGED_LAYOUT_CLUSTER,
  PAGED_LAYOUT_SECTION,
  asPropertyFields,
} from "@paged-media/shell";
import type { BlendModeInfo } from "@paged-media/plugin-api";
import { BLEND_MODES } from "@paged-media/plugin-sdk";
import { defineMessages, type Strings } from "@paged-media/strings";

const M = defineMessages("app.effectsComposition", {
  normal: "Normal",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  darken: "Darken",
  lighten: "Lighten",
  colorDodge: "Color dodge",
  colorBurn: "Color burn",
  hardLight: "Hard light",
  softLight: "Soft light",
  difference: "Difference",
  exclusion: "Exclusion",
  hue: "Hue",
  saturation: "Saturation",
  color: "Color",
  luminosity: "Luminosity",
  dissolve: "Dissolve",
  linearBurn: "Linear burn",
  darkerColor: "Darker color",
  linearDodge: "Linear dodge (add)",
  lighterColor: "Lighter color",
  vividLight: "Vivid light",
  linearLight: "Linear light",
  pinLight: "Pin light",
  hardMix: "Hard mix",
  subtract: "Subtract",
  divide: "Divide",
  notInIdml: "InDesign can't store this mode: IDML gets {mode}",
  innerBevel: "Inner bevel",
  outerBevel: "Outer bevel",
  emboss: "Emboss",
  pillowEmboss: "Pillow emboss",
  strokeEmboss: "Stroke emboss",
  smooth: "Smooth",
  chiselHard: "Chisel hard",
  chiselSoft: "Chisel soft",
  up: "Up",
  down: "Down",
  edge: "Edge",
  center: "Center",
  sharp: "Sharp",
  rounded: "Rounded",
  diffusion: "Diffusion",
  mode: "Mode",
  drop: "Drop",
  inner: "Inner",
  blend: "Blend",
  opacity: "Opacity",
  useGlobalLight: "Use global light",
  blur: "Blur",
  spread: "Spread",
  noise: "Noise",
  objectKnocksOutShadow: "Object knocks out shadow",
  angle: "Angle",
  dist: "Dist",
  size: "Size",
  choke: "Choke",
  source: "Source",
  style: "Style",
  technique: "Technique",
  direction: "Direction",
  depth: "Depth",
  soften: "Soften",
  altitude: "Altitude",
  highlight: "Highlight",
  hOpacity: "H opacity",
  shadow: "Shadow",
  sOpacity: "S opacity",
  invert: "Invert",
  width: "Width",
  corner: "Corner",
  left: "Left",
  right: "Right",
  top: "Top",
  bottom: "Bottom",
  dropShadow: "Drop shadow",
  innerShadow: "Inner shadow",
  outerGlow: "Outer glow",
  innerGlow: "Inner glow",
  bevelAndEmboss: "Bevel and emboss",
  satin: "Satin",
  feather: "Feather",
  directionalFeather: "Directional feather",
});

// The blend-mode menus list the engine's modes (engine ADR 1016,
// plugin-sdk's `BLEND_MODES`, in Photoshop's order); only their
// translations live here, keyed by the model spelling. An out-of-list
// current value renders via SelectLeaf's pass-through option.
const BLEND_LABELS: Record<string, (typeof M)[keyof typeof M]> = {
  Normal: M.normal,
  Dissolve: M.dissolve,
  Darken: M.darken,
  Multiply: M.multiply,
  ColorBurn: M.colorBurn,
  LinearBurn: M.linearBurn,
  DarkerColor: M.darkerColor,
  Lighten: M.lighten,
  Screen: M.screen,
  ColorDodge: M.colorDodge,
  LinearDodge: M.linearDodge,
  LighterColor: M.lighterColor,
  Overlay: M.overlay,
  SoftLight: M.softLight,
  HardLight: M.hardLight,
  VividLight: M.vividLight,
  LinearLight: M.linearLight,
  PinLight: M.pinLight,
  HardMix: M.hardMix,
  Difference: M.difference,
  Exclusion: M.exclusion,
  Subtract: M.subtract,
  Divide: M.divide,
  Hue: M.hue,
  Saturation: M.saturation,
  Color: M.color,
  Luminosity: M.luminosity,
};

export interface BlendModeOption {
  value: string;
  label: string;
  /** Photoshop's menu group (0–5). */
  group: number;
  /** One of InDesign's sixteen; otherwise IDML gets `idml`. */
  native: boolean;
  idml: string;
}

const blendOption = (strings: Strings, m: BlendModeInfo): BlendModeOption => {
  const msg = BLEND_LABELS[m.name];
  return {
    value: m.name,
    label: msg ? strings.t(msg) : m.label,
    group: m.group,
    native: m.native,
    idml: m.idml,
  };
};

/** Every blend mode an object, fill, stroke or content target takes
 *  (all 27), grouped as Photoshop's menu groups them. */
export const allBlendModes = (strings: Strings): BlendModeOption[] =>
  BLEND_MODES.map((m) => blendOption(strings, m));

/** The tooltip of a mode InDesign cannot store. */
export const notInIdmlLabel = (strings: Strings, o: BlendModeOption): string =>
  strings.t(M.notInIdml, {
    mode:
      allBlendModes(strings).find((m) => m.value === o.idml)?.label ?? o.idml,
  });

/** An effect's own blend (shadow, glow, satin): InDesign's sixteen. */
export const blendModes = (strings: Strings) =>
  BLEND_MODES.filter((m) => m.native).map((m) => {
    const o = blendOption(strings, m);
    return { value: o.value, label: o.label };
  });

const bevelStyles = (strings: Strings) => [
  { value: "InnerBevel", label: strings.t(M.innerBevel) },
  { value: "OuterBevel", label: strings.t(M.outerBevel) },
  { value: "Emboss", label: strings.t(M.emboss) },
  { value: "PillowEmboss", label: strings.t(M.pillowEmboss) },
  { value: "StrokeEmboss", label: strings.t(M.strokeEmboss) },
];

const bevelTechniques = (strings: Strings) => [
  { value: "Smooth", label: strings.t(M.smooth) },
  { value: "ChiselHard", label: strings.t(M.chiselHard) },
  { value: "ChiselSoft", label: strings.t(M.chiselSoft) },
];

const bevelDirections = (strings: Strings) => [
  { value: "Up", label: strings.t(M.up) },
  { value: "Down", label: strings.t(M.down) },
];

const innerGlowSources = (strings: Strings) => [
  { value: "EdgeGlow", label: strings.t(M.edge) },
  { value: "CenterGlow", label: strings.t(M.center) },
];

const featherCorners = (strings: Strings) => [
  { value: "Sharp", label: strings.t(M.sharp) },
  { value: "Rounded", label: strings.t(M.rounded) },
  { value: "Diffusion", label: strings.t(M.diffusion) },
];

/** Element-scope selection-property binding for a frame effect path.
 *  Typed against `PropertyPath` so a mistyped path is a tsc error
 *  (every label is verified against the protocol union). */
function bind(path: PropertyPath) {
  return {
    value: {
      kind: "selectionProperty" as const,
      scope: "element" as const,
      path,
    },
  };
}

// ADR 323 — every live field is a schema-driven `PropertyField` (type
// from the schema row, reads/writes through `host.objects`, "Bind to
// data…" + badge); `section` migrates each family's fields.
function section(title: string, children: CompositionNode[]): CompositionNode {
  return asPropertyFields({
    catalogId: PAGED_LAYOUT_SECTION,
    props: { title, heading: false },
    bindings: {},
    children,
  });
}

// ── Drop shadow ────────────────────────────────────────────────
// Kept on the legacy per-field `frameDropShadow*` arms; the enable
// pill (in effects-panel) writes the `frameDropShadow` bool. Laid out
// as InDesign's Drop Shadow dialog: blending, position, options.
export function dropShadowComposition(strings: Strings): CompositionNode {
  return section(strings.t(M.dropShadow), [
    {
      catalogId: PAGED_INPUT_SELECT,
      props: {
        label: strings.t(M.mode),
        options: [
          { value: "Drop", label: strings.t(M.drop) },
          { value: "Inner", label: strings.t(M.inner) },
        ],
      },
      bindings: bind("frameDropShadowMode"),
    },
    {
      catalogId: PAGED_INPUT_SELECT,
      props: { label: strings.t(M.blend), options: blendModes(strings) },
      bindings: bind("frameDropShadowBlendMode"),
    },
    {
      catalogId: PAGED_INPUT_COLOR_SWATCH,
      props: { label: strings.t(M.color) },
      bindings: bind("frameDropShadowColor"),
    },
    {
      catalogId: PAGED_INPUT_NUMERIC_SCRUB,
      props: { label: strings.t(M.opacity), suffix: "%" },
      bindings: bind("frameDropShadowOpacity"),
    },
    {
      catalogId: PAGED_LAYOUT_CLUSTER,
      props: { count: 2 },
      bindings: {},
      children: [
        {
          catalogId: PAGED_INPUT_LENGTH,
          props: { prefix: "X", showUnit: false },
          bindings: bind("frameDropShadowXOffset"),
        },
        {
          catalogId: PAGED_INPUT_LENGTH,
          props: { prefix: "Y", showUnit: false },
          bindings: bind("frameDropShadowYOffset"),
        },
      ],
    },
    {
      catalogId: PAGED_INPUT_TOGGLE_SWITCH,
      props: { label: strings.t(M.useGlobalLight) },
      bindings: bind("frameDropShadowUseGlobalLight"),
    },
    {
      catalogId: PAGED_LAYOUT_CLUSTER,
      props: { count: 2 },
      bindings: {},
      children: [
        {
          catalogId: PAGED_INPUT_LENGTH,
          props: { prefix: strings.t(M.blur), showUnit: false },
          bindings: bind("frameDropShadowSize"),
        },
        {
          catalogId: PAGED_INPUT_NUMERIC_SCRUB,
          props: { prefix: strings.t(M.spread), suffix: "%" },
          bindings: bind("frameDropShadowSpread"),
        },
      ],
    },
    {
      catalogId: PAGED_INPUT_NUMERIC_SCRUB,
      props: { label: strings.t(M.noise), suffix: "%" },
      bindings: bind("frameDropShadowNoise"),
    },
    {
      catalogId: PAGED_INPUT_TOGGLE_SWITCH,
      props: { label: strings.t(M.objectKnocksOutShadow) },
      bindings: bind("frameDropShadowKnockedOut"),
    },
  ]);
}

// ── Inner shadow ───────────────────────────────────────────────
export function innerShadowComposition(strings: Strings): CompositionNode {
  return section(strings.t(M.innerShadow), [
    {
      catalogId: PAGED_INPUT_SELECT,
      props: { label: strings.t(M.blend), options: blendModes(strings) },
      bindings: bind("frameInnerShadowBlendMode"),
    },
    {
      catalogId: PAGED_INPUT_COLOR_SWATCH,
      props: { label: strings.t(M.color) },
      bindings: bind("frameInnerShadowColor"),
    },
    {
      catalogId: PAGED_INPUT_NUMERIC_SCRUB,
      props: { label: strings.t(M.opacity), suffix: "%" },
      bindings: bind("frameInnerShadowOpacity"),
    },
    {
      catalogId: PAGED_LAYOUT_CLUSTER,
      props: { count: 2 },
      bindings: {},
      children: [
        {
          catalogId: PAGED_INPUT_NUMERIC_SCRUB,
          props: { prefix: strings.t(M.angle), suffix: "°" },
          bindings: bind("frameInnerShadowAngle"),
        },
        {
          catalogId: PAGED_INPUT_LENGTH,
          props: { prefix: strings.t(M.dist), showUnit: false },
          bindings: bind("frameInnerShadowDistance"),
        },
      ],
    },
    {
      catalogId: PAGED_LAYOUT_CLUSTER,
      props: { count: 2 },
      bindings: {},
      children: [
        {
          catalogId: PAGED_INPUT_LENGTH,
          props: { prefix: strings.t(M.size), showUnit: false },
          bindings: bind("frameInnerShadowSize"),
        },
        {
          catalogId: PAGED_INPUT_NUMERIC_SCRUB,
          props: { prefix: strings.t(M.choke), suffix: "%" },
          bindings: bind("frameInnerShadowChoke"),
        },
      ],
    },
    {
      catalogId: PAGED_INPUT_NUMERIC_SCRUB,
      props: { label: strings.t(M.noise), suffix: "%" },
      bindings: bind("frameInnerShadowNoise"),
    },
  ]);
}

// ── Outer glow ─────────────────────────────────────────────────
export function outerGlowComposition(strings: Strings): CompositionNode {
  return section(strings.t(M.outerGlow), [
    {
      catalogId: PAGED_INPUT_SELECT,
      props: { label: strings.t(M.blend), options: blendModes(strings) },
      bindings: bind("frameOuterGlowBlendMode"),
    },
    {
      catalogId: PAGED_INPUT_COLOR_SWATCH,
      props: { label: strings.t(M.color) },
      bindings: bind("frameOuterGlowColor"),
    },
    {
      catalogId: PAGED_INPUT_NUMERIC_SCRUB,
      props: { label: strings.t(M.opacity), suffix: "%" },
      bindings: bind("frameOuterGlowOpacity"),
    },
    {
      catalogId: PAGED_LAYOUT_CLUSTER,
      props: { count: 2 },
      bindings: {},
      children: [
        {
          catalogId: PAGED_INPUT_NUMERIC_SCRUB,
          props: { prefix: strings.t(M.spread), suffix: "%" },
          bindings: bind("frameOuterGlowSpread"),
        },
        {
          catalogId: PAGED_INPUT_LENGTH,
          props: { prefix: strings.t(M.size), showUnit: false },
          bindings: bind("frameOuterGlowSize"),
        },
      ],
    },
    {
      catalogId: PAGED_INPUT_NUMERIC_SCRUB,
      props: { label: strings.t(M.noise), suffix: "%" },
      bindings: bind("frameOuterGlowNoise"),
    },
  ]);
}

// ── Inner glow ─────────────────────────────────────────────────
export function innerGlowComposition(strings: Strings): CompositionNode {
  return section(strings.t(M.innerGlow), [
    {
      catalogId: PAGED_INPUT_SELECT,
      props: { label: strings.t(M.blend), options: blendModes(strings) },
      bindings: bind("frameInnerGlowBlendMode"),
    },
    {
      catalogId: PAGED_INPUT_COLOR_SWATCH,
      props: { label: strings.t(M.color) },
      bindings: bind("frameInnerGlowColor"),
    },
    {
      catalogId: PAGED_INPUT_SELECT,
      props: { label: strings.t(M.source), options: innerGlowSources(strings) },
      bindings: bind("frameInnerGlowSource"),
    },
    {
      catalogId: PAGED_INPUT_NUMERIC_SCRUB,
      props: { label: strings.t(M.opacity), suffix: "%" },
      bindings: bind("frameInnerGlowOpacity"),
    },
    {
      catalogId: PAGED_LAYOUT_CLUSTER,
      props: { count: 2 },
      bindings: {},
      children: [
        {
          catalogId: PAGED_INPUT_NUMERIC_SCRUB,
          props: { prefix: strings.t(M.choke), suffix: "%" },
          bindings: bind("frameInnerGlowChoke"),
        },
        {
          catalogId: PAGED_INPUT_LENGTH,
          props: { prefix: strings.t(M.size), showUnit: false },
          bindings: bind("frameInnerGlowSize"),
        },
      ],
    },
    {
      catalogId: PAGED_INPUT_NUMERIC_SCRUB,
      props: { label: strings.t(M.noise), suffix: "%" },
      bindings: bind("frameInnerGlowNoise"),
    },
  ]);
}

// ── Bevel & emboss ─────────────────────────────────────────────
export function bevelComposition(strings: Strings): CompositionNode {
  return section(strings.t(M.bevelAndEmboss), [
    {
      catalogId: PAGED_INPUT_SELECT,
      props: { label: strings.t(M.style), options: bevelStyles(strings) },
      bindings: bind("frameBevelStyle"),
    },
    {
      catalogId: PAGED_INPUT_SELECT,
      props: {
        label: strings.t(M.technique),
        options: bevelTechniques(strings),
      },
      bindings: bind("frameBevelTechnique"),
    },
    {
      catalogId: PAGED_INPUT_SELECT,
      props: {
        label: strings.t(M.direction),
        options: bevelDirections(strings),
      },
      bindings: bind("frameBevelDirection"),
    },
    {
      catalogId: PAGED_LAYOUT_CLUSTER,
      props: { count: 2 },
      bindings: {},
      children: [
        {
          catalogId: PAGED_INPUT_NUMERIC_SCRUB,
          props: { prefix: strings.t(M.depth), suffix: "%" },
          bindings: bind("frameBevelDepth"),
        },
        {
          catalogId: PAGED_INPUT_LENGTH,
          props: { prefix: strings.t(M.size), showUnit: false },
          bindings: bind("frameBevelSize"),
        },
      ],
    },
    {
      catalogId: PAGED_LAYOUT_CLUSTER,
      props: { count: 2 },
      bindings: {},
      children: [
        {
          catalogId: PAGED_INPUT_LENGTH,
          props: { prefix: strings.t(M.soften), showUnit: false },
          bindings: bind("frameBevelSoften"),
        },
        {
          catalogId: PAGED_INPUT_NUMERIC_SCRUB,
          props: { prefix: strings.t(M.angle), suffix: "°" },
          bindings: bind("frameBevelAngle"),
        },
      ],
    },
    {
      catalogId: PAGED_INPUT_NUMERIC_SCRUB,
      props: { label: strings.t(M.altitude), suffix: "°" },
      bindings: bind("frameBevelAltitude"),
    },
    {
      catalogId: PAGED_INPUT_COLOR_SWATCH,
      props: { label: strings.t(M.highlight) },
      bindings: bind("frameBevelHighlightColor"),
    },
    {
      catalogId: PAGED_INPUT_NUMERIC_SCRUB,
      props: { label: strings.t(M.hOpacity), suffix: "%" },
      bindings: bind("frameBevelHighlightOpacity"),
    },
    {
      catalogId: PAGED_INPUT_COLOR_SWATCH,
      props: { label: strings.t(M.shadow) },
      bindings: bind("frameBevelShadowColor"),
    },
    {
      catalogId: PAGED_INPUT_NUMERIC_SCRUB,
      props: { label: strings.t(M.sOpacity), suffix: "%" },
      bindings: bind("frameBevelShadowOpacity"),
    },
  ]);
}

// ── Satin ──────────────────────────────────────────────────────
export function satinComposition(strings: Strings): CompositionNode {
  return section(strings.t(M.satin), [
    {
      catalogId: PAGED_INPUT_SELECT,
      props: { label: strings.t(M.blend), options: blendModes(strings) },
      bindings: bind("frameSatinBlendMode"),
    },
    {
      catalogId: PAGED_INPUT_COLOR_SWATCH,
      props: { label: strings.t(M.color) },
      bindings: bind("frameSatinColor"),
    },
    {
      catalogId: PAGED_INPUT_NUMERIC_SCRUB,
      props: { label: strings.t(M.opacity), suffix: "%" },
      bindings: bind("frameSatinOpacity"),
    },
    {
      catalogId: PAGED_LAYOUT_CLUSTER,
      props: { count: 2 },
      bindings: {},
      children: [
        {
          catalogId: PAGED_INPUT_NUMERIC_SCRUB,
          props: { prefix: strings.t(M.angle), suffix: "°" },
          bindings: bind("frameSatinAngle"),
        },
        {
          catalogId: PAGED_INPUT_LENGTH,
          props: { prefix: strings.t(M.dist), showUnit: false },
          bindings: bind("frameSatinDistance"),
        },
      ],
    },
    {
      catalogId: PAGED_INPUT_LENGTH,
      props: { label: strings.t(M.size), showUnit: false },
      bindings: bind("frameSatinSize"),
    },
    {
      catalogId: PAGED_INPUT_TOGGLE_SWITCH,
      props: { label: strings.t(M.invert) },
      bindings: bind("frameSatinInvert"),
    },
  ]);
}

// ── Feather (basic) ────────────────────────────────────────────
export function featherComposition(strings: Strings): CompositionNode {
  return section(strings.t(M.feather), [
    {
      catalogId: PAGED_INPUT_LENGTH,
      props: { label: strings.t(M.width), showUnit: false },
      bindings: bind("frameFeatherWidth"),
    },
    {
      catalogId: PAGED_INPUT_SELECT,
      props: { label: strings.t(M.corner), options: featherCorners(strings) },
      bindings: bind("frameFeatherCornerType"),
    },
    {
      catalogId: PAGED_LAYOUT_CLUSTER,
      props: { count: 2 },
      bindings: {},
      children: [
        {
          catalogId: PAGED_INPUT_NUMERIC_SCRUB,
          props: { prefix: strings.t(M.noise), suffix: "%" },
          bindings: bind("frameFeatherNoise"),
        },
        {
          catalogId: PAGED_INPUT_NUMERIC_SCRUB,
          props: { prefix: strings.t(M.choke), suffix: "%" },
          bindings: bind("frameFeatherChoke"),
        },
      ],
    },
  ]);
}

// ── Directional feather ────────────────────────────────────────
export function directionalFeatherComposition(
  strings: Strings,
): CompositionNode {
  return section(strings.t(M.directionalFeather), [
    {
      catalogId: PAGED_LAYOUT_CLUSTER,
      props: { count: 2 },
      bindings: {},
      children: [
        {
          catalogId: PAGED_INPUT_LENGTH,
          props: { prefix: strings.t(M.left), showUnit: false },
          bindings: bind("frameDirectionalFeatherLeftWidth"),
        },
        {
          catalogId: PAGED_INPUT_LENGTH,
          props: { prefix: strings.t(M.right), showUnit: false },
          bindings: bind("frameDirectionalFeatherRightWidth"),
        },
      ],
    },
    {
      catalogId: PAGED_LAYOUT_CLUSTER,
      props: { count: 2 },
      bindings: {},
      children: [
        {
          catalogId: PAGED_INPUT_LENGTH,
          props: { prefix: strings.t(M.top), showUnit: false },
          bindings: bind("frameDirectionalFeatherTopWidth"),
        },
        {
          catalogId: PAGED_INPUT_LENGTH,
          props: { prefix: strings.t(M.bottom), showUnit: false },
          bindings: bind("frameDirectionalFeatherBottomWidth"),
        },
      ],
    },
    {
      catalogId: PAGED_INPUT_NUMERIC_SCRUB,
      props: { label: strings.t(M.angle), suffix: "°" },
      bindings: bind("frameDirectionalFeatherAngle"),
    },
    {
      catalogId: PAGED_LAYOUT_CLUSTER,
      props: { count: 2 },
      bindings: {},
      children: [
        {
          catalogId: PAGED_INPUT_NUMERIC_SCRUB,
          props: { prefix: strings.t(M.noise), suffix: "%" },
          bindings: bind("frameDirectionalFeatherNoise"),
        },
        {
          catalogId: PAGED_INPUT_NUMERIC_SCRUB,
          props: { prefix: strings.t(M.choke), suffix: "%" },
          bindings: bind("frameDirectionalFeatherChoke"),
        },
      ],
    },
  ]);
}
