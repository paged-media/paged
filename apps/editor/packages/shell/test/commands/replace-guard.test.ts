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

// The one replace question (ADR 230, finding R8): what each answer does,
// the platform fallback when no prompt is mounted, and the drop path
// (`openFile`), which used to replace an edited document without asking
// (SH-10, UX audit F-01).

import { afterEach, describe, expect, test } from "bun:test";

import { covers, stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import { createImporterRegistry } from "../../src/registries/document-io";
import { openFile } from "../../src/state/commands/file-commands";
import {
  attachReplacePromptSurface,
  confirmReplace,
  isReplaceDeclined,
  replaceConfirmText,
  replaceDeclinedError,
  replacePrompts,
  setDocumentSaver,
} from "../../src/state/replace-guard";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  unstubAllGlobals();
});

/** A client whose dirty flag the test flips. */
function dirtyClient(initial: boolean) {
  const state = { dirty: initial, reads: 0 };
  return {
    state,
    client: {
      async documentMeta() {
        state.reads += 1;
        return { dirty: state.dirty };
      },
    },
  };
}

/** Mount a prompt surface (what `<ReplaceDocumentPrompt>` does). */
function surface() {
  disposers.push(attachReplacePromptSurface());
}

/** The question the guard is asking right now, once it asks. */
async function asked() {
  for (let i = 0; i < 20; i++) {
    const p = replacePrompts.current();
    if (p) return p;
    await Promise.resolve();
  }
  throw new Error("the guard asked nothing");
}

describe("the replace question (ADR 230)", () => {
  test("a clean document, or none: nothing is asked", async () => {
    covers("command:paged.file.new");
    surface();
    const { client } = dirtyClient(false);
    expect(await confirmReplace(client, { action: "Opening a.idml" })).toBe(
      true,
    );
    const none = {
      async documentMeta(): Promise<{ dirty: boolean }> {
        throw new Error("noDocument");
      },
    };
    expect(await confirmReplace(none, { action: "Opening a.idml" })).toBe(true);
    expect(replacePrompts.current()).toBeNull();
  });

  test("Don't save goes on; Cancel keeps the document", async () => {
    covers("command:paged.file.new");
    surface();
    const { client } = dirtyClient(true);
    const discard = confirmReplace(client, { action: "Opening a.idml" });
    const p1 = await asked();
    expect(p1.action).toBe("Opening a.idml");
    expect(p1.canSave).toBe(false);
    p1.answer("discard");
    expect(await discard).toBe(true);
    const cancel = confirmReplace(client, { action: "Opening a.idml" });
    (await asked()).answer("cancel");
    expect(await cancel).toBe(false);
    expect(replacePrompts.current()).toBeNull();
  });

  test("Save runs the registered save and goes on only when it left the document clean", async () => {
    covers("command:paged.file.new");
    surface();
    const { client, state } = dirtyClient(true);
    let saves = 0;
    let saveCleans = true;
    disposers.push(
      setDocumentSaver(() => {
        saves += 1;
        if (saveCleans) state.dirty = false;
      }),
    );
    const saved = confirmReplace(client, { action: "Creating a new document" });
    const p = await asked();
    expect(p.canSave).toBe(true);
    p.answer("save");
    expect(await saved).toBe(true);
    expect(saves).toBe(1);

    // A save that did not happen (the user cancelled its picker): keep.
    state.dirty = true;
    saveCleans = false;
    const abandoned = confirmReplace(client, {
      action: "Creating a new document",
    });
    (await asked()).answer("save");
    expect(await abandoned).toBe(false);
    expect(saves).toBe(2);
  });

  test("a plugin's request names the plugin and the document", async () => {
    covers("command:paged.file.new");
    surface();
    const { client } = dirtyClient(true);
    const r = confirmReplace(client, {
      action: "Opening Catalog (merged)",
      requester: "Data",
      documentName: "Catalog (merged)",
    });
    const p = await asked();
    expect([p.requester, p.documentName]).toEqual(["Data", "Catalog (merged)"]);
    p.answer("cancel");
    expect(await r).toBe(false);
  });

  test("two questions are asked one at a time, oldest first", async () => {
    covers("command:paged.file.new");
    surface();
    const { client } = dirtyClient(true);
    const a = confirmReplace(client, { action: "Opening a.idml" });
    const b = confirmReplace(client, { action: "Opening b.idml" });
    const first = await asked();
    expect(first.action).toBe("Opening a.idml");
    first.answer("cancel");
    const second = await asked();
    expect(second.action).toBe("Opening b.idml");
    second.answer("discard");
    expect([await a, await b]).toEqual([false, true]);
  });

  test("a prompt unmounted mid-question keeps the document", async () => {
    covers("command:paged.file.new");
    const detach = attachReplacePromptSurface();
    const { client } = dirtyClient(true);
    const r = confirmReplace(client, { action: "Opening a.idml" });
    await asked();
    detach();
    expect(await r).toBe(false);
  });

  test("with no prompt mounted the platform confirm asks, naming this platform's save chord", async () => {
    covers("command:paged.file.new");
    const seen: string[] = [];
    stubGlobal("confirm", (m: string) => (seen.push(m), false));
    const { client } = dirtyClient(true);
    expect(await confirmReplace(client, { action: "Opening a.idml" })).toBe(
      false,
    );
    expect(seen).toEqual([replaceConfirmText({ action: "Opening a.idml" })]);
    expect(seen[0]).toMatch(
      /^This document has unsaved edits\. Opening a\.idml will discard them\./,
    );
    expect(seen[0]).toMatch(/Save with (⌘S|Ctrl\+S) first/);
  });

  test("the declined error is an AbortError", () => {
    covers("command:paged.file.new");
    const err = replaceDeclinedError();
    expect(err.name).toBe("AbortError");
    expect(isReplaceDeclined(err)).toBe(true);
    expect(isReplaceDeclined(new Error("load failed"))).toBe(false);
  });
});

