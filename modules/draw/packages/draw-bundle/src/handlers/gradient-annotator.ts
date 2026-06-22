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

// The Gradient Annotator tool (B-03 lane, on-canvas) — while ACTIVE it
// displays the gradient AXIS of a gradient-filled selection through the
// shared tool-preview channel, and a drag on the canvas re-aims the
// axis: pointer-up commits `frameGradientFillAngle` +
// `frameGradientFillLength` (one batch = one undo step) to every
// selected element — the same two scalar properties the fill panel's
// scrubs steer.
//
// Why a TOOL and not a passive overlay: the tool-preview channel is the
// ONE shared overlay signal (no retained per-plugin overlay layer
// exists in the facade), so a passive always-on annotator would fight
// whichever tool is active for the same channel. Scoping the annotator
// to its own tool activation keeps the channel honest — exactly one
// owner at a time. (A retained overlay contribution is React-typed —
// `OverlayContribution.render` — which this bundle keeps out of its
// module graph; a declarative overlay layer is an RFI candidate.)
//
// Drag-on-canvas IS supported here — the gesture spine delivers pointer
// input to the active tool, so no honesty caveat applies; the fill
// panel's Angle/Length scrubs remain the precise-entry lane.

import type {
  BundleHost,
  CanvasPointerEvent,
  Disposable,
  ElementId,
  GestureHandler,
  Mutation,
} from "@paged-media/plugin-api";

/** Minimum drag length (pt) below which the commit is dropped — a
 *  click must not zero the gradient length. */
const MIN_DRAG_LENGTH_PT = 2;

/** The `setElementProperty` BATCH one annotator drag commits: angle
 *  (degrees from +x, y down) + length (pt) per selected element — one
 *  undo step. Exported so the conformance spec asserts the EXACT wire
 *  sequence the live drag emits (no second copy to drift from). The
 *  same `{ type: "length" }` scalar Value the editor's gradient tool
 *  proved engine-side. */
export function gradientAxisMutationFor(
  elementIds: ElementId[],
  angleDeg: number,
  lengthPt: number,
): Mutation {
  const ops: Mutation[] = elementIds.flatMap((elementId): Mutation[] => [
    {
      op: "setElementProperty",
      args: {
        elementId,
        path: "frameGradientFillAngle",
        value: { type: "length", value: angleDeg },
      },
    },
    {
      op: "setElementProperty",
      args: {
        elementId,
        path: "frameGradientFillLength",
        value: { type: "length", value: lengthPt },
      },
    },
  ]);
  return { op: "batch", args: { ops } };
}

/** Read the first selected element's gradient-axis display state:
 *  null when it isn't gradient-filled. */
async function axisOf(
  host: BundleHost,
  id: ElementId,
): Promise<{
  pageId: string;
  center: [number, number];
  angleDeg: number;
  lengthPt: number;
} | null> {
  const props = await host.document.elementProperties(id);
  if (!props) return null;
  let fillRef: string | null = null;
  let angleDeg = 0;
  let lengthPt = 0;
  for (const entry of props.entries) {
    const v = entry.value;
    if (!v) continue;
    if (entry.path === "frameFillColor" && v.type === "colorRef") {
      fillRef = v.value;
    } else if (
      entry.path === "frameGradientFillAngle" &&
      v.type === "length" &&
      v.value !== null
    ) {
      angleDeg = v.value;
    } else if (
      entry.path === "frameGradientFillLength" &&
      v.type === "length" &&
      v.value !== null
    ) {
      lengthPt = v.value;
    }
  }
  if (!fillRef || !fillRef.startsWith("Gradient/")) return null;
  const [geom] = await host.document.elementGeometry([id]);
  if (!geom) return null;
  const [top, left, bottom, right] = geom.bounds;
  const m = geom.itemTransform ?? null;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const center: [number, number] = m
    ? [m[0] * cx + m[2] * cy + m[4], m[1] * cx + m[3] * cy + m[5]]
    : [cx, cy];
  // A zero/unset length displays as half the frame's smaller side so
  // the axis is visible at all (display fallback only — never written).
  const fallback = Math.min(Math.abs(right - left), Math.abs(bottom - top)) / 2;
  return {
    pageId: geom.pageId,
    center,
    angleDeg,
    lengthPt: lengthPt > 0 ? lengthPt : fallback,
  };
}

export function createGradientAnnotatorHandler(
  host: BundleHost,
): GestureHandler {
  let subs: Disposable[] = [];
  let drag: { pageId: string; start: [number, number] } | null = null;

  /** Show the CURRENT axis (selection-derived) — the idle annotation. */
  const renderAxis = async (): Promise<void> => {
    if (drag) return; // the live drag owns the preview
    const selection = host.selection.get();
    const axis = selection.length > 0 ? await axisOf(host, selection[0]) : null;
    if (!axis) {
      host.overlay.setToolPreview(null);
      return;
    }
    const rad = (axis.angleDeg * Math.PI) / 180;
    host.overlay.setToolPreview({
      pageId: axis.pageId,
      points: [
        axis.center,
        [
          axis.center[0] + axis.lengthPt * Math.cos(rad),
          axis.center[1] + axis.lengthPt * Math.sin(rad),
        ],
      ],
    });
  };

  return {
    onActivate() {
      subs = [
        host.selection.onDidChange(() => void renderAxis()),
        host.document.onDidChange(() => void renderAxis()),
      ];
      void renderAxis();
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      for (const s of subs) s.dispose();
      subs = [];
      drag = null;
      host.overlay.setToolPreview(null);
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (e.button !== 0 || !e.pageId || !e.pagePoint) return;
      if (host.selection.get().length === 0) return;
      drag = { pageId: e.pageId, start: e.pagePoint };
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!drag || !e.pagePoint || e.pageId !== drag.pageId) return;
      host.overlay.setToolPreview({
        pageId: drag.pageId,
        points: [drag.start, e.pagePoint],
      });
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!drag) return;
      const start = drag.start;
      const samePage = e.pageId === drag.pageId;
      drag = null;
      if (!samePage || !e.pagePoint) {
        void renderAxis();
        return;
      }
      const dx = e.pagePoint[0] - start[0];
      const dy = e.pagePoint[1] - start[1];
      const lengthPt = Math.hypot(dx, dy);
      const targets = host.selection.get();
      if (lengthPt < MIN_DRAG_LENGTH_PT || targets.length === 0) {
        void renderAxis();
        return;
      }
      const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
      void host.document
        .mutate(gradientAxisMutationFor(targets, angleDeg, lengthPt))
        .then((outcome) => {
          if (!outcome.applied) {
            host.log.warn(
              `gradient axis rejected by engine: ${JSON.stringify(outcome.error)}`,
            );
          }
        })
        .catch((err) => host.log.warn(`gradient axis failed: ${err}`))
        .finally(() => void renderAxis());
    },
    onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || !drag) return;
      drag = null;
      void renderAxis();
    },
  };
}
