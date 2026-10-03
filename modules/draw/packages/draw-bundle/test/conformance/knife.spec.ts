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

// THE KNIFE through the REAL engine wasm. Pins:
//   (1) a straight cut splits a square into TWO separate closed pieces
//       that MEET along the cut (the strip's gap is snapped shut), the
//       rewritten target keeps its id and its paint, the inserted piece
//       carries the same fill / stroke / weight;
//   (2) ONE UNDO STEP — and exactly one: the step before the cut is still
//       there after undoing it, and no strip survives anywhere;
//   (3) the door arithmetic: two mutations (probe + cut) and one undo;
//   (4) a wavy cut crossing twice makes THREE pieces; a hole stays with
//       the piece around it; a nick changes nothing;
//   (5) a ROTATED target is cut where the user cut on the page;
//   (6) what is not cut: an open path (Scissors' job), a text frame, a
//       path the cut misses; with something selected, ONLY the selection;
//   (7) the probe's guard: a change that lands between the probe and its
//       withdrawal is KEPT, the strips still vanish, and the cut reports
//       its two undo steps;
//   (8) the live tool: a freehand drag and an Alt straight drag both cut.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  BundleHost,
  ElementId,
  PathAnchorsResult,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { contourRanges, contourSignedArea } from "@paged-media/draw-geometry";

import {
  applyKnife,
  applyMakeCompoundPath,
  createKnifeHandler,
  drawBundle,
  knifeBatchFor,
  knifeStripBatchFor,
  knifeStripHandle,
  knifeTargetOf,
  CUT_TOOL_IDS,
  KNIFE_STRIP_WIDTH_PT,
  type KnifeResult,
} from "../../src";
import { packageWithSpread, pathItem } from "../fixtures/build-idml";
import { leafIds, poly, squareItem, PAGE_ID } from "../panels/panel-document";
import { countingHost } from "../perf/counting-host";
import { pointerAt, settle } from "../perf/pointer-stream";
import { openHost } from "./host";

const SQ = poly("sq");
const OTHER = poly("other");
const OPEN = poly("open");

/** sq: 100 pt square at (100, 100). other: a 50 pt square well away at
 *  (400, 100). open: an OPEN zig-zag at y 300. */
const DOC = () =>
  packageWithSpread(
    squareItem("sq", 100, 100, 100) +
      squareItem("other", 400, 100, 50) +
      pathItem("Polygon", "open", "300 100 340 300", true, [
        { a: [100, 300] },
        { a: [200, 340] },
        { a: [300, 300] },
      ]),
  );

/** Area of a whole table (outer minus holes, by signed sum). */
function areaOf(t: PathAnchorsResult): number {
  const starts = t.subpathStarts.length > 0 ? t.subpathStarts : [0];
  let total = 0;
  for (let i = 0; i < starts.length; i++) {
    total += contourSignedArea(
      t.anchors.slice(starts[i], starts[i + 1] ?? t.anchors.length),
    );
  }
  return Math.abs(total);
}

/** `[minX, minY, maxX, maxY]` of a table's anchors, in PAGE space. */
function pageBox(t: PathAnchorsResult): [number, number, number, number] {
  const m = t.itemTransform ?? [1, 0, 0, 1, 0, 0];
  let box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const a of t.anchors) {
    const x = m[0] * a.anchor[0] + m[2] * a.anchor[1] + m[4];
    const y = m[1] * a.anchor[0] + m[3] * a.anchor[1] + m[5];
    box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
  }
  return box;
}

async function propsOf(h: HeadlessHost, id: ElementId) {
  const props = await h.host.document.elementProperties(id);
  const out: Record<string, unknown> = {};
  for (const e of props?.entries ?? []) {
    if (
      e.path === "frameFillColor" ||
      e.path === "frameStrokeColor" ||
      e.path === "frameStrokeWeight"
    ) {
      out[e.path] = e.value?.value ?? null;
    }
  }
  return out;
}

