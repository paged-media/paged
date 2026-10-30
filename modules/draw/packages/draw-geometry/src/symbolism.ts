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

// THE SYMBOLISM TOOLS' kernels (WP6.8, draw ADR 365) — Illustrator's
// Symbol Sprayer, Shifter, Scruncher, Sizer, Spinner, Stainer and Screener,
// as pure functions over symbol INSTANCES (engine ADR 1039): an instance
// is a matrix from definition space to the page plus its definition's
// box, and the tools change only what the engine lets an instance carry —
// the matrix, a colour tint and an opacity. Page pt throughout.
//
// One brush: a disc of `diameter`, and a weight that falls from 1 at the
// centre to 0 at the rim, `1 − (d / r)²` — Illustrator's symbolism brush
// fades towards its rim too (its exact curve is not published and not
// scriptable; this one is a convention). `intensity` is Illustrator's
// 1–10 rate: one step moves an instance at the centre by `intensity / 10`
// of the tool's full rate.
//
// Each modifier is one STEP per pointer sample (and per dwell tick while
// the button is held, for the tools that act in place); the gesture
// commits the instances' end state, so one drag is one undo step however
// many steps it took.
//
// The SPRAYER places new instances along the drag: one every
// `diameter / density` pt of travel, scattered within the brush, its size
// and angle scattered within the options' ranges, from a SEEDED generator
// so a recorded drag replays exactly.

import { applyAffine, composeAffine, type Affine } from "./affine";
import { lcg } from "./star";
import type { Vec2 } from "./types";

/** The modifiers (the Sprayer is separate: it creates). */
export type SymbolismKind =
  "shifter" | "scruncher" | "sizer" | "spinner" | "stainer" | "screener";

/** One instance as the kernels see it. */
export interface SymbolismItem {
  /** Definition space → page pt. */
  readonly matrix: Affine;
  /** The definition's box `[x0, y0, x1, y1]` in definition space. */
  readonly box: readonly [number, number, number, number];
  /** `[r, g, b, amount]`, each 0..1; null = untinted. */
  readonly tint: readonly [number, number, number, number] | null;
  /** 0..100 %. */
  readonly opacity: number;
}

/** The brush of one step. */
export interface SymbolismBrush {
  readonly center: Vec2;
  readonly diameter: number;
  /** 1..10. */
  readonly intensity: number;
}

/** One step of a modifier. */
export interface SymbolismStep {
  readonly kind: SymbolismKind;
  readonly brush: SymbolismBrush;
  /** The pointer's motion since the last sample (Shifter, Spinner). */
  readonly delta?: Vec2;
  /** Alt: the inverse (Scruncher pushes, Sizer shrinks, Stainer and
   *  Screener undo their effect). */
  readonly invert?: boolean;
  /** Stainer: the colour, sRGB 0..1. */
  readonly color?: readonly [number, number, number];
}

/** The full rates: what one step does at the brush's centre at intensity
 *  10. Conventions, chosen so a short drag is a visible but controllable
 *  change (Illustrator's are not published). */
export const SYMBOLISM_RATES = {
  /** Scruncher: the fraction of the way to the centre. */
  scrunch: 0.1,
  /** Sizer: the scale factor's step (1.05 = 5 % per step). */
  size: 0.05,
  /** Spinner: the fraction of the turn towards the drag direction. */
  spin: 0.5,
  /** Stainer: the tint amount per step. */
  stain: 0.1,
  /** Screener: opacity points per step. */
  screen: 10,
} as const;

/** The smallest scale the Sizer leaves (a typo is not data either). */
export const SYMBOLISM_MIN_SCALE = 0.01;

/** The registration point of an instance on the page (its box's centre
 *  mapped by its matrix). */
export function symbolismCentre(item: SymbolismItem): Vec2 {
  const [x0, y0, x1, y1] = item.box;
  const [x, y] = applyAffine(item.matrix, (x0 + x1) / 2, (y0 + y1) / 2);
  return [x, y];
}

/** The instance's box on the page: four corners, in order. */
export function symbolismQuad(item: SymbolismItem): Vec2[] {
  const [x0, y0, x1, y1] = item.box;
  return (
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ] as const
  ).map(([x, y]) => {
    const [px, py] = applyAffine(item.matrix, x, y);
    return [px, py] as Vec2;
  });
}

