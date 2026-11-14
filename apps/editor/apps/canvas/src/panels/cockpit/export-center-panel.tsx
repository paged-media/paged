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

// Cockpit — the Export Center (kit canvas.jsx: Export mode's
// CENTRED work-area readiness table).
//
// W2.6 (Full-Green) — honest-or-live. Every row is one or the other:
//   • LIVE rows run a REAL action through the published client surface
//     — Print PDF opens the ExportPdfDialog; Page images run the inline
//     PNG export (`requestSnapshot`); IDML serialises the package
//     (`exportIdml`). Their readiness pill reads the real document/
//     working-space state.
//   • HONEST rows (web / social / package) are visible, disabled "soon"
//     seams until the multi-format publishing pipeline lands.
// Row selection syncs the Outputs nav (left) and the Export inspector
// (right) through the shared selected-target store.
//
// Editor ADR 1221 (guided export): the readiness the table shows is the
// export's own check (`pdfReadiness`, the one the PDF dialog runs before
// it starts), so "Fix issues first" lights when the document has issues
// and opens Publication health, which leads to each; every run says how
// it ended through the editor's one feedback service (the file and where
// it went, or why there is none). Presets live in the PDF dialog.

import { useState } from "react";

import { ChoiceGroup, ChoiceRow } from "@paged-media/panel-kit";

import {
  CockpitBtn,
  Icon,
  StatusPill,
  notifyExportPdfDialog,
  pdfReadiness,
  useEditorScope,
  printOutputFacts,
  useCanvasClient,
  useCollection,
  useDocument,
  useDocumentMeta,
  useDocumentStats,
  useRegistries,
  useRegistryView,
  type PrintOutputFacts,
} from "@paged-media/shell";
import type { FontSummary, LinkSummary } from "@paged-media/client";

import {
  EXPORT_TARGETS,
  exportTargetById,
  exportReadiness,
  reportImageExport,
  runImageExport,
  runPluginExport,
  setSelectedExportTarget,
  useImageSettings,
  useSelectedExportTarget,
  type ExportTarget,
  type ExportTargetId,
} from "./export-targets";
import { defineMessages, useStrings, type Strings } from "@paged-media/strings";

const M = defineMessages("app.cockpitExportCenterPanel", {
  soon: "soon",
  title: "Export Center",
  outputsAvailable:
    "{count, plural, one {# output available} other {# outputs available}}",
  noDocument: "no document",
  intro:
    "Publish every format from one place. Readiness is checked before " +
    "export.",
  outputs: "Outputs",
  working: "Working…",
  export: "Export…",
  fromPlugin: "{extension} · from a plugin",
  ready: "ready",
  fixIssues: "Fix issues first",
  issues:
    "{count, plural, one {# issue to review} other {# issues to review}} before export",
  noIssues: "No issues found before export",
  exportSelected: "Export selected",
});

function rowReadiness(
  strings: Strings,
  t: ExportTarget,
  loaded: boolean,
  facts: PrintOutputFacts,
): ReturnType<typeof exportReadiness> {
  return exportReadiness(t, loaded, facts, strings.t(M.soon));
}

