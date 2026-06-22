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

// Minimal SVG document reader/writer: element coverage, presentation-attr
// + style-shorthand resolution, transform flattening (translate/scale/
// matrix/rotate, nested groups), and a full document round-trip (parse →
// serialize → re-parse with geometry stable within tolerance).

import { describe, expect, it } from "vitest";

import {
  parseSvgDocument,
  serializeSvgDocument,
  parseTransform,
  applyAffine,
  evalCubic,
  type DrawShape,
  type AnchorTable,
} from "../src";

function outline(t: AnchorTable, per = 12): [number, number][] {
  const out: [number, number][] = [];
  const starts = t.subpathStarts.length ? t.subpathStarts : [0];
  const open = t.subpathOpen ?? [];
  for (let s = 0; s < starts.length; s++) {
    const begin = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : t.anchors.length;
    const count = end - begin;
    if (!count) continue;
    const segs = (open[s] ?? false) ? count - 1 : count;
    for (let i = 0; i < segs; i++) {
      const a = t.anchors[begin + i];
      const b = t.anchors[begin + ((i + 1) % count)];
      for (let k = 0; k <= per; k++) {
        out.push(evalCubic(a.anchor, a.right, b.left, b.anchor, k / per));
      }
    }
  }
  return out;
}

function maxDeviation(shapesA: DrawShape[], shapesB: DrawShape[]): number {
  expect(shapesB.length).toBe(shapesA.length);
  let max = 0;
  for (let i = 0; i < shapesA.length; i++) {
    const pa = outline(shapesA[i].anchors);
    const pb = outline(shapesB[i].anchors);
    expect(pb.length).toBe(pa.length);
    for (let k = 0; k < pa.length; k++) {
      max = Math.max(max, Math.hypot(pa[k][0] - pb[k][0], pa[k][1] - pb[k][1]));
    }
  }
  return max;
}

describe("parseTransform", () => {
  it("translate moves a point", () => {
    const m = parseTransform("translate(10, 20)");
    expect(applyAffine(m, 0, 0)).toEqual([10, 20]);
  });

  it("scale multiplies", () => {
    const m = parseTransform("scale(2, 3)");
    expect(applyAffine(m, 5, 5)).toEqual([10, 15]);
  });

  it("matrix is taken verbatim", () => {
    const m = parseTransform("matrix(1 0 0 1 7 8)");
    expect(applyAffine(m, 0, 0)).toEqual([7, 8]);
  });

  it("rotate(90) maps (1,0) → (0,1)", () => {
    const m = parseTransform("rotate(90)");
    const p = applyAffine(m, 1, 0);
    expect(p[0]).toBeCloseTo(0, 6);
    expect(p[1]).toBeCloseTo(1, 6);
  });

  it("composes left-to-right (leftmost outermost)", () => {
    // translate then scale: scale applies first to the point.
    const m = parseTransform("translate(10 0) scale(2)");
    expect(applyAffine(m, 1, 0)).toEqual([12, 0]);
  });
});

