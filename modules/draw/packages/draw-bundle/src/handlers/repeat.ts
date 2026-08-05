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

// The REPEAT gesture tool — §12.4's "live on-canvas controls", built to
// the ceiling the overlay door actually has and no further.
//
// WHAT IT DOES. Select a repeat (its source, an instance or its clip
// frame), press anywhere on the page and drag: the drag steers ONE
// parameter of that repeat's kind —
//   · RADIAL — the pointer places the ring CENTRE, so the drag sets the
//     radius AND the start angle at once. The source never moves.
//   · GRID   — the pointer places the NEXT cell, so the drag sets the
//     spacing on both axes; dragging inside the source's own footprint
//     gives a NEGATIVE spacing, which is a real overlap.
//   · MIRROR — the pointer places a point ON the axis and the axis runs
//     perpendicular to the drag, which is the handle Illustrator shows.
// Shift snaps the two ANGULAR parameters to 45°. Escape cancels.
//
// WHAT IT IS NOT, and the code is the only place these are true:
//   · THE INSTANCES DO NOT MOVE DURING THE DRAG. `overlay.setToolPreview`
//     takes ONE polyline, so what the drag draws is a GUIDE — the ring
//     and its spoke, the lattice extent, the mirror axis. Drawing every
//     instance outline would need N polylines the door does not offer.
//   · THE COMMIT IS ON RELEASE, once. A re-plan per pointer-move would
//     be one document mutation — and one undo step — per sample, which
//     is worse than not being live at all.
// `commands/repeat.ts`'s `REPEAT_LIVE_NOTE` says both sentences to the
// user; this file is where they hold.
//
// NO SELECTED REPEAT = a debug log and a no-op. The tool deliberately
// does NOT make one: "drag on empty canvas and get a radial repeat of
// nothing" is the dead-affordance bug the editor's own tool catalog
// records, one level up.

import type {
  BundleHost,
  CanvasPointerEvent,
  GestureHandler,
} from "@paged-media/plugin-api";
import { boundsCenter, type Vec2 } from "@paged-media/draw-geometry";
import {
  repeatGuide,
  repeatSteer,
  type RepeatGuideSpec,
  type RepeatSteer,
} from "@paged-media/draw-tools";

import {
  applyUpdateRepeat,
  findRepeatRecord,
  mirrorDefaultOffset,
  radialCenterOfDraft,
  readRepeatLibrary,
  repeatBoundsOf,
  repeatLinks,
  resolveRepeat,
  type RepeatParams,
} from "../commands/repeat";

/** The drag state one gesture allocates. */
interface Drag {
  repeat: string;
  params: RepeatParams;
  /** The sources' page-space bounds `[top, left, bottom, right]`. */
  bounds: readonly [number, number, number, number];
  center: Vec2;
  size: Vec2;
  pageId: string;
  steer: RepeatSteer;
}

export function createRepeatHandler(host: BundleHost): GestureHandler {
  let drag: Drag | null = null;

  const reset = () => {
    drag = null;
    host.overlay.setToolPreview(null);
  };

  /** The guide for the CURRENT steer — one polyline, the door's shape. */
  const guideFor = (d: Drag): Vec2[] => {
    const params = { ...d.params, ...d.steer } as RepeatParams;
    let spec: RepeatGuideSpec;
    if (params.kind === "radial") {
      spec = {
        kind: "radial",
        center: radialCenterOfDraft(params, d.center),
        source: d.center,
      };
    } else if (params.kind === "grid") {
      spec = {
        kind: "grid",
        bounds: d.bounds,
        stepX: d.size[0] + params.spacing[0],
        stepY: d.size[1] + params.spacing[1],
        columns: params.columns,
        rows: params.rows,
      };
    } else {
      const offset =
        params.offsetPt ?? mirrorDefaultOffset(params.angleDeg, d.size);
      const n = [
        Math.sin((params.angleDeg * Math.PI) / 180),
        -Math.cos((params.angleDeg * Math.PI) / 180),
      ];
      spec = {
        kind: "mirror",
        origin: [d.center[0] + n[0] * offset, d.center[1] + n[1] * offset],
        angleDeg: params.angleDeg,
        span: Math.max(d.size[0], d.size[1]) * 3,
      };
    }
    return repeatGuide(spec);
  };

  const draw = (d: Drag) => {
    const points = guideFor(d);
    host.overlay.setToolPreview(
      points.length > 1
        ? { pageId: d.pageId, points: points as [number, number][] }
        : null,
    );
  };

  return {
    onActivate() {
      /* per-drag state allocates on pointer-down */
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      reset();
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (e.button !== 0 || !e.pageId || !e.pagePoint) return;
      const pageId = e.pageId;
      const point = e.pagePoint as [number, number];
      void (async () => {
        const repeat = await resolveRepeat(host, undefined);
        if (repeat === null) {
          host.log.debug(
            "repeat tool: no repeat resolved from the selection — select a " +
              "repeat's source, an instance or its clip frame first (this tool " +
              "steers an EXISTING repeat; the three make commands build one)",
          );
          return;
        }
        const library = await readRepeatLibrary(host);
        const record = findRepeatRecord(library, repeat);
        const links = await repeatLinks(host, repeat);
        const sourceIds = links.sources.map((s) => s.id);
        if (!record || sourceIds.length === 0) {
          host.log.debug(
            `repeat tool: "${repeat}" has no saved parameters or no source ` +
              "artwork — nothing to steer",
          );
          return;
        }
        const bounds = await repeatBoundsOf(host, sourceIds);
        if (!bounds) {
          host.log.debug(
            `repeat tool: "${repeat}"'s sources have no measurable bounds ` +
              "(off-page reads answer nothing — RFI C-23)",
          );
          return;
        }
        const center = boundsCenter(bounds);
        drag = {
          repeat,
          params: record.params,
          bounds,
          center,
          size: [bounds[3] - bounds[1], bounds[2] - bounds[0]],
          pageId,
          steer: repeatSteer(record.params.kind, center, point, [
            bounds[3] - bounds[1],
            bounds[2] - bounds[0],
          ]),
        };
        draw(drag);
      })();
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!drag || !e.pagePoint) return;
      drag.steer = repeatSteer(
        drag.params.kind,
        drag.center,
        e.pagePoint as [number, number],
        drag.size,
        { constrain: e.modifiers?.shift === true },
      );
      draw(drag);
    },
    onPointerUp() {
      if (!drag) {
        reset();
        return;
      }
      const { repeat, steer } = drag;
      reset();
      void applyUpdateRepeat(host, { repeatId: repeat, ...steer }).catch((err) =>
        host.log.warn(`repeat tool: update failed: ${String(err)}`),
      );
    },
    onKey(e: KeyboardEvent) {
      if (e.key === "Escape") reset();
    },
  };
}
