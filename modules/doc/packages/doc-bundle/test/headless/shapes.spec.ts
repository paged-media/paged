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

// Doc ADR 627 — shapes without text on the real engine: File ▸ Open of
// `shapes.docx` draws each shape along its outline, not as its box. The
// triangle (apex at 30 %) covers half of its box, the freeform less than
// its box, the rotated rounded rectangle and the ellipse are painted; an
// unedited export keeps the drawings as written.

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

import { afterEach, describe, expect, it } from "bun:test";

import type {
  ExporterContribution,
  ImporterContribution,
} from "@paged-media/plugin-api";
import {
  createHeadlessHost,
  type HeadlessHost,
  silentConsole as silent,
} from "@paged-media/plugin-sdk";

import { docBundle } from "../../src";
import {
  docxPresent,
  ENGINE_ANCHOR,
  fixture,
  requireDocx,
} from "../conformance/harness";

requireDocx("doc headless — shapes");

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** A PNG's pixels as RGBA (8-bit, non-interlaced, as the engine writes). */
function pixels(png: Uint8Array): { w: number; h: number; rgba: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  let w = 0;
  let h = 0;
  let channels = 4;
  const idat: Uint8Array[] = [];
  while (at < png.length) {
    const len = view.getUint32(at);
    const kind = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + len);
    if (kind === "IHDR") {
      w = new DataView(body.buffer, body.byteOffset).getUint32(0);
      h = new DataView(body.buffer, body.byteOffset).getUint32(4);
      channels = body[9] === 6 ? 4 : 3;
    } else if (kind === "IDAT") idat.push(body);
    at += 12 + len;
  }
  const raw = new Uint8Array(inflateSync(Buffer.concat(idat)));
  const stride = w * channels;
  const out = new Uint8Array(w * h * 4);
  const prev = new Uint8Array(stride);
  const row = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      row[x] =
        (line[x]! +
          (filter === 0
            ? 0
            : filter === 1
              ? a
              : filter === 2
                ? b
                : filter === 3
                  ? (a + b) >> 1
                  : paeth)) &
        255;
    }
    prev.set(row);
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < 3; k++)
        out[(y * w + x) * 4 + k] = row[x * channels + k]!;
      out[(y * w + x) * 4 + 3] = channels === 4 ? row[x * channels + 3]! : 255;
    }
  }
  return { w, h, rgba: out };
}

/** The pixels of `rgb` (within 6 per channel) in a render, and their box. */
function paint(
  img: { w: number; h: number; rgba: Uint8Array },
  rgb: [number, number, number],
) {
  let count = 0;
  let [x0, y0, x1, y1] = [img.w, img.h, 0, 0];
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      if (
        rgb.every((v, k) => Math.abs(img.rgba[i + k]! - v) <= 6) &&
        img.rgba[i + 3]! > 200
      ) {
        count++;
        [x0, y0, x1, y1] = [
          Math.min(x0, x),
          Math.min(y0, y),
          Math.max(x1, x),
          Math.max(y1, y),
        ];
      }
    }
  return { count, box: (x1 - x0 + 1) * (y1 - y0 + 1) };
}

describe.skipIf(!docxPresent)("doc headless — shapes @feat:doc-shapes", () => {
  let h: HeadlessHost | undefined;
  afterEach(() => h?.dispose());

  it("File ▸ Open draws each shape along its outline", async () => {
    const bytes = fixture("shapes.docx");
    // The engine lays text out, and draws a story, only with a font.
    const inter = new Uint8Array(
      readFileSync(
        new URL(
          "../../../../../../engine/core/corpus/fonts/Inter.ttf",
          import.meta.url,
        ),
      ),
    );
    h = await createHeadlessHost({
      resolveFrom: ENGINE_ANCHOR,
      console: silent,
      defaultFont: inter,
    });
    h.loadBundle(docBundle);
    const importer = h
      .importersContributed()
      .find(
        (c) => c.id === "media.paged.doc.importer.docx",
      ) as ImporterContribution;
    await h.newBlank(300, 300);
    await importer.import({
      name: "shapes.docx",
      bytes,
      mimeType: DOCX_MIME,
      newDocument: true,
    });
    const send = (m: unknown) =>
      h!.host.editor.client.send(m as never) as Promise<{
        payload?: { output?: string[] };
      }>;
    const r = await send({
      kind: "executeScript",
      payload: { source: "paged.pages()" },
    });
    const pages = JSON.parse(r.payload?.output?.[0] ?? "[]") as Array<{
      selfId: string;
    }>;
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) {
      await send({
        kind: "requestPage",
        payload: { pageId: p.selfId, lod: "live" },
      });
    }
    // Scale 2: 72 pt boxes are 144 px.
    const renders: Array<{ w: number; h: number; rgba: Uint8Array }> = [];
    for (const p of pages) {
      const s = await h.host.render.snapshot(p.selfId as never, {
        widthPx: 1224,
      });
      renders.push(pixels(s!.png));
    }
    const sum = (rgb: [number, number, number]) => {
      let count = 0;
      let box = 0;
      for (const img of renders) {
        const p = paint(img, rgb);
        count += p.count;
        box = Math.max(box, p.box);
      }
      return { count, box };
    };
    // The triangle: 72 x 72 pt, apex at 30 %: half of its box.
    const blue = sum([0x2e, 0x74, 0xb5]);
    expect(blue.count).toBeGreaterThan(0);
    expect(blue.count / (144 * 144)).toBeGreaterThan(0.4);
    expect(blue.count / (144 * 144)).toBeLessThan(0.6);
    // The freeform (72 x 72 pt): a peaked shape, well under its box.
    const amber = sum([0xff, 0xc0, 0x00]);
    expect(amber.count).toBeGreaterThan(0);
    expect(amber.count / (144 * 144)).toBeLessThan(0.8);
    // The rotated rounded rectangle and the rectangle are painted.
    expect(sum([0x70, 0xad, 0x47]).count).toBeGreaterThan(0);
    expect(sum([0xc0, 0x00, 0x00]).count).toBeGreaterThan(0);

    const exporter = h
      .exportersContributed()
      .find(
        (c) => c.id === "media.paged.doc.exporter.docx",
      ) as ExporterContribution;
    const out = await exporter.export();
    expect(out).not.toBeNull();
  }, 180_000);
});
