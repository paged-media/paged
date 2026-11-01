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

// The COMMENTS door (`comments@1`, extensions ADR 1101): the document's
// comment threads (engine ADR 1055) as typed rows and six writes, and the
// `contribute.commentAnchor` contribution a module uses to tell the host
// where an address it owns points. Type-only, like the rest of plugin-api.
//
// A thread is a root comment with its replies, attached to ONE anchor:
//   · `item`   a shape, frame or group, optionally a point in it;
//   · `page`   a point on a page or slide;
//   · `region` a rectangle in an item;
//   · `cell`   an opaque address that the item's owning module resolves
//              (sheet: `B7`; slide: `shape:12`);
//   · `text`   a range of a story (read-only here: the text editor starts
//              those, they follow their text through edits).
//
// The door is backed by the document door: reads need
// `capabilities.document.read`, writes `capabilities.document.write` and
// go through the one write door, so they undo with the document. Without the
// write capability a write answers `{ ok: false, reason }`; it never throws
// for a refusal.

import type { Disposable } from "./host.js";
import type { CommentAnchorSpec } from "./wire.js";

/** Where a thread can be started: the four document anchors. */
export type CommentAnchor = CommentAnchorSpec;

/** A thread on a range of text; listed, never started through this door. */
export interface CommentTextAnchor {
  kind: "text";
  /** The story. */
  story: string;
  /** The range in story characters; absent when the commented text is gone. */
  start?: number;
  end?: number;
}

/** One comment of a thread. */
export interface CommentRow {
  id: string;
  /** The thread it belongs to (the root comment's id). */
  threadId: string;
  /** The root comment's id for a reply, null for the root. */
  parentId: string | null;
  /** The author's display name, when the comment has one. */
  author: string | null;
  /** The author's id in the document's people list. */
  person: string | null;
  /** Paragraphs separated by `\n`. */
  text: string;
  /** Created, ISO 8601. */
  date: string | null;
  /** Last edited, ISO 8601. */
  modified: string | null;
}

/** A thread: the root comment first, then its replies, oldest first. */
export interface CommentThread {
  id: string;
  /** `"comment"` (threaded) or `"note"` (one annotation, no replies). */
  kind: "comment" | "note";
  anchor: CommentAnchor | CommentTextAnchor;
  resolved: boolean;
  /** True while the anchor's target is gone and the thread waits to be
   *  re-anchored or deleted. */
  orphaned: boolean;
  /** The page the thread is on and the point of it, in points from the
   *  page's top-left, as the engine resolved the anchor; null when none. */
  page: string | null;
  at: [number, number] | null;
  comments: CommentRow[];
}

/** What `list` keeps: every given field must match. */
export interface CommentFilter {
  page?: string;
  /** Threads anchored to this item (`item`, `region` and `cell` anchors). */
  item?: string;
  anchorKind?: CommentThread["anchor"]["kind"];
  resolved?: boolean;
  orphaned?: boolean;
}

/** Who writes a comment. The person is entered in the document's people list
 *  (by `id`) before the comment. Absent: the engine's default author. */
export interface CommentAuthor {
  id?: string;
  name: string;
  initials?: string;
}

/** The answer of every write: the ids it made, or why it did not apply. */
export type CommentWriteResult<T = object> =
  ({ ok: true } & T) | { ok: false; reason: string };

/** The comments door (`host.comments`, `supports("comments@1")`). */
export interface CommentsSurface {
  /** Every thread, oldest first, that matches `filter`. Reads the
   *  `comments` collection; needs `capabilities.document.read`. */
  list(filter?: CommentFilter): Promise<readonly CommentThread[]>;
  /** One thread by its id, or null when there is none. */
  get(threadId: string): Promise<CommentThread | null>;
  /** `listener` runs after a committed document change that altered the
   *  comments (a write here, the host panel, an undo, a load); it re-reads
   *  with `list`. */
  onDidChange(listener: () => void): Disposable;
  /** Start a thread on `anchor` with `text`. */
  startThread(
    anchor: CommentAnchor,
    text: string,
    author?: CommentAuthor,
  ): Promise<CommentWriteResult<{ threadId: string; commentId: string }>>;
  /** Add a reply; `id` is a thread id or any comment id of the thread. */
  reply(
    id: string,
    text: string,
    author?: CommentAuthor,
  ): Promise<CommentWriteResult<{ commentId: string }>>;
  /** Replace a comment's text; the modification time is set. */
  edit(commentId: string, text: string): Promise<CommentWriteResult>;
  /** Resolve or reopen; `id` is a thread id or a comment id. */
  resolve(id: string, resolved: boolean): Promise<CommentWriteResult>;
  /** Delete a comment; deleting a thread's root deletes the thread. */
  remove(commentId: string): Promise<CommentWriteResult>;
}

/** Where a `cell` anchor points, in the item's own space. */
export interface CommentAnchorGeometry {
  /** `[x, y, width, height]` in points from the item's top-left. The host
   *  pins the thread at its top-left corner and may outline the rest. */
  rect?: [number, number, number, number];
  /** What to show for the address (sheet: `Sheet1!B7`); the raw address
   *  when absent. */
  label?: string;
}

/** `contribute.commentAnchor`: the module that owns an address space says
 *  where an address of it points. Probe `supports("contribute.commentAnchor@1")`:
 *  without a host that reads it the call is a no-op and the pin stays at the
 *  item's top-left. */
export interface CommentAnchorContribution {
  /** Namespaced, like every contribution id. */
  id: string;
  kind: "cell";
  /** The geometry of `address` in `item`, or null when it is not an
   *  address of this module (the next resolver is asked). */
  resolve(address: string, item: string): CommentAnchorGeometry | null;
}
