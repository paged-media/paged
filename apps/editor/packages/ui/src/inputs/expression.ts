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

// THE ONE PARSER of what a user types into a numeric field (editor ADR on
// the one numeric field, amending 233 and 245; the interaction spec's
// UXI-PNL-002 and UXI-PNL-009). Every numeric field reads its text here:
// the kit's NumericField, and through it NumberInput, LengthInput,
// BoundsInput, SmartDialMicro, the catalogue's leaves and the control bar.
//
//   input    := relative? expr
//   relative := "+=" | "-=" | "*=" | "/=" | "×=" | "÷="
//             | "*" | "/" | "×" | "÷"            (a leading factor: relative)
//   expr     := term (("+" | "-" | "−") term)*
//   term     := unary (("*" | "/" | "×" | "÷") unary)*
//   unary    := ("+" | "-" | "−") unary | primary
//   primary  := number unit? | "(" expr ")" unit?
//   unit     := pt | pc | p | px | mm | cm | in | " | ″ | % | °   (and 6p3:
//               six picas and three points, as InDesign writes it)
//
// DIMENSIONS, so mixed units are deterministic. A literal with a length
// unit is a length (held in points); a bare number is a number. In a
// LENGTH field (its unit is a length unit) a bare number added to or
// subtracted from a length is read in the field's unit, and a bare result
// is in the field's unit too: "10 + 2 pt" in a millimetre field is 10 mm
// plus 2 pt. A length times a number is a length, a length over a length a
// ratio; a length times a length, or a number over a length, is not a
// length and is refused as an unsupported unit. The result is converted to
// the field's unit once, at the end, through the one table
// (`POINTS_PER_UNIT`), so the same text gives the same number every time.
//
// A field that is not a length (a percentage, an angle, a count) refuses a
// length unit; its own suffix ("%" in an opacity, "°" in a rotation) is
// read as the number itself. Elsewhere "%" is a hundredth: "*110%" scales by
// 1.1, and a relative "+=10%" adds a tenth of the value.
//
// DECIMALS follow the UI locale. Where it writes a decimal comma (German),
// "12,5" is twelve and a half and "1.000,5" groups thousands; "12.5" is
// read too. Where it writes a decimal point, "12.5" is the number, "1,000"
// and "12,500.25" group thousands, and any other comma is a decimal comma
// (ADR 245 read "12,5 pt" in every locale, and still does).
//
// ERRORS ARE TYPED: `syntax` (not an expression), `range` (outside the
// field's bounds, or not finite: a division by zero), `unit` (a unit this
// field cannot take). The field shows them in words; it never guesses.

import { POINTS_PER_UNIT, type LengthUnit } from "./units";

/** Why typed text is not a value for the field. */
export type NumericParseError =
  | { kind: "syntax"; at: number; reason: SyntaxReason }
  | { kind: "range"; value: number; min?: number; max?: number }
  | { kind: "unit"; unit: string };

/** What a syntax error is about (the field words each one). */
export type SyntaxReason =
  | "empty"
  | "unexpected"
  | "number"
  | "unclosed"
  /** A relative entry ("+=5") where the field has no single value to
   *  change (a mixed selection without a per-object write). */
  | "needsValue";

/** A relative entry, kept apart from its result so a multi-selection can
 *  apply it to each object's own value (UXI-PNL-010: "increase each width
 *  by 5 mm", "scale all widths by 110 %"). `operand` is in the field's unit;
 *  `percent` marks "+=10%" (a tenth of the value, not ten units). */
export interface RelativeEdit {
  op: "+" | "-" | "*" | "/";
  operand: number;
  percent: boolean;
}

export type ExpressionResult =
  | {
      ok: true;
      /** The value in the field's unit; null for a relative entry when the
       *  field has no current value (apply `relative` per object). */
      value: number | null;
      relative: RelativeEdit | null;
    }
  | { ok: false; error: NumericParseError };

