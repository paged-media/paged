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

// The live polyline of a freehand stroke (Pencil, Paintbrush, Blob Brush,
// Eraser) — ONE growing array per stroke, appended to, never re-mapped.
//
// WHAT THIS REPLACED. Each handler used to answer every pointer move with
// `snapshot.points.map(...)`: a fresh array of fresh tuples holding the
// WHOLE stroke. A stroke of S samples built S arrays and S²/2 points —
// 2 000 samples, 2 000 999 points — and did it again for a sample the
// machine had DROPPED (a jittered pen stream sends many closer than the
// decimation floor), publishing an unchanged polyline.
//
// WHAT IT DOES NOW. The kept samples are copied ONCE, as they arrive,
// into an array this module owns; a publish hands the overlay that same
// array in a fresh shape object. Nothing is published when the kept set
// did not change.
//
// WHAT IT CANNOT DO, and the perf budget pins this rather than hiding
// it: `host.overlay.setToolPreview(shape)` is a single slot holding ONE
// whole shape, last write wins. There is no "append these points to the
// preview you already hold", so every publish still names the entire
// polyline, and a host that renders it (the editor rebuilds an SVG
// `points` string) still walks all of it — S²/2 points CROSS the door
// for a stroke of S samples. Removing that needs a door: a retained
// preview a tool can EXTEND (`appendToolPreviewPoints(points)`, or a
// `from` index on the polyline saying "everything before this is what
// you already hold"). Until then the handler's share of the quadratic is
// gone and the overlay's is not.
//
// ALIASING, deliberately: the array handed over keeps growing while the
// stroke is in flight. The contract types `points` as a ReadonlyArray —
// the HOST may not write to it — and says nothing about the publisher.
// Every publish is a new shape object, so a host that compares by
// identity still sees a change, and a host that reads the array when it
// paints sees at least what the publish it is painting described. The
// array is let go of (never cleared, never reused) when the stroke ends,
// so a host still holding the last shape holds a stable one.

import type { BundleHost } from "@paged-media/plugin-api";

import type { Vec2 } from "@paged-media/draw-geometry";

export interface StrokePreview {
  /** The machine's kept samples after one event. Appends what is new and
   *  publishes; a no-op when the kept set is the one already shown. A
   *  stroke of fewer than two samples shows nothing. */
  show(pageId: string, kept: readonly Vec2[]): void;
  /** The stroke ended (committed, cancelled, tool switched): clear the
   *  overlay and let go of the array. */
  clear(): void;
}

export function createStrokePreview(host: BundleHost): StrokePreview {
  /** The polyline handed to the overlay; null between strokes. */
  let points: [number, number][] | null = null;

  return {
    show(pageId, kept) {
      if (points && kept.length === points.length) return;
      // A machine only ever APPENDS within a stroke. Should a caller hand
      // over a shorter run (a new stroke with no `clear` between), start
      // again rather than leave the old stroke's tail on screen.
      if (!points || kept.length < points.length) points = [];
      for (let i = points.length; i < kept.length; i++) {
        points.push([kept[i][0], kept[i][1]]);
      }
      host.overlay.setToolPreview(
        points.length >= 2 ? { pageId, points } : null,
      );
    },
    clear() {
      points = null;
      host.overlay.setToolPreview(null);
    },
  };
}
