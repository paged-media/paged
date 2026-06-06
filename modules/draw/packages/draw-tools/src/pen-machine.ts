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

export interface PenModifiers {
  shift: boolean;
  alt: boolean;
}

export type PenEvent =
  | { type: "down"; point: Vec2; modifiers: PenModifiers }
  | { type: "move"; point: Vec2; modifiers: PenModifiers }
  | { type: "up"; point: Vec2; modifiers: PenModifiers }
  | { type: "key"; key: "Enter" | "Escape" };

export interface PenCommit {
  anchors: AnchorTriple[];
  open: boolean;
}

/** What the host renders/acts on after each event. */
export interface PenSnapshot {
  /** Anchors placed so far (live — includes the one being dragged). */
  anchors: readonly AnchorTriple[];
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

export class PenMachine {
  private anchors: AnchorTriple[] = [];
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
        return this.onDown(event.point, event.modifiers);
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

  private onDown(point: Vec2, modifiers: PenModifiers): PenSnapshot {
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
      return this.snapshot(null);
    }
    // Enter — commit the open path; a degenerate run cancels.
    this.done = true;
    if (this.anchors.length < 2) {
      this.anchors = [];
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
