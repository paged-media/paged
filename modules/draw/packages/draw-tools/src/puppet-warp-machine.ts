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

// PUPPET WARP — the tool's session machine. Unlike the one-gesture
// machines it lives for as long as the tool stays on the same artwork:
// the rest mesh and the pins persist between drags, as in Illustrator.
//
//   construction → the MESH (draw-geometry `triangulateRings` over the
//                  flattened contours of every target — an open contour
//                  is closed by its chord, which is the outline its fill
//                  would have) and the AUTOMATIC pins (`autoPins`); every
//                  anchor and handle of every target is LOCATED in the
//                  rest mesh once, so a deformation maps them all
//   down         → on a pin: select it and start dragging it (Alt: remove
//                  it); on the selected pin's ROTATION RING (just outside
//                  the pin): start turning the artwork about it; anywhere
//                  else on the mesh: ADD a pin at the nearest mesh vertex
//                  (it does not move anything) and drag it; off the mesh:
//                  nothing
//   move         → the dragged pin's target (or its angle); ARAP solve
//                  (Igarashi 2005, `ArapSolver`) → the mapped tables
//   up           → COMMIT the mapped tables when the drag moved something
//                  — the host writes every target in ONE batch, one undo
//                  step per pin drag; removing a pin re-solves and commits
//                  too (the artwork settles without that pin's hold)
//   Delete       → remove the selected pin (re-solve, commit)
//   Escape       → cancel the drag in progress (the pin goes back)
//
// The solver is rebuilt only when the PIN SET changes (add / remove /
// first rotation of a pin): a drag sample is two back-substitutions.

import {
  ArapSolver,
  autoPins,
  flattenAnchorRun,
  locateInMesh,
  mapLocated,
  nearestVertex,
  triangulateRings,
  type AnchorTable,
  type ArapPin,
  type TriangleMesh,
  type Vec2,
  type Vec2Mut,
} from "@paged-media/draw-geometry";

export type PuppetWarpEvent =
  | { type: "down"; point: Vec2; alt?: boolean }
  | { type: "move"; point: Vec2 }
  | { type: "up"; point: Vec2 }
  | { type: "key"; key: "Escape" | "Delete" | "Backspace" };

export interface PuppetWarpOptions {
  /** The selection's paths, page space. */
  targets: readonly AnchorTable[];
  /** pt — the pick radius round a pin (the host converts px at zoom). */
  tolerance: number;
  /** pt — the mesh's target edge length (default: the outline's
   *  diagonal / 24, Illustrator's "normal" density). */
  spacing?: number;
  /** Automatic pins on construction (default 3; 0 for none). */
  autoPinCount?: number;
  /** Cap on mesh vertices (default 320 — the dense solve stays
   *  interactive). */
  maxVertices?: number;
}

export interface PuppetPinView {
  point: Vec2Mut;
  selected: boolean;
}

export interface PuppetWarpSnapshot {
  /** The mapped targets (page space). */
  tables: AnchorTable[];
  /** The deformed mesh's edges, for the overlay. */
  meshEdges: [Vec2Mut, Vec2Mut][];
  pins: PuppetPinView[];
  /** Non-null once, on the event that ends a changing edit. */
  commit: AnchorTable[] | null;
  /** Mid-drag. */
  dragging: boolean;
}

interface Pin {
  vertex: number;
  target: Vec2Mut;
  angle: number | null;
}

interface Located {
  triangle: number;
  weights: [number, number, number];
}

export class PuppetWarpMachine {
  readonly mesh: TriangleMesh;
  private pins: Pin[] = [];
  private selected = -1;
  private solver: ArapSolver | null = null;
  private deformed: Vec2Mut[];
  private readonly located: Located[][][]; // [target][anchor][anchor,left,right]
  private drag:
    | {
        kind: "move";
        pin: number;
        start: Vec2Mut;
        from: Vec2Mut;
        moved: boolean;
      }
    | {
        kind: "rotate";
        pin: number;
        start: number;
        from: number | null;
        moved: boolean;
      }
    | null = null;

