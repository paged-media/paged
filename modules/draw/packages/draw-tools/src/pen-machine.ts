// The Pen tool's state machine — host-agnostic: page-local pt points
// in, a snapshot (in-progress anchors + rubber band + optional
// commit) out. The editor's gesture handler is a thin shim that
// page-anchors pointer events, feeds them here, flattens the
// snapshot into the tool-preview polyline, and turns the commit into
// one `insertPath` Mutation. Keeping the modifier matrix here makes
// it unit-testable without a browser and portable to a future
// isolate unchanged.
//
// v1 modifier matrix (Illustrator parity, §13.1 of the concept):
//   click            → corner anchor (handles collapsed)
//   drag             → smooth anchor (right handle follows pointer,
//                      left mirrors)
//   Alt during drag  → break the pair: left handle freezes at its
//                      last mirrored position, right keeps following
//   Shift + click    → constrain the new anchor to 45° from the
//                      previous anchor
//   Shift + drag     → constrain the handle pull to 45°
//   click 1st anchor → close the path (commit { open: false })
//   Enter            → commit the open path (≥ 2 anchors)
//   Escape           → cancel

import {
  clone,
  constrainAngle,
  cornerAnchor,
  dist,
  mirrorHandle,
  type AnchorTriple,
  type Vec2,
} from "@paged-media/draw-geometry";

import type { ToolPreviewPath } from "@paged-media/plugin-api";

export interface PenModifiers {
  shift: boolean;
  alt: boolean;
}

/**
 * Optional Pointer-Events sample carried alongside a pen event (B-08).
 * The machine stays geometry-pure — it records the pressure at each
 * anchor but never branches on it; consumers turn the recorded profile
 * into a variable-width stroke via a width hook (`strokeWidthFromPressure`)
 * once the engine can render one (§13.12, Tier B residual). `pressure`
 * is 0..1 with browser semantics (mouse 0/0.5; pen physical).
 */
export interface PenSample {
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
}

export type PenEvent =
  | { type: "down"; point: Vec2; modifiers: PenModifiers; sample?: PenSample }
  | { type: "move"; point: Vec2; modifiers: PenModifiers; sample?: PenSample }
  | { type: "up"; point: Vec2; modifiers: PenModifiers; sample?: PenSample }
  | { type: "key"; key: "Enter" | "Escape" };

export interface PenCommit {
  anchors: AnchorTriple[];
  open: boolean;
}

/** What the host renders/acts on after each event. */
export interface PenSnapshot {
  /** Anchors placed so far (live — includes the one being dragged). */
  anchors: readonly AnchorTriple[];
  /** Per-anchor pressure 0..1, parallel to `anchors` (B-08). The
   *  pressure recorded when each anchor was placed; `0.5` when the
   *  event carried no sample (mouse). The pen-stroke-width hook
   *  (`strokeWidthFromPressure`) turns this profile into a
   *  variable-width stroke — pending engine support (§13.12 Tier B). */
  pressures: readonly number[];
  /** Hover point for the rubber band from the last anchor (null
   *  while the pointer is down or the path is empty/inactive). */
  rubberTo: Vec2 | null;
  /** Hovering within close-tolerance of the first anchor. */
  closePreview: boolean;
  /** Non-null exactly once, when the path completes. */
  commit: PenCommit | null;
  /** False once committed or cancelled — the shim resets then. */
  active: boolean;
}

export interface PenOptions {
  /** Click-on-first-anchor radius, page-local pt (host converts a
   *  screen tolerance at the current zoom). */
  closeTolerance: number;
  /** Pointer travel (pt) below which a down→up is a click, not a
   *  handle drag. */
  dragThreshold?: number;
}

const DEFAULT_DRAG_THRESHOLD = 2;

/** Pressure recorded for a mouse anchor (no physical sample). Matches
 *  the host's mouse-pressure default (Pointer Events: 0.5 while a
 *  button is held). */
