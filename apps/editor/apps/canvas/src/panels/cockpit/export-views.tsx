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

// Cockpit — Export mode's split surfaces (kit: left Outputs nav +
// right per-target Export inspector; the Export Center table itself
// is the canvas-area main view, export-center-panel.tsx).
//
// W2.6 (Full-Green) — honest-or-live. Three outputs are LIVE through
// the published client surface: Print PDF (the ExportPdfDialog),
// Page images (PNG via `requestSnapshot`, inline DPI/scope settings),
// and the IDML package (`exportIdml`). Web bundle / Social crops /
// Print package are HONEST concept seams (visible, disabled, "soon").
// The shared selected-target store keeps the three panels in sync.

import { useState } from "react";

import { defineMessages, t, useStrings } from "@paged-media/strings";

import { ChoiceGroup, ChoiceRow } from "@paged-media/panel-kit";

import {
  CockpitBtn,
  CockpitPanelHeader,
  CockpitSection,
  Icon,
  StatusPill,
  notifyExportPdfDialog,
  useEditorScope,
  printOutputFacts,
  useCanvasClient,
  useDocument,
  useDocumentMeta,
  useRegistries,
  useRegistryView,
  type PanelProps,
  type PrintOutputFacts,
} from "@paged-media/shell";

import {
  EXPORT_TARGETS,
  exportTargetById,
  exportReadiness,
  runImageExport,
  runPluginExporter,
  setImageSettings,
  setSelectedExportTarget,
  useImageSettings,
  useSelectedExportTarget,
  type ExportTarget,
} from "./export-targets";

const M = defineMessages("app.cockpitExportViews", {
  outputs: "Outputs",
  pluginExports: "Plugin exports",
  rangeNamesNoPage: `"{range}" names no page in this {count}-page document.`,
  settings: "Settings",
  dialogSettings:
    "Standard, bleed, marks and image downsampling are set in the " +
    "export dialog — one place, applied per run.",
  exportTarget: "Export {target}",
  resolution: "Resolution",
  dpiScreen: "72 ppi (screen)",
  dpiProof: "150 ppi (proof)",
  dpiPrint: "300 ppi (print)",
  format: "Format",
  png: "PNG (lossless, alpha)",
  jpeg: "JPEG (smaller, no alpha)",
  quality: "Quality",
  q60: "60% (smallest)",
  q90: "90% (default)",
  q100: "100% (largest)",
  pages: "Pages",
  allPages: "All",
  currentPage: "Current page",
  rangeOption: "Range…",
  range: "Range",
  rendering: "Rendering…",
  exportPageImages: "Export page images",
  exportedPng: "Exported {count, plural, one {# PNG} other {# PNGs}}.",
  exportedJpeg: "Exported {count, plural, one {# JPEG} other {# JPEGs}}.",
  exportFailed: "Export failed: {message}",
  honestNote:
    "{note}. This output lands with the multi-format publishing pipeline.",
});

// Re-export the model so existing importers (export-center-panel,
// the specs) keep their import paths.
export {
  EXPORT_TARGETS,
  setSelectedExportTarget,
  useSelectedExportTarget,
  type ExportTarget,
} from "./export-targets";

/** Per-target readiness pill tone + label (`exportReadiness`). */
function readiness(
  target: ExportTarget,
  loaded: boolean,
  facts: PrintOutputFacts,
): ReturnType<typeof exportReadiness> {
  return exportReadiness(target, loaded, facts);
}

/** Export mode — LEFT panel: outputs navigation (kit ExportNavPanel).
 *  Status dots reflect real per-target readiness. */
