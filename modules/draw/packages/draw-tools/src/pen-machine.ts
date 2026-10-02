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

// The Pen tool's state machine — host-agnostic: page-local pt points
// in, a snapshot (in-progress anchors + rubber band + optional
// commit) out. The editor's gesture handler is a thin shim that
// page-anchors pointer events, feeds them here, flattens the
// snapshot into the tool-preview polyline, and turns the commit into
// one `insertPath` Mutation. Keeping the modifier matrix here makes
// it unit-testable without a browser and portable to a future
// isolate unchanged.
//
// v1 modifier matrix (Illustrator parity, §13.1 of the concept):
//   click            → corner anchor (handles collapsed)
//   drag             → smooth anchor (right handle follows pointer,
//                      left mirrors)
//   Alt during drag  → break the pair: left handle freezes at its
//                      last mirrored position, right keeps following
//   Shift + click    → constrain the new anchor to 45° from the
//                      previous anchor
//   Shift + drag     → constrain the handle pull to 45°
//   click 1st anchor → close the path (commit { open: false })
//   Enter            → commit the open path (≥ 2 anchors)
//   Escape           → cancel
//
// v2 — EXISTING PATHS. v1 could only author a NEW path. With a hit
// description on the event (which the HOST computes — the machine never
// queries anything), the same machine now works on paths that already
// exist:
//
//   press an open path's ENDPOINT, nothing in progress
//                    → CONTINUE it: the endpoint becomes the run's first
//                      anchor (dragging off it pulls a fresh outgoing
//                      handle and leaves the incoming one alone), and
//                      the anchors placed after it commit as
//                      `pathPointInsert`s on THAT element — appended
//                      after its last anchor, or prepended before its
//                      first when the start was the end picked.
//   …then its OTHER endpoint
//                    → CLOSE it: the inserts, then `closePath`.
//   …then ANOTHER open path's endpoint
//                    → JOIN: the inserts, then `joinPaths`.
//   a NEW run, then an open path's endpoint
//                    → EXTEND that path with the run (inserts only — the
//                      run was never an element, so there is nothing to
//                      join).
//   Enter while continuing → commit the inserts.
//   hover / press an anchor or a segment of the SELECTED path, nothing
//   in progress      → the DELETE / ADD intent (a cursor for the host),
//                      and the click plans exactly that edit.
//
// Every one of those commits is ONE batch — one undo step.
//
// COORDINATE SPACES. Event points and the snapshot are in POINTER space
// (the editor's page-local pt). An existing path's table is in its own
// INNER space; `PenPath.transform` maps inner → pointer, and every op a
// plan carries is already back in the inner space of the element it
// addresses.
//
// WHAT THE WIRE CANNOT SAY, and what the machine therefore refuses —
// each resolves to the plain "draw" intent rather than a plan the
// engine would reject or, worse, apply to the wrong ends:
//
//   · `joinPaths { elementId, otherId }` names no ENDPOINTS: the engine
//     welds whichever pair of ends is nearest. The plan makes the picked
//     pair the nearest by first inserting, on the continued path, an
//     anchor coincident with the picked endpoint (distance zero — and a
//     coincident weld merges the two, so no anchor is left over). It
//     keeps the handle the picked endpoint was dangling, so the bridging
//     segment is the one the two paths' own handles describe.
//   · `joinPaths` concatenates RAW anchors — the two elements' item
//     transforms are not composed in — so a join across two different
//     transforms would land the second path's geometry in the wrong
//     place. Refused unless the transforms are equal.
//   · `joinPaths` refuses a multi-contour element, and there is no op at
//     all that welds two open contours of ONE element. Both refused.

import {
  applyAffine,
  clampPressure,
  clone,
  constrainAngle,
  cornerAnchor,
  dist,
  IDENTITY_AFFINE,
  inverseApplyAffine,
  mirrorHandle,
  type Affine,
  type AnchorTable,
  type AnchorTriple,
  type Vec2,
  type Vec2Mut,
} from "@paged-media/draw-geometry";

import type { ElementId, ToolPreviewPath } from "@paged-media/plugin-api";

import {
  planAnchorAddAt,
  planAnchorDeleteAt,
  type AnchorEditPlan,
} from "./anchor-machine";
import {
  anchorEditOps,
  targetedPathEditBatch,
  type InsertPathWire,
  type PathEditBatchWire,
  type TargetedPathOp,
} from "./path-edit-ops";

