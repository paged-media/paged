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

// The Data panel (editor ADR 291): the document's data, as a grid. It reads
// whatever bundle serves the data (`data@1`; paged.data in the editor):
//
//   · one tab per table — the imported sources, the transforms' derived
//     tables, the queries;
//   · sort by a header, shift-click to sub-sort; a filter builder (match
//     all or any); grouping by a field, each group with its count; columns
//     shown or hidden;
//   · a field that a binding reads is marked in its header, with how many
//     bindings read it; a double-click on that header selects the page
//     items those bindings are placed in (the service's `placements`);
//   · a query's rows by their record's status: new, changed, placed (a
//     double-click selects where), and the placed records gone from the
//     data counted (`data-record-status.ts`);
//   · the grid is windowed: the service sorts and filters (guarded SQL), and
//     only the rows in view cross;
//   · with no data yet, a three-step start: import, query, bind;
//   · the pipeline (`data-pipeline.tsx`): sources → transforms → queries,
//     each with its rows or its error, a transform edited in place.

import { useEffect, useRef, useState, type CSSProperties } from "react";

import type {
  DataBindingStatus,
  DataService,
  DataTableInfo,
  ProviderRecordSet,
} from "@paged-media/plugin-api";
import { color, font, radius, space, status } from "@paged-media/panel-kit";
import {
  DATA_FIELD_DRAG_TYPE,
  DATA_RECORD_DRAG_TYPE,
  DATA_TABLE_DRAG_TYPE,
  elementOfPlacement,
  useCanvasClient,
  useCockpitActions,
  useDataRevision,
  useDataService,
  useSelection,
} from "@paged-media/shell";
import type { ElementId } from "@paged-media/client";
import { defineMessages, useStrings } from "@paged-media/strings";

import {
  gridSql,
  groupRows,
  ident,
  nextSort,
  RECORD_FIELD,
  type FilterOp,
  type FilterRow,
  type SortKey,
} from "./data-grid-model";
import {
  numbersRecords,
  recordAttrs,
  recordCue,
  recordStyle,
  RM,
  selectRecord,
  useRecordStatus,
} from "./data-record-status";
import { DataPipeline, offersPipeline, PipelineToggle } from "./data-pipeline";
import {
  AssetColumnEditor,
  AssetColumnMarker,
  PictureColumnToggle,
  useAssetColumns,
} from "./data-asset-column";

const M = defineMessages("app.dataPanel", {
  startTitle: "Put data in the document",
  step1: "Import a source: a CSV, JSON, Parquet or Excel file, or a URL.",
  step2: "Write a query over it: the records a binding reads.",
  step3:
    "Place: drag a field header onto a text or graphic frame, or right-click any property and choose Bind to data…",
  openSources: "Open Sources",
  openQuery: "Open Query",
  noService:
    "No module serves the document's data. paged.data does: load it to work with data.",
  rows: "{count, plural, one {# record} other {# records}}",
  filter: "Filter",
  addFilter: "Add a condition",
  matchAll: "all",
  matchAny: "any",
  matchBefore: "Match",
  matchAfter: "of these conditions",
  groupBy: "Group by",
  noGroup: "No grouping",
  columns: "Columns",
  derived: "derived",
  bound: "{count, plural, one {read by # binding} other {read by # bindings}}",
  sortHint: "Sort; shift-click to sort within",
  failed: "The table could not be read: {reason}",
  opEq: "is",
  opNe: "is not",
  opLt: "<",
  opLe: "≤",
  opGt: ">",
  opGe: "≥",
  opContains: "contains",
  opBlank: "is empty",
  opNotBlank: "is not empty",
  remove: "Remove",
  update: "Update document",
  updateTitle:
    "Read the data again and bring every placed field, table and image up to date",
  updating: "Updating…",
  inSync: "{count} in step",
  stale: "{count} changed in the data",
  kept: "{count} kept as placed",
  errors: "{count} failed",
  fieldLinked: "every binding reading it is in step",
  fieldStale: "the data changed since it was placed",
  fieldError: "a binding reading it failed",
  selectHint: "double-click to select where it is placed",
  dragHint: "drag onto a text or graphic frame to place it",
  sample: "Try it with sample data",
  sampleFailed: "The sample data was not loaded: {reason}",
  asTable: "Drag as table",
  asTableHint:
    "drag onto a text frame to place the shown columns, in this order, as a table",
  rowHint:
    "drag onto a group or a frame with <<field>>s to fill it with this record",
});

