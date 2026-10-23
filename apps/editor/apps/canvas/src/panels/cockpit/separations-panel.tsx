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

// Cockpit — Separations & Ink Limit (Prepress mode). §21 advanced
// prepress, the ink-coverage third of "Separations Preview, overprint
// preview, ink coverage".
//
// Two readings, and the difference between them is the point:
//
//  * INK LIMIT (swatches) — exact palette arithmetic from
//    `SwatchSummary.totalAreaCoveragePct`. No render, no profile, no
//    resolution. Catches a rich black built over the press limit
//    wherever it is used, including in hairlines the page reading
//    under-samples.
//  * PLATES (pages) — the rendered separation from the `inkCoverage`
//    collection: which plates each page needs and how heavily inked,
//    plus the total-area-coverage distribution.
//
// What this panel deliberately does NOT do: show a plate-isolated
// preview on the canvas. The canvas renders through Vello/WebGPU,
// which keeps no page-level ink-plane state — only the CPU rasterizer
// does. A plate view here would either be a second, differently-
// rendered image sitting next to the real canvas, or a fabrication.
// The engine CAN isolate plates (`paged-inspect --separations`); the
// canvas cannot yet, and the seam below says so rather than faking it.
//
// The honesty rule that governs every number here: `separatedPct` is
// how much of the page the raster lane could actually decompose into
// inks. Images, RGB/Lab swatches and gradients carry no ink
// decomposition and are excluded — as UNKNOWN, not as blank. And when
// `separationAvailable` is false there is no ink lane at all, which is
// a different problem with a different fix. Both bottom out at 0%;
// they must never render the same way.

import { useMemo, useState } from "react";
import {
  CockpitPanelHeader,
  CockpitSection,
  StatusPill,
  usePageNavigation,
  useCollection,
} from "@paged-media/shell";
import type { SwatchSummary } from "@paged-media/client";

import { defineMessages, useStrings } from "@paged-media/strings";

import type { InkCoverageSummary } from "./separations-wire";

const M = defineMessages("app.cockpitSeparationsPanel", {
  sheetFedCoated: "Sheet-fed coated",
  webCoated: "Web coated",
  uncoated: "Uncoated",
  newsprint: "Newsprint",
  title: "Separations & Ink Limit",
  pressInkLimit: "Press ink limit",
  tacNote:
    "Total area coverage — the sum of every plate’s ink. Re-reads the " +
    "stored distribution; no re-render.",
  swatchLimit: "Ink limit — swatches",
  withinLimit: "Within limit",
  over: "{count} over",
  swatchNote:
    "Exact, from the palette. Works with or without a colour profile, and " +
    "at any size — a 0.25 pt rich-black hairline is caught here even " +
    "though the page reading below under-samples it.",
  unseparable:
    "{count} swatch(es) — RGB, Lab or mixed-ink — have no ink breakdown " +
    "here; they separate at the RIP against the output intent, so their " +
    "ink limit cannot be checked before export.",
  plates: "Plates",
  openToSeparate: "Open a document to separate it.",
  noProfile:
    "No CMYK working profile is active, so the renderer resolves every " +
    "CMYK and spot swatch straight to display RGB and there are no plates " +
    "to read. This is not the same as the document carrying no ink. Add a " +
    "profile in Color Settings and this section fills in. The swatch " +
    "ink-limit check above is unaffected.",
  noPlates:
    "A profile is active, but nothing on any page carries ink the " +
    "renderer can separate — the artwork is RGB, gradients or placed " +
    "images. That content separates at the RIP; check the exported PDF " +
    "in Acrobat’s Output Preview.",
  spot: "spot",
  process: "process",
  coverageByPage: "Coverage by page",
  pagesOver: "{count, plural, one {# page over} other {# pages over}}",
  page: "Page {page}",
  pageStats: "max {max} · measured {measured}",
  pxOver: " · {count} px over",
  caveat:
    "“measured” is the share of the page the renderer could break into " +
    "inks. Placed images, RGB/Lab swatches and gradients are excluded — " +
    "unknown here, not ink-free — so a low figure means the page-level " +
    "numbers describe only part of the page. Sampled at {dpi} dpi, so " +
    "sub-pixel hairlines under-report; the swatch check above covers those.",
  platePreview: "Plate preview",
  platePreviewBefore:
    "Isolating a single plate on the canvas is not wired. The canvas " +
    "renders through WebGPU, which keeps no page-level ink-plane state — " +
    "only the CPU rasterizer does, and that is what the numbers above " +
    "come from. Rather than show a second, differently-rendered image " +
    "beside the real canvas, the plate rasters ship in the engine:",
  platePreviewAfter:
    "writes one PNG per plate plus an ink-limit overlay, with unmeasured " +
    "pixels left transparent.",
});

