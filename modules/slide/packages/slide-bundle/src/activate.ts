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
// engine builds the whole presentation as one native document (ADR 700,
// ADR 708), packaged as `.paged`: a
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
// deck's document once it is open, within their licences (ADR 707); a
// document reopened later gets them again from the source deck it keeps.
//
// The deck's comments (ADR 711, amendment 2026-10-25) are kept per slide in
// a container part, shown in the Comments panel and as markers on the
// slide, and written back by export. A deck holds the `slideDeck` document
// context (editor ADR 307), so PowerPoint's Normal-view keys (Cmd/Ctrl+M,
// Cmd/Ctrl+D, PageUp/PageDown) apply in it and nowhere else.

import type {
  BundleHandle,
  BundleHost,
  Diagnostic,
} from "@paged-media/plugin-api";
import { fromElementId } from "@paged-media/plugin-sdk";
import { t } from "@paged-media/strings";

import {
  animationTypedCommands,
  contributeAnimations,
  type AnimBinding,
} from "./anim/contribute.js";
import { ChartEditing, contributeCharts } from "./charts.js";
import { chartPlans, keepCharts } from "./charts-model.js";
import { contributeCommentMarkers } from "./comment-markers.js";
import { CommentsStore, fileFromReport } from "./comments-model.js";
import { contributeSlideCommands, DECK_CONTEXT } from "./commands.js";
import {
  deckPlan,
  documentBytes,
  exportDiagnostics,
  exportPlan,
  pageFingerprints,
} from "./deck-export.js";
import { slideEngine, type ImportReport } from "./engine.js";
import { giveDocumentEmbeddedFonts } from "./fonts.js";
import { contributeMenu } from "./menu.js";
import { COMMENTS, DECK, MASTERS, NOTES, SHAPES, SLIDES } from "./messages.js";
import {
  contributeSlideObjectModel,
  parseLabel,
  type DeckLabel,
} from "./object-model.js";
import { slidePanels } from "./panels.js";
import { makeCommentsPanel } from "./panels/comments-panel.js";
import { makeNotesPanel } from "./panels/notes-panel.js";
import { makeSlidesPanel } from "./panels/slides-panel.js";
import { SlidesStore } from "./slides-model.js";
import {
  contributeShow,
  showTypedCommands,
  SORTER_VIEW,
} from "./show/contribute.js";
import { SHOW } from "./messages.js";
import { makeSlideSorter } from "./views/slide-sorter.js";
import { makeSlideMaster } from "./views/slide-master.js";
import {
  contributeMasterCommands,
  MASTER_VIEW,
  masterTypedCommands,
  type MasterDeps,
} from "./masters-commands.js";
import { adjustHandlesOverlay, HandlesModel } from "./adjust-handles.js";
import { LiveFollower } from "./live-presets.js";
import { makeShapesPanel } from "./panels/shapes-panel.js";
import { insertShape, SHAPES_PANEL_ID } from "./shapes.js";
import { renderRasters } from "./pictures.js";
import {
  contentTypedCommands,
  contributeContentCommands,
  FormatClipboard,
  type ContentDeps,
} from "./content-commands.js";
import { SMARTART_PANEL_ID, SmartArtStore } from "./smartart.js";
import { makeSmartArtPanel } from "./panels/smartart-panel.js";
import { SMARTART } from "./messages.js";
import {
  contributeOutputCommands,
  CUSTOM_SHOWS_PANEL,
  EXPORT_VIEW,
  outputTypedCommands,
  type OutputUi,
} from "./output/commands.js";
import { makeExportView } from "./output/export-view.js";
import { Output } from "./output/output.js";
import { makeCustomShowsPanel } from "./panels/custom-shows-panel.js";
import { OUTPUT } from "./messages.js";

