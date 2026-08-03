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

// Wave 2 conformance — Blend v0: (1) the structure gate + the exact
// two-batch wire shapes (geometry+swatches, then fills — the
// commands/blend.ts UNDO SHAPE note records why one batch is blocked
// by the engine: setDocumentDefaults is unbatchable + no in-batch id
// references), (2) the LIVE command against the real engine — two
// matching quads blend into 3 interpolated intermediates with
// INTERPOLATED fills (red → blue via hex-named swatches, the io/svg
// colour convention), undone in TWO steps (fills, then the whole
// geometry batch), (3) the honest-diagnostic no-op on mismatched
// anchor counts, (4) the exactly-2-selected gate.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type {
  CommandContribution,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  blendStructureMatches,
  blendGeometryBatchFor,
  blendFillBatchFor,
  BLEND_COMMAND_ID,
  BLEND_STEPS,
  type BlendSource,
} from "../../src";
import { F1_MULTI_SHAPE, F4_OVERLAP } from "../fixtures/corpus";
import { openHost } from "./host";

const UA = { kind: "polygon", id: "ua" } as ElementId;
const UB = { kind: "polygon", id: "ub" } as ElementId;

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

async function leafIds(h: HeadlessHost): Promise<string[]> {
  const roots = await h.host.document.tree();
  const out: string[] = [];
  const walk = (nodes: { id?: { id?: unknown } | null; children?: unknown[] }[]) => {
    for (const node of nodes) {
      const raw = node.id?.id;
      if (typeof raw === "string" && (!node.children || node.children.length === 0)) {
        out.push(raw);
      }
      if (node.children) walk(node.children as never);
    }
  };
  walk(roots as never);
  return out;
}

