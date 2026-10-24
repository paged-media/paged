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

// WP4.11 — File ▸ Automate ▸ Batch… (Photoshop's Batch): run one recorded
// action over a set of files and save each result in a chosen format.
//
// The loop is the shell's pure `runBatch`; this file is the editor's half
// of it (`appBatchDeps`) and the dialog. Per file:
//
//   1. a fresh blank document, so an importer that ADDS content (a
//      workbook range, a picture) lands in its own document rather than in
//      the previous file's result;
//   2. the file through the editor's ONE open path (`openFile`: the
//      importer registry, then the IDML / .paged load) — with the
//      run-on-import rules muted, or every file would set them off;
//   3. the action, played with its stops and breakpoints passed by (each
//      passed stop is logged) and grouped into one undo step;
//   4. the result exported as .paged, IDML or PDF and delivered as a
//      download named after the file; the document is then marked saved,
//      which is true — its result was just written out — so the next open
//      does not ask about it.
//
// The open document is asked about ONCE, before the first file (the
// replace question, ADR 230). Nothing is written back to the picked files:
// a browser cannot, and a batch that overwrote its inputs would be the
// destructive default Photoshop's own Batch makes optional.

import { useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, ReactNode } from "react";

import {
  BATCH_FORMATS,
  FocusScope,
  confirmDiscard,
  createValueStore,
  mintBlankDocument,
  openFile,
  playerDeps,
  runBatch,
  scoped,
  scopeOf,
  useActions,
  usePaged,
  useScoped,
  withImportHooksSuppressed,
  type BatchDeps,
  type BatchFormat,
  type BatchLogEntry,
  type BatchProgress,
  type CommandContribution,
  type MenuItemContribution,
  type PagedEditor,
} from "@paged-media/shell";
import { color, radius } from "@paged-media/panel-kit";
import { defineMessages, t, useStrings } from "@paged-media/strings";

import { downloadBytes } from "../shell-file-saver";

const M = defineMessages("app.batchDialog", {
  command: "Batch…",
  title: "Batch",
  action: "Action",
  noActions: "Record an action in the Actions panel first.",
  files: "Files",
  chooseFiles: "Choose files…",
  chooseFolder: "Choose folder…",
  fileCount: "{count, plural, one {# file} other {# files}}",
  saveAs: "Save as",
  formatPaged: "Paged document (.paged)",
  formatIdml: "InDesign markup (.idml)",
  formatPdf: "PDF (.pdf)",
  note: "Each result downloads under its file's name; the picked files are not changed. Stops in the action are passed by and logged.",
  run: "Run",
  cancel: "Cancel",
  close: "Close",
  progress: "{done} of {total}",
  current: "Processing {name}…",
  ok: "{file} → {output}",
  failedAt: "{file}: {stage} failed — {error}",
  stepsFailed:
    "{count, plural, one {# step} other {# steps}} of the action failed",
  passedStop: "stop passed: {message}",
  summary: "{ok} saved, {failed} failed",
  cancelled: "Cancelled after {count, plural, one {# file} other {# files}}.",
  stageOpen: "open",
  stagePlay: "play",
  stageExport: "export",
  stageDeliver: "save",
  noDocument: "the file did not open as a document",
  opening: "Running a batch",
});

defineMessages("menu", {
  Automate: "Automate",
  "Batch…": "Batch…",
});

/** Opens the dialog. */
export const BATCH_COMMAND = "paged.actions.batch";

/** US Letter, the blank each file opens over (File ▸ New's default). */
const LETTER_PT: readonly [number, number] = [612, 792];

const OPEN = scoped("batchDialog", () => createValueStore<boolean>(false));

export function buildBatchCommands(): CommandContribution[] {
  return [
    {
      id: BATCH_COMMAND,
      get title() {
        return t(M.command);
      },
      category: "Actions",
      handler: (paged) => scopeOf(paged).get(OPEN).set(true),
    },
  ];
}

export const BATCH_MENU_ITEMS: MenuItemContribution[] = [
  {
    path: "File/Automate/Batch…",
    command: BATCH_COMMAND,
    order: 62,
    group: "produce",
  },
];

/** Export the open document as `format`. */
async function exportAs(
  editor: PagedEditor,
  format: BatchFormat,
): Promise<Uint8Array> {
  const client = editor.client;
  if (format === "idml") return client.exportIdml();
  if (format === "paged") return client.exportPaged();
  return (await client.exportPdf({ standard: "pdf17" })).bytes;
}

const MIME: Record<BatchFormat, string> = {
  paged: "application/vnd.paged-media.paged",
  idml: "application/vnd.adobe.indesign-idml-package",
  pdf: "application/pdf",
};

