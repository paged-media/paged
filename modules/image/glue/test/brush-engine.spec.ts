// paged.image's BRUSH ENGINE in the bundle (WP5.7): the settings wire
// (packed BY NAME against the engine's own key list), the new tools'
// gestures, their tool-options fields, and the brush commands — over the
// real image-js wasm in Node, through the fake editor.
//
// Painted pixels are not here: every dab is a WGSL dispatch and Node has
// no navigator.gpu. The device proofs are image-js/tests/it/brush_engine.rs
// (and the Photoshop replay, brush_photoshop.rs). What IS here: what each
// tool and command hands the engine, and what the CPU-side doors (Define
// Brush Preset, the .abr reader and writer) produce.

import { describe, expect, it } from "bun:test";

import type { ToolContribution } from "@paged-media/plugin-api";
import { inMemoryToolSettings } from "@paged-media/plugin-sdk";
import { covers, gestures } from "@paged-media/test-kit";

import {
  COMBINE_MODES,
  DEFAULT_BRUSH_DYNAMICS,
  DEFAULT_PAINT_TOOL_OPTIONS,
  DYNAMICS_FIELDS,
  cloneDynamics,
  dynamicsActive,
  packDynamics,
  patchDynamics,
} from "../src/brush-dynamics";
import { createBrushMachine } from "../src/brush-machine";
import { deserializePresets } from "../src/brush-presets";
import { bundleOnFake, C, spyOn } from "./command-kit";
import { abrBytes } from "./fixtures/abr";

const T = "media.paged.image.tool";

/** Literal covers() per id (the surface gate reads them statically). */
const COVER_TOOL: Record<string, () => void> = {
  smudge: () => covers("tool:media.paged.image.tool.smudge"),
  mixerBrush: () => covers("tool:media.paged.image.tool.mixerBrush"),
  historyBrush: () => covers("tool:media.paged.image.tool.historyBrush"),
  artHistoryBrush: () => covers("tool:media.paged.image.tool.artHistoryBrush"),
  backgroundEraser: () =>
    covers("tool:media.paged.image.tool.backgroundEraser"),
  colorReplacement: () =>
    covers("tool:media.paged.image.tool.colorReplacement"),
};

