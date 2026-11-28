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

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { initSync, Repository } from "@paged-media/canvas-wasm/repo";

import { memoryFs } from "../src/fs.ts";
import {
  CheckpointRefused,
  Library,
  MAX_AUTO_CHECKPOINTS,
  MAX_CHECKPOINT_BYTES,
  memoryLocks,
} from "../src/library.ts";
import { crc32 } from "@paged-media/helpers";

initSync({
  module: readFileSync(
    new URL(
      import.meta
        .resolve("@paged-media/canvas-wasm/repo/paged_repo_wasm_bg.wasm"),
    ),
  ),
});

// A minimal STORED zip writer: enough to make `.paged` fixtures in a test.
function zip(parts: [string, Uint8Array][]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of parts) {
    const n = enc.encode(name);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint32(14, crc32(data), true);
    h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true);
    h.setUint16(26, n.length, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint32(16, crc32(data), true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, n.length, true);
    c.setUint32(42, offset, true);
    chunks.push(new Uint8Array(h.buffer), n, data);
    central.push(new Uint8Array(c.buffer), n);
    offset += 30 + n.length + data.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, parts.length, true);
  end.setUint16(10, parts.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
  let at = 0;
  for (const b of all) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

function noise(len: number, seed: number): Uint8Array {
  let x = seed * 2 + 1;
  const abc = new TextEncoder().encode('abcdefghij klmnop"{}:,0123456789');
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = abc[(x >>> 0) % 32];
  }
  return out;
}

const text = (s: string) => new TextEncoder().encode(s);
const doc = (model: Uint8Array) =>
  zip([
    ["mimetype", text("application/vnd.adobe.indesign-idml-package")],
    ["designmap.xml", text("<Document/>")],
    ["paged/core/model/document.pgm", model],
  ]);

function library(fs = memoryFs()) {
  let t = 1000;
  let n = 0;
  return {
    fs,
    lib: new Library(fs, {
      createRepository: (owner) => new Repository(owner),
      now: () => (t += 1000),
      newId: () => `doc-${++n}`,
    }),
  };
}

test("an opened file becomes a document that survives a reload", async () => {
  const { fs, lib } = library();
  const file = doc(noise(700_000, 1));
  const entry = await lib.importFile(file, "brochure.idml");
  assert.equal(entry.name, "brochure");
  assert.ok(entry.head);

  const fresh = library(fs).lib;
  assert.deepEqual(
    (await fresh.list()).map((d) => d.id),
    ["doc-1"],
  );
  const log = await fresh.log("doc-1");
  assert.equal(log.length, 1);
  assert.equal(log[0].imported_from, "brochure.idml");
  const a = await lib.exportPaged("doc-1");
  const b = await fresh.exportPaged("doc-1");
  assert.deepEqual(a, b);
});

test("a save commits only when something changed", async () => {
  const { lib } = library();
  const { id } = await lib.importFile(doc(noise(400_000, 2)), "d.paged");
  assert.equal((await lib.save(id, doc(noise(400_000, 2)))).changed, false);
  assert.equal((await lib.save(id, doc(noise(400_000, 3)))).changed, true);
  assert.equal((await lib.log(id)).length, 2);
});

test("restoring a version keeps the history", async () => {
  const { fs, lib } = library();
  const { id } = await lib.importFile(doc(noise(500_000, 4)), "d.paged");
  const v1 = (await lib.log(id))[0].hash;
  const first = await lib.exportPaged(id);
  await lib.save(id, doc(noise(500_000, 5)));
  await lib.restore(id, v1);
  assert.equal((await lib.log(id)).length, 3);
  // From cold: every blob faulted in from the packs.
  assert.deepEqual(await library(fs).lib.exportPaged(id), first);
  assert.deepEqual(await library(fs).lib.exportPaged(id, v1), first);
});

test("a file can carry its history into another library", async () => {
  const { lib } = library();
  const { id } = await lib.importFile(doc(noise(300_000, 6)), "d.paged");
  await lib.save(id, doc(noise(300_000, 7)));
  await lib.release(id, "v1", (await lib.log(id))[0].hash);
  const file = await lib.exportPaged(id, "main", true);

  const other = library().lib;
  const copy = await other.importFile(file, "d.paged");
  assert.equal((await other.log(copy.id)).length, 2);
  assert.ok((await other.refs(copy.id))["releases/v1"]);
});

