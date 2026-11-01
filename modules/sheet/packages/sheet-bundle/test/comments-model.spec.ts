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

// [sheet.comments.threads] Excel threaded comments in the host's one comment
// model (engine ADR 1055; sheet ADR 528): the pure reconcile plan, and the
// controller against an in-memory workbook and an in-memory comment store.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";

import {
  cellAddress,
  createSheetComments,
  frameFor,
  parseAddress,
  parseRange,
  plan,
  toDt,
  type EngineRow,
  type FrameRange,
  type Mutation,
  type WbComment,
} from "../src/comments-model";
import type { CellThreadInfo, SheetEngine, ThreadAuthor } from "../src/engine";

describe("addresses", () => {
  it("writes and reads Sheet!A1 with quoting", () => {
    expect(cellAddress("Sheet1", 2, 1)).toBe("Sheet1!B3");
    expect(cellAddress("My Sheet", 0, 0)).toBe("'My Sheet'!A1");
    expect(cellAddress("it's", 0, 27)).toBe("'it''s'!AB1");
    expect(cellAddress("A1", 0, 0)).toBe("'A1'!A1");
    expect(parseAddress("Sheet1!B3")).toEqual({
      sheet: "Sheet1",
      row: 2,
      col: 1,
    });
    expect(parseAddress("'it''s'!AB1")).toEqual({
      sheet: "it's",
      row: 0,
      col: 27,
    });
    expect(parseAddress("nonsense")).toBeNull();
  });

  it("picks the frame showing the cell, else the sheet's first", () => {
    const frames: FrameRange[] = [
      { id: "f1", sheet: "S", range: parseRange("A1:B2") },
      { id: "f2", sheet: "S", range: parseRange("C3:D4") },
      { id: "f3", sheet: "T", range: parseRange("A1:B2") },
    ];
    expect(frameFor(frames, "S", 2, 2)).toBe("f2");
    expect(frameFor(frames, "S", 50, 50)).toBe("f1");
    expect(frameFor(frames, "U", 0, 0)).toBeNull();
  });

  it("makes Excel's dT from an ISO time and keeps one already in form", () => {
    expect(toDt("2026-11-01T10:11:12.345Z")).toBe("2026-11-01T10:11:12.34");
    expect(toDt("2026-11-01T10:11:12.50")).toBe("2026-11-01T10:11:12.50");
  });
});

const wbc = (over: Partial<WbComment> & { id: string }): WbComment => ({
  rootId: over.id,
  sheet: 0,
  sheetName: "Sheet1",
  row: 0,
  col: 0,
  personId: "{P1}",
  displayName: "Ann Author",
  userId: "ann",
  providerId: "None",
  timestamp: "2026-11-01T10:00:00.00",
  text: "hello",
  done: false,
  ...over,
});

const row = (over: Partial<EngineRow> & { id: string }): EngineRow => ({
  text: "hello",
  resolved: false,
  ...over,
});

const eroot = (id: string, over: Partial<EngineRow> = {}): EngineRow =>
  row({
    id,
    threadId: id,
    anchor: { kind: "cell", item: "f1", address: "Sheet1!A1" },
    source: { format: "xlsx", data: "{}" },
    ...over,
  });

const frames = (): FrameRange[] => [
  { id: "f1", sheet: "Sheet1", range: parseRange("A1:C5") },
];

