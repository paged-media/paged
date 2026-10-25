/*
 * This file is part of paged (https://paged.media).
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

// [plugin-slide.comments] The comments model: the pure edits (add, reply,
// resolve, delete), the store over the container part (a fake parts door),
// the author an edit is written under, the markers on the slide, and what
// export hands the engine per page.

import { describe, expect, it } from "bun:test";

import type { BundleHost, ToolPreviewText } from "@paged-media/plugin-api";

import { markerShapes } from "../src/comment-markers";
import {
  COMMENTS_PART,
  CommentsStore,
  fileFromReport,
  initialsOf,
  makeComment,
  newGuid,
  parseFile,
  withComment,
  withReply,
  withStatus,
  withoutComment,
  type CommentsFile,
  type SlideComment,
} from "../src/comments-model";
import { exportPlan } from "../src/deck-export";
import type { SlideReport } from "../src/engine";

const ANA = { id: "{A}", name: "Ana Lima", initials: "AL" };

function comment(over: Partial<SlideComment> = {}): SlideComment {
  return {
    id: "{C1}",
    authorId: "{B}",
    author: "Ben Ode",
    initials: "BO",
    created: "2026-10-01T09:00:00.000",
    text: "Tighten the title",
    x: 120,
    y: 40,
    shapeId: null,
    status: null,
    replies: [],
    legacy: false,
    ...over,
  };
}

/** A host with a parts door and a KV store, in memory. */
function fakeHost() {
  const parts = new Map<string, Uint8Array>();
  const kv = new Map<string, unknown>();
  const opened = new Set<() => void>();
  const host = {
    supports: (door: string) =>
      door === "storage.parts@1" || door === "document.onDidOpen@1",
    parts: {
      read: async (p: string) => parts.get(p) ?? null,
      write: async (p: string, b: Uint8Array) => void parts.set(p, b),
    },
    storage: {
      get: (k: string) => kv.get(k),
      set: (k: string, v: unknown) => void kv.set(k, v),
    },
    document: {
      onDidOpen(l: () => void) {
        opened.add(l);
        return { dispose: () => opened.delete(l) };
      },
    },
  } as unknown as BundleHost;
  const file = (): CommentsFile | null =>
    parseFile(parts.get(COMMENTS_PART) ?? null);
  return { host, parts, kv, file, reopen: () => opened.forEach((l) => l()) };
}

