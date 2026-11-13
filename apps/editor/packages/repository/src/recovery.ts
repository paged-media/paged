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

// The recovery journal (the UX strategy's §6.2, interaction spec
// UXI-MUT-008 to UXI-MUT-010): checkpoints of the open document's unsaved
// work, kept on this device so a crashed or reloaded tab can offer them
// back. A checkpoint is NO SAVE: it never touches the document's file, its
// library history or its host, and the chrome never calls it saved.
//
// ONE SESSION PER EDITOR. An editor begins a session when it mounts and
// holds a lock named after it for as long as it lives (Web Locks; the lock
// goes with the page, so a crash or a reload releases it). A session that
// ended cleanly purged its checkpoints; one whose directory is still there
// and whose lock nobody holds ended without that: its newest checkpoint is
// offered back. Two editors on one page, or two tabs, each have their own
// session and never see each other's work as orphaned.
//
// BOUNDED. A session keeps its newest `keepPerSession` checkpoints; a
// checkpoint larger than `maxCheckpointBytes` is not kept; orphaned
// sessions older than `maxAgeMs`, beyond `maxSessions`, or beyond
// `maxBytes` in total are pruned, oldest first.
//
// Layout under the journal's root (a `RepoFs`: the origin-private file
// system in the app, memory in tests):
//
//   <session>/meta.json      the session's checkpoints, newest last
//   <session>/<seq>.paged    one checkpoint's bytes

import type { RepoFs } from "./fs.ts";

/** What a checkpoint is a copy of. */
export interface RecoveryDocument {
  /** The open document's identity key (editor ADR 264: `lib:`, `fh:`,
   *  `t:`), so a checkpoint is matched to the right source. */
  readonly key: string;
  /** The key names the same document in a later session. */
  readonly stable: boolean;
  /** Its display name. */
  readonly name: string;
  /** Where its last saved version lives, to compare against. */
  readonly source:
    | { readonly kind: "library"; readonly documentId: string }
    | { readonly kind: "file"; readonly name: string }
    | { readonly kind: "none" };
  readonly openedAt: number;
  /** When this session last saved it (null: not since it was opened). */
  readonly savedAt: number | null;
}

export type CheckpointReason =
  /** After a pause in editing. */
  | "idle"
  /** After a number of accepted operations. */
  | "operations"
  /** Before the document is replaced (a load can fail or run out of
   *  memory). */
  | "before-replace"
  /** The page was hidden (it may not come back). */
  | "hidden"
  /** A document restored from the journal, kept again at once. */
  | "recovered";

export interface RecoveryCheckpoint {
  readonly session: string;
  readonly seq: number;
  readonly at: number;
  readonly reason: CheckpointReason;
  readonly document: RecoveryDocument;
  /** Accepted operations since the document was last saved (or opened). */
  readonly edits: number;
  readonly pages: number | null;
  readonly bytes: number;
}

/** Which sessions are alive: Web Locks in a browser, a set in tests. */
export interface RecoveryLiveness {
  /** Hold `name` for as long as the session lives; resolves to the
   *  release once held. */
  hold(name: string): Promise<() => void>;
  /** Hold `name` if nobody does; null when somebody does. */
  tryHold(name: string): Promise<(() => void) | null>;
  /** The names held anywhere (every tab of this origin). */
  held(): Promise<Set<string>>;
}

interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
  request(
    name: string,
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
  query(): Promise<{ held?: { name?: string }[] }>;
}

/** Liveness through the Web Locks API. */
export function webLocksLiveness(locks: LockManagerLike): RecoveryLiveness {
  return {
    hold: (name) =>
      new Promise((resolve) => {
        void locks.request(
          name,
          () =>
            new Promise<void>((release) => {
              resolve(() => release());
            }),
        );
      }),
    tryHold: (name) =>
      new Promise((resolve) => {
        void locks.request(name, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(null);
            return;
          }
          return new Promise<void>((release) => {
            resolve(() => release());
          });
        });
      }),
    async held() {
      const state = await locks.query();
      return new Set(
        (state.held ?? []).flatMap((l) => (l.name ? [l.name] : [])),
      );
    },
  };
}

