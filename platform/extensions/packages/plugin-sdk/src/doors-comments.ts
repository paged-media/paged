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

// The COMMENTS door (`comments@1`, extensions ADR 1101) and the comment
// anchor registry behind `contribute.commentAnchor`.
//
// The door adds no engine operation: it reads the `comments` collection and
// writes engine ADR 1055's comment mutations through `host.document`, so the
// document door's capability gate, undo steps and change events apply as they
// do to a raw mutation. The anchor registry is a SHARED backend the editor
// builds once and injects into every `createBundleHost` (`options.commentAnchors`),
// the shape of the data registry; a host panel asks it where a `cell` anchor
// points.

import type {
  CommentAnchor,
  CommentAnchorContribution,
  CommentAnchorGeometry,
  CommentAuthor,
  CommentFilter,
  CommentRow,
  CommentSummary,
  CommentsSurface,
  CommentThread,
  CommentWriteResult,
  Disposable,
  DocumentSurface,
  MutationOutcome,
} from "@paged-media/plugin-api";

import { toDisposable } from "./disposables.js";

// --------------------------------------------------------- anchor registry

/** The shared registry of `cell` anchor resolvers. */
export interface CommentAnchorBackend {
  register(owner: string, contribution: CommentAnchorContribution): Disposable;
  /** Where `address` of `item` points: the first resolver that knows it
   *  answers; null when none does. */
  resolve(item: string, address: string): CommentAnchorGeometry | null;
  /** Fires when a resolver is added or removed (pins are placed again). */
  onDidChange(listener: () => void): Disposable;
}

/** Build the shared anchor registry. */
export function createCommentAnchorRegistry(): CommentAnchorBackend {
  const entries = new Set<{ owner: string; c: CommentAnchorContribution }>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const l of [...listeners]) l();
  };
  return {
    register(owner, c) {
      const entry = { owner, c };
      entries.add(entry);
      changed();
      return toDisposable(() => {
        if (entries.delete(entry)) changed();
      });
    },
    resolve(item, address) {
      for (const { c } of [...entries]) {
        if (c.kind !== "cell") continue;
        try {
          const g = c.resolve(address, item);
          if (g) return g;
        } catch {
          // A resolver that throws does not take the pin down with it.
        }
      }
      return null;
    },
    onDidChange(listener) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  };
}

// ----------------------------------------------------------------- the rows

const NO_ID = (id: string) => `no comment or thread "${id}"`;

/** The engine's rows as threads, oldest first. A row with a story and no
 *  thread id is a comment on a text range; its thread is its root's id. */
export function threadsOf(rows: readonly CommentSummary[]): CommentThread[] {
  const byThread = new Map<string, CommentSummary[]>();
  for (const r of rows) {
    const tid = r.threadId ?? r.parentId ?? r.id;
    const list = byThread.get(tid);
    if (list) list.push(r);
    else byThread.set(tid, [r]);
  }
  const out: CommentThread[] = [];
  for (const [id, list] of byThread) {
    const root = list.find((r) => !r.parentId) ?? list[0]!;
    const anchor: CommentThread["anchor"] =
      root.anchor ??
      ({
        kind: "text",
        story: root.storyId,
        ...(root.start !== undefined ? { start: root.start } : {}),
        ...(root.end !== undefined ? { end: root.end } : {}),
      } as const);
    const comments: CommentRow[] = [
      root,
      ...list.filter((r) => r !== root),
    ].map((r) => ({
      id: r.id,
      threadId: id,
      parentId: r === root ? null : (r.parentId ?? id),
      author: r.author ?? null,
      person: r.person ?? null,
      text: r.text,
      date: r.date ?? null,
      modified: r.modified ?? null,
    }));
    out.push({
      id,
      kind: root.threadKind === "note" ? "note" : "comment",
      anchor,
      resolved: root.resolved,
      orphaned: root.orphaned === true,
      page: root.page ?? null,
      at: root.at ?? null,
      comments,
    });
  }
  return out;
}

const itemOf = (a: CommentThread["anchor"]): string | undefined =>
  "item" in a ? a.item : undefined;

function matches(t: CommentThread, f: CommentFilter | undefined): boolean {
  if (!f) return true;
  if (f.page !== undefined && t.page !== f.page) return false;
  if (f.item !== undefined && itemOf(t.anchor) !== f.item) return false;
  if (f.anchorKind !== undefined && t.anchor.kind !== f.anchorKind)
    return false;
  if (f.resolved !== undefined && t.resolved !== f.resolved) return false;
  if (f.orphaned !== undefined && t.orphaned !== f.orphaned) return false;
  return true;
}

