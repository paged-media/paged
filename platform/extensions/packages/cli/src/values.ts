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

// Command-line values are TEXT. They become typed values only through the
// path's schema row — `coerceValue` (the explicit door ADR 132 gives text
// surfaces) then `validateValue` — never by guessing. A failure names the
// path and the type it expects.

import type { PropertySchema, ValueType } from "@paged-media/plugin-api";
import { CORE_PATH_ALIASES, coerceValue, rowPathOf, validateValue } from "@paged-media/plugin-sdk";

/** A human description of a value type (error messages, `schema --text`). */
export function describeType(t: ValueType): string {
  switch (t.kind) {
    case "number":
      return `${t.integer ? "integer" : "number"}${t.unit ? ` (${t.unit})` : ""}`;
    case "length":
      return "length (pt; or with a unit: 3mm, 0.5in, 12pt)";
    case "enum":
      return `enum (${t.members.join(" | ")})`;
    case "text":
      return t.maxLength !== undefined ? `text (≤ ${t.maxLength} chars)` : "text";
    case "ref":
      return `ref to ${t.to}`;
    case "bounds":
      return "bounds [top, left, bottom, right] (JSON)";
    case "transform":
      return "transform [a, b, c, d, tx, ty] (JSON)";
    case "point":
      return "point [x, y] (JSON)";
    case "list":
      return `list of ${describeType(t.of)} (JSON)`;
    case "map":
      return `map of ${describeType(t.of)} (JSON)`;
    case "struct":
      return `record { ${Object.entries(t.fields)
        .map(([k, v]) => `${k}${v.optional || v.default !== undefined ? "?" : ""}: ${describeType(v)}${v.default !== undefined ? ` = ${JSON.stringify(v.default)}` : ""}`)
        .join(", ")} } (JSON)`;
    case "color":
      return "color (a swatch name or reference)";
    case "asset":
      return "asset (a data:<mime>;base64,… URI or bare base64)";
    default:
      return t.kind;
  }
}

/** The schema row for `path` among `rows` (core path aliases honoured; a
 *  concrete indexed path such as `rows[0].height` falls back to its indexed
 *  row `rows[].height`, §21.8). */
export function rowFor(rows: readonly PropertySchema[], path: string): PropertySchema | null {
  const exact = (p: string) => rows.find((r) => r.path === p) ?? rows.find((r) => r.path === (CORE_PATH_ALIASES[p] ?? p)) ?? null;
  return exact(path) ?? (path.includes("[") ? exact(rowPathOf(path)) : null);
}

export type Parsed = { ok: true; value: unknown; schema: PropertySchema | null } | { ok: false; reason: string };

/**
 * Parse a command-line `raw` value for `path`. `json` forces JSON (for a
 * path without a schema row, or a structured value). Without a row and
 * without `json` the text passes as text, unconverted — the owner then
 * accepts or refuses it.
 */
export function parseCliValue(rows: readonly PropertySchema[], address: string, path: string, raw: string, json = false): Parsed {
  const row = rowFor(rows, path);
  const fail = (why: string): Parsed => ({
    ok: false,
    reason: `${address} ${path}: ${why}${row ? ` — expected ${describeType(row.type)}${row.nullable ? " or null" : ""}` : ""}`,
  });
  if (row && (row.access === "readOnly" || row.access === "derived")) return fail(`is ${row.access}`);
  let value: unknown = raw;
  if (json) {
    try {
      value = JSON.parse(raw);
    } catch {
      return fail(`"${raw}" is not JSON`);
    }
  } else if (row && raw.trim() === "null") {
    if (!row.nullable) return fail("may not be null");
    value = null;
  } else if (row) {
    const c = coerceValue(row.type, raw);
    if (!c.ok) return fail(c.reason);
    value = c.value;
  }
  if (row) {
    const why = validateValue(row.type, value, row, path);
    if (why) return fail(why);
  }
  return { ok: true, value, schema: row };
}
