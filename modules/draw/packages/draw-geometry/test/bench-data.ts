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

// Inputs for the `*.bench.ts` files beside this one.
//
// THE BENCHES ARE TRENDED, NOT GATED. They assert nothing: a duration
// moves with the machine and the load on it, so a threshold on one is a
// flaky test with a number in it. (The gated half lives in
// `draw-bundle/test/perf/`, and counts door calls for exactly that
// reason.) `pnpm bench` prints them; the number to watch is how one
// moves against ITS OWN history on the same machine — and, inside one
// run, how a size's ops/sec compares with ten times that size.
//
// Every input is built deterministically (a seeded LCG, no
// `Math.random`), once, outside the timed function.

import type { AnchorTable, AnchorTriple, Vec2 } from "../src/types";

/** A linear congruential generator (the Numerical Recipes constants):
 *  `next()` answers a float in [0, 1). */
export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export const BENCH_SEED = 0x5eed;

/** `samples` points of a hand-drawn stroke: three slow sine waves across
 *  a page, every sample jittered by up to 1.5 pt — what the pencil hands
 *  RDP on pointer-up. */
export function freehandStroke(samples: number): Vec2[] {
  const next = lcg(BENCH_SEED);
  const out: Vec2[] = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    out.push([
      40 + 530 * t + (next() * 2 - 1) * 1.5,
      400 + 60 * Math.sin(t * 6 * Math.PI) + (next() * 2 - 1) * 1.5,
    ]);
  }
  return out;
}

/** `samples` points on a 12-turn spiral — the stroke RDP can drop the
 *  least from, because it never runs straight. */
export function spiralStroke(samples: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const a = t * 12 * Math.PI * 2;
    const r = 20 + 260 * t;
    out.push([306 + r * Math.cos(a), 396 + r * Math.sin(a)]);
  }
  return out;
}

const corner = (x: number, y: number): AnchorTriple => ({
  anchor: [x, y],
  left: [x, y],
  right: [x, y],
});

/** A closed square of straight edges. */
export function squareFace(x: number, y: number, size: number): AnchorTriple[] {
  return [
    corner(x, y),
    corner(x + size, y),
    corner(x + size, y + size),
    corner(x, y + size),
  ];
}

/** A closed four-anchor circle with real Bezier handles — every segment
 *  is a curve, so `flattenAnchorRun` samples all of them. */
export function roundFace(cx: number, cy: number, r: number): AnchorTriple[] {
  const k = r * 0.5522847498;
  return [
    { anchor: [cx + r, cy], left: [cx + r, cy - k], right: [cx + r, cy + k] },
    { anchor: [cx, cy + r], left: [cx + k, cy + r], right: [cx - k, cy + r] },
    { anchor: [cx - r, cy], left: [cx - r, cy + k], right: [cx - r, cy - k] },
    { anchor: [cx, cy - r], left: [cx - k, cy - r], right: [cx + k, cy - r] },
  ];
}

/** The planar kernel's face cap. */
export const MAX_FACES = 256;

/** `MAX_FACES` faces on a 16 × 16 grid of 30 pt cells — what a region
 *  tool's cache holds for the largest arrangement the engine will
 *  enumerate, and what one hover move tests the pointer against. */
export function faceGrid(
  face: (x: number, y: number) => AnchorTriple[],
): AnchorTriple[][] {
  const out: AnchorTriple[][] = [];
  for (let i = 0; i < MAX_FACES; i++) {
    out.push(face(20 + (i % 16) * 30, 20 + Math.floor(i / 16) * 30));
  }
  return out;
}

/** `contours` concentric squares in ONE table — contour i sits inside
 *  all the ones before it, so its depth is i. The worst case for a
 *  depth pass that tests every contour against every other. */
export function nestedContours(contours: number): AnchorTable {
  const anchors: AnchorTriple[] = [];
  const subpathStarts: number[] = [];
  for (let i = 0; i < contours; i++) {
    subpathStarts.push(anchors.length);
    anchors.push(...squareFace(i, i, 2 * (contours - i)));
  }
  return { anchors, subpathStarts };
}

/** One cubic segment as the four points `closestTOnCubic` takes. */
export type Cubic = [Vec2, Vec2, Vec2, Vec2];

/** `segments` cubics along an S-curve, and a click 5 pt off each — the
 *  nearest-point search over a long path. */
export function cubicRun(segments: number): { cubics: Cubic[]; clicks: Vec2[] } {
  const next = lcg(BENCH_SEED);
  const cubics: Cubic[] = [];
  const clicks: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const x = i * 6;
    const y = 300 + 80 * Math.sin(i / 20);
    cubics.push([
      [x, y],
      [x + 2, y - 10],
      [x + 4, y + 10],
      [x + 6, 300 + 80 * Math.sin((i + 1) / 20)],
    ]);
    clicks.push([x + next() * 6, y + (next() * 2 - 1) * 5]);
  }
  return { cubics, clicks };
}

/** A synthetic SVG of `shapes` shapes, the mix an exported illustration
 *  carries: rects, circles and multi-subpath cubic paths, a third of
 *  them inside a transformed group, every one with its own fill, some
 *  with a stroke and an inline `style`. About 120 bytes a shape. */
export function syntheticSvg(shapes: number): string {
  const next = lcg(BENCH_SEED);
  const hex = (): string =>
    `#${Math.floor(next() * 0xffffff)
      .toString(16)
      .padStart(6, "0")}`;
  const n = (max: number): string => (next() * max).toFixed(2);
  const out: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!-- synthetic: ${shapes} shapes -->`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="612" height="792" viewBox="0 0 612 792">`,
  ];
  for (let i = 0; i < shapes; i++) {
    if (i % 30 === 0) {
      if (i > 0) out.push(`</g>`);
      out.push(
        i % 90 === 0
          ? `<g transform="translate(${n(40)} ${n(40)}) rotate(${n(30)})" fill="${hex()}">`
          : `<g id="layer-${i / 30}">`,
      );
    }
    switch (i % 3) {
      case 0:
        out.push(
          `<rect x="${n(560)}" y="${n(740)}" width="${n(50)}" height="${n(50)}" fill="${hex()}" stroke="${hex()}" stroke-width="1.5"/>`,
        );
        break;
      case 1:
        out.push(
          `<circle cx="${n(560)}" cy="${n(740)}" r="${n(25)}" style="fill:${hex()};stroke:none"/>`,
        );
        break;
      default: {
        const x = n(520);
        const y = n(700);
        out.push(
          `<path d="M${x} ${y} c 10 -20 30 -20 40 0 s 30 20 40 0 l 0 30 l -80 0 Z m 10 10 h 20 v 10 h -20 Z" fill="${hex()}" fill-rule="evenodd"/>`,
        );
      }
    }
  }
  out.push(`</g>`, `</svg>`);
  return out.join("\n");
}
