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

// The WORKBOOK door (`workbooks@1`, `contribute.workbookEditor@1`,
// extensions ADR 1102): the shared registry the editor builds ONCE and
// injects into every `createBundleHost` (`options.workbookEditors`), and
// the consumer's surface over it. The surface wraps each session the
// provider answers, so the guarantees hold whoever provides: the request's
// bytes come back unchanged while nothing changed, `close` runs once, and
// a closed session keeps answering its last bytes.

import type {
  Disposable,
  WorkbookEditRequest,
  WorkbookEditSession,
  WorkbookEditorContribution,
  WorkbooksSurface,
} from "@paged-media/plugin-api";

import { toDisposable } from "./disposables.js";

/** The shared registry of workbook editors. */
export interface WorkbookEditorBackend {
  register(owner: string, contribution: WorkbookEditorContribution): Disposable;
  /** The editor that answers: the first registered that is still there. */
  current(): { owner: string; editor: WorkbookEditorContribution } | null;
  /** Fires when an editor is registered or goes. */
  onDidChange(listener: () => void): Disposable;
}

/** Build the shared registry. */
export function createWorkbookEditorRegistry(): WorkbookEditorBackend {
  const entries: { owner: string; editor: WorkbookEditorContribution }[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const l of [...listeners]) l();
  };
  return {
    register(owner, editor) {
      if (entries.some((e) => e.editor.id === editor.id))
        throw new Error(
          `contribute.workbookEditor: ${editor.id} is registered already`,
        );
      const entry = { owner, editor };
      entries.push(entry);
      changed();
      return toDisposable(() => {
        const i = entries.indexOf(entry);
        if (i < 0) return;
        entries.splice(i, 1);
        changed();
      });
    },
    current: () => entries[0] ?? null,
    onDidChange(listener) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  };
}

/** A provider's session with the door's guarantees. */
function guarded(
  request: WorkbookEditRequest,
  inner: WorkbookEditSession,
): WorkbookEditSession {
  let closed = false;
  let last: Uint8Array = request.xlsx;
  let edited = false;
  const read = (): Uint8Array => {
    if (closed) return last;
    edited = edited || inner.changed();
    last = edited ? inner.xlsx() : request.xlsx;
    return last;
  };
  return {
    editor: inner.editor,
    Surface: inner.Surface,
    changed: () => (closed ? edited : (edited = edited || inner.changed())),
    xlsx: read,
    onDidChange: (listener) => inner.onDidChange(listener),
    close() {
      if (closed) return;
      // The bytes are taken before the provider frees its engine.
      try {
        read();
      } finally {
        closed = true;
        inner.close();
      }
    },
  };
}

/** The consumer's side of the door for one bundle. */
export function createWorkbooksSurface(
  backend: WorkbookEditorBackend | undefined,
  track: (d: Disposable) => Disposable,
): WorkbooksSurface {
  return {
    available: () => backend?.current() != null,
    async open(request) {
      if (!backend)
        throw new Error(
          "workbooks.open: the host shares no workbook editors (supports('workbooks@1') is false)",
        );
      const current = backend.current();
      if (!current)
        throw new Error("workbooks.open: no bundle offers a workbook editor");
      const inner = await current.editor.open({
        ...request,
        // The provider gets its own copy: the consumer's bytes stay its own.
        xlsx: request.xlsx.slice(),
      });
      return guarded(request, inner);
    },
    onDidChangeAvailability(listener) {
      if (!backend) return toDisposable(() => {});
      return track(backend.onDidChange(listener));
    },
  };
}
