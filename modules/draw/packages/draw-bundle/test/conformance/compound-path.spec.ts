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
//       Release = 2 batches;
//   (4) THE HOLE ACTUALLY RENDERS. Anchor-table assertions cannot tell a
//       ring from a coin — under the engine's NON-ZERO fill that is
//       decided by the inner contour's WINDING. So the ring is exported
//       to a real PDF, the page content stream is inflated, and the
//       painted path's two subpaths are measured: same fill op, one
//       path, opposite signed areas. That is the definition of a
//       non-zero hole, read off the artifact a reader would print.
//   (5) the honest scope: a single selected element, open contours,
//       and a text frame in the CONSUMED role.

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
  compoundSourceOf,
  contourCountOf,
  framePathMutationFor,
  makeCompoundBatchFor,
  releaseInsertBatchFor,
  releasePaintBatchFor,
  tableInInnerSpace,
  MAKE_COMPOUND_PATH_COMMAND_ID,
  RELEASE_COMPOUND_PATH_COMMAND_ID,
} from "../../src";
import { F6_RING_PAIR } from "../fixtures/corpus";
import { openHost } from "./host";

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

    it("RELEASE splits the compound back into one element per contour — TWO batches", async () => {
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

      // TWO batches: insertPath mints the id the paint batch addresses,
      // and a batch cannot address an id minted inside itself.
      await h.host.document.undo();
      expect(await leafIds(h)).toHaveLength(before.length + 1);
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

      // Unwind: make (1) + release (2) + make (1).
      for (let i = 0; i < 4; i++) await h.host.document.undo();
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

      for (let i = 0; i < 3; i++) await h.host.document.undo();
      expect(await leafIds(h)).toEqual(["uinner", "uopen", "uouter"]);
    });
  });
});
