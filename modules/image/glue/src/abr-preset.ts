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

// An `.abr` preset → this engine's brush. The reader's JSON
// (`abr_presets`, image-js/src/brushes.rs) carries every parsed field;
// this maps each onto `BrushParams` + `BrushDynamics` and reports, by
// name, everything it could not apply — a designer who picks a bristle
// brush and gets a round one should be told, not left to guess.
//
// Units: the reader already turned percents into fractions, angles into
// degrees and counts into numbers. The only conversions left are the
// ones between two vocabularies (a blend mode's long-form name → a
// `compose.*` wire name, a control's name → `BrushControl`).

import { defineMessages, t } from "@paged-media/strings";

import {
  BRUSH_CONTROLS,
  COMBINE_MODES,
  type BrushControl,
  type BrushDynamics,
  type CombineMode,
  type DynamicsPatch,
  type JitterSetting,
  type TipBitmap,
} from "./brush-dynamics";
import type { BrushParams, BrushPresetInfo } from "./engine";

/** One dynamic as the reader projects it. */
export interface AbrDynamicJson {
  control: number;
  controlName: string;
  fade: number;
  jitter: number;
  minimum: number | null;
}

type D = AbrDynamicJson | null;

/** The nested `dynamics` object of a preset row (every group `null`
 *  when the file's gate switched it off). */
export interface AbrDynamicsJson {
  tip: { flipX: boolean | null; flipY: boolean | null };
  shape: {
    size: D;
    angle: D;
    roundness: D;
    minimumDiameter: number | null;
    minimumRoundness: number | null;
    tiltScale: number | null;
    flipXJitter: boolean | null;
    flipYJitter: boolean | null;
    projection: boolean | null;
  } | null;
  scatter: {
    scatter: D;
    count: number | null;
    countJitter: D;
    bothAxes: boolean | null;
  } | null;
  texture: {
    patternId: string | null;
    patternName: string | null;
    mode: string | null;
    scale: number | null;
    depth: number | null;
    minimumDepth: number | null;
    depthJitter: D;
    invert: boolean | null;
    brightness: number | null;
    contrast: number | null;
    eachTip: boolean | null;
  } | null;
  dual: {
    enabled: boolean;
    kind: string | null;
    diameter: number | null;
    diameterUnit: string | null;
    roundness: number | null;
    hardness: number | null;
    tipSpacing: number | null;
    angle: number | null;
    sampleIndex: number | null;
    flip: boolean | null;
    mode: string | null;
    useScatter: boolean | null;
    spacing: number | null;
    count: number | null;
    bothAxes: boolean | null;
    countJitter: D;
    scatter: D;
  } | null;
  color: {
    fgBg: D;
    hue: number | null;
    saturation: number | null;
    brightness: number | null;
    purity: number | null;
    perTip: boolean | null;
  } | null;
  transfer: { flow: D; opacity: D; wetness: D; mix: D } | null;
  pose: {
    overrideAngle: boolean | null;
    overrideTiltX: boolean | null;
    overrideTiltY: boolean | null;
    overridePressure: boolean | null;
    pressure: number | null;
    tiltX: number | null;
    tiltY: number | null;
    angle: number | null;
  } | null;
  wetEdges: boolean | null;
  noise: boolean | null;
  buildUp: boolean | null;
  protectTexture: boolean | null;
  pressureOverridesSize: boolean | null;
  pressureOverridesOpacity: boolean | null;
  smoothing: {
    enabled: boolean | null;
    amount: number | null;
    radiusMode: boolean | null;
    catchUp: boolean | null;
    catchUpAtEnd: boolean | null;
    zoomCompensation: boolean | null;
    pressureSmoothing: boolean | null;
    source: string;
  } | null;
  toolOptions: {
    kind: string;
    classId: string;
    flow: number;
    opacity: number;
    blend: string;
  } | null;
}

/** A preset row with the fields the reader added for the brush engine:
 *  the sampled tip's index (what `abr_tip` takes) and every dynamics
 *  group. Both are absent on a row from an older engine. */
export interface AbrPresetInfo extends BrushPresetInfo {
  sampleIndex?: number | null;
  dynamics?: AbrDynamicsJson | null;
}

