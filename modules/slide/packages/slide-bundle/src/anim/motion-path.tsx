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

// Motion paths on the canvas (slide ADR 714, amendment 2026-10-30). The
// effect picked in the Animations pane shows its path over the slide,
// PowerPoint's dotted line from where the shape stands, with the green
// start and red end markers; its points are edited with Bézier handles as
// paged.draw's Direct Selection edits a path: a square anchor moves with
// its two handles, a round handle bends its curve, a line segment shows
// none. Release writes the path into the slide's timing, one undo step,
// and export writes it back as `p:animMotion path`. A double-click on the
// path adds a point there; on an anchor it deletes the point.
//
// The path is the timing's, not a page item, so it is drawn on the overlay
// channel (`contribute.overlay`, the adjust handles' door); what a path is
// and how it is written are the slide engine's (`pathSegments`,
// `pathWrite`). The EDITING is the host's Direct Selection: the path is an
// anchor table (`tableOfSegs`) and every press, drag and release goes
// through `@paged-media/vector-tools`' `DirectSelectMachine` (an anchor
// moves with its handles and the other selected anchors, Shift adds to the
// selection, a smooth anchor keeps its handles in line unless Alt, a
// segment drag reshapes the curve), whose plan is applied to the table
// (`applyPathOps`) and written back as segments (`segsOfTable`). Only the
// storage is slide's.

import type {
  BundleHost,
  Disposable,
  OverlayContribution,
  OverlayProps,
} from "@paged-media/plugin-api";
import {
  evalCubic,
  splitSegmentDeCasteljau,
  type AnchorTable,
  type AnchorTriple,
} from "@paged-media/vector-geometry";
import {
  applyPathOps,
  DirectSelectMachine,
  type DirectSelectHit,
  type DirectSelectModifiers,
} from "@paged-media/vector-tools";
import * as React from "react";

import type { SlideEngine } from "../engine.js";
import type { AnimationAuthoring } from "./authoring.js";
import type { EffectInfo, PathSeg } from "./model.js";
import { idOf } from "./shapes.js";

export const MOTION_PATH_OVERLAY_ID = "media.paged.slide.overlay.motionPath";

/** A handle of the path: segment `seg`'s end point or a control point. */
export interface PathHandle {
  seg: number;
  which: "to" | "c1" | "c2";
}

export interface MotionPathState {
  pageId: string | null;
  /** The effect's index in the slide's timing. */
  index: number | null;
  segs: readonly PathSeg[];
  /** Where the shape stands (its box's centre), page pt: the path's 0 0. */
  origin: [number, number];
  /** The slide's size, pt: the path's units. */
  slide: [number, number];
  locked: boolean;
  /** The selected anchors (the machine's, flat indices). */
  selected?: readonly number[];
}

const EMPTY: MotionPathState = {
  pageId: null,
  index: null,
  segs: [],
  origin: [0, 0],
  slide: [1, 1],
  locked: false,
};

type Pt = [number, number];

const same = (a: Pt, b: Pt) =>
  Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

/** The path as an anchor table (slide fractions): an anchor per end
 *  point, a curve's controls as the handles of its two ends, a contour per
 *  `move`, closed where a `close` ends it. `anchorOf[seg]` is the anchor a
 *  segment ends at (-1 for a close). */
export function tableOfSegs(segs: readonly PathSeg[]): {
  table: AnchorTable;
  anchorOf: number[];
} {
  const anchors: AnchorTriple[] = [];
  const subpathStarts: number[] = [];
  const subpathOpen: boolean[] = [];
  const anchorOf: number[] = [];
  segs.forEach((s, i) => {
    if (s.kind === "close") {
      anchorOf.push(-1);
      if (subpathOpen.length > 0) subpathOpen[subpathOpen.length - 1] = false;
      return;
    }
    if (s.kind === "move" || anchors.length === 0) {
      subpathStarts.push(anchors.length);
      subpathOpen.push(true);
    }
    const to: Pt = [s.to[0], s.to[1]];
    const left: Pt = s.kind === "curve" ? [s.c2[0], s.c2[1]] : [...to];
    const next = segs[i + 1];
    const right: Pt =
      next?.kind === "curve" ? [next.c1[0], next.c1[1]] : [...to];
    anchorOf.push(anchors.length);
    anchors.push({ anchor: to, left, right });
  });
  return { table: { anchors, subpathStarts, subpathOpen }, anchorOf };
}

