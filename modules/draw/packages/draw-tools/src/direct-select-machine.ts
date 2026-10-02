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

// The Direct Selection tool's state machine — the missing core of path
// editing: dragging anchors, Bézier handles and segments of ONE path.
// Host-agnostic: pointer events + a hit description the HOST computed
// in, a snapshot (edited anchor table for preview, selected-anchor set,
// marquee) out, and on release a plan that lowers to ONE `batch` of
// `pathPointSet` ops (`pathPointRemove` for Delete) — one undo step.
//
// THE MACHINE NEVER HIT-TESTS. The host knows where its handle dots are
// and how big they are at the current zoom; it says what the pointer
// went down on (`DirectSelectHit`) and the machine decides what that
// means. A `move` or `up` carries only a point.
//
// COORDINATE SPACES — two, and the machine names both.
//   · POINTER SPACE is whatever the caller's event points are in: in the
//     editor that is page-local pt. The drag delta, the 45° constraint,
//     the marquee, the slop and the nudge step are all measured here,
//     because that is the space the user sees: a marquee is an
//     axis-aligned rectangle on screen, not in the rotated frame of the
//     path it happens to be selecting in.
//   · PATH-INNER SPACE is what `pathAnchors` reports and what
//     `pathPointSet` writes: the element's own coordinates, before its
//     item transform.
//   `options.transform` maps inner → pointer (pass the reply's
//   `itemTransform`; null/omitted = identity, i.e. the caller already
//   feeds path-local points, as the anchor tools do). The snapshot's
//   table is in POINTER space (draw it); a plan's positions are in INNER
//   space (send them).
//
// Gesture matrix (Illustrator parity):
//   press anchor, drag       → move it; its handles travel with it. An
//                              anchor that is part of the selection
//                              drags the whole selection.
//   press handle, drag       → move that handle. On a SMOOTH anchor the
//                              opposite handle stays collinear and keeps
//                              its own length; Alt breaks the pair. On a
//                              corner / cusp / one-handled anchor the
//                              drag is always independent.
//   press segment, drag      → reshape it: the two inner handles move so
//                              the grabbed point follows the pointer
//                              (`reshapeSegmentByDrag` — the formula is
//                              documented there).
//   press empty, drag        → marquee: selects the enclosed anchors,
//                              Shift adds to the selection.
//   click anchor             → select just it; Shift-click toggles it.
//   click empty              → deselect (Shift keeps the selection).
//   Shift while dragging     → constrain the drag to 45° steps from the
//                              drag origin. FOR A HANDLE the origin is
//                              its ANCHOR — Shift snaps the direction
//                              line, which is what the Pen's Shift-drag
//                              does and what a user constraining a
//                              tangent means — not the press point.
//   arrow keys               → nudge the selected anchors by
//                              `nudgeStep` (×10 with Shift); each key is
//                              its own plan.
//   Delete / Backspace       → remove the selected anchors. Refused, as
//                              a whole, if any contour would be left
//                              with fewer than two.
//   Escape (mid-gesture)     → cancel: the table and the selection are
//                              back where the press found them, zero
//                              ops, and the trailing `up` is ignored.
//
// CLICK vs DRAG. Travel within `slop` of the press point is a click.
// Once the pointer leaves the slop the gesture is a drag for good, even
// if it comes back — and a drag that ends exactly where it began plans
// nothing at all.
//
// SUBPATHS. Indices are flat across contours, exactly as on the wire. A
// closed contour wraps: its last anchor starts the closing segment back
// to its first. The last anchor of an OPEN contour starts no segment.
//
// ONE PATH. The machine edits a single anchor table. Dragging anchors
// of several selected paths at once is a host concern (one machine per
// path, fed the same events) and is not built here.

import {
  applyAffine,
  clone,
  constrainAngle,
  dist,
  inverseApplyAffine,
  isSmoothAnchor,
  reshapeSegmentByDrag,
  type Affine,
  type AnchorTable,
  type AnchorTriple,
  type Vec2,
  type Vec2Mut,
} from "@paged-media/draw-geometry";

import type { ElementId } from "@paged-media/plugin-api";

