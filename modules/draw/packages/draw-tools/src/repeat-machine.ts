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

// The on-canvas REPEAT widget's math (§12.4 "live on-canvas controls").
// Host-free pure geometry, the `corner-radius-machine.ts` shape: a drag
// from the source's centre in, the steered parameter and the guide
// polyline out. The gesture handler in draw-bundle owns the host wiring
// and the commit.
//
// WHAT "LIVE" MEANS HERE, EXACTLY — and this is the ceiling, not a
// to-do:
//   · The overlay door is `setToolPreview({ pageId, points })`, ONE
//     polyline. It cannot draw N instance outlines, so the drag
//     previews a GUIDE — the ring and its spoke, the lattice extent,
//     the mirror axis — and not the instances themselves.
//   · The instances are rebuilt ONCE, on pointer-UP. Re-planning per
//     pointer-move would be one document mutation (and one undo step)
//     per sample, which is worse than not being live.
// The bundle's command titles and the Repeat Options panel repeat both
// sentences; `repeat-machine` is where they are true.

import type { Vec2 } from "@paged-media/draw-geometry";

import type { Bounds } from "./corner-radius-machine";

/** Which repeat the drag is steering. */
export type RepeatSteerKind = "radial" | "grid" | "mirror";

/** The parameter patch a drag implies. Every field is optional because
 *  each kind steers a different pair; the caller merges what it gets. */
export interface RepeatSteer {
  /** radial — the ring radius, pt. */
  radiusPt?: number;
  /** radial — where the SOURCE sits on the ring, degrees. */
  startDeg?: number;
  /** grid — the gutter added to the source size, pt `[x, y]`
   *  (negative = a real geometric overlap). */
  spacing?: [number, number];
  /** mirror — the axis direction, degrees. */
  angleDeg?: number;
  /** mirror — how far off the source centre the axis sits, pt. */
  offsetPt?: number;
}

/** Modifier state the drag honours. `constrain` is the Shift key: it
 *  snaps the two ANGULAR parameters (radial start, mirror axis) to
 *  {@link CONSTRAIN_STEP_DEG}. There is nothing sensible to snap on the
 *  grid's spacing, so the flag is ignored there rather than pretending. */
export interface RepeatSteerModifiers {
  constrain?: boolean;
}

/** The Shift snap, degrees — InDesign/Illustrator's 45° increment. */
export const CONSTRAIN_STEP_DEG = 45;

/** Below this the drag is treated as "no radius yet" rather than
 *  producing a degenerate ring the size of the pointer jitter. */
export const MIN_RADIUS_PT = 1;

const angleOf = (from: Vec2, to: Vec2): number =>
  (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;

/** Snap an ANGLE to {@link CONSTRAIN_STEP_DEG}. Deliberately NOT
 *  draw-geometry's `constrainAngle`, which snaps a POINT around an
 *  origin and preserves its distance — here the distance is a separate
 *  steered parameter and must not move when Shift goes down. */
export function snapAngleDeg(deg: number, on: boolean | undefined): number {
  if (!on) return deg;
  return Math.round(deg / CONSTRAIN_STEP_DEG) * CONSTRAIN_STEP_DEG;
}

const snap = snapAngleDeg;

/**
 * The parameter patch a drag from `origin` (the SOURCE's centre) to
 * `point` implies.
 *
 *   · **radial** — the pointer places the ring CENTRE. The radius is
 *     the distance and `startDeg` is the direction from that centre
 *     back to the source, so the artwork the user drew never moves.
 *   · **grid** — the pointer places the NEXT cell's centre. The step is
 *     the delta; `spacing` is that step minus the source `size`, so a
 *     drag inside the source's own footprint yields a NEGATIVE spacing,
 *     which is a real overlap.
 *   · **mirror** — the pointer places a point ON the axis, and the axis
 *     runs PERPENDICULAR to the drag: dragging right puts a vertical
 *     axis to the right, which is the handle Illustrator shows.
 */
export function repeatSteer(
  kind: RepeatSteerKind,
  origin: Vec2,
  point: Vec2,
  size: Vec2,
  mods: RepeatSteerModifiers = {},
): RepeatSteer {
  const dx = point[0] - origin[0];
  const dy = point[1] - origin[1];
  const len = Math.hypot(dx, dy);
  if (kind === "radial") {
    if (len < MIN_RADIUS_PT) return { radiusPt: 0 };
    // The pointer is the ring centre; the source sits on the ring at
    // the angle FROM that centre TO the source.
    return {
      radiusPt: len,
      startDeg: snap(angleOf(point, origin), mods.constrain),
    };
  }
  if (kind === "grid") {
    return { spacing: [dx - size[0], dy - size[1]] };
  }
  const axis = snap(angleOf(origin, point) + 90, mods.constrain);
  return { angleDeg: axis, offsetPt: len };
}

// ------------------------------------------------------------- guides

/** What {@link repeatGuide} draws, per kind. Pure data, so the spec
 *  builds one by hand without a host. */
export type RepeatGuideSpec =
  | { kind: "radial"; center: Vec2; source: Vec2 }
  | {
      kind: "grid";
      bounds: Bounds;
      stepX: number;
      stepY: number;
      columns: number;
      rows: number;
    }
  | { kind: "mirror"; origin: Vec2; angleDeg: number; span: number };

/** How many segments the ring is drawn with. */
export const RING_SEGMENTS = 48;

/**
 * The ONE polyline the overlay draws while the drag is live.
 *
 *   · radial — the spoke from the ring centre out to the source, then
 *     the ring itself (one connected run, because the door takes one
 *     polyline and two would need two calls).
 *   · grid — the rectangle the whole lattice will occupy.
 *   · mirror — the axis segment, `span` long, centred on its origin.
 *
 * Returns `[]` when there is nothing meaningful to draw — the handler
 * then clears the preview rather than drawing a dot.
 */
export function repeatGuide(spec: RepeatGuideSpec): Vec2[] {
  if (spec.kind === "radial") {
    const r = Math.hypot(
      spec.source[0] - spec.center[0],
      spec.source[1] - spec.center[1],
    );
    if (r < MIN_RADIUS_PT) return [];
    const start = Math.atan2(
      spec.source[1] - spec.center[1],
      spec.source[0] - spec.center[0],
    );
    const points: Vec2[] = [[spec.center[0], spec.center[1]]];
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      const t = start + (i / RING_SEGMENTS) * Math.PI * 2;
      points.push([
        spec.center[0] + r * Math.cos(t),
        spec.center[1] + r * Math.sin(t),
      ]);
    }
    return points;
  }
  if (spec.kind === "grid") {
    const [top, left, bottom, right] = spec.bounds;
    const cols = Math.max(1, Math.round(spec.columns));
    const rows = Math.max(1, Math.round(spec.rows));
    const xs = [left, left + (cols - 1) * spec.stepX];
    const ys = [top, top + (rows - 1) * spec.stepY];
    const l = Math.min(xs[0], xs[1]);
    const r = Math.max(xs[0], xs[1]) + (right - left);
    const t = Math.min(ys[0], ys[1]);
    const b = Math.max(ys[0], ys[1]) + (bottom - top);
    return [
      [l, t],
      [r, t],
      [r, b],
      [l, b],
      [l, t],
    ];
  }
  const rad = (spec.angleDeg * Math.PI) / 180;
  const half = Math.max(1, spec.span) / 2;
  const dx = Math.cos(rad) * half;
  const dy = Math.sin(rad) * half;
  return [
    [spec.origin[0] - dx, spec.origin[1] - dy],
    [spec.origin[0] + dx, spec.origin[1] + dy],
  ];
}
