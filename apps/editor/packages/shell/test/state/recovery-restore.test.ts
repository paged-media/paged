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

// A restored copy and the checkpoint it came from (editor ADR 1204): the
// old checkpoint is forgotten only once this session holds the copy again,
// and a checkpoint that cannot be written is said through the feedback
// channel, once.

import { describe, expect, test } from "bun:test";

import {
  memoryFs,
  memoryLiveness,
  RecoveryJournal,
  type RecoveryCheckpoint,
  type RepoFs,
} from "@paged-media/repository";

import { createEditorScope } from "../../src/state/editor-scope";
import { operationFeedbackOf } from "../../src/state/operation-feedback";
import {
  attachRecovery,
  keepRestoredCopy,
  recoveryOffers,
  writeCheckpoint,
} from "../../src/state/recovery";
import { saveStateOf } from "../../src/state/save-status";

/** A session that crashed with unsaved work in "Annual". */
async function crashed(fs: RepoFs) {
  const base = memoryLiveness();
  const releases: (() => void)[] = [];
  const session = await new RecoveryJournal(fs, {
    liveness: {
      async hold(name) {
        const r = await base.hold(name);
        releases.push(r);
        return r;
      },
      tryHold: (n) => base.tryHold(n),
      held: () => base.held(),
    },
  }).begin();
  await session.write({
    document: {
      key: "fh:1",
      stable: true,
      name: "Annual",
      source: { kind: "file", name: "Annual.paged" },
      openedAt: 1,
      savedAt: null,
    },
    bytes: new Uint8Array([1, 2, 3]),
    reason: "idle",
    edits: 7,
    pages: 12,
  });
  for (const r of releases) r();
}

/** An editor whose open document is the restored copy of the crashed
 *  session's checkpoint; `fs` may refuse writes. */
async function restored(options: { refuseWrites?: boolean } = {}) {
  const disk = memoryFs();
  await crashed(disk);
  const state = { refuse: options.refuseWrites ?? false };
  const fs: RepoFs = {
    ...disk,
    write: (path, bytes) =>
      state.refuse
        ? Promise.reject(new Error("QuotaExceededError"))
        : disk.write(path, bytes),
  };
  const liveness = memoryLiveness();
  const journal = new RecoveryJournal(fs, { liveness });
  const session = await journal.begin();
  const offers: { checkpoint: RecoveryCheckpoint; release(): void }[] = [];
  for (const checkpoint of await journal.sweep()) {
    const release = await journal.claim(checkpoint.session);
    if (release) offers.push({ checkpoint, release });
  }
  const scope = createEditorScope();
  attachRecovery(scope, {
    journal,
    session,
    identify: () => ({ key: "t:2", stable: false }),
    offers,
  });
  const checkpoint = offers[0]!.checkpoint;
  saveStateOf(scope).dispatch({
    type: "opened",
    origin: { kind: "recovered", name: "Annual", checkpointAt: checkpoint.at },
    at: 10,
  });
  // The opening purged what the session held; let it land.
  await session.purge();
  const client = {
    editMark: 0,
    exportPaged: async () => new Uint8Array([9, 9, 9, 9]),
    documentMeta: async () => {
      throw new Error("not used");
    },
  };
  /** What a later start would offer. */
  const laterOffers = () => new RecoveryJournal(disk, { liveness }).orphans();
  return { scope, client, checkpoint, session, state, laterOffers, disk };
}

describe("a restored copy and its old checkpoint", () => {
  test("the old checkpoint goes once the session holds the copy again", async () => {
    const r = await restored();
    const kept = await keepRestoredCopy(r.scope, r.client, r.checkpoint, {
      name: "Annual (recovered)",
      pages: 12,
    });
    expect(kept).toBe(true);
    expect(r.session.latest()?.reason).toBe("recovered");
    expect(await r.disk.list(r.checkpoint.session)).toEqual([]);
    expect(recoveryOffers(r.scope).current()).toBeNull();
  });

  test("a new checkpoint that cannot be written leaves the old one in the journal", async () => {
    const r = await restored({ refuseWrites: true });
    const kept = await keepRestoredCopy(r.scope, r.client, r.checkpoint, {
      name: "Annual (recovered)",
      pages: 12,
    });
    expect(kept).toBe(false);
    expect(r.session.latest()).toBeNull();
    // The only copy is still there, and a later start offers it again.
    const later = await r.laterOffers();
    expect(later.map((c) => c.session)).toEqual([r.checkpoint.session]);
    expect(recoveryOffers(r.scope).current()).toBeNull();
  });

  test("an export that fails leaves the old one too", async () => {
    const r = await restored();
    const client = {
      ...r.client,
      exportPaged: async () => {
        throw new Error("the worker is gone");
      },
    };
    expect(
      await keepRestoredCopy(r.scope, client, r.checkpoint, {
        name: "Annual (recovered)",
        pages: 12,
      }),
    ).toBe(false);
    expect(await r.laterOffers()).toHaveLength(1);
  });
});

describe("a checkpoint that cannot be written", () => {
  test("is reported once, kept in Problems, and resolved by the next one that lands", async () => {
    const r = await restored({ refuseWrites: true });
    const feedback = operationFeedbackOf(r.scope);
    const write = (mark: number) =>
      writeCheckpoint(
        r.scope,
        { ...r.client, editMark: mark },
        { reason: "idle", name: "Annual (recovered)", pages: 12 },
      );
    expect(await write(1)).toBeNull();
    expect(await write(2)).toBeNull();
    const snap = feedback.snapshot();
    expect(snap.toasts).toHaveLength(1);
    expect(snap.toasts[0]!.count).toBe(2);
    expect(snap.toasts[0]!.text.headline).toContain(
      "Could not keep a recovery copy",
    );
    expect(snap.toasts[0]!.report.detail).toBe("QuotaExceededError");
    expect(snap.problems).toHaveLength(1);

    r.state.refuse = false;
    expect(await write(3)).not.toBeNull();
    expect(feedback.snapshot().problems).toHaveLength(0);
  });
});
