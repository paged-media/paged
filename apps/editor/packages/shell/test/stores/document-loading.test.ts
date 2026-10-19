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

// The document state's writers outside React:
//
//   · document-loader.ts — open a file / File ▸ New: reset, load, hand the
//     handle over, snapshot every page in order, then "ready"; the
//     default font is fetched and only accepted when it IS a font;
//   · script-selection.ts — a script that changed the selection pushes
//     it into the main-thread mirror the chrome draws from.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type {
  CanvasClient,
  DocumentHandle,
  ElementId,
  WorkerToMain,
} from "@paged-media/client";
import { stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import {
  createBlankDocument,
  fetchDefaultFont,
  loadDocumentFile,
  type DocumentLoaderCallbacks,
} from "../../src/state/document-loader";
import {
  currentLibraryDocument,
  setCurrentLibraryDocument,
  setLibrary,
} from "../../src/state/library-document";
import { followScriptSelection } from "../../src/state/script-selection";

const TRUETYPE = new Uint8Array([0, 1, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 0]);
const HTML = new TextEncoder().encode("<!doctype html><html></html>");

/** `fetch` answering the default font path with `body` (or a 404). */
function serveFont(body: Uint8Array | null) {
  const asked: string[] = [];
  stubGlobal("fetch", async (url: string) => {
    asked.push(String(url));
    return body
      ? new Response(body.slice(), { status: 200 })
      : new Response("missing", { status: 404 });
  });
  return asked;
}

const handleOf = (docId: string, pageIds: string[]) =>
  ({
    docId,
    pageIds,
    pageCount: pageIds.length,
    pageSizesPt: pageIds.map(() => [612, 792]),
  }) as unknown as DocumentHandle;

/** Records every callback, in order. */
function recorder() {
  const log: string[] = [];
  const cb: DocumentLoaderCallbacks = {
    setHandle: (h) => log.push(`handle ${h?.docId ?? null}`),
    setLoading: (l) => log.push(`loading ${l ? l.name : null}`),
    setStatus: (s) => log.push(`status ${s}`),
    setSnapshotsReady: (r) => log.push(`ready ${r}`),
    addSnapshot: (p) => log.push(`snapshot ${p}`),
    resetForNewDocument: () => log.push("reset"),
    pushWarning: (w) => log.push(`warning ${w}`),
    setSourceName: (n) => log.push(`name ${n}`),
  };
  return { log, cb };
}

function client(opts: {
  handle?: DocumentHandle;
  failLoad?: boolean;
  failSnapshot?: string;
  gate?: Promise<void>;
}) {
  const loads: Array<{ bytes: number; font: boolean }> = [];
  const c = {
    async loadDocument(bytes: Uint8Array, font?: Uint8Array) {
      loads.push({ bytes: bytes.length, font: Boolean(font) });
      if (opts.failLoad) throw new Error("not an IDML package");
      return opts.handle!;
    },
    async newBlankDocument(w: number, h: number, font?: Uint8Array) {
      loads.push({ bytes: w * 1000 + h, font: Boolean(font) });
      return opts.handle!;
    },
    async requestSnapshot(pageId: string) {
      await opts.gate;
      if (pageId === opts.failSnapshot) throw new Error("render failed");
      return { pageId, pngBytes: [137, 80], widthPx: 256, heightPx: 1 };
    },
  } as unknown as CanvasClient;
  return { c, loads };
}

beforeEach(() => {
  setLibrary(null);
  setCurrentLibraryDocument(null);
});
afterEach(() => unstubAllGlobals());

describe("loading a file", () => {
  test("reset → load with the default font → handle → every page snapshotted in order → ready", async () => {
    serveFont(TRUETYPE);
    const { log, cb } = recorder();
    const { c, loads } = client({ handle: handleOf("d1", ["p1", "p2"]) });
    await loadDocumentFile(
      c,
      new File([new Uint8Array(10)], "Annual report.idml"),
      cb,
    );
    expect(loads).toEqual([{ bytes: 10, font: true }]);
    expect(log).toEqual([
      "status loading Annual report.idml (10 bytes)…",
      "loading Annual report.idml",
      "reset",
      "name Annual report",
      "handle d1",
      "loading null",
      "status loaded 2 pages; snapshotting…",
      "snapshot p1",
      "snapshot p2",
      "status loaded 2 pages",
      "ready true",
    ]);
  });

  test("a failed load says so and keeps the previous document's handle", async () => {
    serveFont(TRUETYPE);
    const { log, cb } = recorder();
    const { c } = client({ failLoad: true });
    await loadDocumentFile(c, new File([new Uint8Array(3)], "broken.idml"), cb);
    expect(log).not.toContain("handle null");
    expect(log.filter((l) => l.startsWith("handle"))).toEqual([]);
    expect(log.at(-1)).toBe("status load failed: Error: not an IDML package");
    expect(log).toContain("loading null");
  });

  test("a page whose snapshot fails is a warning; the rest still land", async () => {
    serveFont(TRUETYPE);
    const { log, cb } = recorder();
    const { c } = client({
      handle: handleOf("d1", ["p1", "p2", "p3"]),
      failSnapshot: "p2",
    });
    await loadDocumentFile(c, new File([new Uint8Array(1)], "x.idml"), cb);
    expect(log.filter((l) => /^(snapshot|warning|ready)/.test(l))).toEqual([
      "snapshot p1",
      "warning snapshot p2: Error: render failed",
      "snapshot p3",
      "ready true",
    ]);
  });

  test("no default font: the load goes ahead and a warning says text may not render", async () => {
    serveFont(null);
    const { log, cb } = recorder();
    const { c, loads } = client({ handle: handleOf("d1", ["p1"]) });
    await loadDocumentFile(c, new File([new Uint8Array(1)], "x.idml"), cb);
    expect(loads[0].font).toBe(false);
    expect(log).toContain(
      "warning default font unavailable — text in documents with missing fonts will not render",
    );
  });

  test("an opened file becomes a library document only when it did not come from the library", async () => {
    serveFont(TRUETYPE);
    const entry = {
      id: "lib-1",
      name: "x.paged",
      createdAt: 1,
      updatedAt: 1,
      head: "h",
    };
    const { cb } = recorder();
    const { c } = client({ handle: handleOf("d1", ["p1"]) });
    await loadDocumentFile(c, new File([new Uint8Array(1)], "x.paged"), {
      ...cb,
      libraryDocument: entry,
    });
    expect(currentLibraryDocument()).toBe(entry);
  });

  // Finding SH-105: nothing ties a snapshot pass to the load that started
  // it. A second file opened while the first is still snapshotting resets
  // the document state, but the first pass keeps going: its pages' thumbnails
  // land in the NEW document's map, and its closing "loaded N pages" status
  // and snapshotsReady=true arrive after the new document's reset.
  test.failing(
    "SH-105: a newer load stops the older load's snapshot pass",
    async () => {
      serveFont(TRUETYPE);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const { log, cb } = recorder();
      const first = client({ handle: handleOf("old", ["o1", "o2"]), gate });
      const second = client({ handle: handleOf("new", ["n1"]) });
      const a = loadDocumentFile(
        first.c,
        new File([new Uint8Array(1)], "old.idml"),
        cb,
      );
      // Let the first load reach its snapshot pass.
      await new Promise((r) => setTimeout(r, 10));
      const b = loadDocumentFile(
        second.c,
        new File([new Uint8Array(1)], "new.idml"),
        cb,
      );
      await b;
      release();
      await a;
      const afterSecondReset = log.slice(log.lastIndexOf("reset"));
      expect(afterSecondReset.filter((l) => l.startsWith("snapshot"))).toEqual([
        "snapshot n1",
      ]);
    },
  );
});

describe("File > New", () => {
  test("a blank page of the given size, with no source name and no library entry yet", async () => {
    serveFont(TRUETYPE);
    setCurrentLibraryDocument({
      id: "old",
      name: "o",
      createdAt: 1,
      updatedAt: 1,
      head: null,
    });
    const { log, cb } = recorder();
    const { c, loads } = client({ handle: handleOf("blank", ["b1"]) });
    await createBlankDocument(c, { widthPt: 612, heightPt: 792 }, cb);
    expect(loads).toEqual([{ bytes: 612 * 1000 + 792, font: true }]);
    expect(currentLibraryDocument()).toBeNull();
    expect(log).toEqual([
      "status creating new document…",
      "loading Untitled",
      "reset",
      "name null",
      "handle blank",
      "loading null",
      "status new 1-page document; snapshotting…",
      "snapshot b1",
      "status loaded 1 page",
      "ready true",
    ]);
  });
});

describe("the default font", () => {
  test("only real font bytes are accepted (a static host's index.html is not a font)", async () => {
    const asked = serveFont(TRUETYPE);
    expect(await fetchDefaultFont()).toEqual(TRUETYPE);
    expect(asked).toEqual(["/fonts/Inter.ttf"]);
    serveFont(HTML);
    expect(await fetchDefaultFont()).toBeUndefined();
    serveFont(null);
    expect(await fetchDefaultFont()).toBeUndefined();
    stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    expect(await fetchDefaultFont()).toBeUndefined();
  });
});

describe("script selection follows into the mirror", () => {
  const A = { kind: "rectangle", id: "a" } as ElementId;
  const B = { kind: "oval", id: "b" } as ElementId;

  function scriptClient() {
    const listeners = new Set<(m: WorkerToMain) => void>();
    let selection: ElementId[] = [];
    const calls: string[] = [];
    const c = {
      subscribe(l: (m: WorkerToMain) => void) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      async setElementSelection(ids: ElementId[], mode: string) {
        calls.push(`read ${mode} ${ids.length}`);
        return selection;
      },
      async elementGeometry(ids: ElementId[]) {
        return ids.map((id) => ({ id, bounds: [0, 0, 1, 1] }));
      },
    };
    const emit = (m: unknown) => {
      for (const l of listeners) l(m as WorkerToMain);
    };
    return {
      c: c as unknown as Pick<
        CanvasClient,
        "subscribe" | "setElementSelection" | "elementGeometry"
      >,
      calls,
      emit,
      select: (ids: ElementId[]) => (selection = ids),
      listeners,
    };
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  test("a script result reads the worker's selection and pushes a changed one with its geometry", async () => {
    const s = scriptClient();
    const pushed: unknown[] = [];
    const geometry: unknown[] = [];
    const off = followScriptSelection(s.c, {
      setElementSelection: (ids) => pushed.push(ids),
      setElementGeometry: (items) => geometry.push(items),
    });
    s.select([A, B]);
    s.emit({ kind: "scriptResult", payload: {} });
    await tick();
    expect(s.calls).toEqual(["read add 0"]);
    expect(pushed).toEqual([[A, B]]);
    expect(geometry).toHaveLength(1);
    off();
  });

  test("an unchanged selection is not pushed; a reported one counts as known", async () => {
    const s = scriptClient();
    const pushed: unknown[] = [];
    followScriptSelection(s.c, {
      setElementSelection: (ids) => pushed.push(ids),
      setElementGeometry: () => {},
    });
    s.select([A]);
    s.emit({ kind: "elementSelectionApplied", payload: { ids: [A] } });
    s.emit({ kind: "scriptResult", payload: {} });
    await tick();
    expect(pushed).toEqual([]);
    // A new document forgets what was known.
    s.emit({ kind: "documentLoaded", payload: {} });
    s.emit({ kind: "scriptResult", payload: {} });
    await tick();
    expect(pushed).toEqual([[A]]);
  });

  test("after dispose nothing is read or pushed", async () => {
    const s = scriptClient();
    const pushed: unknown[] = [];
    const off = followScriptSelection(s.c, {
      setElementSelection: (ids) => pushed.push(ids),
      setElementGeometry: () => {},
    });
    off();
    expect(s.listeners.size).toBe(0);
    s.select([B]);
    s.emit({ kind: "scriptResult", payload: {} });
    await tick();
    expect(pushed).toEqual([]);
    expect(s.calls).toEqual([]);
  });
});
