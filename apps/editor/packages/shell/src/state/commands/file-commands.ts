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
import { setPendingImportSource } from "../import-source";
import { confirmDiscard, isReplaceDeclined } from "../replace-guard";

export { confirmDiscard };
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
): Promise<void> {
  const [widthPt, heightPt] = sizePt;
  await createBlankDocument(
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
  const importer = editor.registries.importers.resolve(file.name, file.type);
  if (importer) {
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
      });
      sinks.setStatus(`imported ${file.name}`);
    } catch (err) {
      if (isReplaceDeclined(err)) {
        // The user kept the open document at the replace question: an
        // answer, not a failure.
        sinks.setStatus(`kept the open document; ${file.name} not opened`);
      } else {
        sinks.pushWarning(
          `import of ${file.name} via ${importer.title} failed: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    } finally {
      setPendingImportSource(null);
    }
    return;
  }
  // The guard sits HERE, not before the picker and not before the
  // importer routing above. Asking before the picker interrupts a
  // gesture the user may abandon anyway, and a plugin importer does
  // not necessarily replace the document — paged.sheet's .xlsx adds
  // a frame. This branch is the one that always replaces.
  if (!(await confirmDiscard(editor, `Opening ${file.name}`))) return;
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

/** A file dropped on the canvas and the point it was dropped at, handed to
 *  Place (UX audit F-03, ADR 258). */
export interface PlaceDropPayload {
  file: { name: string; bytes: Uint8Array; mimeType: string };
  at: { clientX: number; clientY: number };
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
