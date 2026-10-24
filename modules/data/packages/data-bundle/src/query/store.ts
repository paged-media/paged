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

// The query store (ADR 561): the imported sources live as tables in the data
// engine itself (data-store, an in-memory Turso database compiled into
// data-js), and a query's rows go from the store to the binding session
// without leaving the wasm. This file is the bundle's handle on that store:
// thin calls to the `store_*` methods of `DataEngine`, nothing computed here.
//
// What used to need a second engine — DuckDB-WASM, its worker, its
// extensions, the Arrow conversion — is gone: the same engine answers in the
// editor, in `paged-node` and on the server.

import type { DataRowEdit, ProviderRecordSet } from "@paged-media/plugin-api";
import type { DataEngineLike } from "../engine";
import type { ImportFormat } from "./import";

export const STORE_MISSING =
  "the data engine has no query store — rebuild it (`bash scripts/build-wasm.sh`)";

/** A column a query produces: its name and its type as the builders read
 *  it (`TEXT`, `INTEGER`, `DECIMAL(18,2)`, `REAL`, `BOOLEAN`, `DATE`,
 *  `TIMESTAMP`, `BLOB`, `NULL`). */
export interface StoreColumn {
  name: string;
  type: string;
}

/** What an import loaded (`DataEngine.store_import`). */
export interface StoreImport {
  table: string;
  columns: StoreColumn[];
  rows: number;
  /** The worksheet read (xlsx only). */
  sheet?: string;
  /** Every worksheet of the workbook (xlsx only). */
  sheets?: string[];
  /** Error cells read as NULL (xlsx only). */
  errorCells: number;
  /** Whether the source is also kept as written (CSV, TSV). */
  asWritten: boolean;
}

/** The first rows of a query as text (`null` for SQL NULL) and its count. */
export interface StorePreview {
  columns: StoreColumn[];
  rows: (string | null)[][];
  count: number;
}

/** A value now, or later. */
export type Awaitable<T> = T | Promise<T>;

/** The store, through the engine. The engine answers synchronously (it is in
 *  this realm); a test double may answer later, so callers await. A failure
 *  throws an `Error` whose `kind` and `offset` (into the SQL that ran)
 *  [`diagnoseStoreError`](./sql.ts) reads. */
export interface QueryHandle {
  /** Read a file as the source table `name`, replacing it. */
  importFile(
    name: string,
    format: ImportFormat,
    bytes: Uint8Array,
    sheet?: string,
  ): Awaitable<StoreImport>;
  /** Read CSV text as the source table `name` (the pasted and saved path). */
  importCsv(name: string, text: string): Awaitable<StoreImport>;
  /** Drop a source's table (and its as-written twin). */
  dropSource(name: string): Awaitable<void>;
  /** The source tables. */
  tables(): Awaitable<string[]>;
  /** Run `sql` and deliver its rows as `query`'s result; the row count. */
  ingest(query: string, sql: string): Awaitable<number>;
  /** Run `sql` over the CSV `sources` as written and deliver the rows as
   *  `query`'s result; the row count, or null when no source is kept as
   *  written. */
  ingestAsWritten(
    query: string,
    sql: string,
    sources: readonly string[],
  ): Awaitable<number | null>;
  /** The columns a query produces. */
  describe(sql: string): Awaitable<StoreColumn[]>;
  /** The first `limit` rows of a query as text and its row count. */
  preview(sql: string, limit: number): Awaitable<StorePreview>;
  /** A window of a source table, typed, in the provider shape (the data
   *  door, extensions ADR 343). Absent on an engine built before it. */
  records?(
    table: string,
    offset: number,
    limit: number,
  ): Awaitable<ProviderRecordSet>;
  /** Apply row edits to a source table in one transaction; the row count. */
  edit?(table: string, edits: readonly DataRowEdit[]): Awaitable<number>;
  /** A query's rows, typed, in the provider shape (the guard has run). */
  queryRecords?(sql: string): Awaitable<ProviderRecordSet>;
}

/** The store of a booted engine, or null for an engine built before it. */
export function storeHandle(e: DataEngineLike): QueryHandle | null {
  if (typeof e.store_import !== "function") return null;
  return {
    importFile(name, format, bytes, sheet) {
      return e.store_import!(name, format, bytes, sheet) as StoreImport;
    },
    importCsv(name, text) {
      return e.store_import!(
        name,
        "csv",
        new TextEncoder().encode(text),
      ) as StoreImport;
    },
    dropSource(name) {
      e.store_drop!(name);
    },
    tables() {
      return e.store_tables!();
    },
    ingest(query, sql) {
      return e.store_ingest!(query, sql);
    },
    ingestAsWritten(query, sql, sources) {
      return e.store_ingest_as_written!(query, sql, [...sources]) ?? null;
    },
    describe(sql) {
      return e.store_describe!(sql) as StoreColumn[];
    },
    preview(sql, limit) {
      return e.store_preview!(sql, limit) as StorePreview;
    },
    ...(typeof e.store_records === "function" &&
    typeof e.store_edit === "function" &&
    typeof e.store_query_records === "function"
      ? {
          records(table: string, offset: number, limit: number) {
            return e.store_records!(table, offset, limit) as ProviderRecordSet;
          },
          edit(table: string, edits: readonly DataRowEdit[]) {
            return e.store_edit!(table, [...edits]);
          },
          queryRecords(sql: string) {
            return e.store_query_records!(sql) as ProviderRecordSet;
          },
        }
      : {}),
  };
}
