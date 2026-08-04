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

// B-22 conformance — the REGION Pathfinder row + the `requestPlanarRegions`
// read door, against the REAL engine (protocol v57).
//
// The fixture is F4: two overlapping squares in raw path space with
// identity item transforms — A = `ua` [100,100]-[300,300], B = `ub`
// [200,200]-[400,400], `ub` later in the spread XML and therefore
// FRONTMOST. Top-to-bottom is `[ub, ua]`, so face signatures index
// 0 = ub, 1 = ua and the arrangement is exactly three faces:
//   `0#0`   ub only     area 30000
//   `0-1#0` the overlap area 10000  ← what a hover in the middle hits
//   `1#0`   ua only     area 30000
//
// Every assertion below reads the RESULT (survivor identity, anchor
// count, bounding box), never merely `applied: true` — the point of the
// six verbs is what they leave behind, and Crop / Minus Back are only
// correct if `elementIds` really is top-to-bottom.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";

import type {
  CommandContribution,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  PATHFINDER_REGION_PRESETS,
  PATHFINDER_REGION_COMMAND_IDS,
  pathfinderRegionMutationFor,
  pathfinderFacesMutationFor,
  orderTopToBottom,
  paintOrderLeaves,
  regionRefusalReason,
  type PlanarRegionsWire,
} from "../../src";
import { F4_OVERLAP, F5_THIRTEEN } from "../fixtures/corpus";
import { openHost } from "./host";

/** `ua` — the BACK square. */
const A = { kind: "polygon", id: F4_OVERLAP.ids.polygon! } as ElementId;
/** `ub` — the FRONT square. */
const B = { kind: "polygon", id: F4_OVERLAP.secondId } as ElementId;
/** The engine's convention: index 0 frontmost. */
const TOP_TO_BOTTOM = [B, A];

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

async function leaves(h: HeadlessHost): Promise<ElementId[]> {
  const roots = await h.host.document.tree();
  const out: ElementId[] = [];
  const walk = (nodes: { id?: unknown; children?: unknown[] }[]) => {
    for (const node of nodes) {
      if (node.id) out.push(node.id as ElementId);
      if (node.children) walk(node.children as never);
    }
  };
  walk(roots as never);
  return out;
}

const idsOf = (els: readonly ElementId[]): string[] =>
  els.map((e) => String((e as { id: unknown }).id));

/** The bounding box of an element's anchor table, rounded to whole pt
 *  (the fixture geometry is axis-aligned and integral). */
async function bboxOf(
  h: HeadlessHost,
  id: ElementId,
): Promise<{ n: number; box: number[] } | null> {
  const t = await h.host.document.pathAnchors(id);
  if (!t || t.anchors.length === 0) return null;
  const xs = t.anchors.map((a) => a.anchor[0]);
  const ys = t.anchors.map((a) => a.anchor[1]);
  return {
    n: t.anchors.length,
    box: [
      Math.round(Math.min(...xs)),
      Math.round(Math.min(...ys)),
      Math.round(Math.max(...xs)),
      Math.round(Math.max(...ys)),
    ],
  };
}

/** The `requestPlanarRegions` read door, driven exactly the way the
 *  Shape Builder handler drives it (the marked v0 escape hatch). */
async function planarRegions(
  h: HeadlessHost,
  ids: ElementId[],
  point?: [number, number],
): Promise<PlanarRegionsWire> {
  const reply = (await h.host.editor.client.send({
    kind: "requestPlanarRegions",
    payload: point ? { elementIds: ids, point } : { elementIds: ids },
  } as never)) as unknown as {
    kind: string;
    payload: { result: PlanarRegionsWire };
  };
  expect(reply.kind).toBe("planarRegions");
  return reply.payload.result;
}

