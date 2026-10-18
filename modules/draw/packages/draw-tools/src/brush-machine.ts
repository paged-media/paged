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

// The Brush tools' state machine (brush tools v0) — host-agnostic, a
// thin composition over PencilMachine: the same down/move/up sampling,
// minSampleDistance decimation, RDP simplify + Catmull-Rom smoothing
// and per-sample pressure lane, but the commit product is a CENTERLINE
// + PER-ANCHOR WIDTHS: each kept anchor's calligraphic width from the
// stroke's local tangent angle against a fixed nib
// (draw-geometry's `calligraphicWidth`), pressure-scaled. The bundle
// sweeps the centerline through the engine's `outlineStrokeVariable`
// op — this machine never touches a host.

import {
  anchorTangentAngle,
  calligraphicWidth,
  type AnchorTriple,
  type NibProfile,
  type Vec2,
} from "@paged-media/draw-geometry";

import {
  PencilMachine,
  type PencilEvent,
  type PencilOptions,
} from "./pencil-machine";

/** Brush events are the pencil's (down/move/up carry pressure). */
export type BrushEvent = PencilEvent;

export interface BrushOptions extends PencilOptions {
  /** The fixed calligraphic nib the widths are computed against. */
  nib: NibProfile;
  /** Scale each width stop by its sample's pressure (default true).
   *  `false` is the UNIFORM lane (the eraser): every stop is the
   *  pressure-neutral model width — a round nib then yields a constant
   *  `nib.size`. */
  pressure?: boolean;
}

export interface BrushCommit {
  /** The smoothed centerline (identical to a pencil commit). */
  anchors: AnchorTriple[];
  open: boolean;
  /** Per-anchor clamped pressures, 1:1 with `anchors` (the pencil's
   *  B-08 lane). */
  pressures: number[];
  /** Per-anchor calligraphic width stops in pt, 1:1 with `anchors` —
   *  the `outlineStrokeVariable.widths` payload. */
  widths: number[];
}

export interface BrushSnapshot {
  /** The raw (decimated) samples so far — the live polyline preview. */
  points: readonly Vec2[];
  /** Non-null exactly once, on the pointer-up that completes a stroke. */
  commit: BrushCommit | null;
  /** False once committed or cancelled. */
  active: boolean;
}

export class BrushMachine {
  private readonly inner: PencilMachine;

  constructor(private readonly options: BrushOptions) {
    this.inner = new PencilMachine(options);
  }

  handle(event: BrushEvent): BrushSnapshot {
    const snap = this.inner.handle(event);
    if (!snap.commit) {
      return { points: snap.points, commit: null, active: snap.active };
    }
    const { anchors, open, pressures } = snap.commit;
    const usePressure = this.options.pressure !== false;
    const closed = !open;
    const widths = anchors.map((_, i) =>
      calligraphicWidth(
        anchorTangentAngle(anchors, i, closed),
        this.options.nib,
        usePressure ? pressures[i] : undefined,
      ),
    );
    return {
      points: snap.points,
      commit: { anchors, open, pressures, widths },
      active: snap.active,
    };
  }
}