/**
 * The editor's half of a batch: how a file opens, how the action plays,
 * how the result is exported and delivered. `deliver` defaults to a
 * download; the headless test collects the bytes instead.
 */
export function appBatchDeps(
  editor: PagedEditor,
  options: {
    deliver?: (name: string, bytes: Uint8Array, format: BatchFormat) => void;
    setStatus?: (s: string) => void;
  } = {},
): BatchDeps<File> {
  const client = editor.client;
  const warnings: string[] = [];
  const sinks = {
    setStatus: options.setStatus ?? (() => {}),
    pushWarning: (w: string) => void warnings.push(w),
  };
  return {
    async open(file) {
      warnings.length = 0;
      const blank = await mintBlankDocument(editor, LETTER_PT, sinks);
      if (!blank) throw new Error(warnings.at(-1) ?? t(M.noDocument));
      const before = client.openDocument;
      const mark = client.editMark;
      await openFile(editor, file, sinks);
      // It opened (a new load) or it added to the blank (an edit).
      if (client.openDocument === before && client.editMark === mark) {
        throw new Error(warnings.at(-1) ?? t(M.noDocument));
      }
    },
    player: playerDeps(editor.registries.commands, client),
    exportAs: (format) => exportAs(editor, format),
    deliver:
      options.deliver ??
      ((name, bytes, format) => downloadBytes(bytes, name, MIME[format])),
    afterFile: () => client.markSaved(),
  };
}

export function BatchDialog() {
  const store = useScoped(OPEN);
  const open = useSyncExternalStore(store.subscribe, store.get, store.get);
  return open ? <BatchForm close={() => store.set(false)} /> : null;
}

function stageWord(stage: BatchLogEntry["stage"]): string {
  switch (stage) {
    case "open":
      return t(M.stageOpen);
    case "play":
      return t(M.stagePlay);
    case "export":
      return t(M.stageExport);
    default:
      return t(M.stageDeliver);
  }
}

