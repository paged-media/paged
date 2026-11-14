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

// Session continuity (UX audit F-06; editor ADR 1224): the library
// document open last is remembered with a shape check and reopened only
// when the editor shows none and the recovery journal offers nothing; the
// recent list puts the library's documents and the files opened lately in
// one order, newest first.

import { describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";
import type { DocumentEntry } from "@paged-media/repository";
import {
  createEditorScope,
  editorStorage,
  memoryStorage,
  setEditorStorage,
  setLibrary,
} from "@paged-media/shell";

import {
  LAST_DOCUMENT_KEY,
  readLastDocument,
  recentDocuments,
  reopenLastDocument,
} from "../../../src/session-continuity";

const entry = (id: string, updatedAt: number): DocumentEntry => ({
  id,
  name: `doc ${id}`,
  createdAt: 0,
  updatedAt,
  head: "c",
});

function scopeWith(docs: DocumentEntry[]) {
  const scope = createEditorScope();
  setEditorStorage(scope, memoryStorage());
  setLibrary(scope, {
    list: async () => docs,
  } as never);
  return scope;
}

describe("the document open last", () => {
  test("is read with a shape check", () => {
    covers("setting:paged.session.lastDocument.v1");
    const scope = scopeWith([]);
    const storage = editorStorage(scope);
    expect(readLastDocument(scope)).toBeNull();
    storage.setItem(LAST_DOCUMENT_KEY, "not json");
    expect(readLastDocument(scope)).toBeNull();
    storage.setItem(LAST_DOCUMENT_KEY, JSON.stringify({ id: 7 }));
    expect(readLastDocument(scope)).toBeNull();
    storage.setItem(LAST_DOCUMENT_KEY, JSON.stringify({ id: "d1" }));
    expect(readLastDocument(scope)).toBe("d1");
  });

  test("does not reopen over an open document, and forgets one the library lost", async () => {
    covers("setting:paged.session.lastDocument.v1");
    const scope = scopeWith([entry("d1", 1)]);
    editorStorage(scope).setItem(
      LAST_DOCUMENT_KEY,
      JSON.stringify({ id: "gone" }),
    );
    const paged = { scope, document: { handle: null } } as never;
    expect(await reopenLastDocument(paged)).toBe(false);
    expect(readLastDocument(scope)).toBeNull();
    editorStorage(scope).setItem(
      LAST_DOCUMENT_KEY,
      JSON.stringify({ id: "d1" }),
    );
    const open = { scope, document: { handle: { docId: "x" } } } as never;
    expect(await reopenLastDocument(open)).toBe(false);
    expect(readLastDocument(scope)).toBe("d1");
  });
});

describe("File ▸ Open recent", () => {
  test("library documents and recent files, newest first; datasets left out", async () => {
    const scope = scopeWith([
      entry("old", 10),
      entry("new", 30),
      { ...entry("data", 40), kind: "data" },
    ]);
    const rows = await recentDocuments(scope, {
      recentFiles: async () => [
        {
          key: "fh:1",
          name: "Brochure.idml",
          handle: { name: "Brochure.idml" },
          seenAt: 20,
        },
      ],
    });
    expect(rows.map((r) => [r.kind, r.name])).toEqual([
      ["library", "doc new"],
      ["file", "Brochure.idml"],
      ["library", "doc old"],
    ]);
  });
});
