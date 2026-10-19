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

// File ▸ Open…, File ▸ New and File ▸ New from a brief… — the shell's
// file commands, run through the registry against a recording client.
//
// What they promise: Open routes a file a plugin importer claims to that
// importer (no discard prompt — an importer need not replace anything) and
// every other file through the one IDML load path; New mints a blank US
// Letter page. Both ASK before discarding an edited document, ask nothing
// when there is no document, and stop on "no". A load that fails says so
// in the status line and leaves no half-open document.

import { afterEach, describe, expect, test } from "bun:test";

import { covers, stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import { createCommandRegistry } from "../../src/registries/command";
import { createImporterRegistry } from "../../src/registries/document-io";
import {
  buildNewDocumentCommand,
  buildNewFromBriefCommand,
  buildOpenIdmlCommand,
} from "../../src/state/commands/file-commands";
import { takePendingImportSource } from "../../src/state/import-source";

const SFNT = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9]);

interface Calls {
  [name: string]: unknown[][];
}

function harness(opts: {
  dirty?: boolean;
  noDocument?: boolean;
  confirm?: boolean;
  loadFails?: boolean;
  font?: boolean;
  pages?: string[];
}) {
  const calls: Calls = {};
  const log =
    (name: string) =>
    (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
    };
  const handle = {
    docId: "d1",
    pageCount: (opts.pages ?? ["p1"]).length,
    pageIds: opts.pages ?? ["p1"],
    pageSizesPt: (opts.pages ?? ["p1"]).map(() => [612, 792]),
  };
  const client = {
    async documentMeta() {
      log("documentMeta")();
      if (opts.noDocument) throw new Error("noDocument");
      return { dirty: opts.dirty ?? false };
    },
    async newBlankDocument(w: number, h: number, font?: Uint8Array) {
      log("newBlankDocument")(w, h, font ?? null);
      if (opts.loadFails) throw new Error("engine said no");
      return handle;
    },
    async loadDocument(bytes: Uint8Array, font?: Uint8Array) {
      log("loadDocument")(Array.from(bytes), font ?? null);
      if (opts.loadFails) throw new Error("not an IDML package");
      return handle;
    },
    async requestSnapshot(pageId: string, width: number) {
      log("requestSnapshot")(pageId, width);
      return { pageId, pngBytes: [1, 2, 3], widthPx: width, heightPx: 1 };
    },
  };
  let snapshots = new Map<string, string>();
  const editor = {
    client,
    registries: { importers: createImporterRegistry() },
    document: {
      setHandle: log("setHandle"),
      setSourceName: log("setSourceName"),
      setLoading: log("setLoading"),
      setSnapshotsReady: log("setSnapshotsReady"),
      setSnapshots: (fn: (m: Map<string, string>) => Map<string, string>) => {
        snapshots = fn(snapshots);
      },
      resetForNewDocument: log("resetForNewDocument"),
    },
  };
  const statuses: string[] = [];
  const warnings: string[] = [];
  const prompts: string[] = [];
  stubGlobal("confirm", (message: string) => {
    prompts.push(message);
    return opts.confirm ?? false;
  });
  stubGlobal("fetch", async () =>
    opts.font
      ? new Response(SFNT, { status: 200 })
      : new Response("<html>", { status: 404 }),
  );
  let picked: File | null = null;
  const registry = createCommandRegistry(() => editor);
  const sinks = {
    setStatus: (s: string) => void statuses.push(s),
    pushWarning: (w: string) => void warnings.push(w),
  };
  registry.register(
    buildOpenIdmlCommand({ pickFile: async () => picked, ...sinks }),
  );
  registry.register(buildNewDocumentCommand(sinks));
  return {
    registry,
    editor,
    calls,
    statuses,
    warnings,
    prompts,
    snapshots: () => snapshots,
    pick(file: File | null) {
      picked = file;
    },
  };
}

afterEach(() => unstubAllGlobals());

