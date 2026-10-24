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

// Small test doubles a bundle's own suite needs beside the harness, so no
// suite hand-rolls them (community bundles included). Runner-agnostic:
// nothing here imports a test runner.
//
//   loadBundle(() => fake.editor, bundle, {
//     console: silentConsole,
//     storage: mapBacking(),
//   });
//
// `createFakeEditor` (the gesture kit) is the recording editor such a call
// takes; `createHeadlessHost` is the conformance host over the real engine.

import type {
  DataBindingInfo,
  DataRowEdit,
  DataService,
  DataTableInfo,
  ProviderField,
  ProviderRecordSet,
} from "@paged-media/plugin-api";

import type { StorageBacking } from "./host-impl.js";

/** A `StorageBacking` over an in-memory map: what `host.storage` persists
 *  into in a test, private to the test (a browser-like realm's
 *  `localStorage` would leak between tests). `entries` seeds it. */
export function mapBacking(
  entries?: Iterable<readonly [string, string]>,
): StorageBacking {
  const map = new Map<string, string>(entries);
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    keys: () => Array.from(map.keys()),
  };
}

/** A console (and `PluginLogger`) that says nothing: the `console` of a
 *  host under test, or the `log` of a stub host. */
export const silentConsole: Readonly<
  Pick<Console, "debug" | "info" | "warn" | "error">
> = Object.freeze({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
});

/** One table of a {@link fakeDataService}: its fields and its rows. */
export interface FakeDataTable {
  fields: readonly ProviderField[];
  rows: readonly Readonly<Record<string, unknown>>[];
  /** A query table is read-only (`write` refuses it). Default `"source"`. */
  kind?: "source" | "query";
}

/**
 * An in-memory `DataService` (`data@1`, extensions ADR 343) for a bundle's
 * tests: serve it with `harness.data.serve("test", fake)` (or a serving
 * bundle's `host.data.serve`), and a consumer under test reads, writes and
 * binds as it would against paged.data. `query` answers `SELECT * FROM
 * <table>` only, and says so for anything else: the fake runs no SQL.
 * Bindings are recorded, not resolved.
 */
export function fakeDataService(
  tables: Readonly<Record<string, FakeDataTable>>,
): DataService & {
  /** The rows as they are now, by table. */
  rows(table: string): readonly Record<string, unknown>[];
} {
  const state = new Map(
    Object.entries(tables).map(([name, t]) => [
      name,
      { ...t, rows: t.rows.map((r) => ({ ...r })), revision: 1 },
    ]),
  );
  const bindings = new Map<string, DataBindingInfo>();
  let nextBinding = 1;
  const table = (name: string) => {
    const t = state.get(name);
    if (!t) throw new Error(`no table ${name}`);
    return t;
  };
  const recordSet = (
    name: string,
    offset = 0,
    limit = Infinity,
  ): ProviderRecordSet => {
    const t = table(name);
    const rows = t.rows.slice(offset, offset + limit);
    return {
      schema: { fields: [...t.fields] },
      columns: t.fields.map((f) => rows.map((r) => r[f.name] ?? null)),
      rowCount: rows.length,
    };
  };
  const info = (name: string): DataTableInfo => {
    const t = table(name);
    return {
      name,
      kind: t.kind ?? "source",
      schema: { fields: [...t.fields] },
      rowCount: t.rows.length,
      revision: String(t.revision),
      writable: (t.kind ?? "source") === "source",
    };
  };
  return {
    tables: () => [...state.keys()].map(info),
    async records(name, range) {
      return recordSet(name, range?.offset, range?.limit);
    },
    async query(sql) {
      const m =
        /^\s*select\s+\*\s+from\s+([A-Za-z_][A-Za-z0-9_]*)\s*;?\s*$/i.exec(sql);
      if (!m)
        throw new Error(
          "fakeDataService answers SELECT * FROM <table> only (it runs no SQL)",
        );
      return recordSet(m[1]!);
    },
    async write(name, edits: readonly DataRowEdit[]) {
      const t = table(name);
      if ((t.kind ?? "source") !== "source")
        throw new Error(`${name} is a query: it cannot be written`);
      const fields = new Set(t.fields.map((f) => f.name));
      for (const e of edits) {
        if (e.op === "set") {
          if (!t.rows[e.row]) throw new Error(`${name} has no row ${e.row}`);
          if (!fields.has(e.field))
            throw new Error(`${name} has no field ${e.field}`);
          t.rows[e.row]![e.field] = e.value;
        } else if (e.op === "insert") {
          t.rows.push({ ...e.values });
        } else {
          if (!t.rows[e.row]) throw new Error(`${name} has no row ${e.row}`);
          t.rows.splice(e.row, 1);
        }
      }
      t.revision++;
      return { revision: String(t.revision), rowCount: t.rows.length };
    },
    async bind(spec) {
      const b = { ...spec, id: `b${nextBinding++}` };
      bindings.set(b.id, b);
      return b;
    },
    async unbind(id) {
      bindings.delete(id);
    },
    async bindings() {
      return [...bindings.values()];
    },
    async evaluate(query, expr, record) {
      const t = table(query);
      const field = expr.trim();
      if (!t.fields.some((f) => f.name === field))
        return {
          display: "",
          value: null,
          error: "fakeDataService evaluates a bare field name only",
        };
      const value = t.rows[record]?.[field] ?? null;
      return { display: value === null ? "" : String(value), value };
    },
    rows: (name) => table(name).rows,
  };
}