async function stroke(h: HeadlessHost, id: ElementId, weight: number): Promise<void> {
  for (const m of [
    {
      op: "setElementProperty",
      args: { elementId: id, path: "frameStrokeColor", value: { type: "colorRef", value: "Color/Black" } },
    },
    {
      op: "setElementProperty",
      args: { elementId: id, path: "frameStrokeWeight", value: { type: "length", value: weight } },
    },
  ] as const) {
    const out = await h.host.document.mutate(m);
    if (!out.applied) throw new Error(`stroke setup refused: ${JSON.stringify(out.error)}`);
  }
}

describe("draw conformance — the Knife", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());
  beforeEach(async () => {
    await h.load(DOC());
    await h.host.selection.set([]);
  });

  it("is a tool in the host's Scissors flyout, keyless", () => {
    const tool = h.toolsContributed().find((t) => t.id === CUT_TOOL_IDS[0]);
    expect(tool).toBeDefined();
    expect(tool!.group).toBe("scissors");
    expect(tool!.shortcut).toBeUndefined();
    expect(tool!.icon).toBe("tool-scissors");
  });

  it("a straight cut splits the square into TWO closed pieces that MEET along the cut, paint carried", async () => {
    await stroke(h, SQ, 3);
    const before = await leafIds(h);
    const original = (await h.host.document.pathAnchors(SQ))!;
    const result = await applyKnife(h.host, PAGE_ID, [
      [60, 150],
      [260, 150],
    ]);
    expect(result.cut).toEqual([SQ]);
    expect(result.pieces).toHaveLength(2);
    expect(result.undoSteps).toBe(1);

    const after = await leafIds(h);
    expect(after).toHaveLength(before.length + 1);
    const piece = result.pieces.find((p) => p.id !== SQ.id)!;
    const kept = (await h.host.document.pathAnchors(SQ))!;
    const other = (await h.host.document.pathAnchors(piece))!;
    // Two halves, both closed, together the square (no gap, no overlap).
    expect(areaOf(kept)).toBeCloseTo(5000, 1);
    expect(areaOf(other)).toBeCloseTo(5000, 1);
    expect(areaOf(kept) + areaOf(other)).toBeCloseTo(areaOf(original), 1);
    expect(kept.subpathOpen?.every((o) => !o) ?? true).toBe(true);
    expect(other.subpathOpen?.every((o) => !o) ?? true).toBe(true);
    // They MEET on the cut: one ends at y = 150, the other starts there.
    const boxes = [pageBox(kept), pageBox(other)].sort((a, b) => a[1] - b[1]);
    expect(boxes[0][3]).toBeCloseTo(150, 6);
    expect(boxes[1][1]).toBeCloseTo(150, 6);
    // The rewritten target's FRAME BOX followed its path.
    const [geom] = await h.host.document.elementGeometry([SQ]);
    const keptBox = pageBox(kept);
    expect(geom!.bounds[0]).toBeCloseTo(keptBox[1], 6);
    expect(geom!.bounds[2]).toBeCloseTo(keptBox[3], 6);
    // Paint: the target keeps its own, the new piece inherits it.
    expect(await propsOf(h, piece)).toEqual(await propsOf(h, SQ));
    expect((await propsOf(h, SQ)).frameStrokeWeight).toBe(3);
    // The pieces are what is selected.
    expect(h.host.selection.get()).toEqual(result.pieces);
  });

  it("ONE undo step — exactly one: Cmd-Z restores the square, the step before it is still there, no strip anywhere", async () => {
    await stroke(h, SQ, 3);
    const before = await leafIds(h);
    const original = (await h.host.document.pathAnchors(SQ))!;
    await applyKnife(h.host, PAGE_ID, [
      [60, 150],
      [260, 150],
    ]);
    await h.host.document.undo();
    expect(await leafIds(h)).toEqual(before);
    const restored = (await h.host.document.pathAnchors(SQ))!;
    expect(restored.anchors).toEqual(original.anchors);
    // The stroke weight written BEFORE the cut survives the one undo…
    expect((await propsOf(h, SQ)).frameStrokeWeight).toBe(3);
    // …and is the NEXT step back.
    await h.host.document.undo();
    expect((await propsOf(h, SQ)).frameStrokeWeight).not.toBe(3);
  });

  it("the doors: TWO mutations (probe, cut) and ONE undo; one arrangement query per target", async () => {
    const { host, work } = countingHost(h.host);
    await applyKnife(host, PAGE_ID, [
      [60, 150],
      [260, 150],
    ]);
    expect(work.mutations.map((m) => m.op)).toEqual(["batch", "batch"]);
    expect(work.count("document.undo")).toBe(1);
    expect(work.count("document.redo")).toBe(0);
    expect(work.count("document.planarRegions")).toBe(1);
  });

  it("the probe batch: one strip per target, inserted, NAMED and pinned to the target's raw frame", () => {
    const batch = knifeStripBatchFor([
      { pageId: PAGE_ID, cutInner: [[0, 0], [10, 0]] },
    ]) as { op: string; args: { ops: { op: string; args: Record<string, unknown> }[] } };
    expect(batch.args.ops.map((o) => o.op)).toEqual([
      "insertPath",
      "bindCreated",
      "setElementProperty",
    ]);
    expect(batch.args.ops[1].args).toEqual({ handle: knifeStripHandle(0) });
    expect(batch.args.ops[2].args.path).toBe("framePath");
    // A strip KNIFE_STRIP_WIDTH_PT wide around the cut.
    const strip = batch.args.ops[0].args.anchors as { anchor: [number, number] }[];
    const ys = strip.map((a) => a.anchor[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(KNIFE_STRIP_WIDTH_PT, 12);
  });

  it("a wavy cut crossing the square TWICE leaves THREE pieces, one undo removes them all", async () => {
    const before = await leafIds(h);
    const result = await applyKnife(h.host, PAGE_ID, [
      [60, 120],
      [260, 120],
      [260, 180],
      [60, 180],
    ]);
    expect(result.pieces).toHaveLength(3);
    let total = 0;
    for (const p of result.pieces) total += areaOf((await h.host.document.pathAnchors(p))!);
    expect(total).toBeCloseTo(10000, 0);
    await h.host.document.undo();
    expect(await leafIds(h)).toEqual(before);
  });

  it("a HOLE stays with the piece around it (the cut misses the hole)", async () => {
    await h.load(
      packageWithSpread(
        squareItem("outer", 100, 100, 200) + squareItem("inner", 220, 220, 40),
      ),
    );
    await h.host.selection.set([poly("outer"), poly("inner")]);
    expect(await applyMakeCompoundPath(h.host)).toBe(2);
    await h.host.selection.set([]);
    const result = await applyKnife(h.host, PAGE_ID, [
      [60, 160],
      [360, 160],
    ]);
    expect(result.pieces).toHaveLength(2);
    const contours: number[] = [];
    const areas: number[] = [];
    for (const p of result.pieces) {
      const t = (await h.host.document.pathAnchors(p))!;
      contours.push(contourRanges(t.anchors.length, t.subpathStarts).length);
      areas.push(areaOf(t));
    }
    // The lower piece (140 pt tall, around the hole) has two contours.
    expect(contours.sort()).toEqual([1, 2]);
    expect(areas.reduce((a, b) => a + b, 0)).toBeCloseTo(200 * 200 - 40 * 40, 0);
  });

  it("a NICK (the cut enters and stops) changes nothing and leaves no undo step", async () => {
    await stroke(h, SQ, 3);
    const before = await leafIds(h);
    const original = (await h.host.document.pathAnchors(SQ))!;
    const result: KnifeResult = await applyKnife(h.host, PAGE_ID, [
      [60, 150],
      [150, 150],
    ]);
    expect(result.cut).toEqual([]);
    expect(result.undoSteps).toBe(0);
    expect(await leafIds(h)).toEqual(before);
    expect((await h.host.document.pathAnchors(SQ))!.anchors).toEqual(original.anchors);
    // The last step is still the stroke setup, not a strip.
    await h.host.document.undo();
    expect((await propsOf(h, SQ)).frameStrokeWeight).not.toBe(3);
  });

  it("a ROTATED square is cut where the cut was drawn ON THE PAGE", async () => {
    // Rotate the square 30° about its centre (150, 150).
    const r = (30 * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const m: [number, number, number, number, number, number] = [
      c,
      s,
      -s,
      c,
      150 - (c * 150 - s * 150),
      150 - (s * 150 + c * 150),
    ];
    const rot = await h.host.document.mutate({
      op: "setElementProperty",
      args: { elementId: SQ, path: "frameTransform", value: { type: "transform", value: m } },
    });
    expect(rot.applied).toBe(true);
    const result = await applyKnife(h.host, PAGE_ID, [
      [40, 150],
      [260, 150],
    ]);
    expect(result.pieces).toHaveLength(2);
    // Each piece lies on ONE side of the page line y = 150.
    const boxes = [];
    let total = 0;
    for (const p of result.pieces) {
      const t = (await h.host.document.pathAnchors(p))!;
      boxes.push(pageBox(t));
      total += areaOf(t);
    }
    boxes.sort((a, b) => a[1] - b[1]);
    expect(boxes[0][3]).toBeLessThanOrEqual(150 + 1e-3);
    expect(boxes[1][1]).toBeGreaterThanOrEqual(150 - 1e-3);
    // A rotation keeps area: the halves still make the square — and the
    // corners where the cut meets the outline SLID along it (projected
    // straight across they pivot the edges and lose ~1.2 pt² here).
    expect(total).toBeCloseTo(10000, 1);
  });

  it("what is NOT cut: an open path (Scissors' job), a text frame, a path the cut misses", async () => {
    const open = await knifeTargetOf(h.host, OPEN, PAGE_ID, [
      [150, 280],
      [150, 360],
    ]);
    expect(open).toEqual({ skip: expect.stringContaining("Scissors") });
    const text = await knifeTargetOf(
      h.host,
      { kind: "textFrame", id: "tf" } as ElementId,
      PAGE_ID,
      [
        [0, 0],
        [10, 0],
      ],
    );
    expect(text).toEqual({ skip: expect.stringContaining("text frame") });
    const missed = await knifeTargetOf(h.host, OTHER, PAGE_ID, [
      [60, 150],
      [260, 150],
    ]);
    expect(missed).toEqual({ skip: null });
  });

  it("with something SELECTED only the selection is cut; with nothing selected, everything crossed", async () => {
    const across: [number, number][] = [
      [60, 120],
      [500, 120],
    ];
    await h.host.selection.set([OTHER]);
    const onlyOther = await applyKnife(h.host, PAGE_ID, across);
    expect(onlyOther.cut).toEqual([OTHER]);
    await h.host.document.undo();
    await h.host.selection.set([]);
    const both = await applyKnife(h.host, PAGE_ID, across);
    expect(both.cut.map((id) => id.id).sort()).toEqual(["other", "sq"]);
    expect(both.pieces).toHaveLength(4);
    expect(both.undoSteps).toBe(1);
  });

  it("THE GUARD: a change landing between the probe and its withdrawal is KEPT, the strips still go, two undo steps reported", async () => {
    const before = await leafIds(h);
    // A stranger's write slips in while the arrangement is being read.
    let fired = false;
    const document = new Proxy(h.host.document, {
      get(target, prop, receiver) {
        if (prop === "planarRegions") {
          return async (...args: Parameters<BundleHost["document"]["planarRegions"]>) => {
            if (!fired) {
              fired = true;
              await h.host.document.mutate({
                op: "setElementProperty",
                args: {
                  elementId: OTHER,
                  path: "frameStrokeWeight",
                  value: { type: "length", value: 7 },
                },
              });
            }
            return target.planarRegions(...args);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const host = new Proxy(h.host, {
      get(target, prop, receiver) {
        return prop === "document" ? document : (Reflect.get(target, prop, receiver) as unknown);
      },
    }) as BundleHost;
    await h.host.selection.set([SQ]);
    const result = await applyKnife(host, PAGE_ID, [
      [60, 150],
      [260, 150],
    ]);
    expect(fired).toBe(true);
    expect(result.pieces).toHaveLength(2);
    expect(result.undoSteps).toBe(2);
    // The stranger's change survived.
    expect((await propsOf(h, OTHER)).frameStrokeWeight).toBe(7);
    // No strip is left: exactly one new leaf (the second piece).
    expect(await leafIds(h)).toHaveLength(before.length + 1);
  });

  it("the cut batch: inserts and their paint FIRST, the target rewrite after, deletes LAST", () => {
    const table = {
      anchors: [
        { anchor: [0, 0] as [number, number], left: [0, 0] as [number, number], right: [0, 0] as [number, number] },
        { anchor: [1, 0] as [number, number], left: [1, 0] as [number, number], right: [1, 0] as [number, number] },
        { anchor: [1, 1] as [number, number], left: [1, 1] as [number, number], right: [1, 1] as [number, number] },
      ],
      subpathStarts: [0],
    };
    const batch = knifeBatchFor(
      [
        {
          target: { id: SQ, pageId: PAGE_ID, inner: table, transform: null, cutInner: [] },
          pieces: [table, table],
          paint: { fill: "Color/Black", stroke: null, weight: 2 },
        },
      ],
      [poly("strip")],
    ) as { args: { ops: { op: string; args: { path?: string } }[] } };
    expect(batch.args.ops.map((o) => o.args.path ?? o.op)).toEqual([
      "insertPath",
      "bindCreated",
      "frameFillColor",
      "frameStrokeColor",
      "frameStrokeWeight",
      "framePath",
      "frameBounds",
      "deleteFrame",
    ]);
  });

  describe("the live tool", () => {
    it("a FREEHAND drag across the square cuts it", async () => {
      let done: KnifeResult | null = null;
      const handler = createKnifeHandler(h.host, { onCut: (r) => (done = r) });
      handler.onActivate(undefined as never);
      handler.onPointerDown(pointerAt(PAGE_ID, [60, 140]));
      for (let x = 70; x <= 260; x += 10) {
        handler.onPointerMove(pointerAt(PAGE_ID, [x, 140 + (x % 20 === 0 ? 1 : 0)]));
      }
      expect(h.lastToolPreview()).not.toBeNull();
      handler.onPointerUp(pointerAt(PAGE_ID, [260, 140]));
      await settle();
      expect(done).not.toBeNull();
      expect(done!.pieces).toHaveLength(2);
      expect(h.lastToolPreview()).toBeNull();
    });

    it("an ALT drag is a STRAIGHT cut from the press point, whatever the pointer wandered through", async () => {
      let done: KnifeResult | null = null;
      const handler = createKnifeHandler(h.host, { onCut: (r) => (done = r) });
      handler.onActivate(undefined as never);
      handler.onPointerDown(pointerAt(PAGE_ID, [60, 150], { alt: true }));
      handler.onPointerMove(pointerAt(PAGE_ID, [150, 400], { alt: true }));
      handler.onPointerUp(pointerAt(PAGE_ID, [260, 150], { alt: true }));
      await settle();
      expect(done!.pieces).toHaveLength(2);
      const areas = [];
      for (const p of done!.pieces) areas.push(areaOf((await h.host.document.pathAnchors(p))!));
      expect(areas[0]).toBeCloseTo(5000, 0);
      expect(areas[1]).toBeCloseTo(5000, 0);
    });

    it("Escape cancels the cut in flight: nothing is written", async () => {
      const before = await leafIds(h);
      const handler = createKnifeHandler(h.host);
      handler.onActivate(undefined as never);
      handler.onPointerDown(pointerAt(PAGE_ID, [60, 150]));
      handler.onPointerMove(pointerAt(PAGE_ID, [260, 150]));
      handler.onKey!({ key: "Escape" } as KeyboardEvent);
      handler.onPointerUp(pointerAt(PAGE_ID, [260, 150]));
      await settle();
      expect(await leafIds(h)).toEqual(before);
      expect(h.lastToolPreview()).toBeNull();
    });
  });
});
