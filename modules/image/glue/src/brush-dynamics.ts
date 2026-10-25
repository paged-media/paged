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

// THE BRUSH ENGINE'S SETTINGS — every pane of Brush Settings, and the
// options of the tools that paint through the same stroke session
// (smudge, mixer, history, art history, background eraser, colour
// replacement), as one plain object the session holds and freezes into
// each stroke.
//
// THE WIRE IS BY NAME. The engine publishes its ordered key list
// (`brush_dynamics_keys`); `packDynamics` fills a Float32Array in THAT
// order from `DYNAMICS_FIELDS`, looking each key up by name. A key the
// engine knows and this table does not is sent as 0 and reported (the
// panel cannot set what it does not know about); a key this table knows
// and the engine does not is simply not sent. Neither side can silently
// shift every later field by one, which a positional layout would.

/** What drives a dynamic (Photoshop's "Control"). The order is the
 *  `.abr` `bVTy` table, so a preset's ordinal maps straight across. */
export type BrushControl =
  | "off"
  | "fade"
  | "pressure"
  | "tilt"
  | "wheel"
  | "initialDirection"
  | "direction"
  | "initialRotation"
  | "rotation";

export const BRUSH_CONTROLS: readonly BrushControl[] = [
  "off",
  "fade",
  "pressure",
  "tilt",
  "wheel",
  "initialDirection",
  "direction",
  "initialRotation",
  "rotation",
];

/** One dynamic: a random jitter (a fraction; scatter may exceed 1) plus
 *  a control that scales the value between `minimum` and 1. */
export interface JitterSetting {
  jitter: number;
  control: BrushControl;
  /** Fade length in dabs (only under `fade`). */
  fadeSteps: number;
  /** Floor of the controlled range, 0..1. */
  minimum: number;
}

/** How the texture or the dual tip combines with the primary tip. The
 *  order is the engine's (`brush_combine_modes`). */
export type CombineMode =
  | "multiply"
  | "subtract"
  | "darken"
  | "overlay"
  | "colorDodge"
  | "colorBurn"
  | "linearBurn"
  | "hardMix"
  | "linearHeight"
  | "height";

export const COMBINE_MODES: readonly CombineMode[] = [
  "multiply",
  "subtract",
  "darken",
  "overlay",
  "colorDodge",
  "colorBurn",
  "linearBurn",
  "hardMix",
  "linearHeight",
  "height",
];

/** Symmetry painting (Photoshop's butterfly menu). */
export type SymmetryKind =
  | "off"
  | "vertical"
  | "horizontal"
  | "dual"
  | "diagonal"
  | "wavy"
  | "circle"
  | "spiral"
  | "radial"
  | "mandala";

export const SYMMETRY_KINDS: readonly SymmetryKind[] = [
  "off",
  "vertical",
  "horizontal",
  "dual",
  "diagonal",
  "wavy",
  "circle",
  "spiral",
  "radial",
  "mandala",
];

/** Art History Brush stroke styles (Photoshop's list, in its order). */
export type ArtHistoryStyle =
  | "tightShort"
  | "tightMedium"
  | "tightLong"
  | "looseMedium"
  | "looseLong"
  | "dab"
  | "tightCurl"
  | "tightCurlLong"
  | "looseCurl"
  | "looseCurlLong";

export const ART_HISTORY_STYLES: readonly ArtHistoryStyle[] = [
  "tightShort",
  "tightMedium",
  "tightLong",
  "looseMedium",
  "looseLong",
  "dab",
  "tightCurl",
  "tightCurlLong",
  "looseCurl",
  "looseCurlLong",
];

/** Where the background eraser and the colour replacement tool take
 *  the colour they act on. */
export type SamplingMode = "continuous" | "once" | "swatch";
export const SAMPLING_MODES: readonly SamplingMode[] = [
  "continuous",
  "once",
  "swatch",
];

/** Which pixels under the tip they may touch. */
export type LimitsMode = "discontiguous" | "contiguous" | "findEdges";
export const LIMITS_MODES: readonly LimitsMode[] = [
  "discontiguous",
  "contiguous",
  "findEdges",
];

/** The colour replacement tool's blend. */
export type ColorReplaceMode = "hue" | "saturation" | "color" | "luminosity";
export const COLOR_REPLACE_MODES: readonly ColorReplaceMode[] = [
  "hue",
  "saturation",
  "color",
  "luminosity",
];

