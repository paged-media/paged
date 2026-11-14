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

// The compatibility report (editor ADR 1222; UXI-FIL-002; the UX
// strategy's §6.4; task DF4): what every import and export of this
// session could not carry, from the engine's one loss report (engine ADR
// 1097) wherever it came from — the engine's IDML reader and writer, a
// bundle's importer (PowerPoint, Word, PDF vectors, Photoshop) or the
// editor's own SVG import. Each report says its summary and the format's
// round-trip risk; each entry says what it means (left out, converted, a
// note), where it stood (its pages and items, a click takes you there and
// selects it) and, on demand, the technical code.

import { useState } from "react";

import type { LossEntry } from "@paged-media/plugin-api";
import { useEditorScope, usePaged, useRegistries } from "@paged-media/shell";
import { font, radius, space } from "@paged-media/panel-kit";
import { defineMessages, useStrings } from "@paged-media/strings";

import {
  areaLabel,
  areaOf,
  explainLoss,
  roundTripRisk,
  severityLabel,
  severityOfLoss,
  sortLosses,
  summaryLine,
  type CompatReport,
} from "./compatibility-report";
import {
  clearCompatReport,
  useCompatReports,
} from "./compatibility-report-store";
import { revealItems, revealPage } from "../reveal-targets";

const M = defineMessages("app.importReportPanel", {
  title: "Compatibility report",
  empty:
    "Nothing was lost. When an import or an export cannot carry something, it is listed here with where it was.",
  import: "Import",
  export: "Export",
  roundTrip: "Round trip",
  page: "Page {n}",
  showItems: "{count, plural, one {Show the item} other {Show the # items}}",
  showMade: "Show what was imported",
  notFound: "No longer in the document.",
  code: "Code",
  hideCode: "Hide code",
  clear: "Clear",
  times: "{count}×",
});

const TONE: Record<string, string> = {
  dropped: "var(--status-error)",
  approximated: "var(--status-review)",
  info: "var(--status-info)",
};

export function ImportReportPanel() {
  const strings = useStrings();
  const reports = useCompatReports();
  return (
    <div
      data-import-report-panel
      style={{
        padding: space[3],
        font: `12px ${font.sans}`,
        color: "var(--pg-fg)",
        display: "flex",
        flexDirection: "column",
        gap: space[3],
      }}
    >
      <div style={kicker}>{strings.t(M.title)}</div>
      {reports.length === 0 ? (
        <p data-import-report-empty style={muted}>
          {strings.t(M.empty)}
        </p>
      ) : (
        reports.map((r) => <ReportCard key={r.id} report={r} />)
      )}
    </div>
  );
}

function ReportCard({ report }: { report: CompatReport }) {
  const strings = useStrings();
  const scope = useEditorScope();
  const paged = usePaged();
  const registries = useRegistries();
  const [missing, setMissing] = useState(false);
  const t = (key: string, params?: Readonly<Record<string, string | number>>) =>
    strings.t(key, params);
  const reveal = (ids: readonly string[]) => {
    void revealItems(
      paged,
      { invoke: (id, p) => registries.commands.invoke(id, p) },
      ids,
    ).then((n) => setMissing(n === 0));
  };
  return (
    <section
      data-import-report
      data-import-report-id={report.id}
      data-direction={report.direction}
      data-format={report.format}
      style={card}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: space[2] }}>
        <span style={{ ...kicker, margin: 0 }}>
          {strings.t(report.direction === "import" ? M.import : M.export)} ·{" "}
          {report.format.toUpperCase()}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-import-report-clear
          onClick={() => clearCompatReport(scope, report.id)}
          style={linkButton}
        >
          {strings.t(M.clear)}
        </button>
      </div>
      <div data-import-report-summary style={{ fontWeight: 600 }}>
        {summaryLine(report, t)}
      </div>
      <p data-import-report-risk style={{ ...muted, margin: 0 }}>
        <strong style={{ color: "var(--pg-fg)" }}>
          {strings.t(M.roundTrip)}:
        </strong>{" "}
        {roundTripRisk(report.format, t)}
      </p>
      {report.made && report.made.length > 0 && (
        <button
          type="button"
          data-import-report-made
          onClick={() => reveal(report.made!)}
          style={linkButton}
        >
          {strings.t(M.showMade)}
        </button>
      )}
      {missing && (
        <p data-import-report-missing style={{ ...muted, margin: 0 }}>
          {strings.t(M.notFound)}
        </p>
      )}
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {sortLosses(report.losses).map((entry, i) => (
          <LossRow
            key={`${entry.code}:${i}`}
            entry={entry}
            onPage={(n) => void revealPage(paged, n)}
            onItems={reveal}
          />
        ))}
      </ul>
    </section>
  );
}

