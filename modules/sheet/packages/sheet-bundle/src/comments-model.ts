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

// An Excel workbook's threaded comments in the host's one comment model
// (engine ADR 1055; sheet ADR 528 for the workbook side). A thread on a cell
// is an engine comment thread anchored `Cell { item, address }`: `item` is
// the sheet frame that shows the cell, `address` is `Sheet1!B3`. The comment
// ids ARE the workbook's GUIDs, so the mapping between the two models needs
// no table of its own and survives a reload of either side.
//
// The workbook (the engine session, saved as the document's container part)
// is the truth for the xlsx; the document's threads are what the host's
// Comments panel reads and writes. `sync` reconciles the two three ways
// against the snapshot of the last reconcile:
//
//   workbook -> panel   a thread the workbook has and the document lacks is
//                       projected (on open, on import); a text or resolved
//                       state that moved in the workbook is edited in the
//                       document; a comment deleted in the workbook is
//                       deleted in the document.
//   panel -> workbook   a reply, an edit, a resolve or reopen, a delete made
//                       in the panel is written to the workbook through the
//                       session's thread doors, so saving writes it.
//
// A thread started on a cell through the comments door (the "New comment"
// command) has no workbook twin yet: the next reconcile writes it into the
// workbook (`addThread`, its replies after it) and swaps the document's thread
// for one carrying the workbook's ids, so both sides name it alike. The host
// panel itself starts item, page and text threads, not cell ones. A plain note
// (no thread) is not projected.
// When both sides changed the same text since the last reconcile, the
// workbook wins. A cell whose frame is deleted becomes orphaned by the
// engine's own rule; the workbook keeps the thread.

import type {
  BundleHost,
  CommentAuthor,
  ElementId,
} from "@paged-media/plugin-api";

import {
  cellOfA1,
  HEADING_INDEX,
  parseBinding,
  type LoweredContent,
} from "../../sheet-host-model/src";
import type { CellThreadInfo, SheetEngine, ThreadAuthor } from "./engine";

/** The format name a projected comment's source carries. */
export const SOURCE_FORMAT = "xlsx";

/** One comment of the workbook, flattened with where it stands. */
export interface WbComment {
  id: string;
  /** The thread's root id; the comment's own id for a root. */
  rootId: string;
  sheet: number;
  sheetName: string;
  row: number;
  col: number;
  personId: string;
  displayName: string;
  userId: string;
  providerId: string;
  timestamp: string;
  text: string;
  /** Resolved; meaningful on a root. */
  done: boolean;
}

/** One row of the engine's `comments` collection, as far as sheet reads it. */
export interface EngineRow {
  id: string;
  parentId?: string | null;
  threadId?: string | null;
  author?: string | null;
  initials?: string | null;
  date?: string | null;
  text: string;
  resolved: boolean;
  person?: string | null;
  orphaned?: boolean;
  anchor?:
    { kind: "cell"; item: string; address: string } | { kind: string } | null;
  source?: { format: string; data: string } | null;
}

/** A sheet frame and the range it shows. */
export interface FrameRange {
  id: string;
  sheet: string;
  range: { r0: number; c0: number; r1: number; c1: number } | null;
}

/** What the last reconcile left standing on both sides, by comment id. */
export type Snapshot = Map<string, { text: string; done: boolean }>;

export type Mutation = { op: string; args: Record<string, unknown> };

/** A change to write into the workbook. */
export type WbAction =
  | { kind: "edit"; sheet: number; id: string; text: string }
  | { kind: "done"; sheet: number; row: number; col: number; done: boolean }
  | { kind: "delete"; sheet: number; id: string };

export interface Plan {
  engine: Mutation[];
  workbook: WbAction[];
  /** Replies written in the panel that the workbook does not have yet. */
  replies: Array<{ row: EngineRow; root: WbComment }>;
  /** Cell threads started in the document that the workbook does not have. */
  starts: Array<{
    row: EngineRow;
    sheet: number;
    sheetName: string;
    r: number;
    c: number;
    item: string;
    replies: EngineRow[];
  }>;
}

// -- addresses ---------------------------------------------------------------