/** The History / Art History brushes' source state. Until history
 *  snapshots exist, the two states the journal can name: the image as
 *  it was opened, and the state before the newest edit of the layer. */
export type HistorySource = "open" | "previous";

/** A bitmap (sampled) tip, held by the session; `id` names it in the
 *  preset library. */
export interface TipBitmap {
  id: string;
  width: number;
  height: number;
  /** Coverage, row-major, 255 = paint. */
  alpha: Uint8Array;
}

export interface BrushDynamics {
  /** Brush Tip Shape (diameter, hardness and spacing are `BrushParams`). */
  tip: {
    /** Degrees, counter-clockwise on screen. */
    angle: number;
    /** Minor/major axis ratio, 0.01..1. */
    roundness: number;
    flipX: boolean;
    flipY: boolean;
    /** Off: Photoshop spaces dabs by pointer events instead. */
    spacingEnabled: boolean;
  };
  /** The sampled tip in use, or null for the round computed tip. */
  bitmap: TipBitmap | null;
  shape: {
    enabled: boolean;
    size: JitterSetting;
    /** The size control's floor (Photoshop's "Minimum Diameter"). */
    minDiameter: number;
    /** Pen tilt's influence on size under the tilt control, 0..2. */
    tiltScale: number;
    angle: JitterSetting;
    roundness: JitterSetting;
    minRoundness: number;
    flipXJitter: boolean;
    flipYJitter: boolean;
    /** Brush projection: tilt and rotation drive the tip's shape. */
    projection: boolean;
  };
  scatter: {
    enabled: boolean;
    /** Jitter = the scatter as a fraction of the diameter (1 = 100%). */
    amount: JitterSetting;
    bothAxes: boolean;
    /** Dabs per spacing interval, 1..16. */
    count: number;
    countJitter: JitterSetting;
  };
  texture: {
    enabled: boolean;
    /** Scale of the pattern, 0.01..10. */
    scale: number;
    /** −150..150. */
    brightness: number;
    /** −50..100. */
    contrast: number;
    mode: CombineMode;
    /** 0..1. */
    depth: number;
    minDepth: number;
    depthJitter: JitterSetting;
    invert: boolean;
    /** Apply per dab (depth varies) rather than to the whole stroke. */
    eachTip: boolean;
  };
  dual: {
    enabled: boolean;
    mode: CombineMode;
    /** px. */
    diameter: number;
    /** Fraction of the dual tip's diameter. */
    spacing: number;
    /** Fraction of its diameter. */
    scatter: number;
    bothAxes: boolean;
    count: number;
    roundness: number;
    flip: boolean;
    bitmap: TipBitmap | null;
  };
  color: {
    enabled: boolean;
    /** Foreground/background jitter (the jitter mixes toward the
     *  background colour). */
    fgBg: JitterSetting;
    /** 0..1 each. */
    hue: number;
    saturation: number;
    brightness: number;
    /** −1..1 — desaturates (−) or saturates (+) every dab. */
    purity: number;
    /** Jitter per dab (true) or once per stroke. */
    perTip: boolean;
  };
  transfer: {
    enabled: boolean;
    opacity: JitterSetting;
    flow: JitterSetting;
  };
  pose: {
    enabled: boolean;
    /** Degrees, −90..90. */
    tiltX: number;
    tiltY: number;
    /** Degrees, 0..360. */
    rotation: number;
    /** 0..1. */
    pressure: number;
    overrideTilt: boolean;
    overrideRotation: boolean;
    overridePressure: boolean;
  };
  noise: boolean;
  wetEdges: boolean;
  /** Airbrush: a held pointer keeps depositing. */
  buildUp: boolean;
  smoothing: {
    /** 0..1 — the pulled string's length, as a fraction of 128 screen px. */
    amount: number;
    /** Catch up while the pointer pauses. */
    catchUp: boolean;
    /** Finish the stroke at the pointer on release. */
    catchUpEnd: boolean;
    /** Measure the string in screen px (zoom-compensated). */
    zoomCompensation: boolean;
  };
  /** Keep this texture when switching between textured presets. */
  protectTexture: boolean;
  symmetry: {
    kind: SymmetryKind;
    /** Centre, as fractions of the canvas. */
    cx: number;
    cy: number;
    /** Axis angle, degrees. */
    angle: number;
    /** Radial / mandala / spiral segment count, 2..12. */
    segments: number;
  };
  /** Lock Transparent Pixels — every paint tool keeps the layer's alpha. */
  lockAlpha: boolean;
}

