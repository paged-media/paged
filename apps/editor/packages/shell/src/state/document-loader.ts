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

// File-loading orchestration extracted from CanvasApp.tsx — the
// `onFile` flow that turns a dropped file into (a) loaded
// document handle, (b) per-page snapshots, (c) Tier 3 resolution.
//
// The loader takes the canvas client + the document/loading
// callbacks (typically the setters from DocumentContext). It does
// NOT depend on React; pass it the setters and it dispatches.

import type { CanvasClient } from "@paged-media/client";
import type { DocumentHandle, PageId } from "@paged-media/client";

import type { DocumentEntry } from "@paged-media/repository";

import type { LoadingState } from "./document-context";
import { declareDocumentSource, sourceOfFile } from "./document-source";
import {
  rememberOpenedFile,
  setCurrentLibraryDocument,
} from "./library-document";

const SNAPSHOT_WIDTH_PX = 256;

export interface DocumentLoaderCallbacks {
  setHandle: (h: DocumentHandle | null) => void;
  setLoading: (l: LoadingState | null) => void;
  setStatus: (s: string) => void;
  setSnapshotsReady: (ready: boolean) => void;
  addSnapshot: (pageId: PageId, objectUrl: string) => void;
  resetForNewDocument: () => void;
  pushWarning: (w: string) => void;
  /** U14 — receives the loaded file's display name (extension
   * stripped) so the doc title bar / Save-As basename can fall back
   * to it when the document meta carries no `documentName`. Optional:
   * callers that don't surface a title may omit it. */
  setSourceName?: (name: string | null) => void;
  /** ADR 180 — the file is a projection of this library document (opened
   *  from the library), so it is not imported again. Absent: the file is
   *  new to the library and becomes a document in it. */
  libraryDocument?: DocumentEntry;
}

/** The newest load (open or New). Every step after an await checks it, so
 *  a load another one superseded stops where it is: its handle, its page
 *  thumbnails, its "loaded N pages" status and its ready flag never land
 *  on the document that replaced it (SH-105, ADR 248). Module-scoped
 *  because the document state the callbacks write is one per editor. */
let newestLoad = 0;

/**
 * Drives the load → snapshot → ready sequence for one IDML file.
 *
 * Order matters here: each step must complete before the next. The
 * worker is single-threaded; parallel requests would only queue.
 * Snapshot progress lands in the UI page-by-page (the navigator
 * shows the snapshot as soon as it lands), so the loop is
 * deliberately not Promise.all.
 *
 * Errors at the load step abort; per-page snapshot errors are
 * pushed as warnings and the loop continues — a missing snapshot
 * shouldn't block the rest of the document.
 */
export async function loadDocumentFile(
  client: CanvasClient,
  file: File,
  cb: DocumentLoaderCallbacks,
): Promise<void> {
  const load = ++newestLoad;
  cb.setStatus(`loading ${file.name} (${file.size.toLocaleString()} bytes)…`);
  cb.setLoading({ name: file.name, bytes: file.size });
  cb.resetForNewDocument();
  // U14 — the file's name (extension stripped) is the document's
  // fallback display identity when its meta has no documentName.
  cb.setSourceName?.(file.name.replace(/\.[^.]+$/, "") || null);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const fontBytes = await fetchDefaultFont();
  if (!fontBytes) warnDefaultFontUnavailable(cb);

  // loadDocument TRANSFERS the buffer to the worker; the library keeps a copy.
  const forLibrary = cb.libraryDocument ? null : bytes.slice();
  let handle: DocumentHandle;
  try {
    handle = await client.loadDocument(bytes, fontBytes);
  } catch (err) {
    if (load !== newestLoad) return;
    cb.setLoading(null);
    cb.setStatus(`load failed: ${String(err)}`);
    return;
  }
  if (load !== newestLoad) return;

  if (cb.libraryDocument) setCurrentLibraryDocument(cb.libraryDocument);
  else if (forLibrary) rememberOpenedFile(forLibrary, file.name);
  // Editor ADR 264 — the source this document came from, which a grant
  // remembered for it is keyed by: the library document it is, the file
  // handle the picker attached to `file`, else nothing (transient).
  declareDocumentSource(
    handle.docId,
    cb.libraryDocument
      ? { kind: "library", documentId: cb.libraryDocument.id }
      : sourceOfFile(file),
  );
  cb.setHandle(handle);
  cb.setLoading(null);
  cb.setStatus(
    `loaded ${handle.pageCount} page${handle.pageCount === 1 ? "" : "s"}; snapshotting…`,
  );
  await snapshotAllPages(client, handle, cb, load);
}

