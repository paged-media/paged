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

// REFLECT on a GROUP, in the group's PARENT FRAME (`../src/commands/transform.ts`).
//
// A group's stored transform G is relative to the group holding it, and
// an engine that answers `elementGeometry` for a group answers its
// COMPOSED transform E (every enclosing group's, then its own). The
// reflection R is a page-space matrix, so a nested group is written
// `F⁻¹ ∘ R ∘ F ∘ G` with `F = E ∘ G⁻¹` (its parent frame): what lands on
// the page is `R ∘ E`. A top-level group has `F = I` and is written
// `R ∘ G`, as is any group on an engine that answers no group geometry.
//
// The engine is PLAYED BACK here: the published engine (0.71.x) answers
// nothing for a group, so the nested case can only be driven against a
// host answering the way the next engine does. The real engine's answer
// for a group today — nothing, and the old write — is pinned in
// `conformance/transform.spec.ts`.

import { describe, expect, it } from "vitest";

import type { BundleHost, ElementId } from "@paged-media/plugin-api";
import {
  affineReflect,
  affineRotate,
  applyAffine,
  composeAffine,
  type Affine,
} from "@paged-media/draw-geometry";

import {
  applyReflect,
  groupFrameOf,
  transformBatchFor,
} from "../src/commands/transform";

type Box = [number, number, number, number];

interface GroupFixture {
  id: string;
  /** What `frameTransform` reads: the stored, parent-relative G. */
  stored: Affine | null;
  /** What `frameBounds` reads: the members' union, spread space. */
  box: Box;
  /** What `elementGeometry` answers for it; absent = nothing (0.71.x). */
  geometry?: { itemTransform: Affine | null; pageOrigin?: [number, number] };
}

const groupId = (id: string): ElementId => ({ kind: "group", id }) as ElementId;

/** The smallest host a reflect reaches, answering for `groups` only and
 *  recording every mutation it is sent. */
function groupHost(groups: GroupFixture[]): { host: BundleHost; sent: unknown[] } {
  const sent: unknown[] = [];
  const byId = new Map(groups.map((g) => [g.id, g]));
  const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const host = {
    log: quiet,
    supports: () => false,
    selection: { get: () => groups.map((g) => groupId(g.id)) },
    document: {
      elementProperties: async (id: ElementId) => {
        const g = byId.get(String(id.id));
        if (!g) return null;
        return {
          entries: [
            { path: "frameBounds", value: { type: "bounds", value: g.box } },
            { path: "frameTransform", value: { type: "transform", value: g.stored } },
          ],
        };
      },
      elementGeometry: async (ids: ElementId[]) =>
        ids.flatMap((id) => {
          const g = byId.get(String(id.id));
          if (!g?.geometry) return [];
          return [
            {
              id,
              pageId: "p",
              spreadId: "s",
              bounds: [0, 0, 1, 1],
              itemTransform: g.geometry.itemTransform,
              ...(g.geometry.pageOrigin ? { pageOrigin: g.geometry.pageOrigin } : {}),
              hasImage: false,
            },
          ];
        }),
      mutate: async (m: unknown) => {
        sent.push(m);
        return { applied: true };
      },
    },
  } as unknown as BundleHost;
  return { host, sent };
}

/** The `transform` each `setGroupTransform` of the one batch wrote. */
function groupWrites(sent: unknown[]): Record<string, number[]> {
  expect(sent).toHaveLength(1);
  const ops = (sent[0] as { args: { ops: { op: string; args: { groupId: string; transform: number[] } }[] } }).args.ops;
  return Object.fromEntries(
    ops.filter((o) => o.op === "setGroupTransform").map((o) => [o.args.groupId, o.args.transform]),
  );
}