/** The segments an anchor table makes: a `move` per contour, a `line`
 *  where both ends' handles sit on their anchors, else a `curve`, and a
 *  `close` after a closed contour (its closing segment straight, as
 *  PowerPoint's `Z` is). */
export function segsOfTable(table: AnchorTable): PathSeg[] {
  const out: PathSeg[] = [];
  const n = table.anchors.length;
  const starts = table.subpathStarts.length > 0 ? table.subpathStarts : [0];
  starts.forEach((from, k) => {
    const to = starts[k + 1] ?? n;
    for (let i = from; i < to; i++) {
      const a = table.anchors[i]!;
      const p: Pt = [a.anchor[0], a.anchor[1]];
      if (i === from) {
        out.push({ kind: "move", to: p });
        continue;
      }
      const prev = table.anchors[i - 1]!;
      const c1: Pt = [prev.right[0], prev.right[1]];
      const c2: Pt = [a.left[0], a.left[1]];
      out.push(
        same(c1, prev.anchor as Pt) && same(c2, p)
          ? { kind: "line", to: p }
          : { kind: "curve", c1, c2, to: p },
      );
    }
    if (table.subpathOpen?.[k] === false) out.push({ kind: "close" });
  });
  return out;
}

/** What a press on handle `h` hits, for the Direct Selection machine: an
 *  end point is its anchor, a curve's first control the right handle of
 *  the anchor before it, its second the left handle of its own end. */
export function hitOf(
  segs: readonly PathSeg[],
  h: PathHandle,
): DirectSelectHit {
  const { anchorOf } = tableOfSegs(segs);
  const own = anchorOf[h.seg] ?? -1;
  if (h.which === "to") return { kind: "anchor", index: own };
  if (h.which === "c2") return { kind: "handle", index: own, side: "left" };
  return { kind: "handle", index: own - 1, side: "right" };
}

/** `table` with every point taken through `f`. */
function mapTable(table: AnchorTable, f: (p: Pt) => Pt): AnchorTable {
  return {
    anchors: table.anchors.map((a) => ({
      anchor: f(a.anchor as Pt),
      left: f(a.left as Pt),
      right: f(a.right as Pt),
    })),
    subpathStarts: [...table.subpathStarts],
    ...(table.subpathOpen ? { subpathOpen: [...table.subpathOpen] } : {}),
  };
}

/** The handles a path shows: every end point, and a curve's controls. */
export function handlesOf(segs: readonly PathSeg[]): PathHandle[] {
  const out: PathHandle[] = [];
  segs.forEach((s, seg) => {
    if (s.kind === "close") return;
    if (s.kind === "curve") {
      out.push({ seg, which: "c1" }, { seg, which: "c2" });
    }
    out.push({ seg, which: "to" });
  });
  return out;
}

/** The point a handle stands at (slide fractions). */
export function handlePoint(segs: readonly PathSeg[], h: PathHandle): Pt {
  const s = segs[h.seg];
  if (!s || s.kind === "close") return [0, 0];
  if (h.which === "to" || s.kind !== "curve") return s.to;
  return s[h.which];
}

const lerp = (a: Pt, b: Pt, t: number): Pt => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

/** Where segment `i` starts (its predecessor's end point). */
function startOf(segs: readonly PathSeg[], i: number): Pt | null {
  const prev = segs[i - 1];
  return prev && prev.kind !== "close" ? prev.to : null;
}

/** The point of segment `i` at `t` (0 to 1). */
function pointAt(segs: readonly PathSeg[], i: number, t: number): Pt | null {
  const s = segs[i];
  const a = startOf(segs, i);
  if (!s || s.kind === "close" || s.kind === "move" || !a) return null;
  if (s.kind === "line") return lerp(a, s.to, t);
  return evalCubic(a, s.c1, s.c2, s.to, t);
}

