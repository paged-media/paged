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

// THE LIQUIFY TOOLS' gesture machine — Warp, Twirl, Pucker, Bloat,
// Scallop, Crystallize and Wrinkle share it; the kind is an option.
//
//   down   → the first step at the press (Illustrator distorts on the
//            press, not only once the pointer moves)
//   move   → one step per sample (Warp steps by the motion since the
//            last sample; the others step where the brush now is)
//   tick   → one DWELL step while the button is held and the pointer
//            rests (the host's timer): Twirl keeps turning, Pucker keeps
//            pulling. Warp has no motion to apply and ignores it
//   up     → COMMIT: every target the drag changed, re-fitted
//            (draw-geometry `liquifyRefit` at the Simplify tolerance) —
//            the host writes them as ONE batch, so one drag is one undo
//            step. A drag that changed nothing commits nothing
//   Escape → cancel; nothing is written
//
// Page space throughout: the host maps each target's anchors to the page
// before handing them in and back through the inverse transform after
// (an affine map is exact on Béziers). The snapshot carries the DENSE
// preview (no refit per sample — the fit runs once, on release) and the
// brush, so the overlay can draw both.

import {
  liquifyChanged,
  liquifyRefit,
  liquifyStart,
  liquifyStep,
  simplifyTolerance,
  type AnchorTable,
  type LiquifyBrush,
  type LiquifyKind,
  type LiquifyParams,
  type LiquifyState,
  type Vec2,
} from "@paged-media/draw-geometry";

export type LiquifyEvent =
  | { type: "down"; point: Vec2; pressure?: number; pen?: boolean }
  | { type: "move"; point: Vec2; pressure?: number; pen?: boolean }
  | { type: "tick" }
  | { type: "up"; point: Vec2 }
  | { type: "key"; key: "Escape" };

/** Illustrator's Liquify tool options (the global brush and the
 *  tool-specific ones). */
export interface LiquifyToolOptions {
  kind: LiquifyKind;
  /** pt */
  width: number;
  height: number;
  /** degrees */
  angle: number;
  /** 0..100 % */
  intensity: number;
  /** Use the pen's pressure in place of the intensity. */
  usePressure: boolean;
  /** 1..10 */
  detail: number;
  /** 0.2..100 */
  simplify: number;
  /** Twirl: −180..180 degrees per step. */
  twirlRate: number;
  /** Scallop / Crystallize / Wrinkle: 0..15 */
  complexity: number;
  /** Wrinkle: 0..100 % */
  horizontal: number;
  vertical: number;
  /** Scallop / Crystallize / Wrinkle */
  affectAnchors: boolean;
  affectIn: boolean;
  affectOut: boolean;
  /** The detail kernels' seed. */
  seed?: number;
}

/** Illustrator's dialog defaults (Width / Height 100 px, Intensity 50 %,
 *  Detail 2, Simplify 50, Twirl Rate 40°, Complexity 1, Wrinkle 0 % / 100
 *  %). Which control points the detail kernels move is the one default
 *  that differs per kernel in Illustrator; these are "all three". */
export const LIQUIFY_DEFAULTS: Omit<LiquifyToolOptions, "kind"> = {
  width: 100,
  height: 100,
  angle: 0,
  intensity: 50,
  usePressure: false,
  detail: 2,
  simplify: 50,
  twirlRate: 40,
  complexity: 1,
  horizontal: 0,
  vertical: 100,
  affectAnchors: true,
  affectIn: true,
  affectOut: true,
};

export interface LiquifyOptions {
  options: LiquifyToolOptions;
  /** The tables the brush may distort, page space. */
  targets: readonly AnchorTable[];
}

export interface LiquifySnapshot {
  /** The dense preview of every target (page space), or null before the
   *  press / after the end. */
  tables: AnchorTable[] | null;
  /** The brush where it is now (for the overlay ellipse). */
  brush: LiquifyBrush | null;
  /** Non-null once, on the release that ends a changing drag: the
   *  re-fitted tables, by target index (only the changed ones). */
  commit: { index: number; table: AnchorTable }[] | null;
  active: boolean;
}

