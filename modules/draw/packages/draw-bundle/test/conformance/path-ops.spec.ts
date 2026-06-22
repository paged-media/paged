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

// Phase 4c conformance — the v30 kernel path ops as commands
// (Outline stroke / Offset path / Simplify). Asserts (1) the EXACT
// wire shape each exported builder emits (the same objects the live
// commands send — no second copy to drift from), (2) each op applied
// at the REAL engine against a scratch insertPath product (the
// capability-matrix probe shape) with a full undo round-trip, and
// (3) the recorded command handlers commit against the live selection
// incl. payload parameter overrides.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type {
  CommandContribution,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  outlineStrokeMutationFor,
  offsetPathMutationFor,
  simplifyPathMutationFor,
  DEFAULT_OFFSET_DELTA_PT,
  DEFAULT_MITER_LIMIT,
  OUTLINE_STROKE_COMMAND_ID,
  OFFSET_PATH_COMMAND_ID,
  SIMPLIFY_PATH_COMMAND_ID,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { liveTable } from "../replay";
import { openHost } from "./host";

const EL = { kind: "polygon", id: "ux" } as unknown as ElementId;

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

/** Insert a scratch open path on the fixture page and return its id
 *  (the capability-matrix `newPath` shape). */
async function newPath(h: HeadlessHost): Promise<ElementId> {
  const outcome = await h.host.document.mutate({
    op: "insertPath",
    args: {
      pageId: F1_MULTI_SHAPE.pageId,
      anchors: [
        { anchor: [100, 100], left: [100, 100], right: [100, 100] },
        { anchor: [200, 120], left: [200, 120], right: [200, 120] },
        { anchor: [300, 100], left: [300, 100], right: [300, 100] },
      ],
      open: true,
    },
  });
  if (!outcome.applied) throw new Error("insert failed");
  expect(outcome.createdId).not.toBeNull();
  return outcome.createdId!;
}

/** Insert a scratch CLOSED quad — `offsetPath` requires a closed path
 *  (the engine rejects an offset of an open stroke with "open path
 *  where closed is required"). */
async function newClosedPath(h: HeadlessHost): Promise<ElementId> {
  const outcome = await h.host.document.mutate({
    op: "insertPath",
    args: {
      pageId: F1_MULTI_SHAPE.pageId,
      anchors: [
        { anchor: [400, 100], left: [400, 100], right: [400, 100] },
        { anchor: [500, 100], left: [500, 100], right: [500, 100] },
        { anchor: [500, 200], left: [500, 200], right: [500, 200] },
        { anchor: [400, 200], left: [400, 200], right: [400, 200] },
      ],
      open: false,
    },
  });
  if (!outcome.applied) throw new Error("insert closed failed");
  return outcome.createdId!;
}