/** The place on the path nearest `p` (slide fractions, measured in
 *  `scale` units so a distance means the same both ways). */
export function nearestOnPath(
  segs: readonly PathSeg[],
  p: Pt,
  scale: Pt = [1, 1],
): { seg: number; t: number; dist: number } | null {
  let best: { seg: number; t: number; dist: number } | null = null;
  const steps = 48;
  segs.forEach((_, seg) => {
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const q = pointAt(segs, seg, t);
      if (!q) return;
      const dist = Math.hypot(
        (q[0] - p[0]) * scale[0],
        (q[1] - p[1]) * scale[1],
      );
      if (!best || dist < best.dist) best = { seg, t, dist };
    }
  });
  return best;
}

/** Add a point on segment `seg` at `t`: a line splits in two, a curve at
 *  de Casteljau's point, so the path keeps its shape. */
export function insertPoint(
  segs: readonly PathSeg[],
  seg: number,
  t: number,
): PathSeg[] {
  const s = segs[seg];
  const a = startOf(segs, seg);
  if (!s || !a || (s.kind !== "line" && s.kind !== "curve")) return [...segs];
  const out = [...segs];
  if (s.kind === "line") {
    out.splice(seg, 1, { kind: "line", to: lerp(a, s.to, t) }, s);
    return out;
  }
  const cut = splitSegmentDeCasteljau(a, s.c1, s.c2, s.to, t);
  out.splice(
    seg,
    1,
    { kind: "curve", c1: cut.startRight, c2: cut.midLeft, to: cut.midAnchor },
    { kind: "curve", c1: cut.midRight, c2: cut.endLeft, to: s.to },
  );
  return out;
}

/** Delete the anchor that segment `seg` ends at; a path keeps at least
 *  two points. The neighbouring segments join into one. */
export function deletePoint(segs: readonly PathSeg[], seg: number): PathSeg[] {
  const ends = segs.filter((x) => x.kind !== "close").length;
  const s = segs[seg];
  if (!s || s.kind === "close" || ends <= 2) return [...segs];
  const out = [...segs];
  const next = out[seg + 1];
  if (seg === 0) {
    // The start point goes: the next end point becomes the start.
    if (next && next.kind !== "close") {
      out.splice(0, 2, { kind: "move", to: next.to });
    }
    return out;
  }
  if (!next || next.kind === "close") {
    out.splice(seg, 1);
    return out;
  }
  const a = startOf(segs, seg)!;
  if (s.kind !== "curve" && next.kind !== "curve") {
    out.splice(seg, 2, { kind: "line", to: next.to });
  } else {
    const c1 = s.kind === "curve" ? s.c1 : a;
    const c2 = next.kind === "curve" ? next.c2 : next.to;
    out.splice(seg, 2, { kind: "curve", c1, c2, to: next.to });
  }
  return out;
}

/** The page point of a path point. */
export function toPage(st: MotionPathState, p: Pt): Pt {
  return [st.origin[0] + p[0] * st.slide[0], st.origin[1] + p[1] * st.slide[1]];
}

/** The path point under a page point. */
export function fromPage(st: MotionPathState, p: Pt): Pt {
  return [
    (p[0] - st.origin[0]) / st.slide[0],
    (p[1] - st.origin[1]) / st.slide[1],
  ];
}

/** An SVG path of `segs`, page pt. */
export function svgPath(st: MotionPathState, segs: readonly PathSeg[]): string {
  const f = (p: Pt) =>
    toPage(st, p)
      .map((v) => v.toFixed(2))
      .join(" ");
  return segs
    .map((s) => {
      switch (s.kind) {
        case "move":
          return `M ${f(s.to)}`;
        case "line":
          return `L ${f(s.to)}`;
        case "curve":
          return `C ${f(s.c1)} ${f(s.c2)} ${f(s.to)}`;
        default:
          return "Z";
      }
    })
    .join(" ");
}

/** The picked effect's motion path, kept current; drags edit it. */
export class MotionPathModel implements Disposable {
  private state: MotionPathState = EMPTY;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private dragging = false;