function LossRow({
  entry,
  onPage,
  onItems,
}: {
  entry: LossEntry;
  onPage: (index: number) => void;
  onItems: (ids: readonly string[]) => void;
}) {
  const strings = useStrings();
  const [code, setCode] = useState(false);
  const t = (key: string, params?: Readonly<Record<string, string | number>>) =>
    strings.t(key, params);
  const severity = severityOfLoss(entry);
  return (
    <li
      data-loss
      data-loss-code={entry.code}
      data-loss-severity={severity}
      data-loss-area={areaOf(entry)}
      style={{
        padding: "6px 0",
        borderTop: "1px solid var(--chrome-border)",
        display: "flex",
        flexDirection: "column",
        gap: 3,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: space[2] }}>
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: radius.full,
            background: TONE[severity],
            flex: "none",
            transform: "translateY(1px)",
          }}
        />
        <span data-loss-severity-label style={{ fontWeight: 600 }}>
          {severityLabel(severity, t)}
        </span>
        <span style={muted}>{areaLabel(areaOf(entry), t)}</span>
        {entry.count > 1 && (
          <span data-loss-count style={{ ...muted, font: `11px ${font.mono}` }}>
            {strings.t(M.times, { count: entry.count })}
          </span>
        )}
      </div>
      <div data-loss-explanation style={{ paddingLeft: 15 }}>
        {explainLoss(entry, t)}
      </div>
      <div
        style={{
          paddingLeft: 15,
          display: "flex",
          flexWrap: "wrap",
          gap: space[2],
        }}
      >
        {(entry.pages ?? []).map((p) => (
          <button
            key={p}
            type="button"
            data-loss-page={p}
            onClick={() => onPage(p)}
            style={linkButton}
          >
            {strings.t(M.page, { n: p + 1 })}
          </button>
        ))}
        {entry.items && entry.items.length > 0 && (
          <button
            type="button"
            data-loss-items
            onClick={() => onItems(entry.items!)}
            style={linkButton}
          >
            {strings.t(M.showItems, { count: entry.items.length })}
          </button>
        )}
        <button
          type="button"
          aria-expanded={code}
          data-loss-code-toggle
          onClick={() => setCode((c) => !c)}
          style={{ ...linkButton, color: "var(--pg-muted-fg)" }}
        >
          {strings.t(code ? M.hideCode : M.code)}
        </button>
      </div>
      {code && (
        <code
          data-loss-code-text
          style={{
            paddingLeft: 15,
            font: `11px ${font.mono}`,
            color: "var(--pg-muted-fg)",
          }}
        >
          {entry.code}
        </code>
      )}
    </li>
  );
}

const kicker: React.CSSProperties = {
  font: `700 10px ${font.sans}`,
  letterSpacing: font.trackingWide,
  textTransform: "uppercase",
  color: "var(--pg-muted-fg)",
  margin: `0 0 ${space[2]}`,
};

const muted: React.CSSProperties = { color: "var(--pg-muted-fg)" };

const card: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: space[2],
  padding: space[2],
  border: "1px solid var(--chrome-border)",
  borderRadius: radius.md,
};

const linkButton: React.CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  font: `600 11px ${font.sans}`,
  color: "var(--pg-primary)",
  cursor: "pointer",
  alignSelf: "flex-start",
};