export function ExportCenterPanel() {
  const scope = useEditorScope();
  const strings = useStrings();
  const client = useCanvasClient();
  const meta = useDocumentMeta();
  const { handle } = useDocument();
  const loaded = meta != null && meta.pageCount > 0;
  // The print-output facts (ADR 266): the same derivation Health, the
  // Document Map and the Prepress bar read.
  const facts = printOutputFacts(meta);
  const selected = useSelectedExportTarget();
  const image = useImageSettings();
  const [busy, setBusy] = useState<ExportTargetId | null>(null);
  // The plugins' exporters (paged.publish's IDML, a sheet's .xlsx), as
  // rows of the same table: "every format from one place" (PN-309). A
  // view of the registry, so one a bundle registers later is listed too.
  const registries = useRegistries();
  const pluginExporters = useRegistryView(registries.exporters).list();
  const [pluginBusy, setPluginBusy] = useState<string | null>(null);
  const runPlugin = async (id: string) => {
    const exporter = pluginExporters.find((e) => e.id === id);
    if (!exporter || !loaded) return;
    setPluginBusy(id);
    await runPluginExport(scope, exporter).finally(() => setPluginBusy(null));
  };
  // The export's own check (ADR 1221), on the standard the document can
  // meet: what it warns about is what "Fix issues first" leads to.
  const fonts = useCollection<FontSummary>("fonts");
  const links = useCollection<LinkSummary>("links");
  const stats = useDocumentStats();
  const issues = pdfReadiness(
    {
      standard: facts.standard,
      outputIntentProfile: "",
      colorPolicy: "preserveNumbers",
      pageScope: "all",
      pageFrom: "1",
      pageTo: "1",
      useDocumentBleed: true,
      bleedPt: "0",
      downsample: "off",
    },
    {
      loaded,
      pageCount: meta?.pageCount ?? 0,
      currentPage: 0,
      print: facts,
      pages: null,
      fonts,
      links,
      oversetStories: stats?.overset_stories ?? null,
      documentName: meta?.documentName ?? "",
    },
  ).filter((c) => c.level !== "ok");

  const liveCount =
    EXPORT_TARGETS.filter((t) => t.live).length + pluginExporters.length;

  // Run the selected (or a given) LIVE target's real action.
  const runTarget = async (id: ExportTargetId) => {
    const t = exportTargetById(id);
    if (!t.live || !loaded || !handle) return;
    if (t.action === "dialog") {
      notifyExportPdfDialog(scope, "open");
      return;
    }
    setBusy(id);
    // IDML export is now the paged.publish plugin exporter (ADR-022 Phase 5),
    // rendered via the plugin-exporters section, not a built-in target. A
    // promise chain, not try/finally (the React Compiler, ADR 229).
    const run =
      t.action === "image"
        ? runImageExport(client, {
            pageIds: handle.pageIds,
            pageSizesPt: handle.pageSizesPt,
            settings: image,
            baseName: meta?.documentName,
          }).then(
            (result) =>
              reportImageExport(scope, image, result, handle.pageIds.length),
            (err: unknown) =>
              reportImageExport(
                scope,
                image,
                { error: err instanceof Error ? err.message : String(err) },
                handle.pageIds.length,
              ),
          )
        : Promise.resolve();
    await run.finally(() => setBusy(null));
  };

  return (
    <div
      data-export-center
      style={{
        height: "100%",
        overflowY: "auto",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        // It opens in the 320 px right dock as often as in the centre, so
        // the gutters and the rows give way when it is narrow.
        padding: "24px 16px",
      }}
    >
      <div
        style={{ width: "min(680px, 100%)", fontFamily: "var(--font-sans)" }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: 4,
          }}
        >
          <h2
            style={{
              fontFamily: "var(--font-display-serif)",
              fontSize: 30,
              fontWeight: 680,
              letterSpacing: "-0.02em",
              color: "var(--pg-fg)",
              margin: 0,
              whiteSpace: "nowrap",
            }}
          >
            {strings.t(M.title)}
          </h2>
          <span className="pg-ui-xs">
            {loaded
              ? strings.t(M.outputsAvailable, { count: liveCount })
              : strings.t(M.noDocument)}
          </span>
        </div>
        <p
          className="pg-ui-sm"
          style={{ color: "var(--pg-muted-fg)", margin: "0 0 20px" }}
        >
          {strings.t(M.intro)}
        </p>

        <div
          style={{
            borderRadius: "var(--radius-xl)",
            border: "1px solid var(--pg-border)",
            overflow: "hidden",
            background: "var(--elevated)",
          }}
        >
          <ChoiceGroup label={strings.t(M.outputs)}>
            {EXPORT_TARGETS.map((t, i) => {
              const sel = selected === t.id;
              const r = rowReadiness(strings, t, loaded, facts);
              const running = busy === t.id;
              return (
                <ChoiceRow
                  key={t.id}
                  data-export-target={t.id}
                  data-export-live={t.live ? "" : undefined}
                  data-selected={sel || undefined}
                  checked={sel}
                  onChoose={() => setSelectedExportTarget(scope, t.id)}
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: "8px 13px",
                    padding: "13px 16px",
                    borderTop: i ? "1px solid var(--pg-border)" : "none",
                    cursor: "pointer",
                    background: sel ? "var(--selected-bg)" : "transparent",
                    opacity: t.live ? 1 : 0.6,
                  }}
                >
                  <Icon
                    name={t.icon}
                    size={19}
                    style={{ color: "var(--pg-muted-fg)", flexShrink: 0 }}
                  />
                  <div style={{ flex: "1 1 160px", minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 500 }}>
                      {t.title}
                    </div>
                    <div className="pg-ui-xs" style={{ marginTop: 1 }}>
                      {t.note}
                    </div>
                  </div>
                  {t.live ? (
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        marginLeft: "auto",
                      }}
                    >
                      <StatusPill
                        tone={r.tone}
                        testId={`readiness-${t.id}`}
                        title={r.reason}
                      >
                        {r.label}
                      </StatusPill>
                      <CockpitBtn
                        sm
                        primary
                        disabled={!loaded || running}
                        testId={`export-center-${t.id}`}
                        onClick={() => void runTarget(t.id)}
                      >
                        {running ? strings.t(M.working) : strings.t(M.export)}
                      </CockpitBtn>
                    </span>
                  ) : (
                    <StatusPill tone="draft">{strings.t(M.soon)}</StatusPill>
                  )}
                </ChoiceRow>
              );
            })}
          </ChoiceGroup>
          {pluginExporters.map((e) => (
            <div
              key={e.id}
              data-export-plugin={e.id}
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "8px 13px",
                padding: "13px 16px",
                borderTop: "1px solid var(--pg-border)",
              }}
            >
              <Icon
                name="ui-export"
                size={19}
                style={{ color: "var(--pg-muted-fg)", flexShrink: 0 }}
              />
              <div style={{ flex: "1 1 160px", minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500 }}>{e.title}</div>
                <div className="pg-ui-xs" style={{ marginTop: 1 }}>
                  {strings.t(M.fromPlugin, { extension: e.extension })}
                </div>
              </div>
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginLeft: "auto",
                }}
              >
                <StatusPill tone={loaded ? "ready" : "draft"}>
                  {loaded ? strings.t(M.ready) : strings.t(M.noDocument)}
                </StatusPill>
                <CockpitBtn
                  sm
                  primary
                  disabled={!loaded || pluginBusy === e.id}
                  testId={`export-center-plugin-${e.id}`}
                  onClick={() => void runPlugin(e.id)}
                >
                  {pluginBusy === e.id
                    ? strings.t(M.working)
                    : strings.t(M.export)}
                </CockpitBtn>
              </span>
            </div>
          ))}
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
            marginTop: 18,
            justifyContent: "flex-end",
          }}
        >
          <span
            className="pg-ui-xs"
            data-export-issues={loaded ? issues.length : undefined}
            style={{ alignSelf: "center", marginRight: "auto" }}
          >
            {loaded
              ? issues.length > 0
                ? strings.t(M.issues, { count: issues.length })
                : strings.t(M.noIssues)
              : null}
          </span>
          <CockpitBtn
            disabled={!loaded || issues.length === 0}
            testId="export-fix-issues"
            onClick={() =>
              void registries.commands.invoke(
                "paged.panel.show.paged.publication-health",
              )
            }
          >
            {strings.t(M.fixIssues)}
          </CockpitBtn>
          <CockpitBtn
            primary
            disabled={
              !loaded || busy != null || !exportTargetById(selected).live
            }
            testId="export-selected"
            onClick={() => void runTarget(selected)}
          >
            <Icon name="ui-export" size={15} /> {strings.t(M.exportSelected)}
          </CockpitBtn>
        </div>
      </div>
    </div>
  );
}
