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

// Word's Review tab inside paged (doc ADR 613; engine ADRs 1040 and 1020;
// contract C5, extensions ADR 349 amendment 1; editor ADR 300): Track
// Changes on and off, Accept and Reject (one, all, by author), Next and
// Previous, the four markup views, and comment threads (new, reply,
// resolve, delete). Every write is ONE engine mutation, so each is one
// undo step. The markup margin band shows deletions, formatting and the
// comment threads as balloons beside the page; the Review panel lists
// them; the status bar says whether changes are tracked. Every command has
// a typed twin (object-model.ts); the keys are Word's (Cmd+Shift+E,
// Cmd+Alt+M), scoped to the `wordDocument` context.

import type {
  BundleHost,
  MarginBalloonProps,
  PanelProps,
  StatusItemProps,
} from "@paged-media/plugin-api";
import { paragraphTexts, wordAroundCaret } from "@paged-media/plugin-sdk";
import { subscribeOf, useLive } from "@paged-media/react-live";
import { t, useStrings } from "@paged-media/strings";
import * as React from "react";

import { REVIEW } from "../messages.js";
import {
  authorColor,
  changeAt,
  createReviewStore,
  initialsOf,
  MARKUP_VIEWS,
  stepTo,
  type MarkupView,
  type ReviewChange,
  type ReviewStore,
  type ReviewThread,
} from "./review-model.js";

const ID = "media.paged.doc.command.review";

/** The review command ids (also the manifest's `contributes.commands` and
 *  `objectModel.commands`). */
export const REVIEW_COMMAND = {
  toggleTrackChanges: `${ID}.toggleTrackChanges`,
  newComment: `${ID}.newComment`,
  acceptChange: `${ID}.acceptChange`,
  rejectChange: `${ID}.rejectChange`,
  acceptAll: `${ID}.acceptAll`,
  rejectAll: `${ID}.rejectAll`,
  nextChange: `${ID}.nextChange`,
  previousChange: `${ID}.previousChange`,
  nextComment: `${ID}.nextComment`,
  previousComment: `${ID}.previousComment`,
  markupSimple: `${ID}.markupSimple`,
  markupAll: `${ID}.markupAll`,
  markupNone: `${ID}.markupNone`,
  markupOriginal: `${ID}.markupOriginal`,
  replyComment: `${ID}.replyComment`,
  resolveComment: `${ID}.resolveComment`,
  deleteComment: `${ID}.deleteComment`,
  showReview: `${ID}.showReview`,
} as const;

export type ReviewCommandName = keyof typeof REVIEW_COMMAND;

export const REVIEW_PANEL = "media.paged.doc.panel.review";
export const REVIEW_BAND = "media.paged.doc.marginBand.markup";

/** Word's review keys (Word for Mac): Track Changes and New Comment. */
export const REVIEW_KEYS: ReadonlyArray<{ key: string; command: string }> = [
  { key: "cmd+shift+e", command: REVIEW_COMMAND.toggleTrackChanges },
  { key: "cmd+alt+m", command: REVIEW_COMMAND.newComment },
];

const TITLES: Record<ReviewCommandName, () => string> = {
  toggleTrackChanges: () => t(REVIEW.trackChanges),
  newComment: () => t(REVIEW.newComment),
  acceptChange: () => t(REVIEW.accept),
  rejectChange: () => t(REVIEW.reject),
  acceptAll: () => t(REVIEW.acceptAll),
  rejectAll: () => t(REVIEW.rejectAll),
  nextChange: () => t(REVIEW.nextChange),
  previousChange: () => t(REVIEW.previousChange),
  nextComment: () => t(REVIEW.nextComment),
  previousComment: () => t(REVIEW.previousComment),
  markupSimple: () => t(REVIEW.markupSimple),
  markupAll: () => t(REVIEW.markupAll),
  markupNone: () => t(REVIEW.markupNone),
  markupOriginal: () => t(REVIEW.markupOriginal),
  replyComment: () => t(REVIEW.reply),
  resolveComment: () => t(REVIEW.resolve),
  deleteComment: () => t(REVIEW.deleteComment),
  showReview: () => t(REVIEW.showReview),
};

