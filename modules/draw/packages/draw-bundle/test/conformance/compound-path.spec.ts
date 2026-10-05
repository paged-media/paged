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

// COMPOUND PATHS through the REAL engine wasm the harness boots
// (protocol 57). Pins:
//   (1) the exact wire shapes Make / Release emit — `framePath` for the
//       whole-table replace, `deleteFrame` per consumed element,
//       `insertPath` per released contour (no new op was needed: this
//       is the same door core's own `apply_pathfinder` uses internally);
//   (2) the document SHAPE a Make produces — ONE element carrying both
//       contours, the other gone;
//   (3) the REAL undo count (RFI C-15 — assert it, never claim "one"):
//       Make = 1 batch, Make-with-an-open-survivor = 2 mutations,
//       Release = 1 batch for the whole selection (it was 2 PER ELEMENT
//       until the pieces could be named inside the batch; that lane is
//       the fallback now, and every release runs through both and
//       through hosts that cannot say what a batch created — the same
//       document must come out of each);
//   (4) THE HOLE ACTUALLY RENDERS. Anchor-table assertions cannot tell a
//       ring from a coin — under the engine's NON-ZERO fill that is
//       decided by the inner contour's WINDING. So the ring is exported
//       to a real PDF, the page content stream is inflated, and the
//       painted path's two subpaths are measured: same fill op, one
//       path, opposite signed areas. That is the definition of a
//       non-zero hole, read off the artifact a reader would print.
//   (5) the honest scope: a single selected element, open contours,
//       and a text frame in the CONSUMED role.
//   (6) WHICH contour turns is decided by the scene tree's PAINT ORDER
//       (Illustrator's rule — `test/oracle/compound-path.spec.ts`), not
//       by selection order and not by nesting: the backmost path keeps
//       its direction, every other one is wound against it.

import { inflateSync } from "node:zlib";
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";

