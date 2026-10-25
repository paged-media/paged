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

// Boot the paged.data engine wasm (data-js) in the bundle realm — the
// canvas-wasm pattern (the wasm-bindgen `--target web` glue, NOT
// host.loadBundleWasm; BREAKAGE D-07). The artifact lands in ./bin via
// scripts/build-wasm.sh; absent until built → ENGINE_NOT_BUILT (honest, never
// faked). ALL binding/expression/sync/lowering semantics live behind this
// boundary (CLAUDE.md hard rule) — this file only constructs the handle (and
// hands a result's typed column buffers across the column door).

import { singleFlight } from "@paged-media/wasm-boot";

import { WASM_ARTIFACTS, type WasmResolver } from "./bin-url";
import { columnToValues, type ColumnBatch } from "./query/recordset";

export const ENGINE_NOT_BUILT =
  "data-js wasm not built — run `bash scripts/build-wasm.sh` (100 MB app wasm budget, lands in packages/data-bundle/bin/)";

/** The wasm class surface (`data-js` `DataEngine`) the bundle consumes. The
 *  method names + JSON shapes match the Rust `#[wasm_bindgen]` impl exactly. */
export interface DataEngineLike {
  define_source(source: unknown): void;
  define_query(query: unknown): void;
  define_binding(def: unknown): void;
  define_template(template: unknown): void;
  /** The record-template library (`TemplateEntry[]`), and its changes.
   *  Optional: a wasm built before the library lacks them. */
  template_library?(): unknown;
  template_from_text?(id: string, text: string, lineHeightPt: number): unknown;
  rename_template?(from: string, to: string): unknown;
  remove_template?(id: string): boolean;
  preview_template?(id: string, query: string, record: number): unknown;
  /** A record flow's recipe (`RecordFlowDef`) or null; set its template and
   *  `FlowOpts`. */
  record_flow?(binding: string): unknown;
  set_record_flow?(binding: string, template: string, options: unknown): void;
  define_placeholder(placeholder: unknown): void;
  set_param(name: string, value: unknown): void;
  set_locale(locale: unknown): void;
  ingest_result(query: string, records: unknown): void;
  /** The typed column door (Wave 2): `begin_columns` → one `push_*` per
   *  schema field → `finish_columns` (`"changed"` | `"unchanged"`). Each
   *  buffer is copied into wasm once; no per-cell objects. Use
   *  `ingestColumnBatch`, which falls back to `ingest_result` on an engine
   *  without the door. */
  begin_columns?(query: string, schema: unknown, rows: number): void;
  push_f64?(values: Float64Array, valid?: Uint8Array): void;
  push_bool?(values: Uint8Array, valid?: Uint8Array): void;
  push_date?(values: Int32Array, valid?: Uint8Array): void;
  push_datetime?(values: Float64Array, valid?: Uint8Array): void;
  push_utf8?(bytes: Uint8Array, offsets: Int32Array, valid?: Uint8Array): void;
  push_binary?(
    bytes: Uint8Array,
    offsets: Int32Array,
    valid?: Uint8Array,
  ): void;
  finish_columns?(): string;
  /** The content token (hex content hash) of a query's ingested result —
   *  equal tokens, equal data. `undefined` before an ingest. */
  result_token?(query: string): string | undefined;
  resolve_lowered(binding: string): unknown;
  /** ADR 558: every property binding's lowering over `record` (with
   *  `withVisibility`, visibility bindings re-expressed too), for ONE apply
   *  (`PropertyApply[]`). Optional: a wasm built before it lacks it. */
  resolve_properties_at?(
    record: number,
    withVisibility: boolean,
    bindings?: string[],
  ): unknown;
  /** Remove a binding from the recipe. Optional (a wasm built before it). */
  remove_binding?(binding: string): boolean;
  /** §9 record-preview stepper: the count of records ingested for a query — the
   *  stepper's "of N" upper bound (0 before a refresh). Optional: a wasm
   *  artifact built before the preview lane lacks it. */
  query_record_count?(query: string): number;
  /** §9 field-mapping wizard: the column → variable-binding suggestions for a
   *  query's ingested result (`ColumnMapping[]`). Optional: absent on a wasm
   *  artifact built before the wizard lane (the panel degrades honestly). */
  query_mappings?(query: string): unknown;
  /** §8 change report: diff every binding's current resolved content against the
   *  previous report's snapshot — `{ entries, changed, unchanged, added,
   *  removed }`. Call AFTER re-ingesting the queries. Optional: absent on a wasm
   *  artifact built before the change-report lane (the panel degrades honestly). */
  refresh_change_report?(): unknown;
  /** §9 record-preview stepper: resolve a binding against a chosen RECORD INDEX
   *  (`record`) and return its lowered IR — per-record kinds (variable/image)
   *  resolve over `records[record]`; a table renders in full. Optional: absent
   *  on a wasm artifact built before the preview lane (the session falls back to
   *  the record-0 resolve, honestly). */
  resolve_lowered_at?(binding: string, record: number): unknown;
  /** §9.9: the declared variables + captured data sets (`VariableSet`). Optional:
   *  absent on a wasm artifact built before the variables lane (the session
   *  degrades to an empty palette, honestly). */
  variables?(): unknown;
  /** §9.9: capture the current resolved values as a named data set, resolved
   *  against a record index. Optional (see `variables`). */
  capture_data_set?(name: string, record: number): unknown;
  /** §9.9: capture ONE data set per record of a query. Returns the names in
   *  record order. Optional (see `variables`). */
  capture_every_record?(
    query: string,
    prefix: string,
    nameColumn?: string,
  ): unknown;
  /** §9.9: the named data sets, in palette order. Optional (see `variables`). */
  list_data_sets?(): unknown;
  /** §9.9: delete a data set by name. Optional (see `variables`). */
  delete_data_set?(name: string): boolean;
  /** §9.9: plan a data-set application — one `DataSetApply` per captured
   *  variable. The BUNDLE commits the applicable rows as ONE batch (one undo
   *  step); this only decides values. Optional (see `variables`). */
  apply_data_set?(name: string): unknown;
  /** §9.9: export the variable set as Illustrator-compatible library XML.
   *  Optional (see `variables`). */
  export_variable_library?(): string;
  /** §9.9: import a variable library, replacing the current set. Returns the
   *  `ImportReport`. Optional (see `variables`). */
  import_variable_library?(xml: string): unknown;
  /** §9.9: the serialized byte size of the variable half of the payload — the
   *  D-08 budget check. Optional (see `variables`). */
  data_set_payload_bytes?(): number;
  /** Wave 5 Data Merge: plan a merge of a query's records (in delivered
   *  order) through a record template (`MergeSpec` → `MergePlan`). Optional:
   *  absent on a wasm artifact built before the merge lane. */
  plan_merge?(query: string, spec: unknown): unknown;
  /** ADR 560: plan a catalogue (`CatalogueSpec` → `CataloguePlan`): per
   *  record or group, the value each bound template field takes. Optional:
   *  a wasm built before it lacks it. */
  plan_catalogue?(query: string, spec: unknown): unknown;
  /** Wave 5: the distinct words of a merge plan's texts per template frame. */
  merge_words?(plan: unknown, frames: number): unknown;
  /** Wave 5: per record, per frame, is the merged text overset (DM-7)? */
  merge_overset?(plan: unknown, metrics: unknown): unknown;
  /** Data ADR 564: one text's distinct words, for the host to measure. */
  text_words?(text: string): unknown;
  /** Data ADR 564: is a text overset in a frame `width` × `height` (pt) at
   *  the measured `metrics` (`{ leadingPt, advances }`)? */
  text_overset?(
    text: string,
    width: number,
    height: number,
    metrics: unknown,
  ): boolean;
  /** Data ADR 564: is a threaded story's text overset in its frames
   *  (`[width, height][]` pt, in chain order), wrapped through each in
   *  turn? Optional: a wasm built before it lacks it. */
  text_overset_chain?(
    text: string,
    boxes: readonly (readonly [number, number])[],
    metrics: unknown,
  ): boolean;
  /** Editor ADR 291: the Data Merge placeholders of a text that name a field
   *  (`{ start, end, field, image }[]`, byte offsets as the host counts
   *  them). Optional: a wasm built before it lacks it. */
  placeholder_spans?(text: string): unknown;
  publish_provider(
    query: string,
    providerId: string,
    category: string,
  ): unknown;
  governed_catalog(query: string, metadata: unknown): unknown;
  plan_batch(query: string, mode: unknown): unknown;
  run_record_flow_batch(
    binding: string,
    mode: unknown,
    chain: unknown,
    opts: unknown,
  ): unknown;
  /** D-13: evaluate a data-driven formatting rule over a query's records —
   *  returns `{scope, fires, apply, total}` (the firing decision; the host
   *  applies the named document style). */
  evaluate_rule(rule: string, query: string): unknown;
  /** D-12: resolve a record-flow binding and paginate it over a caller-supplied
   *  frame chain (`FrameCapacity[]`, `heightPt`) — returns the `PaginatedFlow`
   *  IR. The chain is the host frame-chain topology (D-12), read live. */
  lower_record_flow(binding: string, chain: unknown, opts: unknown): unknown;
  /** §9.7: resolve a barcode binding and lower it scaled to the bound frame's
   *  content box (`boxWPt` × `boxHPt`, pt) — returns the `LoweredBarcode` IR
   *  (content-space filled-rect modules the bundle draws as native insertPath). */
  lower_barcode(binding: string, boxWPt: number, boxHPt: number): unknown;
  /** M1 remote slice: the content-hash invalidation key for a defined remote
   *  source over bundle-fetched bytes. Optional: a wasm artifact built before
   *  the M1 slice lacks it (the session degrades honestly). */
  remote_invalidation_key?(source: string, bytes: Uint8Array): string;
  /** The query store (ADR 561, `query/store.ts`): read a file as a source
   *  table (`StoreImport`). Optional only so a test double can leave the
   *  store out; the shipped engine has it. */
  store_import?(
    name: string,
    format: string,
    bytes: Uint8Array,
    sheet?: string,
  ): unknown;
  /** Drop a source's table and its as-written twin. */
  store_drop?(name: string): void;
  /** The store's source tables. */
  store_tables?(): string[];
  /** Run SQL in the store and deliver the rows as a query's result. */
  store_ingest?(query: string, sql: string): number;
  /** The same, over the CSV sources as written; undefined without a twin. */
  store_ingest_as_written?(
    query: string,
    sql: string,
    sources: string[],
  ): number | undefined;
  /** The columns a query produces (`StoreColumn[]`). */
  store_describe?(sql: string): unknown;
  /** The first rows of a query as text and its count (`StorePreview`). */
  store_preview?(sql: string, limit: number): unknown;
  /** A window of a source table in the provider shape (`limit` 0 = all). */
  store_records?(table: string, offset: number, limit: number): unknown;
  /** An expression's value at a record (the bind popover's preview). */
  evaluate_at?(
    query: string,
    expr: string,
    record: number,
  ): { display: string; value: unknown; error?: string };
  /** Transforms (data ADR 562). */
  define_transform?(def: TransformDefJson): void;
  remove_transform?(id: string): boolean;
  transforms?(): TransformDefJson[];
  run_transforms?(): {
    transform: string;
    outcome: { Ok: number } | { Err: string };
  }[];
  /** A query's rows in the provider shape (the guard has run). */
  store_query_records?(sql: string): unknown;
  /** Apply row edits to a source table; the row count. */
  store_edit?(table: string, edits: unknown): number;
  /** §9.1: override one binding's formatting locale (a tag; `null` clears).
   *  Optional: absent on a wasm artifact built before the locale table. */
  set_binding_locale?(binding: string, locale: string | null): void;
  /** §9.1: the per-binding locale overrides, `{ binding: tag }`. */
  binding_locales?(): unknown;
  /** §9.1: every locale with formatted samples (`LocaleInfo[]`). */
  locales?(): unknown;
  /** §9.1: wrap an expression in a display pattern. */
  format_expression?(inner: string, pattern: unknown): string;
  /** §9.1: split an expression into `{ inner, pattern }`. */
  split_expression?(src: string): unknown;
  /** §8: snapshot each query's result as the one the document was written
   *  from (the "before" of `row_diff`). */
  mark_rows_applied?(): void;
  /** §8: the row diff per query since `mark_rows_applied` (`QueryRowDiff[]`). */
  row_diff?(opts: unknown): unknown;
  /** Snapshot ONE query's result as the one the document was written from
   *  (a Data Merge). */
  mark_query_applied?(query: string): void;
  /** Editor ADR 291: one query's per-record status since it was written
   *  from (`EngineRecordStatus`, or null without a result). `opts` is
   *  `{ key?, instances? }`. */
  record_status?(query: string, opts: unknown): unknown;
  /** Check an expression: `{ ok, error?, fields, unknownFields }`. */
  check_expression?(src: string, query?: string | null): unknown;
  /** §9.5: which records a condition fires on, `{ fires, total, error? }`. */
  preview_condition?(query: string, when: string): unknown;
  /** A per-record binding's display text for a record, without re-linking. */
  preview_display?(binding: string, record: number): unknown;
  sync_state(binding: string): unknown;
  /** The field-refresh decision per binding, in ONE call
   *  (`[{outcome: "value"|"kept"|"notVariable"|"failed", binding, value?, error?}]`):
   *  pinned / overridden bindings are kept without resolving. Optional: a wasm
   *  built before it lacks it (the refresh falls back to two calls per binding). */
  refresh_field_values?(bindings: string[]): unknown;
  pin(binding: string): void;
  mark_overridden(binding: string): void;
  relink(binding: string): void;
  sync_report(): unknown;
  source_manifest(): unknown;
  authorize_report(): unknown;
  payload(): unknown;
  /** Replace the recipe with a saved `payload()` (the session restore path).
   *  Optional: a wasm artifact built before it lacks it (restore reports it). */
  load_payload?(payload: unknown): void;
  metadata(): unknown;
  free(): void;
}