describe("draw conformance — the region Pathfinder row (B-22)", () => {
  describe("wire shapes + the ordering rule (pure)", () => {
    it("each preset emits the exact <verb>{ elementIds } wire shape", () => {
      for (const preset of PATHFINDER_REGION_PRESETS) {
        const m = pathfinderRegionMutationFor(preset.verb, TOP_TO_BOTTOM) as {
          op: string;
          args: unknown;
        };
        expect(m).toEqual({
          op: preset.verb,
          args: { elementIds: TOP_TO_BOTTOM },
        });
      }
      expect(PATHFINDER_REGION_PRESETS.map((p) => p.verb)).toEqual([
        "pathfinderDivide",
        "pathfinderTrim",
        "pathfinderMerge",
        "pathfinderCrop",
        "pathfinderOutline",
        "pathfinderMinusBack",
      ]);
      expect(PATHFINDER_REGION_COMMAND_IDS).toEqual([
        "media.paged.draw.command.pathfinderDivide",
        "media.paged.draw.command.pathfinderTrim",
        "media.paged.draw.command.pathfinderMerge",
        "media.paged.draw.command.pathfinderCrop",
        "media.paged.draw.command.pathfinderOutline",
        "media.paged.draw.command.pathfinderMinusBack",
      ]);
    });

    it("pathfinderFaces carries the ids + the keep/remove mode verbatim", () => {
      expect(
        pathfinderFacesMutationFor(TOP_TO_BOTTOM, ["0-1#0"], "keep"),
      ).toEqual({
        op: "pathfinderFaces",
        args: { elementIds: TOP_TO_BOTTOM, faces: ["0-1#0"], mode: "keep" },
      } as unknown as Mutation);
      expect(
        pathfinderFacesMutationFor(TOP_TO_BOTTOM, ["1#0"], "remove"),
      ).toEqual({
        op: "pathfinderFaces",
        args: { elementIds: TOP_TO_BOTTOM, faces: ["1#0"], mode: "remove" },
      } as unknown as Mutation);
    });

    it("orderTopToBottom reverses the tree's PAINT order, not the click order", () => {
      // The tree lists back-to-front, so `ua` first means `ub` is on top.
      const paint = ["polygon:ua", "polygon:ub"];
      expect(idsOf(orderTopToBottom([A, B], paint))).toEqual(["ub", "ua"]);
      // Selecting the other way round changes nothing — z-order wins.
      expect(idsOf(orderTopToBottom([B, A], paint))).toEqual(["ub", "ua"]);
    });

    it("ids the tree does not carry keep selection order and sort to the BACK", () => {
      const ghost = { kind: "polygon", id: "ghost" } as ElementId;
      const paint = ["polygon:ua", "polygon:ub"];
      expect(idsOf(orderTopToBottom([ghost, A, B], paint))).toEqual([
        "ub",
        "ua",
        "ghost",
      ]);
    });

    it("paintOrderLeaves flattens the tree in paint order, groups included", () => {
      const roots = [
        {
          id: null,
          kind: "Spread",
          label: "s",
          children: [
            {
              id: null,
              kind: "Page",
              label: "1",
              children: [
                { id: A, kind: "Polygon", label: "a", children: [] },
                { id: B, kind: "Polygon", label: "b", children: [] },
              ],
            },
          ],
        },
      ];
      expect(paintOrderLeaves(roots as never)).toEqual([
        "polygon:ua",
        "polygon:ub",
      ]);
    });

    it("regionRefusalReason lifts the engine's sentence out of its envelopes", () => {
      const wrapped = {
        error: {
          kind: "notImplemented",
          details: {
            what:
              "frame mutation failed: invalid value for FramePath on " +
              'Polygon("u0"): planar arrangement takes at most 12 inputs (got 13)',
          },
        },
      };
      expect(regionRefusalReason(wrapped)).toBe(
        "planar arrangement takes at most 12 inputs (got 13)",
      );
      expect(regionRefusalReason(undefined)).toBeNull();
    });
  });

  describe("the requestPlanarRegions read door (F4, real engine)", () => {
    let h: HeadlessHost;
    beforeAll(async () => {
      h = await openHost();
      await h.load(F4_OVERLAP.bytes());
    });
    afterAll(() => h?.dispose());

    it("enumerates the three faces two overlapping squares divide the plane into", async () => {
      const r = await planarRegions(h, TOP_TO_BOTTOM);
      expect(r.found).toBe(true);
      expect(r.inputCount).toBe(2);
      expect(r.complete).toBe(true);
      expect(r.faces.map((f) => f.id).sort()).toEqual(["0#0", "0-1#0", "1#0"]);
      const byId = new Map(r.faces.map((f) => [f.id, f]));
      expect(Math.round(byId.get("0-1#0")!.area)).toBe(10000);
      expect(Math.round(byId.get("0#0")!.area)).toBe(30000);
      expect(Math.round(byId.get("1#0")!.area)).toBe(30000);
      // Signatures index the REQUEST's elementIds: 0 = ub (front).
      expect(byId.get("0#0")!.signature).toEqual([0]);
      expect(byId.get("1#0")!.signature).toEqual([1]);
      expect(byId.get("0-1#0")!.signature).toEqual([0, 1]);
    });

    it("a point query in the overlap resolves the MIDDLE face — the hover query", async () => {
      const r = await planarRegions(h, TOP_TO_BOTTOM, [250, 250]);
      expect(r.found).toBe(true);
      expect(r.faces).toHaveLength(1);
      expect(r.faces[0].id).toBe("0-1#0");
      expect(Math.round(r.faces[0].area)).toBe(10000);
      // The face outline is the overlap square, in raw path space.
      const xs = r.faces[0].anchors.map((a) => a.anchor[0]);
      const ys = r.faces[0].anchors.map((a) => a.anchor[1]);
      expect([
        Math.round(Math.min(...xs)),
        Math.round(Math.min(...ys)),
        Math.round(Math.max(...xs)),
        Math.round(Math.max(...ys)),
      ]).toEqual([200, 200, 300, 300]);
      // `inside` is a point strictly inside the face.
      expect(r.faces[0].inside[0]).toBeGreaterThan(200);
      expect(r.faces[0].inside[0]).toBeLessThan(300);
    });

    it("a point query over one shape only resolves that shape's face", async () => {
      expect(
        (await planarRegions(h, TOP_TO_BOTTOM, [150, 150])).faces[0].id,
      ).toBe("1#0"); // ua only
      expect(
        (await planarRegions(h, TOP_TO_BOTTOM, [350, 350])).faces[0].id,
      ).toBe("0#0"); // ub only
    });

    it("a point outside every input is found-with-no-face, NOT a refusal", async () => {
      const r = await planarRegions(h, TOP_TO_BOTTOM, [50, 50]);
      expect(r.found).toBe(true);
      expect(r.faces).toEqual([]);
      expect(r.reason ?? null).toBeNull();
    });

    it("the face ids a hover reports are the ids pathfinderFaces accepts", async () => {
      const hovered = (await planarRegions(h, TOP_TO_BOTTOM, [250, 250]))
        .faces[0].id;
      const before = await leaves(h);
      const outcome = await h.host.document.mutate(
        pathfinderFacesMutationFor(TOP_TO_BOTTOM, [hovered], "keep"),
      );
      expect(outcome.applied).toBe(true);
      expect((await leaves(h)).length).toBe(before.length - 1);
      await h.host.document.undo();
      expect((await leaves(h)).length).toBe(before.length);
    });
  });

  describe("the six verbs against the real engine (F4)", () => {
    let h: HeadlessHost;
    beforeAll(async () => {
      h = await openHost();
      await h.load(F4_OVERLAP.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());
    beforeEach(async () => {
      await h.host.selection.set([]);
    });

    it("Divide splits the arrangement into one object per face (2 → 3)", async () => {
      const outcome = await h.host.document.mutate(
        pathfinderRegionMutationFor("pathfinderDivide", TOP_TO_BOTTOM),
      );
      expect(outcome.applied).toBe(true);
      const after = await leaves(h);
      expect(after).toHaveLength(3);
      // The two inputs are REUSED as carriers; the surplus face becomes
      // a fresh Polygon whose box is exactly the overlap.
      expect(idsOf(after).slice(0, 2)).toEqual(["ua", "ub"]);
      const fresh = await bboxOf(h, after[2]);
      expect(fresh).toEqual({ n: 4, box: [200, 200, 300, 300] });
      await h.host.document.undo();
      expect(await leaves(h)).toHaveLength(2);
    });

    it("Trim clips each input to what nothing above covers (both survive; the back one is an L)", async () => {
      const outcome = await h.host.document.mutate(
        pathfinderRegionMutationFor("pathfinderTrim", TOP_TO_BOTTOM),
      );
      expect(outcome.applied).toBe(true);
      expect(idsOf(await leaves(h))).toEqual(["ua", "ub"]);
      // `ua` is the BACK square: clipped to the L outside `ub` — six
      // vertices, same outer box. `ub` is untouched.
      expect(await bboxOf(h, A)).toEqual({ n: 6, box: [100, 100, 300, 300] });
      expect(await bboxOf(h, B)).toEqual({ n: 6, box: [200, 200, 400, 400] });
      await h.host.document.undo();
      expect(await leaves(h)).toHaveLength(2);
    });

    it("Merge coalesces the same-fill inputs into ONE object spanning both", async () => {
      const outcome = await h.host.document.mutate(
        pathfinderRegionMutationFor("pathfinderMerge", TOP_TO_BOTTOM),
      );
      expect(outcome.applied).toBe(true);
      const after = await leaves(h);
      // Both fixture quads are Color/Black, so Merge is a single result
      // carried by the TOPMOST input.
      expect(idsOf(after)).toEqual(["ub"]);
      expect(await bboxOf(h, B)).toEqual({ n: 8, box: [100, 100, 400, 400] });
      await h.host.document.undo();
      expect(await leaves(h)).toHaveLength(2);
    });

    it("Crop cookie-cuts with the TOPMOST input, which is then consumed", async () => {
      const outcome = await h.host.document.mutate(
        pathfinderRegionMutationFor("pathfinderCrop", TOP_TO_BOTTOM),
      );
      expect(outcome.applied).toBe(true);
      // `ub` (the cutter) is gone; `ua` survives clipped to the overlap.
      expect(idsOf(await leaves(h))).toEqual(["ua"]);
      expect(await bboxOf(h, A)).toEqual({ n: 4, box: [200, 200, 300, 300] });
      await h.host.document.undo();
      expect(await leaves(h)).toHaveLength(2);
    });

    it("Outline turns every arrangement EDGE into an open line (all inputs consumed)", async () => {
      const outcome = await h.host.document.mutate(
        pathfinderRegionMutationFor("pathfinderOutline", TOP_TO_BOTTOM),
      );
      expect(outcome.applied).toBe(true);
      const after = await leaves(h);
      // Two overlapping squares split into twelve edges at the four
      // crossings; each comes back as a two-anchor GraphicLine.
      expect(after).toHaveLength(12);
      expect(new Set(after.map((e) => e.kind))).toEqual(
        new Set(["graphicLine"]),
      );
      for (const line of after) {
        expect((await bboxOf(h, line))!.n).toBe(2);
      }
      expect(idsOf(after)).not.toContain("ua");
      await h.host.document.undo();
      expect(idsOf(await leaves(h))).toEqual(["ua", "ub"]);
    });

    it("Minus back keeps the BACKMOST object minus everything in front", async () => {
      const outcome = await h.host.document.mutate(
        pathfinderRegionMutationFor("pathfinderMinusBack", TOP_TO_BOTTOM),
      );
      expect(outcome.applied).toBe(true);
      expect(idsOf(await leaves(h))).toEqual(["ua"]);
      // `ua` minus `ub` = the six-vertex L.
      expect(await bboxOf(h, A)).toEqual({ n: 6, box: [100, 100, 300, 300] });
      await h.host.document.undo();
      expect(await leaves(h)).toHaveLength(2);
    });

    it("ORDER DECIDES: Crop and Minus back invert when elementIds is bottom-to-top", async () => {
      const reversed = [A, B];
      await h.host.document.mutate(
        pathfinderRegionMutationFor("pathfinderCrop", reversed),
      );
      // With `ua` presented as the top, IT becomes the cutter and `ub`
      // survives — the opposite survivor from the correct order above.
      expect(idsOf(await leaves(h))).toEqual(["ub"]);
      await h.host.document.undo();

      await h.host.document.mutate(
        pathfinderRegionMutationFor("pathfinderMinusBack", reversed),
      );
      expect(idsOf(await leaves(h))).toEqual(["ub"]);
      expect(await bboxOf(h, B)).toEqual({ n: 6, box: [200, 200, 400, 400] });
      await h.host.document.undo();
      expect(await leaves(h)).toHaveLength(2);
    });

    it("the recorded command handlers derive top-to-bottom from the SCENE TREE, not click order", async () => {
      // Select bottom-up on purpose: `ua` first, then `ub`.
      await h.host.selection.set([A, B]);
      await commandFor(h, "media.paged.draw.command.pathfinderCrop").handler(
        undefined,
      );
      // Had the command trusted click order, `ub` would have survived.
      expect(idsOf(await leaves(h))).toEqual(["ua"]);
      expect(await bboxOf(h, A)).toEqual({ n: 4, box: [200, 200, 300, 300] });
      await h.host.document.undo();
      expect(await leaves(h)).toHaveLength(2);
    });

    it("every one of the six commands runs from a live selection and one undo restores", async () => {
      for (const preset of PATHFINDER_REGION_PRESETS) {
        await h.host.selection.set([A, B]);
        await commandFor(h, preset.id).handler(undefined);
        const after = await leaves(h);
        expect(
          after.length,
          `${preset.verb} left ${after.length} leaves`,
        ).toBeGreaterThanOrEqual(1);
        await h.host.document.undo();
        expect(idsOf(await leaves(h)), `${preset.verb} undo`).toEqual([
          "ua",
          "ub",
        ]);
      }
    });

    it("fewer than two selected is an honest no-op (no throw, tree intact)", async () => {
      await h.host.selection.set([A]);
      await expect(
        commandFor(h, "media.paged.draw.command.pathfinderDivide").handler(
          undefined,
        ),
      ).resolves.toBeUndefined();
      expect(await leaves(h)).toHaveLength(2);
    });
  });

  describe("pathfinderFaces materializes the named faces (F4)", () => {
    let h: HeadlessHost;
    beforeAll(async () => {
      h = await openHost();
      await h.load(F4_OVERLAP.bytes());
    });
    afterAll(() => h?.dispose());

    it("keep = the drag's faces: the overlap alone survives, and one undo restores both inputs", async () => {
      const outcome = await h.host.document.mutate(
        pathfinderFacesMutationFor(TOP_TO_BOTTOM, ["0-1#0"], "keep"),
      );
      expect(outcome.applied).toBe(true);
      const after = await leaves(h);
      expect(after).toHaveLength(1);
      // The result is owned by the topmost input covering the face.
      expect(idsOf(after)).toEqual(["ub"]);
      expect(await bboxOf(h, B)).toEqual({ n: 4, box: [200, 200, 300, 300] });
      await h.host.document.undo();
      expect(idsOf(await leaves(h))).toEqual(["ua", "ub"]);
      expect(await bboxOf(h, A)).toEqual({ n: 4, box: [100, 100, 300, 300] });
      expect(await bboxOf(h, B)).toEqual({ n: 4, box: [200, 200, 400, 400] });
    });

    it("remove = the Alt-drag's faces: everything BUT the overlap survives", async () => {
      const outcome = await h.host.document.mutate(
        pathfinderFacesMutationFor(TOP_TO_BOTTOM, ["0-1#0"], "remove"),
      );
      expect(outcome.applied).toBe(true);
      const after = await leaves(h);
      expect(after).toHaveLength(1);
      // The two L-shaped remainders unite into one 12-vertex object
      // spanning the whole union.
      expect(await bboxOf(h, after[0])).toEqual({
        n: 12,
        box: [100, 100, 400, 400],
      });
      await h.host.document.undo();
      expect(await leaves(h)).toHaveLength(2);
    });

    it("an unknown face id is REFUSED, not silently dropped", async () => {
      const outcome = await h.host.document.mutate(
        pathfinderFacesMutationFor(TOP_TO_BOTTOM, ["9-9#9"], "keep"),
      );
      expect(outcome.applied).toBe(false);
      expect(
        regionRefusalReason((outcome as { error?: unknown }).error),
      ).toContain("no face 9-9#9 in this arrangement");
      expect(await leaves(h)).toHaveLength(2);
    });
  });

  describe("the caps REFUSE — 13 inputs (F5)", () => {
    let h: HeadlessHost;
    let ids: ElementId[];
    beforeAll(async () => {
      h = await openHost();
      await h.load(F5_THIRTEEN.bytes());
      h.loadBundle(drawBundle);
      ids = Array.from(
        { length: F5_THIRTEEN.count },
        (_, i) => ({ kind: "polygon", id: F5_THIRTEEN.idAt(i) }) as ElementId,
      );
    });
    afterAll(() => h?.dispose());

    it("the read door answers found:false with the engine's REASON — never an empty face list", async () => {
      const r = await planarRegions(h, ids);
      expect(r.found).toBe(false);
      expect(r.faces).toEqual([]);
      expect(r.complete).toBe(false);
      expect(r.reason).toContain("at most 12");
      // The POINT form refuses on the same cap (inputs, not faces).
      const p = await planarRegions(h, ids, [250, 250]);
      expect(p.found).toBe(false);
      expect(p.reason).toContain("at most 12");
    });

    it("twelve inputs — the cap itself — are answered, not refused", async () => {
      const r = await planarRegions(h, ids.slice(0, 12));
      expect(r.found).toBe(true);
      expect(r.inputCount).toBe(12);
      expect(r.faces.length).toBeGreaterThan(0);
    });

    it("a verb over 13 inputs refuses and mutates NOTHING; the reason is readable", async () => {
      const before = await leaves(h);
      const outcome = await h.host.document.mutate(
        pathfinderRegionMutationFor("pathfinderDivide", ids),
      );
      expect(outcome.applied).toBe(false);
      const reason = regionRefusalReason(
        (outcome as { error?: unknown }).error,
      );
      expect(reason).toContain("planar arrangement takes at most 12");
      expect(reason).toContain("13");
      expect(await leaves(h)).toHaveLength(before.length);
    });

    it("the COMMAND surfaces the refusal on the status binding instead of a silent no-op", async () => {
      await h.host.selection.set(ids);
      await commandFor(h, "media.paged.draw.command.pathfinderDivide").handler(
        undefined,
      );
      const status = h.host.bindings.get("media.paged.draw.pathfinderStatus");
      expect(String(status)).toContain("at most 12");
      // Nothing changed and the selection is untouched.
      expect(await leaves(h)).toHaveLength(F5_THIRTEEN.count);
      expect(h.host.selection.get()).toHaveLength(F5_THIRTEEN.count);
    });
  });
});