/** Size of a new blank document in points, [width, height]. */
export interface BlankDocumentOptions {
  widthPt: number;
  heightPt: number;
}

/**
 * File ▸ New — create an empty single-page document and run the same
 * post-load orchestration as {@link loadDocumentFile} (reset, snapshot,
 * ready). The blank package is minted by the engine
 * ([`CanvasClient.newBlankDocument`]); the editor only orchestrates the
 * surrounding UI state, exactly like opening a file. Resolves to the new
 * document's handle, or null when the engine refused or a later load took
 * over.
 */
export async function createBlankDocument(
  client: CanvasClient,
  opts: BlankDocumentOptions,
  cb: DocumentLoaderCallbacks,
): Promise<DocumentHandle | null> {
  const load = ++newestLoad;
  cb.setStatus("creating new document…");
  cb.setLoading({ name: "Untitled", bytes: 0 });
  cb.resetForNewDocument();
  // U14 — a blank document has no source file; the title bar's
  // "Untitled document" fallback is the honest name.
  cb.setSourceName?.(null);
  // A blank document is no library document until its first save.
  setCurrentLibraryDocument(null);

  const fontBytes = await fetchDefaultFont();
  if (!fontBytes) warnDefaultFontUnavailable(cb);

  let handle: DocumentHandle;
  try {
    handle = await client.newBlankDocument(
      opts.widthPt,
      opts.heightPt,
      fontBytes,
    );
  } catch (err) {
    if (load !== newestLoad) return null;
    cb.setLoading(null);
    cb.setStatus(`new document failed: ${String(err)}`);
    return null;
  }
  if (load !== newestLoad) return null;

  declareDocumentSource(handle.docId, { kind: "transient" });
  cb.setHandle(handle);
  cb.setLoading(null);
  cb.setStatus(`new ${handle.pageCount}-page document; snapshotting…`);
  await snapshotAllPages(client, handle, cb, load);
  return handle;
}

/**
 * Auto-fetch a default font so text is shaped + the captured StoryLayout
 * has real glyph positions. Without this the caret + selection rendering
 * has nothing to position against (glyphs vec empty → no clusters
 * captured) — and, worse, fonts the document declares but cannot resolve
 * have NO fallback face, so their text renders blank (U5/A7). Inter is
 * checked in under corpus/fonts/. Best-effort in that the load proceeds
 * without it, but callers must be LOUD about the gap (see
 * `warnDefaultFontUnavailable`).
 *
 * Exported (U5/A7) so the app can hand the SAME fetch to
 * `CanvasClient`'s `defaultFontProvider` — one default-font door for
 * shell loads and bare client loads alike.
 */
export async function fetchDefaultFont(): Promise<Uint8Array | undefined> {
  try {
    const fontResp = await fetch(defaultFontUrls.roman);
    if (fontResp.ok) {
      const bytes = new Uint8Array(await fontResp.arrayBuffer());
      // A static host answers a missing file with its SPA index.html and a
      // 200 — the playground did, and every new document laid its text out
      // with "HTML" as the font: nothing drew. Accept only sfnt bytes.
      if (isFontFile(bytes)) return bytes;
    }
  } catch {
    // fall through to undefined — the caller warns.
  }
  return undefined;
}

/**
 * Where the default faces are served: the editor app's own `/fonts/`. An
 * embedding build that ships them elsewhere (the `@paged-media/editor`
 * package, beside its modules) says so once, before the first load.
 */