describe("plan", () => {
  it("projects a workbook thread with its replies and resolved state", () => {
    const p = plan(
      [
        wbc({ id: "{R}", done: true }),
        wbc({ id: "{Y}", rootId: "{R}", text: "reply" }),
      ],
      [],
      new Map(),
      frames,
    );
    expect(p.workbook).toEqual([]);
    expect(p.engine.map((m) => m.op)).toEqual([
      "setPerson",
      "insertCommentThread",
      "replyComment",
      "resolveComment",
    ]);
    const insert = p.engine[1]!.args as {
      anchor: unknown;
      comment: { id: string };
    };
    expect(insert.anchor).toEqual({
      kind: "cell",
      item: "f1",
      address: "Sheet1!A1",
    });
    expect(insert.comment.id).toBe("{R}");
  });

  it("projects nothing while no frame shows the sheet", () => {
    const p = plan([wbc({ id: "{R}" })], [], new Map(), () => []);
    expect(p.engine).toEqual([]);
  });

  it("is quiet when both sides agree", () => {
    const snap = new Map([["{R}", { text: "hello", done: false }]]);
    const p = plan([wbc({ id: "{R}" })], [eroot("{R}")], snap, frames);
    expect(p).toEqual({ engine: [], workbook: [], replies: [] });
  });

  it("sends a panel edit and a panel resolve to the workbook", () => {
    const snap = new Map([["{R}", { text: "hello", done: false }]]);
    const p = plan(
      [wbc({ id: "{R}" })],
      [eroot("{R}", { text: "changed", resolved: true })],
      snap,
      frames,
    );
    expect(p.workbook).toEqual([
      { kind: "edit", sheet: 0, id: "{R}", text: "changed" },
      { kind: "done", sheet: 0, row: 0, col: 0, done: true },
    ]);
    expect(p.engine).toEqual([]);
  });

  it("sends a workbook edit to the document, and wins a conflict", () => {
    const snap = new Map([["{R}", { text: "hello", done: false }]]);
    const p = plan(
      [wbc({ id: "{R}", text: "from excel" })],
      [eroot("{R}", { text: "from panel" })],
      snap,
      frames,
    );
    expect(p.engine).toEqual([
      {
        op: "editComment",
        args: { commentId: "{R}", text: "from excel", date: null },
      },
    ]);
    expect(p.workbook).toEqual([]);
  });

  it("deletes in the workbook what the panel deleted, and the reverse", () => {
    const snap = new Map([
      ["{A}", { text: "hello", done: false }],
      ["{B}", { text: "hello", done: false }],
      ["{Y}", { text: "r", done: false }],
    ]);
    const p = plan(
      // {A} gone from the panel (with its reply), {B} gone from the workbook
      [wbc({ id: "{A}" }), wbc({ id: "{Y}", rootId: "{A}", text: "r" })],
      [eroot("{B}")],
      snap,
      frames,
    );
    expect(p.workbook).toEqual([{ kind: "delete", sheet: 0, id: "{A}" }]);
    expect(p.engine).toEqual([
      { op: "deleteComment", args: { commentId: "{B}" } },
    ]);
  });

  it("carries a panel reply into the workbook", () => {
    const snap = new Map([["{R}", { text: "hello", done: false }]]);
    const reply = row({
      id: "c-7",
      parentId: "{R}",
      text: "answer",
      author: "Bob",
    });
    const p = plan([wbc({ id: "{R}" })], [eroot("{R}"), reply], snap, frames);
    expect(p.replies).toHaveLength(1);
    expect(p.replies[0]!.row.id).toBe("c-7");
  });

  it("re-resolves a resolved thread a projected reply reopened", () => {
    const snap = new Map([["{R}", { text: "hello", done: true }]]);
    const p = plan(
      [wbc({ id: "{R}", done: true }), wbc({ id: "{Y}", rootId: "{R}" })],
      [eroot("{R}", { resolved: true })],
      snap,
      frames,
    );
    expect(p.engine.map((m) => m.op)).toEqual([
      "setPerson",
      "replyComment",
      "resolveComment",
    ]);
  });

  it("leaves a document thread of an unknown workbook alone, drops one the last reconcile held", () => {
    const stale = [eroot("{OLD}")];
    expect(plan([], stale, new Map(), frames).engine).toEqual([]);
    const held = new Map([["{OLD}", { text: "hello", done: false }]]);
    expect(plan([], stale, held, frames).engine).toEqual([
      { op: "deleteComment", args: { commentId: "{OLD}" } },
    ]);
  });
});

// -- the controller, against an in-memory workbook and comment store ---------------

type Store = Array<{
  id: string;
  parent: string | null;
  text: string;
  author: string;
  anchor: unknown;
  source: unknown;
  resolved: boolean;
}>;

