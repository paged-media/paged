// Local file import into the query store (wave 6; ADR 561): which formats
// there are, and the SQL quoting that keeps a name from becoming SQL.
// Transport only — the engine reads every format (data-store):
//   csv / tsv  the `csv` crate; a CSV's delimiter is sniffed, each column
//              typed from its fields, and the file also kept as written.
//   json       an array of objects or one object per line; nested values
//              are kept as their JSON text.
//   parquet    the row reader (snappy, gzip, brotli, lz4; not zstd).
//   xlsx       one worksheet, typed per column by data-xlsx (calamine).
//
// Every source is materialised as a table, so a query names it the same way
// whatever it was imported from (`SELECT * FROM products`).

import type { QueryHandle } from "./store";

/** The formats a local file can be imported as. */
export type ImportFormat = "csv" | "tsv" | "json" | "parquet" | "xlsx";

/** File extension → format. `.ndjson` / `.jsonl` are JSON (the reader
 *  takes an array of objects or one object per line). */
export const IMPORT_EXTENSIONS: Readonly<Record<string, ImportFormat>> = {
  ".csv": "csv",
  ".tsv": "tsv",
  ".json": "json",
  ".ndjson": "json",
  ".jsonl": "json",
  ".parquet": "parquet",
  ".xlsx": "xlsx",
};

/** The `accept` list for a file picker. */
export const IMPORT_ACCEPT: readonly string[] = Object.keys(IMPORT_EXTENSIONS);

/** The format of a file by its extension, or null when it is not importable. */
export function formatOfFile(fileName: string): ImportFormat | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return null;
  return IMPORT_EXTENSIONS[fileName.slice(dot).toLowerCase()] ?? null;
}

/** A source name from a file name: the stem, with anything but letters,
 *  digits and `_` replaced, never starting with a digit. */
export function sourceNameOf(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const clean = base.replace(/[^a-zA-Z0-9_]/g, "_") || "data";
  return /^[0-9]/.test(clean) ? `_${clean}` : clean;
}

/** A SQL identifier, double-quoted. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** A SQL string literal, single-quoted. */
export function quoteLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** What an import loaded. */
export interface LoadOutcome {
  /** The worksheet read (xlsx only). */
  sheet?: string;
  /** Every worksheet of the workbook (xlsx only). */
  sheets?: string[];
  /** Error cells read as NULL (xlsx only). */
  errorCells?: number;
}

/** Load one imported file into the store as the table `source`, replacing
 *  it. Every format is read by the engine (data-store): CSV and TSV through
 *  the `csv` crate (a CSV's delimiter sniffed), JSON as an array of objects
 *  or one object per line, Parquet through the row reader, XLSX one
 *  worksheet (`sheet`, else the first). Throws the engine's reason when the
 *  file does not read. */
export async function loadIntoStore(
  store: QueryHandle,
  source: string,
  format: ImportFormat,
  bytes: Uint8Array,
  sheet?: string,
): Promise<LoadOutcome> {
  const r = await store.importFile(source, format, bytes, sheet);
  if (format !== "xlsx") return {};
  return {
    ...(r.sheet !== undefined ? { sheet: r.sheet } : {}),
    ...(r.sheets !== undefined ? { sheets: r.sheets } : {}),
    errorCells: r.errorCells,
  };
}
