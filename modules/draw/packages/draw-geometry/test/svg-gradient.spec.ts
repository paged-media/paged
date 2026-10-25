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

// D-58 (the gradient part, engine ADR 1007): `<linearGradient>` and
// `<radialGradient>` paints resolve into the document frame with each
// stop's colour and `stop-opacity`, through `href` inheritance, both
// gradient units and the shape's own transform; the writer emits them
// back as `userSpaceOnUse` gradients, opacity included.

import { describe, expect, it } from "bun:test";

import { parseSvgDocument, serializeSvgDocument } from "../src";

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100">${body}</svg>`;

describe("SVG gradients [color-swatches.paint-v2]", () => {
  it("a bounding-box linear gradient lands on the shape, stop-opacity kept", () => {
    const doc = parseSvgDocument(
      svg(`<defs><linearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#0080ff"/>
        <stop offset="100%" style="stop-color:#0080ff;stop-opacity:0"/>
      </linearGradient></defs>
      <rect x="20" y="10" width="100" height="50" fill="url(#fade)"/>`),
    )!;
    expect(doc.shapes).toHaveLength(1);
    const style = doc.shapes[0]!.style;
    expect(style.fill).toBe("#0080ff");
    const g = style.fillGradient!;
    expect(g.kind).toBe("linear");
    if (g.kind !== "linear") throw new Error("linear");
    expect(g.start[0]).toBeCloseTo(20);
    expect(g.start[1]).toBeCloseTo(10);
    expect(g.end[0]).toBeCloseTo(120);
    expect(g.stops.map((s) => s.opacity)).toEqual([1, 0]);
    expect(g.stops.map((s) => s.offset)).toEqual([0, 1]);
  });

  it("userSpaceOnUse follows the shape's transform; href lends the stops", () => {
    const doc = parseSvgDocument(
      svg(`<linearGradient id="base"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue" stop-opacity="0.25"/></linearGradient>
      <linearGradient id="g" xlink:href="#base" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="40"/>
      <g transform="translate(50 5)"><rect width="10" height="40" fill="url(#g)"/></g>`),
    )!;
    const g = doc.shapes[0]!.style.fillGradient!;
    if (g.kind !== "linear") throw new Error("linear");
    expect(g.start).toEqual([50, 5]);
    expect(g.end).toEqual([50, 45]);
    expect(g.stops[1]!.opacity).toBe(0.25);
    expect(g.stops[1]!.color).toBe("blue");
  });

  it("a radial gradient resolves its centre and radius", () => {
    const doc = parseSvgDocument(
      svg(`<radialGradient id="r"><stop offset="0" stop-color="white"/><stop offset="1" stop-color="black"/></radialGradient>
      <circle cx="50" cy="50" r="40" fill="url(#r)"/>`),
    )!;
    const g = doc.shapes[0]!.style.fillGradient!;
    if (g.kind !== "radial") throw new Error("radial");
    expect(g.center[0]).toBeCloseTo(50, 1);
    expect(g.center[1]).toBeCloseTo(50, 1);
    expect(g.radius).toBeCloseTo(40, 0);
  });

  it("a url to nothing paints nothing", () => {
    const doc = parseSvgDocument(
      svg(`<rect width="10" height="10" fill="url(#missing)"/>`),
    )!;
    expect(doc.shapes[0]!.style.fill).toBeNull();
  });

  it("the writer emits the gradient back with its opacity, and it re-reads", () => {
    const doc = parseSvgDocument(
      svg(`<linearGradient id="fade"><stop offset="0" stop-color="#0080ff"/><stop offset="1" stop-color="#0080ff" stop-opacity="0"/></linearGradient>
      <rect width="100" height="20" fill="url(#fade)"/>`),
    )!;
    const out = serializeSvgDocument(doc.shapes);
    expect(out).toContain("<linearGradient");
    expect(out).toContain('stop-opacity="0"');
    expect(out).toContain('fill="url(#g1)"');
    const again = parseSvgDocument(out)!;
    const g = again.shapes[0]!.style.fillGradient!;
    if (g.kind !== "linear") throw new Error("linear");
    expect(g.end[0]).toBeCloseTo(100);
    expect(g.stops[1]!.opacity).toBe(0);
  });
});