test("exports are recorded, and a write that did not finish is ignored", async () => {
  const { fs, lib } = library();
  const { id } = await lib.importFile(doc(noise(10, 8)), "d.paged");
  await lib.exportPaged(id);
  await fs.write(`repos/${id}/packs/99.pack`, new Uint8Array([1, 2, 3]));
  const fresh = library(fs).lib;
  const ev = await fresh.evidence(id);
  assert.deepEqual(
    ev.map((e) => e.action),
    ["export"],
  );
  assert.equal((await fresh.log(id)).length, 1);
});

test("calls run one at a time", async () => {
  const { lib } = library();
  const { id } = await lib.importFile(doc(noise(10, 9)), "d.paged");
  const saves = [10, 11, 12].map((s) => lib.save(id, doc(noise(10, s))));
  await Promise.all(saves);
  assert.equal((await lib.log(id)).length, 4);
});

test("a model's save is an agent's version on its branch, merged by the person", async () => {
  const { lib } = library();
  const { id } = await lib.importFile(doc(noise(10, 20)), "d.paged");
  const saved = await lib.saveAgent(
    id,
    doc(noise(10, 21)),
    { agent: "agent:claude", client: "claude", run: "R1" },
    "Claude's edit",
  );
  assert.equal(saved.branch, "agent/r1/live");
  assert.equal((await lib.log(id)).length, 1, "main does not move");
  const branch = await lib.log(id, saved.branch);
  assert.equal(branch[0].agent, true);
  assert.equal(branch[0].author, "agent:claude");
  await lib.mergeBranch(id, saved.branch);
  assert.equal((await lib.log(id))[0].hash, saved.head, "a fast-forward");
});

test("a dataset is a repository of data parts, named by paged:// references", async () => {
  const { lib } = library();
  const csv = new TextEncoder().encode("sku,price\nA1,9.90\nB2,12.50\n");
  const ds = await lib.importDataset("products", [
    { path: "data/products.csv", bytes: csv },
    {
      path: "schema.json",
      bytes: new TextEncoder().encode('{"sku":"string","price":"number"}'),
    },
  ]);
  assert.equal(ds.kind, "data");
  assert.deepEqual(
    await lib.resolve("paged://products/data/products.csv"),
    csv,
  );
  await assert.rejects(
    lib.resolve("paged://acme.products/data/products.csv"),
    /not in this library/,
  );
  await assert.rejects(lib.resolve("http://x/y"), /not a paged/);
});

// Editor ADR 1234 — named checkpoints: a timeline of named versions on the
// document's repository, kept on their own ref so a checkpoint never moves
// the saved version; bounded; a restore is a new version, never a rewind.
test("PX7 — an import is the first checkpoint; checkpoints never move main", async () => {
  const { fs, lib } = library();
  const { id } = await lib.importFile(doc(noise(200_000, 30)), "annual.idml");
  const main = (await lib.refs(id)).main;
  let timeline = await lib.checkpoints(id);
  assert.deepEqual(
    timeline.map((c) => [c.name, c.kind, c.auto, c.commit]),
    [["annual.idml", "import", true, main]],
  );
  // An unsaved state, kept by name: a commit on the checkpoints ref only.
  const pass = await lib.checkpoint(id, doc(noise(200_000, 31)), {
    name: "Typography pass",
    kind: "named",
    pages: 4,
  });
  assert.equal((await lib.refs(id)).main, main, "main does not move");
  assert.equal(
    (await lib.refs(id))["drafts/user:local/checkpoints"],
    pass.commit,
  );
  assert.equal((await lib.log(id)).length, 1);
  // The same state again makes no new version, only a new name.
  const again = await lib.checkpoint(id, doc(noise(200_000, 31)), {
    name: "Again",
    kind: "named",
  });
  assert.equal(again.commit, pass.commit);
  // From cold, the timeline and its states are there.
  const fresh = library(fs).lib;
  timeline = await fresh.checkpoints(id);
  assert.deepEqual(
    timeline.map((c) => c.name),
    ["annual.idml", "Typography pass", "Again"],
  );
  assert.equal(timeline[1].pages, 4);
  assert.deepEqual(
    await fresh.exportPaged(id, pass.commit),
    await lib.exportPaged(id, pass.commit),
  );
  // A blank document's first save is no import.
  const blank = await lib.importFile(doc(noise(10, 32)), "Untitled.paged", {
    checkpoint: false,
  });
  assert.deepEqual(await lib.checkpoints(blank.id), []);
});