/** The arguments a review command takes (the typed twins pass them; the
 *  keys, the menu and the panel's buttons pass what they know). */
export interface ReviewArgs {
  /** acceptChange / rejectChange: the change (else the caret's, else the
   *  next); resolve / reply / delete: the comment. */
  id?: string;
  /** acceptAll / rejectAll: only this reviewer's changes. */
  author?: string;
  /** newComment / replyComment: the comment's text. */
  text?: string;
  /** resolveComment: false reopens. Default true. */
  resolved?: boolean;
}

export interface ReviewResult {
  applied: boolean;
  /** newComment: the comment's id. */
  id?: string;
  error?: string;
}

export interface ReviewDeps {
  /** The Word document's stories in order (navigation order). */
  docStories(): Promise<string[]>;
  /** The time a new comment or reply is stamped with (tests fix it). */
  now?(): string;
}

/** What `contributeReview` hands back. */
export interface ReviewContribution {
  store: ReviewStore;
  run(name: ReviewCommandName, args?: ReviewArgs): Promise<ReviewResult>;
  /** Run by command id; false when the id is not a review command. */
  runId(id: string, args?: ReviewArgs): Promise<ReviewResult | false>;
  dispose(): void;
}

const MARKUP_COMMAND: Partial<Record<ReviewCommandName, MarkupView>> = {
  markupSimple: "simple",
  markupAll: "all",
  markupNone: "none",
  markupOriginal: "original",
};

async function mutate(host: BundleHost, m: unknown): Promise<ReviewResult> {
  const out = await host.document.mutate(m as never);
  return out.applied
    ? { applied: true }
    : { applied: false, error: String(out.error ?? "refused") };
}

/** The next free numeric comment id (replies included): one past the
 *  highest, as Word numbers `w:comment/@w:id`. */
export function nextCommentId(threads: readonly ReviewThread[]): string {
  let max = -1;
  for (const th of threads) {
    for (const c of [th.root, ...th.replies]) {
      const n = Number(c.id);
      if (Number.isInteger(n) && n > max) max = n;
    }
  }
  return String(max + 1);
}

const setDoc = (path: string, value: unknown) => ({
  op: "set",
  args: { address: "doc", path, value },
});

