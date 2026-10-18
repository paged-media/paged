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
//
// THE STOPS ARE ON THE LINE TOO. The overlay is a multi-shape channel
// now (`host.overlay.setToolPreviews`, K-9), so the axis is drawn WITH a
// diamond marker at every stop of the gradient, at its location along
// the line. A press on a marker grabs that stop (draw-tools
// `GradientStopMachine`): it slides along the axis between its two
// neighbours, and the release writes the one location change through
// `editGradient` — ONE mutation, one undo step per drag. A press anywhere
// else is the axis drag it always was.
//
// Three facts the markers carry, named rather than hidden:
//   · THE STOPS ARE READ THROUGH THE RAW HATCH. There is no
//     `document.gradientDetail` facade and `collection("gradients")`
//     answers id / name / kind only, so `requestGradientDetail` goes
//     through `raw-wire.ts` (the ONE guarded hatch seam). A host without
//     the hatch shows the bare axis, as before.
//   · A GRADIENT HERE IS A SWATCH. `frameFillColor` holds a reference to
//     a document gradient, and `editGradient` edits that gradient — so a
//     stop moved on one object moves on EVERY object filled with the same
//     swatch (Illustrator edits the object's own instance; this engine
//     has no per-object gradient to edit). The commit's log line says so.
//   · THE LINE STARTS AT THE FRAME'S CENTRE — the annotator's display
//     convention since it shipped (the wire carries the fill's angle and
//     length, not its start point), and the markers are placed along the
//     line as drawn.

import type {
  BundleHost,
  CanvasPointerEvent,
  Disposable,
  ElementId,
  GestureHandler,
  GradientSpec,
  Mutation,
  ToolPreviewPolyline,
  ToolPreviewShape,
} from "@paged-media/plugin-api";
import {
  GradientStopMachine,
  pointOnAxis,
  type GradientAxis,
} from "@paged-media/draw-tools";

import { rawGradientDetail, type GradientDetailWire } from "../raw-wire";

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

/** Screen px: a stop marker's half-size, and how near a press must be. */
const STOP_MARKER_PX = 4;
const STOP_HIT_PX = 7;

/** The `GradientSpec` an `editGradient` writes for `detail` with stop
 *  `index` moved to `locationPct` — every other field exactly as read.
 *  Null for a kind the engine reports as `"unknown"`: a write must not
 *  guess the ramp type. Pure; exported for the spec. */
export function gradientSpecWithStop(
  detail: GradientDetailWire,
  index: number,
  locationPct: number,
): GradientSpec | null {
  const kind =
    detail.kind.toLowerCase() === "linear"
      ? "Linear"
      : detail.kind.toLowerCase() === "radial"
        ? "Radial"
        : null;
  if (!kind || index < 0 || index >= detail.stops.length) return null;
  return {
    selfId: detail.selfId,
    name: detail.name,
    kind,
    stops: detail.stops.map((s, i) => ({
      stopColor: s.stopColorRef,
      locationPct: i === index ? locationPct : s.locationPct,
      ...(s.midpointPct !== null && s.midpointPct !== undefined
        ? { midpointPct: s.midpointPct }
        : {}),
    })),
  };
}

/** The ONE mutation a stop drag commits. Null = nothing writable. */
export function gradientStopMutationFor(
  detail: GradientDetailWire,
  index: number,
  locationPct: number,
): Mutation | null {
  const spec = gradientSpecWithStop(detail, index, locationPct);
  return spec ? { op: "editGradient", args: { gradientId: detail.selfId, spec } } : null;
}

/** A stop marker: a closed diamond `r` pt across its half-diagonal. */
export function stopMarker(
  pageId: string,
  point: readonly [number, number],
  r: number,
): ToolPreviewPolyline {
  const [x, y] = point;
  return {
    pageId,
    points: [
      [x, y - r],
      [x + r, y],
      [x, y + r],
      [x - r, y],
    ],
    close: true,
  };
}

/** What the annotator draws for one gradient-filled element. */
interface AxisState {
  pageId: string;
  center: [number, number];
  angleDeg: number;
  lengthPt: number;
  gradientId: string;
}

/** Read the first selected element's gradient-axis display state:
 *  null when it isn't gradient-filled. */
async function axisOf(
  host: BundleHost,
  id: ElementId,
): Promise<AxisState | null> {
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
  // C-23 — the annotator draws page-space chrome, so a pasteboard
  // frame gets none (the same rule the host overlays follow).
  if (!geom.pageId) return null;
  return {
    pageId: geom.pageId,
    center,
    angleDeg,
    lengthPt: lengthPt > 0 ? lengthPt : fallback,
    gradientId: fillRef,
  };
}

export interface GradientAnnotatorOptions {
  /** Called when a stop drag's write settles — the spec's hook. */
  onStopCommit?: (applied: boolean) => void;
}