/** `A`, `B`, ... `AA` for a zero-based column. */
export function columnName(col: number): string {
  let n = col + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** A sheet name as a formula reference writes it: quoted when it has to be. */
export function sheetRef(name: string): string {
  const plain = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name);
  const looksLikeCell =
    /^[A-Za-z]{1,3}[0-9]+$/.test(name) || /^R\d*C\d*$/i.test(name);
  return plain && !looksLikeCell ? name : `'${name.replaceAll("'", "''")}'`;
}

/** The thread anchor's address of a cell: `Sheet1!B3`. */
export function cellAddress(
  sheetName: string,
  row: number,
  col: number,
): string {
  return `${sheetRef(sheetName)}!${columnName(col)}${row + 1}`;
}

/** The sheet name and zero-based cell an address names, or null. */
export function parseAddress(
  address: string,
): { sheet: string; row: number; col: number } | null {
  const bang = address.lastIndexOf("!");
  if (bang <= 0) return null;
  let sheet = address.slice(0, bang);
  if (sheet.startsWith("'") && sheet.endsWith("'") && sheet.length >= 2) {
    sheet = sheet.slice(1, -1).replaceAll("''", "'");
  }
  const cell = cellOfA1(address.slice(bang + 1));
  return cell ? { sheet, ...cell } : null;
}

/** The corners of an A1 range (`B2:D9`, `C3`), or null. */
export function parseRange(
  range: string,
): { r0: number; c0: number; r1: number; c1: number } | null {
  const body = range.includes("!")
    ? range.slice(range.lastIndexOf("!") + 1)
    : range;
  const [a, b] = body.split(":");
  const p = cellOfA1(a ?? "");
  const q = b === undefined ? p : cellOfA1(b);
  if (!p || !q) return null;
  return {
    r0: Math.min(p.row, q.row),
    c0: Math.min(p.col, q.col),
    r1: Math.max(p.row, q.row),
    c1: Math.max(p.col, q.col),
  };
}

/** The frame a thread on this cell is pinned to: one showing the cell, else
 *  the first frame of the sheet; null when no frame shows the sheet. */
export function frameFor(
  frames: readonly FrameRange[],
  sheetName: string,
  row: number,
  col: number,
): string | null {
  const of = frames.filter((f) => f.sheet === sheetName);
  const showing = of.find(
    (f) =>
      f.range &&
      row >= f.range.r0 &&
      row <= f.range.r1 &&
      col >= f.range.c0 &&
      col <= f.range.c1,
  );
  return (showing ?? of[0])?.id ?? null;
}

// -- where an address points ----------------------------------------------------

/** What the comment-anchor door answers: `[x, y, w, h]` in points from the
 *  frame's top-left, and the address as the user knows it. */
export interface AnchorGeometry {
  rect: [number, number, number, number];
  label: string;
}

/** A sheet frame as the resolver reads it: the sheet it shows, the table the
 *  page holds (tracks in order: printed headings, frozen rows, the window)
 *  and the room the frame's content box gives it. */
export interface ResolvableFrame {
  sheetName: string;
  content: LoweredContent;
  /** The content box (pt); a cell below or right of it is not shown. */
  box?: { widthPt: number; heightPt: number };
  /** False for a frame that continues a chain: its rows start elsewhere. */
  head?: boolean;
}

/**
 * The rectangle of `address` in a frame's table, in points from its top-left.
 * The table's own tracks are the truth: hidden rows and columns are not in
 * it (they take no room), a frozen row sits where the table puts it, the
 * printed headings take their strip, and a cell outside the window the
 * table shows is simply absent. A range answers the rectangle of its cells
 * that are shown. Null when the address is not `Sheet!A1[:B2]`, names
 * another sheet than the frame's, or no cell of it is shown.
 */
