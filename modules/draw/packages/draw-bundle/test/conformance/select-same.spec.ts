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

// Phase 9 (Tier B) conformance — Select-same (pure SELECTION by shared
// fill / stroke / stroke-weight; no mutation). Asserts:
//   (1) the pure tree flattener `leafIdsOf` (groups descended, leaves
//       collected);
//   (2) `pathForCriterion` maps each criterion to its PropertyPath;
//   (3) against the REAL engine on F1 (rectangle + polygon + graphic line,
//       all authored FillColor="Color/Black"): `valueForCriterion` reads
//       the fill colorRef, and `selectSameMatches` finds the black-filled
//       leaves from the rectangle reference (the reference included);
//   (4) the recorded command actually SETS the selection (and leaves the
//       document unmutated — pure selection).
//
// HONEST ENGINE FINDING (pinned below): the GraphicLine reads back a NULL
// `frameFillColor` even though the fixture authors FillColor="Color/Black"
// on it — a line has no fill AREA, so the engine surfaces no fill ref for
// it through elementProperties. Select-same-by-fill therefore matches the
// two FILLABLE kinds (rectangle + polygon), NOT the line. This is correct
// (Illustrator's Select Same Fill likewise ignores unfilled lines); the
// spec pins it so a future engine change to fill-on-lines fails loudly.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { ElementId, SceneTreeNode } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  leafIdsOf,
  pathForCriterion,
  valueForCriterion,
  selectSameMatches,
  applySelectSameStrokeWeight,
  strokeWeightToleranceOf,
  MAX_STROKE_WEIGHT_TOLERANCE,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const RECT = { kind: "rectangle", id: F1_MULTI_SHAPE.ids.rectangle! } as ElementId;
const POLY = { kind: "polygon", id: F1_MULTI_SHAPE.ids.polygon! } as ElementId;
const LINE = { kind: "graphicLine", id: F1_MULTI_SHAPE.ids.graphicLine! } as ElementId;

async function leafCount(h: HeadlessHost): Promise<number> {
  const roots = await h.host.document.tree();
  let n = 0;
  const walk = (nodes: { id?: unknown; children?: unknown[] }[]) => {
    for (const node of nodes) {
      if (node.id) n++;
      if (node.children) walk(node.children as never);
    }
  };
  walk(roots as never);
  return n;
}

