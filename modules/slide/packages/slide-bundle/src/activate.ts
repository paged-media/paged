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
import { contributeSlideObjectModel, importLabelMutations } from "./object-model.js";

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

  /** The door that replaces the active document: the native-document door
   *  (the editor), else the documents door (headless hosts, the Node CLI). */
  function openDoor(): ((idml: Uint8Array, name: string) => Promise<void>) | null {
    if (host.supports("document.openNative@1")) return (idml) => host.nativeDocument.open(idml);
    if (host.supports("documents.open@1")) {
      return async (idml, name) => {
        const r = await host.documents.open(idml, { name });
        if (!r.opened) throw new Error(`the host declined to open ${name}`);
      };
    }
    return null;
  }

  async function openDeck(name: string, bytes: Uint8Array): Promise<ImportReport | null> {
    const open = openDoor();
    if (!open) {
      host.diagnostics.set(IMPORT_DIAGNOSTICS, [
        {
          severity: "error",
          message: "This host cannot open a native document, so a PowerPoint deck cannot be opened.",
        },
      ]);
      return null;
    }
    const engine = await slideEngine();
    const { idml, report } = engine.importPptx(bytes, documentName(name));
    await open(idml, documentName(name));
    // The parts belong to the document just opened, so they are written
    // after it replaced the previous one. They are a cache: the labels
    // written next are what the object model reads (ADR 703).
    if (host.supports("storage.parts@1")) {
      await host.parts.write(SOURCE_PART, bytes);
      await host.parts.write(REPORT_PART, new TextEncoder().encode(JSON.stringify(report)));
    }
    const labels = importLabelMutations(report, documentName(name));
    const written = await host.document.mutate({ op: "batch", args: { ops: labels.mutations as never } });
    const diagnostics = reportDiagnostics(report);
    if (!written.applied) {
      diagnostics.push({ severity: "warning", message: "The slide labels could not be written; slide data is read from the import cache.", source: "pptx" });
    } else if (labels.dropped.length > 0) {
      diagnostics.push({ severity: "info", message: `Speaker notes of ${labels.dropped.length} slide(s) exceed the label cap and are kept in the import cache only.`, source: "pptx" });
    }
    host.diagnostics.set(IMPORT_DIAGNOSTICS, diagnostics);
    host.log.info(
      `paged.slide: opened ${name}: ${report.slides.length} slide(s), ` +
        `${report.diagnostics.length} diagnostic(s)`,
    );
    return report;
  }

  const model = contributeSlideObjectModel(host, { openDeck });
  if (model) disposers.push(() => model.dispose());

  if (host.supports("contribute.importer@1")) {
    disposers.push(
      host.contribute.importer({
        id: IMPORTER_ID,
        title: "PowerPoint presentation (.pptx)",
        extensions: [".pptx", ".ppsx", ".potx"],
        mimeTypes: [PPTX_MIME],
        import: async ({ name, bytes }) => {
          await openDeck(name, bytes);
        },
      }).dispose,
    );
  }

  return {
    dispose() {
      for (const d of disposers.splice(0).reverse()) d();
    },
  };
}