function world(initial: CellThreadInfo[], real?: SheetEngine) {
  const threads: CellThreadInfo[] = JSON.parse(JSON.stringify(initial));
  let n = 0;
  const engine =
    real ??
    ({
      listSheets: () => [{ id: 0, name: "Sheet1", rows: 10, cols: 10 }],
      listThreads: () =>
        threads.map((t) => ({ ...t, comments: [...t.comments] })),
      replyThread: (
        _s: number,
        row: number,
        col: number,
        a: ThreadAuthor,
        timestamp: string,
        text: string,
      ) => {
        const t = threads.find((x) => x.row === row && x.col === col)!;
        const id = `{NEW${++n}}`;
        t.comments.push({
          id,
          parentId: t.comments[0]!.id,
          personId: `{P-${a.userId}}`,
          displayName: a.displayName,
          userId: a.userId,
          providerId: a.providerId,
          timestamp,
          text,
          done: false,
        });
        return id;
      },
      editThreadComment: (_s: number, id: string, text: string) => {
        for (const t of threads)
          for (const c of t.comments) if (c.id === id) c.text = text;
        return true;
      },
      deleteThreadComment: (_s: number, id: string) => {
        for (const t of [...threads]) {
          const c = t.comments.find((x) => x.id === id);
          if (!c) continue;
          if (!c.parentId) threads.splice(threads.indexOf(t), 1);
          else t.comments = t.comments.filter((x) => x.id !== id);
        }
        return true;
      },
      setThreadDone: (_s: number, row: number, col: number, done: boolean) => {
        const t = threads.find((x) => x.row === row && x.col === col)!;
        t.resolved = done;
        t.comments[0]!.done = done;
        return true;
      },
    } as unknown as SheetEngine);

  const store: Store = [];
  let listeners: Array<() => void> = [];
  let edited = 0;
  let mintId = 0;
  const applyOne = (m: Mutation) => {
    const a = m.args as Record<string, any>;
    if (m.op === "batch") return (a.ops as Mutation[]).forEach(applyOne);
    if (m.op === "setPerson") return;
    if (m.op === "insertCommentThread")
      store.push({
        id: a.comment.id ?? `c-${++mintId}`,
        parent: null,
        text: a.comment.text,
        author: a.comment.author,
        anchor: a.anchor,
        source: a.comment.source,
        resolved: !!a.comment.resolved,
      });
    else if (m.op === "replyComment") {
      store.push({
        id: a.comment.id ?? `c-${++mintId}`,
        parent: a.parentId,
        text: a.comment.text,
        author: a.comment.author,
        anchor: null,
        source: a.comment.source,
        resolved: false,
      });
      store.find((x) => x.id === a.parentId)!.resolved = false;
    } else if (m.op === "editComment")
      store.find((x) => x.id === a.commentId)!.text = a.text;
    else if (m.op === "resolveComment")
      store.find((x) => x.id === a.commentId)!.resolved = a.resolved;
    else if (m.op === "deleteComment") {
      const i = store.findIndex((x) => x.id === a.commentId);
      if (i < 0) throw new Error("no such comment");
      const dead = store[i]!.parent
        ? [store[i]!.id]
        : store
            .filter((x) => x.id === a.commentId || x.parent === a.commentId)
            .map((x) => x.id);
      for (const d of dead)
        store.splice(
          store.findIndex((x) => x.id === d),
          1,
        );
    }
  };
  const host = {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    document: {
      onDidChange: (l: () => void) => {
        listeners.push(l);
        return {
          dispose: () => void (listeners = listeners.filter((x) => x !== l)),
        };
      },
      tree: async () => [{ id: { kind: "textFrame", id: "f1" }, children: [] }],
      getMetadata: async () => ({
        v: 2,
        data: {
          sheet: "Sheet1",
          range: "A1:C5",
          contentVersion: 0,
          view: { topLeft: "A1", lock: false },
          print: { headings: false, gridlines: false },
          sizing: "fit",
        },
      }),
      collection: async () => {
        const out: EngineRow[] = [];
        for (const c of store) {
          const root = c.parent ?? c.id;
          out.push({
            id: c.id,
            parentId: c.parent,
            threadId: root,
            text: c.text,
            author: c.author,
            resolved: store.find((x) => x.id === root)!.resolved,
            anchor: (c.parent
              ? store.find((x) => x.id === root)!.anchor
              : c.anchor) as EngineRow["anchor"],
            source: c.source as EngineRow["source"],
          });
        }
        return out;
      },
      mutate: async (m: Mutation) => {
        try {
          applyOne(m);
        } catch (err) {
          return { applied: false, error: String(err) };
        }
        for (const l of [...listeners]) l();
        return { applied: true };
      },
    },
  } as unknown as BundleHost;
  const comments = createSheetComments({
    host,
    engine: () => engine,
    ownWrite: (w) => w(),
    edited: () => void (edited += 1),
    seed: () => 7,
  });
  return {
    threads,
    store,
    comments,
    edited: () => edited,
    /** A panel action: a mutation plus the change event the host sends. */
    panel: (m: Mutation) => host.document.mutate(m as never),
  };
}

