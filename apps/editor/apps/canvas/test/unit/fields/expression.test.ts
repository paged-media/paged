/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// The one numeric parser (packages/ui inputs/expression.ts): units, the four
// operations, brackets, relative entries, mixed units resolved to the
// field's unit, the locale's decimal comma, and typed errors. Property-style:
// a seeded generator writes hundreds of expressions whose value is known.

import { describe, expect, test } from "bun:test";

import {
  applyRelative,
  decimalSeparator,
  parseNumericExpression,
  parseLengthText,
  POINTS_PER_UNIT,
  type ExpressionOptions,
  type LengthUnit,
} from "@paged-media/ui";

const UNITS: LengthUnit[] = ["pt", "pc", "px", "mm", "cm", "in"];

/** A small deterministic PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const value = (text: string, opts: ExpressionOptions = {}) => {
  const r = parseNumericExpression(text, opts);
  if (!r.ok) throw new Error(`${text}: ${JSON.stringify(r.error)}`);
  return r.value;
};
const error = (text: string, opts: ExpressionOptions = {}) => {
  const r = parseNumericExpression(text, opts);
  if (r.ok) throw new Error(`${text} parsed as ${r.value}`);
  return r.error;
};

/** A number with up to two decimals, written plainly. */
const num = (r: () => number, max = 500) => Math.round(r() * max * 100) / 100;

describe("UXI-PNL-009 — one parser: numbers, units, operations @uxi:UXI-PNL-002", () => {
  test("a bare number is in the field's unit; a typed unit converts", () => {
    expect(value("12", { unit: "pt" })).toBe(12);
    expect(value("10", { unit: "mm" })).toBe(10);
    expect(value("10 mm", { unit: "pt" })).toBeCloseTo(28.3465, 4);
    expect(value("1in", { unit: "mm" })).toBeCloseTo(25.4, 9);
    expect(value('1"', { unit: "pt" })).toBe(72);
    expect(value("6p", { unit: "pt" })).toBe(72);
    expect(value("6p3", { unit: "pt" })).toBe(75);
    expect(value("1 pc", { unit: "pt" })).toBe(12);
    expect(value("2 cm", { unit: "mm" })).toBeCloseTo(20, 9);
  });

  test("the four operations, precedence and brackets", () => {
    expect(value("1 + 2 * 3")).toBe(7);
    expect(value("(1 + 2) * 3")).toBe(9);
    expect(value("10 / 4")).toBe(2.5);
    expect(value("10 − 4")).toBe(6);
    expect(value("3 × 4 ÷ 2")).toBe(6);
    expect(value("-(2 + 3)")).toBe(-5);
    expect(value("((2))")).toBe(2);
    expect(value("(10 + 2) mm", { unit: "pt" })).toBeCloseTo(
      12 * POINTS_PER_UNIT.mm,
      9,
    );
  });

  test("mixed units resolve to the field's unit, deterministically", () => {
    // 10 mm + 2 pt in a point field and in a millimetre field.
    expect(value("10 mm + 2 pt", { unit: "pt" })).toBeCloseTo(30.3465, 4);
    expect(value("10 mm + 2 pt", { unit: "mm" })).toBeCloseTo(10.70556, 5);
    // A bare number beside a length is in the field's unit.
    expect(value("10 + 2 pt", { unit: "mm" })).toBeCloseTo(10.70556, 5);
    // A length times a number is a length; a length over a length a ratio.
    expect(value("10 mm * 2", { unit: "mm" })).toBeCloseTo(20, 9);
    expect(value("20 mm / 10 mm", { unit: "mm" })).toBeCloseTo(2, 9);
    for (let i = 0; i < 3; i++)
      expect(value("1in - 1cm + 6p", { unit: "mm" })).toBe(
        value("1in - 1cm + 6p", { unit: "mm" }),
      );
  });

  test("property: a + b in any two units equals the sum through points", () => {
    const r = rng(0xf11);
    for (let i = 0; i < 400; i++) {
      const [ua, ub, uf] = [0, 0, 0].map(
        () => UNITS[Math.floor(r() * UNITS.length)]!,
      );
      const a = num(r);
      const b = num(r);
      const op = r() < 0.5 ? "+" : "-";
      const got = value(`${a} ${ua} ${op} ${b}${ub}`, { unit: uf });
      const pt =
        a * POINTS_PER_UNIT[ua] +
        (op === "+" ? 1 : -1) * b * POINTS_PER_UNIT[ub];
      expect(got!).toBeCloseTo(pt / POINTS_PER_UNIT[uf], 6);
    }
  });

  test("property: addition commutes and a bracket changes nothing alone", () => {
    const r = rng(0xbeef);
    for (let i = 0; i < 300; i++) {
      const uf = UNITS[Math.floor(r() * UNITS.length)]!;
      const a = `${num(r)} ${UNITS[Math.floor(r() * UNITS.length)]!}`;
      const b = `${num(r)}`;
      expect(value(`${a} + ${b}`, { unit: uf })!).toBeCloseTo(
        value(`${b} + ${a}`, { unit: uf })!,
        9,
      );
      expect(value(`(${a}) + ${b}`, { unit: uf })!).toBeCloseTo(
        value(`${a} + ${b}`, { unit: uf })!,
        9,
      );
    }
  });

  test("property: precedence matches arithmetic on bare numbers", () => {
    const r = rng(42);
    for (let i = 0; i < 300; i++) {
      const [a, b, c] = [num(r, 50) + 1, num(r, 50) + 1, num(r, 50) + 1];
      expect(value(`${a} + ${b} * ${c}`)!).toBeCloseTo(a + b * c, 9);
      expect(value(`${a} - ${b} / ${c}`)!).toBeCloseTo(a - b / c, 9);
      expect(value(`(${a} + ${b}) * ${c}`)!).toBeCloseTo((a + b) * c, 9);
    }
  });

  test("property: a shown value reads back as itself in every unit", () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const u = UNITS[Math.floor(r() * UNITS.length)]!;
      const v = num(r, 2000);
      expect(value(String(v), { unit: u })).toBe(v);
      expect(value(`${v} ${u}`, { unit: u })!).toBeCloseTo(v, 9);
    }
  });
});

