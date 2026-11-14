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
//   repos/<id>/checkpoints.json the named points of its timeline (editor ADR
//                               1234): commits on the `checkpoints` ref, or
//                               an import's first version

import type { RepoFs } from "./fs.ts";

/** The subset of `@paged-media/canvas-wasm/repo`'s `Repository` the library drives.
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
  importFile(
    file: Uint8Array,
    name: string,
    ref: string,
    actor: string,
    ts: number,
  ): string;
  offer(ref: string, known: string): string;
  locateMany(addresses: string): string;
  packOf(objects: string): Uint8Array;
  receivePack(
    pack: Uint8Array,
    ref: string,
    expected: string,
    next: string,
    actor: string,
    ts: number,
  ): void;
  importParts(
    manifest: string,
    bytes: Uint8Array,
    ref: string,
    actor: string,
    message: string,
    ts: number,
  ): string;
  readPart(target: string, path: string): Uint8Array;
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
  merge(
    source: string,
    target: string,
    actor: string,
    approvers: string[],
    ts: number,
  ): string;
  save(
    file: Uint8Array,
    ref: string,
    actor: string,
    message: string,
    ts: number,
  ): string;
  export(
    target: string,
    withHistory: boolean,
    actor: string,
    ts: number,
  ): Uint8Array;
  log(ref: string): string;
  refs(): string;
  branch(from: string, to: string, actor: string, ts: number): string;
  release(name: string, commit: string, actor: string, ts: number): void;
  restore(version: string, ref: string, actor: string, ts: number): string;
  diff(from: string, to: string): string;
  record(
    actor: string,
    action: string,
    target: string,
    result: string,
    ts: number,
  ): void;
  evidence(): string;
}

export interface DocumentEntry {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  head: string | null;
  /** The paged.server repository this document syncs with, when it has one. */
  remote?: { url: string; repo: string };
  /** `data` for a dataset: a repository of data parts rather than a page document. */
  kind?: "document" | "data";
}

/** One part of one version of a repository: `paged://[<ws>.]<repo>/<path>[?ref=<ref>]`. */
export interface PagedRef {
  workspace: string | null;
  repository: string;
  path: string;
  ref: string;
}

const NAME = /^[a-z0-9-]{1,64}$/;

/** Parses a `paged://` reference (core's `PagedRef`, the same grammar). */
export function parsePagedRef(url: string): PagedRef | null {
  if (!url.startsWith("paged://")) return null;
  const rest = url.slice("paged://".length);
  const [main, query = ""] = rest.split("?", 2);
  const slash = main.indexOf("/");
  if (slash < 0) return null;
  const authority = main.slice(0, slash);
  let path: string;
  try {
    path = decodeURIComponent(main.slice(slash + 1));
  } catch {
    return null;
  }
  const dot = authority.indexOf(".");
  const workspace = dot < 0 ? null : authority.slice(0, dot);
  const repository = dot < 0 ? authority : authority.slice(dot + 1);
  if (!NAME.test(repository) || (workspace !== null && !NAME.test(workspace)))
    return null;
  if (!path || path.split("/").some((s) => !s || s === "." || s === ".."))
    return null;
  const ref = new URLSearchParams(query).get("ref") || "main";
  return { workspace, repository, path, ref };
}

/** A paged.server repository and the bearer token to reach it with. */
export interface Remote {
  url: string;
  repo: string;
  token: string;
}

/** A paged.server error: its status and RFC 9457 problem. */
export class RemoteError extends Error {
  readonly status: number;
  constructor(status: number, title: string, detail: string) {
    super(`${status} ${title}${detail ? `: ${detail}` : ""}`);
    this.status = status;
  }
}

/** Uploads above this are split, well under the server's request limits. */
const PACK_MAX = 32 * 1024 * 1024;
const OFFER_BATCH = 4096;

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

/** The line of history checkpoints are committed on: a draft ref of the
 *  library's person (`drafts/<owner>/checkpoints`; the repository's ref
 *  families are main, drafts, agents' runs and releases), never main, so
 *  keeping a checkpoint never moves the saved version (a checkpoint is no
 *  save; editor ADRs 1204 and 1234). */
