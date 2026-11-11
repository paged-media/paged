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

// A deck's comments (ADR 711, amendment 2026-10-25; engine ADR 1055):
// PowerPoint's threaded comments and its legacy ones. They live in the
// document as the engine's comment threads, so the host's Comments panel
// shows them beside every other module's, they undo with the document and
// they save with it. A slide comment is a thread anchored to its page (a
// point on it) or to a shape on it (`shape:<cNvPr id>` on the page), and
// keeps the comment PowerPoint wrote as the thread's source, so the fields
// the engine does not model survive until the comment is edited.
//
// Decks saved before the engine kept comments hold them in this plugin's
// container part `comments/comments.json` (ADR 703): the first open reads
// the part into the document and empties it.
//
// This store keeps the deck's comments as the `CommentsFile` export hands
// the engine, current: read from the engine's `comments` collection after
// every document change; written through the engine's comment mutations.

import type { BundleHost } from "@paged-media/plugin-api";

import type { CommentReply, SlideComment, SlideReport } from "./engine.js";

export type { CommentReply, SlideComment };

/** The container part (this plugin's namespace). */
export const COMMENTS_PART = "comments/comments.json";

/** The part's shape. */
export interface CommentsFile {
  v: 1;
  /** Each slide's comments, oldest first, by page id. */
  byPage: Record<string, SlideComment[]>;
}

/** Who writes a new comment. */
export interface Author {
  id: string;
  name: string;
  initials: string;
}

/** A new GUID in the braces PowerPoint writes. */
export function newGuid(): string {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = Math.floor(Math.random() * 16);
          return (c === "x" ? r : (r & 3) | 8).toString(16);
        });
  return `{${uuid.toUpperCase()}}`;
}

/** A name's initials, as PowerPoint shows them on a comment marker. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words
    .slice(0, 3)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** The import report's comments, as the part's content. */
export function fileFromReport(slides: readonly SlideReport[]): CommentsFile {
  const byPage: Record<string, SlideComment[]> = {};
  for (const s of slides) byPage[s.pageId] = [...(s.comments ?? [])];
  return { v: 1, byPage };
}

/** The part's bytes as a file, or null when they are not one. */
export function parseFile(bytes: Uint8Array | null): CommentsFile | null {
  if (!bytes) return null;
  try {
    const f = JSON.parse(new TextDecoder().decode(bytes)) as CommentsFile;
    if (f?.v !== 1 || typeof f.byPage !== "object" || f.byPage === null)
      return null;
    return f;
  } catch {
    return null;
  }
}

const now = () => new Date().toISOString();

/** `file` with a new comment on `pageId`. */
export function makeComment(
  author: Author,
  text: string,
  at?: { x: number; y: number } | null,
): SlideComment {
  return {
    id: newGuid(),
    authorId: author.id,
    author: author.name,
    initials: author.initials,
    created: now(),
    text,
    x: at?.x ?? null,
    y: at?.y ?? null,
    shapeId: null,
    status: null,
    replies: [],
    legacy: false,
  };
}

/** `file` with `change` applied to comment `id` of `pageId`; the same file
 *  when there is no such comment. */
/** The storage key of the name new comments are written under. */
export const AUTHOR_KEY = "commentAuthor";

/** The format name a slide comment's source carries. */
export const SOURCE_FORMAT = "pptx";

/** The address of a shape on its page, the thread anchor's module address. */
export const shapeAddress = (shapeId: number): string => `shape:${shapeId}`;

/** The shape id a module address names, or null. */
export function shapeOfAddress(address: string | undefined): number | null {
  const m = /^shape:(\d+)$/.exec(address ?? "");
  return m ? Number(m[1]) : null;
}

/** One row of the engine's `comments` collection, as far as slide reads it. */
export interface EngineCommentRow {
  id: string;
  parentId?: string | null;
  threadId?: string | null;
  author?: string | null;
  initials?: string | null;
  date?: string | null;
  text: string;
  resolved: boolean;
  person?: string | null;
  page?: string | null;
  at?: [number, number] | null;
  anchor?:
    | { kind: "page"; page: string; at: [number, number] }
    | { kind: "cell"; item: string; address: string }
    | { kind: string }
    | null;
  source?: { format: string; data: string } | null;
}

type Mutation = { op: string; args: Record<string, unknown> };

const sourceOf = (c: SlideComment | CommentReply) => {
  const { replies: _replies, ...rest } = c as SlideComment;
  return { format: SOURCE_FORMAT, data: JSON.stringify(rest) };
};

const specOf = (c: SlideComment | CommentReply, resolved = false) => ({
  id: c.id,
  author: c.author,
  initials: c.initials,
  date: c.created,
  text: c.text,
  person: c.authorId || null,
  resolved,
  source: sourceOf(c),
});

/** The engine mutations that put a deck's comments into its document: each
 *  author once, each slide comment as a thread on its page or shape, each
 *  reply in its thread. */
