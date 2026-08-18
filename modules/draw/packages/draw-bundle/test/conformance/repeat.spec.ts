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

// REPEATS v1 conformance (§12.4) — through the REAL engine wasm the
// harness boots. What this pins, in order of how much it would hurt to
// get wrong:
//
//   (1) ONE UNDO STEP. This is the first feature in the repo that
//       builds in one, and the claim is only worth making if it is
//       measured: Make = 1, Update = 1, Expand = 1, Release = 1 — and
//       a CLIPPED build = 2, for a reason that is NOT the contract
//       skew. The C-15 rules the collapse rides on are re-measured
//       here (order, own-op, and the id positions `$h:` reaches).
//   (2) THE FOUR CLIPPING CONSEQUENCES, each asserted against the
//       engine rather than described: no group on a clipped repeat, a
//       clipped instance INVISIBLE to `document.tree()` while still
//       answering geometry + metadata, `deleteFrame` REFUSED on a
//       pasted-in child, and a deleted container ORPHANING its
//       children.
//   (3) EXPAND ≠ RELEASE. Expand keeps every instance as artwork;
//       Release removes them and keeps the source. Both directions
//       asserted on the same document.
//   (4) RFI C-23 — a placed instance is READABLE and a dropped one
//       would not have been; `fitToArtboard: false` still reaches the
//       off-page case on purpose, and the reads answer nothing there.
//   (5) The honest refusals: a text frame, the copy ceiling, no
//       selection, clipping without a container writer.
//   (6) The exact wire shapes, the recipe part, the links, the panel
//       wording and the registration surface (including the tool that
//       deliberately carries NO shortcut).

import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";

import type {
  CanvasPointerEvent,
  CommandContribution,
  ElementId,
  Mutation,
  MutationInput,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  createRepeatHandler,
  applyExpandRepeat,
  applyMakeRepeat,
  applyReleaseRepeat,
  applySelectRepeatInstances,
  applyUpdateRepeat,
  bindCreatedMutationFor,
  findRepeatRecord,
  handleRef,
  mintRepeatId,
  mirrorDefaultOffset,
  parseRepeatLibrary,
  pasteIntoMutationFor,
  radialCenterOfDraft,
  readRepeatLibrary,
  releaseFromMutationFor,
  removeRepeatRecordFrom,
  repeatBatchFor,
  repeatBoundsOf,
  repeatClipBatchFor,
  repeatClipOf,
  repeatCopiesFor,
  repeatExpandBatchFor,
  repeatGenerationOf,
  repeatGroupOf,
  repeatHandle,
  repeatInstanceOf,
  repeatLinks,
  repeatPageRect,
  repeatParamsFrom,
  repeatPlacementsFor,
  repeatPlanFor,
  repeatReleaseBatchFor,
  repeatRowLabel,
  repeatSourceOf,
  resolveRepeat,
  serializeRepeatLibrary,
  supportsBindCreated,
  supportsPasteInto,
  upsertRepeatRecord,
  withRepeatKey,
  writeRepeatLibrary,
  EXPAND_REPEAT_COMMAND_ID,
  MAKE_GRID_REPEAT_COMMAND_ID,
  MAKE_MIRROR_REPEAT_COMMAND_ID,
  MAKE_RADIAL_REPEAT_COMMAND_ID,
  REPEAT_CLIP_HANDLE,
  REPEAT_CLIP_NOTE,
  REPEAT_COMMAND_IDS,
  REPEAT_DEFAULTS,
  REPEAT_FEATURE,
  REPEAT_KINDS,
  REPEAT_LIBRARY_VERSION,
  REPEAT_LIVE_NOTE,
  REPEAT_MAX_INSTANCES,
  REPEAT_PANEL_ID,
  REPEAT_PANEL_NOTE,
  REPEAT_PART,
  REPEAT_TOOL_IDS,
  RELEASE_REPEAT_COMMAND_ID,
  SELECT_REPEAT_INSTANCES_COMMAND_ID,
  UPDATE_REPEAT_COMMAND_ID,
  type RepeatParams,
  type RepeatPlan,
} from "../../src";
import { F6_RING_PAIR } from "../fixtures/corpus";
import { openHost } from "./host";

const poly = (id: string): ElementId => ({ kind: "polygon", id }) as ElementId;

const INNER = poly("uinner");
const OUTER = poly("uouter");
const PRISTINE = ["uinner", "uopen", "uouter"];

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

/** Leaf ids in TREE order. NOTE what this does NOT see: a pasted-in
 *  child. That absence is one of the assertions below, not an oversight. */
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

/** The one group node in the tree (or null) plus its member ids. */
async function groupShape(
  h: HeadlessHost,
): Promise<{ id: string; members: string[] } | null> {
  let found: { id: string; members: string[] } | null = null;
  const walk = (
    nodes: { id?: { kind?: string; id?: unknown }; children?: unknown[] }[],
  ) => {
    for (const node of nodes) {
      if (node.id?.kind === "group" && typeof node.id.id === "string") {
        found = {
          id: node.id.id,
          members: ((node.children ?? []) as { id?: { id?: unknown } }[])
            .map((c) => c.id?.id)
            .filter((id): id is string => typeof id === "string"),
        };
        return;
      }
      if (node.children) walk(node.children as never);
    }
  };
  walk((await h.host.document.tree()) as never);
  return found;
}

async function undoTo(h: HeadlessHost, steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) await h.host.document.undo();
}

const anchorAt = (p: [number, number]) => ({
  anchor: [p[0], p[1]] as [number, number],
  left: [p[0], p[1]] as [number, number],
  right: [p[0], p[1]] as [number, number],
});

const SQUARE_TABLE = {
  anchors: [
    anchorAt([0, 0]),
    anchorAt([100, 0]),
    anchorAt([100, 100]),
    anchorAt([0, 100]),
  ],
  subpathStarts: [0],
  subpathOpen: [false],
};

/** A hand-built plan (one square source, one mirrored placement) — the
 *  pure wire builders are asserted against this, not against the engine. */
