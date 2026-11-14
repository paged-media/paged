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

// File ▸ Open recent… (UX audit F-06; editor ADR 1224): the documents of
// the local library and the files opened lately, newest first, each opened
// by the path its kind takes (the library's, or File ▸ Open's with the
// file's handle kept for Save). The replace question asks first when the
// open document has unsaved edits (ADR 230).

import { useEffect, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";

import {
  createValueStore,
  FocusScope,
  operationFeedbackOf,
  scoped,
  useEditorScope,
  useEscapeHandler,
  usePaged,
  useScoped,
  type EditorScope,
} from "@paged-media/shell";
import { color, radius } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";

import { useEditorInstance } from "../app/instance";
import {
  openRecent,
  recentDocuments,
  type RecentDocument,
} from "../session-continuity";

const M = defineMessages("app.openRecentDialog", {
  title: "Open recent",
  library: "Library",
  file: "File",
  empty: "No recent documents yet. Documents you open or save appear here.",
  loading: "Reading the library…",
  cancel: "Cancel",
  open: "open {name}",
});

const OPEN = scoped("openRecentDialog", () => createValueStore(false));

/** Whether `scope`'s Open recent dialog is showing. */
export function isOpenRecentDialogOpen(scope: EditorScope): boolean {
  return scope.get(OPEN).get();
}

/** Show `scope`'s Open recent dialog (the command's handler). */
export function openRecentDialog(scope: EditorScope): void {
  scope.get(OPEN).set(true);
}

export function OpenRecentDialog() {
  const store = useScoped(OPEN);
  const open = useSyncExternalStore(store.subscribe, store.get, store.get);
  return open ? <OpenRecentList /> : null;
}

function OpenRecentList() {
  const strings = useStrings();
  const scope = useEditorScope();
  const paged = usePaged();
  const instance = useEditorInstance();
  const store = useScoped(OPEN);
  const [rows, setRows] = useState<RecentDocument[] | null>(null);
  const close = () => store.set(false);
  useEscapeHandler({
    id: "paged.openRecentDialog",
    tier: "modal",
    isActive: () => true,
    resolve: () => close(),
  });
  useEffect(() => {
    let live = true;
    void recentDocuments(scope, instance.services.documentIdentity).then(
      (r) => {
        if (live) setRows(r);
      },
    );
    return () => {
      live = false;
    };
  }, [scope, instance]);
  const choose = (row: RecentDocument) => {
    close();
    const feedback = operationFeedbackOf(scope);
    void openRecent(paged, row, {
      setStatus: () => {},
      pushWarning: (w) =>
        feedback.report({
          action: strings.t(M.open, { name: row.name }),
          outcome: "recoverable-failure",
          title: w,
          document: "unchanged",
          source: "paged.recent",
        }),
    });
  };
  const time = (at: number) =>
    at > 0
      ? new Date(at).toLocaleString(strings.locale, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "";
  return (
    <div
      data-open-recent-backdrop=""
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      style={backdropStyle}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-recent-title"
        data-open-recent-dialog=""
        style={dialogStyle}
      >
        <FocusScope trap autoFocus restoreFocus>
          <h2 id="open-recent-title" style={titleStyle}>
            {strings.t(M.title)}
          </h2>
          {rows === null ? (
            <p style={mutedStyle}>{strings.t(M.loading)}</p>
          ) : rows.length === 0 ? (
            <p data-open-recent-empty="" style={mutedStyle}>
              {strings.t(M.empty)}
            </p>
          ) : (
            <ul style={listStyle}>
              {rows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    data-open-recent-row={row.id}
                    data-open-recent-kind={row.kind}
                    onClick={() => choose(row)}
                    style={rowStyle}
                  >
                    <span style={{ flex: 1, minWidth: 0 }}>{row.name}</span>
                    <span style={mutedStyle}>
                      {strings.t(row.kind === "library" ? M.library : M.file)}
                      {row.at > 0 ? ` · ${time(row.at)}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              data-open-recent-cancel=""
              onClick={close}
              style={buttonStyle}
            >
              {strings.t(M.cancel)}
            </button>
          </div>
        </FocusScope>
      </div>
    </div>
  );
}

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  display: "grid",
  placeItems: "center",
  background: "rgba(0,0,0,0.5)",
};

const dialogStyle: CSSProperties = {
  width: "min(440px, 92vw)",
  padding: 16,
  borderRadius: radius.lg,
  border: `1px solid ${color.border}`,
  background: color.elevated,
  color: color.fg,
  boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
  fontSize: 12,
};

const titleStyle: CSSProperties = {
  margin: "0 0 12px",
  fontSize: 14,
  fontWeight: 600,
};

const mutedStyle: CSSProperties = { color: color.mutedFg, fontSize: 11 };

const listStyle: CSSProperties = {
  listStyle: "none",
  margin: "0 0 12px",
  padding: 0,
  maxHeight: 320,
  overflowY: "auto",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 8,
  width: "100%",
  padding: "6px 8px",
  border: "none",
  borderRadius: radius.sm,
  background: "transparent",
  color: color.fg,
  font: "inherit",
  fontSize: 12,
  textAlign: "left",
  cursor: "pointer",
};

const buttonStyle: CSSProperties = {
  padding: "4px 12px",
  borderRadius: radius.sm,
  border: `1px solid ${color.border}`,
  background: color.bg,
  color: color.fg,
  fontSize: 12,
  cursor: "pointer",
};