test("PX7 — restoring a checkpoint is a new version; the versions after it stay", async () => {
  const { lib } = library();
  const { id } = await lib.importFile(doc(noise(100_000, 40)), "d.paged");
  const first = await lib.exportPaged(id);
  const [imported] = await lib.checkpoints(id);
  await lib.save(id, doc(noise(100_000, 41)));
  const head = await lib.restoreCheckpoint(id, imported.id);
  const log = await lib.log(id);
  assert.equal(log.length, 3, "import, save, restore: nothing rewound");
  assert.equal(log[0].hash, head);
  assert.match(log[0].message, /^Restore /);
  assert.deepEqual(await lib.exportPaged(id), first);
  await assert.rejects(lib.restoreCheckpoint(id, "nope"), /no checkpoint/);
});

test("PX7 — checkpoints are bounded: automatic ones pruned oldest first, a state too large refused", async () => {
  const { lib } = library();
  const { id } = await lib.importFile(doc(noise(1000, 50)), "d.paged");
  await lib.checkpoint(id, doc(noise(1000, 51)), {
    name: "Mine",
    kind: "named",
  });
  for (let i = 0; i < MAX_AUTO_CHECKPOINTS + 3; i++)
    await lib.checkpoint(id, doc(noise(1000, 60 + i)), {
      name: `Exported ${i}`,
      kind: "export",
    });
  const timeline = await lib.checkpoints(id);
  assert.equal(timeline.filter((c) => c.auto).length, MAX_AUTO_CHECKPOINTS);
  assert.ok(
    timeline.some((c) => c.name === "Mine"),
    "named ones stay",
  );
  assert.ok(!timeline.some((c) => c.kind === "import"), "the oldest went");
  assert.equal(timeline.at(-1)?.name, `Exported ${MAX_AUTO_CHECKPOINTS + 2}`);
  const huge = { length: MAX_CHECKPOINT_BYTES + 1 } as Uint8Array;
  await assert.rejects(
    lib.checkpoint(id, huge, { name: "Huge", kind: "named" }),
    (e: unknown) => e instanceof CheckpointRefused && e.reason === "too-large",
  );
  // Removing one takes it off the timeline only.
  const mine = timeline.find((c) => c.name === "Mine")!;
  await lib.removeCheckpoint(id, mine.id);
  assert.ok(!(await lib.checkpoints(id)).some((c) => c.id === mine.id));
  assert.ok((await lib.exportPaged(id, mine.commit)).length > 0);
});