const ROW_H = 22;
const PAGE = 200;

const OPS: { op: FilterOp; key: keyof typeof M }[] = [
  { op: "=", key: "opEq" },
  { op: "<>", key: "opNe" },
  { op: "<", key: "opLt" },
  { op: "<=", key: "opLe" },
  { op: ">", key: "opGt" },
  { op: ">=", key: "opGe" },
  { op: "contains", key: "opContains" },
  { op: "blank", key: "opBlank" },
  { op: "notBlank", key: "opNotBlank" },
];

const small: CSSProperties = { font: `11px ${font.sans}`, color: color.fg };
const muted: CSSProperties = {
  font: `11px ${font.sans}`,
  color: color.mutedFg,
};
const control: CSSProperties = {
  ...small,
  height: 22,
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  background: color.bg,
  padding: "0 4px",
};
const button: CSSProperties = {
  ...small,
  height: 22,
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  background: color.bg,
  padding: "0 8px",
  cursor: "pointer",
};

type Tone = "ok" | "warn" | "error" | "none";
const RANK: Record<Tone, number> = { none: 0, ok: 1, warn: 2, error: 3 };

function toneOf(st: DataBindingStatus["status"]): Tone {
  if (st === "linked") return "ok";
  if (st === "error") return "error";
  if (st === "unresolved") return "none";
  return "warn";
}

/** Per field of `table`: how many bindings read it and the worst of their
 *  states (EasyCatalog's colour cues, at the field). */
function fieldStates(
  statuses: readonly DataBindingStatus[],
  table: string,
): Map<string, { count: number; tone: Tone }> {
  const out = new Map<string, { count: number; tone: Tone }>();
  for (const b of statuses) {
    if (b.query !== table) continue;
    const tone = toneOf(b.status);
    for (const f of b.fields) {
      const cur = out.get(f) ?? { count: 0, tone: "none" as Tone };
      out.set(f, {
        count: cur.count + 1,
        tone: RANK[tone] > RANK[cur.tone] ? tone : cur.tone,
      });
    }
  }
  return out;
}

const TONE_COLOR: Record<Tone, string> = {
  ok: status.ok,
  warn: status.warn,
  error: status.error,
  none: color.mutedFg,
};

/** What `selectPlaced` acts through: the grid's hooks, handed over. */
interface SelectDeps {
  service: DataService;
  client: ReturnType<typeof useCanvasClient>;
  setElementSelection: ReturnType<typeof useSelection>["setElementSelection"];
  setElementGeometry: ReturnType<typeof useSelection>["setElementGeometry"];
}

/** Select the page items the bindings reading `field` of `table` are
 *  placed in. Nothing happens when none is placed, or the service cannot
 *  say where (no `placements`). Outside the component: the React Compiler
 *  does not compile a conditional inside a `try` (ADR 229). */
