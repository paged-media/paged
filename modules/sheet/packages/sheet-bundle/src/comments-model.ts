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
// A thread the panel starts on a cell is not supported (the panel starts
// item, page and text threads); a plain note (no thread) is not projected.
// When both sides changed the same text since the last reconcile, the
// workbook wins. A cell whose frame is deleted becomes orphaned by the
// engine's own rule; the workbook keeps the thread.

import type { BundleHost, ElementId } from "@paged-media/plugin-api";

import { cellOfA1, parseBinding } from "../../sheet-host-model/src";
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
): Plan {
  const out: Plan = { engine: [], workbook: [], replies: [] };
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
    return { changed, swaps };
  }

  async function once(): Promise<void> {
    const engine = deps.engine();
    if (!engine?.listThreads || !engine.listSheets) return;
    const wb = readWorkbook(engine);
    if (wb.length === 0 && snap.size === 0) {
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
    const p = plan(wb, current, snap, () => frameList);
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

  return {
    sync,
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
