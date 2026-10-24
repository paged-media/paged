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

// The Tier-A model cache (editor ADR 290): models the user installed, kept
// in the origin private file system (OPFS) of this browser, one directory
// per model. A download happens only with the user's consent (and their
// acknowledgement of the licence, when it asks for one), only from the
// URL the registry names, only from an origin the network wall admits,
// and is kept only when every file has the registry's size and sha256.
// Loading checks the hashes again: a file changed on disk is removed, not
// run.

import { sha256Hex } from "@paged-media/helpers";

import type { ModelEntry, ModelVariant } from "./registry";
import { variantOf } from "./registry";

/** Where the model files live: OPFS in the editor, memory in tests. */
export interface ModelFiles {
  write(dir: string, name: string, bytes: Uint8Array): Promise<void>;
  read(dir: string, name: string): Promise<Uint8Array | null>;
  removeDir(dir: string): Promise<void>;
  list(): Promise<Array<{ dir: string; name: string; size: number }>>;
}

/** The user's answer in the consent dialog. */
export interface ModelConsent {
  /** Download this many bytes from these origins. */
  consented: boolean;
  /** The licence was shown and accepted (needed when it asks for it). */
  licenceAcknowledged: boolean;
}

/** What an installed model's directory records. */
export interface InstallRecord {
  model: string;
  variant: string;
  files: Array<{ name: string; sha256: string; size: number }>;
  installedAt: string;
}

export interface InstallProgress {
  file: string;
  loaded: number;
  total: number;
}

export class ModelConsentError extends Error {
  override name = "ModelConsentError";
}
export class ModelIntegrityError extends Error {
  override name = "ModelIntegrityError";
}
export class ModelBlockedError extends Error {
  override name = "ModelBlockedError";
}

const RECORD = "install.json";

/** A model's directory name (its id is already path-safe). */
const dirOf = (entry: ModelEntry) => entry.id;

export interface ModelStoreOptions {
  files: ModelFiles;
  /** The page's origin: relative URLs resolve against it. */
  origin: string;
  fetch?: typeof fetch;
  /** Whether the network wall admits an origin (ADR 218). Default: only
   *  the page's own. */
  admitted?: (origin: string) => boolean;
}

export class ModelStore {
  private readonly files: ModelFiles;
  private readonly origin: string;
  private readonly doFetch: typeof fetch;
  private readonly admitted: (origin: string) => boolean;

  constructor(options: ModelStoreOptions) {
    this.files = options.files;
    this.origin = options.origin;
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.admitted = options.admitted ?? ((o) => o === options.origin);
  }

  /** The origins a variant downloads from (the consent dialog lists them). */
  originsOf(variant: ModelVariant): string[] {
    return [
      ...new Set(variant.files.map((f) => new URL(f.url, this.origin).origin)),
    ];
  }

  /** The origins of a variant this build's wall does not admit. */
  blockedOrigins(variant: ModelVariant): string[] {
    return this.originsOf(variant).filter((o) => !this.admitted(o));
  }

  async installed(entry: ModelEntry): Promise<InstallRecord | null> {
    const raw = await this.files.read(dirOf(entry), RECORD);
    if (!raw) return null;
    try {
      const record = JSON.parse(new TextDecoder().decode(raw)) as InstallRecord;
      if (record.model !== entry.id || !Array.isArray(record.files))
        return null;
      return record;
    } catch {
      return null;
    }
  }

  /** Download, check and keep a variant. Refuses without consent, without
   *  the licence acknowledged when it asks for it, and for an origin the
   *  wall does not admit. */
  async install(
    entry: ModelEntry,
    options: {
      variant?: string;
      consent: ModelConsent;
      onProgress?: (p: InstallProgress) => void;
      signal?: AbortSignal;
    },
  ): Promise<InstallRecord> {
    if (entry.install !== "download")
      throw new ModelConsentError(
        `${entry.title} is installed by you, not downloaded: give its file paths in Settings ▸ Models`,
      );
    if (!options.consent.consented)
      throw new ModelConsentError(
        `installing ${entry.title} needs your consent`,
      );
    if (
      entry.licence.requiresAcknowledgement &&
      !options.consent.licenceAcknowledged
    )
      throw new ModelConsentError(
        `installing ${entry.title} needs you to acknowledge the ${entry.licence.title}`,
      );
    const variant = variantOf(entry, options.variant);
    const blocked = this.blockedOrigins(variant);
    if (blocked.length)
      throw new ModelBlockedError(
        `this build's network wall does not admit ${blocked.join(", ")} (ADR 218: list it in PAGED_DATA_ORIGINS, or mirror the model on this origin)`,
      );
    const dir = dirOf(entry);
    await this.files.removeDir(dir);
    try {
      for (const file of variant.files) {
        const bytes = await this.download(file, options);
        if (bytes.length !== file.size)
          throw new ModelIntegrityError(
            `${file.name}: ${bytes.length} bytes, the registry says ${file.size}`,
          );
        const sha = await sha256Hex(bytes);
        if (sha !== file.sha256)
          throw new ModelIntegrityError(
            `${file.name}: sha256 ${sha} is not the registry's ${file.sha256}`,
          );
        await this.files.write(dir, file.name, bytes);
      }
      const record: InstallRecord = {
        model: entry.id,
        variant: variant.id,
        files: variant.files.map(({ name, sha256, size }) => ({
          name,
          sha256,
          size,
        })),
        installedAt: new Date().toISOString(),
      };
      await this.files.write(
        dir,
        RECORD,
        new TextEncoder().encode(JSON.stringify(record)),
      );
      return record;
    } catch (err) {
      await this.files.removeDir(dir);
      throw err;
    }
  }