  constructor(
    private readonly host: BundleHost,
    private readonly engine: () => Promise<SlideEngine>,
    private readonly authoring: AnimationAuthoring,
    private readonly slideSize: (pageId: string) => [number, number] | null,
  ) {}

  snapshot = (): MotionPathState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(next: MotionPathState) {
    this.state = next;
    for (const l of this.listeners) l();
  }

  /** Show `effect`'s path (none for an effect without one). */
  async show(pageId: string | null, effect: EffectInfo | null): Promise<void> {
    if (this.dragging) return;
    const gen = ++this.generation;
    if (!pageId || !effect?.path || !effect.target) {
      if (this.state !== EMPTY) this.set(EMPTY);
      return;
    }
    const engine = await this.engine();
    const segs = engine.pathSegments(effect.path);
    const page = await this.authoring.shapes(pageId);
    const t = effect.target;
    const shape = page?.shapes.find(
      (s) =>
        (t.key && s.key === t.key) ||
        s.items.some((i) => t.item && idOf(i.id) === t.item),
    );
    const slide = this.slideSize(pageId);
    if (gen !== this.generation) return;
    if (!shape || !slide) {
      this.set(EMPTY);
      return;
    }
    this.machine = null;
    this.set({
      pageId,
      index: effect.index,
      segs,
      origin: [shape.box.x + shape.box.w / 2, shape.box.y + shape.box.h / 2],
      slide,
      locked: effect.pathLocked === true,
    });
  }

  /** The path's machine: the host's Direct Selection over the path in
   *  slide fractions, mapped onto the page from where the shape stands.
   *  Kept across presses so the selection holds (Shift adds). */
  private machine: DirectSelectMachine | null = null;
  private machineOf(scale: number): DirectSelectMachine {
    const st = this.state;
    const transform = [
      st.slide[0],
      0,
      0,
      st.slide[1],
      st.origin[0],
      st.origin[1],
    ];
    const table = tableOfSegs(st.segs).table;
    const slop = 2 / (scale || 1);
    if (!this.machine) {
      this.machine = new DirectSelectMachine({
        table,
        transform: transform as never,
        slop,
        nudgeStep: 1,
      });
    } else {
      this.machine.sync(table, transform as never);
      this.machine.setOptions({ slop });
    }
    return this.machine;
  }

  /** A press of the path at page point `p` on `hit`. */
  press(
    hit: DirectSelectHit,
    p: Pt,
    modifiers: DirectSelectModifiers,
    scale: number,
  ): void {
    if (!this.state.pageId) return;
    this.preDrag = this.state.segs;
    this.dragging = true;
    const snap = this.machineOf(scale).handle({
      type: "down",
      point: p,
      hit,
      modifiers,
    });
    this.set({ ...this.state, selected: snap.selected });
  }

  /** The pointer moved: the path as the drag would leave it. */
  move(p: Pt, modifiers: DirectSelectModifiers): void {
    if (!this.machine || !this.dragging) return;
    const snap = this.machine.handle({ type: "move", point: p, modifiers });
    const segs = segsOfTable(
      mapTable(snap.table, (q) => fromPage(this.state, q)),
    );
    this.set({ ...this.state, segs, selected: snap.selected });
  }

  /** Release: the machine's plan applied to the path and written, one
   *  undo step; a click only selects. */
  async release(p: Pt, modifiers: DirectSelectModifiers): Promise<boolean> {
    if (!this.machine || !this.dragging) return false;
    const before = this.preDrag;
    const snap = this.machine.handle({ type: "up", point: p, modifiers });
    this.dragging = false;
    if (!snap.commit) {
      this.set({ ...this.state, segs: before, selected: snap.selected });
      return false;
    }
    const segs = segsOfTable(
      applyPathOps(tableOfSegs(before).table, snap.commit.ops),
    );
    this.set({ ...this.state, segs, selected: snap.selected });
    return this.commit(segs);
  }

  /** The path before the drag in flight (what a cancel restores). */
  private preDrag: readonly PathSeg[] = [];

