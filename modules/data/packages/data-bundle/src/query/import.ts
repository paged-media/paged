// Local file import into the query store (wave 6; ADR 561): which formats
// there are, and the SQL quoting that keeps a name from becoming SQL.
// Transport only — the engine reads every format (data-store):
//   csv / tsv  the `csv` crate; a CSV's delimiter is sniffed, each column
//              typed from its fields, and the file also kept as written.
//   json       an array of objects or one object per line; nested values
//              are kept as their JSON text.
//   parquet    the row reader (snappy, gzip, brotli, lz4; not zstd).
//   xlsx       one worksheet, typed per column by data-xlsx (over sheet-xlsx).
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

/** A delimited text file's bytes as text, and how they were read. */
export interface DecodedText {
  text: string;
  /** The encoding the bytes were read as. */
  encoding: "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";
  /** Set when the file did not say or keep its encoding: what was assumed
   *  or replaced, for a diagnostic. Absent when the text is exactly the
   *  file's. */
  note?: string;
}

/** Read a CSV or TSV file's bytes as text without losing a byte silently.
 *  A byte-order mark names the encoding (UTF-8, UTF-16LE, UTF-16BE) and is
 *  dropped. Without one the file is UTF-8 when it is valid UTF-8; otherwise
 *  it is read as Windows-1252 (what a spreadsheet's "CSV" export writes on
 *  most systems; every byte maps to a character), and `note` says so. A
 *  UTF-16 file with a broken pair keeps U+FFFD there, and `note` counts
 *  them. */
export function decodeDelimitedText(bytes: Uint8Array): DecodedText {
  const utf16 =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : null;
  if (utf16) {
    try {
      const text = new TextDecoder(utf16, { fatal: true }).decode(bytes);
      return { text, encoding: utf16 };
    } catch {
      const text = new TextDecoder(utf16).decode(bytes);
      const replaced = text.split("\ufffd").length - 1;
      return {
        text,
        encoding: utf16,
        note: `the file is not valid UTF-16: ${replaced} character${replaced === 1 ? "" : "s"} could not be read and show as \ufffd`,
      };
    }
  }
  try {
    // The decoder drops a UTF-8 byte-order mark.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, encoding: "utf-8" };
  } catch {
    return {
      text: new TextDecoder("windows-1252").decode(bytes),
      encoding: "windows-1252",
      note: "the file is not UTF-8 and has no byte-order mark: it was read as Windows-1252 — save it as UTF-8 if characters are wrong",
    };
  }
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