const idml = (name = "Brochure.idml") =>
  new File([new Uint8Array([80, 75, 3, 4])], name, {
    type: "application/vnd.adobe.indesign-idml-package",
  });

describe("File ▸ New (paged.file.new)", () => {
  test("a clean document: a blank US Letter page, set up like an opened file", async () => {
    covers("command:paged.file.new");
    const h = harness({ font: true });
    await h.registry.invoke("paged.file.new");
    expect(h.calls.newBlankDocument).toEqual([[612, 792, SFNT]]);
    expect(h.calls.resetForNewDocument).toHaveLength(1);
    expect(h.calls.setSourceName).toEqual([[null]]);
    expect(h.calls.setHandle?.[0]?.[0]).toMatchObject({ pageIds: ["p1"] });
    expect(h.calls.requestSnapshot).toEqual([["p1", 256]]);
    expect([...h.snapshots().keys()]).toEqual(["p1"]);
    expect(h.calls.setSnapshotsReady).toEqual([[true]]);
    expect(h.prompts).toEqual([]);
    expect(h.warnings).toEqual([]);
    expect(h.statuses.at(-1)).toBe("loaded 1 page");
  });

  test("an edited document is not discarded without asking; 'no' keeps it", async () => {
    covers("command:paged.file.new");
    const h = harness({ dirty: true, confirm: false });
    await h.registry.invoke("paged.file.new");
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toMatch(
      /^This document has unsaved edits\. Creating a new document will discard them\./,
    );
    expect(h.calls.newBlankDocument).toBeUndefined();
    expect(h.calls.resetForNewDocument).toBeUndefined();
  });

  test("an edited document and 'yes': replaced", async () => {
    covers("command:paged.file.new");
    const h = harness({ dirty: true, confirm: true });
    await h.registry.invoke("paged.file.new");
    expect(h.prompts).toHaveLength(1);
    expect(h.calls.newBlankDocument).toHaveLength(1);
  });

  test("no document open: nothing to lose, no prompt", async () => {
    covers("command:paged.file.new");
    const h = harness({ noDocument: true });
    await h.registry.invoke("paged.file.new");
    expect(h.prompts).toEqual([]);
    expect(h.calls.newBlankDocument).toHaveLength(1);
  });

  test("a missing default font is said out loud, and the document still opens", async () => {
    covers("command:paged.file.new");
    const h = harness({ font: false });
    await h.registry.invoke("paged.file.new");
    expect(h.calls.newBlankDocument).toEqual([[612, 792, null]]);
    expect(h.warnings).toEqual([
      "default font unavailable — text in documents with missing fonts will not render",
    ]);
  });

  test("an engine failure leaves no handle and says so", async () => {
    covers("command:paged.file.new");
    const h = harness({ loadFails: true });
    await h.registry.invoke("paged.file.new");
    expect(h.calls.setHandle).toBeUndefined();
    expect(h.calls.setLoading?.at(-1)).toEqual([null]);
    expect(h.statuses.at(-1)).toBe(
      "new document failed: Error: engine said no",
    );
  });

  test("the size is configurable (a solo app's artboard)", async () => {
    covers("command:paged.file.new");
    const h = harness({});
    const r = createCommandRegistry(() => h.editor);
    r.register(
      buildNewDocumentCommand({
        setStatus: () => {},
        pushWarning: () => {},
        defaultSizePt: [800, 600],
      }),
    );
    await r.invoke("paged.file.new");
    expect(h.calls.newBlankDocument?.[0]?.slice(0, 2)).toEqual([800, 600]);
  });
});

