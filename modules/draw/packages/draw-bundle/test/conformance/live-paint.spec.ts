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

// LIVE PAINT v0 conformance — the last unbuilt Illustrator Phase-2 row,
// through the REAL engine wasm the harness boots. What this pins is, in
// order of how much it would hurt to get wrong:
//
//   (1) REGENERABLE ≠ LIVE. Editing a member does NOT move the paint —
//       asserted directly, twice: the fill's geometry is unchanged after
//       a member edit, and only Regenerate moves it. And when an edit
//       retires a face id, the recorded paint is DROPPED with a report
//       rather than quietly repainted somewhere else.
//   (2) THE CAPS. 13 members ⇒ the engine's own refusal reaches the
//       status binding and NO recipe is written; 12 ⇒ accepted.
//   (3) GAP DETECTION IS NOT BUILT — the catalog's "despite gaps".
//       Two open paths that ALMOST enclose a square do not produce a
//       face for that square, because the kernel takes no tolerance and
//       implicitly CLOSES every open subpath on itself. Both halves are
//       asserted against the real arrangement.
//   (4) EDGES ARE NOT BUILT — the wire carries face outlines and no edge
//       id at all, so the catalog's "or stroke edges" half has nothing
//       to address. Pinned as a shape assertion on the read door.
//   (5) THE REAL UNDO COUNTS (RFI C-15 — measure them, never claim
//       "one"): make = 1, fill = 2, regenerate = 2, delete face = 1,
//       release = 1.
//   (6) The persistence shape (a THIRD container part), the exact wire
//       shapes, the bucket/selection GESTURES driven with synthetic
//       pointer events, and the z-order fact a fill inherits.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";

import type {
  CanvasPointerEvent,
  CommandContribution,
  ElementId,
  Mutation,
  PluginMetadataEnvelope,
} from "@paged-media/plugin-api";
import type { AnchorTable } from "@paged-media/draw-geometry";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  applyDeleteLivePaintFace,
  applyFillLivePaintFace,
  applyMakeLivePaintGroup,
  applyRegenerateLivePaint,
  applyReleaseLivePaint,
  applySelectLivePaintFaces,
  bindLivePaintFaces,
  createLivePaintBucketHandler,
  createLivePaintSelectHandler,
  faceTableOf,
  fillLivePaintFaces,
  findLivePaintGroup,
  framePathMutationFor,
  getLivePaintFill,
  insertPathMutationFor,
  livePaintArrangement,
  livePaintContourCounts,
  livePaintDeleteBatchFor,
  livePaintFaceAt,
  livePaintFillOf,
  livePaintFinishBatchFor,
  livePaintInsertBatchFor,
  livePaintInputs,
  livePaintLinks,
  livePaintMemberBatchFor,
  livePaintMemberOf,
  livePaintReleaseBatchFor,
  livePaintRowLabel,
  mintLivePaintId,
  parseLivePaintLibrary,
  readPlanarRegions,
  removeLivePaintGroupFrom,
  selectedLivePaintGroup,
  serializeLivePaintLibrary,
  setLivePaintFill,
  stampDrawMetadata,
  upsertLivePaintGroup,
  withLivePaintFace,
  withLivePaintKey,
  withoutLivePaintFace,
  BIND_LIVE_PAINT_FACE,
  DELETE_LIVE_PAINT_FACE_COMMAND_ID,
  FILL_LIVE_PAINT_FACE_COMMAND_ID,
  LIVE_PAINT_COMMAND_IDS,
  LIVE_PAINT_DEFAULT_FILL,
  LIVE_PAINT_NOTE,
  LIVE_PAINT_PANEL_ID,
  LIVE_PAINT_PART,
  LIVE_PAINT_TOOL_IDS,
  MAKE_LIVE_PAINT_GROUP_COMMAND_ID,
  MAX_PLANAR_FACES,
  MAX_PLANAR_INPUTS,
  REGENERATE_LIVE_PAINT_COMMAND_ID,
  RELEASE_LIVE_PAINT_COMMAND_ID,
  SELECT_LIVE_PAINT_FACES_COMMAND_ID,
  type LivePaintFillPlan,
  type LivePaintRecipe,
  type PlanarRegionsWire,
} from "../../src";
import { F4_OVERLAP, F5_THIRTEEN, F6_RING_PAIR } from "../fixtures/corpus";
import { openHost } from "./host";

/** `ua` — the BACK square (100…300)². */
const A = { kind: "polygon", id: F4_OVERLAP.ids.polygon! } as ElementId;
/** `ub` — the FRONT square (200…400)². */
const B = { kind: "polygon", id: F4_OVERLAP.secondId } as ElementId;

/** F4's arrangement, with the members ordered TOP-TO-BOTTOM ([ub, ua]):
 *  index 0 is `ub`, index 1 is `ua`, so the overlap is `0-1#0`. */
const OVERLAP = "0-1#0";

const anchorAt = (p: [number, number]) => ({
  anchor: [p[0], p[1]] as [number, number],
  left: [p[0], p[1]] as [number, number],
  right: [p[0], p[1]] as [number, number],
});

/** An axis-aligned rectangle as an anchor table. */
const rect = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): AnchorTable => ({
  anchors: [
    anchorAt([x0, y0]),
    anchorAt([x1, y0]),
    anchorAt([x1, y1]),
    anchorAt([x0, y1]),
  ],
  subpathStarts: [0],
  subpathOpen: [false],
});

function pointer(
  pageId: string,
  point: [number, number],
  button = 0,
): CanvasPointerEvent {
  return {
    pageId,
    pagePoint: point,
    docPoint: point,
    modifiers: { shift: false, alt: false, cmd: false, ctrl: false },
    maxDelta: 0,
    button,
    target: null,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    pointerType: "mouse",
  };
}

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

async function leaves(h: HeadlessHost): Promise<ElementId[]> {
  const out: ElementId[] = [];
  const walk = (nodes: { id?: unknown; children?: unknown[] }[]) => {
    for (const node of nodes) {
      if (node.id) out.push(node.id as ElementId);
      if (node.children) walk(node.children as never);
    }
  };
  walk((await h.host.document.tree()) as never);
  return out;
}