const COVER_SETTING: Record<string, () => void> = {
  "smudge.size": () => covers("setting:media.paged.image.tool.smudge.size"),
  "smudge.strength": () =>
    covers("setting:media.paged.image.tool.smudge.strength"),
  "smudge.fingerPainting": () =>
    covers("setting:media.paged.image.tool.smudge.fingerPainting"),
  "smudge.sampleAll": () =>
    covers("setting:media.paged.image.tool.smudge.sampleAll"),
  "mixerBrush.size": () =>
    covers("setting:media.paged.image.tool.mixerBrush.size"),
  "mixerBrush.wet": () =>
    covers("setting:media.paged.image.tool.mixerBrush.wet"),
  "mixerBrush.load": () =>
    covers("setting:media.paged.image.tool.mixerBrush.load"),
  "mixerBrush.mix": () =>
    covers("setting:media.paged.image.tool.mixerBrush.mix"),
  "mixerBrush.flow": () =>
    covers("setting:media.paged.image.tool.mixerBrush.flow"),
  "mixerBrush.loadAfter": () =>
    covers("setting:media.paged.image.tool.mixerBrush.loadAfter"),
  "mixerBrush.cleanAfter": () =>
    covers("setting:media.paged.image.tool.mixerBrush.cleanAfter"),
  "mixerBrush.sampleAll": () =>
    covers("setting:media.paged.image.tool.mixerBrush.sampleAll"),
  "historyBrush.size": () =>
    covers("setting:media.paged.image.tool.historyBrush.size"),
  "historyBrush.opacity": () =>
    covers("setting:media.paged.image.tool.historyBrush.opacity"),
  "historyBrush.source": () =>
    covers("setting:media.paged.image.tool.historyBrush.source"),
  "artHistoryBrush.size": () =>
    covers("setting:media.paged.image.tool.artHistoryBrush.size"),
  "artHistoryBrush.style": () =>
    covers("setting:media.paged.image.tool.artHistoryBrush.style"),
  "artHistoryBrush.area": () =>
    covers("setting:media.paged.image.tool.artHistoryBrush.area"),
  "artHistoryBrush.tolerance": () =>
    covers("setting:media.paged.image.tool.artHistoryBrush.tolerance"),
  "backgroundEraser.size": () =>
    covers("setting:media.paged.image.tool.backgroundEraser.size"),
  "backgroundEraser.sampling": () =>
    covers("setting:media.paged.image.tool.backgroundEraser.sampling"),
  "backgroundEraser.limits": () =>
    covers("setting:media.paged.image.tool.backgroundEraser.limits"),
  "backgroundEraser.tolerance": () =>
    covers("setting:media.paged.image.tool.backgroundEraser.tolerance"),
  "backgroundEraser.protectForeground": () =>
    covers("setting:media.paged.image.tool.backgroundEraser.protectForeground"),
  "colorReplacement.size": () =>
    covers("setting:media.paged.image.tool.colorReplacement.size"),
  "colorReplacement.mode": () =>
    covers("setting:media.paged.image.tool.colorReplacement.mode"),
  "colorReplacement.sampling": () =>
    covers("setting:media.paged.image.tool.colorReplacement.sampling"),
  "colorReplacement.limits": () =>
    covers("setting:media.paged.image.tool.colorReplacement.limits"),
  "colorReplacement.tolerance": () =>
    covers("setting:media.paged.image.tool.colorReplacement.tolerance"),
  "magicEraser.tolerance": () =>
    covers("setting:media.paged.image.tool.magicEraser.tolerance"),
  "magicEraser.antialias": () =>
    covers("setting:media.paged.image.tool.magicEraser.antialias"),
  "magicEraser.contiguous": () =>
    covers("setting:media.paged.image.tool.magicEraser.contiguous"),
  "magicEraser.sampleAll": () =>
    covers("setting:media.paged.image.tool.magicEraser.sampleAll"),
  "magicEraser.opacity": () =>
    covers("setting:media.paged.image.tool.magicEraser.opacity"),
};

async function ingested(options?: Parameters<typeof bundleOnFake>[0]) {
  const k = await bundleOnFake(options);
  await k.ingest();
  return k;
}
type K = Awaited<ReturnType<typeof ingested>>;

async function strokeSequence(k: K, tool: string) {
  const calls = spyOn(k.session, {
    brushBegin: true,
    brushExtend: true,
    brushCommit: true,
  });
  await gestures(k.toolTarget)
    .tool(tool)
    .settle()
    .drag({ from: [25, 25], to: [175, 75], steps: 3 })
    .settle();
  return calls;
}