describe("File ▸ Open… (paged.file.openIdml)", () => {
  test("a cancelled picker does nothing at all", async () => {
    covers("command:paged.file.openIdml");
    const h = harness({ dirty: true });
    h.pick(null);
    await h.registry.invoke("paged.file.openIdml");
    expect(h.calls).toEqual({});
    expect(h.prompts).toEqual([]);
  });

  test("an IDML file loads through the one load path, named after the file", async () => {
    covers("command:paged.file.openIdml");
    const h = harness({ font: true, pages: ["p1", "p2"] });
    h.pick(idml());
    await h.registry.invoke("paged.file.openIdml");
    expect(h.calls.loadDocument).toEqual([[[80, 75, 3, 4], SFNT]]);
    expect(h.calls.setSourceName).toEqual([["Brochure"]]);
    expect(h.calls.requestSnapshot).toEqual([
      ["p1", 256],
      ["p2", 256],
    ]);
    expect(h.statuses.at(-1)).toBe("loaded 2 pages");
  });

  test("replacing an edited document asks first, naming the file; 'no' keeps it", async () => {
    covers("command:paged.file.openIdml");
    const h = harness({ dirty: true, confirm: false });
    h.pick(idml("Annual.idml"));
    await h.registry.invoke("paged.file.openIdml");
    expect(h.prompts[0]).toMatch(/Opening Annual\.idml will discard them/);
    expect(h.calls.loadDocument).toBeUndefined();
  });

  test("a file a plugin importer claims goes to the importer, without a discard prompt", async () => {
    covers("command:paged.file.openIdml");
    const h = harness({ dirty: true, confirm: false });
    const seen: unknown[] = [];
    let parked: string | null = "unset";
    h.editor.registries.importers.register({
      id: "t.sheet",
      title: "Spreadsheet",
      extensions: [".xlsx"],
      async import(request: {
        name: string;
        bytes: Uint8Array;
        mimeType?: string;
      }) {
        // The open orchestration reads the parked name while the import runs.
        parked = takePendingImportSource();
        seen.push({ ...request, bytes: Array.from(request.bytes) });
      },
    } as never);
    h.pick(
      new File([new Uint8Array([7, 7])], "Budget.xlsx", { type: "x/xlsx" }),
    );
    await h.registry.invoke("paged.file.openIdml");
    expect(seen).toEqual([
      { name: "Budget.xlsx", bytes: [7, 7], mimeType: "x/xlsx" },
    ]);
    expect(parked).toBe("Budget.xlsx");
    expect(takePendingImportSource()).toBeNull();
    expect(h.prompts).toEqual([]);
    expect(h.calls.loadDocument).toBeUndefined();
    expect(h.statuses).toEqual([
      "importing Budget.xlsx via Spreadsheet…",
      "imported Budget.xlsx",
    ]);
  });

  test("an importer's failure is a warning, and the parked name is cleared", async () => {
    covers("command:paged.file.openIdml");
    const h = harness({});
    h.editor.registries.importers.register({
      id: "t.bad",
      title: "Broken",
      extensions: [".bad"],
      async import() {
        throw new Error("corrupt workbook");
      },
    } as never);
    h.pick(new File([new Uint8Array([1])], "x.bad"));
    await h.registry.invoke("paged.file.openIdml");
    expect(h.warnings).toEqual([
      "import of x.bad via Broken failed: corrupt workbook",
    ]);
    expect(takePendingImportSource()).toBeNull();
  });

  test("a file the engine cannot load fails the open in the status line", async () => {
    covers("command:paged.file.openIdml");
    const h = harness({ loadFails: true });
    h.pick(idml());
    await h.registry.invoke("paged.file.openIdml");
    expect(h.calls.setHandle).toBeUndefined();
    expect(h.statuses.at(-1)).toBe("load failed: Error: not an IDML package");
  });
});

describe("File ▸ New from a brief… (paged.file.newFromBrief)", () => {
  test("opens the assistant's brief view and touches no document", async () => {
    covers("command:paged.file.newFromBrief");
    let opened = 0;
    const r = createCommandRegistry(() => null);
    r.register(buildNewFromBriefCommand(() => void opened++));
    await r.invoke("paged.file.newFromBrief");
    expect(opened).toBe(1);
    expect(r.get("paged.file.newFromBrief")?.when).toBeUndefined();
  });
});
