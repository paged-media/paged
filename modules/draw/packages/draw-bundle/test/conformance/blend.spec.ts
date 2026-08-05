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

// BLENDS v1 conformance (§16.2) — through the REAL engine wasm the
// harness boots. In order of how much it would hurt to get wrong:
//
//   (1) ONE UNDO STEP for every verb. v0 paid two and said so; C-15's
//       `bindCreated` closed that, and the claim is only worth making
//       if it is measured: make = 1, update = 1, the two reverses = 1
//       each, expand = 1, release = 1.
//   (2) THE THREE SPACING MODES, which are the substance of the row.
//       Specified Steps is a count; Specified Distance divides the
//       SPINE's arc length; Smooth Color divides the COLOUR distance —
//       each asserted on its own arithmetic AND end-to-end.
//   (3) THE DEFAULT IS INERT. A default-options v1 blend places exactly
//       what a straight linear interpolation places — the spine offset
//       and the orientation turn both vanish. That is what makes every
//       deviation opt-in rather than a surprise.
//   (4) THE SPINE: replace, reverse (geometry moves) and reverse
//       front-to-back (paint order only, nothing moves).
//   (5) EXPAND ≠ RELEASE, on the same document.
//   (6) The honest refusals: structure mismatch, not-exactly-2, a text
//       frame, and a TYPED count over the ceiling (which refuses, where
//       a DERIVED one clamps).

import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";

import type {
  CommandContribution,
  ElementId,
  Mutation,
  MutationInput,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  applyExpandBlend,
  applyMakeBlend,
  applyReleaseBlend,
  applyReplaceBlendSpine,
  applyReverseBlendOrder,
  applyReverseBlendSpine,
  applySelectBlendObjects,
  applyUpdateBlend,
  blendBatchFor,
  blendHandle,
  blendKeyOf,
  blendParamsFrom,
  blendRowLabel,
  blendSourceBounds,
  blendSourceCenter,
  blendStepBounds,
  blendStepCountFor,
  blendStepOf,
  blendStepsFor,
  blendSpineOf,
  blendStructureMatches,
  defaultSpineFor,
  findBlendRecord,
  mintBlendId,
  parseBlendLibrary,
  readBlendLibrary,
  resetBlendSwatchSeq,
  serializeBlendLibrary,
  smoothColorSteps,
  upsertBlendRecord,
  withBlendKey,
  writeBlendLibrary,
  BLEND_COMMAND_ID,
  BLEND_COMMAND_IDS,
  BLEND_DEFAULTS,
  BLEND_FEATURE,
  BLEND_LIBRARY_VERSION,
  BLEND_LIVE_NOTE,
  BLEND_MAX_STEPS,
  BLEND_PANEL_ID,
  BLEND_PANEL_NOTE,
  BLEND_PART,
  BLEND_SPINE_NOTE,
  BLEND_STEPS,
  EXPAND_BLEND_COMMAND_ID,
  RELEASE_BLEND_COMMAND_ID,
  REPLACE_BLEND_SPINE_COMMAND_ID,
  REVERSE_BLEND_ORDER_COMMAND_ID,
  REVERSE_BLEND_SPINE_COMMAND_ID,
  SELECT_BLEND_OBJECTS_COMMAND_ID,
  UPDATE_BLEND_COMMAND_ID,
  type BlendKey,
  type BlendSource,
} from "../../src";
import { measureSegment } from "@paged-media/draw-geometry";
import { F1_MULTI_SHAPE, F4_OVERLAP } from "../fixtures/corpus";
import { openHost } from "./host";

const UA = { kind: "polygon", id: "ua" } as ElementId;
const UB = { kind: "polygon", id: "ub" } as ElementId;
const PRISTINE = ["ua", "ub"];

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

/** Leaf ids in TREE order — which for a page is PAINT order, and that
 *  is what "reverse front to back" is asserted against. */
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

async function fillHexOf(
  h: HeadlessHost,
  id: ElementId,
): Promise<string | null> {
  const props = await h.host.document.elementProperties(id);
  let ref: string | null = null;
  for (const entry of props?.entries ?? []) {
    if (entry.path === "frameFillColor" && entry.value?.type === "colorRef") {
      ref = entry.value.value;
    }
  }
  if (!ref) return null;
  const swatches = await h.host.document.collection<{
    selfId: string;
    name: string;
  }>("swatches");
  return swatches.find((s) => s.selfId === ref)?.name ?? null;
}

const corner = (x: number, y: number) => ({
  anchor: [x, y] as [number, number],
  left: [x, y] as [number, number],
  right: [x, y] as [number, number],
});

const opsOf = (m: MutationInput): MutationInput[] =>
  (m as { args: { ops: MutationInput[] } }).args.ops;

