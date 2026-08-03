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

// Wave 2 conformance — the Width tool v0: the LIVE drag handler
// against the real engine. A drag near an anchor of the SELECTED open
// polygon bakes a peaked width profile through
// `outlineStrokeVariable` (DESTRUCTIVE — the open centerline becomes
// its closed swept outline; ONE mutation = one undo round-trip).
// Negative lanes: no selection, an off-anchor press, and a CLOSED
// path all no-op (the documented v0 gates).

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { CanvasPointerEvent, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { drawBundle, createWidthHandler } from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const POLY = { kind: "polygon", id: "upoly" } as ElementId;
const RECT = { kind: "rectangle", id: "urect" } as ElementId;

function pointer(
  pageId: string,
  point: [number, number],
  maxDelta = 0,
): CanvasPointerEvent {
  return {
    pageId,
    pagePoint: point,
    docPoint: point,
    modifiers: { shift: false, alt: false, cmd: false, ctrl: false },
    maxDelta,
    button: 0,
    target: null,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    pointerType: "mouse",
  };
}

async function until(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 4));
  }
  throw new Error("timed out waiting for the width bake to land");
}

function drag(
  handler: ReturnType<typeof createWidthHandler>,
  pageId: string,
  from: [number, number],
  to: [number, number],
): void {
  handler.onActivate(undefined as never);
  handler.onPointerDown(pointer(pageId, from));
  handler.onPointerMove(pointer(pageId, to, 30));
  handler.onPointerUp(pointer(pageId, to, 30));
}

describe("draw conformance — width tool v0 (wave 2)", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  it("a drag on the selected open polygon's middle anchor bakes the outline (one undo)", async () => {
    await h.host.selection.set([POLY]);
    const before = await h.host.document.pathAnchors(POLY);
    expect(before!.subpathOpen?.[0]).toBe(true);
    expect(before!.anchors).toHaveLength(3);

    const handler = createWidthHandler(h.host);
    // upoly's middle anchor sits at (250, 600); drag 20 pt upward.
    drag(handler, F1_MULTI_SHAPE.pageId, [250, 600], [250, 580]);

    // The DESTRUCTIVE bake: the element becomes its CLOSED swept
    // outline (identity preserved — same id, new geometry).
    await until(async () => {
      const t = await h.host.document.pathAnchors(POLY);
      return !!t && t.subpathOpen?.[0] === false;
    });
    const baked = await h.host.document.pathAnchors(POLY);
    expect(baked!.anchors.length).toBeGreaterThanOrEqual(4);

    // ONE mutation = ONE undo step returns the open centerline.
    await h.host.document.undo();
    await until(async () => {
      const t = await h.host.document.pathAnchors(POLY);
      return !!t && t.subpathOpen?.[0] === true && t.anchors.length === 3;
    });
    handler.onDeactivate("switch");
  });

  it("an off-anchor press is inert", async () => {
    await h.host.selection.set([POLY]);
    const before = await h.host.document.pathAnchors(POLY);
    const handler = createWidthHandler(h.host);
    // (250, 450) is > 8 px-pt from every anchor of upoly.
    drag(handler, F1_MULTI_SHAPE.pageId, [250, 450], [250, 430]);
    await new Promise((r) => setTimeout(r, 100));
    const after = await h.host.document.pathAnchors(POLY);
    expect(after!.anchors.length).toBe(before!.anchors.length);
    expect(after!.subpathOpen?.[0]).toBe(true);
    handler.onDeactivate("switch");
  });

  it("no path-bearing selection → no-op", async () => {
    await h.host.selection.set([]);
    const before = await h.host.document.pathAnchors(POLY);
    const handler = createWidthHandler(h.host);
    drag(handler, F1_MULTI_SHAPE.pageId, [250, 600], [250, 580]);
    await new Promise((r) => setTimeout(r, 100));
    const after = await h.host.document.pathAnchors(POLY);
    expect(after!.anchors.length).toBe(before!.anchors.length);
    handler.onDeactivate("switch");
  });

  it("a CLOSED path is refused (the v0 open-single-contour gate)", async () => {
    await h.host.selection.set([RECT]);
    const before = await h.host.document.pathAnchors(RECT);
    const handler = createWidthHandler(h.host);
    // (100, 100) is the rectangle's first corner anchor.
    drag(handler, F1_MULTI_SHAPE.pageId, [100, 100], [80, 80]);
    await new Promise((r) => setTimeout(r, 100));
    const after = await h.host.document.pathAnchors(RECT);
    expect(after!.anchors.length).toBe(before!.anchors.length);
    expect(after!.subpathOpen?.[0]).toBe(before!.subpathOpen?.[0]);
    handler.onDeactivate("switch");
  });
});