const SQUARE_PLAN: RepeatPlan = {
  pageId: "usp",
  repeat: "rep-1",
  params: { ...REPEAT_DEFAULTS, kind: "mirror", angleDeg: 90, offsetPt: 50 },
  bounds: [0, 0, 100, 100],
  sources: [
    {
      id: poly("us"),
      table: SQUARE_TABLE,
      paint: { fill: "Color/Black", stroke: null, weight: null },
    },
  ],
  placements: [{ index: 1, col: 1, row: 0, matrix: [1, 0, 0, 1, 200, 0] }],
  dropped: [],
  clipRect: null,
};

const opsOf = (m: MutationInput): MutationInput[] =>
  (m as { args: { ops: MutationInput[] } }).args.ops;

function pointer(
  pageId: string,
  point: [number, number],
  shift = false,
): CanvasPointerEvent {
  return {
    pageId,
    pagePoint: point,
    docPoint: point,
    modifiers: { shift, alt: false, cmd: false, ctrl: false },
    maxDelta: 0,
    button: 0,
    target: null,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    pointerType: "mouse",
  } as CanvasPointerEvent;
}

const settle = () => new Promise((r) => setTimeout(r, 40));

describe("draw conformance — REPEATS (radial / grid / mirror, §12.4)", () => {
  // ------------------------------------------------- pure: the model

  describe("the parameters", () => {
    it("repeatParamsFrom merges a loose payload over a base and clamps it", () => {
      expect(repeatParamsFrom(undefined)).toEqual(REPEAT_DEFAULTS);
      const p = repeatParamsFrom({
        kind: "grid",
        count: 2.6,
        columns: "nope",
        rows: 0,
        spacing: -8,
        sweepDeg: 5000,
        radiusPt: -40,
        flipRows: true,
        clip: true,
        offsetPt: null,
      });
      expect(p.kind).toBe("grid");
      expect(p.count).toBe(3); // rounded
      expect(p.columns).toBe(REPEAT_DEFAULTS.columns); // unparsable → base
      expect(p.rows).toBe(1); // floored at 1
      // A scalar spacing means both axes; NEGATIVE is kept — it is the
      // geometric overlap (the pattern-v1 convention).
      expect(p.spacing).toEqual([-8, -8]);
      expect(p.sweepDeg).toBe(360); // clamped
      expect(p.radiusPt).toBe(0); // clamped
      expect(p.flipRows).toBe(true);
      expect(p.clip).toBe(true);
      expect(p.offsetPt).toBeNull();
      // An unknown kind keeps the base's.
      expect(repeatParamsFrom({ kind: "spiral" }).kind).toBe(
        REPEAT_DEFAULTS.kind,
      );
      expect([...REPEAT_KINDS]).toEqual(["radial", "grid", "mirror"]);
    });

    it("repeatPlacementsFor routes the three kinds through ONE algebra", () => {
      const bounds = [0, 0, 100, 100] as const;
      const radial = repeatPlacementsFor(
        { ...REPEAT_DEFAULTS, kind: "radial", count: 5 },
        bounds,
      );
      expect(radial).toHaveLength(5);
      const grid = repeatPlacementsFor(
        { ...REPEAT_DEFAULTS, kind: "grid", columns: 4, rows: 2 },
        bounds,
      );
      expect(grid).toHaveLength(8);
      const mirror = repeatPlacementsFor(
        { ...REPEAT_DEFAULTS, kind: "mirror" },
        bounds,
      );
      expect(mirror).toHaveLength(2);
      // Index 0 is always the SOURCE with the identity — it is never
      // re-emitted, but it is counted the way the catalog counts.
      for (const list of [radial, grid, mirror]) {
        expect(list[0].matrix).toEqual([1, 0, 0, 1, 0, 0]);
        expect(list[0].index).toBe(0);
      }
    });

    it("the mirror's default offset puts the axis on the source's EDGE", () => {
      expect(mirrorDefaultOffset(90, [100, 60])).toBe(50);
      expect(mirrorDefaultOffset(0, [100, 60])).toBe(30);
      // …and the on-canvas guide derives the ring from the SAME
      // function the commit uses (no second copy of the algebra).
      const draft = { ...REPEAT_DEFAULTS, radiusPt: 120, startDeg: -90 };
      expect(radialCenterOfDraft(draft as RepeatParams, [250, 250])).toEqual([
        250, 370,
      ]);
    });
  });

  describe("the recipe part (the FIFTH in this repo)", () => {
    it("round-trips, and anything unreadable reads as an EMPTY library", () => {
      const lib = upsertRepeatRecord(
        { v: REPEAT_LIBRARY_VERSION, repeats: [] },
        {
          id: "rep-1",
          name: "Radial repeat 1",
          params: REPEAT_DEFAULTS,
          sources: [{ kind: "polygon", id: "uinner" }],
          instances: [{ kind: "polygon", id: "u9" }],
          clipFrame: { kind: "polygon", id: "u8" },
        },
      );
      const back = parseRepeatLibrary(serializeRepeatLibrary(lib));
      expect(back).toEqual(lib);
      expect(mintRepeatId(back)).toBe("rep-2");
      expect(findRepeatRecord(back, "rep-1")!.name).toBe("Radial repeat 1");
      expect(removeRepeatRecordFrom(back, "rep-1").repeats).toEqual([]);
      // Unreadable → empty, never a crash.
      expect(parseRepeatLibrary(null).repeats).toEqual([]);
      expect(
        parseRepeatLibrary(new TextEncoder().encode("{{")).repeats,
      ).toEqual([]);
      expect(
        parseRepeatLibrary(new TextEncoder().encode('{"v":99,"repeats":[{}]}'))
          .repeats,
      ).toEqual([]);
    });

    it("withRepeatKey drops ONLY this feature's key", () => {
      const env = {
        v: 1,
        data: {
          graphicStyle: { style: "gs-1" },
          repeatSource: { repeat: "rep-1", index: 0 },
        },
      };
      const out = withRepeatKey(env, "repeatSource", null)!;
      expect(out.data).toEqual({ graphicStyle: { style: "gs-1" } });
      // The last key going leaves NO envelope at all.
      expect(
        withRepeatKey(
          { v: 1, data: { repeatInstance: { repeat: "r", of: poly("a") } } },
          "repeatInstance",
          null,
        ),
      ).toBeNull();
      // Readers are tolerant of partial/foreign shapes.
      expect(repeatSourceOf(null)).toBeNull();
      expect(
        repeatInstanceOf({ v: 1, data: { repeatInstance: {} } }),
      ).toBeNull();
      expect(
        repeatClipOf({ v: 1, data: { repeatClip: { repeat: "r" } } }),
      ).toEqual({ repeat: "r" });
    });
  });

  // -------------------------------------------------- pure: the wire

  describe("the wire shapes", () => {
    it("the build batch binds EVERY insert and then addresses it by handle", () => {
      const ops = opsOf(
        repeatBatchFor({ plan: SQUARE_PLAN, sourceEnvelopes: [null] }),
      );
      // insert, bind, fill, stroke, stamp, source-link, group.
      expect(ops.map((o) => o.op)).toEqual([
        "insertPath",
        "bindCreated",
        "setElementProperty",
        "setElementProperty",
        "setPluginMetadata",
        "setPluginMetadata",
        "createGroup",
      ]);
      // RULE 1 — the bind comes AFTER its creating child.
      expect(ops[0].op).toBe("insertPath");
      expect(ops[1]).toEqual(bindCreatedMutationFor(repeatHandle(0, 0)));
      // RULE 2 — it is its OWN op: nothing is smuggled into the
      // insert's args.
      expect(JSON.stringify(ops[0])).not.toContain("bindCreated");
      expect(JSON.stringify(ops[0])).not.toContain("handle");
      // …and every later op names the minted id through `$h:`.
      const later = JSON.stringify(ops.slice(2));
      expect(later).toContain(`$h:${repeatHandle(0, 0)}`);
      expect(handleRef(repeatHandle(0, 0))).toEqual({
        kind: "polygon",
        id: "$h:ri0_0",
      });
      // The group holds the SOURCE and the instance.
      expect(ops[6]).toEqual({
        op: "createGroup",
        args: { memberIds: [poly("us"), handleRef("ri0_0")] },
      });
    });

    it("a CLIPPED plan mints the clip frame first, clears its stroke, and emits NO group", () => {
      const ops = opsOf(
        repeatBatchFor({
          plan: { ...SQUARE_PLAN, clipRect: [0, 0, 792, 612] },
          sourceEnvelopes: [null],
        }),
      );
      expect(ops[0].op).toBe("insertPath");
      expect(ops[1]).toEqual(bindCreatedMutationFor(REPEAT_CLIP_HANDLE));
      // An inserted path defaults to a 1 pt BLACK stroke (measured), so
      // a clip frame that did not clear it would paint its own outline.
      expect(ops[2]).toEqual({
        op: "setElementProperty",
        args: {
          elementId: handleRef(REPEAT_CLIP_HANDLE),
          path: "frameStrokeColor",
          value: { type: "colorRef", value: null },
        },
      });
      // NO createGroup anywhere: pasteInto refuses a grouped child.
      expect(ops.some((o) => o.op === "createGroup")).toBe(false);
      // …and NO pasteInto either — that rides its own batch, because it
      // is what hides the instances from the tree diff. (The cast is
      // the v59 seam's: the PUBLISHED contract's `Mutation` union has no
      // `pasteInto` arm, so `o.op` is not typed to reach it.)
      expect(ops.some((o) => (o.op as string) === "pasteInto")).toBe(false);
      const clipOps = opsOf(repeatClipBatchFor(poly("u1"), [poly("u2")]));
      expect(clipOps).toEqual([pasteIntoMutationFor(poly("u1"), poly("u2"))]);
    });

    it("the release batch dissolves, THEN releases, THEN deletes, THEN drops the container", () => {
      const ops = opsOf(
        repeatReleaseBatchFor({
          group: { kind: "group", id: "g1" } as ElementId,
          instances: [poly("u2"), poly("u3")],
          clipped: true,
          clipFrame: poly("u1"),
          sources: [{ id: INNER, envelope: null }],
        }),
      );
      expect(ops.map((o) => o.op)).toEqual([
        "dissolveGroup",
        "releaseFrom",
        "deleteFrame",
        "releaseFrom",
        "deleteFrame",
        "deleteFrame",
        "setPluginMetadata",
      ]);
      expect(ops[1]).toEqual(releaseFromMutationFor(poly("u2")));
      // The container goes LAST — deleting it first ORPHANS its
      // children (measured below).
      expect(ops[5]).toEqual({ op: "deleteFrame", args: { frameId: "u1" } });
      // UNCLIPPED: no releaseFrom at all.
      const plain = opsOf(
        repeatReleaseBatchFor({
          instances: [poly("u2")],
          clipped: false,
          sources: [],
        }),
      );
      expect(plain.map((o) => o.op)).toEqual(["deleteFrame"]);
    });

    it("expand only drops links — it touches no geometry", () => {
      const ops = opsOf(
        repeatExpandBatchFor([
          { id: INNER, envelope: null, key: "repeatSource" },
          { id: poly("u2"), envelope: null, key: "repeatInstance" },
        ]),
      );
      expect(ops.map((o) => o.op)).toEqual([
        "setPluginMetadata",
        "setPluginMetadata",
      ]);
    });

    it("a compound source re-merges through framePath IN THE SAME BATCH", () => {
      const ringPlan: RepeatPlan = {
        ...SQUARE_PLAN,
        sources: [
          {
            ...SQUARE_PLAN.sources[0],
            table: {
              anchors: [
                ...SQUARE_TABLE.anchors,
                anchorAt([20, 20]),
                anchorAt([80, 20]),
                anchorAt([80, 80]),
                anchorAt([20, 80]),
              ],
              subpathStarts: [0, 4],
              subpathOpen: [false, false],
            },
          },
        ],
      };
      expect(repeatCopiesFor(ringPlan)[0].contours).toBe(2);
      const ops = opsOf(
        repeatBatchFor({ plan: ringPlan, sourceEnvelopes: [null] }),
      );
      expect(ops.map((o) => o.op).slice(0, 6)).toEqual([
        "insertPath",
        "bindCreated",
        "insertPath",
        "bindCreated",
        "setElementProperty", // framePath — the compound re-merge
        "deleteFrame", // …and the absorbed contour, by HANDLE
      ]);
      expect(ops[5]).toEqual({
        op: "deleteFrame",
        args: { frameId: `$h:${repeatHandle(0, 1)}` },
      });
    });
  });

  // ------------------------------------------------ the real engine

  describe("against the booted engine", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F6_RING_PAIR.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    beforeEach(async () => {
      await h.host.selection.set([]);
      await writeRepeatLibrary(h.host, {
        v: REPEAT_LIBRARY_VERSION,
        repeats: [],
      });
    });

    it("the host wires the container-parts door this feature rides", () => {
      expect(h.host.supports(REPEAT_FEATURE)).toBe(true);
    });

    it("the engine speaks C-15 and B-18 — the two doors this row is built on", async () => {
      expect(await supportsBindCreated(h.host)).toBe(true);
      expect(await supportsPasteInto(h.host)).toBe(true);
    });

    it("C-15 RULE 1 — a bind BEFORE its creating child is refused BY NAME", async () => {
      const early = await h.host.document.mutate({
        op: "batch",
        args: {
          ops: [
            bindCreatedMutationFor("h1"),
            {
              op: "insertPath",
              args: {
                pageId: F6_RING_PAIR.pageId,
                anchors: [
                  anchorAt([10, 10]),
                  anchorAt([20, 10]),
                  anchorAt([20, 20]),
                ],
                open: false,
              },
            },
          ],
        },
      } as Mutation);
      expect(early.applied).toBe(false);
      expect(JSON.stringify(early)).toContain("has nothing to name");
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("C-15 RULE 2 — a handle inside the creating op's own args is SILENTLY IGNORED", async () => {
      const smuggled = await h.host.document.mutate({
        op: "batch",
        args: {
          ops: [
            {
              op: "insertPath",
              args: {
                pageId: F6_RING_PAIR.pageId,
                anchors: [
                  anchorAt([10, 10]),
                  anchorAt([20, 10]),
                  anchorAt([20, 20]),
                ],
                open: false,
                bindCreated: "h1",
              },
            },
            {
              op: "setElementProperty",
              args: {
                elementId: poly("$h:h1"),
                path: "frameFillColor",
                value: { type: "colorRef", value: "Color/Black" },
              },
            },
          ],
        },
      } as unknown as Mutation);
      // The insert is accepted (the extra arg is ignored) and the later
      // reference then fails — which is exactly the confusing shape the
      // rule exists to prevent.
      expect(smuggled.applied).toBe(false);
      expect(JSON.stringify(smuggled)).toContain("node not found");
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("MAKE RADIAL = ONE batch ⇒ ONE undo step (the whole point of this row)", async () => {
      await h.host.selection.set([INNER]);
      const made = await applyMakeRepeat(h.host, "radial", {
        count: 4,
        radiusPt: 120,
        startDeg: -90,
      });
      expect(made).toHaveLength(3);
      const withInstances = await leafIds(h);
      expect(withInstances).toHaveLength(PRISTINE.length + 3);

      // The instances are REAL, PAINTED and LINKED artwork.
      for (const id of made) {
        const geo = await h.host.document.elementGeometry([id]);
        expect(geo).toHaveLength(1);
        const ref = repeatInstanceOf(await h.host.document.getMetadata(id));
        expect(ref?.repeat).toBe("rep-1");
        expect(ref?.of.id).toBe("uinner");
      }
      // The source carries its own link, and the whole thing is ONE
      // group (an UNCLIPPED repeat gets one).
      expect(
        repeatSourceOf(await h.host.document.getMetadata(INNER))?.repeat,
      ).toBe("rep-1");
      const group = await groupShape(h);
      expect(group?.members).toHaveLength(4);

      // …AND ONE undo puts the document back exactly as it was. This is
      // the assertion the whole `bindCreated` seam exists for; every
      // other bake in this repo needs TWO here.
      await h.host.document.undo();
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
      expect(await groupShape(h)).toBeNull();
      expect(
        repeatSourceOf(await h.host.document.getMetadata(INNER)),
      ).toBeNull();
    });

    it("MAKE GRID and MAKE MIRROR are one undo step too, and place what they say", async () => {
      await h.host.selection.set([INNER]);
      const grid = await applyMakeRepeat(h.host, "grid", {
        columns: 2,
        rows: 2,
        spacing: [10, 10],
      });
      expect(grid).toHaveLength(3); // 2 × 2 minus the source cell
      await h.host.document.undo();
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);

      await writeRepeatLibrary(h.host, {
        v: REPEAT_LIBRARY_VERSION,
        repeats: [],
      });
      await h.host.selection.set([INNER]);
      const mirror = await applyMakeRepeat(h.host, "mirror", { angleDeg: 90 });
      expect(mirror).toHaveLength(1);
      // The image lands beside the source: uinner is x 200..300, so a
      // vertical axis on its right edge puts the copy at x 300..400.
      const geo = await h.host.document.elementGeometry(mirror);
      expect(geo[0].bounds[1]).toBeCloseTo(300, 6);
      expect(geo[0].bounds[3]).toBeCloseTo(400, 6);
      await h.host.document.undo();
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("UPDATE = ONE batch ⇒ ONE undo step, and the instances get NEW ids", async () => {
      await h.host.selection.set([INNER]);
      const first = await applyMakeRepeat(h.host, "radial", {
        count: 3,
        radiusPt: 120,
        startDeg: -90,
      });
      expect(first).toHaveLength(2);
      const after = await applyUpdateRepeat(h.host, { count: 5 });
      expect(after).toHaveLength(4);
      // NEW ids — another plugin's metadata on an instance does not
      // survive an update, and the module says so.
      expect(after.map((i) => i.id)).not.toContain(first[0].id);
      // The old ones are GONE, not orphaned.
      expect(await leafIds(h)).not.toContain(first[0].id);
      expect(await h.host.document.elementGeometry([first[0]])).toHaveLength(0);
      // One undo unwinds the whole re-plan back to the FIRST generation.
      await h.host.document.undo();
      const back = await leafIds(h);
      expect(back).toContain(first[0].id);
      expect(back).toHaveLength(PRISTINE.length + 2);
      await undoTo(h, 1);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("EXPAND keeps everything; RELEASE keeps only the source. Both = 1 undo step", async () => {
      // EXPAND
      await h.host.selection.set([INNER]);
      const made = await applyMakeRepeat(h.host, "radial", {
        count: 3,
        radiusPt: 120,
        startDeg: -90,
      });
      expect(await applyExpandRepeat(h.host, {})).toBe(true);
      // Every piece of artwork is still there…
      expect(await leafIds(h)).toHaveLength(PRISTINE.length + made.length);
      // …and nothing tracks it.
      expect(
        repeatSourceOf(await h.host.document.getMetadata(INNER)),
      ).toBeNull();
      expect(
        repeatInstanceOf(await h.host.document.getMetadata(made[0])),
      ).toBeNull();
      expect((await readRepeatLibrary(h.host)).repeats).toEqual([]);
      await undoTo(h, 2); // the expand, then the make
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);

      // RELEASE
      await writeRepeatLibrary(h.host, {
        v: REPEAT_LIBRARY_VERSION,
        repeats: [],
      });
      await h.host.selection.set([INNER]);
      const again = await applyMakeRepeat(h.host, "radial", {
        count: 3,
        radiusPt: 120,
        startDeg: -90,
      });
      expect(await applyReleaseRepeat(h.host, {})).toBe(again.length);
      // The instances are gone; the SOURCE is untouched and unlinked.
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
      expect(
        repeatSourceOf(await h.host.document.getMetadata(INNER)),
      ).toBeNull();
      expect((await readRepeatLibrary(h.host)).repeats).toEqual([]);
      await undoTo(h, 2); // the release, then the make
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("SELECT INSTANCES puts them on the selection and mutates nothing", async () => {
      await h.host.selection.set([INNER]);
      const made = await applyMakeRepeat(h.host, "radial", {
        count: 3,
        radiusPt: 120,
        startDeg: -90,
      });
      const picked = await applySelectRepeatInstances(h.host, {});
      expect(picked.map((i) => i.id).sort()).toEqual(
        made.map((i) => i.id).sort(),
      );
      const withSources = await applySelectRepeatInstances(h.host, {
        includeSources: true,
      });
      expect(withSources).toHaveLength(made.length + 1);
      await undoTo(h, 1);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    // ------------------------------------------------------ clipping

    it("CLIPPING — 2 undo steps, NO group, and the instances leave the scene tree", async () => {
      await h.host.selection.set([INNER]);
      const made = await applyMakeRepeat(h.host, "radial", {
        count: 4,
        radiusPt: 120,
        startDeg: -90,
        clip: true,
      });
      expect(made).toHaveLength(3);

      // CONSEQUENCE 1 — no group. `pasteInto` refuses a grouped child,
      // so clip and group are mutually exclusive.
      expect(await groupShape(h)).toBeNull();

      // CONSEQUENCE 2 — the instances are INVISIBLE to the tree, and
      // still answer geometry AND metadata by id.
      const visible = await leafIds(h);
      for (const id of made) expect(visible).not.toContain(id.id);
      for (const id of made) {
        expect(await h.host.document.elementGeometry([id])).toHaveLength(1);
        expect(
          repeatInstanceOf(await h.host.document.getMetadata(id))?.repeat,
        ).toBe("rep-1");
      }
      // The clip FRAME is in the tree (only its children are not) and
      // carries its own link.
      const record = findRepeatRecord(
        await readRepeatLibrary(h.host),
        "rep-1",
      )!;
      expect(record.clipFrame).not.toBeNull();
      expect(visible).toContain(record.clipFrame!.id);
      expect(
        repeatClipOf(
          await h.host.document.getMetadata(poly(record.clipFrame!.id)),
        )?.repeat,
      ).toBe("rep-1");
      // …and the recipe is the ONLY index of the hidden instances,
      // which is why `repeatLinks` reads it back.
      expect(record.instances).toHaveLength(3);
      const links = await repeatLinks(h.host, "rep-1");
      expect(links.instances.map((i) => i.id.id).sort()).toEqual(
        made.map((i) => i.id).sort(),
      );

      // CONSEQUENCE 3 — `deleteFrame` REFUSES a pasted-in child, with
      // the engine's own sentence.
      const refused = await h.host.document.mutate({
        op: "deleteFrame",
        args: { frameId: String(made[0].id) },
      } as Mutation);
      expect(refused.applied).toBe(false);
      expect(JSON.stringify(refused)).toContain(
        "pasted into a container — release it before removing",
      );

      // TWO undo steps — the build, then the clip. Measured, not
      // claimed: the FIRST undo un-clips (the instances come back into
      // the tree), the SECOND removes them.
      await h.host.document.undo();
      const unclipped = await leafIds(h);
      for (const id of made) expect(unclipped).toContain(id.id);
      await h.host.document.undo();
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("UPDATE crosses the clip boundary BOTH ways, cleaning up the old generation", async () => {
      // unclipped → clipped
      await h.host.selection.set([INNER]);
      const plain = await applyMakeRepeat(h.host, "radial", {
        count: 3,
        radiusPt: 120,
        startDeg: -90,
      });
      expect(await groupShape(h)).not.toBeNull();
      const clipped = await applyUpdateRepeat(h.host, { clip: true });
      expect(clipped).toHaveLength(2);
      // The old group is gone with its members; the new instances are
      // nested (invisible to the tree) and the old ids answer nothing.
      expect(await groupShape(h)).toBeNull();
      for (const id of plain) {
        expect(await h.host.document.elementGeometry([id])).toHaveLength(0);
      }
      const visible = await leafIds(h);
      for (const id of clipped) expect(visible).not.toContain(id.id);

      // clipped → unclipped: the old nested instances need `releaseFrom`
      // before `deleteFrame`, in the SAME batch as the new inserts.
      const back = await applyUpdateRepeat(h.host, { clip: false });
      expect(back).toHaveLength(2);
      const now = await leafIds(h);
      for (const id of back) expect(now).toContain(id.id);
      for (const id of clipped) {
        expect(await h.host.document.elementGeometry([id])).toHaveLength(0);
      }
      // No orphan clip frame is left behind.
      expect(
        findRepeatRecord(await readRepeatLibrary(h.host), "rep-1")!.clipFrame,
      ).toBeNull();
      expect(now).toHaveLength(PRISTINE.length + 2);
      expect(await groupShape(h)).not.toBeNull();

      await undoTo(h, 4); // back, clip(2), build
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("CONSEQUENCE 4 — deleting a container ORPHANS its children, so Release drops it LAST", async () => {
      await h.host.selection.set([INNER]);
      await applyMakeRepeat(h.host, "radial", {
        count: 3,
        radiusPt: 120,
        startDeg: -90,
        clip: true,
      });
      const record = findRepeatRecord(
        await readRepeatLibrary(h.host),
        "rep-1",
      )!;
      const child = poly(record.instances[0].id);
      // The hazard, demonstrated: drop the container on its own…
      const dropped = await h.host.document.mutate({
        op: "deleteFrame",
        args: { frameId: record.clipFrame!.id },
      } as Mutation);
      expect(dropped.applied).toBe(true);
      // …and the child is in NO tree while still answering geometry.
      expect(await leafIds(h)).not.toContain(child.id);
      expect(await h.host.document.elementGeometry([child])).toHaveLength(1);
      await undoTo(h, 3); // the stray delete, the clip, the build
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("RELEASING a clipped repeat removes the instances AND the clip frame, in one step", async () => {
      await h.host.selection.set([INNER]);
      const made = await applyMakeRepeat(h.host, "radial", {
        count: 4,
        radiusPt: 120,
        startDeg: -90,
        clip: true,
      });
      const generation = await repeatGenerationOf(h.host, "rep-1");
      expect(generation.clipped).toBe(true);
      expect(generation.instances).toHaveLength(3);
      expect(await applyReleaseRepeat(h.host, {})).toBe(3);
      // Nothing is left behind — not the instances, not the frame, and
      // no orphan (the geometry door is the check that would catch one).
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
      for (const id of made) {
        expect(await h.host.document.elementGeometry([id])).toHaveLength(0);
      }
      await undoTo(h, 3); // release, clip, build
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("EXPANDING a clipped repeat keeps the nesting — the nesting IS the clip", async () => {
      await h.host.selection.set([INNER]);
      const made = await applyMakeRepeat(h.host, "radial", {
        count: 3,
        radiusPt: 120,
        startDeg: -90,
        clip: true,
      });
      expect(await applyExpandRepeat(h.host, {})).toBe(true);
      // Still nested (still invisible to the tree, still real)…
      expect(await leafIds(h)).not.toContain(made[0].id);
      expect(await h.host.document.elementGeometry([made[0]])).toHaveLength(1);
      // …and no longer tracked.
      expect(
        repeatInstanceOf(await h.host.document.getMetadata(made[0])),
      ).toBeNull();
      await undoTo(h, 3); // expand, clip, build
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    // ---------------------------------------------- RFI C-23 + refusals

    it("RFI C-23 CLOSED — a fitted repeat is READABLE, and so is an off-page one: fitToArtboard:false now yields PAGELESS tiles, not unreadable ones", async () => {
      const page = await repeatPageRect(h.host, F6_RING_PAIR.pageId);
      expect(page).toEqual({ pageId: "usp", width: 612, height: 792 });

      // A radius that throws SOME instances off the page: fitted, those
      // are dropped and every placed one answers. (The fit tests the
      // ROTATED hull, not the source box — a turned instance is wider
      // than the artwork that made it.)
      await h.host.selection.set([INNER]);
      const fitted = await applyMakeRepeat(h.host, "radial", {
        count: 6,
        radiusPt: 300,
        startDeg: -90,
        fitToArtboard: true,
      });
      expect(fitted).toHaveLength(2);
      for (const id of fitted) {
        expect(await h.host.document.elementGeometry([id])).toHaveLength(1);
        expect(await h.host.document.pathAnchors(id)).not.toBeNull();
      }
      await undoTo(h, 1);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);

      // …and with the fit OFF, the off-page instances ARE created and
      // answer NOTHING. That is the residual, still pinned on purpose.
      await writeRepeatLibrary(h.host, {
        v: REPEAT_LIBRARY_VERSION,
        repeats: [],
      });
      await h.host.selection.set([INNER]);
      const loose = await applyMakeRepeat(h.host, "radial", {
        count: 6,
        radiusPt: 600,
        startDeg: -90,
        fitToArtboard: false,
      });
      expect(loose).toHaveLength(5);
      // C-23 CLOSED (core 6df4851, canvas-wasm 0.61.1). This block used
      // to collect tiles whose geometry answered NOTHING and assert
      // that at least one existed — the artboard-fit feature was built
      // precisely to avoid making them. Core no longer drops an
      // off-page element: EVERY tile answers, and the ones past the
      // page edge report `pageId: null`.
      //
      // The fit option keeps its point: fitted tiles are all page-owned
      // (asserted above), loose ones are not. What changed is that a
      // loose tile is now MEASURABLE, which is what made it worth
      // fixing — art on the pasteboard was created, grouped, and then
      // impossible to read back.
      // Typed as the ELEMENT ID it is — an `ElementId` is a tagged
      // object, not a string, and casting it to one only to count the
      // entries was a cast that bought nothing.
      const pageless: typeof loose = [];
      for (const id of loose) {
        const g = await h.host.document.elementGeometry([id]);
        expect(g, "every tile answers now").toHaveLength(1);
        expect(await h.host.document.pathAnchors(id)).not.toBeNull();
        if ((g[0].pageId ?? null) === null) pageless.push(id);
      }
      expect(
        pageless.length,
        "fitToArtboard:false still reaches the off-page case",
      ).toBeGreaterThan(0);
      await undoTo(h, 1);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("refuses a text frame, an oversized repeat, and an empty selection", async () => {
      // A text frame cannot be repeated: no wire op copies a story and
      // `insertPath` mints Polygons.
      expect(
        await repeatPlanFor(h.host, {
          repeat: "rep-1",
          params: REPEAT_DEFAULTS,
          ids: [{ kind: "textFrame", id: "utext" } as ElementId],
          label: "test",
        }),
      ).toBeNull();

      // The ceiling REFUSES rather than truncating.
      await h.host.selection.set([INNER]);
      expect(
        await applyMakeRepeat(h.host, "grid", {
          columns: 40,
          rows: 40,
          fitToArtboard: false,
        }),
      ).toEqual([]);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
      expect(REPEAT_MAX_INSTANCES).toBe(200);

      // Nothing selected is a no-op, not a throw.
      await h.host.selection.set([]);
      expect(await applyMakeRepeat(h.host, "radial", {})).toEqual([]);
      expect(await applyUpdateRepeat(h.host, {})).toEqual([]);
      expect(await applyExpandRepeat(h.host, {})).toBe(false);
      expect(await applyReleaseRepeat(h.host, {})).toBe(0);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("a COMPOUND source stays compound in every instance", async () => {
      // Make uouter+uinner a compound ring first, then repeat it.
      const { applyMakeCompoundPath } = await import("../../src");
      await h.host.selection.set([OUTER, INNER]);
      await applyMakeCompoundPath(h.host);
      const ring = poly("uouter");
      expect((await h.host.document.pathAnchors(ring))!.subpathStarts).toEqual([
        0, 4,
      ]);
      await h.host.selection.set([ring]);
      // A 2 × 1 grid with a NEGATIVE spacing: the ring is 300 pt wide,
      // so an overlapping step keeps the copy on the 612 pt page (a
      // mirror of it would land at x 400..700 and the artboard fit would
      // drop it — which is the C-23 rule doing its job, not a bug).
      const made = await applyMakeRepeat(h.host, "grid", {
        columns: 2,
        rows: 1,
        spacing: [-250, 0],
      });
      expect(made).toHaveLength(1);
      const copy = await h.host.document.pathAnchors(made[0]);
      expect(copy!.subpathStarts).toEqual([0, 4]);
      expect(copy!.anchors).toHaveLength(8);
      await undoTo(h, 2); // the repeat, then the compound
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("resolveRepeat / repeatBoundsOf / repeatGroupOf read what the commands need", async () => {
      expect(await repeatBoundsOf(h.host, [INNER])).toEqual([
        200, 200, 300, 300,
      ]);
      expect(await resolveRepeat(h.host, "rep-9")).toBe("rep-9");
      expect(await resolveRepeat(h.host, undefined)).toBeNull();
      await h.host.selection.set([INNER]);
      const made = await applyMakeRepeat(h.host, "radial", {
        count: 3,
        radiusPt: 120,
        startDeg: -90,
      });
      // …the selection's own link now answers.
      await h.host.selection.set([made[0]]);
      expect(await resolveRepeat(h.host, undefined)).toBe("rep-1");
      expect((await repeatGroupOf(h.host, made[0]))?.kind).toBe("group");
      await undoTo(h, 1);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("the recipe travels in the `.paged` container part", async () => {
      await h.host.selection.set([INNER]);
      await applyMakeRepeat(h.host, "grid", { columns: 2, rows: 1 });
      const bytes = await h.host.parts.read(REPEAT_PART);
      expect(bytes).not.toBeNull();
      const library = parseRepeatLibrary(bytes);
      expect(library.repeats).toHaveLength(1);
      expect(library.repeats[0].params.kind).toBe("grid");
      expect(library.repeats[0].sources).toEqual([
        { kind: "polygon", id: "uinner" },
      ]);
      expect(library.repeats[0].instances).toHaveLength(1);
      // The recipe is a CONTAINER write, not an engine mutation — so
      // undoing the build leaves it behind, and every reader tolerates
      // the dangling ids.
      await undoTo(h, 1);
      expect((await readRepeatLibrary(h.host)).repeats).toHaveLength(1);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
      expect((await repeatLinks(h.host, "rep-1")).instances).toEqual([]);
    });

    // ------------------------------------------- the on-canvas control

    it("the TOOL steers the selected repeat and commits ONCE, on release", async () => {
      await h.host.selection.set([INNER]);
      const first = await applyMakeRepeat(h.host, "radial", {
        count: 4,
        radiusPt: 120,
        startDeg: -90,
      });
      expect(first).toHaveLength(3);
      const handler = createRepeatHandler(h.host);
      handler.onActivate?.(undefined as never);
      await h.host.selection.set([first[0]]);

      // Press + drag: the pointer places the ring CENTRE. Nothing is
      // committed yet — the drag draws a GUIDE, one polyline.
      handler.onPointerDown?.(pointer(F6_RING_PAIR.pageId, [250, 400]));
      await settle();
      handler.onPointerMove?.(pointer(F6_RING_PAIR.pageId, [250, 330]));
      const preview = h.lastToolPreview() as unknown as {
        pageId: string;
        points: [number, number][];
      } | null;
      expect(preview).not.toBeNull();
      expect(preview!.pageId).toBe(F6_RING_PAIR.pageId);
      // The spoke's first point IS the dragged ring centre, and every
      // ring sample sits one radius from it.
      expect(preview!.points[0]).toEqual([250, 330]);
      expect(preview!.points.length).toBeGreaterThan(10);
      // …and the DOCUMENT is untouched: no per-move mutation.
      const midway = await leafIds(h);
      expect(midway).toContain(first[0].id);

      handler.onPointerUp?.(pointer(F6_RING_PAIR.pageId, [250, 330]));
      await settle();
      // ONE update ran: the instances were rebuilt with new ids at the
      // steered radius (80 pt from the source centre at y 250).
      const after = await repeatLinks(h.host, "rep-1");
      expect(after.instances).toHaveLength(3);
      expect(after.instances.map((i) => String(i.id.id))).not.toContain(
        String(first[0].id),
      );
      const saved = findRepeatRecord(await readRepeatLibrary(h.host), "rep-1")!;
      expect(saved.params.radiusPt).toBeCloseTo(80, 6);
      // The overlay is cleared on release.
      expect(h.lastToolPreview()).toBeNull();
      handler.onDeactivate?.("switch");
      await undoTo(h, 2); // the tool's update, then the build
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("the TOOL is a no-op with no repeat selected — it never MAKES one", async () => {
      const handler = createRepeatHandler(h.host);
      handler.onActivate?.(undefined as never);
      await h.host.selection.set([INNER]);
      handler.onPointerDown?.(pointer(F6_RING_PAIR.pageId, [250, 400]));
      await settle();
      handler.onPointerMove?.(pointer(F6_RING_PAIR.pageId, [250, 330]));
      handler.onPointerUp?.(pointer(F6_RING_PAIR.pageId, [250, 330]));
      await settle();
      expect(h.lastToolPreview()).toBeNull();
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
      handler.onDeactivate?.("switch");
    });
  });

  // -------------------------------------------------- the honest degrade

  describe("a host with NO container writer", () => {
    let h: HeadlessHost;
    const warnings: string[] = [];

    beforeAll(async () => {
      h = await openHost();
      await h.load(F6_RING_PAIR.bytes());
      h.loadBundle(drawBundle);
      // Take the door away, the graphic-styles precedent.
      const supports = h.host.supports.bind(h.host);
      (h.host as { supports: (f: string) => boolean }).supports = (
        f: string,
      ) => (f === REPEAT_FEATURE ? false : supports(f));
      (h.host.log as { warn: (m: string) => void }).warn = (m: string) => {
        warnings.push(m);
      };
    });
    afterAll(() => h?.dispose());

    it("CLIPPING degrades OFF (with a warning) rather than hiding artwork forever", async () => {
      await h.host.selection.set([INNER]);
      const made = await applyMakeRepeat(h.host, "radial", {
        count: 3,
        radiusPt: 120,
        startDeg: -90,
        clip: true,
      });
      expect(made).toHaveLength(2);
      // Built UNCLIPPED: the instances are in the tree, and there is a
      // group (which a clipped repeat could not have had).
      const visible = await leafIds(h);
      for (const id of made) expect(visible).toContain(id.id);
      expect(await groupShape(h)).not.toBeNull();
      expect(
        warnings.some(
          (w) =>
            w.includes("clipping needs the `.paged` container writer") &&
            w.includes("INVISIBLE to document.tree()"),
        ),
      ).toBe(true);
      // …and the repeat is still expandable/releasable through its
      // LINKS — only the parameters were lost.
      expect((await readRepeatLibrary(h.host)).repeats).toEqual([]);
      expect(await applyReleaseRepeat(h.host, { repeatId: "rep-1" })).toBe(2);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });
  });

  // --------------------------------------------- the registration surface

  describe("the contributions", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F6_RING_PAIR.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    it("registers the seven commands, and every TITLE carries what the contract cannot", () => {
      expect(REPEAT_COMMAND_IDS).toEqual([
        MAKE_RADIAL_REPEAT_COMMAND_ID,
        MAKE_GRID_REPEAT_COMMAND_ID,
        MAKE_MIRROR_REPEAT_COMMAND_ID,
        UPDATE_REPEAT_COMMAND_ID,
        SELECT_REPEAT_INSTANCES_COMMAND_ID,
        EXPAND_REPEAT_COMMAND_ID,
        RELEASE_REPEAT_COMMAND_ID,
      ]);
      for (const id of [
        MAKE_RADIAL_REPEAT_COMMAND_ID,
        MAKE_GRID_REPEAT_COMMAND_ID,
        MAKE_MIRROR_REPEAT_COMMAND_ID,
      ]) {
        expect(commandFor(h, id).title).toContain(
          "artwork rebuilt by Update, not a live link",
        );
      }
      // EXPAND and RELEASE are DIFFERENT verbs, and the titles say which
      // is which — this is the pair pattern v1 spells the other way
      // round ("Release" there keeps the artwork).
      expect(commandFor(h, EXPAND_REPEAT_COMMAND_ID).title).toContain(
        "keep every instance as ordinary artwork",
      );
      expect(commandFor(h, RELEASE_REPEAT_COMMAND_ID).title).toContain(
        "remove the instances, keep the source",
      );
    });

    it("the honesty notes say the two things the feature NAME does not", () => {
      expect(REPEAT_LIVE_NOTE).toContain("NOT A LIVE LINKED OBJECT");
      expect(REPEAT_LIVE_NOTE).toContain("The engine has no repeat node");
      expect(REPEAT_LIVE_NOTE).toContain("Update does");
      expect(REPEAT_LIVE_NOTE).toContain("ONE polyline");
      expect(REPEAT_LIVE_NOTE).toContain("rebuilt once, on release");
      expect(REPEAT_CLIP_NOTE).toContain("NO GROUP");
      expect(REPEAT_CLIP_NOTE).toContain("INVISIBLE");
      expect(REPEAT_CLIP_NOTE).toContain("deleteFrame REFUSES");
      expect(REPEAT_CLIP_NOTE).toContain("ORPHANS");
      // The panel repeats both AND states the undo arithmetic.
      expect(REPEAT_PANEL_NOTE).toContain(REPEAT_LIVE_NOTE);
      expect(REPEAT_PANEL_NOTE).toContain(REPEAT_CLIP_NOTE);
      expect(REPEAT_PANEL_NOTE).toContain("ONE undo step");
      expect(REPEAT_PANEL_NOTE).toContain("CLIPPED one costs");
    });

    it("registers the Repeat Options panel", () => {
      const panel = h.contributions.find(
        (c) => c.kind === "panel" && c.id === REPEAT_PANEL_ID,
      );
      expect(panel).toBeTruthy();
      const value = panel!.value as { title: string; defaultDock: string };
      expect(value.title).toBe("Repeat options");
      expect(value.defaultDock).toBe("right");
      expect(
        repeatRowLabel(
          {
            id: "rep-1",
            name: "R",
            params: { ...REPEAT_DEFAULTS, kind: "grid", columns: 3, rows: 2 },
            sources: [],
            instances: [],
            clipFrame: null,
          },
          5,
        ),
      ).toBe("grid · 3 × 2 (5 instances placed)");
    });

    it("INV-REG-1: the Repeat tool ships with NO shortcut, and every other key stays unique", () => {
      const tools = h
        .toolsContributed()
        .filter((t) => (REPEAT_TOOL_IDS as readonly string[]).includes(t.id));
      expect(tools.map((t) => t.id)).toEqual([...REPEAT_TOOL_IDS]);
      // Deliberately keyless — see tools.ts. The three registers the
      // editor freed on 2026-08-03 (`shift+t`, `i`, `k`) are each the
      // CANONICAL key of a paged.draw tool currently on a substitute,
      // and `shift+z` reads as an undo variant everywhere.
      expect(tools[0]!.shortcut).toBeUndefined();
      const all = h
        .toolsContributed()
        .map((t) => t.shortcut)
        .filter((s): s is string => typeof s === "string");
      expect(new Set(all).size).toBe(all.length);
      expect(all).not.toContain("shift+t");
      expect(all).not.toContain("i");
      expect(all).not.toContain("k");
      expect(all).not.toContain("shift+z");
      // A REAL glyph token — an invented one renders the rail button
      // glyphless (the stroke panel's recorded lesson).
      expect(tools[0]!.icon).toBe("tool-rotate");
    });

    it("declares the recipe part type in the manifest", () => {
      const parts = drawBundle.manifest.contributes?.partTypes ?? [];
      expect(parts).toContainEqual({
        type: "repeatRecipe",
        role: "spec",
        format: "json",
        linkable: false,
      });
    });
  });
});
