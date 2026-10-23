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

// `apply`, `merge` and `generate` drive paged.data through its TYPED
// commands only (plan G4), the way a script does: `importSource` reads the
// file, a `query` object (host.objects) selects the records, `previewQuery`
// counts them, `defineBinding` / `defineProperty` / `apply` place one
// record, `merge` runs Data Merge, `planBatch` partitions the records into
// the units of a batch. Nothing reaches into the bundle's session. A
// `property` binding with an `expr` is paged.data's own property binding
// (`defineProperty`, ADR 558): the engine evaluates the expression and
// coerces it to the property's schema row. One with a `field` instead is
// the CLI's shorthand: the record's text for that field, typed by the
// schema row the way `set` types a value, all of them in ONE
// `host.objects.batch`.

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import type { ObjectOp } from "@paged-media/plugin-api";

import { CliError, EXIT } from "./errors";
import type { CliSession } from "./session";
import { parseCliValue } from "./values";
import { normalizeAddress } from "@paged-media/plugin-sdk";

export const DATA_PLUGIN = "media.paged.data";

const D = DATA_PLUGIN;
const QUERY_ID = "records";
const SOURCE = "data";
/** The typed commands the verbs need; a bundle without them is too old. */
const NEEDED = [
  "importSource",
  "previewQuery",
  "defineBinding",
  "defineProperty",
  "merge",
  "apply",
].map((c) => `${D}.${c}`);

/** Fail unless the paged.data bundle is loaded with the typed commands the
 *  data verbs drive. */
export async function requireData(s: CliSession): Promise<void> {
  const p = s.plugin(DATA_PLUGIN);
  if (!p) {
    const why = s.pluginProblems.find(
      (x) => x.source === "@paged-media/data",
    )?.error;
    throw new CliError(
      EXIT.usage,
      `this verb needs the paged.data bundle (media.paged.data), and none is loaded. The published @paged-media/paged does not include it: paged.data is built into the editor and runs on DuckDB-WASM (34 MiB). In a checkout of the repository, build its wasm (\`moon run data:wasm\`)` +
        (why ? ` (it was found but: ${why})` : ""),
    );
  }
  const known = new Set((await s.h.objects.commands()).map((c) => c.id));
  const missing = NEEDED.filter((id) => !known.has(id));
  if (missing.length)
    throw new CliError(
      EXIT.failed,
      `${p.source} has no ${missing.join(", ")} — a newer bundle is needed`,
    );
}

/** Run one of paged.data's typed commands; a refusal fails the verb. */
export async function dataCommand<T>(
  s: CliSession,
  command: string,
  args: unknown,
): Promise<T> {
  try {
    return (await s.h.objects.invoke(`${D}.${command}`, args)) as T;
  } catch (err) {
    throw new CliError(
      EXIT.failed,
      `${D}.${command}: ${(err as Error).message ?? String(err)}`,
    );
  }
}

/** Define (or redefine) query `id` as `sql`, through host.objects. */
async function defineQuery(
  s: CliSession,
  id: string,
  sql: string,
): Promise<void> {
  const r = await s.h.objects.batch([
    {
      op: "create",
      kind: `plugin:${D}/query`,
      handle: id,
      props: { sql, shape: "recordStream" },
    },
  ]);
  if (!r.applied)
    throw new CliError(EXIT.failed, `query: ${r.reason ?? r.code}`);
}

interface Preview {
  columns: string[];
  rows: string[][];
  total?: number;
  problem?: string;
}

async function preview(
  s: CliSession,
  sql: string,
  limit: number,
): Promise<Preview> {
  const p = await dataCommand<Preview>(s, "previewQuery", { sql, limit });
  if (p.problem) throw new CliError(EXIT.failed, `query: ${p.problem}`);
  return p;
}

/** Import `dataPath` as source `data` and define query `records` over it. */
export async function loadRecords(
  s: CliSession,
  dataPath: string,
  sql?: string,
): Promise<{ query: string; total: number | null }> {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(dataPath);
  } catch (err) {
    throw new CliError(
      EXIT.usage,
      `cannot read ${dataPath}: ${(err as Error).message}`,
    );
  }
  try {
    await s.h.objects.invoke(`${D}.importSource`, {
      bytes,
      fileName: basename(dataPath),
      name: SOURCE,
    });
  } catch (err) {
    throw new CliError(
      EXIT.failed,
      `import ${dataPath}: ${(err as Error).message.replace(/^invalidValue: /, "")}`,
    );
  }
  const query = sql ?? `SELECT * FROM "${SOURCE}"`;
  await defineQuery(s, QUERY_ID, query);
  const p = await preview(s, query, 1);
  return { query, total: p.total ?? null };
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

