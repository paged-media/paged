// paged.image's COMMANDS against the REAL canvas engine (the headless
// host, `createHeadlessHost`): the integration twin of commands.spec.ts.
//
// The unit spec proves what each command does to the image. This one
// proves the part only a real document can: what reaches it. A pixel
// edit stays in the plugin until Commit, Commit writes the composite and
// the layer record into the frame through the engine, and the
// DOCUMENT's undo takes that commit back. A command that is not a pixel
// edit sends the document nothing at all (`changes()` counts every
// document change after the ingest). The typed commands are invoked
// through the shared object registry (`h.objects.invoke`), as a script
// or the Node CLI would call them; each is one document undo step.
//
// No WebGPU here either: the GPU-only verbs decline exactly as they do
// over the fake editor, and the document stays untouched.

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import {
  at,
  BLUE,
  bundleOnHeadless,
  C,
  FRAME,
  imageEngine,
  imageShape,
  RED,
  sourcePixels,
} from "../command-kit";

const P = "plugin:media.paged.image";
const IMAGE = `${P}/image/${FRAME}`;
const L1 = `${P}/layer/${FRAME}/1`;
const value = (v: unknown) => ({ kind: "value", value: v });

async function ingested() {
  const k = await bundleOnHeadless();
  await k.ingest();
  return k;
}
type K = Awaited<ReturnType<typeof ingested>>;

/** Commit, assert the frame now shows `w`×`h` with `topLeft`, then undo
 *  in the DOCUMENT and assert the original 4×2 image is back. */
async function commitsAndUndoes(
  k: K,
  w: number,
  h: number,
  topLeft: readonly number[],
) {
  await k.commit();
  expect(k.session.state().committedRev).toBe(1);
  const shown = await k.framePixels();
  expect([shown.w, shown.h]).toEqual([w, h]);
  expect(at(shown, 0, 0)).toEqual([...topLeft]);
  await k.h.host.document.undo();
  const back = await k.framePixels();
  expect([back.w, back.h]).toEqual([4, 2]);
  expect(at(back, 0, 0)).toEqual([...RED]);
}

/** A command that is not a pixel edit: it sends the document nothing. */
function sentNothing(k: K) {
  expect(k.changes()).toBe(0);
}

describe("panel, ingest and readouts", () => {
  it("openImage changes neither the image nor the document", async () => {
    covers("command:media.paged.image.command.openImage");
    const k = await ingested();
    const before = imageShape(k.session);
    await k.run(`${C}.openImage`);
    expect(imageShape(k.session)).toEqual(before);
    sentNothing(k);
    k.dispose();
  });

  it("adjustSelected reads the frame's placed image out of the engine and marks the frame as the plugin's", async () => {
    covers("command:media.paged.image.command.adjustSelected");
    const k = await bundleOnHeadless();
    let marker = 0;
    const sub = k.h.host.document.onDidChange(() => void marker++);
    await k.ingest();
    sub.dispose();
    const s = k.session.state().source!;
    expect([s.width, s.height, s.elementId]).toEqual([4, 2, FRAME]);
    expect(at(await sourcePixels(k.session), 0, 0)).toEqual([...RED]);
    // The ownership marker is the one document write of an ingest.
    expect(marker).toBe(1);
    expect(await k.h.objects.get(IMAGE, "layerCount")).toEqual(value(1));
    k.dispose();
  });

  it("setType sends the document nothing", async () => {
    covers("command:media.paged.image.command.setType");
    const k = await ingested();
    const before = k.session.state().type;
    await k.run(`${C}.setType`);
    expect(k.session.state().type).toEqual(before);
    sentNothing(k);
    k.dispose();
  });

  it("autoEnhance is a preview: levels move, the document does not", async () => {
    covers("command:media.paged.image.command.autoEnhance");
    const k = await ingested();
    await k.run(`${C}.autoEnhance`);
    expect(k.session.state().params.levels.inWhite).toBeLessThan(1);
    sentNothing(k);
    k.dispose();
  });

  it("claimTiles: the headless host serves no tile resource, and the command says so", async () => {
    covers("command:media.paged.image.command.claimTiles");
    // The editor wires the renderer's resource channel (`images`); the
    // headless host does not, so `rendering.resourceProvider@1` is false
    // and the claim is declined by name. The claim itself is asserted
    // over the fake editor's channel in commands.spec.ts.
    const k = await ingested();
    expect(k.h.host.supports("rendering.resourceProvider@1")).toBe(false);
    await k.run(`${C}.claimTiles`);
    expect(k.session.state().status).toMatch(
      /serves no tile resource \(rendering\.resourceProvider@1 is false\)/,
    );
    sentNothing(k);
    k.dispose();
  });

  it("applyToFile stages the frame's pixels and writes nothing to the document", async () => {
    covers("command:media.paged.image.command.applyToFile");
    const k = await ingested();
    await k.run(`${C}.applyToFile`);
    const staged = k.session.state().saveBack!;
    expect(Array.from(staged.bytes.slice(0, 4))).toEqual([
      0x89, 0x50, 0x4e, 0x47,
    ]);
    sentNothing(k);
    k.dispose();
  });

  it("saveToFile: the headless host wires no saver, and the command says so", async () => {
    covers("command:media.paged.image.command.saveToFile");
    const k = await ingested();
    expect(k.h.host.supports("shell.saveFile@1")).toBe(false);
    await k.run(`${C}.saveToFile`);
    expect(k.session.state().status).toMatch(/cannot save files/);
    sentNothing(k);
    k.dispose();
  });

  it("loadBrushLibrary: the headless host wires no picker, and the command says so", async () => {
    covers("command:media.paged.image.command.loadBrushLibrary");
    const k = await ingested();
    expect(k.h.host.supports("shell.pickFile@1")).toBe(false);
    await k.run(`${C}.loadBrushLibrary`);
    expect(k.session.state().status).toMatch(/wires no file picker/);
    sentNothing(k);
    k.dispose();
  });

  it("definePattern stores a pattern and sends the document nothing", async () => {
    covers("command:media.paged.image.command.definePattern");
    const k = await ingested();
    await k.run(`${C}.definePattern`);
    expect(k.session.state().pattern).toEqual({ width: 4, height: 2 });
    sentNothing(k);
    k.dispose();
  });
});

