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

// The settings inventory (apps/editor/scripts/settings-inventory.json) is
// the source of truth for the editor's `setting:` surface ids: the
// surface-coverage gate reads its ids. This test keeps it from drifting
// away from the code, in both directions:
//
//   · every browser-storage call site in the editor's sources is claimed
//     by exactly one inventory entry (a setting, or an exclusion with its
//     reason) — so a new persisted key fails here until it is listed, and
//     once listed the gate demands a test for it;
//   · every entry still names a source that holds its marker and exactly
//     the call sites it claims — so a renamed or removed key fails too.
//
// A scanner that silently stops matching would make both directions pass
// vacuously, so the run asserts a floor on what it found.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const EDITOR = join(REPO, "apps/editor");
const INVENTORY = join(EDITOR, "scripts/settings-inventory.json");

type Site = [method: string, expr: string];

interface Entry {
  id?: string;
  key?: string;
  kind?: string;
  storage: string;
  source: string;
  marker: string;
  sites: Site[];
  reason?: string;
  default?: unknown;
}

interface Inventory {
  settings: Entry[];
  excluded: Entry[];
}

const KINDS = new Set([
  "preference",
  "persisted-ui-state",
  "export-option",
  "user-library",
  "feature-flag",
  "view-option",
  "ui-state",
  "url-flag",
]);
const STORAGES = new Set([
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "opfs",
  "memory",
  "url",
]);

const inventory = JSON.parse(readFileSync(INVENTORY, "utf8")) as Inventory;

// ── the scan ────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Line comments and the lines of a block comment, blanked (a call site
 *  quoted in prose is not a call site). */
const stripComments = (src: string) =>
  src
    .split("\n")
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? "" : line))
    .join("\n");

/** The first argument at `i` (just past the call's `(`), as written:
 *  string and template literals respected, nesting counted, whitespace
 *  collapsed. */
function firstArgument(src: string, i: number): string {
  let depth = 0;
  let quote: string | null = null;
  let out = "";
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += src[++i];
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    }
    if (c === "," && depth === 0) break;
    out += c;
  }
  return out.trim().replace(/\s+/g, " ");
}

/** Every storage call: Storage's item methods (on localStorage,
 *  sessionStorage or any alias of them), the Storage enumeration and
 *  `clear`, IndexedDB opens and the origin-private file system's root. */
const CALL =
  /\.(getItem|setItem|removeItem|getDirectory)\(|indexedDB\.open\(|(?:localStorage|sessionStorage)\.(clear|key)\(|(?:localStorage|sessionStorage)\[/g;

interface FoundSite {
  file: string;
  method: string;
  expr: string;
}

function scan(): FoundSite[] {
  const roots = [
    join(EDITOR, "apps/canvas/src"),
    ...readdirSync(join(EDITOR, "packages")).map((p) =>
      join(EDITOR, "packages", p, "src"),
    ),
  ];
  const found: FoundSite[] = [];
  for (const root of roots) {
    for (const path of walk(root)) {
      const src = stripComments(readFileSync(path, "utf8"));
      for (const m of src.matchAll(CALL)) {
        const method =
          m[1] ??
          m[2] ??
          (m[0].startsWith("indexedDB") ? "indexedDB.open" : "[]");
        found.push({
          file: relative(REPO, path),
          method,
          expr:
            method === "[]"
              ? firstArgument(src, m.index! + m[0].length).replace(/\]$/, "")
              : firstArgument(src, m.index! + m[0].length),
        });
      }
    }
  }
  return found;
}

const siteKey = (file: string, [method, expr]: Site) =>
  `${file} :: ${method}(${expr})`;
const squash = (s: string) => s.replace(/\s+/g, "");

const entries = [...inventory.settings, ...inventory.excluded];
const label = (e: Entry) => e.id ?? e.key ?? "?";

// ── the assertions ──────────────────────────────────────────────────

describe("the settings inventory", () => {
  test("is well formed: unique ids, a known kind and storage, a real source", () => {
    expect(inventory.settings.length).toBeGreaterThanOrEqual(15);
    const ids = inventory.settings.map((s) => s.id);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(
      true,
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of inventory.settings) {
      expect({ id: s.id, kind: KINDS.has(s.kind ?? "") }).toEqual({
        id: s.id,
        kind: true,
      });
      expect("default" in s).toBe(true);
    }
    for (const e of entries) {
      expect({ entry: label(e), storage: STORAGES.has(e.storage) }).toEqual({
        entry: label(e),
        storage: true,
      });
      expect({
        entry: label(e),
        exists: existsSync(join(REPO, e.source)),
      }).toEqual({ entry: label(e), exists: true });
      // Memory and URL settings have no storage call; everything else
      // must claim at least one.
      const callless = e.storage === "memory" || e.storage === "url";
      expect({ entry: label(e), sites: e.sites.length > 0 }).toEqual({
        entry: label(e),
        sites: !callless,
      });
    }
    for (const e of inventory.excluded) {
      expect((e.reason ?? "").length).toBeGreaterThan(40);
    }
  });

  test("every entry's source still holds its marker", () => {
    const missing = entries
      .filter(
        (e) =>
          !squash(readFileSync(join(REPO, e.source), "utf8")).includes(
            squash(e.marker),
          ),
      )
      .map((e) => `${label(e)}: ${e.marker} not in ${e.source}`);
    expect(missing).toEqual([]);
  });

  test("every storage call site in the editor is claimed, exactly as written", () => {
    const found = scan();
    // The floor: the editor has 27 storage call sites as of this test;
    // a scanner that comes back with a handful has lost its footing.
    expect(found.length).toBeGreaterThanOrEqual(20);

    const counts = new Map<string, number>();
    for (const f of found) {
      const k = siteKey(f.file, [f.method, f.expr]);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const claimed = new Map<string, number>();
    for (const e of entries) {
      for (const site of e.sites) {
        const k = siteKey(e.source, site);
        claimed.set(k, (claimed.get(k) ?? 0) + 1);
      }
    }
    const unclaimed = [...counts]
      .filter(([k, n]) => (claimed.get(k) ?? 0) < n)
      .map(([k]) => k);
    const stale = [...claimed]
      .filter(([k, n]) => (counts.get(k) ?? 0) < n)
      .map(([k]) => k);
    expect({ unclaimed, stale }).toEqual({ unclaimed: [], stale: [] });
  });

  test("a site is claimed by one entry only", () => {
    const owner = new Map<string, string>();
    const twice: string[] = [];
    for (const e of entries) {
      for (const k of new Set(e.sites.map((s) => siteKey(e.source, s)))) {
        const prior = owner.get(k);
        if (prior && prior !== label(e))
          twice.push(`${k}: ${prior}, ${label(e)}`);
        owner.set(k, label(e));
      }
    }
    expect(twice).toEqual([]);
  });

  test("a persisted setting names its literal key in its source", () => {
    const persisted = inventory.settings.filter(
      (s) => s.storage === "localStorage" || s.storage === "sessionStorage",
    );
    expect(persisted.length).toBeGreaterThanOrEqual(9);
    for (const s of persisted) {
      const src = readFileSync(join(REPO, s.source), "utf8");
      expect({ id: s.id, key: src.includes(`"${s.key}"`) }).toEqual({
        id: s.id,
        key: true,
      });
    }
  });
});
