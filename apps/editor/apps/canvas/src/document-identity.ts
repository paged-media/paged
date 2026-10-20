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

// Editor ADR 264 — the identity a remembered grant is keyed by.
//
// The open document's KEY is minted here, on this machine, and bound to
// something the host holds and a file cannot name:
//
//   lib:<id>   a local-library document, by the id the library minted when
//              it took the file in (a file's bytes never choose it);
//   fh:<uuid>  a file the user picked, recognised again by its handle
//              (`isSameEntry`) — while it reads as it did when the editor
//              last opened or saved it (a change made elsewhere mints a new
//              key);
//   t:<uuid>   anything else: one key per load, never stored, so a grant
//              lasts while the document stays open and a reopen asks again.
//
// Only `lib:` and `fh:` keys are STABLE: a grant can be remembered for them.
// The handles live in IndexedDB (a handle is structured-cloneable); nothing
// is written into the document.

import type {
  DocumentSource,
  DocumentSourceSink,
  IdentifiableFileHandle,
} from "@paged-media/shell";

export interface DocumentKey {
  key: string;
  /** A grant can be remembered for it (the host will know it again). */
  stable: boolean;
}

/** One recognised file: its key and how it read when last seen. */
export interface HandleRecord {
  key: string;
  handle: IdentifiableFileHandle;
  lastModified: number;
  size: number;
}

/** Where the recognised file handles are kept. */
export interface HandleStore {
  list(): Promise<HandleRecord[]>;
  put(record: HandleRecord): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface DocumentIdentity extends DocumentSourceSink {
  /** The open document's key (a transient one until its source resolves). */
  current(): DocumentKey;
  /** Settles once every declared source has been matched. */
  ready(): Promise<void>;
  /** No declared source is still being matched. */
  settled(): boolean;
  /** Follow the engine's open document (`docId`, null when none). */
  attach(documentId: () => string | null): () => void;
}

/** The most file handles kept; the oldest beyond it are forgotten. */
const MAX_HANDLES = 200;

export function createDocumentIdentity(options: {
  store: HandleStore;
  documentId?: () => string | null;
  mint?: () => string;
}): DocumentIdentity {
  const mint = options.mint ?? (() => crypto.randomUUID());
  let documentId = options.documentId ?? (() => null);
  const byDoc = new Map<string, DocumentKey>();
  let pending: Promise<void> = Promise.resolve();
  let inFlight = 0;
  /** Chain `work` after what is already being matched. */
  const queue = (work: () => Promise<void>, what: string): void => {
    inFlight++;
    pending = pending
      .then(work)
      .catch((err: unknown) =>
        console.warn(`document identity: ${what} failed:`, err),
      )
      .finally(() => {
        inFlight--;
      });
  };
  const none: DocumentKey = { key: "none", stable: false };

  const transient = (docId: string): DocumentKey => {
    let k = byDoc.get(docId);
    if (!k) {
      k = { key: `t:${mint()}`, stable: false };
      byDoc.set(docId, k);
    }
    return k;
  };

  const sameEntry = async (
    a: IdentifiableFileHandle,
    b: IdentifiableFileHandle,
  ): Promise<boolean> => {
    if (a === b) return true;
    try {
      return (await a.isSameEntry?.(b)) === true;
    } catch {
      return false;
    }
  };

  async function resolveHandle(
    docId: string,
    source: Extract<DocumentSource, { kind: "fileHandle" }>,
  ): Promise<void> {
    let records: HandleRecord[] = [];
    try {
      records = await options.store.list();
    } catch {
      records = [];
    }
    let match: HandleRecord | null = null;
    for (const r of records)
      if (await sameEntry(r.handle, source.handle)) {
        match = r;
        break;
      }
    const unchanged =
      match !== null &&
      match.lastModified === source.lastModified &&
      match.size === source.size;
    // A file changed outside the editor is not the document the grant was
    // made for: a new key, and the old record goes.
    const key = unchanged ? match!.key : `fh:${mint()}`;
    if (match && !unchanged) await options.store.remove(match.key);
    await options.store.put({
      key,
      handle: source.handle,
      lastModified: source.lastModified,
      size: source.size,
    });
    if (records.length >= MAX_HANDLES) {
      const keep = new Set([key]);
      for (const r of records.slice(-(MAX_HANDLES - 1))) keep.add(r.key);
      for (const r of records)
        if (!keep.has(r.key)) await options.store.remove(r.key);
    }
    byDoc.set(docId, { key, stable: true });
  }

  const self: DocumentIdentity = {
    current() {
      const docId = documentId();
      return docId === null ? none : transient(docId);
    },
    ready: () => pending,
    settled: () => inFlight === 0,
    attach(next) {
      documentId = next;
      return () => {
        if (documentId === next) documentId = () => null;
      };
    },
    declare(docId, source) {
      switch (source.kind) {
        case "library":
          byDoc.set(docId, { key: `lib:${source.documentId}`, stable: true });
          return;
        case "fileHandle":
          // Until the handle is matched the document reads as transient:
          // a request in the meantime waits (`ready`) or asks again.
          transient(docId);
          queue(() => resolveHandle(docId, source), "matching a file handle");
          return;
        case "transient":
          transient(docId);
          return;
      }
    },
    written(handle, file) {
      const docId = documentId();
      const k = docId === null ? null : byDoc.get(docId);
      queue(async () => {
        const records = await options.store.list();
        for (const r of records) {
          if (!(await sameEntry(r.handle, handle))) continue;
          // The open document is the one this file was recognised as:
          // it reads as it does now. Any other document written over it
          // makes the file a new document — forget the record.
          if (k && r.key === k.key)
            await options.store.put({ ...r, ...file, handle: r.handle });
          else await options.store.remove(r.key);
        }
      }, "recording a save");
    },
  };
  return self;
}

/** The handles in memory (tests, and a browser with no IndexedDB). */
export function memoryHandleStore(): HandleStore {
  const records = new Map<string, HandleRecord>();
  return {
    async list() {
      return [...records.values()];
    },
    async put(r) {
      records.delete(r.key);
      records.set(r.key, r);
    },
    async remove(key) {
      records.delete(key);
    },
  };
}

/** The handles in IndexedDB (`paged.documentIdentity` / `handles`); the
 *  memory store when IndexedDB is unavailable. */
export function indexedDbHandleStore(): HandleStore {
  if (typeof indexedDB === "undefined") return memoryHandleStore();
  const DB = "paged.documentIdentity";
  const STORE = "handles";
  let opened: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = async <T>(
    mode: IDBTransactionMode,
    body: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const d = await db();
    return new Promise<T>((resolve, reject) => {
      const req = body(d.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  };
  return {
    async list() {
      return (await run("readonly", (s) => s.getAll())) as HandleRecord[];
    },
    async put(r) {
      await run("readwrite", (s) => s.put(r));
    },
    async remove(key) {
      await run("readwrite", (s) => s.delete(key));
    },
  };
}
