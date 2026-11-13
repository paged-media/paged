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

// File ▸ Save (.paged), step by step into the save state (editor ADR
// 1203): the label is what really happened to the bytes.

import { describe, expect, test } from "bun:test";

import type { DocumentEntry, LibraryClient } from "@paged-media/repository";
import {
  createEditorScope,
  saveStateOf,
  setLibrary,
  setOpenFileHandle,
  type WritableFileHandle,
} from "@paged-media/shell";

import { savePagedFile, type SaveClient } from "../../../src/app/save-paged";

const BYTES = new Uint8Array([80, 75, 3, 4]);

function client() {
  const c = {
    editMark: 3,
    savedAt: null as number | null,
    exportPaged: async () => BYTES.slice(),
    markSaved(mark?: number) {
      c.savedAt = mark ?? c.editMark;
    },
    documentMeta: async () => ({ documentName: "Annual" }),
  };
  return c satisfies SaveClient;
}

function library(fail = false): LibraryClient {
  const entry: DocumentEntry = {
    id: "annual",
    name: "Annual",
    createdAt: 1,
    updatedAt: 1,
    head: "h1",
  };
  return {
    importFile: async () => {
      if (fail) throw new Error("quota");
      return entry;
    },
    save: async () => ({ head: "h2", changed: true }),
  } as unknown as LibraryClient;
}

function handle(write: () => Promise<void>): WritableFileHandle {
  return {
    name: "Annual.paged",
    queryPermission: async () => "granted",
    createWritable: async () => ({
      write,
      close: async () => undefined,
    }),
  };
}

const noPlugins = {
  run: async () => ({ failed: [] as string[], timedOut: [] as string[] }),
};

function setup() {
  const scope = createEditorScope();
  const store = saveStateOf(scope);
  store.dispatch({
    type: "opened",
    origin: { kind: "opened", name: "Annual" },
    at: 0,
  });
  store.dispatch({ type: "dirty", dirty: true });
  const kinds: string[] = [];
  store.subscribe(() => kinds.push(store.get().kind));
  const downloads: string[] = [];
  return {
    scope,
    store,
    kinds,
    downloads,
    download: (_b: Uint8Array, name: string) => void downloads.push(name),
  };
}

describe("savePagedFile reports what each step did", () => {
  test("library and file write: synced, no download", async () => {
    const { scope, store, kinds, downloads, download } = setup();
    setLibrary(scope, library());
    setOpenFileHandle(
      scope,
      handle(async () => undefined),
    );
    const c = client();
    await savePagedFile({
      scope,
      client: c,
      willSave: noPlugins,
      sourceName: "Annual",
      download,
    });
    expect(kinds).toContain("saving");
    expect(kinds).toContain("syncing");
    expect(store.get().kind).toBe("synced");
    expect(store.get().saved?.where).toEqual([
      { kind: "library" },
      { kind: "file", name: "Annual.paged" },
    ]);
    expect(downloads).toEqual([]);
    expect(c.savedAt).toBe(3);
  });

  test("UXI-T67: the file write fails after the local commit: not synced, never synced, and a download keeps the work", async () => {
    const { scope, store, kinds, downloads, download } = setup();
    setLibrary(scope, library());
    setOpenFileHandle(
      scope,
      handle(async () => {
        throw new DOMException("The file was moved", "NotFoundError");
      }),
    );
    await savePagedFile({
      scope,
      client: client(),
      willSave: noPlugins,
      sourceName: "Annual",
      download,
    });
    expect(kinds).not.toContain("synced");
    const s = store.get();
    expect(s.kind).toBe("not-synced");
    expect(s.missed?.code).toBe("file-missing");
    expect(s.missed?.target).toEqual({ kind: "file", name: "Annual.paged" });
    expect(s.saved?.where.map((d) => d.kind)).toEqual(["library", "download"]);
    expect(downloads).toEqual(["Annual.paged"]);
  });

  test("a declined permission is not synced too", async () => {
    const { scope, store, download } = setup();
    setLibrary(scope, library());
    setOpenFileHandle(scope, {
      ...handle(async () => undefined),
      queryPermission: async () => "prompt",
      requestPermission: async () => "denied",
    });
    await savePagedFile({
      scope,
      client: client(),
      willSave: noPlugins,
      sourceName: "Annual",
      download,
    });
    expect(store.get().kind).toBe("not-synced");
    expect(store.get().missed?.code).toBe("permission-denied");
  });

  test("no file to write back to: saved locally, in the library and a download", async () => {
    const { scope, store, downloads, download } = setup();
    setLibrary(scope, library());
    await savePagedFile({
      scope,
      client: client(),
      willSave: noPlugins,
      sourceName: "Annual",
      download,
    });
    expect(store.get().kind).toBe("saved-local");
    expect(downloads).toEqual(["Annual.paged"]);
  });

  test("a library that fails is noted; the download still lands", async () => {
    const { scope, store, download } = setup();
    setLibrary(scope, library(true));
    await savePagedFile({
      scope,
      client: client(),
      willSave: noPlugins,
      sourceName: "Annual",
      download,
    });
    const s = store.get();
    expect(s.kind).toBe("saved-local");
    expect(s.saved?.where.map((d) => d.kind)).toEqual(["download"]);
    expect(s.saved?.notes).toEqual([
      { kind: "library-failed", detail: "quota" },
    ]);
  });

  test("a host that refuses: failed, nothing stored, and the save throws", async () => {
    const { scope, store, download } = setup();
    const c = client();
    await expect(
      savePagedFile({
        scope,
        client: c,
        willSave: noPlugins,
        hostSave: async () => {
          throw new Error("offline");
        },
        sourceName: "Annual",
        download,
      }),
    ).rejects.toThrow("offline");
    expect(store.get().kind).toBe("failed");
    expect(store.get().failure?.code).toBe("host-refused");
    expect(c.savedAt).toBeNull();
  });

  test("an export that throws: failed, and still dirty", async () => {
    const { scope, store, download } = setup();
    const c = {
      ...client(),
      exportPaged: async () => {
        throw new Error("engine");
      },
    };
    await expect(
      savePagedFile({
        scope,
        client: c,
        willSave: noPlugins,
        sourceName: "Annual",
        download,
      }),
    ).rejects.toThrow("engine");
    expect(store.get().kind).toBe("failed");
    expect(store.get().dirty).toBe(true);
  });
});
