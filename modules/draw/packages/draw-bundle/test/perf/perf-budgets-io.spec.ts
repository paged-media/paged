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

// PERF BUDGETS — interchange. The rules are in `perf-budgets.spec.ts`
// and bind here too.
//
// An import is the one flow whose INPUT sets its size: a logo is ten
// shapes, a traced illustration is thousands. So the budget is per
// shape, on a file small enough to run in a test and regular enough to
// do the arithmetic by eye.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ElementId } from "@paged-media/plugin-api";

import { importSvg, shapesFromSvgBytes } from "../../src";
import { commitSvgImport } from "../../src/io/svg";
import { BUDGET_TIMEOUT_MS, countingHost, report } from "./counting-host";
import {
  addPlainShapes,
  leafIds,
  openWorkload,
  undoMark,
  undoStepsSince,
  type Workload,
} from "./workload";

const hex = (n: number): string =>
  `#${((n * 2654435761) >>> 8).toString(16).padStart(6, "0").slice(-6)}`;

/** A synthetic SVG of `shapes` shapes in a 5-column grid, cycling
 *  through the three kinds the importer treats differently:
 *
 *   · 3 in 5 — a `<rect>` with a fill AND a stroke (two swatches);
 *   · 1 in 5 — a `<circle>` with a fill only (one swatch);
 *   · 1 in 5 — a `<path>` of THREE closed subpaths with a fill only
 *     (one swatch, three inserts: `insertPath` takes one contour).
 *
 *  Every colour is distinct, so no two shapes share a swatch. Everything
 *  lands inside the 612 × 792 page. */
function syntheticSvg(shapes: number): string {
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="612" height="792" viewBox="0 0 612 792">`,
  ];
  for (let i = 0; i < shapes; i++) {
    const x = 20 + (i % 5) * 50;
    const y = 300 + Math.floor(i / 5) * 40;
    switch (i % 5) {
      case 3:
        out.push(`<circle cx="${x + 15}" cy="${y + 15}" r="12" fill="${hex(i * 2)}"/>`);
        break;
      case 4:
        out.push(
          `<path d="M${x} ${y}h10v10h-10Z M${x + 14} ${y}h10v10h-10Z M${x + 28} ${y}h10v10h-10Z" fill="${hex(i * 2)}"/>`,
        );
        break;
      default:
        out.push(
          `<rect x="${x}" y="${y}" width="30" height="24" fill="${hex(i * 2)}" stroke="${hex(i * 2 + 1)}" stroke-width="1"/>`,
        );
    }
  }
  out.push("</svg>");
  return out.join("\n");
}

/** `shapes` small squares, each with its own fill AND stroke colour, in a
 *  60-column grid that stays on the page up to 3 000 of them. */
function denseSvg(shapes: number): string {
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="612" height="792" viewBox="0 0 612 792">`,
  ];
  for (let i = 0; i < shapes; i++) {
    out.push(
      `<rect x="${6 + (i % 60) * 10}" y="${280 + Math.floor(i / 60) * 10}" width="6" height="6" ` +
        `fill="${hex(i * 2)}" stroke="${hex(i * 2 + 1)}" stroke-width="0.5"/>`,
    );
  }
  out.push("</svg>");
  return out.join("\n");
}

const svgFile = (name: string, svg: string) => ({
  name,
  bytes: new TextEncoder().encode(svg),
  mimeType: "image/svg+xml",
});

type SwatchRow = { selfId: string; name: string };

const swatchRows = async (w: Workload): Promise<readonly SwatchRow[]> =>
  w.h.host.document.collection<SwatchRow>("swatches");

const creationDefaults = async (w: Workload): Promise<unknown[]> => {
  const meta = await w.h.host.document.meta();
  return [
    meta.defaultFillColor ?? null,
    meta.defaultStrokeColor ?? null,
    meta.defaultStrokeWeight ?? null,
  ];
};

/** What landed, per new element in tree (= paint) order: where its first
 *  anchor is and what it is painted with, colour refs resolved to the
 *  swatch NAME (the importer names a swatch with its hex). */
async function landed(
  w: Workload,
  ids: readonly ElementId[],
): Promise<{ at: [number, number]; fill: string | null; stroke: string | null; weight: unknown }[]> {
  const names = new Map((await swatchRows(w)).map((sw) => [sw.selfId, sw.name]));
  const out = [];
  for (const id of ids) {
    const table = await w.h.host.document.pathAnchors(id);
    const props = await w.h.host.document.elementProperties(id);
    const read = (path: string): unknown =>
      (props?.entries.find((e) => e.path === path)?.value as { value?: unknown })
        ?.value ?? null;
    const name = (ref: unknown): string | null =>
      typeof ref === "string" ? (names.get(ref) ?? ref) : null;
    const a = table!.anchors[0].anchor;
    out.push({
      at: [Math.round(a[0]), Math.round(a[1])] as [number, number],
      fill: name(read("frameFillColor")),
      stroke: name(read("frameStrokeColor")),
      weight: read("frameStrokeWeight"),
    });
  }
  return out;
}