/** The paint options of the tools beyond the plain brush. */
export interface PaintToolOptions {
  smudge: { strength: number; fingerPainting: boolean; sampleAll: boolean };
  mixer: {
    wet: number;
    load: number;
    mix: number;
    flow: number;
    /** Load the brush with the foreground after each stroke. */
    loadAfter: boolean;
    /** Clean the brush after each stroke. */
    cleanAfter: boolean;
    sampleAll: boolean;
  };
  history: { source: HistorySource };
  artHistory: {
    style: ArtHistoryStyle;
    /** px. */
    area: number;
    /** 0..1 — paint only where the source differs by more than this. */
    tolerance: number;
    /** 0..1 — colour fidelity to the source. */
    fidelity: number;
  };
  backgroundEraser: {
    sampling: SamplingMode;
    limits: LimitsMode;
    /** 0..1. */
    tolerance: number;
    protectForeground: boolean;
  };
  colorReplace: {
    mode: ColorReplaceMode;
    sampling: SamplingMode;
    limits: LimitsMode;
    tolerance: number;
  };
  magicEraser: {
    /** 0..255, the wand's per-channel distance. */
    tolerance: number;
    antialias: boolean;
    contiguous: boolean;
    sampleAll: boolean;
    opacity: number;
  };
}

const jitter = (
  control: BrushControl = "off",
  value = 0,
  minimum = 0,
): JitterSetting => ({ jitter: value, control, fadeSteps: 25, minimum });

/** Every pane off: the brush the v0 engine painted. */
export const DEFAULT_BRUSH_DYNAMICS: BrushDynamics = {
  tip: {
    angle: 0,
    roundness: 1,
    flipX: false,
    flipY: false,
    spacingEnabled: true,
  },
  bitmap: null,
  shape: {
    enabled: false,
    size: jitter(),
    minDiameter: 0,
    tiltScale: 1,
    angle: jitter(),
    roundness: jitter(),
    minRoundness: 0.25,
    flipXJitter: false,
    flipYJitter: false,
    projection: false,
  },
  scatter: {
    enabled: false,
    amount: jitter(),
    bothAxes: false,
    count: 1,
    countJitter: jitter(),
  },
  texture: {
    enabled: false,
    scale: 1,
    brightness: 0,
    contrast: 0,
    mode: "multiply",
    depth: 1,
    minDepth: 0,
    depthJitter: jitter(),
    invert: false,
    eachTip: true,
  },
  dual: {
    enabled: false,
    mode: "multiply",
    diameter: 12,
    spacing: 0.25,
    scatter: 0,
    bothAxes: false,
    count: 1,
    roundness: 1,
    flip: false,
    bitmap: null,
  },
  color: {
    enabled: false,
    fgBg: jitter(),
    hue: 0,
    saturation: 0,
    brightness: 0,
    purity: 0,
    perTip: true,
  },
  transfer: {
    enabled: false,
    opacity: jitter(),
    flow: jitter(),
  },
  pose: {
    enabled: false,
    tiltX: 0,
    tiltY: 0,
    rotation: 0,
    pressure: 1,
    overrideTilt: false,
    overrideRotation: false,
    overridePressure: false,
  },
  noise: false,
  wetEdges: false,
  buildUp: false,
  smoothing: {
    amount: 0,
    catchUp: true,
    catchUpEnd: true,
    zoomCompensation: true,
  },
  protectTexture: false,
  symmetry: { kind: "off", cx: 0.5, cy: 0.5, angle: 0, segments: 6 },
  lockAlpha: false,
};

export const DEFAULT_PAINT_TOOL_OPTIONS: PaintToolOptions = {
  smudge: { strength: 0.5, fingerPainting: false, sampleAll: false },
  mixer: {
    wet: 0.5,
    load: 0.5,
    mix: 0.5,
    flow: 1,
    loadAfter: true,
    cleanAfter: true,
    sampleAll: false,
  },
  history: { source: "open" },
  artHistory: { style: "tightShort", area: 50, tolerance: 0, fidelity: 1 },
  backgroundEraser: {
    sampling: "continuous",
    limits: "contiguous",
    tolerance: 0.5,
    protectForeground: false,
  },
  colorReplace: {
    mode: "color",
    sampling: "continuous",
    limits: "contiguous",
    tolerance: 0.3,
  },
  magicEraser: {
    tolerance: 32,
    antialias: true,
    contiguous: true,
    sampleAll: false,
    opacity: 1,
  },
};