import { segmentPairFrom } from "./anchor-machine";
import {
  pathEditBatch,
  type PathEditBatchWire,
  type PathPointOp,
} from "./path-edit-ops";

export interface DirectSelectModifiers {
  shift: boolean;
  alt: boolean;
}

/** What the pointer went down on — computed by the HOST. */
export type DirectSelectHit =
  /** An anchor dot; `index` is flat across contours. */
  | { kind: "anchor"; index: number }
  /** One of an anchor's handle dots. */
  | { kind: "handle"; index: number; side: "left" | "right" }
  /** A point on a segment: `index` is the flat index of the segment's
   *  START anchor (the `NearestPathPointResult.segStart` convention — a
   *  closed contour's last anchor starts its closing segment), `t` the
   *  cubic parameter of the grabbed point. */
  | { kind: "segment"; index: number; t: number }
  /** Nothing — the press starts a marquee. */
  | { kind: "empty" };

export type DirectSelectKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown"
  | "Delete"
  | "Backspace"
  | "Escape";

export type DirectSelectEvent =
  | {
      type: "down";
      point: Vec2;
      hit: DirectSelectHit;
      modifiers: DirectSelectModifiers;
    }
  | { type: "move"; point: Vec2; modifiers: DirectSelectModifiers }
  | { type: "up"; point: Vec2; modifiers: DirectSelectModifiers }
  | { type: "key"; key: DirectSelectKey; modifiers: DirectSelectModifiers };

export interface DirectSelectOptions {
  /** The path's anchor table in path-INNER space — `pathAnchors`' reply
   *  verbatim. */
  table: AnchorTable;
  /** Inner → pointer space (`itemTransform`). Null / omitted =
   *  identity. */
  transform?: Affine | null;
  /** Pointer travel, in pointer-space units, at or below which a press
   *  and release is a click (the host converts a pixel slop at the
   *  current zoom). */
  slop: number;
  /** One arrow-key nudge, in pointer-space units (×10 with Shift). */
  nudgeStep: number;
  /** Anchors selected at construction. */
  selection?: readonly number[];
  /** |sin| of the deviation from a straight line under which an anchor
   *  with two extended handles counts as SMOOTH (`isSmoothAnchor`'s
   *  `angleTol`). */
  smoothTolerance?: number;
}

/** A marquee in pointer space, normalised (width/height ≥ 0). */
export interface MarqueeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DirectSelectPlanKind =
  | "move"
  | "handle"
  | "segment"
  | "nudge"
  | "delete";

/** The two ops a Direct Selection plan is ever made of. */
export type DirectSelectOp = Extract<
  PathPointOp,
  { op: "pathPointSet" | "pathPointRemove" }
>;

/** What one committed gesture does to the path. `ops` are in apply
 *  order, flat-indexed, positions in path-INNER space; lower them with
 *  `directSelectMutation`. Never empty. */
export interface DirectSelectPlan {
  kind: DirectSelectPlanKind;
  ops: DirectSelectOp[];
}

export type DirectSelectRefusal =
  /** Delete would leave these contours (by subpath index) with fewer
   *  than two anchors. Nothing was removed. */
  | { reason: "contourFloor"; contours: number[] }
  /** The inner → pointer transform has no inverse, so a pointer-space
   *  edit cannot be written back. Nothing was moved. */
  | { reason: "singularTransform" };

export type DirectSelectMode =
  | "idle"
  /** Pointer down, still within the slop. */
  | "press"
  | "anchors"
  | "handle"
  | "segment"
  | "marquee";

/** What the host renders/acts on after each event. */
export interface DirectSelectSnapshot {
  /** The anchor table as edited so far, in POINTER space — the live
   *  preview. Never mutated in place: a later snapshot is a new table. */
  table: AnchorTable;
  /** Selected anchors, flat indices, ascending. During a marquee this is
   *  the selection the release would produce. */
  selected: readonly number[];
  /** The marquee while one is being dragged, else null. */
  marquee: MarqueeRect | null;
  mode: DirectSelectMode;
  /** Non-null exactly once, on the event that completes a gesture which
   *  changes the path. */
  commit: DirectSelectPlan | null;
  /** Non-null on the `up` of a press that never left the slop: the hit
   *  the press landed on. The seam for what a host layers on a click —
   *  a double-click convert, a segment-click insert. */
  click: DirectSelectHit | null;
  /** Non-null on the event that was refused. */
  refusal: DirectSelectRefusal | null;
}

