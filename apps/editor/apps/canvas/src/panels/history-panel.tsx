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

// Editor ADR 285 — the History panel. Every step of the document's undo
// timeline by name (engine ADR 1017), oldest first, the current one marked;
// a click goes back (or forward) to the state right after that step in one
// engine round trip. While an edit context that keeps its own history is
// active (the image module's pixel journal), the panel lists THAT history
// instead, through the context's `historySteps`.
//
// Snapshots name a state of this session: restoring one is ONE new undo
// step (`restoreTo`), so a restore is itself undoable and the steps it went
// back over stay recoverable. When the editor keeps its document in the
// local library (ADR 180), a snapshot is also saved there as a version, so
// it outlives the session.

import { useState, useSyncExternalStore } from "react";

import {
  PanelToolbar,
  ToolbarBtn,
  currentLibraryDocument,
  editorStorage,
  getLibrary,
  useOptionalEditContextStack,
  usePaged,
  type PanelProps,
} from "@paged-media/shell";
import type { EditContextHistory } from "@paged-media/plugin-api";
import type { UndoLogEntryWire } from "@paged-media/client";
import { color, font, status } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";

import {
  HISTORY_DEPTHS,
  historyStoreOf,
  type HistorySnapshot,
} from "./history-store";

/** Where the depth preference is kept (the editor's storage adapter). */
export const HISTORY_DEPTH_KEY = "paged.history.depth";

const M = defineMessages("app.historyPanel", {
  noDocument: "No document loaded.",
  opened: "Opened document",
  openedEvicted: "Older steps were dropped (history depth)",
  contextOrigin: "Before the first step",
  contextTitle: "Steps of the edited item",
  newSnapshot: "New snapshot",
  snapshotName: "Snapshot {n}",
  snapshots: "Snapshots",
  restoreSnapshot: "Restore {name}",
  restoreLabel: "Restore {name}",
  deleteSnapshot: "Delete snapshot {name}",
  unreachable: "No longer in this session's history",
  current: "Current state",
  goTo: "Go back to the state after {label}",
  goForward: "Redo up to {label}",
  empty: "No steps yet. Every change appears here.",
  depth: "History depth",
  depthValue: "{count, plural, one {# step} other {# steps}}",
  shown: "Showing the newest {shown} of {total} steps",
});

// The engine's default labels, by the key it derived them from: the
// steps a user makes most often, translated; any other default shows the
// engine's English and a caller's own label shows as written.
const STEPS = defineMessages("app.historySteps", {
  move: "Move",
  resize: "Resize",
  rotate: "Rotate",
  scale: "Scale",
  shear: "Shear",
  duplicate: "Duplicate",
  editPath: "Edit path",
  moveContent: "Move content",
  rotateContent: "Rotate content",
  scaleContent: "Scale content",
  typing: "Typing",
  deleteText: "Delete text",
  delete: "Delete",
  insertTextFrame: "Insert text frame",
  insertFrame: "Insert frame",
  insertLine: "Insert line",
  insertPath: "Insert path",
  insertOval: "Insert oval",
  insertPage: "Insert page",
  deletePage: "Delete page",
  group: "Group",
  ungroup: "Ungroup",
  paste: "Paste",
  place: "Place",
  editImage: "Edit image",
  arrange: "Arrange",
  transform: "Transform",
  changeFill: "Change fill",
  changeStroke: "Change stroke",
  changeStrokeWeight: "Change stroke weight",
  changeOpacity: "Change opacity",
  rename: "Rename",
  multiple: "Multiple changes",
  script: "Run script",
  restore: "Restore",
});