export class LiquifyMachine {
  private states: LiquifyState[] | null = null;
  private last: Vec2 | null = null;
  private brush: LiquifyBrush | null = null;
  private done = false;

  constructor(private readonly opts: LiquifyOptions) {}

  private brushAt(point: Vec2, pressure?: number, pen?: boolean): LiquifyBrush {
    const o = this.opts.options;
    const strength =
      o.usePressure && pen && typeof pressure === "number"
        ? Math.max(0, Math.min(1, pressure))
        : Math.max(0, Math.min(100, o.intensity)) / 100;
    return {
      center: [point[0], point[1]],
      width: Math.max(1, o.width),
      height: Math.max(1, o.height),
      angleDeg: o.angle,
      strength,
    };
  }

  private params(delta: Vec2 | null): LiquifyParams {
    const o = this.opts.options;
    return {
      kind: o.kind,
      ...(delta ? { delta } : {}),
      twirlRate: o.twirlRate,
      complexity: o.complexity,
      horizontal: o.horizontal,
      vertical: o.vertical,
      affectAnchors: o.affectAnchors,
      affectIn: o.affectIn,
      affectOut: o.affectOut,
      seed: o.seed ?? 0,
    };
  }

  private step(delta: Vec2 | null): void {
    if (!this.states || !this.brush) return;
    const kind = this.opts.options.kind;
    if (kind === "warp" && (!delta || (delta[0] === 0 && delta[1] === 0)))
      return;
    const p = this.params(delta);
    this.states = this.states.map((s) =>
      liquifyStep(s, this.brush!, p, this.opts.options.detail),
    );
  }

  handle(event: LiquifyEvent): LiquifySnapshot {
    if (this.done) return this.snapshot(null);
    switch (event.type) {
      case "down":
        this.states = this.opts.targets.map(liquifyStart);
        this.brush = this.brushAt(event.point, event.pressure, event.pen);
        this.last = [event.point[0], event.point[1]];
        this.step(null);
        return this.snapshot(null);
      case "move": {
        if (!this.states || !this.last) {
          // Hovering: the brush outline follows the pointer.
          this.brush = this.brushAt(event.point, event.pressure, event.pen);
          return this.snapshot(null);
        }
        const delta: Vec2 = [
          event.point[0] - this.last[0],
          event.point[1] - this.last[1],
        ];
        if (this.opts.options.kind === "warp") {
          // The warp brush is centred where the motion STARTS, so the
          // points under it are carried along with the pointer.
          this.step(delta);
          this.brush = this.brushAt(event.point, event.pressure, event.pen);
        } else {
          this.brush = this.brushAt(event.point, event.pressure, event.pen);
          this.step(null);
        }
        this.last = [event.point[0], event.point[1]];
        return this.snapshot(null);
      }
      case "tick":
        if (this.states && this.opts.options.kind !== "warp") this.step(null);
        return this.snapshot(null);
      case "up": {
        if (!this.states) {
          this.done = true;
          return this.snapshot(null);
        }
        const tol = simplifyTolerance(this.opts.options.simplify);
        const commit = this.states
          .map((s, index) => ({ s, index }))
          .filter(({ s }) => liquifyChanged(s))
          .map(({ s, index }) => ({ index, table: liquifyRefit(s, tol) }));
        this.done = true;
        return this.snapshot(commit.length > 0 ? commit : null);
      }
      case "key":
        this.done = true;
        this.states = null;
        return this.snapshot(null);
    }
  }

  private snapshot(
    commit: { index: number; table: AnchorTable }[] | null,
  ): LiquifySnapshot {
    return {
      tables: this.states ? this.states.map((s) => s.table) : null,
      brush: this.brush,
      commit,
      active: !this.done,
    };
  }
}
