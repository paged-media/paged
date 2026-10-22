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

// Step 3d / 3h — the canonical file-open command. The header file
// picker and (3h+) the Cmd+K palette both resolve through this
// contribution so there's a single load path.

import { getAiAvailability } from "../../ai/availability";
import { createBlankDocument, loadDocumentFile } from "../document-loader";
import { importReplaceAllowed, setPendingImportSource } from "../import-source";
import { pageForPicture, pictureSize } from "../picture-size";
import { confirmDiscard, isReplaceDeclined } from "../replace-guard";

export { confirmDiscard };
import type { DocumentHandle } from "@paged-media/client";
import type { ImporterContribution } from "../../registries";
import type { PagedEditor } from "../paged-editor";
import type { CommandContribution } from "../../registries";

export const PAGED_FILE_OPEN_IDML = "paged.file.openIdml";
export const PAGED_FILE_NEW = "paged.file.new";
export const PAGED_FILE_NEW_FROM_BRIEF = "paged.file.newFromBrief";

/** US Letter in points — InDesign's default new-document size. */
const LETTER_PT: readonly [number, number] = [612, 792];

/**
 * Build the File ▸ New command. Mints a blank single-page document via
 * the engine ([`CanvasClient.newBlankDocument`]) and runs it through the
 * same document-state orchestration as Open, so the menu, palette, and
 * tests all reach one path. Asks first when the open document has
 * unsaved edits (`confirmDiscard`, the one replace guard, ADR 230).
 */
export function buildNewDocumentCommand(options: {
  setStatus: (s: string) => void;
  pushWarning: (w: string) => void;
  defaultSizePt?: readonly [number, number];
}): CommandContribution {
  return {
    id: PAGED_FILE_NEW,
    title: "New document",
    category: "File",
    handler: async (paged) => {
      const editor = paged as PagedEditor;
      if (!(await confirmDiscard(editor, "Creating a new document"))) return;
      await mintBlankDocument(
        editor,
        options.defaultSizePt ?? LETTER_PT,
        options,
      );
    },
  };
}

/**
 * Mint a blank document of a given size, WITHOUT asking to discard.
 *
 * Factored out of the `File ▸ New` handler so a caller that knows there
 * is nothing to discard can reuse the same callback wiring instead of
 * copying it. Exactly one such caller exists: solo mode's boot artboard.
 *
 * WHY THE GUARD MUST NOT BE ON THIS PATH. `confirmDiscard` asks a
 * question, which on a freshly-opened application is a modal asking
 * whether to discard a document that does not exist — and its platform
 * fallback is auto-DISMISSED under Playwright when nothing listens, so
 * the boot document would silently never be created and every plugin
 * menu entry would stay greyed (the SDK gates them on `pageCount > 0`).
 * The two failure modes are a nonsense dialog and an invisible no-op;
 * neither belongs at boot.
 */
export async function mintBlankDocument(
  editor: PagedEditor,
  sizePt: readonly [number, number],
  sinks: {
    setStatus: (s: string) => void;
    pushWarning: (w: string) => void;
  },
): Promise<DocumentHandle | null> {
  const [widthPt, heightPt] = sizePt;
  return createBlankDocument(
    editor.client,
    { widthPt, heightPt },
    {
      setHandle: editor.document.setHandle,
      setSourceName: editor.document.setSourceName,
      setLoading: editor.document.setLoading,
      setStatus: sinks.setStatus,
      setSnapshotsReady: editor.document.setSnapshotsReady,
      addSnapshot: (pageId, url) => {
        editor.document.setSnapshots((prev) => {
          const next = new Map(prev);
          next.set(pageId, url);
          return next;
        });
      },
      resetForNewDocument: editor.document.resetForNewDocument,
      pushWarning: sinks.pushWarning,
    },
  );
}

/**
 * Build the file-open command contribution. The `pickFile` thunk
 * is supplied at registration time so the shell stays decoupled
 * from the DOM-level mechanism (file input, drag-drop, palette
 * invocation, OS file dialog) — every entry point hands in its
 * own picker and the loader runs identically afterward.
 */
export function buildOpenIdmlCommand(options: {
  pickFile: () => Promise<File | null>;
  setStatus: (s: string) => void;
  pushWarning: (w: string) => void;
}): CommandContribution {
  return {
    id: PAGED_FILE_OPEN_IDML,
    // "Open…", not "Open IDML…": the picker's accept list is computed from
    // the importer registry, so this door opens every registered format
    // (.idml, .svg, .xlsx, images, .docx, …). Command id keeps the historic
    // name for test/config stability.
    title: "Open…",
    category: "File",
    handler: async (paged) => {
      const file = await options.pickFile();
      if (!file) return;
      await openFile(paged as PagedEditor, file, options);
    },
  };
}

