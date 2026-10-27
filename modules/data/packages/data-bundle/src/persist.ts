// The data session as a `.paged` container part — the ONE schema, reader and
// writer. Everything a user defines in the panels lives in the session, and
// none of it is document content, so it persists as this plugin's own part
// (`paged/media.paged.data/session.json`, declared in the manifest as the
// `session` part type) and travels with the file.
//
// What the part holds (`PersistedSession`, v1):
//   · `engine`  — the engine's recipe exactly as `DataEngine.payload()` returns
//                 it: sources, queries, templates, bindings, the §9.9 variable
//                 set (declarations + captured data sets). Credentials are
//                 redacted by the engine before it gets here (§11/D-11).
//                 Restored with `DataEngine.load_payload`.
//   · `locale`  — the session formatting locale, a BCP 47 tag from the engine's
//                 locale table (not part of the engine recipe; per-binding
//                 overrides ARE in the recipe, as `engine.locales`).
//   · `sync`    — the user's sync decisions (pinned / overridden bindings);
//                 linked/stale/error are derived and are not saved.
//   · `targets` — what only the host knows: the rectangle an image or barcode
//                 binding fills, a visibility binding's element and kind, a
//                 rule's query and host target, and the element a table was
//                 lowered into (`lowered`), so a reopen can tell whether that
//                 element is still there and still carries this binding.
//   · `data`    — the imported file per source: CSV/TSV as text, JSON,
//                 Parquet and XLSX as bytes (base64 when inline). A small file
//                 is inline; a large one (over INLINE_DATA_MAX_BYTES) is its
//                 own content-addressed part `data/<hash>.<ext>` and the
//                 session names it by `{ hash, bytes }`, so a session rewrite
//                 never rewrites the data and two sessions with the same file
//                 share one part. An XLSX entry also names the worksheet read.
//   · `refresh` — the refresh policy per source (data-core `RefreshPolicy`),
//                 absent = manual.
//   · `remote`  — remote source descriptors (url, format, params, credential
//                 REF). They restore INERT: nothing is fetched on open (§11).
//   · `appliedValues` — per query, the values of the result the document was
//                 last written from (the engine payload's `applied_values`,
//                 editor ADR 291): the Sync panel's row diff "before" after
//                 a reopen. Taken OUT of `engine` and stored like imported
//                 data: inline up to INLINE_DATA_MAX_BYTES of JSON, else its
//                 own content-addressed part `data/<hash>.applied.json`, so a
//                 session rewrite (and every labelled session version) names
//                 an unchanged snapshot by hash instead of carrying it again.
//                 The document already holds the imported data these values
//                 came from: no new exposure. Absent in a part written before
//                 it: the engine then has the `applied` hashes only.
//
// Undo: `host.parts` writes are not undoable, and the session is not document
// content, so defining a binding is not an undo step either. What IS undoable
// is everything the session writes INTO the document (placed fields, tables,
// barcodes, styles, visibility) — those go through `mutate`, and the content
// they create carries this plugin's metadata label naming the binding and the
// hash of the session it was lowered under. A restore checks those labels
// against the session (see `session.ts` `restore`).

import type { ElementId } from "@paged-media/plugin-api";
import {
  bytesToBase64,
  base64ToBytes,
  sha256HexPrefix,
} from "@paged-media/helpers";

import type {
  IdmlFit,
  RuleTarget,
  VisibilityTargetKind,
} from "../../data-host-model/src";
import type { CatalogueDef, TemplateFieldBinding } from "./catalogue";
import type { ImportFormat } from "./query/import";
import type { AssetColumnDef } from "./assets";
import type { RefreshPolicy } from "./refresh";
import type { RemoteFormat } from "./remote";

/** The part the session is written to (relative to `paged/media.paged.data/`). */
export const SESSION_PART = "session.json";
/** The folder large imported data files are written to. */
export const DATA_PART_DIR = "data/";
/** Imported text up to this many UTF-8 bytes rides inline in the session part. */
export const INLINE_DATA_MAX_BYTES = 64 * 1024;
export const SESSION_VERSION = 1;

/** A stored CSV entry. */
export type CsvData = Extract<PersistedData, { format: "csv" }>;

/** The imported formats stored as bytes (CSV and TSV are stored as text). */
export type BinaryFormat = Exclude<ImportFormat, "csv" | "tsv">;

