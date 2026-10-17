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

// ADR 180 — the Library panel: the open document's versions, and every
// document in the local library. A document here is a repository; the file
// a user downloads is a projection of one of its versions.
//
// Nothing here rewinds. Restoring a version commits it again on top, so the
// version being replaced stays in the list; a release is a name given once
// to a version and never moved.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import {
  confirmDiscard,
  currentLibraryDocument,
  getLibrary,
  libraryVersion,
  loadDocumentFile,
  subscribeLibrary,
  usePaged,
} from "@paged-media/shell";
import type { CommitInfo, DocumentEntry } from "@paged-media/repository";

import { downloadBytes } from "../shell-file-saver";

const mono = { fontFamily: "var(--font-mono, monospace)", fontSize: 11 } as const;
const kicker = {
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--pg-muted-fg)",
  margin: "12px 0 6px",
} as const;
const button = {
  ...mono,
  cursor: "pointer",
  background: "transparent",
  color: "var(--pg-fg)",
  border: "1px solid var(--border, #2a2a2a)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "1px 6px",
} as const;

function when(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

export function LibraryPanel() {
  const editor = usePaged();
  const version = useSyncExternalStore(subscribeLibrary, libraryVersion, libraryVersion);
  const library = getLibrary();
  const current = currentLibraryDocument();
  const [docs, setDocs] = useState<DocumentEntry[]>([]);
  const [log, setLog] = useState<CommitInfo[]>([]);
  const [releases, setReleases] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  useEffect(() => {
    if (!library) return;
    let live = true;
    void (async () => {
      try {
        const list = await library.list();
        const history = current ? await library.log(current.id) : [];
        const refs = current ? await library.refs(current.id) : {};
        if (!live) return;
        setDocs(list);
        setLog(history);
        const named: Record<string, string> = {};
        for (const [ref, hash] of Object.entries(refs)) {
          if (ref.startsWith("releases/")) named[hash] = [named[hash], ref.slice(9)].filter(Boolean).join(", ");
        }
        setReleases(named);
        setError(null);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [library, current, version, tick]);

  const open = useCallback(
    async (entry: DocumentEntry, target = "main") => {
      if (!library) return;
      if (!(await confirmDiscard(editor, `Opening ${entry.name}`))) return;
      const bytes = await library.exportPaged(entry.id, target);
      const doc = editor.document;
      await loadDocumentFile(editor.client, new File([bytes.slice()], `${entry.name}.paged`), {
        setHandle: doc.setHandle,
        setSourceName: doc.setSourceName,
        setLoading: doc.setLoading,
        setStatus: (s) => console.info("[library]", s),
        setSnapshotsReady: doc.setSnapshotsReady,
        addSnapshot: (pageId, url) => doc.setSnapshots((prev) => new Map(prev).set(pageId, url)),
        resetForNewDocument: doc.resetForNewDocument,
        pushWarning: (w) => console.warn("[library]", w),
        libraryDocument: entry,
      });
    },
    [editor, library],
  );

  const act = (f: () => Promise<unknown>) => () => {
    f()
      .then(refresh)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  if (!library) {
    return (
      <div data-library-panel style={{ padding: 12, font: "12px var(--font-sans, sans-serif)", color: "var(--pg-muted-fg)" }}>
        The library needs the browser&apos;s private file system, which is not available here. Files still open and
        save as before.
      </div>
    );
  }

  return (
    <div data-library-panel style={{ padding: 12, font: "12px var(--font-sans, sans-serif)", color: "var(--pg-fg)" }}>
      <div style={{ ...kicker, marginTop: 0 }}>This document</div>
      {!current ? (
        <p data-library-unsaved style={{ margin: 0, color: "var(--pg-muted-fg)" }}>
          Not in the library yet. Save (Cmd+S) keeps it here, with every later save as a version.
        </p>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <strong>{current.name}</strong>
            <button
              type="button"
              data-library-export-history
              style={button}
              title="A .paged file that carries every version; opening it elsewhere brings them along"
              onClick={act(async () =>
                downloadBytes(
                  await library.exportPaged(current.id, "main", true),
                  `${current.name}.paged`,
                  "application/x-paged+zip",
                ),
              )}
            >
              Export with history
            </button>
          </div>
          <ul data-library-versions style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
            {log.map((c, i) => (
              <li
                key={c.hash}
                data-library-version={c.hash}
                style={{ padding: "4px 0", borderTop: "1px solid var(--border, #2a2a2a)" }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span>
                    {c.message}
                    {c.agent && <span style={{ ...mono, marginLeft: 6, color: "var(--status-warn)" }}>agent</span>}
                    {releases[c.hash] && (
                      <span style={{ ...mono, marginLeft: 6, color: "var(--status-ok, #6c6)" }}>
                        released {releases[c.hash]}
                      </span>
                    )}
                  </span>
                  <span style={{ ...mono, color: "var(--pg-muted-fg)" }}>{when(c.ts)}</span>
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 3, alignItems: "center" }}>
                  <span style={{ ...mono, color: "var(--pg-muted-fg)" }}>{c.hash.slice(0, 10)}</span>
                  {i > 0 && (
                    <button
                      type="button"
                      data-library-restore
                      style={button}
                      title="Make this version current again, as a new version; nothing is lost"
                      onClick={act(async () => {
                        await library.restore(current.id, c.hash);
                        await open(current);
                      })}
                    >
                      Restore
                    </button>
                  )}
                  <button
                    type="button"
                    data-library-download
                    style={button}
                    onClick={act(async () =>
                      downloadBytes(
                        await library.exportPaged(current.id, c.hash),
                        `${current.name}-${c.hash.slice(0, 8)}.paged`,
                        "application/x-paged+zip",
                      ),
                    )}
                  >
                    Download
                  </button>
                  <button
                    type="button"
                    data-library-release
                    style={button}
                    title="Name this version; a release never moves"
                    onClick={act(async () => {
                      const name = globalThis.prompt("Release name (it never moves once given):", "");
                      if (name?.trim()) await library.release(current.id, name.trim().replace(/\s+/g, "-"), c.hash);
                    })}
                  >
                    Release
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <div style={kicker}>Library</div>
      {docs.length === 0 ? (
        <p style={{ margin: 0, color: "var(--pg-muted-fg)" }}>No documents yet. Opening or saving a file adds it.</p>
      ) : (
        <ul data-library-documents style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {docs.map((d) => (
            <li
              key={d.id}
              data-library-document={d.id}
              style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "3px 0" }}
            >
              <span style={{ fontWeight: d.id === current?.id ? 600 : 400 }}>{d.name}</span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ ...mono, color: "var(--pg-muted-fg)" }}>{when(d.updatedAt)}</span>
                {d.id !== current?.id && (
                  <button type="button" data-library-open style={button} onClick={act(() => open(d))}>
                    Open
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p data-library-error style={{ ...mono, color: "var(--status-error)", marginTop: 8 }}>
          {error}
        </p>
      )}
    </div>
  );
}