describe("draw conformance — kernel path ops (Phase 4c)", () => {
  describe("the exact wire shapes the builders emit", () => {
    it("outlineStrokeMutationFor → outlineStroke{elementId,width,cap,join,miterLimit}", () => {
      const m = outlineStrokeMutationFor(EL, {
        width: 2,
        cap: "round",
        join: "bevel",
        miterLimit: 4,
      }) as Extract<Mutation, { op: "outlineStroke" }>;
      expect(m).toEqual({
        op: "outlineStroke",
        args: {
          elementId: EL,
          width: 2,
          cap: "round",
          join: "bevel",
          miterLimit: 4,
        },
      });
    });

    it("offsetPathMutationFor → offsetPath{elementId,delta,join,miterLimit}", () => {
      const m = offsetPathMutationFor(EL, {
        delta: -3,
        join: "miter",
        miterLimit: 4,
      });
      expect(m).toEqual({
        op: "offsetPath",
        args: { elementId: EL, delta: -3, join: "miter", miterLimit: 4 },
      });
    });

    it("simplifyPathMutationFor → simplifyPath{elementId,tolerance}", () => {
      expect(simplifyPathMutationFor(EL, 1.5)).toEqual({
        op: "simplifyPath",
        args: { elementId: EL, tolerance: 1.5 },
      });
    });
  });

  describe("against the real engine (scratch path per op, undo round-trips)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    it("outlineStroke applies and undo restores the source path", async () => {
      const target = await newPath(h);
      const ref = { kind: target.kind, id: target.id as string };
      const before = await liveTable(h.host, ref);
      const outcome = await h.host.document.mutate(
        outlineStrokeMutationFor(target, {
          width: 2,
          cap: "butt",
          join: "miter",
          miterLimit: DEFAULT_MITER_LIMIT,
        }),
      );
      expect(outcome.applied).toBe(true);
      // Outlining a 3-anchor open stroke yields a CLOSED outline with a
      // different anchor table.
      const after = await liveTable(h.host, ref);
      expect(after.anchors).not.toEqual(before.anchors);
      await h.host.document.undo();
      const restored = await liveTable(h.host, ref);
      expect(restored.anchors).toEqual(before.anchors);
      await h.host.document.undo(); // drop the scratch insertPath
    });

    it("offsetPath applies on a closed path (anchors change) and undo restores", async () => {
      // A closed contour offsets the contour directly (the single-sided
      // lane); open paths now produce a band instead of erroring — see
      // the next test (B-21).
      const target = await newClosedPath(h);
      const ref = { kind: target.kind, id: target.id as string };
      const before = await liveTable(h.host, ref);
      const outcome = await h.host.document.mutate(
        offsetPathMutationFor(target, {
          delta: DEFAULT_OFFSET_DELTA_PT,
          join: "miter",
          miterLimit: DEFAULT_MITER_LIMIT,
        }),
      );
      expect(outcome.applied).toBe(true);
      const after = await liveTable(h.host, ref);
      expect(after.anchors).not.toEqual(before.anchors);
      await h.host.document.undo();
      expect((await liveTable(h.host, ref)).anchors).toEqual(before.anchors);
      await h.host.document.undo();
    });

    it("offsetPath on an OPEN path now produces a closed band (B-21, v0.44.1)", async () => {
      // B-21 FIXED (core v0.44.1): an open/multi-subpath input no longer
      // errors "open path where closed is required" — it routes to a
      // kurbo outline_stroke band (the two-sided offset outline at
      // 2·|delta|). applied:true, the anchor table changes, undo
      // restores. Closes the B-21 RFI loop (was: rejected by design).
      const target = await newPath(h); // OPEN 3-anchor stroke
      const ref = { kind: target.kind, id: target.id as string };
      const before = await liveTable(h.host, ref);
      const outcome = await h.host.document.mutate(
        offsetPathMutationFor(target, {
          delta: DEFAULT_OFFSET_DELTA_PT,
          join: "miter",
          miterLimit: DEFAULT_MITER_LIMIT,
        }),
      );
      expect(outcome.applied).toBe(true);
      expect((await liveTable(h.host, ref)).anchors).not.toEqual(
        before.anchors,
      );
      await h.host.document.undo();
      expect((await liveTable(h.host, ref)).anchors).toEqual(before.anchors);
      await h.host.document.undo();
    });

    it("simplifyPath decimates within tolerance + undo restores (B-20, v0.44.1)", async () => {
      // B-20 FIXED (core v0.44.1): `simplifyPath` now runs an RDP
      // point-decimation pass over each subpath BEFORE the curve-fit, so
      // a near-collinear interior anchor within tolerance drops. The
      // 3-anchor corner polyline ([100,100],[200,120],[300,100]) has a
      // ~20pt-deviation middle anchor; at tolerance 30 (> 20) it is
      // removed → fewer anchors. Undo restores the original table
      // bytewise. (Pre-0.44.1 this was a no-op — the test then pinned the
      // plugin contract only; it now asserts the reduction the published
      // engine delivers, closing the B-20 RFI loop.)
      const target = await newPath(h);
      const ref = { kind: target.kind, id: target.id as string };
      const before = await liveTable(h.host, ref);
      const outcome = await h.host.document.mutate(
        simplifyPathMutationFor(target, 30),
      );
      expect(outcome.applied).toBe(true);
      const after = await liveTable(h.host, ref);
      expect(after.anchors.length).toBeLessThan(before.anchors.length);
      await h.host.document.undo();
      expect((await liveTable(h.host, ref)).anchors).toEqual(before.anchors);
      await h.host.document.undo();
    });

    it("the recorded command handlers commit to the selection (payload overrides honored)", async () => {
      // Outline + simplify run on an OPEN scratch path; offset needs a
      // closed one (see newClosedPath). Each command reads the selection
      // and emits its op with the payload override honored.
      const target = await newPath(h);
      const ref = { kind: target.kind, id: target.id as string };
      await h.host.selection.set([target]);
      const before = await liveTable(h.host, ref);

      // Simplify is accepted + undoable (decimation magnitude is core's
      // contract — currently a no-op on this input, see above).
      await commandFor(h, SIMPLIFY_PATH_COMMAND_ID).handler(undefined, {
        tolerance: 30,
      });
      await h.host.document.undo();
      expect((await liveTable(h.host, ref)).anchors).toEqual(before.anchors);

      // Outline with a payload width — yields a closed outline (anchors
      // change), undo restores.
      await commandFor(h, OUTLINE_STROKE_COMMAND_ID).handler(undefined, {
        width: 3,
      });
      expect((await liveTable(h.host, ref)).anchors).not.toEqual(
        before.anchors,
      );
      await h.host.document.undo();
      expect((await liveTable(h.host, ref)).anchors).toEqual(before.anchors);
      await h.host.document.undo(); // scratch path

      // Offset honors a payload delta on a CLOSED selection.
      const closed = await newClosedPath(h);
      const cref = { kind: closed.kind, id: closed.id as string };
      await h.host.selection.set([closed]);
      const cbefore = await liveTable(h.host, cref);
      await commandFor(h, OFFSET_PATH_COMMAND_ID).handler(undefined, {
        delta: 4,
      });
      expect((await liveTable(h.host, cref)).anchors).not.toEqual(
        cbefore.anchors,
      );
      await h.host.document.undo();
      await h.host.document.undo(); // scratch closed path
    });

    it("with NO selection each command is a no-op (no throw)", async () => {
      await h.host.selection.set([]);
      for (const id of [
        OUTLINE_STROKE_COMMAND_ID,
        OFFSET_PATH_COMMAND_ID,
        SIMPLIFY_PATH_COMMAND_ID,
      ]) {
        await expect(
          commandFor(h, id).handler(undefined),
        ).resolves.toBeUndefined();
      }
    });
  });
});
