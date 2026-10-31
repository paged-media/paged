// The `.abr` preset → brush mapping (src/abr-preset.ts): every dynamics
// group the reader projects lands on the brush engine's settings, and
// everything it cannot apply is NAMED in `unapplied` rather than dropped.
// The JSON shape is the reader's (`image-js/src/brushes.rs`
// `dynamics_json`, whose own tests write a preset with the `.abr` writer
// and read it back); here it is fed literally so the mapping is tested on
// its own.

import { describe, expect, it } from "bun:test";

import {
  abrToBrush,
  composeBlendOf,
  decodeTipBitmap,
  exportFields,
  packExportValues,
  type AbrDynamicJson,
  type AbrDynamicsJson,
  type AbrPresetInfo,
} from "../src/abr-preset";
import {
  DEFAULT_BRUSH_DYNAMICS,
  patchDynamics,
  type TipBitmap,
} from "../src/brush-dynamics";

const dyn = (
  controlName: string,
  jitter: number,
  minimum: number | null = null,
  control = 0,
): AbrDynamicJson => ({ control, controlName, fade: 25, jitter, minimum });

const NONE: AbrDynamicsJson = {
  tip: { flipX: false, flipY: false },
  shape: null,
  scatter: null,
  texture: null,
  dual: null,
  color: null,
  transfer: null,
  pose: null,
  wetEdges: null,
  noise: null,
  buildUp: null,
  protectTexture: null,
  pressureOverridesSize: null,
  pressureOverridesOpacity: null,
  smoothing: null,
  toolOptions: null,
};

const preset = (over: Partial<AbrPresetInfo> = {}): AbrPresetInfo => ({
  index: 0,
  name: "Soft Round 30",
  kind: "computed",
  diameter: 30,
  diameterUnit: "#Pxl",
  hardness: 0.5,
  spacing: 0.25,
  spacingEnabled: true,
  roundness: 1,
  angle: 0,
  sampleIndex: null,
  dynamics: NONE,
  ...over,
});

const bitmap: TipBitmap = {
  id: "abr:0",
  width: 2,
  height: 2,
  alpha: new Uint8Array([0, 128, 255, 64]),
};

describe("abrToBrush — the tip", () => {
  it("a computed round tip maps size, hardness, spacing, angle, roundness and the flips", () => {
    const m = abrToBrush(
      preset({
        angle: 30,
        roundness: 0.4,
        dynamics: { ...NONE, tip: { flipX: true, flipY: false } },
      }),
      null,
    );
    expect(m.params).toEqual({ size: 30, hardness: 0.5, spacing: 0.25 });
    expect(m.dynamics.tip).toEqual({
      spacingEnabled: true,
      angle: 30,
      roundness: 0.4,
      flipX: true,
      flipY: false,
    });
    expect(m.dynamics.bitmap).toBeNull();
    expect(m.unapplied).toEqual([]);
  });

  it("spacing switched off travels as spacingEnabled false (the engine honours it now)", () => {
    const m = abrToBrush(preset({ spacingEnabled: false }), null);
    expect(m.dynamics.tip?.spacingEnabled).toBe(false);
    expect(m.params.spacing).toBe(0.25);
  });

  it("a sampled tip takes its bitmap; without one it says so", () => {
    const sampled = preset({ kind: "sampled", hardness: null, sampleIndex: 0 });
    const withBitmap = abrToBrush(sampled, bitmap);
    expect(withBitmap.dynamics.bitmap).toBe(bitmap);
    expect(withBitmap.params.hardness).toBeUndefined();
    expect(withBitmap.unapplied).toEqual([]);
    const without = abrToBrush(sampled, null);
    expect(without.dynamics.bitmap).toBeNull();
    expect(without.unapplied).toEqual([
      "the sampled tip's bitmap — not available",
    ]);
  });

  it("a non-pixel diameter and a bristle tip are reported, not applied", () => {
    const m = abrToBrush(
      preset({ kind: "bristle", diameterUnit: "#Prc" }),
      null,
    );
    expect(m.params.size).toBeUndefined();
    expect(m.unapplied).toEqual([
      "diameter in #Prc",
      "the bristle tip — painted as a round tip",
    ]);
  });

  it("a row from an older engine (no dynamics) still maps its tip", () => {
    const old = preset();
    delete old.dynamics;
    const m = abrToBrush(old, null);
    expect(m.params.size).toBe(30);
    expect(m.dynamics.shape).toBeUndefined();
  });
});

