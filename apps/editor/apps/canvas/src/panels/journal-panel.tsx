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

// The Journal panel (ADR 025) — the local flight recorder's surface.
//
// Two halves, and the SECOND one is the point:
//
//   1. What was recorded — a bounded ring of program events (commands,
//      plugin activation, worker frames, crashes), newest first.
//   2. WHAT THIS CANNOT SEE — the uncaptured ledger and the declared blind
//      spots, rendered PERMANENTLY and NOT behind a disclosure triangle.
//
// The second half exists because the failure mode of any diagnostic surface is
// a reader mistaking absence of evidence for evidence of absence. The action
// recorder already established the rule this generalises (`shell/actions/
// model.ts`): a silent drop produces a false picture; a counted drop is a fact
// on screen.
//
// Nothing here transmits anything. Export is a Blob download through the app's
// existing door, and the dialog shows the EXACT bytes that will be written —
// "explicit export" only means something if the user can see what leaves.

import { useMemo, useState, useSyncExternalStore } from "react";

import {
  journal,
  textFor,
  ledgerIsClean,
  KNOWN_BLIND_SPOTS,
  type JournalEntry,
  type JournalSeverity,
} from "@paged-media/client";

import {
  buildBundleNow,
  exportJournalBundleAsync,
  getDocumentShape,
  previewBundle,
  pullWorkerJournal,
} from "../journal-sink";
import { color, Disclosure, font, radius, space } from "@paged-media/panel-kit";
import {
  debugHandlesOf,
  FocusScope,
  useEditorScope,
  type EditorScope,
} from "@paged-media/shell";
import { defineMessages, useStrings } from "@paged-media/strings";

// The panel's words. The entries themselves (codes, data, origins) and the
// client's declared blind spots are the recorder's own record and stay as
// recorded.
const M = defineMessages("app.journalPanel", {
  journal: "Journal",
  minSeverity: "Minimum severity",
  all: "all",
  infoUp: "info+",
  warnUp: "warn+",
  errors: "errors",
  export: "Export…",
  summary:
    "{entries, plural, one {# entry} other {# entries}} · " +
    "{errors, plural, one {# error} other {# errors}} · " +
    "{warnings, plural, one {# warning} other {# warnings}}",
  empty: "Nothing recorded at this severity yet.",
  cannotSee: "What this cannot see",
  nothingUncaptured: "Nothing uncaptured so far this session.",
  evicted: "evicted",
  evictedWhy: "recorded, then overwritten by the ring",
  collapsed: "collapsed",
  collapsedWhy:
    "folded into another entry by a rate policy (the count survives on it)",
  rejected: "rejected data",
  rejectedWhy:
    "values dropped for failing the identifier rule — THIS IS A BUG IN THE EMITTING CODE",
  gestureWrites: "gesture SAB writes",
  cameraWrites: "camera SAB writes",
  notJournaled: "deliberately not journaled individually",
  workerDropped: "worker entries dropped",
  workerDroppedWhy: "lost to the worker ring before a drain reached them",
  drainFailures: "drain failures",
  drainFailuresWhy: "an UNKNOWN number of worker entries are missing",
  pluginLog: "plugin log lines",
  pluginLogWhy:
    "censused (severity + site hash); the text is withheld by design",
  tracing:
    "engine tracing events — fired and dropped; no shipped subscriber carries their text",
  blindSpots: "{count} structural blind spots (always present, by design)",
  costToFix: "Cost to fix: {cost}",
  exportTitle: "Export journal bundle",
  exportIntro:
    "{count} entries. Nothing has been sent anywhere — this writes a file " +
    "to your machine. Below is exactly what it will contain.",
  includeCrash: "Include crash stack traces",
  includeCrashWhy: " — stack traces usually contain file paths from your disk.",
  includeShape: "Include document shape",
  includeShapeWhy: " — page/story counts and font names. No document text.",
  cancel: "Cancel",
  saveFile: "Save file",
});

const DOT: Record<JournalSeverity, string> = {
  error: "var(--status-error)",
  warn: "var(--status-review)",
  info: "var(--status-info)",
  debug: "var(--pg-muted-fg)",
};

const kicker: React.CSSProperties = {
  font: `700 10px ${font.sans}`,
  letterSpacing: font.trackingWide,
  textTransform: "uppercase",
  color: "var(--pg-muted-fg)",
  margin: `0 0 ${space[2]}`,
};

const mono: React.CSSProperties = {
  font: `11px/1.5 ${font.mono}`,
  fontVariantNumeric: "tabular-nums",
};

