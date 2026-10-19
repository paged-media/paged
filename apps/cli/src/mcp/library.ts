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

// A library of repositories on disk, the layout the Rust CLI's `paged
// library` writes and its `paged mcp` serves (engine/core/crates/paged-cli/
// src/library.rs), and the editor keeps in the browser (core ADR 180):
//
//   repos/<name>/meta.json        id, name, createdAt, updatedAt, head
//   repos/<name>/refs.json        written by the repository
//   repos/<name>/evidence.jsonl   appended by the repository
//   repos/<name>/packs/<n>.pack   objects, append-only
//   repos/<name>/packs/<n>.idx    written AFTER its pack: a pack with no index
//                                 is a write that did not finish, and is ignored
//
// The repository is the engine's own (`@paged-media/paged/repo`), so the two
// CLIs read and write one library interchangeably.

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The person a local library belongs to. */
export const LOCAL_OWNER = "user:local";

/** The slice of the wasm `Repository` the library drives. */
export interface WasmRepository {
  loadIndex(pack: number, index: Uint8Array): void;
  loadRefs(json: Uint8Array): void;
  loadEvidence(jsonl: Uint8Array): void;
  metadata(): string;
  locate(address: string): string | undefined;
  wanted(target: string, withHistory: boolean): string;
  provide(address: string, bytes: Uint8Array): void;
  flush(): {
    readonly packId: number | undefined;
    readonly packData: Uint8Array;
    readonly packIndex: Uint8Array;
    readonly refs: Uint8Array;
    readonly evidence: Uint8Array;
    free?(): void;
  };
  importFile(
    file: Uint8Array,
    name: string,
    ref: string,
    actor: string,
    ts: number,
  ): string;
  refs(): string;
  tree(target: string): string;
  readPart(target: string, path: string): Uint8Array;
  log(ref: string): string;
  diff(from: string, to: string): string;
  branchAgent(
    from: string,
    to: string,
    agent: string,
    client: string,
    run: string,
    onBehalfOf: string,
    ts: number,
  ): string;
  commitParts(
    branch: string,
    manifest: string,
    bytes: Uint8Array,
    agent: string,
    client: string,
    run: string,
    onBehalfOf: string,
    message: string,
    ts: number,
  ): string;
  saveAgent(
    file: Uint8Array,
    branch: string,
    base: string,
    agent: string,
    client: string,
    run: string,
    onBehalfOf: string,
    message: string,
    ts: number,
  ): string;
  export(
    target: string,
    withHistory: boolean,
    actor: string,
    ts: number,
  ): Uint8Array;
  free(): void;
}

interface RepoModule {
  initSync(m: { module: BufferSource }): unknown;
  Repository: new (owner: string) => WasmRepository;
}

/** The repository wasm of the engine package at `dir`, instantiated once. */
let repoModule: RepoModule | null = null;
export async function loadRepositoryWasm(dir: string): Promise<RepoModule> {
  if (repoModule) return repoModule;
  const mod = (await import(
    pathToFileURL(join(dir, "repo", "paged_repo_wasm.js")).href
  )) as RepoModule;
  mod.initSync({
    module: readFileSync(join(dir, "repo", "paged_repo_wasm_bg.wasm")),
  });
  repoModule = mod;
  return mod;
}

export const validName = (name: string): boolean =>
  /^[a-z0-9-]{1,64}$/.test(name);

/** `$PAGED_LIBRARY`, else `~/.paged/library` (the Rust CLI's default). */
export function defaultLibrary(): string {
  return process.env["PAGED_LIBRARY"] ?? join(homedir(), ".paged", "library");
}

interface Loc {
  hash: string;
  pack: number;
  offset: number;
  len: number;
}

export class DiskLibrary {
  constructor(
    readonly root: string,
    private readonly mod: RepoModule,
  ) {}

  private dir(name: string): string {
    if (!validName(name))
      throw new Error(
        `\`${name}\` is not a document name: lowercase letters, digits and '-'`,
      );
    return join(this.root, "repos", name);
  }

  list(): Record<string, unknown>[] {
    const repos = join(this.root, "repos");
    if (!existsSync(repos)) return [];
    const out: Record<string, unknown>[] = [];
    for (const d of readdirSync(repos)) {
      const meta = join(repos, d, "meta.json");
      if (existsSync(meta))
        out.push(
          JSON.parse(readFileSync(meta, "utf8")) as Record<string, unknown>,
        );
    }
    return out.sort(
      (a, b) => Number(b["updatedAt"] ?? 0) - Number(a["updatedAt"] ?? 0),
    );
  }

