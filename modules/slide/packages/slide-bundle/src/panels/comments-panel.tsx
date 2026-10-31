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

// The Comments panel (ADR 711, amendment 2026-10-25): the threads on the
// slide the user is on, as PowerPoint's Comments pane shows them. Each
// thread has its replies, a reply box, Resolve / Reopen and Delete; a box at
// the bottom starts a new thread on the slide. Resolved threads fold away
// behind "Show resolved". What a comment is lives in CommentsStore; this is
// display glue.

import type { BundleHost, PanelProps } from "@paged-media/plugin-api";
import { color } from "@paged-media/panel-kit";
import { subscribeOf, useLive } from "@paged-media/react-live";
import { useStrings } from "@paged-media/strings";
import * as React from "react";

import type { CommentsStore, SlideComment } from "../comments-model.js";
import { COMMENTS } from "../messages.js";
import type { SlidesStore } from "../slides-model.js";

const small: React.CSSProperties = { fontSize: 11, padding: "1px 6px" };
const meta: React.CSSProperties = { fontSize: 11, opacity: 0.7 };

/** A date as the panel shows it: the deck's own text when it is no date. */
function when(created: string | null): string {
  if (!created) return "";
  const d = new Date(created);
  return Number.isNaN(d.getTime()) ? created : d.toLocaleString();
}

export function makeCommentsPanel(
  host: BundleHost,
  slides: SlidesStore,
  comments: CommentsStore,
): React.ComponentType<PanelProps> {
  const warn = (e: unknown) =>
    host.log.warn(`paged.slide comments: ${String(e)}`);

  const Thread: React.FC<{
    pageId: string;
    comment: SlideComment;
    author: () => string;
  }> = ({ pageId, comment, author }) => {
    const { t } = useStrings();
    const [reply, setReply] = React.useState("");
    const resolved =
      comment.status === "resolved" || comment.status === "closed";
    return (
      <div
        data-comment={comment.id}
        data-resolved={resolved || undefined}
        style={{
          border: `1px solid ${color.border}`,
          borderRadius: 4,
          padding: 8,
          display: "flex",
          flexDirection: "column",
          gap: 4,
          opacity: resolved ? 0.6 : 1,
        }}
      >
        <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
          <strong style={{ fontSize: 12 }}>{comment.author}</strong>
          <span style={meta}>{when(comment.created)}</span>
          {resolved && <span style={meta}>· {t(COMMENTS.resolved)}</span>}
        </div>
        <div data-comment-text style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
          {comment.text}
        </div>
        {comment.replies.map((r) => (
          <div
            key={r.id}
            data-reply={r.id}
            style={{
              marginLeft: 10,
              paddingLeft: 8,
              borderLeft: `2px solid ${color.border}`,
            }}
          >
            <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
              <strong style={{ fontSize: 12 }}>{r.author}</strong>
              <span style={meta}>{when(r.created)}</span>
              <button
                type="button"
                style={{ ...small, marginLeft: "auto" }}
                title={t(COMMENTS.deleteReply)}
                aria-label={t(COMMENTS.deleteReply)}
                onClick={() =>
                  void comments.remove(pageId, comment.id, r.id).catch(warn)
                }
              >
                ×
              </button>
            </div>
            <div
              data-reply-text
              style={{ fontSize: 13, whiteSpace: "pre-wrap" }}
            >
              {r.text}
            </div>
          </div>
        ))}
        <div style={{ display: "flex", gap: 4 }}>
          <input
            data-reply-input
            value={reply}
            placeholder={t(COMMENTS.replyPlaceholder)}
            aria-label={t(COMMENTS.replyPlaceholder)}
            onChange={(e) => setReply(e.target.value)}
            style={{ flex: 1, minWidth: 0, fontSize: 12 }}
          />
          <button
            type="button"
            style={small}
            data-reply-send
            disabled={reply.trim() === ""}
            onClick={() => {
              const text = reply.trim();
              setReply("");
              void comments
                .reply(pageId, comment.id, text, author())
                .catch(warn);
            }}
          >
            {t(COMMENTS.reply)}
          </button>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            style={small}
            data-comment-resolve
            aria-pressed={resolved}
            onClick={() =>
              void comments
                .setResolved(pageId, comment.id, !resolved)
                .catch(warn)
            }
          >
            {t(resolved ? COMMENTS.reopen : COMMENTS.resolve)}
          </button>
          <button
            type="button"
            style={small}
            data-comment-delete
            onClick={() => void comments.remove(pageId, comment.id).catch(warn)}
          >
            {t(COMMENTS.delete)}
          </button>
        </div>
      </div>
    );
  };

  const Component: React.FC<PanelProps> = () => {
    const { t } = useStrings();
    const deck = useLive(slides, subscribeOf);
    const store = useLive(comments, subscribeOf);
    const [draft, setDraft] = React.useState("");
    const [showResolved, setShowResolved] = React.useState(false);
    const [name, setName] = React.useState(() => comments.authorName());
    const author = () => name.trim() || t(COMMENTS.defaultAuthor);
    const slide = deck.activeSlide();

    if (!slide) {
      return (
        <div
          style={{ padding: 12, fontSize: 13, opacity: 0.7 }}
          data-comments-panel="empty"
        >
          {t(COMMENTS.empty)}
        </div>
      );
    }
    const all = store.forPage(slide.pageId);
    const isResolved = (c: SlideComment) =>
      c.status === "resolved" || c.status === "closed";
    const shown = showResolved ? all : all.filter((c) => !isResolved(c));
    const hiddenCount = all.length - shown.length;
    return (
      <div
        style={{
          padding: 10,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
        data-comments-panel="ready"
        data-comments-page={slide.pageId}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ flex: 1, fontSize: 11, opacity: 0.7 }}>
            {t(COMMENTS.heading, { number: slide.number })}
          </span>
          {(hiddenCount > 0 || showResolved) && (
            <label style={{ fontSize: 11, display: "flex", gap: 4 }}>
              <input
                type="checkbox"
                data-show-resolved
                checked={showResolved}
                onChange={(e) => setShowResolved(e.target.checked)}
              />
              {t(COMMENTS.showResolved)}
            </label>
          )}
        </div>
        {shown.length === 0 && (
          <div style={{ fontSize: 13, opacity: 0.7 }} data-comments-none>
            {t(COMMENTS.none)}
          </div>
        )}
        {shown.map((c) => (
          <Thread
            key={c.id}
            pageId={slide.pageId}
            comment={c}
            author={author}
          />
        ))}
        <textarea
          data-comment-new
          value={draft}
          placeholder={t(COMMENTS.newPlaceholder)}
          aria-label={t(COMMENTS.newPlaceholder)}
          onChange={(e) => setDraft(e.target.value)}
          style={{
            minHeight: 48,
            resize: "vertical",
            font: "inherit",
            fontSize: 13,
          }}
        />
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            data-comment-author
            value={name}
            placeholder={t(COMMENTS.defaultAuthor)}
            aria-label={t(COMMENTS.yourName)}
            title={t(COMMENTS.yourName)}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => comments.setAuthorName(name)}
            style={{ flex: 1, minWidth: 0, fontSize: 12 }}
          />
          <button
            type="button"
            data-comment-add
            disabled={draft.trim() === ""}
            onClick={() => {
              const text = draft.trim();
              setDraft("");
              comments.setAuthorName(name);
              void comments.add(slide.pageId, text, author()).catch(warn);
            }}
          >
            {t(COMMENTS.add)}
          </button>
        </div>
      </div>
    );
  };
  return Component;
}
