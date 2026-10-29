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

// THE SYMBOLISM TOOLS' gesture machine (WP6.8, draw ADR 365) — the Symbol
// Sprayer and the six modifiers (Shifter, Scruncher, Sizer, Spinner,
// Stainer, Screener) share it; the kind is an option.
//
//   down   → the first step at the press (the Sprayer sprays once; Alt
//            with the Sprayer marks the instances under the brush for
//            removal instead)
//   move   → one step per sample (the Shifter and Spinner step by the
//            motion since the last sample; the Sprayer sprays along it)
//   tick   → one DWELL step while the button is held and the pointer
//            rests (the host's timer): the Sizer keeps growing, the
//            Sprayer keeps spraying. The Shifter and Spinner have no
//            motion to apply and ignore it
//   up     → the release point is the drag's last sample (a step there);
//            then COMMIT: what the drag changed — the modified instances'
//            matrix / tint / opacity, the sprayed placements, the removed
//            instances — which the host writes as ONE batch: one drag is
//            one undo step. A drag that changed nothing commits nothing
//   Escape → cancel; nothing is written
//
// Page space throughout (the host maps each instance's matrix to the page
// before handing it in and back to spread space when it writes).

import {
  sprayMove,
  sprayStart,
  sprayTick,
  symbolismCentre,
  symbolismQuad,
  symbolismStep,
  symbolismWeight,
  type SprayOptions,
  type SprayPlacement,
  type SprayState,
  type SymbolismItem,
  type SymbolismKind,
  type Vec2,
} from "@paged-media/draw-geometry";

export type SymbolismToolKind = "sprayer" | SymbolismKind;

export type SymbolismEvent =
  | { type: "down"; point: Vec2; alt?: boolean }
  | { type: "move"; point: Vec2; alt?: boolean }
  | { type: "tick" }
  | { type: "up"; point: Vec2 }
  | { type: "key"; key: "Escape" };

/** Illustrator's Symbolism Tools Options, as far as they apply here. */
export interface SymbolismToolOptions {
  kind: SymbolismToolKind;
  /** pt */
  diameter: number;
  /** 1..10 */
  intensity: number;
  /** Sprayer: 1..10 instances per brush diameter of travel. */
  density: number;
  /** Sprayer: 0..100 %. */
  sizeScatter: number;
  /** Sprayer: 0..180°. */
  rotationScatter: number;
  /** Sprayer: turn each instance to the drag direction. */
  followDrag: boolean;
  /** Stainer: sRGB 0..1. */
  color: readonly [number, number, number];
  /** The Sprayer's seed. */
  seed?: number;
}

/** Illustrator's defaults where it has them (Diameter 200 px ≈ 100 pt
 *  here, Intensity 8, Density 5); the scatter ranges start at none. */
export const SYMBOLISM_DEFAULTS: Omit<SymbolismToolOptions, "kind"> = {
  diameter: 100,
  intensity: 8,
  density: 5,
  sizeScatter: 0,
  rotationScatter: 0,
  followDrag: false,
  color: [1, 0, 0],
};

/** One instance the machine may act on. */
export interface SymbolismTarget {
  id: string;
  item: SymbolismItem;
}

export interface SymbolismOptions {
  options: SymbolismToolOptions;
  /** The instances on the page (the selection's, or all of them). */
  targets: readonly SymbolismTarget[];
  /** Sprayer: the box of the symbol it sprays, definition space. */
  sprayBox?: readonly [number, number, number, number];
}

/** One modified instance: only the fields the drag changed. */
export interface SymbolismUpdate {
  id: string;
  matrix?: readonly [number, number, number, number, number, number];
  tint?: readonly [number, number, number, number] | null;
  opacity?: number;
}

export interface SymbolismCommit {
  updates: SymbolismUpdate[];
  placements: SprayPlacement[];
  removals: string[];
}

export interface SymbolismSnapshot {
  active: boolean;
  brush: { center: Vec2; diameter: number } | null;
  /** The boxes to draw: every changed or new instance's, page space. */
  quads: Vec2[][];
  /** The instances marked for removal (the Sprayer's Alt), page space. */
  removing: Vec2[][];
  commit: SymbolismCommit | null;
}

const IDLE: SymbolismSnapshot = {
  active: false,
  brush: null,
  quads: [],
  removing: [],
  commit: null,
};

export class SymbolismMachine {
  private readonly o: SymbolismToolOptions;
  private readonly start: readonly SymbolismTarget[];
  private items: SymbolismItem[];
  private readonly sprayBox: readonly [number, number, number, number];
  private spray: SprayState | null = null;
  private removing = new Set<number>();
  private alt = false;
  private last: Vec2 | null = null;
  private active = false;

