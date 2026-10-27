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

// THE PERSPECTIVE GRID TOOL and THE PERSPECTIVE SELECTION TOOL — shims
// over draw-tools' `PerspectiveGridMachine` / `PerspectiveSelectMachine`.
//
// Both show the page's grid (activating either SHOWS it, creating a
// default two-point grid on a page that has none — Illustrator's
// Perspective Grid tool does the same), and both draw the PLANE WIDGET:
// four cells at the page's top-left corner, screen-constant in size —
// left plane, right plane, floor, no plane — and accept Illustrator's
// keys 1 (left), 2 (floor), 3 (right), 4 (none).
//
// The GRID tool drags the grid's own handles (origin = the whole grid,
// horizon, vanishing points, extents, cell size); a release saves the
// grid (`commands/perspective.ts`: the container part, off the undo
// stack, as a view setting). A LOCKED grid only switches planes.
//
// The SELECTION tool works on artwork: drag artwork already on a plane
// to move it ALONG that plane; drag other artwork to put it on the
// ACTIVE plane where you drop it; with its "a drag on nothing draws"
// option, drag on empty canvas to draw a rectangle or an ellipse on the
// active plane. Each release is one batch — geometry and the link — one
// undo step.

import type {
  BundleHost,
  ElementId,
  GestureHandler,
  ToolPreviewShape,
} from "@paged-media/plugin-api";
import { gridHandles, type PerspectiveGrid } from "@paged-media/draw-geometry";
import {
  PerspectiveGridMachine,
  PerspectiveSelectMachine,
  planeForKey,
  planeWidgetLayout,
  type PerspectiveHit,
  type PlaneWidgetCell,
} from "@paged-media/draw-tools";

import {
  readDistortTargets,
  type DistortTarget,
} from "../commands/distort-shared";
import { EDITABLE_PATH_KINDS } from "../commands/path-rewrite";
import {
  gridFor,
  insertOnPlane,
  readPerspectiveLink,
  renderPerspectiveLayer,
  saveGrid,
  writeOnPlane,
} from "../commands/perspective";
import {
  createToolOptionsReader,
  PERSPECTIVE_SELECT_OPTIONS,
} from "../tool-options";
import { polyShape, squareShape, tableShapes } from "./preview-shapes";
import { serial } from "./serial";
import { resolveTargetPage } from "../io/svg";

const PICK_PX = 7;
const HANDLE_PX = 4;
const WIDGET_PX = 18;
const WIDGET_MARGIN_PX = 10;

/** The widget's cells on a page at the current zoom. */
export function widgetCells(host: BundleHost): PlaneWidgetCell[] {
  const m = host.viewport.pxToPt(WIDGET_MARGIN_PX);
  return planeWidgetLayout([m, m], host.viewport.pxToPt(WIDGET_PX));
}

/** The widget's shapes: every cell outlined, the active one doubled. */
export function widgetShapes(
  pageId: string,
  cells: readonly PlaneWidgetCell[],
  grid: PerspectiveGrid,
): ToolPreviewShape[] {
  const out: ToolPreviewShape[] = [];
  for (const c of cells) {
    const [x0, y0, x1, y1] = c.box;
    const box: [number, number][] = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    const active = grid.activePlane === c.plane;
    out.push(polyShape(pageId, box, { close: true, dashed: !active }));
    if (active) {
      const k = (x1 - x0) * 0.2;
      out.push(
        polyShape(
          pageId,
          [
            [x0 + k, y0 + k],
            [x1 - k, y0 + k],
            [x1 - k, y1 - k],
            [x0 + k, y1 - k],
          ],
          { close: true },
        ),
      );
    }
  }
  return out;
}

/** Shared by both tools: the page's grid (created and shown on demand). */
async function shownGrid(
  host: BundleHost,
  pageId: string,
): Promise<PerspectiveGrid | null> {
  const g = await gridFor(host, pageId, true);
  if (g && !g.visible) {
    const shown = { ...g, visible: true };
    await saveGrid(host, pageId, shown);
    return shown;
  }
  return g;
}

/** The page the user is on (for activation, before any pointer): the
 *  viewport's, else the document's active or first page. */
