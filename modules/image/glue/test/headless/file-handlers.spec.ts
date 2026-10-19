// paged.image's FILE HANDLERS on the headless host: the raster importer
// (File ▸ Open / drop routes PSD, PNG and JPEG bytes here) and the three
// exporters (the Export Center pulls bytes from them), each through its
// REGISTERED contribution, over files built in code: the engine's own PNG
// and JPEG encodes and the hand-assembled 2×1 PSD of helpers.ts.
//
// Every exporter is asserted on the bytes it hands over (the format's
// magic, a decode back to the pixels) and on what it does with nothing to
// export (null: the Export Center's honest empty result), and round-trips
// through the importer.

import { fileURLToPath } from "node:url";

import { describe, expect, it } from "bun:test";

import type {
  ExporterContribution,
  ImporterContribution,
} from "@paged-media/plugin-api";
import { createHeadlessHost } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import { imageBundle } from "../../src";
import { lastSession } from "../bundle-session";
import {
  at,
  BLUE,
  C,
  decoded,
  FRAME,
  quiesce,
  RED,
  sourcePixels,
  twoColourPng,
} from "../command-kit";
import { minimalIdml } from "../fixtures/minimal-idml";
import { psdBytes, silentConsole } from "../helpers";

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));

async function host() {
  const h = await createHeadlessHost({
    resolveFrom: ENGINE_ANCHOR,
    console: silentConsole,
  });
  await h.load(minimalIdml());
  h.loadBundle(imageBundle);
  const session = lastSession();
  const importer = h.importersContributed()[0] as ImporterContribution;
  const exporter = (id: string) =>
    h
      .exportersContributed()
      .find(
        (e) => e.id === `media.paged.image.exporter.${id}`,
      ) as ExporterContribution;
  const open = async (name: string, bytes: Uint8Array, mimeType: string) => {
    await importer.import({ name, bytes, mimeType });
    await quiesce(session);
  };
  const run = async (id: string) => {
    const c = h.contributions.find((x) => x.kind === "command" && x.id === id);
    await (c!.value as { handler: (p: unknown) => unknown }).handler(null);
    await quiesce(session);
  };
  return { h, session, importer, exporter, open, run };
}

describe("the raster importer", () => {
  it("opens PNG, PSD and JPEG bytes into the session; into a selected empty frame it places the image as one document undo step", async () => {
    covers("importer:media.paged.image.importer.raster");
    const k = await host();
    expect(k.importer.extensions).toEqual([
      ".psd",
      ".psb",
      ".png",
      ".jpg",
      ".jpeg",
    ]);
    // Nothing selected: the file opens in the panel's session, bound to
    // no frame (Commit has nowhere to go and says so).
    await k.open("two.png", await twoColourPng(), "image/png");
    const s = k.session.state();
    expect([s.source?.width, s.source?.height, s.source?.origin]).toEqual([
      4,
      2,
      "import",
    ]);
    expect(s.source?.elementId).toBeNull();
    expect(at(await sourcePixels(k.session), 0, 0)).toEqual([...RED]);
    // A PSD opens as a PSD session (its records kept for the re-emit).
    await k.open("tiny.psd", psdBytes(), "image/vnd.adobe.photoshop");
    expect(k.session.state().psd?.name).toBe("tiny.psd");
    expect(k.session.state().source?.width).toBe(2);
    // A JPEG decodes (lossy: the red is within a step or two).
    const jpeg = (await k.exporter("jpeg").export()) ?? null;
    expect(jpeg).not.toBeNull();
    await k.open("photo.jpg", jpeg!.bytes, "image/jpeg");
    expect(k.session.state().source?.width).toBe(2);
    // Into the selected EMPTY frame: placed in it, layers stored, and the
    // document's undo takes the placement back.
    await k.h.host.selection.set([{ kind: "rectangle", id: FRAME } as never]);
    await k.open("two.png", await twoColourPng(), "image/png");
    expect(k.session.state().source?.elementId).toBe(FRAME);
    const placed = await k.h.host.assets.getPlacedImage(FRAME);
    expect(at(await decoded(placed!.bytes), 3, 0)).toEqual([...BLUE]);
    await k.h.host.document.undo();
    expect(await k.h.host.assets.getPlacedImage(FRAME)).toBeNull();
    k.h.dispose();
  });
});

