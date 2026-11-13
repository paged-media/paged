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

// The recovery journal: per-editor sessions, orphans after a crash,
// bounded retention, purge on save and close.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { memoryFs, type RepoFs } from "../src/fs.ts";
import {
  memoryLiveness,
  RecoveryJournal,
  type RecoveryDocument,
  type RecoveryLiveness,
  type RecoveryOptions,
} from "../src/recovery.ts";

const doc: RecoveryDocument = {
  key: "lib:annual",
  stable: true,
  name: "Annual",
  source: { kind: "library", documentId: "annual" },
  openedAt: 1,
  savedAt: null,
};

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

/** A tab: its own journal over the shared device storage and locks. A
 *  crash is a tab whose locks are gone without its `end` having run. */
function tab(
  fs: RepoFs,
  locks: RecoveryLiveness,
  options: RecoveryOptions = {},
) {
  let n = 0;
  return new RecoveryJournal(fs, {
    liveness: locks,
    newId: () => `s${Math.random().toString(36).slice(2, 8)}-${n++}`,
    ...options,
  });
}

/** Locks that can drop everything one tab held (the tab crashed). */
function crashableLocks() {
  const base = memoryLiveness();
  const releases: (() => void)[] = [];
  const locks: RecoveryLiveness = {
    async hold(name) {
      const r = await base.hold(name);
      releases.push(r);
      return r;
    },
    tryHold: (name) => base.tryHold(name),
    held: () => base.held(),
  };
  return { locks, crash: () => releases.splice(0).forEach((r) => r()) };
}

test("a live session's work is never offered; a crashed one's newest checkpoint is", async () => {
  const fs = memoryFs();
  const a = crashableLocks();
  const shared = memoryLiveness();
  const first = tab(fs, a.locks);
  const session = await first.begin();
  await session.write({
    document: doc,
    bytes: bytes(10, 1),
    reason: "idle",
    edits: 3,
    pages: 2,
  });
  await session.write({
    document: doc,
    bytes: bytes(12, 2),
    reason: "operations",
    edits: 40,
    pages: 2,
  });
  // Another tab, while the first lives: nothing to offer.
  const other = tab(fs, {
    hold: shared.hold,
    tryHold: shared.tryHold,
    held: a.locks.held,
  });
  assert.deepEqual(await other.orphans(), []);
  // The first tab crashes: its newest checkpoint is offered.
  a.crash();
  const [orphan, ...rest] = await other.orphans();
  assert.equal(rest.length, 0);
  assert.equal(orphan?.session, session.id);
  assert.equal(orphan?.reason, "operations");
  assert.equal(orphan?.edits, 40);
  assert.deepEqual(await other.read(orphan!), bytes(12, 2));
});

test("the journal that began a session never offers it, even without locks", async () => {
  const fs = memoryFs();
  const journal = tab(fs, memoryLiveness());
  const session = await journal.begin();
  await session.write({
    document: doc,
    bytes: bytes(4),
    reason: "idle",
    edits: 1,
    pages: 1,
  });
  assert.deepEqual(await journal.orphans(), []);
});

test("a session keeps its newest checkpoints only", async () => {
  const fs = memoryFs();
  const { locks, crash } = crashableLocks();
  const journal = tab(fs, locks, { keepPerSession: 2 });
  const session = await journal.begin();
  for (let i = 1; i <= 4; i++) {
    await session.write({
      document: doc,
      bytes: bytes(8, i),
      reason: "idle",
      edits: i,
      pages: 1,
    });
  }
  const files = await fs.list(session.id);
  assert.deepEqual(files.sort(), ["3.paged", "4.paged", "meta.json"]);
  crash();
  const next = tab(fs, locks);
  const [orphan] = await next.orphans();
  assert.equal(orphan?.edits, 4);
});

test("a save purges, a clean close ends: nothing is offered after either", async () => {
  const fs = memoryFs();
  const { locks, crash } = crashableLocks();
  const journal = tab(fs, locks);
  const saved = await journal.begin();
  await saved.write({
    document: doc,
    bytes: bytes(4),
    reason: "idle",
    edits: 1,
    pages: 1,
  });
  await saved.purge();
  assert.equal(saved.latest(), null);
  const closed = await journal.begin();
  await closed.write({
    document: doc,
    bytes: bytes(4),
    reason: "idle",
    edits: 1,
    pages: 1,
  });
  await closed.end();
  crash();
  assert.deepEqual(await tab(fs, locks).orphans(), []);
  assert.deepEqual(await fs.list(""), []);
});

test("a checkpoint too large to keep is not kept", async () => {
  const fs = memoryFs();
  const journal = tab(fs, memoryLiveness(), { maxCheckpointBytes: 5 });
  const session = await journal.begin();
  const kept = await session.write({
    document: doc,
    bytes: bytes(6),
    reason: "idle",
    edits: 1,
    pages: 1,
  });
  assert.equal(kept, null);
  assert.equal(session.latest(), null);
});

test("retention: orphans past the age, the count or the bytes are pruned, oldest first", async () => {
  const fs = memoryFs();
  let now = 1_000;
  const { locks, crash } = crashableLocks();
  const writer = tab(fs, locks, { now: () => now });
  for (let i = 0; i < 4; i++) {
    now += 1_000;
    const s = await writer.begin();
    await s.write({
      document: { ...doc, name: `Doc ${i}` },
      bytes: bytes(10),
      reason: "idle",
      edits: 1,
      pages: 1,
    });
  }
  crash();
  const names = async (j: RecoveryJournal) =>
    (await j.orphans()).map((c) => c.document.name);
  const byCount = tab(fs, locks, { now: () => now, maxSessions: 3 });
  await byCount.prune();
  assert.deepEqual(await names(byCount), ["Doc 3", "Doc 2", "Doc 1"]);
  const byBytes = tab(fs, locks, { now: () => now, maxBytes: 20 });
  await byBytes.prune();
  assert.deepEqual(await names(byBytes), ["Doc 3", "Doc 2"]);
  now += 10_000;
  const byAge = tab(fs, locks, { now: () => now, maxAgeMs: 10_500 });
  await byAge.prune();
  assert.deepEqual(await names(byAge), ["Doc 3"]);
});

test("damaged sessions are cleared, not offered", async () => {
  const fs = memoryFs();
  await fs.write("broken/meta.json", new TextEncoder().encode("{not json"));
  await fs.write(
    "nobytes/meta.json",
    new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        session: "nobytes",
        startedAt: 1,
        checkpoints: [
          {
            session: "nobytes",
            seq: 1,
            at: 1,
            reason: "idle",
            document: doc,
            edits: 1,
            pages: 1,
            bytes: 3,
          },
        ],
      }),
    ),
  );
  const journal = tab(fs, memoryLiveness());
  assert.deepEqual(await journal.orphans(), []);
  assert.deepEqual(await fs.list(""), []);
});

test("an orphan offered in one tab is not offered in another; discard forgets it", async () => {
  const fs = memoryFs();
  const { locks, crash } = crashableLocks();
  const crashed = await tab(fs, locks).begin();
  await crashed.write({
    document: doc,
    bytes: bytes(4),
    reason: "idle",
    edits: 1,
    pages: 1,
  });
  crash();
  const one = tab(fs, locks);
  const two = tab(fs, locks);
  const release = await one.claim(crashed.id);
  assert.ok(release);
  assert.equal(await two.claim(crashed.id), null);
  release!();
  await one.discard(crashed.id);
  assert.deepEqual(await two.orphans(), []);
});
