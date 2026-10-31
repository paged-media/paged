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

// What a video of the deck shows when (slide ADR 720), as PowerPoint's
// File ▸ Export ▸ Create a Video lays it out: the slides that are not
// hidden, each for its recorded time ("advance after", with "Use recorded
// timings") or the default seconds per slide; a slide's transition plays
// as it comes in, before its time on screen. Pure: frame counts at a fixed
// frame rate, so a test checks the arithmetic and the runner only draws.

import {
  resolveShowTransition,
  transitionDurationMs,
} from "../../show/transition-renderer.js";
import type { ShowSlide } from "../../show/show-model.js";

/** What one run of frames draws. */
export type Segment =
  | { kind: "hold"; pageId: string; frames: number }
  | {
      kind: "transition";
      from: string;
      to: string;
      /** The shader's key and parameters (show/shaders). */
      shader: string;
      params: Record<string, number>;
      frames: number;
    };

export interface TimelineOptions {
  fps: number;
  /** Seconds on a slide without a recorded time. */
  defaultSeconds: number;
  /** Use each slide's "advance after" time when it has one. */
  useTimings: boolean;
}

export interface Timeline {
  segments: Segment[];
  frames: number;
  /** frames / fps, ms. */
  durationMs: number;
  /** The slides it shows, in order. */
  pages: string[];
}

const frames = (ms: number, fps: number) =>
  Math.max(0, Math.round((ms * fps) / 1000));

/** The video of `slides` (hidden ones left out). */
export function timeline(
  slides: readonly ShowSlide[],
  opts: TimelineOptions,
): Timeline {
  const shown = slides.filter((s) => !s.hidden);
  const segments: Segment[] = [];
  let prev: ShowSlide | null = null;
  for (const s of shown) {
    if (prev && s.transition) {
      const r = resolveShowTransition(s.transition);
      const n = r ? frames(transitionDurationMs(s.transition), opts.fps) : 0;
      if (r && n > 0)
        segments.push({
          kind: "transition",
          from: prev.pageId,
          to: s.pageId,
          shader: r.kind,
          params: r.params,
          frames: n,
        });
    }
    const ms =
      opts.useTimings && s.advanceAfterMs !== null && s.advanceAfterMs > 0
        ? s.advanceAfterMs
        : opts.defaultSeconds * 1000;
    segments.push({
      kind: "hold",
      pageId: s.pageId,
      frames: Math.max(1, frames(ms, opts.fps)),
    });
    prev = s;
  }
  const total = segments.reduce((a, g) => a + g.frames, 0);
  return {
    segments,
    frames: total,
    durationMs: (total * 1000) / opts.fps,
    pages: shown.map((s) => s.pageId),
  };
}

/** The video's frame size for a resolution name and the slide's aspect: the
 *  height PowerPoint names (720, 1080, 2160), the width that keeps the
 *  slide's shape, both even (the encoders want 4:2:0 blocks). */
export function videoSize(
  height: 720 | 1080 | 2160,
  slidePt: readonly [number, number],
): { width: number; height: number } {
  const aspect =
    slidePt[0] > 0 && slidePt[1] > 0 ? slidePt[0] / slidePt[1] : 16 / 9;
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  return { width: even(height * aspect), height };
}