/** Histogram bucket width in percent — mirrors core's `TAC_BUCKET_PCT`. */
const BUCKET_PCT = 10;

/** Presets an operator actually prints against. */
const LIMIT_PRESETS = [
  { label: M.sheetFedCoated, value: 300 },
  { label: M.webCoated, value: 280 },
  { label: M.uncoated, value: 260 },
  { label: M.newsprint, value: 240 },
];

/**
 * Re-threshold a page's TAC histogram to `limit` without asking the
 * engine to render again. Bucket `i` covers `[i*10, (i+1)*10)`, so
 * every bucket strictly above the one containing `limit` is over —
 * plus, conservatively, none of the straddling bucket (we cannot tell
 * where inside it the pixels sit, and over-reporting a violation is as
 * wrong as under-reporting one).
 */
function overLimitFromHistogram(histogram: number[], limit: number): number {
  const firstOver = Math.floor(limit / BUCKET_PCT) + 1;
  let n = 0;
  for (let i = firstOver; i < histogram.length; i++) n += histogram[i] ?? 0;
  return n;
}

const pct = (v: number, digits = 1) => `${v.toFixed(digits)}%`;

export function SeparationsPanel() {
  const navigateToPages = usePageNavigation();
  const strings = useStrings();
  const coverage = useCollection<InkCoverageSummary>("inkCoverage");
  const swatches = useCollection<SwatchSummary>("swatches");
  const [limit, setLimit] = useState(300);

  // Swatches whose own total area coverage exceeds the limit. Exact,
  // and independent of whether a colour profile is active.
  const overLimitSwatches = (swatches ?? [])
    .filter(
      (s) =>
        typeof s.totalAreaCoveragePct === "number" &&
        s.totalAreaCoveragePct > limit,
    )
    .sort(
      (a, b) => (b.totalAreaCoveragePct ?? 0) - (a.totalAreaCoveragePct ?? 0),
    );

  // Swatches with no ink decomposition at all — they separate at the
  // RIP against the output intent, so the ink limit cannot be checked
  // here. Counted, not hidden.
  const unseparableSwatches = (swatches ?? []).filter(
    (s) => s.totalAreaCoveragePct == null,
  );

  const pages = coverage ?? [];
  const separationAvailable = pages.length > 0 && pages[0].separationAvailable;

  // The union of plates any page needs — the job's plate list.
  // eslint-disable-next-line no-restricted-syntax -- a computed block, not a single expression (ADR 229)
  const jobPlates = useMemo(() => {
    const seen = new Map<string, { name: string; isSpot: boolean }>();
    for (const page of pages) {
      for (const plate of page.plates) {
        if (plate.areaPct > 0 && !seen.has(plate.inkId)) {
          seen.set(plate.inkId, { name: plate.name, isSpot: plate.isSpot });
        }
      }
    }
    return [...seen.entries()].map(([inkId, v]) => ({ inkId, ...v }));
  }, [pages]);

  const pagesOverLimit = pages.filter(
    (p) => overLimitFromHistogram(p.histogram, limit) > 0,
  );

  return (
    <div data-separations-panel style={{ overflowY: "auto", height: "100%" }}>
      <CockpitPanelHeader title={strings.t(M.title)} />

      <CockpitSection title={strings.t(M.pressInkLimit)}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {LIMIT_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                data-ink-limit-preset={p.value}
                aria-pressed={limit === p.value}
                onClick={() => setLimit(p.value)}
                className="pg-ui-xs"
                style={{
                  border: "1px solid var(--pg-border)",
                  borderRadius: "var(--radius-sm)",
                  padding: "3px 7px",
                  background:
                    limit === p.value ? "var(--selected-bg)" : "transparent",
                  color: "inherit",
                  cursor: "pointer",
                }}
              >
                {strings.t(p.label)} {p.value}%
              </button>
            ))}
          </div>
          <span className="pg-ui-xs">{strings.t(M.tacNote)}</span>
        </div>
      </CockpitSection>

      <CockpitSection
        title={strings.t(M.swatchLimit)}
        right={
          swatches ? (
            <StatusPill
              tone={overLimitSwatches.length === 0 ? "ok" : "error"}
              testId="swatch-limit-state"
            >
              {overLimitSwatches.length === 0
                ? strings.t(M.withinLimit)
                : strings.t(M.over, { count: overLimitSwatches.length })}
            </StatusPill>
          ) : undefined
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="pg-ui-xs">{strings.t(M.swatchNote)}</span>
          {overLimitSwatches.map((s) => (
            <div
              key={s.selfId}
              data-swatch-over-limit={s.selfId}
              className="pg-ui-xs"
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
                border: "1px solid var(--pg-border)",
                borderLeft: "3px solid var(--status-error)",
                borderRadius: "var(--radius-sm)",
                padding: "4px 7px",
              }}
            >
              <span style={{ minWidth: 0, overflow: "hidden" }}>{s.name}</span>
              <span className="pg-mono-meta">
                {pct(s.totalAreaCoveragePct ?? 0, 0)}
              </span>
            </div>
          ))}
          {unseparableSwatches.length > 0 && (
            <span className="pg-ui-xs" data-swatch-unseparable>
              {strings.t(M.unseparable, { count: unseparableSwatches.length })}
            </span>
          )}
        </div>
      </CockpitSection>

      <CockpitSection
        title={strings.t(M.plates)}
        right={
          <span className="pg-mono-meta">
            {pages.length === 0 ? "—" : jobPlates.length}
          </span>
        }
      >
        {pages.length === 0 ? (
          <span className="pg-ui-xs">{strings.t(M.openToSeparate)}</span>
        ) : !separationAvailable ? (
          <div
            data-separations-unavailable
            className="pg-ui-xs"
            style={{
              border: "1px solid var(--pg-border)",
              borderLeft: "3px solid var(--status-review)",
              borderRadius: "var(--radius-sm)",
              padding: "6px 8px",
              lineHeight: 1.4,
            }}
          >
            {strings.t(M.noProfile)}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {jobPlates.length === 0 ? (
              <span className="pg-ui-xs" data-separations-no-plates>
                {strings.t(M.noPlates)}
              </span>
            ) : (
              jobPlates.map((p) => (
                <div
                  key={p.inkId}
                  data-job-plate={p.inkId}
                  className="pg-ui-xs"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <span>{p.name}</span>
                  <span className="pg-mono-meta">
                    {p.isSpot ? strings.t(M.spot) : strings.t(M.process)}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </CockpitSection>

      {separationAvailable && (
        <CockpitSection
          title={strings.t(M.coverageByPage)}
          right={
            <StatusPill
              tone={pagesOverLimit.length === 0 ? "ok" : "error"}
              testId="page-limit-state"
            >
              {pagesOverLimit.length === 0
                ? strings.t(M.withinLimit)
                : strings.t(M.pagesOver, { count: pagesOverLimit.length })}
            </StatusPill>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {pages.map((page) => {
              const over = overLimitFromHistogram(page.histogram, limit);
              return (
                <button
                  key={page.pageId}
                  type="button"
                  data-page-coverage={page.pageIndex}
                  onClick={() => navigateToPages([page.pageIndex])}
                  className="pg-ui-xs"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                    border: "1px solid var(--pg-border)",
                    borderLeft: `3px solid ${
                      over > 0 ? "var(--status-error)" : "var(--pg-border)"
                    }`,
                    borderRadius: "var(--radius-sm)",
                    padding: "4px 7px",
                    background: "transparent",
                    color: "inherit",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span>{strings.t(M.page, { page: page.pageIndex + 1 })}</span>
                  <span className="pg-mono-meta">
                    {strings.t(M.pageStats, {
                      max: pct(page.maxTacPct, 0),
                      measured: pct(page.separatedPct, 0),
                    })}
                    {over > 0 ? strings.t(M.pxOver, { count: over }) : ""}
                  </span>
                </button>
              );
            })}
            <span className="pg-ui-xs" data-separations-caveat>
              {strings.t(M.caveat, { dpi: pages[0]?.analysisDpi ?? 72 })}
            </span>
          </div>
        </CockpitSection>
      )}

      <CockpitSection title={strings.t(M.platePreview)}>
        <span className="pg-ui-xs" data-separations-preview-seam>
          {strings.t(M.platePreviewBefore)}{" "}
          <code>paged-inspect --separations DIR --cmyk-profile PROFILE</code>{" "}
          {strings.t(M.platePreviewAfter)}
        </span>
      </CockpitSection>
    </div>
  );
}
