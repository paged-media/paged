// The Pencil (freehand) tool's state machine — host-agnostic: raw
// pointer samples in (page-local pt), an RDP-simplified anchor run out.
//
//   down          → start the stroke (first sample)
//   move (down)   → append a sample when it travelled ≥ minSampleDistance
//                   from the last (decimates jittery pointer streams)
//   up            → COMMIT: simplify the samples with draw-geometry's
//                   Ramer-Douglas-Peucker at `tolerance`, then either
//                   fit smooth handles through the survivors (default —
//                   the freehand look) or emit corner anchors
//                   (`smooth: false`). Ending within `closeTolerance`
//                   of the start commits a CLOSED contour.
//   Escape        → cancel the in-flight stroke
//
// A degenerate stroke (fewer than 2 simplified anchors) cancels rather
// than committing an unstrokeable path.

import {
  clone,
  dist,
  simplifyRdp,
  smoothAnchorsThrough,
  type AnchorTriple,
  type Vec2,
} from "@paged-media/draw-geometry";

export type PencilEvent =
  | { type: "down"; point: Vec2 }
  | { type: "move"; point: Vec2 }
  | { type: "up"; point: Vec2 }
  | { type: "key"; key: "Escape" };

export interface PencilCommit {
  anchors: AnchorTriple[];
  open: boolean;
}

export interface PencilSnapshot {
  /** The raw (decimated) samples so far — the host's live polyline
   *  preview. */
  points: readonly Vec2[];
  /** Non-null exactly once, on the pointer-up that completes a stroke. */
  commit: PencilCommit | null;
  /** False once committed or cancelled — the shim resets then. */
  active: boolean;
}

export interface PencilOptions {
  /** RDP simplification tolerance in page-local pt (the host converts a
   *  screen-px fidelity setting at the current zoom). */
  tolerance: number;
  /** Decimation floor: a move closer than this (pt) to the last sample
   *  is dropped. Default 0.5. */
  minSampleDistance?: number;
  /** Fit smooth Catmull-Rom handles through the simplified anchors
   *  (default true). `false` emits corner anchors — the polyline look. */
  smooth?: boolean;
  /** Lifting the pen within this radius (pt) of the stroke's first
   *  sample closes the contour. Default 0 (never close). */
  closeTolerance?: number;
}

const DEFAULT_MIN_SAMPLE_DISTANCE = 0.5;

export class PencilMachine {
  private samples: Vec2[] = [];
  private drawing = false;
  private done = false;

  constructor(private readonly options: PencilOptions) {}

  handle(event: PencilEvent): PencilSnapshot {
    if (this.done) return this.snapshot(null);
    switch (event.type) {
      case "down":
        this.drawing = true;
        this.samples = [clone(event.point)];
        return this.snapshot(null);
      case "move": {
        if (!this.drawing) return this.snapshot(null);
        const last = this.samples[this.samples.length - 1];
        const floor =
          this.options.minSampleDistance ?? DEFAULT_MIN_SAMPLE_DISTANCE;
        if (dist(event.point, last) >= floor) {
          this.samples.push(clone(event.point));
        }
        return this.snapshot(null);
      }
      case "up":
        return this.onUp(event.point);
      case "key":
        // Escape — cancel the in-flight stroke.
        this.done = true;
        this.samples = [];
        return this.snapshot(null);
    }
  }

  private onUp(point: Vec2): PencilSnapshot {
    if (!this.drawing) return this.snapshot(null);
    this.drawing = false;
    this.done = true;
    const last = this.samples[this.samples.length - 1];
    if (dist(point, last) > 0) this.samples.push(clone(point));
    // Close when the pen lifted near the start (and the stroke is long
    // enough that dropping the coincident tail still leaves a contour).
    const closeTol = this.options.closeTolerance ?? 0;
    let closed = false;
    let run = this.samples;
    if (
      closeTol > 0 &&
      run.length >= 4 &&
      dist(run[run.length - 1], run[0]) <= closeTol
    ) {
      closed = true;
      run = run.slice(0, -1); // the wraparound edge supplies the return
    }
    const simplified = simplifyRdp(run, this.options.tolerance);
    if (simplified.length < 2 || (closed && simplified.length < 3)) {
      // A click / negligible stroke — cancel, never commit a degenerate
      // path the engine would reject.
      this.samples = [];
      return this.snapshot(null);
    }
    const anchors: AnchorTriple[] =
      this.options.smooth === false
        ? simplified.map((p) => ({
            anchor: [p[0], p[1]] as [number, number],
            left: [p[0], p[1]] as [number, number],
            right: [p[0], p[1]] as [number, number],
          }))
        : smoothAnchorsThrough(simplified, undefined, closed);
    return this.snapshot({ anchors, open: !closed });
  }

  private snapshot(commit: PencilCommit | null): PencilSnapshot {
    return {
      points: this.samples,
      commit,
      active: !this.done,
    };
  }
}