// Editor ADR 1235 — layout variants: branches of main on the person's draft
// refs, sharing its history; saving a variant never moves main; promoting
// one is a new version of main.
test("PX5 — a variant branches from main, saves on its own ref, and promotes as a new version", async () => {
  const { fs, lib } = library();
  const { id } = await lib.importFile(doc(noise(300_000, 70)), "brochure.idml");
  const main = (await lib.refs(id)).main;
  const compact = await lib.createVariant(
    id,
    "Compact",
    doc(noise(300_000, 71)),
  );
  assert.equal(compact.slug, "compact");
  assert.equal(compact.ref, "drafts/user:local/variants/compact");
  assert.equal(compact.base, main);
  assert.equal((await lib.refs(id)).main, main, "main does not move");
  // Its history starts with main's: shared, not duplicated.
  const history = await lib.log(id, compact.ref);
  assert.equal(history.length, 2);
  assert.equal(history[1].hash, main);
  // A save on the variant moves the variant only.
  const saved = await lib.save(
    id,
    doc(noise(300_000, 72)),
    "Save",
    compact.ref,
  );
  assert.equal(saved.changed, true);
  assert.equal((await lib.refs(id)).main, main);
  // A second variant of the same name gets its own slug.
  const again = await lib.createVariant(id, "Compact", doc(noise(300_000, 73)));
  assert.equal(again.slug, "compact-2");
  // From cold: both listed, with their heads.
  const fresh = library(fs).lib;
  assert.deepEqual(
    (await fresh.variants(id)).map((v) => [v.name, v.slug, v.head]),
    [
      ["Compact", "compact", saved.head],
      ["Compact", "compact-2", again.head],
    ],
  );
  // Promote: the variant's state becomes main's newest version.
  const variantBytes = await lib.exportPaged(id, compact.ref);
  const head = await lib.promoteVariant(id, "compact");
  const log = await lib.log(id);
  assert.equal(log[0].hash, head);
  assert.equal(log.length, 2, "import, then the promotion");
  assert.deepEqual(await lib.exportPaged(id), variantBytes);
  // Removing a variant takes it off the list; its versions stay.
  await lib.removeVariant(id, "compact-2");
  assert.deepEqual(
    (await lib.variants(id)).map((v) => v.slug),
    ["compact"],
  );
  assert.ok((await lib.exportPaged(id, again.head!)).length > 0);
});

// Two tabs: two libraries over one storage, each with its own copy of the
// repository in memory, sharing the origin's locks.
function twoTabs() {
  const fs = memoryFs();
  const locks = memoryLocks();
  let t = 1000;
  let n = 0;
  const tab = () =>
    new Library(fs, {
      createRepository: (owner) => new Repository(owner),
      now: () => (t += 1000),
      newId: () => `doc-${++n}`,
      locks,
    });
  return { fs, a: tab(), b: tab(), fresh: tab };
}

test("a second tab's save builds on the first tab's instead of replacing it", async () => {
  const { a, b, fresh } = twoTabs();
  const { id } = await a.importFile(doc(noise(300_000, 20)), "d.paged");
  // Both tabs hold the document in memory at the same head.
  assert.equal((await a.log(id)).length, 1);
  assert.equal((await b.log(id)).length, 1);

  const first = doc(noise(300_000, 21));
  const second = doc(noise(300_000, 22));
  const savedA = await a.save(id, first, "Save in tab A");
  // Tab B's copy is stale now: its save must not take A's pack number or
  // write refs that forget A's commit.
  const savedB = await b.save(id, second, "Save in tab B");
  assert.equal(savedA.changed, true);
  assert.equal(savedB.changed, true);

  const cold = fresh();
  const log = await cold.log(id);
  assert.deepEqual(
    log.map((c) => c.hash).includes(savedA.head),
    true,
    "tab A's commit is in the history",
  );
  assert.equal(log.length, 3);
  assert.equal(log[0].hash, savedB.head);
  // Both versions read back whole from the packs.
  assert.deepEqual(
    await cold.exportPaged(id, savedA.head),
    await a.exportPaged(id, savedA.head),
  );
  assert.deepEqual(await cold.exportPaged(id), await b.exportPaged(id));
  // And tab A sees B's save the next time it looks.
  assert.equal((await a.log(id))[0].hash, savedB.head);
});

test("saves started in two tabs at once both land", async () => {
  const { a, b, fresh } = twoTabs();
  const { id } = await a.importFile(doc(noise(200_000, 30)), "d.paged");
  await b.log(id);
  const [x, y] = await Promise.all([
    a.save(id, doc(noise(200_000, 31)), "A"),
    b.save(id, doc(noise(200_000, 32)), "B"),
  ]);
  const hashes = (await fresh().log(id)).map((c) => c.hash);
  assert.equal(hashes.length, 3);
  assert.ok(hashes.includes(x.head));
  assert.ok(hashes.includes(y.head));
});

test("a rename in one tab survives a save in the other", async () => {
  const { a, b, fresh } = twoTabs();
  const { id } = await a.importFile(doc(noise(100_000, 40)), "d.paged");
  await b.log(id);
  await a.rename(id, "Annual report");
  await b.save(id, doc(noise(100_000, 41)));
  assert.equal((await fresh().list())[0].name, "Annual report");
});
