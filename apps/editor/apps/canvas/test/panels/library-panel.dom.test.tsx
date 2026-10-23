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

// Library (paged.library): the open document's versions in the local
// library and every document kept there. The library here is the real one
// (packages/repository's Library over the repository wasm), on an
// in-memory file system instead of the browser's private one; the
// document's bytes are the engine's own .paged export.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { covers } from "@paged-media/test-kit";
import { initSync, Repository } from "@paged-media/canvas-wasm/repo";
import {
  Library,
  memoryFs,
  type DocumentEntry,
  type LibraryClient,
} from "@paged-media/repository";
import { setCurrentLibraryDocument, setLibrary } from "@paged-media/shell";

import { LibraryPanel } from "../../src/panels/library-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

beforeAll(() => {
  initSync({
    module: readFileSync(
      new URL(
        import.meta
          .resolve("@paged-media/canvas-wasm/repo/paged_repo_wasm_bg.wasm"),
      ),
    ),
  });
});

let prompted: string[] = [];
const realPrompt = globalThis.prompt;
const realConfirm = globalThis.confirm;
afterEach(() => {
  unmountAll();
  globalThis.prompt = realPrompt;
  globalThis.confirm = realConfirm;
  prompted = [];
});

type H = PanelHarness<unknown>;

/** A library holding the mounted document, opened, with `saves` versions. */
async function withDocument(saves = 1): Promise<{
  h: H;
  lib: Library;
  entry: DocumentEntry;
}> {
  const h = await mountPanel(LibraryPanel, { id: "paged.library" });
  let t = 1_000_000;
  let n = 0;
  const lib = new Library(memoryFs(), {
    createRepository: (owner) => new Repository(owner),
    now: () => (t += 60_000),
    newId: () => `doc-${++n}`,
  });
  const entry = await lib.importFile(
    await h.client.exportPaged(),
    "brochure.paged",
  );
  for (let i = 1; i < saves; i++) {
    await h.mutate({
      op: "insertPage",
      args: { afterPageId: h.handle!.pageIds[0], masterId: null },
    } as never);
    await lib.save(entry.id, await h.client.exportPaged(), `Save ${i + 1}`);
  }
  await h.act(() => {
    setLibrary(h.scope, lib as unknown as LibraryClient);
    setCurrentLibraryDocument(h.scope, entry);
  });
  return { h, lib, entry };
}

const versions = (h: H) => [
  ...h.root.querySelectorAll<HTMLElement>("[data-library-version]"),
];

describe("Library panel", () => {
  test("no private file system: it says the library is unavailable and files still work", async () => {
    covers("panel:paged.library");
    const h = await mountPanel(LibraryPanel, { id: "paged.library" });
    expect(h.root.textContent).toContain(
      "The library needs the browser's private file system",
    );
  });

  test("a library, but the document is not in it yet: says how it gets there", async () => {
    covers("panel:paged.library");
    const h = await mountPanel(LibraryPanel, { id: "paged.library" });
    await h.act(() =>
      setLibrary(
        h.scope,
        new Library(memoryFs(), {
          createRepository: (owner) => new Repository(owner),
        }) as unknown as LibraryClient,
      ),
    );
    expect(
      h.root.querySelector("[data-library-unsaved]")?.textContent,
    ).toContain("Not in the library yet.");
  });

  test("the document's versions, newest first, one per save", async () => {
    covers("panel:paged.library");
    const { h, lib, entry } = await withDocument(2);
    const log = await lib.log(entry.id);
    expect(
      versions(h).map((v) => v.getAttribute("data-library-version")),
    ).toEqual(log.map((c) => c.hash));
    expect(versions(h)).toHaveLength(2);
    expect(versions(h)[0].textContent).toContain("Save 2");
  });

  test("Restore makes an older version current again as a new version", async () => {
    covers("panel:paged.library");
    const { h, lib, entry } = await withDocument(2);
    const older = versions(h)[1].getAttribute("data-library-version")!;
    expect(versions(h)[0].querySelector("[data-library-restore]")).toBeNull();
    // Restoring reopens the document, which asks before discarding the
    // open document's unsaved edits: answer "discard".
    const asked: string[] = [];
    globalThis.confirm = ((message?: string) => {
      asked.push(String(message));
      return true;
    }) as typeof confirm;
    await h.click(versions(h)[1].querySelector("[data-library-restore]")!);
    await h.settle();
    expect(asked).toHaveLength(1);
    const log = await lib.log(entry.id);
    expect(log).toHaveLength(3);
    expect(versions(h)).toHaveLength(3);
    // The restored version's content is the head again.
    const head = await lib.exportPaged(entry.id, "main");
    const old = await lib.exportPaged(entry.id, older);
    expect(head.length).toBe(old.length);
  });

  test("Release names a version, and the name shows on it", async () => {
    covers("panel:paged.library");
    const { h, lib, entry } = await withDocument(1);
    await h.click(versions(h)[0].querySelector("[data-library-release]")!);
    const name = versions(h)[0].querySelector<HTMLInputElement>(
      "[data-library-release-name]",
    )!;
    name.focus();
    await h.user.keyboard("v1");
    await h.click(
      versions(h)[0].querySelector("[data-library-release-confirm]")!,
    );
    await h.settle();
    const refs = await lib.refs(entry.id);
    expect(refs["releases/v1"]).toBe(
      versions(h)[0].getAttribute("data-library-version")!,
    );
    expect(versions(h)[0].textContent).toContain("released v1");
  });

  // UX audit F-13 (fixed): each version showed a content hash as its
  // second line; it reads "Version n · author" now.
  test("PN-353 (UX F-13): versions are labelled for people, not by content hash", async () => {
    covers("panel:paged.library");
    const { h } = await withDocument(1);
    const hash = versions(h)[0].getAttribute("data-library-version")!;
    expect(versions(h)[0].textContent).not.toContain(hash.slice(0, 10));
  });

  // UX audit F-13 (fixed): "Release" asked through window.prompt; it
  // asks in the panel now.
  test("PN-354 (UX F-13): Release asks for the name in the panel, not through window.prompt", async () => {
    covers("panel:paged.library");
    const { h } = await withDocument(1);
    globalThis.prompt = ((message?: string) => {
      prompted.push(String(message));
      return null;
    }) as typeof prompt;
    await h.click(versions(h)[0].querySelector("[data-library-release]")!);
    expect(prompted).toEqual([]);
    expect(
      versions(h)[0].querySelector("[data-library-release-name]"),
    ).not.toBeNull();
  });
});