export interface ExpressionOptions {
  /** The field's unit: a length unit makes it a length field (the result
   *  is in that unit; any length suffix converts). Any other text ("%",
   *  "°") is the suffix the field's numbers carry; null or absent: a plain
   *  number. */
  unit?: string | null;
  /** The field's value now, for a relative entry. */
  current?: number | null;
  /** Bounds, inclusive, in the field's unit. Outside them is a `range`
   *  error (a scrub clamps; typing says so). */
  min?: number;
  max?: number;
  /** The UI locale's decimal separator (`decimalSeparator(locale)`). */
  decimal?: "." | ",";
}

/** Points per unit for every length suffix a typed value may carry. */
const LENGTH_SUFFIX: Readonly<Record<string, number>> = {
  pt: POINTS_PER_UNIT.pt,
  pc: POINTS_PER_UNIT.pc,
  p: POINTS_PER_UNIT.pc,
  px: POINTS_PER_UNIT.px,
  mm: POINTS_PER_UNIT.mm,
  cm: POINTS_PER_UNIT.cm,
  in: POINTS_PER_UNIT.in,
  '"': POINTS_PER_UNIT.in,
  "″": POINTS_PER_UNIT.in,
};

/** The non-length suffixes a field may name as its own. */
const ANGLE_SUFFIXES = new Set(["°", "deg"]);

export function isLengthUnitName(unit: unknown): unit is LengthUnit {
  return typeof unit === "string" && Object.hasOwn(POINTS_PER_UNIT, unit);
}

/** The decimal separator `locale` writes ("," for German, "." for
 *  English); "." when the runtime cannot say. */
export function decimalSeparator(locale: string | undefined): "." | "," {
  try {
    const part = new Intl.NumberFormat(locale)
      .formatToParts(1.5)
      .find((p) => p.type === "decimal");
    return part?.value === "," ? "," : ".";
  } catch {
    return ".";
  }
}

// ---------------------------------------------------------------- lexer

type Token =
  | { t: "num"; v: number; at: number }
  | { t: "unit"; v: string; at: number }
  | { t: "op"; v: "+" | "-" | "*" | "/"; at: number }
  | { t: "rel"; v: "+" | "-" | "*" | "/"; at: number }
  | { t: "("; at: number }
  | { t: ")"; at: number }
  | { t: "pica"; picas: number; points: number; at: number };

class ParseFailure extends Error {
  constructor(readonly error: NumericParseError) {
    super(error.kind);
  }
}

const syntax = (at: number, reason: SyntaxReason = "unexpected") =>
  new ParseFailure({ kind: "syntax", at, reason });

/** A run of digits and separators read as one number, by the locale. */
function readNumber(raw: string, at: number, decimal: "." | ","): number {
  let text: string;
  if (decimal === ",") {
    // German: "1.000,5" groups thousands; one separator of either kind is
    // the decimal one.
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(raw))
      text = raw.replace(/\./g, "").replace(",", ".");
    else if ((raw.match(/[.,]/g) ?? []).length <= 1)
      text = raw.replace(",", ".");
    else throw syntax(at, "number");
  } else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw)) {
    text = raw.replace(/,/g, "");
  } else if ((raw.match(/[.,]/g) ?? []).length <= 1) {
    text = raw.replace(",", ".");
  } else {
    throw syntax(at, "number");
  }
  if (!/^(\d+\.?\d*|\.\d+)$/.test(text)) throw syntax(at, "number");
  const n = Number(text);
  if (!Number.isFinite(n)) throw syntax(at, "number");
  return n;
}