const idsOf = (els: readonly ElementId[]): string[] =>
  els.map((e) => String((e as { id: unknown }).id));

/** The bounding box of an element's anchor table, rounded to whole pt. */
async function bboxOf(
  h: HeadlessHost,
  id: ElementId,
): Promise<number[] | null> {
  const t = await h.host.document.pathAnchors(id);
  if (!t || t.anchors.length === 0) return null;
  const xs = t.anchors.map((a) => a.anchor[0]);
  const ys = t.anchors.map((a) => a.anchor[1]);
  return [
    Math.round(Math.min(...xs)),
    Math.round(Math.min(...ys)),
    Math.round(Math.max(...xs)),
    Math.round(Math.max(...ys)),
  ];
}

async function until(
  predicate: () => Promise<boolean>,
  what: string,
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 3));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// =====================================================================
// PURE — the recipe, the links, the plan, the wire shapes, the wording.

describe("draw conformance — LIVE PAINT v0 (the recipe, pure)", () => {
  const GROUP: LivePaintRecipe = {
    id: "lp-1",
    name: "Live Paint 1",
    inputs: [
      { kind: "polygon", id: "ub" },
      { kind: "polygon", id: "ua" },
    ],
    faces: [{ face: OVERLAP, fill: "Color/Black" }],
  };

  it("round-trips through the part bytes", () => {
    const bytes = serializeLivePaintLibrary({ v: 1, groups: [GROUP] });
    // Indented JSON — the `spec` role exists to stay small and diffable.
    expect(new TextDecoder().decode(bytes)).toContain('\n  "groups": [');
    expect(parseLivePaintLibrary(bytes)).toEqual({ v: 1, groups: [GROUP] });
  });

  it("degrades to an EMPTY library rather than throwing", () => {
    const empty = { v: 1, groups: [] };
    expect(parseLivePaintLibrary(null)).toEqual(empty);
    expect(parseLivePaintLibrary(new Uint8Array())).toEqual(empty);
    expect(parseLivePaintLibrary(new TextEncoder().encode("not json{"))).toEqual(
      empty,
    );
    // A FUTURE recipe version is not guessed at.
    expect(
      parseLivePaintLibrary(
        new TextEncoder().encode('{"v":99,"groups":[{"id":"lp-1"}]}'),
      ),
    ).toEqual(empty);
    // An id-less group is dropped; a name-less one falls back to its id;
    // a half-written input or face row is dropped rather than restored
    // as a reference to nothing.
    expect(
      parseLivePaintLibrary(
        new TextEncoder().encode(
          '{"v":1,"groups":[{},{"id":"lp-4","inputs":[{"kind":"polygon"},' +
            '{"kind":"polygon","id":"ua"}],"faces":[{"fill":"x"},{"face":"0#0"}]}]}',
        ),
      ),
    ).toEqual({
      v: 1,
      groups: [
        {
          id: "lp-4",
          name: "lp-4",
          inputs: [{ kind: "polygon", id: "ua" }],
          faces: [{ face: "0#0", fill: null }],
        },
      ],
    });
  });

  it("mints deterministic ids and upserts/removes by id", () => {
    expect(mintLivePaintId({ v: 1, groups: [] })).toBe("lp-1");
    expect(mintLivePaintId({ v: 1, groups: [GROUP] })).toBe("lp-2");
    const two = upsertLivePaintGroup({ v: 1, groups: [GROUP] }, {
      ...GROUP,
      id: "lp-2",
    });
    expect(two.groups.map((g) => g.id)).toEqual(["lp-1", "lp-2"]);
    // An upsert of an existing id REPLACES in place (order preserved).
    const renamed = upsertLivePaintGroup(two, { ...GROUP, name: "Renamed" });
    expect(renamed.groups.map((g) => g.name)).toEqual(["Renamed", "Live Paint 1"]);
    expect(removeLivePaintGroupFrom(two, "lp-1").groups.map((g) => g.id)).toEqual(
      ["lp-2"],
    );
    expect(findLivePaintGroup(two, "nope")).toBeNull();
  });

  it("records a face's paint by upsert, order-stable, and forgets one", () => {
    const one = withLivePaintFace(GROUP, "0#0", "Color/Cyan");
    expect(one.faces).toEqual([
      { face: OVERLAP, fill: "Color/Black" },
      { face: "0#0", fill: "Color/Cyan" },
    ]);
    // Repainting an already-recorded face replaces IN PLACE — a face is
    // one entry, never two rows racing for the same id.
    const repainted = withLivePaintFace(one, OVERLAP, null);
    expect(repainted.faces).toEqual([
      { face: OVERLAP, fill: null },
      { face: "0#0", fill: "Color/Cyan" },
    ]);
    expect(withoutLivePaintFace(one, OVERLAP).faces).toEqual([
      { face: "0#0", fill: "Color/Cyan" },
    ]);
    expect(withoutLivePaintFace(one, "unknown").faces).toHaveLength(2);
  });

  it("the element links read tolerantly and PRESERVE every other draw key", () => {
    expect(livePaintMemberOf(null)).toBeNull();
    expect(livePaintMemberOf({ v: 1, data: {} })).toBeNull();
    expect(livePaintMemberOf({ v: 1, data: { livePaintMember: { group: "" } } }))
      .toBeNull();
    expect(
      livePaintMemberOf({ v: 1, data: { livePaintMember: { group: "lp-1" } } }),
    ).toEqual({ group: "lp-1", index: 0 });
    // A fill link needs BOTH halves — a group with no face names nothing.
    expect(
      livePaintFillOf({ v: 1, data: { livePaintFill: { group: "lp-1" } } }),
    ).toBeNull();
    expect(
      livePaintFillOf({
        v: 1,
        data: { livePaintFill: { group: "lp-1", face: OVERLAP } },
      }),
    ).toEqual({ group: "lp-1", face: OVERLAP });

    const prev: PluginMetadataEnvelope = {
      v: 1,
      data: { appearance: { fills: [], strokes: [] } },
      engine: { blitz: "x" },
    };
    const linked = withLivePaintKey(prev, "livePaintMember", {
      group: "lp-1",
      index: 2,
    })!;
    expect(linked.data.appearance).toEqual({ fills: [], strokes: [] });
    expect(linked.engine).toEqual({ blitz: "x" });
    // Dropping it leaves the appearance exactly where it was…
    expect(withLivePaintKey(linked, "livePaintMember", null)!.data).toEqual({
      appearance: { fills: [], strokes: [] },
    });
    // …and an envelope that carried NOTHING else clears to null rather
    // than persisting an empty husk.
    expect(
      withLivePaintKey(
        { v: 1, data: { livePaintFill: { group: "lp-1", face: OVERLAP } } },
        "livePaintFill",
        null,
      ),
    ).toBeNull();
  });

  it("a face outline becomes a CLOSED anchor table (faces are never open)", () => {
    const table = faceTableOf({
      id: OVERLAP,
      anchors: [
        { anchor: [0, 0], left: [0, 0], right: [0, 0] },
        { anchor: [10, 0], left: [10, 0], right: [10, 0] },
        { anchor: [10, 10], left: [10, 10], right: [10, 10] },
      ],
      subpathStarts: [0],
    });
    expect(table.anchors.map((a) => a.anchor)).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    expect(table.subpathStarts).toEqual([0]);
    expect(table.subpathOpen).toEqual([false]);
    // A HOLED face carries its hole as a second subpath, and both
    // contours are closed.
    const holed = faceTableOf({
      id: "0#0",
      anchors: [...rect(0, 0, 10, 10).anchors, ...rect(3, 3, 7, 7).anchors],
      subpathStarts: [0, 4],
    });
    expect(holed.subpathStarts).toEqual([0, 4]);
    expect(holed.subpathOpen).toEqual([false, false]);
  });

  describe("the plan + the exact wire shapes", () => {
    const PLAN: LivePaintFillPlan = {
      pageId: "usp",
      groupId: "lp-1",
      faces: [
        { face: OVERLAP, fill: "Color/Black", table: rect(200, 200, 300, 300) },
      ],
      stale: [],
    };

    it("BATCH 1 inserts one closed path per contour, and NOTHING else", () => {
      expect(livePaintContourCounts(PLAN)).toEqual([1]);
      expect(livePaintInsertBatchFor(PLAN)).toEqual({
        op: "batch",
        args: {
          ops: [
            insertPathMutationFor("usp", rect(200, 200, 300, 300).anchors, false),
          ],
        },
      });
      // A HOLED face inserts one path per contour and is re-merged in
      // batch 2 — the same `framePath` door Make Compound Path uses.
      const holed: LivePaintFillPlan = {
        ...PLAN,
        faces: [
          {
            face: "0#0",
            fill: null,
            table: {
              anchors: [
                ...rect(0, 0, 10, 10).anchors,
                ...rect(3, 3, 7, 7).anchors,
              ],
              subpathStarts: [0, 4],
              subpathOpen: [false, false],
            },
          },
        ],
      };
      expect(livePaintContourCounts(holed)).toEqual([2]);
      expect(
        (livePaintInsertBatchFor(holed) as { args: { ops: unknown[] } }).args.ops,
      ).toHaveLength(2);
    });

    it("bindLivePaintFaces chunks the minted ids back onto their faces", () => {
      const k = { kind: "polygon", id: "n1" } as ElementId;
      const j = { kind: "polygon", id: "n2" } as ElementId;
      expect(bindLivePaintFaces(PLAN, [k])).toEqual([
        { faceIndex: 0, keep: k, absorb: [] },
      ]);
      // A COUNT MISMATCH refuses rather than mis-binding.
      expect(bindLivePaintFaces(PLAN, [k, j])).toBeNull();
      expect(bindLivePaintFaces(PLAN, [])).toBeNull();
    });

    it("BATCH 2 deletes the replaced fills FIRST, then paints + stamps", () => {
      const keep = { kind: "polygon", id: "n1" } as ElementId;
      const old = { kind: "polygon", id: "old" } as ElementId;
      const batch = livePaintFinishBatchFor({
        plan: { ...PLAN, stale: [old] },
        bindings: [{ faceIndex: 0, keep, absorb: [] }],
      }) as { op: string; args: { ops: Mutation[] } };
      expect(batch.op).toBe("batch");
      expect(batch.args.ops).toEqual([
        { op: "deleteFrame", args: { frameId: "old" } },
        {
          op: "setElementProperty",
          args: {
            elementId: keep,
            path: "frameFillColor",
            value: { type: "colorRef", value: "Color/Black" },
          },
        },
        // A face fill carries NO stroke: an edge belongs to the member
        // path that bounds it, and v0 cannot stroke edges at all.
        {
          op: "setElementProperty",
          args: {
            elementId: keep,
            path: "frameStrokeColor",
            value: { type: "colorRef", value: null },
          },
        },
        // The metadata rides INSIDE the batch through the raw stamp
        // builder (its own `setMetadata` would be a second mutation and
        // a second undo step) — asserted through that very builder, so
        // there is no second copy of the envelope encoding to drift.
        stampDrawMetadata(keep, {
          v: 1,
          data: { livePaintFill: { group: "lp-1", face: OVERLAP } },
        }),
      ]);
    });

    it("a HOLED face re-merges through framePath and drops the extra contours", () => {
      const keep = { kind: "polygon", id: "n1" } as ElementId;
      const absorb = { kind: "polygon", id: "n2" } as ElementId;
      const table: AnchorTable = {
        anchors: [...rect(0, 0, 10, 10).anchors, ...rect(3, 3, 7, 7).anchors],
        subpathStarts: [0, 4],
        subpathOpen: [false, false],
      };
      const ops = (
        livePaintFinishBatchFor({
          plan: { ...PLAN, faces: [{ face: "0#0", fill: null, table }] },
          bindings: [{ faceIndex: 0, keep, absorb: [absorb] }],
        }) as { args: { ops: Mutation[] } }
      ).args.ops;
      expect(ops[0]).toEqual(framePathMutationFor(keep, table));
      expect(ops[1]).toEqual({
        op: "deleteFrame",
        args: { frameId: "n2" },
      });
    });

    it("the member / release / delete batches are each ONE batch", () => {
      const a = { kind: "polygon", id: "ua" } as ElementId;
      const b = { kind: "polygon", id: "ub" } as ElementId;
      expect(
        livePaintMemberBatchFor("lp-1", [
          { id: b, envelope: null },
          { id: a, envelope: null },
        ]),
      ).toEqual({
        op: "batch",
        args: {
          ops: [
            stampDrawMetadata(b, {
              v: 1,
              data: { livePaintMember: { group: "lp-1", index: 0 } },
            }),
            stampDrawMetadata(a, {
              v: 1,
              data: { livePaintMember: { group: "lp-1", index: 1 } },
            }),
          ],
        },
      });
      expect(
        livePaintReleaseBatchFor([
          { id: a, envelope: null, key: "livePaintMember" },
        ]),
      ).toEqual({
        op: "batch",
        args: { ops: [stampDrawMetadata(a, null)] },
      });
      expect(livePaintDeleteBatchFor([a, b])).toEqual({
        op: "batch",
        args: {
          ops: [
            { op: "deleteFrame", args: { frameId: "ua" } },
            { op: "deleteFrame", args: { frameId: "ub" } },
          ],
        },
      });
    });
  });

  describe("the honest wording is pinned (it cannot be edited away silently)", () => {
    it("the panel note states regenerable-not-live, the missing gaps and edges, the caps and the z-order", () => {
      expect(LIVE_PAINT_NOTE).toContain("REGENERABLE, NOT LIVE");
      expect(LIVE_PAINT_NOTE).toContain("GAPS ARE NOT HANDLED");
      expect(LIVE_PAINT_NOTE).toContain("EDGES ARE NOT BUILT");
      expect(LIVE_PAINT_NOTE).toContain("12 member paths or 256 faces");
      expect(LIVE_PAINT_NOTE).toContain("TOP of the z-order");
      expect(LIVE_PAINT_NOTE).toContain("OUTSIDE the undo stack");
    });

    it("the command titles carry the honest verbs", () => {
      expect(LIVE_PAINT_COMMAND_IDS).toEqual([
        MAKE_LIVE_PAINT_GROUP_COMMAND_ID,
        FILL_LIVE_PAINT_FACE_COMMAND_ID,
        REGENERATE_LIVE_PAINT_COMMAND_ID,
        SELECT_LIVE_PAINT_FACES_COMMAND_ID,
        DELETE_LIVE_PAINT_FACE_COMMAND_ID,
        RELEASE_LIVE_PAINT_COMMAND_ID,
      ]);
    });

    it("the row label counts members and PAINTED faces (the Regenerate blast radius)", () => {
      expect(livePaintRowLabel(GROUP)).toBe("2 members · 1 painted face");
      expect(livePaintRowLabel({ ...GROUP, faces: [] })).toBe(
        "2 members · 0 painted faces",
      );
    });

    it("the caps mirrored for callers match the engine's own constants", () => {
      expect(MAX_PLANAR_INPUTS).toBe(12);
      expect(MAX_PLANAR_FACES).toBe(256);
    });
  });
});

