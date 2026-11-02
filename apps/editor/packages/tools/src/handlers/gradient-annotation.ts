/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// The Gradient tool's ANNOTATION (linear mode): while the tool is active it
// shows the gradient AXIS of a gradient-filled selection, with a diamond
// marker at every stop of the gradient on that line. A press on a marker
// grabs that stop; it slides along the axis between its neighbours and the
// release writes the one location change through `editGradient`: ONE
// mutation, one undo step per drag. A press anywhere else is the tool's axis
// drag, as before.
//
// paged.draw carried this as a tool of its own (the Gradient Annotator); it
// is the host's now (PM-0017). The stop machine (`GradientStopMachine`, in
// `@paged-media/draw/machines`) and the spec of a moved stop
// (`gradientSpecWithStop`, in `@paged-media/helpers`) are shared.
//
// Facts the markers carry, named rather than hidden:
//  · THE LINE STARTS AT THE FRAME'S CENTRE: the wire carries the fill's
//    angle and length, not its start point, so the axis is drawn from the
//    centre of the frame and the markers are placed along it as drawn. A
//    zero length shows as half the frame's smaller side (display only).
//  · A GRADIENT HERE IS A SWATCH: `frameFillColor` holds a reference to a
//    document gradient, and `editGradient` edits that gradient, so a stop
//    moved on one object moves on every object filled with the same swatch.
//  · A PASTEBOARD frame gets no chrome (the page-space overlay rule).

import {
  GradientStopMachine,
  pointOnAxis,
  type GradientAxis,
} from "@paged-media/draw/machines";
import { gradientSpecWithStop } from "@paged-media/helpers";
import type { ElementId } from "@paged-media/client";
import type {
  CanvasPointerEvent,
  PagedEditor,
  ToolPreviewShape,
} from "@paged-media/shell";

import { pxToPt } from "./shared";

/** Screen px: a stop marker's half-size, and how near a press must be. */
const STOP_MARKER_PX = 4;
const STOP_HIT_PX = 7;

const REFRESH_ON = new Set([
  "mutationApplied",
  "undoApplied",
  "redoApplied",
  "documentLoaded",
]);

interface AxisState {
  pageId: string;
  center: [number, number];
  angleDeg: number;
  lengthPt: number;
  gradientId: string;
}

type Detail = NonNullable<
  Awaited<ReturnType<PagedEditor["client"]["gradientDetail"]>>
>;
type Shown = { axis: AxisState; detail: Detail | null };

/** A closed diamond `r` pt across its half-diagonal. */
export function stopMarker(
  pageId: string,
  point: readonly [number, number],
  r: number,
) {
  const [x, y] = point;
  return {
    pageId,
    points: [
      [x, y - r],
      [x + r, y],
      [x, y + r],
      [x - r, y],
    ] as [number, number][],
    close: true,
  };
}

const lineOf = (a: AxisState): GradientAxis => ({
  origin: a.center,
  angleDeg: a.angleDeg,
  lengthPt: a.lengthPt,
});

/** A read that may be absent or fail: its answer, else null. */
async function attempt<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** The first selected element's gradient-axis display state, or null when
 *  it is not gradient-filled. */
async function axisOf(
  client: PagedEditor["client"],
  id: ElementId,
): Promise<AxisState | null> {
  const props = await attempt(() => client.elementProperties(id));
  if (!props) return null;
  let fillRef: string | null = null;
  let angleDeg = 0;
  let lengthPt = 0;
  for (const entry of props.entries) {
    const v = entry.value as { type?: string; value?: unknown } | null;
    if (!v) continue;
    if (entry.path === "frameFillColor" && v.type === "colorRef") {
      fillRef = v.value as string;
    } else if (
      entry.path === "frameGradientFillAngle" &&
      v.type === "length" &&
      typeof v.value === "number"
    ) {
      angleDeg = v.value;
    } else if (
      entry.path === "frameGradientFillLength" &&
      v.type === "length" &&
      typeof v.value === "number"
    ) {
      lengthPt = v.value;
    }
  }
  if (!fillRef || !fillRef.startsWith("Gradient/")) return null;
  const [geom] = (await attempt(() => client.elementGeometry([id]))) ?? [];
  if (!geom || !geom.pageId) return null;
  const [top, left, bottom, right] = geom.bounds;
  const m = geom.itemTransform ?? null;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const center: [number, number] = m
    ? [m[0] * cx + m[2] * cy + m[4], m[1] * cx + m[3] * cy + m[5]]
    : [cx, cy];
  const fallback = Math.min(Math.abs(right - left), Math.abs(bottom - top)) / 2;
  return {
    pageId: geom.pageId,
    center,
    angleDeg,
    lengthPt: lengthPt > 0 ? lengthPt : fallback,
    gradientId: fillRef,
  };
}

