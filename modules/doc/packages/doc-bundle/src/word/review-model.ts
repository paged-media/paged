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

// Word's Review (doc ADR 613, engine ADRs 1040 and 1020): the live state of
// the review chrome — whether Track Changes is on, who is reviewing, the
// markup view, the document's tracked changes and comment threads — read
// from the engine's `trackedChanges` and `comments` collections and the
// document's `documentTrackChanges*` / `documentMarkupView` paths, and the
// pure helpers the commands, the panel and the margin band share.

import type { BundleHost } from "@paged-media/plugin-api";
import { charToContent, paragraphTexts } from "@paged-media/plugin-sdk";

/** Word's four markup views (`documentMarkupView`). */
export type MarkupView = "simple" | "all" | "none" | "original";
export const MARKUP_VIEWS: readonly MarkupView[] = [
  "simple",
  "all",
  "none",
  "original",
];

/** What a change did (the engine's `kind`; ADR 184 deletions carry none). */
export type ChangeKind =
  "insert" | "delete" | "format" | "paraProps" | "insertMark" | "deleteMark";

/** One `documentCollection:trackedChanges` entry, as the engine lists it. */
export interface TrackedChangeRead {
  storyId: string;
  /** Story characters (contiguous) where the change starts. */
  offset: number;
  changeType?: string;
  userName?: string | null;
  date?: string | null;
  text?: string;
  id?: string | null;
  kind?: ChangeKind | null;
  end?: number | null;
  paragraph?: number | null;
}

/** One `documentCollection:comments` entry. */
export interface CommentRead {
  id: string;
  storyId: string;
  parentId?: string | null;
  start?: number | null;
  end?: number | null;
  anchorText?: string;
  text: string;
  author?: string | null;
  initials?: string | null;
  date?: string | null;
  resolved?: boolean;
}

/** A change as the review chrome shows it. */
export interface ReviewChange {
  /** The engine's id; ADR 184 deletions (no id) get `<story>@<offset>`. */
  key: string;
  id: string | null;
  storyId: string;
  kind: ChangeKind;
  author: string | null;
  date: string | null;
  text: string;
  /** Story characters. */
  start: number;
  end: number;
  /** Content offsets (what the caret and `revealText` count). */
  anchor: { start: number; end: number };
}

/** A comment thread: the root comment and its replies, oldest first. */
export interface ReviewThread {
  id: string;
  storyId: string;
  root: CommentRead;
  replies: CommentRead[];
  resolved: boolean;
  anchorText: string;
  start: number;
  end: number;
  anchor: { start: number; end: number };
}

export interface ReviewSnapshot {
  tracking: boolean;
  author: string | null;
  view: MarkupView;
  changes: ReviewChange[];
  threads: ReviewThread[];
  /** The authors of the changes and the comments, in order of appearance. */
  authors: string[];
  /** The comment whose balloon is open for typing (just made). */
  editing: string | null;
}

export const EMPTY_REVIEW: ReviewSnapshot = {
  tracking: false,
  author: null,
  view: "all",
  changes: [],
  threads: [],
  authors: [],
  editing: null,
};

/** The kind of an entry: the engine's, else read from InDesign's
 *  `ChangeType` (ADR 184). */
export function kindOf(c: TrackedChangeRead): ChangeKind {
  if (c.kind) return c.kind;
  if (c.changeType === "InsertedText") return "insert";
  return "delete";
}

/** The ten colours Word gives its reviewers, by order of appearance. */
const AUTHOR_COLORS = [
  "#b5082e",
  "#2b579a",
  "#107c10",
  "#8764b8",
  "#ca5010",
  "#038387",
  "#c239b3",
  "#986f0b",
  "#4f6bed",
  "#7a7574",
];

/** An author's colour (stable for the document: by order of appearance). */
export function authorColor(authors: readonly string[], author: string | null) {
  const i = author ? authors.indexOf(author) : -1;
  return AUTHOR_COLORS[(i < 0 ? 0 : i) % AUTHOR_COLORS.length]!;
}

/** The paragraph texts of each story, read once per story. */
export type StoryTexts = ReadonlyMap<string, readonly string[]>;

/** Build the snapshot's lists from the collections (pure). Changes are in
 *  document order (the engine lists stories in order, a story's changes by
 *  offset); a thread's replies follow their root. */
export function buildReview(
  changes: readonly TrackedChangeRead[],
  comments: readonly CommentRead[],
  texts: StoryTexts,
): Pick<ReviewSnapshot, "changes" | "threads" | "authors"> {
  const authors: string[] = [];
  const seen = (a: string | null | undefined) => {
    if (a && !authors.includes(a)) authors.push(a);
  };
  const toContent = (storyId: string, at: number) => {
    const paras = texts.get(storyId);
    return paras ? charToContent(paras, at) : at;
  };
  const out: ReviewChange[] = changes.map((c) => {
    seen(c.userName);
    const start = c.offset;
    const end = c.end ?? (kindOf(c) === "delete" && !c.id ? start + 1 : start);
    return {
      key: c.id ?? `${c.storyId}@${c.offset}`,
      id: c.id ?? null,
      storyId: c.storyId,
      kind: kindOf(c),
      author: c.userName ?? null,
      date: c.date ?? null,
      text: c.text ?? "",
      start,
      end,
      anchor: {
        start: toContent(c.storyId, start),
        end: toContent(c.storyId, end),
      },
    };
  });
  const roots = comments.filter((c) => !c.parentId);
  const threads: ReviewThread[] = roots.map((root) => {
    seen(root.author);
    const replies = comments.filter((c) => c.parentId === root.id);
    for (const r of replies) seen(r.author);
    const start = root.start ?? 0;
    const end = root.end ?? start;
    return {
      id: root.id,
      storyId: root.storyId,
      root,
      replies,
      resolved: root.resolved === true,
      anchorText: root.anchorText ?? "",
      start,
      end,
      anchor: {
        start: toContent(root.storyId, start),
        end: toContent(root.storyId, end),
      },
    };
  });
  threads.sort(
    (a, b) =>
      storyOrder(changes, comments, a.storyId) -
        storyOrder(changes, comments, b.storyId) || a.start - b.start,
  );
  return { changes: out, threads, authors };
}