/** Lower a plan to the ONE batch `host.document.mutate` takes. */
export function directSelectMutation(
  plan: DirectSelectPlan,
  elementId: ElementId,
): PathEditBatchWire {
  return pathEditBatch(elementId, plan.ops);
}

// ---- internals --------------------------------------------------------

interface Table {
  anchors: AnchorTriple[];
  subpathStarts: number[];
  subpathOpen?: boolean[];
}

interface GestureBase {
  down: Vec2Mut;
  dragging: boolean;
  hit: DirectSelectHit;
  shiftAtDown: boolean;
  selectionAtDown: number[];
}

type Gesture = GestureBase &
  (
    | { kind: "anchors"; index: number; wasSelected: boolean; indices: number[] }
    | { kind: "handle"; index: number; side: "left" | "right"; smooth: boolean }
    | { kind: "segment"; segStart: number; segEnd: number; t: number }
    | { kind: "marquee" }
  );

const PLAN_KIND = {
  anchors: "move",
  handle: "handle",
  segment: "segment",
} as const;

const NUDGE: Record<
  "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
  Vec2
> = {
  // Pointer space is y-down (page coordinates): Up is −y.
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

const SHIFT_NUDGE_FACTOR = 10;

/** Round-off allowed when deciding a handle rode rigidly with its
 *  anchor — `(x + d) − x` is `d` only to within an ulp of `x + d`. */
const RIGID_EPS = 1e-9;

function isIdentity(m: Affine): boolean {
  return (
    m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0
  );
}

function mapPoint(m: Affine | null, p: Vec2): Vec2Mut {
  return m ? applyAffine(m, p[0], p[1]) : clone(p);
}

function toPointerSpace(table: AnchorTable, m: Affine | null): Table {
  return {
    anchors: table.anchors.map((a) => ({
      anchor: mapPoint(m, a.anchor),
      left: mapPoint(m, a.left),
      right: mapPoint(m, a.right),
    })),
    subpathStarts: [...table.subpathStarts],
    ...(table.subpathOpen ? { subpathOpen: [...table.subpathOpen] } : {}),
  };
}

function same(a: Vec2, b: Vec2): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function near(a: Vec2, b: Vec2): boolean {
  const scale = Math.max(1, Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1]));
  return (
    Math.abs(a[0] - b[0]) <= RIGID_EPS * scale &&
    Math.abs(a[1] - b[1]) <= RIGID_EPS * scale
  );
}

function shifted(p: Vec2, d: Vec2): Vec2Mut {
  return [p[0] + d[0], p[1] + d[1]];
}

export class DirectSelectMachine {
  /** The committed table, pointer space. */
  private base: Table;
  /** The previewed table, pointer space (`=== base` when nothing is in
   *  flight). Replaced, never mutated. */
  private live: Table;
  private transform: Affine | null;
  private singular: boolean;
  private selection = new Set<number>();
  private gesture: Gesture | null = null;
  private marquee: MarqueeRect | null = null;
  private slop: number;
  private nudgeStep: number;
  private smoothTolerance: number | undefined;

  constructor(options: DirectSelectOptions) {
    this.slop = options.slop;
    this.nudgeStep = options.nudgeStep;
    this.smoothTolerance = options.smoothTolerance;
    this.transform = null;
    this.singular = false;
    this.base = this.live = { anchors: [], subpathStarts: [] };
    this.install(options.table, options.transform ?? null);
    this.setSelectionInternal(options.selection ?? []);
  }

  /** Feed one event; the returned snapshot is what to draw and, when
   *  `commit` is set, what to send. */
  handle(event: DirectSelectEvent): DirectSelectSnapshot {
    switch (event.type) {
      case "down":
        return this.onDown(event.point, event.hit, event.modifiers);
      case "move":
        // A move with no button down is a hover: nothing to do.
        return this.gesture
          ? this.onDrag(this.gesture, event.point, event.modifiers)
          : this.snap();
      case "up":
        return this.gesture
          ? this.onUp(this.gesture, event.point, event.modifiers)
          : this.snap();
      case "key":
        return this.onKey(event.key, event.modifiers);
    }
  }

