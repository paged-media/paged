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

// THE BUNDLEHOST CONTRACT — the document doors: `host.document` (mutate,
// undo/redo, the reads, the change and open events, plugin metadata),
// `host.selection`, `host.render.snapshot`, `host.text.measureString(s)`,
// `host.parts`, `host.documents`, `host.nativeDocument` and the font half of
// `host.assets`. On the `editor` adapter these run through the shell's
// PagedEditor and a real CanvasClient (the headless editor); on `headless`
// through the SDK harness's engine client. What plugin-api documents, on
// every adapter it applies to (hosts.ts).

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import type {
  DocumentChangeEvent,
  DocumentOpenedEvent,
  ElementId,
} from "@paged-media/plugin-api";
import { buildFixtureIdml, rect, textFrame } from "@paged-media/test-kit";

import {
  OTHER_ID,
  PROBE_ID,
  bareAdapter,
  editorAdapter,
  headlessAdapter,
  probeManifest,
  type HostUnderTest,
} from "./hosts";

/** One page: a frame, and a text frame with a two-paragraph story. */
const DOC = buildFixtureIdml({
  name: "bundle-host-document",
  pages: [
    {
      id: "pg1",
      items: [
        rect("ubox", [100, 72, 200, 272]),
        textFrame("utf", [300, 72, 400, 400], "ust"),
      ],
    },
  ],
  stories: [{ id: "ust", paragraphs: ["Hello world", "Second"] }],
});
const BOX: ElementId = { kind: "rectangle", id: "ubox" } as ElementId;
const OPACITY = { type: "length", value: 50 };

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b;
const isPng = (b: Uint8Array) =>
  b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

const ADAPTERS = [
  ["editor", editorAdapter],
  ["headless", headlessAdapter],
] as const;

// ── host.document: writes, history, events ──────────────────────────

describe.each(ADAPTERS)("host.document — %s", (_name, make) => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await make();
  });
  afterAll(async () => {
    await t.dispose();
  });
  beforeEach(async () => {
    await t.load(DOC);
  });

  test("onDidOpen reports the loaded document's pages", async () => {
    const opened: DocumentOpenedEvent[] = [];
    const sub = t.host.document.onDidOpen((e) => opened.push(e));
    const pageIds = await t.load(DOC);
    sub.dispose();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      pageCount: 1,
      pageIds,
      pageSizesPt: [[612, 792]],
    });
  });

  test("mutate applies, reports its pages, and fires onDidChange; undo and redo are changes too", async () => {
    const events: DocumentChangeEvent[] = [];
    const sub = t.host.document.onDidChange((e) => events.push(e));
    const out = await t.host.document.mutate({
      op: "setElementProperty",
      args: { elementId: BOX, path: "frameOpacity", value: OPACITY },
    } as never);
    expect(out.applied).toBe(true);
    await t.host.document.undo();
    await t.host.document.redo();
    sub.dispose();
    expect(events.map((e) => e.kind)).toEqual([
      "mutationApplied",
      "undoApplied",
      "redoApplied",
    ]);
    if (out.applied) expect(out.pageIds).toEqual(["pg1"]);
  });

  test("a mutation the engine refuses is a result, never a throw", async () => {
    const out = await t.host.document.mutate({
      op: "setElementProperty",
      args: {
        elementId: { kind: "rectangle", id: "nope" },
        path: "frameOpacity",
        value: OPACITY,
      },
    } as never);
    expect(out.applied).toBe(false);
  });

  test("an undeclared document write is a capability error; the refusal is a result", async () => {
    const reader = t.withManifest(
      probeManifest("media.paged.probereader", {
        capabilities: { document: { read: "broad" } },
      }),
    );
    const out = await reader.document.mutate({
      op: "setElementProperty",
      args: { elementId: BOX, path: "frameOpacity", value: OPACITY },
    } as never);
    expect(out.applied).toBe(false);
  });

  test("reads: meta, the pages collection, geometry, hit test, tree, parentOf", async () => {
    const meta = await t.host.document.meta();
    expect(meta.pageCount).toBe(1);
    const pages = await t.host.document.collection<{ selfId: string }>("pages");
    expect(pages.map((p) => p.selfId)).toEqual(["pg1"]);
    const [geo] = await t.host.document.elementGeometry([BOX]);
    expect(geo?.pageId).toBe("pg1");
    const hit = await t.host.document.hitTest("pg1", [120, 150]);
    expect(hit?.element).toEqual(BOX);
    const tree = JSON.stringify(await t.host.document.tree());
    expect(tree).toContain("ubox");
    expect(await t.host.document.parentOf(BOX)).toBeNull();
  });

  test("storyContent reads the story's paragraphs; an unknown story is null", async () => {
    const story = await t.host.document.storyContent("ust");
    expect(
      story?.paragraphs.map((p) => p.runs.map((r) => r.text).join("")),
    ).toEqual(["Hello world", "Second"]);
    expect(await t.host.document.storyContent("nope")).toBeNull();
  });

  test("plugin metadata: set, read back, namespaced to this plugin, undoable", async () => {
    const env = { v: 1, data: { kind: "chart" } };
    const out = await t.host.document.setMetadata(BOX, env as never);
    expect(out.applied).toBe(true);
    expect(await t.host.document.getMetadata(BOX)).toEqual(env);
    expect(await t.sibling().document.getMetadata(BOX)).toBeNull();
    await t.host.document.undo();
    expect(await t.host.document.getMetadata(BOX)).toBeNull();
  });

  test("document metadata: set and read back, per plugin", async () => {
    const env = { v: 1, data: { theme: "dark" } };
    expect(
      (await t.host.document.setDocumentMetadata(env as never)).applied,
    ).toBe(true);
    expect(await t.host.document.getDocumentMetadata()).toEqual(env);
    expect(await t.sibling().document.getDocumentMetadata()).toBeNull();
  });
});