function BatchForm({ close }: { close: () => void }) {
  const strings = useStrings();
  const editor = usePaged();
  const actions = useActions();
  const [actionId, setActionId] = useState<string>(
    () => actions.actions.at(-1)?.id ?? "",
  );
  const [files, setFiles] = useState<File[]>([]);
  const [format, setFormat] = useState<BatchFormat>("paged");
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [log, setLog] = useState<BatchLogEntry[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abort = useRef({ aborted: false });
  const filesRef = useRef<HTMLInputElement | null>(null);
  const folderRef = useRef<HTMLInputElement | null>(null);

  const action = actions.actions.find((a) => a.id === actionId) ?? null;
  const canRun = !running && action !== null && files.length > 0;

  const run = async () => {
    if (!action) return;
    if (!(await confirmDiscard(editor, t(M.opening)))) return;
    abort.current = { aborted: false };
    setRunning(true);
    setLog([]);
    setSummary(null);
    const result = await withImportHooksSuppressed(editor.scope, () =>
      runBatch(files, action, format, appBatchDeps(editor), {
        onProgress: setProgress,
        onLog: (entry) => setLog((prev) => [...prev, entry]),
        signal: abort.current,
      }),
    );
    setRunning(false);
    setSummary(
      result.cancelled
        ? t(M.cancelled, { count: result.log.length })
        : t(M.summary, { ok: result.succeeded, failed: result.failed }),
    );
  };

  const pick = (list: FileList | null) => {
    setFiles(
      [...(list ?? [])]
        .filter((f) => !f.name.startsWith("."))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  };

  return (
    <div
      data-batch-backdrop=""
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "grid",
        placeItems: "center",
        background: "rgba(0,0,0,0.5)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-title"
        data-batch-dialog=""
        data-panel-host=""
        style={{
          width: "min(440px, 92vw)",
          maxHeight: "86vh",
          overflowY: "auto",
          padding: 16,
          borderRadius: radius.lg,
          border: `1px solid ${color.border}`,
          background: color.elevated,
          color: color.fg,
          boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
        }}
      >
        <FocusScope trap autoFocus restoreFocus>
          <h2
            id="batch-title"
            style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600 }}
          >
            {strings.t(M.title)}
          </h2>
          <Row label={strings.t(M.action)}>
            {actions.actions.length === 0 ? (
              <span data-batch-no-actions="" style={{ color: color.mutedFg }}>
                {strings.t(M.noActions)}
              </span>
            ) : (
              <select
                aria-label={strings.t(M.action)}
                data-batch-action=""
                value={actionId}
                onChange={(e) => setActionId(e.target.value)}
                style={fieldStyle}
              >
                {actions.actions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
          </Row>
          <Row label={strings.t(M.files)}>
            <span className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-batch-choose-files=""
                disabled={running}
                onClick={() => filesRef.current?.click()}
                style={secondaryButton}
              >
                {strings.t(M.chooseFiles)}
              </button>
              <button
                type="button"
                data-batch-choose-folder=""
                disabled={running}
                onClick={() => folderRef.current?.click()}
                style={secondaryButton}
              >
                {strings.t(M.chooseFolder)}
              </button>
              <span data-batch-file-count="">
                {strings.t(M.fileCount, { count: files.length })}
              </span>
            </span>
            <input
              ref={filesRef}
              type="file"
              multiple
              hidden
              data-batch-files=""
              style={{ display: "none" }}
              onChange={(e) => {
                pick(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={(el) => {
                folderRef.current = el;
                el?.setAttribute("webkitdirectory", "");
              }}
              type="file"
              multiple
              hidden
              data-batch-folder=""
              style={{ display: "none" }}
              onChange={(e) => {
                pick(e.target.files);
                e.target.value = "";
              }}
            />
          </Row>
          <Row label={strings.t(M.saveAs)}>
            <select
              aria-label={strings.t(M.saveAs)}
              data-batch-format=""
              value={format}
              disabled={running}
              onChange={(e) => setFormat(e.target.value as BatchFormat)}
              style={fieldStyle}
            >
              {BATCH_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {strings.t(
                    f === "paged"
                      ? M.formatPaged
                      : f === "idml"
                        ? M.formatIdml
                        : M.formatPdf,
                  )}
                </option>
              ))}
            </select>
          </Row>
          <p
            className="text-[11px]"
            style={{ color: color.mutedFg, margin: "8px 0" }}
          >
            {strings.t(M.note)}
          </p>
          {progress && (
            <div data-batch-progress="" className="text-xs mb-1">
              {strings.t(M.progress, {
                done: progress.done,
                total: progress.total,
              })}
              {progress.current
                ? ` · ${strings.t(M.current, { name: progress.current })}`
                : ""}
            </div>
          )}
          {log.length > 0 && (
            <ul
              data-batch-log=""
              className="text-[11px] mb-2"
              style={{ listStyle: "none", padding: 0, margin: 0 }}
            >
              {log.map((e, i) => (
                <li
                  key={`${i}:${e.file}`}
                  data-batch-log-entry={e.ok ? "ok" : "failed"}
                  style={{ color: e.ok ? color.fg : "var(--status-error)" }}
                >
                  {e.ok
                    ? strings.t(M.ok, { file: e.file, output: e.output ?? "" })
                    : strings.t(M.failedAt, {
                        file: e.file,
                        stage: stageWord(e.stage),
                        error: e.error ?? "",
                      })}
                  {e.failedSteps > 0
                    ? ` — ${strings.t(M.stepsFailed, { count: e.failedSteps })}`
                    : ""}
                  {e.passedStops.map((m) => (
                    <div key={m} style={{ color: color.mutedFg }}>
                      {strings.t(M.passedStop, { message: m })}
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
          {summary && (
            <div data-batch-summary="" className="text-xs mb-2">
              {summary}
            </div>
          )}
          <div className="flex justify-end gap-2 mt-2">
            {running ? (
              <button
                type="button"
                data-batch-cancel=""
                onClick={() => {
                  abort.current.aborted = true;
                }}
                style={secondaryButton}
              >
                {strings.t(M.cancel)}
              </button>
            ) : (
              <button
                type="button"
                data-batch-close=""
                onClick={close}
                style={secondaryButton}
              >
                {strings.t(M.close)}
              </button>
            )}
            <button
              type="button"
              data-batch-run=""
              disabled={!canRun}
              onClick={() => void run()}
              style={{ ...buttonStyle, opacity: canRun ? 1 : 0.5 }}
            >
              {strings.t(M.run)}
            </button>
          </div>
        </FocusScope>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-xs mb-2">
      <span className="w-[72px] pt-1" style={{ color: "var(--pg-muted-fg)" }}>
        {label}
      </span>
      <span className="flex-1">{children}</span>
    </div>
  );
}

const fieldStyle: CSSProperties = {
  width: "100%",
  height: 26,
  borderRadius: 6,
  border: `1px solid ${color.border}`,
  background: "transparent",
  color: color.fg,
  fontSize: 12,
};

const buttonStyle: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 7,
  fontSize: 12,
  cursor: "pointer",
  border: `1px solid ${color.border}`,
  background: color.primary,
  color: color.primaryFg,
};

const secondaryButton: CSSProperties = {
  ...buttonStyle,
  padding: "4px 10px",
  background: "transparent",
  color: color.fg,
};