  constructor(init: SymbolismOptions) {
    this.o = init.options;
    this.start = init.targets;
    this.items = init.targets.map((t) => t.item);
    this.sprayBox = init.sprayBox ?? [-0.5, -0.5, 0.5, 0.5];
  }

  get kind(): SymbolismToolKind {
    return this.o.kind;
  }

  handle(e: SymbolismEvent): SymbolismSnapshot {
    switch (e.type) {
      case "down":
        this.active = true;
        this.alt = !!e.alt;
        this.last = e.point;
        if (this.o.kind === "sprayer") {
          if (this.alt) this.markRemovals(e.point);
          else this.spray = sprayMove(sprayStart(this.sprayOptions()), e.point);
        } else this.step(e.point, [0, 0]);
        return this.snapshot(e.point);
      case "move": {
        if (!this.active || !this.last) return IDLE;
        const delta: Vec2 = [
          e.point[0] - this.last[0],
          e.point[1] - this.last[1],
        ];
        this.last = e.point;
        if (this.o.kind === "sprayer") {
          if (this.alt) this.markRemovals(e.point);
          else if (this.spray) this.spray = sprayMove(this.spray, e.point);
        } else this.step(e.point, delta);
        return this.snapshot(e.point);
      }
      case "tick":
        if (!this.active || !this.last) return IDLE;
        if (this.o.kind === "sprayer") {
          if (!this.alt && this.spray) this.spray = sprayTick(this.spray);
        } else if (this.o.kind !== "shifter" && this.o.kind !== "spinner") {
          this.step(this.last, [0, 0]);
        }
        return this.snapshot(this.last);
      case "up": {
        if (!this.active) return IDLE;
        // The release point is the drag's last sample.
        if (
          this.last &&
          (e.point[0] !== this.last[0] || e.point[1] !== this.last[1])
        )
          this.handle({ type: "move", point: e.point, alt: this.alt });
        this.active = false;
        const commit = this.commit();
        return { ...IDLE, commit };
      }
      case "key":
        this.active = false;
        this.items = this.start.map((t) => t.item);
        this.spray = null;
        this.removing.clear();
        return IDLE;
    }
  }

  private sprayOptions(): SprayOptions {
    return {
      diameter: this.o.diameter,
      intensity: this.o.intensity,
      density: this.o.density,
      sizeScatter: this.o.sizeScatter,
      rotationScatter: this.o.rotationScatter,
      followDrag: this.o.followDrag,
      seed: this.o.seed ?? 0x5eed,
    };
  }

  private markRemovals(at: Vec2): void {
    this.items.forEach((item, i) => {
      const c = symbolismCentre(item);
      if (
        symbolismWeight(
          Math.hypot(c[0] - at[0], c[1] - at[1]),
          this.o.diameter,
        ) > 0
      )
        this.removing.add(i);
    });
  }

  private step(at: Vec2, delta: Vec2): void {
    if (this.o.kind === "sprayer") return;
    this.items = symbolismStep(this.items, {
      kind: this.o.kind,
      brush: {
        center: at,
        diameter: this.o.diameter,
        intensity: this.o.intensity,
      },
      delta,
      invert: this.alt,
      color: this.o.color,
    });
  }

  private snapshot(at: Vec2): SymbolismSnapshot {
    const quads: Vec2[][] = [];
    this.items.forEach((item, i) => {
      if (item !== this.start[i]!.item) quads.push(symbolismQuad(item));
    });
    for (const p of this.spray?.placed ?? [])
      quads.push(
        symbolismQuad({
          matrix: p.matrix,
          box: this.sprayBox,
          tint: null,
          opacity: 100,
        }),
      );
    const removing = [...this.removing].map((i) =>
      symbolismQuad(this.items[i]!),
    );
    return {
      active: true,
      brush: { center: at, diameter: this.o.diameter },
      quads,
      removing,
      commit: null,
    };
  }

  private commit(): SymbolismCommit | null {
    const updates: SymbolismUpdate[] = [];
    this.items.forEach((item, i) => {
      const before = this.start[i]!.item;
      if (item === before || this.removing.has(i)) return;
      const u: SymbolismUpdate = { id: this.start[i]!.id };
      if (item.matrix.some((v, k) => Math.abs(v - before.matrix[k]!) > 1e-9))
        u.matrix = item.matrix;
      if (JSON.stringify(item.tint) !== JSON.stringify(before.tint))
        u.tint = item.tint;
      if (item.opacity !== before.opacity) u.opacity = item.opacity;
      if (u.matrix || u.tint !== undefined || u.opacity !== undefined)
        updates.push(u);
    });
    const placements = this.spray ? [...this.spray.placed] : [];
    const removals = [...this.removing].map((i) => this.start[i]!.id);
    this.spray = null;
    this.removing.clear();
    if (
      updates.length === 0 &&
      placements.length === 0 &&
      removals.length === 0
    )
      return null;
    return { updates, placements, removals };
  }
}
