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

// Comments (paged.comments), engine ADR 1055: every comment thread of the
// document, whatever it is attached to (a text range, a page item, a page
// point, a region, a cell), with reply, resolve, edit and delete; and a new
// comment on the current selection. One panel for every module's edit
// context: the modules supply anchors, never panels.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { CommentSummary } from "@paged-media/client";
import {
  CockpitPanelHeader,
  ComingSoon,
  focusThread,
  getFocusedThread,
  subscribeFocusedThread,
  useCanvasClient,
  useCollection,
  useContentSelection,
  useDocumentMeta,
  useEditorScope,
  selectedCommentAddress,
  useSelection,
} from "@paged-media/shell";
import { defineMessages, useStrings } from "@paged-media/strings";

import {
  anchorDetail,
  cellCommentMutation,
  deleteFor,
  editFor,
  isStoryNote,
  filterThreads,
  groupThreads,
  initialsOf,
  itemCommentMutation,
  newTargetOf,
  pageCommentMutation,
  replyMutation,
  resolveMutation,
  textCommentMutation,
  type Reviewer,
  type Thread,
  type ThreadFilter,
} from "./comments-model";

const M = defineMessages("app.commentsPanel", {
  title: "Comments",
  loading: "Loading comments…",
  empty: "No comments yet",
  emptyBody:
    "Select text or an object and add a comment. Threads from Word, Excel, PowerPoint, InDesign and PDF files appear here.",
  noneMatch: "No comments match this filter.",
  filterAll: "All",
  filterOpen: "Open",
  filterResolved: "Resolved",
  as: "Comment as",
  newPlaceholder: "Add a comment…",
  add: "Comment",
  needsTarget: "Select text or one object to comment on.",
  reply: "Reply",
  replyPlaceholder: "Reply…",
  resolve: "Resolve",
  reopen: "Reopen",
  edit: "Edit",
  save: "Save",
  cancel: "Cancel",
  remove: "Delete",
  whereItem: "On an object",
  wherePage: "On a page",
  whereRegion: "On a region",
  whereCell: "At {address}",
  whereOrphaned: "Its target was deleted",
  whereText: "On “{text}”",
  note: "Note",
  defaultAuthor: "Reviewer",
});

const AUTHOR_KEY = "paged.comments.author";

/** The remembered name, or `fallback` (storage can be absent or refuse). */
function readAuthor(fallback: string): string {
  try {
    return globalThis.localStorage?.getItem(AUTHOR_KEY) || fallback;
  } catch {
    return fallback;
  }
}

function writeAuthor(name: string): void {
  try {
    globalThis.localStorage?.setItem(AUTHOR_KEY, name);
  } catch {
    // The name still works for this session.
  }
}

/** The name the panel comments as, remembered in this browser. */
function useReviewer(fallback: string): [Reviewer, (name: string) => void] {
  const [name, setName] = useState(() => readAuthor(fallback));
  const set = (next: string) => {
    setName(next);
    writeAuthor(next);
  };
  return [{ name }, set];
}

const now = () => new Date().toISOString();

