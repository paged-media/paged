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

// SVG IMPORT OF A SHAPE WITH SEVERAL CONTOURS, through the REAL engine. A
// ring used to land as two filled siblings — the hole painted over by the
// inner disc, whatever the file's `fill-rule` said. It is ONE compound
// element now, wound for its fill rule by draw-geometry's
// `orientForFillRule`. Anchor tables cannot tell a ring from a coin (the
// engine fills NON-ZERO, so that is decided by the windings), so every
// hole here is ALSO read off a real PDF: the page content stream is
// inflated and the painted path's subpaths are measured — one fill op,
// one path, alternating signed areas.

import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import {
  contourRanges,
  contourSignedArea,
  parseSvgDocument,
  type AnchorTriple,
} from "@paged-media/draw-geometry";

import { drawBundle, exportSvg, importSvg, leafIdsOf } from "../../src";
import { commitSvgImport, shapesFromSvgBytes } from "../../src/io/svg";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { countingHost } from "../perf/counting-host";
import { openHost } from "./host";

const enc = (s: string) => new TextEncoder().encode(s);
const file = (name: string, svg: string) => ({
  name,
  bytes: enc(svg),
  mimeType: "image/svg+xml",
});
const svgOf = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">${body}</svg>`;

/** A square as path data, clockwise (in SVG's y-down frame) or not. */
const sq = (x: number, y: number, n: number, cw = true): string =>
  cw ? `M${x} ${y}h${n}v${n}h${-n}Z` : `M${x} ${y}v${n}h${n}v${-n}Z`;

/** The signed area of each of an element's contours, as the engine
 *  stores them. */
async function areasOf(h: HeadlessHost, id: ElementId): Promise<number[]> {
  const r = await h.host.document.pathAnchors(id);
  if (!r) throw new Error(`no anchors for ${String(id.id)}`);
  return contourRanges(r.anchors.length, r.subpathStarts).map(([from, to]) =>
    contourSignedArea(r.anchors.slice(from, to) as AnchorTriple[]),
  );
}

// ------------------------------------------------------- export helper
// Rides `host.editor.client` — the MARKED escape hatch (DESIGN.md §4.9):
// a conformance spec may reach an engine query the plugin contract does
// not expose (export); the bundle's own source never does. The same
// reading `compound-path.spec.ts` and `image-trace.spec.ts` make.

interface PdfClient {
  send(m: { kind: string; payload: unknown }): Promise<{
    kind: string;
    payload: Record<string, unknown>;
  }>;
}

/** The page-1 PDF content stream, inflated. */
async function pdfContentStream(h: HeadlessHost): Promise<string> {
  const client = (h.host as unknown as { editor: { client: PdfClient } }).editor
    .client;
  const begun = await client.send({
    kind: "exportPdfBegin",
    payload: { options: {} },
  });
  const session = begun.payload.session as number;
  const pages = begun.payload.pageCount as number;
  for (let i = 0; i < pages; i++) {
    await client.send({ kind: "exportPdfPage", payload: { session } });
  }
  const fin = await client.send({
    kind: "exportPdfFinish",
    payload: { session },
  });
  const bytes = new Uint8Array(fin.payload.pdfBytes as number[]);
  const text = new TextDecoder("latin1").decode(bytes);
  const length = Number(/\/Length (\d+)/.exec(text)![1]);
  const start = text.indexOf("stream\n") + "stream\n".length;
  return new TextDecoder("latin1").decode(
    inflateSync(bytes.subarray(start, start + length)),
  );
}

/** The vertex rings of every subpath built inside ONE `q … Q` block. */
function subpathsOf(block: string): [number, number][][] {
  const rings: [number, number][][] = [];
  let cur: [number, number][] | null = null;
  for (const raw of block.split("\n")) {
    const m = /^((?:-?[\d.]+\s+)+)([a-zA-Z]+\*?)$/.exec(raw.trim());
    if (!m) continue;
    const n = m[1].trim().split(/\s+/).map(Number);
    if (m[2] === "m") {
      cur = [[n[0], n[1]]];
      rings.push(cur);
    } else if (m[2] === "l") {
      cur?.push([n[0], n[1]]);
    } else if (m[2] === "c") {
      cur?.push([n[4], n[5]]);
    }
  }
  return rings;
}

const ringArea = (ring: [number, number][]): number => {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return sum / 2;
};

/** The FILLED paint blocks the import added: the subpath areas of every
 *  `f` block with `rings` subpaths, minus those there before. */
async function paintedWith(
  h: HeadlessHost,
  rings: number,
  run: () => Promise<unknown>,
): Promise<number[][]> {
  const blocks = async () =>
    (await pdfContentStream(h))
      .split(/\nq\n/)
      .slice(1)
      .filter((b) => /^f$/m.test(b))
      .map(subpathsOf)
      .filter((b) => b.length === rings)
      .map((b) => b.map(ringArea));
  const before = await blocks();
  await run();
  const after = await blocks();
  return after.slice(before.length);
}