/** The review commands over `host` and `store`. */
export function reviewCommands(
  host: BundleHost,
  store: ReviewStore,
  deps: ReviewDeps,
) {
  const now = deps.now ?? (() => new Date().toISOString());
  const reviewer = () => store.get().author ?? t(REVIEW.defaultAuthor);
  const caret = () => host.text?.selection?.() ?? null;
  const reveal = (storyId: string, range: { start: number; end: number }) =>
    host.supports("viewport.revealText@1")
      ? host.viewport.revealText({ storyId, ...range }, { select: true })
      : Promise.resolve(false);
  const place = () => {
    const sel = caret();
    return sel ? { storyId: sel.storyId, offset: sel.end } : null;
  };
  /** The change a one-change command acts on: named, else at the caret,
   *  else the next one after it. */
  const target = (id?: string): ReviewChange | null => {
    const { changes } = store.get();
    if (id) return changes.find((c) => c.key === id || c.id === id) ?? null;
    return changeAt(changes, caret()) ?? null;
  };
  const resolveOne = async (accept: boolean, id?: string) => {
    const c = target(id);
    if (!c) return { applied: false, error: "no change here" };
    // ADR 184 deletions (InDesign's) have no id: they resolve by place.
    const m = c.id
      ? { op: accept ? "acceptChange" : "rejectChange", args: { id: c.id } }
      : {
          op: accept ? "acceptTrackedChange" : "rejectTrackedChange",
          args: { storyId: c.storyId, offset: c.start },
        };
    const out = await mutate(host, m);
    if (out.applied) {
      // Word moves on to the next change after resolving one.
      await store.refresh();
      const next = stepTo(
        store.get().changes,
        await deps.docStories(),
        place(),
        1,
      );
      if (next) await reveal(next.storyId, next.anchor);
    }
    return out;
  };
  const step = async (what: "change" | "comment", dir: 1 | -1) => {
    await store.refresh();
    const s = store.get();
    const items: ReadonlyArray<ReviewChange | ReviewThread> =
      what === "change" ? s.changes : s.threads;
    const hit = stepTo(items, await deps.docStories(), place(), dir);
    if (!hit) return { applied: false, error: `no ${what}` };
    await reveal(hit.storyId, hit.anchor);
    return { applied: true, id: "key" in hit ? hit.key : hit.id };
  };
  const newComment = async (text: string) => {
    const sel = caret();
    if (!sel) return { applied: false, error: t(REVIEW.noTextForComment) };
    const content = await host.document.storyContent(sel.storyId);
    if (!content) return { applied: false, error: t(REVIEW.noTextForComment) };
    const paras = paragraphTexts(content);
    let range: [number, number] | null;
    if (sel.start === sel.end) {
      // Word comments the word at a collapsed caret.
      range = wordAroundCaret(paras, sel.start);
    } else {
      const r = await host.text.characterRange();
      range = r ? [r.start, r.end] : null;
    }
    if (!range || range[0] === range[1])
      return { applied: false, error: t(REVIEW.noTextForComment) };
    // The engine answers no id for a comment (a reply's `createdId` names
    // elements): the comment gets the next free numeric id, Word's form.
    await store.refresh();
    const author = reviewer();
    const id = nextCommentId(store.get().threads);
    const out = await mutate(host, {
      op: "insertComment",
      args: {
        storyId: sel.storyId,
        start: range[0],
        end: range[1],
        comment: {
          id,
          author,
          initials: initialsOf(author),
          date: now(),
          text,
        },
      },
    });
    if (out.applied) {
      if (text === "") store.setEditing(id);
      await store.refresh();
      return { applied: true, id };
    }
    return out;
  };

  async function run(
    name: ReviewCommandName,
    args: ReviewArgs = {},
  ): Promise<ReviewResult> {
    const view = MARKUP_COMMAND[name];
    if (view) {
      const out = await mutate(
        host,
        setDoc("documentMarkupView", { type: "text", value: view }),
      );
      await store.refresh();
      return out;
    }
    switch (name) {
      case "toggleTrackChanges": {
        await store.refresh();
        const on = !store.get().tracking;
        const ops = [
          setDoc("documentTrackChanges", { type: "bool", value: on }),
        ];
        // Track Changes needs a reviewer: Word's user name, here the one
        // the panel set, else a placeholder the user can rename.
        if (on && !store.get().author)
          ops.push(
            setDoc("documentTrackChangesAuthor", {
              type: "text",
              value: reviewer(),
            }),
          );
        const out = await mutate(
          host,
          ops.length === 1 ? ops[0] : { op: "batch", args: { ops } },
        );
        await store.refresh();
        return out;
      }
      case "newComment":
        return newComment(args.text ?? "");
      case "acceptChange":
        return resolveOne(true, args.id);
      case "rejectChange":
        return resolveOne(false, args.id);
      case "acceptAll":
      case "rejectAll": {
        const out = await mutate(host, {
          op: name === "acceptAll" ? "acceptChange" : "rejectChange",
          args: args.author ? { author: args.author } : {},
        });
        await store.refresh();
        return out;
      }
      case "nextChange":
        return step("change", 1);
      case "previousChange":
        return step("change", -1);
      case "nextComment":
        return step("comment", 1);
      case "previousComment":
        return step("comment", -1);
      case "replyComment": {
        if (!args.id || !args.text)
          return {
            applied: false,
            error: "a reply needs its comment and text",
          };
        await store.refresh();
        const author = reviewer();
        const out = await mutate(host, {
          op: "replyComment",
          args: {
            parentId: args.id,
            comment: {
              id: nextCommentId(store.get().threads),
              author,
              initials: initialsOf(author),
              date: now(),
              text: args.text,
            },
          },
        });
        await store.refresh();
        return out;
      }
      case "resolveComment":
      case "deleteComment": {
        const id = args.id ?? threadAtCaret(store, caret())?.id;
        if (!id) return { applied: false, error: "no comment here" };
        const out = await mutate(
          host,
          name === "resolveComment"
            ? {
                op: "resolveComment",
                args: { commentId: id, resolved: args.resolved ?? true },
              }
            : { op: "deleteComment", args: { commentId: id } },
        );
        await store.refresh();
        return out;
      }
      case "showReview":
        host.shell.openPanel(REVIEW_PANEL);
        return { applied: true };
      default:
        return { applied: false, error: `unknown review command ${name}` };
    }
  }

  /** Write a comment's text (the balloon a new comment opens). */
  const editComment = async (id: string, text: string) => {
    const out = await mutate(host, {
      op: "editComment",
      args: { commentId: id, text, date: now() },
    });
    store.setEditing(null);
    await store.refresh();
    return out;
  };
  const setAuthor = async (author: string) => {
    const out = await mutate(
      host,
      setDoc("documentTrackChangesAuthor", { type: "text", value: author }),
    );
    await store.refresh();
    return out;
  };
  return { run, editComment, setAuthor, reveal };
}

