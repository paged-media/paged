// Image ADR 477 — history snapshots, History Options and the Preset
// Manager in the image context, through the bundle as the editor loads it
// (the fake editor, the real image engine).

import { describe, expect, it } from "bun:test";

import { mapBacking } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import { contextHistory } from "../src/context-history";
import type { GradientValue } from "../src/engine";
import {
  adjustFromJson,
  adjustToJson,
  appendEntries,
  deleteEntry,
  gradientEnds,
  moveEntry,
  parseLibrary,
  renameEntry,
  serializeLibrary,
  type PresetEntry,
} from "../src/preset-library";
import { clampHistoryPrefs } from "../src/preset-store";
import { historySourceChoices } from "../src/panels/sections/history-section";
import { emptyStyle, setEffectEnabled } from "../src/layer-style";
import { C, bundleOnFake, imageEngine, quiesce } from "./command-kit";

const FEAT = "[image.editor.snapshots-presets]";

describe(`${FEAT} history snapshots`, () => {
  it("takes the first snapshot on open, and a command takes more", async () => {
    const k = await bundleOnFake();
    await k.ingest();
    const h0 = k.session.state().history!;
    expect(h0.snapshots.map((s) => s.name)).toEqual(["Opened"]);
    expect(h0.undoSteps).toEqual([]);

    covers("command:media.paged.image.command.newSnapshot");
    await k.run(`${C}.rotateCw`);
    await k.run(`${C}.newSnapshot`);
    const h1 = k.session.state().history!;
    expect(h1.snapshots.map((s) => s.name)).toEqual(["Opened", "Snapshot 2"]);
    expect(h1.undoSteps).toEqual(["Rotate 90° clockwise"]);
    k.dispose();
  });

  it("restores a snapshot as one undo step, renames and deletes", async () => {
    const k = await bundleOnFake();
    await k.ingest();
    const opened = k.session.state().history!.snapshots[0]!;
    await k.run(`${C}.rotateCw`);
    expect(k.session.state().source).toMatchObject({ width: 2, height: 4 });

    expect(await k.session.restoreSnapshot(opened.id)).toBe(true);
    await quiesce(k.session);
    expect(k.session.state().source).toMatchObject({ width: 4, height: 2 });
    expect(k.session.state().history!.undoSteps).toEqual([
      "Rotate 90° clockwise",
      "Restore Opened",
    ]);
    // One undo returns to where the user was.
    await k.session.undo();
    await quiesce(k.session);
    expect(k.session.state().source).toMatchObject({ width: 2, height: 4 });

    expect(k.session.renameSnapshot(opened.id, "Start")).toBe(true);
    expect(k.session.state().history!.snapshots[0]!.name).toBe("Start");
    expect(k.session.deleteSnapshot(opened.id)).toBe(true);
    expect(k.session.state().history!.snapshots).toEqual([]);
    k.dispose();
  });

  it("lists the snapshots in the host's History panel, Photoshop's way", async () => {
    const k = await bundleOnFake();
    await k.ingest();
    const ctx = k.contexts.find((c) => c.type === "rasterImage")!;
    await k.run(`${C}.rotateCw`);
    await k.run(`${C}.flipHorizontal`);
    const h = ctx.historySteps!()!;
    expect(h.undo).toEqual([
      "Snapshot: Opened",
      "Oldest kept state",
      "Rotate 90° clockwise",
      "Flip horizontal",
    ]);
    // A click on the snapshot row (index 0): delta = -(n - 1 - 0).
    await h.step(-(h.undo.length - 1));
    await quiesce(k.session);
    const after = ctx.historySteps!()!;
    expect(after.undo.at(-1)).toBe("Restore Opened");
    expect(k.session.state().source).toMatchObject({ width: 4, height: 2 });
    // The state row undoes every kept step.
    const n = after.undo.length;
    await after.step(-(n - 1 - 1));
    await quiesce(k.session);
    expect(k.session.state().history!.undoSteps).toEqual([]);
    expect(ctx.historySteps!()!.redo).toHaveLength(3);
    k.dispose();
  });

  it("walks steps as before when there are no snapshots", () => {
    const calls: string[] = [];
    const session = {
      state: () =>
        ({
          history: {
            undoSteps: ["a", "b"],
            redoSteps: ["c"],
            snapshots: [],
          },
        }) as never,
      undoSteps: async (n: number) => (calls.push(`undo ${n}`), true),
      redoSteps: async (n: number) => (calls.push(`redo ${n}`), true),
      restoreSnapshot: async (id: number) => (
        calls.push(`restore ${id}`),
        true
      ),
    };
    const h = contextHistory(session)!;
    expect(h.undo).toEqual(["a", "b"]);
    void h.step(-1);
    void h.step(1);
    expect(calls).toEqual(["undo 1", "redo 1"]);
  });

  it("offers every step and snapshot as a History brush source", () => {
    const choices = historySourceChoices({
      undoSteps: ["Paint"],
      undoIds: [7],
      redoSteps: ["Fill"],
      redoIds: [8],
      snapshots: [{ id: 2, name: "Opened", width: 4, height: 2 }],
    } as never);
    expect(choices.map((c) => c.value)).toEqual([
      "open",
      "previous",
      "snapshot:2",
      "step:7",
      "step:8",
    ]);
    expect(historySourceChoices(null)).toHaveLength(2);
  });

  it("the engine takes a step or a snapshot as the History brush source", async () => {
    const k = await bundleOnFake();
    await k.ingest();
    const eng = await imageEngine();
    const h = k.session.state().history!;
    k.session.setPaintToolOptions("history", {
      source: `snapshot:${h.snapshots[0]!.id}`,
    });
    expect(k.session.state().paintTools.history.source).toBe(
      `snapshot:${h.snapshots[0]!.id}`,
    );
    // Outside a stroke the door refuses by name, not by the source.
    expect(() => eng.brushSetHistorySource("step:1")).toThrow(/stroke/);
    k.dispose();
  });
});