/** Liveness in memory: share one between journals to model several tabs. */
export function memoryLiveness(): RecoveryLiveness {
  const names = new Set<string>();
  const take = (name: string) => {
    names.add(name);
    let held = true;
    return () => {
      if (held) names.delete(name);
      held = false;
    };
  };
  return {
    async hold(name) {
      return take(name);
    },
    async tryHold(name) {
      return names.has(name) ? null : take(name);
    },
    async held() {
      return new Set(names);
    },
  };
}

export interface RecoveryOptions {
  liveness?: RecoveryLiveness;
  now?: () => number;
  newId?: () => string;
  /** Checkpoints a session keeps (newest first). Default 2. */
  keepPerSession?: number;
  /** Orphaned sessions kept. Default 8. */
  maxSessions?: number;
  /** Bytes all orphaned sessions may hold together. Default 512 MB. */
  maxBytes?: number;
  /** Bytes one checkpoint may have; a larger one is not kept. Default 256 MB. */
  maxCheckpointBytes?: number;
  /** Orphaned sessions older than this are pruned. Default 14 days. */
  maxAgeMs?: number;
}

interface SessionMeta {
  version: 1;
  session: string;
  startedAt: number;
  checkpoints: RecoveryCheckpoint[];
}

const SESSION_LOCK = "paged.recovery.session:";
const CLAIM_LOCK = "paged.recovery.claim:";
const META = "meta.json";
const MB = 1024 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** A checkpoint's bytes within its session. */
const blobPath = (c: { session: string; seq: number }) =>
  `${c.session}/${c.seq}.paged`;

/** One editor's journal session. */
export interface RecoverySession {
  readonly id: string;
  /** Keep a checkpoint. Null when it is too large to keep. */
  write(input: {
    document: RecoveryDocument;
    bytes: Uint8Array;
    reason: CheckpointReason;
    edits: number;
    pages: number | null;
  }): Promise<RecoveryCheckpoint | null>;
  /** The newest checkpoint kept, if any. */
  latest(): RecoveryCheckpoint | null;
  /** Drop every checkpoint: the work was saved, or closed on purpose. */
  purge(): Promise<void>;
  /** A clean close: purge and let the session go. */
  end(): Promise<void>;
}

export class RecoveryJournal {
  private readonly fs: RepoFs;
  private readonly liveness: RecoveryLiveness;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly keepPerSession: number;
  private readonly maxSessions: number;
  private readonly maxBytes: number;
  private readonly maxCheckpointBytes: number;
  private readonly maxAgeMs: number;
  /** Sessions this journal began: never orphans, whatever the locks say. */
  private readonly own = new Set<string>();

  constructor(fs: RepoFs, options: RecoveryOptions = {}) {
    this.fs = fs;
    this.liveness = options.liveness ?? memoryLiveness();
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.keepPerSession = Math.max(1, options.keepPerSession ?? 2);
    this.maxSessions = Math.max(1, options.maxSessions ?? 8);
    this.maxBytes = options.maxBytes ?? 512 * MB;
    this.maxCheckpointBytes = options.maxCheckpointBytes ?? 256 * MB;
    this.maxAgeMs = options.maxAgeMs ?? 14 * 24 * 60 * 60 * 1000;
  }

  /** Begin this editor's session: holds its lock until `end` (or until the
   *  page goes, which is what makes a crashed session an orphan). */
  async begin(): Promise<RecoverySession> {
    const id = this.newId();
    this.own.add(id);
    const release = await this.liveness.hold(SESSION_LOCK + id);
    const meta: SessionMeta = {
      version: 1,
      session: id,
      startedAt: this.now(),
      checkpoints: [],
    };
    let queue: Promise<unknown> = Promise.resolve();
    // One write at a time: a purge never interleaves with a write.
    const serial = <T>(f: () => Promise<T>): Promise<T> => {
      const run = queue.then(f, f);
      queue = run.catch(() => undefined);
      return run;
    };
    let seq = 0;
    let ended = false;
    const journal = this;
    return {
      id,
      latest: () => meta.checkpoints.at(-1) ?? null,
      write: (input) =>
        serial(async () => {
          if (ended) return null;
          if (input.bytes.length > journal.maxCheckpointBytes) return null;
          const checkpoint: RecoveryCheckpoint = {
            session: id,
            seq: ++seq,
            at: journal.now(),
            reason: input.reason,
            document: input.document,
            edits: input.edits,
            pages: input.pages,
            bytes: input.bytes.length,
          };
          // The bytes first, then the list that names them: a crash
          // between the two leaves the older list, which still holds.
          await journal.fs.write(blobPath(checkpoint), input.bytes);
          const kept = [...meta.checkpoints, checkpoint];
          const dropped = kept.splice(
            0,
            Math.max(0, kept.length - journal.keepPerSession),
          );
          meta.checkpoints = kept;
          await journal.writeMeta(meta);
          for (const old of dropped) await journal.removeBlob(old);
          return checkpoint;
        }),
      purge: () =>
        serial(async () => {
          meta.checkpoints = [];
          await journal.fs.removeDir(id);
        }),
      end: () =>
        serial(async () => {
          if (ended) return;
          ended = true;
          meta.checkpoints = [];
          await journal.fs.removeDir(id);
          journal.own.delete(id);
          release();
        }),
    };
  }

