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

// OBJECTS ON A PATH conformance (§16.3) — through the REAL engine wasm.
// In order of how much it would hurt to get wrong:
//
//   (1) IT MOVES, IT DOES NOT COPY. The leaf count is UNCHANGED after a
//       Make, the element IDS are the ones that were selected, and a
//       foreign plugin's metadata on an object survives. That is the
//       claim the whole row rests on and it is asserted first.
//   (2) THE DOOR'S SEMANTICS, measured rather than assumed:
//       `frameTransform` REPLACES an element's transform (so Update is
//       IDEMPOTENT and Release is EXACT), `elementGeometry.bounds` is
//       NOT page space and is not recomputed by it, and N writes in one
//       batch is ONE undo step.
//   (3) RFI C-23 ON TRANSFORMS, and the exact SHAPE of it, because two
//       plausible readings are false and are pinned here as false: an
//       element entirely off the page rect loses `elementGeometry` and
//       `pathAnchors`, but KEEPS its metadata and its place in the scene
//       tree; and an element that merely OVERHANGS the rect loses
//       nothing. The artboard fit applies the stricter "fully inside"
//       rule on purpose, and an object it refuses is left home.
//   (4) The two distribution modes, align, pivot, offset and order.
//   (5) EXPAND ≠ RELEASE on the same document.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";

import type {
  CommandContribution,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  applyExpandObjectsOnPath,
  applyMakeObjectsOnPath,
  applyReleaseObjectsOnPath,
  applySelectObjectsOnPath,
  applyUpdateObjectsOnPath,
  affineFrom,
  findObjectsOnPathRecord,
  frameTransformMutationFor,
  mintObjectsOnPathId,
  objectsOnPathBatchFor,
  objectsOnPathLinks,
  objectsOnPathParamsFrom,
  objectsOnPathReleaseBatchFor,
  objectsOnPathRowLabel,
  onPathHullOf,
  onPathObjectOf,
  onPathSpineOf,
  orderedIndices,
  parseObjectsOnPathLibrary,
  placeObjectsOnPath,
  readObjectsOnPathLibrary,
  serializeObjectsOnPathLibrary,
  upsertObjectsOnPathRecord,
  withOnPathKey,
  writeObjectsOnPathLibrary,
  EXPAND_OBJECTS_ON_PATH_COMMAND_ID,
  MAKE_OBJECTS_ON_PATH_COMMAND_ID,
  OBJECTS_ON_PATH_COMMAND_IDS,
  OBJECTS_ON_PATH_DEFAULTS,
  OBJECTS_ON_PATH_FEATURE,
  OBJECTS_ON_PATH_LIBRARY_VERSION,
  OBJECTS_ON_PATH_NOTE,
  OBJECTS_ON_PATH_PANEL_ID,
  OBJECTS_ON_PATH_PANEL_NOTE,
  OBJECTS_ON_PATH_PART,
  ON_PATH_PIVOTS,
  RELEASE_OBJECTS_ON_PATH_COMMAND_ID,
  SELECT_OBJECTS_ON_PATH_COMMAND_ID,
  UPDATE_OBJECTS_ON_PATH_COMMAND_ID,
  type OnPathObject,
} from "../../src";
import { IDENTITY_AFFINE, measureSegment } from "@paged-media/draw-geometry";
import { F6_RING_PAIR } from "../fixtures/corpus";
import { openHost } from "./host";

const poly = (id: string): ElementId => ({ kind: "polygon", id }) as ElementId;

/** F6: `uinner` 200..300², `uouter` 100..400², `uopen` an open 3-anchor
 *  path spanning x 500..600, y 100..300 — the PATH here. */
const INNER = poly("uinner");
const OUTER = poly("uouter");
const OPEN = poly("uopen");

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

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
  return out;
}

const sortedLeafIds = async (h: HeadlessHost) => (await leafIds(h)).sort();

async function undoTo(h: HeadlessHost, steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) await h.host.document.undo();
}

/** An element's CURRENT item transform, or null when it is unreadable. */
async function transformOf(
  h: HeadlessHost,
  id: ElementId,
): Promise<number[] | null> {
  const g = await h.host.document.elementGeometry([id]);
  return g[0] ? ((g[0].itemTransform as number[] | null) ?? null) : null;
}

const opsOf = (m: Mutation): Mutation[] =>
  (m as { args: { ops: Mutation[] } }).args.ops;

/** A 100 × 100 object at the origin of its own space, home = identity. */
const boxObject = (id: string): OnPathObject => ({
  id: poly(id),
  innerBounds: [0, 0, 100, 100], // [top, left, bottom, right]
  home: IDENTITY_AFFINE,
});

