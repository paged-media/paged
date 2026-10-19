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

// Browser PLATFORM objects the editor's host backends talk to, faked below
// the backend so the backend's own code runs: the origin-private file system
// (`navigator.storage.getDirectory`, plugin-blob-store.ts), the system
// clipboard (`navigator.clipboard` + `ClipboardItem`, plugin-clipboard.ts)
// and `localStorage` (the SDK's default KV backing, which the editor relies
// on: it passes no `storage` option). Each `install` returns its undo.

type Restore = () => void;

function defineGlobal(owner: object, key: string, value: unknown): Restore {
  const had = Object.getOwnPropertyDescriptor(owner, key);
  Object.defineProperty(owner, key, {
    value,
    configurable: true,
    writable: true,
  });
  return () => {
    if (had) Object.defineProperty(owner, key, had);
    else delete (owner as Record<string, unknown>)[key];
  };
}

/** An in-memory origin-private file system: directories of files, enough of
 *  `FileSystemDirectoryHandle` / `FileSystemFileHandle` for the blob store. */
export function fakeOpfs() {
  interface Dir {
    kind: "directory";
    entries: Map<string, Dir | File>;
  }
  interface File {
    kind: "file";
    bytes: Uint8Array;
  }
  const root: Dir = { kind: "directory", entries: new Map() };
  let available = true;

  const notFound = (name: string) =>
    Object.assign(new Error(`${name} not found`), { name: "NotFoundError" });

  const fileHandle = (file: File) => ({
    kind: "file" as const,
    async getFile() {
      const bytes = file.bytes.slice();
      return {
        size: bytes.byteLength,
        arrayBuffer: async () => bytes.buffer,
      };
    },
    async createWritable() {
      let next = new Uint8Array(0);
      return {
        async write(data: Uint8Array) {
          next = new Uint8Array(data);
        },
        async close() {
          file.bytes = next;
        },
      };
    },
  });

  const dirHandle = (dir: Dir): unknown => ({
    kind: "directory" as const,
    async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
      let child = dir.entries.get(name);
      if (!child) {
        if (!opts?.create) throw notFound(name);
        child = { kind: "directory", entries: new Map() };
        dir.entries.set(name, child);
      }
      if (child.kind !== "directory") throw new TypeError(`${name} is a file`);
      return dirHandle(child);
    },
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      let child = dir.entries.get(name);
      if (!child) {
        if (!opts?.create) throw notFound(name);
        child = { kind: "file", bytes: new Uint8Array(0) };
        dir.entries.set(name, child);
      }
      if (child.kind !== "file") throw new TypeError(`${name} is a directory`);
      return fileHandle(child);
    },
    async removeEntry(name: string) {
      if (!dir.entries.delete(name)) throw notFound(name);
    },
    async *entries() {
      for (const [name, child] of dir.entries) {
        yield [
          name,
          child.kind === "file" ? fileHandle(child) : dirHandle(child),
        ] as const;
      }
    },
  });

  return {
    /** The raw file names under `plugin-blobs/<pluginId>/`. */
    files(pluginId: string): string[] {
      const blobs = root.entries.get("plugin-blobs");
      const dir = blobs?.kind === "directory" && blobs.entries.get(pluginId);
      return dir && dir.kind === "directory" ? [...dir.entries.keys()] : [];
    },
    /** Make `getDirectory` unavailable (an insecure context, a denied
     *  origin) or available again. */
    setAvailable(on: boolean) {
      available = on;
    },
    install(): Restore {
      const storage = {
        getDirectory: async () => {
          if (!available)
            throw Object.assign(new Error("denied"), {
              name: "SecurityError",
            });
          return dirHandle(root);
        },
      };
      return defineGlobal(globalThis.navigator, "storage", storage);
    },
  };
}

/** The system clipboard, holding what a real one holds: one item with a
 *  `text/plain` and optionally a `text/html` representation. `refuse` makes
 *  writes reject the way the browser does without a user gesture. */
export function fakeSystemClipboard() {
  let item: Record<string, string> = {};
  let refuse = false;
  const writes: Array<Record<string, string>> = [];

  class FakeClipboardItem {
    constructor(readonly items: Record<string, Blob>) {}
  }

  const clipboard = {
    async readText(): Promise<string> {
      return item["text/plain"] ?? "";
    },
    async writeText(text: string): Promise<void> {
      if (refuse) throw new DOMException("no user gesture", "NotAllowedError");
      item = { "text/plain": text };
      writes.push(item);
    },
    async write(items: FakeClipboardItem[]): Promise<void> {
      if (refuse) throw new DOMException("no user gesture", "NotAllowedError");
      const next: Record<string, string> = {};
      for (const [type, blob] of Object.entries(items[0]?.items ?? {}))
        next[type] = await blob.text();
      item = next;
      writes.push(item);
    },
  };

  return {
    /** What the clipboard holds now, per MIME type. */
    current: () => ({ ...item }),
    /** Every write, in order. */
    writes,
    /** Put text on the clipboard as another application would. */
    putText(text: string) {
      item = { "text/plain": text };
    },
    setRefuse(on: boolean) {
      refuse = on;
    },
    install(): Restore {
      const a = defineGlobal(globalThis.navigator, "clipboard", clipboard);
      const b = defineGlobal(globalThis, "ClipboardItem", FakeClipboardItem);
      return () => {
        b();
        a();
      };
    },
  };
}

/** A `localStorage` (the Storage interface the SDK's default backing reads). */
export function fakeLocalStorage(): Restore {
  const map = new Map<string, string>();
  const storage = {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  return defineGlobal(globalThis, "localStorage", storage);
}
