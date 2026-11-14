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

// The Type tool's DRAG: pull out a new text frame.
//
// Until now `paged.tool.type` carried no `gesture` at all. It set the
// hit-test filter to "text" and placed a caret, and that was the whole
// tool — so "press T, drag a box, type", the muscle memory of every
// InDesign user alive, produced nothing. `insertTextFrame` existed on
// the wire since protocol v24 and the only ways to reach it were a menu
// item with no keybinding, the script REPL, or dragging a thread out of
// an existing frame's out-port onto empty canvas.
//
// WHY THIS NEEDS NO CHANGE IN ViewportCanvas. The pointer-up dispatch
// already splits on `maxDelta <= CLICK_DRAG_THRESHOLD_PX`: below the
// threshold it routes to the worker's hit-tester (which is what places
// the caret), above it the gesture handler owns the drag. So a CLICK
// keeps doing exactly what it did, and only a DRAG reaches this file —
// which is precisely the InDesign split.
//
// A DRAG THAT STARTS OVER TEXT selects text, as in InDesign (the
// interaction specification's UXI-TXT-011; editor ADR 1210, IC4): from
// the story offset under the press to the one under the pointer, in story
// order across lines and threaded frames, and it creates nothing. (It
// used to do nothing at all: a frame pulled out on top of the one the
// user aimed at would have been worse.)

import type {
  CanvasPointerEvent,
  GestureHandler,
  PagedEditor,
} from "@paged-media/shell";

import {
  beginPageDrag,
  CLICK_DRAG_THRESHOLD_PX,
  endLocalFor,
  mutateAndSelect,
  type PageDrag,
} from "./shared";

/** Smaller than a shape's minimum: a one-line frame is a legitimate
 *  thing to pull out, and rounding a deliberate small drag up to a
 *  shape-sized box would fight the user. */
const MIN_TEXT_FRAME_PT = 8;

/** Pull out the frame, then put the caret in it — "drag a box, type", as
 *  in InDesign. Without the caret the frame was selected but the keys
 *  typed next went nowhere.
 *
 *  The reply names the frame but not its story (`minted` stays empty for
 *  a plain insert, and the frame has no story pointer on the wire), and a
 *  hit-test cannot find an EMPTY frame's story either — the frame under
 *  it answers. So the story is the one the stories collection gained
 *  across the insert, the same diff Insert ▸ Table relies on. */
async function createAndEnter(
  paged: PagedEditor,
  pageId: string,
  bounds: [number, number, number, number],
): Promise<void> {
  const storyIds = async () =>
    new Set(
      (await paged.client.collection<{ selfId: string }>("stories")).map(
        (s) => s.selfId,
      ),
    );
  let before: Set<string>;
  try {
    before = await storyIds();
  } catch {
    before = new Set();
  }
  const reply = await mutateAndSelect(
    paged,
    { op: "insertTextFrame", args: { pageId, bounds } },
    "insertTextFrame",
  );
  if (reply?.kind !== "mutationApplied") return;
  try {
    const minted = [...(await storyIds())].filter((id) => !before.has(id));
    if (minted.length !== 1) return;
    paged.contentSelection.setContentSelection({
      storyId: minted[0],
      start: 0,
      end: 0,
      affinity: false,
    });
  } catch {
    /* the frame stands, selected; only the caret is missing */
  }
}