async function activePage(host: BundleHost): Promise<string | null> {
  let page: string | null = null;
  try {
    page = host.viewport.activePage();
  } catch {
    page = null;
  }
  return page ?? (await resolveTargetPage(host).catch(() => null));
}

// ------------------------------------------------------------ the grid

export function createPerspectiveGridHandler(
  host: BundleHost,
  hooks: { onCommit?: (grid: PerspectiveGrid) => void } = {},
): GestureHandler {
  const queue = serial(host, "perspective grid");
  let machine: PerspectiveGridMachine | null = null;
  let pageId: string | null = null;

  const draw = (page: string, grid: PerspectiveGrid) => {
    const r = host.viewport.pxToPt(HANDLE_PX);
    const shapes: ToolPreviewShape[] = widgetShapes(
      page,
      widgetCells(host),
      grid,
    );
    if (!grid.locked)
      for (const h of gridHandles(grid))
        shapes.push(squareShape(page, h.point, r));
    host.overlay.setToolPreviews(shapes);
  };

  const show = async (page: string) => {
    const g = await shownGrid(host, page);
    if (g) draw(page, g);
  };

  const commit = async (page: string, grid: PerspectiveGrid) => {
    await saveGrid(host, page, grid);
    draw(page, grid);
    hooks.onCommit?.(grid);
  };

  return {
    onActivate() {
      queue.run(async () => {
        const page = await activePage(host);
        if (page) await show(page);
      });
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      machine = null;
      host.overlay.setToolPreviews(null);
    },
    onPointerDown(e) {
      if (e.button !== 0 || !e.pageId || !e.pagePoint) return;
      const page = e.pageId;
      const point = e.pagePoint;
      queue.run(async () => {
        const grid = await shownGrid(host, page);
        if (!grid) return;
        pageId = page;
        machine = new PerspectiveGridMachine({
          grid,
          tolerance: host.viewport.pxToPt(PICK_PX),
          widget: widgetCells(host),
        });
        const snap = machine.handle({ type: "down", point });
        if (snap.commit) await commit(page, snap.commit);
        else draw(page, snap.grid);
        if (!snap.active) machine = null;
      });
    },
    onPointerMove(e) {
      const point = e.pagePoint;
      const page = e.pageId;
      queue.run(async () => {
        if (!machine || !point || page !== pageId) return;
        const snap = machine.handle({ type: "move", point });
        draw(page!, snap.grid);
        // The grid lines follow the drag live through the layer too.
        await renderPerspectiveLayer(host, {
          v: 1,
          grids: { [page!]: snap.grid },
        });
      });
    },
    onPointerUp(e) {
      const point = e.pagePoint;
      const page = e.pageId;
      queue.run(async () => {
        if (!machine) return;
        const m = machine;
        machine = null;
        const snap =
          point && page === pageId
            ? m.handle({ type: "up", point })
            : m.handle({ type: "key", key: "Escape" });
        if (snap.commit && pageId) await commit(pageId, snap.commit);
        else if (pageId) {
          await renderPerspectiveLayer(host);
          draw(pageId, snap.grid);
        }
      });
    },
    onKey(e) {
      const key = e.key;
      queue.run(async () => {
        const page = pageId ?? (await activePage(host));
        if (!page) return;
        if (key === "Escape" && machine) {
          machine.handle({ type: "key", key });
          machine = null;
          await show(page);
          return;
        }
        if (!planeForKey(key)) return;
        const grid = await shownGrid(host, page);
        if (!grid) return;
        const snap = new PerspectiveGridMachine({ grid, tolerance: 0 }).handle({
          type: "key",
          key,
        });
        if (snap.commit) await commit(page, snap.commit);
      });
    },
  };
}

// ------------------------------------------------------- the selection