export function anchorGeometry(
  address: string,
  frame: ResolvableFrame,
): AnchorGeometry | null {
  const bang = address.lastIndexOf("!");
  if (bang <= 0 || frame.head === false) return null;
  const first = address.slice(bang + 1).split(":")[0] ?? "";
  const parsed = parseAddress(`${address.slice(0, bang)}!${first}`);
  const range = parseRange(address);
  if (!parsed || !range || parsed.sheet !== frame.sheetName) return null;

  let x = 0;
  let x0: number | null = null;
  let x1 = 0;
  for (const col of frame.content.cols) {
    if (
      col.index !== HEADING_INDEX &&
      col.index >= range.c0 &&
      col.index <= range.c1
    ) {
      x0 ??= x;
      x1 = x + col.widthPt;
    }
    x += col.widthPt;
  }
  let y = 0;
  let y0: number | null = null;
  let y1 = 0;
  for (const row of frame.content.rows) {
    if (
      row.index !== HEADING_INDEX &&
      row.index >= range.r0 &&
      row.index <= range.r1
    ) {
      y0 ??= y;
      y1 = y + row.heightPt;
    }
    y += row.heightPt;
  }
  if (x0 === null || y0 === null) return null;
  // Beyond the content box the cell is not on the page (the engine flows
  // the rest to the next frame of a chain, or the window ends there).
  if (frame.box && (x0 >= frame.box.widthPt || y0 >= frame.box.heightPt))
    return null;
  return {
    rect: [x0, y0, x1 - x0, y1 - y0],
    label: address,
  };
}

// -- times and people ---------------------------------------------------------

const DT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?$/;

/** Excel's `dT` (`YYYY-MM-DDThh:mm:ss.ff`) of an ISO time; a time already
 *  in that form is kept as it is. */
export function toDt(date?: string | null, now: () => Date = () => new Date()) {
  if (date && DT.test(date)) return date;
  let d = date ? new Date(date) : now();
  if (Number.isNaN(d.getTime())) d = now();
  const iso = d.toISOString();
  return `${iso.slice(0, 19)}.${iso.slice(20, 22)}`;
}

/** Up to two initials of a name. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

const norm = (s: string) => s.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

// -- reading the workbook ------------------------------------------------------

/** Every threaded comment of the workbook, flattened. */
export function readWorkbook(engine: SheetEngine): WbComment[] {
  const out: WbComment[] = [];
  if (!engine.listThreads) return out;
  for (const sheet of engine.listSheets()) {
    let threads: CellThreadInfo[];
    try {
      threads = engine.listThreads(sheet.id);
    } catch {
      return out; // a wasm that predates the thread doors
    }
    for (const t of threads) {
      const root = t.comments.find((c) => !c.parentId);
      if (!root) continue;
      for (const c of t.comments) {
        const name = c.displayName || c.userId || "";
        out.push({
          id: c.id,
          rootId: c.parentId || c.id,
          sheet: sheet.id,
          sheetName: sheet.name,
          row: t.row,
          col: t.col,
          personId: c.personId,
          displayName: name,
          userId: c.userId || name,
          providerId: c.providerId || "None",
          timestamp: c.timestamp,
          text: c.text,
          done: !c.parentId && (c.done || t.resolved),
        });
      }
    }
  }
  return out;
}

const isCellRoot = (r: EngineRow) =>
  !r.parentId &&
  r.anchor?.kind === "cell" &&
  r.source?.format === SOURCE_FORMAT;

/** A cell thread's root that the workbook has not taken yet: no source. */
const isStartedRoot = (r: EngineRow) =>
  !r.parentId &&
  !r.orphaned &&
  r.anchor?.kind === "cell" &&
  !r.source &&
  typeof (r.anchor as { address?: unknown }).address === "string";

// -- the plan --------------------------------------------------------------------

const specOf = (c: WbComment) => ({
  id: c.id,
  author: c.displayName,
  initials: initialsOf(c.displayName),
  date: c.timestamp,
  text: c.text,
  person: c.personId || null,
  source: {
    format: SOURCE_FORMAT,
    data: JSON.stringify({
      userId: c.userId,
      providerId: c.providerId,
      timestamp: c.timestamp,
    }),
  },
});

/**
 * What to change on each side so the two agree.

 */
