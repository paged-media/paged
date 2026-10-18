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

// `apply` and `merge` over TODAY's paged.data session (canary.10): the
// installed @paged-media/data bundle's `sessionFor(host)` — import the CSV
// (DuckDB, in-process through node-shims), define a query, then the
// session's own bindings / Data Merge writer. The universal
// `Binding::Property` (ADR 558, Wave 5) is not in that session yet; the CLI
// carries an INTERIM `property` binding that maps one record FIELD onto one
// (address|selector, path) through `host.objects.batch` — no expression
// language (`expr` waits for Wave 5).

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import type { ObjectOp } from "@paged-media/plugin-api";

import { CliError, EXIT } from "./errors";
import type { CliSession } from "./session";
import { parseCliValue } from "./values";
import { normalizeAddress } from "@paged-media/plugin-sdk";

export const DATA_PLUGIN = "media.paged.data";
export const WAVE5 =
  "needs Wave 5 (paged.data's universal Binding::Property with expressions, ADR 558) — use { \"field\": … } until then";

/** The slice of the data session (`DataSourceSession`, canary.10) the CLI drives. */
export interface DataSessionLike {
  whenRestored(): Promise<void>;
  importFile(fileName: string, bytes: Uint8Array, options?: { name?: string }): Promise<{ error?: string }>;
  saveQuery(id: string, sql: string, shape?: "recordStream" | "singleRecord" | "scalar"): Promise<{ message: string } | null>;
  previewQuery(sql: string, limit?: number): Promise<{
    columns: { name: string }[];
    rows: (string | null)[][];
    total: number | null;
    diagnostic: { message: string } | null;
  }>;
  mergeRecords(options: Record<string, unknown>): Promise<{
    ok: boolean;
    pages: string[];
    records: unknown[];
    overset: number[];
    mutateCalls: number;
    diagnostics: string[];
  }>;
  addVariableBinding(id: string, target: string, query: string, expr: string): void;
  addTableBinding(id: string, region: string, query: string, columns: unknown[]): void;
  addImageBinding(id: string, target: string, query: string, expr: string, options?: unknown): void;
  addBarcodeBinding(id: string, target: string, query: string, symbology: unknown, expr: string, options?: unknown): void;
  addVisibilityBinding(id: string, target: string, query: string, expr: string, options?: unknown): void;
  addRuleBinding(id: string, scope: string, query: string, when: string, apply: unknown): void;
  lowerAll(): Promise<void>;
  previewRecord(bindingId: string, record: number): Promise<void>;
  getState(): { status: string; message: string };
  diagnostics?: unknown;
  flushPersist(): Promise<void>;
}

const QUERY_ID = "records";
const SOURCE = "data";

/** The data session of the loaded paged.data bundle. */
export async function dataSession(s: CliSession): Promise<DataSessionLike> {
  const p = s.plugin(DATA_PLUGIN);
  if (!p) {
    const why = s.pluginProblems.find((x) => x.source === "@paged-media/data")?.error;
    throw new CliError(
      EXIT.usage,
      `this verb needs the paged.data bundle — install @paged-media/data (and @duckdb/duckdb-wasm@1.29.0) beside the CLI` +
        (why ? ` (it was found but: ${why})` : ""),
    );
  }
  const sessionFor = p.module["sessionFor"] as ((host: unknown) => DataSessionLike | undefined) | undefined;
  const ds = sessionFor?.(p.host);
  if (!ds) throw new CliError(EXIT.failed, `${p.source} exposes no data session (sessionFor) — a newer bundle is needed`);
  await ds.whenRestored();
  return ds;
}

