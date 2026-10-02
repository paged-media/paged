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

// Property tests for svg-doc.ts — the SVG document reader/writer.

import { describe, expect, it } from "vitest";

import {
  applyAffine,
  parseSvgDocument,
  parseTransform,
  serializeSvgDocument,
  type DrawShape,
  type SvgStyle,
  type Vec2,
} from "../src";
import {
  assertTableClose,
  assertTrue,
  assertVecClose,
  canonicalTable,
  fc,
  smallVec2,
} from "./property-kit";

// ------------------------------------------------- transform functions

type Tf =
  | { fn: "translate"; tx: number; ty: number | null }
  | { fn: "scale"; sx: number; sy: number | null }
  | { fn: "rotate"; deg: number; about: Vec2 | null }
  | { fn: "skewX" | "skewY"; deg: number }
  | { fn: "matrix"; m: [number, number, number, number, number, number] };

const tiny = fc.integer({ min: -6, max: 6 });
const half = fc.integer({ min: -12, max: 12 }).map((n) => n / 2);
const nonZero = half.filter((n) => n !== 0);
const tiltDeg = fc.constantFrom(-60, -45, -30, 0, 15, 30, 45, 60);
const turnDeg = fc.oneof(
  fc.constantFrom(0, 90, 180, 270, -90, 45, 30),
  fc.integer({ min: -360, max: 360 }),
);

const tf: fc.Arbitrary<Tf> = fc.oneof(
  fc.record({
    fn: fc.constant("translate" as const),
    tx: half,
    ty: fc.option(half, { nil: null }),
  }),
  fc.record({
    fn: fc.constant("scale" as const),
    sx: nonZero,
    sy: fc.option(nonZero, { nil: null }),
  }),
  fc.record({
    fn: fc.constant("rotate" as const),
    deg: turnDeg,
    about: fc.option(smallVec2 as fc.Arbitrary<Vec2>, { nil: null }),
  }),
  fc.record({ fn: fc.constantFrom("skewX" as const, "skewY" as const), deg: tiltDeg }),
  fc.record({
    fn: fc.constant("matrix" as const),
    m: fc.tuple(tiny, tiny, tiny, tiny, tiny, tiny),
  }),
);

function renderTf(t: Tf, sep: string): string {
  switch (t.fn) {
    case "translate":
      return `translate(${[t.tx, ...(t.ty === null ? [] : [t.ty])].join(sep)})`;
    case "scale":
      return `scale(${[t.sx, ...(t.sy === null ? [] : [t.sy])].join(sep)})`;
    case "rotate":
      return `rotate(${[t.deg, ...(t.about ?? [])].join(sep)})`;
    case "skewX":
    case "skewY":
      return `${t.fn}(${t.deg})`;
    case "matrix":
      return `matrix(${t.m.join(sep)})`;
  }
}

/** REFERENCE: what each SVG transform function does to a POINT, written
 *  from the SVG definitions — no matrices, no composition. */
function applyTf(t: Tf, p: Vec2): Vec2 {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  switch (t.fn) {
    case "translate":
      return [p[0] + t.tx, p[1] + (t.ty ?? 0)];
    case "scale":
      return [p[0] * t.sx, p[1] * (t.sy ?? t.sx)];
    case "rotate": {
      const c = t.about ?? [0, 0];
      const x = p[0] - c[0];
      const y = p[1] - c[1];
      const cos = Math.cos(rad(t.deg));
      const sin = Math.sin(rad(t.deg));
      return [c[0] + cos * x - sin * y, c[1] + sin * x + cos * y];
    }
    case "skewX":
      return [p[0] + Math.tan(rad(t.deg)) * p[1], p[1]];
    case "skewY":
      return [p[0], p[1] + Math.tan(rad(t.deg)) * p[0]];
    case "matrix":
      return [
        t.m[0] * p[0] + t.m[2] * p[1] + t.m[4],
        t.m[1] * p[0] + t.m[3] * p[1] + t.m[5],
      ];
  }
}

/** A transform LIST applies right-to-left: the rightmost function is the
 *  innermost (closest to the geometry). */
const applyList = (list: readonly Tf[], p: Vec2): Vec2 =>
  [...list].reverse().reduce((q, t) => applyTf(t, q), p);

// ----------------------------------------------------------- documents

const colour = fc.oneof(
  fc.constantFrom("red", "#ff8000", "#abc", "rgb(1, 2, 3)", "black"),
  fc
    .array(fc.constantFrom(..."0123456789abcdef"), { minLength: 6, maxLength: 6 })
    .map((d) => `#${d.join("")}`),
);
const paint = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  colour,
);