/**
 * Open a file the user chose: picked through File ▸ Open…, dropped on the
 * canvas, or handed to the shell's file input. ONE path for all of them,
 * so a drop asks exactly what File ▸ Open asks (F-01: the drop used to
 * replace an edited document without a word).
 *
 * K-2 / S-06 — a registered plugin importer may claim the file type
 * (paged.sheet's .xlsx, paged.pdf's .pdf). The bytes go to the importer,
 * which owns what the file becomes; one that REPLACES the document does
 * so through `host.nativeDocument.open`, whose backend asks the same
 * question there (an importer that adds a frame asks nothing). Every
 * other file replaces the document through the one IDML load path, after
 * the question.
 */
export async function openFile(
  editor: PagedEditor,
  file: File,
  sinks: {
    setStatus: (s: string) => void;
    pushWarning: (w: string) => void;
  },
): Promise<void> {
  const nothingOpen = !hasDocument(editor);
  // UX audit F-03 (ADR 262): a picture opened with nothing open becomes a
  // document, one page the picture's size with the picture placed on it,
  // rather than a panel beside an empty canvas.
  if (nothingOpen && (await openPictureAsDocument(editor, file, sinks))) {
    return;
  }
  const importer = editor.registries.importers.resolve(file.name, file.type);
  if (importer) {
    const outcome = await runImporter(importer, file, sinks);
    // An importer that only ADDS content (a workbook's range, …) and found
    // nothing open left the canvas empty: give it a document and run it
    // again, told the document is new so it places its content there
    // (F-03, ADR 262). One that opened a document, failed or was declined
    // is done.
    if (nothingOpen && outcome === "added") {
      const handle = await mintBlankDocument(editor, LETTER_PT, sinks);
      if (!handle) return;
      await liveEditorWith(editor, handle);
      await runImporter(importer, file, sinks, { newDocument: true });
    }
    return;
  }
  // The guard sits HERE, not before the picker and not before the
  // importer routing above. Asking before the picker interrupts a
  // gesture the user may abandon anyway, and a plugin importer does
  // not necessarily replace the document — paged.sheet's .xlsx adds
  // a frame. This branch is the one that always replaces.
  if (!(await confirmDiscard(editor, `Opening ${file.name}`))) return;
  await openDocumentFile(editor, file, sinks);
}

/**
 * Replace the open document with `file` through the one IDML / `.paged`
 * load path, without asking: the half of Open after its question. An
 * embedding host's `load` (docs/composable-editor.md §8.2) replaces the
 * document on purpose, so it does not ask its user.
 */
export async function openDocumentFile(
  editor: PagedEditor,
  file: File,
  sinks: {
    setStatus: (s: string) => void;
    pushWarning: (w: string) => void;
  },
): Promise<void> {
  await loadDocumentFile(editor.client, file, {
    setHandle: editor.document.setHandle,
    setSourceName: editor.document.setSourceName,
    setLoading: editor.document.setLoading,
    setStatus: sinks.setStatus,
    setSnapshotsReady: editor.document.setSnapshotsReady,
    addSnapshot: (pageId, url) => {
      editor.document.setSnapshots((prev) => {
        const next = new Map(prev);
        next.set(pageId, url);
        return next;
      });
    },
    resetForNewDocument: editor.document.resetForNewDocument,
    pushWarning: sinks.pushWarning,
  });
}

/** A picture handed to Place without a picker (UX audit F-03): dropped on
 *  the canvas at a point (ADR 258), or opened with nothing open, to fill
 *  the page minted for it (ADR 262). One of `at` and `fillPage` is set. */
export interface PlaceDropPayload {
  file: { name: string; bytes: Uint8Array; mimeType: string };
  /** Where it was dropped: the picture's top-left lands there. */
  at?: { clientX: number; clientY: number };
  /** The page it fills, edge to edge. */
  fillPage?: { pageId: string; widthPt: number; heightPt: number };
}

/** The command a dropped picture is placed through. */
export const PLACE_DROPPED_COMMAND = "paged.insert.placeImage";

/** Raster pictures a drop places rather than opens. An SVG stays with its
 *  importer (it opens or is drawn as native paths), as does every other
 *  file. */
const PLACEABLE = /\.(png|jpe?g|gif|webp|bmp|tiff?|psd|psb)$/i;

/** Does a drop of `file` onto an open document mean Place, as it does in
 *  InDesign? */
export function dropPlaces(file: { name: string; type: string }): boolean {
  if (/svg/i.test(file.type) || /\.svg$/i.test(file.name)) return false;
  return PLACEABLE.test(file.name) || /^image\//i.test(file.type);
}

/** Route a file dropped at `at` (UX audit F-03): with a document open and
 *  a picture dropped, Place it there; anything else opens as before. */
export async function dropFile(
  editor: PagedEditor,
  file: File,
  at: { clientX: number; clientY: number } | null,
  sinks: {
    setStatus: (s: string) => void;
    pushWarning: (w: string) => void;
  },
): Promise<void> {
  const handle = editor.document.handle;
  if (
    at &&
    handle &&
    handle.pageCount > 0 &&
    dropPlaces(file) &&
    editor.registries.commands.get(PLACE_DROPPED_COMMAND)
  ) {
    const payload: PlaceDropPayload = {
      file: {
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        mimeType: file.type,
      },
      at,
    };
    await editor.registries.commands.invoke(PLACE_DROPPED_COMMAND, payload);
    return;
  }
  await openFile(editor, file, sinks);
}

