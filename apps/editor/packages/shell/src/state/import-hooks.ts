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

// WP4.11 — "Run action on import": the moment an import FINISHED, as a
// per-editor event. The open path (`openFile`: a plugin importer, a
// picture opened as a document, the IDML / .paged load) reports each
// file it brought in; the Actions provider listens and plays the action
// an import rule names (Photoshop's droplet, as a standing rule).
//
// A batch opens files through the same path and must not set the rules
// off on every one of them, so it holds a suppression for its run.

import { scoped, type EditorScope } from "./editor-scope";

/** One finished import. */
export interface ImportedFile {
  name: string;
  /** What brought it in: a plugin importer (its title), a picture opened
   *  as a document, or the document load itself. */
  via: "importer" | "picture" | "document";
  importer?: string;
}

type Listener = (file: ImportedFile) => void | Promise<void>;

const HOOKS = scoped("importHooks", () => ({
  listeners: new Set<Listener>(),
  suppressed: 0,
}));

/** Listen for finished imports; returns the unsubscribe. */
export function onImported(scope: EditorScope, fn: Listener): () => void {
  const h = scope.get(HOOKS);
  h.listeners.add(fn);
  return () => h.listeners.delete(fn);
}

/** Report a finished import (the open path calls it). Listeners run in
 *  order and are awaited, so a rule's action has played before the open
 *  command resolves; one that throws is logged and the rest still run. */
export async function notifyImported(
  scope: EditorScope,
  file: ImportedFile,
): Promise<void> {
  const h = scope.get(HOOKS);
  if (h.suppressed > 0) return;
  for (const fn of [...h.listeners]) {
    try {
      await fn(file);
    } catch (err) {
      console.warn(
        `paged: an after-import listener failed on ${file.name}`,
        err,
      );
    }
  }
}

/** Run `fn` with import listeners muted (a batch opening its files). */
export async function withImportHooksSuppressed<T>(
  scope: EditorScope,
  fn: () => Promise<T>,
): Promise<T> {
  const h = scope.get(HOOKS);
  h.suppressed += 1;
  try {
    return await fn();
  } finally {
    h.suppressed -= 1;
  }
}
