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

// The library against a running paged.server (`PAGED_SERVER_URL`; locally
// `npx wrangler dev` in editor-server's server/crates/paged-server, whose
// .dev.vars knows `dev-token`). Skipped without it.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { initSync, Repository } from "@paged-media/repo-wasm";

import { memoryFs } from "../src/fs.ts";
import { Library, RemoteError } from "../src/library.ts";

initSync({
  module: readFileSync(new URL(import.meta.resolve("@paged-media/repo-wasm/paged_repo_wasm_bg.wasm"))),
});

const URL_ = process.env.PAGED_SERVER_URL;
const enc = new TextEncoder();

// The same STORED zip writer as library.test.ts, kept local to this file.
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
  const abc = enc.encode('abcdefghij klmnop"{}:,0123456789');
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = abc[(x >>> 0) % 32];
  }
  return out;
}
const model = noise(1_500_000, 1);
const doc = (story: string) =>
  zip([
    ["mimetype", enc.encode("application/vnd.adobe.indesign-idml-package")],
    ["designmap.xml", enc.encode("<Document/>")],
    ["Stories/Story_u1.xml", enc.encode(story)],
    ["paged/core/model/document.pgm", model],
  ]);

let n = 0;
const library = () =>
  new Library(memoryFs(), {
    createRepository: (owner) => new Repository(owner),
    owner: "user:dev",
    newId: () => `doc-${++n}`,
  });

test("push, clone, edit, pull: two browsers through one server", { skip: !URL_ }, async () => {
  const remote = { url: URL_!, repo: `browser-${Date.now().toString(36)}`, token: "dev-token" };
  const a = library();
  const doc1 = await a.importFile(doc("<Story/>"), "brochure.idml");
  const first = await a.push(doc1.id, remote);
  assert.ok(first.sent > 0);

  const b = library();
  const copy = await b.clone(remote, "brochure");
  assert.deepEqual(await b.exportPaged(copy.id), await a.exportPaged(doc1.id));

  await a.save(doc1.id, doc("<Story>edited in A</Story>"));
  const second = await a.push(doc1.id, remote);
  assert.ok(second.sent <= 4, `sent ${second.sent}`);
  assert.ok(second.bytes < 4096, `sent ${second.bytes} bytes for a one-story edit`);

  const pulled = await b.pull(copy.id, remote);
  assert.equal(pulled.changed, true);
  assert.deepEqual(await b.exportPaged(copy.id), await a.exportPaged(doc1.id));
  assert.equal((await b.pull(copy.id, remote)).changed, false);
  assert.deepEqual(
    (await a.evidence(doc1.id)).map((e) => e.action).filter((x) => x === "push"),
    ["push", "push"],
  );

  // Both edit; A pushes first. B can neither push over A nor pull past its own edit.
  await a.save(doc1.id, doc("<Story>A again</Story>"));
  await b.save(copy.id, doc("<Story>B instead</Story>"));
  await a.push(doc1.id, remote);
  await assert.rejects(b.push(copy.id, remote), (e) => e instanceof RemoteError && [403, 409].includes(e.status));
  await assert.rejects(b.pull(copy.id, remote), /forward/);
});