const BY_KEY: Readonly<Record<string, string>> = {
  moveFrame: STEPS.move,
  resizeFrame: STEPS.resize,
  "gesture:translate": STEPS.move,
  "gesture:translateCopy": STEPS.duplicate,
  "gesture:resize": STEPS.resize,
  "gesture:rotate": STEPS.rotate,
  "gesture:scale": STEPS.scale,
  "gesture:shear": STEPS.shear,
  "gesture:pathEdit": STEPS.editPath,
  "gesture:translateContent": STEPS.moveContent,
  "gesture:rotateContent": STEPS.rotateContent,
  "gesture:scaleContent": STEPS.scaleContent,
  insertText: STEPS.typing,
  deleteRange: STEPS.deleteText,
  deleteFrame: STEPS.delete,
  insertTextFrame: STEPS.insertTextFrame,
  insertFrame: STEPS.insertFrame,
  insertLine: STEPS.insertLine,
  insertPath: STEPS.insertPath,
  insertOval: STEPS.insertOval,
  insertPage: STEPS.insertPage,
  deletePage: STEPS.deletePage,
  createGroup: STEPS.group,
  dissolveGroup: STEPS.ungroup,
  duplicateElements: STEPS.duplicate,
  pasteElements: STEPS.paste,
  placeImage: STEPS.place,
  replaceImageBytes: STEPS.editImage,
  reorderElement: STEPS.arrange,
  setGroupTransform: STEPS.transform,
  batch: STEPS.multiple,
  script: STEPS.script,
  restore: STEPS.restore,
};

// A property write's key is `set:<path>`; the panel translates it by the
// path's last segment (`frame.fillColor` and `fillColor` alike).
const BY_PROPERTY: Readonly<Record<string, string>> = {
  bounds: STEPS.resize,
  transform: STEPS.transform,
  fillColor: STEPS.changeFill,
  strokeColor: STEPS.changeStroke,
  strokeWeight: STEPS.changeStrokeWeight,
  opacity: STEPS.changeOpacity,
  name: STEPS.rename,
};

/** The words a step shows: its translated default, else its label. */
export function stepText(
  step: Pick<UndoLogEntryWire, "label" | "key">,
  t: (key: string) => string,
): string {
  const key = step.key ?? null;
  if (key === null) return step.label;
  const known = BY_KEY[key];
  if (known) return t(known);
  if (key.startsWith("set:")) {
    const prop = key.slice(4).split(".").at(-1) ?? "";
    const byProp = BY_PROPERTY[prop];
    if (byProp) return t(byProp);
  }
  return step.label;
}

type Snap = { key: string; value: EditContextHistory | null };
const contextSnaps = new WeakMap<object, Snap>();

/** The active context's history as a stable snapshot: the same object
 *  until its lists change (what `useSyncExternalStore` needs). */
function readContextHistory(
  owner: {
    historySteps?: () => EditContextHistory | null;
  } | null,
): EditContextHistory | null {
  if (!owner?.historySteps) return null;
  const value = owner.historySteps() ?? null;
  const key = value ? JSON.stringify([value.undo, value.redo]) : "null";
  const prev = contextSnaps.get(owner);
  if (prev && prev.key === key) return prev.value;
  contextSnaps.set(owner, { key, value });
  return value;
}

const noop = () => () => {};

