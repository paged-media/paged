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

import { importSvg, shapesFromSvgBytes } from "../../src";
import { BUDGET_TIMEOUT_MS, countingHost, report } from "./counting-host";
import {
  addPlainShapes,
  leafIds,
  openWorkload,
  undoMark,
  undoStepsSince,
  type Workload,
} from "./workload";

/** A synthetic SVG of `shapes` shapes in a 5-column grid, cycling
 *  through the three kinds the importer treats differently:
 *
 *   · 3 in 5 — a `<rect>` with a fill AND a stroke (two swatches);
 *   · 1 in 5 — a `<circle>` with a fill only (one swatch);
 *   · 1 in 5 — a `<path>` of THREE closed subpaths with a fill only
 *     (one swatch, three inserts: `insertPath` takes one contour).
 *
 *  Every colour is distinct, so no two shapes could share a swatch even
 *  if the importer looked. Everything lands inside the 612 × 792 page. */
function syntheticSvg(shapes: number): string {
  const hex = (n: number): string =>
    `#${((n * 2654435761) >>> 8).toString(16).padStart(6, "0").slice(-6)}`;
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

vi.setConfig({ testTimeout: BUDGET_TIMEOUT_MS });

describe("perf budgets — interchange", () => {
  // COVERS: `importSvg` in `io/svg.ts` — a loop of awaited single
  // mutations: per shape, a swatch per colour, a creation-defaults swap,
  // and an insert per contour.
  //
  // SUSPICION CONFIRMED: four mutations for a filled-and-stroked rect.
  describe("SVG import — a 50-shape file into a 500-shape document", () => {
    const SHAPES = 50;
    let w: Workload;

    beforeAll(async () => {
      w = await openWorkload();
      await addPlainShapes(w);
    }, 120_000);
    afterAll(() => w?.h.dispose());

    it("201 mutations and 150 undo steps for one File ▸ Open", async () => {
      expect(w.refusals).toEqual([]);
      const before = (await leafIds(w.h)).length;
      expect(before).toBe(502);
      const bytes = new TextEncoder().encode(syntheticSvg(SHAPES));
      // The file is what the comment says: 30 rects, 10 circles and 10
      // three-contour paths.
      const parsed = shapesFromSvgBytes(bytes);
      expect(parsed).toHaveLength(SHAPES);
      expect(parsed.filter((s) => s.anchors.subpathStarts.length === 3)).toHaveLength(10);

      const mark = await undoMark(w);
      const { host, work } = countingHost(w.h.host);
      const inserted = await importSvg(host, {
        name: "perf.svg",
        bytes,
        mimeType: "image/svg+xml",
      });
      const counted = work.snapshot();
      const after = (await leafIds(w.h)).length;
      const undoSteps = await undoStepsSince(w, mark);
      report("svg import 50", counted, { undoSteps, leavesAdded: after - before });

      // 30 + 10 + 3 × 10 contours, each its own element.
      expect(inserted).toHaveLength(70);
      expect(after - before).toBe(70);

      const ops = counted.mutations.map((m) => m.op);
      const count = (op: string): number => ops.filter((o) => o === op).length;
      // One swatch per colour per shape: 2 × 30 + 10 + 10.
      expect(count("createSwatch")).toBe(80);
      // One defaults swap per shape, and one to put them back.
      expect(count("setDocumentDefaults")).toBe(51);
      expect(count("insertPath")).toBe(70);
      // Every one a separate awaited round trip and a separate rebuild
      // of a 500-shape document. TARGET 1 — the whole file is one batch
      // (`bindCreated` names an insert so its paint can ride with it).
      expect(counted.mutations).toHaveLength(201);
      expect(counted.mutations.some((m) => m.op === "batch")).toBe(false);
      // 80 swatches + 70 inserts; the 51 defaults swaps never reach the
      // undo log. An imported file takes 150 presses of undo to remove.
      // TARGET 1.
      expect(undoSteps).toBe(150);
      // The reads are few: the target page (meta, then the page list)
      // and the defaults to restore.
      expect(counted.count("document.meta")).toBe(2);
      expect(counted.count("document.collection")).toBe(1);
      expect(counted.reads()).toBe(3);
    });
  });
});