  /** The current state without feeding an event. */
  snapshot(): DirectSelectSnapshot {
    return this.snap();
  }

  /**
   * Re-seat the machine on a fresh `pathAnchors` reply — after the
   * engine applied a plan (it stores f32, so its table is the truth, not
   * this machine's f64 preview), after an undo/redo, or after any other
   * edit to the path. Any gesture in flight is dropped; the selection
   * survives where its indices still exist. Omit `transform` to keep the
   * current one.
   */
  sync(table: AnchorTable, transform?: Affine | null): DirectSelectSnapshot {
    this.gesture = null;
    this.marquee = null;
    this.install(table, transform === undefined ? this.transform : transform);
    this.setSelectionInternal(this.sorted());
    return this.snap();
  }

  /**
   * Change the ZOOM-DEPENDENT tolerances without rebuilding the machine —
   * the host converts its pixel slop and nudge at the current zoom, and a
   * zoom used to mean a new machine (and a lost selection). Every key is
   * optional; a non-finite or negative value is ignored (the old one
   * stays), as is `smoothTolerance: undefined` (pass a number to change
   * it). Takes effect from the NEXT event, mid-gesture included: a slop
   * that shrinks under a press can turn it into a drag on the next move,
   * which is what the pointer has by then done on screen.
   */
  setOptions(
    patch: Partial<Pick<DirectSelectOptions, "slop" | "nudgeStep" | "smoothTolerance">>,
  ): DirectSelectSnapshot {
    const ok = (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v) && v >= 0;
    if (ok(patch.slop)) this.slop = patch.slop;
    if (ok(patch.nudgeStep)) this.nudgeStep = patch.nudgeStep;
    if (ok(patch.smoothTolerance)) this.smoothTolerance = patch.smoothTolerance;
    return this.snap();
  }

  /** The tolerances in force (what `setOptions` last left). */
  currentOptions(): {
    slop: number;
    nudgeStep: number;
    smoothTolerance: number | undefined;
  } {
    return {
      slop: this.slop,
      nudgeStep: this.nudgeStep,
      smoothTolerance: this.smoothTolerance,
    };
  }

  /** Replace the selection (Select All, a host-side lasso, …). Indices
   *  outside the table are dropped. Ignored mid-gesture. */
  setSelection(indices: readonly number[]): DirectSelectSnapshot {
    if (!this.gesture) this.setSelectionInternal(indices);
    return this.snap();
  }

  // ---- pointer ----------------------------------------------------------

  private onDown(
    point: Vec2,
    rawHit: DirectSelectHit,
    modifiers: DirectSelectModifiers,
  ): DirectSelectSnapshot {
    // A press while a gesture is still open means its `up` was lost
    // (pointer capture broke): drop it cleanly, then start over.
    if (this.gesture) this.abort(this.gesture);
    const hit = this.validHit(rawHit);
    const common: GestureBase = {
      down: clone(point),
      dragging: false,
      hit,
      shiftAtDown: modifiers.shift,
      selectionAtDown: this.sorted(),
    };
    switch (hit.kind) {
      case "anchor": {
        const wasSelected = this.selection.has(hit.index);
        // Select on PRESS so the drag that may follow moves what the
        // user grabbed. A press on an already-selected anchor keeps the
        // whole selection (that is how a multi-anchor drag starts); it
        // collapses to the one anchor only if the press turns out to be
        // a click.
        if (modifiers.shift) this.selection.add(hit.index);
        else if (!wasSelected) this.selection = new Set([hit.index]);
        this.gesture = {
          ...common,
          kind: "anchors",
          index: hit.index,
          wasSelected,
          indices: this.sorted(),
        };
        break;
      }
      case "handle":
        this.gesture = {
          ...common,
          kind: "handle",
          index: hit.index,
          side: hit.side,
          // Judged ONCE, against the table the press found — not against
          // the live preview, which the drag itself is bending.
          smooth: isSmoothAnchor(
            this.base.anchors[hit.index],
            undefined,
            this.smoothTolerance,
          ),
        };
        break;
      case "segment": {
        // `validHit` already proved the segment exists.
        const pair = segmentPairFrom(this.base, hit.index)!;
        this.gesture = {
          ...common,
          kind: "segment",
          segStart: pair[0],
          segEnd: pair[1],
          t: hit.t,
        };
        break;
      }
      case "empty":
        this.gesture = { ...common, kind: "marquee" };
        break;
    }
    return this.snap();
  }

