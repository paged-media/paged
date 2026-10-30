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

// Doc ADR 613 — Word's Review over a recording host: the store reads the
// engine's collections (engine ADRs 1040 and 1020) into changes and
// threads with caret offsets, the margin band shows what each markup view
// shows, and each review command is the one mutation Word's verb is.

import { describe, expect, it } from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import {
  buildReview,
  changeAt,
  createReviewStore,
  initialsOf,
  stepTo,
  type CommentRead,
  type TrackedChangeRead,
} from "../src/word/review-model";
import {
  bandItems,
  nextCommentId,
  REVIEW_COMMAND,
  REVIEW_KEYS,
  reviewCommands,
} from "../src/word/review";

// "Größe ändern" / "zweite Zeile": the first paragraph is 12 characters
// and 15 bytes, so the second starts at char 12, content 16.
const PARAS = [[{ text: "Größe ändern" }], [{ text: "zweite Zeile" }]];

const CHANGES: TrackedChangeRead[] = [
  {
    storyId: "s1",
    offset: 6,
    end: 12,
    id: "1",
    kind: "insert",
    userName: "Author A",
    date: "2026-10-29T10:00:00Z",
    changeType: "InsertedText",
    text: "ändern",
  },
  {
    storyId: "s1",
    offset: 12,
    end: 18,
    id: "2",
    kind: "delete",
    userName: "Author B",
    changeType: "DeletedText",
    text: "zweite",
  },
  {
    storyId: "s1",
    offset: 0,
    end: 5,
    id: "3",
    kind: "format",
    userName: "Author A",
    text: "Größe",
  },
];
const COMMENTS: CommentRead[] = [
  {
    id: "0",
    storyId: "s1",
    start: 19,
    end: 24,
    anchorText: "Zeile",
    text: "Check this",
    author: "Author C",
    resolved: false,
  },
  {
    id: "4",
    storyId: "s1",
    parentId: "0",
    text: "Done",
    author: "Author A",
  },
];

function fakeHost(opts: {
  sel?: { storyId: string; start: number; end: number } | null;
  props?: Record<string, unknown>;
}) {
  const mutations: Array<{ op: string; args: Record<string, unknown> }> = [];
  const revealed: unknown[] = [];
  const props = { ...(opts.props ?? {}) };
  const host = {
    supports: () => true,
    log: { warn() {}, info() {} },
    text: {
      selection: () => opts.sel ?? null,
      characterRange: async () =>
        opts.sel ? { storyId: opts.sel.storyId, start: 6, end: 12 } : null,
    },
    viewport: {
      revealText: async (r: unknown, o: unknown) => {
        revealed.push([r, o]);
        return true;
      },
    },
    shell: { openPanel() {} },
    objects: {
      get: async (_a: string, path: string) =>
        path in props
          ? { kind: "value", value: props[path] }
          : { kind: "missing" },
    },
    document: {
      collection: async (name: string) =>
        name === "trackedChanges"
          ? CHANGES
          : name === "comments"
            ? COMMENTS
            : [],
      storyContent: async (id: string) => ({
        selfId: id,
        paragraphs: PARAS.map((runs) => ({ runs })),
      }),
      mutate: async (m: { op: string; args: Record<string, unknown> }) => {
        mutations.push(m);
        return { applied: true };
      },
    },
  };
  return { host: host as unknown as BundleHost, mutations, revealed };
}