export function createPerspectiveSelectHandler(
  host: BundleHost,
  hooks: { onCommit?: (kind: string, applied: boolean) => void } = {},
): GestureHandler {
  const reader = createToolOptionsReader(PERSPECTIVE_SELECT_OPTIONS);
  const queue = serial(host, "perspective selection");
  let machine: PerspectiveSelectMachine | null = null;
  let pageId: string | null = null;
  let grid: PerspectiveGrid | null = null;
  let target: DistortTarget | null = null;
  let envelope: Awaited<ReturnType<typeof readPerspectiveLink>>["envelope"] =
    null;

  const chrome = (page: string, g: PerspectiveGrid): ToolPreviewShape[] =>
    widgetShapes(page, widgetCells(host), g);

  const show = async (page: string) => {
    const g = await shownGrid(host, page);
    if (g) host.overlay.setToolPreviews(chrome(page, g));
    return g;
  };

  return {
    onActivate(paged) {
      reader.attach(paged);
      queue.run(async () => {
        const page = await activePage(host);
        if (page) await show(page);
      });
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      machine = null;
      host.overlay.setToolPreviews(null);
    },
    onPointerDown(e) {
      if (e.button !== 0 || !e.pageId || !e.pagePoint) return;
      const page = e.pageId;
      const point = e.pagePoint;
      queue.run(async () => {
        const g = await show(page);
        if (!g) return;
        // The widget first.
        const cell = widgetCells(host).find(
          (c) =>
            point[0] >= c.box[0] &&
            point[0] <= c.box[2] &&
            point[1] >= c.box[1] &&
            point[1] <= c.box[3],
        );
        if (cell) {
          if (cell.plane !== g.activePlane) {
            const next = { ...g, activePlane: cell.plane };
            await saveGrid(host, page, next);
            host.overlay.setToolPreviews(chrome(page, next));
          }
          return;
        }
        let id: ElementId | null = null;
        try {
          id =
            (await host.document.hitTest(page, point, "any"))?.element ?? null;
        } catch {
          id = null;
        }
        let hit: PerspectiveHit = { kind: "none" };
        target = null;
        envelope = null;
        if (id && EDITABLE_PATH_KINDS.has(id.kind)) {
          const [t] = await readDistortTargets(host, [id]);
          if (t) {
            target = t;
            const read = await readPerspectiveLink(host, id);
            envelope = read.envelope;
            hit =
              read.link && read.link.page === page
                ? {
                    kind: "attached",
                    plane: read.link.plane,
                    flat: read.link.flat,
                  }
                : { kind: "free", table: t.page };
            await host.selection.set([id]);
          }
        }
        pageId = page;
        grid = g;
        const shape = reader.select("shape") as
          "none" | "rectangle" | "ellipse";
        machine = new PerspectiveSelectMachine({ grid: g, shape });
        const snap = machine.handle({ type: "down", point, hit });
        if (!snap.active) machine = null;
      });
    },
    onPointerMove(e) {
      const point = e.pagePoint;
      const page = e.pageId;
      queue.run(async () => {
        if (!machine || !point || page !== pageId || !grid) return;
        const snap = machine.handle({ type: "move", point });
        const shapes = chrome(page!, grid);
        if (snap.preview) shapes.push(...tableShapes(page!, snap.preview));
        host.overlay.setToolPreviews(shapes);
      });
    },
    onPointerUp(e) {
      const point = e.pagePoint;
      const page = e.pageId;
      queue.run(async () => {
        if (!machine || !pageId || !grid) return;
        const m = machine;
        machine = null;
        const snap =
          point && page === pageId
            ? m.handle({ type: "up", point })
            : m.handle({ type: "key", key: "Escape" });
        host.overlay.setToolPreviews(chrome(pageId, grid));
        const c = snap.commit;
        if (!c) return;
        const link = { plane: c.plane, page: pageId, flat: c.flat };
        let applied = false;
        if (c.kind === "draw")
          applied = (await insertOnPlane(host, pageId, c.page, link)) !== null;
        else if (target)
          applied = await writeOnPlane(host, `perspective ${c.kind}`, [
            { target, page: c.page, link, envelope },
          ]);
        hooks.onCommit?.(c.kind, applied);
      });
    },
    onKey(e) {
      const key = e.key;
      queue.run(async () => {
        if (key === "Escape") {
          if (machine) machine.handle({ type: "key", key: "Escape" });
          machine = null;
          if (pageId && grid)
            host.overlay.setToolPreviews(chrome(pageId, grid));
          return;
        }
        const plane = planeForKey(key);
        const page = pageId ?? (await activePage(host));
        if (!plane || !page) return;
        const g = await gridFor(host, page, true);
        if (!g || g.activePlane === plane) return;
        const next = { ...g, activePlane: plane };
        await saveGrid(host, page, next);
        grid = next;
        host.overlay.setToolPreviews(chrome(page, next));
      });
    },
  };
}