function lex(src: string, decimal: "." | ","): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const at = i;
    if (/[\d.,]/.test(c)) {
      let j = i;
      while (j < n && /[\d.,]/.test(src[j]!)) j++;
      const raw = src.slice(i, j);
      if (!/\d/.test(raw)) throw syntax(at, "number");
      // InDesign's pica notation: 6p3 is six picas and three points.
      const pica = /^p(\d+(?:[.,]\d+)?)/i.exec(src.slice(j));
      if (pica && /^\d+$/.test(raw)) {
        const points = readNumber(pica[1]!, j + 1, decimal);
        out.push({
          t: "pica",
          picas: readNumber(raw, at, decimal),
          points,
          at,
        });
        i = j + pica[0].length;
        continue;
      }
      out.push({ t: "num", v: readNumber(raw, at, decimal), at });
      i = j;
      continue;
    }
    // Two-character relative operators.
    const two = src.slice(i, i + 2);
    if (/^[-+*/×÷−]=$/.test(two)) {
      out.push({ t: "rel", v: normOp(two[0]!), at });
      i += 2;
      continue;
    }
    if ("+-−*/×÷".includes(c)) {
      out.push({ t: "op", v: normOp(c), at });
      i++;
      continue;
    }
    if (c === "(") {
      out.push({ t: "(", at });
      i++;
      continue;
    }
    if (c === ")") {
      out.push({ t: ")", at });
      i++;
      continue;
    }
    if (c === '"' || c === "″" || c === "%" || c === "°") {
      out.push({ t: "unit", v: c, at });
      i++;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < n && /[a-zA-Z]/.test(src[j]!)) j++;
      out.push({ t: "unit", v: src.slice(i, j).toLowerCase(), at });
      i = j;
      continue;
    }
    throw syntax(at);
  }
  return out;
}

function normOp(c: string): "+" | "-" | "*" | "/" {
  if (c === "+") return "+";
  if (c === "-" || c === "−") return "-";
  if (c === "*" || c === "×") return "*";
  return "/";
}

// ---------------------------------------------------------------- parser

/** A value with its dimension: a length (in points) or a number.
 *  `percent` marks a lone percentage literal (for "+=10%"). */
interface Dim {
  n: number;
  len: boolean;
  percent: boolean;
}

interface Ctx {
  tokens: Token[];
  pos: number;
  /** Points per unit of the field when it is a length field, else null. */
  fieldPt: number | null;
  /** The field's own non-length suffix ("%", "°"), lower-cased. */
  ownSuffix: string | null;
  /** How a dimension error names the field's unit ("mm", or "pt"). */
  unitName: string;
  /** A relative factor ("*110%"): "%" is a hundredth even in a field
   *  whose own suffix is "%". */
  factor: boolean;
  end: number;
}

const peek = (c: Ctx) => c.tokens[c.pos];

function parseExpr(c: Ctx): Dim {
  let left = parseTerm(c);
  for (;;) {
    const tok = peek(c);
    if (tok?.t !== "op" || (tok.v !== "+" && tok.v !== "-")) return left;
    c.pos++;
    const right = parseTerm(c);
    left = add(c, left, right, tok.v === "-" ? -1 : 1);
  }
}

function parseTerm(c: Ctx): Dim {
  let left = parseUnary(c);
  for (;;) {
    const tok = peek(c);
    if (tok?.t !== "op" || (tok.v !== "*" && tok.v !== "/")) return left;
    c.pos++;
    const right = parseUnary(c);
    left = tok.v === "*" ? mul(c, left, right) : div(c, left, right);
  }
}

function parseUnary(c: Ctx): Dim {
  const tok = peek(c);
  if (tok?.t === "op" && (tok.v === "+" || tok.v === "-")) {
    c.pos++;
    const v = parseUnary(c);
    return tok.v === "-" ? { ...v, n: -v.n } : v;
  }
  return parsePrimary(c);
}