const MOUSE_PRESSURE = 0.5;

export class PenMachine {
  private anchors: AnchorTriple[] = [];
  /** Per-anchor pressure, parallel to `anchors` (B-08). */
  private pressures: number[] = [];
  private pointerDown = false;
  private downPoint: Vec2 | null = null;
  private dragging = false;
  private closing = false;
  private brokenLeft = false;
  private hover: Vec2 | null = null;
  private done = false;

  constructor(private readonly options: PenOptions) {}

  handle(event: PenEvent): PenSnapshot {
    if (this.done) return this.snapshot(null);
    switch (event.type) {
      case "down":
        return this.onDown(event.point, event.modifiers, event.sample);
      case "move":
        return this.pointerDown
          ? this.onDragMove(event.point, event.modifiers)
          : this.onHoverMove(event.point);
      case "up":
        return this.onUp();
      case "key":
        return this.onKey(event.key);
    }
  }

  private onDown(
    point: Vec2,
    modifiers: PenModifiers,
    sample?: PenSample,
  ): PenSnapshot {
    this.pointerDown = true;
    this.dragging = false;
    this.brokenLeft = false;
    this.hover = null;
    // Closing click: on the first anchor with a closeable path.
    if (
      this.anchors.length >= 2 &&
      dist(point, this.anchors[0].anchor) <= this.options.closeTolerance
    ) {
      this.closing = true;
      this.downPoint = clone(point);
      return this.snapshot(null);
    }
    const placed =
      modifiers.shift && this.anchors.length > 0
        ? constrainAngle(this.anchors[this.anchors.length - 1].anchor, point)
        : clone(point);
    this.anchors.push(cornerAnchor(placed));
    // B-08 — record the pressure at placement. Pure bookkeeping: it
    // never feeds the geometry, only the optional variable-width hook.
    // A missing sample (mouse / synthetic) records the mouse default.
    this.pressures.push(clampPressure(sample?.pressure ?? MOUSE_PRESSURE));
    this.downPoint = placed;
    return this.snapshot(null);
  }

  private onDragMove(point: Vec2, modifiers: PenModifiers): PenSnapshot {
    if (this.closing || !this.downPoint) return this.snapshot(null);
    const current = this.anchors[this.anchors.length - 1];
    if (!current) return this.snapshot(null);
    const threshold = this.options.dragThreshold ?? DEFAULT_DRAG_THRESHOLD;
    if (!this.dragging && dist(point, this.downPoint) <= threshold) {
      return this.snapshot(null);
    }
    this.dragging = true;
    const pull = modifiers.shift
      ? constrainAngle(current.anchor, point)
      : clone(point);
    current.right = pull;
    if (modifiers.alt) {
      // Break the pair: left freezes at its last mirrored position.
      this.brokenLeft = true;
    } else if (!this.brokenLeft) {
      current.left = mirrorHandle(current.anchor, pull);
    }
    return this.snapshot(null);
  }

  private onHoverMove(point: Vec2): PenSnapshot {
    this.hover = clone(point);
    return this.snapshot(null);
  }

  private onUp(): PenSnapshot {
    this.pointerDown = false;
    this.downPoint = null;
    if (this.closing) {
      this.closing = false;
      this.done = true;
      return this.snapshot({ anchors: this.anchors, open: false });
    }
    return this.snapshot(null);
  }

  private onKey(key: "Enter" | "Escape"): PenSnapshot {
    if (key === "Escape") {
      this.done = true;
      this.anchors = [];
      this.pressures = [];
      return this.snapshot(null);
    }
    // Enter — commit the open path; a degenerate run cancels.
    this.done = true;
    if (this.anchors.length < 2) {
      this.anchors = [];
      this.pressures = [];
      return this.snapshot(null);
    }
    return this.snapshot({ anchors: this.anchors, open: true });
  }

