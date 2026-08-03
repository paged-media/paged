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

// Width tool v0 (wave 2) — drag near an anchor of the SELECTED open
// path to give the stroke a per-anchor width profile peaked there
// (draw-tools' WidthMachine: falloff over the neighbors, magnitude
// from the drag distance), then bake it through the engine's
// `outlineStrokeVariable` op.
//
// HONEST SCOPE (v0, kept deliberately simple):
//   · The bake is DESTRUCTIVE — `outlineStrokeVariable` replaces the
//     centerline with its swept OUTLINE (a closed filled contour).
//     There is no live width-profile model on the wire (Illustrator
//     keeps widths editable; the engine's v1 kernel does not), so the
//     honest v0 is bake-on-release, one mutation = one undo step.
//   · Targets the FIRST selected path-bearing element only, and only
//     a SINGLE-CONTOUR OPEN path (the v1 kernel outlines one open
//     contour — see the ENGINE NOTE in handlers/brush.ts).
//   · The live preview is a perpendicular width TICK at the peaked
//     anchor (real profile data), not a full swept-outline preview.
//
// The pointer-down resolve (selection → pathAnchors → local space) is
// async; events are SERIALIZED through a promise chain so the machine
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
  type AnchorTriple,
  type Affine,
  type Vec2,
} from "@paged-media/draw-geometry";
import { WidthMachine, type WidthSnapshot } from "@paged-media/draw-tools";

import { outlineStrokeVariableMutationFor } from "./brush";
import { outlineParamsOf, supportsPathOps } from "../commands/path-ops";

/** Screen-space pick radius around anchors (the anchors.ts constant
 *  family). */
const PICK_TOLERANCE_PX = 8;

/** v0 fixed profile parameters (no options UI yet): the peak decays
 *  over 2 neighbors, 1 pt of width per pt of drag, peak capped at
 *  72 pt. */
export const WIDTH_FALLOFF_ANCHORS = 2;
export const WIDTH_GAIN = 1;
export const WIDTH_MAX_PT = 72;

interface WidthGesture {
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
  let gesture: Promise<WidthGesture | null> | null = null;

  const clearPreview = () => host.overlay.setToolPreview(null);

  const beginGesture = async (
    e: CanvasPointerEvent,
  ): Promise<WidthGesture | null> => {
    if (!e.pageId || !e.pagePoint) return null;
    const target = host.selection.get().find(supportsPathOps) ?? null;
    if (!target) {
      host.log.debug("width: no path-bearing selection — select an open path first");
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
      falloff: WIDTH_FALLOFF_ANCHORS,
      gain: WIDTH_GAIN,
      maxWidth: WIDTH_MAX_PT,
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
      const onPage = "pageId" in event ? event.pageId === g.pageId : true;
      const local =
        "point" in event && onPage ? g.toLocal(event.point) : null;
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
    onActivate() {
      /* per-drag state allocates on pointer-down */
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