function parsePrimary(c: Ctx): Dim {
  const tok = peek(c);
  if (!tok) throw syntax(c.end, c.pos === 0 ? "empty" : "unexpected");
  if (tok.t === "pica") {
    c.pos++;
    return {
      n: tok.picas * POINTS_PER_UNIT.pc + tok.points,
      len: true,
      percent: false,
    };
  }
  if (tok.t === "num") {
    c.pos++;
    return withUnit(c, { n: tok.v, len: false, percent: false });
  }
  if (tok.t === "(") {
    c.pos++;
    const inner = parseExpr(c);
    const close = peek(c);
    if (close?.t !== ")") throw syntax(close?.at ?? c.end, "unclosed");
    c.pos++;
    return withUnit(c, { ...inner, percent: false });
  }
  throw syntax(tok.at);
}

/** A unit after a number (or a bracket), applied to a bare value. */
function withUnit(c: Ctx, v: Dim): Dim {
  const tok = peek(c);
  if (tok?.t !== "unit") return v;
  c.pos++;
  if (v.len) throw new ParseFailure({ kind: "unit", unit: tok.v });
  const u = tok.v;
  if (u === "%" && (c.factor || c.ownSuffix !== "%"))
    return { n: v.n / 100, len: false, percent: true };
  if (c.ownSuffix !== null && u === c.ownSuffix) return v;
  if (Object.hasOwn(LENGTH_SUFFIX, u)) {
    if (c.fieldPt === null) throw new ParseFailure({ kind: "unit", unit: u });
    return { n: v.n * LENGTH_SUFFIX[u]!, len: true, percent: false };
  }
  if (ANGLE_SUFFIXES.has(u) && c.ownSuffix && ANGLE_SUFFIXES.has(c.ownSuffix))
    return v;
  throw new ParseFailure({ kind: "unit", unit: u });
}

/** A bare number beside a length, read in the field's unit. */
const asLength = (c: Ctx, v: Dim): Dim =>
  v.len || c.fieldPt === null
    ? v
    : { n: v.n * c.fieldPt, len: true, percent: false };

function add(c: Ctx, a: Dim, b: Dim, sign: 1 | -1): Dim {
  if (a.len || b.len) {
    const x = asLength(c, a);
    const y = asLength(c, b);
    return { n: x.n + sign * y.n, len: true, percent: false };
  }
  return { n: a.n + sign * b.n, len: false, percent: false };
}

function mul(c: Ctx, a: Dim, b: Dim): Dim {
  if (a.len && b.len)
    throw new ParseFailure({ kind: "unit", unit: `${c.unitName}²` });
  return { n: a.n * b.n, len: a.len || b.len, percent: false };
}

function div(c: Ctx, a: Dim, b: Dim): Dim {
  if (b.len && !a.len)
    throw new ParseFailure({ kind: "unit", unit: `1/${c.unitName}` });
  const n = a.n / b.n;
  if (!Number.isFinite(n)) throw new ParseFailure({ kind: "range", value: n });
  return { n, len: a.len && !b.len, percent: false };
}

/** The final value in the field's unit. */
function inFieldUnit(c: Ctx, v: Dim): number {
  return v.len && c.fieldPt !== null ? v.n / c.fieldPt : v.n;
}

// ---------------------------------------------------------------- entry

/** Apply a relative edit to a value (each object's own, in a batch). */
export function applyRelative(edit: RelativeEdit, current: number): number {
  switch (edit.op) {
    case "+":
      return edit.percent
        ? current * (1 + edit.operand)
        : current + edit.operand;
    case "-":
      return edit.percent
        ? current * (1 - edit.operand)
        : current - edit.operand;
    case "*":
      return current * edit.operand;
    case "/":
      return current / edit.operand;
  }
}

function inRange(
  value: number,
  opts: ExpressionOptions,
): NumericParseError | null {
  if (!Number.isFinite(value)) return { kind: "range", value };
  if (
    (opts.min !== undefined && value < opts.min) ||
    (opts.max !== undefined && value > opts.max)
  )
    return { kind: "range", value, min: opts.min, max: opts.max };
  return null;
}

/** The parsed text: its dimensioned value and relative operator. */
interface Parsed {
  v: Dim;
  rel: RelativeEdit["op"] | null;
  c: Ctx;
}