describe("the review model (review-model.ts)", () => {
  it("reads changes and threads with caret offsets and the authors in order", () => {
    const texts = new Map([["s1", ["Größe ändern", "zweite Zeile"]]]);
    const r = buildReview(CHANGES, COMMENTS, texts);
    expect(r.changes.map((c) => [c.key, c.kind, c.anchor])).toEqual([
      ["1", "insert", { start: 8, end: 15 }],
      ["2", "delete", { start: 15, end: 22 }],
      ["3", "format", { start: 0, end: 7 }],
    ]);
    // char 12 is the first paragraph's end, so the deletion starts there
    // in content offsets (15) — the engine's own rule.
    expect(r.threads).toHaveLength(1);
    expect(r.threads[0]!.replies.map((c) => c.text)).toEqual(["Done"]);
    expect(r.threads[0]!.anchor).toEqual({ start: 23, end: 28 });
    expect(r.authors).toEqual(["Author A", "Author B", "Author C"]);
  });

  it("reads an InDesign deletion (no id) by its place", () => {
    const r = buildReview(
      [{ storyId: "s1", offset: 3, changeType: "DeletedText", text: "x" }],
      [],
      new Map(),
    );
    expect(r.changes[0]).toMatchObject({
      key: "s1@3",
      id: null,
      kind: "delete",
      start: 3,
      end: 4,
    });
  });

  it("steps through items in document order, wrapping round", () => {
    const items = [
      { storyId: "b", anchor: { start: 1 } },
      { storyId: "a", anchor: { start: 5 } },
      { storyId: "a", anchor: { start: 9 } },
    ];
    const order = ["a", "b"];
    expect(stepTo(items, order, null, 1)).toBe(items[1]!);
    expect(stepTo(items, order, { storyId: "a", offset: 5 }, 1)).toBe(
      items[2]!,
    );
    expect(stepTo(items, order, { storyId: "b", offset: 1 }, 1)).toBe(
      items[1]!,
    );
    expect(stepTo(items, order, { storyId: "a", offset: 5 }, -1)).toBe(
      items[0]!,
    );
    expect(stepTo([], order, null, 1)).toBeNull();
  });

  it("finds the change at the caret, and initials", () => {
    const r = buildReview(CHANGES, [], new Map());
    expect(changeAt(r.changes, { storyId: "s1", start: 8, end: 8 })?.key).toBe(
      "1",
    );
    expect(changeAt(r.changes, { storyId: "s2", start: 8, end: 8 })).toBeNull();
    expect(initialsOf("Author A")).toBe("AA");
  });

  it("the store reads the document's review state", async () => {
    const { host } = fakeHost({
      props: {
        documentTrackChanges: true,
        documentTrackChangesAuthor: "Author A",
        documentMarkupView: "simple",
      },
    });
    const store = createReviewStore(host);
    await store.refresh();
    const s = store.get();
    expect(s.tracking).toBe(true);
    expect(s.author).toBe("Author A");
    expect(s.view).toBe("simple");
    expect(s.changes).toHaveLength(3);
    expect(nextCommentId(s.threads)).toBe("5");
  });
});

describe("the margin band (bandItems)", () => {
  it("All Markup balloons deletions, formatting and comments; Simple only comments", async () => {
    for (const [view, ids] of [
      ["all", ["change:2", "change:3", "comment:0"]],
      ["simple", ["comment:0"]],
      ["none", []],
      ["original", []],
    ] as const) {
      const { host } = fakeHost({ props: { documentMarkupView: view } });
      const store = createReviewStore(host);
      await store.refresh();
      const items = bandItems(store);
      expect(items.map((i) => i.id)).toEqual([...ids]);
      for (const i of items) expect(i.anchor.storyId).toBe("s1");
    }
  });
});