  private onDrag(
    g: Gesture,
    point: Vec2,
    modifiers: DirectSelectModifiers,
  ): DirectSelectSnapshot {
    if (!g.dragging) {
      if (dist(point, g.down) <= this.slop) return this.snap();
      g.dragging = true;
    }
    this.applyDrag(g, point, modifiers);
    return this.snap();
  }

  private onUp(
    g: Gesture,
    point: Vec2,
    modifiers: DirectSelectModifiers,
  ): DirectSelectSnapshot {
    // A release far from the press with no move in between is still a
    // drag (a coalesced pointer stream can deliver exactly that).
    if (!g.dragging && dist(point, g.down) > this.slop) g.dragging = true;
    this.gesture = null;
    if (!g.dragging) return this.onClick(g);
    this.applyDrag(g, point, modifiers);
    if (g.kind === "marquee") {
      this.marquee = null;
      return this.snap();
    }
    return this.commit(PLAN_KIND[g.kind]);
  }

  private onClick(g: Gesture): DirectSelectSnapshot {
    if (g.kind === "anchors") {
      if (!g.shiftAtDown) this.selection = new Set([g.index]);
      // Shift-click TOGGLES: an anchor that was not selected was added
      // on press; one that was is taken out now.
      else if (g.wasSelected) this.selection.delete(g.index);
    } else if (g.kind === "marquee" && !g.shiftAtDown) {
      this.selection.clear();
    }
    return this.snap({ click: g.hit });
  }

  /** Recompute the preview from the BASE table and the current pointer —
   *  stateless in the pointer's history, so releasing a modifier mid-drag
   *  simply un-applies it. */
  private applyDrag(
    g: Gesture,
    point: Vec2,
    modifiers: DirectSelectModifiers,
  ): void {
    if (g.kind === "marquee") {
      this.marquee = {
        x: Math.min(g.down[0], point[0]),
        y: Math.min(g.down[1], point[1]),
        width: Math.abs(point[0] - g.down[0]),
        height: Math.abs(point[1] - g.down[1]),
      };
      const enclosed = this.enclosedBy(this.marquee);
      this.selection = new Set(
        modifiers.shift ? [...g.selectionAtDown, ...enclosed] : enclosed,
      );
      return;
    }
    if (same(point, g.down)) {
      // Back on the press point: exactly the table the press found.
      this.live = this.base;
      return;
    }
    if (g.kind === "handle") {
      this.live = this.withHandleDragged(g, point, modifiers);
      return;
    }
    const target = modifiers.shift ? constrainAngle(g.down, point) : point;
    const delta: Vec2 = [target[0] - g.down[0], target[1] - g.down[1]];
    if (g.kind === "anchors") {
      const moving = new Set(g.indices);
      this.live = this.withAnchors((a, i) =>
        moving.has(i)
          ? {
              anchor: shifted(a.anchor, delta),
              left: shifted(a.left, delta),
              right: shifted(a.right, delta),
            }
          : a,
      );
      return;
    }
    // Segment: both anchors stay, the two inner handles bend.
    const start = this.base.anchors[g.segStart];
    const end = this.base.anchors[g.segEnd];
    const reshaped = reshapeSegmentByDrag(start.right, end.left, g.t, delta);
    this.live = this.withAnchors((a, i) => {
      // Two different anchors always (a contour needs two anchors to
      // have a segment), each giving this segment ONE of its handles.
      let next = a;
      if (i === g.segStart) next = { ...next, right: reshaped.startRight };
      if (i === g.segEnd) next = { ...next, left: reshaped.endLeft };
      return next;
    });
  }

