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

// Cockpit — Publication health (Design mode's left footer in the
// kit; a standalone panel here). REAL metrics from documentMeta + the
// worker's live DocumentStats + the fonts/links collections.
//
// W2.12 — the risk rows are now REAL counts wherever the W0.6 wire
// summaries carry them: overset stories (`DocumentStats.overset_stories`),
// missing fonts (`FontSummary.isMissing`), broken links
// (`LinkSummary.status === "missing"`), low-res placements
// (`LinkSummary.effectivePpi` below the 150-ppi convention), and the
// last export's structured preflight findings rolled up by severity.
// A clean count reads "0" with an OK dot; a non-zero count badges and
// (for preflight) chevrons into the Preflight panel's findings.

import {
  CockpitPanelHeader,
  CockpitSection,
  Icon,
  cockpitActions,
  MetricTile,
  StatusPill,
  printOutputFacts,
  useCanvasClient,
  useCollection,
  useDocumentMeta,
  useDocumentStats,
} from "@paged-media/shell";
import type { FontSummary, LinkSummary } from "@paged-media/client";

import { exportReadiness, exportTargetById } from "./export-targets";

import { severityCounts, usePreflightFindings } from "./preflight-findings";

/** Low-res convention — screen/preflight floor below which a placed
 *  image is flagged. The print floor is 300 ppi; 150 is the editor's
 *  "warn, not fail" threshold the panels share. */
const LOW_RES_PPI = 150;

interface RiskRow {
  key: string;
  label: string;
  /** The panel that lists this risk's findings, opened by the row. */
  panel: string;
  /** `null` when the data source for this risk isn't available yet
   *  (renders the em-dash seam); a number renders the live count. */
  count: number | null;
}

export function PublicationHealthPanel() {
  const client = useCanvasClient();
  const meta = useDocumentMeta();
  const stats = useDocumentStats();
  const fonts = useCollection<FontSummary>("fonts");
  const links = useCollection<LinkSummary>("links");
  const { findings, runCount } = usePreflightFindings(client);
  const loaded = meta != null && meta.pageCount > 0;
  // The print PDF's readiness is the Export Center's own pill (ADR 266):
  // the standard the export will meet, not a PDF/X-4 warning for a
  // document that exports PDF 1.7.
  const print = exportReadiness(
    exportTargetById("pdf-x4"),
    loaded,
    printOutputFacts(meta),
  );

  const missingFonts = fonts ? fonts.filter((f) => f.isMissing).length : null;
  const missingLinks = links
    ? links.filter((l) => l.status === "missing").length
    : null;
  const lowRes = links
    ? links.filter(
        (l) => l.effectivePpi != null && l.effectivePpi < LOW_RES_PPI,
      ).length
    : null;
  const oversetStories =
    stats && stats.overset_stories != null ? stats.overset_stories : null;
  const { errors, warnings } = severityCounts(findings);
  // Preflight findings only count once an export has actually run.
  const preflightCount = runCount > 0 ? errors + warnings : null;

  const riskRows: RiskRow[] = [
    {
      key: "overset",
      label: "Overset stories",
      count: oversetStories,
      panel: "paged.stories",
    },
    {
      key: "missing-links",
      label: "Missing links",
      count: missingLinks,
      panel: "paged.links",
    },
    {
      key: "low-res",
      label: "Low-res images",
      count: lowRes,
      panel: "paged.links",
    },
    {
      key: "fonts",
      label: "Missing fonts",
      count: missingFonts,
      panel: "paged.fonts",
    },
    {
      key: "preflight",
      label: "Preflight findings",
      count: preflightCount,
      panel: "paged.preflight",
    },
  ];

  return (
    <div data-publication-health style={{ overflowY: "auto", height: "100%" }}>
      <CockpitPanelHeader
        title="Publication health"
        action={
          loaded ? (
            <StatusPill
              tone={print.tone}
              testId="print-readiness"
              title={print.reason}
            >
              {print.label}
            </StatusPill>
          ) : undefined
        }
      />
      <CockpitSection title="Document">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 6,
          }}
        >
          <MetricTile
            label="Pages"
            value={loaded ? String(meta.pageCount) : "—"}
          />
          <MetricTile
            label="Stories"
            value={stats ? String(stats.stories) : "—"}
          />
          <MetricTile
            label="Frames"
            value={stats ? String(stats.frames) : "—"}
          />
          <MetricTile
            label="Glyphs"
            value={stats ? String(stats.glyphs) : "—"}
          />
          <MetricTile
            label="Placed links"
            value={links ? String(links.length) : "—"}
          />
          <MetricTile
            label="Color mode"
            value={meta?.colorMode ? meta.colorMode.toUpperCase() : "—"}
          />
        </div>
      </CockpitSection>
      <CockpitSection title="Risks">
        <div style={{ display: "flex", flexDirection: "column" }}>
          {riskRows.map((r) => (
            <RiskRowView key={r.key} row={r} />
          ))}
          <span
            className="pg-ui-xs"
            style={{ paddingTop: 8, lineHeight: 1.45 }}
          >
            Preflight findings populate after Prepress ▸ Validate output; the
            other counts read live from the document.
          </span>
        </div>
      </CockpitSection>
    </div>
  );
}

function RiskRowView({ row }: { row: RiskRow }) {
  const seam = row.count == null;
  const clean = row.count === 0;
  const danger = (row.count ?? 0) > 0;
  const content = (
    <>
      <span
        className="pg-value"
        style={{
          width: 18,
          textAlign: "right",
          flexShrink: 0,
          color: danger ? "var(--status-error)" : undefined,
        }}
      >
        {seam ? "—" : row.count}
      </span>
      <span style={{ flex: 1, fontSize: 12.5 }}>{row.label}</span>
      {clean ? (
        <Icon
          name="ui-check"
          size={13}
          style={{ color: "var(--status-approved)", flexShrink: 0 }}
        />
      ) : danger ? (
        <Icon
          name="ui-chevron-right"
          size={13}
          style={{ color: "var(--pg-muted-fg)", flexShrink: 0 }}
        />
      ) : null}
    </>
  );
  const common = {
    "data-risk-row": row.key,
    "data-risk-count": seam ? undefined : row.count,
    "data-seam": seam ? "" : undefined,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "6px 0",
      borderBottom: "1px solid var(--pg-border)",
      opacity: seam ? 0.55 : 1,
    } as const,
  };
  // A row with findings is the way to them (PN-301): a button that opens
  // the panel listing them, as the chevron promises.
  if (danger)
    return (
      <button
        type="button"
        {...common}
        title={`Show the ${row.label.toLowerCase()}`}
        onClick={() => cockpitActions.openPanel?.(row.panel)}
        style={{
          ...common.style,
          width: "100%",
          background: "transparent",
          border: "none",
          borderBottom: common.style.borderBottom,
          color: "inherit",
          font: "inherit",
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        {content}
      </button>
    );
  return (
    <div
      {...common}
      title={seam ? "This risk's data source isn't wired yet" : `${row.count}`}
    >
      {content}
    </div>
  );
}