const style: fc.Arbitrary<SvgStyle> = fc
  .record({
    fill: paint,
    stroke: paint,
    strokeWidth: fc.option(
      fc.integer({ min: 0, max: 400 }).map((n) => n / 8),
      { nil: undefined },
    ),
    fillRule: fc.constantFrom(undefined, "nonzero" as const, "evenodd" as const),
  })
  .map((s) => {
    // Drop the keys that are `undefined`, the way the reader reports a
    // property that was never set.
    const out: SvgStyle = {};
    if (s.fill !== undefined) out.fill = s.fill;
    if (s.stroke !== undefined) out.stroke = s.stroke;
    if (s.strokeWidth !== undefined) out.strokeWidth = s.strokeWidth;
    if (s.fillRule !== undefined) out.fillRule = s.fillRule;
    return out;
  });

const shape: fc.Arbitrary<DrawShape> = fc.record({ anchors: canonicalTable, style });

describe("svg-doc — parseTransform (properties)", () => {
  it("each function does to a point what the SVG definition says", () => {
    fc.assert(
      fc.property(tf, smallVec2, fc.constantFrom(" ", ",", ", ", "  "), (t, p, sep) => {
        const m = parseTransform(renderTf(t, sep));
        assertVecClose(applyAffine(m, p[0], p[1]), applyTf(t, p), 1e-9 * 1000);
      }),
    );
  });

  it("a list composes LEFT-TO-RIGHT as outer-to-inner (the rightmost touches the geometry first)", () => {
    fc.assert(
      fc.property(
        fc.array(tf, { maxLength: 5 }),
        smallVec2,
        fc.constantFrom(" ", "", ", ", "\n"),
        (list, p, between) => {
          const m = parseTransform(list.map((t) => renderTf(t, " ")).join(between));
          const expected = applyList(list, p);
          const size = Math.max(1, Math.abs(expected[0]), Math.abs(expected[1]));
          assertVecClose(applyAffine(m, p[0], p[1]), expected, 1e-6 * size);
        },
      ),
    );
  });

  it("rotate(a cx cy) fixes its centre", () => {
    fc.assert(
      fc.property(turnDeg, smallVec2, (deg, c) => {
        const m = parseTransform(`rotate(${deg} ${c[0]} ${c[1]})`);
        assertVecClose(applyAffine(m, c[0], c[1]), c, 1e-9);
      }),
    );
  });

  it("nothing recognisable is the identity", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("", "   ", "none", "frobnicate(1 2 3)", "matrix(1 2 3)", "42"),
        smallVec2,
        (text, p) => {
          assertVecClose(applyAffine(parseTransform(text), p[0], p[1]), p, 0);
        },
      ),
    );
  });

  // ------------------------------------------------------------------
  // DEFECT (svg-doc.ts — parseTransform and parsePoints) — numbers
  // separated only by a SIGN are fused, and the second one is lost.
  //
  // Both split their argument text on `/[\s,]+/` and `parseFloat` each
  // piece. SVG's number-list grammar (the same one the path parser in
  // svg-path.ts implements correctly) lets a `-` start the next number
  // with no separator: `10-5` is the two numbers 10 and −5. Here it is
  // ONE piece, and `parseFloat("10-5")` is 10.
  //
  //   parseTransform("translate(10-5)")
  //   EXPECTED: [1, 0, 0, 1, 10, -5]
  //   ACTUAL:   [1, 0, 0, 1, 10, 0]   — the y offset is dropped.
  //
  //   <polygon points="0,0 10-5 20,0"/>
  //   EXPECTED: three anchors (0,0) (10,−5) (20,0)
  //   ACTUAL:   TWO anchors (0,0) (10,20) — one number is swallowed and
  //             every later coordinate changes partner.
  //
  // Minified SVG writes exactly this form whenever a coordinate is
  // negative.
  // ------------------------------------------------------------------
  it.fails("DEFECT (minimal counterexample): translate(10-5) is a translation by (10, −5)", () => {
    expect(parseTransform("translate(10-5)")).toEqual([1, 0, 0, 1, 10, -5]);
  });

  it.fails("DEFECT (minimal counterexample): a polygon's points may be separated by a sign alone", () => {
    const doc = parseSvgDocument('<svg><polygon points="0,0 10-5 20,0"/></svg>');
    expect(doc!.shapes[0].anchors.anchors.map((a) => a.anchor)).toEqual([
      [0, 0],
      [10, -5],
      [20, 0],
    ]);
  });

  it.fails("DEFECT: property — a transform's arguments need no separator before a minus sign", () => {
    fc.assert(
      fc.property(tiny, fc.integer({ min: -9, max: -1 }), (tx, ty) => {
        expect(parseTransform(`translate(${tx}${ty})`)).toEqual(
          parseTransform(`translate(${tx} ${ty})`),
        );
      }),
    );
  });
});