// =====================================================================
// AGAINST THE REAL ENGINE.

describe("draw conformance — LIVE PAINT v0 (against the real engine, F4)", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  // A pristine document + an empty recipe part per test: filling INSERTS
  // and regenerating DELETES page items, so chaining state across tests
  // would make the undo arithmetic unreadable.
  beforeEach(async () => {
    await h.load(F4_OVERLAP.bytes());
    await h.host.parts.write(
      LIVE_PAINT_PART,
      serializeLivePaintLibrary({ v: 1, groups: [] }),
    );
    await h.host.selection.set([]);
    setLivePaintFill(LIVE_PAINT_DEFAULT_FILL);
  });

  it("registers the six commands, the two tools and the right-docked panel", () => {
    for (const id of LIVE_PAINT_COMMAND_IDS) {
      expect(commandFor(h, id).category).toBe("Live Paint");
    }
    expect(commandFor(h, MAKE_LIVE_PAINT_GROUP_COMMAND_ID).title).toContain(
      "REGENERABLE recipe — not a live object",
    );
    expect(commandFor(h, REGENERATE_LIVE_PAINT_COMMAND_ID).title).toContain(
      "ids may not survive",
    );
    const panel = h.panelsContributed().find((p) => p.id === LIVE_PAINT_PANEL_ID);
    expect(panel).toBeDefined();
    expect(panel!.title).toBe("Live Paint (draw)");
    expect(panel!.defaultDock).toBe("right");
    expect(typeof panel!.component).toBe("function");
  });

  it("INV-REG-1: the two tool shortcuts avoid BOTH catalog keys, which are taken", () => {
    const tools = h
      .toolsContributed()
      .filter((t) => (LIVE_PAINT_TOOL_IDS as readonly string[]).includes(t.id));
    expect(tools.map((t) => t.id)).toEqual([...LIVE_PAINT_TOOL_IDS]);
    const shortcuts = tools.map((t) => t.shortcut);
    // Illustrator's own keys: `k` (bucket) is an editor built-in single
    // key and `shift+l` (selection) is held by paged.image — so neither
    // is taken here, and nothing in the bundle collides either.
    expect(shortcuts).toEqual(["shift+o", "shift+v"]);
    const all = h.toolsContributed().map((t) => t.shortcut);
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain("k");
    expect(all).not.toContain("shift+l");
  });

  it("the host wires the container parts door this feature rides", () => {
    expect(h.host.supports("storage.parts@1")).toBe(true);
  });

  // ------------------------------------------------------- make a group

  it("MAKE GROUP records the ORDERED members and stamps them — ONE undo step", async () => {
    await h.host.selection.set([A, B]);
    const group = await applyMakeLivePaintGroup(h.host, { name: "Shield" });
    expect(group).not.toBeNull();

    // (1) the persistence shape — a THIRD part under this plugin's
    // namespace, beside the graphic-style and symbol libraries.
    expect(await h.host.parts.list("")).toContain(LIVE_PAINT_PART);
    const library = parseLivePaintLibrary(
      await h.host.parts.read(LIVE_PAINT_PART),
    );
    expect(library.v).toBe(1);
    expect(library.groups).toHaveLength(1);
    expect(library.groups[0]!.id).toBe("lp-1");
    expect(library.groups[0]!.name).toBe("Shield");
    expect(library.groups[0]!.faces).toEqual([]);
    // (2) TOP-TO-BOTTOM, read from the scene tree's paint order — NOT
    // the click order above (which was bottom-up on purpose). The order
    // IS the signature basis, so getting it from the selection would
    // make every recorded face id mean something else.
    expect(library.groups[0]!.inputs).toEqual([
      { kind: "polygon", id: "ub" },
      { kind: "polygon", id: "ua" },
    ]);

    // (3) the members carry their index, in ONE batch.
    expect(livePaintMemberOf(await h.host.document.getMetadata(B))).toEqual({
      group: "lp-1",
      index: 0,
    });
    expect(livePaintMemberOf(await h.host.document.getMetadata(A))).toEqual({
      group: "lp-1",
      index: 1,
    });
    await h.host.document.undo();
    expect(await h.host.document.getMetadata(B)).toBeNull();
    expect(await h.host.document.getMetadata(A)).toBeNull();
  });

  it("MAKE GROUP refuses fewer than two path-bearing elements", async () => {
    await h.host.selection.set([A]);
    expect(await applyMakeLivePaintGroup(h.host)).toBeNull();
    expect(
      parseLivePaintLibrary(await h.host.parts.read(LIVE_PAINT_PART)).groups,
    ).toEqual([]);
  });

  // ------------------------------------------------------------- fill

  it("FILL a face by POINT inserts the region's artwork — exactly TWO batches", async () => {
    await h.host.selection.set([A, B]);
    await applyMakeLivePaintGroup(h.host);
    const before = await leaves(h);

    const painted = await applyFillLivePaintFace(h.host, {
      x: 250,
      y: 250,
      fill: "Color/Black",
    });
    expect(painted).toEqual([OVERLAP]);

    // A new leaf, carrying the OVERLAP square — the region, not either
    // whole member. Both members survive untouched (this is paint, not
    // a pathfinder).
    const after = await leaves(h);
    expect(after).toHaveLength(before.length + 1);
    expect(idsOf(after)).toEqual(expect.arrayContaining(["ua", "ub"]));
    const fill = after.find((e) => !idsOf(before).includes(String(e.id)))!;
    expect(await bboxOf(h, fill)).toEqual([200, 200, 300, 300]);
    expect(await bboxOf(h, A)).toEqual([100, 100, 300, 300]);
    expect(await bboxOf(h, B)).toEqual([200, 200, 400, 400]);
    expect(livePaintFillOf(await h.host.document.getMetadata(fill))).toEqual({
      group: "lp-1",
      face: OVERLAP,
    });
    // The recipe remembers the paint (that is what makes it regenerable).
    expect(
      parseLivePaintLibrary(await h.host.parts.read(LIVE_PAINT_PART)).groups[0]!
        .faces,
    ).toEqual([{ face: OVERLAP, fill: "Color/Black" }]);

    // TWO undo steps — measured, not claimed. One is not enough.
    await h.host.document.undo();
    expect(await leaves(h)).toHaveLength(before.length + 1);
    await h.host.document.undo();
    expect(idsOf(await leaves(h))).toEqual(idsOf(before));
  });

  it("Z-ORDER, named rather than hidden: the fill lands at the TOP of the page", async () => {
    await h.host.selection.set([A, B]);
    await applyMakeLivePaintGroup(h.host);
    await applyFillLivePaintFace(h.host, { face: OVERLAP });
    // The scene tree reports PAINT order (back to front), so the fill
    // being LAST means it paints over the members that bound it. There
    // is no insert-at-z argument on `insertPath` and no reorder op on
    // the wire — folded into RFI C-30.
    const order = idsOf(await leaves(h));
    expect(order.slice(0, 2)).toEqual(["ua", "ub"]);
    expect(order).toHaveLength(3);
  });

  it("repainting the SAME face replaces its artwork instead of stacking a second copy", async () => {
    await h.host.selection.set([A, B]);
    await applyMakeLivePaintGroup(h.host);
    await applyFillLivePaintFace(h.host, { face: OVERLAP, fill: "Color/Black" });
    const once = await leaves(h);

    await applyFillLivePaintFace(h.host, { face: OVERLAP, fill: "Color/Cyan" });
    const twice = await leaves(h);
    expect(twice).toHaveLength(once.length);
    const library = parseLivePaintLibrary(
      await h.host.parts.read(LIVE_PAINT_PART),
    );
    expect(library.groups[0]!.faces).toEqual([
      { face: OVERLAP, fill: "Color/Cyan" },
    ]);
    const links = await livePaintLinks(h.host, "lp-1");
    expect(links.fills).toHaveLength(1);
  });

  it("a face id the arrangement does not carry is REPORTED, never painted somewhere else", async () => {
    await h.host.selection.set([A, B]);
    await applyMakeLivePaintGroup(h.host);
    const before = await leaves(h);
    expect(await applyFillLivePaintFace(h.host, { face: "9-9#9" })).toEqual([]);
    expect(await leaves(h)).toHaveLength(before.length);
  });

  // --------------------------------------------- REGENERABLE ≠ LIVE

  it("REGENERABLE ≠ LIVE: editing a member does NOT move the paint; Regenerate does", async () => {
    await h.host.selection.set([A, B]);
    await applyMakeLivePaintGroup(h.host);
    await applyFillLivePaintFace(h.host, { face: OVERLAP });
    const fillId = (await livePaintLinks(h.host, "lp-1")).fills[0]!.id;
    expect(await bboxOf(h, fillId)).toEqual([200, 200, 300, 300]);

    // Move `ub` down-right by 50 pt: the overlap becomes (250…300)².
    await h.host.document.mutate(
      framePathMutationFor(B, rect(250, 250, 450, 450)),
    );
    // THE PIN: the paint has NOT followed. This is the whole reason the
    // feature is called regenerable and not live.
    expect(await bboxOf(h, fillId)).toEqual([200, 200, 300, 300]);

    const result = await applyRegenerateLivePaint(h.host, { groupId: "lp-1" });
    expect(result).toEqual({ rebuilt: 1, dropped: [] });
    const rebuilt = (await livePaintLinks(h.host, "lp-1")).fills[0]!;
    expect(rebuilt.ref.face).toBe(OVERLAP);
    expect(await bboxOf(h, rebuilt.id)).toEqual([250, 250, 300, 300]);
    // A rebuild MINTS A NEW ELEMENT ID (named in the module header).
    expect(String(rebuilt.id.id)).not.toBe(String(fillId.id));
  });

  it("REGENERATE is exactly TWO batches for the whole group", async () => {
    await h.host.selection.set([A, B]);
    await applyMakeLivePaintGroup(h.host);
    await applyFillLivePaintFace(h.host, { faces: [OVERLAP, "0#0"] });
    expect((await livePaintLinks(h.host, "lp-1")).fills).toHaveLength(2);
    const before = idsOf(await leaves(h));

    await applyRegenerateLivePaint(h.host, { groupId: "lp-1" });
    // Two faces rebuilt: two old fills gone, two new ones in.
    expect(await leaves(h)).toHaveLength(before.length);
    await h.host.document.undo();
    await h.host.document.undo();
    expect(idsOf(await leaves(h))).toEqual(before);
  });

  it("a face id an edit RETIRES loses its paint, is reported, and its stale artwork is removed", async () => {
    await h.host.selection.set([A, B]);
    await applyMakeLivePaintGroup(h.host);
    await applyFillLivePaintFace(h.host, { face: OVERLAP });
    expect((await livePaintLinks(h.host, "lp-1")).fills).toHaveLength(1);

    // Move `ub` clear of `ua`: the two squares no longer overlap, so the
    // signature {0,1} has no region at all and `0-1#0` is gone.
    await h.host.document.mutate(
      framePathMutationFor(B, rect(600, 600, 700, 700)),
    );
    const result = await applyRegenerateLivePaint(h.host, { groupId: "lp-1" });
    expect(result.rebuilt).toBe(0);
    expect(result.dropped).toEqual([OVERLAP]);
    // The artwork bounded by geometry that is gone is REMOVED, not left.
    expect((await livePaintLinks(h.host, "lp-1")).fills).toEqual([]);
    // …and the recipe forgot the paint, so a later Regenerate is a no-op
    // rather than a repeat of the same warning.
    expect(
      parseLivePaintLibrary(await h.host.parts.read(LIVE_PAINT_PART)).groups[0]!
        .faces,
    ).toEqual([]);
  });

  // ------------------------------------------------------ select faces

  it("SELECT FACES puts the materialised fills on the selection", async () => {
    await h.host.selection.set([A, B]);
    await applyMakeLivePaintGroup(h.host);
    await applyFillLivePaintFace(h.host, { faces: [OVERLAP, "0#0"] });

    const all = await applySelectLivePaintFaces(h.host, { groupId: "lp-1" });
    expect(all).toHaveLength(2);
    expect(h.host.selection.get()).toHaveLength(2);

    const one = await applySelectLivePaintFaces(h.host, {
      groupId: "lp-1",
      face: OVERLAP,
    });
    expect(one).toHaveLength(1);
    expect(await bboxOf(h, one[0]!)).toEqual([200, 200, 300, 300]);
  });

  it("an UNPAINTED face has nothing to select — the persistent-object gap, stated", async () => {
    await h.host.selection.set([A, B]);
    await applyMakeLivePaintGroup(h.host);
    // `1#0` is a real face of the arrangement — it just carries no paint,
    // and v0 has no face OBJECT to select in its place (RFI C-30).
    const arrangement = await livePaintArrangement(
      h.host,
      (await selectedLivePaintGroup(h.host))!,
      "spec",
    );
    expect(arrangement!.faces.map((f) => f.id)).toEqual(
      expect.arrayContaining([OVERLAP, "0#0", "1#0"]),
    );
    expect(
      await applySelectLivePaintFaces(h.host, {
        groupId: "lp-1",
        face: "1#0",
      }),
    ).toEqual([]);
  });

  // ------------------------------------------------- delete + release

  it("DELETE FACE removes its artwork and forgets its paint — ONE undo step", async () => {
    await h.host.selection.set([A, B]);
    await applyMakeLivePaintGroup(h.host);
    await applyFillLivePaintFace(h.host, { face: OVERLAP });
    const withFill = await leaves(h);

    expect(
      await applyDeleteLivePaintFace(h.host, { groupId: "lp-1", face: OVERLAP }),
    ).toEqual([OVERLAP]);
    expect(await leaves(h)).toHaveLength(withFill.length - 1);
    expect(
      parseLivePaintLibrary(await h.host.parts.read(LIVE_PAINT_PART)).groups[0]!
        .faces,
    ).toEqual([]);
    await h.host.document.undo();
    expect(idsOf(await leaves(h))).toEqual(idsOf(withFill));
  });

  it("RELEASE drops every link and the recipe, and KEEPS all the artwork — ONE undo step", async () => {
    await h.host.selection.set([A, B]);
    await applyMakeLivePaintGroup(h.host);
    await applyFillLivePaintFace(h.host, { face: OVERLAP });
    const before = idsOf(await leaves(h));

    expect(await applyReleaseLivePaint(h.host, { groupId: "lp-1" })).toBe(true);
    // Nothing was destroyed: the members are still members and the
    // painted face is still a filled path.
    expect(idsOf(await leaves(h))).toEqual(before);
    expect(await h.host.document.getMetadata(A)).toBeNull();
    expect(await h.host.document.getMetadata(B)).toBeNull();
    const links = await livePaintLinks(h.host);
    expect(links.members).toEqual([]);
    expect(links.fills).toEqual([]);
    expect(
      parseLivePaintLibrary(await h.host.parts.read(LIVE_PAINT_PART)).groups,
    ).toEqual([]);

    // ONE undo restores every link together — one batch, one step. (The
    // RECIPE does not come back: a container write is not a mutation.)
    await h.host.document.undo();
    expect(livePaintMemberOf(await h.host.document.getMetadata(A))).not.toBeNull();
  });

  it("the recipe part is NOT on the undo stack (a container write is no mutation)", async () => {
    await h.host.selection.set([A, B]);
    await applyMakeLivePaintGroup(h.host);
    await h.host.document.undo(); // unwinds the member stamps
    expect(
      parseLivePaintLibrary(await h.host.parts.read(LIVE_PAINT_PART)).groups,
    ).toHaveLength(1);
  });

  // ------------------------------------------------------ the gestures

  describe("the live gesture tools (synthetic pointer events, real engine)", () => {
    /** Arm a handler over a document that already carries a group. */
    const armed = async (
      make: (host: HeadlessHost["host"]) => ReturnType<
        typeof createLivePaintBucketHandler
      >,
    ) => {
      await h.host.selection.set([A, B]);
      await applyMakeLivePaintGroup(h.host);
      const handler = make(h.host);
      handler.onActivate(undefined as never);
      // Let the recipe resolve off the selection.
      await new Promise((r) => setTimeout(r, 30));
      return handler;
    };

    it("the BUCKET hovers a face and PREVIEWS its outline through the overlay", async () => {
      const handler = await armed(createLivePaintBucketHandler);
      handler.onPointerMove(pointer(F4_OVERLAP.pageId, [250, 250]));
      await until(async () => {
        const p = h.lastToolPreview();
        return p !== null && "anchors" in p;
      }, "the face highlight");
      const preview = h.lastToolPreview() as unknown as {
        pageId: string;
        anchors: ReadonlyArray<{ anchor: [number, number] }>;
        close?: boolean;
      };
      expect(preview.pageId).toBe(F4_OVERLAP.pageId);
      expect(preview.close).toBe(true);
      const xs = preview.anchors.map((a) => a.anchor[0]);
      const ys = preview.anchors.map((a) => a.anchor[1]);
      expect([
        Math.round(Math.min(...xs)),
        Math.round(Math.min(...ys)),
        Math.round(Math.max(...xs)),
        Math.round(Math.max(...ys)),
      ]).toEqual([200, 200, 300, 300]);
      // The resolved face id is published, so a panel can name it even
      // before it carries paint.
      expect(h.host.bindings.get(BIND_LIVE_PAINT_FACE)).toBe(OVERLAP);
      handler.onDeactivate("switch");
    });

    it("a BUCKET click fills the hovered face", async () => {
      const handler = await armed(createLivePaintBucketHandler);
      const before = await leaves(h);
      setLivePaintFill("Color/Black");
      expect(getLivePaintFill()).toBe("Color/Black");

      handler.onPointerDown(pointer(F4_OVERLAP.pageId, [250, 250]));
      await new Promise((r) => setTimeout(r, 40));
      handler.onPointerUp(pointer(F4_OVERLAP.pageId, [250, 250]));

      await until(
        async () => (await leaves(h)).length === before.length + 1,
        "the bucket fill",
      );
      const links = await livePaintLinks(h.host, "lp-1");
      expect(links.fills).toHaveLength(1);
      expect(links.fills[0]!.ref.face).toBe(OVERLAP);
      expect(await bboxOf(h, links.fills[0]!.id)).toEqual([200, 200, 300, 300]);
      handler.onDeactivate("switch");
    });

    it("a BUCKET drag fills every face it crosses, in ONE plan", async () => {
      const handler = await armed(createLivePaintBucketHandler);
      const before = await leaves(h);

      // ua-only (150,150) → the overlap (250,250) → ub-only (370,370).
      handler.onPointerDown(pointer(F4_OVERLAP.pageId, [150, 150]));
      await new Promise((r) => setTimeout(r, 40));
      handler.onPointerMove(pointer(F4_OVERLAP.pageId, [250, 250]));
      handler.onPointerMove(pointer(F4_OVERLAP.pageId, [370, 370]));
      await new Promise((r) => setTimeout(r, 20));
      handler.onPointerUp(pointer(F4_OVERLAP.pageId, [370, 370]));

      await until(
        async () => (await leaves(h)).length === before.length + 3,
        "the three-face drag",
      );
      const links = await livePaintLinks(h.host, "lp-1");
      expect(new Set(links.fills.map((f) => f.ref.face))).toEqual(
        new Set([OVERLAP, "0#0", "1#0"]),
      );
      handler.onDeactivate("switch");
    });

    it("the SELECTION tool picks a painted face's artwork, and says so when there is none", async () => {
      const handler = await armed(createLivePaintSelectHandler);
      await fillLivePaintFaces(
        h.host,
        (await selectedLivePaintGroup(h.host))!,
        [OVERLAP],
        "Color/Black",
        "spec",
      );
      const fillId = (await livePaintLinks(h.host, "lp-1")).fills[0]!.id;

      handler.onPointerDown(pointer(F4_OVERLAP.pageId, [250, 250]));
      await new Promise((r) => setTimeout(r, 40));
      handler.onPointerUp(pointer(F4_OVERLAP.pageId, [250, 250]));
      await until(
        async () => idsOf(h.host.selection.get())[0] === String(fillId.id),
        "the face selection",
      );
      expect(h.host.selection.get()).toHaveLength(1);
      handler.onDeactivate("switch");
    });

    it("a gesture over empty space is an honest no-op", async () => {
      const handler = await armed(createLivePaintBucketHandler);
      const before = await leaves(h);
      handler.onPointerDown(pointer(F4_OVERLAP.pageId, [20, 20]));
      await new Promise((r) => setTimeout(r, 30));
      handler.onPointerUp(pointer(F4_OVERLAP.pageId, [20, 20]));
      await new Promise((r) => setTimeout(r, 40));
      expect(await leaves(h)).toHaveLength(before.length);
      handler.onDeactivate("switch");
    });
  });
});

