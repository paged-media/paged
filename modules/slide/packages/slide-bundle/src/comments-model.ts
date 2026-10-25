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

// A deck's comments (ADR 711, amendment 2026-10-25): PowerPoint's threaded
// comments and its legacy ones, kept per slide in this plugin's container
// part `comments/comments.json` (ADR 703), keyed by the page each slide
// opened as. The engine's own notes are anchored in text, while a slide
// comment sits on the slide or on a shape, so they live here.
//
// The importer writes the part from the deck; the Comments panel and the
// typed commands change it; export hands each page's list to the engine,
// which writes back only the slides whose comments changed. Not undoable
// (container parts are outside the undo log, like the rest of ADR 703's
// deck-level parts). Pure functions do the edits; the store reads and
// writes the part.

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
export function withComment(
  file: CommentsFile,
  pageId: string,
  comment: SlideComment,
): CommentsFile {
  const list = file.byPage[pageId] ?? [];
  return { ...file, byPage: { ...file.byPage, [pageId]: [...list, comment] } };
}

/** A comment written now by `author`. */
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
function mapComment(
  file: CommentsFile,
  pageId: string,
  id: string,
  change: (c: SlideComment) => SlideComment | null,
): CommentsFile {
  const list = file.byPage[pageId];
  if (!list?.some((c) => c.id === id)) return file;
  const next = list.flatMap((c) => {
    if (c.id !== id) return [c];
    const out = change(c);
    return out ? [out] : [];
  });
  return { ...file, byPage: { ...file.byPage, [pageId]: next } };
}

export function withReply(
  file: CommentsFile,
  pageId: string,
  id: string,
  author: Author,
  text: string,
): { file: CommentsFile; reply: CommentReply | null } {
  const reply: CommentReply = {
    id: newGuid(),
    authorId: author.id,
    author: author.name,
    initials: author.initials,
    created: now(),
    text,
  };
  const next = mapComment(file, pageId, id, (c) => ({
    ...c,
    replies: [...c.replies, reply],
  }));
  return { file: next, reply: next === file ? null : reply };
}

export function withStatus(
  file: CommentsFile,
  pageId: string,
  id: string,
  resolved: boolean,
): CommentsFile {
  return mapComment(file, pageId, id, (c) => ({
    ...c,
    status: resolved ? "resolved" : null,
  }));
}

/** `file` without comment `id` (or only without its reply `replyId`). */
export function withoutComment(
  file: CommentsFile,
  pageId: string,
  id: string,
  replyId?: string,
): CommentsFile {
  return mapComment(file, pageId, id, (c) =>
    replyId
      ? { ...c, replies: c.replies.filter((r) => r.id !== replyId) }
      : null,
  );
}

/** The storage key of the name new comments are written under. */
export const AUTHOR_KEY = "commentAuthor";

/**
 * The deck's comments, kept current: read from the part on every document
 * open, written back on every change. Pages are addressed by id, so a slide
 * keeps its comments wherever it moves; a deleted slide's comments are not
 * exported (export lists the pages there are).
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
    void this.load();
  }

  /** Whether the open document keeps comments (a deck imported with them). */
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

  /** Read the part again. */
  load(): Promise<void> {
    const job = (async () => {
      if (!this.host.supports("storage.parts@1")) {
        this.file = null;
      } else {
        try {
          this.file = parseFile(await this.host.parts.read(COMMENTS_PART));
        } catch {
          this.file = null; // no document open
        }
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

  /** Replace the file (the importer's), and write it. */
  async replace(file: CommentsFile): Promise<void> {
    await this.write(file);
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
    await this.write(withComment(this.base(), pageId, comment));
    return comment;
  }

  async reply(
    pageId: string,
    id: string,
    text: string,
    name: string,
  ): Promise<CommentReply | null> {
    await this.ready();
    const out = withReply(this.base(), pageId, id, this.author(name), text);
    if (out.reply) await this.write(out.file);
    return out.reply;
  }

  async setResolved(
    pageId: string,
    id: string,
    resolved: boolean,
  ): Promise<boolean> {
    await this.ready();
    const before = this.base();
    const next = withStatus(before, pageId, id, resolved);
    if (next === before) return false;
    await this.write(next);
    return true;
  }

  async remove(pageId: string, id: string, replyId?: string): Promise<boolean> {
    await this.ready();
    const before = this.base();
    const next = withoutComment(before, pageId, id, replyId);
    if (next === before) return false;
    await this.write(next);
    return true;
  }

  dispose(): void {
    for (const d of this.disposers.splice(0)) d();
    this.listeners.clear();
  }

  private base(): CommentsFile {
    return this.file ?? { v: 1, byPage: {} };
  }

  private async write(file: CommentsFile): Promise<void> {
    if (!this.host.supports("storage.parts@1"))
      throw new Error(
        "this host keeps no container parts, so comments cannot be kept",
      );
    await this.host.parts.write(
      COMMENTS_PART,
      new TextEncoder().encode(JSON.stringify(file)),
    );
    this.file = file;
    this.emit();
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}
