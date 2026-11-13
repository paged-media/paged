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

// The header's save status (editor ADR 1203; UX audit F-07; interaction
// spec UXI-INV-010, UXI-FIL-003, D-10 of ADR 1201). One label that says
// what a save really did — "Saved locally · Not synced", never "Saved"
// when the file was not written — and a popover that says where, when and
// why, with Retry when a save failed or missed its target.
//
// `data-save-state` carries the machine's state (`new`, `editing`, …,
// `recovered`): the suite and scripts read it.

import type {
  SaveDestination,
  SaveFailureCode,
  SaveNote,
  SaveState,
} from "@paged-media/repository";
import { useStrings, type Strings } from "@paged-media/strings";

import { Button } from "../components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { useDocument } from "../state/document-context";
import { useEditorScope } from "../state/editor-scope";
import { documentSaver } from "../state/replace-guard";
import { useSaveState } from "../state/save-status";
import { useCompactLayout } from "../state/compact";
import { SAVE_STATUS } from "./messages";

type Tone = "quiet" | "pending" | "local" | "saved" | "warn" | "error";

const DOT: Record<Tone, string> = {
  quiet: "var(--status-draft)",
  pending: "var(--status-review)",
  local: "var(--status-info)",
  saved: "var(--status-approved)",
  warn: "var(--status-review)",
  error: "var(--status-error)",
};

/** The label and tone of a state. */
export function saveStatusLabel(
  state: SaveState,
  strings: Strings,
): { label: string; tone: Tone } {
  const t = strings.t;
  switch (state.kind) {
    case "new":
      return state.document?.origin.kind === "opened"
        ? { label: t(SAVE_STATUS.noChanges), tone: "quiet" }
        : { label: t(SAVE_STATUS.notSavedYet), tone: "quiet" };
    case "editing":
      return { label: t(SAVE_STATUS.editing), tone: "pending" };
    case "saving":
      return { label: t(SAVE_STATUS.saving), tone: "pending" };
    case "syncing":
      return (state.running?.where.length ?? 0) > 0
        ? { label: t(SAVE_STATUS.syncing), tone: "pending" }
        : { label: t(SAVE_STATUS.saving), tone: "pending" };
    case "saved-local":
      return state.saved?.where.some((d) => d.kind === "library")
        ? { label: t(SAVE_STATUS.savedLocally), tone: "local" }
        : { label: t(SAVE_STATUS.downloaded), tone: "local" };
    case "synced":
      return { label: t(SAVE_STATUS.synced), tone: "saved" };
    case "not-synced":
      return { label: t(SAVE_STATUS.notSynced), tone: "warn" };
    case "failed":
      return { label: t(SAVE_STATUS.failed), tone: "error" };
    case "read-only":
      return { label: t(SAVE_STATUS.readOnly), tone: "quiet" };
    case "recovered":
      return { label: t(SAVE_STATUS.recovered), tone: "warn" };
  }
}

const REASON: Record<SaveFailureCode, keyof typeof SAVE_STATUS> = {
  "permission-denied": "permissionDenied",
  "file-missing": "fileMissing",
  "write-failed": "writeFailed",
  "export-failed": "exportFailed",
  "host-refused": "hostRefused",
  "remote-failed": "remoteFailed",
  unknown: "unknown",
};

function where(d: SaveDestination, strings: Strings): string {
  switch (d.kind) {
    case "library":
      return strings.t(SAVE_STATUS.inLibrary);
    case "file":
      return strings.t(SAVE_STATUS.inFile, { name: d.name });
    case "download":
      return strings.t(SAVE_STATUS.asDownload, { name: d.name });
    case "host":
      return strings.t(SAVE_STATUS.toHost);
    case "remote":
      return strings.t(SAVE_STATUS.onServer, { repo: d.repo });
  }
}

function targetName(d: SaveDestination | null, strings: Strings): string {
  if (!d) return strings.t(SAVE_STATUS.theFile);
  switch (d.kind) {
    case "file":
    case "download":
      return d.name;
    case "host":
      return strings.t(SAVE_STATUS.theHost);
    case "remote":
      return strings.t(SAVE_STATUS.theServer);
    case "library":
      return strings.t(SAVE_STATUS.inLibrary);
  }
}

function note(n: SaveNote, strings: Strings): string {
  return n.kind === "library-failed"
    ? strings.t(SAVE_STATUS.libraryFailed)
    : strings.t(SAVE_STATUS.notPrepared, { plugin: n.plugin });
}

/** Retry runs the save the replace question's Save runs (the app's Cmd+S):
 *  the whole save again, which re-commits nothing that did not change and
 *  writes the file again. */
function retrySave(scope: ReturnType<typeof useEditorScope>): void {
  const save = documentSaver(scope);
  if (save) void Promise.resolve(save()).catch(() => undefined);
}