// Module-scope so the identities are stable across renders (a new function
// every render makes useSyncExternalStore resubscribe on every commit).
const subscribe = (cb: () => void) => journal.subscribe(cb);

// The snapshot is keyed on the buffer's REVISION, not on `entries()`: a
// ledger-only change (an eviction, a counted SAB write) leaves the entry
// array identical and would otherwise never reach the screen. It is the
// snapshot itself that the store returns, not the revision: a value read
// beside a revision that only triggers the render is a value the React
// Compiler keeps (ADR 229).
interface JournalView {
  entries: ReturnType<typeof journal.entries>;
  ledger: ReturnType<typeof journal.getLedger>;
  counts: ReturnType<typeof journal.counts>;
}
let view: { version: number; value: JournalView } | null = null;
const getView = (): JournalView => {
  const version = journal.version();
  if (view?.version !== version) {
    view = {
      version,
      value: {
        entries: journal.entries(),
        ledger: journal.getLedger(),
        counts: journal.counts(),
      },
    };
  }
  return view.value;
};

export function JournalPanel() {
  const strings = useStrings();
  const { entries, ledger, counts } = useSyncExternalStore(
    subscribe,
    getView,
    getView,
  );
  const [minSeverity, setMinSeverity] = useState<JournalSeverity | "all">(
    "all",
  );
  const [exporting, setExporting] = useState(false);

  // eslint-disable-next-line no-restricted-syntax -- a computed block, not a single expression (ADR 229)
  const shown = useMemo(() => {
    const rank = { debug: 0, info: 1, warn: 2, error: 3 } as const;
    const floor = minSeverity === "all" ? -1 : rank[minSeverity];
    // Newest first: when something just went wrong, it is at the top.
    return entries
      .filter((e) => rank[e.severity] >= floor)
      .slice()
      .reverse();
  }, [entries, minSeverity]);

  return (
    <div
      data-journal-panel
      style={{
        padding: space[3],
        font: `12px ${font.sans}`,
        color: "var(--pg-fg)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          // The panel docks into a resizable column and shares the console
          // group with Problems, so the header is allowed to wrap rather than
          // overflow when the user drags the dock narrow.
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <div style={kicker}>{strings.t(M.journal)}</div>
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            flex: "0 1 auto",
            minWidth: 0,
          }}
        >
          <select
            data-journal-filter
            aria-label={strings.t(M.minSeverity)}
            value={minSeverity}
            onChange={(e) =>
              setMinSeverity(e.target.value as JournalSeverity | "all")
            }
            style={{
              ...mono,
              background: "transparent",
              color: "var(--pg-fg)",
              border: `1px solid ${color.border}`,
              borderRadius: radius.sm,
              padding: "2px 4px",
            }}
          >
            <option value="all">{strings.t(M.all)}</option>
            <option value="info">{strings.t(M.infoUp)}</option>
            <option value="warn">{strings.t(M.warnUp)}</option>
            <option value="error">{strings.t(M.errors)}</option>
          </select>
          <button
            type="button"
            data-journal-export
            onClick={() => {
              // Drain the worker first so the preview is not missing the
              // render loop's last second.
              void pullWorkerJournal().then(() => setExporting(true));
            }}
            style={{
              ...mono,
              cursor: "pointer",
              background: "transparent",
              color: "var(--pg-fg)",
              border: `1px solid ${color.border}`,
              borderRadius: radius.sm,
              padding: "2px 8px",
            }}
          >
            {strings.t(M.export)}
          </button>
        </div>
      </div>

      <p
        data-journal-summary
        style={{ ...mono, margin: "0 0 8px", color: "var(--pg-muted-fg)" }}
      >
        {strings.t(M.summary, {
          entries: entries.length,
          errors: counts.error,
          warnings: counts.warn,
        })}
      </p>

      {shown.length === 0 ? (
        <p
          data-journal-empty
          style={{ margin: 0, color: "var(--pg-muted-fg)" }}
        >
          {strings.t(M.empty)}
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {shown.map((e) => (
            <JournalRow key={`${e.origin}:${e.seq}`} entry={e} />
          ))}
        </ul>
      )}

      <UncapturedSection ledger={ledger} />

      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    </div>
  );
}

