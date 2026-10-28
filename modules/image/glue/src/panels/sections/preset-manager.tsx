// Edit ▸ Presets ▸ Preset Manager… and History Options… (image ADR 477):
// the dialogs that sit on top of the Image panel. The Preset Manager is
// ONE dialog for every preset kind (brushes, tool presets, adjustments,
// gradients, patterns, layer styles): it lists them, renames, deletes and
// reorders them, applies one, saves the current settings as a new one,
// and imports or exports a kind's file. PURE: props in, callbacks out.

import { useState } from "react";

import { defineMessages, t } from "@paged-media/strings";
import { color, space } from "@paged-media/panel-kit";

import {
  PRESET_KINDS,
  type PresetEntry,
  type PresetKind,
} from "../../preset-library";
import {
  HISTORY_DEPTH_RANGE,
  HISTORY_MEMORY_RANGE,
  type HistoryPrefs,
} from "../../preset-store";
import { note, row } from "./styles";

const M = defineMessages("image.presetManagerDialog", {
  title: "Preset manager",
  kind: "Preset type",
  brushes: "Brushes",
  tools: "Tool presets",
  adjustments: "Adjustments",
  gradients: "Gradients",
  patterns: "Patterns",
  styles: "Styles",
  empty: "No presets of this type yet.",
  apply: "Apply",
  applyTitle: "Apply {name}",
  rename: "Rename",
  renameTitle: "Rename {name}",
  delete: "Delete",
  deleteTitle: "Delete {name}",
  builtIn: "Built in: it can be renamed and moved, not deleted.",
  up: "Move up",
  down: "Move down",
  saveCurrent: "Save current",
  newName: "Name of the new preset",
  import: "Import…",
  export: "Export…",
  done: "Done",
  formats: "Files: {formats}",
  stored: "Presets are kept for your next session in this browser.",
  saveBrushes: "Define from the selection",
  saveTools: "From the current brush and tool options",
  saveAdjustments: "From the adjustment sliders",
  saveGradients: "Foreground to background",
  savePatterns: "From the defined pattern",
  saveStyles: "From the active layer's style",
});

const H = defineMessages("image.historyOptionsDialog", {
  title: "History options",
  depth: "History states",
  depthNote:
    "Undo steps kept, {min} to {max}. A smaller number drops the oldest steps now.",
  memory: "History memory (MB)",
  memoryNote:
    "The most the undo history may hold, {min} to {max} MB; the oldest steps go first when it is full.",
  autoSnapshot: "Automatically create first snapshot",
  used: "In use: {history} of history, {snapshots} in snapshots.",
  ok: "OK",
  cancel: "Cancel",
});

const KIND_LABEL: Record<PresetKind, string> = {
  brushes: M.brushes,
  tools: M.tools,
  adjustments: M.adjustments,
  gradients: M.gradients,
  patterns: M.patterns,
  styles: M.styles,
};

const SAVE_LABEL: Record<PresetKind, string> = {
  brushes: M.saveBrushes,
  tools: M.saveTools,
  adjustments: M.saveAdjustments,
  gradients: M.saveGradients,
  patterns: M.savePatterns,
  styles: M.saveStyles,
};

const FORMATS: Record<PresetKind, string> = {
  brushes: ".abr, .json",
  tools: ".json",
  adjustments: ".json",
  gradients: ".grd",
  patterns: ".pat",
  styles: ".asl",
};

const dialogStyle = {
  border: `1px solid ${color.border}`,
  borderRadius: 4,
  padding: space[2],
  margin: `${space[2]} 0`,
} as const;

const titleStyle = { fontWeight: 600, marginBottom: space[1] } as const;

/** A row's detail (a pattern's size, a gradient's swatch). */
export interface PresetRowDetail {
  id: string;
  detail?: string;
  /** A CSS background for the swatch (a gradient), when there is one. */
  swatch?: string;
}

