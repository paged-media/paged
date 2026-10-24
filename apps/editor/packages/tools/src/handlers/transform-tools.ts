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

// Editor-ops — the three matrix-transform TOOLS (Rotate, Scale,
// Shear), which are the same handler with a different `GestureType`.
//
// Unlike the drawing tools these drive a WORKER gesture: pointer-down
// on the canvas begins the gesture against the current selection with
// the pointer position as the ANCHOR; moves stream doc-space deltas
// through the SAB hot path; pointer-up commits (one undo step). Shift
// snaps engine-side (15° tangents for Shear, 15° steps for Rotate).
//
// PIVOT — by default the engine derives it from the union centroid of
// the gesture's snapshots (`begin_gesture` → `pivot_spread`), and treats
// the anchor as "where the pointer was when the drag started", so a
// drag anywhere rotates/scales the SELECTION about its own centre.
// A CLICK (no drag) moves the pivot there instead — InDesign's and
// Illustrator's click-to-set reference point — and the next drag sends
// it as the anchor's `pivotInPage` (protocol 66, RFI C-67). The pivot is
// forgotten when the selection changes, on Escape and when the tool is
// switched away (not on a spring-load suspend). An engine older than 66
// ignores the field and pivots about the centroid as before — the
// marker then promises more than the engine does, which is why the
// field is only sent, never assumed.
//
// Rotate / Scale were reachable before this only through the selection
// chrome (the rotate handle, Cmd+drag on a resize handle) and the
// Object/Transform panel's numeric fields — the rail entries were
// inert. Same engine arms, now also reachable as tools.
//
// Mirrors ViewportCanvas's begin/buffer/flush dance: pointermoves that
// arrive before `beginGesture` resolves are buffered into
// `pendingDelta` and flushed when the handle lands; a pointer-up
// before then cancels as soon as the handle arrives so worker state
// stays clean.

import type {
  CanvasPointerEvent,
  GestureHandler,
  PagedEditor,
} from "@paged-media/shell";

import type { GestureType } from "@paged-media/client";
import { layoutPageRects } from "@paged-media/shell";

import { CLICK_DRAG_THRESHOLD_PX } from "./shared";

/** The matrix-transform gesture arms this factory can drive. All three
 *  take an anchor and commit a single `SetProperty{FrameTransform}`. */
export type TransformGestureKind = "rotate" | "scale" | "shear";

/** Prebuilt `GestureType` literals. Indexing this (rather than
 *  spreading `{ kind }`) keeps the value a DISCRIMINATED union member,
 *  which `{ kind: "rotate" | "scale" | "shear" }` is not. */
const GESTURE_SPEC = {
  rotate: { kind: "rotate" },
  scale: { kind: "scale" },
  shear: { kind: "shear" },
} as const;

/** A click-set pivot: the page it was set on, the point in that
 *  page's space, and the selection it was set for. */
interface Pivot {
  pageId: string;
  point: [number, number];
  selectionKey: string;
}

/** Half-size of the pivot marker, page pt. */
const PIVOT_MARKER_PT = 4;

const selectionKeyOf = (
  ids: readonly { kind: string; id: unknown }[],
): string => ids.map((id) => `${id.kind}:${String(id.id)}`).join("|");

/** The anchor a gesture begins with: a page and the press in its space. */
interface Anchor {
  pageId: string;
  pointInPage: [number, number];
}

/**
 * The anchor for a press OFF every page (on the pasteboard): the press
 * named in the space of the page the selection sits on (the first page
 * when its geometry names none). InDesign's Rotate / Scale / Shear take
 * the drag anywhere, and the engine measures the drag about the
 * selection's pivot, so only the page the point is spoken in matters
 * (GT-4). Pages are laid out as the canvas lays them out
 * (`layoutPageRects`).
 */
export async function pasteboardAnchor(
  paged: PagedEditor,
  targets: readonly { kind: string; id: unknown }[],
  docPoint: readonly [number, number],
): Promise<Anchor | null> {
  const [geometry, pages] = await Promise.all([
    paged.client
      .elementGeometry(targets.slice() as never)
      .catch(() => [] as { pageId?: string | null }[]),
    paged.client.collection<{ selfId: string; sizePt: [number, number] }>(
      "pages",
    ),
  ]);
  const rects = layoutPageRects(pages.map((p) => p.sizePt));
  const pageId =
    (geometry as { pageId?: string | null }[]).find((g) => g?.pageId)?.pageId ??
    pages[0]?.selfId;
  const i = pages.findIndex((p) => p.selfId === pageId);
  const rect = rects[i];
  if (!pageId || !rect) return null;
  return { pageId, pointInPage: [docPoint[0] - rect.x, docPoint[1] - rect.y] };
}