/** What `media.paged.data.merge` answers. */
export interface MergeResult {
  ok: boolean;
  records: number;
  pages: number;
  oversetRecords: number[];
  undoSteps: number;
  message: string;
  diagnostics: string[];
}

/** One merge into the open document (InDesign's "Create Merged Document"),
 *  through the typed `media.paged.data.merge`. */
export async function mergeOnce(
  s: CliSession,
  f: MergeFlags,
  query = QUERY_ID,
): Promise<MergeResult> {
  const r = await dataCommand<MergeResult>(s, "merge", {
    query,
    mode: f.recordsPerPage,
    ...(f.recordsPerPage === "multiple"
      ? {
          arrange: f.arrange,
          rowSpacingPt: f.rowSpacing,
          columnSpacingPt: f.columnSpacing,
        }
      : {}),
    removeBlankLines: f.removeBlankLines,
    template: "consume",
    ...(f.imageBase ? { imageBase: f.imageBase } : {}),
    ...(f.imageFields ? { imageFields: f.imageFields } : {}),
  });
  if (!r.ok)
    throw new CliError(
      EXIT.failed,
      `merge failed: ${r.diagnostics.join("; ") || r.message}`,
    );
  return { ...r, oversetRecords: r.oversetRecords ?? [] };
}

/** Back to the template: the merge's own undo steps. */
export async function undoMerge(s: CliSession, r: MergeResult): Promise<void> {
  for (let u = 0; u < r.undoSteps; u++) await s.driver.document.undo();
}

/** Define query `records-unit` as the records `indices` (0-based, in the
 *  order the base query delivers them) of `base`. */
export async function selectRecords(
  s: CliSession,
  base: string,
  indices: readonly number[],
): Promise<string> {
  const id = `${QUERY_ID}-unit`;
  const sql =
    indices.length === 1
      ? `SELECT * FROM (${base}) LIMIT 1 OFFSET ${indices[0]}`
      : `SELECT * EXCLUDE (paged_row) FROM (SELECT *, row_number() OVER () - 1 AS paged_row FROM (${base})) WHERE paged_row IN (${indices.join(", ")}) ORDER BY paged_row`;
  await defineQuery(s, id, sql);
  return id;
}

/** The units of a batch over query `records`: one per record, per group of
 *  the columns `by`, or one catalogue. */
export async function planBatch(
  s: CliSession,
  mode: "perRecord" | "perGroup" | "oneCatalog",
  by: readonly string[],
): Promise<{
  totalRecords: number;
  units: { label: string; records: number[] }[];
}> {
  return dataCommand(s, "planBatch", {
    query: QUERY_ID,
    mode,
    ...(mode === "perGroup" ? { by: [...by] } : {}),
  });
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
    throw new CliError(
      EXIT.usage,
      `cannot read bindings ${path}: ${(err as Error).message}`,
    );
  }
  const file = (
    Array.isArray(parsed) ? { bindings: parsed } : parsed
  ) as BindingsFile;
  if (!file || !Array.isArray(file.bindings))
    throw new CliError(
      EXIT.usage,
      `${path}: expected { "bindings": [ … ] } or an array`,
    );
  for (const [i, b] of file.bindings.entries()) {
    if (typeof b !== "object" || b === null || typeof b["kind"] !== "string") {
      throw new CliError(EXIT.usage, `${path}: bindings[${i}] has no "kind"`);
    }
  }
  return file;
}

const str = (b: Record<string, unknown>, key: string, i: number): string => {
  const v = b[key];
  if (typeof v !== "string" || v === "")
    throw new CliError(
      EXIT.usage,
      `bindings[${i}] (${String(b["kind"])}): "${key}" must be a non-empty string`,
    );
  return v;
};

export interface ApplyReport {
  record: number;
  sessionBindings: string[];
  property: { ops: number; undoSteps: number };
}

/** The fields of a `media.paged.data.defineBinding` for one session kind. */
const KIND_FIELDS: Record<string, readonly string[]> = {
  variable: ["target", "expr"],
  image: ["target", "expr"],
  visibility: ["target", "expr"],
  barcode: ["target", "expr"],
  table: ["region"],
  rule: ["scope", "when"],
};