async function selectPlaced(
  { service, client, setElementSelection, setElementGeometry }: SelectDeps,
  statuses: readonly DataBindingStatus[],
  table: string,
  field: string,
): Promise<void> {
  if (typeof service.placements !== "function") return;
  const reading = new Set(
    statuses
      .filter((b) => b.query === table && b.fields.includes(field))
      .map((b) => b.id),
  );
  if (reading.size === 0) return;
  try {
    const ids: ElementId[] = [];
    const seen = new Set<string>();
    for (const p of await service.placements()) {
      const id = reading.has(p.binding) ? elementOfPlacement(p.address) : null;
      if (!id || seen.has(p.address)) continue;
      seen.add(p.address);
      ids.push(id);
    }
    if (ids.length === 0) return;
    const applied = await client.setElementSelection(ids, "replace");
    setElementSelection(applied);
    setElementGeometry(await client.elementGeometry(applied));
  } catch {
    // A placement that vanished meanwhile: the selection stays as it was.
  }
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function Start({
  hasService,
  sample,
}: {
  hasService: boolean;
  /** Load the sample data (the service's `loadSample`), when offered. */
  sample: (() => Promise<void>) | null;
}) {
  const { t } = useStrings();
  const cockpit = useCockpitActions();
  const open = (id: string) => cockpit.openPanel?.(id, { activate: true });
  const [loading, setLoading] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  return (
    <div
      data-data-start=""
      style={{ padding: space[3], display: "grid", gap: space[2] }}
    >
      <div style={{ font: `600 13px ${font.sans}`, color: color.fg }}>
        {t(M.startTitle)}
      </div>
      {!hasService ? (
        <p style={muted}>{t(M.noService)}</p>
      ) : (
        <ol
          style={{
            ...small,
            margin: 0,
            paddingLeft: 18,
            display: "grid",
            gap: space[2],
          }}
        >
          <li>
            {t(M.step1)}{" "}
            <button
              type="button"
              style={button}
              onClick={() => open("media.paged.data.panel.sources")}
            >
              {t(M.openSources)}
            </button>
          </li>
          <li>
            {t(M.step2)}{" "}
            <button
              type="button"
              style={button}
              onClick={() => open("media.paged.data.panel.query")}
            >
              {t(M.openQuery)}
            </button>
          </li>
          <li>{t(M.step3)}</li>
        </ol>
      )}
      {hasService && sample && (
        <div>
          <button
            type="button"
            data-data-sample=""
            style={button}
            disabled={loading}
            onClick={() => {
              setLoading(true);
              setSampleError(null);
              sample().then(
                () => setLoading(false),
                (err: unknown) => {
                  setLoading(false);
                  setSampleError(
                    err instanceof Error ? err.message : String(err),
                  );
                },
              );
            }}
          >
            {t(M.sample)}
          </button>
          {sampleError && (
            <p style={{ ...small, color: status.error }}>
              {t(M.sampleFailed, { reason: sampleError })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Grid({
  service,
  table,
  statuses,
}: {
  service: DataService;
  table: DataTableInfo;
  statuses: readonly DataBindingStatus[];
}) {
  const { t } = useStrings();
  const revision = useDataRevision();
  const client = useCanvasClient();
  const { setElementSelection, setElementGeometry } = useSelection();
  const [sort, setSort] = useState<SortKey[]>([]);
  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [match, setMatch] = useState<"all" | "any">("all");
  const [group, setGroup] = useState("");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [showColumns, setShowColumns] = useState(false);
  const [count, setCount] = useState(0);
  const [pages, setPages] = useState<ReadonlyMap<number, ProviderRecordSet>>(
    new Map(),
  );
  const [groupValues, setGroupValues] = useState<unknown[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(300);
  const scroller = useRef<HTMLDivElement | null>(null);
  // Data ADR 563: the field whose picture column editor is open.
  const assets = useAssetColumns(service, table);
  const [picture, setPicture] = useState<string | null>(null);

  const fields = table.schema.fields;
  const visible = fields.filter((f) => !hidden.has(f.name));
  // Grouping sorts by the group field first, so a group is a run.
  const keys = group
    ? [{ field: group, desc: false }, ...sort.filter((s) => s.field !== group)]
    : sort;
  const sql = gridSql(
    table.name,
    filters,
    match,
    keys,
    numbersRecords(service, table),
  );
  const records = useRecordStatus(service, table, revision);
  const bound = fieldStates(statuses, table.name);
  const rowsDrag =
    table.kind === "query" &&
    keys.length === 0 &&
    filters.every((f) => f.field === "");

  // The count, and (grouped) the group field's values in order.
  useEffect(() => {
    let live = true;
    const run = async () => {
      const n = await service.query?.(`SELECT count(*) AS n FROM (${sql})`);
      if (!live || !n) return;
      setCount(Number(n.columns[0]?.[0] ?? 0));
      setPages(new Map());
      setFailure(null);
      if (group) {
        const g = await service.query?.(`SELECT ${ident(group)} FROM (${sql})`);
        if (live) setGroupValues(g?.columns[0] ?? []);
      } else if (live) setGroupValues(null);
    };
    run().catch((err: unknown) => {
      if (live) setFailure(err instanceof Error ? err.message : String(err));
    });
    return () => {
      live = false;
    };
  }, [service, sql, group, revision]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = groupRows(groupValues, count, closed);
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
  const last = Math.min(
    rows.length,
    Math.ceil((scrollTop + height) / ROW_H) + 10,
  );
  const neededPages = new Set<number>();
  for (let i = first; i < last; i++) {
    const r = rows[i];
    if (r?.kind === "record") neededPages.add(Math.floor(r.index / PAGE));
  }
  const wanted = [...neededPages].filter((p) => !pages.has(p)).join(",");

  // The rows in view, a page at a time.
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    for (const p of wanted.split(",").map(Number)) {
      void service.query?.(`${sql} LIMIT ${PAGE} OFFSET ${p * PAGE}`).then(
        (rs) => {
          if (live && rs) setPages((m) => new Map(m).set(p, rs));
        },
        (err: unknown) => live && setFailure(String(err)),
      );
    }
    return () => {
      live = false;
    };
  }, [service, sql, wanted]);

  const valueAt = (index: number, field: string): string => {
    const page = pages.get(Math.floor(index / PAGE));
    if (!page) return "";
    const c = page.schema.fields.findIndex((f) => f.name === field);
    return c < 0 ? "" : cell(page.columns[c]?.[index % PAGE]);
  };

  // The record a row shows (the grid numbers a query's rows, `gridSql`).
  const recordAt = (index: number): number | null => {
    const v = valueAt(index, RECORD_FIELD);
    return v === "" ? null : Number(v);
  };

  const colW = 120;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        flex: 1,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: space[1],
          padding: `${space[1]} ${space[2]}`,
          alignItems: "center",
        }}
      >
        <span style={muted} data-data-count="">
          {t(M.rows, { count })}
        </span>
        {(records?.removed ?? 0) > 0 && (
          <span style={{ ...small, color: status.warn }} data-data-removed="">
            {t(RM.removed, { count: records!.removed })}
          </span>
        )}
        {table.kind === "query" && (
          // Editor ADR 291: the query as a table, its shown columns in order.
          <span
            role="button"
            tabIndex={-1}
            draggable
            data-data-table-drag=""
            title={t(M.asTableHint)}
            style={{
              ...button,
              display: "inline-flex",
              alignItems: "center",
              cursor: "grab",
            }}
            onDragStart={(e) => {
              e.dataTransfer.setData(
                DATA_TABLE_DRAG_TYPE,
                JSON.stringify({
                  query: table.name,
                  fields: visible.map((f) => f.name),
                }),
              );
              e.dataTransfer.setData("text/plain", table.name);
              e.dataTransfer.effectAllowed = "copy";
            }}
          >
            {t(M.asTable)}
          </span>
        )}
        <label
          style={{ ...muted, display: "flex", gap: 4, alignItems: "center" }}
        >
          {t(M.groupBy)}
          <select
            data-data-group=""
            style={control}
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          >
            <option value="">{t(M.noGroup)}</option>
            {fields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          style={button}
          data-data-add-filter=""
          onClick={() =>
            setFilters([
              ...filters,
              { field: fields[0]?.name ?? "", op: "=", value: "" },
            ])
          }
        >
          {t(M.addFilter)}
        </button>
        <button
          type="button"
          style={button}
          aria-expanded={showColumns}
          onClick={() => setShowColumns(!showColumns)}
        >
          {t(M.columns)}
        </button>
        {assets && fields.length > 0 && (
          <PictureColumnToggle
            open={picture !== null}
            onToggle={() =>
              setPicture(
                picture !== null
                  ? null
                  : ([...assets.keys()][0] ?? fields[0]!.name),
              )
            }
          />
        )}
      </div>
      {assets && picture !== null && (
        <AssetColumnEditor
          key={`${picture}:${assets.has(picture)}`}
          service={service}
          table={table}
          field={picture}
          column={assets.get(picture)}
          onField={setPicture}
          onClose={() => setPicture(null)}
        />
      )}
      {showColumns && (
        <div
          data-data-columns=""
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: space[2],
            padding: `0 ${space[2]} ${space[1]}`,
          }}
        >
          {fields.map((f) => (
            <label key={f.name} style={{ ...small, display: "flex", gap: 4 }}>
              <input
                type="checkbox"
                checked={!hidden.has(f.name)}
                onChange={() => {
                  const next = new Set(hidden);
                  if (next.has(f.name)) next.delete(f.name);
                  else next.add(f.name);
                  setHidden(next);
                }}
              />
              {f.name}
            </label>
          ))}
        </div>
      )}
      {filters.length > 0 && (
        <div
          data-data-filters=""
          style={{
            display: "grid",
            gap: 4,
            padding: `0 ${space[2]} ${space[1]}`,
          }}
        >
          <span
            style={{ ...muted, display: "flex", gap: 4, alignItems: "center" }}
          >
            {t(M.matchBefore)}
            <select
              data-data-match=""
              style={control}
              value={match}
              onChange={(e) => setMatch(e.target.value as "all" | "any")}
            >
              <option value="all">{t(M.matchAll)}</option>
              <option value="any">{t(M.matchAny)}</option>
            </select>
            {t(M.matchAfter)}
          </span>
          {filters.map((f, i) => {
            const set = (patch: Partial<FilterRow>) =>
              setFilters(
                filters.map((x, j) => (j === i ? { ...x, ...patch } : x)),
              );
            return (
              <div
                key={i}
                data-data-filter={i}
                style={{ display: "flex", gap: 4 }}
              >
                <select
                  style={control}
                  value={f.field}
                  onChange={(e) => set({ field: e.target.value })}
                >
                  {fields.map((x) => (
                    <option key={x.name} value={x.name}>
                      {x.name}
                    </option>
                  ))}
                </select>
                <select
                  style={control}
                  value={f.op}
                  onChange={(e) => set({ op: e.target.value as FilterOp })}
                >
                  {OPS.map((o) => (
                    <option key={o.op} value={o.op}>
                      {t(M[o.key])}
                    </option>
                  ))}
                </select>
                {f.op !== "blank" && f.op !== "notBlank" && (
                  <input
                    style={{ ...control, width: 90 }}
                    value={f.value}
                    onChange={(e) => set({ value: e.target.value })}
                  />
                )}
                <button
                  type="button"
                  style={button}
                  aria-label={t(M.remove)}
                  onClick={() => setFilters(filters.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
      {failure && (
        <p
          data-data-failure=""
          style={{ ...small, color: status.error, padding: `0 ${space[2]}` }}
        >
          {t(M.failed, { reason: failure })}
        </p>
      )}
      <div
        ref={scroller}
        data-data-grid=""
        role="grid"
        aria-rowcount={count}
        style={{
          flex: 1,
          minHeight: 120,
          overflow: "auto",
          position: "relative",
          borderTop: `1px solid ${color.border}`,
        }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div
          role="row"
          style={{
            display: "flex",
            position: "sticky",
            top: 0,
            zIndex: 1,
            background: color.muted,
            height: ROW_H,
          }}
        >
          {visible.map((f) => {
            const s = keys.findIndex((k) => k.field === f.name);
            const b = bound.get(f.name);
            const n = b?.count ?? 0;
            const cue =
              b?.tone === "error"
                ? t(M.fieldError)
                : b?.tone === "warn"
                  ? t(M.fieldStale)
                  : t(M.fieldLinked);
            return (
              <button
                key={f.name}
                type="button"
                role="columnheader"
                data-data-header={f.name}
                // Editor ADR 291, drag to place: a query's field goes onto a
                // frame (the viewport hit-tests the drop and places it).
                draggable={table.kind === "query"}
                onDragStart={(e) => {
                  e.dataTransfer.setData(
                    DATA_FIELD_DRAG_TYPE,
                    JSON.stringify({ query: table.name, field: f.name }),
                  );
                  e.dataTransfer.setData("text/plain", f.name);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                data-bound={n > 0 ? (b?.tone ?? "none") : undefined}
                title={
                  n > 0
                    ? `${t(M.sortHint)} · ${t(M.bound, { count: n })} · ${cue} · ${t(M.selectHint)}${table.kind === "query" ? ` · ${t(M.dragHint)}` : ""}`
                    : table.kind === "query"
                      ? `${t(M.sortHint)} · ${t(M.dragHint)}`
                      : t(M.sortHint)
                }
                aria-sort={
                  s < 0 ? "none" : keys[s]!.desc ? "descending" : "ascending"
                }
                onClick={(e) => {
                  // A double-click's second click selects, it does not
                  // reverse the sort the first one set.
                  if (e.detail > 1) return;
                  setSort(nextSort(sort, f.name, e.shiftKey));
                }}
                onContextMenu={(e) => {
                  if (!assets) return;
                  e.preventDefault();
                  setPicture(f.name);
                }}
                onDoubleClick={() => {
                  if (n === 0) return;
                  void selectPlaced(
                    {
                      service,
                      client,
                      setElementSelection,
                      setElementGeometry,
                    },
                    statuses,
                    table.name,
                    f.name,
                  );
                }}
                style={{
                  ...small,
                  width: colW,
                  flex: "0 0 auto",
                  textAlign: "left",
                  padding: "0 6px",
                  border: "none",
                  borderRight: `1px solid ${color.border}`,
                  borderBottom:
                    n > 0
                      ? `2px solid ${TONE_COLOR[b?.tone ?? "none"]}`
                      : `1px solid ${color.border}`,
                  background: "transparent",
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {f.name}
                <span
                  style={{ ...muted, marginLeft: 4, fontFamily: font.mono }}
                >
                  {f.ty}
                </span>
                {assets?.has(f.name) && (
                  <AssetColumnMarker column={assets.get(f.name)!} />
                )}
                {s >= 0 && (
                  <span
                    style={muted}
                  >{` ${keys[s]!.desc ? "▼" : "▲"}${keys.length > 1 ? s + 1 : ""}`}</span>
                )}
              </button>
            );
          })}
        </div>
        <div style={{ height: rows.length * ROW_H, position: "relative" }}>
          {rows.slice(first, last).map((r, k) => {
            const top = (first + k) * ROW_H;
            if (r.kind === "group")
              return (
                <button
                  key={`g:${r.value}:${first + k}`}
                  type="button"
                  role="row"
                  data-data-group-row={r.value}
                  aria-expanded={r.open}
                  onClick={() => {
                    const next = new Set(closed);
                    if (next.has(r.value)) next.delete(r.value);
                    else next.add(r.value);
                    setClosed(next);
                  }}
                  style={{
                    ...small,
                    position: "absolute",
                    top,
                    left: 0,
                    right: 0,
                    height: ROW_H,
                    textAlign: "left",
                    padding: "0 6px",
                    border: "none",
                    background: color.primarySoft,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {r.open ? "▾" : "▸"} {r.value || "—"}{" "}
                  <span style={muted}>({r.count})</span>
                </button>
              );
            const record = records ? recordAt(r.index) : null;
            const cue = recordCue(records, record);
            return (
              <div
                key={`r:${r.index}`}
                role="row"
                data-data-row={r.index}
                // Editor ADR 291: a record onto a design. Only while the grid
                // shows the query's own order: a row's place is then its
                // record number.
                draggable={rowsDrag}
                onDragStart={(e) => {
                  e.dataTransfer.setData(
                    DATA_RECORD_DRAG_TYPE,
                    JSON.stringify({ query: table.name, record: r.index }),
                  );
                  e.dataTransfer.setData("text/plain", String(r.index + 1));
                  e.dataTransfer.effectAllowed = "copy";
                }}
                {...recordAttrs(cue, t, rowsDrag ? t(M.rowHint) : undefined)}
                onDoubleClick={() => {
                  if (!cue.placed || record === null) return;
                  void selectRecord(
                    {
                      service,
                      client,
                      setElementSelection,
                      setElementGeometry,
                    },
                    statuses,
                    table.name,
                    record,
                  );
                }}
                style={{
                  display: "flex",
                  position: "absolute",
                  top,
                  left: 0,
                  height: ROW_H,
                  borderBottom: `1px solid ${color.border}`,
                  ...recordStyle(cue),
                }}
              >
                {visible.map((f) => (
                  <div
                    key={f.name}
                    role="gridcell"
                    style={{
                      ...small,
                      width: colW,
                      padding: "0 6px",
                      lineHeight: `${ROW_H}px`,
                      borderRight: `1px solid ${color.border}`,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      fontFamily: f.ty === "text" ? font.sans : font.mono,
                    }}
                  >
                    {valueAt(r.index, f.name)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StatusBar({
  statuses,
  updating,
  onUpdate,
}: {
  statuses: readonly DataBindingStatus[];
  updating: boolean;
  onUpdate: (() => void) | null;
}) {
  const { t } = useStrings();
  const count = (tone: Tone) =>
    statuses.filter((b) => toneOf(b.status) === tone).length;
  const stale = statuses.filter((b) => b.status === "stale").length;
  const kept = statuses.filter(
    (b) => b.status === "pinned" || b.status === "overridden",
  ).length;
  const chip = (tone: Tone, text: string, attr: string) => (
    <span data-data-status={attr} style={{ ...small, color: TONE_COLOR[tone] }}>
      ● {text}
    </span>
  );
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: space[2],
        padding: `${space[1]} ${space[2]}`,
      }}
    >
      {statuses.length > 0 &&
        chip("ok", t(M.inSync, { count: count("ok") }), "linked")}
      {stale > 0 && chip("warn", t(M.stale, { count: stale }), "stale")}
      {kept > 0 && chip("none", t(M.kept, { count: kept }), "kept")}
      {count("error") > 0 &&
        chip("error", t(M.errors, { count: count("error") }), "error")}
      <span style={{ flex: 1 }} />
      {onUpdate && (
        <button
          type="button"
          data-data-update=""
          style={button}
          title={t(M.updateTitle)}
          disabled={updating}
          onClick={onUpdate}
        >
          {updating ? t(M.updating) : t(M.update)}
        </button>
      )}
    </div>
  );
}

export function DataPanel() {
  const { t } = useStrings();
  const service = useDataService();
  const revision = useDataRevision();
  const [tables, setTables] = useState<readonly DataTableInfo[]>([]);
  const [statuses, setStatuses] = useState<readonly DataBindingStatus[]>([]);
  const [updating, setUpdating] = useState(false);
  const [active, setActive] = useState("");
  const [pipeline, setPipeline] = useState(false);

  useEffect(() => {
    if (!service) return;
    let live = true;
    void Promise.resolve(service.tables()).then((all) => {
      if (live) setTables(all);
    });
    void service.status?.().then(
      (b) => live && setStatuses(b),
      () => live && setStatuses([]),
    );
    return () => {
      live = false;
    };
  }, [service, revision]);

  const shown = service ? tables : [];
  if (shown.length === 0) {
    // The first run's sample: loaded, its query's tab shows.
    const loads =
      service && typeof service.loadSample === "function" ? service : null;
    return (
      <Start
        hasService={service !== null}
        sample={loads ? async () => setActive(await loads.loadSample!()) : null}
      />
    );
  }
  const table = shown.find((x) => x.name === active) ?? shown[0]!;
  return (
    <div
      data-data-panel=""
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div
        role="tablist"
        style={{
          display: "flex",
          gap: 2,
          padding: `${space[1]} ${space[2]} 0`,
          overflowX: "auto",
        }}
      >
        {shown.map((x) => (
          <button
            key={x.name}
            type="button"
            role="tab"
            data-data-tab={x.name}
            aria-selected={x.name === table.name}
            onClick={() => setActive(x.name)}
            style={{
              ...small,
              height: 24,
              padding: "0 10px",
              border: `1px solid ${color.border}`,
              borderBottom: "none",
              borderRadius: `${radius.sm} ${radius.sm} 0 0`,
              background: x.name === table.name ? color.bg : color.muted,
              fontWeight: x.name === table.name ? 600 : 400,
              cursor: "pointer",
            }}
          >
            {x.name}
            {!x.writable && (
              <span style={{ ...muted, marginLeft: 4 }}>{t(M.derived)}</span>
            )}
          </button>
        ))}
        {offersPipeline(service) && (
          <PipelineToggle
            open={pipeline}
            onToggle={() => setPipeline(!pipeline)}
          />
        )}
      </div>
      {pipeline && service && offersPipeline(service) && (
        <DataPipeline service={service} onSelect={setActive} />
      )}
      <StatusBar
        statuses={statuses}
        updating={updating}
        onUpdate={
          service && typeof service.refresh === "function"
            ? () => {
                setUpdating(true);
                void service.refresh!().then(
                  () => setUpdating(false),
                  () => setUpdating(false),
                );
              }
            : null
        }
      />
      {service && (
        <Grid
          key={table.name}
          service={service}
          table={table}
          statuses={statuses}
        />
      )}
    </div>
  );
}