function parseText(text: string, opts: ExpressionOptions): Parsed {
  const decimal = opts.decimal ?? ".";
  const unit = opts.unit ?? null;
  const fieldPt = isLengthUnitName(unit) ? POINTS_PER_UNIT[unit] : null;
  const ownSuffix =
    unit !== null && fieldPt === null ? unit.trim().toLowerCase() : null;
  const tokens = lex(text, decimal);
  const c: Ctx = {
    tokens,
    pos: 0,
    fieldPt,
    ownSuffix,
    unitName: fieldPt !== null && unit ? unit : "pt",
    factor: false,
    end: text.length,
  };
  if (tokens.length === 0) throw syntax(0, "empty");
  // A relative entry: "+=5 mm", "-=2", "*=1.1", or a leading factor
  // ("*110%", "/2"), which cannot start an absolute value.
  let rel: RelativeEdit["op"] | null = null;
  const first = tokens[0]!;
  if (first.t === "rel") {
    rel = first.v;
    c.pos = 1;
  } else if (first.t === "op" && (first.v === "*" || first.v === "/")) {
    rel = first.v;
    c.pos = 1;
  }
  c.factor = rel === "*" || rel === "/";
  const v = parseExpr(c);
  const rest = peek(c);
  if (rest) throw syntax(rest.at);
  // A lone "50%" is a share of nothing in a field that is not a
  // percentage; as a factor or a relative change it means something.
  if (rel === null && v.percent)
    throw new ParseFailure({ kind: "unit", unit: "%" });
  return { v, rel, c };
}

/**
 * Read what was typed into a numeric field. The value is in the field's
 * unit (see {@link ExpressionOptions.unit}); a relative entry also returns
 * its {@link RelativeEdit}, applied to `current` when there is one.
 */
export function parseNumericExpression(
  text: string,
  opts: ExpressionOptions = {},
): ExpressionResult {
  try {
    const { v, rel, c } = parseText(text, opts);
    if (rel === null) {
      const value = inFieldUnit(c, v);
      const bad = inRange(value, opts);
      return bad
        ? { ok: false, error: bad }
        : { ok: true, value, relative: null };
    }
    // A factor is a number: "*= 2 mm" is not a scale.
    if ((rel === "*" || rel === "/") && v.len)
      return { ok: false, error: { kind: "unit", unit: `${c.unitName}²` } };
    const operand =
      (rel === "+" || rel === "-") && v.percent ? v.n : inFieldUnit(c, v);
    if ((rel === "/" && operand === 0) || !Number.isFinite(operand))
      return { ok: false, error: { kind: "range", value: operand } };
    const relative: RelativeEdit = {
      op: rel,
      operand,
      percent: (rel === "+" || rel === "-") && v.percent,
    };
    const current = opts.current;
    if (current === null || current === undefined)
      return { ok: true, value: null, relative };
    const value = applyRelative(relative, current);
    const bad = inRange(value, opts);
    return bad ? { ok: false, error: bad } : { ok: true, value, relative };
  } catch (err) {
    if (err instanceof ParseFailure) return { ok: false, error: err.error };
    throw err;
  }
}

/** Points a length text reads as in a field shown in `unit`, or null when
 *  it is not an absolute length (ADR 245's `parseLengthText`, now an
 *  expression). Computed in points, so "10mm" is exactly 10 × 72 / 25.4. */
export function lengthTextToPoints(
  text: string,
  unit: LengthUnit,
  decimal: "." | "," = ".",
): number | null {
  try {
    const { v, rel } = parseText(text, { unit, decimal });
    if (rel !== null) return null;
    const pt = v.len ? v.n : v.n * POINTS_PER_UNIT[unit];
    return Number.isFinite(pt) ? pt : null;
  } catch (err) {
    if (err instanceof ParseFailure) return null;
    throw err;
  }
}
