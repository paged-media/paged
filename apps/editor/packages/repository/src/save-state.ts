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

// The save state (interaction spec UXI-INV-010, UXI-FIL-003, UXI-MUT-009;
// decision D-10 of editor ADR 1201): what the open document's persistence
// actually is, and where. Every state is a guarantee that held when it was
// entered, never a hope:
//
//   new          nothing of this document has been saved in this session
//                (a blank document, or a file opened and not edited)
//   editing      accepted edits that are not persisted anywhere yet
//   saving       a save is running; nothing has landed yet
//   saved-local  the bytes are on this device: the browser's library and/or
//                a download; the document had no other target
//   syncing      the bytes are on this device and are being written to the
//                document's own target (the file it was opened from, the
//                embedding host, a server)
//   synced       the target holds the bytes
//   not-synced   the bytes are on this device but the target did not take
//                them ("Saved locally · Not synced", with Retry)
//   failed       nothing was persisted (with the reason, and Retry)
//   read-only    this editor cannot save this document
//   recovered    restored from the recovery journal and not saved since:
//                a local recovery copy, which is no save
//
// PURE and PER INSTANCE: `reduceSaveState` is a function of a state and an
// event; `createSaveStateStore` makes one store per editor (the shell keeps
// it in the editor's scope). Nothing here is module state.

/** Where a save put the bytes. */
export type SaveDestination =
  /** This browser's local library (the origin-private file system). */
  | { kind: "library" }
  /** The file the document was opened from (a file handle). */
  | { kind: "file"; name: string }
  /** A download the browser was handed: on this device, not verified. */
  | { kind: "download"; name: string }
  /** The embedding host's save action. */
  | { kind: "host" }
  /** A paged.server repository. */
  | { kind: "remote"; repo: string };

/** Why a step did not happen, as a code the chrome words. */
export type SaveFailureCode =
  | "permission-denied"
  | "file-missing"
  | "write-failed"
  | "export-failed"
  | "host-refused"
  | "remote-failed"
  | "unknown";

export interface SaveProblem {
  readonly code: SaveFailureCode;
  /** The platform's own words, for the details view (never the label). */
  readonly detail: string | null;
  /** The target that was not reached; null when the whole save failed. */
  readonly target: SaveDestination | null;
  readonly at: number;
}

/** Something a save did that is no failure but belongs in its account. */
export type SaveNote =
  /** The local library did not keep the save (the file write went on). */
  | { kind: "library-failed"; detail: string | null }
  /** A plugin did not finish preparing; its last committed state was saved. */
  | { kind: "not-prepared"; plugin: string };

/** Where the open document came from. */
export type DocumentOrigin =
  | { kind: "blank" }
  | { kind: "opened"; name: string }
  /** Restored from the recovery journal (its checkpoint's time). */
  | { kind: "recovered"; name: string; checkpointAt: number };

export type SaveStateKind =
  | "new"
  | "editing"
  | "saving"
  | "saved-local"
  | "syncing"
  | "synced"
  | "not-synced"
  | "failed"
  | "read-only"
  | "recovered";

export interface SaveRecord {
  readonly at: number;
  readonly where: readonly SaveDestination[];
  readonly notes: readonly SaveNote[];
}

export interface SaveState {
  readonly kind: SaveStateKind;
  /** The open document; null when nothing is open. */
  readonly document: {
    readonly origin: DocumentOrigin;
    readonly openedAt: number;
  } | null;
  /** Accepted edits not persisted to the declared target. */
  readonly dirty: boolean;
  /** The last save of this session that put the bytes somewhere. */
  readonly saved: SaveRecord | null;
  /** The last save stored the bytes on this device but missed the target
   *  (not-synced). */
  readonly missed: SaveProblem | null;
  /** The last save persisted nothing (failed); cleared by a save that
   *  stores the bytes anywhere, or by another document. */
  readonly failure: SaveProblem | null;
  /** Why this editor cannot save (read-only), or null. */
  readonly readOnly: string | null;
  /** The newest recovery checkpoint of this document: a local copy kept
   *  for a crash, never a save (UXI-MUT-009). */
  readonly checkpointAt: number | null;
  /** The save running now, if any. */
  readonly running: {
    readonly startedAt: number;
    readonly where: readonly SaveDestination[];
    readonly notes: readonly SaveNote[];
    readonly syncing: SaveDestination | null;
    readonly problem: SaveProblem | null;
  } | null;
}

export type SaveEvent =
  /** A document was opened (or minted, or restored). */
  | { type: "opened"; origin: DocumentOrigin; at: number }
  /** Nothing is open any more. */
  | { type: "closed" }
  /** The document's dirty flag as the engine and the client fold it. */
  | { type: "dirty"; dirty: boolean }
  /** This editor cannot save (a reason), or can again (null). */
  | { type: "read-only"; reason: string | null }
  /** A recovery checkpoint of this document was written (null: purged). */
  | { type: "checkpoint"; at: number | null }
  | { type: "save-started"; at: number }
  /** A step of the running save put the bytes at `destination`. */
  | { type: "stored"; destination: SaveDestination }
  /** The running save starts writing to its target. */
  | { type: "sync-started"; target: SaveDestination }
  /** The target did not take the bytes. */
  | {
      type: "sync-failed";
      target: SaveDestination;
      code: SaveFailureCode;
      detail?: string | null;
      at: number;
    }
  | { type: "note"; note: SaveNote }
  /** The running save is over: what it stored is what it did. */
  | { type: "save-finished"; at: number }
  /** The running save threw. */
  | {
      type: "save-failed";
      code: SaveFailureCode;
      detail?: string | null;
      at: number;
    };