describe("the settings wire", () => {
  it("the engine's key list is filled entirely by name", async () => {
    const k = await ingested();
    // The real wasm's list: every key it reads, this glue can fill.
    const wasm = await import("../wasm/image_js.js");
    const keys = (wasm as unknown as { brush_dynamics_keys(): string })
      .brush_dynamics_keys()
      .split("\n")
      .filter(Boolean);
    expect(keys.length).toBeGreaterThan(100);
    expect(keys.filter((k2) => !DYNAMICS_FIELDS.has(k2))).toEqual([]);
    k.dispose();
  });

  it("the combine modes are the engine's, in its order", async () => {
    const wasm = (await import("../wasm/image_js.js")) as unknown as {
      brush_combine_modes(): string;
    };
    expect(wasm.brush_combine_modes().split("\n")).toEqual([...COMBINE_MODES]);
  });

  it("packs by name: a reordered key list moves every value with its key", () => {
    const o = {
      dynamics: patchDynamics(DEFAULT_BRUSH_DYNAMICS, {
        tip: { angle: 30, roundness: 0.5 },
      }),
      tools: DEFAULT_PAINT_TOOL_OPTIONS,
      seed: 7,
      background: [1, 1, 1, 1] as [number, number, number, number],
      smoothingRadiusPx: 0,
    };
    const a = packDynamics(["seed", "tip.angle", "nope"], o);
    expect([...a.values]).toEqual([7, 30, 0]);
    expect(a.unknown).toEqual(["nope"]);
    const b = packDynamics(["tip.roundness", "seed"], o);
    expect([...b.values]).toEqual([0.5, 7]);
  });

  it("a patch merges each jitter field by field and leaves the source alone", () => {
    const d = cloneDynamics(DEFAULT_BRUSH_DYNAMICS);
    const p = patchDynamics(d, {
      shape: {
        enabled: true,
        size: { jitter: 0.4, control: "pressure", fadeSteps: 25, minimum: 0 },
      },
    });
    expect(p.shape.size.control).toBe("pressure");
    expect(p.shape.angle).toEqual(d.shape.angle);
    expect(d.shape.enabled).toBe(false);
    expect(dynamicsActive(d)).toBe(false);
    expect(dynamicsActive(p)).toBe(true);
  });

  it("the machine sends a pen's tilt, and re-queues a held sample", () => {
    const m = createBrushMachine();
    m.down([1, 2], 0.5, "pen", { tiltX: 30, tiltY: -10 });
    expect(m.next()).toEqual({
      x: 1,
      y: 2,
      pressure: 0.5,
      tiltX: 30,
      tiltY: -10,
    });
    expect(m.hold()).toBe(true);
    expect(m.next()?.x).toBe(1);
    // A mouse never claims a tilt.
    const mouse = createBrushMachine();
    mouse.down([1, 2], 0.5, "mouse", { tiltX: 30 });
    expect(mouse.next()).toEqual({ x: 1, y: 2, pressure: 1 });
  });
});