/** A deep-ish copy (the panes are one level of objects, the jitters a
 *  second); bitmaps are shared — they are immutable once made. */
export function cloneDynamics(d: BrushDynamics): BrushDynamics {
  const j = (x: JitterSetting): JitterSetting => ({ ...x });
  return {
    tip: { ...d.tip },
    bitmap: d.bitmap,
    shape: {
      ...d.shape,
      size: j(d.shape.size),
      angle: j(d.shape.angle),
      roundness: j(d.shape.roundness),
    },
    scatter: {
      ...d.scatter,
      amount: j(d.scatter.amount),
      countJitter: j(d.scatter.countJitter),
    },
    texture: { ...d.texture, depthJitter: j(d.texture.depthJitter) },
    dual: { ...d.dual },
    color: { ...d.color, fgBg: j(d.color.fgBg) },
    transfer: {
      ...d.transfer,
      opacity: j(d.transfer.opacity),
      flow: j(d.transfer.flow),
    },
    pose: { ...d.pose },
    noise: d.noise,
    wetEdges: d.wetEdges,
    buildUp: d.buildUp,
    smoothing: { ...d.smoothing },
    protectTexture: d.protectTexture,
    symmetry: { ...d.symmetry },
    lockAlpha: d.lockAlpha,
  };
}

/** One pane's patch: its fields, each jitter merged field by field. */
export type DynamicsPatch = {
  [K in keyof BrushDynamics]?: BrushDynamics[K] extends object | null
    ? Partial<NonNullable<BrushDynamics[K]>> | null
    : BrushDynamics[K];
};

/** Merge a patch into `d` (a new object; `d` is not touched). */
export function patchDynamics(
  d: BrushDynamics,
  patch: DynamicsPatch,
): BrushDynamics {
  const out = cloneDynamics(d);
  const o = out as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = o[k];
    if (
      v !== null &&
      typeof v === "object" &&
      !(v instanceof Uint8Array) &&
      cur !== null &&
      typeof cur === "object" &&
      !("alpha" in (v as object))
    ) {
      const merged: Record<string, unknown> = {
        ...(cur as Record<string, unknown>),
      };
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        const c2 = merged[k2];
        merged[k2] =
          v2 !== null &&
          typeof v2 === "object" &&
          c2 !== null &&
          typeof c2 === "object" &&
          "control" in (c2 as object)
            ? { ...(c2 as object), ...(v2 as object) }
            : v2;
      }
      o[k] = merged;
    } else {
      o[k] = v;
    }
  }
  return out;
}

/** What a stroke freezes beyond `BrushParams`: the dynamics, the tool
 *  options, the per-stroke seed, the background colour (the colour
 *  dynamics' second end and the swatch the eraser samples), and the
 *  pulled string's length in IMAGE px (the session converts it from
 *  screen px at the zoom of the stroke's first sample). */
export interface StrokeOptions {
  dynamics: BrushDynamics;
  tools: PaintToolOptions;
  seed: number;
  background: [number, number, number, number];
  smoothingRadiusPx: number;
}

const b = (v: boolean) => (v ? 1 : 0);
const ord = <T>(list: readonly T[], v: T) => Math.max(0, list.indexOf(v));

type Getter = (o: StrokeOptions) => number;

function jitterFields(
  prefix: string,
  pick: (o: StrokeOptions) => JitterSetting,
): Array<[string, Getter]> {
  return [
    [`${prefix}.jitter`, (o) => pick(o).jitter],
    [`${prefix}.control`, (o) => ord(BRUSH_CONTROLS, pick(o).control)],
    [`${prefix}.fade`, (o) => pick(o).fadeSteps],
    [`${prefix}.min`, (o) => pick(o).minimum],
  ];
}

/** Every wire key this glue can fill, by name. */
export const DYNAMICS_FIELDS: ReadonlyMap<string, Getter> = new Map<
  string,
  Getter
