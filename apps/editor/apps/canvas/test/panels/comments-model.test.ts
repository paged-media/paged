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

// The Comments panel's model (engine ADR 1055): threads grouped from the
// engine's `comments` collection, filtered, labelled; the mutations it sends.

import { describe, expect, test } from "bun:test";
import type { CommentSummary } from "@paged-media/client";
import { covers } from "@paged-media/test-kit";

import {
  anchorDetail,
  deleteFor,
  deleteMutation,
  editFor,
  editMutation,
  isStoryNote,
  filterThreads,
  groupThreads,
  initialsOf,
  itemCommentMutation,
  pageCommentMutation,
  newTargetOf,
  replyMutation,
  resolveMutation,
  textCommentMutation,
  whereOf,
} from "../../src/panels/comments-model";

const row = (over: Partial<CommentSummary>): CommentSummary =>
  ({
    id: "1",
    storyId: "",
    anchorText: "",
    text: "t",
    resolved: false,
    ...over,
  }) as CommentSummary;

const rows: CommentSummary[] = [
  row({ id: "1", storyId: "u9", anchorText: "beta", author: "Ann Author" }),
  row({ id: "2", storyId: "u9", parentId: "1", author: "Bob" }),
  row({
    id: "t1",
    threadId: "t1",
    anchor: { kind: "item", item: "u3", at: null },
    resolved: true,
  } as never),
  row({
    id: "t2",
    threadId: "t2",
    anchor: { kind: "cell", item: "s1", address: "Sheet1!B3" },
  } as never),
  row({ id: "t3", threadId: "t3", orphaned: true } as never),
  row({ id: "t1.1", threadId: "t1", parentId: "t1", resolved: true } as never),
];

const now = () => "2026-11-01T10:00:00Z";

describe("Comments panel model", () => {
  test("groups roots with their replies, in the engine's order", () => {
    covers("panel:paged.comments");
    const ts = groupThreads(rows);
    expect(ts.map((t) => [t.id, t.replies.map((r) => r.id)])).toEqual([
      ["1", ["2"]],
      ["t1", ["t1.1"]],
      ["t2", []],
      ["t3", []],
    ]);
    // A reply whose root is gone appears nowhere.
    expect(groupThreads([row({ id: "9", parentId: "missing" })])).toEqual([]);
  });

  test("names what a thread is attached to", () => {
    covers("panel:paged.comments");
    expect(groupThreads(rows).map((t) => t.where)).toEqual([
      "text",
      "item",
      "cell",
      "orphaned",
    ]);
    expect(
      whereOf(
        row({ anchor: { kind: "page", page: "p", at: [1, 2] } } as never),
      ),
    ).toBe("page");
    expect(
      whereOf(
        row({
          anchor: { kind: "region", item: "i", rect: [0, 0, 1, 1] },
        } as never),
      ),
    ).toBe("region");
    const [text, , cell] = groupThreads(rows);
    expect(anchorDetail(text!)).toBe("beta");
    expect(anchorDetail(cell!)).toBe("Sheet1!B3");
  });

  test("filters open and resolved threads", () => {
    covers("panel:paged.comments");
    const ts = groupThreads(rows);
    expect(filterThreads(ts, "all")).toHaveLength(4);
    expect(filterThreads(ts, "open").map((t) => t.id)).toEqual([
      "1",
      "t2",
      "t3",
    ]);
    expect(filterThreads(ts, "resolved").map((t) => t.id)).toEqual(["t1"]);
  });

  test("initials: the comment's own, else the first letters of the name", () => {
    covers("panel:paged.comments");
    expect(initialsOf({ author: "Ann Author", initials: "AA" })).toBe("AA");
    expect(initialsOf({ author: "ann b. author" })).toBe("AB");
    expect(initialsOf({ author: "Bob" })).toBe("B");
    expect(initialsOf({})).toBe("?");
  });

  test("the mutations are the wire's", () => {
    covers("panel:paged.comments");
    const me = { name: "Ann Author" };
    expect(replyMutation("1", "ok", me, now)).toEqual({
      op: "replyComment",
      args: {
        parentId: "1",
        comment: {
          author: "Ann Author",
          initials: "AA",
          date: "2026-11-01T10:00:00Z",
          text: "ok",
        },
      },
    });
    expect(resolveMutation("1", true)).toEqual({
      op: "resolveComment",
      args: { commentId: "1", resolved: true },
    });
    expect(editMutation("1", "new", now).args).toEqual({
      commentId: "1",
      text: "new",
      date: "2026-11-01T10:00:00Z",
    });
    expect(deleteMutation("1")).toEqual({
      op: "deleteComment",
      args: { commentId: "1" },
    });
    expect(textCommentMutation("u9", 2, 6, "why", me, now).args).toMatchObject({
      storyId: "u9",
      start: 2,
      end: 6,
    });
    expect(itemCommentMutation("u3", "check", me, now)).toMatchObject({
      op: "insertCommentThread",
      args: { anchor: { kind: "item", item: "u3" } },
    });
  });

  test("a new comment attaches to a text range, else to one selected item", () => {
    covers("panel:paged.comments");
    expect(
      newTargetOf({ storyId: "u9", start: 2, end: 6 }, [{ id: "u3" }]),
    ).toEqual({
      kind: "text",
      storyId: "u9",
      start: 2,
      end: 6,
    });
    // A caret is not a range.
    expect(
      newTargetOf({ storyId: "u9", start: 2, end: 2 }, [{ id: "u3" }]),
    ).toEqual({
      kind: "item",
      item: "u3",
    });
    expect(newTargetOf(null, [{ id: "a" }, { id: "b" }])).toBeNull();
    expect(newTargetOf(null, [])).toBeNull();
  });

  test("an InDesign note is edited and removed with the note operations", () => {
    covers("panel:paged.comments");
    const note = row({
      id: "n1",
      storyId: "u9",
      threadKind: "note",
    } as never);
    const docNote = row({
      id: "t9",
      threadId: "t9",
      threadKind: "note",
    } as never);
    expect(isStoryNote(note)).toBe(true);
    // A document thread of kind note is a thread: the comment operations.
    expect(isStoryNote(docNote)).toBe(false);
    expect(isStoryNote(row({ id: "1", storyId: "u9" }))).toBe(false);
    expect(editFor(note, "new", now)).toEqual({
      op: "editNote",
      args: { noteId: "n1", text: "new", date: "2026-11-01T10:00:00Z" },
    });
    expect(deleteFor(note)).toEqual({
      op: "deleteNote",
      args: { noteId: "n1" },
    });
    expect(editFor(docNote, "new", now)).toEqual(
      editMutation("t9", "new", now),
    );
    expect(deleteFor(docNote)).toEqual(deleteMutation("t9"));
  });

  test("with nothing selected a new comment attaches to the active page", () => {
    covers("panel:paged.comments");
    expect(newTargetOf(null, [], "p3")).toEqual({ kind: "page", page: "p3" });
    // A selection wins over the page, and two items are not one target.
    expect(newTargetOf(null, [{ id: "a" }], "p3")).toEqual({
      kind: "item",
      item: "a",
    });
    expect(newTargetOf(null, [{ id: "a" }, { id: "b" }], "p3")).toBeNull();
    expect(newTargetOf(null, [], null)).toBeNull();
    const me = { name: "Ann Author" };
    expect(pageCommentMutation("p3", "check", me, now)).toMatchObject({
      op: "insertCommentThread",
      args: { anchor: { kind: "page", page: "p3", at: [16, 24] } },
    });
  });
});