describe("selection commands (engine state, never the document)", () => {
  it("selectAll", async () => {
    covers("command:media.paged.image.command.selectAll");
    const k = await ingested();
    await k.run(`${C}.selectAll`);
    expect(k.session.state().selection?.coverage).toBeCloseTo(1, 5);
    sentNothing(k);
    k.dispose();
  });

  it("deselect", async () => {
    covers("command:media.paged.image.command.deselect");
    const k = await ingested();
    await k.run(`${C}.selectAll`);
    await k.run(`${C}.deselect`);
    expect(k.session.state().selection).toBeNull();
    sentNothing(k);
    k.dispose();
  });

  it("invertSelection", async () => {
    covers("command:media.paged.image.command.invertSelection");
    const k = await ingested();
    await k.run(`${C}.selectAll`);
    await k.run(`${C}.invertSelection`);
    expect(k.session.state().selection?.coverage).toBeCloseTo(0, 5);
    sentNothing(k);
    k.dispose();
  });

  it("featherSelection", async () => {
    covers("command:media.paged.image.command.featherSelection");
    const k = await ingested();
    await k.run(`${C}.selectAll`);
    await k.run(`${C}.featherSelection`);
    const cov = k.session.state().selection!.coverage;
    expect(cov).toBeGreaterThan(0);
    expect(cov).toBeLessThan(1);
    sentNothing(k);
    k.dispose();
  });

  it("channelToSelection", async () => {
    covers("command:media.paged.image.command.channelToSelection");
    const k = await ingested();
    await k.run(`${C}.channelToSelection`);
    expect(k.session.state().selection?.coverage).toBeLessThan(0.5);
    sentNothing(k);
    k.dispose();
  });

  it("pathToSelection refuses the image frame itself as the path", async () => {
    covers("command:media.paged.image.command.pathToSelection");
    const k = await ingested();
    await k.run(`${C}.pathToSelection`);
    expect(k.session.state().status).toMatch(
      /Select exactly ONE vector element/,
    );
    expect(k.session.state().selection).toBeNull();
    sentNothing(k);
    k.dispose();
  });

  it("selectionToPath inserts a real path element on the frame's page; the document's undo removes it", async () => {
    covers("command:media.paged.image.command.selectionToPath");
    const k = await ingested();
    const kinds = async () => {
      const [spread] = await k.h.host.document.tree();
      return spread?.children?.[0]?.children?.map((n) => n.kind);
    };
    expect(await kinds()).toEqual(["Rectangle"]);
    await k.run(`${C}.selectAll`);
    await k.run(`${C}.selectionToPath`);
    expect(k.changes()).toBe(1);
    expect(await kinds()).toEqual(["Rectangle", "Polygon"]);
    await k.h.host.document.undo();
    expect(await kinds()).toEqual(["Rectangle"]);
    k.dispose();
  });
});