export function commentMutations(file: CommentsFile): Mutation[] {
  const ops: Mutation[] = [];
  const people = new Set<string>();
  const person = (c: CommentReply) => {
    if (!c.authorId || people.has(c.authorId)) return;
    people.add(c.authorId);
    ops.push({
      op: "setPerson",
      args: {
        person: { id: c.authorId, name: c.author, initials: c.initials },
      },
    });
  };
  for (const [pageId, list] of Object.entries(file.byPage)) {
    for (const c of list) {
      person(c);
      const resolved = c.status === "resolved" || c.status === "closed";
      ops.push({
        op: "insertCommentThread",
        args: {
          anchor:
            c.shapeId != null
              ? { kind: "cell", item: pageId, address: shapeAddress(c.shapeId) }
              : { kind: "page", page: pageId, at: [c.x ?? 0, c.y ?? 0] },
          comment: specOf(c, resolved),
        },
      });
      for (const r of c.replies) {
        person(r);
        ops.push({
          op: "replyComment",
          args: { parentId: c.id, comment: specOf(r) },
        });
      }
    }
  }
  return ops;
}

const parseSource = <T>(row: EngineCommentRow): Partial<T> | null => {
  if (row.source?.format !== SOURCE_FORMAT) return null;
  try {
    return JSON.parse(row.source.data) as Partial<T>;
  } catch {
    return null;
  }
};

const replyOf = (row: EngineCommentRow): CommentReply => {
  const src = parseSource<CommentReply>(row);
  return {
    id: row.id,
    authorId: row.person ?? src?.authorId ?? "",
    author: row.author ?? src?.author ?? "",
    initials: row.initials ?? src?.initials ?? initialsOf(row.author ?? ""),
    created: row.date ?? src?.created ?? new Date(0).toISOString(),
    text: row.text,
  };
};

/** The deck's comments as export hands them over, from the engine's rows:
 *  the threads on a page (a text comment has no slide to go on and is not
 *  exported). A comment the engine holds without the source PowerPoint wrote
 *  (made in the host's panel) gets sensible defaults. */
export function fileFromRows(rows: readonly EngineCommentRow[]): CommentsFile {
  const byPage: Record<string, SlideComment[]> = {};
  const replies = new Map<string, EngineCommentRow[]>();
  for (const r of rows) {
    if (!r.parentId) continue;
    const list = replies.get(r.parentId) ?? [];
    list.push(r);
    replies.set(r.parentId, list);
  }
  for (const row of rows) {
    if (row.parentId || !row.threadId || !row.page) continue;
    const src = parseSource<SlideComment>(row);
    const base = replyOf(row);
    const address =
      row.anchor?.kind === "cell"
        ? (row.anchor as { address: string }).address
        : undefined;
    const shapeId = shapeOfAddress(address) ?? src?.shapeId ?? null;
    const was = src?.status ?? null;
    const status: SlideComment["status"] = row.resolved
      ? was === "closed"
        ? "closed"
        : "resolved"
      : was === "resolved" || was === "closed"
        ? null
        : was;
    const at = row.at ?? null;
    const comment: SlideComment = {
      ...base,
      x: src
        ? (src.x ?? null)
        : at && (at[0] !== 0 || at[1] !== 0)
          ? at[0]
          : null,
      y: src
        ? (src.y ?? null)
        : at && (at[0] !== 0 || at[1] !== 0)
          ? at[1]
          : null,
      shapeId,
      status,
      replies: (replies.get(row.id) ?? []).map(replyOf),
      legacy: src?.legacy ?? false,
    };
    (byPage[row.page] ??= []).push(comment);
  }
  return { v: 1, byPage };
}

/**
 * The deck's comments, kept current from the engine. Pages are addressed by
 * id, so a slide keeps its comments wherever it moves; a deleted slide's
 * comments are not exported (export lists the pages there are).
 */
export class CommentsStore {
  private file: CommentsFile | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly disposers: Array<() => void> = [];
  private loading: Promise<void> | null = null;
  /** Authors made this session, by name (an id once per name). */
  private readonly authors = new Map<string, Author>();

  constructor(private readonly host: BundleHost) {
    if (host.supports("document.onDidOpen@1")) {
      this.disposers.push(
        host.document.onDidOpen(() => void this.load()).dispose,
      );
    }
    if (host.supports("document.onDidChange@1")) {
      this.disposers.push(
        host.document.onDidChange(() => void this.load()).dispose,
      );
    }
    void this.load();
  }

  /** Whether the open document's comments have been read. */
  has(): boolean {
    return this.file !== null;
  }

  /** The whole file (export reads it), or null. */
  current(): CommentsFile | null {
    return this.file;
  }

  /** The comments of `pageId`, oldest first. */
  forPage(pageId: string | null): readonly SlideComment[] {
    return (pageId && this.file?.byPage[pageId]) || [];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Read the engine's comments again (and, once, move an older deck's
   *  container part into the document). */
  load(): Promise<void> {
    const job = (async () => {
      try {
        let rows = await this.rows();
        if (rows.length === 0 && (await this.migrate()))
          rows = await this.rows();
        this.file = fileFromRows(rows);
      } catch {
        this.file = null; // no document open
      }
      this.emit();
    })();
    this.loading = job;
    return job;
  }

