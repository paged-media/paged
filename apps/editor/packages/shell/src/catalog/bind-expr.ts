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

// The bind popover's four ways to bind a property (editor ADR 292), compiled
// to paged.data's binding language: a field is its bare name; rules are
// `IF(condition, value, IF(…, else))`; a map is `SWITCH(field, key, value, …,
// default)`; an expression is itself. Pure: the popover renders, this writes
// the expression, and the engine evaluates and coerces it (ADR 558).

/** A comparison a rule's condition makes. */
export type RuleOp =
  "=" | "<>" | "<" | "<=" | ">" | ">=" | "contains" | "blank";

/** One rule: when `field op value`, the property is `result`. */
export interface BindRule {
  field: string;
  op: RuleOp;
  value: string;
  result: string;
}

/** One map entry: when the field is `key`, the property is `value`. */
export interface BindMapEntry {
  key: string;
  value: string;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A field reference, or null when the name is not a bare identifier (the
 *  language has no quoted field syntax: such a column needs an alias in
 *  its query). */
export function fieldRef(name: string): string | null {
  return IDENT.test(name) ? name : null;
}

/** A string literal of the language (`"` doubled inside). */
export function quote(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

/** A value as the author typed it: a number stays a number, `=…` is an
 *  expression, `"…"` is already a string, anything else is a string. */
export function literal(input: string): string {
  const v = input.trim();
  if (v === "") return quote("");
  if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(v)) return v;
  if (v.startsWith("=")) return v.slice(1).trim();
  if (/^".*"$/s.test(v)) return v;
  return quote(v);
}

/** Why a set of rules or a map cannot be compiled, or null. */
export type CompileResult = { expr: string } | { error: string };

function condition(r: BindRule): CompileResult {
  const f = fieldRef(r.field);
  if (!f)
    return { error: `"${r.field}" is not a field name the language can read` };
  if (r.op === "blank") return { expr: `ISBLANK(${f})` };
  if (r.op === "contains")
    // FIND is #VALUE when the text is not there.
    return { expr: `IFERROR(FIND(${literal(r.value)}, ${f}), 0) > 0` };
  return { expr: `${f} ${r.op} ${literal(r.value)}` };
}

/** Rules, first match wins; `otherwise` when none matches. */
export function compileRules(
  rules: readonly BindRule[],
  otherwise: string,
): CompileResult {
  let expr = literal(otherwise);
  for (let i = rules.length - 1; i >= 0; i--) {
    const c = condition(rules[i]!);
    if ("error" in c) return c;
    expr = `IF(${c.expr}, ${literal(rules[i]!.result)}, ${expr})`;
  }
  return { expr };
}

/** A lookup of the field's value; `otherwise` for a value the map lacks. */
export function compileMap(
  field: string,
  entries: readonly BindMapEntry[],
  otherwise: string,
): CompileResult {
  const f = fieldRef(field);
  if (!f)
    return { error: `"${field}" is not a field name the language can read` };
  if (entries.length === 0) return { expr: literal(otherwise) };
  const pairs = entries.map((e) => `${quote(e.key)}, ${literal(e.value)}`);
  return { expr: `SWITCH(${f}, ${pairs.join(", ")}, ${literal(otherwise)})` };
}
