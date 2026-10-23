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

// A5 — the handle of the file the document was opened from, so Save can
// write back to it.
//
// Until now every save minted a Blob and clicked an `<a download>`. That
// is a save-AS, dressed as a save: the second `Cmd+S` produced
// "document (1).paged", the third "document (2).paged", and the file the
// user opened was never touched. Combined with there being no autosave,
// "Save" was the one word in the app that did not mean what it says.
//
// The File System Access API gives a real handle, and the app already
// requires a Chromium-class browser (WebGPU + SharedArrayBuffer +
// OffscreenCanvas), so this is not a portability regression — it is
// available wherever the editor runs at all.
//
// A STORE IN THE EDITOR'S SCOPE, not a context. The writer is the shell's
// file picker and the reader is the canvas app's save command, and
// threading a handle between them through React state would mean a
// provider that exists for one value that never renders anything. It also
// has to survive a dock close/reopen, which the scope (the editor's
// lifetime) does for free. Per editor (plan task E1): each editor saves
// back to the file IT opened.
//
// Cleared on New, because a blank document is not the file you opened,
// and on a picker that yields no handle (the `<input type=file>`
// fallback), because a stale handle would write the NEW document over
// the OLD file — silently, and with no undo. That failure is worse than
// no feature, so absence is the safe default everywhere it is unclear.

import { noteFileWritten } from "./document-source";
import { scoped, type EditorScope } from "./editor-scope";

/** The subset of FileSystemFileHandle this uses. Declared rather than
 *  relying on lib.dom, whose typings for the File System Access API vary
 *  by TS version. */
export interface WritableFileHandle {
  readonly name: string;
  createWritable(): Promise<{
    write(data: BufferSource | Blob): Promise<void>;
    close(): Promise<void>;
  }>;
  queryPermission?(d: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(d: {
    mode: "read" | "readwrite";
  }): Promise<PermissionState>;
}

const HANDLE = scoped("openFileHandle", () => ({
  current: null as WritableFileHandle | null,
}));

/** Remember the file `scope`'s document was opened from. `null` clears it. */
export function setOpenFileHandle(
  scope: EditorScope,
  handle: WritableFileHandle | null,
): void {
  scope.get(HANDLE).current = handle;
}

/** The handle to save back into, or null when the document did not come
 *  from one (a blank document, a drag-drop, or the input fallback). */
export function getOpenFileHandle(
  scope: EditorScope,
): WritableFileHandle | null {
  return scope.get(HANDLE).current;
}

/** True when the platform can hand out real file handles at all. */
export function supportsFileHandles(): boolean {
  return (
    typeof (globalThis as { showOpenFilePicker?: unknown })
      .showOpenFilePicker === "function"
  );
}

/** Write bytes back to the opened file.
 *
 *  Returns false when there is no handle, when the platform cannot do
 *  it, or when the user declines the permission prompt — every one of
 *  which means the caller must fall back to a download rather than
 *  report a save that did not happen. */
export async function writeToOpenFile(
  scope: EditorScope,
  bytes: Uint8Array,
  mimeType: string,
): Promise<boolean> {
  const handle = getOpenFileHandle(scope);
  if (!handle) return false;
  try {
    // Permission can lapse between sessions even though the handle
    // survives, so ask rather than assume. `queryPermission` is absent
    // on some builds; treat absence as "try and see".
    const state = await handle.queryPermission?.({ mode: "readwrite" });
    if (state === "prompt") {
      const granted = await handle.requestPermission?.({ mode: "readwrite" });
      if (granted !== "granted") return false;
    } else if (state === "denied") {
      return false;
    }
    const writable = await handle.createWritable();
    // Copy through a Blob so the mime type rides along and the caller's
    // buffer is not detached by the write.
    await writable.write(new Blob([bytes.slice()], { type: mimeType }));
    await writable.close();
    // Editor ADR 264 — the file changed under the editor's own hand: a
    // grant remembered for the document it holds keeps holding.
    const written = await (handle as unknown as { getFile?(): Promise<File> })
      .getFile?.()
      .catch(() => null);
    if (written)
      noteFileWritten(scope, handle as never, {
        lastModified: written.lastModified,
        size: written.size,
      });
    return true;
  } catch {
    // A revoked permission, a removed file, a locked file. The caller
    // downloads instead — never silently "succeeds".
    return false;
  }
}