// =====================================================================
// THE CAPS — the engine refuses, it never truncates.

describe("draw conformance — LIVE PAINT v0 (the 12-input cap, F5)", () => {
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

  beforeEach(async () => {
    await h.host.parts.write(
      LIVE_PAINT_PART,
      serializeLivePaintLibrary({ v: 1, groups: [] }),
    );
  });

  it("MAKE GROUP over 13 members is REFUSED with the engine's own sentence, and writes NOTHING", async () => {
    await h.host.selection.set(ids);
    expect(await applyMakeLivePaintGroup(h.host)).toBeNull();
    // The user sees the engine's words, not "no regions".
    const status = String(h.host.bindings.get("media.paged.draw.pathfinderStatus"));
    expect(status).toContain("planar arrangement takes at most 12");
    expect(status).toContain("13");
    // And no half-made group is left behind to paint with.
    expect(
      parseLivePaintLibrary(await h.host.parts.read(LIVE_PAINT_PART)).groups,
    ).toEqual([]);
    // Nothing in the document was touched either.
    expect(await h.host.document.getMetadata(ids[0]!)).toBeNull();
  });

  it("TWELVE members — the cap itself — are accepted", async () => {
    await h.host.selection.set(ids.slice(0, 12));
    const group = await applyMakeLivePaintGroup(h.host);
    expect(group).not.toBeNull();
    expect(group!.inputs).toHaveLength(12);
    await h.host.document.undo();
  });

  it("the FACE cap is a refusal too, and the read door reports it the same way", async () => {
    // 256 faces is out of reach for a fixture, so the shape of the
    // refusal is what is pinned: a `found:false` with a reason, which is
    // exactly what the 13-input case above proves the pipeline surfaces.
    const refused: PlanarRegionsWire | null = await readPlanarRegions(
      h.host,
      ids,
    );
    expect(refused).not.toBeNull();
    expect(refused!.found).toBe(false);
    expect(refused!.faces).toEqual([]);
    expect(refused!.reason).toContain("at most 12");
  });
});