let defaultFontUrls = {
  roman: "/fonts/Inter.ttf",
  italic: "/fonts/Inter-Italic.ttf",
};

export function setDefaultFontUrls(urls: {
  roman: string;
  italic: string;
}): void {
  defaultFontUrls = { ...urls };
  defaultItalic = null;
}

/** The family the editor's bundled default face (`/fonts/Inter.ttf`)
 *  belongs to: what text no style gives a font is set in, so what the
 *  Character panel shows for it (PN-20). */
export const DEFAULT_FONT_FAMILY = "Inter";

/** The bundled default family's italic, beside its roman (`Inter.ttf`):
 *  the variable roman covers weights, not italic, so the client
 *  registers this as Inter's "Italic" after every load
 *  (`CanvasClient`'s `defaultFontFaces`). Fetched once per session. */
let defaultItalic: Promise<Uint8Array | undefined> | null = null;

export async function fetchDefaultFontFaces(): Promise<
  Array<{ family: string; style: string; bytes: Uint8Array }>
> {
  defaultItalic ??= (async () => {
    try {
      const resp = await fetch(defaultFontUrls.italic);
      if (!resp.ok) return undefined;
      const bytes = new Uint8Array(await resp.arrayBuffer());
      return isFontFile(bytes) ? bytes : undefined;
    } catch {
      return undefined;
    }
  })();
  const italic = await defaultItalic;
  // A failed fetch is not cached: the next load tries again.
  if (!italic) defaultItalic = null;
  return italic
    ? [{ family: DEFAULT_FONT_FAMILY, style: "Italic", bytes: italic }]
    : [];
}

/** TrueType / OpenType / collection magic: 0x00010000, "OTTO", "true", "ttcf". */
function isFontFile(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const tag = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  return (
    (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) ||
    tag === "OTTO" ||
    tag === "true" ||
    tag === "ttcf"
  );
}

/** U5/A7 — a missing default font is the "blank text" precondition;
 *  say so where the user can see it instead of failing silently. */
function warnDefaultFontUnavailable(cb: DocumentLoaderCallbacks): void {
  cb.pushWarning(
    "default font unavailable — text in documents with missing fonts will not render",
  );
}

/** One page's thumbnail as an object URL (the caller revokes it). The
 *  load pass and the thumbnail keeper (`usePageThumbnails`) both take
 *  them here, so a re-taken thumbnail matches the one it replaces. */
export async function requestPageThumbnail(
  client: CanvasClient,
  pageId: PageId,
): Promise<string> {
  // A thumbnail shows the canvas, so it keeps the canvas's markers
  // (engine ADR 205); every other snapshot is drawn as the exports draw it.
  const snap = await client.requestSnapshot(
    pageId,
    SNAPSHOT_WIDTH_PX,
    undefined,
    {
      markers: true,
    },
  );
  const blob = new Blob([new Uint8Array(snap.pngBytes)], { type: "image/png" });
  return URL.createObjectURL(blob);
}

/**
 * Sequential per-page snapshot requests + ready flag, shared by the
 * open-file and new-document paths. `load` is the pass's load; a newer
 * one stops it between pages. Sequential because the worker is
 * single-threaded; parallel requests would only queue. A missing
 * snapshot is a warning, not a hard failure.
 */
async function snapshotAllPages(
  client: CanvasClient,
  handle: DocumentHandle,
  cb: DocumentLoaderCallbacks,
  load: number,
): Promise<void> {
  for (const pageId of handle.pageIds) {
    if (load !== newestLoad) return;
    try {
      const url = await requestPageThumbnail(client, pageId);
      if (load !== newestLoad) {
        URL.revokeObjectURL(url);
        return;
      }
      cb.addSnapshot(pageId, url);
    } catch (err) {
      if (load !== newestLoad) return;
      cb.pushWarning(`snapshot ${pageId}: ${String(err)}`);
    }
  }
  if (load !== newestLoad) return;

  cb.setStatus(
    `loaded ${handle.pageCount} page${handle.pageCount === 1 ? "" : "s"}`,
  );
  cb.setSnapshotsReady(true);
}
