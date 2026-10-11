/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// ADR 132 value types, as VALUES: check a schema row is well formed, check
// a value against a row (the registry's gate before any owner is asked —
// a mismatch is refused with a reason, never coerced silently, ADR 323
// rule 3), and the EXPLICIT coercion a text surface (the CLI, a binding)
// asks for: "3mm" → 8.503937 pt, "true" → true, "12" → 12.

import type { PropertySchema, ValueType } from "@paged-media/plugin-api";

export const VALUE_TYPE_KINDS = [
  "bool",
  "number",
  "length",
  "color",
  "enum",
  "text",
  "ref",
  "bounds",
  "transform",
  "point",
  "bytes",
  "asset",
  "list",
  "map",
  "struct",
] as const;
const KINDS = new Set<string>(VALUE_TYPE_KINDS);

/** Why `t` is not a well-formed `ValueType`, or null. */
export function checkValueType(t: unknown, at = "type"): string | null {
  if (typeof t !== "object" || t === null) return `${at} must be an object`;
  const k = (t as { kind?: unknown }).kind;
  if (typeof k !== "string" || !KINDS.has(k)) return `${at}.kind "${String(k)}" is not a ValueType`;
  const v = t as Record<string, unknown>;
  switch (k) {
    case "enum":
      if (!Array.isArray(v["members"]) || v["members"].length === 0 || !v["members"].every((m) => typeof m === "string")) {
        return `${at}: an enum needs a non-empty members[]`;
      }
      return null;
    case "number": {
      const kw = v["keywords"];
      if (kw !== undefined && (!Array.isArray(kw) || !kw.every((m) => typeof m === "string"))) {
        return `${at}: a number's keywords must be strings`;
      }
      return null;
    }
    case "ref":
      return typeof v["to"] === "string" && v["to"].length > 0 ? null : `${at}: a ref needs "to"`;
    case "list":
    case "map":
      return checkValueType(v["of"], `${at}.of`);
    case "struct": {
      const f = v["fields"];
      if (typeof f !== "object" || f === null) return `${at}: a struct needs fields`;
      for (const [name, ft] of Object.entries(f)) {
        const e = checkValueType(ft, `${at}.fields.${name}`);
        if (e) return e;
        const field = ft as { optional?: unknown; default?: unknown };
        if (field.optional !== undefined && field.optional !== true) return `${at}.fields.${name}: optional must be true when present`;
        if (field.default !== undefined) {
          const why = validateValue(ft as ValueType, field.default, undefined, `${at}.fields.${name}.default`);
          if (why) return `${at}.fields.${name}: the default does not fit its type (${why})`;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Path grammar of a schema ROW: dotted identifiers, each optionally
 * followed by bracket segments. `[]` makes an INDEXED row (`points[]`,
 * `points[].anchor`, `ranges[][]`) that stands for every `points[3]` /
 * `cells[B4]` a caller names; its type is the type of ONE item at that
 * index. A concrete index (`colorize[0]`) is an ordinary row and wins
 * over the indexed one.
 */
export const ROW_PATH = /^[A-Za-z_][A-Za-z0-9_-]*(\[[^\][]*\])*(\.[A-Za-z_][A-Za-z0-9_-]*(\[[^\][]*\])*)*$/;

/** The row path a concrete path resolves to: every `[<index>]` becomes
 *  `[]` (`points[3].anchor` → `points[].anchor`). Bracket contents may be
 *  any text without `]` (a list index, a map key such as `x-paged:oid`). */
export function rowPathOf(path: string): string {
  return path.replace(/\[[^\]]*\]/g, "[]");
}

/** Find the row for a concrete path: exact first, then its indexed form. */
export function findRow<R extends { path: string }>(rows: ReadonlyMap<string, R>, path: string): R | null {
  return rows.get(path) ?? (path.includes("[") ? (rows.get(rowPathOf(path)) ?? null) : null);
}

/** Why a schema row list is unusable (empty, malformed, duplicate path). */
export function checkSchemaRows(rows: unknown): string | null {
  if (!Array.isArray(rows) || rows.length === 0) return "schema has no rows";
  const seen = new Set<string>();
  for (const [i, row] of rows.entries()) {
    if (typeof row !== "object" || row === null) return `schema[${i}] is not an object`;
    const path = (row as { path?: unknown }).path;
    if (typeof path !== "string" || path.length === 0) return `schema[${i}] has no path`;
    if (!ROW_PATH.test(path)) return `schema path "${path}" is not a row path (dotted names, an indexed segment written \`name[]\`)`;
    if (seen.has(path)) return `schema path "${path}" is repeated`;
    seen.add(path);
    const e = checkValueType((row as { type?: unknown }).type, `schema[${path}].type`);
    if (e) return e;
  }
  return null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nums = (v: unknown, n: number) => Array.isArray(v) && v.length === n && v.every(isNum);

/** Why `value` does not satisfy `type` (and the row's range / nullable), or
 *  null when it does. */
export function validateValue(
  type: ValueType,
  value: unknown,
  row?: Pick<PropertySchema, "nullable" | "range">,
  at = "value",
): string | null {
  if (value === null) return row?.nullable ? null : `${at} may not be null`;
  const range = (n: number): string | null => {
    const r = row?.range;
    if (r?.min !== undefined && n < r.min) return `${at} ${n} is below ${r.min}`;
    if (r?.max !== undefined && n > r.max) return `${at} ${n} is above ${r.max}`;
    return null;
  };
  switch (type.kind) {
    case "bool":
      return typeof value === "boolean" ? null : `${at} must be a boolean`;
    case "number":
      if (typeof value === "string" && type.keywords?.includes(value)) return null;
      if (!isNum(value)) {
        return type.keywords?.length
          ? `${at} must be a number or one of ${type.keywords.join(" | ")}`
          : `${at} must be a number`;
      }
      if (type.integer && !Number.isInteger(value)) return `${at} must be an integer`;
      return range(value);
    case "length":
      return isNum(value) ? range(value) : `${at} must be a length in pt`;
    case "color":
    case "text":
      if (typeof value !== "string") return `${at} must be a string`;
      if (type.kind === "text" && type.maxLength !== undefined && value.length > type.maxLength) {
        return `${at} is longer than ${type.maxLength}`;
      }
      return null;
    case "asset":
      return assetProblem(value, at);
    case "enum":
      return typeof value === "string" && type.members.includes(value)
        ? null
        : `${at} must be one of ${type.members.join(" | ")}`;
    case "ref":
      return typeof value === "string" && value.length > 0 ? null : `${at} must be a ${type.to} reference`;
    case "bounds":
      return nums(value, 4) ? null : `${at} must be [top, left, bottom, right]`;
    case "transform":
      return nums(value, 6) ? null : `${at} must be [a, b, c, d, tx, ty]`;
    case "point":
      return nums(value, 2) ? null : `${at} must be [x, y]`;
    case "bytes":
      return value instanceof Uint8Array ? null : `${at} must be bytes`;
    case "list": {
      if (!Array.isArray(value)) return `${at} must be a list`;
      if (type.maxItems !== undefined && value.length > type.maxItems) return `${at} has more than ${type.maxItems} items`;
      for (const [i, item] of value.entries()) {
        const e = validateValue(type.of, item, undefined, `${at}[${i}]`);
        if (e) return e;
      }
      return null;
    }
    case "map": {
      if (typeof value !== "object" || Array.isArray(value)) return `${at} must be a map`;
      for (const [k, item] of Object.entries(value as object)) {
        if (type.keyPattern && !new RegExp(type.keyPattern).test(k)) return `${at} key "${k}" is not allowed`;
        const e = validateValue(type.of, item, undefined, `${at}[${k}]`);
        if (e) return e;
      }
      return null;
    }
    case "struct": {
      if (typeof value !== "object" || Array.isArray(value)) return `${at} must be a record`;
      const rec = value as Record<string, unknown>;
      if (!type.open) {
        for (const k of Object.keys(rec)) {
          if (!(k in type.fields)) return `${at} has no field "${k}"`;
        }
      }
      for (const [k, ft] of Object.entries(type.fields)) {
        if (!(k in rec) || rec[k] === undefined) {
          if (ft.optional || ft.default !== undefined) continue;
          return `${at}.${k} is missing`;
        }
        const e = validateValue(ft, rec[k], undefined, `${at}.${k}`);
        if (e) return e;
      }
      return null;
    }
  }
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Why `value` is not an `asset` value, or null. An asset is a
 *  `data:<mime>;base64,<payload>` URI or bare base64 (the forms core's
 *  `imageBytes` row decodes), or bytes (`Uint8Array` / `ArrayBuffer`),
 *  which `applyDefaults` encodes. Empty content is refused: `null` clears. */
function assetProblem(value: unknown, at: string): string | null {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return value.byteLength > 0 ? null : `${at} has no bytes (clear the content with null)`;
  }
  if (typeof value !== "string") return `${at} must be a data: URI, base64 text or bytes`;
  let payload = value;
  if (value.startsWith("data:")) {
    const comma = value.indexOf(",");
    if (comma < 0) return `${at}: a data: URI needs a comma before its payload`;
    if (!value.slice(5, comma).endsWith(";base64")) return `${at}: a data: URI must carry its bytes as base64 (\`;base64,\`)`;
    payload = value.slice(comma + 1);
  }
  payload = payload.trim();
  if (payload.length === 0) return `${at} has no bytes (clear the content with null)`;
  return BASE64.test(payload) && payload.length % 4 === 0 ? null : `${at} is not base64`;
}

/** Bytes → the `data:` URI core reads an asset back as (the MIME typed by
 *  the bytes' magic, the same table core uses; otherwise
 *  `application/octet-stream`). */
export function assetFromBytes(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  const mime = at(0, 0x89, 0x50, 0x4e, 0x47)
    ? "image/png"
    : at(0, 0xff, 0xd8, 0xff)
      ? "image/jpeg"
      : at(0, 0x47, 0x49, 0x46, 0x38)
        ? "image/gif"
        : at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)
          ? "image/webp"
          : at(0, 0x49, 0x49, 42, 0) || at(0, 0x4d, 0x4d, 0, 42)
            ? "image/tiff"
            : at(0, 0x42, 0x4d)
              ? "image/bmp"
              : "application/octet-stream";
  let bin = "";
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

/**
 * Fill struct DEFAULTS into a value that already validated: a missing
 * field with a `default` gets it (recursively, also inside lists and
 * maps); optional fields stay absent. An `asset` given as bytes is
 * encoded to its `data:` URI. Returns a new value; the input is
 * not mutated.
 */
export function applyDefaults(type: ValueType, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  switch (type.kind) {
    // Bytes become the text form core takes (a lossless re-encoding, not
    // a coercion: the content is the same).
    case "asset":
      return value instanceof Uint8Array || value instanceof ArrayBuffer ? assetFromBytes(value) : value;
    case "struct": {
      if (typeof value !== "object" || Array.isArray(value)) return value;
      const rec = value as Record<string, unknown>;
      const out: Record<string, unknown> = { ...rec };
      for (const [k, ft] of Object.entries(type.fields)) {
        if (out[k] === undefined) {
          if (ft.default !== undefined) out[k] = structuredClone(ft.default);
          else delete out[k];
        } else {
          out[k] = applyDefaults(ft, out[k]);
        }
      }
      return out;
    }
    case "list":
      return Array.isArray(value) ? value.map((v) => applyDefaults(type.of, v)) : value;
    case "map":
      if (typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) return value;
      return Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, applyDefaults(type.of, v)]));
    default:
      return value;
  }
}

const UNIT_PT: Record<string, number> = {
  pt: 1,
  px: 0.75,
  in: 72,
  mm: 72 / 25.4,
  cm: 72 / 2.54,
  pc: 12,
  p: 12,
};

/** Parse a length with an optional unit (`"3mm"`, `"12"`, `"0.5in"`) into
 *  points; null when it is not one. */
export function parseLength(text: string): number | null {
  const m = /^\s*(-?\d+(?:\.\d+)?|-?\.\d+)\s*([a-z]*)\s*$/i.exec(text);
  if (!m) return null;
  const factor = m[2] ? UNIT_PT[m[2].toLowerCase()] : 1;
  return factor === undefined ? null : Number(m[1]) * factor;
}

/**
 * EXPLICIT coercion of a loosely typed input (a CLI argument, a CSV cell)
 * to `type`. Returns `{ ok: true, value }` or `{ ok: false, reason }`; the
 * coerced value is then checked with `validateValue` as usual. Values that
 * already have the right shape pass through unchanged.
 */
export function coerceValue(
  type: ValueType,
  input: unknown,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const ok = (value: unknown) => ({ ok: true as const, value });
  if (input === null || typeof input !== "string") return ok(input);
  const text = input.trim();
  switch (type.kind) {
    case "bool":
      if (/^(true|yes|1|on)$/i.test(text)) return ok(true);
      if (/^(false|no|0|off)$/i.test(text)) return ok(false);
      return { ok: false, reason: `"${input}" is not a boolean` };
    case "number": {
      if (type.keywords?.includes(text)) return ok(text);
      const n = Number(text.replace(/%$/, ""));
      return text !== "" && Number.isFinite(n) ? ok(n) : { ok: false, reason: `"${input}" is not a number` };
    }
    case "length": {
      const n = parseLength(text);
      return n !== null ? ok(n) : { ok: false, reason: `"${input}" is not a length` };
    }
    case "bounds":
    case "transform":
    case "point":
    case "list":
    case "map":
    case "struct":
      try {
        return ok(JSON.parse(text));
      } catch {
        return { ok: false, reason: `"${input}" is not JSON` };
      }
    default:
      return ok(input);
  }
}
