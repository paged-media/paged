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

// Editor ADR 264 — where the open document came from, as the HOST knows it.
//
// A grant the user remembers for a document (network consent, ADR 218's
// door) must hold for THAT document only. The engine's `docId` is minted per
// load, and anything inside the file is the file's to forge, so the identity
// a grant is keyed by comes from here: the source the editor opened the bytes
// from, which a file cannot name.
//
//   fileHandle   a File System Access handle the user picked — the host can
//                recognise the same file again (`isSameEntry`);
//   library      a document of the local library, by the id the library
//                minted when it first took the file in;
//   transient    everything else (a drop, the input fallback, a URL, New, a
//                plugin-built document): nothing to recognise it by later.
//
// The source travels WITH the `File` the loader is handed (a WeakMap keyed
// by the object, not by its name or bytes), so only the opener that holds
// the handle can claim it, and a load that names no source is transient.
// After a load succeeds the loader tells the sink (the app's identity store)
// which engine `docId` came from which source.

import { scoped, type EditorScope } from "./editor-scope";

/** The parts of a `FileSystemFileHandle` the identity needs. */
export interface IdentifiableFileHandle {
  readonly name: string;
  /** True when both handles name the same file on disk. */
  isSameEntry?(other: unknown): Promise<boolean>;
}

export type DocumentSource =
  | {
      kind: "fileHandle";
      handle: IdentifiableFileHandle;
      /** The file as it was read: a change made outside the editor moves
       *  these, and a grant does not survive it. */
      lastModified: number;
      size: number;
    }
  | { kind: "library"; documentId: string }
  | { kind: "transient" };

export interface DocumentSourceSink {
  /** The document the engine loaded as `docId` came from `source`. */
  declare(docId: string, source: DocumentSource): void;
  /** The open document was written to `handle`; the file now reads as
   *  `lastModified` / `size`. */
  written(
    handle: IdentifiableFileHandle,
    file: { lastModified: number; size: number },
  ): void;
}

// Keyed by the `File` object itself: whoever holds the file holds its
// source, whichever editor it is handed to.
const sources = new WeakMap<File, DocumentSource>();
/** The identity store of each editor (plan task E1). */
const SINK = scoped("documentSourceSink", () => ({
  current: null as DocumentSourceSink | null,
}));

/** Mark `file` as read from `handle` (the open picker). Returns `file`. */
export function attachFileSource(
  file: File,
  handle: IdentifiableFileHandle,
): File {
  sources.set(file, {
    kind: "fileHandle",
    handle,
    lastModified: file.lastModified,
    size: file.size,
  });
  return file;
}

/** The source `file` was read from; transient when nothing claimed it. */
export function sourceOfFile(file: File): DocumentSource {
  return sources.get(file) ?? { kind: "transient" };
}

/** `scope`'s identity store (one per editor); `null` detaches it. */
export function setDocumentSourceSink(
  scope: EditorScope,
  next: DocumentSourceSink | null,
): void {
  scope.get(SINK).current = next;
}

/** Tell `scope`'s sink where `docId` came from. Never throws. */
export function declareDocumentSource(
  scope: EditorScope,
  docId: string,
  source: DocumentSource,
): void {
  try {
    scope.get(SINK).current?.declare(docId, source);
  } catch (err) {
    console.warn("document identity: could not record the source:", err);
  }
}

/** Tell the sink the open document was saved into `handle`. Never throws. */
export function noteFileWritten(
  scope: EditorScope,
  handle: IdentifiableFileHandle,
  file: { lastModified: number; size: number },
): void {
  try {
    scope.get(SINK).current?.written(handle, file);
  } catch (err) {
    console.warn("document identity: could not record the save:", err);
  }
}