describe("pixel edits reach the document only through Commit", () => {
  it("rotateCw: commit shows 2×4 red-on-top; the document's undo restores 4×2", async () => {
    covers("command:media.paged.image.command.rotateCw");
    const k = await ingested();
    await k.run(`${C}.rotateCw`);
    sentNothing(k);
    await commitsAndUndoes(k, 2, 4, RED);
    k.dispose();
  });

  it("rotateCcw: commit shows 2×4 blue-on-top; the document's undo restores 4×2", async () => {
    covers("command:media.paged.image.command.rotateCcw");
    const k = await ingested();
    await k.run(`${C}.rotateCcw`);
    sentNothing(k);
    await commitsAndUndoes(k, 2, 4, BLUE);
    k.dispose();
  });

  it("rotate180: commit shows the halves swapped; undo restores", async () => {
    covers("command:media.paged.image.command.rotate180");
    const k = await ingested();
    await k.run(`${C}.rotate180`);
    await commitsAndUndoes(k, 4, 2, BLUE);
    k.dispose();
  });

  it("flipHorizontal: commit shows the mirror; undo restores", async () => {
    covers("command:media.paged.image.command.flipHorizontal");
    const k = await ingested();
    await k.run(`${C}.flipHorizontal`);
    await commitsAndUndoes(k, 4, 2, BLUE);
    k.dispose();
  });

  it("flipVertical: commit shows the rotated image upside down; undo restores", async () => {
    covers("command:media.paged.image.command.flipVertical");
    const k = await ingested();
    await k.run(`${C}.rotateCw`);
    await k.run(`${C}.flipVertical`);
    await commitsAndUndoes(k, 2, 4, BLUE);
    k.dispose();
  });

  it("commitCrop: commit shows the cropped 2×1 corner; undo restores", async () => {
    covers("command:media.paged.image.command.commitCrop");
    const k = await ingested();
    const crop = k.session.cropMachine()!;
    crop.pointerDown([0, 0]);
    crop.pointerMove([2, 1]);
    crop.pointerUp();
    await k.run(`${C}.commitCrop`);
    sentNothing(k);
    await commitsAndUndoes(k, 2, 1, BLUE);
    k.dispose();
  });

  it("commitImage: one document change carrying the composite and the stored layers; the document's undo reverts it", async () => {
    covers("command:media.paged.image.command.commitImage");
    const k = await ingested();
    await k.run(`${C}.addLayer`);
    await k.run(`${C}.flipHorizontal`);
    await k.commit();
    expect(k.changes()).toBe(1);
    expect(await k.h.objects.get(IMAGE, "layerCount")).toEqual(value(2));
    expect(at(await k.framePixels(), 0, 0)).toEqual([...BLUE]);
    await k.h.host.document.undo();
    expect(await k.h.objects.get(IMAGE, "layerCount")).toEqual(value(1));
    expect(at(await k.framePixels(), 0, 0)).toEqual([...RED]);
    k.dispose();
  });
});

describe("the layer stack: interactive and typed", () => {
  it("addLayer: the interactive command's layer is stored by Commit; the typed one is one document undo step", async () => {
    covers("command:media.paged.image.command.addLayer");
    const k = await ingested();
    await k.run(`${C}.addLayer`);
    sentNothing(k);
    await k.commit();
    expect(await k.h.objects.get(IMAGE, "layerCount")).toEqual(value(2));
    await k.h.host.document.undo();
    expect(await k.h.objects.get(IMAGE, "layerCount")).toEqual(value(1));
    // The typed twin names its image and writes the document directly.
    expect(
      await k.h.objects.invoke(`${C}.addLayer`, { image: IMAGE, name: "Top" }),
    ).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await k.h.objects.get(`${P}/layer/${FRAME}/2`, "name")).toEqual(
      value("Top"),
    );
    await k.h.host.document.undo();
    expect(await k.h.objects.get(IMAGE, "layerCount")).toEqual(value(1));
    k.dispose();
  });

  it("addLayerMask: typed, a reveal-all mask in one undo step", async () => {
    covers("command:media.paged.image.command.addLayerMask");
    const k = await ingested();
    await k.run(`${C}.addLayerMask`);
    expect(k.session.state().layers.layers[0].hasMask).toBe(true);
    sentNothing(k);
    expect(
      await k.h.objects.invoke(`${C}.addLayerMask`, { layer: L1 }),
    ).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await k.h.objects.get(L1, "hasMask")).toEqual(value(true));
    await k.h.host.document.undo();
    expect(await k.h.objects.get(L1, "hasMask")).toEqual(value(false));
    k.dispose();
  });

  it("addLayerMaskHideAll: typed, a black mask in one undo step", async () => {
    covers("command:media.paged.image.command.addLayerMaskHideAll");
    const k = await ingested();
    expect(
      await k.h.objects.invoke(`${C}.addLayerMaskHideAll`, { layer: L1 }),
    ).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await k.h.objects.get(L1, "hasMask")).toEqual(value(true));
    await k.h.host.document.undo();
    expect(await k.h.objects.get(L1, "hasMask")).toEqual(value(false));
    k.dispose();
  });

  it("convertLayerToSmart: typed, the layer becomes a smart object in one undo step", async () => {
    covers("command:media.paged.image.command.convertLayerToSmart");
    const k = await ingested();
    expect(
      await k.h.objects.invoke(`${C}.convertLayerToSmart`, { layer: L1 }),
    ).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await k.h.objects.get(L1, "kind")).toEqual(value("smart"));
    await k.h.host.document.undo();
    expect(await k.h.objects.get(L1, "kind")).toEqual(value("pixels"));
    k.dispose();
  });

  it("replaceLayerPixels: typed only, the layer's pixels replaced in one undo step", async () => {
    covers("command:media.paged.image.command.replaceLayerPixels");
    const k = await ingested();
    const blue = (await imageEngine()).encode(
      new Uint8Array(4 * 2 * 4).map((_, i) => BLUE[i % 4]),
      4,
      2,
      "png",
    );
    expect(
      await k.h.objects.invoke(`${C}.replaceLayerPixels`, {
        layer: L1,
        source: `data:image/png;base64,${Buffer.from(blue).toString("base64")}`,
      }),
    ).toMatchObject({ applied: true, undoSteps: 1 });
    expect(at(await k.framePixels(), 0, 0)).toEqual([...BLUE]);
    await k.h.host.document.undo();
    expect(at(await k.framePixels(), 0, 0)).toEqual([...RED]);
    k.dispose();
  });

  it("bakeAdjustToLayer: GPU-only past identity, and the document is untouched", async () => {
    covers("command:media.paged.image.command.bakeAdjustToLayer");
    const k = await ingested();
    await k.run(`${C}.autoEnhance`);
    await k.run(`${C}.bakeAdjustToLayer`);
    expect(k.session.state().status).toMatch(/GPU-only/);
    sentNothing(k);
    k.dispose();
  });
});