export function checkpointRef(owner: string): string {
  return `drafts/${owner}/checkpoints`;
}
/** Automatic checkpoints kept per document; older ones leave the timeline. */
export const MAX_AUTO_CHECKPOINTS = 20;
/** Named checkpoints a document keeps; one more is refused. */
export const MAX_NAMED_CHECKPOINTS = 100;
/** A checkpoint larger than this is not kept (the recovery journal's rule). */
export const MAX_CHECKPOINT_BYTES = 256 * 1024 * 1024;

/** Why a checkpoint was kept: named by the person; kept automatically at an
 *  import, an export or before an operation that replaces the document; or
 *  the state a publication was approved in. */
export type CheckpointKind =
  "named" | "import" | "export" | "before" | "approved";

/** One point of a document's timeline. */
export interface CheckpointEntry {
  id: string;
  name: string;
  kind: CheckpointKind;
  /** Kept automatically (and pruned beyond `MAX_AUTO_CHECKPOINTS`). */
  auto: boolean;
  /** The version it names (a commit address). */
  commit: string;
  ts: number;
  /** The document's page count then, when the caller knew it. */
  pages?: number;
}

const CHECKPOINT_KINDS: readonly CheckpointKind[] = [
  "named",
  "import",
  "export",
  "before",
  "approved",
];

/** One entry of `checkpoints.json`, shape-checked (ADR 247): an entry that
 *  cannot be read is left out. */
function readCheckpoint(v: unknown): CheckpointEntry | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  if (typeof e.id !== "string" || typeof e.name !== "string") return null;
  if (!CHECKPOINT_KINDS.includes(e.kind as CheckpointKind)) return null;
  if (typeof e.commit !== "string" || !/^[0-9a-f]{64}$/.test(e.commit))
    return null;
  if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) return null;
  const out: CheckpointEntry = {
    id: e.id,
    name: e.name,
    kind: e.kind as CheckpointKind,
    auto: e.auto === true,
    commit: e.commit,
    ts: e.ts,
  };
  if (typeof e.pages === "number" && Number.isInteger(e.pages) && e.pages >= 0)
    out.pages = e.pages;
  return out;
}

