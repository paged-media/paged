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

import {
  ViewTransition,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  FADE,
  confirmDiscard,
  currentLibraryDocument,
  getLibrary,
  libraryVersion,
  loadDocumentFile,
  subscribeLibrary,
  transitionWith,
  usePaged,
} from "@paged-media/shell";
import {
  accessToken,
  signedInAs,
  signIn,
  signOut,
} from "@paged-media/repository";
import type { CommitInfo, DocumentEntry } from "@paged-media/repository";

import {
  connect as connectLive,
  disconnect as disconnectLive,
  live,
} from "../live-bridge";
import { downloadBytes } from "../shell-file-saver";
import { color, font, radius, status } from "@paged-media/panel-kit";

const mono = {
  fontFamily: font.mono,
  fontSize: 11,
} as const;
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
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  padding: "1px 6px",
} as const;

// ADR 225 — the paged.server this build syncs with (`PAGED_SERVER_URL` at build
// time, which also admits it through the network wall). Empty: no server, and
// the panel shows no server controls.
declare const __PAGED_SERVER__: string | undefined;
const SERVER = typeof __PAGED_SERVER__ === "undefined" ? "" : __PAGED_SERVER__;

/** The server repository a document syncs with: its own, or one named after it. */
function remoteRepo(d: DocumentEntry): string {
  if (d.remote?.repo) return d.remote.repo;
  const slug = d.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${slug || "document"}-${d.id
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 8)
    .toLowerCase()}`;
}

function when(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
}

// The library and the open document, as one snapshot per library version:
// the store hands the render the values, not only the version beside them
// (a value read from a getter next to a version that only triggers the
// render is a value the React Compiler keeps; ADR 229).
type LibrarySnapshot = {
  version: number;
  library: ReturnType<typeof getLibrary>;
  current: ReturnType<typeof currentLibraryDocument>;
};
let librarySnap: LibrarySnapshot | null = null;
function librarySnapshot(): LibrarySnapshot {
  const version = libraryVersion();
  if (librarySnap?.version !== version) {
    librarySnap = {
      version,
      library: getLibrary(),
      current: currentLibraryDocument(),
    };
  }
  return librarySnap;
}

/** What the panel lists, read outside the component (the compiler does not
 *  compile a component with a conditional inside a `try`). */
async function readLibrary(
  library: NonNullable<LibrarySnapshot["library"]>,
  current: LibrarySnapshot["current"],
) {
  const list = await library.list();
  const history = current ? await library.log(current.id) : [];
  const refs = current ? await library.refs(current.id) : {};
  return { list, history, refs };
}

export function LibraryPanel() {
  const editor = usePaged();
  const { version, library, current } = useSyncExternalStore(
    subscribeLibrary,
    librarySnapshot,
    librarySnapshot,
  );
  const [docs, setDocs] = useState<DocumentEntry[]>([]);
  const [log, setLog] = useState<CommitInfo[]>([]);
  const [releases, setReleases] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [who, setWho] = useState<string | null>(() =>
    SERVER ? signedInAs(SERVER) : null,
  );
  const [syncNote, setSyncNote] = useState<string | null>(null);
  // The version a release is being named for, and the name typed so far:
  // the name is asked in the panel, beside the version (PN-354), not in a
  // window.prompt.
  const [releasing, setReleasing] = useState<string | null>(null);
  const [releaseName, setReleaseName] = useState("");
  // Open from server asks for the repository in the panel too (UX F-13).
  const [cloning, setCloning] = useState(false);
  const [cloneRepo, setCloneRepo] = useState("");
  // A live save adds a branch: the refs below are read again when the relay moves.
  const liveVersion = useSyncExternalStore(
    live.subscribe,
    live.version,
    live.version,
  );
  const [branches, setBranches] = useState<string[]>([]);
  const refresh = () => setTick((t) => t + 1);

  // ADR 240 — a version that appears after the first read (a save, a
  // restore, a pull) fades in: the read lands as a view transition. The
  // first read of a document just shows its list.
  const readFor = useRef<string | null>(null);
  useEffect(() => {
    if (!library) return;
    let live = true;
    void readLibrary(library, current).then(
      ({ list, history, refs }) => {
        if (!live) return;
        const key = current?.id ?? "";
        const first = readFor.current !== key;
        readFor.current = key;
        const apply = first
          ? (run: () => void) => run()
          : (run: () => void) => transitionWith("next", run);
        apply(() => {
          setDocs(list);
          setLog(history);
          const named: Record<string, string> = {};
          for (const [ref, hash] of Object.entries(refs)) {
            if (ref.startsWith("releases/"))
              named[hash] = [named[hash], ref.slice(9)]
                .filter(Boolean)
                .join(", ");
          }
          setReleases(named);
          setBranches(Object.keys(refs).filter((r) => r.startsWith("agent/")));
          setError(null);
        });
      },
      (err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      live = false;
    };
  }, [library, current, version, tick, liveVersion]);

  const open = async (entry: DocumentEntry, target = "main") => {
    if (!library) return;
    if (!(await confirmDiscard(editor, `Opening ${entry.name}`))) return;
    const bytes = await library.exportPaged(entry.id, target);
    const doc = editor.document;
    await loadDocumentFile(
      editor.client,
      new File([bytes.slice()], `${entry.name}.paged`),
      {
        setHandle: doc.setHandle,
        setSourceName: doc.setSourceName,
        setLoading: doc.setLoading,
        setStatus: (s) => console.info("[library]", s),
        setSnapshotsReady: doc.setSnapshotsReady,
        addSnapshot: (pageId, url) =>
          doc.setSnapshots((prev) => new Map(prev).set(pageId, url)),
        resetForNewDocument: doc.resetForNewDocument,
        pushWarning: (w) => console.warn("[library]", w),
        libraryDocument: entry,
      },
    );
  };

  const act = (f: () => Promise<unknown>) => () => {
    f()
      .then(refresh)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  };

  const remoteFor = async (d: DocumentEntry) => {
    const token = await accessToken(SERVER);
    if (!token) {
      setWho(null);
      throw new Error("Sign in to the server first.");
    }
    return { url: SERVER, repo: remoteRepo(d), token };
  };

  if (!library) {
    return (
      <div
        data-library-panel
        style={{
          padding: 12,
          font: `12px ${font.sans}`,
          color: "var(--pg-muted-fg)",
        }}
      >
        The library needs the browser&apos;s private file system, which is not
        available here. Files still open and save as before.
      </div>
    );
  }

  return (
    <div
      data-library-panel
      style={{
        padding: 12,
        font: `12px ${font.sans}`,
        color: "var(--pg-fg)",
      }}
    >
      <div style={{ ...kicker, marginTop: 0 }}>This document</div>
      {!current ? (
        <p
          data-library-unsaved
          style={{ margin: 0, color: "var(--pg-muted-fg)" }}
        >
          Not in the library yet. Save (Cmd+S) keeps it here, with every later
          save as a version.
        </p>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
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
          <ul
            data-library-versions
            style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}
          >
            {log.map((c, i) => (
              <ViewTransition
                key={c.hash}
                enter={FADE}
                exit={FADE}
                update="none"
              >
                <li
                  data-library-version={c.hash}
                  style={{
                    padding: "4px 0",
                    borderTop: `1px solid ${color.border}`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <span>
                      {c.message}
                      {c.agent && (
                        <span
                          style={{
                            ...mono,
                            marginLeft: 6,
                            color: "var(--status-warn)",
                          }}
                        >
                          agent
                        </span>
                      )}
                      {releases[c.hash] && (
                        <span
                          style={{
                            ...mono,
                            marginLeft: 6,
                            color: status.ok,
                          }}
                        >
                          released {releases[c.hash]}
                        </span>
                      )}
                    </span>
                    <span style={{ ...mono, color: "var(--pg-muted-fg)" }}>
                      {when(c.ts)}
                    </span>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      marginTop: 3,
                      alignItems: "center",
                    }}
                  >
                    {/* Labelled for people (PN-353): the version's
                        number and who made it; the hash is only the
                        tooltip. */}
                    <span
                      style={{ ...mono, color: "var(--pg-muted-fg)" }}
                      title={c.hash}
                      data-library-version-label
                    >
                      Version {log.length - i}
                      {c.author ? ` · ${c.author}` : ""}
                    </span>
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
                      aria-expanded={releasing === c.hash}
                      onClick={() => {
                        setReleasing(releasing === c.hash ? null : c.hash);
                        setReleaseName("");
                      }}
                    >
                      Release
                    </button>
                  </div>
                  {releasing === c.hash && (
                    <form
                      data-library-release-form
                      style={{
                        display: "flex",
                        gap: 6,
                        marginTop: 4,
                        alignItems: "center",
                      }}
                      onSubmit={(e) => {
                        e.preventDefault();
                        const name = releaseName.trim().replace(/\s+/g, "-");
                        if (!name) return;
                        setReleasing(null);
                        act(async () => {
                          await library.release(current.id, name, c.hash);
                        })();
                      }}
                    >
                      <input
                        autoFocus
                        aria-label="Release name"
                        placeholder="Release name (it never moves)"
                        data-library-release-name
                        value={releaseName}
                        onChange={(e) => setReleaseName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setReleasing(null);
                        }}
                        style={{ ...button, flex: 1, minWidth: 0 }}
                      />
                      <button
                        type="submit"
                        data-library-release-confirm
                        style={button}
                        disabled={!releaseName.trim()}
                      >
                        Release
                      </button>
                      <button
                        type="button"
                        style={button}
                        onClick={() => setReleasing(null)}
                      >
                        Cancel
                      </button>
                    </form>
                  )}
                </li>
              </ViewTransition>
            ))}
          </ul>
        </>
      )}

      {SERVER && (
        <div data-library-server>
          <div style={kicker}>Server</div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <span
              style={{ ...mono, color: "var(--pg-muted-fg)" }}
              data-library-who
            >
              {who
                ? `${new URL(SERVER).host} · ${who}`
                : `${new URL(SERVER).host} · signed out`}
            </span>
            {who ? (
              <button
                type="button"
                data-library-signout
                style={button}
                onClick={() => {
                  signOut(SERVER);
                  setWho(null);
                }}
              >
                Sign out
              </button>
            ) : (
              <button
                type="button"
                data-library-signin
                style={button}
                onClick={act(async () => {
                  await signIn(SERVER);
                  setWho(signedInAs(SERVER));
                })}
              >
                Sign in
              </button>
            )}
          </div>
          {who && current && (
            <div
              style={{
                display: "flex",
                gap: 6,
                marginTop: 6,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <span style={{ ...mono, color: "var(--pg-muted-fg)" }}>
                {remoteRepo(current)}
              </span>
              <button
                type="button"
                data-library-push
                style={button}
                title="Send this document's versions the server lacks"
                onClick={act(async () => {
                  const r = await library.push(
                    current.id,
                    await remoteFor(current),
                  );
                  setSyncNote(
                    r.sent
                      ? `Pushed ${r.sent} object${r.sent === 1 ? "" : "s"} (${r.bytes.toLocaleString()} bytes)`
                      : "Up to date",
                  );
                })}
              >
                Push
              </button>
              <button
                type="button"
                data-library-pull
                style={button}
                title="Take the server's newer versions; a document that moved apart is refused, not merged"
                onClick={act(async () => {
                  const r = await library.pull(
                    current.id,
                    await remoteFor(current),
                  );
                  setSyncNote(
                    r.changed ? "Pulled newer versions" : "Up to date",
                  );
                  if (r.changed) await open(current);
                })}
              >
                Pull
              </button>
            </div>
          )}
          {who && (
            <button
              type="button"
              data-library-clone
              style={{ ...button, marginTop: 6 }}
              aria-expanded={cloning}
              onClick={() => {
                setCloning(!cloning);
                setCloneRepo("");
              }}
            >
              Open from server…
            </button>
          )}
          {who && cloning && (
            <form
              data-library-clone-form
              style={{ display: "flex", gap: 6, marginTop: 4 }}
              onSubmit={(e) => {
                e.preventDefault();
                const repo = cloneRepo.trim();
                if (!repo) return;
                setCloning(false);
                act(async () => {
                  const token = await accessToken(SERVER);
                  if (!token) throw new Error("Sign in to the server first.");
                  await open(
                    await library.clone({ url: SERVER, repo, token }, repo),
                  );
                })();
              }}
            >
              <input
                autoFocus
                aria-label="Server repository"
                placeholder="Server repository"
                data-library-clone-repo
                value={cloneRepo}
                onChange={(e) => setCloneRepo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setCloning(false);
                }}
                style={{ ...button, flex: 1, minWidth: 0 }}
              />
              <button type="submit" style={button} disabled={!cloneRepo.trim()}>
                Open
              </button>
              <button
                type="button"
                style={button}
                onClick={() => setCloning(false)}
              >
                Cancel
              </button>
            </form>
          )}
          {who && (
            <div data-library-claude style={{ marginTop: 10 }}>
              <div style={kicker}>Claude</div>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                {live.state() === "open" ? (
                  <>
                    <span
                      style={{ ...mono, color: "var(--pg-muted-fg)" }}
                      data-library-live-state
                    >
                      Connected · Claude can use this tab
                    </span>
                    <button
                      type="button"
                      data-library-live-disconnect
                      style={button}
                      onClick={() => disconnectLive()}
                    >
                      Disconnect
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    data-library-live-connect
                    style={button}
                    disabled={live.state() === "connecting"}
                    title="Let Claude (signed in to this server as you) run scripts, render pages and save versions in this tab"
                    onClick={act(() => connectLive(SERVER, editor.client))}
                  >
                    {live.state() === "connecting"
                      ? "Connecting…"
                      : "Connect to Claude"}
                  </button>
                )}
                <label
                  style={{
                    ...mono,
                    display: "flex",
                    gap: 4,
                    alignItems: "center",
                  }}
                >
                  <input
                    type="checkbox"
                    data-library-live-ask
                    checked={live.ask()}
                    onChange={(e) => live.setAsk(e.target.checked)}
                  />
                  Ask before each change
                </label>
              </div>
              {live.pending().map((call) => (
                <div
                  key={call.id}
                  data-library-live-pending={call.tool}
                  style={{
                    border: `1px solid ${status.warn}`,
                    borderRadius: 4,
                    padding: 6,
                    marginTop: 6,
                  }}
                >
                  <div style={mono}>
                    Claude wants to{" "}
                    {call.tool === "save_document"
                      ? "save a version on its own branch"
                      : "run a script"}
                  </div>
                  {typeof call.args.source === "string" && (
                    <pre
                      style={{
                        ...mono,
                        maxHeight: 120,
                        overflow: "auto",
                        margin: "4px 0",
                      }}
                    >
                      {call.args.source}
                    </pre>
                  )}
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      data-library-live-allow
                      style={button}
                      onClick={() => live.answer(call.id, true)}
                    >
                      Allow
                    </button>
                    <button
                      type="button"
                      data-library-live-decline
                      style={button}
                      onClick={() => live.answer(call.id, false)}
                    >
                      Decline
                    </button>
                  </div>
                </div>
              ))}
              {live.log().length > 0 && (
                <ul
                  data-library-live-log
                  style={{ listStyle: "none", margin: "6px 0 0", padding: 0 }}
                >
                  {live
                    .log()
                    .slice(0, 8)
                    .map((e) => (
                      <li
                        key={e.id}
                        data-library-live-entry={e.outcome}
                        style={{
                          ...mono,
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 6,
                        }}
                      >
                        <span>
                          {e.tool}{" "}
                          <span style={{ color: "var(--pg-muted-fg)" }}>
                            {e.summary}
                          </span>
                        </span>
                        <span
                          style={{
                            color:
                              e.outcome === "done"
                                ? "var(--pg-muted-fg)"
                                : "var(--status-warn)",
                          }}
                        >
                          {e.outcome}
                        </span>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
          {current && branches.length > 0 && (
            <div data-library-agent-branches style={{ marginTop: 8 }}>
              <div style={kicker}>Claude's branches</div>
              {branches.map((b) => (
                <div
                  key={b}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 6,
                    alignItems: "center",
                  }}
                >
                  <span style={{ ...mono }}>{b}</span>
                  <button
                    type="button"
                    data-library-merge={b}
                    style={button}
                    title="Approve and merge into main; Claude cannot do this itself"
                    onClick={act(async () => {
                      await library.mergeBranch(current.id, b);
                      await open(current);
                    })}
                  >
                    Merge into main
                  </button>
                </div>
              ))}
            </div>
          )}
          {syncNote && (
            <p
              data-library-sync-note
              style={{
                ...mono,
                margin: "6px 0 0",
                color: "var(--pg-muted-fg)",
              }}
            >
              {syncNote}
            </p>
          )}
        </div>
      )}

      <div style={kicker}>Library</div>
      {docs.length === 0 ? (
        <p style={{ margin: 0, color: "var(--pg-muted-fg)" }}>
          No documents yet. Opening or saving a file adds it.
        </p>
      ) : (
        <ul
          data-library-documents
          style={{ listStyle: "none", margin: 0, padding: 0 }}
        >
          {docs.map((d) => (
            <li
              key={d.id}
              data-library-document={d.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
                padding: "3px 0",
              }}
            >
              <span style={{ fontWeight: d.id === current?.id ? 600 : 400 }}>
                {d.name}
              </span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ ...mono, color: "var(--pg-muted-fg)" }}>
                  {when(d.updatedAt)}
                </span>
                {d.id !== current?.id && (
                  <button
                    type="button"
                    data-library-open
                    style={button}
                    onClick={act(() => open(d))}
                  >
                    Open
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p
          data-library-error
          style={{ ...mono, color: "var(--status-error)", marginTop: 8 }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