describe(`${FEAT} History Options`, () => {
  it("raises the 32-step cap, keeps the preference, and a new session applies it", async () => {
    const storage = mapBacking();
    const k = await bundleOnFake({ storage });
    await k.ingest();
    expect(k.session.state().history!.maxEntries).toBe(32);

    covers("command:media.paged.image.command.historyOptions");
    await k.run(`${C}.historyOptions`);
    expect(k.session.state().dialog).toEqual({ kind: "historyOptions" });
    const set = k.session.setHistoryPrefs({ depth: 120, memoryMb: 512 });
    expect(set).toMatchObject({ depth: 120, memoryMb: 512 });
    expect(k.session.state().history!.maxEntries).toBe(120);
    expect(k.session.state().history!.maxBytes).toBe(512 * 1024 * 1024);
    k.dispose();

    const again = await bundleOnFake({ storage });
    expect(again.session.state().historyPrefs.depth).toBe(120);
    await again.ingest();
    expect(again.session.state().history!.maxEntries).toBe(120);
    again.dispose();
  });

  it("clamps what it stores", () => {
    expect(clampHistoryPrefs({ depth: 0, memoryMb: 1e9 })).toEqual({
      depth: 1,
      memoryMb: 2048,
      autoSnapshot: true,
    });
    expect(clampHistoryPrefs({ autoSnapshot: false }).autoSnapshot).toBe(false);
  });

  it("without the automatic snapshot, an opened image has none", async () => {
    const storage = mapBacking();
    const k = await bundleOnFake({ storage });
    k.session.setHistoryPrefs({ autoSnapshot: false });
    await k.ingest();
    expect(k.session.state().history!.snapshots).toEqual([]);
    k.dispose();
  });
});

describe(`${FEAT} the preset library model`, () => {
  const list: PresetEntry[] = [
    { id: "a", name: "A", builtIn: true },
    { id: "b", name: "B" },
  ];
  it("renames, deletes (never a built-in) and moves by identity", () => {
    expect(renameEntry(list, "a", " Alpha ")[0]!.name).toBe("Alpha");
    expect(renameEntry(list, "a", "  ")).toBe(list);
    expect(deleteEntry(list, "a")).toBe(list);
    expect(deleteEntry(list, "b")).toEqual([list[0]]);
    expect(moveEntry(list, 0, 1).map((p) => p.id)).toEqual(["b", "a"]);
    expect(moveEntry(list, 0, 5)).toBe(list);
    expect(appendEntries(list, "x", [{ name: "C" }]).at(-1)).toEqual({
      id: "x-3",
      name: "C",
    });
  });

  it("round-trips adjustment params, curve tables included", () => {
    const p = adjustFromJson({ exposureEv: 1.5, unknown: 3 });
    expect(p.exposureEv).toBe(1.5);
    p.curveLut = Uint8Array.from({ length: 256 }, (_, i) => 255 - i);
    const back = adjustFromJson(JSON.parse(JSON.stringify(adjustToJson(p))));
    expect(back.exposureEv).toBe(1.5);
    expect(Array.from(back.curveLut!)).toEqual(Array.from(p.curveLut));
  });

  it("refuses a library of another kind, by name", () => {
    const text = serializeLibrary("tools", []);
    expect(() => parseLibrary(text, "adjustments")).toThrow(/holds tools/);
    expect(() => parseLibrary("{", "tools")).toThrow(/not JSON/);
  });

  it("a gradient's ends are its first and last stops", () => {
    const g: GradientValue = {
      name: "g",
      smoothness: 100,
      stops: [
        { at: 1, rgb: [0, 0, 255], midpoint: 0.5 },
        { at: 0, rgb: [255, 0, 0], midpoint: 0.5 },
      ],
      opacityStops: [
        { at: 0, opacity: 1, midpoint: 0.5 },
        { at: 1, opacity: 0.5, midpoint: 0.5 },
      ],
    };
    expect(gradientEnds(g)).toEqual({
      first: [1, 0, 0, 1],
      last: [0, 0, 1, 0.5],
    });
  });
});