export function createTypeHandler(): GestureHandler {
  let paged: PagedEditor | null = null;
  /** The drag, anchored to the page it started on: the release point
   *  is read in THAT page's space wherever it lands (the pasteboard,
   *  another page), as the Rectangle tool does (GT-3). */
  let drag: PageDrag | null = null;
  /** Set when pointer-down landed on an existing text frame: the drag is
   *  then inert (see the header note). Resolved asynchronously, so the
   *  drag may already be under way when the answer arrives — which is
   *  why it is checked at pointer-up rather than gating pointer-down. */
  let overExistingText = false;
  /** The story offset under the press, when it landed on text. */
  let anchor: { storyId: string; offset: number } | null = null;
  /** One hit test at a time while a text range is dragged; the latest
   *  pointer waits for it. */
  let rangeBusy = false;
  let rangePending: CanvasPointerEvent | null = null;

  /** Extend the text range to the offset under `e` (same story). */
  const extendRange = (e: CanvasPointerEvent): void => {
    if (!paged || !anchor || !e.pageId || !e.pagePoint) return;
    if (rangeBusy) {
      rangePending = e;
      return;
    }
    rangeBusy = true;
    const from = anchor;
    const editor = paged;
    void editor.client
      .send({
        kind: "hitTest",
        payload: { pageId: e.pageId, docPoint: e.pagePoint, filter: "text" },
      })
      .then((reply) => {
        if (anchor !== from || reply.kind !== "hitResult") return;
        const hit = reply.payload;
        if (hit.storyId !== from.storyId || hit.offsetWithinStory == null)
          return;
        const to = hit.offsetWithinStory;
        editor.contentSelection.setContentSelection({
          storyId: from.storyId,
          start: Math.min(from.offset, to),
          end: Math.max(from.offset, to),
          affinity: false,
        });
      })
      .catch(() => {})
      .then(() => {
        rangeBusy = false;
        const next = rangePending;
        rangePending = null;
        if (next) extendRange(next);
      });
  };

  const reset = () => {
    drag = null;
    overExistingText = false;
    anchor = null;
    rangePending = null;
    paged?.overlaySignals.setToolPreview(null);
  };

  const boundsFor = (
    end: [number, number],
  ): [number, number, number, number] => {
    const [sx, sy] = drag!.startLocal;
    const [ex, ey] = end;
    return [
      Math.min(sy, ey),
      Math.min(sx, ex),
      Math.max(sy, ey),
      Math.max(sx, ex),
    ];
  };

  return {
    onActivate(p: PagedEditor) {
      paged = p;
    },
    onDeactivate(reason) {
      // Spring-load suspend keeps the in-flight drag so it resumes when
      // the override is released — same rule the shape tools follow.
      if (reason === "suspend") return;
      reset();
    },
    onPointerDown(e: CanvasPointerEvent) {
      const started = paged ? beginPageDrag(e) : null;
      if (!paged || !started || !e.pagePoint) {
        reset();
        return;
      }
      drag = started;
      overExistingText = false;
      anchor = null;
      // Ask whether a text frame is already here. Filter "text" because
      // dragging across a rectangle to make a text frame is legitimate —
      // only an existing TEXT frame is the case we decline.
      const client = paged.client;
      const pageId = started.pageId;
      const docPoint = e.pagePoint;
      void (async () => {
        try {
          const reply = await client.send({
            kind: "hitTest",
            payload: { pageId, docPoint, filter: "text" },
          });
          if (reply.kind === "hitResult" && reply.payload.element) {
            overExistingText = true;
            const hit = reply.payload;
            if (
              drag === started &&
              hit.storyId &&
              hit.offsetWithinStory != null
            )
              anchor = { storyId: hit.storyId, offset: hit.offsetWithinStory };
          }
        } catch {
          // No answer — treat the canvas as empty. Refusing to create on
          // a failed hit-test would make the tool feel broken exactly
          // when the worker is already struggling.
        }
      })();
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!paged || !drag) return;
      if (e.maxDelta <= CLICK_DRAG_THRESHOLD_PX) return;
      if (overExistingText) {
        extendRange(e);
        return;
      }
      paged.overlaySignals.setToolPreview({
        pageId: drag.pageId,
        rect: boundsFor(endLocalFor(drag, e)),
      });
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!paged || !drag) {
        reset();
        return;
      }
      const bounds = boundsFor(endLocalFor(drag, e));
      const pageId = drag.pageId;
      const declined = overExistingText;
      // A drag over text ends where it was let go.
      if (declined && e.maxDelta > CLICK_DRAG_THRESHOLD_PX) {
        rangePending = null;
        extendRange(e);
        drag = null;
        overExistingText = false;
        paged.overlaySignals.setToolPreview(null);
        return;
      }
      reset();
      // A click is the caret's (the legacy path), never a frame.
      if (declined || e.maxDelta <= CLICK_DRAG_THRESHOLD_PX) return;
      const [top, left, bottom, right] = bounds;
      if (
        bottom - top < MIN_TEXT_FRAME_PT ||
        right - left < MIN_TEXT_FRAME_PT
      ) {
        return;
      }
      void createAndEnter(paged, pageId, bounds);
    },
  };
}
