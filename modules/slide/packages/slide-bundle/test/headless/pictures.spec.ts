/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// Slide W4's content verbs on the real engine (the canvas-wasm, headless)
// and the real slide wasm: pictures in every format inserted and exported
// as PowerPoint holds them, the format painter, the SmartArt text pane.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateRawSync } from "node:zlib";

import { afterEach, describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import type {
  BundleHost,
  ElementId,
  ExporterContribution,
} from "@paged-media/plugin-api";
import { bytesToBase64 } from "@paged-media/helpers";
import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

import { activate, keepSource } from "../../src/activate";
import { CONTENT_CMD } from "../../src/content-commands";
import { slideEngine } from "../../src/engine";
import { slideAddress } from "../../src/object-model";
import { pictureSize } from "../../src/pictures";

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"),
) as Parameters<HeadlessHost["loadBundle"]>[0]["manifest"];

/** Keep a written deck for PowerPoint's open-check (ADR 705) when
 *  `PAGED_SLIDE_EXPORT_DIR` names a folder. */
function keep(bytes: Uint8Array, name: string) {
  const dir = process.env.PAGED_SLIDE_EXPORT_DIR;
  if (dir) writeFileSync(`${dir}/${name}.pptx`, bytes);
}

const hosts: HeadlessHost[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
});

function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(
      new URL(
        `../../../../slide-conformance/fixtures/${name}.pptx`,
        import.meta.url,
      ),
    ),
  );
}

async function open(bytes: Uint8Array, name: string) {
  const h = await createHeadlessHost({ resolveFrom: ENGINE_ANCHOR });
  hosts.push(h);
  let host!: BundleHost;
  h.loadBundle({
    manifest,
    activate(x) {
      host = x;
      return activate(x);
    },
  });
  const exporter = h.exportersContributed()[0] as ExporterContribution;
  const { paged, report } = (await slideEngine()).importPptx(bytes, name);
  await h.load(paged);
  await keepSource(host, bytes, report);
  return { h, host, exporter };
}

/** Every part of a zip package (central directory, stored or deflated). */
function zipParts(bytes: Uint8Array): Map<string, Buffer> {
  const b = Buffer.from(bytes);
  let eocd = b.length - 22;
  while (eocd >= 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = b.readUInt32LE(eocd + 16);
  const n = b.readUInt16LE(eocd + 10);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < n; i++) {
    const method = b.readUInt16LE(p + 10);
    const size = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extra = b.readUInt16LE(p + 30);
    const comment = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.toString("utf8", p + 46, p + 46 + nameLen);
    const start =
      local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const data = b.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

// ── test pictures, written here (no file of the corpus) ──────────────────

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const W = 8;
const H = 4;
/** An opaque blue picture, `W` × `H`. */
const pixel = [0x44, 0x72, 0xc4];
/** The picture as a PNG: RGB, or RGBA (opaque) with `alpha`. */
function png(alpha = false): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, "latin1");
    Buffer.from(data).copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  const n = alpha ? 4 : 3;
  ihdr.set([8, alpha ? 6 : 2, 0, 0, 0], 8);
  const raw = Buffer.alloc(H * (1 + W * n));
  const px = alpha ? [...pixel, 0xff] : pixel;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) raw.set(px, y * (1 + W * n) + 1 + x * n);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}