export const IMPORTER_ID = "media.paged.slide.importer.pptx";
export const SLIDES_PANEL_ID = "media.paged.slide.panel.slides";
export const NOTES_PANEL_ID = "media.paged.slide.panel.notes";
export const COMMENTS_PANEL_ID = "media.paged.slide.panel.comments";
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
export const TEMPLATE_EXPORTER_ID = "media.paged.slide.exporter.potx";
export const POTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.template";

/** The file name without its extension: the document's name. */
export function documentName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** A PowerPoint template (`.potx`): it opens as a new presentation. */
export function isTemplate(fileName: string): boolean {
  return /\.potx$/i.test(fileName.trim());
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
      message: t(DECK.fontsUsed, { fonts: report.fonts.join(", ") }),
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
export async function keepSource(
  host: BundleHost,
  bytes: Uint8Array,
  report: ImportReport,
  comments?: CommentsStore | null,
  workbooks: Uint8Array = new Uint8Array(),
): Promise<void> {
  if (!host.supports("storage.parts@1")) return;
  await host.parts.write(SOURCE_PART, bytes);
  await host.parts.write(
    REPORT_PART,
    new TextEncoder().encode(JSON.stringify(report)),
  );
  // Page i is slide i of the deck right after the open.
  const prints = await pageFingerprints(host);
  const byPart: Record<string, string> = {};
  report.slides.forEach((s, i) => {
    if (prints[i]) byPart[s.part] = prints[i];
  });
  await host.parts.write(
    FINGERPRINTS_PART,
    new TextEncoder().encode(JSON.stringify(byPart)),
  );
  // Each slide's comments, by the page it opened as.
  await comments?.replace(fileFromReport(report.slides));
  // Each chart's workbook (ADR 715).
  await keepCharts(host, report.charts, workbooks);
}

/**
 * Give a reopened deck document its embedded fonts again: a face lives as
 * long as the document it was given to (plugin-sdk ADR 330; for the editing
 * session on an older host), and the source deck kept as a container part
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
    ...diagnostics.map((message) => ({
      severity: "warning" as const,
      message,
      source: "pptx",
    })),
    ...refused,
  ]);
}

/** Whether the manifest asks for a rendering capability. */
function renders(host: BundleHost, what: string): boolean {
  const r = (host.manifest.capabilities as { rendering?: readonly string[] })
    .rendering;
  return Array.isArray(r) && r.includes(what);
}

export function activate(host: BundleHost): BundleHandle {
  const disposers: Array<() => void> = [];
  // The deck's comments, in a container part (needs the parts door).
  const comments = host.supports("storage.parts@1")
    ? new CommentsStore(host)
    : null;
  if (comments) disposers.push(() => comments.dispose());
  /** An import is opening its own document (which gets its fonts there). */
  let importing = false;

  /** The door that replaces the active document: the native-document door
   *  (the editor), else the documents door (headless hosts, the Node CLI). */
  function openDoor():
    ((paged: Uint8Array, name: string) => Promise<void>) | null {
    if (host.supports("document.openNative@1"))
      return (paged) => host.nativeDocument.open(paged);
    if (host.supports("documents.open@1")) {
      return async (paged, name) => {
        const r = await host.documents.open(paged, { name });
        if (!r.opened) throw new Error(`the host declined to open ${name}`);
      };
    }
    return null;
  }

  async function openDeck(
    name: string,
    bytes: Uint8Array,
  ): Promise<ImportReport | null> {
    const open = openDoor();
    if (!open) {
      host.diagnostics.set(IMPORT_DIAGNOSTICS, [
        {
          severity: "error",
          message: t(DECK.cannotOpen),
        },
      ]);
      return null;
    }
    const engine = await slideEngine();
    // A template opens as a new, untitled presentation built on it (slide
    // ADR 720; editor ADR 293's "a template says so").
    const template = isTemplate(name);
    const docName = template ? t(DECK.untitled) : documentName(name);
    const { paged, report, fonts, workbooks } = engine.importPptx(
      bytes,
      docName,
    );
    importing = true;
    let fontDiagnostics: Diagnostic[] = [];
    try {
      await open(paged, docName);
      // The faces once the deck's document is open: a face belongs to the
      // document open when it is given and is dropped when that document
      // closes (plugin-sdk ADR 330), so one given before the open would go
      // with the document the deck replaces. Before the source is kept, so
      // the fingerprints are read from the deck as it is drawn.
      fontDiagnostics = await giveDocumentEmbeddedFonts(
        host,
        report.embeddedFonts,
        fonts,
      );
      await keepSource(host, bytes, report, comments, workbooks);
    } finally {
      importing = false;
    }
    // The importer wrote every label into the package (each slide's page
    // label, each placeholder's, and the deck label on the document, ADR
    // 703), so the open makes no edit: the deck opens clean, with nothing
    // to undo (UX audit F-08).
    const diagnostics = [
      ...(template
        ? [
            {
              severity: "info" as const,
              message: t(DECK.fromTemplate, { name: documentName(name) }),
              source: "pptx",
            },
          ]
        : []),
      ...reportDiagnostics(report),
      ...fontDiagnostics,
    ];
    host.diagnostics.set(IMPORT_DIAGNOSTICS, diagnostics);
    host.log.info(
      `paged.slide: opened ${name}: ${report.slides.length} slide(s), ` +
        `${report.diagnostics.length} diagnostic(s)`,
    );
    return report;
  }

  // Insert ▸ Shapes and the typed insertShape command (ADR 717).
  async function insertPreset(args: {
    prst: string;
    pageId: string;
    center: [number, number];
    w?: number;
    h?: number;
  }) {
    const id = await insertShape(host, await slideEngine(), args);
    return id
      ? { address: fromElementId(id) }
      : { refused: `the preset ${args.prst} could not be inserted` };
  }

  /** The import report the deck kept (its own timings), or null. */
  async function readReport(): Promise<ImportReport | null> {
    if (!host.supports("storage.parts@1")) return null;
    try {
      const bytes = await host.parts.read(REPORT_PART);
      return bytes
        ? (JSON.parse(new TextDecoder().decode(bytes)) as ImportReport)
        : null;
    } catch {
      return null;
    }
  }

  // The slides store is made below (it needs the page doors); the object
  // model's navigation reads it when a command runs.
  let store: SlidesStore | null = null;
  const step = async (by: -1 | 1): Promise<string | null> => {
    const slide = store?.isDeck() ? store.activeSlide() : null;
    const target = slide ? store!.list()[slide.number - 1 + by] : undefined;
    if (!target || !host.supports("viewport.pages@1")) return null;
    return (await host.viewport.goToPage(target.pageId)) ? target.pageId : null;
  };
  // The slide show's typed commands are registered with the model, which
  // comes first; they run the show once it is contributed below.
  let runShow: ((id: string) => Promise<boolean>) | null = null;
  let animBinding: AnimBinding | null = null;
  let playCustom: ((name: string) => Promise<boolean>) | null = null;
  // The deck's outputs (slide ADR 720): PDF, outline, template, video,
  // custom shows and sections; made once the store exists.
  let output: Output | null = null;
  let outputUi: OutputUi | null = null;
  // Slide W4's content verbs: pictures and icons, the format painter, the
  // SmartArt text pane (content-commands.ts).
  const clipboard = new FormatClipboard();
  const smartArt = new SmartArtStore(host);
  disposers.push(() => smartArt.dispose());
  let textPane = false;
  const content: ContentDeps = {
    engine: slideEngine,
    activePage: () => store?.activePage() ?? null,
    openTextPane: () => {
      if (!textPane || !host.supports("shell.openPanel@1")) return false;
      host.shell.openPanel(SMARTART_PANEL_ID);
      return true;
    },
  };
  // Slide ADR 712 — masters and layouts.
  const masterDeps: MasterDeps = {
    activePage: () => store?.activePage() ?? null,
    deckOpen: () => (store ? store.isDeck() : false),
    views: host.supports("contribute.view@1") && host.supports("shell.views@1"),
  };
  const model = contributeSlideObjectModel(host, {
    openDeck,
    exportDeck,
    extraCommands: showTypedCommands((id) =>
      runShow ? runShow(id) : Promise.resolve(false),
    ),
    // The output's typed commands, the animations' twins (slide ADR 714,
    // bound below) and the content verbs', in the manifest's order.
    outputCommands: [
      ...outputTypedCommands(
        () => output,
        () => outputUi,
      ),
      ...animationTypedCommands(() => animBinding),
      // Pictures, icons, the format painter and SmartArt text (slide ADR
      // 717 amendment).
      ...contentTypedCommands(host, content, clipboard),
      // Masters and layouts (slide ADR 712), last in the manifest.
      ...masterTypedCommands(host, masterDeps),
    ],
    comments: () => comments,
    step,
    activePage: () => store?.activePage() ?? null,
    insertShape: insertPreset,
  });
  if (model) disposers.push(() => model.dispose());

  // A deck document opened another way (File ▸ Open of a saved document,
  // or already open when the bundle activates) gets its embedded fonts
  // from the source deck it keeps.
  const reload = () => {
    if (importing) return;
    reloadEmbeddedFonts(host).catch((err: unknown) =>
      host.log.warn(
        `paged.slide: embedded fonts of the open deck: ${String(err)}`,
      ),
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
        title: t(DECK.format),
        extensions: [".pptx", ".ppsx", ".potx"],
        mimeTypes: [PPTX_MIME],
        import: async ({ name, bytes }) => {
          await openDeck(name, bytes);
        },
      }).dispose,
    );
  }

  // The deck's own name (the document label's `deck.name`): an opened deck
  // document can have no name, since the native open door carries none.
  async function deckName(): Promise<string> {
    try {
      const label = parseLabel<DeckLabel>(
        await host.document.getDocumentMetadata(),
      );
      return (label?.deck?.name ?? "").replace(/[\\/:*?"<>|]/g, "").trim();
    } catch {
      return "";
    }
  }

  // PPTX export: the deck the document was imported from, rewritten for
  // the document's slides (order, duplicates, deletions, hidden, notes) and
  // what is on them (ADR 704, ADR 711).
  async function exportDeck(format: "pptx" | "potx" = "pptx") {
    if (!host.supports("storage.parts@1")) return null;
    const original = await host.parts.read(SOURCE_PART);
    if (!original) {
      host.diagnostics.set(EXPORT_DIAGNOSTICS, [
        {
          severity: "error",
          message: t(DECK.notFromDeck),
        },
      ]);
      return null;
    }
    const printsBytes = await host.parts.read(FINGERPRINTS_PART);
    const prints = printsBytes
      ? (JSON.parse(new TextDecoder().decode(printsBytes)) as Record<
          string,
          string
        >)
      : {};
    await comments?.ready();
    const plan = await exportPlan(host, prints, comments?.current() ?? null);
    const document = await documentBytes(host);
    const engine = await slideEngine();
    const deck = {
      ...(await deckPlan(host, format)),
      charts: await chartPlans(host),
    };
    let out = engine.exportPptx(original, plan, document, deck);
    // Pictures PowerPoint cannot hold as they are (an SVG's fallback, a
    // WebP, …): the host renders them, and the deck is written again.
    if (out.rastersNeeded.length > 0) {
      const rasters = await renderRasters(host, out.rastersNeeded);
      if (Object.keys(rasters).length > 0)
        out = engine.exportPptx(original, plan, document, { ...deck, rasters });
    }
    host.diagnostics.set(EXPORT_DIAGNOSTICS, exportDiagnostics(out));
    const meta = await host.document.meta();
    const name =
      (meta as { documentName?: string }).documentName?.trim() ||
      (await deckName()) ||
      "presentation";
    return {
      bytes: out.bytes,
      fileName: `${name}.${format}`,
      diagnostics: [...out.diagnostics, ...out.notExported],
      notExported: out.notExported,
    };
  }

  if (
    host.supports("contribute.exporter@1") &&
    host.supports("storage.parts@1")
  ) {
    disposers.push(
      host.contribute.exporter({
        id: EXPORTER_ID,
        title: t(DECK.format),
        extension: ".pptx",
        mimeType: PPTX_MIME,
        export: () => exportDeck("pptx"),
      }).dispose,
      // File ▸ Save as template (slide ADR 720).
      host.contribute.exporter({
        id: TEMPLATE_EXPORTER_ID,
        title: t(DECK.templateFormat),
        extension: ".potx",
        mimeType: POTX_MIME,
        export: () => exportDeck("potx"),
      }).dispose,
    );
  }

  // The slide panels and the palette commands share one store: the pages,
  // their state, thumbnails and the active slide. It needs the v70 page
  // doors; the panels also need the panel and snapshot doors.
  store = host.supports("viewport.pages@1") ? new SlidesStore(host) : null;
  if (store) {
    const s = store;
    disposers.push(() => s.dispose());
  }
  output = new Output(host, {
    store: () => store,
    engine: slideEngine,
    exportTemplate: () => exportDeck("potx"),
    readReport,
    deckName: async () => {
      const meta = (await host.document.meta()) as { documentName?: string };
      return meta.documentName?.trim() || (await deckName()) || "presentation";
    },
    playCustomShow: () => playCustom,
  });

  // The deck's document context (editor ADR 307): a deck is slide content
  // on every page, so its Normal-view keys apply wherever the user is in
  // it. The context is registered for that alone (no frame is entered by
  // double-click); the host drops it when the document is replaced, and
  // the store says again whether the new one is a deck.
  let deckContext = false;
  if (
    store &&
    host.supports("contribute.editContext@1") &&
    host.supports("shell.documentContext@1")
  ) {
    const s = store;
    disposers.push(
      host.contribute.editContext({
        type: DECK_CONTEXT,
        entry: "doubleClick",
        matches: () => false,
      }).dispose,
    );
    deckContext = true;
    let held = false;
    const sync = () => {
      const want = s.isDeck();
      if (want === held) return;
      held = want;
      host.shell.setDocumentContext(want ? DECK_CONTEXT : null);
    };
    if (host.supports("document.onDidOpen@1")) {
      disposers.push(
        host.document.onDidOpen(() => {
          held = false; // the host dropped it with the old document
        }).dispose,
      );
    }
    disposers.push(s.subscribe(sync));
    sync();
  }
  const richPanels =
    store !== null &&
    host.supports("contribute.panel@1") &&
    host.supports("render.snapshot@1");

  // The user's verbs for the palette and the menu bar (commands.ts,
  // menu.ts): open and export a deck; new, duplicate, delete and move the
  // active slide.
  // Live presets and connectors (ADR 717): a resized preset is drawn
  // again, a connector follows the shapes it is glued to, in the edit's
  // undo step; the selected preset's adjust handles are drawn on the
  // canvas.
  // The follow-up write needs the amend door; without it a redraw would be
  // an undo step of its own, so nothing follows.
  if (host.supports("document.mutate.amend@1")) {
    const follower = new LiveFollower(host, slideEngine, () =>
      store ? store.isDeck() : true,
    );
    disposers.push(() => follower.dispose());
  }
  if (host.supports("contribute.overlay@1") && renders(host, "overlay")) {
    const handles = new HandlesModel(host, slideEngine);
    const overlay = host.contribute.overlay(adjustHandlesOverlay(handles));
    disposers.push(
      () => overlay.dispose(),
      () => handles.dispose(),
    );
  }

  if (host.supports("contribute.command@1")) {
    const commands = contributeSlideCommands(host, {
      store,
      objectModel: model !== null,
      openDeck,
      exportDeck,
      scopedKeys: deckContext,
      ...(comments && host.supports("shell.openPanel@1")
        ? { openComments: () => host.shell.openPanel(COMMENTS_PANEL_ID) }
        : {}),
      shapesPanel: richPanels ? SHAPES_PANEL_ID : undefined,
    });
    const menu = contributeMenu(host, (id) => commands.ids.has(id));
    const contentCommands = contributeContentCommands(
      host,
      content,
      clipboard,
      {
        deckOpen: () => (store ? store.isDeck() : false),
        scopedKeys: deckContext,
        deckContext: DECK_CONTEXT,
      },
    );
    disposers.push(
      () => commands.dispose(),
      () => menu.dispose(),
      () => contentCommands.dispose(),
    );
  }

  // Slide ADR 716 — Slide Show, Presenter View, Rehearse Timings (one
  // presentation, extensions ADR 345) and View ▸ Slide Sorter (a module
  // view in place of the canvas).
  if (store && host.supports("contribute.command@1")) {
    const show = contributeShow(
      host,
      {
        store,
        engine: slideEngine,
        readReport,
        customShowPages: async (name) => {
          const shows = (await output?.shows.list()) ?? [];
          return shows.find((c) => c.name === name)?.pages ?? null;
        },
      },
      host.supports("contribute.view@1") && host.supports("render.snapshot@1")
        ? () =>
            host.contribute.view({
              id: SORTER_VIEW,
              title: t(SHOW.slideSorter),
              render: makeSlideSorter(host, store),
            })
        : null,
    );
    runShow = show.run;
    playCustom = show.playCustomShow;
    disposers.push(() => {
      runShow = null;
      playCustom = null;
      show.dispose();
    });
  }

  // Slide ADR 712 — View ▸ Slide Master (a module view) and Reset Slide.
  if (store && host.supports("contribute.command@1")) {
    if (masterDeps.views && host.supports("render.snapshot@1")) {
      disposers.push(
        host.contribute.view({
          id: MASTER_VIEW,
          title: t(MASTERS.slideMaster),
          render: makeSlideMaster(host),
        }).dispose,
      );
    } else masterDeps.views = false;
    const cmds = contributeMasterCommands(host, masterDeps);
    disposers.push(() => cmds.dispose());
  }

  // File ▸ Export… (a module view), Save as template, Custom Shows… and
  // Add Section (slide ADR 720).
  if (store && output && host.supports("contribute.command@1")) {
    const s = store;
    const o = output;
    const views =
      host.supports("contribute.view@1") && host.supports("shell.views@1");
    if (views) {
      disposers.push(
        host.contribute.view({
          id: EXPORT_VIEW,
          title: t(OUTPUT.title),
          render: makeExportView(host, o),
        }).dispose,
      );
    }
    const panels = host.supports("contribute.panel@1");
    if (panels) {
      disposers.push(
        host.contribute.panel({
          id: CUSTOM_SHOWS_PANEL,
          title: t(OUTPUT.showsTitle),
          component: makeCustomShowsPanel(host, s, o),
          defaultDock: "right",
          rail: false,
          // A play triangle over a list.
          iconSvg:
            '<path d="M4 6h9M4 10h9M4 14h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
            '<path d="M14 13l6 3.5-6 3.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
        }).dispose,
      );
    }
    outputUi = {
      openExport: () => (views ? host.shell.showView(EXPORT_VIEW) : false),
      openCustomShows: () => {
        if (panels && host.supports("shell.openPanel@1"))
          host.shell.openPanel(CUSTOM_SHOWS_PANEL);
      },
    };
    const cmds = contributeOutputCommands(
      host,
      o,
      outputUi,
      () => s.isDeck() && s.list().length > 0,
    );
    disposers.push(() => {
      outputUi = null;
      cmds.dispose();
    });
  }

  if (store && richPanels) {
    const s = store;
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
          title: t(SLIDES.title),
          component: makeSlidesPanel(host, s),
          defaultDock: "left",
          rail,
          // Three stacked slides.
          iconSvg:
            '<rect x="7" y="3.5" width="12" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
            '<rect x="7" y="13.5" width="12" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
            '<path d="M4 5v14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
        }).dispose,
        host.contribute.panel({
          id: SHAPES_PANEL_ID,
          title: t(SHAPES.title),
          component: makeShapesPanel(host, store, slideEngine),
          defaultDock: "right",
          // A square, a circle and a triangle.
          iconSvg:
            '<rect x="3.5" y="3.5" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
            '<circle cx="17" cy="7.5" r="4" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
            '<path d="M12 20.5l4.5-7 4.5 7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
        }).dispose,
        host.contribute.panel({
          id: SMARTART_PANEL_ID,
          title: t(SMARTART.title),
          component: makeSmartArtPanel(host, smartArt),
          defaultDock: "right",
          rail: false,
          // Three lines of an outline beside a diagram's boxes.
          iconSvg:
            '<path d="M3.5 6h6M5.5 10h4M5.5 14h4M3.5 18h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
            '<rect x="13" y="4" width="7.5" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
            '<rect x="13" y="15" width="7.5" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
            '<path d="M16.75 9v6" fill="none" stroke="currentColor" stroke-width="1.6"/>',
        }).dispose,
        host.contribute.panel({
          id: NOTES_PANEL_ID,
          title: t(NOTES.title),
          component: makeNotesPanel(host, s),
          defaultDock: "bottom",
          rail,
          // A slide with lines of notes under it.
          iconSvg:
            '<rect x="5" y="3.5" width="14" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
            '<path d="M5 15h14M5 18.5h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
        }).dispose,
      );
      if (comments) {
        panelDisposers.push(
          host.contribute.panel({
            id: COMMENTS_PANEL_ID,
            title: t(COMMENTS.title),
            component: makeCommentsPanel(host, s, comments),
            defaultDock: "right",
            rail,
            // A speech bubble.
            iconSvg:
              '<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
          }).dispose,
        );
      }
    };
    registerPanels(s.isDeck());
    textPane = true;
    disposers.push(
      s.subscribe(() => {
        if (s.isDeck() !== railed) registerPanels(s.isDeck());
      }),
      () => {
        for (const d of panelDisposers.splice(0)) d();
      },
    );
  }

  // Slide ADR 714 — the Animations pane, Preview on the canvas, the
  // Animation Painter and their commands.
  if (store) {
    const anims = contributeAnimations(host, store, slideEngine, {
      panel: richPanels,
      overlay:
        host.supports("contribute.overlay@1") && renders(host, "overlay"),
    });
    animBinding = anims.binding;
    disposers.push(() => {
      animBinding = null;
      anims.dispose();
    });
  }

  // Live charts (ADR 715): a chart frame is entered by double-click; its
  // workbook opens in the chart data sheet (the context's frame surface)
  // and the chart is redrawn when the user leaves.
  if (host.supports("storage.parts@1")) {
    const editing = new ChartEditing(host);
    disposers.push(...contributeCharts(host, editing), () => editing.dispose());
  }

  // The comment markers on the active slide (the host's overlay layers).
  if (store && comments) {
    const markers = contributeCommentMarkers(host, store, comments);
    if (markers) disposers.push(() => markers.dispose());
  }

  // ADR 323 — the slide, transition, notes, placeholder and deck fields as
  // host-rendered PropertyFields (schema panels of property rows; they need
  // the object model the rows address). The Notes panel above owns the
  // notes panel id where it is contributed; the notes property row is the
  // fallback for hosts without the page doors.
  if (model && host.supports("contribute.schemaPanel@1")) {
    for (const schema of slidePanels()) {
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
