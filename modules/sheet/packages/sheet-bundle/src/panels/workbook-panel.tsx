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

// The workbook panel — a React expert-leaf factory closing over the
// BundleHost + the in-memory session. It owns the file input (S-11: no
// host file picker), the sheet list, the range input, the "Place on page"
// action, the S-08 storage notice, and the engine-boot failure state
// (S-10) — rendered honestly, never faked.
//
// Layout: the file and sheet controls stay on top; everything else sits in
// collapsible sections (native <details>), with "Place on page" open by
// default. Settings with another home are a one-line pointer here: find
// and replace live in the Grid panel; number format, font, fill, alignment
// and iterative calculation in Sheet properties (when the host renders it).
//
// Built from host surfaces + React ONLY (no @paged-media/shell): all
// spreadsheet work is the engine's; the panel reads the session snapshot
// and triggers session actions. Token-layer styling (--pg-*, --space-*,
// --font-mono, --radius-*, sentence-case labels) mirrors plugin-web's
// source panel so it reads native in both themes.

import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { onDidChangeOf, useLive } from "@paged-media/react-live";
import {
  chrome,
  color,
  Disclosure,
  font,
  radius,
  space,
  status,
  useConfirm,
} from "@paged-media/panel-kit";
import { useStrings } from "@paged-media/strings";

import type { BundleHost } from "@paged-media/plugin-api";

import type { FunctionEntry } from "../../../sheet-host-model/src";
import {
  importBytes,
  SPREADSHEET_ACCEPT,
  SPREADSHEET_EXTENSIONS,
} from "../import-xlsx";
import { columnLabel, type WorkbookSession } from "../session";
import { CHART_STYLE, COMMANDS, DOC_STYLES, WORKBOOK as M } from "../messages";
import { ChartStyleSection } from "./chart-style-section";
import { FormatSection, NamesSection, tokenLabel } from "./format-section";
import { PROPERTIES_PANEL_ID } from "./properties-panel";
import { DocStylesSection } from "./doc-styles-section";

const GRID_PANEL_ID = "media.paged.sheet.panel.grid";

// ---------------------------------------------------------------- styles

const kicker: CSSProperties = {
  font: `700 10px ${font.sans}`,
  letterSpacing: font.trackingWide,
  textTransform: "uppercase",
  color: "var(--pg-muted-fg)",
  margin: `${space[3]} 0 ${space[1]}`,
};

const body: CSSProperties = {
  font: `12px ${font.sans}`,
  color: "var(--pg-fg)",
};

const note: CSSProperties = {
  margin: `${space[1]} 0 0`,
  font: `11px/1.5 ${font.sans}`,
  color: "var(--pg-muted-fg)",
};

const input: CSSProperties = {
  font: `12px ${font.sans}`,
  fontFamily: font.mono,
  color: "var(--pg-fg)",
  background: "var(--pg-bg)",
  border: "1px solid var(--pg-border)",
  borderRadius: radius.sm,
  padding: "4px 6px",
  minWidth: 0,
};

const primaryButton: CSSProperties = {
  font: `500 12px ${font.sans}`,
  color: color.primaryFg,
  background: "var(--pg-primary)",
  border: "none",
  borderRadius: radius.md,
  padding: "6px 12px",
  cursor: "pointer",
};

/** A quieter button for the structure verbs. */
const secondaryButton: CSSProperties = {
  font: `12px ${font.sans}`,
  padding: "3px 8px",
  color: "var(--pg-fg)",
  background: color.muted,
  border: "1px solid var(--pg-border)",
  borderRadius: radius.sm,
  cursor: "pointer",
};

const row: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: space[1],
  marginTop: space[1],
};

const linkButton: CSSProperties = {
  font: "inherit",
  color: "var(--pg-primary)",
  background: "none",
  border: "none",
  padding: 0,
  cursor: "pointer",
  textDecoration: "underline",
};

const sectionStyle: CSSProperties = {
  borderTop: `1px solid ${chrome.divider}`,
  padding: `${space[2]} 0`,
};

const summaryStyle: CSSProperties = {
  font: `600 12px ${font.sans}`,
  color: "var(--pg-fg)",
  cursor: "pointer",
};