  private async download(
    file: { name: string; url: string; size: number },
    options: {
      onProgress?: (p: InstallProgress) => void;
      signal?: AbortSignal;
    },
  ): Promise<Uint8Array> {
    const url = new URL(file.url, this.origin);
    const res = await this.doFetch(url, {
      credentials: "omit",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!res.ok)
      throw new Error(`${file.name}: ${url.href} answered ${res.status}`);
    const out = new Uint8Array(file.size);
    let loaded = 0;
    if (!res.body) {
      const all = new Uint8Array(await res.arrayBuffer());
      if (all.length > file.size)
        throw new ModelIntegrityError(
          `${file.name}: more than the registry's ${file.size} bytes`,
        );
      out.set(all);
      loaded = all.length;
    } else {
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (loaded + value.length > file.size) {
          await reader.cancel();
          throw new ModelIntegrityError(
            `${file.name}: more than the registry's ${file.size} bytes`,
          );
        }
        out.set(value, loaded);
        loaded += value.length;
        options.onProgress?.({ file: file.name, loaded, total: file.size });
      }
    }
    return out.subarray(0, loaded);
  }

  /** The installed files, each checked against its recorded hash. A file
   *  that changed is a `ModelIntegrityError`, and the model is removed. */
  async load(entry: ModelEntry): Promise<Map<string, Uint8Array>> {
    const record = await this.installed(entry);
    if (!record) throw new Error(`${entry.title} is not installed`);
    const out = new Map<string, Uint8Array>();
    for (const f of record.files) {
      const bytes = await this.files.read(dirOf(entry), f.name);
      const sha = bytes ? await sha256Hex(bytes) : null;
      if (!bytes || bytes.length !== f.size || sha !== f.sha256) {
        await this.files.removeDir(dirOf(entry));
        throw new ModelIntegrityError(
          `${entry.title}: ${f.name} changed on disk since it was installed; it was removed — install it again`,
        );
      }
      out.set(f.name, bytes);
    }
    return out;
  }

  async remove(entry: ModelEntry): Promise<void> {
    await this.files.removeDir(dirOf(entry));
  }

  /** Bytes the cache holds, per model and in all. */
  async diskUse(): Promise<{ total: number; byModel: Record<string, number> }> {
    const byModel: Record<string, number> = {};
    let total = 0;
    for (const f of await this.files.list()) {
      byModel[f.dir] = (byModel[f.dir] ?? 0) + f.size;
      total += f.size;
    }
    return { total, byModel };
  }
}

/** Files in memory (tests, and a browser without OPFS: nothing persists). */
export function createMemoryModelFiles(): ModelFiles & {
  map: Map<string, Uint8Array>;
} {
  const map = new Map<string, Uint8Array>();
  const k = (dir: string, name: string) => `${dir}/${name}`;
  return {
    map,
    async write(dir, name, bytes) {
      map.set(k(dir, name), new Uint8Array(bytes));
    },
    async read(dir, name) {
      const b = map.get(k(dir, name));
      return b ? new Uint8Array(b) : null;
    },
    async removeDir(dir) {
      for (const key of [...map.keys()])
        if (key.startsWith(`${dir}/`)) map.delete(key);
    },
    async list() {
      return [...map.entries()].map(([key, b]) => {
        const i = key.indexOf("/");
        return { dir: key.slice(0, i), name: key.slice(i + 1), size: b.length };
      });
    },
  };
}

/** Files in the origin private file system, under one root directory. */
export function createOpfsModelFiles(rootName = "paged-ml-models"): ModelFiles {
  const root = async () =>
    (await navigator.storage.getDirectory()).getDirectoryHandle(rootName, {
      create: true,
    });
  const dirHandle = async (dir: string, create: boolean) => {
    try {
      return await (await root()).getDirectoryHandle(dir, { create });
    } catch {
      return null;
    }
  };
  return {
    async write(dir, name, bytes) {
      const d = await dirHandle(dir, true);
      const fh = await d!.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(bytes as Uint8Array<ArrayBuffer>);
      await w.close();
    },
    async read(dir, name) {
      const d = await dirHandle(dir, false);
      if (!d) return null;
      try {
        const file = await (await d.getFileHandle(name)).getFile();
        return new Uint8Array(await file.arrayBuffer());
      } catch {
        return null;
      }
    },
    async removeDir(dir) {
      try {
        await (await root()).removeEntry(dir, { recursive: true });
      } catch {
        // not there
      }
    },
    async list() {
      const out: Array<{ dir: string; name: string; size: number }> = [];
      const r = await root();
      for await (const [dir, handle] of (
        r as unknown as {
          entries(): AsyncIterable<[string, FileSystemHandle]>;
        }
      ).entries()) {
        if (handle.kind !== "directory") continue;
        for await (const [name, fh] of (
          handle as unknown as {
            entries(): AsyncIterable<[string, FileSystemHandle]>;
          }
        ).entries()) {
          if (fh.kind !== "file") continue;
          const file = await (fh as FileSystemFileHandle).getFile();
          out.push({ dir, name, size: file.size });
        }
      }
      return out;
    },
  };
}
