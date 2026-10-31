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

// The Gradient tool's FREEFORM modes (engine ADR 1048): colour points
// placed anywhere on a frame, and lines through them, written to the
// frame's `frameFillMesh` as a freeform gradient.
//
//   - Click inside a shape: a point there. The shape becomes a freeform
//     gradient if it is not one (a gradient mesh on it is replaced). The
//     first point takes the shape's fill colour (mid grey when the fill is
//     none or not a plain colour), each later one the next colour of a
//     small distinct palette (`FREEFORM_PALETTE`), so a new point shows at
//     once; the Color panel recolours it. Its spread is the tool's
//     "Spread" option.
//   - Press a point: it is selected (the Color panel's Apply colours it);
//     drag it and it moves. Backspace / Delete removes it.
//   - "Freeform lines": every click — a new point or an existing one —
//     joins the line being drawn; Escape ends the line.
//
// Every gesture is ONE whole-value `frameFillMesh` write (one undo step).

import type { ElementId } from "@paged-media/client";
import type {
  CanvasPointerEvent,
  PagedEditor,
  ToolPreviewShape,
} from "@paged-media/shell";
import { t } from "@paged-media/strings";

import {
  addFreeformPoint,
  catmullRom,
  emptyFreeform,
  extendLine,
  freeformColorFor,
  moveFreeformPoint,
  recolorFreeformPoints,
  removeFreeformPoint,
  type FreeformSpec,
} from "../mesh/freeform";
import { MID_GREY, type MeshColorSpec, type Vec2 } from "../mesh/types";
import { GRADIENT_TOOL } from "../messages";
import {
  commitFillMesh,
  diamondMarker,
  elementUnder,
  fillColorOf,
  inBox,
  MESH_FILLABLE,
  paintToMeshColor,
  readMeshTarget,
  sameElement,
  selectOnly,
  setPaintTarget,
  toInner,
  toPage,
  type MeshTarget,
} from "./mesh-target";
import { CLICK_DRAG_THRESHOLD_PX, pxToPt } from "./shared";

export type FreeformMode = "freeformPoints" | "freeformLines";

/** Screen px: a point marker's half-diagonal and the pick radius. */
const POINT_MARKER_PX = 5;
const PICK_PX = 7;

const REFRESH_ON = new Set([
  "mutationApplied",
  "undoApplied",
  "redoApplied",
  "documentLoaded",
]);

function freeformOf(target: MeshTarget | null): FreeformSpec | null {
  return target?.fill?.kind === "freeform" ? target.fill : null;
}

/** What the gesture handler hands over while a freeform mode is on. */
export interface FreeformGradientEditor {
  activate(paged: PagedEditor): void;
  deactivate(): void;
  /** Redraw (or, `false`, take the overlay and the paint target back). */
  show(on: boolean): void;
  pointerDown(e: CanvasPointerEvent, mode: FreeformMode): void;
  pointerMove(e: CanvasPointerEvent): void;
  pointerUp(e: CanvasPointerEvent, mode: FreeformMode, spreadPct: number): void;
  key(e: KeyboardEvent): void;
}

type Drag =
  | { kind: "click"; pageId: string; start: Vec2 }
  | { kind: "point"; index: number; start: Vec2 };