export function SaveStatus() {
  const strings = useStrings();
  const scope = useEditorScope();
  const state = useSaveState();
  const { handle } = useDocument();
  const compact = useCompactLayout() !== null;
  if (!handle && state.kind !== "read-only") return null;
  const { label, tone } = saveStatusLabel(state, strings);
  const time = (at: number) =>
    new Date(at).toLocaleTimeString(strings.locale, {
      hour: "2-digit",
      minute: "2-digit",
    });
  const problem =
    state.failure ?? (state.kind === "not-synced" ? state.missed : null);
  const reason = problem ? strings.t(SAVE_STATUS[REASON[problem.code]]) : "";
  const canRetry = state.kind === "failed" || state.kind === "not-synced";
  const origin = state.document?.origin ?? null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-save-status
          data-save-state={state.kind}
          aria-label={label}
          title={label}
          style={triggerStyle}
        >
          <span aria-hidden style={{ ...dotStyle, background: DOT[tone] }} />
          {!compact && <span style={labelStyle}>{label}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        data-save-status-details
        aria-label={strings.t(SAVE_STATUS.detailsTitle)}
        style={{ fontSize: 12, lineHeight: 1.45 }}
      >
        <p style={{ fontWeight: 600, margin: "0 0 6px" }}>{label}</p>
        {state.kind === "new" && origin?.kind === "opened" && (
          <p style={lineStyle}>
            {strings.t(SAVE_STATUS.openedFrom, {
              name: origin.name,
              time: time(state.document!.openedAt),
            })}
          </p>
        )}
        {state.kind === "new" && origin?.kind !== "opened" && (
          <p style={lineStyle}>{strings.t(SAVE_STATUS.blank)}</p>
        )}
        {state.kind === "editing" && (
          <p style={lineStyle}>
            {strings.t(SAVE_STATUS.editingSince, {
              time: time(state.saved?.at ?? state.document?.openedAt ?? 0),
            })}
          </p>
        )}
        {state.kind === "saving" && (
          <p style={lineStyle}>{strings.t(SAVE_STATUS.savingNow)}</p>
        )}
        {state.kind === "syncing" && (
          <p style={lineStyle}>
            {strings.t(SAVE_STATUS.syncingTo, {
              target: targetName(state.running?.syncing ?? null, strings),
            })}
          </p>
        )}
        {state.kind === "read-only" && (
          <p style={lineStyle}>{strings.t(SAVE_STATUS.readOnlyBecause)}</p>
        )}
        {state.kind === "recovered" && origin?.kind === "recovered" && (
          <p style={lineStyle}>
            {strings.t(SAVE_STATUS.recoveredFrom, {
              time: time(origin.checkpointAt),
            })}
          </p>
        )}
        {state.kind === "failed" && problem && (
          <p style={lineStyle} data-save-status-reason={problem.code}>
            {strings.t(SAVE_STATUS.failedBecause, { reason })}
          </p>
        )}
        {state.kind === "not-synced" && problem && (
          <p style={lineStyle} data-save-status-reason={problem.code}>
            {strings.t(SAVE_STATUS.notSyncedBecause, {
              target: targetName(problem.target, strings),
              reason,
            })}
          </p>
        )}
        {state.saved && state.kind !== "editing" && (
          <>
            <p style={lineStyle}>
              {strings.t(SAVE_STATUS.savedAt, { time: time(state.saved.at) })}
            </p>
            <ul data-save-status-where style={listStyle}>
              {state.saved.where.map((d, i) => (
                <li key={i} data-save-destination={d.kind}>
                  {where(d, strings)}
                </li>
              ))}
            </ul>
            {state.saved.notes.map((n, i) => (
              <p key={i} style={lineStyle}>
                {note(n, strings)}
              </p>
            ))}
          </>
        )}
        {state.checkpointAt !== null && state.kind === "editing" && (
          <p style={{ ...lineStyle, color: "var(--pg-muted-fg)" }}>
            {strings.t(SAVE_STATUS.checkpoint, {
              time: time(state.checkpointAt),
            })}
          </p>
        )}
        {problem?.detail && (
          <details style={{ marginTop: 6, color: "var(--pg-muted-fg)" }}>
            <summary>{strings.t(SAVE_STATUS.details)}</summary>
            <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
              {problem.detail}
            </code>
          </details>
        )}
        {canRetry && (
          <Button
            type="button"
            size="sm"
            data-save-retry
            style={{ marginTop: 8 }}
            onClick={() => retrySave(scope)}
          >
            {strings.t(SAVE_STATUS.retry)}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

const triggerStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
  maxWidth: 210,
  height: 24,
  padding: "0 6px",
  border: "none",
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--pg-muted-fg)",
  fontSize: 12,
  cursor: "pointer",
  flexShrink: 1,
};

const dotStyle: React.CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: "50%",
  flexShrink: 0,
};

const labelStyle: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const lineStyle: React.CSSProperties = { margin: "0 0 4px" };

const listStyle: React.CSSProperties = {
  margin: "0 0 4px",
  paddingLeft: 16,
  listStyle: "disc",
};