const thread = (): CellThreadInfo => ({
  sheet: 0,
  row: 0,
  col: 0,
  resolved: false,
  comments: [
    {
      id: "{R}",
      personId: "{P1}",
      displayName: "Ann Author",
      userId: "ann",
      providerId: "None",
      timestamp: "2026-11-01T10:00:00.00",
      text: "check this",
      done: false,
    },
    {
      id: "{Y}",
      parentId: "{R}",
      personId: "{P2}",
      displayName: "Bob",
      userId: "bob",
      providerId: "None",
      timestamp: "2026-11-01T10:05:00.00",
      text: "done",
      done: false,
    },
  ],
});

describe("SheetComments", () => {
  it("projects the workbook's threads into the document under their GUIDs", async () => {
    const w = world([thread()]);
    await w.comments.sync();
    expect(w.store.map((c) => [c.id, c.parent, c.text])).toEqual([
      ["{R}", null, "check this"],
      ["{Y}", "{R}", "done"],
    ]);
    expect(w.store[0]!.anchor).toEqual({
      kind: "cell",
      item: "f1",
      address: "Sheet1!A1",
    });
    // a second pass changes nothing
    const before = JSON.stringify(w.store);
    await w.comments.sync();
    expect(JSON.stringify(w.store)).toBe(before);
    expect(w.edited()).toBe(0);
  });

  it("writes a panel reply, edit, resolve and delete to the workbook", async () => {
    const w = world([thread()]);
    await w.comments.sync();

    await w.panel({
      op: "replyComment",
      args: { parentId: "{R}", comment: { author: "Cy", text: "noted" } },
    });
    await w.comments.sync();
    const tc = w.threads[0]!.comments;
    expect(tc.map((c) => c.text)).toEqual(["check this", "done", "noted"]);
    expect(tc[2]!.displayName).toBe("Cy");
    // the panel's id gave way to the workbook's
    expect(w.store.map((c) => c.id)).toEqual(["{R}", "{Y}", "{NEW1}"]);
    expect(w.edited()).toBeGreaterThan(0);

    await w.panel({
      op: "editComment",
      args: { commentId: "{R}", text: "check that" },
    });
    await w.comments.sync();
    expect(w.threads[0]!.comments[0]!.text).toBe("check that");

    await w.panel({
      op: "resolveComment",
      args: { commentId: "{R}", resolved: true },
    });
    await w.comments.sync();
    expect(w.threads[0]!.resolved).toBe(true);

    await w.panel({
      op: "resolveComment",
      args: { commentId: "{R}", resolved: false },
    });
    await w.comments.sync();
    expect(w.threads[0]!.resolved).toBe(false);

    await w.panel({ op: "deleteComment", args: { commentId: "{Y}" } });
    await w.comments.sync();
    expect(w.threads[0]!.comments.map((c) => c.id)).toEqual(["{R}", "{NEW1}"]);

    await w.panel({ op: "deleteComment", args: { commentId: "{R}" } });
    await w.comments.sync();
    expect(w.threads).toEqual([]);
    expect(w.store).toEqual([]);
  });

  it("follows the workbook when it changes under the document", async () => {
    const w = world([thread()]);
    await w.comments.sync();
    w.threads[0]!.comments[0]!.text = "edited in excel";
    w.threads[0]!.resolved = true;
    w.threads[0]!.comments[0]!.done = true;
    w.threads[0]!.comments = w.threads[0]!.comments.filter(
      (c) => c.id !== "{Y}",
    );
    await w.comments.sync();
    expect(w.store.map((c) => [c.id, c.text, c.resolved])).toEqual([
      ["{R}", "edited in excel", true],
    ]);
  });

  it("projects again after a reload, without duplicating", async () => {
    const w = world([thread()]);
    await w.comments.sync();
    w.comments.reset(); // the workbook is restored, the document kept its threads
    await w.comments.sync();
    expect(w.store).toHaveLength(2);
    expect(w.threads[0]!.comments).toHaveLength(2);
  });

  it("does nothing on a workbook without threads", async () => {
    const w = world([]);
    await w.comments.sync();
    expect(w.store).toEqual([]);
  });
});

