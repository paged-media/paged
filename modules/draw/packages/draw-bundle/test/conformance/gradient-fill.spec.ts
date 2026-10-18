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

// Conformance — gradient ASSIGNMENT through the bundle's document door
// (B-03, resolved engine-side; core pins the render truth in
// `paged-mutate/tests/gradient_fill.rs` — display list carries a
// gradient paint). THIS file pins the PLUGIN-side path: a bundle can
// create the gradient, point a frame fill at it and steer the gradient
// axis, all through `host.document.mutate` against the real published
// engine. It is the wire-path proof the fill panel (Phase 2d) builds on.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { drawBundle } from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const RECT = { kind: "rectangle", id: F1_MULTI_SHAPE.ids.rectangle! } as const;

describe("draw conformance — gradient fill assignment (B-03)", () => {
  let h: HeadlessHost;
  let stopA: string;
  let stopB: string;
  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
    h.loadBundle(drawBundle);
    // Two RGB stops for the ramp (created ids are `Color/u<n>`).
    const a = await h.host.document.mutate({
      op: "createSwatch",
      args: {
        spec: { name: "B03 A", space: "RGB", value: [255, 0, 0] },
      },
    } as never);
    const b = await h.host.document.mutate({
      op: "createSwatch",
      args: {
        spec: { name: "B03 B", space: "RGB", value: [0, 0, 255] },
      },
    } as never);
    if (!a.applied || !b.applied) throw new Error("swatch create failed");
    stopA = String(a.createdId);
    stopB = String(b.createdId);
  });
  afterAll(() => h?.dispose());

  it("createGradient lands in the gradients collection", async () => {
    // FINDING (pinned): `mutationApplied.createdId` is null for the
    // collection creates (it carries page-item ids only), so the bundle
    // names the gradient via `selfId` and reads it back through the
    // collection door.
    const out = await h.host.document.mutate({
      op: "createGradient",
      args: {
        spec: {
          selfId: "Gradient/ub03",
          name: "B03 Linear",
          kind: "Linear",
          stops: [
            { stopColor: stopA, locationPct: 0 },
            { stopColor: stopB, locationPct: 100 },
          ],
        },
      },
    } as never);
    expect(out.applied).toBe(true);
    const gradients = await h.host.document.collection("gradients");
    expect(JSON.stringify(gradients)).toContain("Gradient/ub03");
  });

  it("a frame fill accepts a Gradient/ ref and the axis properties steer it", async () => {
    const gid = "Gradient/ub03fill";
    const created = await h.host.document.mutate({
      op: "createGradient",
      args: {
        spec: {
          selfId: gid,
          name: "B03 Fill",
          kind: "Linear",
          stops: [
            { stopColor: stopA, locationPct: 0 },
            { stopColor: stopB, locationPct: 100 },
          ],
        },
      },
    } as never);
    expect(created.applied).toBe(true);
    expect(JSON.stringify(await h.host.document.collection("gradients"))).toContain(gid);

    // The B-03 crux: `setElementProperty{frameFillColor, colorRef}` with
    // a gradient id is a plain ref assignment (gradients share the
    // swatch namespace) — accepted, undoable.
    const fill = await h.host.document.mutate({
      op: "setElementProperty",
      args: {
        elementId: RECT,
        path: "frameFillColor",
        value: { type: "colorRef", value: gid },
      },
    } as never);
    expect(fill.applied).toBe(true);

    // The gradient-axis lane the on-canvas annotator (Phase 4c) will
    // drive: angle + length are `length` values on the same frame.
    const angle = await h.host.document.mutate({
      op: "setElementProperty",
      args: {
        elementId: RECT,
        path: "frameGradientFillAngle",
        value: { type: "length", value: 45 },
      },
    } as never);
    expect(angle.applied).toBe(true);

    // Unwind: angle, fill, gradient — the document is pristine again
    // for the suite's other files (and the inverses are themselves the
    // B-03 undo proof).
    await h.host.document.undo();
    await h.host.document.undo();
    await h.host.document.undo();
  });
});