/** Is a document with pages open? */
function hasDocument(editor: PagedEditor): boolean {
  return (editor.document.handle?.pageCount ?? 0) > 0;
}

/** Run `importer` on `file`, the import session parked around it. Says
 *  what came of it: the importer opened a document (`opened`), only added
 *  to whatever is open (`added`), failed, or the user kept the open
 *  document at the replace question (`declined`). */
async function runImporter(
  importer: ImporterContribution,
  file: File,
  sinks: {
    setStatus: (s: string) => void;
    pushWarning: (w: string) => void;
  },
  extra: { newDocument?: boolean } = {},
): Promise<"opened" | "added" | "failed" | "declined"> {
  sinks.setStatus(`importing ${file.name} via ${importer.title}…`);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // U14 — park the file name for the open orchestration: an
    // importer that OPENS a document does so through
    // `nativeDocument.open(bytes)`, which carries no name.
    setPendingImportSource(file.name);
    await importer.import({
      name: file.name,
      bytes,
      mimeType: file.type,
      ...extra,
    });
    sinks.setStatus(`imported ${file.name}`);
    // The open orchestration marks the session when the importer replaced
    // (or first opened) the document.
    return importReplaceAllowed() ? "opened" : "added";
  } catch (err) {
    if (isReplaceDeclined(err)) {
      // The user kept the open document at the replace question: an
      // answer, not a failure.
      sinks.setStatus(`kept the open document; ${file.name} not opened`);
      return "declined";
    }
    sinks.pushWarning(
      `import of ${file.name} via ${importer.title} failed: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return "failed";
  } finally {
    setPendingImportSource(null);
  }
}

/** How long a just-minted document may take to reach the live editor. */
const LIVE_DOCUMENT_TIMEOUT_MS = 10_000;

/**
 * The live editor once it shows `handle`. A minted document reaches the
 * editor's state on the next render, not when the mint resolves, and a
 * command invoked before then would find nothing open. Without a live
 * editor to watch (a bare registry) the editor passed in is the answer.
 */
async function liveEditorWith(
  editor: PagedEditor,
  handle: DocumentHandle,
): Promise<PagedEditor> {
  const deadline = Date.now() + LIVE_DOCUMENT_TIMEOUT_MS;
  for (;;) {
    const live = editor.registries.commands.liveEditor() as PagedEditor | null;
    if (!live) return editor;
    if (live.document.handle?.docId === handle.docId) return live;
    if (Date.now() > deadline) return live;
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}

/**
 * Open a picture with nothing open (UX audit F-03, ADR 262): mint one page
 * the picture's size (a point per pixel, as Place sizes a picture at its
 * natural size) and place the picture on it, edge to edge. False when this
 * is no picture, its size cannot be read, or Place is not available; the
 * caller then opens it the ordinary way.
 */
async function openPictureAsDocument(
  editor: PagedEditor,
  file: File,
  sinks: {
    setStatus: (s: string) => void;
    pushWarning: (w: string) => void;
  },
): Promise<boolean> {
  if (!dropPlaces(file)) return false;
  if (!editor.registries.commands.get(PLACE_DROPPED_COMMAND)) return false;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const size = await pictureSize(bytes, file.type);
  if (!size) return false;
  const [widthPt, heightPt] = pageForPicture(size);
  const handle = await mintBlankDocument(editor, [widthPt, heightPt], sinks);
  const pageId = handle?.pageIds[0];
  if (!handle || !pageId) return true; // the mint said why in the status
  // The document is named after the picture, as an opened file is.
  editor.document.setSourceName(file.name);
  const live = await liveEditorWith(editor, handle);
  const payload: PlaceDropPayload = {
    file: { name: file.name, bytes, mimeType: file.type },
    fillPage: { pageId, widthPt, heightPt },
  };
  await live.registries.commands.invoke(PLACE_DROPPED_COMMAND, payload);
  return true;
}

/** File ▸ New from a brief… (ADR 221) — opens the AI Assistant panel in
 *  its "New document" view, which mints the blank page and runs Claude.
 *  Offered only while the AI service is not known to be missing (UX
 *  audit F-25, ADR 252): the palette hides it and the menu greys it, as
 *  for any command whose `when` does not hold (ADR 249). */
export function buildNewFromBriefCommand(
  open: () => void,
): CommandContribution {
  return {
    id: PAGED_FILE_NEW_FROM_BRIEF,
    title: "New document from a brief…",
    category: "File",
    when: () => getAiAvailability() !== "unavailable",
    handler: () => {
      if (getAiAvailability() === "unavailable") return;
      open();
    },
  };
}