/** What the 50-shape file must put where — written from the SVG, not
 *  from the importer: one row per CONTOUR, in document order. A shape
 *  with no stroke gets the engine's creation fallback, a 1 pt
 *  `Color/Black` (`SVG_IMPORT_UNSTROKED`; the swatch is named "Black"). */
function expected50(): { at: [number, number]; fill: string; stroke: string; weight: number }[] {
  const rows = [];
  for (let i = 0; i < 50; i++) {
    const x = 20 + (i % 5) * 50;
    const y = 300 + Math.floor(i / 5) * 40;
    const fill = hex(i * 2);
    if (i % 5 === 3) {
      // A circle's path starts at its rightmost point.
      rows.push({ at: [x + 27, y + 15], fill, stroke: "Black", weight: 1 });
    } else if (i % 5 === 4) {
      for (const dx of [0, 14, 28]) {
        rows.push({ at: [x + dx, y], fill, stroke: "Black", weight: 1 });
      }
    } else {
      rows.push({ at: [x, y], fill, stroke: hex(i * 2 + 1), weight: 1 });
    }
  }
  return rows as { at: [number, number]; fill: string; stroke: string; weight: number }[];
}

vi.setConfig({ testTimeout: BUDGET_TIMEOUT_MS });

describe("perf budgets — interchange", () => {
  // COVERS: the SVG import lane in `io/svg.ts` — `commitSvgImport`, what
  // File ▸ Open runs, and `importSvg`, the variant that also answers the
  // ids it inserted.
  //
  // History of these budgets (a budget only goes DOWN):
  //
  //                         mutations  undo steps  reads  swatches
  //   as found (50 shapes)     201        150        3       80
  //   now                        1          1        2       80
  //
  // As found it was a loop of awaited single mutations: per shape a
  // swatch per colour, a creation-defaults swap, and an insert per
  // contour — every one a rebuild of the 500-shape document, and the 80
  // swatches and 70 inserts an undo step each. Now the file is ONE batch
  // whose children insert a contour, bind it, and paint it through the
  // handle (`io/svg.ts` says why the paint is not inherited from the
  // creation defaults any more: that one child sends the whole batch
  // down the engine lane where the undo log's cap bites).
  describe("SVG import — a 50-shape file into a 500-shape document", () => {
    const SHAPES = 50;
    let w: Workload;

    beforeAll(async () => {
      w = await openWorkload();
      await addPlainShapes(w);
    }, 120_000);
    afterAll(() => w?.h.dispose());

    it("1 mutation and 1 undo step for one File ▸ Open", async () => {
      expect(w.refusals).toEqual([]);
      const before = await leafIds(w.h);
      expect(before).toHaveLength(502);
      const swatchesBefore = (await swatchRows(w)).length;
      const defaultsBefore = await creationDefaults(w);
      const file = svgFile("perf.svg", syntheticSvg(SHAPES));
      // The file is what the comment says: 30 rects, 10 circles and 10
      // three-contour paths.
      const parsed = shapesFromSvgBytes(file.bytes);
      expect(parsed).toHaveLength(SHAPES);
      expect(parsed.filter((s) => s.anchors.subpathStarts.length === 3)).toHaveLength(10);

      const mark = await undoMark(w);
      const { host, work } = countingHost(w.h.host);
      const done = await commitSvgImport(host, file);
      const counted = work.snapshot();

      // ---- behaviour: the right paint on the right contour, in order.
      const after = await leafIds(w.h);
      const known = new Set(before.map((id) => String(id.id)));
      const made = after.filter((id) => !known.has(String(id.id)));
      // 30 + 10 + 3 × 10 contours, each its own element…
      expect(made).toHaveLength(70);
      // …appended, so the file paints on top, in document order.
      expect(after.slice(-70)).toEqual(made);
      expect(await landed(w, made)).toEqual(expected50());
      expect(done).toEqual({ shapes: 50, elements: 70, swatches: 80, batches: 1, refused: 0 });
      // One swatch per DISTINCT colour: 2 × 30 + 10 + 10. (Here that is
      // also one per colour per shape — every colour in this file is
      // different. `svg-io.spec.ts` pins the sharing.)
      expect((await swatchRows(w)).length - swatchesBefore).toBe(80);
      // The user's creation defaults are not touched, so not restored.
      expect(await creationDefaults(w)).toEqual(defaultsBefore);

      const undoSteps = await undoStepsSince(w, mark);
      report("svg import 50", counted, { undoSteps, leavesAdded: made.length });

      // ---- the budget.
      // ONE mutation. Its 430 children: 80 swatches, and for each of the
      // 70 contours an insert, a bind and three paint writes.
      // As found: 201 mutations.
      expect(counted.mutations).toEqual([{ op: "batch", ops: 430 }]);
      // ONE press of undo removes the file. As found: 150.
      expect(undoSteps).toBe(1);
      expect(await leafIds(w.h)).toEqual(before);
      expect((await swatchRows(w)).length).toBe(swatchesBefore);
      // The target page: meta, then (no active page headlessly) the page
      // list. As found: 3 — a second meta read for the defaults to
      // restore, which nothing writes any more.
      expect(counted.count("document.meta")).toBe(1);
      expect(counted.count("document.collection")).toBe(1);
      expect(counted.reads()).toBe(2);
    });

    // `importSvg` is the same commit, plus the list of what it inserted.
    // As found the loop got each id from its own insert's outcome, for
    // free — at 201 mutations; the one-batch commit then paid two tree
    // reads for the list, a before/after diff, because a batch outcome
    // carries ONE `createdId`. The engine's reply lists every id a batch
    // minted (`mutationApplied.minted`, in mint order), and the list is
    // read off it now (`commands/minted.ts`): no read on top.
    it("asking which elements were inserted costs nothing on top", async () => {
      const before = await leafIds(w.h);
      const mark = await undoMark(w);
      const { host, work } = countingHost(w.h.host);
      const inserted = await importSvg(host, svgFile("perf.svg", syntheticSvg(SHAPES)));
      const counted = work.snapshot();

      // Exactly the new leaves, in insertion (= paint) order.
      expect(inserted).toEqual((await leafIds(w.h)).slice(before.length));
      expect(inserted).toHaveLength(70);
      expect(await landed(w, inserted)).toEqual(expected50());

      const undoSteps = await undoStepsSince(w, mark);
      report("svg import 50, with ids", counted, { undoSteps });

      expect(counted.mutations).toEqual([{ op: "batch", ops: 430 }]);
      expect(undoSteps).toBe(1);
      // As found: 2.
      expect(counted.count("document.tree")).toBe(0);
      expect(counted.count("document.meta")).toBe(1);
      expect(counted.count("document.collection")).toBe(1);
      // The commit's own two — the same as File ▸ Open's. As found: 4.
      expect(counted.reads()).toBe(2);
    });

    // COVERS: the same lane on a file bigger than the engine's undo log.
    //
    //                          mutations  undo steps   import    undo
    //   as found (3 000 shapes)  12 001     9 000      20.7 s   21.5 s
    //   now                           1         1       0.3 s    0.1 s
    //
    // (The two durations are one run on one laptop, written down so the
    // counts have a scale — they are not budgets.)
    //
    // The count that matters is the SECOND one, and it is not a given.
    // The engine's undo log holds 10 000 entries. A batch that styles
    // through `setDocumentDefaults` takes the engine's per-child lane,
    // where each of this file's children would hold a log entry until
    // the batch collapses — and one undo would then leave 500 shapes and
    // 1 001 swatches behind for good (`svg-io.spec.ts` pins that edge).
    // The batch built here has 21 000 children and is ONE log entry: it
    // is NOT chunked, because 40 batches of 500 contours measured SLOWER
    // than one batch of 20 000 (7.9 s against 5.2 s) and cost 40 undos.
    it("a 3 000-shape file is still one mutation, and one undo takes all of it back", async () => {
      const BIG = 3000;
      const before = await leafIds(w.h);
      const swatchesBefore = (await swatchRows(w)).length;
      const mark = await undoMark(w);
      const { host, work } = countingHost(w.h.host);
      const done = await commitSvgImport(host, svgFile("big.svg", denseSvg(BIG)));
      const counted = work.snapshot();

      expect(done).toEqual({
        shapes: BIG,
        elements: BIG,
        swatches: 2 * BIG,
        batches: 1,
        refused: 0,
      });
      const after = await leafIds(w.h);
      expect(after).toHaveLength(before.length + BIG);
      expect((await swatchRows(w)).length).toBe(swatchesBefore + 2 * BIG);
      // First and last made it, in order, with their own paint.
      expect(await landed(w, [after[before.length], after[after.length - 1]])).toEqual([
        { at: [6, 280], fill: hex(0), stroke: hex(1), weight: 0.5 },
        {
          at: [6 + ((BIG - 1) % 60) * 10, 280 + Math.floor((BIG - 1) / 60) * 10],
          fill: hex((BIG - 1) * 2),
          stroke: hex((BIG - 1) * 2 + 1),
          weight: 0.5,
        },
      ]);

      const undoSteps = await undoStepsSince(w, mark);
      report("svg import 3000", counted, { undoSteps, leavesAdded: BIG });

      // 2 swatches + insert + bind + 3 paint writes, per shape.
      expect(counted.mutations).toEqual([{ op: "batch", ops: 7 * BIG }]);
      expect(undoSteps).toBe(1);
      // ALL of it: not one shape and not one swatch stranded.
      expect(await leafIds(w.h)).toEqual(before);
      expect((await swatchRows(w)).length).toBe(swatchesBefore);
      expect(counted.reads()).toBe(2);
    });
  });
});
