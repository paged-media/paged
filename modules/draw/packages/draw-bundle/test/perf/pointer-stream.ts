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

/** `samples` points on an Archimedean spiral around `centre`, radius
 *  growing linearly from `radius.from` to `radius.to` over `turns`
 *  turns, evenly spaced in ANGLE — so the gap between consecutive
 *  samples grows with the radius (`2π · r · turns / samples`). Pick
 *  `radius.from` so the tightest gap clears the tool's decimation floor
 *  when the scenario wants every sample kept: 0.5 pt for the pencil and
 *  the brushes, 3 px for the lasso.
 *
 *  The freehand shape that is not a straight line: it never revisits a
 *  point, it turns continuously (so RDP keeps most of it), and it fits a
 *  page at any length. */
export function spiralPoints(
  centre: Pt,
  radius: { from: number; to: number },
  turns: number,
  samples: number,
): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < samples; i++) {
    const t = samples === 1 ? 0 : i / (samples - 1);
    const a = t * turns * Math.PI * 2;
    const r = radius.from + (radius.to - radius.from) * t;
    out.push([centre[0] + r * Math.cos(a), centre[1] + r * Math.sin(a)]);
  }
  return out;
}

/** A linear congruential generator (the Numerical Recipes constants):
 *  `next()` answers a float in [0, 1). Deterministic by construction —
 *  the same seed is the same stream on every machine, which is the only
 *  kind of "random" a budget may use. */
export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** The seed every jittered stream in the budgets uses. */
export const FREEHAND_SEED = 0x5eed;

/** One sample of a pen stroke: where, and how hard. */
export interface FreehandSample {
  point: Pt;
  pressure: number;
}

/** `samples` points of a HAND-DRAWN stroke: a slow sine wave from `from`
 *  to `to`, every sample knocked off the curve by up to `jitter` pt in
 *  each axis and given its own pressure in [0.2, 0.9) — what a tablet
 *  actually sends. Seeded (see {@link lcg}), so it is the same stroke on
 *  every run.
 *
 *  Unlike {@link spiralPoints} the samples are NOT evenly spaced: jitter
 *  puts some of them closer than a tool's decimation floor, so a tool
 *  keeps fewer samples than it was sent. That is the point — it is the
 *  case the even streams cannot reach. */
export function jitteredFreehand(
  from: Pt,
  to: Pt,
  samples: number,
  options: { jitter?: number; amplitude?: number; waves?: number; seed?: number } = {},
): FreehandSample[] {
  const jitter = options.jitter ?? 1.5;
  const amplitude = options.amplitude ?? 60;
  const waves = options.waves ?? 3;
  const next = lcg(options.seed ?? FREEHAND_SEED);
  const out: FreehandSample[] = [];
  for (let i = 0; i < samples; i++) {
    const t = samples === 1 ? 0 : i / (samples - 1);
    const x = from[0] + (to[0] - from[0]) * t;
    const y =
      from[1] +
      (to[1] - from[1]) * t +
      amplitude * Math.sin(t * waves * Math.PI * 2);
    out.push({
      point: [x + (next() * 2 - 1) * jitter, y + (next() * 2 - 1) * jitter],
      pressure: 0.2 + next() * 0.7,
    });
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