const expectAffine = (got: readonly number[] | null | undefined, want: Affine) => {
  expect(got, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`).toHaveLength(6);
  got!.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 9));
};

/** The parent: a quarter turn about (200, 200) — (x, y) → (400 − y, x). */
const PARENT: Affine = affineRotate(90, [200, 200]);
/** The nested group's own stored transform, relative to that parent. */
const INNER: Affine = [1, 0, 0, 1, 10, 0];
/** Its composed (spread-space) transform: PARENT ∘ INNER. */
const COMPOSED: Affine = composeAffine(PARENT, INNER);
/** Its members' union on the spread: centre (150, 130). */
const BOX: Box = [100, 100, 160, 200];

describe("Reflect a group in its parent's frame", () => {
  it("a NESTED group in a parent turned 90°: the page-space mirror lands as a page-space mirror", async () => {
    // The engine answers page space: the composed transform less the
    // page's origin, which it reports beside it.
    const origin: [number, number] = [50, 20];
    const pageLocal: Affine = [...COMPOSED.slice(0, 4), COMPOSED[4] - origin[0], COMPOSED[5] - origin[1]] as unknown as Affine;
    const { host, sent } = groupHost([
      { id: "inner", stored: INNER, box: BOX, geometry: { itemTransform: pageLocal, pageOrigin: origin } },
    ]);
    const done = await applyReflect(host, 90);
    expect(done.applied).toBe(true);
    const written = groupWrites(sent).inner!;

    // Reflect horizontally about x = 150: (x, y) → (300 − x, y). Seen from
    // the parent's quarter-turned frame that is a TOP ↔ BOTTOM flip —
    // (x, y) → (x + 10, 500 − y) in the group's own coordinates — where
    // writing R ∘ G would have written a left ↔ right one.
    expectAffine(written, [1, 0, 0, -1, 10, 500]);
    expect(written[0]).not.toBeCloseTo(composeAffine(affineReflect(90, [150, 130]), INNER)[0], 3);

    // What the user sees: every point of the group, through its parent,
    // lands mirrored about the page's vertical axis through the centre.
    const nowComposed = composeAffine(PARENT, written as unknown as Affine);
    expectAffine(nowComposed, composeAffine(affineReflect(90, [150, 130]), COMPOSED));
    for (const [x, y] of [
      [0, 0],
      [40, 0],
      [0, 60],
      [-25, 13],
    ] as const) {
      const [bx, by] = applyAffine(COMPOSED, x, y);
      const [ax, ay] = applyAffine(nowComposed, x, y);
      expect(ax).toBeCloseTo(300 - bx, 9);
      expect(ay).toBeCloseTo(by, 9);
    }
  });

  it("a TOP-LEVEL group (the engine answers E = G): exactly today's write, R ∘ G", async () => {
    // A stored transform the way the engine keeps it (single precision),
    // and the page-space answer it rounds once more on a facing spread's
    // verso: E − G is noise, not a parent frame.
    const stored = affineRotate(30, [-300, 130]).map(Math.fround) as unknown as Affine;
    const origin: [number, number] = [-612, -396];
    const pageLocal = [
      ...stored.slice(0, 4),
      Math.fround(stored[4] - origin[0]),
      Math.fround(stored[5] - origin[1]),
    ] as unknown as Affine;
    const box: Box = [100, -360, 160, -240];
    const { host, sent } = groupHost([
      { id: "g", stored, box, geometry: { itemTransform: pageLocal, pageOrigin: origin } },
    ]);
    await applyReflect(host, 0);
    expect(groupWrites(sent).g).toEqual([...composeAffine(affineReflect(0, [-300, 130]), stored)]);
  });

  it("an engine that answers NO group geometry (0.71.x): exactly today's write, R ∘ G — nested or not", async () => {
    const { host, sent } = groupHost([{ id: "inner", stored: INNER, box: BOX }]);
    await applyReflect(host, 90);
    expect(groupWrites(sent).inner).toEqual([...composeAffine(affineReflect(90, [150, 130]), INNER)]);
  });

  it("a group with NO stored transform reads as the identity: its parent frame is its composed transform", async () => {
    const { host, sent } = groupHost([
      { id: "inner", stored: null, box: BOX, geometry: { itemTransform: PARENT } },
    ]);
    await applyReflect(host, 90);
    const written = groupWrites(sent).inner!;
    expectAffine(
      composeAffine(PARENT, written as unknown as Affine),
      composeAffine(affineReflect(90, [150, 130]), PARENT),
    );
  });
});

describe("groupFrameOf — the parent frame F = E ∘ G⁻¹", () => {
  it("is the parent's transform for a nested group", () => {
    expectAffine(groupFrameOf(COMPOSED, INNER), PARENT);
  });

  it("is null (the spread) for a top-level group, where E = G — to within the engine's rounding", () => {
    expect(groupFrameOf(INNER, INNER)).toBeNull();
    expect(groupFrameOf(null, null)).toBeNull();
    expect(groupFrameOf([1, 0, 0, 1, 10.00002, -0.00001], INNER)).toBeNull();
  });

  it("is null when G cannot be inverted: the write falls back to R ∘ G", () => {
    expect(groupFrameOf(COMPOSED, [1, 2, 2, 4, 0, 0])).toBeNull();
  });

  it("an identity G makes F the composed transform itself", () => {
    expectAffine(groupFrameOf(PARENT, null), PARENT);
  });
});

describe("transformBatchFor — a target with a parent frame", () => {
  it("writes F⁻¹ ∘ R ∘ F ∘ G for it, R ∘ G for the one beside it without", () => {
    const R = affineReflect(90, [150, 130]);
    const batch = transformBatchFor(
      [
        { id: groupId("inner"), matrix: INNER, box: BOX, group: true, frame: PARENT },
        { id: groupId("top"), matrix: INNER, box: BOX, group: true },
      ],
      R,
      false,
    ) as { args: { ops: { op: string; args: { groupId: string; transform: number[] } }[] } };
    const [inner, top] = batch.args.ops;
    expectAffine(inner!.args.transform, [1, 0, 0, -1, 10, 500]);
    expect(top!.args.transform).toEqual([...composeAffine(R, INNER)]);
  });

  it("a SINGULAR parent frame cannot be divided out: R ∘ G, as before", () => {
    const R = affineReflect(90, [150, 130]);
    const batch = transformBatchFor(
      [{ id: groupId("inner"), matrix: INNER, box: BOX, group: true, frame: [0, 0, 0, 0, 5, 5] }],
      R,
      false,
    ) as { args: { ops: { args: { transform: number[] } }[] } };
    expect(batch.args.ops[0]!.args.transform).toEqual([...composeAffine(R, INNER)]);
  });
});