export function plan(
  wb: readonly WbComment[],
  rows: readonly EngineRow[],
  snap: Snapshot,
  frames: () => readonly FrameRange[],
  sheets: ReadonlyArray<{ id: number; name: string }> = [],
): Plan {
  const out: Plan = { engine: [], workbook: [], replies: [], starts: [] };
  const w = new Map(wb.map((c) => [c.id, c]));
  const eRoots = new Map(rows.filter(isCellRoot).map((r) => [r.id, r]));
  const eReplies = new Map(
    rows
      .filter((r) => r.parentId && eRoots.has(r.parentId))
      .map((r) => [r.id, r]),
  );
  const people = new Set<string>();
  const person = (c: WbComment) => {
    if (!c.personId || people.has(c.personId)) return;
    people.add(c.personId);
    out.engine.push({
      op: "setPerson",
      args: {
        person: {
          id: c.personId,
          name: c.displayName,
          initials: initialsOf(c.displayName),
        },
      },
    });
  };

  const gone = new Set<string>(); // roots deleted on either side
  const inEngine = new Set<string>(eRoots.keys()); // roots there after this plan
  const doneAfter = new Map<string, boolean>();
  const reopened = new Set<string>(); // roots a projected reply may reopen
  const resolves: Mutation[] = [];
  let frameList: readonly FrameRange[] | null = null;

  const rootIds = new Set<string>([
    ...[...w.values()].filter((c) => c.id === c.rootId).map((c) => c.id),
    ...eRoots.keys(),
  ]);
  for (const id of rootIds) {
    const wc = w.get(id);
    const er = eRoots.get(id);
    const s = snap.get(id);
    if (wc && er) {
      syncText(wc, er, s);
      const eDone = er.resolved;
      let done = wc.done;
      if (wc.done !== eDone) {
        if (s === undefined || wc.done !== s.done) {
          out.engine.push({
            op: "resolveComment",
            args: { commentId: id, resolved: wc.done },
          });
        } else {
          out.workbook.push({
            kind: "done",
            sheet: wc.sheet,
            row: wc.row,
            col: wc.col,
            done: eDone,
          });
          done = eDone;
        }
      }
      doneAfter.set(id, done);
    } else if (wc && !er) {
      if (s) {
        out.workbook.push({ kind: "delete", sheet: wc.sheet, id });
        gone.add(id);
      } else {
        frameList ??= frames();
        const item = frameFor(frameList, wc.sheetName, wc.row, wc.col);
        if (!item) continue; // no frame shows this sheet (yet)
        person(wc);
        out.engine.push({
          op: "insertCommentThread",
          args: {
            anchor: {
              kind: "cell",
              item,
              address: cellAddress(wc.sheetName, wc.row, wc.col),
            },
            comment: specOf(wc),
          },
        });
        inEngine.add(id);
        reopened.add(id);
        if (wc.done) resolves.push(resolveOp(id, true));
        doneAfter.set(id, wc.done);
      }
    } else if (!wc && er) {
      if (s) {
        out.engine.push({ op: "deleteComment", args: { commentId: id } });
        gone.add(id);
        inEngine.delete(id);
      }
    }
  }

  // Cell threads started in the document (no workbook source): the workbook
  // takes them, unless it already has a thread on that cell or no sheet of
  // the workbook carries the address's name.
  const taken = new Set(
    [...w.values()].map((c) => `${c.sheet}:${c.row}:${c.col}`),
  );
  for (const row of rows) {
    if (!isStartedRoot(row) || gone.has(row.id)) continue;
    const a = parseAddress((row.anchor as { address: string }).address);
    const sheet = a && sheets.find((x) => x.name === a.sheet);
    if (!a || !sheet) continue;
    const key = `${sheet.id}:${a.row}:${a.col}`;
    if (taken.has(key)) continue;
    taken.add(key);
    out.starts.push({
      row,
      sheet: sheet.id,
      sheetName: sheet.name,
      r: a.row,
      c: a.col,
      item: (row.anchor as { item: string }).item,
      replies: rows.filter((x) => x.parentId === row.id),
    });
  }

  const replyIds = new Set<string>([
    ...[...w.values()].filter((c) => c.id !== c.rootId).map((c) => c.id),
    ...eReplies.keys(),
  ]);
  for (const id of replyIds) {
    const wc = w.get(id);
    const er = eReplies.get(id);
    const s = snap.get(id);
    const root = wc?.rootId ?? er?.parentId ?? "";
    if (gone.has(root)) continue;
    if (wc && er) {
      syncText(wc, er, s);
    } else if (wc && !er) {
      if (s) {
        out.workbook.push({ kind: "delete", sheet: wc.sheet, id });
      } else if (inEngine.has(root)) {
        person(wc);
        out.engine.push({
          op: "replyComment",
          args: { parentId: root, comment: specOf(wc) },
        });
        reopened.add(root);
      }
    } else if (!wc && er) {
      if (s) {
        out.engine.push({ op: "deleteComment", args: { commentId: id } });
      } else {
        const rc = w.get(root);
        if (rc) out.replies.push({ row: er, root: rc });
      }
    }
  }

  // A reply joins a resolved thread open; the thread stays resolved here.
  for (const root of reopened) {
    if (
      doneAfter.get(root) &&
      !resolves.some((r) => r.args.commentId === root)
    ) {
      resolves.push(resolveOp(root, true));
    }
  }
  out.engine.push(...resolves);
  return out;

  function resolveOp(commentId: string, resolved: boolean): Mutation {
    return { op: "resolveComment", args: { commentId, resolved } };
  }

  function syncText(
    wc: WbComment,
    er: EngineRow,
    s: { text: string; done: boolean } | undefined,
  ) {
    const wt = norm(wc.text);
    const et = norm(er.text);
    if (wt === et) return;
    if (s === undefined || wt !== s.text) {
      out.engine.push({
        op: "editComment",
        args: { commentId: wc.id, text: wc.text, date: null },
      });
    } else {
      out.workbook.push({
        kind: "edit",
        sheet: wc.sheet,
        id: wc.id,
        text: er.text,
      });
    }
  }
}

