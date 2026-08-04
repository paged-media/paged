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

// The LIVE PAINT gesture machine — host-agnostic and PURE. It is the
// SIBLING of `shape-builder-machine.ts`, not a copy of it, and it shares
// that module's {@link RegionFace} verbatim (one definition in this
// package, installed by the host through `setRegions`).
//
// It drives BOTH Live Paint tools, because both are the same gesture:
//
//   · the BUCKET — hover resolves the face under the cursor (the host
//     highlights it), a click paints that one face, and a DRAG paints
//     every face it crosses, in first-cross order (Illustrator's
//     drag-to-fill).
//   · the FACE SELECTION tool — the identical resolve/collect, except
//     the host turns the collected face ids into a SELECTION instead of
//     a paint.
//
// WHY IT IS NOT `ShapeBuilderMachine`. That machine's whole-gesture
// `mode` is unite/subtract and its `faceMode` is the wire's
// keep/remove — the vocabulary of a DESTRUCTIVE pathfinder commit. Live
// Paint neither keeps nor removes anything: it materialises new artwork
// over faces that go on existing. Reusing the type would have made every
// call site read as a pathfinder op that it is not, so the two machines
// stay separate and share only the geometry.
//
// Events:
//   down       → begin painting; collect the face under the down point
//                (a plain CLICK is a one-face gesture)
//   move       → re-resolve the hover; collect while dragging
//   region(id) → the host resolved the face at the ENGINE (the
//                cold-start / face-cap path — see the handler's caching
//                note); collected while dragging
//   up         → freeze; `collected` is final
//   key Escape → clear
//
// `setRegions(faces)` installs the cached arrangement (null clears it).
// A machine with no regions installed resolves nothing on its own and
// relies entirely on injected `region` events — the cold-start state.
//
// Units: page-local pt. Face ids are opaque strings (the engine's
// `"<signature>#<component>"`), and this machine never parses them —
// their instability across an input edit is the recipe's problem, not
// the gesture's.

import { clone, pointInAnchorPath, type Vec2 } from "@paged-media/draw-geometry";

import type { RegionFace } from "./shape-builder-machine";

export type LivePaintEvent =
  | { type: "down"; point: Vec2 }
  | { type: "move"; point: Vec2 }
  | { type: "region"; id: string | null }
  | { type: "up"; point: Vec2 }
  | { type: "key"; key: "Escape" };

/** What the host paints / selects / previews from. */
export interface LivePaintSnapshot {
  /** The face under the cursor right now, or null — what the host
   *  highlights through the overlay tool-preview. Live while idle too
   *  (the bucket shades the region under the pointer before any click). */
  hovered: string | null;
  /** The distinct face ids this gesture has crossed, in first-cross
   *  order — what pointer-up paints (bucket) or selects (face select). */
  collected: readonly string[];
  /** True between down and up. */
  painting: boolean;
  /** True once an arrangement has been installed (`setRegions`) — the
   *  host uses it to decide whether a sample still needs an engine
   *  point query. */
  hasRegions: boolean;
}

/** Pure machine: pointer samples + (cached faces | injected face ids)
 *  in, the hovered face + the ordered crossed set out. No host, no
 *  engine — the handler shim installs the arrangement and feeds the
 *  pointer stream. */
export class LivePaintMachine {
  private hovered: string | null = null;
  private collected: string[] = [];
  private painting = false;
  private regions: readonly RegionFace[] | null = null;
  private lastPoint: Vec2 | null = null;

  /** Install (or clear, with `null`) the cached planar arrangement the
   *  hover resolves against. Re-resolves at the last sampled point, so a
   *  cache that lands mid-hover highlights immediately rather than at the
   *  next pointermove. */
  setRegions(faces: readonly RegionFace[] | null): LivePaintSnapshot {
    this.regions = faces;
    if (this.lastPoint) this.resolveAt(this.lastPoint);
    return this.snapshot();
  }

  handle(event: LivePaintEvent): LivePaintSnapshot {
    switch (event.type) {
      case "down":
        this.collected = [];
        this.painting = true;
        this.lastPoint = clone(event.point);
        this.resolveAt(event.point);
        return this.snapshot();
      case "move":
        this.lastPoint = clone(event.point);
        this.resolveAt(event.point);
        return this.snapshot();
      case "region":
        // The engine answered the point query — trust it over any local
        // resolution (it is the same kernel the fill geometry comes from).
        this.hovered = event.id;
        this.collect(event.id);
        return this.snapshot();
      case "up":
        if (this.painting) {
          this.lastPoint = clone(event.point);
          this.resolveAt(event.point);
          this.painting = false;
        }
        return this.snapshot();
      case "key":
        this.hovered = null;
        this.collected = [];
        this.lastPoint = null;
        this.painting = false;
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
    if (!this.painting || id === null) return;
    if (!this.collected.includes(id)) this.collected.push(id);
  }

  private snapshot(): LivePaintSnapshot {
    return {
      hovered: this.hovered,
      collected: [...this.collected],
      painting: this.painting,
      hasRegions: this.regions !== null,
    };
  }
}