import type {
  CommandContribution,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { contourSignedArea } from "@paged-media/draw-geometry";

import {
  drawBundle,
  applyMakeCompoundPath,
  applyReleaseCompoundPath,
  backmostContourOf,
  backmostIndexOf,
  compoundSourceOf,
  contourCountOf,
  makeCompoundTableByPaintOrder,
  framePathMutationFor,
  makeCompoundBatchFor,
  releaseInsertBatchFor,
  releasePaintBatchFor,
  tableInInnerSpace,
  MAKE_COMPOUND_PATH_COMMAND_ID,
  RELEASE_COMPOUND_PATH_COMMAND_ID,
} from "../../src";
import {
  releaseBatchForAll,
  releaseHandle,
  type ReleasePlan,
} from "../../src/commands/compound-path";
import { F6_RING_PAIR } from "../fixtures/corpus";
import { openHost } from "./host";
import { runThrough, type LaneName } from "./one-batch";

const poly = (id: string): ElementId => ({ kind: "polygon", id }) as ElementId;

const OUTER = poly(F6_RING_PAIR.ids.polygon!);
const INNER = poly(F6_RING_PAIR.innerId);
const OPEN = poly(F6_RING_PAIR.openId);

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

/** Every leaf element id in the scene tree. */
async function leafIds(h: HeadlessHost): Promise<string[]> {
  const out: string[] = [];
  const walk = (nodes: { id?: { id?: unknown }; children?: unknown[] }[]) => {
    for (const node of nodes) {
      const children = (node.children ?? []) as never[];
      if (children.length > 0) walk(children);
      else if (node.id && typeof node.id.id === "string") out.push(node.id.id);
    }
  };
  walk((await h.host.document.tree()) as never);
  return out.sort();
}

/** The element's contours, in the space the engine stores them. */
async function contoursOf(
  h: HeadlessHost,
  id: ElementId,
): Promise<{ starts: number[]; areas: number[] } | null> {
  const r = await h.host.document.pathAnchors(id).catch(() => null);
  if (!r) return null;
  const starts = r.subpathStarts.length > 0 ? [...r.subpathStarts] : [0];
  const areas = starts.map((from, i) =>
    contourSignedArea(
      r.anchors.slice(from, starts[i + 1] ?? r.anchors.length) as never,
    ),
  );
  return { starts, areas };
}

async function readProp(
  h: HeadlessHost,
  id: ElementId,
  path: string,
): Promise<unknown> {
  const props = await h.host.document.elementProperties(id);
  for (const e of props?.entries ?? []) {
    if (e.path === path) return e.value;
  }
  return undefined;
}

// ------------------------------------------------------- export helper
// Rides `host.editor.client` — the MARKED escape hatch (DESIGN.md §4.9):
// a conformance spec may reach an engine query the plugin contract does
// not expose (export); the bundle's own source never does.

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

/** The vertex rings of every subpath built inside ONE `q … Q` block,
 *  in PDF user space. `m` opens a subpath, `l` extends it, `c` extends
 *  it by the curve's endpoint (control points do not change the sign of
 *  the enclosed area for these corner-anchor quads), `h` closes it. */
function subpathsOf(block: string): [number, number][][] {
  const rings: [number, number][][] = [];
  let cur: [number, number][] | null = null;
  for (const raw of block.split("\n")) {
    const m = /^((?:-?[\d.]+\s+)+)([a-zA-Z]+\*?)$/.exec(raw.trim());
    if (!m) continue;
    const n = m[1].trim().split(/\s+/).map(Number);
    switch (m[2]) {
      case "m":
        cur = [[n[0], n[1]]];
        rings.push(cur);
        break;
      case "l":
        cur?.push([n[0], n[1]]);
        break;
      case "c":
        cur?.push([n[4], n[5]]);
        break;
      default:
        break;
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

/** Every FILLED (`f`) paint block of the content stream, with its
 *  subpath rings. */
function filledBlocks(stream: string): [number, number][][][] {
  return stream
    .split(/\nq\n/)
    .slice(1)
    .filter((b) => /^f$/m.test(b))
    .map(subpathsOf);
}

describe("draw conformance — COMPOUND PATHS (make / release)", () => {
  describe("the wire shapes", () => {
    const RING = {
      anchors: [
        { anchor: [0, 0], left: [0, 0], right: [0, 0] },
        { anchor: [10, 0], left: [10, 0], right: [10, 0] },
        { anchor: [2, 2], left: [2, 2], right: [2, 2] },
        { anchor: [4, 2], left: [4, 2], right: [4, 2] },
      ],
      subpathStarts: [0, 2],
      subpathOpen: [false, false],
    } as const;

    it("framePathMutationFor replaces the WHOLE table, boundaries included", () => {
      expect(framePathMutationFor(OUTER, RING as never)).toEqual({
        op: "setElementProperty",
        args: {
          elementId: OUTER,
          path: "framePath",
          value: {
            type: "framePath",
            value: {
              anchors: RING.anchors.map((a) => ({
                anchor: a.anchor,
                left: a.left,
                right: a.right,
              })),
              subpathStarts: [0, 2],
            },
          },
        },
      });
    });

    it("makeCompoundBatchFor = framePath on the survivor + deleteFrame per consumed", () => {
      const batch = makeCompoundBatchFor(OUTER, [INNER], RING as never) as Extract<
        Mutation,
        { op: "batch" }
      >;
      expect(batch.op).toBe("batch");
      expect(batch.args.ops).toHaveLength(2);
      expect(batch.args.ops[0]).toEqual(framePathMutationFor(OUTER, RING as never));
      expect(batch.args.ops[1]).toEqual({
        op: "deleteFrame",
        args: { frameId: F6_RING_PAIR.innerId },
      });
    });

    it("releaseInsertBatchFor keeps contour 0 and inserts the rest", () => {
      const one = { anchors: RING.anchors.slice(0, 2), subpathStarts: [0] };
      const two = {
        anchors: RING.anchors.slice(2),
        subpathStarts: [0],
        subpathOpen: [false],
      };
      const batch = releaseInsertBatchFor(
        OUTER,
        "usp",
        one as never,
        [two as never],
      ) as Extract<Mutation, { op: "batch" }>;
      expect(batch.args.ops).toHaveLength(2);
      expect(batch.args.ops[0]).toEqual(framePathMutationFor(OUTER, one as never));
      expect(batch.args.ops[1]).toEqual({
        op: "insertPath",
        args: {
          pageId: "usp",
          anchors: two.anchors.map((a) => ({
            anchor: a.anchor,
            left: a.left,
            right: a.right,
          })),
          open: false,
        },
      });
    });

    it("releasePaintBatchFor gives every piece the source's paint", () => {
      const batch = releasePaintBatchFor([poly("u9")], {
        fill: "Color/Black",
        stroke: "Color/Paper",
        weight: 2,
      }) as Extract<Mutation, { op: "batch" }>;
      expect(batch.args.ops).toHaveLength(3);
      expect(batch.args.ops[0]).toEqual({
        op: "setElementProperty",
        args: {
          elementId: poly("u9"),
          path: "frameFillColor",
          value: { type: "colorRef", value: "Color/Black" },
        },
      });
      // A source with no stroke weight emits no weight op.
      const thin = releasePaintBatchFor([poly("u9")], {
        fill: null,
        stroke: null,
        weight: null,
      }) as Extract<Mutation, { op: "batch" }>;
      expect(thin.args.ops).toHaveLength(2);
    });

    it("backmostIndexOf reads PAINT order (the tree's first = backmost), never selection order", () => {
      const order = ["polygon:a", "polygon:b", "polygon:c"];
      expect(backmostIndexOf([poly("c"), poly("a"), poly("b")], order)).toBe(1);
      expect(backmostIndexOf([poly("b"), poly("c")], order)).toBe(0);
      // An id the tree does not list is never "the one behind"…
      expect(backmostIndexOf([poly("x"), poly("c")], order)).toBe(1);
      // …and with none listed there is no answer to give.
      expect(backmostIndexOf([poly("x")], order)).toBeNull();
    });

    it("backmostContourOf: a single-contour input is its own contour, a COMPOUND input its LARGEST", () => {
      const sq = (x0: number, y0: number, s: number) => ({
        anchors: [
          [x0, y0],
          [x0 + s, y0],
          [x0 + s, y0 + s],
          [x0, y0 + s],
        ].map((p) => ({ anchor: p, left: p, right: p })),
        subpathStarts: [0],
        subpathOpen: [false],
      });
      // A ring listed HOLE FIRST: its outer contour is its second.
      const ring = {
        anchors: [...sq(20, 20, 10).anchors, ...sq(0, 0, 50).anchors],
        subpathStarts: [0, 4],
        subpathOpen: [false, false],
      };
      const tables = [sq(100, 0, 10), ring, sq(200, 0, 10)] as never[];
      expect(backmostContourOf(tables, 0)).toBe(0);
      expect(backmostContourOf(tables, 1)).toBe(2);
      expect(backmostContourOf(tables, 2)).toBe(3);
    });

    it("makeCompoundTableByPaintOrder: the backmost input keeps its direction, every other contour turns against it", () => {
      const quad = (x0: number, y0: number, x1: number, y1: number) => ({
        anchors: [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ].map((p) => ({ anchor: p, left: p, right: p })),
        subpathStarts: [0],
        subpathOpen: [false],
      });
      // Survivor (selected first) is the INNER square; the OUTER one is
      // behind it. Both drawn the same way round.
      const inner = quad(200, 200, 300, 300) as never;
      const outer = quad(100, 100, 400, 400) as never;
      const made = makeCompoundTableByPaintOrder([inner, outer], 1);
      expect(made.subpathStarts).toEqual([0, 4]);
      expect(made.anchors.slice(4)).toEqual((outer as { anchors: unknown[] }).anchors);
      expect(Math.sign(contourSignedArea(made.anchors.slice(0, 4)))).toBe(
        -Math.sign(contourSignedArea(made.anchors.slice(4))),
      );
    });

    it("tableInInnerSpace inverts the survivor's ItemTransform", () => {
      const shifted = tableInInnerSpace(RING as never, [1, 0, 0, 1, 10, 20]);
      expect(shifted!.anchors[0].anchor).toEqual([-10, -20]);
      // A singular transform has no inner space to write into.
      expect(tableInInnerSpace(RING as never, [0, 0, 0, 0, 0, 0])).toBeNull();
      // No transform ⇒ the table rides through untouched.
      expect(tableInInnerSpace(RING as never, null)).toBe(RING as never);
    });
  });

  describe("against the real engine (F6: outer quad + inner quad + an open path)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F6_RING_PAIR.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    beforeEach(async () => {
      await h.host.selection.set([]);
    });

    it("the FIXTURE is the trap: both quads are authored the SAME way round", async () => {
      const outer = await contoursOf(h, OUTER);
      const inner = await contoursOf(h, INNER);
      expect(outer!.starts).toHaveLength(1);
      expect(inner!.starts).toHaveLength(1);
      // Concatenating these as-is would paint a solid coin under
      // non-zero — which is exactly what the command must prevent.
      expect(Math.sign(outer!.areas[0])).toBe(Math.sign(inner!.areas[0]));
    });

    it("MAKE merges the contours into the survivor and consumes the other", async () => {
      await h.host.selection.set([OUTER, INNER]);
      expect(await applyMakeCompoundPath(h.host)).toBe(2);

      const ring = await contoursOf(h, OUTER);
      expect(ring!.starts).toEqual([0, 4]);
      // The inner contour is RE-WOUND — the whole point.
      expect(Math.sign(ring!.areas[0])).toBe(-Math.sign(ring!.areas[1]));
      // …and it is the small one that flipped, not the big one.
      expect(Math.abs(ring!.areas[0])).toBeCloseTo(90000, 3);
      expect(Math.abs(ring!.areas[1])).toBeCloseTo(10000, 3);

      expect(await leafIds(h)).toEqual(["uopen", "uouter"]);
      expect(h.host.selection.get()).toEqual([OUTER]);
    });

    it("UNDO — the merge is exactly ONE batch (C-15: assert, never claim)", async () => {
      // (continues from the merge above)
      await h.host.document.undo();
      expect(await leafIds(h)).toEqual(["uinner", "uopen", "uouter"]);
      const outer = await contoursOf(h, OUTER);
      expect(outer!.starts).toEqual([0]);
      const inner = await contoursOf(h, INNER);
      expect(Math.sign(outer!.areas[0])).toBe(Math.sign(inner!.areas[0]));
    });

    it("BACKMOST is the scene tree's PAINT ORDER: the inner square selected FIRST survives, and it is the one that turns", async () => {
      // F6 stacks OUTER behind INNER. Selecting INNER first makes it the
      // survivor (its contour comes first) — but not the backmost path.
      const authored = (await contoursOf(h, OUTER))!.areas[0];
      await h.host.selection.set([INNER, OUTER]);
      expect(await applyMakeCompoundPath(h.host)).toBe(2);

      const merged = await contoursOf(h, INNER);
      expect(merged!.starts).toEqual([0, 4]);
      expect(Math.abs(merged!.areas[0])).toBeCloseTo(10000, 3);
      expect(Math.abs(merged!.areas[1])).toBeCloseTo(90000, 3);
      // The path BEHIND keeps its direction; the survivor's own contour
      // is wound against it. (By selection order — or by "contour 0
      // never turns", the depth rule's anchor — it would be the other way
      // round: the same hole, the opposite assignment.)
      expect(Math.sign(merged!.areas[1])).toBe(Math.sign(authored));
      expect(Math.sign(merged!.areas[0])).toBe(-Math.sign(authored));
      expect(await leafIds(h)).toEqual(["uinner", "uopen"]);

      await h.host.document.undo();
      expect(await leafIds(h)).toEqual(["uinner", "uopen", "uouter"]);
    });

    it("THE HOLE RENDERS: the exported PDF paints ONE path, two OPPOSITE contours", async () => {
      // Before: three separate filled paths, each ONE contour — which
      // also proves this parser sees real path construction ops.
      const before = filledBlocks(await pdfContentStream(h));
      expect(before.map((b) => b.length)).toEqual([1, 1, 1]);

      await h.host.selection.set([OUTER, INNER]);
      expect(await applyMakeCompoundPath(h.host)).toBe(2);

      const after = filledBlocks(await pdfContentStream(h));
      const compound = after.filter((b) => b.length === 2);
      // ONE paint op, TWO subpaths — the ring reached the page content
      // stream as a single filled path.
      expect(compound).toHaveLength(1);
      const [outerRing, innerRing] = compound[0];
      // The engine fills NON-ZERO (`paged-export-pdf` emits `f`, never
      // `f*`), so opposite windings are what carves the hole. Same sign
      // here would mean a solid coin.
      expect(Math.sign(ringArea(outerRing))).toBe(-Math.sign(ringArea(innerRing)));
      expect(Math.abs(ringArea(outerRing))).toBeCloseTo(90000, 0);
      expect(Math.abs(ringArea(innerRing))).toBeCloseTo(10000, 0);
      // Two filled paths remain: the ring (2 contours) and the open
      // polygon (1) — the consumed element's own paint block is gone.
      expect(after.map((b) => b.length).sort()).toEqual([1, 2]);

      await h.host.document.undo();
    });

    it("RELEASE splits the compound back into one element per contour — ONE batch", async () => {
      await h.host.selection.set([OUTER, INNER]);
      expect(await applyMakeCompoundPath(h.host)).toBe(2);
      const before = await leafIds(h);

      await h.host.selection.set([OUTER]);
      const created = await applyReleaseCompoundPath(h.host);
      expect(created).toHaveLength(1);

      // The survivor kept contour 0; the hole became its own element.
      expect((await contoursOf(h, OUTER))!.starts).toEqual([0]);
      const piece = await contoursOf(h, created[0]);
      expect(piece!.starts).toEqual([0]);
      expect(Math.abs(piece!.areas[0])).toBeCloseTo(10000, 3);
      // …carrying the source's paint (Illustrator's release semantics).
      expect(await readProp(h, created[0], "frameFillColor")).toEqual({
        type: "colorRef",
        value: "Color/Black",
      });

      // ONE batch: the piece is inserted, named and painted in the same
      // mutation, so ONE undo takes all of it back. (It was two, and the
      // first undo used to leave the piece standing, unpainted.)
      await h.host.document.undo();
      expect(await leafIds(h)).toEqual(before);
      expect((await contoursOf(h, OUTER))!.starts).toEqual([0, 4]);

      await h.host.document.undo(); // and back to the pre-merge document
      expect(await leafIds(h)).toEqual(["uinner", "uopen", "uouter"]);
    });

    it("MAKE → RELEASE → MAKE is stable (the round trip)", async () => {
      await h.host.selection.set([OUTER, INNER]);
      await applyMakeCompoundPath(h.host);
      const ring = await contoursOf(h, OUTER);

      await h.host.selection.set([OUTER]);
      const created = await applyReleaseCompoundPath(h.host);
      await h.host.selection.set([OUTER, created[0]]);
      expect(await applyMakeCompoundPath(h.host)).toBe(2);

      const again = await contoursOf(h, OUTER);
      expect(again!.starts).toEqual(ring!.starts);
      expect(again!.areas.map((a) => Math.round(a))).toEqual(
        ring!.areas.map((a) => Math.round(a)),
      );

      // Unwind: make (1) + release (1) + make (1).
      for (let i = 0; i < 3; i++) await h.host.document.undo();
      expect(await leafIds(h)).toEqual(["uinner", "uopen", "uouter"]);
    });

    it("an OPEN survivor is CLOSED first — a documented TWO-mutation case", async () => {
      const open = await compoundSourceOf(h.host, OPEN);
      expect(open!.table.subpathOpen).toEqual([true]);

      await h.host.selection.set([OPEN, INNER]);
      expect(await applyMakeCompoundPath(h.host)).toBe(2);
      // Both contours are closed now: `framePath` carries no
      // subpathOpen, so a compound path is a FILL boundary.
      const merged = await h.host.document.pathAnchors(OPEN);
      expect(merged!.subpathStarts).toEqual([0, 3]);
      expect(merged!.subpathOpen?.some((o) => o) ?? false).toBe(false);

      // Two mutations = two undos (the close, then the merge).
      await h.host.document.undo();
      await h.host.document.undo();
      expect(await leafIds(h)).toEqual(["uinner", "uopen", "uouter"]);
      expect(
        (await compoundSourceOf(h.host, OPEN))!.table.subpathOpen,
      ).toEqual([true]);
    });

    it("a SINGLE selected element is a no-op (a compound path is made FROM several)", async () => {
      await h.host.selection.set([OUTER]);
      expect(await applyMakeCompoundPath(h.host)).toBeNull();
      expect((await contoursOf(h, OUTER))!.starts).toEqual([0]);
      expect(await leafIds(h)).toEqual(["uinner", "uopen", "uouter"]);
    });

    it("RELEASE on a non-compound element is a no-op", async () => {
      await h.host.selection.set([OUTER]);
      expect(await applyReleaseCompoundPath(h.host)).toEqual([]);
      expect(await leafIds(h)).toEqual(["uinner", "uopen", "uouter"]);
    });

    it("a text frame in the CONSUMED role is refused (its story would go with it)", async () => {
      const textish = { kind: "textFrame", id: "utext" } as ElementId;
      await h.host.selection.set([OUTER, textish]);
      // Only the text frame was offered as a consumable ⇒ nothing to
      // merge, and NOTHING was deleted.
      expect(await applyMakeCompoundPath(h.host)).toBeNull();
      expect(await leafIds(h)).toEqual(["uinner", "uopen", "uouter"]);
    });

    it("the RECORDED command handlers drive the live selection", async () => {
      const make = commandFor(h, MAKE_COMPOUND_PATH_COMMAND_ID);
      const release = commandFor(h, RELEASE_COMPOUND_PATH_COMMAND_ID);
      expect(make.title).toBe("Path: Make compound path");
      expect(release.title).toBe("Path: Release compound path");

      await h.host.selection.set([OUTER, INNER]);
      await make.handler({} as never, undefined as never);
      expect(contourCountOf((await compoundSourceOf(h.host, OUTER))!.table)).toBe(2);

      await h.host.selection.set([OUTER]);
      await release.handler({} as never, undefined as never);
      expect(contourCountOf((await compoundSourceOf(h.host, OUTER))!.table)).toBe(1);
      expect(await leafIds(h)).toHaveLength(3);

      // make (1) + release (1).
      for (let i = 0; i < 2; i++) await h.host.document.undo();
      expect(await leafIds(h)).toEqual(["uinner", "uopen", "uouter"]);
    });

    // A batch can apply and still be the wrong edit. So a release runs
    // through every lane (`./one-batch.ts`) and each must leave the SAME
    // document — every piece's outline and paint, the survivor's contour
    // 0, the selection — in its own measured number of undo steps, which
    // restore it exactly.
    describe("one batch — and the same document every other lane leaves", () => {
      /** The F6 ring, made compound: OUTER keeps both contours. */
      const ring = async (): Promise<void> => {
        await h.host.selection.set([OUTER, INNER]);
        expect(await applyMakeCompoundPath(h.host)).toBe(2);
      };
      /** A SECOND ring, from two inserted squares. */
      const secondRing = async (): Promise<ElementId> => {
        const before = new Set(await leafIds(h));
        const square = (x: number, y: number, s: number): Mutation => ({
          op: "insertPath",
          args: {
            pageId: F6_RING_PAIR.pageId,
            anchors: [
              { anchor: [x, y], left: [x, y], right: [x, y] },
              { anchor: [x + s, y], left: [x + s, y], right: [x + s, y] },
              { anchor: [x + s, y + s], left: [x + s, y + s], right: [x + s, y + s] },
              { anchor: [x, y + s], left: [x, y + s], right: [x, y + s] },
            ],
            open: false,
          },
        });
        const ins = await h.host.document.mutate({
          op: "batch",
          args: { ops: [square(100, 500, 100), square(130, 530, 40)] },
        });
        expect(ins.applied).toBe(true);
        const [big, hole] = (await leafIds(h)).filter((id) => !before.has(id));
        // leafIds sorts, and the engine mints ascending: big, then hole.
        await h.host.selection.set([poly(big!), poly(hole!)]);
        expect(await applyMakeCompoundPath(h.host)).toBe(2);
        return poly(big!);
      };

      const scenarios: {
        name: string;
        setup: () => Promise<ElementId[]>;
        pieces: number;
        /** Undo steps of the stepwise lane: two per element. */
        stepwiseSteps: number;
        /** Tree reads as found: the diff, two per element. */
        asFound: number;
      }[] = [
        {
          name: "one compound",
          setup: async () => {
            await ring();
            return [OUTER];
          },
          pieces: 1,
          stepwiseSteps: 2,
          asFound: 2,
        },
        {
          name: "TWO compounds selected — one batch for both (was four)",
          setup: async () => {
            await ring();
            const other = await secondRing();
            return [OUTER, other];
          },
          pieces: 2,
          stepwiseSteps: 4,
          asFound: 4,
        },
      ];

      for (const scenario of scenarios) {
        it(scenario.name, async () => {
          const through = (lane: LaneName) =>
            runThrough(h, lane, {
              carrier: OUTER,
              setup: async () => {
                await h.host.selection.set(await scenario.setup());
              },
              command: (host) => applyReleaseCompoundPath(host),
            });

          const shipped = await through("oneBatch");
          expect(shipped.result).toHaveLength(scenario.pieces);
          expect(shipped.work.mutations.map((m) => m.op)).toEqual(["batch"]);
          expect(shipped.undoSteps).toBe(1);
          expect(shipped.restored).toBe(true);
          // As found: two per element, the before/after diff.
          expect(shipped.work.count("document.tree")).toBe(0);

          const stepwise = await through("stepwise");
          expect(stepwise.picture).toBe(shipped.picture);
          expect(stepwise.work.mutations.map((m) => m.op)).toEqual([
            "batch", // the one batch, refused
            ...Array.from({ length: scenario.stepwiseSteps }, () => "batch"),
          ]);
          expect(stepwise.undoSteps).toBe(scenario.stepwiseSteps);
          expect(stepwise.restored).toBe(true);

          // REPLY — an SDK before plugin-sdk 0.2.38, whose outcome carries no
          // `minted`: the ids off the raw reply. The same document, the same
          // writes and the same reads as the shipped (outcome) lane.
          const reply = await through("reply");
          expect(reply.picture).toBe(shipped.picture);
          expect(reply.work.mutations).toEqual(shipped.work.mutations);
          expect(reply.undoSteps).toBe(shipped.undoSteps);
          expect(reply.restored).toBe(true);
          expect(reply.work.count("document.tree")).toBe(shipped.work.count("document.tree"));

          for (const lane of ["diff", "unlisted"] as const) {
            const run = await through(lane);
            expect(run.picture, lane).toBe(shipped.picture);
            expect(run.undoSteps, lane).toBe(1);
            expect(run.restored, lane).toBe(true);
            expect(run.work.count("document.tree"), lane).toBe(2);
          }

          // AS FOUND — no bind, no raw client: the numbers this flow
          // started from, plus the refused attempt's "before" read.
          const asFound = await through("asFound");
          expect(asFound.picture).toBe(shipped.picture);
          expect(asFound.undoSteps).toBe(scenario.stepwiseSteps);
          expect(asFound.work.count("document.tree")).toBe(scenario.asFound + 1);

          expect(await leafIds(h)).toEqual(["uinner", "uopen", "uouter"]);
        });
      }

      it("the ONE batch: per element, contour 0 back, then each piece inserted, NAMED and painted by name", () => {
        const plan = {
          id: OUTER,
          pageId: "usp",
          kept: {
            anchors: [{ anchor: [0, 0], left: [0, 0], right: [0, 0] }],
            subpathStarts: [0],
          },
          rest: [
            {
              anchors: [{ anchor: [2, 2], left: [2, 2], right: [2, 2] }],
              subpathStarts: [0],
              subpathOpen: [false],
            },
          ],
          paint: { fill: "Color/Black", stroke: null, weight: 1 },
        } as unknown as ReleasePlan;
        const ops = (
          releaseBatchForAll([plan, { ...plan, id: INNER }]) as Extract<
            Mutation,
            { op: "batch" }
          >
        ).args.ops as { op: string; args: Record<string, unknown> }[];
        expect(ops.map((o) => o.op)).toEqual([
          "setElementProperty", // framePath
          "insertPath",
          "bindCreated",
          "setElementProperty",
          "setElementProperty",
          "setElementProperty",
          "setElementProperty", // the second element's framePath
          "insertPath",
          "bindCreated",
          "setElementProperty",
          "setElementProperty",
          "setElementProperty",
        ]);
        expect(ops[2]!.args).toEqual({ handle: releaseHandle(0, 0) });
        expect(ops[3]!.args.elementId).toEqual({ kind: "polygon", id: "$h:rc0_0" });
        expect(ops[8]!.args).toEqual({ handle: releaseHandle(1, 0) });
        // The paint is the stepwise lane's batch 2, word for word.
        expect(ops.slice(3, 6)).toEqual(
          (
            releasePaintBatchFor([{ kind: "polygon", id: "$h:rc0_0" } as ElementId], plan.paint) as Extract<
              Mutation,
              { op: "batch" }
            >
          ).args.ops,
        );
      });
    });
  });
});
