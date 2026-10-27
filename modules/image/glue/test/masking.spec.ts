// SELECTION AND MASKING (WP5.5, image ADR 470) over the REAL engine wasm
// in Node: every Select-menu command through its registered contribution,
// the masking controller behind the panel, and the undo list — each
// command is ONE step on the image's undo list, and undo takes it back.
//
// The image is the 4×2 two-colour one (columns 0–1 red, 2–3 blue). Node
// has no WebGPU, so Color Range runs on its CPU twin here (the kernel's
// GPU↔twin parity is image-conformance's oracle_photoshop_selection.rs).

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { bundleOnFake, C } from "./command-kit";

async function ingested() {
  const k = await bundleOnFake();
  await k.ingest();
  return k;
}
type K = Awaited<ReturnType<typeof ingested>>;

const sel = (k: K) => {
  const s = k.session.state().selection;
  return s && [s.x, s.y, s.w, s.h];
};
const undoLabel = (k: K) => k.session.state().history?.undoSteps.at(-1);
const depth = (k: K) => k.session.state().history?.depth ?? 0;
const m = (k: K) => k.session.masking();

/** Select the left (red) half with the marquee door. */
function selectLeft(k: K) {
  k.session.selectionMachine()!.begin("rect", [0, 0], "replace");
  k.session.selectionMachine()!.update([2, 2]);
  expect(k.session.selectionMachine()!.end()).toBe(true);
  k.session.refreshSelection();
  expect(sel(k)).toEqual([0, 0, 2, 2]);
}