>([
  ["seed", (o) => o.seed],
  ["tip.angle", (o) => o.dynamics.tip.angle],
  ["tip.roundness", (o) => o.dynamics.tip.roundness],
  ["tip.flipX", (o) => b(o.dynamics.tip.flipX)],
  ["tip.flipY", (o) => b(o.dynamics.tip.flipY)],
  ["tip.spacingEnabled", (o) => b(o.dynamics.tip.spacingEnabled)],
  ["shape.enabled", (o) => b(o.dynamics.shape.enabled)],
  ...jitterFields("shape.size", (o) => o.dynamics.shape.size),
  ["shape.minDiameter", (o) => o.dynamics.shape.minDiameter],
  ["shape.tiltScale", (o) => o.dynamics.shape.tiltScale],
  ...jitterFields("shape.angle", (o) => o.dynamics.shape.angle),
  ...jitterFields("shape.roundness", (o) => o.dynamics.shape.roundness),
  ["shape.minRoundness", (o) => o.dynamics.shape.minRoundness],
  ["shape.flipXJitter", (o) => b(o.dynamics.shape.flipXJitter)],
  ["shape.flipYJitter", (o) => b(o.dynamics.shape.flipYJitter)],
  ["shape.projection", (o) => b(o.dynamics.shape.projection)],
  ["scatter.enabled", (o) => b(o.dynamics.scatter.enabled)],
  ...jitterFields("scatter.amount", (o) => o.dynamics.scatter.amount),
  ["scatter.bothAxes", (o) => b(o.dynamics.scatter.bothAxes)],
  ["scatter.count", (o) => o.dynamics.scatter.count],
  ...jitterFields("scatter.countJitter", (o) => o.dynamics.scatter.countJitter),
  ["texture.enabled", (o) => b(o.dynamics.texture.enabled)],
  ["texture.scale", (o) => o.dynamics.texture.scale],
  ["texture.brightness", (o) => o.dynamics.texture.brightness],
  ["texture.contrast", (o) => o.dynamics.texture.contrast],
  ["texture.mode", (o) => ord(COMBINE_MODES, o.dynamics.texture.mode)],
  ["texture.depth", (o) => o.dynamics.texture.depth],
  ["texture.minDepth", (o) => o.dynamics.texture.minDepth],
  ...jitterFields("texture.depthJitter", (o) => o.dynamics.texture.depthJitter),
  ["texture.invert", (o) => b(o.dynamics.texture.invert)],
  ["texture.eachTip", (o) => b(o.dynamics.texture.eachTip)],
  ["dual.enabled", (o) => b(o.dynamics.dual.enabled)],
  ["dual.mode", (o) => ord(COMBINE_MODES, o.dynamics.dual.mode)],
  ["dual.diameter", (o) => o.dynamics.dual.diameter],
  ["dual.spacing", (o) => o.dynamics.dual.spacing],
  ["dual.scatter", (o) => o.dynamics.dual.scatter],
  ["dual.bothAxes", (o) => b(o.dynamics.dual.bothAxes)],
  ["dual.count", (o) => o.dynamics.dual.count],
  ["dual.roundness", (o) => o.dynamics.dual.roundness],
  ["dual.flip", (o) => b(o.dynamics.dual.flip)],
  ["color.enabled", (o) => b(o.dynamics.color.enabled)],
  ...jitterFields("color.fgBg", (o) => o.dynamics.color.fgBg),
  ["color.hue", (o) => o.dynamics.color.hue],
  ["color.saturation", (o) => o.dynamics.color.saturation],
  ["color.brightness", (o) => o.dynamics.color.brightness],
  ["color.purity", (o) => o.dynamics.color.purity],
  ["color.perTip", (o) => b(o.dynamics.color.perTip)],
  ["transfer.enabled", (o) => b(o.dynamics.transfer.enabled)],
  ...jitterFields("transfer.opacity", (o) => o.dynamics.transfer.opacity),
  ...jitterFields("transfer.flow", (o) => o.dynamics.transfer.flow),
  ["pose.enabled", (o) => b(o.dynamics.pose.enabled)],
  ["pose.tiltX", (o) => o.dynamics.pose.tiltX],
  ["pose.tiltY", (o) => o.dynamics.pose.tiltY],
  ["pose.rotation", (o) => o.dynamics.pose.rotation],
  ["pose.pressure", (o) => o.dynamics.pose.pressure],
  ["pose.overrideTilt", (o) => b(o.dynamics.pose.overrideTilt)],
  ["pose.overrideRotation", (o) => b(o.dynamics.pose.overrideRotation)],
  ["pose.overridePressure", (o) => b(o.dynamics.pose.overridePressure)],
  ["noise", (o) => b(o.dynamics.noise)],
  ["wetEdges", (o) => b(o.dynamics.wetEdges)],
  ["buildUp", (o) => b(o.dynamics.buildUp)],
  ["smoothing.radius", (o) => o.smoothingRadiusPx],
  ["smoothing.catchUp", (o) => b(o.dynamics.smoothing.catchUp)],
  ["smoothing.catchUpEnd", (o) => b(o.dynamics.smoothing.catchUpEnd)],
  ["symmetry.kind", (o) => ord(SYMMETRY_KINDS, o.dynamics.symmetry.kind)],
  ["symmetry.cx", (o) => o.dynamics.symmetry.cx],
  ["symmetry.cy", (o) => o.dynamics.symmetry.cy],
  ["symmetry.angle", (o) => o.dynamics.symmetry.angle],
  ["symmetry.segments", (o) => o.dynamics.symmetry.segments],
  ["lockAlpha", (o) => b(o.dynamics.lockAlpha)],
  ["background.r", (o) => o.background[0]],
  ["background.g", (o) => o.background[1]],
  ["background.b", (o) => o.background[2]],
  ["smudge.strength", (o) => o.tools.smudge.strength],
  ["smudge.finger", (o) => b(o.tools.smudge.fingerPainting)],
  ["smudge.sampleAll", (o) => b(o.tools.smudge.sampleAll)],
  ["mixer.wet", (o) => o.tools.mixer.wet],
  ["mixer.load", (o) => o.tools.mixer.load],
  ["mixer.mix", (o) => o.tools.mixer.mix],
  ["mixer.flow", (o) => o.tools.mixer.flow],
  ["mixer.sampleAll", (o) => b(o.tools.mixer.sampleAll)],
  ["art.style", (o) => ord(ART_HISTORY_STYLES, o.tools.artHistory.style)],
  ["art.area", (o) => o.tools.artHistory.area],
  ["art.tolerance", (o) => o.tools.artHistory.tolerance],
  ["art.fidelity", (o) => o.tools.artHistory.fidelity],
  [
    "erase.sampling",
    (o) => ord(SAMPLING_MODES, o.tools.backgroundEraser.sampling),
  ],
  ["erase.limits", (o) => ord(LIMITS_MODES, o.tools.backgroundEraser.limits)],
  ["erase.tolerance", (o) => o.tools.backgroundEraser.tolerance],
  ["erase.protectFg", (o) => b(o.tools.backgroundEraser.protectForeground)],
  [
    "replace.sampling",
    (o) => ord(SAMPLING_MODES, o.tools.colorReplace.sampling),
  ],
  ["replace.limits", (o) => ord(LIMITS_MODES, o.tools.colorReplace.limits)],
  ["replace.tolerance", (o) => o.tools.colorReplace.tolerance],
]);

