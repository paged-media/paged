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

// Property tests for svg-color.ts — CSS/SVG colour ⇄ RGB. The forms the
// module supports are `#rgb`, `#rrggbb`, `rgb()` / `rgba()` (comma or
// space separated, numbers or percentages) and twenty keywords; each
// round-trips below. The module's stated contract for everything else is
// "resolves to `null` — never a throw", and the defect block at the end
// is where that contract did not hold until it was fixed.

import { describe, expect, it } from "vitest";

import { cmykToRgb, parseCssColor, rgbToHex, type Rgb } from "../src";
import {
  assertTrue,
  fc,
  real,
} from "./property-kit";

const channel = fc.integer({ min: 0, max: 255 });
const rgb: fc.Arbitrary<Rgb> = fc.tuple(channel, channel, channel);

const HEX_DIGITS = "0123456789abcdef".split("");
const hexDigit = fc.constantFrom(...HEX_DIGITS);

/** Random letter case and random surrounding whitespace — neither may
 *  change the answer. */
const dressed = (s: fc.Arbitrary<string>): fc.Arbitrary<string> =>
  fc
    .tuple(
      s,
      fc.array(fc.boolean(), { minLength: 40, maxLength: 40 }),
      fc.constantFrom("", " ", "\t", "\n  "),
      fc.constantFrom("", " ", "\n"),
    )
    .map(
      ([text, upper, lead, trail]) =>
        lead +
        [...text].map((ch, i) => (upper[i % upper.length] ? ch.toUpperCase() : ch)).join("") +
        trail,
    );

const KEYWORDS: Record<string, Rgb> = {
  black: [0, 0, 0],
  silver: [192, 192, 192],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  white: [255, 255, 255],
  maroon: [128, 0, 0],
  red: [255, 0, 0],
  purple: [128, 0, 128],
  fuchsia: [255, 0, 255],
  magenta: [255, 0, 255],
  green: [0, 128, 0],
  lime: [0, 255, 0],
  olive: [128, 128, 0],
  yellow: [255, 255, 0],
  navy: [0, 0, 128],
  blue: [0, 0, 255],
  teal: [0, 128, 128],
  aqua: [0, 255, 255],
  cyan: [0, 255, 255],
  orange: [255, 165, 0],
};

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

/** A well-formed answer: `null`, or three integers in 0..255. */
function isWellFormed(value: unknown): boolean {
  if (value === null) return true;
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  );
}