describe("parseSvgDocument — elements + style", () => {
  it("reads a path with fill/stroke", () => {
    const doc = parseSvgDocument(
      `<svg><path d="M0 0 L10 0 L10 10 Z" fill="#ff0000" stroke="#000" stroke-width="2"/></svg>`,
    );
    expect(doc).not.toBeNull();
    expect(doc!.shapes.length).toBe(1);
    const s = doc!.shapes[0];
    expect(s.style.fill).toBe("#ff0000");
    expect(s.style.stroke).toBe("#000");
    expect(s.style.strokeWidth).toBe(2);
    expect(s.anchors.subpathOpen).toEqual([false]);
  });

  it("reads each basic shape", () => {
    const doc = parseSvgDocument(
      `<svg>
        <rect x="0" y="0" width="10" height="10"/>
        <circle cx="5" cy="5" r="4"/>
        <ellipse cx="5" cy="5" rx="4" ry="2"/>
        <line x1="0" y1="0" x2="9" y2="9"/>
        <polyline points="0,0 5,5 10,0"/>
        <polygon points="0,0 5,5 10,0"/>
      </svg>`,
    );
    expect(doc!.shapes.length).toBe(6);
  });

  it("fill='none' resolves to null; style='' shorthand wins over attrs", () => {
    const doc = parseSvgDocument(
      `<svg><path d="M0 0 L1 1" fill="red" style="fill:none;stroke:#00ff00;stroke-width:3"/></svg>`,
    );
    const s = doc!.shapes[0];
    expect(s.style.fill).toBeNull();
    expect(s.style.stroke).toBe("#00ff00");
    expect(s.style.strokeWidth).toBe(3);
  });

  it("reads width/height/viewBox", () => {
    const doc = parseSvgDocument(
      `<svg width="200" height="100" viewBox="0 0 200 100"><rect width="10" height="10"/></svg>`,
    );
    expect(doc!.width).toBe(200);
    expect(doc!.height).toBe(100);
    expect(doc!.viewBox).toEqual([0, 0, 200, 100]);
  });

  it("flattens a group translate into the geometry", () => {
    const doc = parseSvgDocument(
      `<svg><g transform="translate(100, 50)"><rect x="0" y="0" width="10" height="10"/></g></svg>`,
    );
    const first = doc!.shapes[0].anchors.anchors[0].anchor;
    expect(first).toEqual([100, 50]);
  });

  it("flattens nested groups (translate ∘ scale)", () => {
    const doc = parseSvgDocument(
      `<svg><g transform="translate(10 10)"><g transform="scale(2)">` +
        `<rect x="0" y="0" width="5" height="5"/></g></g></svg>`,
    );
    const corners = doc!.shapes[0].anchors.anchors.map((a) => a.anchor);
    // Rect (0,0)-(5,5) scaled ×2 → (0,0)-(10,10), then +10,+10.
    expect(corners).toEqual([
      [10, 10],
      [20, 10],
      [20, 20],
      [10, 20],
    ]);
  });

  it("inherits group style onto children", () => {
    const doc = parseSvgDocument(
      `<svg><g fill="#abcdef"><path d="M0 0 L1 1"/></g></svg>`,
    );
    expect(doc!.shapes[0].style.fill).toBe("#abcdef");
  });

  it("skips unknown elements but walks their children", () => {
    const doc = parseSvgDocument(
      `<svg><unknown><rect width="4" height="4"/></unknown></svg>`,
    );
    expect(doc!.shapes.length).toBe(1);
  });

  it("returns null when there's no <svg> root", () => {
    expect(parseSvgDocument(`<html></html>`)).toBeNull();
  });
});

describe("serializeSvgDocument — writer", () => {
  it("emits one <path> per shape with fill/stroke", () => {
    const doc = parseSvgDocument(
      `<svg><path d="M0 0 L10 0 L10 10 Z" fill="#ff0000" stroke="none"/></svg>`,
    );
    const out = serializeSvgDocument(doc!.shapes);
    expect(out).toContain("<path");
    expect(out).toContain(`fill="#ff0000"`);
    expect(out).toContain(`stroke="none"`);
    expect(out).toContain("<svg");
    expect(out).toContain("</svg>");
  });

  it("derives a viewport from the bounds when none given", () => {
    const doc = parseSvgDocument(`<svg><rect x="0" y="0" width="30" height="20"/></svg>`);
    const out = serializeSvgDocument(doc!.shapes);
    expect(out).toContain(`width="30"`);
    expect(out).toContain(`height="20"`);
  });
});

describe("full document round-trip (import → export → re-import)", () => {
  const fixtures: string[] = [
    `<svg width="120" height="120">
       <rect x="10" y="10" width="100" height="50" fill="#ff8800" stroke="#222" stroke-width="2"/>
       <circle cx="60" cy="90" r="20" fill="#0088ff"/>
       <path d="M0 0 C 30 0 30 30 0 30 Z" fill="none" stroke="#000"/>
     </svg>`,
    `<svg>
       <g transform="translate(20 20) rotate(15)">
         <ellipse cx="0" cy="0" rx="40" ry="20" fill="#abc"/>
       </g>
       <polygon points="0,0 50,0 25,40" fill="#cba"/>
     </svg>`,
    `<svg>
       <path d="M10 10 A 30 30 0 1 1 70 10 Z" fill="#123456"/>
       <polyline points="0,0 10,10 20,0 30,10" stroke="#0f0" fill="none"/>
     </svg>`,
  ];

  it.each(fixtures)("is geometry-stable for fixture #%#", (svg) => {
    const a = parseSvgDocument(svg)!;
    const out = serializeSvgDocument(a.shapes, { precision: 4 });
    const b = parseSvgDocument(out)!;
    // Topology preserved.
    expect(b.shapes.length).toBe(a.shapes.length);
    for (let i = 0; i < a.shapes.length; i++) {
      expect(b.shapes[i].anchors.anchors.length).toBe(
        a.shapes[i].anchors.anchors.length,
      );
    }
    // Geometry stable within rounding tolerance (precision 4).
    expect(maxDeviation(a.shapes, b.shapes)).toBeLessThan(1e-2);
    // Style preserved across the round-trip.
    for (let i = 0; i < a.shapes.length; i++) {
      expect(b.shapes[i].style.fill).toEqual(a.shapes[i].style.fill);
      expect(b.shapes[i].style.stroke).toEqual(a.shapes[i].style.stroke);
    }
  });
});
