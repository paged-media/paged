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

// Editor-ops — the Pen tool's gesture handler: a SHIM over paged.draw's
// `PenMachine`.
//
// THE MACHINE OWNS THE MODIFIER MATRIX. Click = corner, click-drag =
// smooth (the incoming handle mirrors), Alt breaks the pair, Shift
// constrains to 45°, a click on the first anchor closes, Enter commits
// the open run, Escape cancels — and, since the machine's v2, the same
// tool works on paths that ALREADY EXIST: press an open path's endpoint
// to continue it, end on its other endpoint to close it, end on another
// open path's endpoint to join the two, and click an anchor / a segment
// of the selected path to delete / add one. None of that is restated
// here (it lived here once, as a hand-written copy of v1; that copy
// could author a new path and nothing else).
//
// What this file does is the host's half:
//
//   · PAGE-ANCHORS the run. The page under the first press owns the run
//     and every later point is resolved against it, so a click that
//     strays onto the pasteboard or a neighbouring page still lands
//     where it was aimed (the Rectangle handler's rule).
//   · RESOLVES THE HIT — which anchor or segment of which path is under
//     the pointer. The machine never queries anything; see `resolveHit`.
//   · DRAWS the machine's snapshot (`penPreview`, true cubics) and turns
//     it into one of the Pen's named STATES (`pen-states.ts`: start,
//     draw, continue, close, join, dragHandle, finish, add, delete), each
//     with its own cursor and a short hint beside the pointer
//     (UXI-DRW-003, paged.draw ADR 370). A click on the run's last
//     anchor finishes the open path, as Enter does.
//   · SENDS the plan: `penPlanMutation` lowers it to ONE mutation — an
//     `insertPath`, or one `batch` — so every gesture is one undo step
//     (invariant 9 / INV-1). Nothing is mutated before that.
//
// EVENTS ARE QUEUED. The hit is an engine read, and a read is
// asynchronous, while the machine takes its events synchronously and in
// order. So every pointer and key event becomes a task on one promise
// chain: a press awaits its hit, then is fed; the moves, the release and
// the Enter behind it run after it, in the order they happened. Hover
// moves coalesce (only the newest is worth resolving).

import type {
  CanvasPointerEvent,
  GestureHandler,
  PagedEditor,
} from "@paged-media/shell";
import type { ElementId, PathAnchorsResult } from "@paged-media/client";

import type { AnchorTable, Vec2 } from "@paged-media/vector-geometry";
import {
  PenMachine,
  penPlanMutation,
  penPreview,
  type PenEvent,
  type PenHit,
  type PenPath,
  type PenPlan,
  type PenSnapshot,
} from "@paged-media/vector-tools";
import { t } from "@paged-media/strings";

import { createHostSnapper } from "./snapper";
import {
  overLastAnchor,
  penCursor,
  penHint,
  penStateOf,
  type PenState,
} from "./pen-states";

import {
  hitPathTable,
  pathHitRadii,
  toPointerTable,
  type PathHit,
} from "../path-edit/path-hit";

import {
  beginPageDrag,
  endLocalFor,
  mutateGraphicAndSelect,
  pxToPt,
  type PageDrag,
} from "./shared";

/** Screen-space radius for the click-on-first-anchor close (DR-10). */
const CLOSE_TOLERANCE_PX = 6;
/** Pointer travel below which a down→up is a click (corner), not a
 *  smooth-handle drag — converted to pt at the current zoom. */
const DRAG_THRESHOLD_PX = 3;

/** The element kinds that carry an anchor table (the path-edit
 *  overlay's list). An oval is declared by its bounds; a group has no
 *  geometry of its own. */
const PATH_KINDS: ReadonlySet<string> = new Set([
  "polygon",
  "graphicLine",
  "rectangle",
  "textFrame",
]);

/** A candidate path as the engine reported it, plus the same table in
 *  pointer space for hit-testing. */
interface Candidate {
  id: ElementId;
  reply: PathAnchorsResult;
  view: AnchorTable;
}

function keyOf(id: ElementId): string {
  return `${id.kind}:${JSON.stringify(id.id)}`;
}