export function HistoryPanel(_props: PanelProps) {
  const strings = useStrings();
  const editor = usePaged();
  const store = historyStoreOf(editor.client);
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const stack = useOptionalEditContextStack();
  const owner = stack?.activeContribution ?? null;
  const context = useSyncExternalStore(
    owner?.onDidChangeHistory
      ? (l: () => void) => owner.onDidChangeHistory!(l)
      : noop,
    () => readContextHistory(owner),
    () => readContextHistory(owner),
  );
  // The preference as stored; the editor applied it at boot
  // (`applyHistoryDepthPreference`), and the worker keeps it across loads.
  const [depthPref, setDepthPref] = useState<number | null>(() =>
    readDepthPref(editor.scope),
  );

  const log = state.log;
  if (!editor.document.handle && !context) {
    return (
      <div data-history-panel style={{ padding: 12, opacity: 0.5 }}>
        {strings.t(M.noDocument)}
      </div>
    );
  }

  const onNewSnapshot = () => {
    const name = strings.t(M.snapshotName, { n: state.snapshots.length + 1 });
    store.takeSnapshot(name);
    void keepInLibrary(editor, name);
  };

  const onDepth = (depth: number) => {
    setDepthPref(depth);
    writeDepthPref(editor.scope, depth);
    void store.setDepth(depth);
  };

  return (
    <div
      data-history-panel
      data-history-source={context ? "context" : "document"}
      style={{ display: "flex", flexDirection: "column", minHeight: 0 }}
    >
      <PanelToolbar>
        <ToolbarBtn
          icon="ui-plus"
          label={strings.t(M.newSnapshot)}
          testId="history-new-snapshot"
          onClick={context || !log ? undefined : onNewSnapshot}
        />
      </PanelToolbar>
      {context ? (
        <ContextSteps history={context} />
      ) : (
        <>
          {state.snapshots.length > 0 ? (
            <SnapshotList snapshots={state.snapshots} />
          ) : null}
          <DocumentSteps />
          <label
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              padding: "6px 12px",
              fontSize: 11,
              color: color.mutedFg,
            }}
          >
            {strings.t(M.depth)}
            <select
              data-history-depth
              aria-label={strings.t(M.depth)}
              value={String(depthPref ?? log?.depth ?? 10000)}
              onChange={(e) => onDepth(Number(e.currentTarget.value))}
            >
              {HISTORY_DEPTHS.map((d) => (
                <option key={d} value={String(d)}>
                  {strings.t(M.depthValue, { count: d })}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {state.error ? (
        <div
          data-history-error
          role="status"
          style={{ padding: "4px 12px", color: status.error, fontSize: 11 }}
        >
          {state.error}
        </div>
      ) : null}
    </div>
  );
}

const rowStyle = (state: "done" | "current" | "undone") => ({
  display: "block",
  width: "100%",
  textAlign: "left" as const,
  padding: "3px 12px",
  border: 0,
  background: state === "current" ? color.primarySoft : "transparent",
  color: state === "undone" ? color.mutedFg : color.fg,
  fontFamily: font.sans,
  fontSize: 12,
  fontWeight: state === "current" ? 600 : 400,
  cursor: state === "current" ? "default" : "pointer",
});

function DocumentSteps() {
  const strings = useStrings();
  const editor = usePaged();
  const store = historyStoreOf(editor.client);
  const { log } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  if (!log) return null;
  const t = (k: string) => strings.t(k);
  const listedAll = log.undo.length === log.undoLen;
  const originReachable = listedAll && log.evicted === 0;
  const atOrigin = log.undo.length === 0;
  if (log.undo.length === 0 && log.redo.length === 0) {
    return (
      <div
        data-history-empty
        style={{ padding: 12, fontSize: 12, color: color.mutedFg }}
      >
        {strings.t(M.empty)}
      </div>
    );
  }
  return (
    <div data-history-steps style={{ overflow: "auto" }}>
      {listedAll ? null : (
        <div
          style={{ padding: "3px 12px", fontSize: 11, color: color.mutedFg }}
        >
          {strings.t(M.shown, { shown: log.undo.length, total: log.undoLen })}
        </div>
      )}
      <button
        type="button"
        data-history-origin
        data-history-state={atOrigin ? "current" : "done"}
        aria-current={atOrigin ? "step" : undefined}
        disabled={atOrigin || !originReachable}
        title={originReachable ? undefined : strings.t(M.openedEvicted)}
        style={rowStyle(atOrigin ? "current" : "done")}
        onClick={() => void store.goToUndo(-1)}
      >
        {strings.t(originReachable ? M.opened : M.openedEvicted)}
      </button>
      {log.undo.map((step, i) => {
        const isCurrent = i === log.undo.length - 1;
        const text = stepText(step, t);
        return (
          <button
            key={step.appliedSeq}
            type="button"
            data-history-step
            data-history-seq={step.appliedSeq}
            data-history-state={isCurrent ? "current" : "done"}
            aria-current={isCurrent ? "step" : undefined}
            title={
              isCurrent
                ? strings.t(M.current)
                : strings.t(M.goTo, { label: text })
            }
            style={rowStyle(isCurrent ? "current" : "done")}
            onClick={isCurrent ? undefined : () => void store.goToUndo(i)}
          >
            {text}
          </button>
        );
      })}
      {log.redo.map((step, i) => {
        const text = stepText(step, t);
        return (
          <button
            key={step.appliedSeq}
            type="button"
            data-history-step
            data-history-seq={step.appliedSeq}
            data-history-state="undone"
            title={strings.t(M.goForward, { label: text })}
            style={rowStyle("undone")}
            onClick={() => void store.goToRedo(i)}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}

function SnapshotList({
  snapshots,
}: {
  snapshots: readonly HistorySnapshot[];
}) {
  const strings = useStrings();
  const editor = usePaged();
  const store = historyStoreOf(editor.client);
  // Read so the rows follow the timeline (reachability, the current one).
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return (
    <div data-history-snapshots style={{ paddingBottom: 4 }}>
      <div
        style={{
          padding: "4px 12px",
          fontSize: 11,
          textTransform: "uppercase",
          color: color.mutedFg,
        }}
      >
        {strings.t(M.snapshots)}
      </div>
      {snapshots.map((s) => {
        const here = store.isCurrent(s);
        const reachable = store.reachable(s);
        return (
          <div
            key={s.id}
            data-history-snapshot={s.id}
            style={{ display: "flex", alignItems: "center" }}
          >
            <button
              type="button"
              data-history-snapshot-restore
              aria-current={here ? "step" : undefined}
              disabled={here || !reachable}
              title={
                reachable
                  ? strings.t(M.restoreSnapshot, { name: s.name })
                  : strings.t(M.unreachable)
              }
              style={{ ...rowStyle(here ? "current" : "done"), flex: 1 }}
              onClick={() =>
                void store.restoreSnapshot(
                  s.id,
                  strings.t(M.restoreLabel, { name: s.name }),
                )
              }
            >
              {s.name}
            </button>
            <ToolbarBtn
              icon="ui-x"
              label={strings.t(M.deleteSnapshot, { name: s.name })}
              onClick={() => store.deleteSnapshot(s.id)}
            />
          </div>
        );
      })}
    </div>
  );
}

function ContextSteps({ history }: { history: EditContextHistory }) {
  const strings = useStrings();
  const n = history.undo.length;
  return (
    <div data-history-steps style={{ overflow: "auto" }}>
      <div style={{ padding: "4px 12px", fontSize: 11, color: color.mutedFg }}>
        {strings.t(M.contextTitle)}
      </div>
      <button
        type="button"
        data-history-origin
        data-history-state={n === 0 ? "current" : "done"}
        aria-current={n === 0 ? "step" : undefined}
        disabled={n === 0}
        style={rowStyle(n === 0 ? "current" : "done")}
        onClick={() => void history.step(-n)}
      >
        {strings.t(M.contextOrigin)}
      </button>
      {history.undo.map((label, i) => {
        const isCurrent = i === n - 1;
        return (
          <button
            key={`u${i}`}
            type="button"
            data-history-step
            data-history-state={isCurrent ? "current" : "done"}
            aria-current={isCurrent ? "step" : undefined}
            style={rowStyle(isCurrent ? "current" : "done")}
            onClick={
              isCurrent ? undefined : () => void history.step(-(n - 1 - i))
            }
          >
            {label}
          </button>
        );
      })}
      {history.redo.map((label, i) => (
        <button
          key={`r${i}`}
          type="button"
          data-history-step
          data-history-state="undone"
          style={rowStyle("undone")}
          onClick={() => void history.step(i + 1)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function readDepthPref(
  scope: Parameters<typeof editorStorage>[0],
): number | null {
  try {
    const raw = Number(editorStorage(scope).getItem(HISTORY_DEPTH_KEY));
    return Number.isInteger(raw) && raw >= 1 && raw <= 10000 ? raw : null;
  } catch {
    return null;
  }
}

function writeDepthPref(
  scope: Parameters<typeof editorStorage>[0],
  depth: number,
): void {
  try {
    editorStorage(scope).setItem(HISTORY_DEPTH_KEY, String(depth));
  } catch {
    /* storage refused: the depth still applies for this session */
  }
}

/** Editor ADR 285 — hand the stored history depth to the worker, which
 *  keeps it across document loads. The app calls it once when its client
 *  is up; nothing is sent while the preference is unset. */
export function applyHistoryDepthPreference(
  scope: Parameters<typeof editorStorage>[0],
  client: { setHistoryDepth(depth: number): Promise<number> },
): void {
  const depth = readDepthPref(scope);
  if (depth !== null) void client.setHistoryDepth(depth).catch(() => {});
}

/** ADR 180 — a snapshot is also a version in the local library, when the
 *  editor keeps this document there; never at the cost of the snapshot. */
async function keepInLibrary(
  editor: ReturnType<typeof usePaged>,
  name: string,
): Promise<void> {
  const library = getLibrary(editor.scope);
  const current = currentLibraryDocument(editor.scope);
  if (!library || !current) return;
  try {
    const bytes = await editor.client.exportPaged();
    await library.save(current.id, bytes, `Snapshot: ${name}`);
  } catch (err) {
    console.warn("History: the library did not keep the snapshot:", err);
  }
}