/** The file a delimited source was imported from (shown in the Sources panel).
 *  Optional: sessions saved before it was recorded restore without a label. */
export interface CsvLabel {
  fileName?: string;
  delimiter?: "csv" | "tsv";
}

/** One imported source's data: inline, or a pointer to its own part. */
export type PersistedData =
  | ({ source: string; format: "csv"; text: string } & CsvLabel)
  | ({
      source: string;
      format: "csv";
      ref: { hash: string; bytes: number };
    } & CsvLabel)
  | {
      source: string;
      format: BinaryFormat;
      fileName: string;
      sheet?: string;
      base64: string;
    }
  | {
      source: string;
      format: BinaryFormat;
      fileName: string;
      sheet?: string;
      ref: { hash: string; bytes: number };
    };

export interface PersistedRemote {
  name: string;
  url: string;
  format: RemoteFormat;
  params: Record<string, string>;
  credentialRef?: string;
}

export interface PersistedTargets {
  image: Record<string, { elementId: string; fit?: IdmlFit }>;
  barcode: Record<string, { elementId: string }>;
  visibility: Record<
    string,
    { elementId: string; kind?: VisibilityTargetKind }
  >;
  rule: Record<string, { query: string; target: RuleTarget }>;
  /** The element each table / record-flow binding was last lowered into. */
  lowered: Record<string, ElementId>;
  /** Editor ADR 291: the text frame (and story) a dropped table was placed
   *  in, with its table when known. Absent when there is none. */
  tableIn?: Record<
    string,
    { frame: ElementId; storyId: string; tableId?: string }
  >;
  /** Editor ADR 291: the record a binding placed by a dropped record shows
   *  (0-based). Absent when there is none. */
  record?: Record<string, number>;
  /** Editor ADR 291: the record the record preview stepped a binding to
   *  (0-based), until the next Lower. Absent when there is none. */
  stepped?: Record<string, number>;
}

export interface PersistedSession {
  v: typeof SESSION_VERSION;
  engine: unknown;
  locale: string;
  sync: { binding: string; status: "pinned" | "overridden" }[];
  targets: PersistedTargets;
  data: PersistedData[];
  remote: PersistedRemote[];
  /** Refresh policy per source; a source not named here is manual. Absent
   *  in a part written before wave 6 (decodeSession fills it). */
  refresh?: Record<string, RefreshPolicy>;
  /** The record the document shows, per query (0-based; the preview
   *  stepper and a template's record field). Absent = the first. */
  preview?: Record<string, number>;
  /** The data set last applied to the document, if any. */
  dataSet?: string;
  /** Data ADR 563: the asset columns, by `<query>.<field>`. Absent when
   *  there are none. */
  assets?: Record<string, AssetColumnDef>;
  /** Editor ADR 291: per query, the applied result's values (the engine
   *  payload's `applied_values`), inline or as a part. Absent when there are
   *  none. */
  appliedValues?: Record<string, PersistedValues>;
  /** ADR 560: the template fields bound to the data, and the catalogues
   *  made (by template page). Absent when there are none. */
  catalogue?: {
    fields: TemplateFieldBinding[];
    runs: Record<string, CatalogueDef>;
  };
}

/** One query's applied values: inline, or a pointer to their own part. */
export type PersistedValues =
  { values: unknown } | { ref: { hash: string; bytes: number } };

