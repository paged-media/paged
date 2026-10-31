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

// The Width tool. Two results (its `mode` option, WP6.4):
//
//   · LIVE (the default) — a drag anywhere on the SELECTED item's stroke
//     adds a width point there (or moves the one within reach) and the
//     drag's distance from the path sets its width; the release writes
//     the item's `widthProfile` stroke style (engine ADR 10XX) — the
//     path keeps its anchors and the profile stays editable, one undo
//     step per drag. Any path, closed or compound, rectangle, ellipse or
//     text frame. The overlay previews the band the profile draws.
//   · OUTLINE — the v0 behaviour, kept: a drag near an anchor of a
//     single-contour open path peaks a per-anchor profile there and bakes
//     it through `outlineStrokeVariable` (the centreline becomes its
//     filled outline). A graphic line, which carries no stroke style,
//     always takes this lane, and so does a host whose engine has no
//     stroke styles (`document.strokeStyles@1`).
//
// The pointer-down resolve (selection → pathAnchors → local space) is
// async; events are SERIALIZED through a promise chain so each gesture
// sees down → moves → up in order even while the reads are in flight.

import type {
  BundleHost,
  CanvasPointerEvent,
  ElementId,
  GestureHandler,
} from "@paged-media/plugin-api";

import {
  affineScale,
  anchorTangentAngle,
  applyAffine,
  inverseApplyAffine,
  measureAnchorRun,
  nearestOnRun,
  widthFactorAt,
  widthOutlinePolyline,
  withWidthPoint,
  type AnchorTriple,
  type Affine,
  type RunLocation,
  type Vec2,
} from "@paged-media/draw-geometry";
import { WidthMachine, type WidthSnapshot } from "@paged-media/draw-tools";

import { outlineStrokeVariableMutationFor } from "./brush";
import { outlineParamsOf, supportsPathOps } from "../commands/path-ops";
import { WIDTH_OPTIONS, createToolOptionsReader } from "../tool-options";
import {
  readStroke,
  stackMutationFor,
  takesStrokeStyle,
  widthProfileEntryFor,
  withStrokeStyle,
  type StackEntry,
} from "../commands/brushes";

/** Screen-space pick radius around anchors (the anchors.ts constant
 *  family). */
const PICK_TOLERANCE_PX = 8;

/** The profile DEFAULTS: the peak decays over 2 neighbors, 1 pt of
 *  width per pt of drag, peak capped at 72 pt. All three are tool
 *  OPTIONS now (`../tool-options.ts` — `falloff` / `gain` / `maxWidth`),
 *  and these constants are what the options default to (the options spec
 *  asserts the two never drift apart). */
export const WIDTH_FALLOFF_ANCHORS = 2;
export const WIDTH_GAIN = 1;
export const WIDTH_MAX_PT = 72;

/** A live width-point drag (see the header). */
interface LiveWidthGesture {
  live: true;
  target: ElementId;
  pageId: string;
  matrix: Affine | null;
  toLocal(p: Vec2): Vec2 | null;
  /** The contour pressed on, its open flag, and where on it. */
  contour: readonly AnchorTriple[];
  closed: boolean;
  at: RunLocation;
  weight: number;
  stack: StackEntry[];
  points: readonly (readonly [number, number])[];
  /** The width the drag sets, × the weight; null until it moves. */
  factor: number | null;
  maxFactor: number;
}

/** The contours of an anchor table: each run of anchors and whether it is
 *  closed. */
function contoursOf(table: {
  anchors: readonly AnchorTriple[];
  subpathStarts: readonly number[];
  subpathOpen?: readonly boolean[] | null;
}): { anchors: AnchorTriple[]; closed: boolean }[] {
  const starts =
    table.subpathStarts.length > 0 ? [...table.subpathStarts] : [0];
  return starts.map((s, i) => ({
    anchors: table.anchors.slice(s, starts[i + 1] ?? table.anchors.length),
    closed: table.subpathOpen?.[i] !== true,
  }));
}

/** The width points a stack's `widthProfile` entry holds. */
function pointsOf(stack: readonly StackEntry[]): [number, number][] {
  const e = stack.find((x) => x.kind === "widthProfile");
  const pts = e?.widthPoints;
  return Array.isArray(pts) ? (pts as [number, number][]) : [];
}

interface WidthGesture {
  live?: false;
  machine: WidthMachine;
  target: ElementId;
  pageId: string;
  anchors: readonly AnchorTriple[];
  matrix: Affine | null;
  toLocal(p: Vec2): Vec2 | null;
}