describe("brush engine tools", () => {
  for (const [id, wire] of [
    ["smudge", "smudge"],
    ["mixerBrush", "mixer"],
    ["historyBrush", "history"],
    ["artHistoryBrush", "art-history"],
    ["backgroundEraser", "background-eraser"],
    ["colorReplacement", "color-replace"],
  ] as const) {
    it(`${id}: one stroke is begin("${wire}") → extend per sample → one commit; in Node it declines for the GPU`, async () => {
      COVER_TOOL[id]();
      const k = await ingested();
      await gestures(k.toolTarget)
        .tool(`${T}.${id}`)
        .settle()
        .drag({ from: [25, 25], to: [175, 75] })
        .settle();
      expect(k.session.state().status).toMatch(/GPU-only/);
      expect(k.session.state().history?.depth).toBe(0);
      expect(k.docOps()).toEqual([]);
      const calls = await strokeSequence(k, `${T}.${id}`);
      expect(calls[0]).toBe(`brushBegin("${wire}")`);
      expect(calls.filter((c) => c.startsWith("brushExtend")).length).toBe(
        calls.length - 2,
      );
      expect(calls.at(-1)).toBe("brushCommit()");
      k.dispose();
    });
  }

  it("magic eraser: a click erases at the image pixel; in Node it declines for the GPU", async () => {
    covers("tool:media.paged.image.tool.magicEraser");
    const k = await ingested();
    await gestures(k.toolTarget)
      .tool(`${T}.magicEraser`)
      .settle()
      .click([175, 25])
      .settle();
    expect(k.session.state().status).toMatch(/GPU-only/);
    expect(k.session.state().history?.depth).toBe(0);
    const calls = spyOn(k.session, { magicErase: true });
    await gestures(k.toolTarget)
      .tool(`${T}.magicEraser`)
      .settle()
      .click([175, 25])
      .settle();
    expect(calls).toEqual(["magicErase([3.5,0.5])"]);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("a smoothed brush hands its string length to begin; a plain one does not", async () => {
    covers("tool:media.paged.image.tool.brush");
    const k = await ingested();
    k.session.setBrushDynamics({ smoothing: { amount: 0.5 } });
    const calls = await strokeSequence(k, `${T}.brush`);
    expect(calls[0]).toMatch(/^brushBegin\("brush",\{"smoothingRadiusPx":\d/);
    k.dispose();
  });
});

async function withSettings() {
  const settings = inMemoryToolSettings();
  const k = await bundleOnFake({ toolSettings: settings });
  await k.ingest();
  const field = (tool: string, key: string) =>
    (
      k.fake.tools.get(`${T}.${tool}`) as unknown as ToolContribution
    ).options?.fields.find((f) => f.key === key);
  return { k, settings, field, state: () => k.session.state() };
}

describe("brush engine tool options", () => {
  it("brush · lock transparent pixels and symmetry", async () => {
    covers("setting:media.paged.image.tool.brush.lockAlpha");
    covers("setting:media.paged.image.tool.brush.symmetry");
    const { k, settings, field, state } = await withSettings();
    expect(field("brush", "lockAlpha")).toMatchObject({ kind: "toggle" });
    settings.set(`${T}.brush`, "lockAlpha", true);
    expect(state().dynamics.lockAlpha).toBe(true);
    expect(field("brush", "symmetry")).toMatchObject({ kind: "select" });
    settings.set(`${T}.brush`, "symmetry", "mandala");
    expect(state().dynamics.symmetry.kind).toBe("mandala");
    settings.set(`${T}.brush`, "symmetry", "nonsense");
    expect(state().dynamics.symmetry.kind).toBe("mandala");
    k.dispose();
  });

  const cases: Array<
    [
      tool: string,
      key: string,
      value: unknown,
      read: (s: any) => unknown,
      want: unknown,
    ]
  > = [
    ["smudge", "size", 33, (s) => s.brush.size, 33],
    ["smudge", "strength", 70, (s) => s.paintTools.smudge.strength, 0.7],
    [
      "smudge",
      "fingerPainting",
      true,
      (s) => s.paintTools.smudge.fingerPainting,
      true,
    ],
    ["smudge", "sampleAll", true, (s) => s.paintTools.smudge.sampleAll, true],
    ["mixerBrush", "size", 21, (s) => s.brush.size, 21],
    ["mixerBrush", "wet", 20, (s) => s.paintTools.mixer.wet, 0.2],
    ["mixerBrush", "load", 40, (s) => s.paintTools.mixer.load, 0.4],
    ["mixerBrush", "mix", 60, (s) => s.paintTools.mixer.mix, 0.6],
    ["mixerBrush", "flow", 80, (s) => s.paintTools.mixer.flow, 0.8],
    [
      "mixerBrush",
      "loadAfter",
      false,
      (s) => s.paintTools.mixer.loadAfter,
      false,
    ],
    [
      "mixerBrush",
      "cleanAfter",
      false,
      (s) => s.paintTools.mixer.cleanAfter,
      false,
    ],
    [
      "mixerBrush",
      "sampleAll",
      true,
      (s) => s.paintTools.mixer.sampleAll,
      true,
    ],
    ["historyBrush", "size", 12, (s) => s.brush.size, 12],
    ["historyBrush", "opacity", 50, (s) => s.brush.opacity, 0.5],
    [
      "historyBrush",
      "source",
      "previous",
      (s) => s.paintTools.history.source,
      "previous",
    ],
    ["artHistoryBrush", "size", 9, (s) => s.brush.size, 9],
    [
      "artHistoryBrush",
      "style",
      "looseCurl",
      (s) => s.paintTools.artHistory.style,
      "looseCurl",
    ],
    ["artHistoryBrush", "area", 120, (s) => s.paintTools.artHistory.area, 120],
    [
      "artHistoryBrush",
      "tolerance",
      30,
      (s) => s.paintTools.artHistory.tolerance,
      0.3,
    ],
    ["backgroundEraser", "size", 17, (s) => s.brush.size, 17],
    [
      "backgroundEraser",
      "sampling",
      "once",
      (s) => s.paintTools.backgroundEraser.sampling,
      "once",
    ],
    [
      "backgroundEraser",
      "limits",
      "findEdges",
      (s) => s.paintTools.backgroundEraser.limits,
      "findEdges",
    ],
    [
      "backgroundEraser",
      "tolerance",
      25,
      (s) => s.paintTools.backgroundEraser.tolerance,
      0.25,
    ],
    [
      "backgroundEraser",
      "protectForeground",
      true,
      (s) => s.paintTools.backgroundEraser.protectForeground,
      true,
    ],
    ["colorReplacement", "size", 19, (s) => s.brush.size, 19],
    [
      "colorReplacement",
      "mode",
      "hue",
      (s) => s.paintTools.colorReplace.mode,
      "hue",
    ],
    [
      "colorReplacement",
      "sampling",
      "swatch",
      (s) => s.paintTools.colorReplace.sampling,
      "swatch",
    ],
    [
      "colorReplacement",
      "limits",
      "discontiguous",
      (s) => s.paintTools.colorReplace.limits,
      "discontiguous",
    ],
    [
      "colorReplacement",
      "tolerance",
      45,
      (s) => s.paintTools.colorReplace.tolerance,
      0.45,
    ],
    [
      "magicEraser",
      "tolerance",
      64,
      (s) => s.paintTools.magicEraser.tolerance,
      64,
    ],
    [
      "magicEraser",
      "antialias",
      false,
      (s) => s.paintTools.magicEraser.antialias,
      false,
    ],
    [
      "magicEraser",
      "contiguous",
      false,
      (s) => s.paintTools.magicEraser.contiguous,
      false,
    ],
    [
      "magicEraser",
      "sampleAll",
      true,
      (s) => s.paintTools.magicEraser.sampleAll,
      true,
    ],
    [
      "magicEraser",
      "opacity",
      40,
      (s) => s.paintTools.magicEraser.opacity,
      0.4,
    ],
  ];
  for (const [tool, key, value, read, want] of cases) {
    it(`${tool} · ${key}`, async () => {
      COVER_SETTING[`${tool}.${key}`]!();
      const { k, settings, field, state } = await withSettings();
      expect(field(tool, key)).toBeDefined();
      settings.set(`${T}.${tool}`, key, value as never);
      expect(read(state())).toBe(want);
      k.dispose();
    });
  }
});

describe("brush commands", () => {
  it("openBrushSettings / openBrushPresets raise their panels and touch nothing", async () => {
    covers("command:media.paged.image.command.openBrushSettings");
    covers("command:media.paged.image.command.openBrushPresets");
    const k = await bundleOnFake();
    await k.run(`${C}.openBrushSettings`);
    await k.run(`${C}.openBrushPresets`);
    expect(k.opened).toEqual([
      "media.paged.image.panel.brushSettings",
      "media.paged.image.panel.brushPresets",
    ]);
    expect(k.fake.mutations).toEqual([]);
    k.dispose();
  });

  it("defineBrushPreset turns the image's pixels into a sampled tip, applies it, and refuses without an image", async () => {
    covers("command:media.paged.image.command.defineBrushPreset");
    const none = await bundleOnFake({ select: false });
    await none.run(`${C}.defineBrushPreset`);
    expect(none.session.state().status).toMatch(/needs an image/);
    none.dispose();
    const k = await ingested();
    const before = k.session.state().brushPresets.length;
    await k.run(`${C}.defineBrushPreset`);
    const s = k.session.state();
    expect(s.brushPresets.length).toBe(before + 1);
    const p = s.brushPresets.at(-1)!;
    expect(p.source).toBe("defined");
    expect([p.dynamics.bitmap?.width, p.dynamics.bitmap?.height]).toEqual([
      4, 2,
    ]);
    // Red and blue are dark: both paint (blue, the darker, more).
    const a = p.dynamics.bitmap!.alpha;
    expect(a[0]).toBeGreaterThan(150);
    expect(a[3]).toBeGreaterThan(a[0]);
    expect(s.brushPresetActive).toBe(p.id);
    expect(s.dynamics.bitmap?.id).toBe(p.id);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("importBrushPresets adds an .abr's presets to the library, and a paged .json's", async () => {
    covers("command:media.paged.image.command.importBrushPresets");
    const asked: unknown[] = [];
    const k = await bundleOnFake({
      shell: {
        pickFile: async (o: unknown) => {
          asked.push(o);
          return [
            {
              name: "round.abr",
              bytes: abrBytes([
                { name: "Hard Round 9", diameter: 9, hardness: 1 },
              ]),
            },
          ];
        },
      } as never,
    });
    const before = k.session.state().brushPresets.length;
    await k.run(`${C}.importBrushPresets`);
    expect(asked).toEqual([{ accept: [".abr", ".json"] }]);
    const added = k.session.state().brushPresets.slice(before);
    expect(added.map((p) => [p.name, p.source, p.params.size])).toEqual([
      ["Hard Round 9", "abr", 9],
    ]);
    k.dispose();
  });

  it("exportBrushPresetsJson writes the library in the session's own format", async () => {
    covers("command:media.paged.image.command.exportBrushPresetsJson");
    const saved: Array<{ suggestedName: string; bytes: Uint8Array }> = [];
    const k = await bundleOnFake({
      shell: { saveFile: async (o) => (saved.push(o), true) },
    });
    await k.run(`${C}.exportBrushPresetsJson`);
    expect(saved.map((s) => s.suggestedName)).toEqual(["brush-presets.json"]);
    const back = deserializePresets(new TextDecoder().decode(saved[0].bytes));
    expect(back.map((p) => p.name)).toEqual(
      k.session.state().brushPresets.map((p) => p.name),
    );
    k.dispose();
  });

  it("exportBrushPresetsAbr writes an .abr the reader reads back preset for preset", async () => {
    covers("command:media.paged.image.command.exportBrushPresetsAbr");
    const saved: Array<{ suggestedName: string; bytes: Uint8Array }> = [];
    const k = await bundleOnFake({
      shell: { saveFile: async (o) => (saved.push(o), true) },
    });
    await k.run(`${C}.exportBrushPresetsAbr`);
    expect(saved.map((s) => s.suggestedName)).toEqual(["brush-presets.abr"]);
    const wasm = (await import("../wasm/image_js.js")) as unknown as {
      abr_presets(b: Uint8Array): string;
    };
    const lib = JSON.parse(wasm.abr_presets(saved[0].bytes)) as {
      presets: Array<{ name: string; diameter: number }>;
      warnings: string[];
    };
    const mine = k.session.state().brushPresets;
    expect(lib.presets.map((p) => p.name)).toEqual(mine.map((p) => p.name));
    expect(lib.presets.map((p) => p.diameter)).toEqual(
      mine.map((p) => p.params.size),
    );
    k.dispose();
  });

  it("toggleLockTransparent flips Lock Transparent Pixels for every paint tool", async () => {
    covers("command:media.paged.image.command.toggleLockTransparent");
    const k = await bundleOnFake();
    expect(k.session.state().dynamics.lockAlpha).toBe(false);
    await k.run(`${C}.toggleLockTransparent`);
    expect(k.session.state().dynamics.lockAlpha).toBe(true);
    await k.run(`${C}.toggleLockTransparent`);
    expect(k.session.state().dynamics.lockAlpha).toBe(false);
    expect(k.fake.mutations).toEqual([]);
    k.dispose();
  });
});