describe("[image.selection.select-and-mask] Select ▸ Color Range", () => {
  it("samples a colour, previews it, and OK selects it as one undo step", async () => {
    covers("command:media.paged.image.command.colorRange");
    const k = await ingested();
    await k.run(`${C}.colorRange`);
    expect(k.opened).toContain("media.paged.image.panel.adjustments");
    expect(m(k).state().colorRange).not.toBeNull();
    expect(await m(k).sampleColorRange(0, 0, "replace")).toBe(true);
    const preview = m(k).state().colorRange!.preview!;
    expect(Array.from(preview)).toEqual([255, 255, 0, 0, 255, 255, 0, 0]);
    const before = depth(k);
    expect(await m(k).colorRangeOk()).toBe(true);
    expect(sel(k)).toEqual([0, 0, 2, 2]);
    expect(depth(k)).toBe(before + 1);
    expect(undoLabel(k)).toBe("Color Range");
    expect(m(k).state().colorRange).toBeNull();
    expect(await k.session.undo()).toBe(true);
    expect(k.session.state().selection).toBeNull();
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("presets, invert, the minus eyedropper and Out of Gamut", async () => {
    const k = await ingested();
    m(k).openColorRange();
    await m(k).setColorRange({ select: "blues" });
    const blues = m(k).state().colorRange!.preview!;
    // Blue (0, 0, 200): chroma × (2 − V) = 0.784 × 1.216.
    expect(Array.from(blues.slice(0, 4))).toEqual([0, 0, 243, 243]);
    await m(k).setColorRange({ invert: true });
    expect(m(k).state().colorRange!.preview![0]).toBe(255);
    // A tonal preset brings Photoshop's own defaults.
    await m(k).setColorRange({ select: "shadows", invert: false });
    expect(m(k).state().colorRange!.opts).toMatchObject({
      fuzziness: 20,
      lower: 0,
      upper: 65,
    });
    // Two samples, then the minus eyedropper drops the blue one.
    await m(k).sampleColorRange(0, 0, "replace");
    await m(k).sampleColorRange(3, 0, "add");
    expect(m(k).state().colorRange!.opts.samples).toHaveLength(2);
    await m(k).sampleColorRange(3, 1, "subtract");
    expect(m(k).state().colorRange!.opts.samples).toHaveLength(1);
    await m(k).setColorRange({ select: "outOfGamut" });
    expect(await m(k).colorRangeOk()).toBe(false);
    expect(k.session.state().status).toContain("CMYK profile");
    expect(await m(k).colorRangeCancel()).toBe(true);
    expect(k.session.state().selection).toBeNull();
    k.dispose();
  });
});

describe("[image.selection.select-and-mask] Select ▸ Grow, Similar, Focus Area", () => {
  it("Grow and Similar widen the selection by the wand tolerance", async () => {
    covers("command:media.paged.image.command.grow");
    covers("command:media.paged.image.command.similar");
    const k = await ingested();
    // One red pixel selected: Grow reaches the other red pixels.
    k.session.selectionMachine()!.begin("rect", [0, 0], "replace");
    k.session.selectionMachine()!.update([1, 1]);
    k.session.selectionMachine()!.end();
    k.session.refreshSelection();
    await k.run(`${C}.grow`);
    expect(sel(k)).toEqual([0, 0, 2, 2]);
    expect(undoLabel(k)).toBe("Grow");
    await k.session.undo();
    expect(sel(k)).toEqual([0, 0, 1, 1]);
    await k.run(`${C}.similar`);
    expect(sel(k)).toEqual([0, 0, 2, 2]);
    expect(undoLabel(k)).toBe("Similar");
    k.dispose();
  });

  it("Focus Area opens its dialog, previews and selects as one step", async () => {
    covers("command:media.paged.image.command.focusArea");
    const k = await ingested();
    await k.run(`${C}.focusArea`);
    expect(m(k).state().focusArea).not.toBeNull();
    await m(k).setFocusArea({ range: 1 });
    expect(m(k).state().focusArea!.preview).toHaveLength(8);
    const before = depth(k);
    expect(await m(k).focusAreaOk()).toBe(true);
    expect(depth(k)).toBe(before + 1);
    expect(undoLabel(k)).toBe("Focus Area");
    k.dispose();
  });
});

describe("[image.selection.select-and-mask] Quick Mask", () => {
  it("toggles into a painted channel and back into the selection, each one step", async () => {
    covers("command:media.paged.image.command.quickMask");
    const k = await ingested();
    selectLeft(k);
    await k.run(`${C}.quickMask`);
    expect(m(k).state().info.quickMask).not.toBeNull();
    expect(m(k).state().view).toEqual({ kind: "quickMask" });
    expect(undoLabel(k)).toBe("Enter Quick Mask");
    // The brushes paint the channel now: the stack's edit target is it.
    expect(m(k).state().info.editChannel).toBe(m(k).state().info.quickMask);
    // The display shows the red overlay over the unselected half.
    const e = m(k).engine()!;
    const shown = e.viewApply(new Uint8Array(4 * 2 * 4).fill(100), 4, 2);
    expect(Array.from(shown.slice(0, 3))).toEqual([100, 100, 100]);
    expect(Array.from(shown.slice(12, 15))).toEqual([178, 50, 50]);
    await k.run(`${C}.quickMask`);
    expect(m(k).state().info.quickMask).toBeNull();
    expect(sel(k)).toEqual([0, 0, 2, 2]);
    expect(undoLabel(k)).toBe("Exit Quick Mask");
    // ONE undo brings the channel back.
    await k.session.undo();
    expect(m(k).state().info.quickMask).not.toBeNull();
    k.dispose();
  });
});

describe("[image.selection.select-and-mask] Channels: save, load, rename, duplicate, spot, view", () => {
  it("Save Selection stores a channel and Load Selection folds it back", async () => {
    covers("command:media.paged.image.command.saveSelection");
    covers("command:media.paged.image.command.loadSelection");
    const k = await ingested();
    selectLeft(k);
    await k.run(`${C}.saveSelection`);
    const ch = m(k).state().info.channels;
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ name: "Alpha 1", kind: "alpha" });
    expect(ch[0].coverage).toBeCloseTo(0.5, 5);
    expect(undoLabel(k)).toBe("Save selection");
    k.session.deselect();
    await k.run(`${C}.loadSelection`);
    expect(m(k).state().load).toMatchObject({ channel: ch[0].id });
    m(k).setLoadSelection({ invert: true });
    expect(m(k).loadSelectionOk()).toBe(true);
    expect(sel(k)).toEqual([2, 0, 2, 2]);
    expect(undoLabel(k)).toBe("Load Selection");
    // Rename, duplicate, spot, delete: one step each.
    expect(m(k).renameChannel(ch[0].id, "Sky")).toBe(true);
    expect(m(k).state().info.channels[0].name).toBe("Sky");
    expect(m(k).duplicateChannel(ch[0].id)).toBe(true);
    expect(
      m(k)
        .state()
        .info.channels.map((c) => c.name),
    ).toEqual(["Sky", "Sky copy"]);
    expect(m(k).setSpot(ch[0].id, [0, 128, 255], 0.5)).toBe(true);
    expect(m(k).state().info.channels[0]).toMatchObject({
      kind: "spot",
      colour: [0, 128, 255],
      solidity: 0.5,
    });
    expect(m(k).newSpotChannel("Varnish", [255, 255, 0], 1)).toBe(true);
    expect(m(k).state().info.channels.at(-1)).toMatchObject({
      name: "Varnish",
      kind: "spot",
    });
    const n = m(k).state().info.channels.length;
    expect(m(k).deleteChannel(ch[0].id)).toBe(true);
    expect(m(k).state().info.channels).toHaveLength(n - 1);
    await k.session.undo();
    expect(m(k).state().info.channels).toHaveLength(n);
    // The per-channel view shows a channel as grey, not the document.
    expect(await m(k).setView({ kind: "channel", id: ch[0].id })).toBe(true);
    expect(m(k).engine()!.viewActive()).toBe(true);
    await m(k).setView({ kind: "component", channel: "red" });
    const grey = m(k)
      .engine()!
      .viewApply(new Uint8Array([200, 0, 0, 255, 0, 0, 200, 255]), 2, 1);
    expect(Array.from(grey)).toEqual([200, 200, 200, 255, 0, 0, 0, 255]);
    await m(k).setView({ kind: "composite" });
    expect(m(k).engine()!.viewActive()).toBe(false);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("a channel picked for painting becomes the brushes' target", async () => {
    const k = await ingested();
    selectLeft(k);
    m(k).saveSelection("Mask");
    const id = m(k).state().info.channels[0].id;
    expect(m(k).editChannel(id)).toBe(true);
    expect(m(k).state().info.editChannel).toBe(id);
    expect(m(k).editChannel(null)).toBe(true);
    expect(m(k).state().info.editChannel).toBeNull();
    k.dispose();
  });
});

describe("[image.selection.select-and-mask] Paths in the image session", () => {
  it("Make Work Path stores the traced selection; Make Selection loads it back", async () => {
    covers("command:media.paged.image.command.makeWorkPath");
    const k = await ingested();
    selectLeft(k);
    await k.run(`${C}.makeWorkPath`);
    const p = m(k).state().info.paths;
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ name: "Path 1", subpaths: 1, anchors: 4 });
    expect(undoLabel(k)).toBe("New path");
    const stored = m(k).engine()!.pathGet(p[0].id);
    expect(stored.closed).toEqual([true]);
    k.session.deselect();
    expect(m(k).makeSelectionFromPath(p[0].id)).toBe(true);
    expect(sel(k)).toEqual([0, 0, 2, 2]);
    expect(undoLabel(k)).toBe("Make Selection");
    expect(m(k).renamePath(p[0].id, "Outline")).toBe(true);
    expect(m(k).duplicatePath(p[0].id)).toBe(true);
    expect(
      m(k)
        .state()
        .info.paths.map((q) => q.name),
    ).toEqual(["Outline", "Outline copy"]);
    expect(m(k).deletePath(p[0].id)).toBe(true);
    expect(m(k).state().info.paths).toHaveLength(1);
    // Paths are session state: nothing reached the document.
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("a path drawn elsewhere is stored with its curves", async () => {
    const k = await ingested();
    const e = m(k).engine()!;
    const id = e.pathAdd("Drawn", [
      {
        closed: true,
        anchors: [
          0, 0, 0, 0, 0, 0, 2, 0, 2, 0, 2, 0, 2, 2, 2, 2, 2, 2, 0, 2, 0, 2, 0,
          2,
        ],
      },
    ]);
    m(k).refresh();
    expect(m(k).state().info.paths[0]).toMatchObject({
      id,
      name: "Drawn",
      anchors: 4,
    });
    expect(m(k).makeSelectionFromPath(id, 0, "replace")).toBe(true);
    expect(sel(k)).toEqual([0, 0, 2, 2]);
    k.dispose();
  });
});

describe("[image.selection.select-and-mask] Select and Mask", () => {
  it("refines the selection's edge and outputs it as one step", async () => {
    covers("command:media.paged.image.command.selectAndMask");
    const k = await ingested();
    // Without a selection there is nothing to refine.
    await k.run(`${C}.selectAndMask`);
    expect(m(k).state().refine).toBeNull();
    expect(k.session.state().status).toContain("selection first");
    selectLeft(k);
    await k.run(`${C}.selectAndMask`);
    const r = m(k).state().refine!;
    expect(r).not.toBeNull();
    expect(Array.from(r.alpha!)).toEqual([255, 255, 0, 0, 255, 255, 0, 0]);
    expect(m(k).state().view).toMatchObject({ kind: "matte", mode: "overlay" });
    await m(k).setRefine({ shiftEdge: 25 });
    expect(Array.from(m(k).state().refine!.alpha!.slice(0, 4))).toEqual([
      255, 255, 255, 0,
    ]);
    await m(k).setRefineView("onBlack");
    expect(m(k).state().view).toMatchObject({ kind: "matte", mode: "onBlack" });
    m(k).setRefineOutput("selection");
    const before = depth(k);
    expect(await m(k).refineOk()).toBe(true);
    expect(sel(k)).toEqual([0, 0, 3, 2]);
    expect(depth(k)).toBe(before + 1);
    expect(undoLabel(k)).toBe("Select and Mask");
    expect(m(k).state().refine).toBeNull();
    expect(m(k).state().view).toEqual({ kind: "composite" });
    k.dispose();
  });

  it("outputs a layer mask or a new masked layer, and a matting provider is consulted", async () => {
    const k = await ingested();
    selectLeft(k);
    const seen: number[] = [];
    m(k).setMattingProvider({
      async solve(_rgba, w, h, trimap) {
        seen.push(trimap.length);
        return new Uint8Array(w * h).fill(255);
      },
    });
    await m(k).openRefine();
    expect(seen).toEqual([8]);
    expect(Array.from(m(k).state().refine!.alpha!)).toEqual(Array(8).fill(255));
    m(k).setMattingProvider(null);
    await m(k).setRefine({});
    m(k).setRefineOutput("newLayerWithMask");
    expect(await m(k).refineOk()).toBe(true);
    const layers = k.session.state().layers.layers;
    expect(layers).toHaveLength(2);
    expect(layers[1].hasMask).toBe(true);
    expect(layers[0].visible).toBe(false);
    expect(undoLabel(k)).toBe("Select and Mask");
    await k.session.undo();
    expect(k.session.state().layers.layers).toHaveLength(1);
    // Cancel changes nothing.
    await m(k).openRefine();
    expect(await m(k).refineCancel()).toBe(true);
    expect(m(k).state().refine).toBeNull();
    k.dispose();
  });
});

describe("[image.selection.select-and-mask] persistence", () => {
  it("channels and paths travel with the session's layer data", async () => {
    const k = await ingested();
    selectLeft(k);
    m(k).saveSelection("Kept");
    m(k).pathFromSelection("Kept path");
    const e = m(k).engine()!;
    const exported = e.layersExport();
    // A fresh stack, then the stored one back.
    m(k).deleteChannel(m(k).state().info.channels[0].id);
    await e.layersImport(exported[0], exported.slice(1));
    m(k).refresh();
    expect(
      m(k)
        .state()
        .info.channels.map((c) => c.name),
    ).toEqual(["Kept"]);
    expect(
      m(k)
        .state()
        .info.paths.map((p) => p.name),
    ).toEqual(["Kept path"]);
    k.dispose();
  });
});