/** Pack `o` in the engine's key order. Returns the values and the keys
 *  the engine asked for that this table cannot fill (sent as 0). */
export function packDynamics(
  keys: readonly string[],
  o: StrokeOptions,
): { values: Float32Array; unknown: string[] } {
  const values = new Float32Array(keys.length);
  const unknown: string[] = [];
  keys.forEach((k, i) => {
    const get = DYNAMICS_FIELDS.get(k);
    if (!get) {
      unknown.push(k);
      return;
    }
    const v = get(o);
    values[i] = Number.isFinite(v) ? v : 0;
  });
  return { values, unknown };
}

/** True when any pane changes what a plain round-brush stroke would do
 *  — the session skips the dynamics door otherwise. */
export function dynamicsActive(d: BrushDynamics): boolean {
  return (
    d.tip.angle !== 0 ||
    d.tip.roundness !== 1 ||
    d.tip.flipX ||
    d.tip.flipY ||
    !d.tip.spacingEnabled ||
    d.bitmap !== null ||
    d.shape.enabled ||
    d.scatter.enabled ||
    d.texture.enabled ||
    d.dual.enabled ||
    d.color.enabled ||
    d.transfer.enabled ||
    d.pose.enabled ||
    d.noise ||
    d.wetEdges ||
    d.buildUp ||
    d.smoothing.amount > 0 ||
    d.symmetry.kind !== "off" ||
    d.lockAlpha
  );
}