  private snapshot(commit: PenCommit | null): PenSnapshot {
    const closePreview =
      !this.done &&
      !this.pointerDown &&
      this.hover !== null &&
      this.anchors.length >= 2 &&
      dist(this.hover, this.anchors[0].anchor) <= this.options.closeTolerance;
    return {
      anchors: this.anchors,
      pressures: this.pressures,
      rubberTo:
        this.done || this.pointerDown || this.anchors.length === 0
          ? null
          : this.hover,
      closePreview,
      commit,
      active: !this.done,
    };
  }
}

/** Clamp a raw pressure sample into the Pointer-Events 0..1 range
 *  (defensive against a misbehaving device / synthetic value). */
function clampPressure(p: number): number {
  if (!Number.isFinite(p)) return MOUSE_PRESSURE;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/**
 * Pressure-aware stroke-width hook (B-08, §13.12 Tier B). Maps a
 * normalized pressure 0..1 to a stroke width in pt by linear
 * interpolation between `min` and `max`. This is the API SEAM only —
 * it gives a draw tool a width per sample so a future variable-width
 * renderer can build a tapered outline. The actual variable-width
 * STROKE GEOMETRY (offset-curve outline from a width profile) is
 * ENGINE work and remains a residual (see BREAKAGE_LOG B-08).
 *
 * Mouse input (pressure ~0.5) lands mid-range, so a mouse-drawn path
 * gets a sensible constant width without special-casing.
 */
export interface StrokeWidthProfile {
  /** Width at pressure 0, pt. */
  min: number;
  /** Width at pressure 1, pt. */
  max: number;
}

export function strokeWidthFromPressure(
  pressure: number,
  profile: StrokeWidthProfile,
): number {
  const p = clampPressure(pressure);
  return profile.min + (profile.max - profile.min) * p;
}

/**
 * Build the in-progress PEN preview as a cubic `ToolPreviewPath`
 * (B-07) — the host renders true Béziers instead of a flattened
 * polyline. The snapshot's `anchors` ARE the cubic run (anchor + left/
 * right handles); this only frames them for the overlay channel and
 * appends the live rubber-band segment to the hover cursor as a corner
 * anchor (collapsed handles → a straight cubic), exactly mirroring the
 * polyline path's trailing rubber-band but WITHOUT sampling.
 *
 * Returns `null` for a run too short to draw (the host clears its
 * preview). When `closePreview` is set (hovering anchor 0), the run is
 * marked `close` and the rubber-band is omitted — the closing cubic
 * already returns to anchor 0.
 *
 * This is the host-agnostic OUTPUT the editor shim / a future isolated
 * bundle pushes straight through `host.overlay.setToolPreview`; the old
 * `flattenAnchorRun` path stays as the fallback for a host whose
 * `ToolPreviewShape` predates the path variant (capability is the same
 * `overlay.toolPreview@1` door — the variant is structural, detected by
 * the renderer's `"anchors" in shape` discriminant, so no separate
 * feature flag exists; a pre-variant host simply ignores the unknown
 * branch and the shim should keep flattening for it).
 */
export function penPreview(
  snapshot: PenSnapshot,
  pageId: string,
  options?: { dashed?: boolean },
): ToolPreviewPath | null {
  const anchors: AnchorTriple[] = snapshot.anchors.map((a) => ({
    anchor: [a.anchor[0], a.anchor[1]],
    left: [a.left[0], a.left[1]],
    right: [a.right[0], a.right[1]],
  }));
  const close = snapshot.closePreview;
  // Rubber-band to the cursor: only while not snapping to close (the
  // close edge already returns to anchor 0). A corner anchor at the
  // hover point → a straight cubic from the last placed anchor.
  if (snapshot.rubberTo && !close) {
    anchors.push(cornerAnchor(clone(snapshot.rubberTo)));
  }
  // A single anchor (or none) has no segment to stroke.
  if (anchors.length < 2) return null;
  return {
    pageId,
    anchors,
    close,
    ...(options?.dashed ? { dashed: true } : {}),
  };
}
