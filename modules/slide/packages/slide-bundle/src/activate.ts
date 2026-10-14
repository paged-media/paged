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
//
// The object model (ADR 323) addresses the deck, its slides, layouts and
// placeholders through host.objects; the slide, transition, notes,
// placeholder and deck fields are host-rendered property rows over it.
//
// The fonts the deck embeds are decoded by the engine and given to the
// document before it opens, within their licences (ADR 707); a document
// reopened later gets them again from the source deck it keeps.

import type { BundleHandle, BundleHost, Diagnostic } from "@paged-media/plugin-api";

import { exportPlan, pageFingerprints } from "./deck-export.js";
import { slideEngine, type ImportReport } from "./engine.js";
import { giveDocumentEmbeddedFonts } from "./fonts.js";
import { contributeSlideObjectModel, importLabelMutations } from "./object-model.js";
import { SLIDE_PANELS } from "./panels.js";
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
/** Diagnostics key for the embedded fonts of a reopened deck. */
export const FONT_DIAGNOSTICS = "media.paged.slide/fonts";
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

/**
 * Give a reopened deck document its embedded fonts again: the faces live
 * for an editing session, and the source deck kept as a container part
 * still holds them. Does nothing for a document that is not a deck.
 */
export async function reloadEmbeddedFonts(host: BundleHost): Promise<void> {
  if (!host.supports("storage.parts@1")) return;
  let source: Uint8Array | null;
  try {
    source = await host.parts.read(SOURCE_PART);
  } catch {
    return; // no document open
  }
  if (!source) return;
  const engine = await slideEngine();
  const { faces, diagnostics, data } = engine.embeddedFonts(source);
  if (faces.length === 0) return;
  const refused = await giveDocumentEmbeddedFonts(host, faces, data);
  host.diagnostics.set(FONT_DIAGNOSTICS, [
    ...diagnostics.map((message) => ({ severity: "warning" as const, message, source: "pptx" })),
    ...refused,
  ]);
}

export function activate(host: BundleHost): BundleHandle {
  const disposers: Array<() => void> = [];
  /** An import is opening its own document (which gets its fonts there). */
  let importing = false;

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
    const { idml, report, fonts } = engine.importPptx(bytes, documentName(name));
    importing = true;
    let fontDiagnostics: Diagnostic[] = [];
    try {
      // The faces first, so the deck lays out in them from the start.
      fontDiagnostics = await giveDocumentEmbeddedFonts(host, report.embeddedFonts, fonts);
      await open(idml, documentName(name));
      await keepSource(host, bytes, report);
    } finally {
      importing = false;
    }
    // The importer already wrote each slide's page label and every
    // placeholder's label into the package; the deck label goes on the
    // document the object model reads (ADR 703).
    const labels = importLabelMutations(report, documentName(name));
    const written = await host.document.mutate({ op: "batch", args: { ops: labels.mutations as never } });
    const diagnostics = [...reportDiagnostics(report), ...fontDiagnostics];
    if (!written.applied) {
      diagnostics.push({ severity: "warning", message: "The deck label could not be written; deck data is read from the import cache.", source: "pptx" });
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

  // A deck document opened another way (File ▸ Open of a saved document,
  // or already open when the bundle activates) gets its embedded fonts
  // from the source deck it keeps.
  const reload = () => {
    if (importing) return;
    reloadEmbeddedFonts(host).catch((err: unknown) =>
      host.log.warn(`paged.slide: embedded fonts of the open deck: ${String(err)}`),
    );
  };
  if (host.supports("document.onDidOpen@1")) {
    disposers.push(host.document.onDidOpen(reload).dispose);
  }
  reload();

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
  const richPanels =
    host.supports("contribute.panel@1") &&
    host.supports("render.snapshot@1") &&
    host.supports("viewport.pages@1");
  if (richPanels) {
    const store = new SlidesStore(host);
    disposers.push(() => store.dispose());
    // In the panel rail only while a deck is open: in any other document
    // the Slides and Notes launchers would sit beside the host's panels
    // with nothing to show. The rail reads `rail` at registration, so a
    // change of document re-registers both panels with the new flag.
    let railed: boolean | null = null;
    const panelDisposers: Array<() => void> = [];
    const registerPanels = (rail: boolean) => {
      for (const d of panelDisposers.splice(0)) d();
      railed = rail;
      panelDisposers.push(
        host.contribute.panel({
          id: SLIDES_PANEL_ID,
          title: "Slides",
          component: makeSlidesPanel(host, store),
          defaultDock: "left",
          rail,
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
          rail,
          // A slide with lines of notes under it.
          iconSvg:
            '<rect x="5" y="3.5" width="14" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
            '<path d="M5 15h14M5 18.5h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
        }).dispose,
      );
    };
    registerPanels(store.isDeck());
    disposers.push(
      store.subscribe(() => {
        if (store.isDeck() !== railed) registerPanels(store.isDeck());
      }),
      () => {
        for (const d of panelDisposers.splice(0)) d();
      },
    );
  }

  // ADR 323 — the slide, transition, notes, placeholder and deck fields as
  // host-rendered PropertyFields (schema panels of property rows; they need
  // the object model the rows address). The Notes panel above owns the
  // notes panel id where it is contributed; the notes property row is the
  // fallback for hosts without the page doors.
  if (model && host.supports("contribute.schemaPanel@1")) {
    for (const schema of SLIDE_PANELS) {
      if (richPanels && schema.id === NOTES_PANEL_ID) continue;
      const d = host.contribute.schemaPanel({
        id: schema.id,
        title: schema.title,
        icon: schema.icon,
        defaultDock: schema.defaultDock,
        schema,
      });
      disposers.push(() => d.dispose());
    }
  }

  return {
    dispose() {
      for (const d of disposers.splice(0).reverse()) d();
    },
  };
}
