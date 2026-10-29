// SMART OBJECTS in full (image ADR 482, WP5.14) through the REGISTERED
// commands and the session's controller, on the bundle over the fake
// editor and the real wasm: convert, transform (one undo step, re-rendered
// from the source), Edit Contents as a nested document saved back as one
// step in the parent, smart filters (pending without a GPU, one step),
// Replace / Relink / Update / Embed / Export, the host Links panel's rows,
// and a vector smart object placed from page items.
//
// Node has no WebGPU: a smart filter's pass cannot run here, so its state
// is asserted as pending — the GPU lane and the Rust suite draw it.

import { describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { makeLinksBindingProvider } from "../src/binding-provider/links-provider";
import { bundleOnFake, C, sourcePixels, twoColourPng } from "./command-kit";

async function ingested(
  shell: Parameters<typeof bundleOnFake>[0] extends infer O
    ? O extends { shell?: infer S }
      ? S
      : never
    : never = {},
) {
  const k = await bundleOnFake({ shell });
  await k.ingest();
  return k;
}
type K = Awaited<ReturnType<typeof ingested>>;

const lastStep = (k: K) => k.session.state().history?.undoSteps.at(-1);
const info = (k: K) => k.session.smart().info(0);
/** The red channel of each pixel of the composite, left to right. */
async function reds(k: K): Promise<number[]> {
  const img = await sourcePixels(k.session);
  const out: number[] = [];
  for (let i = 0; i < img.px.length; i += 4) out.push(img.px[i]!);
  return out;
}

describe("[image.layers.smart-objects-full] convert and transform", () => {
  it("Filter ▸ Convert for smart filters makes the layer a smart object placed where it was", async () => {
    covers("command:media.paged.image.command.convertForSmartFilters");
    const k = await ingested();
    await k.run(`${C}.convertForSmartFilters`);
    expect(k.session.state().layers.layers[0]?.kind).toBe("smart");
    const i = info(k)!;
    expect(i.quad).toEqual([0, 0, 4, 0, 4, 2, 0, 2]);
    expect([i.width, i.height]).toEqual([4, 2]);
    expect(i.file).toBeNull();
    expect(lastStep(k)).toBe("Convert to smart object");
    k.dispose();
  });

  it("a transform re-renders from the source and is one undo step", async () => {
    covers("command:media.paged.image.command.smartTransform");
    const k = await ingested();
    await k.run(`${C}.convertLayerToSmart`);
    const before = await reds(k);
    // Layer ▸ Smart objects ▸ Transform… opens the dialog.
    await k.run(`${C}.smartTransform`);
    expect(k.session.state().dialog?.kind).toBe("smartTransform");
    await k.session.closeDialog();
    // A horizontal flip about the centre.
    expect(await k.session.smart().transform(0, { scaleX: -100 })).toBe(true);
    expect(info(k)!.quad).toEqual([4, 0, 0, 0, 0, 2, 4, 2]);
    expect(lastStep(k)).toBe("Transform smart object");
    const flipped = await reds(k);
    expect(flipped).toEqual([
      before[3],
      before[2],
      before[1],
      before[0],
      before[7],
      before[6],
      before[5],
      before[4],
    ]);
    // Down to a quarter and back: the source draws it again, lossless.
    await k.session.smart().transform(0, { scaleX: 25, scaleY: 25 });
    await k.session.smart().transform(0, { scaleX: 400, scaleY: 400 });
    expect(await reds(k)).toEqual(flipped);
    await k.session.undo();
    await k.session.undo();
    await k.session.undo();
    expect(await reds(k)).toEqual(before);
    k.dispose();
  });
});

describe("[image.layers.smart-objects-full] Edit Contents", () => {
  it("opens the source as a nested document; Save and close is one step in the parent", async () => {
    covers("command:media.paged.image.command.smartEditContents");
    covers("command:media.paged.image.command.smartSaveContents");
    const k = await ingested();
    await k.run(`${C}.convertLayerToSmart`);
    const before = await reds(k);
    const steps = k.session.state().history!.undoSteps.length;
    await k.run(`${C}.smartEditContents`);
    expect(k.session.state().smartNested).toBe("Background");
    expect(k.session.smart().state().nested).toEqual(["Background"]);
    // An edit inside the contents: flip them.
    await k.run(`${C}.flipHorizontal`);
    await k.run(`${C}.smartSaveContents`);
    expect(k.session.state().smartNested).toBeNull();
    expect(lastStep(k)).toBe("Edit Contents");
    expect(k.session.state().history!.undoSteps.length).toBe(steps + 1);
    const after = await reds(k);
    expect(after).toEqual([
      before[3],
      before[2],
      before[1],
      before[0],
      before[7],
      before[6],
      before[5],
      before[4],
    ]);
    expect(info(k)!.file?.type).toBe("8BPB");
    await k.session.undo();
    expect(await reds(k)).toEqual(before);
    k.dispose();
  });

  it("Close contents without saving leaves the parent as it was", async () => {
    covers("command:media.paged.image.command.smartCloseContents");
    const k = await ingested();
    await k.run(`${C}.convertLayerToSmart`);
    const before = await reds(k);
    const label = lastStep(k);
    await k.run(`${C}.smartEditContents`);
    await k.run(`${C}.flipHorizontal`);
    await k.run(`${C}.smartCloseContents`);
    expect(k.session.state().smartNested).toBeNull();
    expect(lastStep(k)).toBe(label);
    expect(await reds(k)).toEqual(before);
    k.dispose();
  });

  it("a commit saves open contents into their smart object first", async () => {
    const k = await ingested();
    await k.run(`${C}.convertLayerToSmart`);
    await k.run(`${C}.smartEditContents`);
    await k.run(`${C}.flipHorizontal`);
    await k.session.commitToDocument();
    expect(k.session.state().smartNested).toBeNull();
    expect(lastStep(k)).toBe("Edit Contents");
    k.dispose();
  });
});

describe("[image.layers.smart-objects-full] smart filters", () => {
  it("a filter on a smart object is a smart filter: one step, pending until a GPU runs it", async () => {
    covers("command:media.paged.image.command.filterGaussianBlur");
    const k = await ingested();
    await k.run(`${C}.convertLayerToSmart`);
    await k.run(`${C}.filterGaussianBlur`);
    const d = k.session.state().dialog;
    expect(d?.kind === "filter" && d.filter.id).toBe("gaussianBlur");
    await k.session.closeDialog();
    expect(await k.session.applyFilter("gaussianBlur", { radius: 1.5 })).toBe(
      true,
    );
    const f = info(k)!.filters!;
    expect(f.filters.map((x) => [x.id, x.values?.radius, x.enabled])).toEqual([
      ["gaussianBlur", 1.5, true],
    ]);
    expect(info(k)!.pendingFilters).toBe(true);
    expect(lastStep(k)).toBe("Smart Filters");
    // Switched off, then deleted: each one step.
    await k.session.smart().setFilter(0, 0, { enabled: false });
    expect(info(k)!.filters!.filters[0]!.enabled).toBe(false);
    expect(info(k)!.pendingFilters).toBe(false);
    await k.session.smart().removeFilter(0, 0);
    expect(info(k)!.filters).toBeNull();
    await k.session.undo();
    await k.session.undo();
    expect(info(k)!.filters!.filters[0]!.enabled).toBe(true);
    k.dispose();
  });
});

describe("[image.layers.smart-objects-full] contents and links", () => {
  const picker = (name: string, bytes: Uint8Array) => ({
    supports: true,
    pickFile: async () => [{ name, bytes }],
  });

  it("Replace contents, Relink, Update from file and Embed; the Links panel lists the file", async () => {
    covers("command:media.paged.image.command.smartReplaceContents");
    covers("command:media.paged.image.command.smartRelink");
    covers("command:media.paged.image.command.smartUpdateLinked");
    covers("command:media.paged.image.command.smartEmbed");
    const png = await twoColourPng(2, 2);
    const k = await ingested(picker("other.png", png) as never);
    await k.run(`${C}.convertLayerToSmart`);
    await k.run(`${C}.smartReplaceContents`);
    expect(info(k)!.file).toMatchObject({ name: "other.png", linked: false });
    expect([info(k)!.width, info(k)!.height]).toEqual([2, 2]);
    // The same scale about the first corner: 2×2 source at 1:1.
    expect(info(k)!.quad).toEqual([0, 0, 2, 0, 2, 2, 0, 2]);
    expect(lastStep(k)).toBe("Replace Contents");
    const links = makeLinksBindingProvider(k.session).provider;
    const rows = () =>
      (
        links.readCollection!({ collection: "links" }) as {
          rows: Array<{
            hostSelfId: string;
            status: string;
            actions: Record<string, string>;
          }>;
        }
      ).rows;
    expect(rows()).toEqual([
      expect.objectContaining({
        hostSelfId: `smart:${k.session.state().layers.layers[0]!.id}`,
        status: "embedded",
        actions: { relink: `${C}.smartRelink` },
      }),
    ]);
    // Relink through the Links panel's action: the row's id as payload.
    await k.run(`${C}.smartRelink`, { link: rows()[0]!.hostSelfId });
    expect(info(k)!.file).toMatchObject({ linked: true, path: "other.png" });
    expect(lastStep(k)).toBe("Relink");
    expect(rows()[0]!.actions).toEqual({
      relink: `${C}.smartRelink`,
      update: `${C}.smartUpdateLinked`,
      embed: `${C}.smartEmbed`,
    });
    await k.run(`${C}.smartUpdateLinked`, { link: rows()[0]!.hostSelfId });
    expect(lastStep(k)).toBe("Update Modified Content");
    await k.run(`${C}.smartEmbed`);
    expect(info(k)!.file).toMatchObject({ linked: false });
    expect(lastStep(k)).toBe("Embed Linked");
    k.dispose();
  });

  it("Export contents hands the source file to the host", async () => {
    covers("command:media.paged.image.command.smartExportContents");
    const saved: string[] = [];
    const k = await ingested({
      saveFile: async (o: { suggestedName: string }) => {
        saved.push(o.suggestedName);
        return true;
      },
    } as never);
    await k.run(`${C}.convertLayerToSmart`);
    await k.run(`${C}.smartExportContents`);
    expect(saved).toEqual(["Background.png"]);
    k.dispose();
  });
});

describe("[image.layers.smart-objects-full] vector smart objects", () => {
  it("places page items drawn by the host as a vector smart object", async () => {
    covers("command:media.paged.image.command.smartPlacePageItems");
    const k = await ingested();
    // With only the image's own frame selected there is nothing to place.
    await k.run(`${C}.smartPlacePageItems`);
    expect(k.session.state().layers.layers).toHaveLength(1);
    // The host draws the items: 2×1 px at the image's resolution, over
    // the frame's right half's top row.
    k.fake.onSend("requestSnapshot", () => ({
      kind: "snapshotReady",
      payload: {
        pageId: "pg1",
        widthPx: 2,
        heightPx: 1,
        pngBytes: [],
        layoutGeneration: 1,
        format: "rgba",
        rgba: [0, 255, 0, 255, 0, 255, 0, 255],
        region: { x: 100, y: 0, width: 100, height: 50 },
      },
    }));
    // Placed (one undo step); without a GPU the two-layer fold that
    // follows cannot run, which is the composite's refusal, not the
    // placement's.
    await k.session.smart().placePageItems(["d1"]);
    const layers = k.session.state().layers.layers;
    expect(layers).toHaveLength(2);
    expect(layers[1]!.kind).toBe("smart");
    const v = k.session.smart().info(1)!;
    expect(v.vector).toMatchObject({ items: ["d1"] });
    expect(v.quad).toEqual([2, 0, 4, 0, 4, 1, 2, 1]);
    expect(lastStep(k)).toBe("Place as smart object");
    k.dispose();
  });
});