// The pressure → stroke-width seam moved to draw-geometry (zero-dep pure
// math the editor's Pencil re-imports too); re-exported here so existing
// draw-tools consumers keep their import site.
export {
  strokeWidthFromPressure,
  type StrokeWidthProfile,
} from "@paged-media/draw-geometry";

export interface PenModifiers {
  shift: boolean;
  alt: boolean;
}

/**
 * Optional Pointer-Events sample carried alongside a pen event (B-08).
 * The machine stays geometry-pure — it records the pressure at each
 * anchor but never branches on it; consumers turn the recorded profile
 * into a variable-width stroke via a width hook (`strokeWidthFromPressure`)
 * once the engine can render one (§13.12, Tier B residual). `pressure`
 * is 0..1 with browser semantics (mouse 0/0.5; pen physical).
 */
export interface PenSample {
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
}

/** An existing path the pointer is over, as the host read it. */
export interface PenPath {
  id: ElementId;
  /** The path's anchor table in its own INNER space — `pathAnchors`'
   *  reply verbatim. */
  table: AnchorTable;
  /** Inner → pointer space (`itemTransform`). Null / omitted =
   *  identity. */
  transform?: Affine | null;
  /** Is this the selected path? Only a selected path offers the
   *  add / delete anchor intents; an endpoint can be picked up on any
   *  path. */
  selected?: boolean;
}

/** What the pointer is over — computed by the HOST. */
export type PenHit =
  /** An anchor dot; `index` is flat across contours. */
  | { kind: "anchor"; path: PenPath; index: number }
  /** A point on a segment: `index` is the flat index of the segment's
   *  START anchor, `t` the cubic parameter. */
  | { kind: "segment"; path: PenPath; index: number; t: number }
  | { kind: "empty" };

/** What a press here would do — the host turns it into a cursor. */
export type PenIntent =
  /** Place an anchor (the plain pen). */
  | "draw"
  /** Pick up an open path's endpoint and continue it. */
  | "continue"
  /** Close the path in progress. */
  | "close"
  /** End on another open path's endpoint, joining it. */
  | "join"
  /** Add an anchor on the selected path's segment. */
  | "add"
  /** Delete the selected path's anchor. */
  | "delete";

export type PenEvent =
  | {
      type: "down";
      point: Vec2;
      modifiers: PenModifiers;
      sample?: PenSample;
      /** Omitted = empty space (v1 behaviour, unchanged). */
      hit?: PenHit;
      /** EVERY path under the pointer, for the machine to rank (see
       *  "RANKING" below). Combined with `hit` when both are given. */
      hits?: readonly PenHit[];
    }
  | {
      type: "move";
      point: Vec2;
      modifiers: PenModifiers;
      sample?: PenSample;
      hit?: PenHit;
      hits?: readonly PenHit[];
    }
  | { type: "up"; point: Vec2; modifiers: PenModifiers; sample?: PenSample }
  | { type: "key"; key: "Enter" | "Escape" };

export interface PenCommit {
  anchors: AnchorTriple[];
  open: boolean;
}

/**
 * Everything a pen gesture can commit. `insertPath` is a NEW element
 * (anchors in pointer space, as `PenCommit` always was); every other
 * kind edits existing elements through `ops`, which are in apply order
 * and already in each element's inner space. Lower with
 * `penPlanMutation`.
 */
export type PenPlan =
  | { kind: "insertPath"; anchors: AnchorTriple[]; open: boolean }
  | {
      kind:
        | "continue"
        | "close"
        | "join"
        | "extend"
        | "addAnchor"
        | "deleteAnchor";
      ops: TargetedPathOp[];
    };

/** What the host renders/acts on after each event. */
export interface PenSnapshot {
  /** Anchors placed so far (live — includes the one being dragged).
   *  When continuing an existing path, anchor 0 IS that path's picked
   *  endpoint, in pointer space. */
  anchors: readonly AnchorTriple[];
  /** Per-anchor pressure 0..1, parallel to `anchors` (B-08). The
   *  pressure recorded when each anchor was placed; `0.5` when the
   *  event carried no sample (mouse). The pen-stroke-width hook
   *  (`strokeWidthFromPressure`) turns this profile into a
   *  variable-width stroke — pending engine support (§13.12 Tier B). */
  pressures: readonly number[];
  /** Hover point for the rubber band from the last anchor (null
   *  while the pointer is down or the path is empty/inactive). Snaps to
   *  the endpoint a close / join would land on. */
  rubberTo: Vec2 | null;
  /** Hovering within close-tolerance of the first anchor. */
  closePreview: boolean;
  /** What a press at the last reported position does (the press's own
   *  intent while the pointer is down). */
  intent: PenIntent;
  /** The element being continued, if any. */
  continuing: ElementId | null;
  /** Non-null exactly once, when a NEW path completes. */
  commit: PenCommit | null;
  /** Non-null exactly once per committed gesture — the superset of
   *  `commit`: a new path arrives here as `insertPath`, an edit to an
   *  existing one as its ops. */
  plan: PenPlan | null;
  /** False once committed or cancelled — the shim resets then. An
   *  add / delete anchor click plans WITHOUT ending the machine. */
  active: boolean;
  /** The hit `intent` was resolved from — the winner of the ranking when
   *  the event carried several (`hits`), null over empty space or once
   *  the machine is done. What the host highlights. */
  hit: PenHit | null;
}

