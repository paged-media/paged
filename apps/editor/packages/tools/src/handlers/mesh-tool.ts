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

// The Mesh tool (`paged.tool.mesh`, engine ADR 1040) — Illustrator's
// gradient-mesh tool over the frame's `frameFillMesh`.
//
//   - Click inside a filled shape without a mesh: the shape gets a 1×1
//     grid over its inner box, every node its fill colour (mid grey when
//     the fill is none or not a plain colour), and a mesh point at the
//     click — one row line and one column line through it, a 2×2 grid.
//     A freeform gradient on the shape is replaced the same way.
//   - Click inside a mesh, not on a point: a mesh point there (a column
//     through every patch row and a row through every patch column; the
//     surface stays where it was — `mesh/grid.ts`).
//   - Press a point: it is selected (Shift adds or removes it); drag it
//     and it moves with its handles. Press a handle of a selected point
//     and drag: the handle moves.
//   - Escape clears the point selection; Backspace / Delete removes the
//     first selected point's row and column lines where the grid keeps a
//     patch (the Object ▸ Delete keys yield to the tool while it is in
//     hand, `deleteKeyApplies`).
//   - While points are selected the Color panel's Apply colours them
//     (`PAINT_TARGET`).
//
// Every gesture is ONE whole-value `frameFillMesh` write, so ONE undo
// step; its inverse is the mesh as it was. The overlay (mesh lines,
// a square per point, the selected points' handles) is drawn through
// the tool-preview slot and redrawn after every edit, undo, redo and
// selection change.

import type { ElementId } from "@paged-media/client";
import type {
  CanvasPointerEvent,
  GestureHandler,
  PagedEditor,
  ToolPreviewShape,
} from "@paged-media/shell";
import { t } from "@paged-media/strings";

import {
  boxGrid,
  gridEdges,
  handleIsLive,
  insertMeshPoint,
  locate,
  moveNode,
  recolorNodes,
  removeNodeLines,
  sampleCubic,
  setHandle,
} from "../mesh/grid";
import type {
  HandleSlot,
  MeshFillSpec,
  MeshGridSpec,
  Vec2,
} from "../mesh/types";
import { MESH_TOOL } from "../messages";
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
  squareMarker,
  toInner,
  toPage,
  type MeshTarget,
} from "./mesh-target";
import { CLICK_DRAG_THRESHOLD_PX, pxToPt } from "./shared";

export const MESH_TOOL_ID = "paged.tool.mesh";

/** Screen px: a point marker's half-size, a handle's, the pick radius. */
const NODE_MARKER_PX = 3.5;
const HANDLE_MARKER_PX = 3;
const PICK_PX = 6;

type Mesh = Extract<MeshFillSpec, { kind: "mesh" }>;

/** The selected points: one grid's node indices. */
interface PointSelection {
  grid: number;
  nodes: number[];
}

type Drag =
  | { kind: "click"; pageId: string; start: Vec2 }
  | { kind: "node"; grid: number; node: number; start: Vec2 }
  | {
      kind: "handle";
      grid: number;
      node: number;
      slot: HandleSlot;
      start: Vec2;
    };

const REFRESH_ON = new Set([
  "mutationApplied",
  "undoApplied",
  "redoApplied",
  "documentLoaded",
]);

function meshOf(target: MeshTarget | null): Mesh | null {
  return target?.fill?.kind === "mesh" ? target.fill : null;
}

function withGrid(mesh: Mesh, index: number, grid: MeshGridSpec): Mesh {
  return {
    kind: "mesh",
    grids: mesh.grids.map((g, i) => (i === index ? grid : g)),
  };
}

