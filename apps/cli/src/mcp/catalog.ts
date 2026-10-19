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

// `lookup_api`: a search over the engine's capability catalog
// (`introspect/catalog.json` of the engine package, the contract every
// surface is generated from), the algorithm of the Rust `paged-mcp`
// (src/catalog.rs): every word must appear; names count more than prose;
// host functions first among equals; shorter entries before longer ones.

type Entry = Record<string, unknown>;
type Catalog = Record<string, unknown>;

/** serde_json's compact text of a value, keys sorted (its `Value` order). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Entry)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

const utf8Length = (s: string): number => Buffer.byteLength(s, "utf8");

/** The catalog entries that best match `query`, at most `limit`. */
export function lookup(
  catalog: Catalog,
  query: string,
  limit: number,
): Record<string, unknown> {
  const words = query
    .split(/[^\p{L}\p{N}._]/u)
    .filter((w) => w !== "")
    .map((w) => w.toLowerCase());
  const hits: Array<{ score: number; hit: Entry }> = [];
  for (const section of Object.keys(catalog).sort()) {
    const entries = catalog[section];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const text = canonical(entry).toLowerCase();
      if (words.length === 0 || !words.every((w) => text.includes(w))) continue;
      const e = (entry ?? {}) as Entry;
      const named = e["name"] ?? e["form"] ?? e["path"];
      const name = (
        named !== undefined ? canonical(named) : text
      ).toLowerCase();
      const score =
        words.filter((w) => name.includes(w)).length * 10 +
        (section === "hostFunctions" ? 3 : 0) +
        Math.floor(1000 / (utf8Length(text) + 10));
      hits.push({ score, hit: { section, entry } });
    }
  }
  // Stable, highest first (Rust's sort_by_key on Reverse).
  hits.sort((a, b) => b.score - a.score);
  const found = hits.slice(0, limit).map((h) => h.hit);
  return { query, matches: found.length, results: found };
}

/** The scripting constraints, always worth reading before a first script. */
export const constraints = (catalog: Catalog): unknown =>
  catalog["constraints"] ?? null;
