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

// One slide's animations while it is up (slide ADR 714): the clicks and
// shape clicks so far, timed from when the slide came up, and the player
// (slide-anim, through the engine) that turns them into each layer's
// state at a moment. The show's state machine counts the build steps
// (show-model.ts); this keeps their times, so a click during an effect
// seeks it to its end (PowerPoint's `nextAc="seek"`) and a step back shows
// the steps before it complete.

import type { PlayerEvent, PlayerFrame } from "../anim/model.js";
import type { AnimPlayer } from "../engine.js";
import { drawState, type DrawState } from "./scene.js";
import type { SlideScene } from "./scene-source.js";

/** Long ago: an event at this time has finished whatever it started. */
export const LONG_AGO = -1e9;

/** What the player answers, as the evaluation the runtime needs (a test
 *  passes a fake). */
export interface Player {
  clicks(): number;
  evaluate(events: readonly PlayerEvent[], nowMs: number): PlayerFrame;
  free(): void;
}

export class SlideAnimation {
  private events: PlayerEvent[] = [];
  private startedAt: number;

  constructor(
    private readonly player: Player | AnimPlayer,
    readonly scene: SlideScene,
    private readonly now: () => number,
    step = 0,
  ) {
    this.startedAt = now();
    this.seek(step);
  }

  /** Clicks the slide's main sequence takes. */
  clicks(): number {
    return this.player.clicks();
  }

  /** The build step the slide is at. */
  step(): number {
    return this.events.filter((e) => e.kind === "next").length;
  }

  /** Time since the slide came up, ms. */
  elapsed(): number {
    return this.now() - this.startedAt;
  }

  /** A main-sequence click now (the next build step). */
  next(): void {
    this.events.push({ kind: "next", at: this.elapsed() });
  }

  /** A click on a shape now (its triggers play). */
  click(target: string): void {
    this.events.push({ kind: "click", at: this.elapsed(), target });
  }

  /** Show `step` with every step up to it complete (a step back, a jump,
   *  the audience joining mid-slide). Shape clicks are kept. */
  seek(step: number): void {
    const clicks = this.events.filter((e) => e.kind === "click");
    this.events = [
      ...Array.from({ length: Math.max(0, step) }, () => ({
        kind: "next" as const,
        at: LONG_AGO,
      })),
      ...clicks.map((c) => ({ ...c, at: LONG_AGO })),
    ];
  }

  /** The player's answer for now. */
  frame(): PlayerFrame {
    return this.player.evaluate(this.events, this.elapsed());
  }

  /** Each scene layer's draw state now, and whether anything moves. */
  draws(): { states: DrawState[]; running: boolean } {
    const f = this.frame();
    const states = this.scene.layers.map((l) =>
      drawState(
        f.layers,
        l.target,
        l.part,
        this.scene.boxes,
        {
          x: l.region.x,
          y: l.region.y,
          w: l.region.width,
          h: l.region.height,
        },
      ),
    );
    return { states, running: f.running };
  }

  dispose(): void {
    this.player.free();
  }
}