function bmp(): Uint8Array {
  const row = Math.ceil((W * 3) / 4) * 4;
  const b = Buffer.alloc(54 + row * H);
  b.write("BM", 0, "latin1");
  b.writeUInt32LE(b.length, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(W, 18);
  b.writeInt32LE(H, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      b.set([pixel[2]!, pixel[1]!, pixel[0]!], 54 + y * row + x * 3);
  return new Uint8Array(b);
}
function tga(): Uint8Array {
  const b = Buffer.alloc(18 + W * H * 3);
  b[2] = 2;
  b.writeUInt16LE(W, 12);
  b.writeUInt16LE(H, 14);
  b[16] = 24;
  for (let i = 0; i < W * H; i++)
    b.set([pixel[2]!, pixel[1]!, pixel[0]!], 18 + i * 3);
  return new Uint8Array(b);
}
function qoi(): Uint8Array {
  const head = Buffer.alloc(14);
  head.write("qoif", 0, "latin1");
  head.writeUInt32BE(W, 4);
  head.writeUInt32BE(H, 8);
  head[12] = 3;
  const ops: number[] = [0xfe, ...pixel];
  // The rest repeat the first: one run op covers up to 62 pixels.
  ops.push(0xc0 | (W * H - 2));
  return new Uint8Array(
    Buffer.concat([
      head,
      Buffer.from(ops),
      Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]),
    ]),
  );
}
function psd(): Uint8Array {
  const head = Buffer.alloc(26);
  head.write("8BPS", 0, "latin1");
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(3, 12);
  head.writeUInt32BE(H, 14);
  head.writeUInt32BE(W, 18);
  head.writeUInt16BE(8, 22);
  head.writeUInt16BE(3, 24);
  const lens = Buffer.alloc(12); // colour data, resources, layers: none
  const comp = Buffer.from([0, 0]); // raw
  const planes = Buffer.concat(pixel.map((v) => Buffer.alloc(W * H, v)));
  return new Uint8Array(Buffer.concat([head, lens, comp, planes]));
}
function ico(): Uint8Array {
  // An icon's PNG is RGBA (decoders refuse another colour type).
  const p = png(true);
  const d = Buffer.alloc(22);
  d.writeUInt16LE(1, 2);
  d.writeUInt16LE(1, 4);
  d[6] = W;
  d[7] = H;
  d.writeUInt16LE(1, 10);
  d.writeUInt16LE(32, 12);
  d.writeUInt32LE(p.length, 14);
  d.writeUInt32LE(22, 18);
  return new Uint8Array(Buffer.concat([d, Buffer.from(p)]));
}
const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const GIF = b64("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==");
/** An 8 × 4 lossless WebP of the pixel above (image-webp's encoder): an
 *  opaque picture, so the PNG the engine renders of it has pixels. */
const WEBP = b64(
  "UklGRpgAAABXRUJQVlA4TIsAAAAvB8AAAM1VICICHogEAAAAAIABAAAAAAAAAAAAAAAAAAwA" +
    "AAAAAAAAAAAAAAAAAAAAAAAEAHggAQAAAAAA5x8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
    "QAAAAAAA4IEEAAAAAACcfwAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAABA5IcCAA==",
);
/** An 8 × 4 baseline JPEG (macOS `sips` from the PNG above). */
const JPEG = b64(
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAA" +
    "AAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAACKADAAQAAAABAAAABAAAAAD/7QA4UGhvdG9z" +
    "aG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgA" +
    "BAAIAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIB" +
    "AwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYX" +
    "GBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeI" +
    "iYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn" +
    "6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIB" +
    "AgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDTh" +
    "JfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWG" +
    "h4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm" +
    "5+jp6vLz9PX29/j5+v/bAEMABgYGBgYGCgYGCg4KCgoOEg4ODg4SFxISEhISFxwXFxcXFxcc" +
    "HBwcHBwcHCIiIiIiIicnJycnLCwsLCwsLCwsLP/bAEMBBwcHCwoLEwoKEy4fGh8uLi4uLi4u" +
    "Li4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLv/dAAQAAf/aAAwD" +
    "AQACEQMRAD8Ax6KKK+4PnT//2Q==",
);
function tiff(): Uint8Array {
  // Little-endian, one strip of 8-bit RGB.
  const entries: [number, number, number, number][] = [
    [256, 3, 1, W],
    [257, 3, 1, H],
    [258, 3, 1, 8],
    [259, 3, 1, 1],
    [262, 3, 1, 2],
    [273, 4, 1, 8 + 2 + 9 * 12 + 4],
    [277, 3, 1, 3],
    [278, 3, 1, H],
    [279, 4, 1, W * H * 3],
  ];
  const b = Buffer.alloc(8 + 2 + entries.length * 12 + 4 + W * H * 3);
  b.write("II", 0, "latin1");
  b.writeUInt16LE(42, 2);
  b.writeUInt32LE(8, 4);
  b.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, ty, n, v], i) => {
    const at = 10 + i * 12;
    b.writeUInt16LE(tag, at);
    b.writeUInt16LE(ty, at + 2);
    b.writeUInt32LE(n, at + 4);
    if (ty === 3) b.writeUInt16LE(v, at + 8);
    else b.writeUInt32LE(v, at + 8);
  });
  const data = 10 + entries.length * 12 + 4;
  for (let i = 0; i < W * H; i++) b.set(pixel, data + i * 3);
  return new Uint8Array(b);
}
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" viewBox="0 0 64 32"><rect width="64" height="32" fill="#4472c4"/><circle cx="16" cy="16" r="10" fill="#ed7d31"/></svg>',
);

