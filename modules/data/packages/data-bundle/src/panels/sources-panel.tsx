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

// The Data sources panel — a React expert-leaf factory closing over the
// BundleHost + the session. It owns the local import (CSV, TSV, JSON, Parquet,
// XLSX — the platform picker via shell.pickFile@1, with the raw file input
// kept as the harness-host fallback), the worksheet choice of a workbook, each
// source's refresh policy (src/refresh.ts),
// the source list, the remote-source lane (M1, D-03: per-source consent state,
// request-consent + edit-time load — inert until granted), and the HONEST
// status (engine/DuckDB availability, and whether the session is saved with
// the document — rendered honestly, never faked).
//
// Built from host surfaces + React ONLY (no @paged-media/shell). Token-layer
// styling (--pg-*, --space-*) reads native in both themes; prose is sans,
// mono is reserved for values/ids.

import {
  useState,
  type ChangeEvent,
  type CSSProperties,
  type ReactElement,
} from "react";
import type { BundleHost } from "@paged-media/plugin-api";

import { IMPORT_ACCEPT } from "../query/import";
import { MIN_INTERVAL_SECS, policyLabel, type RefreshPolicy } from "../refresh";
import type { DataSourceSession, RemoteFormat, SessionState } from "../session";
import { DiagnosticsList } from "./diagnostics";
import { useSessionSnapshot } from "./use-session";
import { color, font, space } from "@paged-media/panel-kit";
import { useStrings } from "@paged-media/strings";
import { SOURCES as M } from "../messages";

const wrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: space[3],
  padding: space[3],
  fontSize: "12px",
  color: color.fg,
};

const note: CSSProperties = {
  color: color.mutedFg,
  fontSize: "11px",
  lineHeight: 1.5,
};

/** Values/ids stay mono; prose is the host's sans. */
const mono: CSSProperties = {
  fontFamily: font.mono,
};

/** What the panel says about saving, per persistence state (message
 *  keys). */
const PERSISTENCE_NOTE: Record<SessionState["persistence"]["status"], string> =
  {
    empty: M.persistenceEmpty,
    pending: M.persistencePending,
    saved: M.persistenceSaved,
    unavailable: M.persistenceUnavailable,
  };

/** A remote source's status token in words (message keys). */
const REMOTE_STATUS: Record<string, string> = {
  inert: M.remoteInert,
  loaded: M.remoteLoaded,
  error: M.remoteError,
};

