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
// channel (`contribute.overlay`, the adjust handles' door) rather than
// through draw's tools; what a path is and how it is written are the slide
// engine's (`pathSegments`, `pathWrite`).

import type {
  BundleHost,
  Disposable,
  OverlayContribution,
  OverlayProps,
} from "@paged-media/plugin-api";
import {
  evalCubic,
  splitSegmentDeCasteljau,
} from "@paged-media/vector-geometry";
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

/** `seg`'s points that the handle names, moved by `d` (slide fractions);
 *  an anchor drags its handles with it. */
export function moveHandle(
  segs: readonly PathSeg[],
  h: PathHandle,
  to: Pt,
): PathSeg[] {
  const out = segs.map((s) => ({ ...s })) as PathSeg[];
  const s = out[h.seg];
  if (!s || s.kind === "close") return out;
  if (h.which === "to") {
    const from = s.to;
    const d: Pt = [to[0] - from[0], to[1] - from[1]];
    const shift = (p: Pt): Pt => [p[0] + d[0], p[1] + d[1]];
    s.to = to;
    if (s.kind === "curve") s.c2 = shift(s.c2);
    const next = out[h.seg + 1];
    if (next?.kind === "curve") next.c1 = shift(next.c1);
  } else if (s.kind === "curve") {
    s[h.which] = to;
  }
  return out;
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
    this.set({
      pageId,
      index: effect.index,
      segs,
      origin: [shape.box.x + shape.box.w / 2, shape.box.y + shape.box.h / 2],
      slide,
      locked: effect.pathLocked === true,
    });
  }

  /** A drag of `h` to the page point `p`: the path it would make. */
  drag(h: PathHandle, p: Pt): PathSeg[] {
    this.dragging = true;
    const segs = moveHandle(this.state.segs, h, fromPage(this.state, p));
    this.set({ ...this.state, segs });
    return segs;
  }

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

  cancel(original: readonly PathSeg[]) {
    this.dragging = false;
    this.set({ ...this.state, segs: original });
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
    const onDown = (h: PathHandle) => (e: React.PointerEvent<SVGElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const svg = (e.currentTarget as SVGElement).ownerSVGElement;
      const box = svg?.getBoundingClientRect();
      const page = (ev: PointerEvent | React.PointerEvent): Pt => [
        (ev.clientX - (box?.left ?? 0) - camera.tx) / camera.scale - rect.x,
        (ev.clientY - (box?.top ?? 0) - camera.ty) / camera.scale - rect.y,
      ];
      const original = s.segs;
      let last: PathSeg[] | null = null;
      const move = (ev: PointerEvent) => {
        last = model.drag(h, page(ev));
      };
      const done = (ev: PointerEvent | null) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        if (ev) move(ev);
        if (ev && last) void model.commit(last);
        else model.cancel(original);
      };
      const up = (ev: PointerEvent) => done(ev);
      const cancel = () => done(null);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
    };
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
              fill={anchor ? "#fff" : "#1a73e8"}
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