/** The signs of the areas, relative to the first: what non-zero reads. */
const relative = (areas: readonly number[]): number[] =>
  areas.map((a) => Math.sign(a) * Math.sign(areas[0]!));

describe("SVG import — a shape of several contours is ONE compound path [plugin-draw.svg-io]", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  const leaves = async (): Promise<ElementId[]> =>
    leafIdsOf(await h.host.document.tree());

  it("a NONZERO ring wound opposite lands as one element with a hole, as authored", async () => {
    const svg = svgOf(
      `<path d="${sq(20, 20, 100)} ${sq(50, 50, 40, false)}" fill="#cc3300"/>`,
    );
    let ids: ElementId[] = [];
    const painted = await paintedWith(h, 2, async () => {
      ids = await importSvg(h.host, file("ring.svg", svg));
    });
    expect(ids).toHaveLength(1);
    const areas = await areasOf(h, ids[0]!);
    // Exactly the authored winding — nothing was turned.
    const authored = shapesFromSvgBytes(enc(svg))[0]!.anchors;
    expect(areas).toEqual(
      contourRanges(authored.anchors.length, authored.subpathStarts).map(
        ([from, to]) => contourSignedArea(authored.anchors.slice(from, to)),
      ),
    );
    expect(relative(areas)).toEqual([1, -1]);
    // THE HOLE RENDERS: one filled path, two opposite subpaths.
    expect(painted).toHaveLength(1);
    expect(relative(painted[0]!)).toEqual([1, -1]);
    expect(Math.abs(painted[0]![0]!)).toBeCloseTo(10000, 0);
    expect(Math.abs(painted[0]![1]!)).toBeCloseTo(1600, 0);
    await h.host.document.undo();
  });

  it("an EVENODD ring wound the SAME way lands as one element whose inner contour is re-wound", async () => {
    const svg = svgOf(
      `<path d="${sq(20, 20, 100)} ${sq(50, 50, 40)}" fill-rule="evenodd" fill="#0033cc"/>`,
    );
    const authored = shapesFromSvgBytes(enc(svg))[0]!.anchors;
    expect(Math.sign(contourSignedArea(authored.anchors.slice(0, 4)))).toBe(
      Math.sign(contourSignedArea(authored.anchors.slice(4, 8))),
    );
    let ids: ElementId[] = [];
    const painted = await paintedWith(h, 2, async () => {
      ids = await importSvg(h.host, file("evenodd.svg", svg));
    });
    expect(ids).toHaveLength(1);
    const areas = await areasOf(h, ids[0]!);
    // Contour 0 kept its direction; the hole turned.
    expect(Math.sign(areas[0]!)).toBe(
      Math.sign(contourSignedArea(authored.anchors.slice(0, 4))),
    );
    expect(relative(areas)).toEqual([1, -1]);
    expect(painted).toHaveLength(1);
    expect(relative(painted[0]!)).toEqual([1, -1]);
    await h.host.document.undo();
  });

  it("a NONZERO ring wound the same way stays a solid disc — what every SVG renderer paints", async () => {
    const svg = svgOf(
      `<path d="${sq(20, 20, 100)} ${sq(50, 50, 40)}" fill="#00cc33"/>`,
    );
    const ids = await importSvg(h.host, file("solid.svg", svg));
    expect(ids).toHaveLength(1);
    expect(relative(await areasOf(h, ids[0]!))).toEqual([1, 1]);
    await h.host.document.undo();
  });

  it("a THREE-level nested evenodd shape alternates its windings at every depth", async () => {
    // Four squares, all drawn the same way round: even-odd paints depth 0
    // and 2 and leaves 1 and 3 empty.
    const svg = svgOf(
      `<path d="${sq(10, 10, 200)} ${sq(30, 30, 160)} ${sq(50, 50, 120)} ${sq(70, 70, 80)}" fill-rule="evenodd" fill="#663399"/>`,
    );
    let ids: ElementId[] = [];
    const painted = await paintedWith(h, 4, async () => {
      ids = await importSvg(h.host, file("nested.svg", svg));
    });
    expect(ids).toHaveLength(1);
    expect(relative(await areasOf(h, ids[0]!))).toEqual([1, -1, 1, -1]);
    expect(painted).toHaveLength(1);
    expect(relative(painted[0]!)).toEqual([1, -1, 1, -1]);
    await h.host.document.undo();
  });

  it("contours that do not nest — two squares in one <path> — are one element, both filled, its box around both", async () => {
    const svg = svgOf(
      `<path d="${sq(20, 20, 40)} ${sq(200, 20, 40)}" fill-rule="evenodd" fill="#996600"/>`,
    );
    let ids: ElementId[] = [];
    const painted = await paintedWith(h, 2, async () => {
      ids = await importSvg(h.host, file("apart.svg", svg));
    });
    expect(ids).toHaveLength(1);
    // Neither is inside the other, so neither is a hole: same winding.
    expect(relative(await areasOf(h, ids[0]!))).toEqual([1, 1]);
    expect(relative(painted[0]!)).toEqual([1, 1]);
    // The frame box covers both contours, not just the first.
    const [g] = await h.host.document.elementGeometry([ids[0]!]);
    expect(g!.bounds.map((v) => Math.round(v))).toEqual([20, 20, 60, 240]);
    await h.host.document.undo();
  });

  it("one file of compounds is ONE mutation and ONE undo step", async () => {
    const before = await leaves();
    const swatches = (await h.host.document.collection("swatches")).length;
    const svg = svgOf(
      `<path d="${sq(20, 20, 100)} ${sq(50, 50, 40, false)}" fill="#111111"/>` +
        `<path d="${sq(140, 20, 100)} ${sq(170, 50, 40)}" fill-rule="evenodd" fill="#222222"/>` +
        `<rect x="20" y="150" width="40" height="40" fill="#333333"/>`,
    );
    const { host, work } = countingHost(h.host);
    const done = await commitSvgImport(host, file("batch.svg", svg));
    expect(done).toEqual({
      shapes: 3,
      elements: 3,
      swatches: 3,
      batches: 1,
      refused: 0,
    });
    const counted = work.snapshot();
    // 3 swatches; per shape insert, bind, three paints; per compound
    // `framePath` and `frameBounds`.
    expect(counted.mutations).toEqual([
      { op: "batch", ops: 3 + 3 * 5 + 2 * 2 },
    ]);
    expect((await leaves()).length).toBe(before.length + 3);
    await h.host.document.undo();
    expect(await leaves()).toEqual(before);
    expect((await h.host.document.collection("swatches")).length).toBe(
      swatches,
    );
  });

  it("an OPEN contour past the first keeps the shape one element per contour (framePath would close it)", async () => {
    const svg = svgOf(
      `<path d="M20 20 L120 20 M20 40 L120 40" fill="none" stroke="#000000" stroke-width="2"/>`,
    );
    const ids = await importSvg(h.host, file("open.svg", svg));
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      const r = await h.host.document.pathAnchors(id);
      expect(r!.subpathOpen?.[0]).toBe(true);
    }
    await h.host.document.undo();
  });

  it("on an engine that reports no page origin, a ring lands as one path per contour (and says so)", async () => {
    // The `pages` rows without `pageOrigin`, as an engine before core
    // 0.71.13 sends them.
    const warned: string[] = [];
    const blind = new Proxy(h.host, {
      get(target, key, receiver) {
        if (key === "log") {
          return {
            ...target.log,
            warn: (m: string) => warned.push(m),
          };
        }
        if (key !== "document") return Reflect.get(target, key, receiver);
        const doc = target.document;
        return new Proxy(doc, {
          get(d, k) {
            const v = Reflect.get(d, k) as unknown;
            if (k !== "collection") {
              return typeof v === "function" ? v.bind(d) : v;
            }
            return async (name: Parameters<typeof doc.collection>[0]) => {
              const rows = await doc.collection<Record<string, unknown>>(name);
              return name === "pages"
                ? rows.map(({ pageOrigin: _, ...row }) => row)
                : rows;
            };
          },
        });
      },
    }) as BundleHost;
    const svg = svgOf(
      `<path d="${sq(20, 20, 100)} ${sq(50, 50, 40, false)}" fill="#cc3300"/>`,
    );
    const done = await commitSvgImport(blind, file("blind.svg", svg));
    expect(done.elements).toBe(2);
    expect(done.batches).toBe(1);
    expect(warned.some((m) => /no page origin/.test(m))).toBe(true);
    await h.host.document.undo();
  });

  it("EXPORT writes a compound as ONE <path> of several subpaths, and it imports back as the same ring", async () => {
    const svg = svgOf(
      `<path d="${sq(20, 20, 100)} ${sq(50, 50, 40)}" fill-rule="evenodd" fill="#0033cc"/>`,
    );
    const ids = await importSvg(h.host, file("rt.svg", svg));
    expect(ids).toHaveLength(1);
    await h.host.selection.set(ids as never[]);
    const out = await exportSvg(h.host);
    const text = new TextDecoder().decode(out!.bytes);
    expect(text.match(/<path /g)).toHaveLength(1);
    // The engine fills non-zero over the windings it stores, and the
    // file says so.
    expect(text).toContain(`fill-rule="nonzero"`);
    const back = parseSvgDocument(text)!.shapes;
    expect(back).toHaveLength(1);
    const t = back[0]!.anchors;
    const areas = contourRanges(t.anchors.length, t.subpathStarts).map(
      ([from, to]) => contourSignedArea(t.anchors.slice(from, to)),
    );
    expect(relative(areas)).toEqual([1, -1]);
    expect(back[0]!.style.fill).toBe("#0033cc");
    await h.host.selection.set([]);
    await h.host.document.undo();
  });
});