/** The snapshot of two agreeing sides: every comment both hold. */
export function snapshotOf(
  wb: readonly WbComment[],
  rows: readonly EngineRow[],
): Snapshot {
  const roots = new Set(rows.filter(isCellRoot).map((r) => r.id));
  const inE = new Set(
    rows
      .filter((r) => roots.has(r.id) || (r.parentId && roots.has(r.parentId)))
      .map((r) => r.id),
  );
  const snap: Snapshot = new Map();
  for (const c of wb) {
    if (inE.has(c.id)) snap.set(c.id, { text: norm(c.text), done: c.done });
  }
  return snap;
}

// -- the controller ------------------------------------------------------------------

export interface SheetCommentsDeps {
  host: BundleHost;
  /** The session's engine, or null before a workbook is loaded. */
  engine(): SheetEngine | null;
  /** A document write the session attributes to itself. */
  ownWrite<T>(write: () => Promise<T>): Promise<T>;
  /** The workbook changed: queue its save. */
  edited(): void;
  /** Ids for new workbook comments (a test fixes them). */
  seed?(): number;
  now?(): Date;
}

export interface SheetComments {
  /** Reconcile now (coalesced with one in flight). */
  sync(): Promise<void>;
  /** Start a thread on a workbook cell through the comments door and have
   *  the workbook take it. `prefer` is the frame to pin it to (the entered
   *  one) when it shows the sheet. A cell that has a thread takes the text
   *  as a reply. */
  startThread(at: {
    sheet: number;
    row: number;
    col: number;
    text: string;
    prefer?: string | null;
    author?: CommentAuthor;
  }): Promise<{ ok: true; threadId: string } | { ok: false; reason: string }>;
  /** A workbook was restored with the document: forget the last reconcile.
   *  (An import keeps it, so the threads of the workbook it replaces are
   *  deleted from the document.) */
  reset(): void;
  dispose(): void;
}

