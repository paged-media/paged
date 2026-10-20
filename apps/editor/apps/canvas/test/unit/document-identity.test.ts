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

// Editor ADR 264 — the identity a remembered network grant is keyed by,
// and the consent backend that keeps the grants under it.

import { describe, expect, test } from "bun:test";

import { attachFileSource, sourceOfFile } from "@paged-media/shell";

import {
  createDocumentIdentity,
  memoryHandleStore,
  type HandleStore,
} from "../../src/document-identity";
import {
  createEditorConsentBackend,
  REMEMBERED_GRANTS_KEY,
  type GrantStorage,
} from "../../src/plugin-consent";

const ORIGIN = "https://data.example.org";
const PLUGIN = "media.paged.data";

function memoryStorage(): GrantStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

function fileHandle(name: string) {
  const h = {
    name,
    isSameEntry: async (o: unknown) => o === h,
  };
  return h;
}

/** One editor session: the identity over `store`, the backend over
 *  `storage`, a settable open document. */
function session(store: HandleStore, storage: GrantStorage) {
  let doc: string | null = null;
  let n = 0;
  const identity = createDocumentIdentity({
    store,
    documentId: () => doc,
    mint: () => `k${++n}`,
  });
  const consent = createEditorConsentBackend({ identity, storage });
  let loads = 0;
  return {
    identity,
    consent,
    /** Load a document (a new engine docId) from `source`. */
    async open(source: Parameters<typeof identity.declare>[1]) {
      doc = `doc-${++loads}`;
      identity.declare(doc, source);
      await identity.ready();
    },
    async ask(): Promise<boolean> {
      const pending = consent.backend.request([ORIGIN], "read", PLUGIN);
      const prompt = consent.controller.current()!;
      const rememberable = prompt.rememberable;
      prompt.decide({ granted: [ORIGIN], remember: true });
      expect((await pending).remembered).toBe(rememberable);
      return rememberable;
    },
    held: () => consent.backend.grants!(PLUGIN),
  };
}

describe("document identity (editor ADR 264)", () => {
  test("a picked file is recognised again by its handle; the grant survives a reload", async () => {
    const store = memoryHandleStore();
    const storage = memoryStorage();
    const h = fileHandle("a.paged");
    const one = session(store, storage);
    await one.open({ kind: "fileHandle", handle: h, lastModified: 5, size: 9 });
    expect(one.identity.current().stable).toBe(true);
    expect(await one.ask()).toBe(true);
    // Nothing about the grant is in the document: it is in this browser,
    // under the host-minted key.
    expect(JSON.parse(storage.map.get(REMEMBERED_GRANTS_KEY)!)).toEqual({
      [one.identity.current().key]: { [PLUGIN]: [ORIGIN] },
    });
    // A reload: a new session over the same storage and handle store.
    const two = session(store, storage);
    await two.open({ kind: "fileHandle", handle: h, lastModified: 5, size: 9 });
    expect(two.held()).toEqual([ORIGIN]);
    // The next document, from nowhere recognisable, holds nothing.
    await two.open({ kind: "transient" });
    expect(two.held()).toEqual([]);
  });

  test("the same name and bytes from another place, or the file changed elsewhere, ask again", async () => {
    const store = memoryHandleStore();
    const storage = memoryStorage();
    const h = fileHandle("a.paged");
    const s = session(store, storage);
    await s.open({ kind: "fileHandle", handle: h, lastModified: 5, size: 9 });
    await s.ask();
    await s.open({
      kind: "fileHandle",
      handle: fileHandle("a.paged"),
      lastModified: 5,
      size: 9,
    });
    expect(s.held()).toEqual([]);
    await s.open({ kind: "fileHandle", handle: h, lastModified: 6, size: 9 });
    expect(s.held()).toEqual([]);
  });

  test("a save through the handle keeps the file recognised", async () => {
    const store = memoryHandleStore();
    const storage = memoryStorage();
    const h = fileHandle("a.paged");
    const s = session(store, storage);
    await s.open({ kind: "fileHandle", handle: h, lastModified: 5, size: 9 });
    await s.ask();
    s.identity.written(h, { lastModified: 7, size: 12 });
    await s.identity.ready();
    const again = session(store, storage);
    await again.open({
      kind: "fileHandle",
      handle: h,
      lastModified: 7,
      size: 12,
    });
    expect(again.held()).toEqual([ORIGIN]);
  });

  test("another document written over a recognised file makes it a new one", async () => {
    const store = memoryHandleStore();
    const storage = memoryStorage();
    const h = fileHandle("a.paged");
    const s = session(store, storage);
    await s.open({ kind: "fileHandle", handle: h, lastModified: 5, size: 9 });
    await s.ask();
    await s.open({ kind: "transient" });
    s.identity.written(h, { lastModified: 8, size: 3 });
    await s.identity.ready();
    await s.open({ kind: "fileHandle", handle: h, lastModified: 8, size: 3 });
    expect(s.held()).toEqual([]);
  });

  test("a library document is recognised by its library id", async () => {
    const s = session(memoryHandleStore(), memoryStorage());
    await s.open({ kind: "library", documentId: "lib-1" });
    expect(s.identity.current()).toEqual({ key: "lib:lib-1", stable: true });
    await s.ask();
    await s.open({ kind: "library", documentId: "lib-2" });
    expect(s.held()).toEqual([]);
    await s.open({ kind: "library", documentId: "lib-1" });
    expect(s.held()).toEqual([ORIGIN]);
  });

  test("a transient document's grant lasts while it is open and is never stored", async () => {
    const storage = memoryStorage();
    const s = session(memoryHandleStore(), storage);
    await s.open({ kind: "transient" });
    expect(await s.ask()).toBe(false);
    expect(s.held()).toEqual([ORIGIN]);
    expect(storage.map.size).toBe(0);
    await s.open({ kind: "transient" });
    expect(s.held()).toEqual([]);
  });

  test("a grant goes to the document that asked, even if another opened meanwhile", async () => {
    const s = session(memoryHandleStore(), memoryStorage());
    await s.open({ kind: "library", documentId: "lib-1" });
    const pending = s.consent.backend.request([ORIGIN], "read", PLUGIN);
    const prompt = s.consent.controller.current()!;
    await s.open({ kind: "library", documentId: "lib-2" });
    prompt.decide({ granted: [ORIGIN], remember: false });
    await pending;
    expect(s.held()).toEqual([]);
    await s.open({ kind: "library", documentId: "lib-1" });
    expect(s.held()).toEqual([ORIGIN]);
  });

  test("the source rides with the File object, not with its name or bytes", () => {
    const h = fileHandle("a.paged");
    const picked = attachFileSource(new File(["x"], "a.paged"), h);
    expect(sourceOfFile(picked)).toMatchObject({
      kind: "fileHandle",
      handle: h,
    });
    expect(sourceOfFile(new File(["x"], "a.paged"))).toEqual({
      kind: "transient",
    });
  });
});