describe("SH-10 (UX audit F-01): a dropped file takes File ▸ Open's path", () => {
  function editorWith(dirty: boolean) {
    const loads: string[] = [];
    const editor = {
      client: {
        async documentMeta() {
          return { dirty };
        },
        async loadDocument() {
          loads.push("loadDocument");
          return {
            docId: "d",
            pageCount: 1,
            pageIds: ["p1"],
            pageSizesPt: [[612, 792]],
          };
        },
        async requestSnapshot(pageId: string, width: number) {
          return { pageId, pngBytes: [1], widthPx: width, heightPx: 1 };
        },
      },
      registries: { importers: createImporterRegistry() },
      document: {
        setHandle() {},
        setSourceName() {},
        setLoading() {},
        setSnapshotsReady() {},
        setSnapshots() {},
        resetForNewDocument() {},
      },
    };
    return { editor, loads };
  }
  const dropped = () =>
    new File([new Uint8Array([80, 75, 3, 4])], "dropped.idml");
  const sinks = { setStatus() {}, pushWarning() {} };

  test("an edited document is asked about before a drop replaces it; Cancel keeps it", async () => {
    covers("command:paged.file.openIdml");
    stubGlobal("fetch", async () => new Response("", { status: 404 }));
    surface();
    const { editor, loads } = editorWith(true);
    const open = openFile(editor as never, dropped(), sinks);
    const p = await asked();
    expect(p.action).toBe("Opening dropped.idml");
    p.answer("cancel");
    await open;
    expect(loads).toEqual([]);
  });

  test("Don't save replaces it", async () => {
    covers("command:paged.file.openIdml");
    stubGlobal("fetch", async () => new Response("", { status: 404 }));
    surface();
    const { editor, loads } = editorWith(true);
    const open = openFile(editor as never, dropped(), sinks);
    (await asked()).answer("discard");
    await open;
    expect(loads).toEqual(["loadDocument"]);
  });

  test("an importer the user declined at its own replace question is not a failure", async () => {
    covers("command:paged.file.openIdml");
    const { editor } = editorWith(true);
    editor.registries.importers.register({
      id: "t.pdf",
      title: "PDF",
      extensions: [".pdf"],
      async import() {
        throw replaceDeclinedError();
      },
    } as never);
    const statuses: string[] = [];
    const warnings: string[] = [];
    await openFile(editor as never, new File([new Uint8Array([1])], "a.pdf"), {
      setStatus: (s) => void statuses.push(s),
      pushWarning: (w) => void warnings.push(w),
    });
    expect(warnings).toEqual([]);
    expect(statuses.at(-1)).toBe("kept the open document; a.pdf not opened");
  });
});