  /** The repository `name`, with its commits, trees and chunk lists read in. */
  open(name: string): WasmRepository {
    const dir = this.dir(name);
    if (!existsSync(join(dir, "meta.json")))
      throw new Error(`no document \`${name}\` in ${this.root}`);
    const repo = new this.mod.Repository(LOCAL_OWNER);
    const packs = join(dir, "packs");
    if (existsSync(packs))
      for (const f of readdirSync(packs)) {
        const m = /^(\d+)\.idx$/.exec(f);
        if (m) repo.loadIndex(Number(m[1]), readFileSync(join(packs, f)));
      }
    if (existsSync(join(dir, "refs.json")))
      repo.loadRefs(readFileSync(join(dir, "refs.json")));
    repo.loadEvidence(
      existsSync(join(dir, "evidence.jsonl"))
        ? readFileSync(join(dir, "evidence.jsonl"))
        : new Uint8Array(),
    );
    this.provide(name, repo, JSON.parse(repo.metadata()) as Loc[]);
    return repo;
  }

  private provide(name: string, repo: WasmRepository, locs: Loc[]): void {
    for (const l of locs) {
      const fd = openSync(join(this.dir(name), "packs", `${l.pack}.pack`), "r");
      try {
        const buf = new Uint8Array(l.len);
        readSync(fd, buf, 0, l.len, l.offset);
        repo.provide(l.hash, buf);
      } finally {
        closeSync(fd);
      }
    }
  }

  /** Runs `op`, reading whatever object it reports missing, and again. */
  run<T>(name: string, repo: WasmRepository, op: () => T): T {
    for (;;) {
      try {
        return op();
      } catch (e) {
        const m = /^missing:([0-9a-f]{64})$/.exec(
          e instanceof Error ? e.message : String(e),
        );
        const loc = m ? repo.locate(m[1]!) : undefined;
        if (!loc) throw e;
        this.provide(name, repo, [JSON.parse(loc) as Loc]);
      }
    }
  }

  /** Every object an export of `target` reads, in one pass. */
  prepareExport(name: string, repo: WasmRepository, target: string): void {
    this.provide(name, repo, JSON.parse(repo.wanted(target, false)) as Loc[]);
  }

  /** Writes what the last operations changed: pack, then index, then refs. */
  persist(name: string, repo: WasmRepository): void {
    const dir = this.dir(name);
    mkdirSync(join(dir, "packs"), { recursive: true });
    const f = repo.flush();
    if (f.packId !== undefined) {
      writeFileSync(join(dir, "packs", `${f.packId}.pack`), f.packData);
      writeFileSync(join(dir, "packs", `${f.packId}.idx`), f.packIndex);
    }
    writeFileSync(join(dir, "refs.json.tmp"), f.refs);
    renameSync(join(dir, "refs.json.tmp"), join(dir, "refs.json"));
    if (f.evidence.length)
      appendFileSync(join(dir, "evidence.jsonl"), f.evidence);
    f.free?.();
    const metaPath = join(dir, "meta.json");
    const now = Date.now();
    const meta = existsSync(metaPath)
      ? (JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>)
      : { id: name, name, createdAt: now };
    meta["updatedAt"] = now;
    meta["head"] =
      (JSON.parse(repo.refs()) as Record<string, string>)["main"] ?? null;
    writeFileSync(metaPath, JSON.stringify(meta));
  }

  /** Opens a file as a new document named `name`; returns the head. */
  import(name: string, file: Uint8Array, fileName: string): string {
    const dir = this.dir(name);
    if (existsSync(join(dir, "meta.json")))
      throw new Error(`a document named \`${name}\` exists`);
    mkdirSync(join(dir, "packs"), { recursive: true });
    const now = Date.now();
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ id: name, name, createdAt: now, updatedAt: now }),
    );
    const repo = new this.mod.Repository(LOCAL_OWNER);
    try {
      const head = repo.importFile(file, fileName, "main", LOCAL_OWNER, now);
      this.persist(name, repo);
      return head;
    } finally {
      repo.free();
    }
  }
}
