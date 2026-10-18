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

// B-17 — the facade-migration proof (DESIGN.md §4.9). The anchor-edit
// GESTURE HANDLER (not just the planner) is now built from a host-bound
// factory `createAnchorEditHandler(mode, host)` and routes EVERY engine
// touch through the `host.*` facades:
//   · selection    → host.selection.get()
//   · path anchors → host.document.pathAnchors
//   · zoom→pt      → host.viewport.pxToPt
//   · write        → host.document.mutate
// No `paged.client.*` / `paged.selection.*` / `paged.camera.*` raw-spine
// reach remains.
//
// This drives a REAL pointer-up through the migrated handler against the
// REAL headless engine and asserts (1) the host-routed mutate lands the
// anchor the planner planned, and (2) the handler's effect EQUALS the
// bundle's own `mutationFor(plan)` (the no-drift guarantee). A
// structural check then asserts the handler source carries no raw-spine
// reach.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { CanvasPointerEvent } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { planAnchorAdd } from "@paged-media/draw-tools";

import { createAnchorEditHandler } from "../../src/handlers/anchors";
import { mutationFor } from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { liveTable } from "../replay";
import { openHost } from "./host";

// A plain element ref (as the replay spec uses) — `liveTable` takes the
// structural `{kind,id}` shape; the facades take the `ElementId` union.
const POLY = (id: string) => ({ kind: "polygon" as const, id });

/** A synthetic primary-button click pointer-up at a page-local point. */
function clickUp(pageId: string, point: [number, number]): CanvasPointerEvent {
  return {
    pageId,
    pagePoint: point,
    docPoint: point,
    modifiers: { shift: false, alt: false, cmd: false, ctrl: false },
    maxDelta: 0,
    button: 0,
    target: null,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    pointerType: "mouse",
  };
}

/** Wait until `predicate()` resolves truthy (the handler's onPointerUp
 *  is fire-and-forget — poll the engine for the landed mutation). */
async function until(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("timed out waiting for the host-routed mutation to land");
}

describe("draw conformance — host-routed anchor handler (B-17)", () => {
  let h: HeadlessHost;
  const el = POLY(F1_MULTI_SHAPE.ids.polygon!);
  // Segment-0 midpoint of the open polygon ([100,400]→[250,600]).
  const click: [number, number] = [175, 500];

  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
  });
  afterAll(() => h?.dispose());

  it("the migrated handler routes hitTest/selection/anchors/mutate through host.* facades", async () => {
    // Build the handler bound to the REAL host (the dogfooding shape).
    const handler = createAnchorEditHandler("add", h.host);
    // onActivate is a host-routed no-op now (no raw spine to capture).
    handler.onActivate(undefined as never);

    // Select the polygon so the handler's selection FALLBACK resolves
    // the target (host.selection.get()) — exercising the facade path
    // even when hitTest finds nothing for the synthetic point.
    await h.host.selection.set([el]);

    const before = (await liveTable(h.host, el)).anchors.length;

    // Fire the click. onPointerUp dispatches act() fire-and-forget.
    handler.onPointerUp(clickUp(F1_MULTI_SHAPE.pageId, click));

    // The host-routed mutate lands exactly one new anchor.
    await until(async () => (await liveTable(h.host, el)).anchors.length === before + 1);
    const after = await liveTable(h.host, el);
    expect(after.anchors.length).toBe(before + 1);
    // The inserted anchor (index 1, between the endpoints) sits at the
    // clicked midpoint.
    expect(after.anchors[1].anchor).toEqual(click);

    // Restore for the no-drift comparison below.
    await h.host.document.undo();
    expect((await liveTable(h.host, el)).anchors.length).toBe(before);
  });

  it("the handler's effect EQUALS the bundle's own mutationFor(plan) (no drift)", async () => {
    // Compute the plan the planner produces for this click (identity
    // itemTransform on the fixture → page-local == path-local), then the
    // mutation the bundle's exported translator emits for it.
    const table = await liveTable(h.host, el);
    const plan = planAnchorAdd(table, click, 6);
    expect(plan?.kind).toBe("insert");
    const expected = mutationFor(plan!, el);

    // Apply the EXPECTED mutation directly through the host door and
    // snapshot the result.
    const directOutcome = await h.host.document.mutate(expected);
    expect(directOutcome.applied).toBe(true);
    const viaMutationFor = await liveTable(h.host, el);
    await h.host.document.undo();

    // Drive the migrated HANDLER for the same click and snapshot.
    const handler = createAnchorEditHandler("add", h.host);
    handler.onActivate(undefined as never);
    await h.host.selection.set([el]);
    const base = (await liveTable(h.host, el)).anchors.length;
    handler.onPointerUp(clickUp(F1_MULTI_SHAPE.pageId, click));
    await until(async () => (await liveTable(h.host, el)).anchors.length === base + 1);
    const viaHandler = await liveTable(h.host, el);
    await h.host.document.undo();

    // Same anchor table either way — the handler emits the bundle's own
    // mutationFor output, just routed through host.document.mutate.
    expect(viaHandler.anchors).toEqual(viaMutationFor.anchors);
  });

  it("no raw spine remains — anchors.ts reaches the engine only through host.* facades", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/handlers/anchors.ts", import.meta.url)),
      "utf8",
    );
    // The five raw-spine reaches the B-17 migration removed.
    expect(src).not.toMatch(/paged\.client/);
    expect(src).not.toMatch(/paged\.selection/);
    expect(src).not.toMatch(/paged\.camera/);
    expect(src).not.toMatch(/\.elementSelection/);
    expect(src).not.toMatch(/client\.send|client\.mutate|client\.pathAnchors/);
    // It DOES route through the facades.
    expect(src).toMatch(/host\.document\.hitTest/);
    expect(src).toMatch(/host\.document\.pathAnchors/);
    expect(src).toMatch(/host\.document\.mutate/);
    expect(src).toMatch(/host\.selection\.get\(\)/);
    expect(src).toMatch(/host\.viewport\.pxToPt/);
  });
});