  private withHandleDragged(
    g: Extract<Gesture, { kind: "handle" }>,
    point: Vec2,
    modifiers: DirectSelectModifiers,
  ): Table {
    const a = this.base.anchors[g.index];
    const other = g.side === "left" ? "right" : "left";
    // The handle keeps the offset it was grabbed at — it does not jump
    // to the pointer.
    let pos: Vec2Mut = [
      a[g.side][0] + point[0] - g.down[0],
      a[g.side][1] + point[1] - g.down[1],
    ];
    if (modifiers.shift) pos = constrainAngle(a.anchor, pos);
    let opposite = a[other];
    if (g.smooth && !modifiers.alt) {
      const length = dist(pos, a.anchor);
      // A handle dragged ONTO its anchor has no direction to mirror; the
      // opposite one stays where it was.
      if (length > 0) {
        const keep = dist(a[other], a.anchor);
        opposite = [
          a.anchor[0] - ((pos[0] - a.anchor[0]) / length) * keep,
          a.anchor[1] - ((pos[1] - a.anchor[1]) / length) * keep,
        ];
      }
    }
    return this.withAnchors((triple, i) =>
      i === g.index
        ? g.side === "left"
          ? { anchor: triple.anchor, left: pos, right: opposite }
          : { anchor: triple.anchor, left: opposite, right: pos }
        : triple,
    );
  }

  // ---- keys -------------------------------------------------------------

  private onKey(
    key: DirectSelectKey,
    modifiers: DirectSelectModifiers,
  ): DirectSelectSnapshot {
    if (key === "Escape") {
      // Idle Escape is the host's (it pops the edit context).
      if (this.gesture) this.abort(this.gesture);
      return this.snap();
    }
    // Everything else waits for the pointer to come up.
    if (this.gesture) return this.snap();
    if (key === "Delete" || key === "Backspace") return this.deleteSelected();
    if (this.selection.size === 0) return this.snap();
    const step = this.nudgeStep * (modifiers.shift ? SHIFT_NUDGE_FACTOR : 1);
    const delta: Vec2 = [NUDGE[key][0] * step, NUDGE[key][1] * step];
    this.live = this.withAnchors((a, i) =>
      this.selection.has(i)
        ? {
            anchor: shifted(a.anchor, delta),
            left: shifted(a.left, delta),
            right: shifted(a.right, delta),
          }
        : a,
    );
    return this.commit("nudge");
  }

  private deleteSelected(): DirectSelectSnapshot {
    if (this.selection.size === 0) return this.snap();
    const n = this.base.anchors.length;
    const starts =
      this.base.subpathStarts.length > 0 ? this.base.subpathStarts : [0];
    const starved: number[] = [];
    for (let si = 0; si < starts.length; si++) {
      const from = starts[si];
      const to = si + 1 < starts.length ? starts[si + 1] : n;
      let doomed = 0;
      for (let i = from; i < to; i++) if (this.selection.has(i)) doomed++;
      if (doomed > 0 && to - from - doomed < 2) starved.push(si);
    }
    if (starved.length > 0) {
      return this.snap({
        refusal: { reason: "contourFloor", contours: starved },
      });
    }
    // DESCENDING, so no remove shifts an index a later one still names.
    const doomed = this.sorted().reverse();
    const ops: DirectSelectOp[] = doomed.map((index) => ({
      op: "pathPointRemove",
      index,
    }));
    const gone = this.selection;
    this.base = this.live = {
      anchors: this.base.anchors.filter((_, i) => !gone.has(i)),
      // No contour vanishes (each keeps ≥ 2), so every start survives —
      // it only slides down by the removals in front of it.
      subpathStarts: this.base.subpathStarts.map(
        (s) => s - doomed.filter((i) => i < s).length,
      ),
      ...(this.base.subpathOpen
        ? { subpathOpen: this.base.subpathOpen }
        : {}),
    };
    this.selection = new Set();
    return this.snap({ commit: { kind: "delete", ops } });
  }

  // ---- commit -----------------------------------------------------------