describe("UXI-PNL-009 — relative entries @uxi:UXI-PNL-010", () => {
  test("+= -= *= /= and a leading factor apply to the current value", () => {
    expect(value("+=5", { unit: "mm", current: 10 })).toBe(15);
    expect(value("-= 2", { unit: "mm", current: 10 })).toBe(8);
    expect(value("*=1.5", { current: 10 })).toBe(15);
    expect(value("/=4", { current: 10 })).toBe(2.5);
    expect(value("*110%", { unit: "mm", current: 50 })).toBeCloseTo(55, 9);
    expect(value("/2", { current: 9 })).toBe(4.5);
    expect(value("+=10%", { unit: "pt", current: 200 })).toBeCloseTo(220, 9);
    expect(value("+=5 mm", { unit: "pt", current: 10 })).toBeCloseTo(
      10 + 5 * POINTS_PER_UNIT.mm,
      9,
    );
  });

  test("in a percentage field, +=10% is ten points and *110% a factor", () => {
    expect(value("+=10%", { unit: "%", current: 50 })).toBe(60);
    expect(value("*110%", { unit: "%", current: 50 })).toBeCloseTo(55, 9);
    expect(value("50%", { unit: "%" })).toBe(50);
  });

  test("without a current value the edit is returned to apply per object", () => {
    const r = parseNumericExpression("+=5 mm", { unit: "mm", current: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBeNull();
    expect(r.relative).toEqual({ op: "+", operand: 5, percent: false });
    expect([10, 20, 35].map((c) => applyRelative(r.relative!, c))).toEqual([
      15, 25, 40,
    ]);
    const scale = parseNumericExpression("*110%", { unit: "mm" });
    if (!scale.ok) throw new Error("scale");
    expect(applyRelative(scale.relative!, 100)).toBeCloseTo(110, 9);
  });

  test("property: += then -= the same operand is the identity", () => {
    const r = rng(99);
    for (let i = 0; i < 300; i++) {
      const u = UNITS[Math.floor(r() * UNITS.length)]!;
      const c = num(r, 300);
      const d = `${num(r, 50)} ${UNITS[Math.floor(r() * UNITS.length)]!}`;
      const up = value(`+=${d}`, { unit: u, current: c })!;
      expect(value(`-=${d}`, { unit: u, current: up })!).toBeCloseTo(c, 6);
    }
  });
});

describe("UXI-PNL-009 — the locale's decimal comma", () => {
  test("German reads a decimal comma and groups thousands with a point", () => {
    expect(decimalSeparator("de")).toBe(",");
    expect(decimalSeparator("en")).toBe(".");
    expect(value("12,5", { decimal: "," })).toBe(12.5);
    expect(value("12.5", { decimal: "," })).toBe(12.5);
    expect(value("1.000,5", { decimal: "," })).toBe(1000.5);
    expect(value("10,5 mm + 2 pt", { unit: "mm", decimal: "," })).toBeCloseTo(
      11.20556,
      5,
    );
  });

  test("English groups thousands with a comma; any other comma is a decimal", () => {
    expect(value("1,000", { decimal: "." })).toBe(1000);
    expect(value("12,500.25", { decimal: "." })).toBe(12500.25);
    expect(value("12,5", { decimal: "." })).toBe(12.5);
    expect(parseLengthText("12,5pt", "mm")).toBe(12.5);
  });

  test("property: every number reads the same in both locales when written in each", () => {
    const r = rng(1234);
    for (let i = 0; i < 300; i++) {
      const whole = Math.floor(r() * 999);
      const frac = Math.floor(r() * 99) + 1;
      const n = Number(`${whole}.${frac}`);
      expect(value(`${whole},${frac}`, { decimal: "," })).toBe(n);
      expect(value(`${whole}.${frac}`, { decimal: "." })).toBe(n);
    }
  });
});

describe("UXI-PNL-009 — typed errors", () => {
  test("invalid syntax", () => {
    expect(error("").kind).toBe("syntax");
    expect(error("10 +").kind).toBe("syntax");
    expect(error("abc").kind).toBe("syntax");
    expect(error("1..2").kind).toBe("syntax");
    expect(error("2 3").kind).toBe("syntax");
    expect(error("(1 + 2")).toMatchObject({
      kind: "syntax",
      reason: "unclosed",
    });
    expect(error("1 + 2)").kind).toBe("syntax");
    expect(error("#").kind).toBe("syntax");
  });

  test("out of range", () => {
    expect(error("150", { min: 0, max: 100 })).toEqual({
      kind: "range",
      value: 150,
      min: 0,
      max: 100,
    });
    expect(error("-1", { min: 0 }).kind).toBe("range");
    expect(error("1/0").kind).toBe("range");
    expect(error("*=2", { current: 60, max: 100 }).kind).toBe("range");
  });

  test("unsupported unit", () => {
    expect(error("10 furlongs", { unit: "pt" })).toEqual({
      kind: "unit",
      unit: "furlongs",
    });
    expect(error("10 mm", { unit: "%" })).toEqual({ kind: "unit", unit: "mm" });
    expect(error("10 mm * 2 mm", { unit: "mm" })).toEqual({
      kind: "unit",
      unit: "mm²",
    });
    expect(error("2 / 1 mm", { unit: "mm" }).kind).toBe("unit");
    expect(error("*= 2 mm", { unit: "mm", current: 4 }).kind).toBe("unit");
    expect(error("50%", { unit: "mm" })).toEqual({ kind: "unit", unit: "%" });
  });

  test("property: a junk suffix is always an unsupported unit, never a number", () => {
    const r = rng(5);
    const junk = ["qq", "kg", "deg", "em", "furlong", "x"];
    for (let i = 0; i < 100; i++) {
      const u = UNITS[Math.floor(r() * UNITS.length)]!;
      const j = junk[Math.floor(r() * junk.length)]!;
      expect(error(`${num(r)} ${j}`, { unit: u }).kind).toBe("unit");
    }
  });
});