export function createSheetComments(deps: SheetCommentsDeps): SheetComments {
  const { host } = deps;
  let snap: Snapshot = new Map();
  let running: Promise<void> | null = null;
  let again = false;
  let disposed = false;
  // A workbook without threads and a document without theirs: nothing can
  // appear on either side until a workbook loads, so document changes cost
  // nothing here (the engine is not asked, the comments are not read).
  let idle = false;
  // The next reconcile reads the document even when both sides were idle: a
  // thread was started in the document.
  let probe = false;

  const rows = async (): Promise<EngineRow[]> => {
    const all: unknown = await host.document.collection("comments" as never);
    return Array.isArray(all) ? (all as EngineRow[]) : [];
  };

  async function frames(): Promise<FrameRange[]> {
    const out: FrameRange[] = [];
    let roots: Awaited<ReturnType<BundleHost["document"]["tree"]>>;
    try {
      roots = await host.document.tree();
    } catch {
      return out;
    }
    const ids: string[] = [];
    const walk = (nodes: typeof roots) => {
      for (const n of nodes) {
        if (n.id?.kind === "textFrame" && typeof n.id.id === "string")
          ids.push(n.id.id);
        if (n.children) walk(n.children);
      }
    };
    walk(roots);
    for (const id of ids) {
      try {
        const b = parseBinding(
          await host.document.getMetadata?.({
            kind: "textFrame",
            id,
          } as ElementId),
        );
        if (b)
          out.push({
            id,
            sheet: b.data.sheet,
            range: parseRange(b.data.range),
          });
      } catch {
        /* unreadable metadata is not a binding */
      }
    }
    return out;
  }

  async function apply(ops: Mutation[]): Promise<boolean> {
    if (ops.length === 0) return true;
    const m = { op: "batch", args: { ops } } as unknown as Parameters<
      BundleHost["document"]["mutate"]
    >[0];
    const res = await deps.ownWrite(() => host.document.mutate(m));
    if (!res.applied) {
      host.log.warn("sheet comments: the document refused", res.error);
      return false;
    }
    return true;
  }

  const author = (r: EngineRow): ThreadAuthor => {
    const name = r.author?.trim() || "Unknown";
    return { displayName: name, userId: r.person || name, providerId: "None" };
  };

  /** Write the plan's workbook side; true when the workbook changed. */
  function writeWorkbook(
    engine: SheetEngine,
    p: Plan,
  ): { changed: boolean; swaps: Mutation[] } {
    let changed = false;
    const swaps: Mutation[] = [];
    for (const a of p.workbook) {
      try {
        if (a.kind === "edit") engine.editThreadComment!(a.sheet, a.id, a.text);
        else if (a.kind === "done")
          engine.setThreadDone!(a.sheet, a.row, a.col, a.done);
        else engine.deleteThreadComment!(a.sheet, a.id);
        changed = true;
      } catch (err) {
        host.log.warn("sheet comments: the workbook refused", err);
      }
    }
    for (const { row, root } of p.replies) {
      try {
        const id = engine.replyThread!(
          root.sheet,
          root.row,
          root.col,
          author(row),
          toDt(row.date, deps.now),
          row.text,
          deps.seed?.() ?? Math.floor(Math.random() * 0xffffffff),
        );
        changed = true;
        // The panel minted its own id for the reply: the workbook's takes
        // its place, so both sides name the comment alike.
        swaps.push(
          { op: "deleteComment", args: { commentId: row.id } },
          {
            op: "replyComment",
            args: {
              parentId: root.id,
              comment: {
                id,
                author: row.author ?? null,
                initials: row.initials ?? null,
                date: row.date ?? null,
                text: row.text,
                person: row.person ?? null,
                source: {
                  format: SOURCE_FORMAT,
                  data: JSON.stringify({
                    userId: author(row).userId,
                    providerId: "None",
                    timestamp: toDt(row.date, deps.now),
                  }),
                },
              },
            },
          },
        );
      } catch (err) {
        host.log.warn("sheet comments: the workbook refused a reply", err);
      }
    }
    for (const st of p.starts) {
      try {
        const a = author(st.row);
        const when = toDt(st.row.date, deps.now);
        const rootId = engine.addThread!(
          st.sheet,
          st.r,
          st.c,
          a,
          when,
          st.row.text,
          deps.seed?.() ?? Math.floor(Math.random() * 0xffffffff),
        );
        changed = true;
        const source = {
          format: SOURCE_FORMAT,
          data: JSON.stringify({
            userId: a.userId,
            providerId: "None",
            timestamp: when,
          }),
        };
        const comment = (id: string, r: EngineRow) => ({
          id,
          author: r.author ?? null,
          initials: r.initials ?? null,
          date: r.date ?? null,
          text: r.text,
          person: r.person ?? null,
          source,
        });
        // The document's thread is replaced by one with the workbook's ids.
        swaps.push(
          { op: "deleteComment", args: { commentId: st.row.id } },
          {
            op: "insertCommentThread",
            args: {
              anchor: {
                kind: "cell",
                item: st.item,
                address: cellAddress(st.sheetName, st.r, st.c),
              },
              comment: comment(rootId, st.row),
            },
          },
        );
        for (const reply of st.replies) {
          const rid = engine.replyThread!(
            st.sheet,
            st.r,
            st.c,
            author(reply),
            toDt(reply.date, deps.now),
            reply.text,
            deps.seed?.() ?? Math.floor(Math.random() * 0xffffffff),
          );
          swaps.push({
            op: "replyComment",
            args: { parentId: rootId, comment: comment(rid, reply) },
          });
        }
        if (st.row.resolved) {
          engine.setThreadDone!(st.sheet, st.r, st.c, true);
          swaps.push({
            op: "resolveComment",
            args: { commentId: rootId, resolved: true },
          });
        }
      } catch (err) {
        host.log.warn("sheet comments: the workbook refused a new thread", err);
      }
    }
    return { changed, swaps };
  }

  async function once(): Promise<void> {
    const engine = deps.engine();
    if (!engine?.listThreads || !engine.listSheets) return;
    const wb = readWorkbook(engine);
    const probing = probe;
    probe = false;
    if (wb.length === 0 && snap.size === 0 && !probing) {
      idle = true;
      return;
    }
    idle = false;
    const current = await rows();
    // The frames are read only when a thread has none in the document yet.
    const placed = new Set(current.filter(isCellRoot).map((r) => r.id));
    const frameList = wb.some((c) => c.id === c.rootId && !placed.has(c.id))
      ? await frames()
      : [];
    const p = plan(wb, current, snap, () => frameList, engine.listSheets());
    const w = writeWorkbook(engine, p);
    if (w.changed) deps.edited();
    const ok = await apply([...p.engine, ...w.swaps]);
    if (!ok) return;
    if (p.engine.length === 0 && w.swaps.length === 0 && !w.changed) {
      snap = snapshotOf(wb, current);
      idle = wb.length === 0 && snap.size === 0;
      return;
    }
    const after = readWorkbook(engine);
    snap = snapshotOf(after, await rows());
    idle = after.length === 0 && snap.size === 0;
  }

  function sync(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          try {
            await once();
          } catch (err) {
            host.log.debug("sheet comments: sync failed", err);
          }
        } while (again && !disposed);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  const sub = host.document.onDidChange(() => {
    if (!idle) void sync();
  });

  async function startThread(at: {
    sheet: number;
    row: number;
    col: number;
    text: string;
    prefer?: string | null;
    author?: CommentAuthor;
  }): Promise<{ ok: true; threadId: string } | { ok: false; reason: string }> {
    const engine = deps.engine();
    const sheet = engine?.listSheets().find((x) => x.id === at.sheet);
    if (!engine || !sheet) return { ok: false, reason: "no workbook" };
    if (!host.supports("comments@1")) {
      return { ok: false, reason: "the host has no comments door" };
    }
    const text = at.text.trim();
    if (!text) return { ok: false, reason: "no text" };
    const existing = readWorkbook(engine).find(
      (c) =>
        c.id === c.rootId &&
        c.sheet === at.sheet &&
        c.row === at.row &&
        c.col === at.col,
    );
    let r: Awaited<ReturnType<BundleHost["comments"]["startThread"]>>;
    let threadId: string;
    if (existing) {
      // One thread per cell, as in Excel: the text joins it.
      const rep = await host.comments.reply(existing.id, text, at.author);
      if (!rep.ok) return rep;
      threadId = existing.id;
    } else {
      const list = await frames();
      const item =
        at.prefer &&
        list.some((f) => f.id === at.prefer && f.sheet === sheet.name)
          ? at.prefer
          : frameFor(list, sheet.name, at.row, at.col);
      if (!item) return { ok: false, reason: "no frame shows this sheet" };
      r = await host.comments.startThread(
        {
          kind: "cell",
          item,
          address: cellAddress(sheet.name, at.row, at.col),
        },
        text,
        at.author,
      );
      if (!r.ok) return r;
      threadId = r.threadId;
    }
    probe = true;
    idle = false;
    await sync();
    return { ok: true, threadId };
  }

  return {
    sync,
    startThread,
    reset() {
      snap = new Map();
      idle = false;
    },
    dispose() {
      disposed = true;
      sub.dispose();
    },
  };
}