  /** Release: write `segs` into the timing, one undo step. */
  async commit(segs: readonly PathSeg[]): Promise<boolean> {
    this.dragging = false;
    const { pageId, index } = this.state;
    if (!pageId || index === null) return false;
    const path = (await this.engine()).pathWrite(segs);
    const out = await this.authoring.edit(pageId, {
      kind: "path",
      index,
      path,
    });
    if (!out.ok) this.host.log.warn(`paged.slide motion path: ${out.reason}`);
    return out.ok;
  }

  /** Add a point where the path passes nearest page point `p` (within a
   *  few pt), one undo step. */
  async addPointAt(p: Pt): Promise<boolean> {
    const st = this.state;
    const hit = nearestOnPath(st.segs, fromPage(st, p), st.slide);
    if (!hit || hit.dist > 8) return false;
    return this.commit(insertPoint(st.segs, hit.seg, hit.t));
  }

  /** Delete the anchor that segment `seg` ends at, one undo step. */
  async deleteAnchor(seg: number): Promise<boolean> {
    const next = deletePoint(this.state.segs, seg);
    if (next.length === this.state.segs.length && seg !== 0) return false;
    return this.commit(next);
  }

  /** A drag interrupted: the path as it was, nothing written. */
  cancel() {
    if (!this.dragging) return;
    this.dragging = false;
    this.machine?.handle({
      type: "key",
      key: "Escape",
      modifiers: { shift: false, alt: false },
    });
    this.set({ ...this.state, segs: this.preDrag });
  }

  dispose() {
    this.listeners.clear();
  }
}

/** Handle size on screen, CSS px. */
const HANDLE_PX = 4;