function threadAtCaret(
  store: ReviewStore,
  sel: { storyId: string; start: number; end: number } | null,
): ReviewThread | null {
  if (!sel) return null;
  return (
    store
      .get()
      .threads.find(
        (th) =>
          th.storyId === sel.storyId &&
          th.anchor.start <= Math.max(sel.start, sel.end) &&
          th.anchor.end >= Math.min(sel.start, sel.end),
      ) ?? null
  );
}

type Commands = ReturnType<typeof reviewCommands>;

// ------------------------------------------------------------- the UI

const row: React.CSSProperties = {
  display: "flex",
  gap: 4,
  alignItems: "center",
  flexWrap: "wrap",
};
const small: React.CSSProperties = { fontSize: 11 };
const meta: React.CSSProperties = { fontSize: 10, color: "var(--pg-muted-fg)" };

function shortDate(date: string | null | undefined): string {
  return date ? date.replace("T", " ").slice(0, 16) : "";
}

function changeLabel(
  strings: ReturnType<typeof useStrings>,
  c: ReviewChange,
): string {
  const text = c.text.length > 60 ? `${c.text.slice(0, 60)}…` : c.text;
  switch (c.kind) {
    case "insert":
      return strings.t(REVIEW.inserted, { text });
    case "delete":
      return strings.t(REVIEW.deleted, { text });
    case "format":
      return strings.t(REVIEW.formatted);
    case "paraProps":
      return strings.t(REVIEW.paragraphFormatted);
    case "insertMark":
      return strings.t(REVIEW.paragraphInserted);
    case "deleteMark":
      return strings.t(REVIEW.paragraphDeleted);
  }
}

function ChangeView(props: {
  change: ReviewChange;
  commands: Commands;
  color: string;
}) {
  const strings = useStrings();
  const { change } = props;
  return (
    <div data-review-change={change.key} data-change-kind={change.kind}>
      <div style={{ ...meta, color: props.color }}>
        {change.author ?? ""} {shortDate(change.date)}
      </div>
      <div style={small}>{changeLabel(strings, change)}</div>
      <div style={row}>
        <button
          type="button"
          data-review-accept={change.key}
          onClick={() =>
            void props.commands.run("acceptChange", { id: change.key })
          }
        >
          {strings.t(REVIEW.accept)}
        </button>
        <button
          type="button"
          data-review-reject={change.key}
          onClick={() =>
            void props.commands.run("rejectChange", { id: change.key })
          }
        >
          {strings.t(REVIEW.reject)}
        </button>
      </div>
    </div>
  );
}

