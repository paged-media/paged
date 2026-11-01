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

// The Comments panel's model (engine ADR 1055): the engine's `comments`
// collection grouped into threads, filtered, labelled, and the mutations the
// panel sends. Pure: no engine, no React.

import type { CommentSummary } from "@paged-media/client";

/** Which threads the panel lists. */
export type ThreadFilter = "all" | "open" | "resolved";

/** What a thread is attached to. */
export type ThreadWhere =
  "text" | "item" | "page" | "region" | "cell" | "orphaned";

/** A conversation: its root comment and the replies, in order. */
export interface Thread {
  /** The root comment's id (a document thread's id is the same). */
  id: string;
  root: CommentSummary;
  replies: CommentSummary[];
  resolved: boolean;
  where: ThreadWhere;
}

/** What a thread is attached to. */
export function whereOf(root: CommentSummary): ThreadWhere {
  if (root.orphaned) return "orphaned";
  switch (root.anchor?.kind) {
    case "item":
      return "item";
    case "page":
      return "page";
    case "region":
      return "region";
    case "cell":
      return "cell";
    default:
      return "text";
  }
}

/** The threads of a comments collection, roots in the order the engine
 *  lists them (text comments first, then document threads), each with its
 *  replies. A reply whose root is missing is dropped. */
export function groupThreads(rows: readonly CommentSummary[]): Thread[] {
  const replies = new Map<string, CommentSummary[]>();
  for (const r of rows) {
    if (!r.parentId) continue;
    const list = replies.get(r.parentId) ?? [];
    list.push(r);
    replies.set(r.parentId, list);
  }
  return rows
    .filter((r) => !r.parentId)
    .map((root) => ({
      id: root.id,
      root,
      replies: replies.get(root.id) ?? [],
      resolved: root.resolved,
      where: whereOf(root),
    }));
}

/** The threads a filter keeps. */
export function filterThreads(
  threads: readonly Thread[],
  filter: ThreadFilter,
): Thread[] {
  if (filter === "all") return [...threads];
  return threads.filter((t) => t.resolved === (filter === "resolved"));
}

/** The text a thread is attached to or the address it names, for a short
 *  second line; `null` when there is nothing to say beyond the kind. */
export function anchorDetail(t: Thread): string | null {
  const a = t.root.anchor;
  if (t.where === "text") return t.root.anchorText || null;
  if (a?.kind === "cell") return a.address;
  return null;
}

/** Up to two upper-case initials of a name; the comment's own when it has them. */
export function initialsOf(c: Pick<CommentSummary, "author" | "initials">) {
  if (c.initials) return c.initials;
  const words = (c.author ?? "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** Who the panel comments as. */
export interface Reviewer {
  name: string;
}

const stamp = (reviewer: Reviewer, text: string, now: () => string) => ({
  author: reviewer.name,
  initials: initialsOf({ author: reviewer.name }),
  date: now(),
  text,
});

/** A reply to `parentId` (a root or a reply: the engine joins the thread). */
export const replyMutation = (
  parentId: string,
  text: string,
  reviewer: Reviewer,
  now: () => string,
) => ({
  op: "replyComment",
  args: { parentId, comment: stamp(reviewer, text, now) },
});

/** An InDesign note of a story: a single annotation at a point of the text,
 *  with no thread, no replies and no resolved state (engine ADR 172). It is
 *  edited and removed with the note operations, not the comment ones. */
export function isStoryNote(
  c: Pick<CommentSummary, "threadKind" | "threadId" | "storyId">,
): boolean {
  return c.threadKind === "note" && !c.threadId && !!c.storyId;
}

/** The edit of a comment, or of a story note. */
export const editFor = (
  c: Pick<CommentSummary, "id" | "threadKind" | "threadId" | "storyId">,
  text: string,
  now: () => string,
) =>
  isStoryNote(c)
    ? { op: "editNote", args: { noteId: c.id, text, date: now() } }
    : editMutation(c.id, text, now);

/** The removal of a comment, or of a story note. */
export const deleteFor = (
  c: Pick<CommentSummary, "id" | "threadKind" | "threadId" | "storyId">,
) =>
  isStoryNote(c)
    ? { op: "deleteNote", args: { noteId: c.id } }
    : deleteMutation(c.id);

export const resolveMutation = (commentId: string, resolved: boolean) => ({
  op: "resolveComment",
  args: { commentId, resolved },
});

export const editMutation = (
  commentId: string,
  text: string,
  now: () => string,
) => ({
  op: "editComment",
  args: { commentId, text, date: now() },
});

export const deleteMutation = (commentId: string) => ({
  op: "deleteComment",
  args: { commentId },
});

/** A new comment on a text range of a story. */
export const textCommentMutation = (
  storyId: string,
  start: number,
  end: number,
  text: string,
  reviewer: Reviewer,
  now: () => string,
) => ({
  op: "insertComment",
  args: {
    storyId,
    start,
    end,
    comment: stamp(reviewer, text, now),
  },
});

/** A new comment thread on a page item. */
export const itemCommentMutation = (
  item: string,
  text: string,
  reviewer: Reviewer,
  now: () => string,
) => ({
  op: "insertCommentThread",
  args: {
    anchor: { kind: "item", item },
    comment: stamp(reviewer, text, now),
  },
});

/** What a new comment would attach to, from the current selection: a
 *  non-empty text range wins, then a single selected item. */
export type NewTarget =
  | { kind: "text"; storyId: string; start: number; end: number }
  | { kind: "item"; item: string }
  | null;

export function newTargetOf(
  content: { storyId: string; start: number; end: number } | null,
  elements: readonly { kind?: string; id?: string }[],
): NewTarget {
  if (content && content.end > content.start) {
    return {
      kind: "text",
      storyId: content.storyId,
      start: content.start,
      end: content.end,
    };
  }
  const only = elements.length === 1 ? elements[0] : undefined;
  if (only?.id) return { kind: "item", item: only.id };
  return null;
}
