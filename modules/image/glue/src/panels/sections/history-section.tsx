// The image's HISTORY SNAPSHOTS and the History brush's source (image ADR
// 477), under the Layers section's step list: New snapshot, each snapshot
// with Restore (one undo step), Rename and Delete, the source the History
// and Art History brushes paint from (the opened state, the state before
// the last edit, any step, any snapshot), and History Options. PURE.

import { useState } from "react";

import { defineMessages, t } from "@paged-media/strings";
import { space } from "@paged-media/panel-kit";

import type { HistorySource } from "../../brush-dynamics";
import type { LayerHistory } from "../../engine";
import { note, row } from "./styles";

const M = defineMessages("image.historySection", {
  snapshots: "Snapshots",
  newSnapshot: "New snapshot",
  options: "History options…",
  none: "No snapshots. A snapshot keeps a state of the image for this session; restoring one is a single undo step.",
  restore: "Restore",
  restoreTitle: "Return to {name} (one undo step)",
  rename: "Rename",
  delete: "Delete",
  deleteTitle: "Delete the snapshot {name}",
  source: "History brush source",
  sourceOpen: "As opened",
  sourcePrevious: "Before the last edit",
  sourceStep: "After: {label}",
  sourceSnapshot: "Snapshot: {name}",
  memory: "Snapshots hold {mb} MB of their own.",
});

/** The History brush's choices for this history. */
export function historySourceChoices(
  history: LayerHistory | null,
): Array<{ value: HistorySource; label: string }> {
  const out: Array<{ value: HistorySource; label: string }> = [
    { value: "open", label: t(M.sourceOpen) },
    { value: "previous", label: t(M.sourcePrevious) },
  ];
  if (!history) return out;
  for (const s of history.snapshots)
    out.push({
      value: `snapshot:${s.id}`,
      label: t(M.sourceSnapshot, { name: s.name }),
    });
  history.undoSteps.forEach((label, i) => {
    const id = history.undoIds[i];
    if (id !== undefined)
      out.push({ value: `step:${id}`, label: t(M.sourceStep, { label }) });
  });
  history.redoSteps.forEach((label, i) => {
    const id = history.redoIds[i];
    if (id !== undefined)
      out.push({ value: `step:${id}`, label: t(M.sourceStep, { label }) });
  });
  return out;
}

export function HistorySection({
  history,
  source,
  disabled,
  onSnapshot,
  onRestore,
  onRename,
  onDelete,
  onSource,
  onOptions,
}: {
  history: LayerHistory | null;
  source: HistorySource;
  disabled: boolean;
  onSnapshot: () => void;
  onRestore: (id: number) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
  onSource: (source: HistorySource) => void;
  onOptions: () => void;
}) {
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(
    null,
  );
  const snaps = history?.snapshots ?? [];
  const choices = historySourceChoices(history);
  // A source that no longer names a held step reads as "As opened",
  // which is what the engine falls back to as well.
  const shown = choices.some((c) => c.value === source) ? source : "open";
  return (
    <div data-image-history-snapshots>
      <div style={{ ...row, borderBottom: "none" }}>
        <strong style={{ fontSize: 11 }}>{t(M.snapshots)}</strong>
        <span style={{ display: "flex", gap: space[1] }}>
          <button
            type="button"
            data-image-snapshot-new
            disabled={disabled || !history}
            onClick={onSnapshot}
          >
            {t(M.newSnapshot)}
          </button>
          <button
            type="button"
            data-image-history-options-open
            onClick={onOptions}
          >
            {t(M.options)}
          </button>
        </span>
      </div>
      {snaps.length === 0 ? (
        <div style={note}>{t(M.none)}</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {snaps.map((s) => (
            <li
              key={s.id}
              data-image-snapshot={s.id}
              style={{ ...row, gap: space[1] }}
            >
              {editing?.id === s.id ? (
                <input
                  type="text"
                  autoFocus
                  data-image-snapshot-name-input={s.id}
                  aria-label={t(M.rename)}
                  value={editing.name}
                  onChange={(e) =>
                    setEditing({ id: s.id, name: e.target.value })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      onRename(s.id, editing.name);
                      setEditing(null);
                    } else if (e.key === "Escape") setEditing(null);
                  }}
                  onBlur={() => {
                    onRename(s.id, editing.name);
                    setEditing(null);
                  }}
                  style={{ flex: 1, minWidth: 0 }}
                />
              ) : (
                <span style={{ flex: 1, minWidth: 0 }} data-image-snapshot-name>
                  {s.name}
                </span>
              )}
              <button
                type="button"
                data-image-snapshot-restore={s.id}
                title={t(M.restoreTitle, { name: s.name })}
                disabled={disabled}
                onClick={() => onRestore(s.id)}
              >
                {t(M.restore)}
              </button>
              <button
                type="button"
                data-image-snapshot-rename={s.id}
                onClick={() => setEditing({ id: s.id, name: s.name })}
              >
                {t(M.rename)}
              </button>
              <button
                type="button"
                data-image-snapshot-delete={s.id}
                title={t(M.deleteTitle, { name: s.name })}
                onClick={() => onDelete(s.id)}
              >
                {t(M.delete)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {history && history.snapshotBytes > 0 ? (
        <div style={note}>
          {t(M.memory, {
            mb: (history.snapshotBytes / (1024 * 1024)).toFixed(1),
          })}
        </div>
      ) : null}
      <label style={row}>
        {t(M.source)}
        <select
          data-image-history-source
          value={shown}
          disabled={disabled}
          onChange={(e) => onSource(e.target.value as HistorySource)}
          style={{ maxWidth: "60%" }}
        >
          {choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