// =====================================================================
// GAPS + EDGES — the two catalog halves that are NOT built.

describe("draw conformance — LIVE PAINT v0 (gaps and edges are NOT built)", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  it("GAPS: two open paths that ALMOST enclose a square do not bound it", async () => {
    await h.load(F4_OVERLAP.bytes());
    // Two open polylines tracing a 200 × 200 box with a 10 pt gap at the
    // top-left corner. Illustrator's Live Paint fills that box with a
    // gap tolerance; here there is no tolerance to set, so it is not a
    // face at all — and the caller is told rather than shown an empty
    // bucket.
    const leg = (points: [number, number][]) =>
      insertPathMutationFor(
        F4_OVERLAP.pageId,
        points.map((p) => ({ anchor: p, left: p, right: p })),
        true,
      );
    const before = idsOf(await leaves(h));
    await h.host.document.mutate({
      op: "batch",
      args: {
        ops: [
          leg([
            [100, 100],
            [300, 100],
            [300, 300],
          ]),
          leg([
            [300, 300],
            [100, 300],
            [100, 110],
          ]),
        ],
      },
    });
    const minted = (await leaves(h)).filter(
      (e) => !before.includes(String(e.id)),
    );
    expect(minted).toHaveLength(2);

    const result = await readPlanarRegions(h.host, minted);
    expect(result).not.toBeNull();
    expect(result!.found).toBe(true);
    // The 200 × 200 box would be 40,000 pt². Nothing that big comes
    // back: each OPEN subpath is implicitly CLOSED on itself by the
    // kernel's path conversion (a straight chord from its last anchor to
    // its first), which is a DIFFERENT arrangement — two triangles — and
    // not gap bridging.
    const areas = result!.faces.map((f) => f.area);
    expect(areas.length).toBeGreaterThan(0);
    expect(Math.max(...areas)).toBeLessThan(39500);
    expect(areas.reduce((n, a) => n + a, 0)).toBeLessThan(39500);
  });

  it("GAPS: an OPEN member contributes its implicit closure, with real area", async () => {
    await h.load(F6_RING_PAIR.bytes());
    const outer = { kind: "polygon", id: F6_RING_PAIR.ids.polygon! } as ElementId;
    const open = { kind: "polygon", id: F6_RING_PAIR.openId } as ElementId;
    const result = await readPlanarRegions(h.host, [outer, open]);
    expect(result!.found).toBe(true);
    // The open 3-anchor path is DISJOINT from the outer quad, so it can
    // only contribute a face by being closed — which it is. Its face is
    // the triangle (500,100)-(600,200)-(500,300): 10,000 pt².
    const areas = result!.faces.map((f) => Math.round(f.area)).sort((a, b) => a - b);
    expect(areas).toContain(10000);
  });

  it("EDGES: the read door carries face outlines and NO edge id at all", async () => {
    await h.load(F4_OVERLAP.bytes());
    const result = await readPlanarRegions(h.host, [B, A]);
    expect(result!.found).toBe(true);
    const face = result!.faces.find((f) => f.id === OVERLAP)!;
    // The entire per-face vocabulary — there is nothing edge-shaped to
    // address, which is why "or stroke edges" is named as unbuilt rather
    // than approximated by stroking a face outline.
    expect(Object.keys(face).sort()).toEqual([
      "anchors",
      "area",
      "id",
      "inside",
      "signature",
      "subpathStarts",
    ]);
    // A face's outline is a closed loop through SEVERAL members (four
    // corners of the overlap, two from each square) — not one edge.
    expect(face.anchors).toHaveLength(4);
    expect(face.signature).toEqual([0, 1]);
  });

  it("the point query answers the same face id the enumeration does", async () => {
    await h.load(F4_OVERLAP.bytes());
    const group: LivePaintRecipe = {
      id: "lp-x",
      name: "probe",
      inputs: [
        { kind: "polygon", id: "ub" },
        { kind: "polygon", id: "ua" },
      ],
      faces: [],
    };
    expect(livePaintInputs(group)).toEqual([B, A]);
    expect(await livePaintFaceAt(h.host, group, [250, 250], "spec")).toBe(
      OVERLAP,
    );
    // Outside the union there is no face — the arrangement covers
    // exactly the union of its inputs.
    expect(await livePaintFaceAt(h.host, group, [20, 20], "spec")).toBeNull();
  });
});
