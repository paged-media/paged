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

// Synthetic pointer streams. The conformance specs send a tool 1–12
// pointer moves; a real stroke is hundreds to thousands. These build the
// long ones deterministically (no `Math.random` — a budget must measure
// the same gesture on every run).

import type { CanvasPointerEvent } from "@paged-media/plugin-api";

export type Pt = [number, number];

/** One pointer event at a page-local point. */
export function pointerAt(
  pageId: string,
  point: Pt,
  opts: { alt?: boolean; shift?: boolean; button?: number; pressure?: number } = {},
): CanvasPointerEvent {
  return {
    pageId,
    pagePoint: point,
    docPoint: point,
    modifiers: {
      shift: opts.shift ?? false,
      alt: opts.alt ?? false,
      cmd: false,
      ctrl: false,
    },
    maxDelta: 0,
    button: opts.button ?? 0,
    target: null,
    pressure: opts.pressure ?? 0.5,
    tiltX: 0,
    tiltY: 0,
    pointerType: "mouse",
  };
}

/** `samples` points evenly spaced on the segment from `from` to `to`,
 *  both ends included. */
export function linePoints(from: Pt, to: Pt, samples: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < samples; i++) {
    const t = samples === 1 ? 0 : i / (samples - 1);
    out.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
  }
  return out;
}

/** The two ways a stream reaches a handler, and they measure different
 *  things:
 *
 *  - `"paced"` yields to the event loop after every event, so an engine
 *    reply lands before the next move — what a pointer does at a frame
 *    rate the engine keeps up with.
 *  - `"burst"` delivers every event before any reply lands — what
 *    happens when moves outrun the engine (a slow document, a coalesced
 *    backlog). A handler with no in-flight guard pays for every one. */
export type Pacing = "paced" | "burst";

/** Feed `events` to `deliver`, then wait for trailing async work. */
export async function drive(
  events: readonly CanvasPointerEvent[],
  deliver: (e: CanvasPointerEvent) => void,
  pacing: Pacing,
): Promise<void> {
  for (const e of events) {
    deliver(e);
    if (pacing === "paced") await new Promise((r) => setTimeout(r, 0));
  }
  await settle();
}

/** Let fire-and-forget handler work (async reads, queued commits) land. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 2));
}
