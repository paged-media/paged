// paged.image's COMMANDS, one test each, through the registered handler
// (the palette's and the menus' way in) over the fake editor and the real
// image-js wasm in Node.
//
// Each test asserts the three things a command owes its caller:
//   · ENABLEMENT — none of these commands carries a `when` predicate, so
//     "disabled" is the refusal: before an image is ingested (or without
//     the command's precondition) it says why, changes nothing and sends
//     the document nothing;
//   · THE EFFECT — what it did to the image (size, pixels, layers, the
//     selection, the staged bytes) and what it SENT to the document (the
//     image's pixels are the plugin's own until Commit, so most send
//     nothing);
//   · UNDO — the image's own journal (`command.undo` / `command.redo`)
//     steps a pixel edit back and forth; a command that is not a pixel
//     edit leaves the journal alone.
//
// GPU-only work declines in Node (there is no WebGPU device), and the
// test asserts THAT, honestly: the refusal names the GPU, the image and
// the journal are untouched. The pixels those kernels produce are proved
// in Rust (image-js / image-conformance, `…__feat__image_editor_*`), not
// here. The typed `replaceLayerPixels` exists only in the object model;
// its unit test is in object-model.spec.ts.
//
// The engine-backed twin of this file is headless/commands.spec.ts: the
// same commands against the real canvas engine's document, committed and
// undone there.

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import {
  at,
  BLUE,
  bundleOnFake,
  C,
  decoded,
  imageShape,
  PANEL_ID,
  RED,
  sourcePixels,
} from "./command-kit";
import { abrBytes } from "./fixtures/abr";

const NOTHING = /Nothing ingested|ingest a placed image first/;

/** A fresh bundle, the frame ingested. */
async function ingested(options?: Parameters<typeof bundleOnFake>[0]) {
  const k = await bundleOnFake(options);
  await k.ingest();
  return k;
}

/** Run `id` with nothing ingested and assert the honest refusal. */
async function refusesWithoutImage(id: string, status: RegExp = NOTHING) {
  const k = await bundleOnFake({ select: false });
  const before = imageShape(k.session);
  await k.run(id);
  expect(k.session.state().status).toMatch(status);
  expect(imageShape(k.session)).toEqual(before);
  expect(k.fake.mutations).toEqual([]);
  k.dispose();
}

/** Undo then redo through the registered commands; returns the shapes. */
async function undoRedo(k: Awaited<ReturnType<typeof ingested>>) {
  await k.run(`${C}.undo`);
  const undone = await sourcePixels(k.session);
  await k.run(`${C}.redo`);
  const redone = await sourcePixels(k.session);
  return { undone, redone };
}

describe("panel and ingest", () => {
  it("openImage raises the Image panel and touches nothing else", async () => {
    covers("command:media.paged.image.command.openImage");
    const k = await bundleOnFake();
    const before = imageShape(k.session);
    await k.run(`${C}.openImage`);
    expect(k.opened).toEqual([PANEL_ID]);
    expect(imageShape(k.session)).toEqual(before);
    expect(k.fake.mutations).toEqual([]);
    k.dispose();
  });

  it("adjustSelected ingests the selected frame's placed image and marks the frame", async () => {
    covers("command:media.paged.image.command.adjustSelected");
    // Disabled: nothing selected — it says so and reads nothing.
    const none = await bundleOnFake({ select: false });
    await none.run(`${C}.adjustSelected`);
    expect(none.session.state().source).toBeNull();
    expect(none.session.state().status).toMatch(
      /Select exactly one placed image frame/,
    );
    expect(none.fake.mutations).toEqual([]);
    none.dispose();

    const k = await bundleOnFake();
    await k.ingest();
    expect(k.opened).toEqual([PANEL_ID]);
    const s = k.session.state().source!;
    expect([s.width, s.height, s.elementId]).toEqual([4, 2, "u1"]);
    expect(k.session.state().layers.layers.map((l) => l.name)).toEqual([
      "Background",
    ]);
    // The ONE thing ingest writes: the frame's ownership marker, which is
    // what the rasterImage edit context matches on.
    expect(k.fake.mutations).toHaveLength(1);
    expect(k.fake.mutations[0]).toMatchObject({
      op: "setPluginMetadata",
      args: { key: "x-paged:media.paged.image" },
    });
    // Not a pixel edit: nothing to undo.
    expect(k.session.state().history?.depth).toBe(0);
    k.dispose();
  });

  it("setType raises the panel (its Type section holds the settings) and changes nothing", async () => {
    covers("command:media.paged.image.command.setType");
    const k = await ingested();
    const before = {
      shape: imageShape(k.session),
      type: k.session.state().type,
    };
    k.opened.length = 0;
    await k.run(`${C}.setType`);
    expect(k.opened).toEqual([PANEL_ID]);
    expect({
      shape: imageShape(k.session),
      type: k.session.state().type,
    }).toEqual(before);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });
});