export interface PenOptions {
  /** Click-on-first-anchor radius, page-local pt (host converts a
   *  screen tolerance at the current zoom). */
  closeTolerance: number;
  /** Pointer travel (pt) below which a down→up is a click, not a
   *  handle drag. */
  dragThreshold?: number;
}

/** Lower a plan to the ONE mutation `host.document.mutate` takes: an
 *  `insertPath` on `pageId` for a new path, otherwise one `batch`. */
export function penPlanMutation(
  plan: PenPlan,
  pageId: string,
): InsertPathWire | PathEditBatchWire {
  if (plan.kind === "insertPath") {
    return {
      op: "insertPath",
      args: { pageId, anchors: plan.anchors, open: plan.open, smooth: false },
    };
  }
  return targetedPathEditBatch(plan.ops);
}

const DEFAULT_DRAG_THRESHOLD = 2;

/** Pressure recorded for a mouse anchor (no physical sample). Matches
 *  the host's mouse-pressure default (Pointer Events: 0.5 while a
 *  button is held). */
const MOUSE_PRESSURE = 0.5;

/** Two item transforms closer than this, component-wise, are the same
 *  space as far as a raw-anchor join is concerned. */
const TRANSFORM_EPS = 1e-9;

/** One end of an OPEN contour of an existing path. */
export interface PenEndpoint {
  path: PenPath;
  /** Subpath index. */
  contour: number;
  /** The contour's flat range, `[from, to)`. */
  from: number;
  to: number;
  /** The endpoint's flat index. */
  index: number;
  end: "start" | "end";
}

type Endpoint = PenEndpoint;

/** The path being continued: the endpoint it was picked up at, plus
 *  the outgoing handle that endpoint had (to tell whether a drag
 *  changed it). */
interface Origin extends Endpoint {
  outgoing: Vec2Mut;
}

type Resolved =
  | { intent: "draw" }
  | { intent: "continue" | "close" | "join"; endpoint: Endpoint }
  | { intent: "add" | "delete"; path: PenPath; edit: AnchorEditPlan };

/** What the current press will do on release, when it is not placing an
 *  anchor. */
type Press =
  | { kind: "closeNew" }
  | { kind: "closeOrigin" }
  | { kind: "join"; endpoint: Endpoint }
  | { kind: "edit"; plan: PenPlan };

const DRAW: Resolved = { intent: "draw" };

/**
 * RANKING — what a press does when SEVERAL paths are under the pointer
 * (`PenEvent.hits`). Each candidate is resolved exactly as a single
 * `hit` would be, and the winner is the first by, in order:
 *
 *   1. it DOES something — any intent beats "draw" (a hit the machine
 *      cannot use, e.g. an interior anchor of an unselected path, never
 *      shadows one it can);
 *   2. it is on the SELECTED path — the path being edited wins a tie
 *      against one that merely passes under the pointer;
 *   3. its intent, most specific first: close, join, continue, delete,
 *      add;
 *   4. an ANCHOR hit before a SEGMENT hit;
 *   5. the host's own order — so a host that lists nearest-first (or
 *      topmost-first) keeps that as the last word.
 */
const INTENT_RANK: Record<PenIntent, number> = {
  close: 0,
  join: 1,
  continue: 2,
  delete: 3,
  add: 4,
  draw: 5,
};

function sameElement(a: ElementId, b: ElementId): boolean {
  return (
    a.kind === b.kind && JSON.stringify(a.id) === JSON.stringify(b.id)
  );
}

function sameTransform(
  a: Affine | null | undefined,
  b: Affine | null | undefined,
): boolean {
  const m = a ?? IDENTITY_AFFINE;
  const n = b ?? IDENTITY_AFFINE;
  return m.every((v, i) => Math.abs(v - n[i]) <= TRANSFORM_EPS);
}