// A computed specifier so the type-checker does not resolve the (build-time)
// wasm glue path; it is loaded dynamically in the bundle realm at runtime.
const ENGINE_GLUE = "../bin/data_js.js";

/** Options for [`bootEngine`]. */
export interface BootEngineOptions {
  /** The module door (`hostWasm`, bin-url.ts): where the HOST serves the
   *  `data-engine` artifact. Absent, answering null or rejecting, the glue
   *  loads the `.wasm` next to itself (`bin/data_js_bg.wasm`). */
  resolveWasm?: WasmResolver;
  /** Told when the host's copy failed and the bundle's own was used. */
  onFallback?: (reason: string) => void;
}

/** Boot a `DataEngine` over the wasm-bindgen glue. Throws [`ENGINE_NOT_BUILT`]
 *  when the artifact is absent (the panel renders that honestly). */
export async function bootEngine(
  today: number,
  opts: BootEngineOptions = {},
): Promise<DataEngineLike> {
  const mod = await engineModule(opts);
  return new mod.DataEngine(today) as DataEngineLike;
}

/** The glue, imported and initialised once per realm: every boot shares one
 *  init (the glue's `init()` checks "already initialised" before its await,
 *  so two in flight would both instantiate; @paged-media/wasm-boot). The
 *  first boot's options choose the module door. A failed boot is forgotten,
 *  so a later one retries. */