async function insert(host: BundleHost, bytes: Uint8Array, icon = false) {
  const pages = await host.document.collection<{ selfId: string }>("pages");
  return (await host.objects.invoke(
    icon ? CONTENT_CMD.insertIcon : CONTENT_CMD.insertPicture,
    {
      data: bytesToBase64(bytes),
      slide: slideAddress(pages[0]!.selfId),
      x: 300,
      y: 200,
    },
  )) as { picture: string };
}

function pngSize(b: Buffer): [number, number] {
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

/** The last picture of slide 1: its XML and its parts. */
function lastPicture(parts: Map<string, Buffer>) {
  const slide = parts.get("ppt/slides/slide1.xml")!.toString("utf8");
  const pic = slide.slice(slide.lastIndexOf("<p:pic>"));
  const rels = parts.get("ppt/slides/_rels/slide1.xml.rels")!.toString("utf8");
  const target = (rid: string) => {
    const m =
      new RegExp(`Id="${rid}"[^>]*Target="\\.\\./media/([^"]+)"`).exec(rels) ??
      new RegExp(`Target="\\.\\./media/([^"]+)"[^>]*Id="${rid}"`).exec(rels);
    return m ? `ppt/media/${m[1]}` : null;
  };
  const blip = /<a:blip r:embed="([^"]+)"/.exec(pic)?.[1];
  const svg = /<asvg:svgBlip [^>]*r:embed="([^"]+)"/.exec(pic)?.[1];
  return {
    pic,
    blip: blip ? target(blip) : null,
    svg: svg ? target(svg) : null,
    types: parts.get("[Content_Types].xml")!.toString("utf8"),
  };
}

