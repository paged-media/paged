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

// Open a document of the local library (ADR 180): the Library panel's
// Open and the empty canvas's recent documents (UX audit F-10) take this
// one path. It asks the replace question first (ADR 230) and loads the
// library's `.paged` bytes as that library document, so a save is its
// next version.

import type { DocumentEntry } from "@paged-media/repository";

import { loadDocumentFile } from "./document-loader";
import { getLibrary } from "./library-document";
import type { PagedEditor } from "./paged-editor";
import { confirmDiscard } from "./replace-guard";

/** Resolves true once `entry` (at `target`, a ref or a version) is the
 *  open document; false when the user kept the open one or there is no
 *  library. */
export async function openLibraryDocument(
  editor: PagedEditor,
  entry: DocumentEntry,
  options: {
    /** The replace question's action ("Opening Annual"). */
    action: string;
    target?: string;
    setStatus?: (s: string) => void;
    pushWarning?: (w: string) => void;
  },
): Promise<boolean> {
  const library = getLibrary(editor.scope);
  if (!library) return false;
  if (!(await confirmDiscard(editor, options.action))) return false;
  const bytes = await library.exportPaged(entry.id, options.target ?? "main");
  const doc = editor.document;
  await loadDocumentFile(
    editor.client,
    new File([bytes.slice()], `${entry.name}.paged`),
    {
      setHandle: doc.setHandle,
      setSourceName: doc.setSourceName,
      setLoading: doc.setLoading,
      setStatus: options.setStatus ?? ((s) => console.info("[library]", s)),
      setSnapshotsReady: doc.setSnapshotsReady,
      addSnapshot: (pageId, url) =>
        doc.setSnapshots((prev) => new Map(prev).set(pageId, url)),
      resetForNewDocument: doc.resetForNewDocument,
      pushWarning: options.pushWarning ?? ((w) => console.warn("[library]", w)),
      libraryDocument: entry,
      scope: editor.scope,
    },
  );
  return true;
}