describe("abrToBrush — every dynamics group", () => {
  const full: AbrDynamicsJson = {
    ...NONE,
    shape: {
      size: dyn("pressure", 0.25, 0.1, 2),
      angle: dyn("direction", 0.5, null, 6),
      roundness: dyn("tilt", 0.3, null, 3),
      minimumDiameter: 0.2,
      minimumRoundness: 0.4,
      tiltScale: 2,
      flipXJitter: true,
      flipYJitter: false,
      projection: true,
    },
    scatter: {
      scatter: dyn("off", 3.68),
      count: 3,
      countJitter: dyn("fade", 0.5, null, 1),
      bothAxes: true,
    },
    texture: {
      patternId: "pat-1",
      patternName: "Canvas",
      mode: "linearHeight",
      scale: 0.5,
      depth: 0.75,
      minimumDepth: 0.1,
      depthJitter: dyn("pressure", 0.2, null, 2),
      invert: true,
      brightness: -7,
      contrast: 14,
      eachTip: true,
    },
    dual: {
      enabled: true,
      kind: "computed",
      diameter: 12,
      diameterUnit: "#Pxl",
      roundness: 0.5,
      hardness: 1,
      tipSpacing: 0.3,
      angle: 0,
      sampleIndex: null,
      flip: true,
      mode: "colorBurn",
      useScatter: true,
      spacing: 0.4,
      count: 2,
      bothAxes: false,
      countJitter: null,
      scatter: dyn("off", 0.6),
    },
    color: {
      fgBg: dyn("pressure", 0.3, null, 2),
      hue: 0.1,
      saturation: 0.2,
      brightness: 0.3,
      purity: -0.4,
      perTip: false,
    },
    transfer: {
      flow: dyn("pressure", 0.1, 0.2, 2),
      opacity: dyn("fade", 0.3, null, 1),
      wetness: null,
      mix: null,
    },
    pose: {
      overrideAngle: true,
      overrideTiltX: true,
      overrideTiltY: false,
      overridePressure: false,
      pressure: 0.8,
      tiltX: -54,
      tiltY: 23,
      angle: 90,
    },
    wetEdges: true,
    noise: false,
    buildUp: true,
    protectTexture: true,
    smoothing: {
      enabled: true,
      amount: 0.35,
      radiusMode: true,
      catchUp: true,
      catchUpAtEnd: false,
      zoomCompensation: true,
      pressureSmoothing: false,
      source: "toolOptions",
    },
    toolOptions: {
      kind: "brush",
      classId: "PbTl",
      flow: 0.8,
      opacity: 0.6,
      blend: "colorBurn",
    },
  };

  it("maps each group onto its pane, and the patch applies to the defaults", () => {
    const m = abrToBrush(preset({ dynamics: full }), null);
    const d = patchDynamics(DEFAULT_BRUSH_DYNAMICS, m.dynamics);

    expect(d.shape).toMatchObject({
      enabled: true,
      size: { jitter: 0.25, control: "pressure", fadeSteps: 25, minimum: 0.1 },
      angle: { jitter: 0.5, control: "direction" },
      roundness: { jitter: 0.3, control: "tilt" },
      minDiameter: 0.2,
      minRoundness: 0.4,
      tiltScale: 2,
      flipXJitter: true,
      projection: true,
    });
    expect(d.scatter).toMatchObject({
      enabled: true,
      amount: { jitter: 3.68, control: "off" },
      count: 3,
      countJitter: { jitter: 0.5, control: "fade" },
      bothAxes: true,
    });
    expect(d.texture).toMatchObject({
      enabled: true,
      mode: "linearHeight",
      scale: 0.5,
      depth: 0.75,
      minDepth: 0.1,
      depthJitter: { jitter: 0.2, control: "pressure" },
      invert: true,
      brightness: -7,
      contrast: 14,
      eachTip: true,
    });
    expect(d.dual).toMatchObject({
      enabled: true,
      mode: "colorBurn",
      diameter: 12,
      spacing: 0.4,
      scatter: 0.6,
      count: 2,
      roundness: 0.5,
      flip: true,
      bitmap: null,
    });
    expect(d.color).toMatchObject({
      enabled: true,
      fgBg: { jitter: 0.3, control: "pressure" },
      hue: 0.1,
      saturation: 0.2,
      brightness: 0.3,
      purity: -0.4,
      perTip: false,
    });
    expect(d.transfer).toMatchObject({
      enabled: true,
      flow: { jitter: 0.1, control: "pressure", minimum: 0.2 },
      opacity: { jitter: 0.3, control: "fade" },
    });
    expect(d.pose).toEqual({
      enabled: true,
      tiltX: -54,
      tiltY: 23,
      rotation: 90,
      pressure: 0.8,
      overrideTilt: true,
      overrideRotation: true,
      overridePressure: false,
    });
    expect([d.wetEdges, d.noise, d.buildUp, d.protectTexture]).toEqual([
      true,
      false,
      true,
      true,
    ]);
    expect(d.smoothing).toEqual({
      amount: 0.35,
      catchUp: true,
      catchUpEnd: false,
      zoomCompensation: true,
    });
    expect(m.params).toMatchObject({
      opacity: 0.6,
      flow: 0.8,
      blend: "color_burn",
    });
    // Only the pattern itself cannot travel (patterns stay opaque bytes).
    expect(m.unapplied).toEqual([
      "the texture's pattern “Canvas” (the image's defined pattern is used)",
    ]);
  });

  it("a gate the file switched off switches the pane off", () => {
    const m = abrToBrush(preset(), null);
    const d = patchDynamics(
      patchDynamics(DEFAULT_BRUSH_DYNAMICS, {
        shape: { enabled: true },
        texture: { enabled: true },
      }),
      m.dynamics,
    );
    expect(d.shape.enabled).toBe(false);
    expect(d.texture.enabled).toBe(false);
    expect(d.dual.enabled).toBe(false);
  });

  it("what the engine cannot do is named: mixer dynamics, odd modes, unknown controls, other tools", () => {
    const m = abrToBrush(
      preset({
        dynamics: {
          ...full,
          texture: {
            ...full.texture!,
            patternId: null,
            patternName: null,
            mode: "screen",
          },
          dual: { ...full.dual!, kind: "sampled", mode: "vividLight" },
          transfer: { ...full.transfer!, wetness: dyn("off", 0.1) },
          shape: { ...full.shape!, size: dyn("somethingNew", 0.1) },
          toolOptions: {
            ...full.toolOptions!,
            kind: "mixer",
            blend: "dissolve",
          },
        },
      }),
      null,
    );
    expect(m.unapplied).toEqual([
      "control somethingNew",
      "texture mode screen",
      "dual brush mode vividLight",
      "the dual tip's sampled shape — painted as a round tip",
      "wetness and mix dynamics (mixer brush)",
      "the mixer tool options",
      "blend mode dissolve",
    ]);
  });

  it("a sampled dual tip takes its own bitmap", () => {
    const m = abrToBrush(
      preset({
        dynamics: { ...full, dual: { ...full.dual!, kind: "sampled" } },
      }),
      null,
      bitmap,
    );
    expect(m.dynamics.dual?.bitmap).toBe(bitmap);
  });
});