function lexLess(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

function invertible(m: Affine | null | undefined): boolean {
  return !m || inverseApplyAffine(m, 0, 0) !== null;
}

function contourCount(table: AnchorTable): number {
  return Math.max(1, table.subpathStarts.length);
}

/** The open-contour endpoint at `index`, or null when that anchor is
 *  interior or its contour is closed. A one-anchor open contour's only
 *  anchor is its END (continuing it appends). Exported as
 *  `penEndpointAt` — the test the machine ranks hits with, so a host
 *  drawing endpoint markers asks the same question. */
export function penEndpointAt(path: PenPath, index: number): PenEndpoint | null {
  return endpointAt(path, index);
}

function endpointAt(path: PenPath, index: number): Endpoint | null {
  const { table } = path;
  const n = table.anchors.length;
  if (!Number.isInteger(index) || index < 0 || index >= n) return null;
  const starts = table.subpathStarts.length > 0 ? table.subpathStarts : [0];
  for (let si = 0; si < starts.length; si++) {
    const from = starts[si];
    const to = si + 1 < starts.length ? starts[si + 1] : n;
    if (index < from || index >= to) continue;
    if (!(table.subpathOpen?.[si] ?? false)) return null;
    if (index === to - 1) {
      return { path, contour: si, from, to, index, end: "end" };
    }
    if (index === from) {
      return { path, contour: si, from, to, index, end: "start" };
    }
    return null;
  }
  return null;
}

function toPointer(m: Affine | null | undefined, p: Vec2): Vec2Mut {
  return m ? applyAffine(m, p[0], p[1]) : clone(p);
}

function toInner(m: Affine | null | undefined, p: Vec2): Vec2Mut {
  // Callers only reach here for a transform `invertible` accepted.
  return (m ? inverseApplyAffine(m, p[0], p[1]) : null) ?? clone(p);
}

/**
 * Attach `run` to an open contour at `endpoint`, as inserts on that
 * element. `run` is in the element's INNER space, ordered AWAY from the
 * endpoint, and each anchor is oriented the same way: `left` points
 * back toward the endpoint, `right` onward.
 *
 *   END   → appended in order after the contour's last anchor. Unless
 *           the contour is the path's last, each insert carries the
 *           contour starts as they must read afterwards: the engine's
 *           default bumps only the starts strictly greater than the
 *           insert index, which would file the anchor as the first
 *           point of the NEXT contour.
 *   START → each inserted AT the contour's first index, so the run ends
 *           up reversed in front of it — and since the path now runs
 *           toward the old start, every anchor's handles swap roles.
 *           The default start rule is exactly right here (the start
 *           equal to the index stays put).
 */
function attachRun(
  endpoint: Endpoint,
  run: readonly AnchorTriple[],
): TargetedPathOp[] {
  const elementId = endpoint.path.id;
  const starts = endpoint.path.table.subpathStarts;
  const needsStarts =
    endpoint.end === "end" && endpoint.contour < starts.length - 1;
  return run.map((a, j): TargetedPathOp => {
    if (endpoint.end === "start") {
      return {
        elementId,
        op: "pathPointInsert",
        index: endpoint.from,
        anchor: { anchor: clone(a.anchor), left: clone(a.right), right: clone(a.left) },
      };
    }
    return {
      elementId,
      op: "pathPointInsert",
      index: endpoint.to + j,
      anchor: { anchor: clone(a.anchor), left: clone(a.left), right: clone(a.right) },
      ...(needsStarts
        ? {
            prevSubpathStarts: starts.map((s, si) =>
              si > endpoint.contour ? s + j + 1 : s,
            ),
          }
        : {}),
    };
  });
}

export class PenMachine {
  private anchors: AnchorTriple[] = [];
  /** Per-anchor pressure, parallel to `anchors` (B-08). */
  private pressures: number[] = [];
  private pointerDown = false;
  private downPoint: Vec2 | null = null;
  private dragging = false;
  /** Non-null while the current press is NOT placing an anchor — it
   *  closes, joins or edits on release, and never pulls a handle. */
  private press: Press | null = null;
  private pressIntent: PenIntent = "draw";
  private brokenLeft = false;
  private hover: Vec2 | null = null;
  private hoverResolved: Resolved = DRAW;
  /** The hits the hover / the press resolved from (snapshot `hit`). */
  private hoverHit: PenHit | null = null;
  private pressHit: PenHit | null = null;
  /** The existing path this run continues (v2), else null. */
  private origin: Origin | null = null;
  private done = false;
  /** The tolerances in force — a COPY, so `setOptions` never writes to
   *  an object the host still holds. */
  private options: PenOptions;

  constructor(options: PenOptions) {
    this.options = { ...options };
  }

  /**
   * Change the ZOOM-DEPENDENT tolerances (both are page pt the host
   * converted from screen px) without rebuilding the machine — which,
   * mid-run, would lose every anchor placed. Every key is optional; a
   * non-finite or negative value is ignored. Takes effect from the next
   * event: the answer returned here already shows a close preview the
   * new radius brings into (or out of) reach.
   */
  setOptions(patch: Partial<PenOptions>): PenSnapshot {
    const ok = (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v) && v >= 0;
    const next: PenOptions = { ...this.options };
    if (ok(patch.closeTolerance)) next.closeTolerance = patch.closeTolerance;
    if (ok(patch.dragThreshold)) next.dragThreshold = patch.dragThreshold;
    this.options = next;
    return this.snapshot(null);
  }

  /** The tolerances in force (what `setOptions` last left). */
  currentOptions(): Readonly<PenOptions> {
    return { ...this.options };
  }

  handle(event: PenEvent): PenSnapshot {
    if (this.done) return this.snapshot(null);
    switch (event.type) {
      case "down":
        return this.onDown(
          event.point,
          event.modifiers,
          event.sample,
          this.pick(event.hit, event.hits),
        );
      case "move":
        return this.pointerDown
          ? this.onDragMove(event.point, event.modifiers)
          : this.onHoverMove(event.point, this.pick(event.hit, event.hits));
      case "up":
        return this.onUp();
      case "key":
        return this.onKey(event.key);
    }
  }

  private onDown(
    point: Vec2,
    modifiers: PenModifiers,
    sample?: PenSample,
    hit?: PenHit,
  ): PenSnapshot {
    this.pointerDown = true;
    this.dragging = false;
    this.brokenLeft = false;
    this.press = null;
    this.hover = null;
    this.hoverResolved = DRAW;
    this.hoverHit = null;
    const resolved = this.resolve(hit);
    this.pressIntent = resolved.intent;
    this.pressHit = hit && hit.kind !== "empty" ? hit : null;
    switch (resolved.intent) {
      case "add":
      case "delete":
        this.press = {
          kind: "edit",
          plan: {
            kind: resolved.intent === "add" ? "addAnchor" : "deleteAnchor",
            ops: anchorEditOps(resolved.edit).map((op) => ({
              ...op,
              elementId: resolved.path.id,
            })),
          },
        };
        this.downPoint = clone(point);
        return this.snapshot(null);
      case "continue":
        this.adopt(resolved.endpoint, sample);
        this.downPoint = clone(point);
        return this.snapshot(null);
      case "close":
        this.press = { kind: "closeOrigin" };
        this.downPoint = clone(point);
        return this.snapshot(null);
      case "join":
        this.press = { kind: "join", endpoint: resolved.endpoint };
        this.downPoint = clone(point);
        return this.snapshot(null);
      case "draw":
        break;
    }
    // Closing click: on the first anchor with a closeable path. Only a
    // NEW path closes this way — a continued path's anchor 0 is the
    // endpoint it was picked up at, and it closes onto its OTHER one.
    if (
      !this.origin &&
      this.anchors.length >= 2 &&
      dist(point, this.anchors[0].anchor) <= this.options.closeTolerance
    ) {
      this.press = { kind: "closeNew" };
      this.pressIntent = "close";
      this.downPoint = clone(point);
      return this.snapshot(null);
    }
    const placed =
      modifiers.shift && this.anchors.length > 0
        ? constrainAngle(this.anchors[this.anchors.length - 1].anchor, point)
        : clone(point);
    this.anchors.push(cornerAnchor(placed));
    // B-08 — record the pressure at placement. Pure bookkeeping: it
    // never feeds the geometry, only the optional variable-width hook.
    // A missing sample (mouse / synthetic) records the mouse default.
    this.pressures.push(clampPressure(sample?.pressure ?? MOUSE_PRESSURE));
    this.downPoint = placed;
    return this.snapshot(null);
  }

  private onDragMove(point: Vec2, modifiers: PenModifiers): PenSnapshot {
    if (this.press || !this.downPoint) return this.snapshot(null);
    const current = this.anchors[this.anchors.length - 1];
    if (!current) return this.snapshot(null);
    const threshold = this.options.dragThreshold ?? DEFAULT_DRAG_THRESHOLD;
    if (!this.dragging && dist(point, this.downPoint) <= threshold) {
      return this.snapshot(null);
    }
    this.dragging = true;
    const pull = modifiers.shift
      ? constrainAngle(current.anchor, point)
      : clone(point);
    current.right = pull;
    // A picked-up endpoint already HAS an incoming handle — the one that
    // shapes the path's own last segment. Pulling a new outgoing handle
    // must not rewrite it.
    if (this.origin && this.anchors.length === 1) return this.snapshot(null);
    if (modifiers.alt) {
      // Break the pair: left freezes at its last mirrored position.
      this.brokenLeft = true;
    } else if (!this.brokenLeft) {
      current.left = mirrorHandle(current.anchor, pull);
    }
    return this.snapshot(null);
  }

  private onHoverMove(point: Vec2, hit?: PenHit): PenSnapshot {
    this.hover = clone(point);
    this.hoverResolved = this.resolve(hit);
    this.hoverHit = hit && hit.kind !== "empty" ? hit : null;
    return this.snapshot(null);
  }

  /** The candidate a press here would act on — see RANKING. Undefined
   *  when there is none (empty space). */
  private pick(
    hit: PenHit | undefined,
    hits: readonly PenHit[] | undefined,
  ): PenHit | undefined {
    if (!hits || hits.length === 0) return hit;
    const candidates = hit ? [hit, ...hits] : [...hits];
    let best: PenHit | undefined;
    let bestKey: number[] | null = null;
    candidates.forEach((c, order) => {
      if (c.kind === "empty") return;
      const intent = this.resolve(c).intent;
      const key = [
        intent === "draw" ? 1 : 0,
        c.path.selected ? 0 : 1,
        INTENT_RANK[intent],
        c.kind === "anchor" ? 0 : 1,
        order,
      ];
      if (!bestKey || lexLess(key, bestKey)) {
        best = c;
        bestKey = key;
      }
    });
    return best;
  }

  private onUp(): PenSnapshot {
    this.pointerDown = false;
    this.downPoint = null;
    const press = this.press;
    this.press = null;
    this.pressIntent = "draw";
    this.pressHit = null;
    if (!press) return this.snapshot(null);
    if (press.kind === "edit") {
      // An anchor edit on the selected path: planned, and the pen stays
      // armed with nothing in progress.
      return this.snapshot(null, press.plan);
    }
    this.done = true;
    switch (press.kind) {
      case "closeNew":
        return this.snapshot({ anchors: this.anchors, open: false });
      case "closeOrigin": {
        const origin = this.origin!;
        return this.snapshot(null, {
          kind: "close",
          ops: [
            ...this.continueOps(origin),
            {
              elementId: origin.path.id,
              op: "closePath",
              subpath: origin.contour,
            },
          ],
        });
      }
      case "join":
        return this.snapshot(
          null,
          this.origin
            ? this.joinPlan(this.origin, press.endpoint)
            : this.extendPlan(press.endpoint),
        );
    }
  }

  private onKey(key: "Enter" | "Escape"): PenSnapshot {
    if (key === "Escape") {
      this.done = true;
      this.anchors = [];
      this.pressures = [];
      return this.snapshot(null);
    }
    this.done = true;
    if (this.origin) {
      // Enter while continuing — commit what was added. Picking an
      // endpoint up and adding nothing changes nothing.
      const ops = this.continueOps(this.origin);
      if (ops.length === 0) {
        this.anchors = [];
        this.pressures = [];
        return this.snapshot(null);
      }
      return this.snapshot(null, { kind: "continue", ops });
    }
    // Enter — commit the open path; a degenerate run cancels.
    if (this.anchors.length < 2) {
      this.anchors = [];
      this.pressures = [];
      return this.snapshot(null);
    }
    return this.snapshot({ anchors: this.anchors, open: true });
  }

  // ---- v2: existing paths -----------------------------------------------

  /** What a press on `hit` does, given what is (or is not) in progress.
   *  Pure — it is the hover intent and the press decision both. */
  private resolve(hit: PenHit | undefined): Resolved {
    if (!hit || hit.kind === "empty") return DRAW;
    const idle = this.anchors.length === 0;
    if (hit.kind === "segment") {
      if (!idle || !hit.path.selected) return DRAW;
      const edit = planAnchorAddAt(hit.path.table, hit.index, hit.t);
      return edit ? { intent: "add", path: hit.path, edit } : DRAW;
    }
    const endpoint = endpointAt(hit.path, hit.index);
    if (!endpoint) {
      // An interior anchor, or any anchor of a closed contour.
      if (!idle || !hit.path.selected) return DRAW;
      // The floor (a contour keeps two anchors) refuses here, where the
      // cursor can still say so, not at the engine.
      const edit = planAnchorDeleteAt(hit.path.table, hit.index);
      return edit ? { intent: "delete", path: hit.path, edit } : DRAW;
    }
    // Every op on this path is written in its inner space.
    if (!invertible(hit.path.transform)) return DRAW;
    if (idle) return { intent: "continue", endpoint };
    const origin = this.origin;
    if (!origin) {
      // A NEW run ending on an existing endpoint: it becomes part of
      // that path.
      return { intent: "join", endpoint };
    }
    if (sameElement(endpoint.path.id, origin.path.id)) {
      // Its own other end closes it. The end it was picked up at is
      // just an anchor again; an end of a DIFFERENT contour of the same
      // element has no op that welds it (see the header).
      return endpoint.contour === origin.contour && endpoint.end !== origin.end
        ? { intent: "close", endpoint }
        : DRAW;
    }
    const joinable =
      contourCount(origin.path.table) === 1 &&
      contourCount(endpoint.path.table) === 1 &&
      sameTransform(origin.path.transform, endpoint.path.transform);
    return joinable ? { intent: "join", endpoint } : DRAW;
  }

  /** Make an open path's endpoint the first anchor of the run. In the
   *  run every anchor's `right` is the handle that leads ONWARD, so an
   *  endpoint picked up at the path's START has its handles swapped. */
  private adopt(endpoint: Endpoint, sample?: PenSample): void {
    const { path } = endpoint;
    const raw = path.table.anchors[endpoint.index];
    const anchor = toPointer(path.transform, raw.anchor);
    const left = toPointer(path.transform, raw.left);
    const right = toPointer(path.transform, raw.right);
    const triple: AnchorTriple =
      endpoint.end === "end"
        ? { anchor, left, right }
        : { anchor, left: right, right: left };
    this.anchors.push(triple);
    this.pressures.push(clampPressure(sample?.pressure ?? MOUSE_PRESSURE));
    this.origin = { ...endpoint, outgoing: clone(triple.right) };
  }

  /** The run's anchors after the picked-up endpoint, in the continued
   *  path's inner space. */
  private runInInner(origin: Origin): AnchorTriple[] {
    const m = origin.path.transform;
    return this.anchors.slice(1).map((a) => ({
      anchor: toInner(m, a.anchor),
      left: toInner(m, a.left),
      right: toInner(m, a.right),
    }));
  }

  /** Ops that make the continued path carry the run: the endpoint's new
   *  outgoing handle (only if a drag changed it — written FIRST, at its
   *  old index), then the inserts. */
  private continueOps(origin: Origin): TargetedPathOp[] {
    const ops: TargetedPathOp[] = [];
    const first = this.anchors[0];
    if (
      first.right[0] !== origin.outgoing[0] ||
      first.right[1] !== origin.outgoing[1]
    ) {
      ops.push({
        elementId: origin.path.id,
        op: "pathPointSet",
        index: origin.index,
        role: origin.end === "end" ? "right" : "left",
        position: toInner(origin.path.transform, first.right),
      });
    }
    return [...ops, ...attachRun(origin, this.runInInner(origin))];
  }

  /**
   * Join the continued path onto `target`'s endpoint. `joinPaths` welds
   * the NEAREST pair of ends, so the picked pair is made the nearest:
   * one more anchor goes onto the continued path, bit-for-bit ON the
   * target endpoint (the two elements share a transform — `resolve`
   * checked — so the target's raw coordinates are valid in both). At
   * distance zero the engine MERGES the twins: the survivor keeps this
   * anchor's incoming handle and takes the target's outgoing one. So
   * the incoming handle is set to the handle the target endpoint was
   * dangling, and the merged anchor is the target endpoint exactly as it
   * was — nothing is left over, nothing is reshaped.
   */
  private joinPlan(origin: Origin, target: Endpoint): PenPlan {
    const raw = target.path.table.anchors[target.index];
    const dangling = target.end === "start" ? raw.left : raw.right;
    const run = this.runInInner(origin);
    const twin: AnchorTriple = {
      anchor: clone(raw.anchor),
      left: clone(dangling),
      right: clone(raw.anchor),
    };
    const ops = this.continueOps(origin);
    // `continueOps` attached `run`; the twin goes on after it.
    const inserts = attachRun(origin, [...run, twin]);
    ops.push(inserts[inserts.length - 1]);
    ops.push({
      elementId: origin.path.id,
      op: "joinPaths",
      otherId: target.path.id,
    });
    return { kind: "join", ops };
  }

  /** A NEW run that ends on an existing open endpoint was never an
   *  element: it is attached to that path as inserts. Seen from the
   *  endpoint the run is walked backwards, so its order reverses and
   *  each anchor's handles swap. */
  private extendPlan(target: Endpoint): PenPlan {
    const m = target.path.transform;
    const run = [...this.anchors].reverse().map((a) => ({
      anchor: toInner(m, a.anchor),
      left: toInner(m, a.right),
      right: toInner(m, a.left),
    }));
    return { kind: "extend", ops: attachRun(target, run) };
  }

  private snapshot(
    commit: PenCommit | null,
    plan: PenPlan | null = commit
      ? { kind: "insertPath", anchors: commit.anchors, open: commit.open }
      : null,
  ): PenSnapshot {
    const hovering = !this.done && !this.pointerDown && this.hover !== null;
    const closePreview =
      hovering &&
      !this.origin &&
      this.hoverResolved.intent === "draw" &&
      this.anchors.length >= 2 &&
      dist(this.hover!, this.anchors[0].anchor) <= this.options.closeTolerance;
    let intent: PenIntent = "draw";
    if (!this.done) {
      if (this.pointerDown) intent = this.pressIntent;
      else if (closePreview) intent = "close";
      else if (hovering) intent = this.hoverResolved.intent;
    }
    let rubberTo: Vec2 | null =
      this.done || this.pointerDown || this.anchors.length === 0
        ? null
        : this.hover;
    if (
      rubberTo &&
      (this.hoverResolved.intent === "close" ||
        this.hoverResolved.intent === "join")
    ) {
      // Snap the rubber band onto the endpoint the click would land on.
      const { path, index } = this.hoverResolved.endpoint;
      rubberTo = toPointer(path.transform, path.table.anchors[index].anchor);
    }
    let hit: PenHit | null = null;
    if (!this.done) {
      if (this.pointerDown) hit = this.pressHit;
      else if (hovering && !closePreview) hit = this.hoverHit;
    }
    return {
      anchors: this.anchors,
      pressures: this.pressures,
      rubberTo,
      closePreview,
      intent,
      continuing: this.done ? null : (this.origin?.path.id ?? null),
      commit,
      plan,
      active: !this.done,
      hit,
    };
  }
}


/**
 * Build the in-progress PEN preview as a cubic `ToolPreviewPath`
 * (B-07) — the host renders true Béziers instead of a flattened
 * polyline. The snapshot's `anchors` ARE the cubic run (anchor + left/
 * right handles); this only frames them for the overlay channel and
 * appends the live rubber-band segment to the hover cursor as a corner
 * anchor (collapsed handles → a straight cubic), exactly mirroring the
 * polyline path's trailing rubber-band but WITHOUT sampling.
 *
 * Returns `null` for a run too short to draw (the host clears its
 * preview). When `closePreview` is set (hovering anchor 0), the run is
 * marked `close` and the rubber-band is omitted — the closing cubic
 * already returns to anchor 0.
 *
 * This is the host-agnostic OUTPUT the editor shim / a future isolated
 * bundle pushes straight through `host.overlay.setToolPreview`; the old
 * `flattenAnchorRun` path stays as the fallback for a host whose
 * `ToolPreviewShape` predates the path variant (capability is the same
 * `overlay.toolPreview@1` door — the variant is structural, detected by
 * the renderer's `"anchors" in shape` discriminant, so no separate
 * feature flag exists; a pre-variant host simply ignores the unknown
 * branch and the shim should keep flattening for it).
 */
export function penPreview(
  snapshot: PenSnapshot,
  pageId: string,
  options?: { dashed?: boolean },
): ToolPreviewPath | null {
  const anchors: AnchorTriple[] = snapshot.anchors.map((a) => ({
    anchor: [a.anchor[0], a.anchor[1]],
    left: [a.left[0], a.left[1]],
    right: [a.right[0], a.right[1]],
  }));
  const close = snapshot.closePreview;
  // Rubber-band to the cursor: only while not snapping to close (the
  // close edge already returns to anchor 0). A corner anchor at the
  // hover point → a straight cubic from the last placed anchor.
  if (snapshot.rubberTo && !close) {
    anchors.push(cornerAnchor(clone(snapshot.rubberTo)));
  }
  // A single anchor (or none) has no segment to stroke.
  if (anchors.length < 2) return null;
  return {
    pageId,
    anchors,
    close,
    ...(options?.dashed ? { dashed: true } : {}),
  };
}