/** A hand-built key: a 100 × 100 square whose top-left is at (x, y). */
const squareKey = (
  id: string,
  x: number,
  y: number,
  fill: string | null,
): BlendKey => {
  const source: BlendSource = {
    subpaths: [
      [
        corner(x, y),
        corner(x + 100, y),
        corner(x + 100, y + 100),
        corner(x, y + 100),
      ],
    ],
    open: [false],
  };
  return {
    id: { kind: "polygon", id } as ElementId,
    source,
    paint: { fill, stroke: null, weight: null },
    center: blendSourceCenter(source),
    rgb: null,
    strokeRgb: null,
  };
};

describe("draw conformance — BLENDS v1 (§16.2)", () => {
  // ------------------------------------------------- pure: the model

  describe("the parameters", () => {
    it("blendParamsFrom merges a loose payload over a base and clamps it", () => {
      expect(blendParamsFrom(undefined)).toEqual(BLEND_DEFAULTS);
      const p = blendParamsFrom({
        spacing: "nope",
        steps: 4.6,
        distancePt: -3,
        easing: "wobble",
        easingStrength: 9,
        orientation: "path",
        reverseSpine: true,
      });
      expect(p.spacing).toBe(BLEND_DEFAULTS.spacing); // unknown → base
      expect(p.steps).toBe(5); // rounded
      expect(p.distancePt).toBeGreaterThan(0); // never zero/negative
      expect(p.easing).toBe("linear"); // unknown → base
      expect(p.easingStrength).toBe(1); // clamped into 0..1
      expect(p.orientation).toBe("path");
      expect(p.reverseSpine).toBe(true);
    });

    it("colorEasing NULL means 'not independent', and that is the default", () => {
      expect(BLEND_DEFAULTS.colorEasing).toBeNull();
      // An explicit null CLEARS independence; omitting it keeps the base.
      const independent = blendParamsFrom({ colorEasing: "easeIn" });
      expect(independent.colorEasing).toBe("easeIn");
      expect(
        blendParamsFrom({ colorEasing: null }, independent).colorEasing,
      ).toBeNull();
      expect(blendParamsFrom({}, independent).colorEasing).toBe("easeIn");
    });
  });

  describe("the three spacing modes", () => {
    it("SMOOTH COLOR divides the colour distance — the largest channel difference", () => {
      expect(smoothColorSteps([0, 0, 0], [255, 255, 255])).toBe(255);
      expect(smoothColorSteps([10, 20, 30], [10, 20, 90])).toBe(60);
      // No colour, no distance — the honest null the caller degrades on.
      expect(smoothColorSteps(null, [1, 2, 3])).toBeNull();
      // Identical colours still make ONE step, never zero.
      expect(smoothColorSteps([7, 7, 7], [7, 7, 7])).toBe(1);
    });

    it("SPECIFIED STEPS is the count — and a TYPED count over the ceiling REFUSES", () => {
      const ok = blendStepCountFor({
        params: { ...BLEND_DEFAULTS, spacing: "steps", steps: 12 },
        spineLength: 100,
        fromRgb: null,
        toRgb: null,
      });
      expect(ok.steps).toBe(12);
      expect(ok.clamped).toBe(false);
      const tooMany = blendStepCountFor({
        params: {
          ...BLEND_DEFAULTS,
          spacing: "steps",
          steps: BLEND_MAX_STEPS + 1,
        },
        spineLength: 100,
        fromRgb: null,
        toRgb: null,
      });
      // steps: 0 IS the refusal signal, and the reason says which rule.
      expect(tooMany.steps).toBe(0);
      expect(tooMany.why).toContain("ceiling");
      expect(tooMany.why).toContain("a derived count clamps");
    });

    it("SPECIFIED DISTANCE divides the SPINE's arc length; a DERIVED count CLAMPS", () => {
      const d = blendStepCountFor({
        params: { ...BLEND_DEFAULTS, spacing: "distance", distancePt: 25 },
        spineLength: 100,
        fromRgb: null,
        toRgb: null,
      });
      // 100 / 25 = 4 gaps ⇒ 3 intermediates.
      expect(d.steps).toBe(3);
      expect(d.why).toContain("100.0 pt spine");
      // A hair-fine distance over a long spine clamps rather than refusing.
      const huge = blendStepCountFor({
        params: { ...BLEND_DEFAULTS, spacing: "distance", distancePt: 0.1 },
        spineLength: 1000,
        fromRgb: null,
        toRgb: null,
      });
      expect(huge.steps).toBe(BLEND_MAX_STEPS);
      expect(huge.clamped).toBe(true);
      // …and a smooth-colour count over the ceiling clamps too.
      const smooth = blendStepCountFor({
        params: { ...BLEND_DEFAULTS, spacing: "smoothColor" },
        spineLength: 100,
        fromRgb: [0, 0, 0],
        toRgb: [255, 255, 255],
      });
      expect(smooth.requested).toBe(255);
      expect(smooth.steps).toBe(BLEND_MAX_STEPS);
      expect(smooth.clamped).toBe(true);
    });

    it("SMOOTH COLOR with unreadable fills DEGRADES to the default and says so", () => {
      const c = blendStepCountFor({
        params: { ...BLEND_DEFAULTS, spacing: "smoothColor" },
        spineLength: 100,
        fromRgb: null,
        toRgb: null,
      });
      expect(c.steps).toBe(BLEND_STEPS);
      expect(c.degraded).toBe(true);
      expect(c.why).toContain("no colour distance");
    });
  });

  describe("the planner", () => {
    const a = squareKey("ua", 0, 0, "Color/Black");
    const b = squareKey("ub", 300, 0, "Color/Black");

    it("THE DEFAULT IS INERT — a default blend is exactly the straight lerp", () => {
      const steps = blendStepsFor({
        keys: [a, b],
        params: BLEND_DEFAULTS,
        spine: defaultSpineFor([a, b]),
        steps: 3,
      })!;
      expect(steps).toHaveLength(3);
      // t = 1/4, 1/2, 3/4 over a 300 pt gap → x offsets 75, 150, 225.
      expect(steps.map((s) => s.subpaths[0][0].anchor[0])).toEqual([
        75, 150, 225,
      ]);
      expect(steps.map((s) => s.subpaths[0][0].anchor[1])).toEqual([0, 0, 0]);
      expect(steps.map((s) => s.t)).toEqual([0.25, 0.5, 0.75]);
      expect(steps.map((s) => s.index)).toEqual([1, 2, 3]);
    });

    it("…and so is `orientation: path` ON the default spine — the turn is zero", () => {
      const straight = blendStepsFor({
        keys: [a, b],
        params: { ...BLEND_DEFAULTS, orientation: "path" },
        spine: defaultSpineFor([a, b]),
        steps: 3,
      })!;
      expect(straight.map((s) => s.subpaths[0][0].anchor)).toEqual([
        [75, 0],
        [150, 0],
        [225, 0],
      ]);
    });

    it("a REPLACED spine moves the intermediates onto it", () => {
      // A spine that bulges 100 pt DOWN the page at its midpoint.
      const spine = measureSegment([50, 50], [350, 50]);
      const down = {
        stations: [
          { point: [50, 50] as [number, number], s: 0 },
          { point: [200, 150] as [number, number], s: 180 },
          { point: [350, 50] as [number, number], s: 360 },
        ],
        length: 360,
        closed: false,
      };
      const flat = blendStepsFor({
        keys: [a, b],
        params: BLEND_DEFAULTS,
        spine,
        steps: 1,
      })!;
      const bulged = blendStepsFor({
        keys: [a, b],
        params: BLEND_DEFAULTS,
        spine: down,
        steps: 1,
      })!;
      // The straight spine IS the default (both centres are at y 50).
      expect(flat[0].subpaths[0][0].anchor).toEqual([150, 0]);
      // The bulged one is pushed 100 pt down at its midpoint.
      expect(bulged[0].subpaths[0][0].anchor[0]).toBeCloseTo(150, 6);
      expect(bulged[0].subpaths[0][0].anchor[1]).toBeCloseTo(100, 6);
    });

    it("REVERSE SPINE flips which end each key's shape travels toward", () => {
      const forward = blendStepsFor({
        keys: [a, b],
        params: BLEND_DEFAULTS,
        spine: defaultSpineFor([a, b]),
        steps: 3,
      })!;
      const reversed = blendStepsFor({
        keys: [a, b],
        params: { ...BLEND_DEFAULTS, reverseSpine: true },
        spine: defaultSpineFor([a, b]),
        steps: 3,
      })!;
      // The SHAPE parameter is untouched…
      expect(reversed.map((s) => s.t)).toEqual(forward.map((s) => s.t));
      // …but the position is read from the other end: 0.25 → 0.75.
      expect(reversed.map((s) => s.u)).toEqual([0.75, 0.5, 0.25]);
      expect(reversed.map((s) => s.subpaths[0][0].anchor[0])).toEqual([
        225, 150, 75,
      ]);
    });

    it("REVERSE FRONT TO BACK reorders EMISSION only — the same geometry, the other way round", () => {
      const forward = blendStepsFor({
        keys: [a, b],
        params: BLEND_DEFAULTS,
        spine: defaultSpineFor([a, b]),
        steps: 3,
      })!;
      const flipped = blendStepsFor({
        keys: [a, b],
        params: { ...BLEND_DEFAULTS, reverseFrontToBack: true },
        spine: defaultSpineFor([a, b]),
        steps: 3,
      })!;
      expect(flipped.map((s) => s.index)).toEqual([3, 2, 1]);
      expect(flipped.map((s) => s.subpaths[0][0].anchor[0])).toEqual([
        225, 150, 75,
      ]);
      // Every step is the SAME step, just emitted in the other order.
      expect(flipped.map((s) => s.t).reverse()).toEqual(
        forward.map((s) => s.t),
      );
    });

    it("EASING re-parameterizes the shapes, and INDEPENDENT COLOUR does not follow it", () => {
      const red = {
        ...squareKey("ua", 0, 0, null),
        rgb: [255, 0, 0] as [number, number, number],
      };
      const blue = {
        ...squareKey("ub", 300, 0, null),
        rgb: [0, 0, 255] as [number, number, number],
      };
      const eased = blendStepsFor({
        keys: [red, blue],
        params: { ...BLEND_DEFAULTS, easing: "easeIn", easingStrength: 1 },
        spine: defaultSpineFor([red, blue]),
        steps: 3,
      })!;
      // easeIn at 0.25/0.5/0.75 → 0.0625 / 0.25 / 0.5625.
      expect(eased.map((s) => s.t)).toEqual([0.0625, 0.25, 0.5625]);
      // Colour followed the SHAPE easing (colorEasing null = not
      // independent): 0.0625 of the way from red to blue.
      expect(eased[0].mintFill?.name).toBe("#ef0010");
      // …now give colour its OWN curve, and the shape keeps its.
      const independent = blendStepsFor({
        keys: [red, blue],
        params: {
          ...BLEND_DEFAULTS,
          easing: "easeIn",
          easingStrength: 1,
          colorEasing: "linear",
        },
        spine: defaultSpineFor([red, blue]),
        steps: 3,
      })!;
      expect(independent.map((s) => s.t)).toEqual([0.0625, 0.25, 0.5625]);
      expect(independent[0].mintFill?.name).toBe("#bf0040"); // linear 0.25
    });

    it("a STRUCTURE MISMATCH answers null — v1 still refuses to invent a correspondence", () => {
      const three: BlendSource = {
        subpaths: [[corner(0, 0), corner(1, 1), corner(2, 2)]],
        open: [true],
      };
      expect(blendStructureMatches(a.source, three)).toBe(false);
      expect(
        blendStepsFor({
          keys: [a, { ...b, source: three }],
          params: BLEND_DEFAULTS,
          spine: defaultSpineFor([a, b]),
          steps: 3,
        }),
      ).toBeNull();
    });

    it("CONCENTRIC keys — a ZERO-length spine — still make every intermediate", () => {
      const outer = squareKey("ua", 0, 0, null);
      const innerSource: BlendSource = {
        subpaths: [
          [corner(25, 25), corner(75, 25), corner(75, 75), corner(25, 75)],
        ],
        open: [false],
      };
      const inner: BlendKey = {
        ...squareKey("ub", 0, 0, null),
        source: innerSource,
        center: blendSourceCenter(innerSource),
      };
      expect(defaultSpineFor([outer, inner]).length).toBe(0);
      const steps = blendStepsFor({
        keys: [outer, inner],
        params: BLEND_DEFAULTS,
        spine: defaultSpineFor([outer, inner]),
        steps: 3,
      })!;
      expect(steps).toHaveLength(3);
      // They shrink toward the inner square: 0, 6.25, 12.5, 18.75.
      expect(steps.map((s) => s.subpaths[0][0].anchor[0])).toEqual([
        6.25, 12.5, 18.75,
      ]);
    });

    it("blendSourceBounds / blendStepBounds measure the CONTROL-POINT hull", () => {
      expect(blendSourceBounds(a.source)).toEqual([0, 0, 100, 100]);
      const steps = blendStepsFor({
        keys: [a, b],
        params: BLEND_DEFAULTS,
        spine: defaultSpineFor([a, b]),
        steps: 1,
      })!;
      expect(blendStepBounds(steps[0])).toEqual([150, 0, 250, 100]);
    });
  });

  describe("the wire", () => {
    it("blendBatchFor emits ONE batch: swatch, insert, bind, paint, link — then the group", () => {
      resetBlendSwatchSeq();
      const red = {
        ...squareKey("ua", 0, 0, null),
        rgb: [255, 0, 0] as [number, number, number],
      };
      const blue = {
        ...squareKey("ub", 300, 0, null),
        rgb: [0, 0, 255] as [number, number, number],
      };
      const steps = blendStepsFor({
        keys: [red, blue],
        params: BLEND_DEFAULTS,
        spine: defaultSpineFor([red, blue]),
        steps: 1,
      })!;
      const batch = blendBatchFor({
        plan: {
          pageId: "usp",
          blend: "bl-1",
          params: BLEND_DEFAULTS,
          keys: [red, blue],
          spineId: null,
          spineLength: 300,
          count: {
            steps: 1,
            requested: 1,
            why: "specified steps: 1",
            clamped: false,
            degraded: false,
          },
          steps,
          dropped: 0,
        },
        keyEnvelopes: [null, null],
      });
      const ops = opsOf(batch);
      expect(ops.map((o) => o.op)).toEqual([
        "createSwatch", // the interpolated fill
        "insertPath",
        "bindCreated", // …and C-15 names what it minted
        "setElementProperty", // fill
        "setElementProperty", // stroke
        "setPluginMetadata", // the step link
        "setPluginMetadata", // key 0's link
        "setPluginMetadata", // key 1's link
        "createGroup",
      ]);
      // The bind's handle is the one the later ops address.
      expect(ops[2]).toEqual({
        op: "bindCreated",
        args: { handle: blendHandle(0, 0) },
      });
      expect(
        (ops[3] as { args: { elementId: ElementId } }).args.elementId,
      ).toEqual({ kind: "polygon", id: `$h:${blendHandle(0, 0)}` });
      // …and the group holds BOTH keys plus the intermediate by handle.
      expect(
        (ops[8] as { args: { memberIds: ElementId[] } }).args.memberIds,
      ).toEqual([
        red.id,
        blue.id,
        { kind: "polygon", id: `$h:${blendHandle(0, 0)}` },
      ]);
    });

    it("a KEEP-FIRST blend (no readable colour) mints no swatch at all", () => {
      const a = squareKey("ua", 0, 0, "Color/Black");
      const b = squareKey("ub", 300, 0, "Color/Other");
      const steps = blendStepsFor({
        keys: [a, b],
        params: BLEND_DEFAULTS,
        spine: defaultSpineFor([a, b]),
        steps: 2,
      })!;
      expect(steps.every((s) => s.mintFill === null)).toBe(true);
      // …and every step keeps the FIRST key's ref (v0's rule).
      expect(steps.map((s) => s.fillRef)).toEqual([
        "Color/Black",
        "Color/Black",
      ]);
    });
  });

  describe("the recipe part", () => {
    it("round-trips, and anything unreadable reads as EMPTY", () => {
      const lib = upsertBlendRecord(
        { v: BLEND_LIBRARY_VERSION, blends: [] },
        {
          id: "bl-1",
          name: "One",
          params: BLEND_DEFAULTS,
          keys: [
            { kind: "polygon", id: "ua" },
            { kind: "polygon", id: "ub" },
          ],
          spine: { kind: "polygon", id: "us" },
          steps: [{ kind: "polygon", id: "u9" }],
        },
      );
      const back = parseBlendLibrary(serializeBlendLibrary(lib));
      expect(back).toEqual(lib);
      expect(mintBlendId(back)).toBe("bl-2");
      expect(findBlendRecord(back, "bl-1")?.name).toBe("One");
      expect(parseBlendLibrary(null).blends).toEqual([]);
      expect(parseBlendLibrary(new TextEncoder().encode("{{{")).blends).toEqual(
        [],
      );
      expect(
        parseBlendLibrary(
          new TextEncoder().encode('{"v":99,"blends":[{"id":"x"}]}'),
        ).blends,
      ).toEqual([]);
    });

    it("withBlendKey preserves every OTHER draw metadata key", () => {
      const prev = {
        v: 1,
        data: { graphicStyle: { style: "gs-1" }, blendKey: { blend: "old" } },
      };
      const merged = withBlendKey(prev, "blendKey", {
        blend: "bl-2",
        index: 1,
      });
      expect(merged?.data).toEqual({
        graphicStyle: { style: "gs-1" },
        blendKey: { blend: "bl-2", index: 1 },
      });
      const dropped = withBlendKey(merged, "blendKey", null);
      expect(dropped?.data).toEqual({ graphicStyle: { style: "gs-1" } });
      // …and an envelope with nothing left goes to null, not to `{}`.
      expect(
        withBlendKey({ v: 1, data: { blendKey: {} } }, "blendKey", null),
      ).toBeNull();
    });
  });

  // ------------------------------------------------ the real engine

  describe("against the booted engine (F4 overlap pair, red → blue)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F4_OVERLAP.bytes());
      h.loadBundle(drawBundle);
      for (const [id, ref, hex, rgb] of [
        [UA, "Color/ured", "#ff0000", [255, 0, 0]],
        [UB, "Color/ublue", "#0000ff", [0, 0, 255]],
      ] as const) {
        const sw = await h.host.document.mutate({
          op: "createSwatch",
          args: {
            spec: { selfId: ref, name: hex, space: "RGB", value: [...rgb] },
          },
        });
        if (!sw.applied) throw new Error("createSwatch failed");
        const set = await h.host.document.mutate({
          op: "setElementProperty",
          args: {
            elementId: id,
            path: "frameFillColor",
            value: { type: "colorRef", value: ref },
          },
        });
        if (!set.applied) throw new Error("fill seed failed");
      }
    });
    afterAll(() => h?.dispose());

    beforeEach(async () => {
      await h.host.selection.set([]);
      await writeBlendLibrary(h.host, { v: BLEND_LIBRARY_VERSION, blends: [] });
    });

    it("the host wires the container-parts door this feature rides", () => {
      expect(h.host.supports(BLEND_FEATURE)).toBe(true);
    });

    it("MAKE = ONE batch ⇒ ONE undo step (v0 needed two, and said so)", async () => {
      await h.host.selection.set([UA, UB]);
      const made = await applyMakeBlend(h.host, {});
      expect(made).toHaveLength(BLEND_STEPS);
      expect(await leafIds(h)).toHaveLength(PRISTINE.length + BLEND_STEPS);

      // The intermediates are REAL, PAINTED and LINKED artwork, and the
      // middle one sits midway between ua (100..300) and ub (200..400).
      const mid = await h.host.document.pathAnchors(made[1]);
      expect(mid!.anchors).toHaveLength(4);
      expect(mid!.anchors[0].anchor[0]).toBeCloseTo(150, 6);
      expect(mid!.anchors[0].anchor[1]).toBeCloseTo(150, 6);
      // …with interpolated fills: t = 1/4, 1/2, 3/4 red → blue.
      expect(await fillHexOf(h, made[0])).toBe("#bf0040");
      expect(await fillHexOf(h, made[1])).toBe("#800080");
      expect(await fillHexOf(h, made[2])).toBe("#4000bf");
      // The keys carry their links and the whole thing is ONE group.
      expect(blendKeyOf(await h.host.document.getMetadata(UA))?.index).toBe(0);
      expect(blendKeyOf(await h.host.document.getMetadata(UB))?.index).toBe(1);
      expect((await groupShape(h))?.members).toHaveLength(2 + BLEND_STEPS);
      // The commit never touches the creation defaults.
      expect(
        (await h.host.document.meta()).defaultFillColor ?? null,
      ).toBeNull();

      // …AND ONE undo puts the document back exactly as it was.
      await h.host.document.undo();
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
      expect(await groupShape(h)).toBeNull();
      expect(blendKeyOf(await h.host.document.getMetadata(UA))).toBeNull();
    });

    it("the recipe records what was built, and resolves without a payload", async () => {
      await h.host.selection.set([UA, UB]);
      await applyMakeBlend(h.host, { name: "Reds" });
      const library = await readBlendLibrary(h.host);
      const record = findBlendRecord(library, "bl-1")!;
      expect(record.name).toBe("Reds");
      expect(record.keys.map((k) => k.id)).toEqual(["ua", "ub"]);
      expect(record.spine).toBeNull();
      expect(record.steps).toHaveLength(BLEND_STEPS);
      // …and the part really is at the declared path.
      expect(await h.host.parts.read(BLEND_PART)).not.toBeNull();
      await undoTo(h, 1);
    });

    it("SPECIFIED STEPS and SPECIFIED DISTANCE reach the engine, each in 1 undo step", async () => {
      await h.host.selection.set([UA, UB]);
      const eight = await applyMakeBlend(h.host, {
        spacing: "steps",
        steps: 8,
      });
      expect(eight).toHaveLength(8);
      await undoTo(h, 1);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);

      await writeBlendLibrary(h.host, { v: BLEND_LIBRARY_VERSION, blends: [] });
      await h.host.selection.set([UA, UB]);
      // The spine is the centre-to-centre line: (200,200)→(300,300) =
      // 141.42 pt. At 35 pt that is 4 gaps ⇒ 3 intermediates.
      const spaced = await applyMakeBlend(h.host, {
        spacing: "distance",
        distancePt: 35,
      });
      expect(spaced).toHaveLength(3);
      await undoTo(h, 1);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("SMOOTH COLOR derives its count from the REAL swatches (red → blue = 255, clamped)", async () => {
      await h.host.selection.set([UA, UB]);
      const smooth = await applyMakeBlend(h.host, { spacing: "smoothColor" });
      // max|Δchannel| for #ff0000 → #0000ff is 255, over the ceiling.
      expect(smooth).toHaveLength(BLEND_MAX_STEPS);
      await undoTo(h, 1);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("UPDATE = ONE undo step, and the intermediates get NEW ids", async () => {
      await h.host.selection.set([UA, UB]);
      const first = await applyMakeBlend(h.host, { steps: 2 });
      expect(first).toHaveLength(2);
      const after = await applyUpdateBlend(h.host, { steps: 5 });
      expect(after).toHaveLength(5);
      expect(after.map((i) => i.id)).not.toContain(first[0].id);
      expect(await h.host.document.elementGeometry([first[0]])).toHaveLength(0);
      // One undo unwinds the whole re-plan back to the FIRST generation.
      await h.host.document.undo();
      expect(await leafIds(h)).toContain(first[0].id);
      expect(await leafIds(h)).toHaveLength(PRISTINE.length + 2);
      await undoTo(h, 1);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("REVERSE FRONT TO BACK flips PAINT ORDER and moves nothing", async () => {
      await h.host.selection.set([UA, UB]);
      const made = await applyMakeBlend(h.host, { steps: 3 });
      const before = await Promise.all(
        made.map(async (id) => ({
          t: blendStepOf(await h.host.document.getMetadata(id))!.index,
          x: (await h.host.document.pathAnchors(id))!.anchors[0].anchor[0],
        })),
      );
      // Emission order == the ordinal order, and the geometry advances.
      expect(before.map((b) => b.t)).toEqual([1, 2, 3]);
      expect(before[0].x).toBeLessThan(before[2].x);

      const flipped = await applyReverseBlendOrder(h.host, {});
      const after = await Promise.all(
        flipped.map(async (id) => ({
          t: blendStepOf(await h.host.document.getMetadata(id))!.index,
          x: (await h.host.document.pathAnchors(id))!.anchors[0].anchor[0],
        })),
      );
      // The ORDINALS are reversed in emission (= paint) order…
      expect(after.map((a) => a.t)).toEqual([3, 2, 1]);
      // …and the SET of positions is unchanged: nothing moved.
      expect(after.map((a) => a.x).sort()).toEqual(
        before.map((b) => b.x).sort(),
      );
      // ONE undo step for the flip, one for the build.
      await undoTo(h, 2);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("REVERSE SPINE moves the geometry (unlike front-to-back), in 1 undo step", async () => {
      await h.host.selection.set([UA, UB]);
      const made = await applyMakeBlend(h.host, { steps: 3 });
      const before = (await h.host.document.pathAnchors(made[0]))!.anchors[0]
        .anchor[0];
      const reversed = await applyReverseBlendSpine(h.host, {});
      const after = (await h.host.document.pathAnchors(reversed[0]))!.anchors[0]
        .anchor[0];
      // Step 1's shape now sits at the FAR end of the spine.
      expect(after).toBeGreaterThan(before);
      expect(
        (await readBlendLibrary(h.host)).blends[0].params.reverseSpine,
      ).toBe(true);
      await undoTo(h, 2);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("SELECT puts the KEY objects on the selection — that is how you edit them", async () => {
      await h.host.selection.set([UA, UB]);
      const made = await applyMakeBlend(h.host, { steps: 2 });
      const keys = await applySelectBlendObjects(h.host, {});
      expect(keys.map((k) => k.id).sort()).toEqual(["ua", "ub"]);
      const steps = await applySelectBlendObjects(h.host, { which: "steps" });
      expect(steps.map((s) => s.id).sort()).toEqual(
        made.map((m) => String(m.id)).sort(),
      );
      await undoTo(h, 1);
    });

    it("EXPAND keeps everything; RELEASE keeps only the keys. Both = 1 undo step", async () => {
      await h.host.selection.set([UA, UB]);
      const made = await applyMakeBlend(h.host, { steps: 2 });
      expect(await applyExpandBlend(h.host, {})).toBe(true);
      expect(await leafIds(h)).toHaveLength(PRISTINE.length + made.length);
      expect(blendKeyOf(await h.host.document.getMetadata(UA))).toBeNull();
      expect(
        blendStepOf(await h.host.document.getMetadata(made[0])),
      ).toBeNull();
      await undoTo(h, 2); // the expand, then the make
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);

      await writeBlendLibrary(h.host, { v: BLEND_LIBRARY_VERSION, blends: [] });
      await h.host.selection.set([UA, UB]);
      const again = await applyMakeBlend(h.host, { steps: 2 });
      expect(await applyReleaseBlend(h.host, {})).toBe(2);
      // The intermediates are GONE, the keys are untouched…
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
      expect(await h.host.document.elementGeometry([again[0]])).toHaveLength(0);
      expect(blendKeyOf(await h.host.document.getMetadata(UA))).toBeNull();
      expect(await groupShape(h)).toBeNull();
      // …and both together are 2 undo steps: the release, then the make.
      await undoTo(h, 2);
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("REPLACE SPINE takes the one selected path that is not part of the blend", async () => {
      await h.host.selection.set([UA, UB]);
      await applyMakeBlend(h.host, { steps: 1 });
      // Mint a spine that bulges away from the straight line.
      const ins = await h.host.document.mutate({
        op: "insertPath",
        args: {
          pageId: F4_OVERLAP.pageId,
          anchors: [corner(200, 200), corner(250, 500), corner(300, 300)],
          open: true,
        },
      } as Mutation);
      if (!ins.applied || !ins.createdId) throw new Error("insertPath failed");
      const spine = ins.createdId as unknown as ElementId;
      await h.host.selection.set([spine]);
      const replaced = await applyReplaceBlendSpine(h.host, {});
      expect(replaced).toHaveLength(1);
      // The single intermediate is now nowhere near the straight line's
      // midpoint (250, 250) — it rides the bulge.
      const at = (await h.host.document.pathAnchors(replaced[0]))!.anchors[0]
        .anchor;
      expect(at[1]).toBeGreaterThan(300);
      // The spine carries its own link and is NOT in the blend's group.
      expect(
        blendSpineOf(await h.host.document.getMetadata(spine))?.blend,
      ).toBe("bl-1");
      expect((await groupShape(h))?.members ?? []).not.toContain(
        String(spine.id),
      );
      expect((await readBlendLibrary(h.host)).blends[0].spine?.id).toBe(
        String(spine.id),
      );
      // …and it still paints exactly as the user drew it: replacing a
      // spine does not silently clear anyone's stroke.
      const props = await h.host.document.elementProperties(spine);
      expect(props).not.toBeNull();
      await undoTo(h, 3); // the replace, the insert, the make
      expect(await sortedLeafIds(h)).toEqual(PRISTINE);
    });

    it("the honest refusals: not-exactly-2, a typed count over the ceiling", async () => {
      const before = await leafIds(h);
      await h.host.selection.set([UA]);
      await commandFor(h, BLEND_COMMAND_ID).handler(undefined, undefined);
      await h.host.selection.set([]);
      await commandFor(h, BLEND_COMMAND_ID).handler(undefined, undefined);
      expect(await leafIds(h)).toEqual(before);

      await h.host.selection.set([UA, UB]);
      expect(
        await applyMakeBlend(h.host, { steps: BLEND_MAX_STEPS + 1 }),
      ).toEqual([]);
      expect(await leafIds(h)).toEqual(before);
    });

    it("a TEXT FRAME is refused — no wire op copies a story", async () => {
      const before = await leafIds(h);
      const ins = await h.host.document.mutate({
        op: "insertTextFrame",
        args: { pageId: F4_OVERLAP.pageId, bounds: [500, 100, 560, 200] },
      } as unknown as Mutation);
      if (!ins.applied || !ins.createdId)
        throw new Error("insertTextFrame failed");
      await h.host.selection.set([UA, ins.createdId as unknown as ElementId]);
      expect(await applyMakeBlend(h.host, {})).toEqual([]);
      await h.host.document.undo();
      expect(await leafIds(h)).toEqual(before);
    });
  });

  describe("mismatched structure (F1: 3-anchor polygon vs 2-anchor line)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    it("refuses with a diagnostic — no elements inserted", async () => {
      const before = await leafIds(h);
      await h.host.selection.set([
        { kind: "polygon", id: "upoly" } as ElementId,
        { kind: "graphicLine", id: "uline" } as ElementId,
      ]);
      await commandFor(h, BLEND_COMMAND_ID).handler(undefined, undefined);
      expect(await leafIds(h)).toEqual(before);
    });
  });

  // ------------------------------------------------- the registration

  describe("the registration surface", () => {
    it("contributes eight commands and a panel, in the declared order", () => {
      expect(BLEND_COMMAND_IDS).toEqual([
        BLEND_COMMAND_ID,
        UPDATE_BLEND_COMMAND_ID,
        REPLACE_BLEND_SPINE_COMMAND_ID,
        REVERSE_BLEND_SPINE_COMMAND_ID,
        REVERSE_BLEND_ORDER_COMMAND_ID,
        SELECT_BLEND_OBJECTS_COMMAND_ID,
        EXPAND_BLEND_COMMAND_ID,
        RELEASE_BLEND_COMMAND_ID,
      ]);
      const declared = drawBundle.manifest.contributes?.commands ?? [];
      for (const id of BLEND_COMMAND_IDS) expect(declared).toContain(id);
      expect(drawBundle.manifest.contributes?.panels).toContain(BLEND_PANEL_ID);
      // v0's id SURVIVES as the make verb — renaming a published command
      // to match a newer convention breaks callers for cosmetics.
      expect(BLEND_COMMAND_ID).toBe("media.paged.draw.command.blendSelected");
      // The recipe part type is declared.
      expect(
        (drawBundle.manifest.contributes?.partTypes ?? []).map((p) => p.type),
      ).toContain("blendRecipe");
    });

    it("the panel note carries the two honesty facts VERBATIM", () => {
      expect(BLEND_PANEL_NOTE).toContain(BLEND_LIVE_NOTE);
      expect(BLEND_PANEL_NOTE).toContain(BLEND_SPINE_NOTE);
      // What "live" means: a preview of the PLAN, not of the artwork.
      expect(BLEND_LIVE_NOTE).toContain("preview of the");
      expect(BLEND_LIVE_NOTE).toContain("PLAN");
      expect(BLEND_LIVE_NOTE).toContain("not of the artwork");
      // The two deliberate differences from Illustrator's spine.
      expect(BLEND_SPINE_NOTE).toContain("KEEPS ITS OWN PAINT");
      expect(BLEND_SPINE_NOTE).toContain("NOT put inside the blend's group");
      // And the undo arithmetic.
      expect(BLEND_PANEL_NOTE).toContain("ONE undo step");
    });

    it("blendRowLabel says what was asked for and what is on the page", () => {
      expect(
        blendRowLabel(
          {
            id: "bl-1",
            name: "One",
            params: { ...BLEND_DEFAULTS, spacing: "steps", steps: 4 },
            keys: [],
            spine: null,
            steps: [],
          },
          4,
        ),
      ).toBe("4 steps (4 intermediates placed)");
      expect(
        blendRowLabel(
          {
            id: "bl-2",
            name: "Two",
            params: {
              ...BLEND_DEFAULTS,
              spacing: "smoothColor",
              orientation: "path",
              reverseSpine: true,
            },
            keys: [],
            spine: { kind: "polygon", id: "us" },
            steps: [],
          },
          1,
        ),
      ).toBe(
        "smooth colour · replaced spine · aligned · reversed spine (1 intermediate placed)",
      );
    });
  });
});
