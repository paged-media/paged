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

// Phase 4c conformance — the Curvature + Pencil authoring tools: the
// machines' commits feed `insertPathMutationFor` (the exported builder
// the live handlers send — no second copy to drift from), the engine
// accepts the insertPath, the created element's anchor table matches
// the committed run, and undo removes it. The pencil's full GESTURE
// handler is additionally driven pointer-by-pointer against the real
// host (the host-handler.spec pattern) to prove the wiring, preview
// channel included.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type {
  CanvasPointerEvent,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { CurvatureMachine, PencilMachine } from "@paged-media/draw-tools";

import {
  drawBundle,
  insertPathMutationFor,
  createPencilHandler,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const PAGE = F1_MULTI_SHAPE.pageId;

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
  for (let i = 0; i < 50; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("timed out waiting for the host-routed mutation to land");
}

async function leafCount(h: HeadlessHost): Promise<number> {
  const roots = await h.host.document.tree();
  let n = 0;
  const walk = (nodes: { id?: unknown; children?: unknown[] }[]) => {
    for (const node of nodes) {
      if (node.id) n++;
      if (node.children) walk(node.children as never);
    }
  };
  walk(roots as never);
  return n;
}

describe("draw conformance — curvature + pencil authoring (Phase 4c)", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  it("insertPathMutationFor emits the exact insertPath wire shape", () => {
    const m = insertPathMutationFor(
      PAGE,
      [
        { anchor: [0, 0], left: [-5, 0], right: [5, 0] },
        { anchor: [10, 10], left: [10, 10], right: [10, 10] },
      ],
      true,
    ) as Extract<Mutation, { op: "insertPath" }>;
    expect(m).toEqual({
      op: "insertPath",
      args: {
        pageId: PAGE,
        anchors: [
          { anchor: [0, 0], left: [-5, 0], right: [5, 0] },
          { anchor: [10, 10], left: [10, 10], right: [10, 10] },
        ],
        open: true,
      },
    });
  });

  it("a curvature commit (click·click·click + Enter) lands at the engine; undo removes it", async () => {
    const m = new CurvatureMachine({ closeTolerance: 6 });
    m.handle({ type: "down", point: [50, 50], modifiers: { alt: false } });
    m.handle({ type: "up", point: [50, 50] });
    m.handle({ type: "down", point: [150, 120], modifiers: { alt: false } });
    m.handle({ type: "up", point: [150, 120] });
    m.handle({ type: "down", point: [250, 50], modifiers: { alt: false } });
    m.handle({ type: "up", point: [250, 50] });
    const snap = m.handle({ type: "key", key: "Enter" });
    expect(snap.commit).not.toBeNull();

    const before = await leafCount(h);
    const outcome = await h.host.document.mutate(
      insertPathMutationFor(PAGE, snap.commit!.anchors, snap.commit!.open),
    );
    if (!outcome.applied) throw new Error("insertPath failed");
    expect(outcome.createdId).not.toBeNull();
    expect(await leafCount(h)).toBe(before + 1);
    // The created element's anchor table is the committed run (smooth
    // interior handles included).
    const table = await h.host.document.pathAnchors(outcome.createdId!);
    expect(table).not.toBeNull();
    expect(table!.anchors.map((a) => a.anchor)).toEqual([
      [50, 50],
      [150, 120],
      [250, 50],
    ]);
    const mid = table!.anchors[1];
    expect(mid.left).not.toEqual(mid.anchor); // smooth survived the engine
    expect(table!.subpathOpen?.[0]).toBe(true);
    await h.host.document.undo();
    expect(await leafCount(h)).toBe(before);
  });

  it("a closed curvature commit (click the first point) round-trips closed", async () => {
    const m = new CurvatureMachine({ closeTolerance: 6 });
    for (const p of [
      [300, 300],
      [400, 300],
      [400, 400],
    ] as [number, number][]) {
      m.handle({ type: "down", point: p, modifiers: { alt: false } });
      m.handle({ type: "up", point: p });
    }
    // The closing click commits on DOWN (the machine's click-on-first-
    // point gesture) — capture that snapshot.
    const snap = m.handle({
      type: "down",
      point: [302, 301],
      modifiers: { alt: false },
    });
    expect(snap.commit?.open).toBe(false);
    const outcome = await h.host.document.mutate(
      insertPathMutationFor(PAGE, snap.commit!.anchors, false),
    );
    if (!outcome.applied) throw new Error("insertPath failed");
    const table = await h.host.document.pathAnchors(outcome.createdId!);
    expect(table!.subpathOpen?.[0]).toBe(false);
    await h.host.document.undo();
  });

  it("a pencil commit (samples → RDP → smooth fit) lands at the engine; undo removes it", async () => {
    const m = new PencilMachine({ tolerance: 1.5, minSampleDistance: 0 });
    m.handle({ type: "down", point: [100, 200] });
    for (let x = 110; x <= 200; x += 10) {
      m.handle({ type: "move", point: [x, 200] }); // collinear — collapses
    }
    for (let y = 210; y <= 300; y += 10) {
      m.handle({ type: "move", point: [200, y] });
    }
    const snap = m.handle({ type: "up", point: [200, 300] });
    expect(snap.commit).not.toBeNull();
    expect(snap.commit!.anchors.length).toBeLessThan(20); // simplified

    const before = await leafCount(h);
    const outcome = await h.host.document.mutate(
      insertPathMutationFor(PAGE, snap.commit!.anchors, snap.commit!.open),
    );
    if (!outcome.applied) throw new Error("insertPath failed");
    const table = await h.host.document.pathAnchors(outcome.createdId!);
    expect(table!.anchors.length).toBe(snap.commit!.anchors.length);
    await h.host.document.undo();
    expect(await leafCount(h)).toBe(before);
  });

  it("the LIVE pencil gesture handler authors end-to-end through host.* facades", async () => {
    const handler = createPencilHandler(h.host);
    handler.onActivate(undefined as never);
    const before = await leafCount(h);

    handler.onPointerDown(pointer(PAGE, [500, 100]));
    handler.onPointerMove(pointer(PAGE, [520, 110], 20));
    // The in-flight stroke previews as a POLYLINE on the recorded
    // overlay channel.
    const preview = h.lastToolPreview();
    expect(preview).not.toBeNull();
    expect(preview && "points" in preview).toBe(true);
    handler.onPointerMove(pointer(PAGE, [560, 140], 60));
    handler.onPointerUp(pointer(PAGE, [560, 140], 60));

    await until(async () => (await leafCount(h)) === before + 1);
    // Commit clears the preview and selects the created path (the
    // selection lands a tick after the insert — poll it too).
    expect(h.lastToolPreview()).toBeNull();
    await until(async () => h.host.selection.get().length === 1);
    const sel = h.host.selection.get();
    expect(sel).toHaveLength(1);
    const table = await h.host.document.pathAnchors(sel[0] as ElementId);
    expect(table).not.toBeNull();
    expect(table!.anchors[0].anchor).toEqual([500, 100]);

    await h.host.document.undo();
    expect(await leafCount(h)).toBe(before);
    handler.onDeactivate("switch");
  });
});