/** One collapsible group of the panel. */
function Section(props: {
  id: string;
  title: string;
  open?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <Disclosure
      summary={props.title}
      defaultOpen={props.open}
      data-sheet-section={props.id}
      style={sectionStyle}
      summaryStyle={summaryStyle}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          marginTop: space[1],
        }}
      >
        {props.children}
      </div>
    </Disclosure>
  );
}

// ----------------------------------------------------------------- panel

export function makeWorkbookPanel(
  host: BundleHost,
  session: WorkbookSession,
): () => ReactElement {
  // A declaration, so the React Compiler sees the component (it cannot
  // see `return function WorkbookPanel()`, editor ADR 229).
  function WorkbookPanel(): ReactElement {
    // Re-render on every session change (import, sheet/range edits): the
    // session as a render value (react-live, editor ADR 229), a new view
    // after every change, so what is read from it is read again.
    const live = useLive(session, onDidChangeOf);
    const { t } = useStrings();
    const fileRef = useRef<HTMLInputElement | null>(null);

    const st = live.state();
    const { armed, confirm } = useConfirm();

    const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await importBytes(session, bytes, file.name);
      } catch (err) {
        host.log.error("workbook file read failed", err);
      }
    };

    // S-11: prefer the HOST file picker (a real modal dialog); the panel's
    // own `<input>` stays as the honest no-picker fallback.
    const pickerSupported = host.supports("shell.pickFile@1");
    const onPick = async () => {
      try {
        const files = await host.shell.pickFile({
          accept: SPREADSHEET_ACCEPT,
          multiple: false,
        });
        const file = files[0];
        if (!file) return; // cancelled
        await importBytes(session, file.bytes, file.name);
      } catch (err) {
        host.log.error("workbook pick failed", err);
      }
    };

    // The Sheet properties panel carries number format, font, fill,
    // alignment and iterative calculation; where the host renders it, the
    // format section points there instead of repeating them.
    const openProperties = host.supports("contribute.schemaPanel@1")
      ? () => host.shell.openPanel(PROPERTIES_PANEL_ID)
      : undefined;

    const [placeMsg, setPlaceMsg] = useState<string | null>(null);
    const onPlace = () => {
      setPlaceMsg(null);
      void session.lowerSelection().then((id) => {
        if (id === null) setPlaceMsg(t(M.placeFailed));
      });
    };

    // Wave 4 — workbook structure + pagination. Every verb answers
    // {ok} / {ok:false, message}; the message shows verbatim (the engine's
    // own reason, e.g. what preserved content blocks a row insert).
    const [structMsg, setStructMsg] = useState<string | null>(null);
    const [sheetMsg, setSheetMsg] = useState<string | null>(null);
    const [renameTo, setRenameTo] = useState("");
    const report = (
      r: { ok: true } | { ok: false; message: string },
      done: string,
    ) => setStructMsg(r.ok ? done : r.message);
    const reportSheet = (
      r: { ok: true } | { ok: false; message: string },
      done: string,
    ) => setSheetMsg(r.ok ? done : r.message);
    // Wave 6 — header rows repeated at the top of every threaded frame.
    const [headerRows, setHeaderRows] = useState(1);
    const onPaginate = async () => {
      const r = await session.paginateSelection({
        repeatHeaderRows: Math.max(0, Math.floor(headerRows)),
      });
      setPlaceMsg(r.ok ? t(M.paginated) : r.message);
    };

    // Sort-range controls (thin glue — the engine owns the sort semantics;
    // sheet.plugin.sort.command). Key column is 1-based in the UI.
    const [sortKey, setSortKey] = useState(1);
    const [sortAsc, setSortAsc] = useState(true);
    const [sortHeader, setSortHeader] = useState(false);
    const [sortMsg, setSortMsg] = useState<string | null>(null);
    const onSort = () => {
      const res = session.sortRange(
        Math.max(0, Math.floor(sortKey) - 1),
        sortAsc,
        sortHeader,
      );
      setSortMsg(res.ok ? t(M.sorted) : res.message);
    };

    // New cell style from the selected cell (S-04). Thin glue over
    // session.newCellStyleFromSelection — the engine owns the lowering, the
    // platform owns the style mint + the cell read; this only routes the name.
    const [styleName, setStyleName] = useState(() =>
      t(COMMANDS.defaultStyleName),
    );
    const [styleMsg, setStyleMsg] = useState<string | null>(null);

    // Chart authoring (editor-ui-coverage M — the model was import-only).
    const [chartKind, setChartKind] = useState("column");
    const [chartValues, setChartValues] = useState("");
    const [chartCats, setChartCats] = useState("");
    const [chartTitle, setChartTitle] = useState("");
    // The §16.4 transpose control: which axis of the values block is a series.
    const [chartSeriesIn, setChartSeriesIn] = useState("columns");
    const [chartMsg, setChartMsg] = useState<string | null>(null);
    const onAuthorChart = () => {
      if (!chartValues.trim()) {
        setChartMsg(t(M.valuesFirst));
        return;
      }
      const res = session.authorChart(
        chartValues.trim(),
        chartCats.trim(),
        chartKind,
        chartTitle.trim(),
        chartSeriesIn,
      );
      setChartMsg(res.ok ? t(M.chartCreated) : res.message);
    };

    // Function browser (editor-ui-coverage M): filter + copy-to-clipboard.
    const [fnFilter, setFnFilter] = useState("");
    const [fnMsg, setFnMsg] = useState<string | null>(null);
    const onCopyFunction = async (name: string) => {
      if (!host.supports("clipboard@1")) {
        setFnMsg(t(M.noClipboard, { name }));
        return;
      }
      try {
        await host.clipboard.write({ text: `${name}()` });
        setFnMsg(t(M.fnCopied, { name }));
      } catch (e) {
        setFnMsg(t(M.fnCopyFailed, { name, error: String(e) }));
      }
    };
    const onNewCellStyle = async () => {
      const res = await session.newCellStyleFromSelection(
        styleName.trim() || t(COMMANDS.defaultStyleName),
      );
      if (!res.ok) {
        setStyleMsg(res.message);
        return;
      }
      setStyleMsg(
        res.applied
          ? t(M.styleApplied, { count: res.capturedCount })
          : t(M.styleNotApplied, {
              count: res.capturedCount,
              reason: res.applyMessage ?? t(M.styleCreatedOnly),
            }),
      );
    };

    // Memoised in the session until the next change (not per render).
    const sheets = live.sheets();
    // The engine's read-only inventories, read once per session change —
    // not on every render (a keystroke in any of this panel's inputs
    // re-renders it).
    // eslint-disable-next-line no-restricted-syntax -- a computed block, not a single expression (ADR 229)
    const inventories = useMemo(() => {
      // Read through the view, so the memo follows each session change.
      const eng = live.state().engine;
      if (!eng) return null;
      return {
        freezes: eng.listFreezePanes(),
        validations: eng.listDataValidations(),
        comments: eng.listComments(),
        charts: eng.listCharts(),
      };
    }, [live]);
    // The chart-kind vocabulary comes from the ENGINE (Rust owns which kinds
    // exist), never a literal list here.
    const chartKinds = live.chartKinds();
    const hasRange = !!st.selectedRange;
    const deleteLabel = (key: string, label: string) =>
      armed === key ? t(M.confirmDelete) : label;

    return (
      <div
        data-sheet-panel="workbook"
        style={{
          padding: space[3],
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ ...kicker, marginTop: 0 }}>{t(M.kicker)}</div>
        {/* S-11 RESOLVED: the host file picker is the primary path; the
         *  panel's own `<input>` is the honest fallback when no picker is
         *  wired (headless / a host that predates the door). */}
        <div style={{ ...row, marginTop: 0, marginBottom: space[2] }}>
          {pickerSupported ? (
            <button
              data-sheet-pick
              type="button"
              onClick={() => void onPick()}
              style={primaryButton}
            >
              {t(M.open)}
            </button>
          ) : (
            <input
              ref={fileRef}
              data-sheet-file
              type="file"
              accept={SPREADSHEET_EXTENSIONS}
              aria-label={t(M.openAria)}
              onChange={onFile}
              style={{ ...body, maxWidth: "100%" }}
            />
          )}
          <button
            data-sheet-new
            type="button"
            data-armed={armed === "new" ? "" : undefined}
            title={sheets.length > 0 ? t(M.replacesWorkbook) : undefined}
            onClick={() => {
              const run = () => void session.newWorkbook();
              if (sheets.length > 0) confirm("new", run);
              else run();
            }}
            style={secondaryButton}
          >
            {armed === "new" ? t(M.confirmReplace) : t(M.newWorkbook)}
          </button>
        </div>

        {/* S-10: engine-boot failure (the wasm isn't built) — say so. */}
        {st.bootError && (
          <div
            data-sheet-boot-error
            role="alert"
            style={{
              ...body,
              padding: "6px 8px",
              color: status.error,
              background: color.muted,
              border: "1px solid var(--pg-border)",
              borderRadius: radius.sm,
            }}
          >
            {t(M.bootError, { error: st.bootError })}
          </div>
        )}

        {!st.bootError && sheets.length === 0 && (
          <p data-sheet-empty style={{ ...note, marginTop: 0 }}>
            {t(M.empty)}
          </p>
        )}

        {st.fileName && (
          <p style={{ ...body, margin: `0 0 ${space[1]}` }}>
            {t(M.imported)}{" "}
            <span style={{ fontFamily: font.mono }}>{st.fileName}</span>.
          </p>
        )}

        {sheets.length > 0 && (
          <>
            <div style={kicker}>{t(M.sheetKicker)}</div>
            <select
              data-sheet-select
              value={st.activeSheet ?? sheets[0].id}
              aria-label={t(M.activeSheet)}
              onChange={(e) => session.setActiveSheet(Number(e.target.value))}
              style={input}
            >
              {sheets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.kind === "chartsheet"
                    ? t(M.chartSheetOption, { name: s.name })
                    : `${s.name} (${s.rows} × ${s.cols})`}
                </option>
              ))}
            </select>

            <div style={row}>
              <button
                type="button"
                data-sheet-add
                style={secondaryButton}
                onClick={() => reportSheet(session.addSheet(), t(M.sheetAdded))}
              >
                {t(M.addSheet)}
              </button>
              <input
                data-sheet-rename-to
                type="text"
                value={renameTo}
                onChange={(e) => setRenameTo(e.target.value)}
                placeholder={t(M.newName)}
                aria-label={t(M.newNameAria)}
                style={{ ...input, width: 110, marginTop: 0 }}
              />
              <button
                type="button"
                data-sheet-rename
                style={secondaryButton}
                disabled={renameTo.trim().length === 0}
                title={renameTo.trim() ? undefined : t(M.typeNameFirst)}
                onClick={() =>
                  reportSheet(
                    session.renameSheet(st.activeSheet ?? 0, renameTo.trim()),
                    t(M.sheetRenamed),
                  )
                }
              >
                {t(M.rename)}
              </button>
              <button
                type="button"
                data-sheet-delete
                data-armed={armed === "sheet" ? "" : undefined}
                style={secondaryButton}
                disabled={sheets.length <= 1}
                title={
                  sheets.length <= 1
                    ? t(M.oneSheetNeeded)
                    : t(M.deleteSheetTitle)
                }
                onClick={() =>
                  confirm("sheet", () =>
                    reportSheet(
                      session.deleteSheet(st.activeSheet ?? 0),
                      t(M.sheetDeleted),
                    ),
                  )
                }
              >
                {deleteLabel("sheet", t(M.deleteSheet))}
              </button>
            </div>
            {sheetMsg && (
              <div
                data-sheet-sheet-msg
                role="status"
                style={{ ...body, marginTop: 4 }}
              >
                {sheetMsg}
              </div>
            )}

            <div style={{ height: space[2] }} />

            <Section id="place" title={t(M.placeSection)} open>
              <label
                style={{
                  ...body,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                {t(M.range)}
                <input
                  data-sheet-range
                  type="text"
                  value={st.selectedRange ?? ""}
                  onChange={(e) => session.setRange(e.target.value)}
                  placeholder="A1:D20"
                  style={input}
                />
              </label>
              <div style={{ ...row, marginTop: space[2] }}>
                <button
                  type="button"
                  data-sheet-lower
                  onClick={onPlace}
                  disabled={!hasRange}
                  title={hasRange ? t(M.placeTitle) : t(M.rangeFirst)}
                  style={{
                    ...primaryButton,
                    opacity: hasRange ? 1 : 0.5,
                    cursor: hasRange ? "pointer" : "not-allowed",
                  }}
                >
                  {t(M.place)}
                </button>
              </div>
              <div style={row}>
                <button
                  type="button"
                  data-sheet-paginate
                  onClick={() => void onPaginate()}
                  disabled={!hasRange}
                  style={secondaryButton}
                  title={hasRange ? t(M.chainFirst) : t(M.rangeFirst)}
                >
                  {t(M.paginate)}
                </button>
                <label
                  style={{
                    ...body,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                  title={t(M.headerRowsTitle)}
                >
                  {t(M.headerRows)}
                  <input
                    data-sheet-paginate-header-rows
                    type="number"
                    min={0}
                    value={headerRows}
                    onChange={(e) => setHeaderRows(Number(e.target.value))}
                    style={{ ...input, width: 52 }}
                  />
                </label>
              </div>
              {placeMsg && (
                <div
                  data-sheet-place-msg
                  role="status"
                  style={{ ...body, marginTop: 4 }}
                >
                  {placeMsg}
                </div>
              )}
            </Section>

            <Section id="structure" title={t(M.structureSection)}>
              <p style={{ ...note, marginTop: 0 }}>{t(M.structureNote)}</p>
              <div style={row}>
                <button
                  type="button"
                  data-sheet-insert-rows
                  style={secondaryButton}
                  onClick={() =>
                    report(
                      session.structuralEdit("insertRows"),
                      t(M.rowsInserted),
                    )
                  }
                >
                  {t(M.insertRows)}
                </button>
                <button
                  type="button"
                  data-sheet-delete-rows
                  style={secondaryButton}
                  data-armed={armed === "rows" ? "" : undefined}
                  title={t(M.deleteRowsTitle)}
                  onClick={() =>
                    confirm("rows", () =>
                      report(
                        session.structuralEdit("deleteRows"),
                        t(M.rowsDeleted),
                      ),
                    )
                  }
                >
                  {deleteLabel("rows", t(M.deleteRows))}
                </button>
                <button
                  type="button"
                  data-sheet-insert-cols
                  style={secondaryButton}
                  onClick={() =>
                    report(
                      session.structuralEdit("insertCols"),
                      t(M.colsInserted),
                    )
                  }
                >
                  {t(M.insertCols)}
                </button>
                <button
                  type="button"
                  data-sheet-delete-cols
                  style={secondaryButton}
                  data-armed={armed === "cols" ? "" : undefined}
                  title={t(M.deleteColsTitle)}
                  onClick={() =>
                    confirm("cols", () =>
                      report(
                        session.structuralEdit("deleteCols"),
                        t(M.colsDeleted),
                      ),
                    )
                  }
                >
                  {deleteLabel("cols", t(M.deleteCols))}
                </button>
              </div>
              {structMsg && (
                <div
                  data-sheet-struct-msg
                  role="status"
                  style={{ ...body, marginTop: 4 }}
                >
                  {structMsg}
                </div>
              )}
            </Section>

            <Section id="format" title={t(M.formatSection)}>
              <FormatSection
                session={session}
                styles={{ kicker, body, input, button: secondaryButton, row }}
                openProperties={openProperties}
              />
            </Section>

            <Section id="names" title={t(M.namesSection)}>
              <NamesSection
                session={session}
                styles={{ kicker, body, input, button: secondaryButton, row }}
              />
            </Section>

            {/* Sort range — thin controls over engine.sortRange (the
             *  values-only honest subset; a formula range refuses and the
             *  engine's message shows verbatim). */}
            <Section id="sort" title={t(M.sortSection)}>
              <div style={{ ...row, marginTop: 0 }}>
                <label
                  style={{
                    ...body,
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  {t(M.keyColumn)}
                  <input
                    data-sheet-sort-key
                    type="number"
                    min={1}
                    value={sortKey}
                    onChange={(e) => setSortKey(Number(e.target.value))}
                    title={t(M.keyColumnTitle)}
                    style={{ ...input, width: 52 }}
                  />
                </label>
                <select
                  data-sheet-sort-dir
                  value={sortAsc ? "asc" : "desc"}
                  aria-label={t(M.sortDirection)}
                  onChange={(e) => setSortAsc(e.target.value === "asc")}
                  style={input}
                >
                  <option value="asc">{t(M.ascending)}</option>
                  <option value="desc">{t(M.descending)}</option>
                </select>
                <label
                  style={{
                    ...body,
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <input
                    data-sheet-sort-header
                    type="checkbox"
                    checked={sortHeader}
                    onChange={(e) => setSortHeader(e.target.checked)}
                  />
                  {t(M.hasHeader)}
                </label>
              </div>
              <div style={row}>
                <button
                  type="button"
                  data-sheet-sort
                  onClick={onSort}
                  disabled={!hasRange}
                  title={hasRange ? undefined : t(M.rangeFirst)}
                  style={{
                    ...primaryButton,
                    opacity: hasRange ? 1 : 0.5,
                    cursor: hasRange ? "pointer" : "not-allowed",
                  }}
                >
                  {t(M.sort)}
                </button>
              </div>
              {sortMsg && (
                <p
                  data-sheet-sort-msg
                  style={{ ...body, margin: `${space[1]} 0 0` }}
                >
                  {sortMsg}
                </p>
              )}
            </Section>

            {/* New cell style from the selected cell (S-04): the style is
             *  minted + populated from the cell's appearance and applied
             *  back to the cell (the message reports whether the apply took). */}
            <Section id="cell-style" title={t(M.stylesSection)}>
              <input
                data-sheet-cellstyle-name
                type="text"
                value={styleName}
                onChange={(e) => setStyleName(e.target.value)}
                placeholder={t(M.styleName)}
                aria-label={t(M.styleName)}
                style={input}
              />
              <div style={row}>
                <button
                  type="button"
                  data-sheet-cellstyle-new
                  onClick={() => void onNewCellStyle()}
                  style={secondaryButton}
                >
                  {t(M.newStyle)}
                </button>
              </div>
              {styleMsg && (
                <p
                  data-sheet-cellstyle-msg
                  style={{ ...body, margin: `${space[1]} 0 0` }}
                >
                  {styleMsg}
                </p>
              )}
              <p data-sheet-cellstyle-note style={note}>
                {t(M.styleNote)}
              </p>
            </Section>

            {/* Sheet ADR 524 — the document's styles for the workbook's
             *  Excel named styles: the switch, the mapping table, "Create
             *  document styles from workbook" and the missing references. */}
            <Section id="doc-styles" title={t(DOC_STYLES.section)}>
              <DocStylesSection session={live} />
            </Section>

            {/* CHART AUTHORING — the chart engine was import-only. Authored
             *  charts render + place through the SAME generator as parsed
             *  ones, and are written into the xlsx on save (a generated
             *  chart part, sheet ADR 519).
             *  The kind list is READ FROM THE ENGINE (session.chartKinds),
             *  never hard-coded here: which kinds exist is a Rust decision,
             *  so the panel cannot offer one the engine refuses. */}
            <Section id="charts" title={t(M.chartsSection)}>
              <div style={{ ...row, marginTop: 0 }}>
                <select
                  data-sheet-chart-kind
                  value={chartKind}
                  aria-label={t(M.chartType)}
                  onChange={(e) => setChartKind(e.target.value)}
                  style={input}
                >
                  {chartKinds.map((k) => (
                    <option key={k} value={k}>
                      {tokenLabel(t, k)}
                    </option>
                  ))}
                </select>
                {/* Transpose rows/columns: which axis of the values block is a
                 *  series. Re-reads the same cells — never rewrites data. */}
                <select
                  data-sheet-chart-series-in
                  value={chartSeriesIn}
                  onChange={(e) => setChartSeriesIn(e.target.value)}
                  title={t(M.seriesInTitle)}
                  aria-label={t(M.seriesIn)}
                  style={input}
                >
                  <option value="columns">{t(M.seriesInColumns)}</option>
                  <option value="rows">{t(M.seriesInRows)}</option>
                </select>
              </div>
              <div style={row}>
                <input
                  data-sheet-chart-values
                  type="text"
                  value={chartValues}
                  onChange={(e) => setChartValues(e.target.value)}
                  placeholder={t(M.valuesPlaceholder)}
                  aria-label={t(M.valuesAria)}
                  style={{ ...input, flex: "1 1 110px" }}
                />
                <input
                  data-sheet-chart-cats
                  type="text"
                  value={chartCats}
                  onChange={(e) => setChartCats(e.target.value)}
                  placeholder={t(M.labelsPlaceholder)}
                  aria-label={t(M.labelsAria)}
                  style={{ ...input, flex: "1 1 110px" }}
                />
              </div>
              <div style={row}>
                <input
                  data-sheet-chart-title
                  type="text"
                  value={chartTitle}
                  onChange={(e) => setChartTitle(e.target.value)}
                  placeholder={t(M.titlePlaceholder)}
                  aria-label={t(M.titleAria)}
                  style={{ ...input, flex: "1 1 110px" }}
                />
                <button
                  type="button"
                  data-sheet-chart-author
                  onClick={onAuthorChart}
                  style={secondaryButton}
                >
                  {t(M.createChart)}
                </button>
              </div>
              {chartMsg && (
                <p
                  data-sheet-chart-msg
                  style={{ ...body, margin: `${space[1]} 0 0` }}
                >
                  {chartMsg}
                </p>
              )}
              {(() => {
                if (!inventories) return null;
                const { charts } = inventories;
                if (charts.length === 0) return null;
                return (
                  <div data-sheet-chart-list style={{ marginTop: space[2] }}>
                    {charts.map((c) => (
                      <div
                        key={c.index}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "2px 0",
                          ...body,
                        }}
                      >
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {c.title ||
                            t(M.untitledChart, {
                              kind: tokenLabel(t, c.kind),
                            })}
                          <span style={{ color: "var(--pg-muted-fg)" }}>
                            {" "}
                            · {c.title ? `${tokenLabel(t, c.kind)}, ` : ""}
                            {t(M.chartSeries, { count: c.seriesCount })}
                          </span>
                        </span>
                        <button
                          type="button"
                          data-sheet-chart-lower={c.index}
                          onClick={() => void session.lowerChart(c.index)}
                          style={secondaryButton}
                        >
                          {t(M.place)}
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </Section>

            {/* CHART STYLE (sheet ADR 525) — the charts' roles bound to the
             *  document's swatches, styles and colour groups. */}
            {st.engine ? (
              <Section id="chartStyle" title={t(CHART_STYLE.title)}>
                <ChartStyleSection
                  host={host}
                  session={session}
                  styles={{ body, input, button: secondaryButton, row, note }}
                  view={live}
                />
              </Section>
            ) : null}

            {/* FUNCTION BROWSER — the 224-function library was reachable only
             *  by typing into the grid formula bar. Searchable, grouped by
             *  family, arg counts from the engine's own registry (never a
             *  hand-kept list). Click copies `NAME(` for pasting into a cell
             *  when the clipboard door is wired. */}
            <Section id="functions" title={t(M.functionsSection)}>
              <input
                data-sheet-fn-filter
                type="text"
                value={fnFilter}
                onChange={(e) => setFnFilter(e.target.value)}
                placeholder={t(M.filterFunctions)}
                aria-label={t(M.filterFunctions)}
                style={input}
              />
              {fnMsg && (
                <p role="status" style={{ ...body, margin: `${space[1]} 0 0` }}>
                  {fnMsg}
                </p>
              )}
              <div
                data-sheet-fn-list
                style={{
                  maxHeight: 180,
                  overflowY: "auto",
                  marginTop: space[1],
                }}
              >
                {(() => {
                  if (!st.engine) return null;
                  // The registry, read ONCE per session (it is build-time
                  // fixed) — a filter keystroke re-filters, never re-reads.
                  const all = live.functionList();
                  const q = fnFilter.trim().toUpperCase();
                  const hitsFn = q
                    ? all.filter(
                        (f) =>
                          f.name.includes(q) ||
                          f.family.toUpperCase().includes(q),
                      )
                    : all;
                  const byFamily = new Map<string, FunctionEntry[]>();
                  for (const f of hitsFn) {
                    const list = byFamily.get(f.family) ?? [];
                    list.push(f);
                    byFamily.set(f.family, list);
                  }
                  return [...byFamily.entries()].map(([family, fns]) => (
                    <div key={family}>
                      <div
                        style={{
                          font: `600 11px ${font.sans}`,
                          color: "var(--pg-muted-fg)",
                          margin: `${space[1]} 0 2px`,
                        }}
                      >
                        {tokenLabel(t, family)} ({fns.length})
                      </div>
                      {fns.map((f) => (
                        <button
                          key={f.name}
                          type="button"
                          data-sheet-fn={f.name}
                          title={
                            f.maxArgs === null
                              ? t(M.fnArgsOrMore, {
                                  name: f.name,
                                  count: f.minArgs,
                                })
                              : f.maxArgs === f.minArgs
                                ? t(M.fnArgs, {
                                    name: f.name,
                                    count: f.minArgs,
                                  })
                                : t(M.fnArgsRange, {
                                    name: f.name,
                                    min: f.minArgs,
                                    max: f.maxArgs,
                                  })
                          }
                          onClick={() => void onCopyFunction(f.name)}
                          style={{
                            display: "block",
                            width: "100%",
                            textAlign: "left",
                            border: "none",
                            background: "none",
                            cursor: "pointer",
                            padding: "1px 0",
                            fontSize: 11,
                            fontFamily: font.mono,
                            color: "var(--pg-fg)",
                          }}
                        >
                          {f.name}
                        </button>
                      ))}
                    </div>
                  ));
                })()}
              </div>
            </Section>

            {/* INSPECT — the three read-only inventories the engine has
             *  carried all along (freeze panes, data validations, comments).
             *  Preserve-first honesty: validations are preserved, never
             *  enforced; comments are display-only. */}
            {(() => {
              if (!inventories) return null;
              const { freezes, validations, comments } = inventories;
              if (
                freezes.length === 0 &&
                validations.length === 0 &&
                comments.length === 0
              ) {
                return null;
              }
              return (
                <Section id="inventory" title={t(M.contentsSection)}>
                  <div data-sheet-inspect>
                    {freezes.map((f, i) => (
                      <p
                        key={`f${i}`}
                        data-sheet-freeze
                        style={{ ...body, margin: 0 }}
                      >
                        {t(M.frozen, {
                          sheet:
                            sheets[f.sheet]?.name ??
                            t(M.sheetN, { n: f.sheet + 1 }),
                          rows: f.rows,
                          cols: f.cols,
                        })}
                      </p>
                    ))}
                    {validations.map((v, i) => (
                      <p
                        key={`v${i}`}
                        data-sheet-validation
                        style={{ ...body, margin: 0 }}
                      >
                        {t(M.validations, {
                          sheet:
                            sheets[v.sheet]?.name ??
                            t(M.sheetN, { n: v.sheet + 1 }),
                          count: v.count,
                          kinds: v.kinds.join(", "),
                        })}
                      </p>
                    ))}
                    {comments.length > 0 && (
                      <p data-sheet-comments style={{ ...body, margin: 0 }}>
                        {t(M.comments, {
                          count: comments.length,
                          list: comments
                            .slice(0, 3)
                            .map((c) =>
                              t(M.commentAt, {
                                author: c.author || t(M.unknownAuthor),
                                cell: `${columnLabel(c.col)}${c.row + 1}`,
                              }),
                            )
                            .join(" · "),
                        })}
                        {comments.length > 3 ? " · …" : ""}
                      </p>
                    )}
                  </div>
                </Section>
              );
            })()}

            <p data-sheet-find-pointer style={{ ...note, marginTop: space[2] }}>
              {t(M.findPointer)}{" "}
              <button
                type="button"
                data-sheet-open-grid
                onClick={() => {
                  host.shell.openPanel(GRID_PANEL_ID);
                  session.requestFind();
                }}
                style={linkButton}
              >
                {t(M.gridPanel)}
              </button>
              .
            </p>
          </>
        )}

        {/* S-08 / .paged container: be honest about where the workbook lives —
         *  inside the .paged document (travels with the file) when host.parts
         *  is wired, else this browser's local store, else in-memory. */}
        <p data-sheet-honesty style={{ ...note, marginTop: space[2] }}>
          {host.supports("storage.parts@1")
            ? t(M.savedInDocument)
            : host.supports("storage.blob@1")
              ? t(M.savedInBrowser)
              : t(M.inMemory)}
        </p>
      </div>
    );
  }
  return WorkbookPanel;
}