describe("[plugin-slide.comments] the comments model", () => {
  it("makes PowerPoint's GUIDs and initials", () => {
    expect(newGuid()).toMatch(
      /^\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}$/,
    );
    expect(newGuid()).not.toBe(newGuid());
    expect(initialsOf("Ana Lima")).toBe("AL");
    expect(initialsOf("  paged ")).toBe("P");
    expect(initialsOf("A B C D")).toBe("ABC");
  });

  it("keeps the import report's comments per page, an empty list included", () => {
    const slides = [
      { pageId: "p1", comments: [comment()] },
      { pageId: "p2", comments: [] },
      { pageId: "p3" },
    ] as unknown as SlideReport[];
    expect(fileFromReport(slides)).toEqual({
      v: 1,
      byPage: { p1: [comment()], p2: [], p3: [] },
    });
  });

  it("adds, replies, resolves and deletes without touching the other threads", () => {
    const base: CommentsFile = { v: 1, byPage: { p1: [comment()] } };
    const made = makeComment(ANA, "Use the brand blue", { x: 10, y: 20 });
    expect(made).toMatchObject({
      authorId: "{A}",
      author: "Ana Lima",
      initials: "AL",
      text: "Use the brand blue",
      x: 10,
      y: 20,
      status: null,
      replies: [],
      legacy: false,
    });
    expect(Number.isNaN(Date.parse(made.created!))).toBe(false);

    const added = withComment(base, "p1", made);
    expect(added.byPage.p1!.map((c) => c.id)).toEqual(["{C1}", made.id]);
    expect(base.byPage.p1).toHaveLength(1); // not mutated

    const { file: replied, reply } = withReply(
      added,
      "p1",
      "{C1}",
      ANA,
      "Done",
    );
    expect(reply).toMatchObject({ author: "Ana Lima", text: "Done" });
    expect(replied.byPage.p1![0]!.replies).toEqual([reply!]);
    expect(withReply(added, "p1", "{nope}", ANA, "x").reply).toBeNull();

    const resolved = withStatus(replied, "p1", "{C1}", true);
    expect(resolved.byPage.p1![0]!.status).toBe("resolved");
    expect(
      withStatus(resolved, "p1", "{C1}", false).byPage.p1![0]!.status,
    ).toBeNull();

    const noReply = withoutComment(resolved, "p1", "{C1}", reply!.id);
    expect(noReply.byPage.p1![0]!.replies).toEqual([]);
    const gone = withoutComment(noReply, "p1", "{C1}");
    expect(gone.byPage.p1!.map((c) => c.id)).toEqual([made.id]);
    // An unknown comment changes nothing (the very same file).
    expect(withoutComment(gone, "p1", "{nope}")).toBe(gone);
  });

  it("the store writes every change to the container part and reads it back on open", async () => {
    const f = fakeHost();
    const store = new CommentsStore(f.host);
    await store.ready();
    expect(store.has()).toBe(false);
    await store.replace({ v: 1, byPage: { p1: [comment()], p2: [] } });
    expect(store.has()).toBe(true);

    const c = await store.add("p2", "New thread", "Ana Lima", { x: 5, y: 6 });
    expect(f.file()!.byPage.p2!.map((x) => x.text)).toEqual(["New thread"]);
    const r = await store.reply("p2", c.id, "A reply", "Ben Ode");
    // Ben is the deck's own author: the reply is written under his id.
    expect(r).toMatchObject({ authorId: "{B}", initials: "BO" });
    expect(await store.setResolved("p2", c.id, true)).toBe(true);
    expect(f.file()!.byPage.p2![0]!.status).toBe("resolved");
    expect(await store.remove("p1", "{C1}")).toBe(true);
    expect(await store.remove("p1", "{C1}")).toBe(false);
    expect(f.file()!.byPage.p1).toEqual([]);

    // Another store (the document reopened) reads what was written.
    const again = new CommentsStore(f.host);
    await again.ready();
    expect(again.forPage("p2").map((x) => x.text)).toEqual(["New thread"]);
    expect(again.forPage("p2")[0]!.replies.map((x) => x.text)).toEqual([
      "A reply",
    ]);
    expect(again.forPage(null)).toEqual([]);
    store.dispose();
    again.dispose();
  });

  it("writes new comments under one id per name, remembered per user", async () => {
    const f = fakeHost();
    const store = new CommentsStore(f.host);
    await store.replace({ v: 1, byPage: { p1: [] } });
    expect(store.authorName()).toBe("");
    store.setAuthorName("  Ana Lima ");
    expect(store.authorName()).toBe("Ana Lima");
    const a = await store.add("p1", "one", "Ana Lima");
    const b = await store.add("p1", "two", "Ana Lima");
    expect(a.authorId).toBe(b.authorId);
    expect(a.authorId).toMatch(/^\{.+\}$/);
    expect(a.initials).toBe("AL");
    store.dispose();
  });

  it("marks the open threads on the slide, the slide's own ones stacked in its corner", () => {
    const shapes = markerShapes("p1", [
      comment({ id: "a", x: 100, y: 50, initials: "BO" }),
      comment({ id: "b", x: null, y: null, initials: "AL" }),
      comment({ id: "c", x: null, y: null, initials: "CX" }),
      comment({ id: "d", status: "resolved", initials: "RS" }),
    ]);
    const rects = shapes.filter((s) => "rect" in s) as { rect: number[] }[];
    const texts = shapes.filter(
      (s) => (s as ToolPreviewText).kind === "text",
    ) as ToolPreviewText[];
    expect(rects.map((r) => r.rect)).toEqual([
      [50, 100, 68, 118],
      [8, 8, 26, 26],
      [30, 8, 48, 26],
    ]);
    expect(texts.map((t) => t.text)).toEqual(["BO", "AL", "CX"]);
    expect(shapes.every((s) => s.pageId === "p1")).toBe(true);
  });

  it("export hands each page its comments only when the document keeps them", async () => {
    const host = {
      supports: () => false,
      document: {
        collection: async () => [
          {
            selfId: "p1",
            pluginMetadata: [
              {
                key: "x-paged:media.paged.slide",
                value: JSON.stringify({
                  v: 1,
                  data: { part: "ppt/slides/slide1.xml" },
                }),
              },
            ],
          },
          { selfId: "p2" },
        ],
        tree: async () => [],
        elementGeometry: async () => [],
        frameChain: async () => [],
        storyContent: async () => null,
      },
    } as unknown as BundleHost;
    const without = await exportPlan(host, {});
    expect(without.every((p) => !("comments" in p))).toBe(true);
    const withComments = await exportPlan(
      host,
      {},
      { v: 1, byPage: { p1: [comment()] } },
    );
    expect(withComments.map((p) => p.comments)).toEqual([[comment()], []]);
  });
});