/** The brush's weight at distance `d` from its centre: 1 there, 0 at and
 *  past the rim. */
export function symbolismWeight(d: number, diameter: number): number {
  const r = diameter / 2;
  if (!(r > 0) || !(d < r)) return 0;
  const t = d / r;
  return 1 - t * t;
}

const about = (m: Affine, p: Vec2, inner: Affine): Affine => {
  const [cx, cy] = p;
  return composeAffine(
    [1, 0, 0, 1, cx, cy],
    composeAffine(inner, composeAffine([1, 0, 0, 1, -cx, -cy], m)),
  );
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The instance's angle on the page (its x axis), radians. */
export function symbolismAngle(m: Affine): number {
  return Math.atan2(m[1], m[0]);
}

/** One step of `step.kind` on `items`. An instance the brush does not
 *  reach is returned AS IS (the same object), so a caller can tell what
 *  changed by identity. */
export function symbolismStep(
  items: readonly SymbolismItem[],
  step: SymbolismStep,
): SymbolismItem[] {
  const { brush } = step;
  const rate = Math.min(10, Math.max(1, brush.intensity)) / 10;
  const sign = step.invert ? -1 : 1;
  return items.map((item) => {
    const c = symbolismCentre(item);
    const w = symbolismWeight(
      Math.hypot(c[0] - brush.center[0], c[1] - brush.center[1]),
      brush.diameter,
    );
    if (w <= 0) return item;
    const k = w * rate;
    switch (step.kind) {
      case "shifter": {
        const [dx, dy] = step.delta ?? [0, 0];
        if (dx === 0 && dy === 0) return item;
        const m = item.matrix;
        return {
          ...item,
          matrix: [m[0], m[1], m[2], m[3], m[4] + dx * k, m[5] + dy * k],
        };
      }
      case "scruncher": {
        const f = SYMBOLISM_RATES.scrunch * k * sign;
        const dx = (brush.center[0] - c[0]) * f;
        const dy = (brush.center[1] - c[1]) * f;
        const m = item.matrix;
        return {
          ...item,
          matrix: [m[0], m[1], m[2], m[3], m[4] + dx, m[5] + dy],
        };
      }
      case "sizer": {
        const grow = 1 + SYMBOLISM_RATES.size * k;
        let s = step.invert ? 1 / grow : grow;
        const current = Math.hypot(item.matrix[0], item.matrix[1]);
        if (current * s < SYMBOLISM_MIN_SCALE)
          s = SYMBOLISM_MIN_SCALE / current;
        if (s === 1) return item;
        return { ...item, matrix: about(item.matrix, c, [s, 0, 0, s, 0, 0]) };
      }
      case "spinner": {
        const [dx, dy] = step.delta ?? [0, 0];
        if (Math.hypot(dx, dy) < 1e-9) return item;
        const target = Math.atan2(dy, dx);
        let turn = target - symbolismAngle(item.matrix);
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        const r = turn * SYMBOLISM_RATES.spin * k;
        if (Math.abs(r) < 1e-12) return item;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        return {
          ...item,
          matrix: about(item.matrix, c, [cos, sin, -sin, cos, 0, 0]),
        };
      }
      case "stainer": {
        const before = item.tint;
        if (step.invert) {
          if (!before) return item;
          const amount = clamp01(before[3] - SYMBOLISM_RATES.stain * k);
          return {
            ...item,
            tint:
              amount <= 1e-6 ? null : [before[0], before[1], before[2], amount],
          };
        }
        const [r, g, b] = step.color ?? [1, 0, 0];
        const add = SYMBOLISM_RATES.stain * k;
        if (!before) return { ...item, tint: [r, g, b, clamp01(add)] };
        // The colour moves towards the new one by the share the step adds.
        const amount = clamp01(before[3] + add);
        const f = add / Math.max(amount, 1e-9);
        return {
          ...item,
          tint: [
            before[0] + (r - before[0]) * f,
            before[1] + (g - before[1]) * f,
            before[2] + (b - before[2]) * f,
            amount,
          ],
        };
      }
      case "screener": {
        const next = Math.min(
          100,
          Math.max(0, item.opacity - SYMBOLISM_RATES.screen * k * sign),
        );
        return next === item.opacity ? item : { ...item, opacity: next };
      }
    }
  });
}

// ------------------------------------------------------------- the sprayer

/** The Sprayer's options. */
export interface SprayOptions {
  readonly diameter: number;
  /** 1..10: how many instances go into one spray (dwell ticks too). */
  readonly intensity: number;
  /** 1..10: instances per brush diameter of travel. */
  readonly density: number;
  /** 0..100 %: each instance's size is 1 ± this, uniformly. */
  readonly sizeScatter: number;
  /** 0..180°: each instance's angle is ± this, uniformly. */
  readonly rotationScatter: number;
  /** Turn each instance to the drag direction (before the scatter). */
  readonly followDrag: boolean;
  readonly seed: number;
}

/** One instance the Sprayer places: definition space → page. */
export interface SprayPlacement {
  readonly matrix: Affine;
}

/** The Sprayer's running state over one drag. */
export interface SprayState {
  readonly options: SprayOptions;
  readonly last: Vec2 | null;
  /** Travel since the last spray, pt. */
  readonly carry: number;
  readonly placed: readonly SprayPlacement[];
  /** The generator's state, as a seed for the next draw. */
  readonly rng: number;
}

/** The travel between two sprays, pt. */
export function spraySpacing(o: SprayOptions): number {
  return Math.max(1e-3, o.diameter / Math.max(1, Math.min(10, o.density)));
}

export function sprayStart(options: SprayOptions): SprayState {
  return { options, last: null, carry: 0, placed: [], rng: options.seed >>> 0 };
}

function sprayAt(
  s: SprayState,
  at: Vec2,
  direction: number,
  count: number,
): SprayState {
  const o = s.options;
  let seed = s.rng;
  const next = () => {
    const g = lcg(seed);
    const v = g();
    seed = Math.floor(v * 4294967296) >>> 0;
    return v;
  };
  const placed = [...s.placed];
  const r = o.diameter / 2;
  for (let i = 0; i < count; i++) {
    // A uniform point in the disc.
    const a = next() * Math.PI * 2;
    const d = Math.sqrt(next()) * r;
    const x = at[0] + Math.cos(a) * d;
    const y = at[1] + Math.sin(a) * d;
    const scatter = Math.min(100, Math.max(0, o.sizeScatter)) / 100;
    const scale = Math.max(SYMBOLISM_MIN_SCALE, 1 + (next() * 2 - 1) * scatter);
    const spin = Math.min(180, Math.max(0, o.rotationScatter));
    const angle =
      (o.followDrag ? direction : 0) +
      ((next() * 2 - 1) * spin * Math.PI) / 180;
    const cos = Math.cos(angle) * scale;
    const sin = Math.sin(angle) * scale;
    placed.push({ matrix: [cos, sin, -sin, cos, x, y] });
  }
  return { ...s, placed, rng: seed };
}

/** How many instances one spray places. */
export function sprayCount(o: SprayOptions): number {
  return Math.max(1, Math.round(Math.min(10, Math.max(1, o.intensity)) / 5));
}

/** The pointer at `point`: the first call sprays once where it is; later
 *  calls spray every `spraySpacing` of travel along the segment. */
export function sprayMove(s: SprayState, point: Vec2): SprayState {
  const count = sprayCount(s.options);
  if (!s.last) return { ...sprayAt(s, point, 0, count), last: point, carry: 0 };
  const [x0, y0] = s.last;
  const dx = point[0] - x0;
  const dy = point[1] - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return s;
  const dir = Math.atan2(dy, dx);
  const step = spraySpacing(s.options);
  let state: SprayState = s;
  let travelled = step - s.carry;
  while (travelled <= len) {
    const t = travelled / len;
    state = sprayAt(state, [x0 + dx * t, y0 + dy * t], dir, count);
    travelled += step;
  }
  return { ...state, last: point, carry: len - (travelled - step) };
}

/** A dwell tick (the button held, the pointer resting): one more spray
 *  where the pointer is. */
export function sprayTick(s: SprayState): SprayState {
  if (!s.last) return s;
  return sprayAt(s, s.last, 0, sprayCount(s.options));
}

/** The registration point (definition origin) of a placement. */
export function sprayPoint(p: SprayPlacement): Vec2 {
  return [p.matrix[4], p.matrix[5]];
}
