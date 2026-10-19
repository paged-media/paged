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
import { Library } from "../src/library.ts";

initSync({
  module: readFileSync(
    new URL(
      import.meta
        .resolve("@paged-media/canvas-wasm/repo/paged_repo_wasm_bg.wasm"),
    ),
  ),
});

// A minimal STORED zip writer: enough to make `.paged` fixtures in a test.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
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
