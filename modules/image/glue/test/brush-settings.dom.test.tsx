// BRUSH SETTINGS as a component (the DOM lane): every pane renders, every
// control sends the exact patch it names, the pane switches turn their
// panes on and off, and the connected panel follows the session.

import { afterEach, describe, expect, it, mock } from "bun:test";
import { covers } from "@paged-media/test-kit";
import {
  BUILT_IN_LOCALES,
  createStrings,
  setActiveStrings,
} from "@paged-media/strings";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import "../src/activate";
import {
  DEFAULT_BRUSH_DYNAMICS,
  DEFAULT_PAINT_TOOL_OPTIONS,
  cloneDynamics,
  patchDynamics,
  type BrushDynamics,
  type DynamicsPatch,
} from "../src/brush-dynamics";
import { DEFAULT_BRUSH_PARAMS } from "../src/engine";
import {
  BRUSH_PANES,
  BrushSettingsView,
  makeBrushSettingsPanel,
  type BrushPane,
  type BrushSettingsSession,
} from "../src/panels/brush-settings-panel";

const ID = "panel:media.paged.image.panel.brushSettings";

afterEach(() => {
  cleanup();
  setActiveStrings(createStrings());
});

function view(
  pane: BrushPane,
  edit?: (d: BrushDynamics) => void,
  pattern: { width: number; height: number } | null = null,
) {
  const dynamics = cloneDynamics(DEFAULT_BRUSH_DYNAMICS);
  edit?.(dynamics);
  const onPane = mock((_p: BrushPane) => {});
  const onBrush = mock((_p: unknown) => {});
  const onDynamics = mock((_p: DynamicsPatch) => {});
  const onTool = mock((_t: string, _p: unknown) => {});
  const r = render(
    <BrushSettingsView
      pane={pane}
      brush={DEFAULT_BRUSH_PARAMS}
      dynamics={dynamics}
      tools={DEFAULT_PAINT_TOOL_OPTIONS}
      pattern={pattern}
      gpu
      disabled={false}
      onPane={onPane}
      onBrush={onBrush}
      onDynamics={onDynamics}
      onTool={onTool as never}
    />,
  );
  const field = (f: string) =>
    r.container.querySelector(
      `[data-brush-field="${f}"]`,
    ) as HTMLInputElement | null;
  const set = (f: string, value: string) =>
    fireEvent.change(field(f)!, { target: { value } });
  const tick = (f: string) => fireEvent.click(field(f)!);
  return { r, field, set, tick, onPane, onBrush, onDynamics, onTool };
}

const j = (over: object) => ({
  jitter: 0,
  control: "off",
  fadeSteps: 25,
  minimum: 0,
  ...over,
});