export interface GradientAnnotation {
  activate(paged: PagedEditor): void;
  deactivate(): void;
  /** Draw the annotation (`true`) or hand the overlay back (`false`). */
  show(on: boolean): void;
  /** A press: true when it grabbed a stop marker (the tool does nothing). */
  grab(e: CanvasPointerEvent): boolean;
  /** True while a stop drag is in flight (the tool does nothing). */
  dragging(): boolean;
  move(e: CanvasPointerEvent): void;
  up(e: CanvasPointerEvent): void;
  cancel(): void;
  /** Redraw after the tool's own axis drag settles. */
  refresh(): void;
}

export function createGradientAnnotation(): GradientAnnotation {
  let paged: PagedEditor | null = null;
  let on = false;
  let shown: Shown | null = null;
  let stopDrag: { machine: GradientStopMachine; shown: Shown } | null = null;
  let unsubscribe: (() => void) | null = null;
  let seq = 0;

  const draw = (
    a: AxisState,
    points: readonly (readonly [number, number])[],
  ) => {
    if (!paged) return;
    const r = pxToPt(paged, STOP_MARKER_PX);
    const end = pointOnAxis(lineOf(a), 100);
    const shapes: ToolPreviewShape[] = [
      { pageId: a.pageId, points: [a.center, [end[0], end[1]]] },
      ...points.map((p) => stopMarker(a.pageId, p, r)),
    ] as ToolPreviewShape[];
    paged.overlaySignals.setToolPreviews(shapes);
  };

  const render = async (): Promise<void> => {
    if (!paged || !on || stopDrag) return;
    const mine = ++seq;
    const client = paged.client;
    const selection = paged.selection.elementSelection;
    const axis =
      selection.length > 0 ? await axisOf(client, selection[0]!) : null;
    if (mine !== seq || !paged || !on || stopDrag) return;
    if (!axis) {
      shown = null;
      paged.overlaySignals.setToolPreview(null);
      return;
    }
    const detail = await client
      .gradientDetail(axis.gradientId)
      .catch(() => null);
    if (mine !== seq || !paged || !on || stopDrag) return;
    shown = { axis, detail };
    draw(
      axis,
      (detail?.stops ?? []).map((s: { locationPct: number }) =>
        pointOnAxis(lineOf(axis), s.locationPct),
      ),
    );
  };

  return {
    activate(p) {
      paged = p;
      unsubscribe?.();
      unsubscribe = p.client.subscribe((msg) => {
        if (!on) return;
        if (msg.kind === "elementSelectionApplied" || REFRESH_ON.has(msg.kind))
          void render();
      });
    },
    deactivate() {
      unsubscribe?.();
      unsubscribe = null;
      on = false;
      stopDrag = null;
      shown = null;
      seq++;
    },
    show(next) {
      on = next;
      if (on) void render();
      else {
        shown = null;
        stopDrag = null;
        seq++;
      }
    },
    grab(e) {
      if (!paged || !on || !e.pagePoint || !shown?.detail) return false;
      if (shown.axis.pageId !== e.pageId) return false;
      const machine = new GradientStopMachine({
        axis: lineOf(shown.axis),
        locations: shown.detail.stops.map(
          (s: { locationPct: number }) => s.locationPct,
        ),
        hitTolerance: pxToPt(paged, STOP_HIT_PX),
      });
      if (!machine.handle({ type: "down", point: e.pagePoint }).grabbed)
        return false;
      stopDrag = { machine, shown };
      return true;
    },
    dragging: () => stopDrag !== null,
    move(e) {
      if (!stopDrag || !e.pagePoint || e.pageId !== stopDrag.shown.axis.pageId)
        return;
      const snap = stopDrag.machine.handle({
        type: "move",
        point: e.pagePoint,
      });
      draw(stopDrag.shown.axis, snap.points);
    },
    up(e) {
      if (!stopDrag || !paged) return;
      const { machine, shown: at } = stopDrag;
      stopDrag = null;
      const snap =
        e.pagePoint && e.pageId === at.axis.pageId
          ? machine.handle({ type: "up", point: e.pagePoint })
          : machine.handle({ type: "key", key: "Escape" });
      const spec =
        snap.commit && at.detail
          ? gradientSpecWithStop(
              at.detail,
              snap.commit.index,
              snap.commit.locationPct,
            )
          : null;
      if (!spec) {
        void render();
        return;
      }
      void paged.client
        .mutate({
          op: "editGradient",
          args: { gradientId: at.detail!.selfId, spec },
        } as never)
        .catch(() => undefined)
        .finally(() => void render());
    },
    cancel() {
      if (!stopDrag) return;
      stopDrag.machine.handle({ type: "key", key: "Escape" });
      stopDrag = null;
      void render();
    },
    refresh() {
      void render();
    },
  };
}