function JournalRow({ entry }: { entry: JournalEntry }) {
  const data = entry.data ?? {};
  const keys = Object.keys(data);
  return (
    <li
      data-journal-entry
      data-journal-code={entry.code}
      data-journal-severity={entry.severity}
      data-journal-origin={entry.origin}
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: space[2],
        padding: "3px 2px",
        ...mono,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: radius.full,
          background: DOT[entry.severity],
          flex: "none",
          transform: "translateY(1px)",
        }}
      />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span title={textFor(entry.code)}>{entry.code}</span>
        {entry.durMs !== undefined && (
          <span style={{ color: "var(--pg-muted-fg)", marginLeft: 6 }}>
            {entry.durMs}ms
          </span>
        )}
        {keys.length > 0 && (
          <span style={{ color: "var(--pg-muted-fg)", marginLeft: 6 }}>
            {keys.map((k) => `${k}=${String(data[k])}`).join(" ")}
          </span>
        )}
      </span>
      <span style={{ color: "var(--pg-muted-fg)", flex: "none" }}>
        {entry.origin}
      </span>
    </li>
  );
}

/**
 * "What this cannot see" — permanently visible, never collapsed.
 *
 * Collapsing this would defeat its purpose: a reader skimming an exported
 * bundle needs to know what is structurally missing BEFORE they conclude
 * anything from what is present.
 */
function UncapturedSection({
  ledger,
}: {
  ledger: ReturnType<typeof journal.getLedger>;
}) {
  const strings = useStrings();
  const clean = ledgerIsClean(ledger);
  // [id, count, label, why]: the id names the row for tests and exports.
  const rows: [string, number, string, string][] = [
    ["evicted", ledger.evicted, M.evicted, M.evictedWhy],
    ["collapsed", ledger.collapsed, M.collapsed, M.collapsedWhy],
    ["rejected data", ledger.rejectedData, M.rejected, M.rejectedWhy],
    [
      "gesture SAB writes",
      ledger.sabGestureUpdates,
      M.gestureWrites,
      M.notJournaled,
    ],
    [
      "camera SAB writes",
      ledger.sabCameraWrites,
      M.cameraWrites,
      M.notJournaled,
    ],
    [
      "worker entries dropped",
      ledger.workerDropped,
      M.workerDropped,
      M.workerDroppedWhy,
    ],
    [
      "drain failures",
      ledger.drainFailures,
      M.drainFailures,
      M.drainFailuresWhy,
    ],
    ["plugin log lines", ledger.pluginLogCensus, M.pluginLog, M.pluginLogWhy],
  ];
  const tracing = ledger.engineTracing;
  const tracingTotal =
    tracing.debug + tracing.info + tracing.warn + tracing.error;

  return (
    <section
      data-journal-uncaptured
      style={{
        marginTop: space[4],
        paddingTop: space[3],
        borderTop: `1px solid ${color.border}`,
      }}
    >
      <div style={kicker}>{strings.t(M.cannotSee)}</div>

      {clean && tracingTotal === 0 ? (
        <p style={{ ...mono, margin: "0 0 8px", color: "var(--pg-muted-fg)" }}>
          {strings.t(M.nothingUncaptured)}
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: "0 0 10px", padding: 0 }}>
          {rows
            .filter(([, n]) => n > 0)
            .map(([id, n, label, why]) => (
              <li
                key={id}
                data-journal-uncaptured-row={id}
                style={{
                  ...mono,
                  color: "var(--pg-muted-fg)",
                  padding: "1px 0",
                }}
              >
                <strong style={{ color: "var(--pg-fg)" }}>{n}</strong>{" "}
                {strings.t(label)}
                <span style={{ marginLeft: 6 }}>— {strings.t(why)}</span>
              </li>
            ))}
          {tracingTotal > 0 && (
            <li
              style={{ ...mono, color: "var(--pg-muted-fg)", padding: "1px 0" }}
            >
              <strong style={{ color: "var(--pg-fg)" }}>{tracingTotal}</strong>{" "}
              {strings.t(M.tracing)}
            </li>
          )}
        </ul>
      )}

      <Disclosure
        data-journal-blindspots
        summary={strings.t(M.blindSpots, { count: KNOWN_BLIND_SPOTS.length })}
        summaryStyle={{ ...mono, color: "var(--pg-muted-fg)" }}
      >
        <ul
          style={{
            listStyle: "none",
            margin: "6px 0 0",
            padding: 0,
            display: "grid",
            gap: 8,
          }}
        >
          {KNOWN_BLIND_SPOTS.map((spot) => (
            <li
              key={spot.id}
              data-journal-blindspot={spot.id}
              style={{ ...mono }}
            >
              <div style={{ color: "var(--pg-fg)" }}>{spot.what}</div>
              <div style={{ color: "var(--pg-muted-fg)" }}>{spot.why}</div>
              <div style={{ color: "var(--pg-muted-fg)", fontStyle: "italic" }}>
                {strings.t(M.costToFix, { cost: spot.wouldCost })}
              </div>
            </li>
          ))}
        </ul>
      </Disclosure>
    </section>
  );
}