export function createWidthHandler(host: BundleHost): GestureHandler {
  // The serialized gesture: null = idle; a promise resolving to null =
  // the down could not arm (no valid target / off-anchor).
  let gesture: Promise<WidthGesture | LiveWidthGesture | null> | null = null;
  const options = createToolOptionsReader(WIDTH_OPTIONS);

  const clearPreview = () => host.overlay.setToolPreview(null);

  /** LIVE: arm a width-point drag on the selected item's stroke. */
  const beginLive = async (
    e: CanvasPointerEvent,
    target: ElementId,
  ): Promise<LiveWidthGesture | null> => {
    if (!e.pageId || !e.pagePoint) return null;
    const table = await host.document.pathAnchors(target).catch(() => null);
    if (!table || table.pageId !== e.pageId || table.anchors.length < 2)
      return null;
    const matrix = table.itemTransform ?? null;
    const toLocal = (p: Vec2): Vec2 | null =>
      inverseApplyAffine(matrix, p[0], p[1]);
    const local = toLocal(e.pagePoint);
    if (!local) return null;
    const read = await readStroke(host, target);
    const points = pointsOf(read.stack);
    let best: {
      at: RunLocation;
      anchors: AnchorTriple[];
      closed: boolean;
    } | null = null;
    for (const c of contoursOf(table)) {
      const at = nearestOnRun(
        measureAnchorRun(c.anchors, { close: c.closed }),
        local,
      );
      if (at && (!best || at.distance < best.at.distance))
        best = { at, anchors: c.anchors, closed: c.closed };
    }
    if (!best) return null;
    const reach =
      host.viewport.pxToPt(PICK_TOLERANCE_PX) / affineScale(matrix) +
      (read.weight * widthFactorAt(points, best.at.u)) / 2;
    if (best.at.distance > reach) return null; // off the stroke
    return {
      live: true,
      target,
      pageId: e.pageId,
      matrix,
      toLocal,
      contour: best.anchors,
      closed: best.closed,
      at: best.at,
      weight: read.weight,
      stack: read.stack,
      points,
      factor: null,
      maxFactor: options.number("maxWidth") / read.weight,
    };
  };

  const previewLive = (g: LiveWidthGesture) => {
    const pts =
      g.factor === null ? g.points : withWidthPoint(g.points, g.at.u, g.factor);
    const line = widthOutlinePolyline(g.contour, g.closed, g.weight, pts);
    if (line.length < 2) {
      clearPreview();
      return;
    }
    host.overlay.setToolPreview({
      pageId: g.pageId,
      points: line.map((p) =>
        g.matrix ? (applyAffine(g.matrix, p[0], p[1]) as [number, number]) : p,
      ) as [number, number][],
    });
  };

  const commitLive = async (g: LiveWidthGesture) => {
    if (g.factor === null) return;
    const entry = widthProfileEntryFor(
      withWidthPoint(g.points, g.at.u, g.factor),
    );
    const outcome = await host.document.mutate(
      stackMutationFor(
        g.target,
        withStrokeStyle(g.stack, "widthProfile", entry),
      ),
    );
    if (!outcome.applied) {
      host.log.warn(
        `width: the live profile was refused: ${JSON.stringify(outcome.error)}`,
      );
    }
  };

  const beginGesture = async (
    e: CanvasPointerEvent,
  ): Promise<WidthGesture | LiveWidthGesture | null> => {
    if (!e.pageId || !e.pagePoint) return null;
    if (
      options.select("mode") === "live" &&
      host.supports("document.strokeStyles@1")
    ) {
      const target = host.selection.get().find(takesStrokeStyle) ?? null;
      if (target) {
        const g = await beginLive(e, target);
        if (g) previewLive(g);
        return g;
      }
    }
    return beginOutline(e);
  };

  const beginOutline = async (
    e: CanvasPointerEvent,
  ): Promise<WidthGesture | null> => {
    if (!e.pageId || !e.pagePoint) return null;
    const target = host.selection.get().find(supportsPathOps) ?? null;
    if (!target) {
      host.log.debug(
        "width: no path-bearing selection — select an open path first",
      );
      return null;
    }
    const table = await host.document.pathAnchors(target).catch(() => null);
    if (!table || table.pageId !== e.pageId) return null;
    // v0 gate: a single OPEN contour (the outline kernel's lane).
    const contours = Math.max(1, table.subpathStarts.length);
    const open = table.subpathOpen?.[0] === true;
    if (contours > 1 || !open) {
      host.log.debug(
        "width: v0 targets a single-contour OPEN path — no-op on closed/compound",
      );
      return null;
    }
    const matrix = table.itemTransform ?? null;
    const toLocal = (p: Vec2): Vec2 | null =>
      inverseApplyAffine(matrix, p[0], p[1]);
    const local = toLocal(e.pagePoint);
    if (!local) return null;
    const tolerance =
      host.viewport.pxToPt(PICK_TOLERANCE_PX) / affineScale(matrix);
    const base = (await outlineParamsOf(host, target)).width;
    const machine = new WidthMachine({
      anchors: table.anchors.map((a) => [a.anchor[0], a.anchor[1]]),
      tolerance,
      baseWidth: base,
      // Read on the press, so a drag is one profile from start to
      // release even if the popover changes a value mid-gesture.
      falloff: options.number("falloff"),
      gain: options.number("gain"),
      maxWidth: options.number("maxWidth"),
    });
    const snap = machine.handle({ type: "down", point: local });
    if (!snap.active) return null; // off-anchor press
    const g: WidthGesture = {
      machine,
      target,
      pageId: e.pageId,
      anchors: table.anchors,
      matrix,
      toLocal,
    };
    preview(g, snap);
    return g;
  };

  /** The live preview: a tick PERPENDICULAR to the path at the peaked
   *  anchor, spanning the current peak width (computed in local space,
   *  mapped through the item transform — honest profile data). */
  const preview = (g: WidthGesture, snap: WidthSnapshot) => {
    if (!snap.active || snap.peakIndex < 0 || !snap.widths) {
      clearPreview();
      return;
    }
    const a = g.anchors[snap.peakIndex];
    if (!a) {
      clearPreview();
      return;
    }
    const angle = anchorTangentAngle(g.anchors, snap.peakIndex, false);
    const w = snap.widths[snap.peakIndex] / 2;
    const nx = -Math.sin(angle) * w;
    const ny = Math.cos(angle) * w;
    const toPage = (x: number, y: number): [number, number] =>
      g.matrix ? (applyAffine(g.matrix, x, y) as [number, number]) : [x, y];
    host.overlay.setToolPreview({
      pageId: g.pageId,
      points: [
        toPage(a.anchor[0] - nx, a.anchor[1] - ny),
        toPage(a.anchor[0] + nx, a.anchor[1] + ny),
      ],
    });
  };

  const commit = async (g: WidthGesture, widths: number[]) => {
    // The DESTRUCTIVE bake: one mutation, one undo step (see the
    // header's honest scope).
    const outcome = await host.document.mutate(
      outlineStrokeVariableMutationFor(g.target, widths),
    );
    if (!outcome.applied) {
      host.log.warn(
        `width bake rejected by engine: ${JSON.stringify(outcome.error)}`,
      );
    }
  };

  const feed = (
    event:
      | { type: "move"; point: Vec2; pageId: string | null }
      | { type: "up"; point: Vec2; pageId: string | null }
      | { type: "key"; key: string },
  ) => {
    if (!gesture) return;
    const chain = gesture;
    gesture = chain.then((g) => {
      if (!g) return null;
      if (g.live) {
        if (event.type === "key") {
          clearPreview();
          return null;
        }
        const onPage = event.pageId === g.pageId;
        const local = onPage ? g.toLocal(event.point) : null;
        if (!local) {
          clearPreview();
          return null;
        }
        const d = Math.abs(
          (local[0] - g.at.point[0]) * g.at.normal[0] +
            (local[1] - g.at.point[1]) * g.at.normal[1],
        );
        g.factor = Math.min(g.maxFactor, (2 * d) / g.weight);
        if (event.type === "up") {
          clearPreview();
          void commitLive(g).catch((err) =>
            host.log.warn(`width commit failed: ${err}`),
          );
          return null;
        }
        previewLive(g);
        return g;
      }
      const onPage = "pageId" in event ? event.pageId === g.pageId : true;
      const local = "point" in event && onPage ? g.toLocal(event.point) : null;
      const snap =
        event.type === "key"
          ? g.machine.handle({ type: "key", key: event.key })
          : local
            ? g.machine.handle({ type: event.type, point: local })
            : g.machine.handle({ type: "key", key: "Escape" }); // off-page → cancel
      if (snap.commit) {
        clearPreview();
        void commit(g, snap.commit.widths).catch((err) =>
          host.log.warn(`width commit failed: ${err}`),
        );
        return null;
      }
      if (!snap.active) {
        clearPreview();
        return null;
      }
      preview(g, snap);
      return g;
    });
  };

  return {
    onActivate(paged) {
      // Per-drag state allocates on pointer-down; this only binds the
      // options reader to the host's store.
      options.attach(paged);
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      gesture = null;
      clearPreview();
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (e.button !== 0) return;
      gesture = beginGesture(e).catch((err) => {
        host.log.warn(`width begin failed: ${err}`);
        return null;
      });
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!e.pagePoint) return;
      feed({ type: "move", point: e.pagePoint, pageId: e.pageId ?? null });
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (e.pagePoint) {
        feed({ type: "up", point: e.pagePoint, pageId: e.pageId ?? null });
      } else {
        feed({ type: "key", key: "Escape" });
      }
      gesture = null;
    },
    onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      feed({ type: "key", key: "Escape" });
      gesture = null;
    },
  };
}
