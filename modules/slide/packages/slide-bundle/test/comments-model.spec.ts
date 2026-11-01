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

// [plugin-slide.comments] The comments model over the engine's comment threads
// (engine ADR 1055): a deck's comments become threads on their page or shape,
// the rows read back as what export hands the engine, the store writes through
// the engine's mutations, an older deck's container part is moved into the
// document once, and export hands each page its comments only when the
// document keeps them.

import { describe, expect, it } from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";

import {
  COMMENTS_PART,
  CommentsStore,
  commentMutations,
  fileFromReport,
  fileFromRows,
  initialsOf,
  makeComment,
  newGuid,
  shapeAddress,
  shapeOfAddress,
  type CommentsFile,
  type EngineCommentRow,
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

type Mutation = { op: string; args: Record<string, any> };

/** The rows the engine would list for the mutations a deck's comments make. */
function rowsFor(file: CommentsFile): EngineCommentRow[] {
  const rows: EngineCommentRow[] = [];
  const flat = (ops: Mutation[]): Mutation[] => ops;
  for (const m of flat(commentMutations(file))) {
    if (m.op === "insertCommentThread") {
      const c = m.args.comment;
      const anchor = m.args.anchor;
      rows.push({
        id: c.id,
        threadId: c.id,
        author: c.author,
        initials: c.initials,
        date: c.date,
        text: c.text,
        resolved: c.resolved,
        person: c.person,
        page: anchor.kind === "page" ? anchor.page : anchor.item,
        at: anchor.kind === "page" ? anchor.at : [0, 0],
        anchor,
        source: c.source,
      });
    } else if (m.op === "replyComment") {
      const c = m.args.comment;
      rows.push({
        id: c.id,
        parentId: m.args.parentId,
        author: c.author,
        initials: c.initials,
        date: c.date,
        text: c.text,
        resolved: false,
        person: c.person,
        source: c.source,
      });
    }
  }
  return rows;
}

/** A host with the engine's comment door and a KV store, in memory. */
function fakeHost(initial: EngineCommentRow[] = []) {
  let rows = initial;
  const parts = new Map<string, Uint8Array>();
  const kv = new Map<string, unknown>();
  const sent: Mutation[] = [];
  const opened = new Set<() => void>();
  const changed = new Set<() => void>();
  const host = {
    supports: (door: string) =>
      [
        "storage.parts@1",
        "document.onDidOpen@1",
        "document.onDidChange@1",
      ].includes(door),
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
      onDidChange(l: () => void) {
        changed.add(l);
        return { dispose: () => changed.delete(l) };
      },
      collection: async () => rows,
      mutate: async (m: Mutation) => {
        sent.push(m);
        return { applied: true };
      },
    },
  } as unknown as BundleHost;
  return {
    host,
    parts,
    kv,
    sent,
    setRows: (r: EngineCommentRow[]) => void (rows = r),
    reopen: () => opened.forEach((l) => l()),
  };
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

  it("names a shape on its page by a module address", () => {
    expect(shapeAddress(7)).toBe("shape:7");
    expect(shapeOfAddress("shape:7")).toBe(7);
    expect(shapeOfAddress("Sheet1!B3")).toBeNull();
    expect(shapeOfAddress(undefined)).toBeNull();
  });

  it("puts a deck's comments into the document: each author once, each comment a thread on its page or shape, each reply in its thread", () => {
    const file: CommentsFile = {
      v: 1,
      byPage: {
        p1: [
          comment({
            replies: [
              {
                id: "{R1}",
                authorId: "{B}",
                author: "Ben Ode",
                initials: "BO",
                created: "2026-10-02T09:00:00.000",
                text: "Done",
              },
            ],
          }),
          comment({
            id: "{C2}",
            shapeId: 5,
            x: null,
            y: null,
            status: "resolved",
          }),
        ],
      },
    };
    const ops = commentMutations(file) as Mutation[];
    expect(ops.map((o) => o.op)).toEqual([
      "setPerson",
      "insertCommentThread",
      "replyComment",
      "insertCommentThread",
    ]);
    expect(ops[0]!.args.person).toEqual({
      id: "{B}",
      name: "Ben Ode",
      initials: "BO",
    });
    expect(ops[1]!.args.anchor).toEqual({
      kind: "page",
      page: "p1",
      at: [120, 40],
    });
    expect(ops[1]!.args.comment).toMatchObject({
      id: "{C1}",
      author: "Ben Ode",
      date: "2026-10-01T09:00:00.000",
      person: "{B}",
      resolved: false,
    });
    expect(ops[2]!.args).toMatchObject({
      parentId: "{C1}",
      comment: { id: "{R1}", text: "Done" },
    });
    expect(ops[3]!.args.anchor).toEqual({
      kind: "cell",
      item: "p1",
      address: "shape:5",
    });
    expect(ops[3]!.args.comment.resolved).toBe(true);
  });

  it("reads the engine's rows back as exactly what the deck held", () => {
    const file: CommentsFile = {
      v: 1,
      byPage: {
        p1: [
          comment({
            legacy: true,
            replies: [
              {
                id: "{R1}",
                authorId: "{B}",
                author: "Ben Ode",
                initials: "BO",
                created: "2026-10-02T09:00:00.000",
                text: "Done",
              },
            ],
          }),
          comment({
            id: "{C2}",
            shapeId: 5,
            x: null,
            y: null,
            status: "closed",
          }),
        ],
      },
    };
    expect(fileFromRows(rowsFor(file))).toEqual(file);
  });

  it("a comment the panel made has no source: it takes its place from the engine's page and point", () => {
    const rows: EngineCommentRow[] = [
      {
        id: "7",
        threadId: "7",
        author: "Cy",
        text: "From the host panel",
        resolved: false,
        page: "p2",
        at: [30, 60],
        anchor: { kind: "item", item: "u9" } as never,
        date: "2026-11-01T10:00:00Z",
      },
      // A text comment has no slide to go on.
      {
        id: "8",
        threadId: undefined,
        author: "Cy",
        text: "on text",
        resolved: false,
      } as never,
      // A thread whose target is gone is not exported.
      {
        id: "9",
        threadId: "9",
        author: "Cy",
        text: "orphan",
        resolved: false,
        page: null,
      },
    ];
    const f = fileFromRows(rows);
    expect(Object.keys(f.byPage)).toEqual(["p2"]);
    expect(f.byPage.p2![0]).toMatchObject({
      id: "7",
      author: "Cy",
      initials: "C",
      text: "From the host panel",
      x: 30,
      y: 60,
      shapeId: null,
      status: null,
      legacy: false,
      replies: [],
    });
  });

  it("resolving in the host sets the exported status; reopening clears a resolved one", () => {
    const file: CommentsFile = {
      v: 1,
      byPage: { p1: [comment({ status: "resolved" })] },
    };
    const rows = rowsFor(file);
    rows[0]!.resolved = false; // reopened in the host panel
    expect(fileFromRows(rows).byPage.p1![0]!.status).toBeNull();
    rows[0]!.resolved = true;
    expect(fileFromRows(rows).byPage.p1![0]!.status).toBe("resolved");
  });

  it("the store reads the engine's comments on open and after a change", async () => {
    const f = fakeHost(rowsFor({ v: 1, byPage: { p1: [comment()] } }));
    const store = new CommentsStore(f.host);
    await store.ready();
    expect(store.has()).toBe(true);
    expect(store.forPage("p1").map((c) => c.text)).toEqual([
      "Tighten the title",
    ]);
    f.setRows([]);
    await store.load();
    expect(store.forPage("p1")).toEqual([]);
    store.dispose();
  });

  it("the store writes through the engine's mutations", async () => {
    const f = fakeHost(rowsFor({ v: 1, byPage: { p1: [comment()] } }));
    const store = new CommentsStore(f.host);
    await store.ready();

    const made = await store.add("p1", "Use the brand blue", "Ana Lima", {
      x: 10,
      y: 20,
    });
    const batch = f.sent.at(-1)!;
    expect(batch.op).toBe("batch");
    expect((batch.args.ops as Mutation[]).map((o) => o.op)).toEqual([
      "setPerson",
      "insertCommentThread",
    ]);
    expect((batch.args.ops as Mutation[])[1]!.args.comment.id).toBe(made.id);

    const reply = await store.reply("p1", "{C1}", "Agreed", "Ana Lima");
    expect(reply?.text).toBe("Agreed");
    expect((f.sent.at(-1)!.args.ops as Mutation[]).at(-1)!.args.parentId).toBe(
      "{C1}",
    );
    expect(await store.reply("p1", "{missing}", "x", "Ana Lima")).toBeNull();

    expect(await store.setResolved("p1", "{C1}", true)).toBe(true);
    expect(f.sent.at(-1)).toEqual({
      op: "resolveComment",
      args: { commentId: "{C1}", resolved: true },
    });
    expect(await store.setResolved("p1", "{missing}", true)).toBe(false);

    expect(await store.remove("p1", "{C1}")).toBe(true);
    expect(f.sent.at(-1)).toEqual({
      op: "deleteComment",
      args: { commentId: "{C1}" },
    });
    expect(await store.remove("p1", "{C1}", "{nope}")).toBe(false);
    store.dispose();
  });

  it("an older deck's container part is moved into the document once", async () => {
    const f = fakeHost([]);
    f.parts.set(
      COMMENTS_PART,
      new TextEncoder().encode(
        JSON.stringify({
          v: 1,
          byPage: { p1: [comment()] },
        } satisfies CommentsFile),
      ),
    );
    const store = new CommentsStore(f.host);
    await store.ready();
    const ops = f.sent.flatMap((m) =>
      m.op === "batch" ? (m.args.ops as Mutation[]) : [m],
    );
    expect(ops.map((o) => o.op)).toEqual(["setPerson", "insertCommentThread"]);
    // The part is emptied so the next open does not move it again.
    const left = JSON.parse(
      new TextDecoder().decode(f.parts.get(COMMENTS_PART)!),
    );
    expect(left).toEqual({ v: 1, byPage: {} });
    store.dispose();
  });

  it("writes new comments under one id per name, remembered per user", async () => {
    const f = fakeHost(rowsFor({ v: 1, byPage: { p1: [comment()] } }));
    const store = new CommentsStore(f.host);
    await store.ready();
    // The deck's own author of that name keeps their id, so PowerPoint shows one person.
    expect(store.author("Ben Ode").id).toBe("{B}");
    const a = store.author("Ana Lima");
    expect(store.author("Ana Lima").id).toBe(a.id);
    expect(a.id).toMatch(/^\{/);
    store.setAuthorName("  Ana Lima ");
    expect(store.authorName()).toBe("Ana Lima");
    expect(makeComment(ANA, "x").authorId).toBe("{A}");
    store.dispose();
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
