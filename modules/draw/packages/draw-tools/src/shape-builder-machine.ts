// The Shape Builder tool's state machine — host-agnostic and PURE: a
// drag-across gesture in (page-local pt), an ordered set of crossed
// REGION KEYS + the boolean mode out. The host samples the engine's
// hit-test along the gesture path and feeds the resolved region key for
// each sampled point; the machine de-dupes + orders them and decides the
// gesture's mode from the modifier at gesture START.
//
//   down          → begin a gesture; record the down-point as the first
//                   sample slot, mode = alt ? "subtract" : "unite"
//   cross(key)    → the host resolved a region the gesture is over
//                   (hit-test along the drag); appended if new
//   move (down)   → extend the gesture polyline (for the on-canvas
//                   preview); the host emits a separate cross() when a
//                   new region is entered
//   up            → freeze; the snapshot's `crossed` is the final region
//                   list the host turns into a pathfinder plan
//   key Escape    → clear
//
// HONEST SUBSET, named (matches the task brief + commands/shape-builder
// header): the facade hit-tests at the ELEMENT level, not the sub-region
// level (no door enumerates the distinct AREAS an overlap divides a plane
// into). So "drag across overlapping regions" resolves to "drag across
// overlapping ELEMENTS" — the machine collects the element keys the
// gesture sweeps, and the handler unites/subtracts those whole elements
// (the selection-based pathfinder, with the swept elements NAMED by the
// gesture rather than pre-selected). True region-level Shape Builder needs
// a planar-map / region hit-test door — an RFI gap (B-22).
//
// Units: page-local pt for the gesture polyline. Region keys are opaque
// strings (the host's element ids) — the machine never interprets them.

import { clone, type Vec2 } from "@paged-media/draw-geometry";

/** Modifier snapshot the mode is decided from (at gesture start). */
export interface ShapeBuilderModifiers {
  alt: boolean;
}

/** Unite (drag) vs subtract (alt-drag) — the gesture's whole-gesture
 *  mode, fixed at the down that began it (Illustrator's Alt-toggle is a
 *  press-state; we read it once per gesture for determinism). */
export type ShapeBuilderMode = "unite" | "subtract";

export type ShapeBuilderEvent =
  | { type: "down"; point: Vec2; modifiers: ShapeBuilderModifiers }
  | { type: "move"; point: Vec2 }
  | { type: "cross"; key: string }
  | { type: "up"; point: Vec2 }
  | { type: "key"; key: "Escape" };

/** What the host renders / plans from. */
export interface ShapeBuilderSnapshot {
  /** The gesture polyline so far (page-local pt), or null when idle. */
  path: readonly Vec2[] | null;
  /** The distinct region keys the gesture has swept, in first-cross
   *  order (the pathfinder operands the host commits over). */
  crossed: readonly string[];
  /** Unite (plain drag) or subtract (alt-drag) — fixed at gesture start. */
  mode: ShapeBuilderMode;
  /** True while a drag is in flight. */
  building: boolean;
}

/** Pure machine: gesture samples + crossed-region notifications in,
 *  ordered operand keys + mode out. No host, no engine — the handler
 *  shim feeds it `cross` events from `host.document.hitTest`. */
export class ShapeBuilderMachine {
  private path: Vec2[] | null = null;
  private crossed: string[] = [];
  private mode: ShapeBuilderMode = "unite";
  private dragging = false;

  handle(event: ShapeBuilderEvent): ShapeBuilderSnapshot {
    switch (event.type) {
      case "down":
        this.path = [clone(event.point)];
        this.crossed = [];
        this.mode = event.modifiers.alt ? "subtract" : "unite";
        this.dragging = true;
        return this.snapshot();
      case "move":
        if (this.dragging && this.path) this.path.push(clone(event.point));
        return this.snapshot();
      case "cross":
        if (this.dragging && !this.crossed.includes(event.key)) {
          this.crossed.push(event.key);
        }
        return this.snapshot();
      case "up":
        if (this.dragging && this.path) {
          this.path.push(clone(event.point));
          this.dragging = false;
        }
        return this.snapshot();
      case "key":
        this.path = null;
        this.crossed = [];
        this.dragging = false;
        return this.snapshot();
    }
  }

  private snapshot(): ShapeBuilderSnapshot {
    return {
      path: this.path ? this.path.map((p) => clone(p)) : null,
      crossed: [...this.crossed],
      mode: this.mode,
      building: this.dragging,
    };
  }
}
