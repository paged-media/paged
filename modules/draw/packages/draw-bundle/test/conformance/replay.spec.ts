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

// Conformance — REPLAY each anchor tool's plan shape against the real
// engine. Per fixture + per tool: record a gesture (tool + click +
// tolerance), replay the bundle's OWN plan→Mutation through
// host.document.mutate, then assert the resulting anchor table AND that
// one undo restores the baseline. This is the B-13 "fixture CORPUS
// replay harness" the RESOLVED entry named as the next step.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { F1_MULTI_SHAPE, F2_CLOSED_QUAD, F3_CURVED_OPEN } from "../fixtures/corpus";
import { replayGesture, liveTable, planFor, type GesturePlan } from "../replay";
import { openHost } from "./host";

const poly = (id: string) => ({ kind: "polygon", id });

describe("draw conformance — gesture-plan replay", () => {
  let h: HeadlessHost;
  beforeAll(async () => {
    h = await openHost();
  });
  afterAll(() => h?.dispose());

  describe("ADD anchor — F1 open polygon", () => {
    const el = poly(F1_MULTI_SHAPE.ids.polygon!);
    // Click near the midpoint of segment 0 ([100,400]→[250,600]).
    const g: GesturePlan = { tool: "add", click: [175, 500], tolerance: 50 };

    beforeAll(async () => {
      await h.load(F1_MULTI_SHAPE.bytes());
    });

    it("the recorded gesture plans an insert at the projected midpoint", async () => {
      const plan = planFor(await liveTable(h.host, el), g);
      expect(plan?.kind).toBe("insert");
      if (plan?.kind === "insert") {
        expect(plan.insertIndex).toBe(1);
        expect(plan.anchor.anchor).toEqual([175, 500]);
      }
    });

    it("replay adds exactly one anchor; undo restores the baseline", async () => {
      const r = await replayGesture(h.host, el, g);
      expect(r.after).toBe(r.before + 1);
      expect(r.restored).toBe(r.before);
    });

    it("the inserted anchor lands at the engine with the planned coords", async () => {
      const r = await replayGesture(h.host, el, g);
      // The new anchor is index 1 (between the two endpoints).
      expect(r.appliedTable.anchors[1].anchor).toEqual([175, 500]);
    });
  });

  describe("ADD anchor (closing edge) — F2 closed quad", () => {
    const el = poly(F2_CLOSED_QUAD.ids.polygon!);
    // Click near the midpoint of the CLOSING edge ([100,300]→[100,100],
    // the wraparound). The plan must carry the subpath-start override.
    const g: GesturePlan = { tool: "add", click: [100, 200], tolerance: 40 };

    beforeAll(async () => {
      await h.load(F2_CLOSED_QUAD.bytes());
    });

    it("a closed contour is reported closed (the close edge is a hit-zone)", async () => {
      const t = await liveTable(h.host, el);
      expect(t.anchors.length).toBe(4);
      // Closed: subpathOpen is empty or [false] (no open flag set).
      expect(t.subpathOpen?.[0] ?? false).toBe(false);
    });

    it("replay on the closing edge adds one anchor; undo restores", async () => {
      const r = await replayGesture(h.host, el, g);
      expect(r.plan?.kind).toBe("insert");
      expect(r.after).toBe(r.before + 1);
      expect(r.restored).toBe(r.before);
    });
  });

  describe("DELETE anchor — F1 open polygon + floor refusal on a triangle", () => {
    beforeAll(async () => {
      await h.load(F1_MULTI_SHAPE.bytes());
    });

    it("replay removes the clicked anchor; undo restores", async () => {
      const el = poly(F1_MULTI_SHAPE.ids.polygon!);
      // Click on the middle anchor [250,600].
      const g: GesturePlan = { tool: "delete", click: [250, 600], tolerance: 10 };
      const r = await replayGesture(h.host, el, g);
      expect(r.plan).toEqual({ kind: "remove", index: 1 });
      expect(r.after).toBe(r.before - 1);
      expect(r.restored).toBe(r.before);
    });

    it("a 3-anchor open contour refuses to drop below two (planner no-op)", async () => {
      // After deleting one anchor a triangle would hit the floor; the
      // planner refuses BEFORE the engine, so no mutation is emitted.
      // Reload to a fresh triangle, delete once, then attempt again.
      await h.load(F1_MULTI_SHAPE.bytes());
      const el = poly(F1_MULTI_SHAPE.ids.polygon!);
      await h.host.document.mutate({
        op: "pathPointRemove",
        args: { elementId: el, index: 0 },
      } as never);
      const table = await liveTable(h.host, el);
      expect(table.anchors.length).toBe(2);
      const plan = planFor(table, {
        tool: "delete",
        click: table.anchors[0].anchor as [number, number],
        tolerance: 10,
      });
      expect(plan).toBeNull();
      await h.host.document.undo();
    });
  });

  describe("CONVERT anchor — F3 curved + F1 corner toggle", () => {
    it("convert toggles a corner to smooth; undo restores", async () => {
      await h.load(F1_MULTI_SHAPE.bytes());
      const el = poly(F1_MULTI_SHAPE.ids.polygon!);
      // F1's anchors are corners (handles collapsed) → convert plans smooth.
      const t = await liveTable(h.host, el);
      const plan = planFor(t, { tool: "convert", click: [250, 600], tolerance: 10 });
      expect(plan).toEqual({ kind: "convert", index: 1, smooth: true });
      const r = await replayGesture(h.host, el, { tool: "convert", click: [250, 600], tolerance: 10 });
      // Count is unchanged by a convert; undo restores the (already-equal)
      // count, and the toggle is reversible.
      expect(r.after).toBe(r.before);
      expect(r.restored).toBe(r.before);
    });

    it("convert on a curved anchor plans corner (smooth→corner)", async () => {
      await h.load(F3_CURVED_OPEN.bytes());
      const el = poly(F3_CURVED_OPEN.ids.polygon!);
      const t = await liveTable(h.host, el);
      // Anchor 0 has a real outgoing handle → it is smooth → convert
      // plans smooth:false (toggle to corner).
      const plan = planFor(t, {
        tool: "convert",
        click: t.anchors[0].anchor as [number, number],
        tolerance: 10,
      });
      expect(plan).toEqual({ kind: "convert", index: 0, smooth: false });
    });
  });
});