export function OutputsPanel(_props: PanelProps) {
  const scope = useEditorScope();
  const strings = useStrings();
  const meta = useDocumentMeta();
  const loaded = meta != null && meta.pageCount > 0;
  const facts = printOutputFacts(meta);
  const selected = useSelectedExportTarget();
  // K-2 / S-06 — plugin-registered exporters surface as one-click
  // outputs here (the host owns blob→download). The Export Center is the
  // one place documents AND plugin-contributed outputs are exported.
  const exporters = useRegistryView(useRegistries().exporters);
  const pluginExporters = exporters.list();
  const [exportPhase, setExportPhase] = useState<{
    id: string;
    kind: "running" | "done" | "error";
  } | null>(null);

  const onRunExporter = async (id: string) => {
    const exporter = pluginExporters.find((e) => e.id === id);
    if (!exporter) return;
    setExportPhase({ id, kind: "running" });
    setExportPhase({ id, kind: await exporterOutcome(exporter) });
  };

  return (
    <div
      data-outputs-panel
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        fontFamily: "var(--font-sans)",
      }}
    >
      <CockpitPanelHeader title={strings.t(M.outputs)} />
      <div style={{ flex: 1, overflowY: "auto", padding: "2px 8px" }}>
        <ChoiceGroup label={strings.t(M.outputs)}>
          {EXPORT_TARGETS.map((t) => {
            const sel = selected === t.id;
            const r = readiness(t, loaded, facts);
            const dot =
              r.tone === "ready"
                ? "var(--status-approved)"
                : r.tone === "warn"
                  ? "var(--status-review)"
                  : "var(--status-draft)";
            return (
              <ChoiceRow
                key={t.id}
                data-output-nav={t.id}
                data-output-live={t.live ? "" : undefined}
                data-selected={sel || undefined}
                checked={sel}
                onChoose={() => setSelectedExportTarget(scope, t.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 10px",
                  borderRadius: "var(--radius-lg)",
                  cursor: "pointer",
                  background: sel ? "var(--selected-bg)" : "transparent",
                  marginBottom: 1,
                  opacity: t.live ? 1 : 0.6,
                }}
              >
                <Icon
                  name={t.icon}
                  size={16}
                  style={{ color: "var(--pg-muted-fg)", flexShrink: 0 }}
                />
                <span
                  style={{
                    flex: 1,
                    fontSize: 12.5,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {t.title}
                </span>
                <span
                  data-output-dot={r.tone}
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: dot,
                    flexShrink: 0,
                  }}
                />
              </ChoiceRow>
            );
          })}
        </ChoiceGroup>

        {pluginExporters.length > 0 && (
          <div data-plugin-exports style={{ marginTop: 10 }}>
            <div
              className="pg-ui-xs"
              style={{
                padding: "6px 10px 2px",
                color: "var(--pg-muted-fg)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                fontSize: 10.5,
              }}
            >
              {strings.t(M.pluginExports)}
            </div>
            {pluginExporters.map((e) => {
              const phase = exportPhase?.id === e.id ? exportPhase.kind : null;
              return (
                <div
                  key={e.id}
                  data-plugin-export={e.id}
                  onClick={() => void onRunExporter(e.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "9px 10px",
                    borderRadius: "var(--radius-lg)",
                    cursor: "pointer",
                    marginBottom: 1,
                  }}
                >
                  <Icon
                    name="ui-export"
                    size={16}
                    style={{ color: "var(--pg-muted-fg)", flexShrink: 0 }}
                  />
                  <span
                    style={{
                      flex: 1,
                      fontSize: 12.5,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {e.title}
                  </span>
                  {phase === "running" && (
                    <span
                      className="pg-ui-xs"
                      style={{ color: "var(--pg-muted-fg)" }}
                    >
                      …
                    </span>
                  )}
                  {phase === "done" && (
                    <span
                      className="pg-ui-xs"
                      style={{ color: "var(--status-approved)" }}
                    >
                      ✓
                    </span>
                  )}
                  {phase === "error" && (
                    <span
                      className="pg-ui-xs"
                      style={{ color: "var(--status-error)" }}
                    >
                      !
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

type ImagePhase =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; files: number }
  | { kind: "error"; message: string };

// The two runs settle outside the components: the React Compiler does not
// compile a component with a conditional inside a `try` (ADR 229).

/** A plugin exporter's run, as the outputs row shows it. */
async function exporterOutcome(
  exporter: Parameters<typeof runPluginExporter>[0],
): Promise<"done" | "error"> {
  try {
    return (await runPluginExporter(exporter)) ? "done" : "error";
  } catch {
    return "error";
  }
}

/** The image export's outcome. */
async function imageExportPhase(
  client: Parameters<typeof runImageExport>[0],
  handle: { pageIds: string[]; pageSizesPt: [number, number][] },
  image: Parameters<typeof runImageExport>[1]["settings"],
  baseName: string | undefined,
): Promise<ImagePhase> {
  try {
    const { files, refused } = await runImageExport(client, {
      pageIds: handle.pageIds,
      pageSizesPt: handle.pageSizesPt,
      settings: image,
      baseName,
    });
    if (refused === "range") {
      // A refusal is a RESULT, not an exception — the range simply
      // named no page in this document, and saying so beats both a
      // thrown error and a silent zero-file "success".
      return {
        kind: "error",
        message: t(M.rangeNamesNoPage, {
          range: image.range,
          count: handle.pageIds.length,
        }),
      };
    }
    return { kind: "done", files };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Export mode — RIGHT inspector: per-target settings (kit
 *  ExportInspector). LIVE targets carry real inline settings + a real
 *  run action; HONEST targets carry the concept seam. */
export function ExportInspectorPanel(_props: PanelProps) {
  const scope = useEditorScope();
  const strings = useStrings();
  const client = useCanvasClient();
  const meta = useDocumentMeta();
  const { handle } = useDocument();
  const loaded = meta != null && meta.pageCount > 0;
  const facts = printOutputFacts(meta);
  const selected = useSelectedExportTarget();
  const target = exportTargetById(selected);
  const image = useImageSettings();
  const [imagePhase, setImagePhase] = useState<ImagePhase>({ kind: "idle" });
  // IDML export moved to the paged.publish plugin exporter (ADR-022 Phase 5) —
  // it renders in the plugin-exporters section below, no longer a built-in target.
  const r = readiness(target, loaded, facts);

  const onRunImage = async () => {
    if (!handle) return;
    setImagePhase({ kind: "running" });
    setImagePhase(
      await imageExportPhase(client, handle, image, meta?.documentName),
    );
  };

  return (
    <div
      data-export-inspector-panel
      style={{ overflowY: "auto", height: "100%" }}
    >
      <CockpitPanelHeader title={target.title} />
      <div style={{ padding: "0 14px 12px" }}>
        <StatusPill
          tone={r.tone}
          testId="export-inspector-readiness"
          title={r.reason}
        >
          {r.label}
        </StatusPill>
      </div>

      {target.action === "dialog" && (
        <>
          <CockpitSection title={strings.t(M.settings)}>
            <span className="pg-ui-xs" style={{ lineHeight: 1.45 }}>
              {strings.t(M.dialogSettings)}
            </span>
          </CockpitSection>
          <div style={{ padding: 14 }}>
            <CockpitBtn
              full
              primary
              disabled={!loaded}
              testId="export-inspector-run"
              onClick={() => notifyExportPdfDialog(scope, "open")}
            >
              <Icon name="ui-export" size={15} />{" "}
              {strings.t(M.exportTarget, { target: target.title })}
            </CockpitBtn>
          </div>
        </>
      )}

      {target.action === "image" && (
        <>
          <CockpitSection title={strings.t(M.settings)}>
            <div
              data-export-image-settings
              style={{ display: "flex", flexDirection: "column", gap: 10 }}
            >
              <SettingRow label={strings.t(M.resolution)}>
                <select
                  data-export-image-dpi
                  value={String(image.dpi)}
                  disabled={!loaded}
                  onChange={(e) =>
                    setImageSettings(scope, {
                      dpi: Number(e.target.value) as 72 | 150 | 300,
                    })
                  }
                >
                  <option value="72">{strings.t(M.dpiScreen)}</option>
                  <option value="150">{strings.t(M.dpiProof)}</option>
                  <option value="300">{strings.t(M.dpiPrint)}</option>
                </select>
              </SettingRow>
              <SettingRow label={strings.t(M.format)}>
                <select
                  data-export-image-format
                  value={image.format}
                  disabled={!loaded}
                  onChange={(e) =>
                    setImageSettings(scope, {
                      format: e.target.value as "png" | "jpeg",
                    })
                  }
                >
                  <option value="png">{strings.t(M.png)}</option>
                  <option value="jpeg">{strings.t(M.jpeg)}</option>
                </select>
              </SettingRow>
              {image.format === "jpeg" ? (
                <SettingRow label={strings.t(M.quality)}>
                  <select
                    data-export-image-quality
                    value={String(image.quality)}
                    disabled={!loaded}
                    onChange={(e) =>
                      setImageSettings(scope, {
                        quality: Number(e.target.value),
                      })
                    }
                  >
                    <option value="0.6">{strings.t(M.q60)}</option>
                    <option value="0.8">80%</option>
                    <option value="0.9">{strings.t(M.q90)}</option>
                    <option value="1">{strings.t(M.q100)}</option>
                  </select>
                </SettingRow>
              ) : null}
              <SettingRow label={strings.t(M.pages)}>
                <select
                  data-export-image-scope
                  value={image.scope}
                  disabled={!loaded}
                  onChange={(e) =>
                    setImageSettings(scope, {
                      scope: e.target.value as "all" | "current" | "range",
                    })
                  }
                >
                  <option value="all">
                    {strings.t(M.allPages)} ({loaded ? meta.pageCount : 0})
                  </option>
                  <option value="current">{strings.t(M.currentPage)}</option>
                  <option value="range">{strings.t(M.rangeOption)}</option>
                </select>
              </SettingRow>
              {image.scope === "range" ? (
                <SettingRow label={strings.t(M.range)}>
                  <input
                    data-export-image-range
                    type="text"
                    placeholder="1-3, 5"
                    value={image.range}
                    disabled={!loaded}
                    onChange={(e) =>
                      setImageSettings(scope, { range: e.target.value })
                    }
                  />
                </SettingRow>
              ) : null}
            </div>
          </CockpitSection>
          <div style={{ padding: 14 }}>
            <CockpitBtn
              full
              primary
              disabled={!loaded || imagePhase.kind === "running"}
              testId="export-inspector-run-image"
              onClick={() => void onRunImage()}
            >
              <Icon name="ui-export" size={15} />{" "}
              {imagePhase.kind === "running"
                ? strings.t(M.rendering)
                : strings.t(M.exportPageImages)}
            </CockpitBtn>
            {imagePhase.kind === "done" && (
              <div
                data-export-image-done
                className="pg-ui-xs"
                style={{ marginTop: 8, color: "var(--status-approved)" }}
              >
                {strings.t(
                  image.format === "jpeg" ? M.exportedJpeg : M.exportedPng,
                  { count: imagePhase.files },
                )}
              </div>
            )}
            {imagePhase.kind === "error" && (
              <div
                className="pg-ui-xs"
                style={{ marginTop: 8, color: "var(--status-error)" }}
              >
                {strings.t(M.exportFailed, { message: imagePhase.message })}
              </div>
            )}
          </div>
        </>
      )}

      {!target.live && (
        <CockpitSection title={strings.t(M.settings)}>
          <span className="pg-ui-xs" style={{ lineHeight: 1.45 }}>
            {strings.t(M.honestNote, { note: target.note })}
          </span>
        </CockpitSection>
      )}
    </div>
  );
}

function SettingRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 12.5,
        fontFamily: "var(--font-sans)",
      }}
    >
      <span style={{ width: 88, color: "var(--pg-muted-fg)" }}>{label}</span>
      {children}
    </label>
  );
}
