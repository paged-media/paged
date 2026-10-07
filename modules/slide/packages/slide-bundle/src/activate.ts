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

// activate(host) for paged.slide: File ▸ Open of a PowerPoint deck. The
// engine writes the whole presentation as one IDML package (ADR 700): a
// master spread per used layout, a page per slide, every shape, story and
// picture with PowerPoint's inheritance already resolved. The host opens it
// as the document. Each slide's notes, hidden flag and transition ride its
// page as plugin metadata (written by the importer); the source deck and the
// import report are kept as this plugin's container parts (ADR 703).
//
// The Slides and Notes panels work on any document's pages: a sorter with
// engine-rendered thumbnails (reorder, duplicate, delete, hide) and the
// active slide's speaker notes.

import type { BundleHandle, BundleHost, Diagnostic } from "@paged-media/plugin-api";

import { exportPlan, pageFingerprints } from "./deck-export.js";
import { slideEngine, type ImportReport } from "./engine.js";
import { makeNotesPanel } from "./panels/notes-panel.js";
import { makeSlidesPanel } from "./panels/slides-panel.js";
import { SlidesStore } from "./slides-model.js";

export const IMPORTER_ID = "media.paged.slide.importer.pptx";
export const SLIDES_PANEL_ID = "media.paged.slide.panel.slides";
export const NOTES_PANEL_ID = "media.paged.slide.panel.notes";
export const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
/** Diagnostics key for what an import met and could not render. */
export const IMPORT_DIAGNOSTICS = "media.paged.slide/import";
/** Container parts (this plugin's namespace). */
export const SOURCE_PART = "source/original.pptx";
export const REPORT_PART = "import/report.json";
/** Each imported slide's content fingerprint, by slide part (export
 *  compares a page against it to tell an edited slide). */
export const FINGERPRINTS_PART = "import/fingerprints.json";
export const EXPORTER_ID = "media.paged.slide.exporter.pptx";
export const EXPORT_DIAGNOSTICS = "media.paged.slide/export";

/** The file name without its extension: the document's name. */
export function documentName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** The import report as diagnostics: what was not drawn, and the fonts the
 *  deck needs (the engine substitutes any it does not have). */
export function reportDiagnostics(report: ImportReport): Diagnostic[] {
  const out: Diagnostic[] = report.diagnostics.map((message) => ({
    severity: "warning" as const,
    message,
    source: "pptx",
  }));
  if (report.fonts.length > 0) {
    out.push({
      severity: "info",
      message: `Fonts used: ${report.fonts.join(", ")}`,
      source: "pptx",
    });
  }
  return out;
}

/**
 * What the importer keeps once the deck is the open document, as container
 * parts (they belong to that document, so they are written after it
 * replaced the previous one): the source deck, the import report and each
 * slide's content fingerprint, which export compares pages against.
 */
export async function keepSource(host: BundleHost, bytes: Uint8Array, report: ImportReport): Promise<void> {
  if (!host.supports("storage.parts@1")) return;
  await host.parts.write(SOURCE_PART, bytes);
  await host.parts.write(REPORT_PART, new TextEncoder().encode(JSON.stringify(report)));
  // Page i is slide i of the deck right after the open.
  const prints = await pageFingerprints(host);
  const byPart: Record<string, string> = {};
  report.slides.forEach((s, i) => {
    if (prints[i]) byPart[s.part] = prints[i];
  });
  await host.parts.write(FINGERPRINTS_PART, new TextEncoder().encode(JSON.stringify(byPart)));
}

export function activate(host: BundleHost): BundleHandle {
  const disposers: Array<() => void> = [];

  async function openDeck(name: string, bytes: Uint8Array): Promise<void> {
    if (!host.supports("document.openNative@1")) {
      host.diagnostics.set(IMPORT_DIAGNOSTICS, [
        {
          severity: "error",
          message: "This host cannot open a native document, so a PowerPoint deck cannot be opened.",
        },
      ]);
      return;
    }
    const engine = await slideEngine();
    const { idml, report } = engine.importPptx(bytes, documentName(name));
    await host.nativeDocument.open(idml);
    await keepSource(host, bytes, report);
    host.diagnostics.set(IMPORT_DIAGNOSTICS, reportDiagnostics(report));
    host.log.info(
      `paged.slide: opened ${name}: ${report.slides.length} slide(s), ` +
        `${report.diagnostics.length} diagnostic(s)`,
    );
  }

  if (host.supports("contribute.importer@1")) {
    disposers.push(
      host.contribute.importer({
        id: IMPORTER_ID,
        title: "PowerPoint presentation (.pptx)",
        extensions: [".pptx", ".ppsx", ".potx"],
        mimeTypes: [PPTX_MIME],
        import: ({ name, bytes }) => openDeck(name, bytes),
      }).dispose,
    );
  }

  // PPTX export: the deck the document was imported from, rewritten for
  // the document's slides (order, duplicates, deletions, hidden, notes).
  async function exportDeck() {
    const original = await host.parts.read(SOURCE_PART);
    if (!original) {
      host.diagnostics.set(EXPORT_DIAGNOSTICS, [
        {
          severity: "error",
          message: "This document was not opened from a PowerPoint deck, so it cannot be exported as one yet.",
        },
      ]);
      return null;
    }
    const printsBytes = await host.parts.read(FINGERPRINTS_PART);
    const prints = printsBytes
      ? (JSON.parse(new TextDecoder().decode(printsBytes)) as Record<string, string>)
      : {};
    const plan = await exportPlan(host, prints);
    const engine = await slideEngine();
    const out = engine.exportPptx(original, plan);
    host.diagnostics.set(
      EXPORT_DIAGNOSTICS,
      out.diagnostics.map((message) => ({ severity: "warning" as const, message, source: "pptx" })),
    );
    const meta = await host.document.meta();
    const name = (meta as { documentName?: string }).documentName?.trim() || "presentation";
    return { bytes: out.bytes, fileName: `${name}.pptx` };
  }

  if (host.supports("contribute.exporter@1") && host.supports("storage.parts@1")) {
    disposers.push(
      host.contribute.exporter({
        id: EXPORTER_ID,
        title: "PowerPoint presentation (.pptx)",
        extension: ".pptx",
        mimeType: PPTX_MIME,
        export: exportDeck,
      }).dispose,
    );
  }

  // The slide panels share one store: the pages, their state, thumbnails
  // and the active slide. They need the v70 page doors.
  if (
    host.supports("contribute.panel@1") &&
    host.supports("render.snapshot@1") &&
    host.supports("viewport.pages@1")
  ) {
    const store = new SlidesStore(host);
    disposers.push(() => store.dispose());
    disposers.push(
      host.contribute.panel({
        id: SLIDES_PANEL_ID,
        title: "Slides",
        component: makeSlidesPanel(host, store),
        defaultDock: "left",
        rail: true,
        // Three stacked slides.
        iconSvg:
          '<rect x="7" y="3.5" width="12" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
          '<rect x="7" y="13.5" width="12" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
          '<path d="M4 5v14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
      }).dispose,
      host.contribute.panel({
        id: NOTES_PANEL_ID,
        title: "Notes",
        component: makeNotesPanel(host, store),
        defaultDock: "bottom",
        rail: true,
        // A slide with lines of notes under it.
        iconSvg:
          '<rect x="5" y="3.5" width="14" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
          '<path d="M5 15h14M5 18.5h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
      }).dispose,
    );
  }

  return {
    dispose() {
      for (const d of disposers.splice(0).reverse()) d();
    },
  };
}
