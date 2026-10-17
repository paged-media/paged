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

// The local library: every document the editor has opened or saved, each one
// a repository (core ADR 180) kept as packs in a RepoFs. A file on disk is a
// projection of a repository; this is where the repository lives when there
// is no server, and it is complete on its own.
//
//   repos/<id>/meta.json        name, created, updated, head
//   repos/<id>/refs.json        written by the repository
//   repos/<id>/evidence.jsonl   appended by the repository
//   repos/<id>/packs/<n>.pack   objects, append-only
//   repos/<id>/packs/<n>.idx    written AFTER its pack: a pack with no index
//                               is a write that did not finish, and is ignored

import type { RepoFs } from "./fs.ts";

/** The subset of `@paged-media/repo-wasm`'s `Repository` the library drives.
 *  Declared here so the library runs against the real wasm and in tests alike. */
export interface WasmRepository {
  loadIndex(pack: number, index: Uint8Array): void;
  loadRefs(json: Uint8Array): void;
  loadEvidence(jsonl: Uint8Array): void;
  metadata(): string;
  wanted(target: string, withHistory: boolean): string;
  locate(address: string): string | undefined;
  provide(address: string, bytes: Uint8Array): void;
  evictBlobs(): void;
  flush(): {
    readonly packId: number | undefined;
    readonly packData: Uint8Array;
    readonly packIndex: Uint8Array;
    readonly refs: Uint8Array;
    readonly evidence: Uint8Array;
    free?(): void;
  };
  importFile(file: Uint8Array, name: string, ref: string, actor: string, ts: number): string;
  save(file: Uint8Array, ref: string, actor: string, message: string, ts: number): string;
  export(target: string, withHistory: boolean, actor: string, ts: number): Uint8Array;
  log(ref: string): string;
  refs(): string;
  branch(from: string, to: string, actor: string, ts: number): string;
  release(name: string, commit: string, actor: string, ts: number): void;
  restore(version: string, ref: string, actor: string, ts: number): string;
  diff(from: string, to: string): string;
  record(actor: string, action: string, target: string, result: string, ts: number): void;
  evidence(): string;
}

export interface DocumentEntry {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  head: string | null;
}

export interface CommitInfo {
  hash: string;
  parents: string[];
  tree: string;
  author: string;
  agent: boolean;
  message: string;
  ts: number;
  imported_from?: string;
}

export interface EvidenceInfo {
  seq: number;
  ts: number;
  actor: { id: string; kind: string };
  action: string;
  target: string;
  result: string;
}

interface Loc {
  hash: string;
  pack: number;
  offset: number;
  len: number;
}

interface Open {
  repo: WasmRepository;
  meta: DocumentEntry;
}

const MAIN = "main";
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface LibraryOptions {
  /** Makes an empty repository owned by `owner`. */
  createRepository: (owner: string) => WasmRepository;
  /** The device's one human until an identity is connected. */
  owner?: string;
  now?: () => number;
  newId?: () => string;
}

export class Library {
  private readonly open = new Map<string, Open>();
  private readonly owner: string;
  private readonly now: () => number;
  private readonly newId: () => string;
  /** One operation at a time: a repository is single-writer. */
  private queue: Promise<unknown> = Promise.resolve();

  private readonly fs: RepoFs;
  private readonly options: LibraryOptions;

