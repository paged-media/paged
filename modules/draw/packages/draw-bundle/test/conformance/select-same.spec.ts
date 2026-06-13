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
});
