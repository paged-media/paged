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

// Where a library keeps its repositories: the browser's origin-private file
// system in the app, memory in tests. Paths are `/`-separated and relative
// to the library root; directories are created on write.

export interface RepoFs {
  /** The whole file, or null when it does not exist. */
  read(path: string): Promise<Uint8Array | null>;
  readSlice(path: string, offset: number, length: number): Promise<Uint8Array>;
  /** Replaces the file. Atomic: a reader sees the old bytes or the new. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  append(path: string, bytes: Uint8Array): Promise<void>;
  /** Entry names in a directory; empty when it does not exist. */
  list(dir: string): Promise<string[]>;
  removeDir(dir: string): Promise<void>;
}

export function memoryFs(): RepoFs {
  const files = new Map<string, Uint8Array>();
  return {
    async read(path) {
      const f = files.get(path);
      return f ? f.slice() : null;
    },
    async readSlice(path, offset, length) {
      const f = files.get(path);
      if (!f) throw new Error(`no file ${path}`);
      return f.slice(offset, offset + length);
    },
    async write(path, bytes) {
      files.set(path, bytes.slice());
    },
    async append(path, bytes) {
      const old = files.get(path) ?? new Uint8Array();
      const next = new Uint8Array(old.length + bytes.length);
      next.set(old);
      next.set(bytes, old.length);
      files.set(path, next);
    },
    async list(dir) {
      const prefix = `${dir}/`;
      const names = new Set<string>();
      for (const p of files.keys()) {
        if (p.startsWith(prefix))
          names.add(p.slice(prefix.length).split("/")[0]);
      }
      return [...names].sort();
    },
    async removeDir(dir) {
      for (const p of [...files.keys()])
        if (p.startsWith(`${dir}/`)) files.delete(p);
    },
  };
}

// The File System Access typings in lib.dom vary by TS version; this is the
// subset used, declared rather than assumed.
interface Dir {
  getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<Dir>;
  getFileHandle(name: string, o?: { create?: boolean }): Promise<FileH>;
  removeEntry(name: string, o?: { recursive?: boolean }): Promise<void>;
  keys(): AsyncIterable<string>;
}
interface FileH {
  getFile(): Promise<File>;
  createWritable(o?: { keepExistingData?: boolean }): Promise<{
    seek(at: number): Promise<void>;
    write(data: BufferSource): Promise<void>;
    close(): Promise<void>;
  }>;
}

function notFound(e: unknown): boolean {
  return (
    e instanceof DOMException &&
    (e.name === "NotFoundError" || e.name === "TypeMismatchError")
  );
}

/** A library under `root` in the origin-private file system. */
export async function opfsFs(root = "paged-library"): Promise<RepoFs> {
  const storage = (
    globalThis.navigator as unknown as {
      storage?: { getDirectory?(): Promise<Dir> };
    }
  ).storage;
  if (!storage?.getDirectory)
    throw new Error("this browser has no origin-private file system");
  const top = await (
    await storage.getDirectory()
  ).getDirectoryHandle(root, { create: true });

  async function dirOf(parts: string[], create: boolean): Promise<Dir> {
    let d = top;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create });
    return d;
  }
  async function file(path: string, create: boolean): Promise<FileH> {
    const parts = path.split("/");
    const name = parts.pop()!;
    return (await dirOf(parts, create)).getFileHandle(name, { create });
  }

  return {
    async read(path) {
      try {
        return new Uint8Array(
          await (await (await file(path, false)).getFile()).arrayBuffer(),
        );
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
    async readSlice(path, offset, length) {
      const f = await (await file(path, false)).getFile();
      return new Uint8Array(
        await f.slice(offset, offset + length).arrayBuffer(),
      );
    },
    async write(path, bytes) {
      // createWritable writes a swap file and replaces the target on close.
      const w = await (await file(path, true)).createWritable();
      await w.write(bytes as BufferSource);
      await w.close();
    },
    async append(path, bytes) {
      const h = await file(path, true);
      const size = (await h.getFile()).size;
      const w = await h.createWritable({ keepExistingData: true });
      await w.seek(size);
      await w.write(bytes as BufferSource);
      await w.close();
    },
    async list(dir) {
      try {
        const out: string[] = [];
        for await (const k of (await dirOf(dir.split("/"), false)).keys())
          out.push(k);
        return out.sort();
      } catch (e) {
        if (notFound(e)) return [];
        throw e;
      }
    },
    async removeDir(dir) {
      const parts = dir.split("/");
      const name = parts.pop()!;
      try {
        await (
          await dirOf(parts, false)
        ).removeEntry(name, { recursive: true });
      } catch (e) {
        if (!notFound(e)) throw e;
      }
    },
  };
}