/** Modifier state a worker gesture update carries. */
export interface WorkerGestureModifiers {
  shift: boolean;
  alt: boolean;
}

/** One worker gesture in flight (`runWorkerGesture`). */
export interface WorkerGestureRun {
  /** Stream the CUMULATIVE doc-space delta since the press. */
  update(delta: [number, number], modifiers: WorkerGestureModifiers): void;
  /** Release: commit (one undo step) or cancel. Idempotent. */
  end(commit: boolean): void;
}

/**
 * Begin a worker gesture and drive it to its end — the begin / buffer /
 * flush dance every matrix-transform tool shares (Rotate, Scale, Shear and
 * each arm of Free Transform): deltas that arrive before `beginGesture`
 * resolves are buffered and flushed when the handle lands; a release
 * before then commits (or cancels) as soon as it does, so worker state
 * stays clean. `anchor` may resolve to null (no page to name the press
 * on): the gesture then never begins. `onSettled` runs after the commit
 * or cancel reached the worker (the selection chrome is refreshed first).
 */
export function runWorkerGesture(
  paged: PagedEditor,
  targets: readonly { kind: string; id: unknown }[],
  spec: GestureType,
  anchor: Promise<Record<string, unknown> | null>,
  options: {
    label: string;
    modifiers: WorkerGestureModifiers;
    onSettled?: (committed: boolean) => void;
  },
): WorkerGestureRun {
  let handle: number | null = null;
  let pendingDelta: [number, number] = [0, 0];
  let lastModifiers = options.modifiers;
  let abandoned = false;
  let commitOnResolve = false;
  let ended = false;

  const refreshSelectionChrome = () => {
    const ids = paged.selection.elementSelection;
    if (ids.length === 0) return;
    void paged.client
      .elementGeometry(ids)
      .then((items) => paged.selection.setElementGeometry(items))
      .catch(() => {});
  };
  const finish = (h: number, commit: boolean) => {
    const done = commit
      ? paged.client.commitGesture(h).then(() => undefined)
      : paged.client.cancelGesture(h).then(() => undefined);
    void done
      .then(refreshSelectionChrome)
      .then(() => options.onSettled?.(commit))
      .catch(() => {});
  };

  void anchor
    .then((a) => {
      if (!a) throw new Error("no page to anchor the gesture on");
      return paged.client.beginGesture(
        targets.slice() as never,
        spec as never,
        a as never,
      );
    })
    .then((h) => {
      if (abandoned) {
        // Released as a click (or Escape) before the worker confirmed.
        finish(h, false);
        return;
      }
      if (commitOnResolve) {
        // The drag finished before begin resolved: flush, then commit.
        void paged.client
          .updateGesture(h, pendingDelta, lastModifiers, "sab")
          .catch(() => {})
          .then(() => finish(h, true));
        return;
      }
      handle = h;
      const [dx, dy] = pendingDelta;
      if (dx !== 0 || dy !== 0) {
        void paged.client
          .updateGesture(h, pendingDelta, lastModifiers, "sab")
          .catch(() => {});
      }
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`${options.label} beginGesture failed:`, err);
      ended = true;
    });

  return {
    update(delta, modifiers) {
      if (ended) return;
      lastModifiers = modifiers;
      if (handle === null) {
        pendingDelta = delta;
        return;
      }
      void paged.client
        .updateGesture(handle, delta, modifiers, "sab")
        .catch(() => {});
    },
    end(commit) {
      if (ended) return;
      ended = true;
      if (handle === null) {
        if (commit) commitOnResolve = true;
        else abandoned = true;
        return;
      }
      finish(handle, commit);
    },
  };
}

