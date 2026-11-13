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

// The save state (UXI-INV-010, D-10): every state is what a save really did.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createSaveStateStore,
  initialSaveState,
  needsSave,
  reduceSaveState,
  writeFailureCode,
  type SaveEvent,
  type SaveState,
} from "../src/save-state.ts";

const run = (events: SaveEvent[], from: SaveState = initialSaveState()) =>
  events.reduce(reduceSaveState, from);

const opened: SaveEvent = {
  type: "opened",
  origin: { kind: "opened", name: "Annual.paged" },
  at: 1,
};
const file = { kind: "file", name: "Annual.paged" } as const;

test("a document opened and not edited is new; an edit makes it editing", () => {
  assert.equal(run([opened]).kind, "new");
  assert.equal(run([opened, { type: "dirty", dirty: true }]).kind, "editing");
  assert.equal(
    run([
      opened,
      { type: "dirty", dirty: true },
      { type: "dirty", dirty: false },
    ]).kind,
    "new",
  );
});

test("saving, then syncing to the file, then synced", () => {
  const steps: SaveEvent[] = [
    opened,
    { type: "dirty", dirty: true },
    { type: "save-started", at: 2 },
  ];
  assert.equal(run(steps).kind, "saving");
  steps.push({ type: "stored", destination: { kind: "library" } });
  steps.push({ type: "sync-started", target: file });
  assert.equal(run(steps).kind, "syncing");
  steps.push({ type: "stored", destination: file });
  steps.push({ type: "dirty", dirty: false });
  steps.push({ type: "save-finished", at: 3 });
  const s = run(steps);
  assert.equal(s.kind, "synced");
  assert.deepEqual(s.saved?.where, [{ kind: "library" }, file]);
  assert.equal(s.missed, null);
});

test("UXI-T67: the local commit landed, the write-back failed: not synced, never synced", () => {
  const s = run([
    opened,
    { type: "dirty", dirty: true },
    { type: "save-started", at: 2 },
    { type: "stored", destination: { kind: "library" } },
    { type: "sync-started", target: file },
    {
      type: "sync-failed",
      target: file,
      code: "permission-denied",
      detail: "NotAllowedError",
      at: 3,
    },
    { type: "stored", destination: { kind: "download", name: "Annual.paged" } },
    { type: "dirty", dirty: false },
    { type: "save-finished", at: 4 },
  ]);
  assert.equal(s.kind, "not-synced");
  assert.deepEqual(s.missed?.target, file);
  assert.equal(s.missed?.code, "permission-denied");
  assert.ok(!s.saved?.where.some((d) => d.kind === "file"));
});

test("with no target of its own, the library and a download are saved locally", () => {
  const s = run([
    { type: "opened", origin: { kind: "blank" }, at: 1 },
    { type: "dirty", dirty: true },
    { type: "save-started", at: 2 },
    { type: "stored", destination: { kind: "library" } },
    {
      type: "stored",
      destination: { kind: "download", name: "Untitled.paged" },
    },
    { type: "dirty", dirty: false },
    { type: "save-finished", at: 3 },
  ]);
  assert.equal(s.kind, "saved-local");
});

test("a save that stored nothing failed, and stays failed through edits until one works", () => {
  const failed = run([
    opened,
    { type: "dirty", dirty: true },
    { type: "save-started", at: 2 },
    { type: "sync-started", target: { kind: "host" } },
    {
      type: "sync-failed",
      target: { kind: "host" },
      code: "host-refused",
      at: 3,
    },
    { type: "save-finished", at: 3 },
  ]);
  assert.equal(failed.kind, "failed");
  assert.equal(failed.failure?.code, "host-refused");
  assert.equal(run([{ type: "dirty", dirty: true }], failed).kind, "failed");
  const recovered = run(
    [
      { type: "save-started", at: 4 },
      { type: "sync-started", target: { kind: "host" } },
      { type: "stored", destination: { kind: "host" } },
      { type: "dirty", dirty: false },
      { type: "save-finished", at: 5 },
    ],
    failed,
  );
  assert.equal(recovered.kind, "synced");
  assert.equal(recovered.failure, null);
});

test("a save that throws before anything landed is failed with its reason", () => {
  const s = run([
    opened,
    { type: "dirty", dirty: true },
    { type: "save-started", at: 2 },
    { type: "save-failed", code: "export-failed", detail: "boom", at: 3 },
  ]);
  assert.equal(s.kind, "failed");
  assert.equal(s.failure?.detail, "boom");
  assert.equal(s.dirty, true);
});

test("a failed save after a good one fails; the good one still says where the older bytes are", () => {
  const s = run([
    opened,
    { type: "dirty", dirty: true },
    { type: "save-started", at: 2 },
    { type: "stored", destination: { kind: "library" } },
    { type: "dirty", dirty: false },
    { type: "save-finished", at: 3 },
    { type: "dirty", dirty: true },
    { type: "save-started", at: 4 },
    { type: "save-failed", code: "export-failed", at: 5 },
  ]);
  assert.equal(s.kind, "failed");
  assert.equal(s.saved?.at, 3);
});

test("a recovered document is recovered, needs a save, and is saved by one", () => {
  const recovered = run([
    {
      type: "opened",
      origin: { kind: "recovered", name: "Annual", checkpointAt: 9 },
      at: 10,
    },
  ]);
  assert.equal(recovered.kind, "recovered");
  assert.equal(needsSave(recovered), true);
  const saved = run(
    [
      { type: "save-started", at: 11 },
      { type: "stored", destination: { kind: "library" } },
      { type: "save-finished", at: 12 },
    ],
    recovered,
  );
  assert.equal(saved.kind, "saved-local");
  assert.equal(needsSave(saved), false);
});

test("a recovery checkpoint is never a save", () => {
  const s = run([
    opened,
    { type: "dirty", dirty: true },
    { type: "checkpoint", at: 5 },
  ]);
  assert.equal(s.kind, "editing");
  assert.equal(s.saved, null);
  assert.equal(needsSave(s), true);
});

test("read-only outranks everything and survives another document", () => {
  const s = run([{ type: "read-only", reason: "viewer" }, opened]);
  assert.equal(s.kind, "read-only");
  assert.equal(run([{ type: "read-only", reason: null }], s).kind, "new");
});

test("a new document forgets the last one's saves and failures", () => {
  const s = run([
    opened,
    { type: "dirty", dirty: true },
    { type: "save-started", at: 2 },
    { type: "save-failed", code: "export-failed", at: 3 },
    { type: "opened", origin: { kind: "blank" }, at: 4 },
  ]);
  assert.equal(s.kind, "new");
  assert.equal(s.failure, null);
  assert.equal(s.dirty, false);
});

test("the store notifies on change only", () => {
  const store = createSaveStateStore();
  let calls = 0;
  const off = store.subscribe(() => calls++);
  store.dispatch(opened);
  store.dispatch({ type: "dirty", dirty: false });
  store.dispatch({ type: "dirty", dirty: true });
  off();
  store.dispatch({ type: "dirty", dirty: false });
  assert.equal(calls, 2);
  assert.equal(store.get().kind, "new");
});

test("write failures read as codes", () => {
  assert.equal(
    writeFailureCode({ name: "NotAllowedError" }),
    "permission-denied",
  );
  assert.equal(writeFailureCode({ name: "NotFoundError" }), "file-missing");
  assert.equal(writeFailureCode(new Error("disk")), "write-failed");
});