export function createFreeformGradientEditor(
  owner: string,
): FreeformGradientEditor {
  let paged: PagedEditor | null = null;
  let shown = false;
  let target: MeshTarget | null = null;
  let selected: number | null = null;
  /** The line being drawn (its index in `lines`), or the first point of
   *  one not yet opened. */
  let line: number | null = null;
  let pending: number | null = null;
  let drag: Drag | null = null;
  let preview: FreeformSpec | null = null;
  let unsubscribe: (() => void) | null = null;
  let readSeq = 0;

  const draw = () => {
    if (!paged || !shown) return;
    const spec = preview ?? freeformOf(target);
    if (!target || !spec) {
      paged.overlaySignals.setToolPreview(null);
      return;
    }
    const at = target;
    const pageId = at.pageId;
    const r = pxToPt(paged, POINT_MARKER_PX);
    const shapes: ToolPreviewShape[] = [];
    for (const l of spec.lines) {
      const pts = l
        .map((i) => spec.points[i]?.point)
        .filter((p): p is Vec2 => !!p);
      shapes.push({
        pageId,
        points: catmullRom(pts).map((p) => toPage(at, p)),
      });
    }
    spec.points.forEach((p, i) => {
      const q = toPage(at, p.point);
      shapes.push(diamondMarker(pageId, q, r));
      if (i === selected) shapes.push(diamondMarker(pageId, q, r / 2));
    });
    paged.overlaySignals.setToolPreviews(shapes);
  };

  const offerPaintTarget = () => {
    if (!paged) return;
    const spec = freeformOf(target);
    const index = selected;
    if (!shown || !target || !spec || index === null) {
      setPaintTarget(paged, owner, null);
      return;
    }
    const id = target.id;
    setPaintTarget(paged, owner, {
      label: t(GRADIENT_TOOL.points, { count: 1 }),
      apply: async (color) => {
        const now = freeformOf(target);
        if (!now || !target || !sameElement(target.id, id)) return false;
        return commit(
          recolorFreeformPoints(now, [index], paintToMeshColor(color)),
          "gradient point colour",
          index,
        );
      },
    });
  };

  const select = (index: number | null) => {
    selected = index;
    offerPaintTarget();
  };

  const endLine = () => {
    line = null;
    pending = null;
  };

  const refresh = async (ids?: readonly ElementId[]) => {
    if (!paged) return;
    const seq = ++readSeq;
    let id = target?.id ?? null;
    const selection = ids ?? (target ? null : paged.selection.elementSelection);
    if (selection && !selection.some((s) => sameElement(s, id))) {
      id = selection.find((s) => MESH_FILLABLE.has(s.kind)) ?? null;
    }
    if (!id) {
      target = null;
      endLine();
      select(null);
      draw();
      return;
    }
    const read = await readMeshTarget(paged.client, id).catch(() => null);
    if (seq !== readSeq || !paged) return;
    if (!read || !target || !sameElement(read.id, target.id)) {
      endLine();
      selected = null;
    }
    target = read;
    const spec = freeformOf(target);
    if (selected !== null && (!spec || selected >= spec.points.length))
      selected = null;
    if (line !== null && (!spec || !spec.lines[line])) endLine();
    offerPaintTarget();
    if (!drag || drag.kind === "click") draw();
  };

  const commit = async (
    spec: FreeformSpec,
    label: string,
    next: number | null,
  ): Promise<boolean> => {
    if (!paged || !target) return false;
    const at = target;
    target = { ...at, fill: spec };
    selected = next;
    preview = null;
    draw();
    // The last point removed clears the gradient back to the swatch fill.
    const ok = await commitFillMesh(
      paged,
      at.id,
      spec.points.length > 0 ? spec : null,
      label,
    );
    await refresh();
    select(selected);
    return ok;
  };

  const pick = (p: Vec2): number | null => {
    const spec = freeformOf(target);
    if (!paged || !target || !spec) return null;
    const at = target;
    const tol = pxToPt(paged, PICK_PX);
    let best: number | null = null;
    let bestD = tol;
    spec.points.forEach((pt, i) => {
      const q = toPage(at, pt.point);
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  const clickAt = async (
    pageId: string,
    p: Vec2,
    mode: FreeformMode,
    spreadPct: number,
  ) => {
    if (!paged) return;
    const hit = await elementUnder(paged, pageId, p);
    if (!hit || !MESH_FILLABLE.has(hit.kind)) {
      endLine();
      select(null);
      draw();
      return;
    }
    let at =
      target && sameElement(target.id, hit)
        ? target
        : await readMeshTarget(paged.client, hit).catch(() => null);
    if (!at || !paged) return;
    if (at !== target) {
      readSeq++;
      target = at;
      endLine();
      select(null);
    }
    void selectOnly(paged, hit);
    const inner = toInner(at, p);
    if (!inBox(at, inner)) return;
    const base = freeformOf(at) ?? emptyFreeform();
    const fill: MeshColorSpec =
      base.points.length === 0 ? await fillColorOf(paged.client, at) : MID_GREY;
    at = target ?? at;
    const added = addFreeformPoint(
      base,
      inner,
      freeformColorFor(base.points.length, fill),
      spreadPct,
    );
    let spec = added.spec;
    if (mode === "freeformLines") {
      const step = extendLine(spec, line, pending, added.index);
      spec = step.spec;
      line = step.line;
      pending = step.pending;
    }
    await commit(spec, "gradient point", added.index);
  };

  const dragged = (d: Drag, p: Vec2): FreeformSpec | null => {
    const spec = freeformOf(target);
    if (!target || !spec || d.kind !== "point") return null;
    return moveFreeformPoint(spec, d.index, toInner(target, p));
  };

  return {
    activate(p) {
      paged = p;
      unsubscribe?.();
      unsubscribe = p.client.subscribe((msg) => {
        if (!shown) return;
        if (msg.kind === "elementSelectionApplied")
          void refresh(msg.payload.ids);
        else if (REFRESH_ON.has(msg.kind)) void refresh();
      });
    },
    deactivate() {
      unsubscribe?.();
      unsubscribe = null;
      if (paged) setPaintTarget(paged, owner, null);
      shown = false;
      target = null;
      selected = null;
      drag = null;
      preview = null;
      endLine();
      readSeq++;
    },
    show(on) {
      if (!paged) return;
      if (on === shown) return;
      shown = on;
      if (on) {
        void refresh(paged.selection.elementSelection);
        return;
      }
      readSeq++;
      target = null;
      selected = null;
      endLine();
      setPaintTarget(paged, owner, null);
      paged.overlaySignals.setToolPreview(null);
    },
    pointerDown(e) {
      if (!paged || e.button !== 0 || !e.pageId || !e.pagePoint) return;
      const index = target?.pageId === e.pageId ? pick(e.pagePoint) : null;
      if (index !== null) {
        select(index);
        draw();
        drag = { kind: "point", index, start: e.pagePoint };
        return;
      }
      drag = { kind: "click", pageId: e.pageId, start: e.pagePoint };
    },
    pointerMove(e) {
      if (!drag || drag.kind !== "point" || !target) return;
      if (e.maxDelta <= CLICK_DRAG_THRESHOLD_PX) return;
      if (!e.pagePoint || e.pageId !== target.pageId) return;
      preview = dragged(drag, e.pagePoint);
      draw();
    },
    pointerUp(e, mode, spreadPct) {
      const d = drag;
      drag = null;
      if (!paged || !d) return;
      const isDrag = e.maxDelta > CLICK_DRAG_THRESHOLD_PX;
      if (d.kind === "click") {
        if (!isDrag) void clickAt(d.pageId, d.start, mode, spreadPct);
        return;
      }
      const moved =
        isDrag && e.pagePoint && e.pageId === target?.pageId
          ? dragged(d, e.pagePoint)
          : null;
      preview = null;
      if (moved) {
        void commit(moved, "gradient point move", d.index);
        return;
      }
      // A click on a point: in the lines mode it joins the line.
      const spec = freeformOf(target);
      if (!isDrag && mode === "freeformLines" && spec) {
        const step = extendLine(spec, line, pending, d.index);
        line = step.line;
        pending = step.pending;
        if (step.spec !== spec) {
          void commit(step.spec, "gradient line", d.index);
          return;
        }
      }
      draw();
    },
    key(e) {
      if (e.key === "Escape") {
        if (drag) {
          drag = null;
          preview = null;
        } else {
          endLine();
          select(null);
        }
        draw();
        return;
      }
      if (e.key !== "Backspace" && e.key !== "Delete") return;
      const spec = freeformOf(target);
      if (!spec || selected === null || drag) return;
      endLine();
      void commit(
        removeFreeformPoint(spec, selected),
        "gradient point removal",
        null,
      );
    },
  };
}