  /**
   * The newest checkpoint of every session that ended without a clean
   * close (nobody holds its lock), newest first. Damaged sessions (no
   * readable list, or no checkpoint whose bytes are there) are removed.
   */
  async orphans(): Promise<RecoveryCheckpoint[]> {
    const out: RecoveryCheckpoint[] = [];
    for (const { latest } of await this.orphanSessions()) out.push(latest);
    return out.sort((a, b) => b.at - a.at);
  }

  /** The bytes of a checkpoint, or null when they are gone. */
  read(checkpoint: RecoveryCheckpoint): Promise<Uint8Array | null> {
    return this.fs.read(blobPath(checkpoint));
  }

  /** Forget a session's work (the user discarded it, or it was restored
   *  and kept again by the session that restored it). */
  async discard(session: string): Promise<void> {
    if (this.own.has(session)) return;
    if ((await this.liveness.held()).has(SESSION_LOCK + session)) return;
    await this.fs.removeDir(session);
  }

  /** Hold an orphan while it is offered, so a second tab does not offer
   *  it too; null when another tab already does. */
  claim(session: string): Promise<(() => void) | null> {
    return this.liveness.tryHold(CLAIM_LOCK + session);
  }

  /** Apply the retention bounds to the orphaned sessions. */
  async prune(): Promise<void> {
    const sessions = (await this.orphanSessions()).sort(
      (a, b) => b.latest.at - a.latest.at,
    );
    const now = this.now();
    let bytes = 0;
    let kept = 0;
    for (const s of sessions) {
      const size = s.meta.checkpoints.reduce((n, c) => n + c.bytes, 0);
      const keep =
        now - s.latest.at <= this.maxAgeMs &&
        kept < this.maxSessions &&
        bytes + size <= this.maxBytes;
      if (keep) {
        kept += 1;
        bytes += size;
      } else {
        await this.fs.removeDir(s.meta.session);
      }
    }
  }

  private async orphanSessions(): Promise<
    { meta: SessionMeta; latest: RecoveryCheckpoint }[]
  > {
    const held = await this.liveness.held();
    const out: { meta: SessionMeta; latest: RecoveryCheckpoint }[] = [];
    for (const dir of await this.fs.list("")) {
      if (this.own.has(dir) || held.has(SESSION_LOCK + dir)) continue;
      const meta = await this.readMeta(dir);
      const present: RecoveryCheckpoint[] = [];
      for (const c of meta?.checkpoints ?? []) {
        if ((await this.fs.read(blobPath(c))) !== null) present.push(c);
      }
      const latest = present.at(-1);
      if (!meta || !latest) {
        await this.fs.removeDir(dir);
        continue;
      }
      out.push({ meta: { ...meta, checkpoints: present }, latest });
    }
    return out;
  }

  private async readMeta(dir: string): Promise<SessionMeta | null> {
    const raw = await this.fs.read(`${dir}/${META}`).catch(() => null);
    if (!raw) return null;
    try {
      const meta = JSON.parse(dec.decode(raw)) as Partial<SessionMeta>;
      if (meta.version !== 1 || meta.session !== dir) return null;
      if (!Array.isArray(meta.checkpoints)) return null;
      return meta as SessionMeta;
    } catch {
      return null;
    }
  }

  private writeMeta(meta: SessionMeta): Promise<void> {
    return this.fs.write(
      `${meta.session}/${META}`,
      enc.encode(JSON.stringify(meta)),
    );
  }

  private removeBlob(c: RecoveryCheckpoint): Promise<void> {
    return this.fs.remove(blobPath(c));
  }
}