export function emptyTargets(): PersistedTargets {
  return { image: {}, barcode: {}, visibility: {}, rule: {}, lowered: {} };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Hex SHA-256 of `bytes`, shortened to 32 hex chars (128 bits) — a content
 *  address, not a security boundary. Documents persist it: it stays the
 *  prefix of the full digest. */
export function contentHash(bytes: Uint8Array): Promise<string> {
  return sha256HexPrefix(bytes, 32);
}

/** The part a stored file is written to (`data/<hash>.<ext>`). */
export function dataPartPath(
  hash: string,
  format: "csv" | BinaryFormat = "csv",
): string {
  return `${DATA_PART_DIR}${hash}.${format}`;
}

/** The part path a persisted entry points at, or null when it is inline. */
export function dataPartOf(d: PersistedData): string | null {
  return "ref" in d ? dataPartPath(d.ref.hash, d.format) : null;
}

/** Store one imported binary file (JSON, Parquet, XLSX): inline as base64
 *  when small, else as a content-addressed part written once. */
export async function storeFile(
  source: string,
  format: BinaryFormat,
  fileName: string,
  bytes: Uint8Array,
  sheet: string | undefined,
  writePart: (path: string, bytes: Uint8Array) => Promise<void>,
  known: Set<string>,
): Promise<PersistedData> {
  const head = {
    source,
    format,
    fileName,
    ...(sheet !== undefined ? { sheet } : {}),
  };
  if (bytes.length <= INLINE_DATA_MAX_BYTES)
    return { ...head, base64: bytesToBase64(bytes) };
  const hash = await contentHash(bytes);
  const path = dataPartPath(hash, format);
  if (!known.has(path)) {
    await writePart(path, bytes);
    known.add(path);
  }
  return { ...head, ref: { hash, bytes: bytes.length } };
}

/** Read one stored binary file back, or `null` when its part is missing. */
export async function loadFile(
  d: PersistedData,
  readPart: (path: string) => Promise<Uint8Array | null>,
): Promise<Uint8Array | null> {
  if ("base64" in d) return base64ToBytes(d.base64);
  if ("text" in d) return encoder.encode(d.text);
  return readPart(dataPartPath(d.ref.hash, d.format));
}

/** Decide how one imported text is stored: inline when small, else as a
 *  content-addressed part (`write` is only called for a part not yet known). */
export async function storeData(
  source: string,
  text: string,
  writePart: (path: string, bytes: Uint8Array) => Promise<void>,
  known: Set<string>,
): Promise<CsvData> {
  const bytes = encoder.encode(text);
  if (bytes.length <= INLINE_DATA_MAX_BYTES)
    return { source, format: "csv", text };
  const hash = await contentHash(bytes);
  const path = dataPartPath(hash);
  if (!known.has(path)) {
    await writePart(path, bytes);
    known.add(path);
  }
  return { source, format: "csv", ref: { hash, bytes: bytes.length } };
}

/** Read one stored source's text back, or `null` when its part is missing. */
export async function loadData(
  d: CsvData,
  readPart: (path: string) => Promise<Uint8Array | null>,
): Promise<string | null> {
  if ("text" in d) return d.text;
  const bytes = await readPart(dataPartPath(d.ref.hash));
  return bytes ? decoder.decode(bytes) : null;
}

/** The part a query's stored applied values are written to. */
export function appliedValuesPartPath(hash: string): string {
  return `${DATA_PART_DIR}${hash}.applied.json`;
}

/** The part a stored applied-values entry points at, or null when inline. */
export function valuesPartOf(v: PersistedValues): string | null {
  return "ref" in v ? appliedValuesPartPath(v.ref.hash) : null;
}

/** What the last store of each query's values made, so an unchanged
 *  snapshot is not hashed again on every session write. */
export type ValuesCache = Map<string, { json: string; entry: PersistedValues }>;

/** Take the applied values out of an engine payload: the payload without
 *  them (what the session part's `engine` holds), and each query's values
 *  stored inline when small, else as a content-addressed part written once. */
export async function storeAppliedValues(
  payload: unknown,
  writePart: (path: string, bytes: Uint8Array) => Promise<void>,
  known: Set<string>,
  cache: ValuesCache,
): Promise<{ engine: unknown; values: Record<string, PersistedValues> }> {
  const values: Record<string, PersistedValues> = {};
  if (!payload || typeof payload !== "object" || !("applied_values" in payload))
    return { engine: payload, values };
  const { applied_values: all, ...engine } = payload as {
    applied_values?: Record<string, unknown>;
  };
  for (const [query, v] of Object.entries(all ?? {})) {
    const json = JSON.stringify(v);
    const kept = cache.get(query);
    if (kept && kept.json === json) {
      const part = valuesPartOf(kept.entry);
      if (!part || known.has(part)) {
        values[query] = kept.entry;
        continue;
      }
    }
    const bytes = encoder.encode(json);
    let entry: PersistedValues;
    if (bytes.length <= INLINE_DATA_MAX_BYTES) entry = { values: v };
    else {
      const hash = await contentHash(bytes);
      const path = appliedValuesPartPath(hash);
      if (!known.has(path)) {
        await writePart(path, bytes);
        known.add(path);
      }
      entry = { ref: { hash, bytes: bytes.length } };
    }
    cache.set(query, { json, entry });
    values[query] = entry;
  }
  return { engine, values };
}

/** Put a session part's applied values back into its engine payload (the
 *  shape `load_payload` reads). A query whose part is missing keeps only
 *  its hashes; it is named in `missing`. */
export async function loadAppliedValues(
  engine: unknown,
  stored: Record<string, PersistedValues> | undefined,
  readPart: (path: string) => Promise<Uint8Array | null>,
): Promise<{ engine: unknown; missing: string[]; parts: string[] }> {
  const missing: string[] = [];
  const parts: string[] = [];
  if (!stored || !engine || typeof engine !== "object")
    return { engine, missing, parts };
  const values: Record<string, unknown> = {};
  for (const [query, v] of Object.entries(stored)) {
    if (!v || typeof v !== "object") continue;
    if ("values" in v) {
      values[query] = v.values;
      continue;
    }
    if (!("ref" in v) || typeof v.ref?.hash !== "string") continue;
    const path = appliedValuesPartPath(v.ref.hash);
    const bytes = await readPart(path).catch(() => null);
    let parsed: unknown = null;
    try {
      parsed = bytes ? JSON.parse(decoder.decode(bytes)) : null;
    } catch {
      parsed = null;
    }
    if (parsed === null) missing.push(query);
    else {
      values[query] = parsed;
      parts.push(path);
    }
  }
  return Object.keys(values).length > 0
    ? { engine: { ...engine, applied_values: values }, missing, parts }
    : { engine, missing, parts };
}

export function encodeSession(s: PersistedSession): Uint8Array {
  return encoder.encode(JSON.stringify(s));
}

/** Parse a session part. Returns the session, or a reason it cannot be used. */
export function decodeSession(
  bytes: Uint8Array,
): PersistedSession | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch (err) {
    return {
      error: `the saved data session is not valid JSON (${String(err)})`,
    };
  }
  if (!parsed || typeof parsed !== "object")
    return { error: "the saved data session is empty" };
  const v = (parsed as { v?: unknown }).v;
  if (v !== SESSION_VERSION) {
    return {
      error:
        typeof v === "number" && v > SESSION_VERSION
          ? `the saved data session is version ${v}; this plugin reads version ${SESSION_VERSION} — update the plugin`
          : "the saved data session has no version",
    };
  }
  const p = parsed as Partial<PersistedSession>;
  return {
    v: SESSION_VERSION,
    engine: p.engine ?? null,
    // Any tag: the engine knows its locale table, and refuses a tag it lacks
    // when the session applies it (reported then, not silently changed here).
    locale: typeof p.locale === "string" && p.locale !== "" ? p.locale : "en",
    sync: Array.isArray(p.sync) ? p.sync : [],
    targets: { ...emptyTargets(), ...(p.targets ?? {}) },
    data: Array.isArray(p.data) ? p.data : [],
    remote: Array.isArray(p.remote) ? p.remote : [],
    refresh: p.refresh && typeof p.refresh === "object" ? p.refresh : {},
    ...(p.preview && typeof p.preview === "object"
      ? {
          preview: Object.fromEntries(
            Object.entries(p.preview).filter(
              ([, n]) => Number.isInteger(n) && (n as number) >= 0,
            ),
          ),
        }
      : {}),
    ...(typeof p.dataSet === "string" ? { dataSet: p.dataSet } : {}),
    ...(p.appliedValues && typeof p.appliedValues === "object"
      ? { appliedValues: p.appliedValues }
      : {}),
    ...(p.assets && typeof p.assets === "object"
      ? { assets: p.assets as Record<string, AssetColumnDef> }
      : {}),
    ...(p.catalogue && typeof p.catalogue === "object"
      ? {
          catalogue: {
            fields: Array.isArray(p.catalogue.fields)
              ? p.catalogue.fields.filter(
                  (f) =>
                    !!f &&
                    typeof f.field === "string" &&
                    typeof f.query === "string" &&
                    typeof f.expr === "string",
                )
              : [],
            runs:
              p.catalogue.runs && typeof p.catalogue.runs === "object"
                ? p.catalogue.runs
                : {},
          },
        }
      : {}),
  };
}