export function makeSourcesPanel(
  host: BundleHost,
  session: DataSourceSession,
): () => ReactElement {
  // A declaration, so the React Compiler sees the component (it cannot
  // see `return function SourcesPanel()`, editor ADR 229).
  function SourcesPanel(): ReactElement {
    const [snapshot, refresh] = useSessionSnapshot(session);
    const { t } = useStrings();
    const [remoteUrl, setRemoteUrl] = useState("");
    const [remoteFormat, setRemoteFormat] = useState<RemoteFormat>("csv");
    const [remoteError, setRemoteError] = useState<string | null>(null);
    const [consentRefused, setConsentRefused] = useState<Set<string>>(
      new Set(),
    );

    function onAddRemote(): void {
      if (!remoteUrl) return;
      const name =
        remoteUrl
          .replace(/^https?:\/\//, "")
          .replace(/\.[^.]+$/, "")
          .replace(/[^a-zA-Z0-9_]/g, "_") || "remote";
      const error = session.addRemoteSource(name, remoteUrl, remoteFormat);
      // A refused URL is said here, not only logged.
      setRemoteError(error ?? null);
      if (error === null) setRemoteUrl("");
      refresh();
    }

    async function onRequestConsent(name: string): Promise<void> {
      const granted = await session.requestConsentForRemote(name);
      // A refusal (the user said no, or this editor does not allow the
      // origin) is said beside the source, not only logged.
      setConsentRefused((prev) => {
        const next = new Set(prev);
        if (granted) next.delete(name);
        else next.add(name);
        return next;
      });
      refresh();
    }

    async function onLoadRemote(name: string): Promise<void> {
      await session.loadRemoteSource(name);
      refresh();
    }

    const [policyNote, setPolicyNote] = useState<string | null>(null);

    async function importBytes(
      fileName: string,
      bytes: Uint8Array,
    ): Promise<void> {
      await session.importFile(fileName, bytes);
      refresh();
    }

    async function onSheet(source: string, sheet: string): Promise<void> {
      await session.selectSheet(source, sheet);
      refresh();
    }

    function onPolicy(source: string, value: string, remote: boolean): void {
      const policy: RefreshPolicy =
        value === "interval"
          ? { policy: "interval", secs: remote ? 300 : 0 }
          : ({ policy: value } as RefreshPolicy);
      setPolicyNote(session.setRefreshPolicy(source, policy));
      refresh();
    }

    function onInterval(source: string, secs: number): void {
      setPolicyNote(
        session.setRefreshPolicy(source, { policy: "interval", secs }),
      );
      refresh();
    }

    // The platform picker (shell.pickFile@1) — same door + guard as
    // plugin-doc's pickAndIngest. The raw <input type="file"> below stays
    // ONLY as the fallback for hosts without the door (the SDK test
    // harness), so the bundle's own tests keep driving the import.
    async function onPick(): Promise<void> {
      const picked = await host.shell.pickFile({ accept: [...IMPORT_ACCEPT] });
      const file = picked[0];
      if (!file) return;
      await importBytes(file.name, file.bytes);
    }

    async function onFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
      const file = event.target.files?.[0];
      if (!file) return;
      await importBytes(file.name, new Uint8Array(await file.arrayBuffer()));
    }

    const fileOf = new Map(snapshot.files.map((f) => [f.source, f]));
    const remoteNames = new Set(snapshot.remote.map((r) => r.name));
    const policyOf = (name: string): RefreshPolicy =>
      snapshot.refresh[name] ?? { policy: "manual" };

    function PolicyPicker({ name }: { name: string }): ReactElement {
      const p = policyOf(name);
      const remote = remoteNames.has(name);
      return (
        <span data-data-refresh-policy={name}>
          {" "}
          · {t(M.refresh)}{" "}
          <select
            value={p.policy}
            onChange={(e) => onPolicy(name, e.target.value, remote)}
          >
            <option value="manual">{t(M.policyManual)}</option>
            <option value="onOpen">{t(M.policyOnOpen)}</option>
            {remote ? (
              <option value="interval">{t(M.policyEvery)}</option>
            ) : null}
            <option value="never">{t(M.policyNever)}</option>
          </select>
          {p.policy === "interval" ? (
            <input
              type="number"
              min={MIN_INTERVAL_SECS}
              value={p.secs}
              style={{ width: 64 }}
              onChange={(e) => onInterval(name, Number(e.target.value))}
            />
          ) : null}
          {snapshot.polling.includes(name) ? (
            <span style={note}>
              {" "}
              {t(M.polling, { policy: policyLabel(p) })}
            </span>
          ) : null}
        </span>
      );
    }

    return (
      <div style={wrap}>
        {host.supports("shell.pickFile@1") ? (
          <button
            type="button"
            data-data-import-csv
            data-data-import-file
            onClick={() => void onPick()}
            style={{ alignSelf: "flex-start", padding: "4px 10px" }}
          >
            {t(M.importFile)}
          </button>
        ) : (
          <label>
            {t(M.importFileLabel)}{" "}
            <input
              type="file"
              accept={IMPORT_ACCEPT.join(",")}
              onChange={onFile}
            />
          </label>
        )}
        <span style={note}>{t(M.formats)}</span>
        <div>
          {snapshot.sources.length === 0 ? (
            <span style={note}>{t(M.noSources)}</span>
          ) : (
            <ul>
              {snapshot.sources.map((s) => {
                const f = fileOf.get(s);
                return (
                  <li key={s} data-data-source={s}>
                    <span style={mono}>{s}</span>
                    {f ? (
                      <span style={note}>
                        {" "}
                        · {f.format} · {f.fileName}
                      </span>
                    ) : null}
                    {f?.sheets && f.sheets.length > 1 ? (
                      <select
                        data-data-sheet={s}
                        value={f.sheet}
                        onChange={(e) => void onSheet(s, e.target.value)}
                      >
                        {f.sheets.map((sh) => (
                          <option key={sh} value={sh}>
                            {sh}
                          </option>
                        ))}
                      </select>
                    ) : f?.sheet ? (
                      <span style={note}>
                        {" "}
                        · {t(M.sheet, { sheet: f.sheet })}
                      </span>
                    ) : null}
                    {remoteNames.has(s) ? null : <PolicyPicker name={s} />}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div>
          {/* Remote sources are consent-gated per the D-03 contract:
              per-origin consent state, request-consent + edit-time load —
              inert until granted, never fetched on document open. */}
          <strong>{t(M.remoteSources)}</strong>
          <p style={note}>{t(M.remoteNote)}</p>
          <div>
            <input
              type="url"
              placeholder="https://example.com/data.csv"
              value={remoteUrl}
              onChange={(e) => {
                setRemoteUrl(e.target.value);
                setRemoteError(null);
              }}
            />
            <select
              value={remoteFormat}
              onChange={(e) => setRemoteFormat(e.target.value as RemoteFormat)}
            >
              <option value="csv">csv</option>
              <option value="tsv">tsv</option>
              <option value="json">json</option>
              <option value="parquet">parquet</option>
            </select>
            <button
              type="button"
              data-data-remote-add
              disabled={!remoteUrl.trim()}
              title={
                remoteUrl.trim() ? t(M.addRemoteTitle) : t(M.addRemoteNeedsUrl)
              }
              onClick={onAddRemote}
            >
              {t(M.addRemote)}
            </button>
          </div>
          {remoteError && (
            <p
              style={{ ...note, color: "var(--status-error)" }}
              role="alert"
              data-data-remote-error
            >
              {remoteError}
            </p>
          )}
          {snapshot.remote.length === 0 ? (
            <span style={note}>{t(M.noRemote)}</span>
          ) : (
            <ul>
              {snapshot.remote.map((r) => (
                <li
                  key={r.name}
                  data-consent={r.consent}
                  data-status={r.status}
                >
                  <span style={mono}>{r.name}</span> ·{" "}
                  <span style={mono}>{r.origin}</span> · {r.format} ·{" "}
                  {r.consent === "granted"
                    ? t(M.consented)
                    : t(M.consentRequired)}{" "}
                  ·{" "}
                  {REMOTE_STATUS[r.status]
                    ? t(REMOTE_STATUS[r.status]!)
                    : r.status}
                  {r.contentKey ? (
                    <>
                      {" "}
                      · {t(M.key)} <span style={mono}>{r.contentKey}</span>
                    </>
                  ) : null}
                  {r.consent === "required" ? (
                    <button
                      type="button"
                      onClick={() => void onRequestConsent(r.name)}
                    >
                      {t(M.requestConsent)}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void onLoadRemote(r.name)}
                    >
                      {t(M.load)}
                    </button>
                  )}
                  <PolicyPicker name={r.name} />
                  <div style={note}>{r.message}</div>
                  {r.consent === "required" && consentRefused.has(r.name) && (
                    <div
                      style={{ ...note, color: "var(--status-error)" }}
                      data-data-consent-refused
                    >
                      {t(M.consentRefused, { origin: r.origin })}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        {policyNote ? (
          <p style={note} role="alert" data-data-policy-note>
            {policyNote}
          </p>
        ) : null}
        <p style={note}>{t(M.localFileNote)}</p>
        <div
          data-status={snapshot.status}
          // The message, not the engine's state name: "status: idle — …"
          // read as a debug line. The state stays on `data-status`.
          style={{
            color: /error|missing|fail/i.test(String(snapshot.status))
              ? "var(--status-error)"
              : "var(--pg-muted-fg)",
          }}
        >
          {snapshot.message}
        </div>
        <DiagnosticsList
          diagnostics={snapshot.diagnostics}
          sources={["import", "persist", "restore"]}
          onClear={() => {
            session.clearDiagnostics();
            refresh();
          }}
        />
        {/* Developer knowledge (was user-facing copy): the query engine is
            the vendored DuckDB-WASM (run scripts/vendor-duckdb.sh); the
            engine wasm is scripts/build-wasm.sh. Remote sources (M1) are
            inert until per-origin consent (D-03) and fetch at edit time
            only — never on document open. Sources, queries, bindings and the
            imported data are saved with the document (the `session`
            container part, persist.ts) on a host with container parts. */}
        {(snapshot.status === "duckdb-missing" ||
          snapshot.status === "engine-missing") && (
          <p style={note}>{t(M.engineMissing)}</p>
        )}
        <p style={note} data-data-persistence={snapshot.persistence.status}>
          {t(PERSISTENCE_NOTE[snapshot.persistence.status])}
        </p>
      </div>
    );
  }
  return SourcesPanel;
}