/** The overlay contribution that draws `model`'s path and handles. */
export function motionPathOverlay(model: MotionPathModel): OverlayContribution {
  const Render: React.FC<OverlayProps> = ({ camera, pageRects }) => {
    const s = React.useSyncExternalStore(model.subscribe, model.snapshot);
    const rect = s.pageId ? pageRects.get(s.pageId) : undefined;
    if (!rect || s.segs.length === 0)
      return <g data-slide-motion-path="" data-count={0} />;
    const inv = 1 / (camera.scale || 1);
    const pageOf = (
      svg: SVGSVGElement | null | undefined,
      ev: { clientX: number; clientY: number },
    ): Pt => {
      const box = svg?.getBoundingClientRect();
      return [
        (ev.clientX - (box?.left ?? 0) - camera.tx) / camera.scale - rect.x,
        (ev.clientY - (box?.top ?? 0) - camera.ty) / camera.scale - rect.y,
      ];
    };
    const mods = (ev: { shiftKey: boolean; altKey: boolean }) => ({
      shift: ev.shiftKey,
      alt: ev.altKey,
    });
    /** A press on the path: the host's Direct Selection takes it. */
    const onPress =
      (hitAt: (p: Pt) => DirectSelectHit | null) =>
      (e: React.PointerEvent<SVGElement>) => {
        if (e.button !== 0) return;
        const svg = (e.currentTarget as SVGElement).ownerSVGElement;
        const p = pageOf(svg, e);
        const hit = hitAt(p);
        if (!hit) return;
        e.preventDefault();
        e.stopPropagation();
        model.press(hit, p, mods(e), camera.scale);
        const move = (ev: PointerEvent) =>
          model.move(pageOf(svg, ev), mods(ev));
        const done = (ev: PointerEvent | null) => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", cancel);
          if (ev) void model.release(pageOf(svg, ev), mods(ev));
          else model.cancel();
        };
        const up = (ev: PointerEvent) => done(ev);
        const cancel = () => done(null);
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", cancel);
      };
    const onDown = (h: PathHandle) => onPress(() => hitOf(s.segs, h));
    /** A press on a segment: its start anchor and the grabbed point. */
    const onSegment = onPress((p) => {
      const near = nearestOnPath(s.segs, fromPage(s, p), s.slide);
      if (!near || near.dist > 8) return null;
      const start = tableOfSegs(s.segs).anchorOf[near.seg - 1] ?? -1;
      return start < 0 ? null : { kind: "segment", index: start, t: near.t };
    });
    const selected = new Set(s.selected ?? []);
    const anchorIndex = tableOfSegs(s.segs).anchorOf;
    const ends = s.segs.filter(
      (x): x is Exclude<PathSeg, { kind: "close" }> => x.kind !== "close",
    );
    const first = ends[0];
    const lastSeg = ends[ends.length - 1];
    const marker = (p: Pt, fill: string, key: string) => {
      const q = toPage(s, p);
      return (
        <path
          key={key}
          data-slide-motion-path-end={key}
          transform={`translate(${q[0]} ${q[1]}) scale(${inv})`}
          d="M-5 -4 L5 0 L-5 4 Z"
          fill={fill}
          pointerEvents="none"
        />
      );
    };
    return (
      <g
        data-slide-motion-path=""
        data-count={s.segs.length}
        data-locked={s.locked ? "1" : "0"}
        transform={`translate(${rect.x} ${rect.y})`}
      >
        <path
          d={svgPath(s, s.segs)}
          fill="none"
          stroke="#555"
          strokeWidth={1.25}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
        <path
          data-slide-motion-path-hit=""
          d={svgPath(s, s.segs)}
          fill="none"
          stroke="transparent"
          strokeWidth={10}
          vectorEffect="non-scaling-stroke"
          style={{ pointerEvents: "stroke" }}
          onPointerDown={onSegment}
          onDoubleClick={(e) => {
            e.stopPropagation();
            const box =
              e.currentTarget.ownerSVGElement?.getBoundingClientRect();
            void model.addPointAt([
              (e.clientX - (box?.left ?? 0) - camera.tx) / camera.scale -
                rect.x,
              (e.clientY - (box?.top ?? 0) - camera.ty) / camera.scale - rect.y,
            ]);
          }}
        />
        {first ? marker(first.to, "#2e9d4a", "start") : null}
        {lastSeg ? marker(lastSeg.to, "#d0312d", "end") : null}
        {s.segs.map((seg, i) => {
          if (seg.kind !== "curve") return null;
          const prev = s.segs[i - 1];
          const from: Pt | null =
            prev && prev.kind !== "close" ? prev.to : null;
          const a = from ? toPage(s, from) : null;
          const c1 = toPage(s, seg.c1);
          const c2 = toPage(s, seg.c2);
          const b = toPage(s, seg.to);
          return (
            <g key={`arms-${i}`} pointerEvents="none">
              {a ? (
                <line
                  x1={a[0]}
                  y1={a[1]}
                  x2={c1[0]}
                  y2={c1[1]}
                  stroke="#1a73e8"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
              <line
                x1={b[0]}
                y1={b[1]}
                x2={c2[0]}
                y2={c2[1]}
                stroke="#1a73e8"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
        {handlesOf(s.segs).map((h) => {
          const q = toPage(s, handlePoint(s.segs, h));
          const anchor = h.which === "to";
          return (
            <path
              key={`${h.seg}-${h.which}`}
              data-slide-motion-path-handle={`${h.seg}:${h.which}`}
              transform={`translate(${q[0]} ${q[1]}) scale(${inv})`}
              d={
                anchor
                  ? `M${-HANDLE_PX} ${-HANDLE_PX} H${HANDLE_PX} V${HANDLE_PX} H${-HANDLE_PX} Z`
                  : `M${HANDLE_PX} 0 A${HANDLE_PX} ${HANDLE_PX} 0 1 1 ${-HANDLE_PX} 0 A${HANDLE_PX} ${HANDLE_PX} 0 1 1 ${HANDLE_PX} 0 Z`
              }
              data-selected={
                anchor && selected.has(anchorIndex[h.seg] ?? -1) ? "1" : "0"
              }
              fill={
                anchor && !selected.has(anchorIndex[h.seg] ?? -1)
                  ? "#fff"
                  : "#1a73e8"
              }
              stroke="#1a73e8"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              style={{ cursor: "default", pointerEvents: "all" }}
              onPointerDown={onDown(h)}
              onDoubleClick={
                anchor
                  ? (e) => {
                      e.stopPropagation();
                      void model.deleteAnchor(h.seg);
                    }
                  : undefined
              }
            />
          );
        })}
      </g>
    );
  };
  return { id: MOTION_PATH_OVERLAY_ID, render: Render, z: 331 };
}