const NOTHING: Omit<SaveState, "kind"> = {
  document: null,
  dirty: false,
  saved: null,
  missed: null,
  failure: null,
  readOnly: null,
  checkpointAt: null,
  running: null,
};

export function initialSaveState(): SaveState {
  return withKind(NOTHING);
}

/** Destinations that are the document's own target, not this device. */
export function isTarget(d: SaveDestination): boolean {
  return d.kind === "file" || d.kind === "host" || d.kind === "remote";
}

/** The state's kind, from its facts. One rule each, in this order. */
export function saveStateKind(s: Omit<SaveState, "kind">): SaveStateKind {
  if (s.readOnly !== null) return "read-only";
  if (s.running) return s.running.syncing ? "syncing" : "saving";
  if (!s.document) return "new";
  // A save that put nothing anywhere stays on screen until a save works or
  // another document opens: an edit after it is still unsaved, and the
  // failure is why.
  if (s.failure) return "failed";
  if (s.dirty) return "editing";
  if (s.saved) {
    if (s.missed) return "not-synced";
    return s.saved.where.some(isTarget) ? "synced" : "saved-local";
  }
  if (s.document.origin.kind === "recovered") return "recovered";
  return "new";
}

function withKind(s: Omit<SaveState, "kind">): SaveState {
  return { ...s, kind: saveStateKind(s) };
}

function finish(
  s: Omit<SaveState, "kind">,
  at: number,
  thrown: SaveProblem | null,
): Omit<SaveState, "kind"> {
  const run = s.running;
  if (!run) return s;
  if (run.where.length === 0) {
    // Nothing landed: the save failed, for the reason that stopped it. The
    // previous save, if any, still says where the older bytes are.
    return {
      ...s,
      running: null,
      failure: thrown ??
        run.problem ?? {
          code: "unknown",
          detail: null,
          target: null,
          at,
        },
    };
  }
  return {
    ...s,
    running: null,
    saved: { at, where: run.where, notes: run.notes },
    failure: null,
    // Stored somewhere but the target was missed (or the run threw after
    // the local step): saved locally, not synced.
    missed: run.problem ?? thrown,
  };
}

export function reduceSaveState(state: SaveState, event: SaveEvent): SaveState {
  const s: Omit<SaveState, "kind"> = state;
  switch (event.type) {
    case "opened":
      return withKind({
        ...NOTHING,
        readOnly: s.readOnly,
        document: { origin: event.origin, openedAt: event.at },
      });
    case "closed":
      return withKind({ ...NOTHING, readOnly: s.readOnly });
    case "dirty":
      return s.dirty === event.dirty
        ? state
        : withKind({ ...s, dirty: event.dirty });
    case "read-only":
      return s.readOnly === event.reason
        ? state
        : withKind({ ...s, readOnly: event.reason });
    case "checkpoint":
      return s.checkpointAt === event.at
        ? state
        : withKind({ ...s, checkpointAt: event.at });
    case "save-started":
      return withKind({
        ...s,
        running: {
          startedAt: event.at,
          where: [],
          notes: [],
          syncing: null,
          problem: null,
        },
      });
    case "stored": {
      const run = s.running;
      if (!run) return state;
      return withKind({
        ...s,
        running: {
          ...run,
          where: [...run.where, event.destination],
          syncing:
            run.syncing && sameDestination(run.syncing, event.destination)
              ? null
              : run.syncing,
        },
      });
    }
    case "sync-started": {
      const run = s.running;
      if (!run) return state;
      return withKind({ ...s, running: { ...run, syncing: event.target } });
    }
    case "sync-failed": {
      const run = s.running;
      if (!run) return state;
      return withKind({
        ...s,
        running: {
          ...run,
          syncing: null,
          problem: {
            code: event.code,
            detail: event.detail ?? null,
            target: event.target,
            at: event.at,
          },
        },
      });
    }
    case "note": {
      const run = s.running;
      if (!run) return state;
      return withKind({
        ...s,
        running: { ...run, notes: [...run.notes, event.note] },
      });
    }
    case "save-finished":
      return withKind(finish(s, event.at, null));
    case "save-failed":
      return withKind(
        finish(s, event.at, {
          code: event.code,
          detail: event.detail ?? null,
          target: null,
          at: event.at,
        }),
      );
  }
}

export function sameDestination(a: SaveDestination, b: SaveDestination) {
  return a.kind === b.kind && destinationName(a) === destinationName(b);
}

/** The file or repository name a destination carries, if any. */
export function destinationName(d: SaveDestination): string | null {
  switch (d.kind) {
    case "file":
    case "download":
      return d.name;
    case "remote":
      return d.repo;
    default:
      return null;
  }
}

/**
 * Must the document be saved before it is replaced or the page left?
 * Dirty, or restored from the journal and not saved since (the journal's
 * copy is no save, UXI-MUT-009): the replace question asks for both.
 */
export function needsSave(s: SaveState): boolean {
  if (!s.document) return false;
  if (s.dirty) return true;
  return s.document.origin.kind === "recovered" && s.saved === null;
}

/** A store of one editor's save state, for `useSyncExternalStore`. */
export interface SaveStateStore {
  get(): SaveState;
  dispatch(event: SaveEvent): void;
  subscribe(listener: () => void): () => void;
}

export function createSaveStateStore(
  initial: SaveState = initialSaveState(),
): SaveStateStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    dispatch(event) {
      const next = reduceSaveState(state, event);
      if (next === state) return;
      state = next;
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The failure code a write that threw `err` reads as. */
export function writeFailureCode(err: unknown): SaveFailureCode {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError")
    return "permission-denied";
  if (name === "NotFoundError") return "file-missing";
  return "write-failed";
}
