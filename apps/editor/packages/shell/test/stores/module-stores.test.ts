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

// The shell's module-scope stores: state that one writer (a command, a
// loader) and one reader (an overlay, the save path) share without React,
// and that survives a dock close/reopen.
//
//   · chrome-storage-scope.ts — which workspace a chrome storage key is for
//   · open-file-handle.ts — the file a document was opened from, for Save
//   · import-source.ts — the file name of an import in flight (single shot)
//   · library-document.ts — the open document's library entry and the
//     open/save race between them

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { DocumentEntry, LibraryClient } from "@paged-media/repository";
import { stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import {
  chromeStorageScope,
  scopedChromeKey,
  setChromeStorageScope,
} from "../../src/state/chrome-storage-scope";
import {
  getOpenFileHandle,
  setOpenFileHandle,
  supportsFileHandles,
  writeToOpenFile,
  type WritableFileHandle,
} from "../../src/state/open-file-handle";
import {
  setPendingImportSource,
  takePendingImportSource,
} from "../../src/state/import-source";
import {
  commitSave,
  currentLibraryDocument,
  getLibrary,
  libraryVersion,
  rememberOpenedFile,
  setCurrentLibraryDocument,
  setLibrary,
  subscribeLibrary,
} from "../../src/state/library-document";

afterEach(() => unstubAllGlobals());

describe("chrome storage scope", () => {
  afterEach(() => setChromeStorageScope(""));

  test("the ordinary editor uses the bare key", () => {
    setChromeStorageScope("");
    expect(chromeStorageScope()).toBe("");
    expect(scopedChromeKey("paged.cockpit.v1")).toBe("paged.cockpit.v1");
  });

  test("a solo workspace suffixes every key with its scope", () => {
    setChromeStorageScope(".solo.paged.sheet");
    expect(chromeStorageScope()).toBe(".solo.paged.sheet");
    expect(scopedChromeKey("paged.cockpit.v1")).toBe(
      "paged.cockpit.v1.solo.paged.sheet",
    );
    expect(scopedChromeKey("paged.workflowMode")).toBe(
      "paged.workflowMode.solo.paged.sheet",
    );
  });
});

describe("open file handle (Save writes back to the opened file)", () => {
  afterEach(() => setOpenFileHandle(null));

  function handle(opts: {
    permission?: PermissionState;
    request?: PermissionState;
    failWrite?: boolean;
  }) {
    const log: string[] = [];
    let written: Blob | null = null;
    const h: WritableFileHandle = {
      name: "doc.paged",
      queryPermission: opts.permission
        ? async () => {
            log.push("query");
            return opts.permission!;
          }
        : undefined,
      requestPermission: async () => {
        log.push("request");
        return opts.request ?? "denied";
      },
      createWritable: async () => {
        log.push("open");
        return {
          write: async (data: BufferSource | Blob) => {
            if (opts.failWrite) throw new Error("disk full");
            written = data as Blob;
            log.push("write");
          },
          close: async () => void log.push("close"),
        };
      },
    };
    return { h, log, written: () => written };
  }

  test("no handle: nothing to write back, the caller downloads", async () => {
    expect(getOpenFileHandle()).toBeNull();
    expect(await writeToOpenFile(new Uint8Array([1]), "x/y")).toBe(false);
  });

  test("granted: the bytes are written and the file closed", async () => {
    const f = handle({ permission: "granted" });
    setOpenFileHandle(f.h);
    expect(getOpenFileHandle()).toBe(f.h);
    expect(
      await writeToOpenFile(
        new Uint8Array([1, 2, 3]),
        "application/x-paged+zip",
      ),
    ).toBe(true);
    expect(f.log).toEqual(["query", "open", "write", "close"]);
    const blob = f.written()!;
    expect(blob.type).toBe("application/x-paged+zip");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  test("prompt: asks, and writes only when the user grants", async () => {
    const yes = handle({ permission: "prompt", request: "granted" });
    setOpenFileHandle(yes.h);
    expect(await writeToOpenFile(new Uint8Array([1]), "a/b")).toBe(true);
    expect(yes.log).toEqual(["query", "request", "open", "write", "close"]);
    const no = handle({ permission: "prompt", request: "denied" });
    setOpenFileHandle(no.h);
    expect(await writeToOpenFile(new Uint8Array([1]), "a/b")).toBe(false);
    expect(no.log).toEqual(["query", "request"]);
  });

  test("denied, or a write that throws: false (never a save that did not happen)", async () => {
    const denied = handle({ permission: "denied" });
    setOpenFileHandle(denied.h);
    expect(await writeToOpenFile(new Uint8Array([1]), "a/b")).toBe(false);
    expect(denied.log).toEqual(["query"]);
    const broken = handle({ permission: "granted", failWrite: true });
    setOpenFileHandle(broken.h);
    expect(await writeToOpenFile(new Uint8Array([1]), "a/b")).toBe(false);
  });

  test("a handle without permission probes is written directly", async () => {
    const f = handle({});
    setOpenFileHandle(f.h);
    expect(await writeToOpenFile(new Uint8Array([9]), "a/b")).toBe(true);
    expect(f.log).toEqual(["open", "write", "close"]);
  });

  test("supportsFileHandles follows the platform's picker", () => {
    stubGlobal("showOpenFilePicker", undefined);
    expect(supportsFileHandles()).toBe(false);
    stubGlobal("showOpenFilePicker", () => Promise.resolve([]));
    expect(supportsFileHandles()).toBe(true);
  });
});

describe("pending import source", () => {
  test("a take returns the parked name once, then null", () => {
    expect(takePendingImportSource()).toBeNull();
    setPendingImportSource("Q3 report.xlsx");
    expect(takePendingImportSource()).toBe("Q3 report.xlsx");
    expect(takePendingImportSource()).toBeNull();
    setPendingImportSource("a.docx");
    setPendingImportSource(null);
    expect(takePendingImportSource()).toBeNull();
  });
});

describe("library document", () => {
  const entry = (id: string, head: string | null = "h0"): DocumentEntry => ({
    id,
    name: `${id}.paged`,
    createdAt: 1,
    updatedAt: 1,
    head,
  });

  /** A library whose imports resolve only when the test says so. */
  function fakeLibrary() {
    const calls: string[] = [];
    const pending: Array<(e: DocumentEntry) => void> = [];
    const lib = {
      importFile: (_bytes: Uint8Array, name: string) => {
        calls.push(`import ${name}`);
        return new Promise<DocumentEntry>((resolve) => pending.push(resolve));
      },
      save: async (id: string) => {
        calls.push(`save ${id}`);
        return { head: `${id}-h1`, changed: true };
      },
    } as unknown as LibraryClient;
    return {
      lib,
      calls,
      resolveImport: (i: number, e: DocumentEntry) => pending[i](e),
    };
  }

  const settle = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    setLibrary(null);
    setCurrentLibraryDocument(null);
  });

  test("set, read and subscribe: every change bumps the version", () => {
    const seen: number[] = [];
    const off = subscribeLibrary(() => seen.push(libraryVersion()));
    const { lib } = fakeLibrary();
    setLibrary(lib);
    expect(getLibrary()).toBe(lib);
    setCurrentLibraryDocument(entry("d1"));
    expect(currentLibraryDocument()?.id).toBe("d1");
    off();
    setCurrentLibraryDocument(null);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0] + 1);
  });

  test("without a library: an opened file is no library document and a save commits nothing", async () => {
    rememberOpenedFile(new Uint8Array([1]), "a.idml");
    expect(currentLibraryDocument()).toBeNull();
    expect(await commitSave(new Uint8Array([1]), "a.paged")).toBeNull();
  });

  test("an opened file becomes the library document once its import lands", async () => {
    const f = fakeLibrary();
    setLibrary(f.lib);
    rememberOpenedFile(new Uint8Array([1]), "a.idml");
    expect(currentLibraryDocument()).toBeNull();
    f.resolveImport(0, entry("a"));
    await settle();
    expect(currentLibraryDocument()?.id).toBe("a");
  });

  test("a save that races the open waits for it instead of minting a second document", async () => {
    const f = fakeLibrary();
    setLibrary(f.lib);
    rememberOpenedFile(new Uint8Array([1]), "a.idml");
    const saved = commitSave(new Uint8Array([2]), "a.paged");
    await settle();
    expect(f.calls).toEqual(["import a.idml"]);
    f.resolveImport(0, entry("a"));
    expect(await saved).toEqual({ head: "a-h1", changed: true });
    expect(f.calls).toEqual(["import a.idml", "save a"]);
    expect(currentLibraryDocument()?.head).toBe("a-h1");
  });

  test("a second open supersedes the first: the late import does not become current", async () => {
    const f = fakeLibrary();
    setLibrary(f.lib);
    rememberOpenedFile(new Uint8Array([1]), "first.idml");
    rememberOpenedFile(new Uint8Array([2]), "second.idml");
    f.resolveImport(1, entry("second"));
    await settle();
    f.resolveImport(0, entry("first"));
    await settle();
    expect(currentLibraryDocument()?.id).toBe("second");
  });

  test("a document with no library entry yet (File > New) is imported on its first save", async () => {
    const f = fakeLibrary();
    setLibrary(f.lib);
    const saved = commitSave(new Uint8Array([3]), "Untitled.paged");
    await settle();
    f.resolveImport(0, entry("new", "n0"));
    expect(await saved).toEqual({ head: "n0", changed: true });
    expect(currentLibraryDocument()?.id).toBe("new");
  });
});
