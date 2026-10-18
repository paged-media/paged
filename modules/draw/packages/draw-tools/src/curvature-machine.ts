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

// The Curvature tool's state machine — host-agnostic, the pen-machine
// pattern: page-local pt events in, a snapshot (fitted smooth anchors +
// preview + optional commit) out. Illustrator-parity semantics
// (§ curvature):
//
//   click            → place a SMOOTH point; the curve is refitted to
//                      pass through every placed point (Catmull-Rom
//                      handles — draw-geometry's smoothAnchorsThrough)
//   alt+click        → place a CORNER point
//   click a PLACED   → toggle that point corner ↔ smooth (the
//   point              "click = corner toggle" gesture)
//   hover            → the preview is refitted INCLUDING the hover
//                      point (the live rubber curve)
//   click 1st point  → close the path (commit { open: false }, fitted
//                      with wraparound smoothing)
//   Enter            → commit the open path (≥ 2 points)
//   Escape           → cancel
//
// Unlike the Pen there is no drag-to-pull-handles: handles are always
// DERIVED from the point sequence (that is the curvature tool's whole
// deal), so down/up carry click semantics only.

import {
  clone,
  dist,
  smoothAnchorsThrough,
  type AnchorTriple,
  type Vec2,
} from "@paged-media/draw-geometry";

import type { ToolPreviewPath } from "@paged-media/plugin-api";

export interface CurvatureModifiers {
  alt: boolean;
}

export type CurvatureEvent =
  | { type: "down"; point: Vec2; modifiers: CurvatureModifiers }
  | { type: "move"; point: Vec2 }
  | { type: "up"; point: Vec2 }
  | { type: "key"; key: "Enter" | "Escape" };

export interface CurvatureCommit {
  anchors: AnchorTriple[];
  open: boolean;
}

export interface CurvatureSnapshot {
  /** The placed points, fitted (smooth/corner per flag) — the committed
   *  geometry-so-far. */
  anchors: readonly AnchorTriple[];
  /** The fit INCLUDING the hover point (the rubber curve the host
   *  previews); equals `anchors` while there is no hover. */
  previewAnchors: readonly AnchorTriple[];
  /** Hovering within close-tolerance of the first point. */
  closePreview: boolean;
  /** Non-null exactly once, when the path completes. */
  commit: CurvatureCommit | null;
  /** False once committed or cancelled — the shim resets then. */
  active: boolean;
}

export interface CurvatureOptions {
  /** Click-on-first-point radius, page-local pt (host converts a screen
   *  tolerance at the current zoom). */
  closeTolerance: number;
  /** Click-on-a-placed-point radius for the corner toggle. Defaults to
   *  `closeTolerance`. */
  pointTolerance?: number;
}

export class CurvatureMachine {
  private points: Vec2[] = [];
  private corners: boolean[] = [];
  private hover: Vec2 | null = null;
  private done = false;

  constructor(private readonly options: CurvatureOptions) {}

  handle(event: CurvatureEvent): CurvatureSnapshot {
    if (this.done) return this.snapshot(null);
    switch (event.type) {
      case "down":
        return this.onDown(event.point, event.modifiers);
      case "move":
        this.hover = clone(event.point);
        return this.snapshot(null);
      case "up":
        // Click semantics resolved on down; handles are derived, never
        // dragged — up carries nothing.
        return this.snapshot(null);
      case "key":
        return this.onKey(event.key);
    }
  }

  private onDown(point: Vec2, modifiers: CurvatureModifiers): CurvatureSnapshot {
    this.hover = null;
    // Closing click: on the first point with a closeable run.
    if (
      this.points.length >= 2 &&
      dist(point, this.points[0]) <= this.options.closeTolerance
    ) {
      this.done = true;
      return this.snapshot({
        anchors: smoothAnchorsThrough(this.points, this.corners, true),
        open: false,
      });
    }
    // Corner toggle: a click on an already-placed point (not the first
    // — that closes, above).
    const tol = this.options.pointTolerance ?? this.options.closeTolerance;
    for (let i = 1; i < this.points.length; i++) {
      if (dist(point, this.points[i]) <= tol) {
        this.corners[i] = !this.corners[i];
        return this.snapshot(null);
      }
    }
    // Place a new point — smooth by default, corner with Alt.
    this.points.push(clone(point));
    this.corners.push(modifiers.alt);
    return this.snapshot(null);
  }

  private onKey(key: "Enter" | "Escape"): CurvatureSnapshot {
    this.done = true;
    if (key === "Escape" || this.points.length < 2) {
      this.points = [];
      this.corners = [];
      return this.snapshot(null);
    }
    return this.snapshot({
      anchors: smoothAnchorsThrough(this.points, this.corners, false),
      open: true,
    });
  }

  private snapshot(commit: CurvatureCommit | null): CurvatureSnapshot {
    const anchors = smoothAnchorsThrough(this.points, this.corners, false);
    const closePreview =
      !this.done &&
      this.hover !== null &&
      this.points.length >= 2 &&
      dist(this.hover, this.points[0]) <= this.options.closeTolerance;
    // The rubber curve: refit including the hover point (smooth), or —
    // when snapping to close — the wraparound fit of the placed points.
    let previewAnchors: AnchorTriple[] = anchors;
    if (!this.done && this.hover !== null && this.points.length > 0) {
      previewAnchors = closePreview
        ? smoothAnchorsThrough(this.points, this.corners, true)
        : smoothAnchorsThrough(
            [...this.points, this.hover],
            [...this.corners, false],
            false,
          );
    }
    return {
      anchors,
      previewAnchors,
      closePreview,
      commit,
      active: !this.done,
    };
  }
}

/**
 * Frame the curvature snapshot's rubber curve as the cubic
 * `ToolPreviewPath` (the B-07 channel the pen preview uses) — `null`
 * when the run is too short to stroke.
 */
export function curvaturePreview(
  snapshot: CurvatureSnapshot,
  pageId: string,
  options?: { dashed?: boolean },
): ToolPreviewPath | null {
  const anchors = snapshot.previewAnchors.map((a) => ({
    anchor: [a.anchor[0], a.anchor[1]] as [number, number],
    left: [a.left[0], a.left[1]] as [number, number],
    right: [a.right[0], a.right[1]] as [number, number],
  }));
  if (anchors.length < 2) return null;
  return {
    pageId,
    anchors,
    close: snapshot.closePreview,
    ...(options?.dashed ? { dashed: true } : {}),
  };
}
