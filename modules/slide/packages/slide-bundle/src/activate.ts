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
// as the document; the source deck and the import report (notes,
// transitions, hidden slides, per-item placeholder identity) are kept as
// this plugin's container parts (ADR 703) until pages can carry plugin
// metadata.

import type { BundleHandle, BundleHost, Diagnostic } from "@paged-media/plugin-api";

import { slideEngine, type ImportReport } from "./engine.js";

export const IMPORTER_ID = "media.paged.slide.importer.pptx";
export const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
/** Diagnostics key for what an import met and could not render. */
export const IMPORT_DIAGNOSTICS = "media.paged.slide/import";
/** Container parts (this plugin's namespace). */
export const SOURCE_PART = "source/original.pptx";
export const REPORT_PART = "import/report.json";

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
    // The parts belong to the document just opened, so they are written
    // after it replaced the previous one.
    if (host.supports("storage.parts@1")) {
      await host.parts.write(SOURCE_PART, bytes);
      await host.parts.write(REPORT_PART, new TextEncoder().encode(JSON.stringify(report)));
    }
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

  return {
    dispose() {
      for (const d of disposers.splice(0).reverse()) d();
    },
  };
}
