// WP9.4 (engine ADR 1038) over the real image-js wasm in Node: the
// "TIFF with layers" exporter writes a session opened from a layered PSD
// as a big-endian TIFF whose ImageSourceData tag carries the PSD's
// layers (the bytes Photoshop reopens with its layers), and Export As
// writes GIF, BMP, TGA and JPEG XL, each saying what the format drops.

import { describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import type { ExportOptions } from "../src/engine";
import { bundleOnFake, imageEngine, W, H } from "./command-kit";
import { layeredPsdBytes } from "./helpers";

const SIGNATURE = "Adobe Photoshop Document Data Block";

/** The bytes contain `text` (ASCII), anywhere. */
function contains(bytes: Uint8Array, text: string): boolean {
  const needle = Array.from(text, (c) => c.charCodeAt(0));
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++)
      if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

type Exporter = {
  export: () => Promise<{ bytes: Uint8Array; fileName: string } | null>;
};

describe("[images-graphics.codecs-long-tail] layered TIFF and the small encoders", () => {
  it("the TIFF-with-layers exporter writes a layered PSD session's layers into tag 37724", async () => {
    covers("exporter:media.paged.image.exporter.tiffLayers");
    const k = await bundleOnFake();
    const psd = await layeredPsdBytes(["Notes"]);
    expect(await k.session.importBytes("layers.psd", psd)).toBe(true);
    const exporter = k.fake.exporters.get(
      "media.paged.image.exporter.tiffLayers",
    ) as unknown as Exporter;
    const out = await exporter.export();
    expect(out).not.toBeNull();
    expect(out!.fileName).toBe("layers.tif");
    // Big-endian, the byte order Photoshop's layer data is read in.
    expect(Array.from(out!.bytes.slice(0, 4))).toEqual([0x4d, 0x4d, 0, 42]);
    expect(contains(out!.bytes, SIGNATURE)).toBe(true);
    expect(contains(out!.bytes, "8BIMLayr")).toBe(true);
    expect(contains(out!.bytes, "Notes")).toBe(true);
    expect(k.session.state().status).toMatch(/TIFF with the PSD's layers/);
    // Every TIFF reader sees the composite.
    const e = await imageEngine();
    const d = e.decode(out!.bytes);
    expect([d.width, d.height]).toEqual([2, 1]);
    e.freeImage(d.handle);
    k.dispose();
  });

  it("a session not opened from a PSD has no layers to write, and says so", async () => {
    const k = await bundleOnFake();
    await k.ingest();
    const exporter = k.fake.exporters.get(
      "media.paged.image.exporter.tiffLayers",
    ) as unknown as Exporter;
    expect(await exporter.export()).toBeNull();
    expect(k.session.state().status).toMatch(/written from a PSD/);
    k.dispose();
  });

  it("Export As writes GIF, BMP, TGA and JPEG XL and opens them again", async () => {
    const saved: string[] = [];
    const k = await bundleOnFake({
      shell: {
        saveFile: async (o) => {
          saved.push(o.suggestedName);
          return true;
        },
      },
    });
    await k.ingest();
    const e = await imageEngine();
    const base: ExportOptions = {
      format: "gif",
      quality: 90,
      ppi: 72,
      keepMetadata: true,
      embedProfile: true,
      mode: "rgb",
      bits: 8,
      compression: "lzw",
      intent: "relativeColorimetric",
    };
    for (const [format, magic, note] of [
      ["gif", [0x47, 0x49, 0x46], /no metadata/],
      ["bmp", [0x42, 0x4d], /no metadata/],
      ["tga", null, /no metadata/],
      ["jxl", [0xff, 0x0a], /lossless/],
    ] as const) {
      const r = await k.session.exportAs({ ...base, format });
      expect(r).not.toBeNull();
      if (magic)
        expect(Array.from(r!.bytes.slice(0, magic.length))).toEqual([...magic]);
      expect(r!.note).toMatch(note);
      const d = e.decode(r!.bytes);
      expect([d.width, d.height]).toEqual([W, H]);
      e.freeImage(d.handle);
    }
    expect(saved.map((n) => n.split(".").pop())).toEqual([
      "gif",
      "bmp",
      "tga",
      "jxl",
    ]);
    k.dispose();
  });
});