describe(`${FEAT} the Preset Manager`, () => {
  it("opens on a kind and lists, renames, reorders and deletes", async () => {
    const k = await bundleOnFake();
    covers("command:media.paged.image.command.presetManager");
    await k.run(`${C}.presetManager`);
    expect(k.session.state().dialog).toEqual({
      kind: "presetManager",
      tab: "brushes",
    });
    k.session.setPresetManagerTab("gradients");
    expect(k.session.state().dialog).toEqual({
      kind: "presetManager",
      tab: "gradients",
    });
    const g = k.session.state().gradientPresets;
    expect(g.map((p) => p.id)).toEqual([
      "builtin-black-white",
      "builtin-spectrum",
      "builtin-black-transparent",
    ]);
    expect(k.session.renamePresetOf("gradients", g[1]!.id, "Rainbow")).toBe(
      true,
    );
    expect(k.session.movePresetOf("gradients", 1, 0)).toBe(true);
    expect(k.session.state().gradientPresets[0]!.name).toBe("Rainbow");
    expect(k.session.deletePresetOf("gradients", g[0]!.id)).toBe(false);
    k.dispose();
  });

  it("keeps tool, adjustment and gradient presets for the next session", async () => {
    const storage = mapBacking();
    const k = await bundleOnFake({ storage });
    await k.session.presetsLoaded();
    k.session.setBrushParams({ size: 77, opacity: 0.4 });
    k.session.setParams({ exposureEv: 0.75 });
    expect(await k.session.savePresetOf("tools", "Big soft")).toBe(true);
    expect(await k.session.savePresetOf("adjustments", "Brighter")).toBe(true);
    expect(await k.session.savePresetOf("gradients", "Mine")).toBe(true);
    const brushes = k.session.state().brushPresets;
    k.session.renamePresetOf("brushes", brushes[0]!.id, "First brush");
    k.dispose();

    const again = await bundleOnFake({ storage });
    await again.session.presetsLoaded();
    const s = again.session.state();
    expect(s.toolPresets.map((p) => p.name)).toEqual(["Big soft"]);
    expect(s.adjustmentPresets[0]!.params.exposureEv).toBe(0.75);
    expect(s.gradientPresets.at(-1)!.name).toBe("Mine");
    expect(s.brushPresets[0]!.name).toBe("First brush");
    // Applying the tool preset brings the brush back.
    again.session.setBrushParams({ size: 5 });
    expect(
      await again.session.applyPresetOf("tools", s.toolPresets[0]!.id),
    ).toBe(true);
    expect(again.session.state().brush.size).toBe(77);
    expect(
      await again.session.applyPresetOf(
        "adjustments",
        s.adjustmentPresets[0]!.id,
      ),
    ).toBe(true);
    expect(again.session.state().params.exposureEv).toBe(0.75);
    again.dispose();
  });

  it("keeps saved layer styles for the next session (they were session-only)", async () => {
    const storage = mapBacking();
    const k = await bundleOnFake({ storage });
    await k.ingest();
    await k.session.presetsLoaded();
    const style = setEffectEnabled(emptyStyle(), "dropShadow", true);
    await k.session.setLayerStyle(0, style);
    await quiesce(k.session);
    expect(await k.session.savePresetOf("styles", "Lifted")).toBe(true);
    k.dispose();

    const again = await bundleOnFake({ storage });
    await again.session.presetsLoaded();
    const saved = again.session
      .state()
      .stylePresets.find((p) => p.name === "Lifted");
    expect(saved?.style.dropShadows).toHaveLength(1);
    again.dispose();
  });

  it("imports and exports Photoshop .grd, .pat and .asl through the engine", async () => {
    const k = await bundleOnFake();
    await k.session.presetsLoaded();
    const eng = await imageEngine();

    // .grd: the bundle's own gradients, written and read back.
    const grd = await k.session.exportPresetBytes("gradients");
    expect(grd?.name).toBe("gradients.grd");
    const before = k.session.state().gradientPresets.length;
    expect(
      await k.session.importPresetBytes("gradients", "g.grd", grd!.bytes),
    ).toBe(true);
    const gs = k.session.state().gradientPresets;
    expect(gs).toHaveLength(before * 2);
    expect(gs.at(-2)!.gradient.stops).toHaveLength(7);

    // .pat: two patterns, one with transparency.
    const rgba = new Uint8Array([
      ...[10, 20, 30, 255, 40, 50, 60, 255],
      ...[1, 2, 3, 128],
    ]);
    const pat = eng.presetsWritePat(
      [
        { name: "Two", id: "p-two", width: 2, height: 1 },
        { name: "One", id: "p-one", width: 1, height: 1 },
      ],
      rgba,
    );
    expect(await k.session.importPresetBytes("patterns", "p.pat", pat)).toBe(
      true,
    );
    const ps = k.session.state().patternPresets;
    expect(ps.map((p) => [p.name, p.psId, p.width])).toEqual([
      ["Two", "p-two", 2],
      ["One", "p-one", 1],
    ]);
    expect(Array.from(ps[1]!.rgba)).toEqual([1, 2, 3, 128]);
    // Importing the same file again adds nothing twice.
    await k.session.importPresetBytes("patterns", "p.pat", pat);
    expect(k.session.state().patternPresets).toHaveLength(2);
    const patOut = await k.session.exportPresetBytes("patterns");
    expect(eng.presetsReadPat(patOut!.bytes).patterns.map((p) => p.id)).toEqual(
      ["p-two", "p-one"],
    );

    // .asl: a style drawing a pattern brings the pattern with it.
    const style = setEffectEnabled(emptyStyle(), "patternOverlay", true);
    style.patternOverlay!.fill.pattern = { name: "Dots", id: "p-dots" };
    const asl = eng.presetsWriteAsl(
      [{ name: "Dotted", id: "s-1", style }],
      [{ name: "Dots", id: "p-dots", width: 1, height: 1 }],
      new Uint8Array([9, 9, 9, 255]),
    );
    expect(await k.session.importPresetBytes("styles", "s.asl", asl)).toBe(
      true,
    );
    const st = k.session.state();
    expect(st.stylePresets.at(-1)).toMatchObject({
      name: "Dotted",
      psId: "s-1",
    });
    expect(st.patternPresets.at(-1)).toMatchObject({
      name: "Dots",
      psId: "p-dots",
    });
    const aslOut = await k.session.exportPresetBytes("styles");
    const back = eng.presetsReadAsl(aslOut!.bytes);
    expect(back.styles.map((s) => s.name)).toContain("Dotted");
    expect(back.patterns.map((p) => p.id)).toEqual(["p-dots"]);
    k.dispose();
  });

  it("imports through the picker and exports through the saver", async () => {
    let saved: { suggestedName: string; bytes: Uint8Array } | null = null;
    const json = new TextEncoder().encode(
      serializeLibrary("adjustments", [
        {
          id: "x",
          name: "Warm",
          params: adjustFromJson({ temp: 0.3 }),
        },
      ]),
    );
    const k = await bundleOnFake({
      shell: {
        pickFile: async () => [{ name: "warm.json", bytes: json }],
        saveFile: async (o: { suggestedName: string; bytes: Uint8Array }) => {
          saved = o;
          return true;
        },
      } as never,
    });
    await k.session.presetsLoaded();
    expect(await k.session.importPresetsOf("adjustments")).toBe(true);
    expect(k.session.state().adjustmentPresets[0]!.params.temp).toBeCloseTo(
      0.3,
    );
    expect(await k.session.exportPresetsOf("adjustments")).toBe(true);
    expect(saved!.suggestedName).toBe("adjustments.json");
    expect(
      parseLibrary(new TextDecoder().decode(saved!.bytes), "adjustments")[0]!
        .name,
    ).toBe("Warm");
    k.dispose();
  });

  it("a pattern preset becomes the defined pattern; a gradient sets the colours", async () => {
    const k = await bundleOnFake();
    await k.ingest();
    await k.session.presetsLoaded();
    const eng = await imageEngine();
    const pat = eng.presetsWritePat(
      [{ name: "Red", id: "r", width: 2, height: 2 }],
      new Uint8Array(16).fill(255),
    );
    await k.session.importPresetBytes("patterns", "r.pat", pat);
    const id = k.session.state().patternPresets[0]!.id;
    expect(await k.session.applyPresetOf("patterns", id)).toBe(true);
    expect(k.session.state().pattern).toEqual({ width: 2, height: 2 });
    // …and saving the defined pattern adds it back to the library.
    expect(await k.session.savePresetOf("patterns", "Again")).toBe(true);
    expect(k.session.state().patternPresets.at(-1)).toMatchObject({
      name: "Again",
      width: 2,
    });
    expect(
      await k.session.applyPresetOf("gradients", "builtin-black-white"),
    ).toBe(true);
    expect(k.session.state().colors.fg).toEqual([0, 0, 0, 1]);
    expect(k.session.state().colors.bg).toEqual([1, 1, 1, 1]);
    k.dispose();
  });
});