/**
 * The export dialog.
 *
 * The live preview is not a nicety — it IS the privacy claim made checkable.
 * `previewBundle` and the download path call the same serializer, so what is
 * shown cannot drift from what is written.
 */
function ExportDialog({ onClose }: { onClose: () => void }) {
  const scope = useEditorScope();
  const strings = useStrings();
  const [includeCrash, setIncludeCrash] = useState(false);
  const [includeShape, setIncludeShape] = useState(false);

  const options = {
    // Both sections are OPT-IN and default OFF. Stack traces embed the
    // user's disk paths; document shape carries font families.
    crash: includeCrash ? { stacks: readCrashStacks(scope) } : undefined,
    documentShape: includeShape ? getDocumentShape() : undefined,
  };

  const text = previewBundle(options);
  const bundle = buildBundleNow(options);

  return (
    <div
      data-journal-export-backdrop
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "grid",
        placeItems: "center",
        background: "rgba(0,0,0,0.6)",
        font: `13px/1.5 ${font.sans}`,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="journal-export-title"
        data-journal-export-dialog
        style={{
          width: "min(720px, 94vw)",
          maxHeight: "86vh",
          display: "flex",
          flexDirection: "column",
          padding: 20,
          borderRadius: radius.lg,
          border: `1px solid ${color.border}`,
          background: color.elevated,
          color: color.fg,
          boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
        }}
      >
        {/* ADR 234 — focus moves in on open, Tab stays inside, and
            focus returns to the opener on close. */}
        <FocusScope trap autoFocus restoreFocus>
          <h2
            id="journal-export-title"
            style={{ margin: "0 0 4px", fontSize: 15 }}
          >
            {strings.t(M.exportTitle)}
          </h2>
          <p style={{ margin: "0 0 12px", color: color.mutedFg }}>
            {strings.t(M.exportIntro, { count: bundle.counters.recorded })}
          </p>

          <div style={{ display: "grid", gap: 6, margin: "0 0 12px" }}>
            <label
              style={{ display: "flex", gap: 8, alignItems: "flex-start" }}
            >
              <input
                type="checkbox"
                data-journal-include-crash
                checked={includeCrash}
                onChange={(e) => setIncludeCrash(e.target.checked)}
              />
              <span>
                {strings.t(M.includeCrash)}
                <span style={{ color: color.mutedFg }}>
                  {strings.t(M.includeCrashWhy)}
                </span>
              </span>
            </label>
            <label
              style={{ display: "flex", gap: 8, alignItems: "flex-start" }}
            >
              <input
                type="checkbox"
                data-journal-include-shape
                checked={includeShape}
                onChange={(e) => setIncludeShape(e.target.checked)}
              />
              <span>
                {strings.t(M.includeShape)}
                <span style={{ color: color.mutedFg }}>
                  {strings.t(M.includeShapeWhy)}
                </span>
              </span>
            </label>
          </div>

          <pre
            data-journal-preview
            style={{
              ...mono,
              flex: 1,
              minHeight: 160,
              overflow: "auto",
              margin: "0 0 12px",
              padding: 10,
              background: color.bg,
              border: `1px solid ${color.border}`,
              borderRadius: radius.sm,
              whiteSpace: "pre",
            }}
          >
            {text}
          </pre>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              data-journal-export-cancel
              onClick={onClose}
              style={buttonStyle}
            >
              {strings.t(M.cancel)}
            </button>
            <button
              type="button"
              data-journal-export-confirm
              onClick={() => {
                void exportJournalBundleAsync(options).then(onClose);
              }}
              style={{ ...buttonStyle, borderColor: color.primary }}
            >
              {strings.t(M.saveFile)}
            </button>
          </div>
        </FocusScope>
      </div>
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  font: `12px ${font.sans}`,
  cursor: "pointer",
  background: "transparent",
  color: color.fg,
  border: `1px solid ${color.border}`,
  borderRadius: radius.sm,
  padding: "5px 12px",
};

/** The shell's error boundary keeps the editor's last crash in its debug
 *  handles (the `__pagedCrash` affordance). That is the only stack the app
 *  retains, and it is read ONLY when the user ticks the box. */
function readCrashStacks(scope: EditorScope): string[] {
  const stash = debugHandlesOf(scope).crash;
  return stash ? [stash] : [];
}