function storyOrder(
  changes: readonly TrackedChangeRead[],
  comments: readonly CommentRead[],
  storyId: string,
): number {
  const i = changes.findIndex((c) => c.storyId === storyId);
  if (i >= 0) return i;
  const j = comments.findIndex((c) => c.storyId === storyId);
  return changes.length + (j < 0 ? comments.length : j);
}

/** A place in the document: a story's position in a list of stories and a
 *  content offset in it. */
export interface Place {
  storyId: string;
  offset: number;
}

/**
 * The item after (`dir` 1) or before (`dir` -1) `at` in document order,
 * wrapping round as Word does; `null` for an empty list. `stories` is the
 * story order; items of a story it does not name come last.
 */
export function stepTo<
  T extends { storyId: string; anchor: { start: number } },
>(
  items: readonly T[],
  stories: readonly string[],
  at: Place | null,
  dir: 1 | -1,
): T | null {
  if (items.length === 0) return null;
  const rank = (s: string) => {
    const i = stories.indexOf(s);
    return i < 0 ? stories.length : i;
  };
  const sorted = [...items].sort(
    (a, b) =>
      rank(a.storyId) - rank(b.storyId) || a.anchor.start - b.anchor.start,
  );
  if (!at) return dir === 1 ? sorted[0]! : sorted[sorted.length - 1]!;
  const cmp = (t: T) =>
    rank(t.storyId) - rank(at.storyId) || t.anchor.start - at.offset;
  if (dir === 1) return sorted.find((t) => cmp(t) > 0) ?? sorted[0]!;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (cmp(sorted[i]!) < 0) return sorted[i]!;
  }
  return sorted[sorted.length - 1]!;
}

/** The change the caret stands in (its content range touches the caret or
 *  the selection), else null. */
export function changeAt(
  changes: readonly ReviewChange[],
  sel: { storyId: string; start: number; end: number } | null,
): ReviewChange | null {
  if (!sel) return null;
  return (
    changes.find(
      (c) =>
        c.storyId === sel.storyId &&
        c.anchor.start <= Math.max(sel.start, sel.end) &&
        c.anchor.end >= Math.min(sel.start, sel.end),
    ) ?? null
  );
}

/** A reviewer's initials ("Author A" → "AA"). */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => [...w][0]!.toUpperCase())
    .join("")
    .slice(0, 3);
}

/** The store's reads. */
export interface ReviewStore {
  get(): ReviewSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  setEditing(id: string | null): void;
}

/** Read a document path through the object model (`doc` address). */
async function readDocPath(host: BundleHost, path: string): Promise<unknown> {
  try {
    const v = await host.objects.get("doc", path as never);
    if (v.kind !== "value") return undefined;
    const raw = v.value as unknown;
    if (raw && typeof raw === "object" && "value" in raw)
      return (raw as { value: unknown }).value;
    return raw;
  } catch {
    return undefined;
  }
}

/** The review store over `host`. */
export function createReviewStore(host: BundleHost): ReviewStore {
  let snap = EMPTY_REVIEW;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<ReviewSnapshot>) => {
    snap = { ...snap, ...patch };
    for (const fn of [...listeners]) fn();
  };
  let ask = 0;
  const collection = async <T>(name: string): Promise<T[]> => {
    try {
      return (await host.document.collection(name as never)) as unknown as T[];
    } catch {
      return [];
    }
  };
  return {
    get: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setEditing(id) {
      set({ editing: id });
    },
    async refresh() {
      const mine = ++ask;
      const [changes, comments, tracking, author, view] = await Promise.all([
        collection<TrackedChangeRead>("trackedChanges"),
        collection<CommentRead>("comments"),
        readDocPath(host, "documentTrackChanges"),
        readDocPath(host, "documentTrackChangesAuthor"),
        readDocPath(host, "documentMarkupView"),
      ]);
      const stories = new Set<string>([
        ...changes.map((c) => c.storyId),
        ...comments.map((c) => c.storyId),
      ]);
      const texts = new Map<string, readonly string[]>();
      if (host.supports("document.readStory@1")) {
        for (const id of stories) {
          try {
            const content = await host.document.storyContent(id);
            if (content) texts.set(id, paragraphTexts(content));
          } catch {
            // A story that does not read keeps its characters as offsets.
          }
        }
      }
      if (mine !== ask) return;
      set({
        tracking: tracking === true,
        author: typeof author === "string" && author !== "" ? author : null,
        view: MARKUP_VIEWS.includes(view as MarkupView)
          ? (view as MarkupView)
          : "all",
        ...buildReview(changes, comments, texts),
      });
    },
  };
}