const engineModule = singleFlight(
  async (
    opts: BootEngineOptions,
  ): Promise<{ DataEngine: new (today: number) => unknown }> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: any = null;
    try {
      mod = await import(/* @vite-ignore */ ENGINE_GLUE);
    } catch {
      throw new Error(ENGINE_NOT_BUILT);
    }
    if (!mod || typeof mod.DataEngine !== "function") {
      throw new Error(ENGINE_NOT_BUILT);
    }
    // wasm-bindgen `--target web` exports a default init() that fetches the .wasm.
    if (typeof mod.default === "function") {
      await initEngineGlue(mod.default, opts);
    }
    return mod;
  },
);

/** Run the glue's `init`: with the module door, on the host's copy fetched
 *  with its integrity (a byte that differs fails the fetch); on any failure
 *  of that, or without the door, on the `.wasm` next to the glue. A failed
 *  init leaves the glue uninitialised, so the second call starts clean. */
export async function initEngineGlue(
  init: (arg?: { module_or_path: unknown }) => Promise<unknown>,
  opts: BootEngineOptions = {},
): Promise<void> {
  const hosted = opts.resolveWasm
    ? await opts.resolveWasm(WASM_ARTIFACTS.engine).catch(() => null)
    : null;
  if (hosted) {
    try {
      await init({
        module_or_path: hosted.integrity
          ? fetch(hosted.url, { integrity: hosted.integrity })
          : hosted.url,
      });
      return;
    } catch (err) {
      opts.onFallback?.(
        `the host's data engine (${hosted.url}) did not load (${err instanceof Error ? err.message : String(err)}); using the bundle's own`,
      );
    }
  }
  await init();
}