export function createGradientAnnotatorHandler(
  host: BundleHost,
  options: GradientAnnotatorOptions = {},
): GestureHandler {
  let subs: Disposable[] = [];
  let drag: { pageId: string; start: [number, number] } | null = null;
  /** What was last drawn: the axis and, when readable, its stops. */
  type Shown = { axis: AxisState; detail: GradientDetailWire | null };
  let shown: Shown | null = null;
  /** A stop drag in flight. */
  let stopDrag: { machine: GradientStopMachine; shown: Shown } | null = null;

  const axisLine = (a: AxisState): ToolPreviewPolyline => {
    const end = pointOnAxis(lineOf(a), 100);
    return { pageId: a.pageId, points: [a.center, [end[0], end[1]]] };
  };
  const lineOf = (a: AxisState): GradientAxis => ({
    origin: a.center,
    angleDeg: a.angleDeg,
    lengthPt: a.lengthPt,
  });

  /** The axis, then one marker per stop at `points`. */
  const draw = (a: AxisState, points: readonly (readonly [number, number])[]) => {
    const r = host.viewport.pxToPt(STOP_MARKER_PX);
    const shapes: ToolPreviewShape[] = [
      axisLine(a),
      ...points.map((p) => stopMarker(a.pageId, p, r)),
    ];
    host.overlay.setToolPreviews(shapes);
  };

  /** Show the CURRENT axis (selection-derived) — the idle annotation. */
  const renderAxis = async (): Promise<void> => {
    if (drag || stopDrag) return; // the live drag owns the preview
    const selection = host.selection.get();
    const axis = selection.length > 0 ? await axisOf(host, selection[0]) : null;
    if (!axis) {
      shown = null;
      host.overlay.setToolPreview(null);
      return;
    }
    const detail = await rawGradientDetail(host, axis.gradientId);
    if (drag || stopDrag) return;
    shown = { axis, detail };
    draw(
      axis,
      (detail?.stops ?? []).map((s) => pointOnAxis(lineOf(axis), s.locationPct)),
    );
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
      stopDrag = null;
      shown = null;
      host.overlay.setToolPreview(null);
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (e.button !== 0 || !e.pageId || !e.pagePoint) return;
      if (host.selection.get().length === 0) return;
      // A press on a STOP marker grabs that stop.
      if (shown?.detail && shown.axis.pageId === e.pageId) {
        const machine = new GradientStopMachine({
          axis: lineOf(shown.axis),
          locations: shown.detail.stops.map((s) => s.locationPct),
          hitTolerance: host.viewport.pxToPt(STOP_HIT_PX),
        });
        if (machine.handle({ type: "down", point: e.pagePoint }).grabbed) {
          stopDrag = { machine, shown };
          return;
        }
      }
      drag = { pageId: e.pageId, start: e.pagePoint };
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (stopDrag) {
        if (!e.pagePoint || e.pageId !== stopDrag.shown.axis.pageId) return;
        const snap = stopDrag.machine.handle({ type: "move", point: e.pagePoint });
        draw(stopDrag.shown.axis, snap.points);
        return;
      }
      if (!drag || !e.pagePoint || e.pageId !== drag.pageId) return;
      host.overlay.setToolPreview({
        pageId: drag.pageId,
        points: [drag.start, e.pagePoint],
      });
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (stopDrag) {
        const { machine, shown: at } = stopDrag;
        stopDrag = null;
        const snap =
          e.pagePoint && e.pageId === at.axis.pageId
            ? machine.handle({ type: "up", point: e.pagePoint })
            : machine.handle({ type: "key", key: "Escape" });
        const mutation =
          snap.commit && at.detail
            ? gradientStopMutationFor(at.detail, snap.commit.index, snap.commit.locationPct)
            : null;
        if (!mutation) {
          void renderAxis();
          return;
        }
        void host.document
          .mutate(mutation)
          .then((outcome) => {
            if (!outcome.applied) {
              host.log.warn(`gradient stop rejected by engine: ${JSON.stringify(outcome.error)}`);
            } else {
              host.log.info(
                `gradient stop ${snap.commit!.index + 1} of ${at.axis.gradientId} moved to ` +
                  `${snap.commit!.locationPct}% — the gradient is a swatch, so every ` +
                  "object filled with it changes",
              );
            }
            options.onStopCommit?.(outcome.applied);
          })
          .catch((err) => host.log.warn(`gradient stop failed: ${err}`))
          .finally(() => void renderAxis());
        return;
      }
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
      if (e.key !== "Escape") return;
      if (stopDrag) {
        stopDrag.machine.handle({ type: "key", key: "Escape" });
        stopDrag = null;
        void renderAxis();
        return;
      }
      if (!drag) return;
      drag = null;
      void renderAxis();
    },
  };
}
