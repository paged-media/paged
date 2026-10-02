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

// Conformance — `DirectSelectMachine.apply(ops)` against the REAL engine.
//
// `apply` previews an edit the machine did not plan (a segment-click
// insert, a double-click convert) on its own table, so the host can keep
// editing before its `pathAnchors` re-read lands. The preview is worth
// exactly as much as its agreement with the engine, so every case here
// seats a machine on the engine's live table, applies a planner's ops to
// BOTH, and requires the two tables to match — to the engine's f32 — in
// the space each is reported in (the machine's preview is pointer space,
// so the engine's table is mapped through its item transform).
//
// The convert rule is the one most likely to drift: the applier models
// core's `smooth_handles_from_neighbours` (tangent from the previous to
// the next anchor of the SAME contour, no wrap round a closed one), and
// these cases include the edge it falls back on.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ElementId, PathAnchorsResult } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { applyAffine, type Affine } from "@paged-media/draw-geometry";
import {
  DirectSelectMachine,
  anchorEditOps,
  pathEditBatch,
  planAnchorAddAt,
  planAnchorConvertAt,
  type PathPointOp,
} from "@paged-media/draw-tools";

import { F1_MULTI_SHAPE, F2_CLOSED_QUAD, F3_CURVED_OPEN } from "../fixtures/corpus";
import { SCALED_SQUARE, SMOOTH_ARCH } from "../fixtures/path-edit";
import { openHost } from "./host";

const polygon = (id: string): ElementId => ({ kind: "polygon", id }) as ElementId;

/** f32 storage: the engine's table agrees with an f64 model to here. */
const F32 = 1e-3;

describe("draw conformance — DirectSelectMachine.apply against the real engine", () => {
  let h: HeadlessHost;
  beforeAll(async () => {
    h = await openHost();
  });
  afterAll(() => h?.dispose());

  async function read(el: ElementId): Promise<PathAnchorsResult> {
    const reply = await h.host.document.pathAnchors(el);
    if (!reply) throw new Error(`no path anchors for ${JSON.stringify(el)}`);
    return reply;
  }

  /** Apply `planOps(table)` to a machine on `el` AND to the engine, and
   *  require the machine's preview to be the engine's table. */
  async function agree(
    bytes: Uint8Array,
    el: ElementId,
    planOps: (table: PathAnchorsResult) => PathPointOp[],
  ): Promise<{ before: PathAnchorsResult; after: PathAnchorsResult }> {
    await h.load(bytes);
    const before = await read(el);
    const m = new DirectSelectMachine({
      table: before,
      transform: before.itemTransform ?? null,
      slop: 2,
      nudgeStep: 1,
    });
    const ops = planOps(before);
    const preview = m.apply(ops).table;

    const outcome = await h.host.document.mutate(pathEditBatch(el, ops));
    expect(outcome.applied, JSON.stringify(outcome)).toBe(true);
    const after = await read(el);
    const m2 = (after.itemTransform ?? null) as Affine | null;
    const toPointer = (p: readonly number[]) =>
      m2 ? applyAffine(m2, p[0], p[1]) : [p[0], p[1]];

    expect(preview.anchors).toHaveLength(after.anchors.length);
    expect(preview.subpathStarts).toEqual(after.subpathStarts);
    after.anchors.forEach((a, i) => {
      for (const role of ["anchor", "left", "right"] as const) {
        const want = toPointer(a[role]);
        const got = preview.anchors[i][role];
        expect(Math.abs(got[0] - want[0]), `anchor ${i} ${role} x`).toBeLessThan(F32);
        expect(Math.abs(got[1] - want[1]), `anchor ${i} ${role} y`).toBeLessThan(F32);
      }
    });
    expect(preview.subpathOpen ?? []).toEqual(after.subpathOpen ?? []);
    return { before, after };
  }

  it("INSERT on a closed quad's closing segment (the subpath bookkeeping case)", async () => {
    const { after } = await agree(F2_CLOSED_QUAD.bytes(), polygon("uquad"), (t) =>
      anchorEditOps(planAnchorAddAt(t, 3, 0.5)!),
    );
    expect(after.anchors).toHaveLength(5);
  });

  it("INSERT on a CURVED segment — the de Casteljau split, handles included", async () => {
    await agree(F3_CURVED_OPEN.bytes(), polygon("ucurve"), (t) =>
      anchorEditOps(planAnchorAddAt(t, 0, 0.3)!),
    );
  });

  it("CONVERT a corner to smooth — the neighbour-tangent rule", async () => {
    const { after } = await agree(F1_MULTI_SHAPE.bytes(), polygon("upoly"), (t) =>
      anchorEditOps(planAnchorConvertAt(t, 1)!),
    );
    // It really is smooth now, not a no-op.
    expect(after.anchors[1].left).not.toEqual(after.anchors[1].anchor);
  });

  it("CONVERT a smooth anchor to a corner", async () => {
    await agree(SMOOTH_ARCH.bytes(), polygon(SMOOTH_ARCH.id), (t) =>
      anchorEditOps(planAnchorConvertAt(t, 1)!),
    );
  });

  it("CONVERT a closed contour's FIRST anchor to smooth — no wrap, so the engine (and the model) keep a corner", async () => {
    const { after } = await agree(F2_CLOSED_QUAD.bytes(), polygon("uquad"), () => [
      { op: "pathPointCurveType", index: 0, smooth: true },
    ]);
    expect(after.anchors[0].left).toEqual(after.anchors[0].anchor);
  });

  it("through an ITEM TRANSFORM — the ops are inner space, the preview pointer space", async () => {
    await agree(SCALED_SQUARE.bytes(), polygon(SCALED_SQUARE.id), (t) =>
      anchorEditOps(planAnchorAddAt(t, 0, 0.25)!),
    );
  });
});