/**
 * Apply `file` against record `record` (0-based) of the loaded data:
 * session bindings through `media.paged.data.defineBinding`, expression
 * property bindings through `media.paged.data.defineProperty`, both applied
 * by `media.paged.data.apply`; `field` property bindings through ONE
 * `host.objects.batch`.
 */
export async function applyBindings(
  s: CliSession,
  file: BindingsFile,
  query: string,
  record: number,
): Promise<ApplyReport> {
  const sessionIds: string[] = [];
  const property: Array<{
    i: number;
    target: string;
    path: string;
    field: string;
  }> = [];
  for (const [i, b] of file.bindings.entries()) {
    const kind = b["kind"] as string;
    if (kind === "property" && b["expr"] !== undefined) {
      if (b["field"] !== undefined)
        throw new CliError(
          EXIT.usage,
          `bindings[${i}] (property): give "expr" or "field", not both`,
        );
      const id =
        typeof b["id"] === "string" ? (b["id"] as string) : `cli-property-${i}`;
      const r = await dataCommand<{ ok: boolean; reason?: string }>(
        s,
        "defineProperty",
        {
          id,
          selector: str(b, "target", i),
          path: str(b, "path", i),
          query: QUERY_ID,
          expr: str(b, "expr", i),
        },
      );
      if (!r.ok)
        throw new CliError(
          EXIT.failed,
          `bindings[${i}] (property): ${r.reason ?? "refused"}`,
        );
      sessionIds.push(id);
      continue;
    }
    if (kind === "property") {
      property.push({
        i,
        target: str(b, "target", i),
        path: str(b, "path", i),
        field: str(b, "field", i),
      });
      continue;
    }
    const fields = KIND_FIELDS[kind];
    if (!fields)
      throw new CliError(
        EXIT.usage,
        `bindings[${i}]: unknown kind "${kind}" (property, ${Object.keys(KIND_FIELDS).join(", ")})`,
      );
    const id =
      typeof b["id"] === "string" ? (b["id"] as string) : `cli-${kind}-${i}`;
    const args: Record<string, unknown> = { id, kind, query: QUERY_ID };
    for (const f of fields) args[f] = str(b, f, i);
    for (const f of ["symbology", "columns", "options", "apply"])
      if (b[f] !== undefined) args[f] = b[f];
    await dataCommand(s, "defineBinding", args);
    sessionIds.push(id);
  }

  if (sessionIds.length > 0) {
    await dataCommand(s, "apply", { record });
    for (const id of sessionIds) {
      const st = await s.h.objects.get(`plugin:${D}/binding/${id}`, "status");
      if (st.kind === "value" && st.value === "error")
        throw new CliError(EXIT.failed, `bindings: ${id} did not resolve`);
    }
  }

  let propertyResult = { ops: 0, undoSteps: 0 };
  if (property.length > 0) {
    const p = await preview(
      s,
      `SELECT * FROM (${query}) LIMIT 1 OFFSET ${record}`,
      1,
    );
    const row = p.rows[0];
    if (!row)
      throw new CliError(
        EXIT.failed,
        `record ${record} does not exist (${p.total ?? 0} records)`,
      );
    const col = (field: string, i: number): string => {
      const at = p.columns.indexOf(field);
      if (at < 0)
        throw new CliError(
          EXIT.failed,
          `bindings[${i}]: no field "${field}" (fields: ${p.columns.join(", ")})`,
        );
      return row[at] ?? "";
    };
    const ops: ObjectOp[] = [];
    for (const b of property) {
      const text = col(b.field, b.i);
      const targets = normalizeAddress(b.target)
        ? [b.target]
        : await s.h.objects.query(b.target);
      if (targets.length === 0)
        throw new CliError(
          EXIT.failed,
          `bindings[${b.i}]: "${b.target}" matches nothing`,
        );
      for (const address of targets) {
        const rows = await s.h.objects.schema(address);
        const parsed = parseCliValue(rows, address, b.path, text);
        if (!parsed.ok)
          throw new CliError(EXIT.failed, `bindings[${b.i}]: ${parsed.reason}`);
        ops.push({ op: "set", address, path: b.path, value: parsed.value });
      }
    }
    const res = await s.h.objects.batch(ops);
    if (!res.applied)
      throw new CliError(
        EXIT.failed,
        `property bindings refused: ${res.reason ?? res.code}`,
        { result: res },
      );
    propertyResult = { ops: ops.length, undoSteps: res.undoSteps };
  }
  return { record, sessionBindings: sessionIds, property: propertyResult };
}

export const resolveFrom = (cwd: string, p: string): string => resolve(cwd, p);