  constructor(fs: RepoFs, options: LibraryOptions) {
    this.fs = fs;
    this.options = options;
    this.owner = options.owner ?? "user:local";
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.queue.then(f, f);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async list(): Promise<DocumentEntry[]> {
    const out: DocumentEntry[] = [];
    for (const id of await this.fs.list("repos")) {
      const meta = await this.fs.read(`repos/${id}/meta.json`);
      if (meta) out.push(JSON.parse(dec.decode(meta)) as DocumentEntry);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async load(id: string): Promise<Open> {
    const cached = this.open.get(id);
    if (cached) return cached;
    const dir = `repos/${id}`;
    const metaBytes = await this.fs.read(`${dir}/meta.json`);
    if (!metaBytes) throw new Error(`no document ${id} in the library`);
    const repo = this.options.createRepository(this.owner);
    for (const name of await this.fs.list(`${dir}/packs`)) {
      const m = /^(\d+)\.idx$/.exec(name);
      if (!m) continue;
      repo.loadIndex(Number(m[1]), (await this.fs.read(`${dir}/packs/${name}`))!);
    }
    const refs = await this.fs.read(`${dir}/refs.json`);
    if (refs) repo.loadRefs(refs);
    repo.loadEvidence((await this.fs.read(`${dir}/evidence.jsonl`)) ?? new Uint8Array());
    const o: Open = { repo, meta: JSON.parse(dec.decode(metaBytes)) as DocumentEntry };
    await this.provide(o, JSON.parse(repo.metadata()) as Loc[]);
    this.open.set(id, o);
    return o;
  }

  private async provide(o: Open, locs: Loc[]): Promise<void> {
    const dir = `repos/${o.meta.id}/packs`;
    const byPack = new Map<number, Loc[]>();
    for (const l of locs) byPack.set(l.pack, [...(byPack.get(l.pack) ?? []), l]);
    for (const [pack, ls] of byPack) {
      const path = `${dir}/${pack}.pack`;
      // Many objects from one pack: one read of the pack beats one per object.
      const whole = ls.length > 8 ? await this.fs.read(path) : null;
      for (const l of ls) {
        const bytes = whole
          ? whole.subarray(l.offset, l.offset + l.len)
          : await this.fs.readSlice(path, l.offset, l.len);
        o.repo.provide(l.hash, bytes);
      }
    }
  }

  /** Runs `op`, reading any object it reports missing and running it again. */
  private async faulting<T>(o: Open, op: () => T): Promise<T> {
    for (;;) {
      try {
        return op();
      } catch (e) {
        const m = /^missing:([0-9a-f]{64})$/.exec(e instanceof Error ? e.message : String(e));
        const loc = m ? o.repo.locate(m[1]) : undefined;
        if (!loc) throw e;
        await this.provide(o, [JSON.parse(loc) as Loc]);
      }
    }
  }

  /** Writes what the last operation changed: pack, then index, then refs. */
  private async persist(o: Open): Promise<void> {
    const dir = `repos/${o.meta.id}`;
    const f = o.repo.flush();
    if (f.packId !== undefined) {
      await this.fs.write(`${dir}/packs/${f.packId}.pack`, f.packData);
      await this.fs.write(`${dir}/packs/${f.packId}.idx`, f.packIndex);
    }
    await this.fs.write(`${dir}/refs.json`, f.refs);
    if (f.evidence.length) await this.fs.append(`${dir}/evidence.jsonl`, f.evidence);
    f.free?.();
    const refs = JSON.parse(o.repo.refs()) as Record<string, string>;
    o.meta = { ...o.meta, updatedAt: this.now(), head: refs[MAIN] ?? null };
    await this.fs.write(`${dir}/meta.json`, enc.encode(JSON.stringify(o.meta)));
  }

  /** Opens a file as a new document. A file that carries its history brings it. */
  importFile(bytes: Uint8Array, name: string): Promise<DocumentEntry> {
    return this.serial(async () => {
      const id = this.newId();
      const now = this.now();
      const meta: DocumentEntry = {
        id,
        name: name.replace(/\.(paged|idml)$/i, "") || "Untitled",
        createdAt: now,
        updatedAt: now,
        head: null,
      };
      const o: Open = { repo: this.options.createRepository(this.owner), meta };
      o.repo.importFile(bytes, name, MAIN, this.owner, now);
      await this.persist(o);
      this.open.set(id, o);
      return o.meta;
    });
  }

  /** Commits a save. Returns the head and whether this save made a commit. */
  save(id: string, bytes: Uint8Array, message = "Save"): Promise<{ head: string; changed: boolean }> {
    return this.serial(async () => {
      const o = await this.load(id);
      const before = o.meta.head;
      const head = await this.faulting(o, () =>
        o.repo.save(bytes, MAIN, this.owner, message, this.now()),
      );
      await this.persist(o);
      return { head, changed: head !== before };
    });
  }

  /** The `.paged` bytes of `target` (a ref or a commit), optionally with history. */
  exportPaged(id: string, target = MAIN, withHistory = false): Promise<Uint8Array> {
    return this.serial(async () => {
      const o = await this.load(id);
      await this.provide(o, JSON.parse(o.repo.wanted(target, withHistory)) as Loc[]);
      const bytes = await this.faulting(o, () =>
        o.repo.export(target, withHistory, this.owner, this.now()),
      );
      o.repo.evictBlobs();
      await this.persist(o);
      return bytes;
    });
  }

  log(id: string, ref = MAIN): Promise<CommitInfo[]> {
    return this.serial(async () => {
      const o = await this.load(id);
      return JSON.parse(await this.faulting(o, () => o.repo.log(ref))) as CommitInfo[];
    });
  }

  refs(id: string): Promise<Record<string, string>> {
    return this.serial(async () => JSON.parse((await this.load(id)).repo.refs()));
  }

  release(id: string, name: string, commit: string): Promise<void> {
    return this.serial(async () => {
      const o = await this.load(id);
      await this.faulting(o, () => o.repo.release(name, commit, this.owner, this.now()));
      await this.persist(o);
    });
  }

  /** Makes an earlier version current again, as a new commit. */
  restore(id: string, version: string): Promise<string> {
    return this.serial(async () => {
      const o = await this.load(id);
      const head = await this.faulting(o, () =>
        o.repo.restore(version, MAIN, this.owner, this.now()),
      );
      await this.persist(o);
      return head;
    });
  }

  diff(id: string, from: string, to: string): Promise<[string, string][]> {
    return this.serial(async () => {
      const o = await this.load(id);
      return JSON.parse(await this.faulting(o, () => o.repo.diff(from, to)));
    });
  }

  evidence(id: string): Promise<EvidenceInfo[]> {
    return this.serial(async () => JSON.parse((await this.load(id)).repo.evidence()));
  }

  rename(id: string, name: string): Promise<DocumentEntry> {
    return this.serial(async () => {
      const o = await this.load(id);
      o.meta = { ...o.meta, name };
      await this.fs.write(`repos/${id}/meta.json`, enc.encode(JSON.stringify(o.meta)));
      return o.meta;
    });
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      this.open.delete(id);
      await this.fs.removeDir(`repos/${id}`);
    });
  }
}