describe("previews and readouts (no pixel edit, nothing sent)", () => {
  it("autoEnhance sets levels from the histogram, as a preview only", async () => {
    covers("command:media.paged.image.command.autoEnhance");
    await refusesWithoutImage(`${C}.autoEnhance`);
    const k = await ingested();
    const before = k.session.state().params.levels;
    await k.run(`${C}.autoEnhance`);
    const after = k.session.state().params.levels;
    // The image spans 0..200 in its channels: the black and white points
    // move in from 0 and 1.
    expect(after).not.toEqual(before);
    expect(after.inWhite).toBeLessThan(1);
    expect(k.session.state().status).toMatch(/click Apply/);
    expect(k.session.state().history?.depth).toBe(0);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("claimTiles claims the frame's tile resource with the source's size", async () => {
    covers("command:media.paged.image.command.claimTiles");
    await refusesWithoutImage(`${C}.claimTiles`);
    const k = await ingested();
    await k.run(`${C}.claimTiles`);
    expect(k.fake.imageClaims).toEqual([
      expect.objectContaining({
        imageId: "u1",
        baseWidth: 4,
        baseHeight: 2,
        levels: 1,
      }),
    ]);
    expect(k.session.state().history?.depth).toBe(0);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("applyToFile stages the adjusted pixels as a PNG for delivery", async () => {
    covers("command:media.paged.image.command.applyToFile");
    await refusesWithoutImage(`${C}.applyToFile`);
    const k = await ingested();
    await k.run(`${C}.applyToFile`);
    const staged = k.session.state().saveBack!;
    expect(staged.fileName).toBe("sample.png");
    expect(staged.mimeType).toBe("image/png");
    expect(Array.from(staged.bytes.slice(0, 4))).toEqual([
      0x89, 0x50, 0x4e, 0x47,
    ]);
    const img = await decoded(staged.bytes);
    expect([img.w, img.h]).toEqual([4, 2]);
    expect(at(img, 0, 0)).toEqual([...RED]);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("saveToFile hands the staged bytes to the host's saver, and says so when there is none", async () => {
    covers("command:media.paged.image.command.saveToFile");
    // Disabled: a host without `shell.saveFile@1` — probed, not assumed.
    const none = await ingested();
    await none.run(`${C}.saveToFile`);
    expect(none.session.state().status).toMatch(/cannot save files/);
    expect(none.session.state().saveBack).toBeNull();
    none.dispose();

    const saved: Array<{ suggestedName: string; bytes: Uint8Array }> = [];
    const k = await ingested({
      shell: { saveFile: async (o) => (saved.push(o), true) },
    });
    await k.run(`${C}.saveToFile`);
    expect(saved).toHaveLength(1);
    expect(saved[0].suggestedName).toBe("sample.png");
    expect((await decoded(saved[0].bytes)).w).toBe(4);
    expect(k.session.state().status).toMatch(/handed to the host's save path/);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("loadBrushLibrary reads a picked .abr into presets, and declines an empty pick", async () => {
    covers("command:media.paged.image.command.loadBrushLibrary");
    const empty = await bundleOnFake();
    await empty.run(`${C}.loadBrushLibrary`);
    expect(empty.session.state().status).toBe("No brush library chosen.");
    expect(empty.session.state().brushLibrary).toBeNull();
    empty.dispose();

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
    await k.run(`${C}.loadBrushLibrary`);
    expect(asked).toEqual([{ accept: [".abr"] }]);
    expect(k.session.state().brushLibrary?.presets.map((p) => p.name)).toEqual([
      "Hard Round 9",
    ]);
    expect(k.session.state().brushLibraryName).toBe("round.abr");
    expect(k.fake.mutations).toEqual([]);
    k.dispose();
  });
  it("definePattern stores the selection's (or the whole image's) pixels as the pattern", async () => {
    covers("command:media.paged.image.command.definePattern");
    await refusesWithoutImage(`${C}.definePattern`);
    const k = await ingested();
    await k.run(`${C}.definePattern`);
    expect(k.session.state().pattern).toEqual({ width: 4, height: 2 });
    expect(k.session.state().status).toMatch(/Pattern defined — 4×2 px/);
    // A definition, not an edit: nothing to undo, nothing sent.
    expect(k.session.state().history?.depth).toBe(0);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });
});

describe("selection commands (engine state, not the document)", () => {
  it("selectAll selects the whole image", async () => {
    covers("command:media.paged.image.command.selectAll");
    await refusesWithoutImage(`${C}.selectAll`);
    const k = await ingested();
    await k.run(`${C}.selectAll`);
    const s = k.session.state().selection!;
    expect([s.x, s.y, s.w, s.h]).toEqual([0, 0, 4, 2]);
    expect(s.coverage).toBeCloseTo(1, 5);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("deselect returns to no selection", async () => {
    covers("command:media.paged.image.command.deselect");
    const k = await ingested();
    await k.run(`${C}.selectAll`);
    await k.run(`${C}.deselect`);
    expect(k.session.state().selection).toBeNull();
    expect(k.session.state().status).toMatch(/Deselected/);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("invertSelection flips the coverage", async () => {
    covers("command:media.paged.image.command.invertSelection");
    await refusesWithoutImage(`${C}.invertSelection`);
    const k = await ingested();
    await k.run(`${C}.selectAll`);
    await k.run(`${C}.invertSelection`);
    expect(k.session.state().selection?.coverage).toBeCloseTo(0, 5);
    expect(k.session.state().status).toBe("Selection inverted.");
    k.dispose();
  });

  it("featherSelection needs a selection, then softens it", async () => {
    covers("command:media.paged.image.command.featherSelection");
    const k = await ingested();
    await k.run(`${C}.featherSelection`);
    expect(k.session.state().status).toMatch(/no selection to feather/);
    expect(k.session.state().selection).toBeNull();
    await k.run(`${C}.selectAll`);
    await k.run(`${C}.featherSelection`);
    const cov = k.session.state().selection!.coverage;
    expect(cov).toBeGreaterThan(0);
    expect(cov).toBeLessThan(1);
    k.dispose();
  });

  it("channelToSelection loads the luminosity as partial coverage", async () => {
    covers("command:media.paged.image.command.channelToSelection");
    await refusesWithoutImage(`${C}.channelToSelection`);
    const k = await ingested();
    await k.run(`${C}.channelToSelection`);
    const s = k.session.state().selection!;
    expect([s.w, s.h]).toEqual([4, 2]);
    // Red (200,0,0) and blue (0,0,200) are dark in luma: partial, low.
    expect(s.coverage).toBeGreaterThan(0);
    expect(s.coverage).toBeLessThan(0.5);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("pathToSelection loads the one selected vector path as the selection", async () => {
    covers("command:media.paged.image.command.pathToSelection");
    const k = await ingested();
    // Disabled: the image frame itself is not a path to load.
    await k.run(`${C}.pathToSelection`);
    expect(k.session.state().status).toMatch(
      /Select exactly ONE vector element/,
    );
    expect(k.session.state().selection).toBeNull();
    // A square over the LEFT half of the image (scale 50 pt/px).
    k.fake.pathAnchors.set("p1", {
      id: { kind: "polygon", id: "p1" },
      pageId: "pg1",
      anchors: [
        { anchor: [0, 0], left: [0, 0], right: [0, 0] },
        { anchor: [100, 0], left: [100, 0], right: [100, 0] },
        { anchor: [100, 100], left: [100, 100], right: [100, 100] },
        { anchor: [0, 100], left: [0, 100], right: [0, 100] },
      ],
      subpathStarts: [],
    });
    k.fake.emitSelection([{ kind: "polygon", id: "p1" }]);
    await k.run(`${C}.pathToSelection`);
    const s = k.session.state().selection!;
    expect([s.x, s.y, s.w, s.h]).toEqual([0, 0, 2, 2]);
    expect(s.coverage).toBeCloseTo(0.5, 2);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("selectionToPath inserts the selection's outline as one closed path in document points", async () => {
    covers("command:media.paged.image.command.selectionToPath");
    const k = await ingested();
    await k.run(`${C}.selectionToPath`);
    expect(k.session.state().status).toMatch(/Nothing selected/);
    expect(k.docOps()).toEqual([]);
    await k.run(`${C}.selectAll`);
    await k.run(`${C}.selectionToPath`);
    const ops = k.docOps();
    expect(ops.map((o) => o.op)).toEqual(["insertPath"]);
    const xs = (ops[0].args.anchors as Array<{ anchor: number[] }>)
      .map((a) => a.anchor[0])
      .sort((a, b) => a - b);
    // 4 px at 50 pt/px: the outline spans 0..200 pt.
    expect([xs[0], xs.at(-1)]).toEqual([0, 200]);
    expect(ops[0].args.open).toBe(false);
    k.dispose();
  });
});

describe("canvas verbs (pixel edits, one undo step each)", () => {
  it("rotateCw turns the canvas 90° clockwise, as one undo step", async () => {
    covers("command:media.paged.image.command.rotateCw");
    await refusesWithoutImage(`${C}.rotateCw`);
    const k = await ingested();
    await k.run(`${C}.rotateCw`);
    const img = await sourcePixels(k.session);
    expect([img.w, img.h]).toEqual([2, 4]);
    // Clockwise: the left (red) half becomes the top.
    expect(at(img, 0, 0)).toEqual([...RED]);
    expect(at(img, 0, 3)).toEqual([...BLUE]);
    expect(k.session.state().history?.undoSteps).toEqual([
      "Rotate 90° clockwise",
    ]);
    expect(k.session.state().uncommitted).toBe(true);
    expect(k.docOps()).toEqual([]);
    // Undo takes the step (redo comes back to the rotated image); what
    // the undone image LOOKS like is IMG-1, below.
    await k.run(`${C}.undo`);
    expect(k.session.state().history?.redoSteps).toEqual([
      "Rotate 90° clockwise",
    ]);
    await k.run(`${C}.redo`);
    const redone = await sourcePixels(k.session);
    expect([redone.w, redone.h]).toEqual([2, 4]);
    expect(at(redone, 0, 3)).toEqual([...BLUE]);
    k.dispose();
  });

  // FINDING IMG-1: undoing a 90° canvas rotation restores the pixel
  // BYTES but not the canvas SIZE. The 4×2 image's rows are read back as
  // a 2×4 image (RR/BB/RR/BB instead of RRBB/RRBB), and Commit then
  // writes that scrambled image into the document.
  it.failing(
    "IMG-1 — undoing rotateCw restores the 4×2 canvas and its pixels",
    async () => {
      const k = await ingested();
      await k.run(`${C}.rotateCw`);
      await k.run(`${C}.undo`);
      const undone = await sourcePixels(k.session);
      expect([undone.w, undone.h]).toEqual([4, 2]);
      expect(at(undone, 3, 0)).toEqual([...BLUE]);
      k.dispose();
    },
  );

  it("rotateCcw turns the canvas 90° counter-clockwise, as one undo step", async () => {
    covers("command:media.paged.image.command.rotateCcw");
    await refusesWithoutImage(`${C}.rotateCcw`);
    const k = await ingested();
    await k.run(`${C}.rotateCcw`);
    const img = await sourcePixels(k.session);
    expect([img.w, img.h]).toEqual([2, 4]);
    // Counter-clockwise: the right (blue) half becomes the top.
    expect(at(img, 0, 0)).toEqual([...BLUE]);
    expect(at(img, 0, 3)).toEqual([...RED]);
    expect(k.session.state().history?.undoSteps).toEqual([
      "Rotate 90° counter-clockwise",
    ]);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  // FINDING IMG-1, the counter-clockwise twin.
  it.failing(
    "IMG-1 — undoing rotateCcw restores the 4×2 canvas and its pixels",
    async () => {
      const k = await ingested();
      await k.run(`${C}.rotateCcw`);
      await k.run(`${C}.undo`);
      const undone = await sourcePixels(k.session);
      expect([undone.w, undone.h]).toEqual([4, 2]);
      expect(at(undone, 3, 0)).toEqual([...BLUE]);
      k.dispose();
    },
  );

  it("rotate180 keeps the size and swaps the halves; undo restores it", async () => {
    covers("command:media.paged.image.command.rotate180");
    await refusesWithoutImage(`${C}.rotate180`);
    const k = await ingested();
    await k.run(`${C}.rotate180`);
    const img = await sourcePixels(k.session);
    expect([img.w, img.h]).toEqual([4, 2]);
    expect(at(img, 0, 0)).toEqual([...BLUE]);
    expect(at(img, 3, 1)).toEqual([...RED]);
    const { undone } = await undoRedo(k);
    expect(at(undone, 0, 0)).toEqual([...RED]);
    k.dispose();
  });

  it("flipHorizontal mirrors left and right; undo restores it", async () => {
    covers("command:media.paged.image.command.flipHorizontal");
    await refusesWithoutImage(`${C}.flipHorizontal`);
    const k = await ingested();
    await k.run(`${C}.flipHorizontal`);
    const img = await sourcePixels(k.session);
    expect(at(img, 0, 0)).toEqual([...BLUE]);
    expect(at(img, 3, 0)).toEqual([...RED]);
    expect(k.session.state().history?.undoSteps.at(-1)).toBe("Flip horizontal");
    const { undone, redone } = await undoRedo(k);
    expect(at(undone, 0, 0)).toEqual([...RED]);
    expect(at(redone, 0, 0)).toEqual([...BLUE]);
    k.dispose();
  });

  it("flipVertical mirrors top and bottom (a left/right image is unchanged by it); undo restores the step", async () => {
    covers("command:media.paged.image.command.flipVertical");
    await refusesWithoutImage(`${C}.flipVertical`);
    const k = await ingested();
    await k.run(`${C}.rotateCw`); // red on top, blue below
    await k.run(`${C}.flipVertical`);
    const img = await sourcePixels(k.session);
    expect([img.w, img.h]).toEqual([2, 4]);
    expect(at(img, 0, 0)).toEqual([...BLUE]);
    expect(at(img, 0, 3)).toEqual([...RED]);
    expect(k.session.state().history?.depth).toBe(2);
    await k.run(`${C}.undo`);
    expect(at(await sourcePixels(k.session), 0, 0)).toEqual([...RED]);
    k.dispose();
  });

  it("commitCrop cuts the crop rectangle out of the image", async () => {
    covers("command:media.paged.image.command.commitCrop");
    await refusesWithoutImage(`${C}.commitCrop`, /Nothing to crop/);
    const k = await ingested();
    const crop = k.session.cropMachine()!;
    // Drag the top-left handle to (2,1): the rect is the bottom-right
    // 2×1 corner, all blue.
    crop.pointerDown([0, 0]);
    crop.pointerMove([2, 1]);
    crop.pointerUp();
    await k.run(`${C}.commitCrop`);
    const img = await sourcePixels(k.session);
    expect([img.w, img.h]).toEqual([2, 1]);
    expect(at(img, 0, 0)).toEqual([...BLUE]);
    expect(k.session.state().uncommitted).toBe(true);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });
});

describe("the layer stack", () => {
  it("addLayer adds an empty pixel layer on top and makes it active; undo removes it", async () => {
    covers("command:media.paged.image.command.addLayer");
    await refusesWithoutImage(`${C}.addLayer`);
    const k = await ingested();
    await k.run(`${C}.addLayer`);
    const layers = k.session.state().layers;
    expect(layers.layers.map((l) => [l.name, l.kind])).toEqual([
      ["Background", "pixels"],
      ["Layer 2", "pixels"],
    ]);
    expect(layers.active).toBe(1);
    expect(k.docOps()).toEqual([]);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    await k.run(`${C}.redo`);
    expect(k.session.state().layers.layers).toHaveLength(2);
    k.dispose();
  });

  it("addLayerMask adds a reveal-all mask to the active layer; undo removes it", async () => {
    covers("command:media.paged.image.command.addLayerMask");
    await refusesWithoutImage(`${C}.addLayerMask`, /Select a placed image/);
    const k = await ingested();
    await k.run(`${C}.addLayerMask`);
    expect(k.session.state().layers.layers[0].hasMask).toBe(true);
    expect(k.session.state().status).toMatch(/reveal-all mask/);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers[0].hasMask).toBe(false);
    k.dispose();
  });

  it("addLayerMaskHideAll adds a hide-all mask (its composite is GPU-only and says so); undo removes it", async () => {
    covers("command:media.paged.image.command.addLayerMaskHideAll");
    await refusesWithoutImage(
      `${C}.addLayerMaskHideAll`,
      /Select a placed image/,
    );
    const k = await ingested();
    await k.run(`${C}.addLayerMaskHideAll`);
    expect(k.session.state().layers.layers[0].hasMask).toBe(true);
    // Hiding everything changes the composite, and compositing layers
    // is a WGSL dispatch: the mask is in the stack, the frame is not
    // recomposited, and the status names the GPU.
    expect(k.session.state().status).toMatch(/GPU-only/);
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers[0].hasMask).toBe(false);
    k.dispose();
  });

  it("convertLayerToSmart turns the active layer into a smart object; undo restores the pixel layer", async () => {
    covers("command:media.paged.image.command.convertLayerToSmart");
    await refusesWithoutImage(
      `${C}.convertLayerToSmart`,
      /Select a placed image/,
    );
    const k = await ingested();
    await k.run(`${C}.convertLayerToSmart`);
    expect(k.session.state().layers.layers[0].kind).toBe("smart");
    expect(k.session.state().history?.undoLabel).toBe(
      "Convert to smart object",
    );
    await k.run(`${C}.undo`);
    expect(k.session.state().layers.layers[0].kind).toBe("pixels");
    k.dispose();
  });

  it("bakeAdjustToLayer refuses at identity, and is GPU-only past it", async () => {
    covers("command:media.paged.image.command.bakeAdjustToLayer");
    await refusesWithoutImage(`${C}.bakeAdjustToLayer`);
    const k = await ingested();
    await k.run(`${C}.bakeAdjustToLayer`);
    expect(k.session.state().status).toMatch(/nothing to bake/);
    await k.run(`${C}.autoEnhance`);
    const before = imageShape(k.session);
    await k.run(`${C}.bakeAdjustToLayer`);
    expect(k.session.state().status).toMatch(/GPU-only/);
    expect(imageShape(k.session)).toEqual(before);
    k.dispose();
  });
});

describe("the image's own undo and redo", () => {
  it("undo steps the last pixel edit back, and says so when there is none", async () => {
    covers("command:media.paged.image.command.undo");
    await refusesWithoutImage(`${C}.undo`);
    const k = await ingested();
    await k.run(`${C}.undo`);
    expect(k.session.state().status).toBe("Nothing to undo.");
    await k.run(`${C}.flipHorizontal`);
    await k.run(`${C}.undo`);
    expect(k.session.state().status).toBe("Undid “Flip horizontal”.");
    expect(at(await sourcePixels(k.session), 0, 0)).toEqual([...RED]);
    expect(k.session.state().history?.redoDepth).toBe(1);
    // The document's own history is not the image's: nothing was sent.
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("redo re-applies the undone edit, and says so when there is none", async () => {
    covers("command:media.paged.image.command.redo");
    await refusesWithoutImage(`${C}.redo`);
    const k = await ingested();
    await k.run(`${C}.redo`);
    expect(k.session.state().status).toBe("Nothing to redo.");
    await k.run(`${C}.flipHorizontal`);
    await k.run(`${C}.undo`);
    await k.run(`${C}.redo`);
    expect(k.session.state().status).toBe("Redid “Flip horizontal”.");
    expect(at(await sourcePixels(k.session), 0, 0)).toEqual([...BLUE]);
    k.dispose();
  });
});

describe("commit to the document", () => {
  it("commitImage writes the edited composite and the layer record into the frame, in one batch", async () => {
    covers("command:media.paged.image.command.commitImage");
    await refusesWithoutImage(
      `${C}.commitImage`,
      /Commit needs an image ingested from a frame/,
    );
    const k = await ingested();
    await k.run(`${C}.rotateCw`);
    await k.run(`${C}.commitImage`);
    const ops = k.docOps();
    expect(ops.map((o) => o.op)).toEqual(["batch"]);
    const children = ops[0].args.ops as Array<{
      op: string;
      args: Record<string, unknown>;
    }>;
    expect(children.map((c) => c.op)).toEqual([
      "replaceImageBytes",
      "setPluginMetadata",
    ]);
    const placed = await decoded(k.fake.placed.get("u1")!);
    expect([placed.w, placed.h]).toEqual([2, 4]);
    expect(k.session.state().committedRev).toBe(1);
    expect(k.session.state().uncommitted).toBe(false);
    k.dispose();
  });
});

describe("GPU-only verbs decline in Node, honestly", () => {
  /** Ingest, run `id` (after `prep`), and assert the GPU refusal left the
   *  image, the journal and the document alone. */
  async function declinesForGpu(
    id: string,
    gpuReason: RegExp,
    prep: (
      k: Awaited<ReturnType<typeof ingested>>,
    ) => Promise<void> = async () => {},
  ) {
    const k = await ingested();
    await prep(k);
    const before = imageShape(k.session);
    const pixels = await sourcePixels(k.session);
    await k.run(id);
    expect(k.session.state().status).toMatch(gpuReason);
    expect(imageShape(k.session)).toEqual(before);
    expect(await sourcePixels(k.session)).toEqual(pixels);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  }

  it("fillSelection (foreground → background gradient)", async () => {
    covers("command:media.paged.image.command.fillSelection");
    await refusesWithoutImage(`${C}.fillSelection`);
    await declinesForGpu(`${C}.fillSelection`, /generators are GPU-only/);
  });

  it("fillNoise", async () => {
    covers("command:media.paged.image.command.fillNoise");
    await refusesWithoutImage(`${C}.fillNoise`);
    await declinesForGpu(`${C}.fillNoise`, /generators are GPU-only/);
  });

  it("contentAwareFill needs a selection, then is GPU-only", async () => {
    covers("command:media.paged.image.command.contentAwareFill");
    await refusesWithoutImage(`${C}.contentAwareFill`);
    const k = await ingested();
    await k.run(`${C}.contentAwareFill`);
    expect(k.session.state().status).toMatch(/Select the area to fill first/);
    k.dispose();
    await declinesForGpu(`${C}.contentAwareFill`, /GPU-only/, (k2) =>
      k2.run(`${C}.selectAll`),
    );
  });

  it("median", async () => {
    covers("command:media.paged.image.command.median");
    await refusesWithoutImage(`${C}.median`);
    await declinesForGpu(`${C}.median`, /Median is a GPU-only kernel/);
  });

  it("maximum", async () => {
    covers("command:media.paged.image.command.maximum");
    await refusesWithoutImage(`${C}.maximum`);
    await declinesForGpu(`${C}.maximum`, /Maximum is a GPU-only kernel/);
  });

  it("minimum", async () => {
    covers("command:media.paged.image.command.minimum");
    await refusesWithoutImage(`${C}.minimum`);
    await declinesForGpu(`${C}.minimum`, /Minimum is a GPU-only kernel/);
  });

  it("fillForeground", async () => {
    covers("command:media.paged.image.command.fillForeground");
    await refusesWithoutImage(`${C}.fillForeground`);
    await declinesForGpu(`${C}.fillForeground`, /Fill is a GPU-only kernel/);
  });

  it("fillPattern needs a defined pattern, then is GPU-only", async () => {
    covers("command:media.paged.image.command.fillPattern");
    await refusesWithoutImage(`${C}.fillPattern`, /No pattern defined/);
    await declinesForGpu(
      `${C}.fillPattern`,
      /Pattern fill is a GPU-only kernel/,
      (k) => k.run(`${C}.definePattern`),
    );
  });

  it("shapeBlur needs a defined pattern, then is GPU-only", async () => {
    covers("command:media.paged.image.command.shapeBlur");
    await refusesWithoutImage(`${C}.shapeBlur`, /define one first/);
    await declinesForGpu(
      `${C}.shapeBlur`,
      /Shape blur is a GPU-only kernel/,
      (k) => k.run(`${C}.definePattern`),
    );
  });
});