describe("pictures in every format (slide W4)", () => {
  it("a picture is placed at its own size, fitted to the slide", () => {
    expect(
      pictureSize({ format: "png", width: 400, height: 200 }, [960, 540]),
    ).toEqual([300, 150]);
    expect(
      pictureSize({ format: "png", width: 4000, height: 2000 }, [960, 540]),
    ).toEqual([960, 480]);
    expect(
      pictureSize({ format: "eps", width: 72, height: 36 }, [960, 540]),
    ).toEqual([72, 36]);
    expect(
      pictureSize({ format: "webp", width: null, height: null }, [960, 540]),
    ).toEqual([288, 216]);
    expect(
      pictureSize({ format: "png", width: 400, height: 200 }, [960, 540], 100),
    ).toEqual([100, 50]);
  });

  for (const [name, make, ext, ct] of [
    ["PNG", png, "png", "image/png"],
    ["JPEG", () => JPEG, "jpeg", "image/jpeg"],
    ["GIF", () => GIF, "gif", "image/gif"],
    ["BMP", bmp, "bmp", "image/bmp"],
    ["TIFF", tiff, "tiff", "image/tiff"],
  ] as const) {
    it(`a ${name} picture is written as it is, with its content type`, async () => {
      covers("command:media.paged.slide.command.insertPicture");
      const bytes = fixture("geometry");
      const { host, exporter } = await open(bytes, "geometry");
      const pic = make();
      const res = await insert(host, pic);
      expect(res.picture).toMatch(/rectangle/);
      const out = await exporter.export();
      keep(out!.bytes, `picture-${ext}`);
      const parts = zipParts(out!.bytes);
      const p = lastPicture(parts);
      expect(p.blip).toMatch(new RegExp(`\\.${ext}$`));
      expect(Buffer.from(parts.get(p.blip!)!).equals(Buffer.from(pic))).toBe(
        true,
      );
      expect(p.svg).toBeNull();
      expect(p.types.toLowerCase()).toContain(
        `extension="${ext}" contenttype="${ct}"`,
      );
      // It reads back as a picture.
      const back = (await slideEngine()).importPptx(out!.bytes, "back");
      expect(back.report.diagnostics.join("\n")).not.toContain("not placed");
    }, 120_000);
  }

  it("an SVG icon stays vector and is written with its PNG fallback", async () => {
    covers("command:media.paged.slide.command.insertIcon");
    const bytes = fixture("geometry");
    const { host, exporter } = await open(bytes, "geometry");
    await insert(host, SVG, true);
    // Its natural size: 64 × 32 px at 96 dpi.
    const pics = await host.document.elementGeometry([
      { kind: "rectangle", id: await insertedId(host) } as ElementId,
    ]);
    const bnd = (pics[0] as { bounds: number[] }).bounds;
    expect(Math.abs(bnd[3]! - bnd[1]!)).toBeCloseTo(48, 1);
    expect(Math.abs(bnd[2]! - bnd[0]!)).toBeCloseTo(24, 1);
    const out = await exporter.export();
    keep(out!.bytes, "picture-svg");
    const parts = zipParts(out!.bytes);
    const p = lastPicture(parts);
    expect(p.pic).toContain(
      '<a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}">',
    );
    expect(p.svg).toMatch(/\.svg$/);
    expect(Buffer.from(parts.get(p.svg!)!).equals(Buffer.from(SVG))).toBe(true);
    expect(p.blip).toMatch(/\.png$/);
    // The fallback the engine rendered, at 192 dpi: 128 × 64 px.
    const [fw, fh] = pngSize(parts.get(p.blip!)!);
    expect(fw).toBeGreaterThanOrEqual(127);
    expect(fh).toBeGreaterThanOrEqual(63);
    expect(p.types).toContain('Extension="svg" ContentType="image/svg+xml"');
    // An SVG that is not one is refused as an icon.
    await expect(insert(host, png(), true)).rejects.toThrow();
  }, 120_000);

  // WebP, TGA, QOI and ICO are decoded by the exporter (ADR 723); a PSD
  // goes as the PNG the host renders of the frame.
  for (const [name, make, how] of [
    ["WebP", () => WEBP, "a PNG of its own pixels"],
    ["TGA", tga, "a PNG of its own pixels"],
    ["QOI", qoi, "a PNG of its own pixels"],
    ["PSD", psd, "the PNG the engine renders of it"],
    ["ICO", ico, "a PNG of its own pixels"],
  ] as const) {
    it(`a ${name} picture is written as ${how}`, async () => {
      const bytes = fixture("geometry");
      const { host, exporter } = await open(bytes, "geometry");
      await insert(host, make());
      const out = await exporter.export();
      keep(out!.bytes, `picture-${name.toLowerCase()}`);
      const parts = zipParts(out!.bytes);
      const p = lastPicture(parts);
      expect(p.blip).toMatch(/\.png$/);
      expect(p.svg).toBeNull();
      expect(p.pic).not.toContain("a:srcRect");
      const [w] = pngSize(parts.get(p.blip!)!);
      expect(w).toBeGreaterThan(0);
      const ext = name.toLowerCase();
      expect([...parts.keys()].some((k) => k.endsWith(`.${ext}`))).toBe(false);
    }, 120_000);
  }
});

/** The id of the picture frame inserted last (the page's last rectangle). */
async function insertedId(host: BundleHost): Promise<string> {
  const tree = (await host.document.tree()) as {
    children?: { children?: { id?: { kind: string; id: string } }[] }[];
  }[];
  const items = tree[0]!.children![0]!.children ?? [];
  const last = [...items].reverse().find((n) => n.id?.kind === "rectangle");
  return last!.id!.id;
}
