// The conformance REPLAY harness — the B-13-foundation "next step".
//
// WHAT IT REPLAYS. The draw tools are click tools over pure PLANNERS:
// a pointer-up on a path produces an `AnchorEditPlan` (add/delete/
// convert) which the bundle translates to one engine `Mutation` and
// sends through `host.document.mutate`. This harness records that PLAN
// — the deterministic OUTPUT of the tool's machine, parameterised by a
// page-local click — and replays it through the REAL headless engine,
// asserting on the resulting anchor table + undo restoration.
//
// HOW PLANS ARE RECORDED. A `GesturePlan` is `{ tool, click,
// tolerance }`: the same triple the live `createAnchorEditHandler`
// computes from a pointer-up (it resolves the target, reads
// `pathAnchors`, maps page→path-local, then calls the planner). The
// harness short-circuits the pointer/hit-test/camera plumbing (that
// couples to B-17, the raw-spine gesture path) and drives the planner
// directly against the engine's live `pathAnchors`, then replays the
// bundle's OWN `mutationFor` — so the mutation under test is verbatim
// what the tool emits, not a test-local re-derivation.
//
// WHY NOT POINTER-LEVEL. Replaying real pointer events through the
// tool's `gesture()` machine against the headless engine is the deeper
// step gated on B-17 (handlers reach the raw spine, not the async
// facades) — recorded as a residual on B-13. This harness proves the
// PLAN→engine contract, which is the load-bearing half.

import { expect } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";
import type { AnchorTable } from "@paged-media/draw-geometry";
import type { AnchorEditPlan } from "@paged-media/draw-tools";
import {
  planAnchorAdd,
  planAnchorDelete,
  planAnchorConvert,
} from "@paged-media/draw-tools";
import { mutationFor, type AnchorEditMode } from "../src";

/** A recorded gesture: which anchor tool fired, the page-local click,
 *  and the pick tolerance (page-local pt). Replayable + serialisable. */
export interface GesturePlan {
  tool: AnchorEditMode;
  /** Page-local click point (the fixtures use identity itemTransform,
   *  so page-local == path-local). */
  click: [number, number];
  tolerance: number;
}

type ElementRef = { kind: string; id: string };

/** Compute the plan a recorded gesture produces against a live anchor
 *  table — the planner half of `createAnchorEditHandler`. Returns null
 *  exactly when the tool would no-op (no hit within tolerance, or a
 *  refused delete). */
export function planFor(
  table: AnchorTable,
  g: GesturePlan,
): AnchorEditPlan | null {
  switch (g.tool) {
    case "add":
      return planAnchorAdd(table, g.click, g.tolerance);
    case "delete":
      return planAnchorDelete(table, g.click, g.tolerance);
    case "convert":
      return planAnchorConvert(table, g.click, g.tolerance);
  }
}

/** Read a path element's current anchor table through the engine. */
export async function liveTable(
  host: HeadlessHost["host"],
  element: ElementRef,
): Promise<AnchorTable> {
  const r = await host.document.pathAnchors(element as never);
  if (!r) throw new Error(`no path anchors for ${element.kind}:${element.id}`);
  return {
    anchors: r.anchors,
    subpathStarts: r.subpathStarts,
    subpathOpen: r.subpathOpen,
  };
}

export interface ReplayResult {
  /** The plan the recorded gesture produced (null = tool no-op). */
  plan: AnchorEditPlan | null;
  /** Anchor count before the mutation. */
  before: number;
  /** Anchor count after the mutation applied. */
  after: number;
  /** Anchor count after one undo (should equal `before`). */
  restored: number;
  /** The anchor table after apply (for geometry assertions). */
  appliedTable: AnchorTable;
}

/**
 * Replay one recorded gesture against the live engine: read the table,
 * plan, translate with the BUNDLE's `mutationFor`, mutate, assert
 * applied, then undo. Returns the before/after/restored counts plus
 * the applied table so a spec can assert the inserted geometry.
 *
 * Asserts internally that the mutation applied; the caller asserts the
 * domain shape (count deltas, anchor coordinates, undo restoration).
 */
export async function replayGesture(
  host: HeadlessHost["host"],
  element: ElementRef,
  g: GesturePlan,
): Promise<ReplayResult> {
  const startTable = await liveTable(host, element);
  const before = startTable.anchors.length;
  const plan = planFor(startTable, g);
  if (!plan) {
    return {
      plan: null,
      before,
      after: before,
      restored: before,
      appliedTable: startTable,
    };
  }
  const mutation = mutationFor(plan, element as never);
  const outcome = await host.document.mutate(mutation);
  expect(outcome.applied).toBe(true);
  const appliedTable = await liveTable(host, element);
  const after = appliedTable.anchors.length;
  await host.document.undo();
  const restored = (await liveTable(host, element)).anchors.length;
  return { plan, before, after, restored, appliedTable };
}