describe("Brush Settings", () => {
  it("lists every pane, selects one on click, and switches the optional ones", () => {
    covers("panel:media.paged.image.panel.brushSettings");
    const v = view("tip");
    const buttons = v.r.container.querySelectorAll("[data-brush-pane]");
    expect(buttons).toHaveLength(BRUSH_PANES.length);
    fireEvent.click(
      v.r.container.querySelector('[data-brush-pane="scatter"]')!,
    );
    expect(v.onPane).toHaveBeenCalledWith("scatter");
    // Tip, symmetry and tools are always there: no switch.
    for (const p of ["tip", "symmetry", "tools"])
      expect(
        v.r.container.querySelector(`[data-brush-pane-enable="${p}"]`),
      ).toBeNull();
    const enable = (p: string) =>
      fireEvent.click(
        v.r.container.querySelector(`[data-brush-pane-enable="${p}"]`)!,
      );
    enable("shape");
    expect(v.onDynamics).toHaveBeenLastCalledWith({ shape: { enabled: true } });
    enable("wetEdges");
    expect(v.onDynamics).toHaveBeenLastCalledWith({ wetEdges: true });
    enable("lockAlpha");
    expect(v.onDynamics).toHaveBeenLastCalledWith({ lockAlpha: true });
    enable("smoothing");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      smoothing: { amount: 0.1 },
    });
  });

  it("Brush Tip Shape: size, hardness and spacing go to the brush; angle, roundness, flips to the tip", () => {
    covers("panel:media.paged.image.panel.brushSettings");
    const v = view("tip", (d) => {
      d.tip.angle = 30;
      d.tip.roundness = 0.4;
    });
    const preview = v.r.container.querySelector("[data-brush-preview]")!;
    expect(preview.getAttribute("data-angle")).toBe("30");
    expect(preview.querySelector("g")!.getAttribute("transform")).toContain(
      "rotate(-30)",
    );
    expect(preview.querySelector("ellipse")!.getAttribute("ry")).toBe("8");
    v.set("size", "64");
    expect(v.onBrush).toHaveBeenLastCalledWith({ size: 64 });
    v.set("hardness", "0.2");
    expect(v.onBrush).toHaveBeenLastCalledWith({ hardness: 0.2 });
    v.set("spacing", "1.5");
    expect(v.onBrush).toHaveBeenLastCalledWith({ spacing: 1.5 });
    v.set("tip.angle", "-45");
    expect(v.onDynamics).toHaveBeenLastCalledWith({ tip: { angle: -45 } });
    v.set("tip.roundness", "0.25");
    expect(v.onDynamics).toHaveBeenLastCalledWith({ tip: { roundness: 0.25 } });
    v.tick("tip.flipX");
    expect(v.onDynamics).toHaveBeenLastCalledWith({ tip: { flipX: true } });
    v.tick("tip.flipY");
    expect(v.onDynamics).toHaveBeenLastCalledWith({ tip: { flipY: true } });
    v.tick("tip.spacingEnabled");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      tip: { spacingEnabled: false },
    });
  });

  it("a sampled tip names its size and greys hardness out", () => {
    covers("panel:media.paged.image.panel.brushSettings");
    const v = view("tip", (d) => {
      d.bitmap = { id: "t", width: 7, height: 3, alpha: new Uint8Array(21) };
    });
    expect(
      v.r.container.querySelector("[data-brush-tip-kind]")!.textContent,
    ).toContain("7×3");
    expect(v.field("hardness")!.disabled).toBe(true);
  });

  it("Shape Dynamics: each jitter with its control, fade steps only under Fade", () => {
    covers("panel:media.paged.image.panel.brushSettings");
    const v = view("shape", (d) => {
      d.shape.enabled = true;
      d.shape.angle.control = "fade";
    });
    v.set("shape.size.jitter", "0.5");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      shape: { size: j({ jitter: 0.5 }) },
    });
    v.set("shape.size.control", "pressure");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      shape: { size: j({ control: "pressure" }) },
    });
    // All nine controls are offered.
    expect(
      v.field("shape.size.control")!.querySelectorAll("option"),
    ).toHaveLength(9);
    expect(v.field("shape.size.fadeSteps")).toBeNull();
    v.set("shape.angle.fadeSteps", "40");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      shape: { angle: j({ control: "fade", fadeSteps: 40 }) },
    });
    v.set("shape.roundness.control", "direction");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      shape: { roundness: j({ control: "direction" }) },
    });
    v.set("shape.minDiameter", "0.3");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      shape: { minDiameter: 0.3 },
    });
    v.set("shape.minRoundness", "0.6");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      shape: { minRoundness: 0.6 },
    });
    // Tilt scale is for the tilt control only.
    expect(v.field("shape.tiltScale")!.disabled).toBe(true);
    for (const f of ["flipXJitter", "flipYJitter", "projection"]) {
      v.tick(`shape.${f}`);
      expect(v.onDynamics).toHaveBeenLastCalledWith({ shape: { [f]: true } });
    }
  });

  it("an optional pane that is switched off greys its controls", () => {
    covers("panel:media.paged.image.panel.brushSettings");
    const v = view("scatter");
    expect(v.field("scatter.count")!.disabled).toBe(true);
  });

  it("Scattering: scatter, both axes, count and its jitter", () => {
    covers("panel:media.paged.image.panel.brushSettings");
    const v = view("scatter", (d) => {
      d.scatter.enabled = true;
    });
    v.set("scatter.amount.jitter", "2.5");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      scatter: { amount: j({ jitter: 2.5 }) },
    });
    v.tick("scatter.bothAxes");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      scatter: { bothAxes: true },
    });
    v.set("scatter.count", "4");
    expect(v.onDynamics).toHaveBeenLastCalledWith({ scatter: { count: 4 } });
    v.set("scatter.countJitter.control", "tilt");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      scatter: { countJitter: j({ control: "tilt" }) },
    });
  });

  it("Texture: says when no pattern is defined, and sends every setting", () => {
    covers("panel:media.paged.image.panel.brushSettings");
    const none = view("texture");
    expect(
      none.r.container
        .querySelector("[data-brush-texture-pattern]")!
        .getAttribute("data-brush-texture-pattern"),
    ).toBe("none");
    cleanup();
    const v = view(
      "texture",
      (d) => {
        d.texture.enabled = true;
      },
      { width: 16, height: 8 },
    );
    expect(
      v.r.container.querySelector("[data-brush-texture-pattern]")!.textContent,
    ).toContain("16×8");
    const cases: Array<[string, string, object]> = [
      ["texture.scale", "2", { scale: 2 }],
      ["texture.brightness", "-20", { brightness: -20 }],
      ["texture.contrast", "35", { contrast: 35 }],
      ["texture.mode", "hardMix", { mode: "hardMix" }],
      ["texture.depth", "0.7", { depth: 0.7 }],
      ["texture.minDepth", "0.1", { minDepth: 0.1 }],
      [
        "texture.depthJitter.jitter",
        "0.3",
        { depthJitter: j({ jitter: 0.3 }) },
      ],
    ];
    for (const [f, value, patch] of cases) {
      v.set(f, value);
      expect(v.onDynamics).toHaveBeenLastCalledWith({ texture: patch });
    }
    expect(v.field("texture.mode")!.querySelectorAll("option")).toHaveLength(
      10,
    );
    v.tick("texture.invert");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      texture: { invert: true },
    });
    v.tick("texture.eachTip");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      texture: { eachTip: false },
    });
  });

  it("Dual Brush: mode, size, spacing, scatter, count, roundness, flip", () => {
    covers("panel:media.paged.image.panel.brushSettings");
    const v = view("dual", (d) => {
      d.dual.enabled = true;
    });
    const cases: Array<[string, string, object]> = [
      ["dual.mode", "darken", { mode: "darken" }],
      ["dual.diameter", "30", { diameter: 30 }],
      ["dual.spacing", "0.5", { spacing: 0.5 }],
      ["dual.scatter", "1.2", { scatter: 1.2 }],
      ["dual.count", "3", { count: 3 }],
      ["dual.roundness", "0.5", { roundness: 0.5 }],
    ];
    for (const [f, value, patch] of cases) {
      v.set(f, value);
      expect(v.onDynamics).toHaveBeenLastCalledWith({ dual: patch });
    }
    v.tick("dual.flip");
    expect(v.onDynamics).toHaveBeenLastCalledWith({ dual: { flip: true } });
    v.tick("dual.bothAxes");
    expect(v.onDynamics).toHaveBeenLastCalledWith({ dual: { bothAxes: true } });
  });

  it("Color Dynamics: per tip, FG/BG jitter, HSB jitters and purity", () => {
    covers("panel:media.paged.image.panel.brushSettings");
    const v = view("color", (d) => {
      d.color.enabled = true;
    });
    v.tick("color.perTip");
    expect(v.onDynamics).toHaveBeenLastCalledWith({ color: { perTip: false } });
    v.set("color.fgBg.jitter", "0.8");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      color: { fgBg: j({ jitter: 0.8 }) },
    });
    for (const [f, value] of [
      ["hue", "0.1"],
      ["saturation", "0.2"],
      ["brightness", "0.3"],
      ["purity", "-0.5"],
    ] as const) {
      v.set(`color.${f}`, value);
      expect(v.onDynamics).toHaveBeenLastCalledWith({
        color: { [f]: Number(value) },
      });
    }
  });

  it("Transfer: opacity and flow jitter with their controls and minimums", () => {
    covers("panel:media.paged.image.panel.brushSettings");
    const v = view("transfer", (d) => {
      d.transfer.enabled = true;
    });
    v.set("transfer.opacity.control", "pressure");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      transfer: { opacity: j({ control: "pressure" }) },
    });
    v.set("transfer.flow.minimum", "0.2");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      transfer: { flow: j({ minimum: 0.2 }) },
    });
    v.set("transfer.flow.jitter", "0.4");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      transfer: { flow: j({ jitter: 0.4 }) },
    });
  });

  it("Brush Pose: each value is live only under its override", () => {
    covers("panel:media.paged.image.panel.brushSettings");
    const v = view("pose", (d) => {
      d.pose.enabled = true;
      d.pose.overrideTilt = true;
    });
    expect(v.field("pose.rotation")!.disabled).toBe(true);
    v.set("pose.tiltX", "30");
    expect(v.onDynamics).toHaveBeenLastCalledWith({ pose: { tiltX: 30 } });
    v.set("pose.tiltY", "-15");
    expect(v.onDynamics).toHaveBeenLastCalledWith({ pose: { tiltY: -15 } });
    v.tick("pose.overrideRotation");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      pose: { overrideRotation: true },
    });
    v.tick("pose.overridePressure");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      pose: { overridePressure: true },
    });
  });

  it("the single-flag panes explain themselves", () => {
    covers("panel:media.paged.image.panel.brushSettings");
    for (const p of [
      "noise",
      "wetEdges",
      "buildUp",
      "protectTexture",
      "lockAlpha",
    ] as const) {
      const v = view(p);
      expect(
        v.r.container.querySelector("[data-brush-pane-note]")!.textContent!
          .length,
      ).toBeGreaterThan(10);
      cleanup();
    }
  });

  it("Smoothing: amount and the three catch-up options", () => {
    covers("panel:media.paged.image.panel.brushSettings");
    const v = view("smoothing");
    v.set("smoothing.amount", "0.5");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      smoothing: { amount: 0.5 },
    });
    for (const f of ["catchUp", "catchUpEnd", "zoomCompensation"]) {
      v.tick(`smoothing.${f}`);
      expect(v.onDynamics).toHaveBeenLastCalledWith({
        smoothing: { [f]: false },
      });
    }
  });

  it("Symmetry: kind, centre and angle; segments only for radial, mandala and spiral", () => {
    covers("panel:media.paged.image.panel.brushSettings");
    const off = view("symmetry");
    expect(off.field("symmetry.cx")!.disabled).toBe(true);
    expect(off.field("symmetry.kind")!.querySelectorAll("option")).toHaveLength(
      10,
    );
    off.set("symmetry.kind", "mandala");
    expect(off.onDynamics).toHaveBeenLastCalledWith({
      symmetry: { kind: "mandala" },
    });
    expect(off.field("symmetry.segments")).toBeNull();
    cleanup();
    const v = view("symmetry", (d) => {
      d.symmetry.kind = "radial";
    });
    v.set("symmetry.segments", "8");
    expect(v.onDynamics).toHaveBeenLastCalledWith({
      symmetry: { segments: 8 },
    });
    v.set("symmetry.cx", "0.25");
    expect(v.onDynamics).toHaveBeenLastCalledWith({ symmetry: { cx: 0.25 } });
    v.set("symmetry.angle", "45");
    expect(v.onDynamics).toHaveBeenLastCalledWith({ symmetry: { angle: 45 } });
  });

  it("Tool options: every paint tool's options reach their tool", () => {
    covers("panel:media.paged.image.panel.brushSettings");
    const v = view("tools");
    const sets: Array<[string, string, string, object]> = [
      ["smudge.strength", "0.8", "smudge", { strength: 0.8 }],
      ["mixer.wet", "0.1", "mixer", { wet: 0.1 }],
      ["mixer.load", "0.2", "mixer", { load: 0.2 }],
      ["mixer.mix", "0.3", "mixer", { mix: 0.3 }],
      ["mixer.flow", "0.4", "mixer", { flow: 0.4 }],
      ["history.source", "previous", "history", { source: "previous" }],
      ["artHistory.style", "looseCurl", "artHistory", { style: "looseCurl" }],
      ["artHistory.area", "120", "artHistory", { area: 120 }],
      ["artHistory.tolerance", "0.2", "artHistory", { tolerance: 0.2 }],
      ["artHistory.fidelity", "0.6", "artHistory", { fidelity: 0.6 }],
      [
        "backgroundEraser.sampling",
        "once",
        "backgroundEraser",
        { sampling: "once" },
      ],
      [
        "backgroundEraser.limits",
        "findEdges",
        "backgroundEraser",
        { limits: "findEdges" },
      ],
      [
        "backgroundEraser.tolerance",
        "0.3",
        "backgroundEraser",
        { tolerance: 0.3 },
      ],
      ["colorReplace.mode", "hue", "colorReplace", { mode: "hue" }],
      [
        "colorReplace.sampling",
        "swatch",
        "colorReplace",
        { sampling: "swatch" },
      ],
      [
        "colorReplace.limits",
        "discontiguous",
        "colorReplace",
        { limits: "discontiguous" },
      ],
      ["colorReplace.tolerance", "0.6", "colorReplace", { tolerance: 0.6 }],
      ["magicEraser.tolerance", "64", "magicEraser", { tolerance: 64 }],
      ["magicEraser.opacity", "0.5", "magicEraser", { opacity: 0.5 }],
    ];
    for (const [f, value, tool, patch] of sets) {
      v.set(f, value);
      expect(v.onTool).toHaveBeenLastCalledWith(tool, patch);
    }
    const ticks: Array<[string, string, object]> = [
      ["smudge.fingerPainting", "smudge", { fingerPainting: true }],
      ["smudge.sampleAll", "smudge", { sampleAll: true }],
      ["mixer.loadAfter", "mixer", { loadAfter: false }],
      ["mixer.cleanAfter", "mixer", { cleanAfter: false }],
      ["mixer.sampleAll", "mixer", { sampleAll: true }],
      [
        "backgroundEraser.protectForeground",
        "backgroundEraser",
        { protectForeground: true },
      ],
      ["magicEraser.antialias", "magicEraser", { antialias: false }],
      ["magicEraser.contiguous", "magicEraser", { contiguous: false }],
      ["magicEraser.sampleAll", "magicEraser", { sampleAll: true }],
    ];
    for (const [f, tool, patch] of ticks) {
      v.tick(f);
      expect(v.onTool).toHaveBeenLastCalledWith(tool, patch);
    }
    expect(
      v.r.container.querySelector("[data-brush-history-note]"),
    ).not.toBeNull();
  });

  it("renders in German", () => {
    covers("panel:media.paged.image.panel.brushSettings");
    setActiveStrings(createStrings("de", BUILT_IN_LOCALES.de));
    const v = view("shape", (d) => {
      d.shape.enabled = true;
    });
    const text = v.r.container.textContent!;
    expect(text).toContain("Pinseleinstellungen");
    expect(text).toContain("Formeigenschaften");
    expect(text).not.toContain("Shape Dynamics");
  });

  it("the connected panel follows the session and routes every change", () => {
    covers("panel:media.paged.image.panel.brushSettings");
    let dynamics = cloneDynamics(DEFAULT_BRUSH_DYNAMICS);
    const listeners = new Set<() => void>();
    const session: BrushSettingsSession = {
      state: () => ({
        brush: DEFAULT_BRUSH_PARAMS,
        dynamics,
        paintTools: DEFAULT_PAINT_TOOL_OPTIONS,
        pattern: null,
        gpu: false,
        strokeActive: false,
      }),
      setBrushParams: mock(() => {}),
      setBrushDynamics: mock((patch: DynamicsPatch) => {
        dynamics = patchDynamics(dynamics, patch);
        for (const l of listeners) l();
      }),
      setPaintToolOptions: mock(() => {}),
      onDidChange: (l) => {
        listeners.add(l);
        return { dispose: () => listeners.delete(l) };
      },
    };
    const Panel = makeBrushSettingsPanel(session);
    const r = render(<Panel />);
    expect(r.container.querySelector("[data-brush-needs-gpu]")).not.toBeNull();
    const angle = () =>
      r.container.querySelector(
        '[data-brush-field="tip.angle"]',
      ) as HTMLInputElement;
    act(() => {
      fireEvent.change(angle(), { target: { value: "15" } });
    });
    expect(session.setBrushDynamics).toHaveBeenCalledWith({
      tip: { angle: 15 },
    });
    expect(angle().value).toBe("15");
    act(() => {
      fireEvent.click(r.container.querySelector('[data-brush-pane="tools"]')!);
    });
    expect(
      r.container.querySelector('[data-brush-pane-body="tools"]'),
    ).not.toBeNull();
    act(() => {
      fireEvent.click(
        r.container.querySelector('[data-brush-field="smudge.sampleAll"]')!,
      );
    });
    expect(session.setPaintToolOptions).toHaveBeenCalledWith("smudge", {
      sampleAll: true,
    });
  });
});