/** Why a checkpoint was not kept. */
export class CheckpointRefused extends Error {
  readonly reason: "too-large" | "too-many";
  constructor(reason: "too-large" | "too-many") {
    super(`checkpoint refused: ${reason}`);
    this.reason = reason;
  }
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
      repo.loadIndex(
        Number(m[1]),
        (await this.fs.read(`${dir}/packs/${name}`))!,
      );
    }
    const refs = await this.fs.read(`${dir}/refs.json`);
    if (refs) repo.loadRefs(refs);
    repo.loadEvidence(
      (await this.fs.read(`${dir}/evidence.jsonl`)) ?? new Uint8Array(),
    );
    const o: Open = {
      repo,
      meta: JSON.parse(dec.decode(metaBytes)) as DocumentEntry,
    };
    await this.provide(o, JSON.parse(repo.metadata()) as Loc[]);
    this.open.set(id, o);
    return o;
  }

  private async provide(o: Open, locs: Loc[]): Promise<void> {
    const dir = `repos/${o.meta.id}/packs`;
    const byPack = new Map<number, Loc[]>();
    for (const l of locs)
      byPack.set(l.pack, [...(byPack.get(l.pack) ?? []), l]);
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
        const m = /^missing:([0-9a-f]{64})$/.exec(
          e instanceof Error ? e.message : String(e),
        );
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
    if (f.evidence.length)
      await this.fs.append(`${dir}/evidence.jsonl`, f.evidence);
    f.free?.();
    const refs = JSON.parse(o.repo.refs()) as Record<string, string>;
    o.meta = { ...o.meta, updatedAt: this.now(), head: refs[MAIN] ?? null };
    await this.fs.write(`${dir}/meta.json`, enc.encode(JSON.stringify(o.meta)));
  }

  /** Opens a file as a new document. A file that carries its history brings
   *  it. The import is the first point of its timeline ("Imported <file>",
   *  editor ADR 1234) unless `checkpoint` is false (a blank document's first
   *  save is no import). */
  importFile(
    bytes: Uint8Array,
    name: string,
    options: { checkpoint?: boolean } = {},
  ): Promise<DocumentEntry> {
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
      if (options.checkpoint !== false && o.meta.head)
        await this.writeCheckpoints(id, [
          ...(await this.readCheckpoints(id)),
          {
            id: this.newId(),
            name,
            kind: "import",
            auto: true,
            commit: o.meta.head,
            ts: now,
          },
        ]);
      return o.meta;
    });
  }

  private async readCheckpoints(id: string): Promise<CheckpointEntry[]> {
    const bytes = await this.fs.read(`repos/${id}/checkpoints.json`);
    if (!bytes) return [];
    try {
      const parsed = JSON.parse(dec.decode(bytes)) as { checkpoints?: unknown };
      return Array.isArray(parsed.checkpoints)
        ? parsed.checkpoints
            .map(readCheckpoint)
            .filter((c): c is CheckpointEntry => c !== null)
        : [];
    } catch {
      return [];
    }
  }

  /** Writes the timeline, keeping the newest `MAX_AUTO_CHECKPOINTS`
   *  automatic checkpoints (named ones stay until removed). */
  private async writeCheckpoints(
    id: string,
    list: CheckpointEntry[],
  ): Promise<CheckpointEntry[]> {
    let autos = list.filter((c) => c.auto).length;
    const kept = list.filter((c) => {
      if (!c.auto || autos <= MAX_AUTO_CHECKPOINTS) return true;
      autos--;
      return false;
    });
    await this.fs.write(
      `repos/${id}/checkpoints.json`,
      enc.encode(JSON.stringify({ v: 1, checkpoints: kept })),
    );
    return kept;
  }

  /** The document's timeline, oldest first. */
  checkpoints(id: string): Promise<CheckpointEntry[]> {
    return this.serial(() => this.readCheckpoints(id));
  }

  /** Keeps `bytes` (the open document's state, saved or not) as a point of
   *  the timeline: a commit on `checkpointRef`, never on main. Bounded: a
   *  checkpoint over `MAX_CHECKPOINT_BYTES` is refused, a named one beyond
   *  `MAX_NAMED_CHECKPOINTS` too, and automatic ones beyond
   *  `MAX_AUTO_CHECKPOINTS` leave the timeline oldest first. A state equal to
   *  the newest checkpoint's makes no new commit. */
  checkpoint(
    id: string,
    bytes: Uint8Array,
    entry: { name: string; kind: CheckpointKind; pages?: number },
  ): Promise<CheckpointEntry> {
    return this.serial(async () => {
      if (bytes.length > MAX_CHECKPOINT_BYTES)
        throw new CheckpointRefused("too-large");
      const auto = entry.kind !== "named" && entry.kind !== "approved";
      const list = await this.readCheckpoints(id);
      if (!auto && list.filter((c) => !c.auto).length >= MAX_NAMED_CHECKPOINTS)
        throw new CheckpointRefused("too-many");
      const o = await this.load(id);
      const now = this.now();
      const commit = await this.faulting(o, () =>
        o.repo.save(
          bytes,
          checkpointRef(this.owner),
          this.owner,
          `Checkpoint: ${entry.name}`,
          now,
        ),
      );
      o.repo.record(this.owner, "checkpoint", entry.name, "ok", now);
      await this.persist(o);
      const made: CheckpointEntry = {
        id: this.newId(),
        name: entry.name,
        kind: entry.kind,
        auto,
        commit,
        ts: now,
        ...(entry.pages !== undefined ? { pages: entry.pages } : {}),
      };
      await this.writeCheckpoints(id, [...list, made]);
      return made;
    });
  }

  /** Takes a checkpoint off the timeline. Its version stays in the
   *  repository's history (nothing rewinds). */
  removeCheckpoint(id: string, checkpointId: string): Promise<void> {
    return this.serial(async () => {
      const list = await this.readCheckpoints(id);
      await this.writeCheckpoints(
        id,
        list.filter((c) => c.id !== checkpointId),
      );
    });
  }

  /** Makes a checkpoint's state current again as a NEW version of main
   *  ("Restore …"): the versions after it stay in the history. */
  restoreCheckpoint(id: string, checkpointId: string): Promise<string> {
    return this.serial(async () => {
      const c = (await this.readCheckpoints(id)).find(
        (x) => x.id === checkpointId,
      );
      if (!c) throw new Error(`no checkpoint ${checkpointId}`);
      const o = await this.load(id);
      const head = await this.faulting(o, () =>
        o.repo.restore(c.commit, MAIN, this.owner, this.now()),
      );
      await this.persist(o);
      return head;
    });
  }

  /** Commits a save. Returns the head and whether this save made a commit. */
  save(
    id: string,
    bytes: Uint8Array,
    message = "Save",
  ): Promise<{ head: string; changed: boolean }> {
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
  exportPaged(
    id: string,
    target = MAIN,
    withHistory = false,
  ): Promise<Uint8Array> {
    return this.serial(async () => {
      const o = await this.load(id);
      await this.provide(
        o,
        JSON.parse(o.repo.wanted(target, withHistory)) as Loc[],
      );
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
      return JSON.parse(
        await this.faulting(o, () => o.repo.log(ref)),
      ) as CommitInfo[];
    });
  }

  refs(id: string): Promise<Record<string, string>> {
    return this.serial(async () =>
      JSON.parse((await this.load(id)).repo.refs()),
    );
  }

  release(id: string, name: string, commit: string): Promise<void> {
    return this.serial(async () => {
      const o = await this.load(id);
      await this.faulting(o, () =>
        o.repo.release(name, commit, this.owner, this.now()),
      );
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
    return this.serial(async () =>
      JSON.parse((await this.load(id)).repo.evidence()),
    );
  }

  private async remoteCall(
    r: Remote,
    route: string,
    init: RequestInit = {},
  ): Promise<Response> {
    // `repo` or `workspace/repo`: a workspace's repository has its own prefix.
    const [first, second] = r.repo.split("/", 2);
    const prefix = second ? `w/${first}/r/${second}` : `r/${first}`;
    const url = `${r.url.replace(/\/$/, "")}/v1/${prefix}/${route}`;
    const resp = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        authorization: `Bearer ${r.token}`,
      },
    });
    if (!resp.ok) {
      let p: { title?: string; detail?: string } = {};
      try {
        p = await resp.json();
      } catch {
        /* not a problem document */
      }
      throw new RemoteError(
        resp.status,
        p.title ?? resp.statusText,
        p.detail ?? "",
      );
    }
    return resp;
  }

  private async remoteRefs(r: Remote): Promise<Record<string, string>> {
    try {
      return (await (await this.remoteCall(r, "refs")).json()) as Record<
        string,
        string
      >;
    } catch (e) {
      // A repository nobody has pushed to has no refs yet.
      if (e instanceof RemoteError && e.status === 404) return {};
      throw e;
    }
  }

  /** Pushes `main` to `remote`: only what the server lacks travels. */
  push(id: string, remote: Remote): Promise<{ sent: number; bytes: number }> {
    return this.serial(async () => {
      const o = await this.load(id);
      const theirs = await this.remoteRefs(remote);
      const offer = JSON.parse(
        o.repo.offer(MAIN, JSON.stringify(Object.values(theirs))),
      ) as {
        hash: string;
        kind: number;
      }[];
      const missing = new Set<string>();
      for (let i = 0; i < offer.length; i += OFFER_BATCH) {
        const batch = offer.slice(i, i + OFFER_BATCH).map((x) => x.hash);
        const resp = await this.remoteCall(remote, "have", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(batch),
        });
        for (const h of (await resp.json()) as string[]) missing.add(h);
      }
      const send = offer.filter((x) => missing.has(x.hash));
      const locs = JSON.parse(
        o.repo.locateMany(JSON.stringify(send.map((x) => x.hash))),
      ) as Loc[];
      await this.provide(o, locs);
      const size = new Map(locs.map((l) => [l.hash, l.len]));
      let sent = 0;
      let bytes = 0;
      for (let i = 0; i < send.length;) {
        let budget = 0;
        let j = i;
        while (
          j < send.length &&
          (j === i || budget + (size.get(send[j].hash) ?? 0) <= PACK_MAX)
        ) {
          budget += size.get(send[j].hash) ?? 0;
          j++;
        }
        const pack = o.repo.packOf(JSON.stringify(send.slice(i, j)));
        await this.remoteCall(remote, "objects", {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: pack as BodyInit,
        });
        sent += j - i;
        bytes += pack.length;
        i = j;
      }
      const head = (JSON.parse(o.repo.refs()) as Record<string, string>)[MAIN];
      await this.remoteCall(remote, `refs/${MAIN}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected: theirs[MAIN] ?? null, new: head }),
      });
      o.repo.evictBlobs();
      o.repo.record(
        this.owner,
        "push",
        `${remote.url}/${remote.repo}`,
        "ok",
        this.now(),
      );
      o.meta = { ...o.meta, remote: { url: remote.url, repo: remote.repo } };
      await this.persist(o);
      return { sent, bytes };
    });
  }

  /** Pulls `main` from `remote`. The local kernel decides: a remote that has
   *  moved away from this document's history is refused, not merged. */
  pull(
    id: string,
    remote: Remote,
  ): Promise<{ head: string; changed: boolean }> {
    return this.serial(async () => {
      const o = await this.load(id);
      const theirs = (await this.remoteRefs(remote))[MAIN];
      if (!theirs)
        throw new RemoteError(404, "Not found", `no ${MAIN} on the server`);
      const mine = (JSON.parse(o.repo.refs()) as Record<string, string>)[MAIN];
      if (mine === theirs) return { head: theirs, changed: false };
      const resp = await this.remoteCall(remote, "fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          want: theirs,
          have: Object.values(JSON.parse(o.repo.refs())),
        }),
      });
      const pack = new Uint8Array(await resp.arrayBuffer());
      await this.faulting(o, () =>
        o.repo.receivePack(
          pack,
          MAIN,
          mine ?? "",
          theirs,
          this.owner,
          this.now(),
        ),
      );
      o.repo.record(
        this.owner,
        "pull",
        `${remote.url}/${remote.repo}`,
        "ok",
        this.now(),
      );
      o.meta = { ...o.meta, remote: { url: remote.url, repo: remote.repo } };
      await this.persist(o);
      return { head: theirs, changed: true };
    });
  }

  /** Clones a remote repository into the library as a new document. */
  clone(remote: Remote, name: string): Promise<DocumentEntry> {
    return this.serial(async () => {
      const theirs = (await this.remoteRefs(remote))[MAIN];
      if (!theirs)
        throw new RemoteError(404, "Not found", `no ${MAIN} on the server`);
      const resp = await this.remoteCall(remote, "fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ want: theirs, have: [] }),
      });
      const pack = new Uint8Array(await resp.arrayBuffer());
      const now = this.now();
      const meta: DocumentEntry = {
        id: this.newId(),
        name,
        createdAt: now,
        updatedAt: now,
        head: null,
        remote: { url: remote.url, repo: remote.repo },
      };
      const o: Open = { repo: this.options.createRepository(this.owner), meta };
      o.repo.receivePack(pack, MAIN, "", theirs, this.owner, now);
      o.repo.record(
        this.owner,
        "clone",
        `${remote.url}/${remote.repo}`,
        "ok",
        now,
      );
      await this.persist(o);
      this.open.set(meta.id, o);
      return o.meta;
    });
  }

  /** Keeps a file a model saved as an agent's version on `agent/<run>/live`,
   *  started at main, naming this library's person as the one it acted for.
   *  Main does not move: the person merges it (`mergeBranch`) after review. */
  saveAgent(
    id: string,
    bytes: Uint8Array,
    who: { agent: string; client: string; run: string },
    message: string,
  ): Promise<{ branch: string; head: string }> {
    return this.serial(async () => {
      const o = await this.load(id);
      const run = who.run.toLowerCase().replace(/[^a-z0-9-]/g, "-") || "run";
      const branch = `agent/${run}/live`;
      const head = await this.faulting(o, () =>
        o.repo.saveAgent(
          bytes,
          branch,
          MAIN,
          who.agent,
          who.client,
          run,
          this.owner,
          message,
          this.now(),
        ),
      );
      await this.persist(o);
      return { branch, head };
    });
  }

  /** Merges `source` into main, approved by this library's person. */
  mergeBranch(id: string, source: string): Promise<string> {
    return this.serial(async () => {
      const o = await this.load(id);
      const head = await this.faulting(o, () =>
        o.repo.merge(source, MAIN, this.owner, [this.owner], this.now()),
      );
      await this.persist(o);
      return head;
    });
  }

  /** Opens a set of data files as a new dataset: a repository of data parts,
   *  versioned like any document and named by `paged://` references. */
  importDataset(
    name: string,
    files: { path: string; bytes: Uint8Array }[],
  ): Promise<DocumentEntry> {
    return this.serial(async () => {
      const total = files.reduce((n, f) => n + f.bytes.length, 0);
      const bytes = new Uint8Array(total);
      const manifest: { path: string; offset: number; len: number }[] = [];
      let at = 0;
      for (const f of files) {
        bytes.set(f.bytes, at);
        manifest.push({ path: f.path, offset: at, len: f.bytes.length });
        at += f.bytes.length;
      }
      const now = this.now();
      const meta: DocumentEntry = {
        id: this.newId(),
        name,
        createdAt: now,
        updatedAt: now,
        head: null,
        kind: "data",
      };
      const o: Open = { repo: this.options.createRepository(this.owner), meta };
      o.repo.importParts(
        JSON.stringify(manifest),
        bytes,
        MAIN,
        this.owner,
        `Open ${name}`,
        now,
      );
      await this.persist(o);
      this.open.set(meta.id, o);
      return o.meta;
    });
  }

  /** One part of a version (a ref or a commit address). */
  readPart(id: string, path: string, ref = MAIN): Promise<Uint8Array> {
    return this.serial(async () => {
      const o = await this.load(id);
      const bytes = await this.faulting(o, () => o.repo.readPart(ref, path));
      o.repo.evictBlobs();
      return bytes;
    });
  }

  /** The bytes a `paged://` reference names: from this library when it holds
   *  that repository (by its server name, or its own), else from `remote`. */
  async resolve(
    url: string,
    remote?: { url: string; token: string },
  ): Promise<Uint8Array> {
    const r = parsePagedRef(url);
    if (!r) throw new Error(`not a paged:// reference: ${url}`);
    const wanted = r.workspace
      ? `${r.workspace}/${r.repository}`
      : r.repository;
    const local = (await this.list()).find(
      (d) =>
        d.remote?.repo === wanted || (!r.workspace && d.name === r.repository),
    );
    if (local) return this.readPart(local.id, r.path, r.ref);
    if (!remote)
      throw new Error(
        `${wanted} is not in this library, and there is no server to ask`,
      );
    const q = `ref=${encodeURIComponent(r.ref)}&path=${encodeURIComponent(r.path)}`;
    const resp = await this.remoteCall(
      { url: remote.url, repo: wanted, token: remote.token },
      `part?${q}`,
    );
    return new Uint8Array(await resp.arrayBuffer());
  }

  rename(id: string, name: string): Promise<DocumentEntry> {
    return this.serial(async () => {
      const o = await this.load(id);
      o.meta = { ...o.meta, name };
      await this.fs.write(
        `repos/${id}/meta.json`,
        enc.encode(JSON.stringify(o.meta)),
      );
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