/** Is `index` an end of an OPEN contour — the only anchors the Pen can
 *  pick a path up at? */
function isOpenEndpoint(table: AnchorTable, index: number): boolean {
  const n = table.anchors.length;
  const starts = table.subpathStarts.length > 0 ? table.subpathStarts : [0];
  for (let si = 0; si < starts.length; si++) {
    const from = starts[si];
    const to = si + 1 < starts.length ? starts[si + 1] : n;
    if (index < from || index >= to) continue;
    return (
      (table.subpathOpen?.[si] ?? false) && (index === from || index === to - 1)
    );
  }
  return false;
}

/** The overlay layer the Pen's hint is drawn on (beside the pointer). */
const HINT_LAYER = "paged.tool.pen.hint";
/** The hint's offset from the pointer, screen px (right and below the
 *  cursor's badge). */
const HINT_OFFSET_PX: Vec2 = [18, 30];

export function createPenHandler(): GestureHandler {
  let paged: PagedEditor | null = null;
  // The page the run is anchored to, fixed at the first press.
  let page: PageDrag | null = null;
  let machine: PenMachine | null = null;
  let snapshot: PenSnapshot | null = null;
  // Where the machine was last fed a point — `up` carries none of its
  // own that matters, but the event type wants one.
  let lastPoint: Vec2 = [0, 0];
  // A button is down. An EVENT-TIME fact (the queue lags it): it sorts
  // a move into "drag sample" or "hover".
  let pressed = false;
  // The press that finished the run: its release belongs to nothing.
  let finishing = false;
  // The button is down and has moved past the drag threshold (screen
  // px, the event's own `maxDelta`): a handle is being pulled.
  let dragging = false;
  // Where the pointer last was, on the page the hint is drawn on.
  let pointerAt: { pageId: string; point: Vec2 } | null = null;
  let queue: Promise<void> = Promise.resolve();
  let hoverPending: CanvasPointerEvent | null = null;
  let hoverQueued = false;

  // The live element selection. The `PagedEditor` handed to
  // `onActivate` is the render it was built in — its `selection` does
  // not move — so the selection is followed on the wire instead.
  let selection: ElementId[] = [];
  // Anchor tables by element, good until the document next changes.
  const tables = new Map<string, Promise<Candidate | null>>();
  let unsubscribe: (() => void) | null = null;

  const ptPerPx = () => (paged ? pxToPt(paged, 1) : 1);
  // Snapping (RFI C-68): a press or hover over EMPTY space snaps through
  // the engine — to every visible element, the page, the guides and this
  // run's own anchors. A hit on a path (continue / join / add / delete) is
  // never moved by a snap — the machine decides those on the raw pointer.
  const snapper = createHostSnapper(() => paged);
  const snapIfEmpty = async (
    pageId: string,
    point: Vec2,
    hit: PenHit,
    e: CanvasPointerEvent,
  ): Promise<Vec2> =>
    hit.kind === "empty"
      ? snapper.snapAsync(
          pageId,
          point,
          e,
          ptPerPx(),
          snapshot?.anchors.map((a) => a.anchor) ?? [],
        )
      : point;

  const enqueue = (task: () => void | Promise<void>) => {
    const run = async () => {
      try {
        await task();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("pen: event failed:", err);
      }
    };
    queue = queue.then(run, run);
  };

  /** The machine for this run. Its tolerances are options, and the
   *  machine reads them when it uses them — so they are getters, and a
   *  zoom between two clicks of one run is honoured. */
  const ensureMachine = (): PenMachine => {
    machine ??= new PenMachine({
      get closeTolerance() {
        return CLOSE_TOLERANCE_PX * ptPerPx();
      },
      get dragThreshold() {
        return DRAG_THRESHOLD_PX * ptPerPx();
      },
    });
    return machine;
  };

  const feed = (event: PenEvent): PenSnapshot => {
    if (event.type !== "key") lastPoint = event.point;
    snapshot = ensureMachine().handle(event);
    return snapshot;
  };

  /** Draw the run in progress: the machine's anchors as true cubics,
   *  with the rubber band to the hover point. */
  const repaint = () => {
    if (!paged) return;
    paged.overlaySignals.setToolPreview(
      page && snapshot ? penPreview(snapshot, page.pageId) : null,
    );
    paintHint();
  };

  /** The state a press here would be in: the machine's intent, with the
   *  start, the handle being pulled and the finish the host sees. */
  const stateAt = (point: Vec2 | null, held = pressed): PenState =>
    penStateOf(snapshot, {
      pressed: held,
      dragging,
      overLastAnchor:
        snapshot !== null &&
        !snapshot.closePreview &&
        overLastAnchor(snapshot, point, CLOSE_TOLERANCE_PX * ptPerPx()),
    });

  /** The hint beside the pointer, in the editor's language, on an overlay
   *  layer of its own (the tool-preview slot keeps the path). */
  const paintHint = () => {
    const signals = paged?.overlaySignals;
    if (!signals) return;
    const at = pointerAt;
    const key = at ? penHint(stateAt(at.point)) : null;
    if (!at || !key) {
      signals.removeOverlayLayer?.(HINT_LAYER);
      return;
    }
    const k = ptPerPx();
    signals.setOverlayLayer?.(HINT_LAYER, [
      {
        kind: "text",
        pageId: at.pageId,
        x: at.point[0] + HINT_OFFSET_PX[0] * k,
        y: at.point[1] + HINT_OFFSET_PX[1] * k,
        text: t(key),
        size: 11,
        background: true,
      },
    ]);
  };

  const reset = () => {
    snapper.reset();
    paged?.overlaySignals.setToolPreview(null);
    page = null;
    machine = null;
    snapshot = null;
    dragging = false;
  };

  // ---- the hit --------------------------------------------------------------

  const candidate = (id: ElementId): Promise<Candidate | null> => {
    const key = keyOf(id);
    let entry = tables.get(key);
    if (!entry) {
      entry = (paged ? paged.client.pathAnchors(id) : Promise.resolve(null))
        .then((reply) =>
          reply && reply.anchors.length > 0
            ? { id, reply, view: toPointerTable(reply, reply.itemTransform) }
            : null,
        )
        .catch(() => null);
      tables.set(key, entry);
    }
    return entry;
  };

  /**
   * What the pointer is over, for the machine. Three engine reads, each
   * for the one thing it is good at:
   *
   *   · `marqueeHits` over a small box round the pointer — WHICH
   *     elements are near. Not `hitTest`: that answers one element, and
   *     it tests the frame box, on whose very edge an open path's
   *     endpoint sits (measured: it misses the end of a rotated path).
   *   · `pathAnchors` — each candidate's table and item transform.
   *   · the selection, followed on the wire — which path may be edited.
   *
   * The anchor / segment under the pointer is then found on those
   * tables in page space (`hitPathTable`), with the path-edit overlay's
   * own grab sizes at the current zoom.
   *
   * Several paths can lie under one pointer and the machine takes ONE
   * hit, so they are ranked by what the machine can do with them: an
   * open path's endpoint (continue / close / join), then an anchor of
   * the selected path (delete), then its segment (add). Anything else
   * is empty space — the plain pen.
   */
  const resolveHit = async (pageId: string, point: Vec2): Promise<PenHit> => {
    if (!paged) return { kind: "empty" };
    const radii = pathHitRadii(ptPerPx());
    const reach = Math.max(radii.anchor, radii.segment);
    let near: ElementId[] = [];
    try {
      near = await paged.client.marqueeHits(pageId, [
        point[1] - reach,
        point[0] - reach,
        point[1] + reach,
        point[0] + reach,
      ]);
    } catch {
      /* worker reload — nothing is near */
    }
    const selected = selection.length === 1 ? selection[0] : null;
    const selectedKey = selected ? keyOf(selected) : null;
    const ids = new Map<string, ElementId>();
    for (const id of selected ? [...near, selected] : near) {
      if (PATH_KINDS.has(id.kind)) ids.set(keyOf(id), id);
    }
    let best: { rank: number; hit: PenHit } | null = null;
    for (const [key, id] of ids) {
      const c = await candidate(id);
      if (!c || c.reply.pageId !== pageId) continue;
      const isSelected = key === selectedKey;
      const found: PathHit = hitPathTable(c.view, point, radii, {
        handles: false,
      });
      if (found.kind === "empty" || found.kind === "handle") continue;
      const path: PenPath = {
        id: c.id,
        table: c.reply,
        transform: c.reply.itemTransform ?? null,
        selected: isSelected,
      };
      let rank: number;
      if (found.kind === "anchor") {
        if (isOpenEndpoint(c.reply, found.index)) rank = 0;
        else if (isSelected) rank = 1;
        else continue;
      } else if (isSelected) {
        rank = 2;
      } else {
        continue;
      }
      if (!best || rank < best.rank) best = { rank, hit: { ...found, path } };
    }
    return best ? best.hit : { kind: "empty" };
  };

  // ---- the wire -------------------------------------------------------------

  const send = async (plan: PenPlan, pageId: string): Promise<void> => {
    if (!paged) return;
    const mutation = penPlanMutation(plan, pageId);
    if (plan.kind === "insertPath") {
      // A new element: it wears the graphic default, and the created
      // path is selected (the post-insert flow every drawing tool shares).
      await mutateGraphicAndSelect(paged, mutation, "insertPath");
      return;
    }
    const label = `pen ${plan.kind}`;
    let reply;
    try {
      reply = await paged.client.mutate(mutation);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`${label} failed:`, err);
      return;
    }
    if (reply.kind === "mutationFailed") {
      // eslint-disable-next-line no-console
      console.warn(
        `${label} rejected by engine:`,
        JSON.stringify((reply as { payload?: unknown }).payload),
      );
      return;
    }
    // An edit to an existing path leaves THAT path selected — the
    // continued one, the one a run was attached to, the survivor of a
    // join — with its chrome on the new geometry.
    const edited = plan.ops[0]?.elementId;
    if (!edited) return;
    try {
      const ids = await paged.client.setElementSelection([edited], "replace");
      paged.selection.setElementSelection(ids);
      paged.selection.setElementGeometry(
        await paged.client.elementGeometry(ids),
      );
    } catch {
      /* selection is chrome — its absence never blocks the edit */
    }
  };

  /** After an event that can end a gesture: send what it planned, then
   *  either start over (the run committed or was cancelled) or redraw. */
  const settle = async (snap: PenSnapshot): Promise<void> => {
    const pageId = page?.pageId ?? "";
    if (!snap.active) reset();
    if (snap.plan) await send(snap.plan, pageId);
    if (!snap.active) {
      paintHint();
      return;
    }
    // An add / delete click plans without ending the machine, and leaves
    // nothing in progress: the next press anchors its own page.
    if (snap.anchors.length === 0) page = null;
    repaint();
  };

  // ---- the events, in order ---------------------------------------------------

  const modifiers = (e: CanvasPointerEvent) => ({
    shift: e.modifiers.shift,
    alt: e.modifiers.alt,
  });

  const down = async (e: CanvasPointerEvent) => {
    // The first press of a run anchors it to the page under the
    // pointer; a pasteboard press has no page and is ignored.
    if (!page) {
      const start = beginPageDrag(e);
      if (!start) return;
      page = start;
    }
    const raw = endLocalFor(page, e);
    pointerAt = { pageId: page.pageId, point: raw };
    const hit = await resolveHit(page.pageId, raw);
    // A click on the run's last anchor finishes the open path, as Enter
    // does (the machine would place a second anchor on top of it).
    // (Asked as of before this press: the button is already down.)
    if (hit.kind === "empty" && machine && stateAt(raw, false) === "finish") {
      finishing = true;
      await settle(feed({ type: "key", key: "Enter" }));
      return;
    }
    const point = await snapIfEmpty(page.pageId, raw, hit, e);
    feed({
      type: "down",
      point,
      modifiers: modifiers(e),
      sample: { pressure: e.pressure, tiltX: e.tiltX, tiltY: e.tiltY },
      hit,
    });
    repaint();
  };

  const drag = (e: CanvasPointerEvent) => {
    if (!page || !machine) return;
    const point = endLocalFor(page, e);
    pointerAt = { pageId: page.pageId, point };
    feed({
      type: "move",
      point,
      modifiers: modifiers(e),
    });
    repaint();
  };

  const hover = async () => {
    hoverQueued = false;
    const e = hoverPending;
    hoverPending = null;
    if (!e) return;
    // With a run in progress the hover is resolved on the run's page;
    // before one, on whatever page the pointer is over.
    const at = page
      ? { pageId: page.pageId, point: endLocalFor(page, e) }
      : e.pageId && e.pagePoint
        ? { pageId: e.pageId, point: e.pagePoint }
        : null;
    if (!at) {
      // Off every page with nothing in progress: the plain pen.
      snapshot = null;
      pointerAt = null;
      paintHint();
      return;
    }
    pointerAt = { pageId: at.pageId, point: [at.point[0], at.point[1]] };
    const hit = await resolveHit(at.pageId, at.point);
    const point = await snapIfEmpty(at.pageId, at.point, hit, e);
    feed({ type: "move", point, modifiers: modifiers(e), hit });
    repaint();
  };

  const up = async (e: CanvasPointerEvent) => {
    if (finishing) {
      finishing = false;
      return;
    }
    if (!page || !machine) return;
    await settle(
      feed({ type: "up", point: lastPoint, modifiers: modifiers(e) }),
    );
  };

  const key = async (k: "Enter" | "Escape") => {
    // Nothing in progress → the keys are not the pen's.
    if (!page || !machine) return;
    await settle(feed({ type: "key", key: k }));
  };

  return {
    onActivate(p) {
      paged = p;
      selection = [...p.selection.elementSelection];
      unsubscribe = p.client.subscribe((msg) => {
        if (msg.kind === "elementSelectionApplied") {
          selection = msg.payload.ids;
          return;
        }
        if (
          msg.kind === "mutationApplied" ||
          msg.kind === "undoApplied" ||
          msg.kind === "redoApplied" ||
          msg.kind === "documentLoaded"
        ) {
          tables.clear();
        }
      });
    },
    onDeactivate(reason) {
      // Spring-load suspend keeps the in-flight path (AC 5); a real
      // tool switch commits the open run (Illustrator behaviour) — the
      // machine's Enter drops a degenerate one.
      if (reason === "suspend") return;
      enqueue(async () => {
        if (page && machine) {
          const snap = feed({ type: "key", key: "Enter" });
          if (snap.plan) await send(snap.plan, page.pageId);
        }
        reset();
        pointerAt = null;
        paged?.overlaySignals.removeOverlayLayer?.(HINT_LAYER);
        unsubscribe?.();
        unsubscribe = null;
      });
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!paged || e.button !== 0) return;
      pressed = true;
      dragging = false;
      enqueue(() => down(e));
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!paged) return;
      if (pressed) {
        if (!dragging && e.maxDelta > DRAG_THRESHOLD_PX) dragging = true;
        enqueue(() => drag(e));
        return;
      }
      hoverPending = e;
      if (hoverQueued) return;
      hoverQueued = true;
      enqueue(hover);
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!paged) return;
      pressed = false;
      dragging = false;
      enqueue(() => up(e));
    },
    onKey(e: KeyboardEvent) {
      if (e.key !== "Enter" && e.key !== "Escape") return;
      const k = e.key;
      enqueue(() => key(k));
    },
    busy() {
      // A path under construction: Escape cancels its open run.
      return page !== null && machine !== null;
    },
    cursorAt(e: CanvasPointerEvent) {
      // What a press here would do, as the machine last resolved it,
      // named as a state (UXI-DRW-003): each state has its own cursor.
      const point = page
        ? endLocalFor(page, e)
        : e.pagePoint
          ? ([e.pagePoint[0], e.pagePoint[1]] as Vec2)
          : null;
      return penCursor(stateAt(point));
    },
  };
}