describe("the image's own undo and redo never touch the document's", () => {
  it("undo", async () => {
    covers("command:media.paged.image.command.undo");
    const k = await ingested();
    await k.run(`${C}.flipHorizontal`);
    await k.run(`${C}.undo`);
    expect(at(await sourcePixels(k.session), 0, 0)).toEqual([...RED]);
    sentNothing(k);
    k.dispose();
  });

  it("redo", async () => {
    covers("command:media.paged.image.command.redo");
    const k = await ingested();
    await k.run(`${C}.flipHorizontal`);
    await k.run(`${C}.undo`);
    await k.run(`${C}.redo`);
    expect(at(await sourcePixels(k.session), 0, 0)).toEqual([...BLUE]);
    sentNothing(k);
    k.dispose();
  });
});

describe("GPU-only verbs decline and leave the document alone", () => {
  async function declines(
    id: string,
    reason: RegExp,
    prep?: (k: K) => Promise<void>,
  ) {
    const k = await ingested();
    await prep?.(k);
    const before = imageShape(k.session);
    await k.run(id);
    expect(k.session.state().status).toMatch(reason);
    expect(imageShape(k.session)).toEqual(before);
    sentNothing(k);
    k.dispose();
  }

  it("fillSelection", async () => {
    covers("command:media.paged.image.command.fillSelection");
    await declines(`${C}.fillSelection`, /GPU-only/);
  });

  it("fillNoise", async () => {
    covers("command:media.paged.image.command.fillNoise");
    await declines(`${C}.fillNoise`, /GPU-only/);
  });

  it("contentAwareFill", async () => {
    covers("command:media.paged.image.command.contentAwareFill");
    await declines(`${C}.contentAwareFill`, /GPU-only/, (k) =>
      k.run(`${C}.selectAll`),
    );
  });

  it("median", async () => {
    covers("command:media.paged.image.command.median");
    await declines(`${C}.median`, /GPU-only/);
  });

  it("maximum", async () => {
    covers("command:media.paged.image.command.maximum");
    await declines(`${C}.maximum`, /GPU-only/);
  });

  it("minimum", async () => {
    covers("command:media.paged.image.command.minimum");
    await declines(`${C}.minimum`, /GPU-only/);
  });

  it("fillForeground", async () => {
    covers("command:media.paged.image.command.fillForeground");
    await declines(`${C}.fillForeground`, /GPU-only/);
  });

  it("fillPattern", async () => {
    covers("command:media.paged.image.command.fillPattern");
    await declines(`${C}.fillPattern`, /GPU-only/, (k) =>
      k.run(`${C}.definePattern`),
    );
  });

  it("shapeBlur", async () => {
    covers("command:media.paged.image.command.shapeBlur");
    await declines(`${C}.shapeBlur`, /GPU-only/, (k) =>
      k.run(`${C}.definePattern`),
    );
  });
});
