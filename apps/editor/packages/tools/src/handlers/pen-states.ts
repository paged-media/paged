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

// The Pen's states, as the user sees them (UXI-DRW-003; paged.draw ADR
// 370). The machine (`PenMachine`, platform/shared/vector-tools) says what
// a press would do (`intent`); this file turns that, and whether a handle
// is being pulled, into one named STATE, and each state into a cursor and
// a short hint beside the pointer:
//
//   start       nothing in progress: the next press starts a new path
//   draw        a path in progress: a click places a corner, a drag a
//               smooth point; Enter finishes, Escape cancels
//   continue    over an open path's endpoint: the press picks it up
//   close       over the first anchor of the path in progress
//   join        over another open path's endpoint: ends the run on it
//   dragHandle  the button is down and moving: the handle being pulled
//   finish      over the LAST anchor of the path in progress: a click
//               there ends the open path, as Enter does
//   add/delete  over the selected path's segment / anchor
//
// Pure: no editor, no DOM. The handler feeds it its snapshot.

import type { CursorSpec } from "@paged-media/shell";
import type { PenIntent, PenSnapshot } from "@paged-media/vector-tools";
import type { Vec2 } from "@paged-media/vector-geometry";

import { PEN_TOOL } from "../messages";

export type PenState =
  | "start"
  | "draw"
  | "continue"
  | "close"
  | "join"
  | "dragHandle"
  | "finish"
  | "add"
  | "delete";

/** What the Pen is about to do: the machine's intent, refined by what the
 *  host knows and the machine does not say — a run with no anchor yet is
 *  a START, a button held past the drag threshold is a HANDLE being
 *  pulled, and the pointer over the run's last anchor FINISHES it. */
export function penStateOf(
  snapshot: Pick<PenSnapshot, "active" | "anchors" | "intent"> | null,
  pointer: {
    /** The button is down. */
    pressed: boolean;
    /** The button is down and moved past the drag threshold. */
    dragging: boolean;
    /** The pointer is over the run's last anchor (within reach). */
    overLastAnchor: boolean;
  },
): PenState {
  if (!snapshot || !snapshot.active) return "start";
  const anchors = snapshot.anchors.length;
  const intent: PenIntent = snapshot.intent;
  // Only a press that placed an anchor (or picked an endpoint up) pulls
  // a handle; a close, a join or an anchor edit does not.
  if (
    pointer.pressed &&
    pointer.dragging &&
    anchors > 0 &&
    (intent === "draw" || intent === "continue")
  )
    return "dragHandle";
  if (intent !== "draw") return intent;
  if (anchors === 0) return "start";
  if (!pointer.pressed && anchors >= 2 && pointer.overLastAnchor)
    return "finish";
  return "draw";
}

/** Is `point` within `reach` of the run's last anchor? */
export function overLastAnchor(
  snapshot: Pick<PenSnapshot, "active" | "anchors"> | null,
  point: Vec2 | null,
  reach: number,
): boolean {
  if (!snapshot?.active || !point) return false;
  const last = snapshot.anchors[snapshot.anchors.length - 1];
  if (!last) return false;
  return (
    Math.hypot(point[0] - last.anchor[0], point[1] - last.anchor[1]) <= reach
  );
}

/** A pen-nib cursor with a small badge beside it, white-haloed so it reads
 *  on any artwork. The hotspot is the nib's tip. One glyph family, so the
 *  states read as states of one tool. */
function nibCursor(badge: string | null): CursorSpec {
  const line = (d: string, color: string, width: number) =>
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
  // The nib: tip at (3, 3), the body up and to the right.
  const nib = "M3 3l3.5 9.5 2.5-2.5 4 4 2-2-4-4 2.5-2.5z";
  const parts = [line(nib, "#fff", 3), line(nib, "#111", 1.25)];
  if (badge) parts.push(line(badge, "#fff", 3.5), line(badge, "#111", 1.5));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
    parts.join("") +
    `</svg>`;
  return {
    kind: "svg",
    src: `data:image/svg+xml,${encodeURIComponent(svg)}`,
    hotspot: { x: 3, y: 3 },
  };
}

/** The badge of each state (bottom right of the nib, 14–22 px). */
const BADGE: Record<PenState, string | null> = {
  // An asterisk: a new path starts here.
  start: "M18 14v8M14.5 16l7 4M21.5 16l-7 4",
  // The plain nib: the next anchor of the path in progress.
  draw: null,
  // A slash: picks an open path up.
  continue: "M15 21l6-6",
  // A ring: closes onto the first anchor.
  close: "M18 15a3 3 0 1 0 0.01 0",
  // Two strokes meeting: joins two paths.
  join: "M14 15h3.5v6H14M22 15h-3.5",
  // A caret: the handle being pulled.
  dragHandle: "M14.5 20.5L18 15l3.5 5.5",
  // A tick: the run ends here.
  finish: "M14.5 18l2.5 2.5 4.5-5",
  add: "M14 18h8M18 14v8",
  delete: "M14 18h8",
};

/** The cursor of each state. */
export function penCursor(state: PenState): CursorSpec {
  return nibCursor(BADGE[state]);
}

/** The hint beside the pointer (a message key), or null where the cursor
 *  says enough (the plain start). */
export function penHint(state: PenState): string | null {
  switch (state) {
    case "start":
      return null;
    case "draw":
      return PEN_TOOL.hintDraw;
    case "continue":
      return PEN_TOOL.hintContinue;
    case "close":
      return PEN_TOOL.hintClose;
    case "join":
      return PEN_TOOL.hintJoin;
    case "dragHandle":
      return PEN_TOOL.hintDragHandle;
    case "finish":
      return PEN_TOOL.hintFinish;
    case "add":
      return PEN_TOOL.hintAdd;
    case "delete":
      return PEN_TOOL.hintDelete;
  }
}