  /** Wait for the read in flight. */
  async ready(): Promise<void> {
    await this.loading;
  }

  /** Put the importer's comments into the document. */
  async replace(file: CommentsFile): Promise<void> {
    const ops = commentMutations(file);
    if (ops.length > 0) await this.apply({ op: "batch", args: { ops } });
    await this.load();
  }

  /** The name new comments are written under (remembered per user). */
  authorName(): string {
    try {
      const name = this.host.storage.get<string>(AUTHOR_KEY);
      if (typeof name === "string" && name.trim() !== "") return name.trim();
    } catch {
      // no storage
    }
    return "";
  }

  setAuthorName(name: string): void {
    try {
      this.host.storage.set(AUTHOR_KEY, name.trim());
    } catch {
      // no storage: the name lasts for this comment
    }
    this.emit();
  }

  /** The author for `name`: the deck's own author of that name (same id,
   *  so PowerPoint shows one person), else one made once this session. */
  author(name: string): Author {
    const known = this.authors.get(name);
    if (known) return known;
    for (const list of Object.values(this.file?.byPage ?? {})) {
      for (const c of list) {
        for (const x of [c, ...c.replies]) {
          if (
            x.author === name &&
            x.authorId &&
            !x.authorId.startsWith("legacy-")
          ) {
            const a = {
              id: x.authorId,
              name,
              initials: x.initials || initialsOf(name),
            };
            this.authors.set(name, a);
            return a;
          }
        }
      }
    }
    const a = { id: newGuid(), name, initials: initialsOf(name) };
    this.authors.set(name, a);
    return a;
  }

  async add(
    pageId: string,
    text: string,
    name: string,
    at?: { x: number; y: number } | null,
  ): Promise<SlideComment> {
    await this.ready();
    const comment = makeComment(this.author(name), text, at);
    await this.apply({
      op: "batch",
      args: {
        ops: commentMutations({ v: 1, byPage: { [pageId]: [comment] } }),
      },
    });
    await this.load();
    return comment;
  }

  // Replies, resolve and delete are the host's comments door (`comments@1`,
  // engine ADR 1055), the same writes the host Comments panel makes; only a
  // new slide comment is written here, with the PowerPoint fields it keeps.

  async reply(
    pageId: string,
    id: string,
    text: string,
    name: string,
  ): Promise<CommentReply | null> {
    await this.ready();
    if (!this.forPage(pageId).some((c) => c.id === id)) return null;
    const author = this.author(name);
    const made = await this.host.comments.reply(id, text, {
      id: author.id,
      name: author.name,
      initials: author.initials,
    });
    if (!made.ok) throw new Error(`failed: ${made.reason}`);
    await this.load();
    return (
      this.forPage(pageId)
        .find((c) => c.id === id)
        ?.replies.find((r) => r.id === made.commentId) ?? {
        id: made.commentId,
        authorId: author.id,
        author: author.name,
        initials: author.initials,
        created: now(),
        text,
      }
    );
  }

  async setResolved(
    pageId: string,
    id: string,
    resolved: boolean,
  ): Promise<boolean> {
    await this.ready();
    if (!this.forPage(pageId).some((c) => c.id === id)) return false;
    const done = await this.host.comments.resolve(id, resolved);
    if (!done.ok) throw new Error(`failed: ${done.reason}`);
    await this.load();
    return true;
  }

  async remove(pageId: string, id: string, replyId?: string): Promise<boolean> {
    await this.ready();
    const c = this.forPage(pageId).find((x) => x.id === id);
    if (!c || (replyId && !c.replies.some((r) => r.id === replyId)))
      return false;
    const done = await this.host.comments.remove(replyId ?? id);
    if (!done.ok) throw new Error(`failed: ${done.reason}`);
    await this.load();
    return true;
  }

  dispose(): void {
    for (const d of this.disposers.splice(0)) d();
    this.listeners.clear();
  }

  private async rows(): Promise<EngineCommentRow[]> {
    return (await this.host.document.collection(
      "comments" as never,
    )) as unknown as EngineCommentRow[];
  }

  private async apply(mutation: Mutation): Promise<void> {
    const out = await this.host.document.mutate(mutation as never);
    if (!out.applied) throw new Error(String(out.error ?? "comment refused"));
  }

  /** Move an older deck's comments from the container part into the
   *  document; the part is emptied so this happens once. */
  private async migrate(): Promise<boolean> {
    if (!this.host.supports("storage.parts@1")) return false;
    const old = parseFile(await this.host.parts.read(COMMENTS_PART));
    if (!old || Object.values(old.byPage).every((l) => l.length === 0))
      return false;
    const ops = commentMutations(old);
    await this.apply({ op: "batch", args: { ops } });
    await this.host.parts.write(
      COMMENTS_PART,
      new TextEncoder().encode(JSON.stringify({ v: 1, byPage: {} })),
    );
    return true;
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}