const M = defineMessages("image.abrPreset", {
  diameterIn: "diameter in {unit}",
  unknownUnit: "an unknown unit",
  tipKind: "the {kind} tip — painted as a round tip",
  noBitmap: "the sampled tip's bitmap — not available",
  texturePattern:
    "the texture's pattern “{name}” (the image's defined pattern is used)",
  textureMode: "texture mode {mode}",
  dualTip: "the dual tip's {kind} shape — painted as a round tip",
  dualMode: "dual brush mode {mode}",
  dualDiameter: "the dual tip's diameter in {unit}",
  mixerDynamics: "wetness and mix dynamics (mixer brush)",
  toolKind: "the {kind} tool options",
  blend: "blend mode {mode}",
  control: "control {name}",
});

/** The mapping's result. */
export interface AbrBrushMapping {
  params: Partial<BrushParams>;
  dynamics: DynamicsPatch;
  /** What the preset carries and this engine cannot apply, in words. */
  unapplied: string[];
}

const COMBINE_BY_NAME: Record<string, CombineMode> = {
  multiply: "multiply",
  subtractionTexture: "subtract",
  blendSubtraction: "subtract",
  darken: "darken",
  overlay: "overlay",
  colorDodge: "colorDodge",
  colorBurn: "colorBurn",
  linearBurn: "linearBurn",
  hardMix: "hardMix",
  linearHeight: "linearHeight",
  height: "height",
};

/** A long-form blend name (`colorBurn`) → the `compose.*` wire name
 *  (`color_burn`), or null when the engine has no such stroke blend. */