export function createTransformGestureHandler(
  kind: TransformGestureKind,
): GestureHandler {
  let paged: PagedEditor | null = null;
  let drag: { run: WorkerGestureRun; startDoc: [number, number] } | null = null;
  let pivot: Pivot | null = null;
  /** The page + point of the pointer-down, for a click to set the pivot. */
  let down: { pageId: string; point: [number, number] } | null = null;

  const showPivot = () => {
    if (!paged) return;
    if (!pivot) {
      paged.overlaySignals.setToolPreview(null);
      return;
    }
    const [x, y] = pivot.point;
    const r = PIVOT_MARKER_PT;
    paged.overlaySignals.setToolPreview({
      pageId: pivot.pageId,
      points: [
        [x, y - r],
        [x + r, y],
        [x, y + r],
        [x - r, y],
      ],
      close: true,
    });
  };

  const clearPivot = () => {
    if (!pivot) return;
    pivot = null;
    showPivot();
  };

  /** The pivot for a drag starting now, or null when there is none for
   *  this page and this selection. */
  const livePivot = (pageId: string): Pivot | null => {
    if (!pivot || !paged) return null;
    if (
      pivot.selectionKey !== selectionKeyOf(paged.selection.elementSelection)
    ) {
      clearPivot();
      return null;
    }
    return pivot.pageId === pageId ? pivot : null;
  };

  const cancel = () => {
    drag?.run.end(false);
    drag = null;
  };

  return {
    onActivate(p) {
      paged = p;
    },
    onDeactivate(reason) {
      // A spring-load suspend keeps the worker gesture alive — it
      // resumes when the override releases. A real switch cancels.
      if (reason === "suspend") return;
      cancel();
      clearPivot();
      down = null;
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!paged || e.button !== 0) return;
      // The selection as it is NOW (the editor handle is live, GM-2),
      // not the one the tool was picked with.
      const targets = paged.selection.elementSelection.slice();
      if (targets.length === 0) return;
      const onPage: Anchor | null =
        e.pageId && e.pagePoint
          ? { pageId: e.pageId, pointInPage: [e.pagePoint[0], e.pagePoint[1]] }
          : null;
      // A click sets the pivot only where a page can name it.
      down = onPage
        ? { pageId: onPage.pageId, point: onPage.pointInPage }
        : null;
      const editor = paged;
      const anchor = (
        onPage
          ? Promise.resolve(onPage)
          : pasteboardAnchor(editor, targets, e.docPoint)
      ).then((a) => {
        if (!a) return null;
        const set = livePivot(a.pageId);
        return {
          pageId: a.pageId,
          pointInPage: a.pointInPage,
          // Protocol 66 — ahead of the pinned wire type, hence the spread.
          ...(set ? { pivotInPage: set.point } : {}),
        };
      });
      drag = {
        run: runWorkerGesture(editor, targets, GESTURE_SPEC[kind], anchor, {
          label: kind,
          modifiers: { shift: e.modifiers.shift, alt: e.modifiers.alt },
        }),
        startDoc: e.docPoint,
      };
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!paged || !drag) return;
      if (e.maxDelta <= CLICK_DRAG_THRESHOLD_PX) return;
      drag.run.update(
        [e.docPoint[0] - drag.startDoc[0], e.docPoint[1] - drag.startDoc[1]],
        { shift: e.modifiers.shift, alt: e.modifiers.alt },
      );
    },
    onPointerUp(e: CanvasPointerEvent) {
      const wasDrag = e.maxDelta > CLICK_DRAG_THRESHOLD_PX;
      // A click sets the pivot where it landed, for this selection.
      if (!wasDrag && down && paged) {
        pivot = {
          pageId: down.pageId,
          point: down.point,
          selectionKey: selectionKeyOf(paged.selection.elementSelection),
        };
        showPivot();
      }
      down = null;
      if (!drag) return;
      if (wasDrag) {
        // The release's own delta, in case no move carried it.
        drag.run.update(
          [e.docPoint[0] - drag.startDoc[0], e.docPoint[1] - drag.startDoc[1]],
          { shift: e.modifiers.shift, alt: e.modifiers.alt },
        );
      }
      drag.run.end(wasDrag);
      drag = null;
    },
    onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        cancel();
        clearPivot();
      }
    },
  };
}

/** Rotate — drag rotates the selection about its centroid; Shift snaps
 *  to 15° steps engine-side. */
export function createRotateHandler(): GestureHandler {
  return createTransformGestureHandler("rotate");
}

/** Scale — drag scales the selection about its centroid; Shift keeps
 *  the aspect ratio engine-side. */
export function createScaleHandler(): GestureHandler {
  return createTransformGestureHandler("scale");
}
