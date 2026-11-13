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

// File ▸ Save (.paged) — the native container, and what each of its steps
// did (editor ADR 1203). The steps, in order:
//
//   1. plugins with an edit session outside the document commit it
//      (`host.document.onWillSave`, bounded);
//   2. the engine writes the bytes;
//   3. an embedding host's `save` action takes them, and that is all;
//   4. otherwise a commit in the local library (ADR 180) — alongside,
//      never instead of, the file: a library failure is noted and the file
//      write goes on;
//   5. a write BACK to the file the document was opened from (A5), when
//      there is one;
//   6. otherwise — no file, or the file did not take them — a download.
//
// Each step reports into the editor's save state, so the header says what
// happened: "Saved" only when the document's own target (the file, the
// host) holds the bytes, "Saved locally · Not synced" when the library or
// the download holds them and the file did not take them (D-10), "Couldn't
// save" when nothing does. A save that throws still throws: the caller
// reports it in Problems.

import type { SaveStateStore } from "@paged-media/repository";
import {
  commitSave,
  getOpenFileHandle,
  saveStateOf,
  writeBackToOpenFile,
  type EditorScope,
} from "@paged-media/shell";

/** What the save needs of the engine client. */
export interface SaveClient {
  exportPaged(): Promise<Uint8Array>;
  readonly editMark: number;
  markSaved(mark?: number): void;
  documentMeta(): Promise<{ documentName?: string | null }>;
}

export interface SavePagedContext {
  scope: EditorScope;
  client: SaveClient;
  /** `host.document.onWillSave`'s registry (v66). */
  willSave: {
    run(o: {
      format: "paged";
    }): Promise<{ failed: readonly string[]; timedOut: readonly string[] }>;
  };
  /** The embedding host's save action (concept §8.3), if it has one. */
  hostSave?: (file: { bytes: Uint8Array; name: string }) => unknown;
  sourceName: string | null | undefined;
  /** Hands the bytes to the browser as a download (a DOM `<a download>`
   *  in the app). */
  download?: (bytes: Uint8Array, fileName: string) => void;
  now?: () => number;
}

const MIME = "application/x-paged+zip";

function browserDownload(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes.slice()], { type: MIME });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

const detailOf = (err: unknown): string | null =>
  err instanceof Error ? err.message : err == null ? null : String(err);

/** Save the open document; resolves once every step has reported. */
export async function savePagedFile(ctx: SavePagedContext): Promise<void> {
  const { scope } = ctx;
  const now = ctx.now ?? Date.now;
  const report = saveStateOf(scope);
  report.dispatch({ type: "save-started", at: now() });
  try {
    await runSave(ctx, report, now);
  } catch (err) {
    // Closes the running save: nothing stored reads as failed, something
    // stored as saved locally and not synced.
    report.dispatch({
      type: "save-failed",
      code: "export-failed",
      detail: detailOf(err),
      at: now(),
    });
    throw err;
  }
}

async function runSave(
  ctx: SavePagedContext,
  report: SaveStateStore,
  now: () => number,
): Promise<void> {
  const { scope, client } = ctx;
  // v66 — plugins with an edit session outside the document commit it
  // first (bounded; a stuck one is reported, not waited on forever), so
  // the file holds what is on screen.
  const prepared = await ctx.willSave.run({ format: "paged" });
  for (const id of [...prepared.failed, ...prepared.timedOut]) {
    console.warn(
      `Save (.paged): ${id} did not finish preparing (` +
        `${prepared.failed.includes(id) ? "threw" : "timed out"}); ` +
        `saving its last committed state`,
    );
    report.dispatch({
      type: "note",
      note: { kind: "not-prepared", plugin: id },
    });
  }
  const bytes = await client.exportPaged();
  // What the bytes hold: an edit landing while they are written out is
  // not part of this save.
  const savedMark = client.editMark;
  let baseName = ctx.sourceName || "document";
  try {
    const meta = await client.documentMeta();
    if (meta.documentName) baseName = meta.documentName;
  } catch {
    /* meta unavailable — keep the fallback name */
  }
  const fileName = `${baseName.replace(/\.(paged|idml)$/i, "")}.paged`;
  /** The document is saved as of `savedMark`: clean unless an edit landed
   *  since (the client's own flag follows once the meta is read again). */
  const saved = () => {
    client.markSaved(savedMark);
    report.dispatch({ type: "dirty", dirty: client.editMark !== savedMark });
  };

  // An embedding host stores the document itself (concept §8.3): the
  // bytes go to its `save` action, not to the library, a file or a
  // download.
  if (ctx.hostSave) {
    report.dispatch({ type: "sync-started", target: { kind: "host" } });
    try {
      await ctx.hostSave({ bytes, name: baseName });
    } catch (err) {
      report.dispatch({
        type: "sync-failed",
        target: { kind: "host" },
        code: "host-refused",
        detail: detailOf(err),
        at: now(),
      });
      report.dispatch({ type: "save-finished", at: now() });
      throw err;
    }
    report.dispatch({ type: "stored", destination: { kind: "host" } });
    saved();
    report.dispatch({ type: "save-finished", at: now() });
    return;
  }

  // ADR 180 — the save is a commit in the local library, alongside (never
  // instead of) the file write below. A library failure is noted and the
  // file still gets written.
  try {
    if (await commitSave(scope, bytes.slice(), baseName))
      report.dispatch({ type: "stored", destination: { kind: "library" } });
  } catch (err) {
    console.warn("Save (.paged): the library did not take this save:", err);
    report.dispatch({
      type: "note",
      note: { kind: "library-failed", detail: detailOf(err) },
    });
  }

  // A5 — write BACK to the file the document was opened from, when there
  // is one. A save that did not reach the file must not look like one
  // that did: the result says which, and why.
  const handle = getOpenFileHandle(scope);
  if (handle)
    report.dispatch({
      type: "sync-started",
      target: { kind: "file", name: handle.name },
    });
  const written = await writeBackToOpenFile(scope, bytes, MIME);
  if (written.kind === "written") {
    report.dispatch({
      type: "stored",
      destination: { kind: "file", name: written.name },
    });
    saved();
    report.dispatch({ type: "save-finished", at: now() });
    return;
  }
  if (written.kind === "failed") {
    report.dispatch({
      type: "sync-failed",
      target: { kind: "file", name: written.name },
      code: written.code,
      detail: written.detail,
      at: now(),
    });
  }
  // No file, or the file did not take the bytes: a download, so the
  // work is on this device either way.
  (ctx.download ?? browserDownload)(bytes, fileName);
  report.dispatch({
    type: "stored",
    destination: { kind: "download", name: fileName },
  });
  // ED-4 — the document is saved (in the library, a download), so the
  // edited flag clears until the next edit; the state still says the file
  // was not written.
  saved();
  report.dispatch({ type: "save-finished", at: now() });
}