  constructor(private readonly opts: PuppetWarpOptions) {
    const rings: Vec2Mut[][] = [];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const t of opts.targets) {
      const n = t.anchors.length;
      const starts = t.subpathStarts.length ? t.subpathStarts : [0];
      starts.forEach((from, s) => {
        const to = s + 1 < starts.length ? starts[s + 1]! : n;
        const closed = !(t.subpathOpen?.[s] ?? false);
        const run = t.anchors.slice(from, to);
        const pts = flattenAnchorRun(run, {
          close: closed,
          samplesPerSegment: 16,
        });
        if (closed && pts.length > 1) pts.pop();
        if (pts.length >= 3) rings.push(pts);
        for (const p of pts) {
          x0 = Math.min(x0, p[0]);
          y0 = Math.min(y0, p[1]);
          x1 = Math.max(x1, p[0]);
          y1 = Math.max(y1, p[1]);
        }
      });
    }
    const diag = Number.isFinite(x0) ? Math.hypot(x1 - x0, y1 - y0) : 0;
    this.mesh = triangulateRings(rings, {
      spacing: opts.spacing ?? Math.max(1, diag / 24),
      maxVertices: opts.maxVertices ?? 320,
    });
    this.deformed = this.mesh.vertices.map((v) => [v[0], v[1]]);
    this.located = opts.targets.map((t) =>
      t.anchors.map((a) =>
        [a.anchor, a.left, a.right].map(
          (p) =>
            locateInMesh(this.mesh, p) ?? {
              triangle: -1,
              weights: [1, 0, 0] as [number, number, number],
            },
        ),
      ),
    );
    for (const v of autoPins(this.mesh, opts.autoPinCount ?? 3))
      this.pins.push({
        vertex: v,
        target: [this.mesh.vertices[v]![0], this.mesh.vertices[v]![1]],
        angle: null,
      });
    this.rebuild();
  }

  /** Is there a mesh to warp (a selection with an outline)? */
  get usable(): boolean {
    return this.mesh.triangles.length > 0;
  }

  /** The pins, page space (for specs and the overlay). */
  pinPoints(): Vec2Mut[] {
    return this.pins.map((p) => [p.target[0], p.target[1]]);
  }

  private rebuild(): void {
    const pins: ArapPin[] = this.pins.map((p) => ({
      vertex: p.vertex,
      target: p.target,
      angle: p.angle,
    }));
    this.solver = new ArapSolver(this.mesh, pins);
    this.solve();
  }

  private solve(): void {
    if (!this.solver) return;
    this.deformed = this.solver.solve(
      this.pins.map((p) => p.target),
      this.pins.map((p) => p.angle),
    );
  }

  private mapped(): AnchorTable[] {
    const tris = this.mesh.triangles;
    return this.opts.targets.map((t, ti) => ({
      ...t,
      anchors: t.anchors.map((a, ai) => {
        const loc = this.located[ti]![ai]!;
        const map = (k: number, p: Vec2): Vec2Mut =>
          loc[k]!.triangle < 0
            ? [p[0], p[1]]
            : mapLocated(tris, this.deformed, loc[k]!);
        return {
          anchor: map(0, a.anchor),
          left: map(1, a.left),
          right: map(2, a.right),
        };
      }),
    }));
  }

  private pinAt(p: Vec2): number {
    let best = -1;
    let bestD = this.opts.tolerance;
    this.pins.forEach((pin, i) => {
      const d = Math.hypot(pin.target[0] - p[0], pin.target[1] - p[1]);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  /** Inside the deformed mesh? */
  private onMesh(p: Vec2): boolean {
    const loc = locateInMesh(
      { vertices: this.deformed, triangles: this.mesh.triangles },
      p,
    );
    return !!loc && Math.min(...loc.weights) >= -1e-6;
  }

  private angleAbout(pin: number, p: Vec2): number {
    const c = this.pins[pin]!.target;
    return Math.atan2(p[1] - c[1], p[0] - c[0]);
  }

  private removePin(i: number): PuppetWarpSnapshot {
    this.pins.splice(i, 1);
    this.selected = -1;
    this.rebuild();
    return this.snapshot(this.mapped());
  }

  handle(event: PuppetWarpEvent): PuppetWarpSnapshot {
    if (!this.usable) return this.snapshot(null);
    switch (event.type) {
      case "down": {
        const hit = this.pinAt(event.point);
        if (hit >= 0 && event.alt) return this.removePin(hit);
        if (hit >= 0) {
          this.selected = hit;
          const t = this.pins[hit]!.target;
          this.drag = {
            kind: "move",
            pin: hit,
            start: [event.point[0], event.point[1]],
            from: [t[0], t[1]],
            moved: false,
          };
          return this.snapshot(null);
        }
        // The rotation ring round the selected pin: 1–3 pick radii out.
        if (this.selected >= 0) {
          const c = this.pins[this.selected]!.target;
          const d = Math.hypot(event.point[0] - c[0], event.point[1] - c[1]);
          if (d > this.opts.tolerance && d <= this.opts.tolerance * 3) {
            this.drag = {
              kind: "rotate",
              pin: this.selected,
              start: this.angleAbout(this.selected, event.point),
              from: this.pins[this.selected]!.angle,
              moved: false,
            };
            return this.snapshot(null);
          }
        }
        if (!this.onMesh(event.point)) {
          this.selected = -1;
          return this.snapshot(null);
        }
        const v = nearestVertex(this.deformed, event.point).index;
        if (v < 0) return this.snapshot(null);
        const existing = this.pins.findIndex((p) => p.vertex === v);
        if (existing >= 0) this.selected = existing;
        else {
          this.pins.push({
            vertex: v,
            target: [this.deformed[v]![0], this.deformed[v]![1]],
            angle: null,
          });
          this.selected = this.pins.length - 1;
          this.rebuild();
        }
        const t = this.pins[this.selected]!.target;
        this.drag = {
          kind: "move",
          pin: this.selected,
          start: [event.point[0], event.point[1]],
          from: [t[0], t[1]],
          moved: false,
        };
        return this.snapshot(null);
      }
      case "move": {
        const d = this.drag;
        if (!d) return this.snapshot(null);
        if (d.kind === "move") {
          const pin = this.pins[d.pin]!;
          pin.target = [
            d.from[0] + event.point[0] - d.start[0],
            d.from[1] + event.point[1] - d.start[1],
          ];
          d.moved =
            d.moved ||
            event.point[0] !== d.start[0] ||
            event.point[1] !== d.start[1];
          this.solve();
        } else {
          const pin = this.pins[d.pin]!;
          const wasFree = pin.angle === null;
          pin.angle =
            (d.from ?? 0) + this.angleAbout(d.pin, event.point) - d.start;
          d.moved = true;
          // A pin's FIRST turn adds its lever constraint: a new pin set.
          if (wasFree) this.rebuild();
          else this.solve();
        }
        return this.snapshot(null);
      }
      case "up": {
        const d = this.drag;
        if (!d) return this.snapshot(null);
        this.handle({ type: "move", point: event.point });
        this.drag = null;
        return this.snapshot(d.moved ? this.mapped() : null);
      }
      case "key": {
        if (event.key === "Escape") {
          const d = this.drag;
          if (d?.kind === "move") this.pins[d.pin]!.target = d.from;
          if (d?.kind === "rotate") {
            this.pins[d.pin]!.angle = d.from;
            if (d.from === null) {
              this.rebuild();
              this.drag = null;
              return this.snapshot(null);
            }
          }
          this.drag = null;
          this.solve();
          return this.snapshot(null);
        }
        if (this.selected >= 0 && !this.drag)
          return this.removePin(this.selected);
        return this.snapshot(null);
      }
    }
  }

  /** The current state, no event. */
  view(): PuppetWarpSnapshot {
    return this.snapshot(null);
  }

  private snapshot(commit: AnchorTable[] | null): PuppetWarpSnapshot {
    const edges: [Vec2Mut, Vec2Mut][] = [];
    const seen = new Set<string>();
    for (const t of this.mesh.triangles)
      for (let e = 0; e < 3; e++) {
        const a = t[e]!;
        const b = t[(e + 1) % 3]!;
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        if (seen.has(k)) continue;
        seen.add(k);
        edges.push([this.deformed[a]!, this.deformed[b]!]);
      }
    return {
      tables: this.mapped(),
      meshEdges: edges,
      pins: this.pins.map((p, i) => ({
        point: [p.target[0], p.target[1]],
        selected: i === this.selected,
      })),
      commit,
      dragging: this.drag !== null,
    };
  }
}