export function createMeshHandler(): GestureHandler {
  let paged: PagedEditor | null = null;
  let target: MeshTarget | null = null;
  let selected: PointSelection | null = null;
  let drag: Drag | null = null;
  /** The mesh a node or handle drag shows before it commits. */
  let preview: Mesh | null = null;
  let unsubscribe: (() => void) | null = null;
  /** Counts target reads, so only the newest answer lands. */
  let readSeq = 0;

  const draw = () => {
    if (!paged) return;
    const mesh = preview ?? meshOf(target);
    if (!target || !mesh) {
      paged.overlaySignals.setToolPreview(null);
      return;
    }
    const at = target;
    const pageId = at.pageId;
    const shapes: ToolPreviewShape[] = [];
    const node = pxToPt(paged, NODE_MARKER_PX);
    const handle = pxToPt(paged, HANDLE_MARKER_PX);
    mesh.grids.forEach((grid, gi) => {
      for (const edge of gridEdges(grid)) {
        shapes.push({
          pageId,
          points: sampleCubic(edge).map((p) => toPage(at, p)),
        });
      }
      grid.nodes.forEach((n, ni) => {
        const p = toPage(at, n.point);
        shapes.push(squareMarker(pageId, p, node));
        if (selected?.grid !== gi || !selected.nodes.includes(ni)) return;
        // A selected point: a second, inner square, and its live handles.
        shapes.push(squareMarker(pageId, p, node / 2));
        for (const slot of [0, 1, 2, 3] as const) {
          if (!handleIsLive(grid, ni, slot)) continue;
          const h = toPage(at, n.handles[slot]);
          shapes.push({ pageId, points: [p, h] });
          shapes.push(diamondMarker(pageId, h, handle));
        }
      });
    });
    paged.overlaySignals.setToolPreviews(shapes);
  };

  /** Offer the Color panel the selected points, or take the offer back. */
  const offerPaintTarget = () => {
    if (!paged) return;
    const mesh = meshOf(target);
    const sel = selected;
    if (!target || !mesh || !sel || sel.nodes.length === 0) {
      setPaintTarget(paged, MESH_TOOL_ID, null);
      return;
    }
    const id = target.id;
    setPaintTarget(paged, MESH_TOOL_ID, {
      label: t(MESH_TOOL.points, { count: sel.nodes.length }),
      apply: async (color) => {
        const now = meshOf(target);
        if (!now || !target || !sameElement(target.id, id)) return false;
        const grid = now.grids[sel.grid];
        if (!grid) return false;
        return commit(
          withGrid(
            now,
            sel.grid,
            recolorNodes(grid, sel.nodes, paintToMeshColor(color)),
          ),
          "mesh point colour",
          sel,
        );
      },
    });
  };

  const setSelected = (next: PointSelection | null) => {
    selected = next && next.nodes.length > 0 ? next : null;
    offerPaintTarget();
  };

  /** Re-read the target. `ids` is a selection the engine just applied:
   *  the frame the tool edits follows it. */
  const refresh = async (ids?: readonly ElementId[]) => {
    if (!paged) return;
    const seq = ++readSeq;
    let id = target?.id ?? null;
    const selection = ids ?? (target ? null : paged.selection.elementSelection);
    if (selection) {
      if (!selection.some((s) => sameElement(s, id))) {
        id = selection.find((s) => MESH_FILLABLE.has(s.kind)) ?? null;
      }
    }
    if (!id) {
      target = null;
      setSelected(null);
      draw();
      return;
    }
    const read = await readMeshTarget(paged.client, id).catch(() => null);
    if (seq !== readSeq || !paged) return;
    if (!read || !target || !sameElement(read.id, target.id)) selected = null;
    target = read;
    const mesh = meshOf(target);
    if (selected) {
      const grid = mesh?.grids[selected.grid];
      const nodes = grid
        ? selected.nodes.filter((n) => n < grid.nodes.length)
        : [];
      selected = nodes.length > 0 ? { grid: selected.grid, nodes } : null;
    }
    offerPaintTarget();
    if (!drag || drag.kind === "click") draw();
  };

  /** Commit a mesh on the target; the selection is `next` after it. */
  const commit = async (
    mesh: Mesh,
    label: string,
    next: PointSelection | null,
  ): Promise<boolean> => {
    if (!paged || !target) return false;
    const at = target;
    // Show the edit at once; the read after the write confirms it.
    target = { ...at, fill: mesh };
    selected = next;
    preview = null;
    draw();
    const ok = await commitFillMesh(paged, at.id, mesh, label);
    await refresh();
    setSelected(selected);
    return ok;
  };

  /** The selected point or handle under a page point. */
  const pick = (
    p: Vec2,
  ):
    | { kind: "handle"; grid: number; node: number; slot: HandleSlot }
    | { kind: "node"; grid: number; node: number }
    | null => {
    const mesh = meshOf(target);
    if (!paged || !target || !mesh) return null;
    const at = target;
    const tol = pxToPt(paged, PICK_PX);
    const near = (q: Vec2) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= tol;
    if (selected) {
      const grid = mesh.grids[selected.grid];
      for (const ni of selected.nodes) {
        const n = grid?.nodes[ni];
        if (!n) continue;
        for (const slot of [0, 1, 2, 3] as const) {
          if (!handleIsLive(grid!, ni, slot)) continue;
          if (near(toPage(at, n.handles[slot])))
            return { kind: "handle", grid: selected.grid, node: ni, slot };
        }
      }
    }
    let best: { kind: "node"; grid: number; node: number } | null = null;
    let bestD = tol;
    mesh.grids.forEach((grid, gi) =>
      grid.nodes.forEach((n, ni) => {
        const q = toPage(at, n.point);
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d <= bestD) {
          bestD = d;
          best = { kind: "node", grid: gi, node: ni };
        }
      }),
    );
    return best;
  };

  /** A click that is not on a point: add one. */
  const clickAt = async (pageId: string, p: Vec2, shift: boolean) => {
    if (!paged) return;
    const hit = await elementUnder(paged, pageId, p);
    if (!hit || !MESH_FILLABLE.has(hit.kind)) {
      if (!shift) {
        setSelected(null);
        draw();
      }
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
      setSelected(null);
    }
    void selectOnly(paged, hit);
    const inner = toInner(at, p);
    const mesh = meshOf(at);
    if (mesh) {
      for (let gi = mesh.grids.length - 1; gi >= 0; gi--) {
        const grid = mesh.grids[gi]!;
        const loc = locate(grid, inner);
        if (!loc) continue;
        const res = insertMeshPoint(grid, loc);
        if (!res) return;
        await commit(withGrid(mesh, gi, res.grid), "mesh point", {
          grid: gi,
          nodes: [res.node],
        });
        return;
      }
      return;
    }
    if (!inBox(at, inner)) return;
    const color = await fillColorOf(paged.client, at);
    at = target ?? at;
    const base = boxGrid(at.box, color);
    const [top, left, bottom, right] = at.box;
    const loc = locate(base, inner) ?? {
      r: 0,
      c: 0,
      u: (inner[0] - left) / Math.max(1e-9, right - left),
      v: (inner[1] - top) / Math.max(1e-9, bottom - top),
    };
    const res = insertMeshPoint(base, loc);
    await commit(
      { kind: "mesh", grids: [res ? res.grid : base] },
      "mesh",
      res ? { grid: 0, nodes: [res.node] } : null,
    );
  };

  /** The mesh a node or handle drag shows with the pointer at `p`. */
  const dragged = (d: Drag, p: Vec2): Mesh | null => {
    const mesh = meshOf(target);
    if (!target || !mesh || d.kind === "click") return null;
    const grid = mesh.grids[d.grid];
    if (!grid) return null;
    const now = toInner(target, p);
    if (d.kind === "handle")
      return withGrid(mesh, d.grid, setHandle(grid, d.node, d.slot, now));
    const from = toInner(target, d.start);
    return withGrid(
      mesh,
      d.grid,
      moveNode(grid, d.node, [now[0] - from[0], now[1] - from[1]]),
    );
  };

  const cancelDrag = () => {
    drag = null;
    preview = null;
    draw();
  };

  return {
    onActivate(p) {
      paged = p;
      unsubscribe?.();
      unsubscribe = p.client.subscribe((msg) => {
        if (msg.kind === "elementSelectionApplied") {
          void refresh(msg.payload.ids);
        } else if (REFRESH_ON.has(msg.kind)) {
          void refresh();
        }
      });
      void refresh(p.selection.elementSelection);
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      unsubscribe?.();
      unsubscribe = null;
      drag = null;
      preview = null;
      if (paged) {
        setPaintTarget(paged, MESH_TOOL_ID, null);
        paged.overlaySignals.setToolPreview(null);
      }
      selected = null;
      target = null;
      readSeq++;
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!paged || e.button !== 0 || !e.pageId || !e.pagePoint) return;
      const hit = target?.pageId === e.pageId ? pick(e.pagePoint) : null;
      if (hit?.kind === "handle") {
        drag = { ...hit, start: e.pagePoint };
        return;
      }
      if (hit?.kind === "node") {
        const sel = selected;
        if (e.modifiers.shift) {
          const nodes =
            sel?.grid === hit.grid
              ? sel.nodes.includes(hit.node)
                ? sel.nodes.filter((n) => n !== hit.node)
                : [...sel.nodes, hit.node]
              : [hit.node];
          setSelected({ grid: hit.grid, nodes });
        } else if (sel?.grid !== hit.grid || !sel.nodes.includes(hit.node)) {
          setSelected({ grid: hit.grid, nodes: [hit.node] });
        }
        draw();
        drag = { ...hit, start: e.pagePoint };
        return;
      }
      drag = { kind: "click", pageId: e.pageId, start: e.pagePoint };
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!drag || drag.kind === "click" || !target) return;
      if (e.maxDelta <= CLICK_DRAG_THRESHOLD_PX) return;
      if (!e.pagePoint || e.pageId !== target.pageId) return;
      preview = dragged(drag, e.pagePoint);
      draw();
    },
    onPointerUp(e: CanvasPointerEvent) {
      const d = drag;
      drag = null;
      if (!paged || !d) return;
      const isDrag = e.maxDelta > CLICK_DRAG_THRESHOLD_PX;
      if (d.kind === "click") {
        preview = null;
        if (!isDrag) void clickAt(d.pageId, d.start, e.modifiers.shift);
        return;
      }
      const moved =
        isDrag && e.pagePoint && e.pageId === target?.pageId
          ? dragged(d, e.pagePoint)
          : null;
      preview = null;
      if (!moved) {
        draw();
        return;
      }
      void commit(
        moved,
        d.kind === "handle" ? "mesh handle" : "mesh point move",
        selected,
      );
    },
    onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (drag) cancelDrag();
        else {
          setSelected(null);
          draw();
        }
        return;
      }
      if (e.key !== "Backspace" && e.key !== "Delete") return;
      const mesh = meshOf(target);
      const sel = selected;
      if (!mesh || !sel || drag) return;
      const grid = mesh.grids[sel.grid];
      const node = sel.nodes[0];
      if (!grid || node === undefined) return;
      const next = removeNodeLines(grid, node);
      if (next)
        void commit(withGrid(mesh, sel.grid, next), "mesh point removal", null);
    },
  };
}