// ── host.selection ───────────────────────────────────────────────────

describe.each(ADAPTERS)("host.selection — %s", (_name, make) => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await make();
    await t.load(DOC);
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("set selects, get reads it, onDidChange announces it; add and toggle combine", async () => {
    const seen: ElementId[][] = [];
    const sub = t.host.selection.onDidChange((ids) => seen.push([...ids]));
    await t.host.selection.set([BOX]);
    expect(t.host.selection.get()).toEqual([BOX]);
    const tf = { kind: "textFrame", id: "utf" } as ElementId;
    await t.host.selection.set([tf], "add");
    expect(t.host.selection.get()).toEqual([BOX, tf]);
    await t.host.selection.set([BOX], "toggle");
    expect(t.host.selection.get()).toEqual([tf]);
    await t.host.selection.set([]);
    expect(t.host.selection.get()).toEqual([]);
    sub.dispose();
    expect(seen.at(-1)).toEqual([]);
    expect(seen.length).toBeGreaterThanOrEqual(4);
  });

  test("changing the selection needs capabilities.document.write", async () => {
    const reader = t.withManifest(
      probeManifest("media.paged.probeselreader", {
        capabilities: { document: { read: "broad" } },
      }),
    );
    await expect(reader.selection.set([BOX])).rejects.toThrow(/write/);
  });
});

// ── host.render, host.text ───────────────────────────────────────────

describe.each(ADAPTERS)("host.render and host.text — %s", (_name, make) => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await make();
    await t.load(DOC);
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("snapshot renders the page as a PNG within a pixel of the width; an unknown page is null", async () => {
    expect(t.host.supports("render.snapshot@1")).toBe(true);
    const shot = await t.host.render.snapshot("pg1", { widthPx: 120 });
    expect(shot).not.toBeNull();
    expect(isPng(shot!.png)).toBe(true);
    expect(Math.abs(shot!.widthPx - 120)).toBeLessThanOrEqual(1);
    expect(shot!.heightPx).toBeGreaterThan(shot!.widthPx);
    expect(await t.host.render.snapshot("nope", { widthPx: 120 })).toBeNull();
  });

  test("measureStrings answers what measureString answers, per string, in order", async () => {
    const one = await t.host.text.measureString("Inter", null, "Hello", 12);
    expect(one.advance).toBeGreaterThan(0);
    const many = await t.host.text.measureStrings(
      "Inter",
      null,
      ["Hello", "Hello world"],
      12,
    );
    expect(many).toHaveLength(2);
    expect(many[0]).toEqual(one);
    expect(many[1]!.advance).toBeGreaterThan(one.advance);
    expect(await t.host.text.measureStrings("Inter", null, [], 12)).toEqual([]);
  });
});

// ── host.parts ───────────────────────────────────────────────────────