/** Import `csvPath` as source `data` and define query `records` over it. */
export async function loadRecords(ds: DataSessionLike, csvPath: string, sql?: string): Promise<{ query: string; total: number | null }> {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(csvPath);
  } catch (err) {
    throw new CliError(EXIT.usage, `cannot read ${csvPath}: ${(err as Error).message}`);
  }
  const imported = await ds.importFile(basename(csvPath), bytes, { name: SOURCE });
  if (imported.error) throw new CliError(EXIT.failed, `import ${csvPath}: ${imported.error}`);
  const query = sql ?? `SELECT * FROM "${SOURCE}"`;
  const diag = await ds.saveQuery(QUERY_ID, query, "recordStream");
  if (diag) throw new CliError(EXIT.failed, `query: ${diag.message}`);
  const preview = await ds.previewQuery(query, 1);
  if (preview.diagnostic) throw new CliError(EXIT.failed, `query: ${preview.diagnostic.message}`);
  return { query, total: preview.total };
}

export interface MergeFlags {
  recordsPerPage: "single" | "multiple";
  arrange: "rows" | "columns";
  rowSpacing: number;
  columnSpacing: number;
  removeBlankLines: boolean;
  imageBase?: string;
  imageFields?: Record<string, string>;
}

function mergeOptions(f: MergeFlags, query: string): Record<string, unknown> {
  return {
    query,
    recordsPerPage:
      f.recordsPerPage === "multiple"
        ? { mode: "multiple", arrange: f.arrange, rowSpacingPt: f.rowSpacing, columnSpacingPt: f.columnSpacing }
        : { mode: "single" },
    removeBlankLines: f.removeBlankLines,
    template: "consume",
    ...(f.imageBase ? { imageBase: f.imageBase } : {}),
    ...(f.imageFields ? { imageFields: f.imageFields } : {}),
  };
}

/** One merge into the open document (InDesign's "Create Merged Document"). */
export async function mergeOnce(ds: DataSessionLike, flags: MergeFlags, query = QUERY_ID) {
  const result = await ds.mergeRecords(mergeOptions(flags, query));
  if (!result.ok) {
    throw new CliError(EXIT.failed, `merge failed: ${result.diagnostics.join("; ") || ds.getState().message}`);
  }
  return result;
}

/** Re-point the `records` query at one record (per-record output). */
export async function selectRecord(ds: DataSessionLike, base: string, index: number): Promise<string> {
  const id = `${QUERY_ID}-one`;
  const diag = await ds.saveQuery(id, `SELECT * FROM (${base}) LIMIT 1 OFFSET ${index}`, "recordStream");
  if (diag) throw new CliError(EXIT.failed, `query: ${diag.message}`);
  return id;
}

// ------------------------------------------------------------------ apply

export interface BindingsFile {
  query?: string;
  record?: number;
  bindings: Array<Record<string, unknown>>;
}

export function readBindings(path: string): BindingsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new CliError(EXIT.usage, `cannot read bindings ${path}: ${(err as Error).message}`);
  }
  const file = (Array.isArray(parsed) ? { bindings: parsed } : parsed) as BindingsFile;
  if (!file || !Array.isArray(file.bindings)) throw new CliError(EXIT.usage, `${path}: expected { "bindings": [ … ] } or an array`);
  for (const [i, b] of file.bindings.entries()) {
    if (typeof b !== "object" || b === null || typeof b["kind"] !== "string") {
      throw new CliError(EXIT.usage, `${path}: bindings[${i}] has no "kind"`);
    }
  }
  return file;
}

const str = (b: Record<string, unknown>, key: string, i: number): string => {
  const v = b[key];
  if (typeof v !== "string" || v === "") throw new CliError(EXIT.usage, `bindings[${i}] (${String(b["kind"])}): "${key}" must be a non-empty string`);
  return v;
};

export interface ApplyReport {
  record: number;
  sessionBindings: string[];
  property: { ops: number; undoSteps: number };
}

/**
 * Apply `file` against record `record` (0-based) of the loaded data:
 * session bindings through the data session (previewRecord / lowerAll),
 * interim property bindings through ONE `host.objects.batch`.
 */