function ThreadView(props: {
  thread: ReviewThread;
  commands: Commands;
  editing: boolean;
  authors: readonly string[];
}) {
  const strings = useStrings();
  const { thread, commands } = props;
  const [reply, setReply] = React.useState("");
  const [draft, setDraft] = React.useState(thread.root.text);
  const entries = [thread.root, ...thread.replies];
  return (
    <div
      data-review-thread={thread.id}
      data-resolved={thread.resolved ? "true" : undefined}
      style={{ opacity: thread.resolved ? 0.6 : 1 }}
    >
      {entries.map((c, i) => (
        <div
          key={c.id}
          data-review-comment={c.id}
          style={{ marginLeft: i ? 8 : 0 }}
        >
          <div
            style={{
              ...meta,
              color: authorColor(props.authors, c.author ?? null),
            }}
          >
            {c.author ?? ""} {shortDate(c.date)}
          </div>
          {i === 0 && props.editing ? (
            <textarea
              data-review-edit={c.id}
              autoFocus
              rows={2}
              value={draft}
              placeholder={strings.t(REVIEW.commentPlaceholder)}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onBlur={() => void commands.editComment(c.id, draft)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void commands.editComment(c.id, draft);
                }
              }}
              style={{ width: "100%", boxSizing: "border-box", fontSize: 12 }}
            />
          ) : (
            <div style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{c.text}</div>
          )}
        </div>
      ))}
      {thread.resolved ? (
        <div style={meta}>{strings.t(REVIEW.resolved)}</div>
      ) : null}
      <div style={row}>
        {!thread.resolved ? (
          <input
            data-review-reply-input={thread.id}
            value={reply}
            placeholder={strings.t(REVIEW.replyPlaceholder)}
            onChange={(e) => setReply(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && reply.trim() !== "") {
                e.preventDefault();
                void commands
                  .run("replyComment", { id: thread.id, text: reply })
                  .then(() => setReply(""));
              }
            }}
            style={{ flex: 1, minWidth: 60, fontSize: 11 }}
          />
        ) : null}
        <button
          type="button"
          data-review-resolve={thread.id}
          onClick={() =>
            void commands.run("resolveComment", {
              id: thread.id,
              resolved: !thread.resolved,
            })
          }
        >
          {strings.t(thread.resolved ? REVIEW.reopen : REVIEW.resolve)}
        </button>
        <button
          type="button"
          data-review-delete={thread.id}
          title={strings.t(REVIEW.deleteComment)}
          onClick={() => void commands.run("deleteComment", { id: thread.id })}
        >
          ×
        </button>
      </div>
    </div>
  );
}

/** Which changes get a balloon: Word shows deletions and formatting in
 *  balloons; insertions stay inline (underlined in the text). */
const BALLOONED: ReadonlySet<ReviewChange["kind"]> = new Set([
  "delete",
  "format",
  "paraProps",
  "deleteMark",
]);

/** The margin band's items for a snapshot (pure, for the tests): All
 *  Markup shows the ballooned changes and the threads, Simple Markup the
 *  threads only, No Markup and Original nothing. */
export function bandItems(store: ReviewStore) {
  const s = store.get();
  if (s.view === "none" || s.view === "original") return [];
  const changes =
    s.view === "all"
      ? s.changes
          .filter((c) => BALLOONED.has(c.kind))
          .map((c) => ({
            id: `change:${c.key}`,
            kind: c.kind,
            color: authorColor(s.authors, c.author),
            anchor: { storyId: c.storyId, ...c.anchor },
          }))
      : [];
  const threads = s.threads.map((th) => ({
    id: `comment:${th.id}`,
    kind: "comment",
    color: authorColor(s.authors, th.root.author ?? null),
    anchor: { storyId: th.storyId, ...th.anchor },
  }));
  return [...changes, ...threads];
}

export function makeBalloon(store: ReviewStore, commands: Commands) {
  function ReviewBalloon(props: MarginBalloonProps) {
    const s = useLive(store, subscribeOf).get();
    const [kind, key] = splitOnce(props.item.id);
    if (kind === "change") {
      const c = s.changes.find((x) => x.key === key);
      return c ? (
        <ChangeView
          change={c}
          commands={commands}
          color={props.item.color ?? ""}
        />
      ) : null;
    }
    const th = s.threads.find((x) => x.id === key);
    return th ? (
      <ThreadView
        thread={th}
        commands={commands}
        editing={s.editing === th.id}
        authors={s.authors}
      />
    ) : null;
  }
  return ReviewBalloon;
}

function splitOnce(id: string): [string, string] {
  const i = id.indexOf(":");
  return i < 0 ? [id, ""] : [id.slice(0, i), id.slice(i + 1)];
}