async function fillHexOf(h: HeadlessHost, id: ElementId): Promise<string | null> {
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

describe("draw conformance — blend v0 (wave 2)", () => {
  it("blendStructureMatches gates subpath count / anchor counts / open flags", () => {
    const two: BlendSource = { subpaths: [[corner(0, 0), corner(1, 1)]], open: [true] };
    const three: BlendSource = {
      subpaths: [[corner(0, 0), corner(1, 1), corner(2, 2)]],
      open: [true],
    };
    const twoClosed: BlendSource = {
      subpaths: [[corner(0, 0), corner(1, 1)]],
      open: [false],
    };
    expect(blendStructureMatches(two, two)).toBe(true);
    expect(blendStructureMatches(two, three)).toBe(false);
    expect(blendStructureMatches(two, twoClosed)).toBe(false);
  });

  it("blendGeometryBatchFor (keepFirst) emits the exact one-batch geometry shape", () => {
    const a: BlendSource = { subpaths: [[corner(0, 0), corner(4, 0)]], open: [true] };
    const b: BlendSource = { subpaths: [[corner(0, 8), corner(4, 8)]], open: [true] };
    const plan = blendGeometryBatchFor("usp", a, b, {
      kind: "keepFirst",
      ref: "Color/Black",
    });
    const insertAt = (y: number) => ({
      op: "insertPath",
      args: {
        pageId: "usp",
        anchors: [
          { anchor: [0, y], left: [0, y], right: [0, y] },
          { anchor: [4, y], left: [4, y], right: [4, y] },
        ],
        open: true,
      },
    });
    // Steps at t = 1/4, 2/4, 3/4 → y = 2, 4, 6; keepFirst mints no
    // swatches and repeats the first's ref per step.
    expect(plan!.mutation).toEqual({
      op: "batch",
      args: { ops: [insertAt(2), insertAt(4), insertAt(6)] },
    });
    expect(plan!.stepFills).toEqual(["Color/Black", "Color/Black", "Color/Black"]);
    // Mismatch → null (the honest-diagnostic cue).
    const three: BlendSource = {
      subpaths: [[corner(0, 0), corner(1, 1), corner(2, 2)]],
      open: [true],
    };
    expect(
      blendGeometryBatchFor("usp", a, three, { kind: "keepFirst", ref: null }),
    ).toBeNull();
  });

  it("blendFillBatchFor emits ONE batch of per-intermediate fill writes", () => {
    const p1 = { kind: "polygon", id: "u1" } as ElementId;
    const p2 = { kind: "polygon", id: "u2" } as ElementId;
    const m = blendFillBatchFor([[p1], [p2]], ["Color/a", null]) as Extract<
      Mutation,
      { op: "batch" }
    >;
    expect(m).toEqual({
      op: "batch",
      args: {
        ops: [
          {
            op: "setElementProperty",
            args: {
              elementId: p1,
              path: "frameFillColor",
              value: { type: "colorRef", value: "Color/a" },
            },
          },
          // The null step writes nothing (no information).
        ],
      },
    });
    expect(blendFillBatchFor([[p1]], [null])).toBeNull();
  });

  describe("against the real engine (F4 overlap pair)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F4_OVERLAP.bytes());
      h.loadBundle(drawBundle);
      // Give the quads DISTINCT hex-named fills (red / blue) so the
      // interpolation branch is observable.
      for (const [id, ref, hex, rgb] of [
        [UA, "Color/ured", "#ff0000", [255, 0, 0]],
        [UB, "Color/ublue", "#0000ff", [0, 0, 255]],
      ] as const) {
        const sw = await h.host.document.mutate({
          op: "createSwatch",
          args: { spec: { selfId: ref, name: hex, space: "RGB", value: [...rgb] } },
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

    it("two matching quads blend into 3 intermediates with interpolated fills (two undo steps)", async () => {
      const before = await leafIds(h);
      await h.host.selection.set([UA, UB]);
      await commandFor(h, BLEND_COMMAND_ID).handler(undefined, undefined);

      const after = await leafIds(h);
      expect(after.length).toBe(before.length + BLEND_STEPS);
      const created = after.filter((id) => !before.includes(id));

      // The middle intermediate (t = 1/2) sits midway between ua
      // (100..300) and ub (200..400): its first anchor at (150, 150).
      const mid = await h.host.document.pathAnchors({
        kind: "polygon",
        id: created[1],
      } as never);
      expect(mid!.anchors).toHaveLength(4);
      expect(mid!.anchors[0].anchor[0]).toBeCloseTo(150);
      expect(mid!.anchors[0].anchor[1]).toBeCloseTo(150);
      expect(mid!.subpathOpen?.[0]).toBe(false);

      // Fills interpolate red → blue (hex-named swatches): t=1/4, 1/2,
      // 3/4 → #bf0040, #800080, #4000bf.
      expect(
        await fillHexOf(h, { kind: "polygon", id: created[0] } as never),
      ).toBe("#bf0040");
      expect(
        await fillHexOf(h, { kind: "polygon", id: created[1] } as never),
      ).toBe("#800080");
      expect(
        await fillHexOf(h, { kind: "polygon", id: created[2] } as never),
      ).toBe("#4000bf");

      // The commit never touches the creation defaults (the fills ride
      // direct property writes, not the defaults idiom).
      const meta = await h.host.document.meta();
      expect(meta.defaultFillColor ?? null).toBeNull();

      // TWO undo steps: (1) the fills batch, (2) the geometry batch —
      // which removes ALL three intermediates at once.
      await h.host.document.undo(); // fills
      expect((await leafIds(h)).length).toBe(before.length + BLEND_STEPS);
      await h.host.document.undo(); // geometry + swatches
      expect((await leafIds(h)).length).toBe(before.length);
    });

    it("fewer/more than exactly 2 selected → honest no-op", async () => {
      const before = await leafIds(h);
      await h.host.selection.set([UA]);
      await commandFor(h, BLEND_COMMAND_ID).handler(undefined, undefined);
      await h.host.selection.set([]);
      await commandFor(h, BLEND_COMMAND_ID).handler(undefined, undefined);
      expect((await leafIds(h)).length).toBe(before.length);
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
      expect((await leafIds(h)).length).toBe(before.length);
    });
  });
});