describe("draw conformance — OBJECTS ON A PATH (§16.3)", () => {
  // ------------------------------------------------- pure: the model

  describe("the parameters", () => {
    it("objectsOnPathParamsFrom merges a loose payload over a base and clamps it", () => {
      expect(objectsOnPathParamsFrom(undefined)).toEqual(
        OBJECTS_ON_PATH_DEFAULTS,
      );
      const p = objectsOnPathParamsFrom({
        distribute: "sideways",
        spacingPt: -5,
        pivot: "nowhere",
        alignToPath: false,
        startOffsetPt: 12,
        order: [2, "x", 0],
      });
      expect(p.distribute).toBe(OBJECTS_ON_PATH_DEFAULTS.distribute);
      expect(p.spacingPt).toBeGreaterThan(0);
      expect(p.pivot).toBe("center");
      expect(p.alignToPath).toBe(false);
      expect(p.startOffsetPt).toBe(12);
      expect(p.order).toEqual([2, 0]); // the junk entry is dropped
    });

    it("the PIVOT grid is §16.1's — imported, not re-derived", () => {
      expect(ON_PATH_PIVOTS).toContain("center");
      expect(ON_PATH_PIVOTS).toContain("topLeft");
      expect(ON_PATH_PIVOTS).toHaveLength(9);
    });

    it("orderedIndices honours a partial permutation and the reverse flag", () => {
      const base = { ...OBJECTS_ON_PATH_DEFAULTS };
      expect(orderedIndices(4, base)).toEqual([0, 1, 2, 3]);
      expect(orderedIndices(4, { ...base, reverseOrder: true })).toEqual([
        3, 2, 1, 0,
      ]);
      // A PARTIAL permutation: named entries first, the rest follow in
      // their original order — so a half-typed order is still usable.
      expect(orderedIndices(4, { ...base, order: [3, 1] })).toEqual([3, 1, 0, 2]);
      // Out-of-range and duplicate entries are ignored, not fatal.
      expect(orderedIndices(3, { ...base, order: [9, 1, 1] })).toEqual([1, 0, 2]);
    });
  });

  describe("the placement", () => {
    const path = measureSegment([0, 0], [400, 0]);

    it("COUNT divides the path by the OBJECT COUNT, first and last on the ends", () => {
      const objects = [boxObject("a"), boxObject("b"), boxObject("c")];
      const placed = placeObjectsOnPath({
        objects,
        metric: path,
        params: { ...OBJECTS_ON_PATH_DEFAULTS, alignToPath: false },
        page: null,
      });
      expect(placed.map((p) => p.point)).toEqual([
        [0, 0],
        [200, 0],
        [400, 0],
      ]);
      // Each object's CENTRE (the default pivot) lands on its slot, so a
      // 100 × 100 box at the origin is translated by (-50, -50) + slot.
      expect(placed[0].matrix).toEqual([1, 0, 0, 1, -50, -50]);
      expect(placed[1].matrix).toEqual([1, 0, 0, 1, 150, -50]);
      expect(placed.every((p) => p.skipped === null)).toBe(true);
    });

    it("the PIVOT decides which point of the object lands on the slot", () => {
      const at = (pivot: (typeof ON_PATH_PIVOTS)[number]) =>
        placeObjectsOnPath({
          objects: [boxObject("a")],
          metric: path,
          params: { ...OBJECTS_ON_PATH_DEFAULTS, alignToPath: false, pivot },
          page: null,
        })[0].matrix;
      // slot 0 is (0, 0): topLeft needs no move at all…
      expect(at("topLeft")).toEqual([1, 0, 0, 1, 0, 0]);
      // …bottomRight pulls the whole box up and left by its size…
      expect(at("bottomRight")).toEqual([1, 0, 0, 1, -100, -100]);
      // …and `top` is the top EDGE's midpoint.
      expect(at("top")).toEqual([1, 0, 0, 1, -50, 0]);
    });

    it("ALIGN TO PATH rotates about the pivot — and a straight path turns nothing", () => {
      const flat = placeObjectsOnPath({
        objects: [boxObject("a")],
        metric: path,
        params: OBJECTS_ON_PATH_DEFAULTS,
        page: null,
      })[0];
      // The path runs at 0°, so aligning changes nothing.
      expect(flat.tangentDeg).toBeCloseTo(0, 9);
      expect(flat.matrix).toEqual([1, 0, 0, 1, -50, -50]);
      // A path running DOWN the page is +90° (y-down), and the object
      // turns with it.
      const down = placeObjectsOnPath({
        objects: [boxObject("a")],
        metric: measureSegment([200, 0], [200, 400]),
        params: OBJECTS_ON_PATH_DEFAULTS,
        page: null,
      })[0];
      expect(down.tangentDeg).toBeCloseTo(90, 9);
      expect(down.matrix![0]).toBeCloseTo(0, 9);
      expect(down.matrix![1]).toBeCloseTo(1, 9);
      expect(down.matrix![2]).toBeCloseTo(-1, 9);
    });

    it("SPACING walks a fixed gap; objects past the end are LEFT WHERE THEY ARE", () => {
      const objects = [boxObject("a"), boxObject("b"), boxObject("c")];
      const placed = placeObjectsOnPath({
        objects,
        metric: measureSegment([0, 0], [250, 0]),
        params: {
          ...OBJECTS_ON_PATH_DEFAULTS,
          distribute: "spacing",
          spacingPt: 200,
          alignToPath: false,
        },
        page: null,
      });
      // Slots at 0 and 200 fit in a 250 pt path; the third does not.
      expect(placed[0].skipped).toBeNull();
      expect(placed[1].skipped).toBeNull();
      expect(placed[2].skipped).toBe("noSlot");
      expect(placed[2].matrix).toBeNull();
    });

    it("MOVE ALONG PATH slides every slot", () => {
      const placed = placeObjectsOnPath({
        objects: [boxObject("a"), boxObject("b")],
        metric: path,
        params: {
          ...OBJECTS_ON_PATH_DEFAULTS,
          alignToPath: false,
          startOffsetPt: 50,
        },
        page: null,
      });
      expect(placed[0].point).toEqual([50, 0]);
      // The second slot (u = 1) + 50 runs past the end of an open path.
      expect(placed[1].skipped).toBe("noSlot");
    });

    it("fitToArtboard LEAVES an object home rather than moving it off the page", () => {
      const placed = placeObjectsOnPath({
        objects: [boxObject("a"), boxObject("b")],
        metric: measureSegment([50, 50], [590, 50]),
        params: { ...OBJECTS_ON_PATH_DEFAULTS, alignToPath: false },
        page: { width: 612, height: 792 },
      });
      // Slot 0 at (50, 50) fits; slot 1 at (590, 50) would put the box's
      // right edge at 640 > 612.
      expect(placed[0].skipped).toBeNull();
      expect(placed[1].skipped).toBe("offPage");
      expect(placed[1].matrix).toBeNull();
      // …and the SAME plan with the fit off does move it.
      const forced = placeObjectsOnPath({
        objects: [boxObject("a"), boxObject("b")],
        metric: measureSegment([50, 50], [590, 50]),
        params: {
          ...OBJECTS_ON_PATH_DEFAULTS,
          alignToPath: false,
          fitToArtboard: false,
        },
        page: { width: 612, height: 792 },
      });
      expect(forced[1].skipped).toBeNull();
    });

    it("the placement composes with an object's EXISTING transform", () => {
      const shifted: OnPathObject = {
        ...boxObject("a"),
        home: [1, 0, 0, 1, 1000, 1000],
      };
      // Its page-space hull is 1000..1100², so its centre is at (1050,
      // 1050) and the move to slot (0, 0) must undo that too.
      expect(onPathHullOf(shifted, shifted.home)).toEqual([
        1000, 1000, 1100, 1100,
      ]);
      const placed = placeObjectsOnPath({
        objects: [shifted],
        metric: path,
        params: { ...OBJECTS_ON_PATH_DEFAULTS, alignToPath: false },
        page: null,
      })[0];
      // M = D · home, and D translates the centre (1050, 1050) → (0, 0).
      expect(placed.matrix).toEqual([1, 0, 0, 1, -50, -50]);
    });
  });

  describe("the wire", () => {
    it("frameTransformMutationFor is the ONE door — and the batch is transforms then links", () => {
      expect(frameTransformMutationFor(poly("ua"), [1, 0, 0, 1, 5, 6])).toEqual({
        op: "setElementProperty",
        args: {
          elementId: poly("ua"),
          path: "frameTransform",
          value: { type: "transform", value: [1, 0, 0, 1, 5, 6] },
        },
      });
      const objects = [boxObject("a"), boxObject("b")];
      const placements = placeObjectsOnPath({
        objects,
        metric: measureSegment([0, 0], [400, 0]),
        params: { ...OBJECTS_ON_PATH_DEFAULTS, alignToPath: false },
        page: null,
      });
      const ops = opsOf(
        objectsOnPathBatchFor({
          plan: {
            pageId: "usp",
            onPath: "op-1",
            params: OBJECTS_ON_PATH_DEFAULTS,
            pathId: poly("us"),
            pathLength: 400,
            placements,
            dropped: 0,
          },
          envelopes: new Map(),
        }),
      );
      expect(ops.map((o) => o.op)).toEqual([
        "setElementProperty", // object a's transform
        "setElementProperty", // object b's transform
        "setPluginMetadata", // a's link
        "setPluginMetadata", // b's link
        "setPluginMetadata", // the path's link
      ]);
      // NO bindCreated, NO insertPath, NO createGroup, NO deleteFrame:
      // this lane creates nothing, so none of the batch-ordering rules
      // the other rows live under apply to it.
      expect(ops.map((o) => o.op)).not.toContain("bindCreated");
      expect(ops.map((o) => o.op)).not.toContain("insertPath");
    });

    it("a SKIPPED object still gets its link — it is in the association and knows its way home", () => {
      const objects = [boxObject("a"), boxObject("b")];
      const placements = placeObjectsOnPath({
        objects,
        metric: measureSegment([0, 0], [100, 0]),
        params: {
          ...OBJECTS_ON_PATH_DEFAULTS,
          distribute: "spacing",
          spacingPt: 500,
          alignToPath: false,
        },
        page: null,
      });
      expect(placements[1].skipped).toBe("noSlot");
      const ops = opsOf(
        objectsOnPathBatchFor({
          plan: {
            pageId: "usp",
            onPath: "op-1",
            params: OBJECTS_ON_PATH_DEFAULTS,
            pathId: poly("us"),
            pathLength: 100,
            placements,
            dropped: 1,
          },
          envelopes: new Map(),
        }),
      );
      // ONE transform (only `a` moved), but THREE links.
      expect(ops.filter((o) => o.op === "setElementProperty")).toHaveLength(1);
      expect(ops.filter((o) => o.op === "setPluginMetadata")).toHaveLength(3);
    });

    it("the RELEASE batch writes each HOME transform back, then drops the links", () => {
      const ops = opsOf(
        objectsOnPathReleaseBatchFor([
          {
            id: poly("a"),
            envelope: null,
            key: "onPathObject",
            home: [1, 0, 0, 1, 7, 8],
          },
          { id: poly("us"), envelope: null, key: "onPathSpine", home: null },
        ]),
      );
      expect(ops.map((o) => o.op)).toEqual([
        "setElementProperty", // a goes home
        "setPluginMetadata", // …then a is unlinked
        "setPluginMetadata", // …and so is the path
      ]);
      expect(ops[0]).toEqual(
        frameTransformMutationFor(poly("a"), [1, 0, 0, 1, 7, 8]),
      );
    });

    it("withOnPathKey preserves every OTHER draw metadata key, and affineFrom is strict", () => {
      const prev = {
        v: 1,
        data: { symbolInstance: { symbol: "sy-1" }, onPathObject: { onPath: "x" } },
      };
      const merged = withOnPathKey(prev, "onPathObject", {
        onPath: "op-2",
        index: 3,
        home: IDENTITY_AFFINE,
      });
      expect(merged?.data.symbolInstance).toEqual({ symbol: "sy-1" });
      expect(withOnPathKey(merged, "onPathObject", null)?.data).toEqual({
        symbolInstance: { symbol: "sy-1" },
      });
      expect(affineFrom([1, 0, 0, 1, 0, 0])).toEqual([1, 0, 0, 1, 0, 0]);
      expect(affineFrom([1, 0, 0, 1, 0])).toBeNull();
      expect(affineFrom([1, 0, 0, 1, 0, "x"])).toBeNull();
      expect(affineFrom(null)).toBeNull();
    });
  });

  describe("the recipe part", () => {
    it("round-trips, and anything unreadable reads as EMPTY", () => {
      const lib = upsertObjectsOnPathRecord(
        { v: OBJECTS_ON_PATH_LIBRARY_VERSION, associations: [] },
        {
          id: "op-1",
          name: "Beads",
          params: OBJECTS_ON_PATH_DEFAULTS,
          path: { kind: "polygon", id: "us" },
          objects: [{ kind: "polygon", id: "ua", home: [1, 0, 0, 1, 3, 4] }],
        },
      );
      expect(parseObjectsOnPathLibrary(serializeObjectsOnPathLibrary(lib))).toEqual(
        lib,
      );
      expect(mintObjectsOnPathId(lib)).toBe("op-2");
      expect(findObjectsOnPathRecord(lib, "op-1")?.name).toBe("Beads");
      expect(parseObjectsOnPathLibrary(null).associations).toEqual([]);
      expect(
        parseObjectsOnPathLibrary(new TextEncoder().encode("nope")).associations,
      ).toEqual([]);
      // A missing home degrades to the identity rather than throwing.
      const noHome = parseObjectsOnPathLibrary(
        new TextEncoder().encode(
          JSON.stringify({
            v: OBJECTS_ON_PATH_LIBRARY_VERSION,
            associations: [
              { id: "op-9", objects: [{ kind: "polygon", id: "ux" }] },
            ],
          }),
        ),
      );
      expect(noHome.associations[0].objects[0].home).toEqual(IDENTITY_AFFINE);
    });
  });

  // ------------------------------------------------ the real engine

  describe("against the booted engine (F6: two quads + an open path)", () => {
    let h: HeadlessHost;
    // Two 60 x 60 squares, small enough that BOTH ends of `uopen` are on
    // the page for them. `uouter` is 300 x 300 and deliberately is not —
    // it is the fit guard's specimen further down.
    let SMALL_A: ElementId;
    let SMALL_B: ElementId;
    let ALL: ElementId[];

    const square = (x: number, y: number) => [
      { anchor: [x, y], left: [x, y], right: [x, y] },
      { anchor: [x + 60, y], left: [x + 60, y], right: [x + 60, y] },
      { anchor: [x + 60, y + 60], left: [x + 60, y + 60], right: [x + 60, y + 60] },
      { anchor: [x, y + 60], left: [x, y + 60], right: [x, y + 60] },
    ];

    beforeAll(async () => {
      h = await openHost();
      await h.load(F6_RING_PAIR.bytes());
      h.loadBundle(drawBundle);
      const mint = async (x: number, y: number) => {
        const out = await h.host.document.mutate({
          op: "insertPath",
          args: { pageId: F6_RING_PAIR.pageId, anchors: square(x, y), open: false },
        } as unknown as Mutation);
        if (!out.applied || !out.createdId) throw new Error("insertPath failed");
        return out.createdId as unknown as ElementId;
      };
      SMALL_A = await mint(20, 20);
      SMALL_B = await mint(20, 120);
      ALL = [INNER, OUTER, OPEN, SMALL_A, SMALL_B];
    });
    afterAll(() => h?.dispose());

    // Reset the WORLD, not just the selection: these tests assert
    // ABSOLUTE transforms, and a test that fails mid-way would otherwise
    // poison every one after it.
    beforeEach(async () => {
      await h.host.selection.set([]);
      await writeObjectsOnPathLibrary(h.host, {
        v: OBJECTS_ON_PATH_LIBRARY_VERSION,
        associations: [],
      });
      await h.host.document.mutate({
        op: "batch",
        args: {
          ops: [
            ...ALL.map((id) => frameTransformMutationFor(id, IDENTITY_AFFINE)),
            ...ALL.map((id) => ({
              op: "setPluginMetadata",
              args: {
                elementId: id,
                key: "x-paged:media.paged.draw",
                value: null,
                caller: "media.paged.draw",
              },
            })),
          ],
        },
      } as unknown as Mutation);
    });

    it("the host wires the container-parts door the PARAMETERS ride", () => {
      expect(h.host.supports(OBJECTS_ON_PATH_FEATURE)).toBe(true);
    });

    it("THE DOOR: frameTransform REPLACES, and elementGeometry.bounds is NOT page space", async () => {
      // This is the measurement the whole module is built on, pinned
      // here so a protocol change fails loudly rather than quietly
      // producing artwork in the wrong place.
      const before = await h.host.document.elementGeometry([INNER]);
      expect(before[0].bounds).toEqual([200, 200, 300, 300]);
      expect(before[0].itemTransform).toEqual([1, 0, 0, 1, 0, 0]);

      const write = (m: number[]) =>
        h.host.document.mutate(frameTransformMutationFor(INNER, m as never));
      expect((await write([1, 0, 0, 1, 40, 60])).applied).toBe(true);
      const moved = await h.host.document.elementGeometry([INNER]);
      // The BOUNDS did not change — they are the frame box in the
      // element's OWN space. The TRANSFORM did.
      expect(moved[0].bounds).toEqual([200, 200, 300, 300]);
      expect(moved[0].itemTransform).toEqual([1, 0, 0, 1, 40, 60]);

      // …and writing again REPLACES rather than composing.
      expect((await write([1, 0, 0, 1, 40, 60])).applied).toBe(true);
      expect((await transformOf(h, INNER))).toEqual([1, 0, 0, 1, 40, 60]);
      await undoTo(h, 2);
      expect(await transformOf(h, INNER)).toEqual([1, 0, 0, 1, 0, 0]);
    });

    it("RFI C-23 ON TRANSFORMS: geometry goes silent — metadata and the TREE do NOT", async () => {
      // Stamp a link first, so "does metadata survive" is a real
      // question and not a vacuous one.
      await h.host.document.mutate({
        op: "setPluginMetadata",
        args: {
          elementId: INNER,
          key: "x-paged:media.paged.draw",
          value: JSON.stringify({ v: 1, data: { graphicStyle: { style: "gs-1" } } }),
          caller: "media.paged.draw",
        },
      } as unknown as Mutation);
      const stamped = await h.host.document.mutate(
        frameTransformMutationFor(INNER, [1, 0, 0, 1, 9000, 9000]),
      );
      expect(stamped.applied).toBe(true);
      // The GEOMETRY doors go silent…
      expect(await h.host.document.elementGeometry([INNER])).toHaveLength(0);
      expect(await h.host.document.pathAnchors(INNER)).toBeNull();
      // …and these two do NOT, which is the half that is easy to assume
      // wrongly: the element keeps its metadata and its place in the
      // tree, so it is never actually LOST — only unmeasurable.
      expect(await h.host.document.getMetadata(INNER)).not.toBeNull();
      expect(await leafIds(h)).toContain("uinner");
      // A write BY ID still reaches it and brings it back.
      expect(
        (await h.host.document.mutate(
          frameTransformMutationFor(INNER, IDENTITY_AFFINE),
        )).applied,
      ).toBe(true);
      expect(await h.host.document.elementGeometry([INNER])).toHaveLength(1);
    });

    it("…and a MODEST overhang costs nothing, while a large one does — the boundary is the engine's", async () => {
      // `uouter` is 100..400² on a 612 × 792 page. Two measurements, and
      // deliberately NO rule inferred between them: this plugin does not
      // model where the engine decides an item has left the page, and
      // this test exists to stop anyone writing down a boundary that was
      // guessed rather than measured. What matters downstream is only
      // that the guard is STRICTER than whatever the boundary is.
      await h.host.document.mutate(
        frameTransformMutationFor(OUTER, [1, 0, 0, 1, 250, -150]),
      );
      // 350..650 × -50..250 — over BOTH edges, and fully readable.
      expect(await h.host.document.elementGeometry([OUTER])).toHaveLength(1);
      expect(await h.host.document.pathAnchors(OUTER)).not.toBeNull();

      await h.host.document.mutate(
        frameTransformMutationFor(OUTER, [1, 0, 0, 1, 400, 0]),
      );
      // 500..800 — mostly past the right edge, and now silent.
      expect(await h.host.document.elementGeometry([OUTER])).toHaveLength(0);
      // …and its metadata and tree place survive even here.
      expect(await leafIds(h)).toContain("uouter");
    });

    it("MAKE MOVES the objects: no new elements, the SAME ids, ONE undo step", async () => {
      const before = await sortedLeafIds(h);
      // The PATH is the LAST selected item.
      await h.host.selection.set([SMALL_A, SMALL_B, OPEN]);
      const moved = await applyMakeObjectsOnPath(h.host, { alignToPath: false });

      // (1) NOTHING WAS CREATED — the leaf set is byte-for-byte the same.
      expect(await sortedLeafIds(h)).toEqual(before);
      // (2) The objects are the ones that were selected, by id.
      expect(moved.map((m) => String(m.id)).sort()).toEqual(
        [String(SMALL_A.id), String(SMALL_B.id)].sort(),
      );
      // (3) They really moved: two objects over an open path spanning
      // (500,100)→(600,200)→(500,300) land on its two ends, so each
      // object's CENTRE (the default pivot) sits there.
      // A is a 60² box at (20, 20) — centre (50, 50) — so landing its
      // centre on (500, 100) is a translation of (450, 50); B sits 100 pt
      // lower and lands on the path's far end (500, 300).
      expect(await transformOf(h, SMALL_A)).toEqual([1, 0, 0, 1, 450, 50]);
      expect(await transformOf(h, SMALL_B)).toEqual([1, 0, 0, 1, 450, 150]);
      // (4) The links are on, and the path carries its own.
      expect(
        onPathObjectOf(await h.host.document.getMetadata(SMALL_A))?.onPath,
      ).toBe("op-1");
      expect(onPathSpineOf(await h.host.document.getMetadata(OPEN))?.onPath).toBe(
        "op-1",
      );
      // …and each object's link REMEMBERS its way home.
      expect(
        onPathObjectOf(await h.host.document.getMetadata(SMALL_A))?.home,
      ).toEqual([1, 0, 0, 1, 0, 0]);

      // ONE undo puts everything back — the transforms AND the links.
      await h.host.document.undo();
      expect(await transformOf(h, SMALL_A)).toEqual([1, 0, 0, 1, 0, 0]);
      expect(await transformOf(h, SMALL_B)).toEqual([1, 0, 0, 1, 0, 0]);
      expect(await h.host.document.getMetadata(SMALL_A)).toBeNull();
    });

    it("a FOREIGN plugin's metadata on an object SURVIVES — nothing was re-created", async () => {
      await h.host.document.mutate({
        op: "setPluginMetadata",
        args: {
          elementId: SMALL_A,
          key: "x-paged:media.paged.draw",
          value: JSON.stringify({ v: 1, data: { graphicStyle: { style: "gs-7" } } }),
          caller: "media.paged.draw",
        },
      } as unknown as Mutation);
      await h.host.selection.set([SMALL_A, OPEN]);
      await applyMakeObjectsOnPath(h.host, { alignToPath: false });
      const env = await h.host.document.getMetadata(SMALL_A);
      expect((env?.data as { graphicStyle?: unknown }).graphicStyle).toEqual({
        style: "gs-7",
      });
      expect(onPathObjectOf(env)?.onPath).toBe("op-1");
    });

    it("UPDATE is IDEMPOTENT — every object is placed from its HOME, not from where it sits", async () => {
      await h.host.selection.set([SMALL_A, SMALL_B, OPEN]);
      await applyMakeObjectsOnPath(h.host, { alignToPath: false });
      const first = await transformOf(h, SMALL_A);
      // Running the SAME update twice more changes nothing: every object
      // is placed from its HOME transform, never from where it sits — so
      // the placement cannot accumulate.
      await applyUpdateObjectsOnPath(h.host, {});
      expect(await transformOf(h, SMALL_A)).toEqual(first);
      await applyUpdateObjectsOnPath(h.host, {});
      expect(await transformOf(h, SMALL_A)).toEqual(first);
      // …and a REAL parameter change does move it, in ONE undo step.
      await applyUpdateObjectsOnPath(h.host, { startOffsetPt: 30 });
      const shifted = await transformOf(h, SMALL_A);
      expect(shifted).not.toEqual(first);
      await h.host.document.undo();
      expect(await transformOf(h, SMALL_A)).toEqual(first);
    });

    it("ALIGN TO PATH turns the objects, and the pivot decides about what", async () => {
      await h.host.selection.set([SMALL_A, OPEN]);
      await applyMakeObjectsOnPath(h.host, { alignToPath: true });
      const turned = await transformOf(h, SMALL_A);
      // A single object takes slot 0, and the first leg of `uopen` runs
      // (500,100)→(600,200) — i.e. 45° in the y-down page frame.
      expect(turned![0]).toBeCloseTo(Math.SQRT1_2, 5);
      expect(turned![1]).toBeCloseTo(Math.SQRT1_2, 5);
      await h.host.document.undo();

      await writeObjectsOnPathLibrary(h.host, {
        v: OBJECTS_ON_PATH_LIBRARY_VERSION,
        associations: [],
      });
      await h.host.selection.set([SMALL_A, OPEN]);
      await applyMakeObjectsOnPath(h.host, { alignToPath: false });
      const flat = await transformOf(h, SMALL_A);
      expect(flat![0]).toBeCloseTo(1, 9);
      expect(flat![1]).toBeCloseTo(0, 9);
    });

    it("SPACING mode and REVERSE ORDER reach the engine", async () => {
      await h.host.selection.set([SMALL_A, SMALL_B, OPEN]);
      await applyMakeObjectsOnPath(h.host, {
        distribute: "spacing",
        spacingPt: 40,
        alignToPath: false,
      });
      const forwardA = await transformOf(h, SMALL_A);
      const forwardB = await transformOf(h, SMALL_B);
      // A spacing walk starts at the path's START, so A takes s = 0 and B
      // takes s = 40 — they are NOT on the two ends the count mode uses.
      expect(forwardA).toEqual([1, 0, 0, 1, 450, 50]);
      expect(forwardB![4]).toBeGreaterThan(450);

      await applyUpdateObjectsOnPath(h.host, { reverseOrder: true });
      // The two objects swapped slots.
      expect(await transformOf(h, SMALL_A)).not.toEqual(forwardA);
      expect(await transformOf(h, SMALL_B)).not.toEqual(forwardB);
      // A slot is a POINT, not a transform: B's home centre is 100 pt
      // lower than A's, so reaching the same point costs A 100 pt more
      // than it cost B. The placement is per-object, never shared.
      // (`toBeCloseTo`, not `toEqual`: the wire rounds a transform.)
      const swapped = await transformOf(h, SMALL_A);
      expect(swapped![4]).toBeCloseTo(forwardB![4], 4);
      expect(swapped![5]).toBeCloseTo(forwardB![5] + 100, 4);
      await h.host.document.undo();
      expect(await transformOf(h, SMALL_A)).toEqual(forwardA);
    });

    it("fitToArtboard LEAVES a too-big object home rather than stranding it", async () => {
      // `uouter` is 300 × 300; centring it on the path (x ≈ 500) would
      // put its right edge at ~650 on a 612 pt page.
      await h.host.selection.set([OUTER, OPEN]);
      const kept = await applyMakeObjectsOnPath(h.host, { alignToPath: false });
      // NOTHING was moved…
      expect(kept).toEqual([]);
      expect(await transformOf(h, OUTER)).toEqual([1, 0, 0, 1, 0, 0]);
      // …but it IS in the association, with its way home, and it is
      // still perfectly readable — which is the whole point of the guard.
      expect(onPathObjectOf(await h.host.document.getMetadata(OUTER))?.onPath).toBe(
        "op-1",
      );
      expect(await h.host.document.elementGeometry([OUTER])).toHaveLength(1);
    });

    it("the guard is STRICTER than the reads: a partial overhang is still readable", async () => {
      // Worth pinning, because it is the difference between the rule the
      // guard applies (fully INSIDE the page rect) and the rule the
      // engine applies (fully OUTSIDE it and you disappear). With the
      // guard off, `uouter` centred on (500, 100) overhangs the 612 pt
      // page by ~38 pt and the top by 50 — and still answers everything.
      await h.host.selection.set([OUTER, OPEN]);
      const forced = await applyMakeObjectsOnPath(h.host, {
        alignToPath: false,
        fitToArtboard: false,
      });
      expect(forced).toHaveLength(1);
      expect(await transformOf(h, OUTER)).toEqual([1, 0, 0, 1, 250, -150]);
      expect(await h.host.document.elementGeometry([OUTER])).toHaveLength(1);
      expect(onPathObjectOf(await h.host.document.getMetadata(OUTER))).not.toBeNull();
    });

    it("a STRANDED object is still LINKED — Release finds it and brings it home", async () => {
      await h.host.selection.set([SMALL_A, OPEN]);
      await applyMakeObjectsOnPath(h.host, { alignToPath: false });
      // Push it fully off the page rect, the way `fitToArtboard: false`
      // plus a far-away path could.
      await h.host.document.mutate(
        frameTransformMutationFor(SMALL_A, [1, 0, 0, 1, 9000, 9000]),
      );
      expect(await h.host.document.elementGeometry([SMALL_A])).toHaveLength(0);
      // The LINK WALK still sees it — this is the assertion that keeps
      // the module header honest about which doors C-23 actually takes.
      expect((await objectsOnPathLinks(h.host, "op-1")).objects).toHaveLength(1);
      // Update cannot PLACE it (nothing can measure it) but does not
      // forget it either: it keeps its seat and its way home.
      await applyUpdateObjectsOnPath(h.host, {});
      const record = findObjectsOnPathRecord(
        await readObjectsOnPathLibrary(h.host),
        "op-1",
      )!;
      expect(record.objects.map((o) => o.id)).toContain(String(SMALL_A.id));
      // …and Release brings it home exactly. The batch writes the
      // transform BEFORE it clears the link, so the element is back on
      // the page by the time that runs.
      expect(await applyReleaseObjectsOnPath(h.host, {})).toBe(1);
      expect(await transformOf(h, SMALL_A)).toEqual([1, 0, 0, 1, 0, 0]);
      expect(await h.host.document.getMetadata(SMALL_A)).toBeNull();
    });

    it("SELECT reaches the objects and the path", async () => {
      await h.host.selection.set([SMALL_A, SMALL_B, OPEN]);
      await applyMakeObjectsOnPath(h.host, { alignToPath: false });
      expect(
        (await applySelectObjectsOnPath(h.host, {})).map((i) => String(i.id)).sort(),
      ).toEqual([String(SMALL_A.id), String(SMALL_B.id)].sort());
      expect(
        (await applySelectObjectsOnPath(h.host, { which: "path" })).map((i) =>
          String(i.id),
        ),
      ).toEqual(["uopen"]);
      expect(
        await applySelectObjectsOnPath(h.host, { which: "all" }),
      ).toHaveLength(3);
    });

    it("RELEASE puts every object back EXACTLY; EXPAND leaves them on the path. 1 undo each", async () => {
      // RELEASE
      await h.host.selection.set([SMALL_A, SMALL_B, OPEN]);
      await applyMakeObjectsOnPath(h.host, { alignToPath: true });
      const placed = await transformOf(h, SMALL_A);
      expect(placed).not.toEqual([1, 0, 0, 1, 0, 0]);
      expect(await applyReleaseObjectsOnPath(h.host, {})).toBe(2);
      // Back at the identity, EXACTLY — frameTransform REPLACES, so this
      // is a restore and not an accumulated inverse (an aligned
      // placement carries a rotation, which an inverse would leave
      // residue from).
      expect(await transformOf(h, SMALL_A)).toEqual([1, 0, 0, 1, 0, 0]);
      expect(await transformOf(h, SMALL_B)).toEqual([1, 0, 0, 1, 0, 0]);
      expect(await h.host.document.getMetadata(SMALL_A)).toBeNull();
      expect(await h.host.document.getMetadata(OPEN)).toBeNull();
      // ONE undo step for the release: everything is back on the path.
      await h.host.document.undo();
      expect(await transformOf(h, SMALL_A)).toEqual(placed);

      // EXPAND
      await h.host.document.undo(); // …and one more unwinds the make
      await writeObjectsOnPathLibrary(h.host, {
        v: OBJECTS_ON_PATH_LIBRARY_VERSION,
        associations: [],
      });
      await h.host.selection.set([SMALL_A, SMALL_B, OPEN]);
      await applyMakeObjectsOnPath(h.host, { alignToPath: true });
      const onPath = await transformOf(h, SMALL_A);
      expect(await applyExpandObjectsOnPath(h.host, {})).toBe(true);
      // Still on the path…
      expect(await transformOf(h, SMALL_A)).toEqual(onPath);
      // …and nothing tracks it any more.
      expect(await h.host.document.getMetadata(SMALL_A)).toBeNull();
      expect(await readObjectsOnPathLibrary(h.host)).toEqual({
        v: OBJECTS_ON_PATH_LIBRARY_VERSION,
        associations: [],
      });
      // ONE undo step for the expand: the links come back.
      await h.host.document.undo();
      expect(
        onPathObjectOf(await h.host.document.getMetadata(SMALL_A))?.onPath,
      ).toBe("op-1");
    });

    it("the recipe records the association and resolves without a payload", async () => {
      await h.host.selection.set([SMALL_A, SMALL_B, OPEN]);
      await applyMakeObjectsOnPath(h.host, { name: "Beads", alignToPath: false });
      const record = findObjectsOnPathRecord(
        await readObjectsOnPathLibrary(h.host),
        "op-1",
      )!;
      expect(record.name).toBe("Beads");
      expect(record.path?.id).toBe("uopen");
      expect(record.objects.map((o) => o.id).sort()).toEqual(
        [String(SMALL_A.id), String(SMALL_B.id)].sort(),
      );
      expect(record.objects.every((o) => o.home.length === 6)).toBe(true);
      expect(await h.host.parts.read(OBJECTS_ON_PATH_PART)).not.toBeNull();
      const links = await objectsOnPathLinks(h.host, "op-1");
      expect(links.objects).toHaveLength(2);
      expect(links.paths).toHaveLength(1);
    });

    it("the honest refusals: nothing selected, only the path, an unmeasurable path", async () => {
      const before = await Promise.all(ALL.map((id) => transformOf(h, id)));
      await h.host.selection.set([]);
      await commandFor(h, MAKE_OBJECTS_ON_PATH_COMMAND_ID).handler(
        undefined,
        undefined,
      );
      // Only the path selected: nothing to put on it.
      await h.host.selection.set([OPEN]);
      expect(await applyMakeObjectsOnPath(h.host, {})).toEqual([]);
      // …and a "path" that answers no anchors at all is refused.
      await h.host.selection.set([SMALL_A, poly("unope")]);
      expect(await applyMakeObjectsOnPath(h.host, {})).toEqual([]);
      expect(await Promise.all(ALL.map((id) => transformOf(h, id)))).toEqual(
        before,
      );
    });

    it("a CLOSED path works too — and it WRAPS rather than running out of room", async () => {
      // `uouter` is a CLOSED 300 × 300 quad: a 1200 pt perimeter. Two
      // objects at a 700 pt spacing would run off an OPEN path of that
      // length; on a closed one the second simply carries on round.
      await h.host.selection.set([SMALL_A, SMALL_B, OUTER]);
      const moved = await applyMakeObjectsOnPath(h.host, {
        distribute: "spacing",
        spacingPt: 700,
        alignToPath: false,
      });
      expect(moved).toHaveLength(2);
      // s = 0 is the quad's top-left corner (100, 100); s = 700 is 100 pt
      // down its LEFT edge on the way back — i.e. past the far end.
      // s = 0 is the quad's top-left corner (100, 100). s = 700 is 300
      // (top) + 300 (right) + 100 along the BOTTOM edge, walking back —
      // i.e. (300, 400), which an open path of the same length could not
      // have reached.
      expect(await transformOf(h, SMALL_A)).toEqual([1, 0, 0, 1, 50, 50]);
      expect(await transformOf(h, SMALL_B)).toEqual([1, 0, 0, 1, 250, 250]);
    });
  });

  // ------------------------------------------------- the registration

  describe("the registration surface", () => {
    it("contributes five commands and a panel, in the declared order", () => {
      expect(OBJECTS_ON_PATH_COMMAND_IDS).toEqual([
        MAKE_OBJECTS_ON_PATH_COMMAND_ID,
        UPDATE_OBJECTS_ON_PATH_COMMAND_ID,
        SELECT_OBJECTS_ON_PATH_COMMAND_ID,
        EXPAND_OBJECTS_ON_PATH_COMMAND_ID,
        RELEASE_OBJECTS_ON_PATH_COMMAND_ID,
      ]);
      const declared = drawBundle.manifest.contributes?.commands ?? [];
      for (const id of OBJECTS_ON_PATH_COMMAND_IDS) expect(declared).toContain(id);
      expect(drawBundle.manifest.contributes?.panels).toContain(
        OBJECTS_ON_PATH_PANEL_ID,
      );
      expect(
        (drawBundle.manifest.contributes?.partTypes ?? []).map((p) => p.type),
      ).toContain("objectsOnPathRecipe");
    });

    it("the panel note carries the two facts the form cannot show", () => {
      expect(OBJECTS_ON_PATH_PANEL_NOTE).toContain(OBJECTS_ON_PATH_NOTE);
      // (1) It MOVES rather than copies — the opposite of every other row.
      expect(OBJECTS_ON_PATH_NOTE).toContain("THIS MOVES YOUR OBJECTS");
      expect(OBJECTS_ON_PATH_NOTE).toContain("IT CREATES NONE");
      expect(OBJECTS_ON_PATH_NOTE).toContain("TEXT FRAMES are not refused");
      // (2) The C-23 wording, which must stay the MEASURED one: the
      // geometry doors go silent, the metadata and the tree do not.
      expect(OBJECTS_ON_PATH_NOTE).toContain("keeps its metadata");
      expect(OBJECTS_ON_PATH_NOTE).toContain("RFI C-23");
      expect(OBJECTS_ON_PATH_NOTE).toContain("STRICTER rule");
      // …and the undo arithmetic.
      expect(OBJECTS_ON_PATH_PANEL_NOTE).toContain("ONE undo step each");
    });

    it("objectsOnPathRowLabel says what was asked for and what is on the path", () => {
      expect(
        objectsOnPathRowLabel(
          {
            id: "op-1",
            name: "Beads",
            params: { ...OBJECTS_ON_PATH_DEFAULTS },
            path: null,
            objects: [
              { kind: "polygon", id: "a", home: IDENTITY_AFFINE },
              { kind: "polygon", id: "b", home: IDENTITY_AFFINE },
            ],
          },
          2,
        ),
      ).toBe("2 even · aligned · pivot center (2 objects on the path)");
      expect(
        objectsOnPathRowLabel(
          {
            id: "op-2",
            name: "Dots",
            params: {
              ...OBJECTS_ON_PATH_DEFAULTS,
              distribute: "spacing",
              spacingPt: 20,
              alignToPath: false,
              startOffsetPt: 5,
              reverseOrder: true,
            },
            path: null,
            objects: [],
          },
          1,
        ),
      ).toBe(
        "every 20 pt · pivot center · offset 5 pt · reversed (1 object on the path)",
      );
    });
  });
});