describe("svg-doc — write → read round trip (properties)", () => {
  it("every shape comes back with the same anchors, contours, open flags and style", () => {
    fc.assert(
      fc.property(fc.array(shape, { maxLength: 4 }), (shapes) => {
        const doc = parseSvgDocument(serializeSvgDocument(shapes));
        assertTrue(doc !== null, "the writer's own output has no <svg> root");
        expect(doc!.shapes).toHaveLength(shapes.length);
        shapes.forEach((s, i) => {
          assertTableClose(doc!.shapes[i].anchors, s.anchors, 0, `shape ${i}`);
          expect(doc!.shapes[i].style).toEqual(s.style);
        });
      }),
    );
  });

  it("the viewport is origin-anchored: width/height reach the artwork's far edge, the viewBox restates them", () => {
    fc.assert(
      fc.property(fc.array(shape, { maxLength: 4 }), (shapes) => {
        const doc = parseSvgDocument(serializeSvgDocument(shapes))!;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const s of shapes) {
          for (const a of s.anchors.anchors) {
            for (const p of [a.anchor, a.left, a.right]) {
              maxX = Math.max(maxX, p[0]);
              maxY = Math.max(maxY, p[1]);
            }
          }
        }
        const width = Number.isFinite(maxX) ? Math.max(1, Math.ceil(maxX)) : 1;
        const height = Number.isFinite(maxY) ? Math.max(1, Math.ceil(maxY)) : 1;
        expect(doc.width).toBe(width);
        expect(doc.height).toBe(height);
        expect(doc.viewBox).toEqual([0, 0, width, height]);
      }),
    );
  });

  it("an explicit size wins over the derived one — either dimension on its own, or both", () => {
    const dim = fc.integer({ min: 1, max: 5000 });
    fc.assert(
      fc.property(
        fc.array(shape, { maxLength: 2 }),
        fc.option(dim, { nil: undefined }),
        fc.option(dim, { nil: undefined }),
        (shapes, width, height) => {
          const derived = parseSvgDocument(serializeSvgDocument(shapes))!;
          const doc = parseSvgDocument(serializeSvgDocument(shapes, { width, height }))!;
          const w = width ?? derived.width;
          const h = height ?? derived.height;
          expect([doc.width, doc.height]).toEqual([w, h]);
          expect(doc.viewBox).toEqual([0, 0, w, h]);
        },
      ),
    );
  });

  it("a paint string survives the attribute escaping, whatever it contains", () => {
    // Free text, plus strings that LOOK like entities already: an
    // unescaped `&` only shows when what follows it is entity-shaped.
    const text = fc
      .oneof(
        fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 20 }),
        fc
          .array(fc.constantFrom("&amp;", "&lt;", "&gt;", "&quot;", "&#38;", "&", "<", ">", '"', "'", "a", "#"), {
            minLength: 1,
            maxLength: 6,
          })
          .map((parts) => parts.join("")),
      )
      .filter((s) => {
        const t = s.trim().toLowerCase();
        return t === s.toLowerCase() && t !== "" && t !== "none" && t !== "transparent";
      });
    fc.assert(
      fc.property(canonicalTable, text, text, (anchors, fill, stroke) => {
        const doc = parseSvgDocument(
          serializeSvgDocument([{ anchors, style: { fill, stroke } }]),
        )!;
        expect(doc.shapes).toHaveLength(1);
        expect(doc.shapes[0].style).toEqual({ fill, stroke });
      }),
    );
  });
});