export function CommentsPanel() {
  const strings = useStrings();
  const client = useCanvasClient();
  const rows = useCollection<CommentSummary>("comments");
  const { elementSelection } = useSelection();
  const { contentSelection } = useContentSelection();
  const meta = useDocumentMeta();
  const scope = useEditorScope();
  // The thread a canvas pin (or a click here) points at.
  const focused = useSyncExternalStore(
    (l) => subscribeFocusedThread(scope, l),
    () => getFocusedThread(scope),
    () => null,
  );
  const [filter, setFilter] = useState<ThreadFilter>("all");
  const [draft, setDraft] = useState("");
  const [reviewer, setReviewer] = useReviewer(strings.t(M.defaultAuthor));

  if (rows === null) {
    return (
      <div
        className="p-3 text-xs text-muted-foreground"
        data-comments-panel="loading"
      >
        {strings.t(M.loading)}
      </div>
    );
  }

  const write = (mutation: unknown) =>
    client.mutate(mutation as never).catch(() => null);

  const threads = groupThreads(rows);
  const shown = filterThreads(threads, filter);
  const target = newTargetOf(
    contentSelection,
    elementSelection as readonly { kind?: string; id?: string }[],
    meta?.activePage ?? null,
  );
  const canAdd = target !== null && draft.trim() !== "";

  const add = () => {
    if (!target || draft.trim() === "") return;
    const text = draft.trim();
    // The cell is read now: a sheet's active cell moves without a render.
    const at = newTargetOf(
      contentSelection,
      elementSelection as readonly { kind?: string; id?: string }[],
      meta?.activePage ?? null,
      selectedCommentAddress,
    );
    if (!at) return;
    void write(
      at.kind === "cell"
        ? cellCommentMutation(at.item, at.address, text, reviewer, now)
        : at.kind === "text"
          ? textCommentMutation(
              at.storyId,
              at.start,
              at.end,
              text,
              reviewer,
              now,
            )
          : at.kind === "page"
            ? pageCommentMutation(at.page, text, reviewer, now)
            : itemCommentMutation(at.item, text, reviewer, now),
    );
    setDraft("");
  };

  return (
    <div
      className="flex h-full flex-col overflow-y-auto"
      data-comments-panel="ready"
    >
      <CockpitPanelHeader title={strings.t(M.title)} />

      <div className="flex flex-col gap-2 border-b border-border p-2">
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          {strings.t(M.as)}
          <input
            className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-foreground"
            data-comments-author
            value={reviewer.name}
            onChange={(e) => setReviewer(e.currentTarget.value)}
          />
        </label>
        <textarea
          className="min-h-12 rounded border border-border bg-background p-1 text-xs"
          data-new-comment-input
          placeholder={strings.t(M.newPlaceholder)}
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground" data-new-comment-hint>
            {target ? "" : strings.t(M.needsTarget)}
          </span>
          <button
            type="button"
            className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground disabled:opacity-50"
            data-new-comment-add
            disabled={!canAdd}
            onClick={add}
          >
            {strings.t(M.add)}
          </button>
        </div>
        <div className="flex gap-1" role="group" data-comments-filter>
          {(
            [
              ["all", M.filterAll],
              ["open", M.filterOpen],
              ["resolved", M.filterResolved],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="rounded border border-border px-2 py-0.5 text-xs aria-pressed:bg-accent"
              aria-pressed={filter === value}
              data-filter={value}
              onClick={() => setFilter(value)}
            >
              {strings.t(label)}
            </button>
          ))}
        </div>
      </div>

      {threads.length === 0 ? (
        <ComingSoon icon="ui-comment" title={strings.t(M.empty)}>
          {strings.t(M.emptyBody)}
        </ComingSoon>
      ) : shown.length === 0 ? (
        <div className="p-3 text-xs text-muted-foreground" data-no-match>
          {strings.t(M.noneMatch)}
        </div>
      ) : (
        <div className="flex flex-col" data-thread-list>
          {shown.map((t) => (
            <ThreadCard
              key={t.id}
              thread={t}
              reviewer={reviewer}
              write={write}
              focused={focused === t.id}
              onFocus={() => focusThread(scope, t.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ThreadCard({
  thread,
  reviewer,
  write,
  focused,
  onFocus,
}: {
  thread: Thread;
  reviewer: Reviewer;
  write: (mutation: unknown) => Promise<unknown>;
  focused: boolean;
  onFocus: () => void;
}) {
  const strings = useStrings();
  const card = useRef<HTMLElement | null>(null);
  // A pin on the canvas brought the user here: show the thread.
  useEffect(() => {
    if (focused) card.current?.scrollIntoView?.({ block: "nearest" });
  }, [focused]);
  const [reply, setReply] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const where = (() => {
    switch (thread.where) {
      case "item":
        return strings.t(M.whereItem);
      case "page":
        return strings.t(M.wherePage);
      case "region":
        return strings.t(M.whereRegion);
      case "cell":
        return strings.t(M.whereCell, { address: anchorDetail(thread) ?? "" });
      case "orphaned":
        return strings.t(M.whereOrphaned);
      default:
        return strings.t(M.whereText, { text: anchorDetail(thread) ?? "" });
    }
  })();

  const send = () => {
    const text = reply.trim();
    if (text === "") return;
    void write(replyMutation(thread.id, text, reviewer, now));
    setReply("");
  };

  const comments = [thread.root, ...thread.replies];
  return (
    <article
      ref={card}
      className="border-b border-border p-2 text-xs aria-[current=true]:bg-accent"
      aria-current={focused ? "true" : undefined}
      onPointerDown={onFocus}
      data-thread={thread.id}
      data-resolved={thread.resolved ? "true" : undefined}
      data-where={thread.where}
    >
      <div className="mb-1 text-muted-foreground" data-thread-where>
        {thread.root.threadKind === "note" ? `${strings.t(M.note)} · ` : ""}
        {where}
      </div>
      {comments.map((c) => (
        <div key={c.id} className="mb-1" data-comment={c.id}>
          <div className="flex items-center gap-1">
            <span
              className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[10px]"
              data-initials
            >
              {initialsOf(c)}
            </span>
            <strong>{c.author}</strong>
            <span className="text-muted-foreground">
              {c.modified ?? c.date ?? ""}
            </span>
          </div>
          {editing === c.id ? (
            <div className="mt-1 flex flex-col gap-1">
              <textarea
                className="rounded border border-border bg-background p-1"
                data-edit-input
                value={editText}
                onChange={(e) => setEditText(e.currentTarget.value)}
              />
              <div className="flex gap-1">
                <button
                  type="button"
                  data-edit-save
                  onClick={() => {
                    void write(editFor(c, editText, now));
                    setEditing(null);
                  }}
                >
                  {strings.t(M.save)}
                </button>
                <button type="button" onClick={() => setEditing(null)}>
                  {strings.t(M.cancel)}
                </button>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap" data-comment-text>
              {c.text}
            </p>
          )}
          {editing === c.id ? null : (
            <div className="flex gap-2 text-muted-foreground">
              <button
                type="button"
                data-edit
                onClick={() => {
                  setEditing(c.id);
                  setEditText(c.text);
                }}
              >
                {strings.t(M.edit)}
              </button>
              <button
                type="button"
                data-delete
                onClick={() => void write(deleteFor(c))}
              >
                {strings.t(M.remove)}
              </button>
            </div>
          )}
        </div>
      ))}
      <div className="mt-1 flex items-center gap-1">
        {thread.root.threadKind === "note" ? null : (
          <input
            className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5"
            data-reply-input
            placeholder={strings.t(M.replyPlaceholder)}
            value={reply}
            onChange={(e) => setReply(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
            }}
          />
        )}
        {thread.root.threadKind === "note" ? null : (
          <button
            type="button"
            data-reply-send
            disabled={reply.trim() === ""}
            onClick={send}
          >
            {strings.t(M.reply)}
          </button>
        )}
        {isStoryNote(thread.root) ? null : (
          <button
            type="button"
            data-resolve
            onClick={() =>
              void write(resolveMutation(thread.root.id, !thread.resolved))
            }
          >
            {strings.t(thread.resolved ? M.reopen : M.resolve)}
          </button>
        )}
      </div>
    </article>
  );
}