describe.each(ADAPTERS)("host.parts — %s", (_name, make) => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await make();
    await t.load(DOC);
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("write/read/list/delete under this plugin's namespace", async () => {
    expect(t.host.supports("storage.parts@2")).toBe(true);
    await t.host.parts.write("o1/spec.json", new TextEncoder().encode("{}"));
    await t.host.parts.write("o1/values.bin", new Uint8Array([1, 2]));
    expect(Array.from((await t.host.parts.read("o1/values.bin"))!)).toEqual([
      1, 2,
    ]);
    expect((await t.host.parts.list("o1/")).sort()).toEqual([
      "o1/spec.json",
      "o1/values.bin",
    ]);
    expect(await t.host.parts.read("absent")).toBeNull();
    expect(await t.host.parts.delete("o1/values.bin")).toBe(true);
    expect(await t.host.parts.delete("o1/values.bin")).toBe(false);
    expect(await t.host.parts.read("o1/values.bin")).toBeNull();
  });

  test("another plugin cannot see them; a path with .. is rejected", async () => {
    await t.host.parts.write("mine.bin", new Uint8Array([7]));
    const sibling = t.sibling();
    expect(await sibling.parts.read("mine.bin")).toBeNull();
    expect(await sibling.parts.list()).not.toContain("mine.bin");
    await expect(
      t.host.parts.write(`../${OTHER_ID}/x.bin`, new Uint8Array([1])),
    ).rejects.toThrow(/\.\./);
  });

  // PartsSurface: "`..`/absolute paths are rejected". The door strips a
  // leading slash and writes the part under the plugin's namespace instead.
  test.failing("HOST-6 — an absolute part path is rejected", async () => {
    await expect(
      t.host.parts.write("/abs.bin", new Uint8Array([1])),
    ).rejects.toThrow();
  });

  test("the parts travel with the file: exportPaged → open reads them back", async () => {
    await t.host.parts.write("travel/note.txt", new TextEncoder().encode("hi"));
    const bytes = await t.host.documents.exportPaged();
    await t.load(DOC); // another document in between
    expect(await t.host.parts.read("travel/note.txt")).toBeNull();
    const opened = await t.host.documents.open(bytes);
    expect(opened.opened).toBe(true);
    expect(
      new TextDecoder().decode((await t.host.parts.read("travel/note.txt"))!),
    ).toBe("hi");
  });
});

// ── host.documents ───────────────────────────────────────────────────

describe.each(ADAPTERS)("host.documents — %s", (name, make) => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await make();
  });
  afterAll(async () => {
    await t.dispose();
  });
  beforeEach(async () => {
    await t.load(DOC);
  });

  test("exportPaged serialises the open document as a .paged (ZIP) container", async () => {
    expect(t.host.supports("documents.exportPaged@1")).toBe(true);
    expect(isZip(await t.host.documents.exportPaged())).toBe(true);
  });

  test("open replaces a clean document, every bundle hears it, and the new one has no unsaved edits", async () => {
    const bytes = await t.host.documents.exportPaged();
    await t.newBlank();
    const heard: DocumentOpenedEvent[] = [];
    const sub = t.sibling().document.onDidOpen((e) => heard.push(e));
    const result = await t.host.documents.open(bytes, { name: "Copy" });
    sub.dispose();
    expect(result).toEqual({ opened: true, pageIds: ["pg1"] });
    expect(heard.map((e) => e.pageIds)).toEqual([["pg1"]]);
    expect((await t.host.document.meta()).dirty).toBe(false);
  });

  test("bytes that are not a package reject", async () => {
    await expect(
      t.host.documents.open(new Uint8Array([1, 2, 3, 4])),
    ).rejects.toThrow();
  });

  if (name === "editor")
    test("with unsaved edits the user is asked first; keeping them declines the open", async () => {
      const bytes = await t.host.documents.exportPaged();
      await t.host.document.mutate({
        op: "setElementProperty",
        args: { elementId: BOX, path: "frameOpacity", value: OPACITY },
      } as never);
      const pending = t.host.documents.open(bytes, { name: "Merged" });
      // The prompt is raised after the dirty check, a few awaits in.
      let prompt = t.editorApp!.documents.controller.current();
      for (let i = 0; !prompt && i < 50; i++) {
        await new Promise((r) => setTimeout(r, 5));
        prompt = t.editorApp!.documents.controller.current();
      }
      expect(prompt?.requester).toBe(`probe ${PROBE_ID}`);
      expect(prompt?.documentName).toBe("Merged");
      prompt!.decide(false);
      expect(await pending).toEqual({ opened: false, reason: "declined" });
      expect((await t.host.document.meta()).dirty).toBe(true);
    });

  test("an undeclared documents capability is a capability error", async () => {
    const narrow = t.withManifest(
      probeManifest("media.paged.probenodocs", { capabilities: {} }),
    );
    await expect(narrow.documents.exportPaged()).rejects.toThrow(/documents/);
  });
});