// -- the real engine: the workbook the controller writes is a real xlsx ----------------

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM = join(HERE, "..", "bin", "sheet_js_bg.wasm");
const FIXTURE = join(
  HERE,
  "..",
  "..",
  "..",
  "corpus/xlsx-corpus/01-minimal.xlsx",
);

describe.skipIf(!existsSync(WASM))("SheetComments over the real engine", () => {
  it("round-trips a thread started, answered, edited and resolved from the panel", async () => {
    const { bootEngine } = await import("../src/engine");
    const engine = await bootEngine();
    engine.loadXlsx(new Uint8Array(readFileSync(FIXTURE)));
    const sheet = engine.listSheets()[0]!;
    const ann = {
      displayName: "Ann Author",
      userId: "ann@example.com",
      providerId: "AD",
    };
    const root = engine.addThread!(
      sheet.id,
      0,
      0,
      ann,
      "2026-11-01T10:00:00.00",
      "check this",
      1,
    );

    const w = world([], engine);
    await w.comments.sync();
    expect(w.store.map((c) => c.id)).toEqual([root]);
    expect((w.store[0]!.anchor as { address: string }).address).toBe(
      `${sheet.name}!A1`,
    );

    await w.panel({
      op: "replyComment",
      args: { parentId: root, comment: { author: "Bob", text: "looks fine" } },
    });
    await w.comments.sync();
    await w.panel({
      op: "editComment",
      args: { commentId: root, text: "check this & that" },
    });
    await w.comments.sync();
    await w.panel({
      op: "resolveComment",
      args: { commentId: root, resolved: true },
    });
    await w.comments.sync();

    const [t] = engine.listThreads!(sheet.id);
    expect(t!.resolved).toBe(true);
    expect(t!.comments.map((c) => c.text)).toEqual([
      "check this & that",
      "looks fine",
    ]);
    expect(t!.comments[1]!.displayName).toBe("Bob");
    expect(w.store.map((c) => c.id)).toEqual(t!.comments.map((c) => c.id));

    // A reload of the saved bytes shows the same thread, and projects clean.
    const bytes = engine.saveXlsx();
    const dir = process.env.PAGED_SHEET_COMMENTS_OUT;
    if (dir) writeFileSync(join(dir, "panel-edited.xlsx"), bytes);
    const again = await bootEngine();
    again.loadXlsx(bytes);
    const fresh = world([], again);
    await fresh.comments.sync();
    expect(fresh.store.map((c) => c.text)).toEqual([
      "check this & that",
      "looks fine",
    ]);
    expect(fresh.store[0]!.resolved).toBe(true);
    again.dispose();
    engine.dispose();
  });
});
