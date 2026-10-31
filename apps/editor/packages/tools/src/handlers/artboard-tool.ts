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

// Engine ADR 1011 — the Artboard tool (`shift+o`). Pages are artboards
// placed freely on the canvas.
//
//   - click a board       → select it (the Artboards panel follows)
//   - drag a board        → move it (`placePage`), its edges and centre
//                           snapping to the other boards' (Shift: one
//                           axis only)
//   - Alt-drag a board    → duplicate it there (`duplicatePage`, then the
//                           copy's `placePage` amended into the same undo
//                           step)
//   - drag a handle       → resize it, the content staying where it is
//                           on the canvas (`resizePage` + `placePage`,
//                           one batch)
//   - arrow keys          → nudge the selected board 1 pt (Shift: 10 pt)
//   - Delete / Backspace  → delete the selected board
//   - Escape              → cancel a drag, else deselect
//
// Every commit is ONE undo step. The board list is read from the `pages`
// collection (each page's `canvasOriginPt`, `sizePt`, `boundsPt`) on
// activation and after every commit.

import type {
  CanvasPointerEvent,
  GestureHandler,
  PagedEditor,
} from "@paged-media/shell";

import {
  artboardAt,
  artboardsOf,
  handleAt,
  handlePoint,
  HANDLE_IDS,
  placeArtboardMutation,
  resizeArtboardMutation,
  resizeRect,
  snapMove,
  type Artboard,
  type CanvasRect,
  type HandleId,
  type PageSummaryLike,
} from "../artboards/model";
import { artboardSelectionOf } from "../artboards/selection";
import { CLICK_DRAG_THRESHOLD_PX, pxToPt } from "./shared";

/** Handle half-size and grab tolerance, CSS px. */
const HANDLE_PX = 4;
const GRAB_PX = 7;
/** Snap tolerance, CSS px. */
const SNAP_PX = 6;

type Drag =
  | {
      kind: "move";
      board: Artboard;
      start: [number, number];
      duplicate: boolean;
    }
  | {
      kind: "resize";
      board: Artboard;
      handle: HandleId;
      start: [number, number];
    };

type Reply = { kind: string; payload?: unknown };

function warnIfFailed(label: string) {
  return (reply: Reply) => {
    if (reply.kind === "mutationFailed") {
      // eslint-disable-next-line no-console
      console.warn(
        `${label} rejected by engine:`,
        JSON.stringify(reply.payload ?? null),
      );
    }
    return reply;
  };
}