export function composeBlendOf(name: string): string | null {
  if (name === "blendSubtraction") return "subtract";
  if (name === "blendDivide") return "divide";
  if (name === "dissolve" || COMBINE_BY_NAME[name] === "height") return null;
  if (name === "linearHeight" || name === "subtractionTexture") return null;
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function combine(
  name: string | null,
  unapplied: string[],
  label: (mode: string) => string,
): CombineMode | undefined {
  if (name === null) return undefined;
  const m = COMBINE_BY_NAME[name];
  if (m && COMBINE_MODES.includes(m)) return m;
  unapplied.push(label(name));
  return undefined;
}

function jitterOf(d: D, unapplied: string[]): JitterSetting | undefined {
  if (!d) return undefined;
  let control: BrushControl = "off";
  if ((BRUSH_CONTROLS as readonly string[]).includes(d.controlName)) {
    control = d.controlName as BrushControl;
  } else {
    unapplied.push(t(M.control, { name: d.controlName }));
  }
  return {
    jitter: Number.isFinite(d.jitter) ? d.jitter : 0,
    control,
    fadeSteps: Math.max(1, Math.round(d.fade || 25)),
    minimum: d.minimum ?? 0,
  };
}

const num = (v: number | null | undefined, fallback: number) =>
  v === null || v === undefined || !Number.isFinite(v) ? fallback : v;

/** Map a preset onto the brush. `bitmap` is its sampled tip (fetched
 *  with `abr_tip` by `sampleIndex`), `dualBitmap` the dual tip's. */
export function abrToBrush(
  info: AbrPresetInfo,
  bitmap: TipBitmap | null,
  dualBitmap: TipBitmap | null = null,
): AbrBrushMapping {
  const params: Partial<BrushParams> = {};
  const dynamics: DynamicsPatch = {};
  const unapplied: string[] = [];
  const d = info.dynamics ?? null;

  // ── tip shape ──
  if (info.diameter !== null && info.diameterUnit === "#Pxl") {
    params.size = Math.max(1, Math.round(info.diameter));
  } else if (info.diameter !== null) {
    unapplied.push(
      t(M.diameterIn, { unit: info.diameterUnit ?? t(M.unknownUnit) }),
    );
  }
  if (info.hardness !== null) {
    params.hardness = Math.min(1, Math.max(0, info.hardness));
  }
  if (info.spacing !== null) params.spacing = Math.max(0.01, info.spacing);
  const tip: NonNullable<DynamicsPatch["tip"]> = {};
  if (info.spacingEnabled !== null) tip.spacingEnabled = info.spacingEnabled;
  if (info.angle !== null) tip.angle = info.angle;
  if (info.roundness !== null) {
    tip.roundness = Math.min(1, Math.max(0.01, info.roundness));
  }
  if (d?.tip.flipX !== null && d?.tip.flipX !== undefined)
    tip.flipX = d.tip.flipX;
  if (d?.tip.flipY !== null && d?.tip.flipY !== undefined)
    tip.flipY = d.tip.flipY;
  dynamics.tip = tip;
  if (info.kind === "sampled") {
    if (bitmap) dynamics.bitmap = bitmap;
    else {
      dynamics.bitmap = null;
      unapplied.push(t(M.noBitmap));
    }
  } else {
    dynamics.bitmap = null;
    if (info.kind !== "computed") {
      unapplied.push(t(M.tipKind, { kind: info.kind }));
    }
  }
  if (!d) return { params, dynamics, unapplied };

  // ── shape dynamics ──
  if (d.shape) {
    const s = d.shape;
    const size = jitterOf(s.size, unapplied);
    const angle = jitterOf(s.angle, unapplied);
    const roundness = jitterOf(s.roundness, unapplied);
    dynamics.shape = {
      enabled: true,
      ...(size ? { size } : {}),
      ...(angle ? { angle } : {}),
      ...(roundness ? { roundness } : {}),
      minDiameter: num(s.minimumDiameter, size?.minimum ?? 0),
      tiltScale: num(s.tiltScale, 1),
      minRoundness: num(s.minimumRoundness, 0.25),
      flipXJitter: s.flipXJitter ?? false,
      flipYJitter: s.flipYJitter ?? false,
      projection: s.projection ?? false,
    };
  } else dynamics.shape = { enabled: false };

  // ── scattering ──
  if (d.scatter) {
    const s = d.scatter;
    const amount = jitterOf(s.scatter, unapplied);
    const countJitter = jitterOf(s.countJitter, unapplied);
    dynamics.scatter = {
      enabled: true,
      ...(amount ? { amount } : {}),
      ...(countJitter ? { countJitter } : {}),
      count: Math.max(1, Math.round(num(s.count, 1))),
      bothAxes: s.bothAxes ?? false,
    };
  } else dynamics.scatter = { enabled: false };

  // ── texture ──
  if (d.texture) {
    const x = d.texture;
    const mode = combine(x.mode, unapplied, (m) =>
      t(M.textureMode, { mode: m }),
    );
    const depthJitter = jitterOf(x.depthJitter, unapplied);
    if (x.patternId !== null || x.patternName !== null) {
      unapplied.push(
        t(M.texturePattern, { name: x.patternName ?? x.patternId ?? "" }),
      );
    }
    dynamics.texture = {
      enabled: true,
      ...(mode ? { mode } : {}),
      ...(depthJitter ? { depthJitter } : {}),
      scale: num(x.scale, 1),
      depth: num(x.depth, 1),
      minDepth: num(x.minimumDepth, 0),
      invert: x.invert ?? false,
      brightness: num(x.brightness, 0),
      contrast: num(x.contrast, 0),
      eachTip: x.eachTip ?? true,
    };
  } else dynamics.texture = { enabled: false };

  // ── dual brush ──
  if (d.dual && d.dual.enabled) {
    const x = d.dual;
    const mode = combine(x.mode, unapplied, (m) => t(M.dualMode, { mode: m }));
    const patch: NonNullable<DynamicsPatch["dual"]> = {
      enabled: true,
      ...(mode ? { mode } : {}),
      spacing: Math.max(0.01, num(x.spacing ?? x.tipSpacing, 0.25)),
      scatter: num(x.scatter?.jitter, 0),
      bothAxes: x.bothAxes ?? false,
      count: Math.max(1, Math.round(num(x.count, 1))),
      roundness: Math.min(1, Math.max(0.01, num(x.roundness, 1))),
      flip: x.flip ?? false,
      bitmap: null,
    };
    if (x.diameter !== null && x.diameterUnit === "#Pxl") {
      patch.diameter = Math.max(1, Math.round(x.diameter));
    } else if (x.diameter !== null) {
      unapplied.push(
        t(M.dualDiameter, { unit: x.diameterUnit ?? t(M.unknownUnit) }),
      );
    }
    if (x.kind === "sampled") {
      if (dualBitmap) patch.bitmap = dualBitmap;
      else unapplied.push(t(M.dualTip, { kind: x.kind }));
    } else if (x.kind !== null && x.kind !== "computed") {
      unapplied.push(t(M.dualTip, { kind: x.kind }));
    }
    dynamics.dual = patch;
  } else dynamics.dual = { enabled: false, bitmap: null };

  // ── colour dynamics ──
  if (d.color) {
    const c = d.color;
    const fgBg = jitterOf(c.fgBg, unapplied);
    dynamics.color = {
      enabled: true,
      ...(fgBg ? { fgBg } : {}),
      hue: num(c.hue, 0),
      saturation: num(c.saturation, 0),
      brightness: num(c.brightness, 0),
      purity: num(c.purity, 0),
      perTip: c.perTip ?? true,
    };
  } else dynamics.color = { enabled: false };

  // ── transfer ──
  if (d.transfer) {
    const x = d.transfer;
    const opacity = jitterOf(x.opacity, unapplied);
    const flow = jitterOf(x.flow, unapplied);
    if (x.wetness || x.mix) unapplied.push(t(M.mixerDynamics));
    dynamics.transfer = {
      enabled: true,
      ...(opacity ? { opacity } : {}),
      ...(flow ? { flow } : {}),
    };
  } else dynamics.transfer = { enabled: false };

  // ── brush pose ──
  if (d.pose) {
    const p = d.pose;
    dynamics.pose = {
      enabled: true,
      tiltX: num(p.tiltX, 0),
      tiltY: num(p.tiltY, 0),
      rotation: num(p.angle, 0),
      pressure: num(p.pressure, 1),
      overrideTilt: !!(p.overrideTiltX || p.overrideTiltY),
      overrideRotation: !!p.overrideAngle,
      overridePressure: !!p.overridePressure,
    };
  } else dynamics.pose = { enabled: false };

  // ── the brush-level toggles (null = the file does not say: untouched) ──
  if (d.wetEdges !== null) dynamics.wetEdges = d.wetEdges;
  if (d.noise !== null) dynamics.noise = d.noise;
  if (d.buildUp !== null) dynamics.buildUp = d.buildUp;
  if (d.protectTexture !== null) dynamics.protectTexture = d.protectTexture;
  if (d.smoothing) {
    const s = d.smoothing;
    dynamics.smoothing = {
      amount: s.enabled === false ? 0 : num(s.amount, 0),
      ...(s.catchUp !== null ? { catchUp: s.catchUp } : {}),
      ...(s.catchUpAtEnd !== null ? { catchUpEnd: s.catchUpAtEnd } : {}),
      ...(s.zoomCompensation !== null
        ? { zoomCompensation: s.zoomCompensation }
        : {}),
    };
  }

  // ── tool options ──
  if (d.toolOptions) {
    const o = d.toolOptions;
    if (o.kind !== "brush") unapplied.push(t(M.toolKind, { kind: o.kind }));
    params.opacity = Math.min(1, Math.max(0, o.opacity));
    params.flow = Math.min(1, Math.max(0, o.flow));
    const blend = composeBlendOf(o.blend);
    if (blend) params.blend = blend;
    else unapplied.push(t(M.blend, { mode: o.blend }));
  }
  return { params, dynamics, unapplied };
}

// ── export: a preset → the values `abr_export_add` takes ─────────────

/** What an exported preset needs: its five tip/stroke numbers and its
 *  dynamics (structurally a `UserBrushPreset`, brush-presets.ts). */
export interface ExportablePreset {
  name: string;
  params: Pick<
    BrushParams,
    "size" | "hardness" | "spacing" | "opacity" | "flow"
  >;
  dynamics: BrushDynamics;
}

const on = (v: boolean) => (v ? 1 : 0);
const ordinal = <T>(list: readonly T[], v: T) => Math.max(0, list.indexOf(v));

function jitterValues(
  prefix: string,
  j: JitterSetting,
): Array<[string, number]> {
  return [
    [`${prefix}.jitter`, j.jitter],
    [`${prefix}.control`, ordinal(BRUSH_CONTROLS, j.control)],
    [`${prefix}.fade`, j.fadeSteps],
    [`${prefix}.min`, j.minimum],
  ];
}

/** Every export key this glue can fill, by name (the engine's list is
 *  `abr_export_keys`; brushes.rs `EXPORT_KEYS`). */
export function exportFields(p: ExportablePreset): Map<string, number> {
  const d = p.dynamics;
  return new Map<string, number>([
    ["diameter", p.params.size],
    ["hardness", p.params.hardness],
    ["spacing", p.params.spacing],
    ["opacity", p.params.opacity],
    ["flow", p.params.flow],
    ["tip.angle", d.tip.angle],
    ["tip.roundness", d.tip.roundness],
    ["tip.flipX", on(d.tip.flipX)],
    ["tip.flipY", on(d.tip.flipY)],
    ["tip.spacingEnabled", on(d.tip.spacingEnabled)],
    ["shape.enabled", on(d.shape.enabled)],
    ...jitterValues("shape.size", d.shape.size),
    ["shape.minDiameter", d.shape.minDiameter],
    ["shape.tiltScale", d.shape.tiltScale],
    ...jitterValues("shape.angle", d.shape.angle),
    ...jitterValues("shape.roundness", d.shape.roundness),
    ["shape.minRoundness", d.shape.minRoundness],
    ["shape.flipXJitter", on(d.shape.flipXJitter)],
    ["shape.flipYJitter", on(d.shape.flipYJitter)],
    ["shape.projection", on(d.shape.projection)],
    ["scatter.enabled", on(d.scatter.enabled)],
    ...jitterValues("scatter.amount", d.scatter.amount),
    ["scatter.bothAxes", on(d.scatter.bothAxes)],
    ["scatter.count", d.scatter.count],
    ...jitterValues("scatter.countJitter", d.scatter.countJitter),
    ["dual.enabled", on(d.dual.enabled)],
    ["dual.mode", ordinal(COMBINE_MODES, d.dual.mode)],
    ["dual.diameter", d.dual.diameter],
    ["dual.spacing", d.dual.spacing],
    ["dual.scatter", d.dual.scatter],
    ["dual.bothAxes", on(d.dual.bothAxes)],
    ["dual.count", d.dual.count],
    ["dual.roundness", d.dual.roundness],
    ["dual.flip", on(d.dual.flip)],
    ["color.enabled", on(d.color.enabled)],
    ...jitterValues("color.fgBg", d.color.fgBg),
    ["color.hue", d.color.hue],
    ["color.saturation", d.color.saturation],
    ["color.brightness", d.color.brightness],
    ["color.purity", d.color.purity],
    ["color.perTip", on(d.color.perTip)],
    ["transfer.enabled", on(d.transfer.enabled)],
    ...jitterValues("transfer.opacity", d.transfer.opacity),
    ...jitterValues("transfer.flow", d.transfer.flow),
    ["pose.enabled", on(d.pose.enabled)],
    ["pose.tiltX", d.pose.tiltX],
    ["pose.tiltY", d.pose.tiltY],
    ["pose.rotation", d.pose.rotation],
    ["pose.pressure", d.pose.pressure],
    ["pose.overrideTilt", on(d.pose.overrideTilt)],
    ["pose.overrideRotation", on(d.pose.overrideRotation)],
    ["pose.overridePressure", on(d.pose.overridePressure)],
    ["noise", on(d.noise)],
    ["wetEdges", on(d.wetEdges)],
    ["buildUp", on(d.buildUp)],
    ["smoothing.amount", d.smoothing.amount],
    ["smoothing.catchUp", on(d.smoothing.catchUp)],
    ["smoothing.catchUpEnd", on(d.smoothing.catchUpEnd)],
    ["smoothing.zoomCompensation", on(d.smoothing.zoomCompensation)],
    ["protectTexture", on(d.protectTexture)],
  ]);
}

/** Pack `p` in the engine's export-key order. `unknown` lists keys the
 *  engine asked for that this table cannot fill (sent as 0). */
export function packExportValues(
  keys: readonly string[],
  p: ExportablePreset,
): { values: Float32Array; unknown: string[] } {
  const fields = exportFields(p);
  const values = new Float32Array(keys.length);
  const unknown: string[] = [];
  keys.forEach((k, i) => {
    const v = fields.get(k);
    if (v === undefined) unknown.push(k);
    else values[i] = Number.isFinite(v) ? v : 0;
  });
  return { values, unknown };
}

/** Decode `abr_tip`'s `[w u32 LE, h u32 LE, alpha…]` into a bitmap. */
export function decodeTipBitmap(bytes: Uint8Array, id: string): TipBitmap {
  if (bytes.length < 8) throw new Error("abr_tip: short reply");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = v.getUint32(0, true);
  const height = v.getUint32(4, true);
  const alpha = bytes.slice(8);
  if (alpha.length !== width * height)
    throw new Error(`abr_tip: ${alpha.length} bytes for ${width}x${height}`);
  return { id, width, height, alpha };
}