describe("the exporters", () => {
  it("PSD: null with no PSD open; a zero-edit export is byte-identical; an edited one carries the edit", async () => {
    covers("exporter:media.paged.image.exporter.psd");
    const k = await host();
    const psd = k.exporter("psd");
    expect(psd.extension).toBe(".psd");
    expect(await psd.export()).toBeNull();
    // A PNG is open: still no PSD to re-emit.
    await k.open("two.png", await twoColourPng(), "image/png");
    expect(await psd.export()).toBeNull();
    await k.open("tiny.psd", psdBytes(), "image/vnd.adobe.photoshop");
    const untouched = (await psd.export())!;
    expect(untouched.fileName).toBe("tiny.psd");
    // §10.4, "Paged never destroys a PSD": no edit, the same bytes.
    expect(Array.from(untouched.bytes)).toEqual(Array.from(psdBytes()));
    await k.run(`${C}.flipHorizontal`);
    const edited = (await psd.export())!;
    expect(Array.from(edited.bytes.slice(0, 4))).toEqual([
      0x38, 0x42, 0x50, 0x53,
    ]);
    // The fixture's pixels are (10,30,50) then (20,40,60): flipped.
    const img = await decoded(edited.bytes);
    expect(at(img, 0, 0)).toEqual([20, 40, 60, 255]);
    k.h.dispose();
  });

  it("PNG: null with nothing open; the adjusted pixels, losslessly, and back through the importer", async () => {
    covers("exporter:media.paged.image.exporter.png");
    const k = await host();
    const png = k.exporter("png");
    expect([png.extension, png.mimeType]).toEqual([".png", "image/png"]);
    expect(await png.export()).toBeNull();
    await k.open("two.png", await twoColourPng(), "image/png");
    await k.run(`${C}.flipHorizontal`);
    const out = (await png.export())!;
    expect(out.fileName).toBe("two.png");
    expect(Array.from(out.bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const img = await decoded(out.bytes);
    expect([img.w, img.h]).toEqual([4, 2]);
    expect(at(img, 0, 0)).toEqual([...BLUE]);
    // Round trip: the exported file opens to the same pixels.
    await k.open("again.png", out.bytes, "image/png");
    expect((await sourcePixels(k.session)).px).toEqual(img.px);
    k.h.dispose();
  });

  it("JPEG: null with nothing open; a baseline JPEG of the pixels, which opens again", async () => {
    covers("exporter:media.paged.image.exporter.jpeg");
    const k = await host();
    const jpeg = k.exporter("jpeg");
    expect([jpeg.extension, jpeg.mimeType]).toEqual([".jpg", "image/jpeg"]);
    expect(await jpeg.export()).toBeNull();
    await k.open("two.png", await twoColourPng(), "image/png");
    const out = (await jpeg.export())!;
    expect(out.fileName).toBe("two.jpg");
    expect(Array.from(out.bytes.slice(0, 3))).toEqual([0xff, 0xd8, 0xff]);
    const img = await decoded(out.bytes);
    expect([img.w, img.h]).toEqual([4, 2]);
    // Lossy: the left pixel is still red, within a few levels.
    const [r, g, b] = at(img, 0, 0);
    expect(Math.abs(r! - 200)).toBeLessThan(16);
    expect(g!).toBeLessThan(16);
    expect(b!).toBeLessThan(16);
    await k.open("two.jpg", out.bytes, "image/jpeg");
    expect(k.session.state().source?.width).toBe(4);
    k.h.dispose();
  });
});
