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

// The Shape Builder tool's state machine — host-agnostic and PURE.
//
// TWO LANES, both driven from the same gesture:
//
//   · REGION lane (the real Illustrator interaction, live since engine
//     protocol v57 / B-22). The host installs the planar ARRANGEMENT of
//     the input set once per gesture (`setRegions`); from then on every
//     pointer sample resolves the FACE under the cursor locally
//     (`pointInAnchorPath` over the face outlines — even-odd, holes
//     included). `hovered` is what the host highlights; `collected` is
//     the ordered set of distinct faces the drag has crossed, which
//     pointer-up commits as `pathfinderFaces`.
//
//   · ELEMENT lane (the documented fallback for an engine without the
//     region ops). The host hit-tests along the drag and feeds the
//     resolved ELEMENT key as a `cross` event; `crossed` is the operand
//     list a `pathfinderBoolean` is built from. This is what shipped as
//     the honest B-22 subset and it stays reachable verbatim.
//
// Events:
//   down          → begin a gesture; record the down-point, mode =
//                   alt ? "subtract" : "unite"; resolve + collect the
//                   face under the down point (a plain CLICK is a
//                   one-face gesture, Illustrator's click-to-merge)
//   move          → extend the gesture polyline (or, when idle, just
//                   re-resolve the hover); collect while dragging
//   region(id)    → the host resolved the face under the cursor at the
//                   ENGINE (the cold-start / no-cache path — see the
//                   handler's caching note); collected while dragging
//   cross(key)    → ELEMENT-lane operand (fallback)
//   up            → freeze; `collected` / `crossed` are final
//   key Escape    → clear
//
// `setRegions(faces)` installs the cached arrangement (null clears it).
// A machine with no regions installed resolves nothing on its own and
// relies entirely on injected `region` events — which is exactly the
// cold-start state.
//
// Units: page-local pt for the gesture polyline; face outlines are in
// whatever space the host installed them in (the handler converts the
// engine's RAW path space to page space before installing, so the two
// agree). Element keys and face ids are opaque strings.

import {
  clone,
  pointInAnchorPath,
  type AnchorTriple,
  type Vec2,
} from "@paged-media/draw-geometry";

/** Modifier snapshot the mode is decided from (at gesture start). */
export interface ShapeBuilderModifiers {
  alt: boolean;
}

/** Unite (drag) vs subtract (alt-drag) — the gesture's whole-gesture
 *  mode, fixed at the down that began it (Illustrator's Alt-toggle is a
 *  press-state; we read it once per gesture for determinism). */
export type ShapeBuilderMode = "unite" | "subtract";

/** The wire `FaceSelectMode` a finished REGION gesture commits with:
 *  a plain drag KEEPS the faces it crossed, an Alt-drag REMOVES them. */
export type FaceMode = "keep" | "remove";

/** One face of the cached arrangement, in the machine's own space.
 *  Structurally the engine's `PlanarFaceWire` minus the fields the
 *  machine has no use for — the host installs what it read. */
export interface RegionFace {
  id: string;
  anchors: readonly AnchorTriple[];
  subpathStarts?: readonly number[];
}

export type ShapeBuilderEvent =
  | { type: "down"; point: Vec2; modifiers: ShapeBuilderModifiers }
  | { type: "move"; point: Vec2 }
  | { type: "region"; id: string | null }
  | { type: "cross"; key: string }
  | { type: "up"; point: Vec2 }
  | { type: "key"; key: "Escape" };

/** What the host renders / plans from. */
export interface ShapeBuilderSnapshot {
  /** The gesture polyline so far (page-local pt), or null when idle. */
  path: readonly Vec2[] | null;
  /** ELEMENT-lane operands: the distinct element keys the gesture has
   *  swept, in first-cross order (the fallback `pathfinderBoolean`
   *  operands). */
  crossed: readonly string[];
  /** REGION-lane operands: the distinct FACE ids the gesture has
   *  crossed, in first-cross order (the `pathfinderFaces` payload). */
  collected: readonly string[];
  /** The face under the cursor right now, or null — what the host
   *  highlights through the overlay tool-preview. Live while idle too
   *  (Illustrator shades the region under the pointer before any drag). */
  hovered: string | null;
  /** Unite (plain drag) or subtract (alt-drag) — fixed at gesture start. */
  mode: ShapeBuilderMode;
  /** The wire face-select mode `mode` maps to. */
  faceMode: FaceMode;
  /** True while a drag is in flight. */
  building: boolean;
  /** True once an arrangement has been installed (`setRegions`) — the
   *  host uses it to decide whether a pointer sample still needs an
   *  engine point query. */
  hasRegions: boolean;
}