export async function applyBindings(s: CliSession, ds: DataSessionLike, file: BindingsFile, query: string, record: number): Promise<ApplyReport> {
  const sessionIds: string[] = [];
  const property: Array<{ i: number; target: string; path: string; field: string }> = [];
  for (const [i, b] of file.bindings.entries()) {
    const kind = b["kind"] as string;
    if (kind === "property") {
      if (b["expr"] !== undefined) throw new CliError(EXIT.failed, `bindings[${i}] property: ${WAVE5}`);
      property.push({ i, target: str(b, "target", i), path: str(b, "path", i), field: str(b, "field", i) });
      continue;
    }
    const id = typeof b["id"] === "string" ? (b["id"] as string) : `cli-${kind}-${i}`;
    switch (kind) {
      case "variable":
        ds.addVariableBinding(id, str(b, "target", i), QUERY_ID, str(b, "expr", i));
        break;
      case "image":
        ds.addImageBinding(id, str(b, "target", i), QUERY_ID, str(b, "expr", i), b["options"]);
        break;
      case "visibility":
        ds.addVisibilityBinding(id, str(b, "target", i), QUERY_ID, str(b, "expr", i), b["options"]);
        break;
      case "barcode":
        ds.addBarcodeBinding(id, str(b, "target", i), QUERY_ID, b["symbology"], str(b, "expr", i), b["options"]);
        break;
      case "table":
        ds.addTableBinding(id, str(b, "region", i), QUERY_ID, (b["columns"] as unknown[]) ?? []);
        break;
      case "rule":
        ds.addRuleBinding(id, str(b, "scope", i), QUERY_ID, str(b, "when", i), b["apply"]);
        break;
      default:
        throw new CliError(EXIT.usage, `bindings[${i}]: unknown kind "${kind}" (property, variable, image, visibility, barcode, table, rule)`);
    }
    sessionIds.push(id);
  }

  if (sessionIds.length > 0) {
    if (record === 0) await ds.lowerAll();
    else for (const id of sessionIds) await ds.previewRecord(id, record);
    const st = ds.getState();
    if (st.status === "error") throw new CliError(EXIT.failed, `bindings: ${st.message}`);
  }

  let propertyResult = { ops: 0, undoSteps: 0 };
  if (property.length > 0) {
    const preview = await ds.previewQuery(`SELECT * FROM (${query}) LIMIT 1 OFFSET ${record}`, 1);
    if (preview.diagnostic) throw new CliError(EXIT.failed, `query: ${preview.diagnostic.message}`);
    const row = preview.rows[0];
    if (!row) throw new CliError(EXIT.failed, `record ${record} does not exist (${preview.total ?? 0} records)`);
    const col = (field: string, i: number): string | null => {
      const at = preview.columns.findIndex((c) => c.name === field);
      if (at < 0) throw new CliError(EXIT.failed, `bindings[${i}]: no field "${field}" (fields: ${preview.columns.map((c) => c.name).join(", ")})`);
      return row[at] ?? null;
    };
    const ops: ObjectOp[] = [];
    for (const p of property) {
      const text = col(p.field, p.i);
      const targets = normalizeAddress(p.target) ? [p.target] : await s.h.objects.query(p.target);
      if (targets.length === 0) throw new CliError(EXIT.failed, `bindings[${p.i}]: "${p.target}" matches nothing`);
      for (const address of targets) {
        const rows = await s.h.objects.schema(address);
        const parsed = text === null ? parseCliValue(rows, address, p.path, "null") : parseCliValue(rows, address, p.path, text);
        if (!parsed.ok) throw new CliError(EXIT.failed, `bindings[${p.i}]: ${parsed.reason}`);
        ops.push({ op: "set", address, path: p.path, value: parsed.value });
      }
    }
    const res = await s.h.objects.batch(ops);
    if (!res.applied) throw new CliError(EXIT.failed, `property bindings refused: ${res.reason ?? res.code}`, { result: res });
    propertyResult = { ops: ops.length, undoSteps: res.undoSteps };
  }
  return { record, sessionBindings: sessionIds, property: propertyResult };
}

export const resolveFrom = (cwd: string, p: string): string => resolve(cwd, p);