describe("svg-doc — reading (properties)", () => {
  it("nested <g> transforms are flattened into the anchors, outermost applied last", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(tf, { minLength: 1, maxLength: 2 }), { maxLength: 3 }),
        fc.array(smallVec2, { minLength: 2, maxLength: 5 }),
        (groups, pts) => {
          const d = `M ${pts.map((p) => `${p[0]} ${p[1]}`).join(" L ")}`;
          const open = groups
            .map((g) => `<g transform="${g.map((t) => renderTf(t, " ")).join(" ")}">`)
            .join("");
          const close = groups.map(() => "</g>").join("");
          const doc = parseSvgDocument(`<svg>${open}<path d="${d}"/>${close}</svg>`)!;
          expect(doc.shapes).toHaveLength(1);
          const all = groups.flat();
          doc.shapes[0].anchors.anchors.forEach((a, i) => {
            const expected = applyList(all, pts[i]);
            const size = Math.max(1, Math.abs(expected[0]), Math.abs(expected[1]));
            assertVecClose(a.anchor, expected, 1e-6 * size, `anchor ${i}`);
          });
        },
      ),
    );
  });

  it("style inherits down the tree; the nearest declaration wins; `style=\"\"` beats the attribute", () => {
    fc.assert(
      fc.property(
        fc.option(colour, { nil: undefined }),
        fc.option(colour, { nil: undefined }),
        fc.option(colour, { nil: undefined }),
        (onGroup, onPathAttr, onPathStyle) => {
          const attr = (name: string, v: string | undefined) =>
            v === undefined ? "" : ` ${name}="${v}"`;
          const doc = parseSvgDocument(
            `<svg><g${attr("fill", onGroup)}>` +
              `<path d="M 0 0 L 1 1"${attr("fill", onPathAttr)}` +
              `${onPathStyle === undefined ? "" : ` style="fill: ${onPathStyle}"`}/>` +
              `</g></svg>`,
          )!;
          expect(doc.shapes[0].style.fill).toBe(onPathStyle ?? onPathAttr ?? onGroup);
        },
      ),
    );
  });

  it("a path, rect, circle or ellipse that lowers to no geometry yields no shape — never an empty one", () => {
    const junk = fc.string({ unit: fc.constantFrom(..."xyz,; -"), maxLength: 8 });
    fc.assert(
      fc.property(junk, smallVec2, (d, p) => {
        const doc = parseSvgDocument(
          `<svg><path d="${d}"/><rect x="${p[0]}" y="${p[1]}" width="0" height="5"/>` +
            `<circle cx="${p[0]}" cy="${p[1]}" r="0"/><ellipse rx="3" ry="-1"/>` +
            `<path d="M 1 2 L 3 4"/></svg>`,
        )!;
        // Only the last element draws anything.
        expect(doc.shapes).toHaveLength(1);
        expect(doc.shapes[0].anchors.anchors).toHaveLength(2);
      }),
    );
  });

  // ------------------------------------------------------------------
  // DEFECT (svg-doc.ts, shapeFromElement) — a `<polygon>` / `<polyline>`
  // with fewer than two points is emitted as a shape with NO anchors.
  //
  // `path`, `rect`, `circle` and `ellipse` all end in
  // `return t.anchors.length ? t : null`, so an element that lowers to
  // nothing is skipped (the property above). The two `poly*` cases return
  // `polyToPath(...)` directly, and `polyToPath` answers an EMPTY table
  // for fewer than two points — which is then pushed as a shape.
  //
  // Minimal counterexample: <svg><polygon points="5,5"/></svg>
  //   EXPECTED: shapes = []
  //   ACTUAL:   one shape, { anchors: [], subpathStarts: [], subpathOpen: [] }
  // (`<polyline/>` with no `points` at all does the same.)
  //
  // Consumer: draw-bundle's SVG importer reports "no shapes in <file>"
  // only when `shapes.length === 0`; a file holding just such an element
  // skips that warning, and its log line counts a shape that has no
  // geometry.
  // ------------------------------------------------------------------
  it.fails("DEFECT (minimal counterexample): a one-point polygon is not a shape", () => {
    expect(parseSvgDocument('<svg><polygon points="5,5"/></svg>')!.shapes).toEqual([]);
  });

  it.fails("DEFECT: a polyline with no points is not a shape", () => {
    expect(parseSvgDocument("<svg><polyline/></svg>")!.shapes).toEqual([]);
  });

  it("never throws on junk; without an <svg> root the answer is null", () => {
    const soup = fc.string({
      unit: fc.constantFrom(..."<>/=\"' !?-[]&;#svgpathdMLZ0123456789.,"),
      maxLength: 60,
    });
    fc.assert(
      fc.property(soup, (text) => {
        const doc = parseSvgDocument(text);
        if (!/<\s*([a-z]+:)?svg/i.test(text)) expect(doc).toBeNull();
        if (doc !== null) {
          for (const s of doc.shapes) {
            assertTrue(s.anchors.anchors.length > 0, "an empty shape was emitted");
          }
        }
      }),
    );
  });
});