export function createArtboardHandler(): GestureHandler {
  let paged: PagedEditor | null = null;
  let boards: Artboard[] = [];
  let drag: Drag | null = null;
  /** The rect the drag shows now (what the commit writes). */
  let live: CanvasRect | null = null;
  let guides: { x: number | null; y: number | null } = { x: null, y: null };
  let unsubscribe: (() => void) | null = null;

  const selection = () => (paged ? artboardSelectionOf(paged.client) : null);
  const selected = (): Artboard | null => {
    const id = selection()?.get() ?? null;
    return boards.find((b) => b.pageId === id) ?? null;
  };

  const read = (): Promise<void> => {
    if (!paged) return Promise.resolve();
    return paged.client
      .collection<PageSummaryLike>("pages")
      .then((pages) => {
        // Unnamed boards show their page number on the canvas; the panel
        // gives them their (translated) default name.
        boards = artboardsOf(pages, (i) => String(i));
        draw();
      })
      .catch(() => undefined);
  };

  /** The selected board's chrome, or the drag's rect, as tool previews in
   *  the board's own page space (the overlay shifts by its page rect). */
  const draw = () => {
    if (!paged) return;
    const board = drag?.board ?? selected();
    if (!board) {
      paged.overlaySignals.setToolPreview(null);
      return;
    }
    const r = live ?? board;
    const local = (x: number, y: number): [number, number] => [
      x - board.x,
      y - board.y,
    ];
    const [l, t] = local(r.x, r.y);
    const shapes: Array<Record<string, unknown>> = [
      { pageId: board.pageId, rect: [t, l, t + r.h, l + r.w] },
    ];
    const hs = pxToPt(paged, HANDLE_PX);
    shapes.push({
      pageId: board.pageId,
      cells: HANDLE_IDS.map((id) => {
        const [hx, hy] = local(...handlePoint(r, id));
        return [hy - hs, hx - hs, hy + hs, hx + hs];
      }),
    });
    const label = drag
      ? `${Math.round(r.w)} × ${Math.round(r.h)} pt`
      : board.name;
    shapes.push({
      kind: "text",
      pageId: board.pageId,
      x: l,
      y: t - pxToPt(paged, 6),
      text: label,
      background: Boolean(drag),
    });
    if (guides.x !== null) {
      const [gx] = local(guides.x, 0);
      shapes.push({
        pageId: board.pageId,
        points: [
          [gx, -100000],
          [gx, 100000],
        ],
      });
    }
    if (guides.y !== null) {
      const [, gy] = local(0, guides.y);
      shapes.push({
        pageId: board.pageId,
        points: [
          [-100000, gy],
          [100000, gy],
        ],
      });
    }
    paged.overlaySignals.setToolPreviews(shapes as never);
  };

  const endDrag = () => {
    drag = null;
    live = null;
    guides = { x: null, y: null };
    draw();
  };

  const mutate = (mutation: Record<string, unknown>, label: string) => {
    if (!paged) return Promise.resolve(null);
    return paged.client
      .mutate(mutation as never)
      .then(warnIfFailed(label))
      .then((reply) => {
        void read();
        return reply;
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`${label} failed:`, err);
        return null;
      });
  };

  /** Alt-drag: the copy, then its place amended into the copy's step. */
  const duplicateTo = async (board: Artboard, at: [number, number]) => {
    if (!paged) return;
    const client = paged.client;
    const reply = (await client
      .mutate({ op: "duplicatePage", args: { page: board.pageId } } as never)
      .then(warnIfFailed("duplicatePage"))
      .catch(() => null)) as Reply | null;
    if (!reply || reply.kind !== "mutationApplied") return;
    const payload = reply.payload as {
      appliedSeq?: number;
      createdPages?: string[];
    };
    const copy = payload.createdPages?.[0];
    if (!copy) return;
    const place = placeArtboardMutation(copy, at);
    const send = (kind: unknown) =>
      client.send(kind as never).catch(() => null) as Promise<Reply | null>;
    let amended =
      payload.appliedSeq !== undefined
        ? await send({
            kind: "amendMutation",
            payload: { appliedSeq: payload.appliedSeq, mutation: place },
          })
        : null;
    // Something took its own undo step in between (the engine refuses the
    // amend): the place becomes a step of its own rather than be lost.
    if (amended?.kind !== "mutationApplied") {
      amended = await send({ kind: "mutate", payload: place });
    }
    if (amended) warnIfFailed("placePage")(amended);
    if (amended?.kind === "mutationApplied") selection()?.set(copy);
    void read();
  };

  const others = (board: Artboard) =>
    boards.filter((b) => b.pageId !== board.pageId);

  return {
    onActivate(p) {
      paged = p;
      unsubscribe?.();
      unsubscribe = artboardSelectionOf(p.client).subscribe(draw);
      void read();
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      drag = null;
      live = null;
      guides = { x: null, y: null };
      unsubscribe?.();
      unsubscribe = null;
      paged?.overlaySignals.setToolPreview(null);
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!paged || e.button !== 0) return;
      const at = e.docPoint;
      const sel = selected();
      const grab = pxToPt(paged, GRAB_PX);
      const handle = sel ? handleAt(sel, at, grab) : null;
      if (sel && handle) {
        drag = { kind: "resize", board: sel, handle, start: [at[0], at[1]] };
        live = { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
        draw();
        return;
      }
      let board = artboardAt(boards, at);
      // The pointer is over a page the list does not know yet (it was
      // read before the page came): take its place from the event.
      if (!board && e.pageId && e.pagePoint) {
        void read();
        board = {
          pageId: e.pageId,
          index: 0,
          name: "",
          named: false,
          x: at[0] - e.pagePoint[0],
          y: at[1] - e.pagePoint[1],
          w: 0,
          h: 0,
          bounds: null,
          placed: false,
        };
      }
      if (!board) {
        selection()?.set(null);
        return;
      }
      selection()?.set(board.pageId);
      drag = {
        kind: "move",
        board,
        start: [at[0], at[1]],
        duplicate: e.modifiers.alt,
      };
      draw();
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!paged || !drag) return;
      if (e.maxDelta <= CLICK_DRAG_THRESHOLD_PX) return;
      let dx = e.docPoint[0] - drag.start[0];
      let dy = e.docPoint[1] - drag.start[1];
      const tol = pxToPt(paged, SNAP_PX);
      const b = drag.board;
      if (drag.kind === "move") {
        if (e.modifiers.shift) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const moved = { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };
        const snapped = snapMove(
          moved,
          drag.duplicate ? boards : others(b),
          tol,
        );
        // Shift keeps the locked axis exactly where it was.
        live = {
          ...snapped.rect,
          x: e.modifiers.shift && dx === 0 ? b.x : snapped.rect.x,
          y: e.modifiers.shift && dy === 0 ? b.y : snapped.rect.y,
        };
        guides = { x: snapped.guideX, y: snapped.guideY };
      } else {
        const snapped = resizeRect(b, drag.handle, dx, dy, others(b), tol);
        live = snapped.rect;
        guides = { x: snapped.guideX, y: snapped.guideY };
      }
      draw();
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!paged || !drag) return;
      const d = drag;
      const to = live;
      const wasDrag = e.maxDelta > CLICK_DRAG_THRESHOLD_PX && to !== null;
      endDrag();
      if (!wasDrag || !to) return;
      if (d.kind === "move") {
        if (to.x === d.board.x && to.y === d.board.y && !d.duplicate) return;
        if (d.duplicate) {
          void duplicateTo(d.board, [to.x, to.y]);
          return;
        }
        void mutate(
          placeArtboardMutation(d.board.pageId, [to.x, to.y]),
          "placePage",
        );
        return;
      }
      const m = resizeArtboardMutation(d.board, to);
      if (m) void mutate(m, "resizeArtboard");
    },
    onKey(e: KeyboardEvent) {
      if (!paged) return;
      if (e.key === "Escape") {
        if (drag) endDrag();
        else selection()?.set(null);
        return;
      }
      const sel = selected();
      if (!sel || drag) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        selection()?.set(null);
        void mutate(
          { op: "deletePage", args: { pageId: sel.pageId } },
          "deletePage",
        );
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      const nudge: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const by = nudge[e.key];
      if (by) {
        e.preventDefault?.();
        void mutate(
          placeArtboardMutation(sel.pageId, [sel.x + by[0], sel.y + by[1]]),
          "placePage",
        );
      }
    },
  };
}