// ------------------------------------------------------------- the surface

let seq = 0;
const newId = (): string => {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${(seq++).toString(36)}`;
  return `comment-${uuid}`;
};

type Op = { op: string; args: Record<string, unknown> };

const refused = (outcome: MutationOutcome): { ok: false; reason: string } => ({
  ok: false,
  reason:
    "error" in outcome && outcome.error
      ? outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error)
      : "the document refused the comment change",
});

/** The comments surface of one bundle, over its document surface. */
export function createCommentsSurface(
  document: DocumentSurface,
  track: (d: Disposable) => Disposable,
): CommentsSurface {
  const rows = () => document.collection<CommentSummary>("comments");
  const list = async (filter?: CommentFilter) =>
    threadsOf(await rows()).filter((t) => matches(t, filter));

  const write = async (
    ops: Op[],
    label: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const outcome = await document.mutate(
      (ops.length === 1 ? ops[0] : { op: "batch", args: { ops } }) as never,
      { label },
    );
    return outcome.applied ? { ok: true } : refused(outcome);
  };

  const personOps = (a: CommentAuthor | undefined): Op[] =>
    a?.id
      ? [
          {
            op: "setPerson",
            args: {
              person: { id: a.id, name: a.name, initials: a.initials ?? null },
            },
          },
        ]
      : [];
  const spec = (text: string, a: CommentAuthor | undefined, id?: string) => ({
    ...(id ? { id } : {}),
    text,
    date: new Date().toISOString(),
    ...(a ? { author: a.name, initials: a.initials ?? null } : {}),
    ...(a?.id ? { person: a.id } : {}),
  });

  /** The thread `id` names (a thread id or one of its comments' ids). */
  const find = async (id: string) =>
    (await list()).find(
      (t) => t.id === id || t.comments.some((c) => c.id === id),
    );

  return {
    list,
    async get(threadId) {
      return (await list()).find((t) => t.id === threadId) ?? null;
    },
    onDidChange(listener) {
      // A committed document change that altered the comments: compared
      // against the last read, so a stroke or a style edit stays silent.
      let last: string | undefined;
      let open = true;
      const read = async () => {
        try {
          return JSON.stringify(await list());
        } catch {
          return undefined;
        }
      };
      void read().then((s) => {
        if (last === undefined) last = s;
      });
      const sub = document.onDidChange(() => {
        void read().then((s) => {
          if (!open || s === undefined || s === last) return;
          const first = last === undefined;
          last = s;
          if (!first) listener();
        });
      });
      return track(
        toDisposable(() => {
          open = false;
          sub.dispose();
        }),
      );
    },
    async startThread(anchor: CommentAnchor, text, author) {
      if (text.trim() === "")
        return { ok: false, reason: "a comment needs text" };
      const commentId = newId();
      const done = await write(
        [
          ...personOps(author),
          {
            op: "insertCommentThread",
            args: { anchor, comment: spec(text, author, commentId) },
          },
        ],
        "Add comment",
      );
      if (!done.ok) return done;
      const t = await find(commentId);
      return { ok: true, threadId: t?.id ?? commentId, commentId };
    },
    async reply(id, text, author) {
      if (text.trim() === "")
        return { ok: false, reason: "a comment needs text" };
      const t = await find(id);
      if (!t) return { ok: false, reason: NO_ID(id) };
      const commentId = newId();
      const done = await write(
        [
          ...personOps(author),
          {
            op: "replyComment",
            args: {
              parentId: t.comments[0]!.id,
              comment: spec(text, author, commentId),
            },
          },
        ],
        "Reply to comment",
      );
      return done.ok ? { ok: true, commentId } : done;
    },
    async edit(commentId, text) {
      if (text.trim() === "")
        return { ok: false, reason: "a comment needs text" };
      return write(
        [
          {
            op: "editComment",
            args: { commentId, text, date: new Date().toISOString() },
          },
        ],
        "Edit comment",
      );
    },
    async resolve(id, resolved) {
      const t = await find(id);
      if (!t) return { ok: false, reason: NO_ID(id) };
      const own = t.comments.find((c) => c.id === id);
      return write(
        [
          {
            op: "resolveComment",
            args: { commentId: own?.id ?? t.comments[0]!.id, resolved },
          },
        ],
        resolved ? "Resolve comment" : "Reopen comment",
      );
    },
    async remove(commentId) {
      return write(
        [{ op: "deleteComment", args: { commentId } }],
        "Delete comment",
      );
    },
  };
}

export type { CommentWriteResult };
