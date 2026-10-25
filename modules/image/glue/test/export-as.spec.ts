// FILE ▸ EXPORT AS (ADR 468) over the real image-js wasm in Node: the
// command opens the dialog; `exportAs` writes TIFF, WebP, JPEG and PNG
// through paged-raster with the source's metadata and the sRGB profile,
// CMYK TIFF without a profile says it was naive, and the bytes reach the
// host's saver. A TIFF and a WebP open through the importer lane, and the
// PNG save-back keeps what the source carried.

import { describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import type { ExportOptions } from "../src/engine";
import {
  bundleOnFake,
  C,
  imageEngine,
  twoColourRgba,
  W,
  H,
} from "./command-kit";

const base: ExportOptions = {
  format: "tiff",
  quality: 90,
  ppi: 300,
  keepMetadata: true,
  embedProfile: true,
  mode: "rgb",
  bits: 8,
  compression: "lzw",
  intent: "relativeColorimetric",
};

async function withSaver() {
  const saved: Array<{
    suggestedName: string;
    bytes: Uint8Array;
    mimeType?: string;
  }> = [];
  const k = await bundleOnFake({
    shell: {
      saveFile: async (o) => {
        saved.push(o);
        return true;
      },
    },
  });
  await k.ingest();
  return { k, saved };
}

describe("[image.codec.core-codecs] Export As", () => {
  it("the command opens the Export As dialog over the panel", async () => {
    covers("command:media.paged.image.command.exportAs");
    const { k } = await withSaver();
    await k.run(`${C}.exportAs`);
    expect(k.session.state().dialog).toEqual({ kind: "exportAs" });
    await k.session.closeDialog();
    expect(k.session.state().dialog).toBeNull();
    k.dispose();
  });

  it("writes every format with the sRGB profile and the resolution, and hands it to the saver", async () => {
    const { k, saved } = await withSaver();
    const e = await imageEngine();
    for (const [format, magic] of [
      ["tiff", [0x49, 0x49]],
      ["webp", [0x52, 0x49, 0x46, 0x46]],
      ["jpeg", [0xff, 0xd8, 0xff]],
      ["png", [0x89, 0x50, 0x4e, 0x47]],
    ] as const) {
      const r = await k.session.exportAs({ ...base, format });
      expect(r).not.toBeNull();
      expect(Array.from(r!.bytes.slice(0, magic.length))).toEqual([...magic]);
      expect(e.imageMetadata(r!.bytes).icc).toBeGreaterThan(0);
      if (format === "webp") expect(r!.note).toMatch(/lossless/);
      // It opens again, at the size it was written.
      const d = e.decode(r!.bytes);
      expect([d.width, d.height]).toEqual([W, H]);
      e.freeImage(d.handle);
    }
    expect(saved.map((s) => s.suggestedName.split(".").pop())).toEqual([
      "tif",
      "webp",
      "jpg",
      "png",
    ]);
    expect(saved[0]!.mimeType).toBe("image/tiff");
    expect(k.session.state().dialog).toBeNull();
    k.dispose();
  });

  it("scales, strips and converts to CMYK (naive without a profile, and says so)", async () => {
    const { k } = await withSaver();
    const e = await imageEngine();
    const r = await k.session.exportAs({
      ...base,
      mode: "cmyk",
      width: W * 2,
      height: H * 2,
      keepMetadata: false,
    });
    expect(r!.note).toMatch(/without a profile/);
    expect(e.imageMetadata(r!.bytes).icc).toBe(0);
    const d = e.decode(r!.bytes);
    expect([d.width, d.height]).toEqual([W * 2, H * 2]);
    expect(d.display).toBe("cmyk-uncalibrated");
    e.freeImage(d.handle);
    k.dispose();
  });

  it("16-bit TIFF of an 8-bit session is widened and says so", async () => {
    const { k } = await withSaver();
    const r = await k.session.exportAs({ ...base, bits: 16 });
    expect(r!.note).toMatch(/16 bits/);
    k.dispose();
  });

  it("TIFF and WebP open through the importer, and the exporters write them", async () => {
    covers("exporter:media.paged.image.exporter.tiff");
    covers("exporter:media.paged.image.exporter.webp");
    const e = await imageEngine();
    const rgba = twoColourRgba();
    for (const format of ["tiff", "webp"] as const) {
      const k = await bundleOnFake();
      const bytes = e.exportImage(
        rgba,
        W,
        H,
        `format=${format};meta=0;icc=0`,
        new Uint8Array(0),
        new Uint8Array(0),
      );
      const importer = k.fake.importers.get(
        "media.paged.image.importer.raster",
      ) as unknown as {
        import: (f: { name: string; bytes: Uint8Array }) => Promise<void>;
      };
      await importer.import({ name: `x.${format}`, bytes });
      expect(k.session.state().source).toMatchObject({ width: W, height: H });
      const exporter = k.fake.exporters.get(
        `media.paged.image.exporter.${format}`,
      ) as unknown as {
        export: () => Promise<{ bytes: Uint8Array; fileName: string } | null>;
      };
      const out = await exporter.export();
      expect(out!.fileName).toMatch(format === "tiff" ? /\.tif$/ : /\.webp$/);
      const back = e.decode(out!.bytes);
      expect(Array.from(e.tile(back.handle, 0, 0, W, H))).toEqual(
        Array.from(rgba),
      );
      e.freeImage(back.handle);
      k.dispose();
    }
  });
});