describe("draw conformance — Select-same (Phase 9 Tier B)", () => {
  describe("leafIdsOf — the pure tree flattener", () => {
    it("collects leaf ids, descends groups, skips id-less containers", () => {
      const tree: SceneTreeNode[] = [
        {
          kind: "Spread",
          label: "Spread",
          children: [
            {
              kind: "Page",
              label: "1",
              children: [
                { kind: "Rectangle", label: "r", id: { kind: "rectangle", id: "ur" } },
                {
                  kind: "Group",
                  label: "g",
                  id: { kind: "group", id: "ug" },
                  children: [
                    { kind: "Polygon", label: "p", id: { kind: "polygon", id: "up" } },
                  ],
                },
              ],
            },
          ],
        },
      ];
      const ids = leafIdsOf(tree).map((e) => e.id);
      // The group is descended (its leaf collected), the group/page/spread
      // containers themselves are not.
      expect(ids).toEqual(["ur", "up"]);
    });
  });

  describe("pathForCriterion", () => {
    it("maps each criterion to its frame PropertyPath", () => {
      expect(pathForCriterion("fill")).toBe("frameFillColor");
      expect(pathForCriterion("stroke")).toBe("frameStrokeColor");
      expect(pathForCriterion("strokeWeight")).toBe("frameStrokeWeight");
    });
  });

  describe("against the real engine (F1: filled rectangle + polygon, unfilled line)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    it("valueForCriterion reads the fill colorRef off fillable kinds; the line reads null", async () => {
      expect(await valueForCriterion(h.host, RECT, "fill")).toBe("Color/Black");
      expect(await valueForCriterion(h.host, POLY, "fill")).toBe("Color/Black");
      // Honest engine finding: a GraphicLine surfaces no fill ref (no fill
      // area) even though the fixture authored FillColor="Color/Black".
      expect(await valueForCriterion(h.host, LINE, "fill")).toBeNull();
    });

    it("selectSameMatches(fill) finds the two fillable black leaves from the rectangle", async () => {
      const matches = await selectSameMatches(h.host, RECT, "fill");
      const ids = matches.map((e) => e.id).sort();
      // The line is excluded (no fill); the rectangle reference is included.
      expect(ids).toEqual(["upoly", "urect"]);
      expect(ids).toContain("urect");
    });

    it("the recorded Select-same:Fill command SETS the selection (pure, no mutation)", async () => {
      const before = await leafCount(h);
      await h.host.selection.set([RECT]);
      const rec = h.contributions.find(
        (c) => c.kind === "command" && c.id === "media.paged.draw.command.selectSameFill",
      );
      expect(rec).toBeDefined();
      await (rec!.value as { handler: (p?: unknown) => unknown }).handler(undefined);

      const sel = h.host.selection.get().map((e) => e.id).sort();
      expect(sel).toEqual(["upoly", "urect"]);
      // Pure selection — the document leaf count is unchanged.
      expect(await leafCount(h)).toBe(before);
    });

    it("with no reference selected the command is a no-op (no throw)", async () => {
      await h.host.selection.set([]);
      const rec = h.contributions.find(
        (c) => c.kind === "command" && c.id === "media.paged.draw.command.selectSameStroke",
      );
      await expect(
        (rec!.value as { handler: (p?: unknown) => unknown }).handler(undefined),
      ).resolves.toBeUndefined();
    });
  });

  // STROKE-WEIGHT TOLERANCE. F1 is re-weighted so the three leaves sit
  // at 2, 2.4 and 3 pt: the rectangle is the reference, the polygon is
  // 0.4 pt away and the line 1 pt away.
  describe("stroke weight within a TOLERANCE (real engine, F1 re-weighted 2 / 2.4 / 3 pt)", () => {
    let h: HeadlessHost;
    const weigh = async (id: ElementId, pt: number) => {
      const out = await h.host.document.mutate({
        op: "setElementProperty",
        args: {
          elementId: id,
          path: "frameStrokeWeight",
          value: { type: "length", value: pt },
        },
      });
      if (!out.applied) throw new Error(`stroke weight refused on ${id.id}`);
    };
    const weightCommand = () =>
      h.contributions.find(
        (c) =>
          c.kind === "command" &&
          c.id === "media.paged.draw.command.selectSameStrokeWeight",
      )!.value as { handler: (p?: unknown, payload?: unknown) => Promise<unknown> };
    const selectedIds = () => h.host.selection.get().map((e) => e.id).sort();

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
      await weigh(RECT, 2);
      await weigh(POLY, 2.4);
      await weigh(LINE, 3);
    });
    afterAll(() => h?.dispose());

    it("the weights are what the fixture says (every kind reads one, the line included)", async () => {
      expect(await valueForCriterion(h.host, RECT, "strokeWeight")).toBe(2);
      expect(await valueForCriterion(h.host, POLY, "strokeWeight")).toBeCloseTo(2.4, 6);
      expect(await valueForCriterion(h.host, LINE, "strokeWeight")).toBe(3);
    });

    it("no tolerance is the EXACT match it always was — the reference alone", async () => {
      expect((await selectSameMatches(h.host, RECT, "strokeWeight")).map((e) => e.id)).toEqual([
        "urect",
      ]);
      await h.host.selection.set([RECT]);
      await weightCommand().handler(undefined);
      expect(selectedIds()).toEqual(["urect"]);
    });

    it("a tolerance widens it, INCLUSIVE: 0.4 reaches the polygon, 1 reaches the line", async () => {
      const ids = async (t: number) =>
        (await selectSameMatches(h.host, RECT, "strokeWeight", t)).map((e) => e.id).sort();
      expect(await ids(0.39)).toEqual(["urect"]);
      expect(await ids(0.4)).toEqual(["upoly", "urect"]);
      expect(await ids(0.99)).toEqual(["upoly", "urect"]);
      expect(await ids(1)).toEqual(["uline", "upoly", "urect"]);
      // Measured from the REFERENCE, not pairwise: from the line, 0.6
      // reaches the polygon (0.6 away) and not the rectangle (1 away).
      expect(
        (await selectSameMatches(h.host, LINE, "strokeWeight", 0.6)).map((e) => e.id).sort(),
      ).toEqual(["uline", "upoly"]);
    });

    it("the recorded command takes the tolerance as its payload", async () => {
      await h.host.selection.set([RECT]);
      await weightCommand().handler(undefined, { tolerance: 0.5 });
      expect(selectedIds()).toEqual(["upoly", "urect"]);
      await h.host.selection.set([RECT]);
      await applySelectSameStrokeWeight(h.host, 1);
      expect(selectedIds()).toEqual(["uline", "upoly", "urect"]);
    });

    it("a COLOUR criterion ignores a tolerance — swatch refs are identities, so it stays exact", async () => {
      await h.host.selection.set([RECT]);
      const fill = h.contributions.find(
        (c) => c.kind === "command" && c.id === "media.paged.draw.command.selectSameFill",
      )!.value as { handler: (p?: unknown, payload?: unknown) => Promise<unknown> };
      await fill.handler(undefined, { tolerance: 50 });
      // The same two black-filled leaves as with no tolerance at all.
      expect(selectedIds()).toEqual(["upoly", "urect"]);
      expect(
        (await selectSameMatches(h.host, RECT, "fill", 50)).map((e) => e.id).sort(),
      ).toEqual(["upoly", "urect"]);
    });

    it("garbage and absurd tolerances are refused, not obeyed", () => {
      expect(strokeWeightToleranceOf(undefined)).toBe(0);
      expect(strokeWeightToleranceOf({ tolerance: "1" })).toBe(0);
      expect(strokeWeightToleranceOf({ tolerance: -2 })).toBe(0);
      expect(strokeWeightToleranceOf({ tolerance: Number.NaN })).toBe(0);
      expect(strokeWeightToleranceOf({ tolerance: 1e9 })).toBe(MAX_STROKE_WEIGHT_TOLERANCE);
      expect(strokeWeightToleranceOf({ tolerance: 0.25 })).toBe(0.25);
    });
  });
});