/** Deliver a query result to the engine as typed column buffers (the column
 *  door: one copy per column, no `{t, v}` object per cell). Returns whether
 *  the engine's result changed: a re-delivery of the same data is
 *  `"unchanged"` and decodes nothing. An engine built before the door gets
 *  the same data through `ingest_result` (reported `"changed"`). */
export function ingestColumnBatch(
  e: DataEngineLike,
  query: string,
  batch: ColumnBatch,
): "changed" | "unchanged" {
  if (
    typeof e.begin_columns !== "function" ||
    typeof e.finish_columns !== "function"
  ) {
    e.ingest_result(query, {
      schema: batch.schema,
      columns: batch.columns.map((c) => columnToValues(c, batch.row_count)),
      row_count: batch.row_count,
    });
    return "changed";
  }
  e.begin_columns(query, batch.schema, batch.row_count);
  for (const c of batch.columns) {
    const valid = c.valid ?? undefined;
    switch (c.kind) {
      case "f64":
        e.push_f64!(c.values, valid);
        break;
      case "bool":
        e.push_bool!(c.values, valid);
        break;
      case "date":
        e.push_date!(c.values, valid);
        break;
      case "datetime":
        e.push_datetime!(c.values, valid);
        break;
      case "utf8":
        e.push_utf8!(c.bytes, c.offsets, valid);
        break;
      case "binary":
        e.push_binary!(c.bytes, c.offsets, valid);
        break;
    }
  }
  return e.finish_columns() === "unchanged" ? "unchanged" : "changed";
}

/** A transform as the engine keeps it (data ADR 562): `source` is a
 *  function expression `(tables, params) => rows`. */
export interface TransformDefJson {
  id: string;
  inputs: string[];
  source: string;
  params?: Record<string, unknown>;
}