  /** Diff the preview against the base into ops, in INNER space. The
   *  engine's `pathPointSet` on an ANCHOR drags both handles by the same
   *  delta, so a handle that merely rode along needs no op of its own —
   *  and one that did not is written AFTER its anchor. */
  private commit(kind: DirectSelectPlanKind): DirectSelectSnapshot {
    const before = this.base.anchors;
    const after = this.live.anchors;
    const ops: DirectSelectOp[] = [];
    let unwritable = false;
    const set = (
      index: number,
      role: "anchor" | "left" | "right",
      p: Vec2,
    ): void => {
      const inner = this.singular ? null : this.toInner(p);
      if (inner) ops.push({ op: "pathPointSet", index, role, position: inner });
      else unwritable = true;
    };
    for (let i = 0; i < after.length; i++) {
      const b = before[i];
      const a = after[i];
      if (a === b) continue;
      const moved = !same(a.anchor, b.anchor);
      if (moved) set(i, "anchor", a.anchor);
      const delta: Vec2 = [a.anchor[0] - b.anchor[0], a.anchor[1] - b.anchor[1]];
      for (const side of ["left", "right"] as const) {
        const rode = moved
          ? near(a[side], shifted(b[side], delta))
          : same(a[side], b[side]);
        if (!rode) set(i, side, a[side]);
      }
    }
    if (unwritable) {
      this.live = this.base;
      return this.snap({ refusal: { reason: "singularTransform" } });
    }
    if (ops.length === 0) {
      this.live = this.base;
      return this.snap();
    }
    this.base = this.live;
    return this.snap({ commit: { kind, ops } });
  }

  private abort(g: Gesture): void {
    this.live = this.base;
    this.selection = new Set(g.selectionAtDown);
    this.marquee = null;
    this.gesture = null;
  }

  // ---- helpers ----------------------------------------------------------

  private install(table: AnchorTable, transform: Affine | null): void {
    this.transform = transform && !isIdentity(transform) ? transform : null;
    this.singular =
      this.transform !== null &&
      inverseApplyAffine(this.transform, 0, 0) === null;
    this.base = this.live = toPointerSpace(table, this.transform);
  }

  private toInner(p: Vec2): Vec2Mut | null {
    return this.transform
      ? inverseApplyAffine(this.transform, p[0], p[1])
      : clone(p);
  }

  private setSelectionInternal(indices: readonly number[]): void {
    const n = this.base.anchors.length;
    this.selection = new Set(
      indices.filter((i) => Number.isInteger(i) && i >= 0 && i < n),
    );
  }

  private sorted(): number[] {
    return [...this.selection].sort((a, b) => a - b);
  }

  /** A hit the table cannot honour degrades to empty space rather than
   *  throwing: the host's hit description can be a frame stale. */
  private validHit(hit: DirectSelectHit): DirectSelectHit {
    if (hit.kind === "empty") return hit;
    const n = this.base.anchors.length;
    const inRange =
      Number.isInteger(hit.index) && hit.index >= 0 && hit.index < n;
    if (!inRange) return { kind: "empty" };
    if (hit.kind === "segment") {
      if (!Number.isFinite(hit.t)) return { kind: "empty" };
      if (!segmentPairFrom(this.base, hit.index)) return { kind: "empty" };
    }
    return hit;
  }

  private enclosedBy(rect: MarqueeRect): number[] {
    const out: number[] = [];
    this.base.anchors.forEach((a, i) => {
      const [x, y] = a.anchor;
      if (
        x >= rect.x &&
        x <= rect.x + rect.width &&
        y >= rect.y &&
        y <= rect.y + rect.height
      ) {
        out.push(i);
      }
    });
    return out;
  }

  private withAnchors(
    f: (a: AnchorTriple, i: number) => AnchorTriple,
  ): Table {
    return { ...this.base, anchors: this.base.anchors.map(f) };
  }

  private snap(
    extra: Partial<
      Pick<DirectSelectSnapshot, "commit" | "click" | "refusal">
    > = {},
  ): DirectSelectSnapshot {
    const g = this.gesture;
    return {
      table: this.live,
      selected: this.sorted(),
      marquee: this.marquee,
      mode: !g ? "idle" : g.dragging ? g.kind : "press",
      commit: extra.commit ?? null,
      click: extra.click ?? null,
      refusal: extra.refusal ?? null,
    };
  }
}