describe("host.documents and host.nativeDocument, no backend — bare", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await bareAdapter();
    await t.load(DOC);
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("documents: both doors reject, supports false", async () => {
    expect(t.host.supports("documents.open@1")).toBe(false);
    expect(t.host.supports("documents.exportPaged@1")).toBe(false);
    await expect(t.host.documents.exportPaged()).rejects.toThrow();
    await expect(t.host.documents.open(DOC)).rejects.toThrow();
  });

  test("nativeDocument: reads null / [], open rejects, supports false", async () => {
    expect(t.host.supports("document.readNative@1")).toBe(false);
    expect(t.host.supports("document.openNative@1")).toBe(false);
    expect(await t.host.nativeDocument.readModel()).toBeNull();
    expect(await t.host.nativeDocument.readComposition()).toBeNull();
    expect(await t.host.nativeDocument.listParts()).toEqual([]);
    await expect(t.host.nativeDocument.open(DOC)).rejects.toThrow();
  });
});

// ── host.nativeDocument, host.assets — the editor ────────────────────

describe("host.nativeDocument — the editor's engine client", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await editorAdapter();
    await t.load(DOC);
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("open loads the package as the active document", async () => {
    expect(t.host.supports("document.openNative@1")).toBe(true);
    await t.newBlank();
    await t.host.nativeDocument.open(DOC);
    const pages = await t.host.document.collection<{ selfId: string }>("pages");
    expect(pages.map((p) => p.selfId)).toEqual(["pg1"]);
  });

  test("the core-owned native parts read back from a .paged container", async () => {
    expect(t.host.supports("document.readNative@1")).toBe(true);
    const bytes = await t.host.documents.exportPaged();
    await t.host.documents.open(bytes);
    const parts = await t.host.nativeDocument.listParts();
    expect(parts.every((p) => p.startsWith("paged/core/"))).toBe(true);
    const model = await t.host.nativeDocument.readModel();
    expect(model === null || model.byteLength > 0).toBe(true);
    if (parts.includes("paged/core/model/document.pgm"))
      expect(model).not.toBeNull();
  });

  test("an undeclared readNative is a capability error", async () => {
    const narrow = t.withManifest(
      probeManifest("media.paged.probenonative", {
        capabilities: { document: { read: "broad" } },
      }),
    );
    await expect(narrow.nativeDocument.readModel()).rejects.toThrow(
      /readNative/,
    );
  });
});

describe("host.assets fonts — the editor's font registry", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await editorAdapter();
    await t.load(DOC);
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("getFontFace serves a face the engine holds and null for one it does not", async () => {
    const fonts = t.withManifest(
      probeManifest("media.paged.probefonts", {
        capabilities: { assets: ["fonts"] },
      }),
    );
    expect(fonts.supports("assets.fonts@1")).toBe(true);
    const inter = await fonts.assets.getFontFace("Inter");
    expect(inter?.family).toBe("Inter");
    expect(inter!.bytes.byteLength).toBeGreaterThan(1000);
    expect(await fonts.assets.getFontFace("Nonesuch Sans")).toBeNull();
  });
});

describe("host.assets fonts, no asset source — headless", () => {
  let t: HostUnderTest;
  beforeAll(async () => {
    t = await headlessAdapter();
    await t.load(DOC);
  });
  afterAll(async () => {
    await t.dispose();
  });

  test("getFontFace is null and supports(assets.fonts@1) false", async () => {
    const fonts = t.withManifest(
      probeManifest("media.paged.probefonts", {
        capabilities: { assets: ["fonts"] },
      }),
    );
    expect(fonts.supports("assets.fonts@1")).toBe(false);
    expect(await fonts.assets.getFontFace("Inter")).toBeNull();
  });
});
