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

// A PDF's review comments, brought into the opened document (engine ADR 1055).
//
// The `pdf-import` wasm reads the annotations (`paged-pdf-annots`: Text,
// FreeText, the text markups, /IRT replies, review states) and answers a
// report: threads in page space, and one loss line per annotation type that is
// not a comment. This file turns the report into the engine's comment
// operations (`setPerson`, `insertCommentThread`, `replyComment`, one `batch`,
// one undo step) and applies them to the document the importer just opened.
// Nothing is dropped silently: the losses are logged, and a markup region
// (which has no item to belong to in a freshly imported page) is placed as a
// point at its top-left, said in the log.

import type { BundleHost } from "@paged-media/plugin-api";

import type { PdfMapper } from "../engine-loader";

/** The format name a PDF annotation's source carries. */
export const PDF_ANNOT_FORMAT = "pdf-annot";

/** One comment as `paged-pdf-annots` writes it (`paged_model::Comment`). */
export interface PdfComment {
  id: string;
  parent?: string;
  author?: string;
  date?: string;
  modified?: string;
  text: string;
  resolved?: boolean;
  review_state?: "accepted" | "rejected" | "cancelled" | "completed";
}

export type PdfAnchor =
  | { kind: "point"; at: [number, number] }
  | { kind: "region"; rect: [number, number, number, number] };

export interface PdfThread {
  id: string;
  pageIndex: number;
  anchor: PdfAnchor;
  subtype: string;
  comments: PdfComment[];
  /** The annotation dictionaries, per comment id. */
  source: [string, { format: string; data: string }][];
}

export interface PdfLoss {
  kind: string;
  count: number;
  /** 0-based. */
  pages: number[];
  reason: string;
}

export interface PdfCommentsReport {
  threads: PdfThread[];
  losses: PdfLoss[];
}

export interface Mutation {
  op: string;
  args: Record<string, unknown>;
}

/** The text of a loss line, as `paged comments` prints it. */
export function lossLine(l: PdfLoss): string {
  const pages = l.pages.map((p) => p + 1).join(", ");
  return `${l.count} x ${l.kind} (page ${pages}): ${l.reason}`;
}

/** A name's initials ("Ann Author" -> "AA"). */
function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** The id a PDF author (a bare `/T` string) has in the people list. */
export const personId = (name: string): string => `pdf-author:${name}`;

export interface CommentPlan {
  ops: Mutation[];
  /** Threads on pages the document does not have (a capped import). */
  skippedThreads: number;
  /** Markup regions placed as a point. */
  regionsAsPoints: number;
}

/**
 * The engine operations that put `report` into a document whose pages are
 * `pageIds` (in order; page `i` of the PDF is `pageIds[i]`): each author once,
 * each thread on its page, each reply in its thread. A comment keeps its
 * annotation (and the state annotations that name it) as its source, so a later
 * export can write it back untouched.
 */
export function commentMutations(
  report: PdfCommentsReport,
  pageIds: readonly string[],
): CommentPlan {
  const ops: Mutation[] = [];
  const people = new Set<string>();
  let skippedThreads = 0;
  let regionsAsPoints = 0;
  const spec = (c: PdfComment, t: PdfThread, resolved: boolean) => {
    const blobs = t.source.filter(([id]) => id === c.id).map(([, b]) => b);
    return {
      id: c.id,
      author: c.author ?? null,
      initials: c.author ? initialsOf(c.author) : null,
      date: c.date ?? null,
      modified: c.modified ?? null,
      text: c.text,
      resolved,
      person: c.author ? personId(c.author) : null,
      reviewState: c.review_state ?? null,
      // One dictionary per line; the first is the annotation itself.
      source: blobs.length
        ? {
            format: PDF_ANNOT_FORMAT,
            data: blobs.map((b) => b.data).join("\n"),
          }
        : null,
    };
  };
  for (const t of report.threads) {
    const page = pageIds[t.pageIndex];
    const root = t.comments[0];
    if (page === undefined || !root) {
      skippedThreads++;
      continue;
    }
    for (const c of t.comments) {
      if (!c.author || people.has(c.author)) continue;
      people.add(c.author);
      ops.push({
        op: "setPerson",
        args: {
          person: {
            id: personId(c.author),
            name: c.author,
            initials: initialsOf(c.author),
          },
        },
      });
    }
    let at: [number, number];
    if (t.anchor.kind === "point") at = t.anchor.at;
    else {
      at = [t.anchor.rect[0], t.anchor.rect[1]];
      regionsAsPoints++;
    }
    ops.push({
      op: "insertCommentThread",
      args: {
        anchor: { kind: "page", page, at },
        comment: spec(root, t, root.resolved === true),
      },
    });
    for (const r of t.comments.slice(1)) {
      ops.push({
        op: "replyComment",
        args: { parentId: root.id, comment: spec(r, t, false) },
      });
    }
  }
  return { ops, skippedThreads, regionsAsPoints };
}

/**
 * Read the comments of `bytes` through the wasm `mapper` and put them into the
 * open document. Never throws (the import has already succeeded); says what
 * it did and what it left out in the log. Returns the number of threads
 * imported.
 */
export async function importPdfComments(
  host: BundleHost,
  mapper: PdfMapper | null,
  bytes: Uint8Array,
  logPrefix: string,
): Promise<number> {
  try {
    const report = mapper?.comments?.(bytes) ?? null;
    if (!report) return 0;
    for (const l of report.losses)
      host.log.warn(`${logPrefix}: comments not imported — ${lossLine(l)}`);
    if (report.threads.length === 0) return 0;
    const pages = (await host.document.collection("pages")) as Array<{
      selfId: string;
    }>;
    const plan = commentMutations(
      report,
      pages.map((p) => p.selfId),
    );
    if (plan.skippedThreads > 0)
      host.log.warn(
        `${logPrefix}: ${plan.skippedThreads} comment thread(s) are on pages that were not imported`,
      );
    if (plan.regionsAsPoints > 0)
      host.log.info(
        `${logPrefix}: ${plan.regionsAsPoints} text-markup comment(s) placed at the top-left of the marked text`,
      );
    if (plan.ops.length === 0) return 0;
    const out = await host.document.mutate({
      op: "batch",
      args: { ops: plan.ops },
    } as never);
    if (!out.applied) {
      host.log.warn(
        `${logPrefix}: comments not imported — ${String(out.error ?? "refused")}`,
      );
      return 0;
    }
    const imported = report.threads.length - plan.skippedThreads;
    host.log.info(`${logPrefix}: imported ${imported} comment thread(s)`);
    return imported;
  } catch (err) {
    host.log.warn(`${logPrefix}: comments not imported — ${String(err)}`);
    return 0;
  }
}