describe("the review commands (review.tsx)", () => {
  const setup = (
    sel: { storyId: string; start: number; end: number } | null,
    props: Record<string, unknown> = {},
  ) => {
    const f = fakeHost({ sel, props });
    const store = createReviewStore(f.host);
    const commands = reviewCommands(f.host, store, {
      docStories: async () => ["s1"],
      now: () => "2026-10-29T12:00:00Z",
    });
    return { ...f, store, commands };
  };

  it("binds Word's keys", () => {
    expect(REVIEW_KEYS).toEqual([
      { key: "cmd+shift+e", command: REVIEW_COMMAND.toggleTrackChanges },
      { key: "cmd+alt+m", command: REVIEW_COMMAND.newComment },
    ]);
  });

  it("Track Changes on names a reviewer in the same step; off is one write", async () => {
    covers("command:media.paged.doc.command.review.toggleTrackChanges");
    const on = setup(null);
    await on.commands.run("toggleTrackChanges");
    expect(on.mutations).toEqual([
      {
        op: "batch",
        args: {
          ops: [
            {
              op: "set",
              args: {
                address: "doc",
                path: "documentTrackChanges",
                value: { type: "bool", value: true },
              },
            },
            {
              op: "set",
              args: {
                address: "doc",
                path: "documentTrackChangesAuthor",
                value: { type: "text", value: "Author" },
              },
            },
          ],
        },
      },
    ]);
    const off = setup(null, {
      documentTrackChanges: true,
      documentTrackChangesAuthor: "Author A",
    });
    await off.commands.run("toggleTrackChanges");
    expect(off.mutations).toEqual([
      {
        op: "set",
        args: {
          address: "doc",
          path: "documentTrackChanges",
          value: { type: "bool", value: false },
        },
      },
    ]);
  });

  it("Accept and Reject take the change at the caret, then move on", async () => {
    covers("command:media.paged.doc.command.review.acceptChange");
    covers("command:media.paged.doc.command.review.rejectChange");
    const c = setup({ storyId: "s1", start: 9, end: 9 });
    await c.store.refresh();
    await c.commands.run("acceptChange");
    expect(c.mutations[0]).toEqual({ op: "acceptChange", args: { id: "1" } });
    expect(c.revealed).toHaveLength(1);
    await c.commands.run("rejectChange", { id: "2" });
    expect(c.mutations[1]).toEqual({ op: "rejectChange", args: { id: "2" } });
  });

  it("Accept All, Reject All and by author", async () => {
    covers("command:media.paged.doc.command.review.acceptAll");
    covers("command:media.paged.doc.command.review.rejectAll");
    const c = setup(null);
    await c.commands.run("acceptAll");
    await c.commands.run("rejectAll", { author: "Author B" });
    expect(c.mutations).toEqual([
      { op: "acceptChange", args: {} },
      { op: "rejectChange", args: { author: "Author B" } },
    ]);
  });

  it("an InDesign deletion resolves by its place", async () => {
    const c = setup(null);
    c.store.get(); // empty until read
    await c.store.refresh();
    // Re-point the first change to an id-less one through the store's
    // lists, as the collection lists ADR 184 deletions.
    const s = c.store.get();
    (s.changes[0] as { id: string | null }).id = null;
    await c.commands.run("acceptChange", { id: "1" });
    expect(c.mutations[0]).toEqual({
      op: "acceptTrackedChange",
      args: { storyId: "s1", offset: 6 },
    });
  });

  it("New Comment at a caret comments the word, with the next id", async () => {
    covers("command:media.paged.doc.command.review.newComment");
    const c = setup(
      { storyId: "s1", start: 9, end: 9 },
      {
        documentTrackChangesAuthor: "Author A",
      },
    );
    const out = await c.commands.run("newComment", { text: "Why?" });
    expect(out).toEqual({ applied: true, id: "5" });
    expect(c.mutations[0]).toEqual({
      op: "insertComment",
      args: {
        storyId: "s1",
        start: 6,
        end: 12,
        comment: {
          id: "5",
          author: "Author A",
          initials: "AA",
          date: "2026-10-29T12:00:00Z",
          text: "Why?",
        },
      },
    });
    // Without text the balloon opens for typing.
    await c.commands.run("newComment");
    expect(c.store.get().editing).toBe("5");
    // Without a selection there is nothing to comment.
    const none = setup(null);
    const refused = await none.commands.run("newComment");
    expect(refused.applied).toBe(false);
    expect(none.mutations).toEqual([]);
  });

  it("Reply, Resolve, Delete and the markup views", async () => {
    covers("command:media.paged.doc.command.review.replyComment");
    covers("command:media.paged.doc.command.review.resolveComment");
    covers("command:media.paged.doc.command.review.deleteComment");
    covers("command:media.paged.doc.command.review.markupOriginal");
    const c = setup(null);
    await c.commands.run("replyComment", { id: "0", text: "Agreed" });
    await c.commands.run("resolveComment", { id: "0" });
    await c.commands.run("resolveComment", { id: "0", resolved: false });
    await c.commands.run("deleteComment", { id: "0" });
    await c.commands.run("markupOriginal");
    expect(c.mutations).toEqual([
      {
        op: "replyComment",
        args: {
          parentId: "0",
          comment: {
            id: "5",
            author: "Author",
            initials: "A",
            date: "2026-10-29T12:00:00Z",
            text: "Agreed",
          },
        },
      },
      { op: "resolveComment", args: { commentId: "0", resolved: true } },
      { op: "resolveComment", args: { commentId: "0", resolved: false } },
      { op: "deleteComment", args: { commentId: "0" } },
      {
        op: "set",
        args: {
          address: "doc",
          path: "documentMarkupView",
          value: { type: "text", value: "original" },
        },
      },
    ]);
  });

  it("the other markup views, Previous Change, Next Comment and the panel", async () => {
    covers("command:media.paged.doc.command.review.markupSimple");
    covers("command:media.paged.doc.command.review.markupAll");
    covers("command:media.paged.doc.command.review.markupNone");
    covers("command:media.paged.doc.command.review.previousChange");
    covers("command:media.paged.doc.command.review.nextComment");
    covers("command:media.paged.doc.command.review.showReview");
    const c = setup({ storyId: "s1", start: 9, end: 9 });
    await c.commands.run("markupSimple");
    await c.commands.run("markupAll");
    await c.commands.run("markupNone");
    expect(
      c.mutations.map(
        (m) => (m.args as { value: { value: unknown } }).value.value,
      ),
    ).toEqual(["simple", "all", "none"]);
    // The change starting before the caret: the insertion it stands in.
    expect((await c.commands.run("previousChange")).id).toBe("1");
    expect(c.revealed[0]).toEqual([
      { storyId: "s1", start: 8, end: 15 },
      { select: true },
    ]);
    expect((await c.commands.run("nextComment")).id).toBe("0");
    expect((await c.commands.run("showReview")).applied).toBe(true);
  });

  it("Next and Previous reveal and select the change", async () => {
    covers("command:media.paged.doc.command.review.nextChange");
    covers("command:media.paged.doc.command.review.previousComment");
    const c = setup({ storyId: "s1", start: 0, end: 0 });
    await c.commands.run("nextChange");
    expect(c.revealed[0]).toEqual([
      { storyId: "s1", start: 8, end: 15 },
      { select: true },
    ]);
    await c.commands.run("previousComment");
    expect(c.revealed[1]).toEqual([
      { storyId: "s1", start: 23, end: 28 },
      { select: true },
    ]);
  });
});