/** Pure machine: gesture samples + (cached faces | injected face ids |
 *  crossed element keys) in, ordered operands + the hovered face out.
 *  No host, no engine — the handler shim installs the arrangement and
 *  feeds the pointer stream. */
export class ShapeBuilderMachine {
  private path: Vec2[] | null = null;
  private crossed: string[] = [];
  private collected: string[] = [];
  private hovered: string | null = null;
  private mode: ShapeBuilderMode = "unite";
  private dragging = false;
  private regions: readonly RegionFace[] | null = null;
  private lastPoint: Vec2 | null = null;

  /** Install (or clear, with `null`) the cached planar arrangement the
   *  hover resolves against. Re-resolves the hover at the last sampled
   *  point, so a cache that lands mid-hover highlights immediately
   *  rather than at the next pointermove. */
  setRegions(faces: readonly RegionFace[] | null): ShapeBuilderSnapshot {
    this.regions = faces;
    if (this.lastPoint) this.resolveAt(this.lastPoint);
    return this.snapshot();
  }

  handle(event: ShapeBuilderEvent): ShapeBuilderSnapshot {
    switch (event.type) {
      case "down":
        this.path = [clone(event.point)];
        this.crossed = [];
        this.collected = [];
        this.mode = event.modifiers.alt ? "subtract" : "unite";
        this.dragging = true;
        this.lastPoint = clone(event.point);
        this.resolveAt(event.point);
        return this.snapshot();
      case "move":
        if (this.dragging && this.path) this.path.push(clone(event.point));
        this.lastPoint = clone(event.point);
        this.resolveAt(event.point);
        return this.snapshot();
      case "region":
        // The engine answered the point query — trust it over any local
        // resolution (it is the same kernel the commit runs through).
        this.hovered = event.id;
        this.collect(event.id);
        return this.snapshot();
      case "cross":
        if (this.dragging && !this.crossed.includes(event.key)) {
          this.crossed.push(event.key);
        }
        return this.snapshot();
      case "up":
        if (this.dragging && this.path) {
          this.path.push(clone(event.point));
          this.lastPoint = clone(event.point);
          this.resolveAt(event.point);
          this.dragging = false;
        }
        return this.snapshot();
      case "key":
        this.path = null;
        this.crossed = [];
        this.collected = [];
        this.hovered = null;
        this.lastPoint = null;
        this.dragging = false;
        return this.snapshot();
    }
  }

  /** Resolve the face under `point` from the installed arrangement.
   *  With no arrangement the hover is left to injected `region` events
   *  (the cold-start path) rather than being cleared — clearing would
   *  flicker the highlight off between engine round trips. */
  private resolveAt(point: Vec2): void {
    if (!this.regions) return;
    let hit: string | null = null;
    for (const face of this.regions) {
      if (pointInAnchorPath(point, face.anchors, face.subpathStarts ?? [])) {
        hit = face.id;
        break;
      }
    }
    this.hovered = hit;
    this.collect(hit);
  }

  private collect(id: string | null): void {
    if (!this.dragging || id === null) return;
    if (!this.collected.includes(id)) this.collected.push(id);
  }

  private snapshot(): ShapeBuilderSnapshot {
    return {
      path: this.path ? this.path.map((p) => clone(p)) : null,
      crossed: [...this.crossed],
      collected: [...this.collected],
      hovered: this.hovered,
      mode: this.mode,
      faceMode: this.mode === "subtract" ? "remove" : "keep",
      building: this.dragging,
      hasRegions: this.regions !== null,
    };
  }
}