describe("composeBlendOf", () => {
  it("turns long-form names into compose wire names and refuses the ones with no stroke blend", () => {
    expect(composeBlendOf("normal")).toBe("normal");
    expect(composeBlendOf("colorDodge")).toBe("color_dodge");
    expect(composeBlendOf("blendSubtraction")).toBe("subtract");
    expect(composeBlendOf("blendDivide")).toBe("divide");
    expect(composeBlendOf("dissolve")).toBeNull();
    expect(composeBlendOf("linearHeight")).toBeNull();
  });
});

describe("export values", () => {
  // The exact list brushes.rs EXPORT_KEYS publishes through
  // `abr_export_keys` (pinned there by its own export test).
  const KEYS = [
    "diameter",
    "hardness",
    "spacing",
    "opacity",
    "flow",
    "tip.angle",
    "tip.roundness",
    "tip.flipX",
    "tip.flipY",
    "tip.spacingEnabled",
    "shape.enabled",
    "shape.size.jitter",
    "shape.size.control",
    "shape.size.fade",
    "shape.size.min",
    "shape.minDiameter",
    "shape.tiltScale",
    "shape.angle.jitter",
    "shape.angle.control",
    "shape.angle.fade",
    "shape.angle.min",
    "shape.roundness.jitter",
    "shape.roundness.control",
    "shape.roundness.fade",
    "shape.roundness.min",
    "shape.minRoundness",
    "shape.flipXJitter",
    "shape.flipYJitter",
    "shape.projection",
    "scatter.enabled",
    "scatter.amount.jitter",
    "scatter.amount.control",
    "scatter.amount.fade",
    "scatter.amount.min",
    "scatter.bothAxes",
    "scatter.count",
    "scatter.countJitter.jitter",
    "scatter.countJitter.control",
    "scatter.countJitter.fade",
    "scatter.countJitter.min",
    "dual.enabled",
    "dual.mode",
    "dual.diameter",
    "dual.spacing",
    "dual.scatter",
    "dual.bothAxes",
    "dual.count",
    "dual.roundness",
    "dual.flip",
    "color.enabled",
    "color.fgBg.jitter",
    "color.fgBg.control",
    "color.fgBg.fade",
    "color.fgBg.min",
    "color.hue",
    "color.saturation",
    "color.brightness",
    "color.purity",
    "color.perTip",
    "transfer.enabled",
    "transfer.opacity.jitter",
    "transfer.opacity.control",
    "transfer.opacity.fade",
    "transfer.opacity.min",
    "transfer.flow.jitter",
    "transfer.flow.control",
    "transfer.flow.fade",
    "transfer.flow.min",
    "pose.enabled",
    "pose.tiltX",
    "pose.tiltY",
    "pose.rotation",
    "pose.pressure",
    "pose.overrideTilt",
    "pose.overrideRotation",
    "pose.overridePressure",
    "noise",
    "wetEdges",
    "buildUp",
    "smoothing.amount",
    "smoothing.catchUp",
    "smoothing.catchUpEnd",
    "smoothing.zoomCompensation",
    "protectTexture",
  ];
  const p = {
    name: "Mine",
    params: { size: 30, hardness: 0.5, spacing: 0.25, opacity: 0.8, flow: 1 },
    dynamics: patchDynamics(DEFAULT_BRUSH_DYNAMICS, {
      tip: { angle: 30 },
      shape: {
        enabled: true,
        size: { control: "pressure", jitter: 0.25, fadeSteps: 25, minimum: 0 },
      },
      dual: { mode: "colorBurn" },
    }),
  };

  it("fills every key the engine asks for, by name", () => {
    const { values, unknown } = packExportValues(KEYS, p);
    expect(unknown).toEqual([]);
    expect(exportFields(p).size).toBe(KEYS.length);
    const at = (k: string) => values[KEYS.indexOf(k)];
    expect(at("diameter")).toBe(30);
    expect(at("opacity")).toBeCloseTo(0.8);
    expect(at("tip.angle")).toBe(30);
    expect(at("shape.enabled")).toBe(1);
    expect(at("shape.size.control")).toBe(2);
    expect(at("dual.mode")).toBe(5);
  });

  it("a key it does not know is sent as 0 and named", () => {
    const { values, unknown } = packExportValues(
      ["diameter", "fromTheFuture"],
      p,
    );
    expect(Array.from(values)).toEqual([30, 0]);
    expect(unknown).toEqual(["fromTheFuture"]);
  });

  it("decodes abr_tip's reply", () => {
    const reply = new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 9, 200]);
    expect(decodeTipBitmap(reply, "abr:3")).toEqual({
      id: "abr:3",
      width: 2,
      height: 1,
      alpha: new Uint8Array([9, 200]),
    });
    expect(() =>
      decodeTipBitmap(new Uint8Array([2, 0, 0, 0, 2, 0, 0, 0, 1]), "x"),
    ).toThrow();
  });
});