describe("svg-color — round trips (properties)", () => {
  it("rgbToHex → parseCssColor is the identity on 8-bit triples", () => {
    fc.assert(
      fc.property(rgb, (c) => {
        expect(parseCssColor(rgbToHex(c))).toEqual(c);
      }),
    );
  });

  it("parseCssColor → rgbToHex is the identity on canonical #rrggbb", () => {
    fc.assert(
      fc.property(
        fc.array(hexDigit, { minLength: 6, maxLength: 6 }).map((d) => `#${d.join("")}`),
        (hex) => {
          const parsed = parseCssColor(hex);
          assertTrue(parsed !== null, `${hex} did not parse`);
          expect(rgbToHex(parsed!)).toBe(hex);
        },
      ),
    );
  });

  it("rgbToHex always emits lowercase #rrggbb, rounding and clamping finite input", () => {
    const loose = real(-1000, 1000);
    fc.assert(
      fc.property(loose, loose, loose, (r, g, b) => {
        const hex = rgbToHex([r, g, b]);
        assertTrue(/^#[0-9a-f]{6}$/.test(hex), `not a #rrggbb string: ${hex}`);
        expect(parseCssColor(hex)).toEqual([clamp255(r), clamp255(g), clamp255(b)]);
      }),
    );
  });

  it("#rgb is #rrggbb with every digit doubled", () => {
    fc.assert(
      fc.property(hexDigit, hexDigit, hexDigit, (r, g, b) => {
        const short = parseCssColor(`#${r}${g}${b}`);
        expect(short).toEqual(parseCssColor(`#${r}${r}${g}${g}${b}${b}`));
        expect(short).toEqual([r, g, b].map((d) => parseInt(d, 16) * 17));
      }),
    );
  });

  it("rgb()/rgba() in every separator style reads back its three components", () => {
    const style = fc.constantFrom(
      (c: Rgb) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`,
      (c: Rgb) => `rgb(${c[0]},${c[1]},${c[2]})`,
      (c: Rgb) => `rgb(${c[0]} ${c[1]} ${c[2]})`,
      (c: Rgb) => `rgb( ${c[0]}  ${c[1]}  ${c[2]} )`,
      (c: Rgb) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.5)`,
      (c: Rgb) => `rgb(${c[0]} ${c[1]} ${c[2]} / 50%)`,
      (c: Rgb) => `rgba(${c[0]} ${c[1]} ${c[2]} / 0.25)`,
    );
    fc.assert(
      fc.property(rgb, style, (c, format) => {
        expect(parseCssColor(format(c))).toEqual(c);
      }),
    );
  });

  it("rgb() rounds fractional components and clamps out-of-range ones", () => {
    const loose = real(-500, 800);
    fc.assert(
      fc.property(loose, loose, loose, (r, g, b) => {
        // `toFixed` keeps the text free of exponents, which CSS numbers
        // do allow but a hand-authored SVG never contains.
        const text = `rgb(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)})`;
        expect(parseCssColor(text)).toEqual(
          [r, g, b].map((n) => clamp255(Number(n.toFixed(4)))),
        );
      }),
    );
  });

  it("rgb() percentages are fractions of 255", () => {
    const pct = fc.integer({ min: 0, max: 100 });
    fc.assert(
      fc.property(pct, pct, pct, (r, g, b) => {
        expect(parseCssColor(`rgb(${r}%, ${g}%, ${b}%)`)).toEqual(
          [r, g, b].map((p) => clamp255((p / 100) * 255)),
        );
      }),
    );
  });

  it("every keyword parses to its table value, and survives the hex round trip", () => {
    fc.assert(
      fc.property(fc.constantFrom(...Object.keys(KEYWORDS)), (name) => {
        const parsed = parseCssColor(name);
        expect(parsed).toEqual(KEYWORDS[name]);
        expect(parseCssColor(rgbToHex(parsed!))).toEqual(KEYWORDS[name]);
      }),
    );
  });

  it("letter case and surrounding whitespace never change the answer", () => {
    const sample = fc.oneof(
      rgb.map(rgbToHex),
      rgb.map((c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`),
      fc.constantFrom(...Object.keys(KEYWORDS), "none", "transparent"),
    );
    fc.assert(
      fc.property(
        sample.chain((plain) => fc.tuple(fc.constant(plain), dressed(fc.constant(plain)))),
        ([plain, noisy]) => {
          expect(parseCssColor(noisy)).toEqual(parseCssColor(plain));
        },
      ),
    );
  });

  it("`none`, `transparent` and blank are no paint", () => {
    fc.assert(
      fc.property(dressed(fc.constantFrom("none", "transparent", "")), (text) => {
        expect(parseCssColor(text)).toBeNull();
      }),
    );
  });
});

describe("svg-color — cmykToRgb (properties)", () => {
  const ink = real(0, 100);

  it("answers an 8-bit triple for any ink values, in range or not", () => {
    const any = real(-300, 300);
    fc.assert(
      fc.property(any, any, any, any, (c, m, y, k) => {
        assertTrue(isWellFormed(cmykToRgb(c, m, y, k)), "not an 8-bit triple");
      }),
    );
  });

  it("more ink is never lighter: every channel is monotone non-increasing", () => {
    fc.assert(
      fc.property(ink, ink, ink, ink, ink, fc.integer({ min: 0, max: 3 }), (c, m, y, k, more, which) => {
        const a: [number, number, number, number] = [c, m, y, k];
        const b: [number, number, number, number] = [c, m, y, k];
        b[which] = Math.max(a[which], more);
        const lighter = cmykToRgb(...a);
        const darker = cmykToRgb(...b);
        for (let i = 0; i < 3; i++) {
          assertTrue(
            darker[i] <= lighter[i],
            `channel ${i} got lighter (${lighter[i]} → ${darker[i]}) with more ink`,
          );
        }
      }),
    );
  });

  it("C, M and Y each touch exactly their own complement; K touches all three alike", () => {
    fc.assert(
      fc.property(ink, ink, (amount, k) => {
        const [r, g, b] = cmykToRgb(amount, 0, 0, 0);
        expect([g, b]).toEqual([255, 255]);
        expect(cmykToRgb(0, amount, 0, 0)).toEqual([255, r, 255]);
        expect(cmykToRgb(0, 0, amount, 0)).toEqual([255, 255, r]);
        const gray = cmykToRgb(0, 0, 0, k);
        expect(gray[0]).toBe(gray[1]);
        expect(gray[1]).toBe(gray[2]);
      }),
    );
  });

  it("is the product of the ink and black coverages, to the rounding", () => {
    fc.assert(
      fc.property(ink, ink, ink, ink, (c, m, y, k) => {
        const out = cmykToRgb(c, m, y, k);
        [c, m, y].forEach((v, i) => {
          const exact = 255 * (1 - v / 100) * (1 - k / 100);
          assertTrue(
            Math.abs(out[i] - exact) <= 0.5 + 1e-9,
            `channel ${i}: ${out[i]} is not ${exact} rounded`,
          );
        });
      }),
    );
  });
});

// --------------------------------------------------------------------
// DEFECTS (svg-color.ts, parseCssColor) — "Anything else resolves to
// `null` (the caller decides the fallback — never a throw)" is the
// module's contract, and its return type is `Rgb | null` with `Rgb`
// documented as 0–255. Four input classes broke it — ALL FIXED. Each has
// its minimal counterexample, and the last test states the contract as
// one property over all of them.
//
// (1) INVALID HEX WAS ACCEPTED. `parseInt(pair, 16)` stops at the first
//     non-hex character instead of rejecting it, so any pair that STARTS
//     with a hex digit parsed.
//       parseCssColor("#00000g")  EXPECTED null   WAS [0, 0, 0]
//       parseCssColor("# 1 2 3")  EXPECTED null   WAS [1, 2, 3]
//     (The 3-digit form was immune by accident: each digit is doubled,
//     and "gg" has no leading hex digit.)
//
// (2) A HEX CHANNEL COULD BE NEGATIVE. `parseInt` also reads a sign.
//       parseCssColor("#-1-1-1")  EXPECTED null   WAS [-1, -1, -1]
//     — a value outside the documented 0–255 range, from the one branch
//     that never clamps.
//
// (3) rgb() WITH A NON-NUMERIC COMPONENT ANSWERED NaN. `parseFloat` gives
//     NaN, and `clamp255(NaN)` is NaN (`Math.min`/`Math.max` propagate
//     it).
//       parseCssColor("rgb(a, b, c)")    EXPECTED null  WAS [NaN, NaN, NaN]
//       parseCssColor("rgb(none 0 0)")   EXPECTED null  WAS [NaN, 0, 0]
//     and `rgbToHex` of that is "#NaNNaNNaN" — which the SVG importer
//     would then have written into a document as a colour.
//
// (4) A KEYWORD LOOKUP WALKED THE PROTOTYPE CHAIN. `NAMED[s] ?? null` on
//     a plain object literal finds `Object.prototype` members.
//       parseCssColor("constructor")  EXPECTED null  WAS [Function: Object]
//       parseCssColor("__proto__")    EXPECTED null  WAS Object.prototype
//     Neither is `null`, and neither is an RGB triple; a caller that
//     destructures `[r, g, b]` throws on the first and reads three
//     `undefined`s from the second.
//
// (5) Observed beside them and fixed with them: any text that merely
//     STARTED with "rgb" was read as the function — "rgbfoo(1,2,3)"
//     answered [1, 2, 3].
//
// THE FIX is one idea applied four times: VALIDATE against the grammar,
// then convert. `parseInt` / `parseFloat` are prefix parsers, so
// "convert, then look for NaN" accepts any text with a numeric prefix;
// the hex body is now matched as three or six hex digits, each rgb()
// component as a CSS number or percentage, the function name as exactly
// `rgb` / `rgba`, and the keyword table is a `Map`.
// --------------------------------------------------------------------
describe("svg-color — DEFECTS in parseCssColor", () => {
  it("FIXED DEFECT (1): a 6-digit hex with a non-hex character is null", () => {
    expect(parseCssColor("#00000g")).toBeNull();
    expect(parseCssColor("# 1 2 3")).toBeNull();
    expect(parseCssColor("#12345x")).toBeNull();
    expect(parseCssColor("#0x1122")).toBeNull();
  });

  it("FIXED DEFECT (1): property — any 6-character hex body that is not all hex digits is null", () => {
    const junk = fc.constantFrom("g", "z", " ", "-", "+", "x", ".");
    fc.assert(
      fc.property(
        fc.array(fc.oneof(hexDigit, junk), { minLength: 6, maxLength: 6 }),
        (chars) => {
          const body = chars.join("");
          fc.pre(!/^[0-9a-f]{6}$/.test(body));
          // Leading/trailing blanks are trimmed away and change the
          // LENGTH, which is rejected correctly; keep the body intact.
          fc.pre(body.trim() === body);
          expect(parseCssColor(`#${body}`)).toBeNull();
        },
      ),
    );
  });

  it("FIXED DEFECT (2): a hex colour never has a negative channel", () => {
    const parsed = parseCssColor("#-1-1-1");
    expect(isWellFormed(parsed)).toBe(true);
    expect(parsed).toBeNull();
    expect(parseCssColor("#+1+1+1")).toBeNull();
    expect(parseCssColor("#-12")).toBeNull();
  });

  it("FIXED DEFECT (3): rgb() with non-numeric components is null, not NaN", () => {
    expect(parseCssColor("rgb(a, b, c)")).toBeNull();
    // A numeric PREFIX is not a number either: `parseFloat("12px")` is 12.
    expect(parseCssColor("rgb(12px, 0, 0)")).toBeNull();
    expect(parseCssColor("rgb(1, 2, %)")).toBeNull();
    expect(parseCssColor("rgb(infinity, 0, 0)")).toBeNull();
    // What IS a CSS number still reads: a sign, a bare fraction, an
    // exponent, a trailing dot-less percentage.
    expect(parseCssColor("rgb(+1, .6, 1e2)")).toEqual([1, 1, 100]);
    expect(parseCssColor("rgb(1E2 0 0)")).toEqual([100, 0, 0]);
  });

  it("FIXED DEFECT (3): what it returns always formats as a #rrggbb string", () => {
    const parsed = parseCssColor("rgb(none 0 0)");
    // Either null (the contract) or a colour that formats.
    expect(parsed === null || /^#[0-9a-f]{6}$/.test(rgbToHex(parsed))).toBe(true);
    expect(parsed).toBeNull();
  });

  it("FIXED DEFECT (4): an Object.prototype member name is not a colour keyword", () => {
    expect(parseCssColor("constructor")).toBeNull();
    for (const name of ["valueOf", "toString", "hasOwnProperty", "isPrototypeOf", "toLocaleString"]) {
      expect(parseCssColor(name)).toBeNull();
    }
  });

  it("FIXED DEFECT (4): `__proto__` is not a colour keyword", () => {
    expect(parseCssColor("__proto__")).toBeNull();
  });

  it("FIXED DEFECT (5): only `rgb(` and `rgba(` are the function — a longer name is not a colour", () => {
    expect(parseCssColor("rgbfoo(1,2,3)")).toBeNull();
    expect(parseCssColor("rgbaa(1,2,3)")).toBeNull();
    expect(parseCssColor("rgb1(1,2,3)")).toBeNull();
    expect(parseCssColor("rgb")).toBeNull();
    // The two real names still read, alpha or not, and what follows the
    // closing parenthesis is still not looked at (`!important`).
    expect(parseCssColor("rgb(1,2,3)")).toEqual([1, 2, 3]);
    expect(parseCssColor("rgba(1,2,3)")).toEqual([1, 2, 3]);
    expect(parseCssColor("rgb(1,2,3) !important")).toEqual([1, 2, 3]);
  });

  it("FIXED DEFECT: property — for ANY string the answer is null or three integers in 0..255", () => {
    const hostile = fc.oneof(
      fc.string(),
      fc.array(fc.constantFrom(...HEX_DIGITS, "g", "-", "+", " "), {
        minLength: 6,
        maxLength: 6,
      }).map((c) => `#${c.join("")}`),
      fc.array(fc.constantFrom("1", "2", "a", "none", "%", "-", "e"), {
        minLength: 3,
        maxLength: 4,
      }).map((parts) => `rgb(${parts.join(", ")})`),
      fc.constantFrom("constructor", "__proto__", "valueOf", "toString"),
    );
    fc.assert(
      fc.property(hostile, (text) => {
        const parsed: unknown = parseCssColor(text);
        assertTrue(
          isWellFormed(parsed),
          `parseCssColor(${JSON.stringify(text)}) answered ${String(parsed)}`,
        );
      }),
    );
  });
});