export function makeTrackStatus(store: ReviewStore, commands: Commands) {
  function TrackStatus(_props: StatusItemProps) {
    const strings = useStrings();
    const on = useLive(store, subscribeOf).get().tracking;
    return (
      <button
        type="button"
        data-word-status="trackChanges"
        data-tracking={on ? "on" : "off"}
        onClick={() => void commands.run("toggleTrackChanges")}
        style={{
          font: "inherit",
          color: "inherit",
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
        }}
      >
        {strings.t(on ? REVIEW.trackOn : REVIEW.trackOff)}
      </button>
    );
  }
  return TrackStatus;
}

export function makeReviewPanel(store: ReviewStore, commands: Commands) {
  function ReviewPanel(_props: PanelProps) {
    const strings = useStrings();
    const s = useLive(store, subscribeOf).get();
    const [author, setAuthor] = React.useState(s.author ?? "");
    const [by, setBy] = React.useState("");
    React.useEffect(() => {
      void store.refresh();
    }, []);
    const viewLabel: Record<MarkupView, string> = {
      simple: strings.t(REVIEW.markupSimple),
      all: strings.t(REVIEW.markupAll),
      none: strings.t(REVIEW.markupNone),
      original: strings.t(REVIEW.markupOriginal),
    };
    const pick = by || s.authors[0] || "";
    return (
      <div
        data-review-panel
        style={{ display: "grid", gap: 8, padding: 8, fontSize: 12 }}
      >
        <label style={row}>
          <input
            type="checkbox"
            data-review-track
            checked={s.tracking}
            onChange={() => void commands.run("toggleTrackChanges")}
          />
          {strings.t(REVIEW.trackChanges)}
        </label>
        <label style={row}>
          {strings.t(REVIEW.author)}
          <input
            data-review-author
            value={author}
            placeholder={strings.t(REVIEW.defaultAuthor)}
            onChange={(e) => setAuthor(e.currentTarget.value)}
            onBlur={() => {
              if (author.trim() && author !== s.author)
                void commands.setAuthor(author.trim());
            }}
          />
        </label>
        <label style={row}>
          {strings.t(REVIEW.markup)}
          <select
            data-review-view
            value={s.view}
            onChange={(e) =>
              void commands.run(
                `markup${capitalize(e.currentTarget.value)}` as ReviewCommandName,
              )
            }
          >
            {MARKUP_VIEWS.map((v) => (
              <option key={v} value={v}>
                {viewLabel[v]}
              </option>
            ))}
          </select>
        </label>
        <div style={row}>
          <button
            type="button"
            data-review-prev
            onClick={() => void commands.run("previousChange")}
          >
            {strings.t(REVIEW.previousChange)}
          </button>
          <button
            type="button"
            data-review-next
            onClick={() => void commands.run("nextChange")}
          >
            {strings.t(REVIEW.nextChange)}
          </button>
        </div>
        <div style={row}>
          <button
            type="button"
            data-review-accept-all
            onClick={() => void commands.run("acceptAll")}
          >
            {strings.t(REVIEW.acceptAll)}
          </button>
          <button
            type="button"
            data-review-reject-all
            onClick={() => void commands.run("rejectAll")}
          >
            {strings.t(REVIEW.rejectAll)}
          </button>
        </div>
        {s.authors.length > 0 ? (
          <div style={row}>
            <select
              data-review-by
              value={pick}
              onChange={(e) => setBy(e.currentTarget.value)}
            >
              {s.authors.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-review-accept-by
              onClick={() => void commands.run("acceptAll", { author: pick })}
            >
              {strings.t(REVIEW.acceptBy, { author: pick })}
            </button>
            <button
              type="button"
              data-review-reject-by
              onClick={() => void commands.run("rejectAll", { author: pick })}
            >
              {strings.t(REVIEW.rejectBy, { author: pick })}
            </button>
          </div>
        ) : null}
        <strong>{strings.t(REVIEW.changes)}</strong>
        {s.changes.length === 0 ? (
          <div style={meta}>{strings.t(REVIEW.noChanges)}</div>
        ) : (
          s.changes.map((c) => (
            <div
              key={c.key}
              onClick={() => void commands.reveal(c.storyId, c.anchor)}
              style={{ cursor: "pointer" }}
            >
              <ChangeView
                change={c}
                commands={commands}
                color={authorColor(s.authors, c.author)}
              />
            </div>
          ))
        )}
        <div style={row}>
          <strong style={{ flex: 1 }}>{strings.t(REVIEW.comments)}</strong>
          <button
            type="button"
            data-review-new-comment
            onClick={() => void commands.run("newComment")}
          >
            {strings.t(REVIEW.newComment)}
          </button>
        </div>
        {s.threads.length === 0 ? (
          <div style={meta}>{strings.t(REVIEW.noComments)}</div>
        ) : (
          s.threads.map((th) => (
            <ThreadView
              key={th.id}
              thread={th}
              commands={commands}
              editing={false}
              authors={s.authors}
            />
          ))
        )}
      </div>
    );
  }
  return ReviewPanel;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Contribute the review chrome. The `wordDocument` edit context must already
 * be registered; each door is probed, so a host without the margin band
 * keeps the panel, the commands and the keys.
 */
export function contributeReview(
  host: BundleHost,
  deps: ReviewDeps & { editContext: string },
): ReviewContribution {
  const disposers: Array<() => void> = [];
  const store = createReviewStore(host);
  const commands = reviewCommands(host, store, deps);
  const run = (name: ReviewCommandName, args?: ReviewArgs) =>
    commands.run(name, args).catch((err: unknown) => {
      host.log.warn(`paged.doc: ${name} failed: ${String(err)}`);
      return { applied: false, error: String(err) } as ReviewResult;
    });

  for (const name of Object.keys(REVIEW_COMMAND) as ReviewCommandName[]) {
    disposers.push(
      host.contribute.command({
        id: REVIEW_COMMAND[name],
        title: TITLES[name](),
        category: "Review",
        handler: () => void run(name),
      }).dispose,
    );
  }
  if (host.supports("contribute.keybinding.scope@1")) {
    for (const k of REVIEW_KEYS) {
      disposers.push(
        host.contribute.keybinding({
          key: k.key,
          command: k.command,
          scope: { editContext: deps.editContext },
        }).dispose,
      );
    }
  }
  disposers.push(
    host.contribute.panel({
      id: REVIEW_PANEL,
      title: t(REVIEW.panelTitle),
      component: makeReviewPanel(store, commands),
      defaultDock: "right",
      icon: "panel-outline",
    }).dispose,
  );
  if (host.supports("contribute.statusItem@1")) {
    disposers.push(
      host.contribute.statusItem({
        id: "media.paged.doc.status.trackChanges",
        scope: { editContext: deps.editContext },
        align: "start",
        order: 35,
        render: makeTrackStatus(store, commands),
      }).dispose,
    );
  }
  if (host.supports("contribute.marginBand@1")) {
    const listeners = new Set<() => void>();
    const off = store.subscribe(() => {
      for (const l of [...listeners]) l();
    });
    disposers.push(off);
    disposers.push(
      host.contribute.marginBand({
        id: REVIEW_BAND,
        title: t(REVIEW.markup),
        scope: { editContext: deps.editContext },
        items: () => bandItems(store),
        onDidChange(listener) {
          listeners.add(listener);
          return { dispose: () => void listeners.delete(listener) };
        },
        render: makeBalloon(store, commands),
      }).dispose,
    );
  }
  // The collections move with every edit; the store re-reads once a burst
  // of edits settles.
  let timer: ReturnType<typeof setTimeout> | null = null;
  const refreshSoon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void store.refresh();
    }, 150);
  };
  if (host.supports("document.onDidChange@1")) {
    disposers.push(host.document.onDidChange(refreshSoon).dispose);
  }
  if (host.supports("document.onDidOpen@1")) {
    disposers.push(host.document.onDidOpen(refreshSoon).dispose);
  }
  const byId = new Map(
    (Object.keys(REVIEW_COMMAND) as ReviewCommandName[]).map((n) => [
      REVIEW_COMMAND[n] as string,
      n,
    ]),
  );
  return {
    store,
    run,
    async runId(id, args) {
      const name = byId.get(id);
      return name ? run(name, args) : false;
    },
    dispose() {
      if (timer) clearTimeout(timer);
      for (const d of disposers.reverse()) d();
    },
  };
}