export function PresetManagerDialog({
  tab,
  entries,
  details,
  busy,
  onTab,
  onApply,
  onRename,
  onDelete,
  onMove,
  onSave,
  onImport,
  onExport,
  onClose,
}: {
  tab: PresetKind;
  entries: readonly PresetEntry[];
  details?: readonly PresetRowDetail[];
  busy: boolean;
  onTab: (tab: PresetKind) => void;
  onApply: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onMove: (from: number, to: number) => void;
  onSave: (name: string) => void;
  onImport: () => void;
  onExport: () => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [newName, setNewName] = useState("");
  const detailOf = (id: string) => details?.find((d) => d.id === id);
  return (
    <section
      role="dialog"
      aria-label={t(M.title)}
      data-image-preset-manager={tab}
      style={dialogStyle}
    >
      <div style={titleStyle}>{t(M.title)}</div>
      <div
        role="tablist"
        aria-label={t(M.kind)}
        style={{ display: "flex", flexWrap: "wrap", gap: space[1] }}
      >
        {PRESET_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={k === tab}
            data-preset-tab={k}
            style={{ fontWeight: k === tab ? 600 : 400 }}
            onClick={() => onTab(k)}
          >
            {t(KIND_LABEL[k])}
          </button>
        ))}
      </div>
      <ul
        data-preset-list={tab}
        style={{
          listStyle: "none",
          margin: `${space[2]} 0`,
          padding: 0,
          maxHeight: 280,
          overflow: "auto",
        }}
      >
        {entries.length === 0 ? (
          <li style={note} data-preset-empty>
            {t(M.empty)}
          </li>
        ) : null}
        {entries.map((p, i) => {
          const d = detailOf(p.id);
          return (
            <li
              key={p.id}
              data-preset-row={p.id}
              style={{ ...row, gap: space[1] }}
            >
              {d?.swatch ? (
                <span
                  aria-hidden
                  style={{
                    width: 28,
                    height: 12,
                    borderRadius: 2,
                    background: d.swatch,
                    border: `1px solid ${color.border}`,
                  }}
                />
              ) : null}
              {editing?.id === p.id ? (
                <input
                  type="text"
                  autoFocus
                  aria-label={t(M.renameTitle, { name: p.name })}
                  data-preset-rename-input={p.id}
                  value={editing.name}
                  onChange={(e) =>
                    setEditing({ id: p.id, name: e.target.value })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      onRename(p.id, editing.name);
                      setEditing(null);
                    } else if (e.key === "Escape") setEditing(null);
                  }}
                  onBlur={() => {
                    onRename(p.id, editing.name);
                    setEditing(null);
                  }}
                  style={{ flex: 1, minWidth: 0 }}
                />
              ) : (
                <span
                  style={{ flex: 1, minWidth: 0 }}
                  title={p.builtIn ? t(M.builtIn) : undefined}
                  data-preset-name={p.id}
                >
                  {p.name}
                  {d?.detail ? (
                    <span style={{ ...note, marginLeft: space[1] }}>
                      {d.detail}
                    </span>
                  ) : null}
                </span>
              )}
              <button
                type="button"
                data-preset-apply={p.id}
                title={t(M.applyTitle, { name: p.name })}
                disabled={busy}
                onClick={() => onApply(p.id)}
              >
                {t(M.apply)}
              </button>
              <button
                type="button"
                data-preset-rename={p.id}
                title={t(M.renameTitle, { name: p.name })}
                onClick={() => setEditing({ id: p.id, name: p.name })}
              >
                {t(M.rename)}
              </button>
              <button
                type="button"
                data-preset-up={p.id}
                aria-label={t(M.up)}
                disabled={i === 0}
                onClick={() => onMove(i, i - 1)}
              >
                ↑
              </button>
              <button
                type="button"
                data-preset-down={p.id}
                aria-label={t(M.down)}
                disabled={i === entries.length - 1}
                onClick={() => onMove(i, i + 1)}
              >
                ↓
              </button>
              <button
                type="button"
                data-preset-delete={p.id}
                title={
                  p.builtIn ? t(M.builtIn) : t(M.deleteTitle, { name: p.name })
                }
                disabled={p.builtIn === true}
                onClick={() => onDelete(p.id)}
              >
                {t(M.delete)}
              </button>
            </li>
          );
        })}
      </ul>
      <div style={{ ...row, borderBottom: "none" }}>
        <input
          type="text"
          aria-label={t(M.newName)}
          placeholder={t(SAVE_LABEL[tab])}
          data-preset-new-name
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button
          type="button"
          data-preset-save={tab}
          title={t(SAVE_LABEL[tab])}
          disabled={busy}
          onClick={() => {
            onSave(newName);
            setNewName("");
          }}
        >
          {t(M.saveCurrent)}
        </button>
      </div>
      <div style={{ ...row, borderBottom: "none", justifyContent: "flex-end" }}>
        <button type="button" data-preset-import={tab} onClick={onImport}>
          {t(M.import)}
        </button>
        <button
          type="button"
          data-preset-export={tab}
          disabled={entries.length === 0}
          onClick={onExport}
        >
          {t(M.export)}
        </button>
        <button type="button" data-dialog-cancel onClick={onClose}>
          {t(M.done)}
        </button>
      </div>
      <div style={note}>
        {t(M.formats, { formats: FORMATS[tab] })} {t(M.stored)}
      </div>
    </section>
  );
}

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function HistoryOptionsDialog({
  prefs,
  usedBytes,
  snapshotBytes,
  onApply,
  onCancel,
}: {
  prefs: HistoryPrefs;
  usedBytes: number;
  snapshotBytes: number;
  onApply: (p: HistoryPrefs) => void;
  onCancel: () => void;
}) {
  const [depth, setDepth] = useState(prefs.depth);
  const [memoryMb, setMemoryMb] = useState(prefs.memoryMb);
  const [autoSnapshot, setAutoSnapshot] = useState(prefs.autoSnapshot);
  return (
    <section
      role="dialog"
      aria-label={t(H.title)}
      data-image-history-options
      style={dialogStyle}
    >
      <div style={titleStyle}>{t(H.title)}</div>
      <label style={row}>
        {t(H.depth)}
        <input
          type="number"
          data-history-depth-input
          min={HISTORY_DEPTH_RANGE[0]}
          max={HISTORY_DEPTH_RANGE[1]}
          value={depth}
          onChange={(e) => setDepth(Number(e.target.value))}
          style={{ width: 80 }}
        />
      </label>
      <div style={note}>
        {t(H.depthNote, {
          min: HISTORY_DEPTH_RANGE[0],
          max: HISTORY_DEPTH_RANGE[1],
        })}
      </div>
      <label style={row}>
        {t(H.memory)}
        <input
          type="number"
          data-history-memory-input
          min={HISTORY_MEMORY_RANGE[0]}
          max={HISTORY_MEMORY_RANGE[1]}
          value={memoryMb}
          onChange={(e) => setMemoryMb(Number(e.target.value))}
          style={{ width: 80 }}
        />
      </label>
      <div style={note}>
        {t(H.memoryNote, {
          min: HISTORY_MEMORY_RANGE[0],
          max: HISTORY_MEMORY_RANGE[1],
        })}
      </div>
      <label style={{ ...row, justifyContent: "flex-start" }}>
        <input
          type="checkbox"
          data-history-auto-snapshot
          checked={autoSnapshot}
          onChange={(e) => setAutoSnapshot(e.target.checked)}
        />
        {t(H.autoSnapshot)}
      </label>
      <div style={note} data-history-memory-used>
        {t(H.used, { history: mb(usedBytes), snapshots: mb(snapshotBytes) })}
      </div>
      <div style={{ ...row, borderBottom: "none", justifyContent: "flex-end" }}>
        <button type="button" data-dialog-cancel onClick={onCancel}>
          {t(H.cancel)}
        </button>
        <button
          type="button"
          data-history-options-apply
          onClick={() => onApply({ depth, memoryMb, autoSnapshot })}
        >
          {t(H.ok)}
        </button>
      </div>
    </section>
  );
}
