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

// One behaviour scenario per paged.sheet command id, run by the unit file
// (`test/commands.spec.ts`, the recording fake editor) and the headless file
// (`test/headless/commands.headless.test.ts`, the real canvas engine).
//
// A command id names two entry points, and each scenario drives both where
// the bundle has both: the PALETTE command (`contribute.command`, its `when`
// gate and its handler) and the TYPED command of the object model
// (`objects.invoke`, value-typed arguments, the result). Per id it asserts:
//
//   · enablement — the `when` predicate is false before a workbook is open
//     and true after; a verb that needs a selection or a placed range says
//     so (the warning it logs) and emits nothing;
//   · the effect — the workbook read back through the object model, the
//     panel the command opened, the clipboard, the scene layer, and the
//     document mutations the bundle emitted;
//   · undo — a typed write is ONE document undo step (the version label):
//     on the fake editor that is one `setDocumentMetadata` emitted, on the
//     real engine `document.undo()` takes the workbook back. A palette grid
//     edit is undone by the sheet context's own journal (`onUndo`).
//
// Where the fake editor cannot answer what the engine would (a placed
// frame's id, a table in the document), the unit run asserts what the
// bundle emitted and the headless run asserts what landed.

import { expect } from "bun:test";

import type { HeadlessHost } from "@paged-media/plugin-sdk";
import type { ElementId, ProviderRecordSet } from "@paged-media/plugin-api";

import { authorWorkbook, exportedTableCells } from "../perf/workload";
import { P, value, type SheetEnv } from "./env";

export const C = "media.paged.sheet.command";
export const PANEL = {
  workbook: "media.paged.sheet.panel.workbook",
  grid: "media.paged.sheet.panel.grid",
  datasets: "media.paged.sheet.panel.datasets",
};

const enc = new TextEncoder();

/** The fixture every scenario opens: a 4 × 2 sheet named "book". */
export const BOOK_CSV = "name,qty\nApples,12\nPears,3\nFigs,7\n";

export async function openBook(env: SheetEnv): Promise<void> {
  await env
    .importer("media.paged.sheet.importer.csv")
    .import({ name: "book.csv", bytes: enc.encode(BOOK_CSV), mimeType: "" });
  await env.settle();
}

export const cell = (env: SheetEnv, a1: string, path = "value") =>
  value(env, `${P}/cell/book!${a1}`, path);

export const column = async (env: SheetEnv, col: string, rows = 4) => {
  const out: unknown[] = [];
  for (let r = 1; r <= rows; r++) out.push(await cell(env, `${col}${r}`));
  return out;
};

const isOpen = (env: SheetEnv, id: string): boolean => {
  const when = env.command(`${C}.${id}`).when;
  expect(when, `${id} declares a when predicate`).toBeDefined();
  return (when as (s: unknown) => boolean)(null);
};

const run = async (env: SheetEnv, id: string, payload?: unknown) => {
  await env.command(`${C}.${id}`).handler(env.host.editor, payload);
  await env.settle();
};

const warned = (env: SheetEnv, text: string): boolean =>
  env.logs.some((l) => l.level === "warn" && l.text.includes(text));

const logged = (env: SheetEnv, text: string): boolean =>
  env.logs.some((l) => l.text.includes(text));

// ── the grid selection, the way the sheet context's keys set it ──────────

const key = (env: SheetEnv, k: Partial<KeyboardEvent> & { key: string }) =>
  env.editContext().onContentKey?.(k as unknown as KeyboardEvent);

/** Select the cell at (row, col), 0-based, by the grid's own keys. */
export function selectCell(env: SheetEnv, row: number, col: number): void {
  key(env, { key: "a", metaKey: true }); // select all: active A1
  key(env, { key: "ArrowDown" }); // collapse onto A2 …
  key(env, { key: "ArrowUp" }); // … and back to A1
  for (let i = 0; i < row; i++) key(env, { key: "ArrowDown" });
  for (let i = 0; i < col; i++) key(env, { key: "ArrowRight" });
}

/** Select the rectangle (r0,c0)–(r1,c1) by shift-extending from (r0,c0). */
export function selectRect(
  env: SheetEnv,
  r0: number,
  c0: number,
  r1: number,
  c1: number,
): void {
  selectCell(env, r0, c0);
  for (let i = r0; i < r1; i++) key(env, { key: "ArrowDown", shiftKey: true });
  for (let i = c0; i < c1; i++) key(env, { key: "ArrowRight", shiftKey: true });
}

/** A typed write is ONE document undo step. On the fake editor: exactly one
 *  version-label mutation was emitted. On the real engine: undo takes the
 *  workbook back to `before`, redo forward to `after`. */
async function oneUndoStep(
  env: SheetEnv,
  mark: number,
  read: () => Promise<unknown>,
  before: unknown,
  after: unknown,
): Promise<void> {
  const emitted = env.mutationsSince(mark);
  expect(emitted.filter((m) => m.op === "setDocumentMetadata")).toHaveLength(1);
  expect(emitted.every((m) => m.applied)).toBe(true);
  if (env.kind !== "headless") return;
  await env.undo();
  await env.settle();
  expect(await read()).toEqual(before);
  await env.redo();
  await env.settle();
  expect(await read()).toEqual(after);
}

// ── the scenarios ─────────────────────────────────────────────────────────

export async function importXlsx(env: SheetEnv): Promise<void> {
  const bytes = await authorWorkbook(2, 2, (r, c) => `v${r}${c}`);
  // Palette: the host file picker hands the bytes over; the workbook opens
  // and the workbook panel shows it.
  env.pick([
    {
      name: "picked.xlsx",
      bytes,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    } as never,
  ]);
  await run(env, "importXlsx");
  expect(env.opened).toContain(PANEL.workbook);
  expect(await value(env, `${P}/cell/Sheet1!B2`, "value")).toBe("v11");
  // Typed: the bytes as an argument, the workbook address as the result.
  const other = await authorWorkbook(1, 1, () => "typed");
  expect(
    await env.objects.invoke(`${C}.importXlsx` as never, { bytes: other }),
  ).toBe(`${P}/workbook/main`);
  await env.settle();
  expect(await value(env, `${P}/cell/Sheet1!A1`, "value")).toBe("typed");
}

/** SHT-1: bytes that are not a workbook — first with none open, then while
 *  one is open. Both must reject. */
export async function importXlsxRefusesGarbage(env: SheetEnv): Promise<void> {
  const first = await env.objects
    .invoke(`${C}.importXlsx` as never, { bytes: enc.encode("not a zip") })
    .then(
      () => "resolved",
      () => "rejected",
    );
  expect(first).toBe("rejected");
  const ok = await authorWorkbook(1, 1, () => "kept");
  await env.objects.invoke(`${C}.importXlsx` as never, { bytes: ok });
  await env.settle();
  await expect(
    env.objects.invoke(`${C}.importXlsx` as never, {
      bytes: enc.encode("not a zip"),
    }),
  ).rejects.toThrow();
}

export async function lowerToFrame(env: SheetEnv): Promise<void> {
  // Without a workbook there is nothing to place: a warning, no mutation.
  let m = env.mark();
  await run(env, "lowerToFrame");
  expect(warned(env, "no workbook / sheet / range")).toBe(true);
  expect(env.mutationsSince(m)).toEqual([]);

  await openBook(env);
  m = env.mark();
  if (env.kind === "unit") {
    // The palette verb places the used range: ONE batch carrying the frame
    // and the native table.
    await run(env, "lowerToFrame");
    const emitted = env.mutationsSince(m);
    expect(emitted.map((e) => e.op)).toContain("batch");
    return;
  }
  const placed = (await env.objects.invoke(`${C}.lowerToFrame` as never, {
    range: "book!A1:B4",
  })) as { frame: string };
  await env.settle();
  expect(placed.frame).toMatch(/^textFrame:/);
  const h = (env as SheetEnv & { h: HeadlessHost }).h;
  const tables = await exportedTableCells(h);
  expect(tables).toHaveLength(1);
  expect(tables[0]!.get("1:0")).toBe("Apples");
  expect(tables[0]!.get("3:1")).toBe("7");
  // Undo takes the placement off the page.
  for (let i = 0; i < 8 && (await exportedTableCells(h)).length > 0; i++)
    await env.undo();
  expect(await exportedTableCells(h)).toHaveLength(0);
  // The palette verb places the selected range (the used range by default).
  await run(env, "lowerToFrame");
  expect(await exportedTableCells(h)).toHaveLength(1);
}

export async function lowerChartToFrame(env: SheetEnv): Promise<void> {
  await openBook(env);
  // A chartless workbook: the palette verb says so and emits nothing.
  const m = env.mark();
  await run(env, "lowerChartToFrame");
  expect(warned(env, "the workbook has no charts")).toBe(true);
  expect(env.mutationsSince(m)).toEqual([]);
  const made = await env.objects.batch([
    {
      op: "create",
      kind: `${P}/chart`,
      props: {
        kind: "column",
        title: "Stock",
        series: [
          {
            values: "book!B2:B4",
            categories: "book!A2:A4",
            name: "qty",
            color: "",
          },
        ],
      },
    } as never,
  ]);
  expect(made.applied).toBe(true);
  await env.settle();
  const m2 = env.mark();
  if (env.kind === "unit") {
    await run(env, "lowerChartToFrame");
    expect(env.mutationsSince(m2).length).toBeGreaterThan(0);
    return;
  }
  expect(
    await env.objects.invoke(`${C}.lowerChartToFrame` as never, { chart: 0 }),
  ).toBe(true);
  await env.settle();
  const emitted = env.mutationsSince(m2);
  expect(emitted.length).toBeGreaterThan(0);
  expect(emitted.every((e) => e.applied)).toBe(true);
}

export async function openGrid(env: SheetEnv): Promise<void> {
  const m = env.mark();
  await run(env, "openGrid");
  expect(env.opened).toEqual([PANEL.grid]);
  expect(env.mutationsSince(m)).toEqual([]);
}

/** Place book!A1:B4 through the typed command (the real engine answers the
 *  frame id); on the fake editor the reply carries none, so the palette
 *  verb's frame is the fake's. Returns the frame id when there is one. */
async function placeBook(env: SheetEnv): Promise<string | null> {
  if (env.kind !== "headless") return null;
  const placed = (await env.objects.invoke(`${C}.lowerToFrame` as never, {
    range: "book!A1:B4",
  })) as { frame: string };
  await env.settle();
  return placed.frame.replace(/^textFrame:/, "");
}

export async function showGridInFrame(env: SheetEnv): Promise<void> {
  // Nothing placed yet: the verb names what is missing.
  await run(env, "showGridInFrame");
  expect(warned(env, "no target frame")).toBe(true);
  expect(env.scene).toEqual([]);
  await openBook(env);
  const frame = await placeBook(env);
  if (!frame) return;
  await run(env, "showGridInFrame");
  const submit = env.scene.find((s) => s.op === "submit");
  expect(submit?.elementId).toBe(frame);
  expect(submit?.texts).toEqual(
    expect.arrayContaining(["Apples", "Pears", "12", "7"]),
  );
}

export async function hideGridInFrame(env: SheetEnv): Promise<void> {
  await openBook(env);
  const frame = await placeBook(env);
  // Hiding with nothing shown is harmless.
  await run(env, "hideGridInFrame");
  if (!frame) {
    expect(env.scene.filter((s) => s.op === "submit")).toEqual([]);
    return;
  }
  await run(env, "showGridInFrame");
  expect(env.scene.at(-1)?.op).toBe("submit");
  await run(env, "hideGridInFrame");
  expect(env.scene.at(-1)).toMatchObject({ op: "clear", elementId: frame });
}

export async function sortRange(env: SheetEnv): Promise<void> {
  // Palette: the sort options live in the workbook panel.
  await run(env, "sortRange");
  expect(env.opened).toEqual([PANEL.workbook]);
  await openBook(env);
  const before = await column(env, "B");
  const m = env.mark();
  await env.objects.invoke(`${C}.sortRange` as never, {
    range: "book!A2:B4",
    keyColumn: 1,
    ascending: true,
  });
  await env.settle();
  const after = ["qty", "3", "7", "12"];
  expect(await column(env, "B")).toEqual(after);
  expect(await column(env, "A")).toEqual(["name", "Pears", "Figs", "Apples"]);
  await oneUndoStep(env, m, () => column(env, "B"), before, after);
}

export async function findReplace(env: SheetEnv): Promise<void> {
  // Palette: replace lives in the grid panel's find section.
  await run(env, "findReplace");
  expect(env.opened).toEqual([PANEL.grid]);
  await openBook(env);
  const m = env.mark();
  expect(
    await env.objects.invoke(`${C}.findReplace` as never, {
      needle: "Pears",
      replacement: "Plums",
    }),
  ).toBe(1);
  await env.settle();
  expect(await cell(env, "A3")).toBe("Plums");
  await oneUndoStep(env, m, () => cell(env, "A3"), "Pears", "Plums");
  // Match case is honoured: "plums" does not match "Plums".
  expect(
    await env.objects.invoke(`${C}.findReplace` as never, {
      needle: "plums",
      replacement: "x",
      matchCase: true,
    }),
  ).toBe(0);
  expect(await cell(env, "A3")).toBe("Plums");
}

/** SHT-2: a replace that matches nothing must not cost an undo step. */
export async function findReplaceNoMatchWritesNothing(
  env: SheetEnv,
): Promise<void> {
  await openBook(env);
  await env.objects.invoke(`${C}.findReplace` as never, {
    needle: "Pears",
    replacement: "Plums",
  });
  await env.settle();
  const m = env.mark();
  expect(
    await env.objects.invoke(`${C}.findReplace` as never, {
      needle: "zzz",
      replacement: "x",
    }),
  ).toBe(0);
  await env.settle();
  expect(env.mutationsSince(m)).toEqual([]);
  // …so the user's next undo takes back the replace that DID something.
  await env.undo();
  await env.settle();
  expect(await cell(env, "A3")).toBe("Pears");
}

export async function sheetFromDataset(env: SheetEnv): Promise<void> {
  await run(env, "sheetFromDataset");
  expect(env.opened).toEqual([PANEL.datasets]);
  // An id nobody publishes sources nothing.
  await expect(
    env.objects.invoke(`${C}.sheetFromDataset` as never, {
      providerId: "media.paged.data.dataset.nope",
    }),
  ).rejects.toThrow(/could not source/);
  const records: ProviderRecordSet = {
    schema: {
      fields: [
        { name: "region", ty: "text" },
        { name: "units", ty: "float" },
      ],
    },
    columns: [
      ["North", "South"],
      [1, 2],
    ],
    rowCount: 2,
  };
  env.providers.register({
    id: "media.paged.data.dataset.sales",
    category: "dataset",
    schema: records.schema,
    revision: "r1",
    getSnapshot: () => records,
  } as never);
  expect(
    await env.objects.invoke(`${C}.sheetFromDataset` as never, {
      providerId: "media.paged.data.dataset.sales",
    }),
  ).toBe(`${P}/workbook/main`);
  await env.settle();
  expect(await value(env, `${P}/cell/Sheet1!A1`, "value")).toBe("region");
  expect(await value(env, `${P}/cell/Sheet1!A3`, "value")).toBe("South");
  expect(await value(env, `${P}/cell/Sheet1!B2`, "value")).toBe("1");
}

export async function copySelection(env: SheetEnv): Promise<void> {
  expect(isOpen(env, "copySelection")).toBe(false);
  await openBook(env);
  expect(isOpen(env, "copySelection")).toBe(true);
  // No range selected yet: nothing is written.
  await run(env, "copySelection");
  expect(env.clipboard.payload).toBeNull();
  expect(warned(env, "copySelection:")).toBe(true);
  selectRect(env, 1, 0, 2, 1);
  const m = env.mark();
  await run(env, "copySelection");
  expect(env.clipboard.payload?.tabular?.rows).toEqual([
    ["Apples", "12"],
    ["Pears", "3"],
  ]);
  expect(env.clipboard.payload?.text).toBe("Apples\t12\nPears\t3");
  expect(env.mutationsSince(m)).toEqual([]);
}

export async function pasteSelection(env: SheetEnv): Promise<void> {
  expect(isOpen(env, "pasteSelection")).toBe(false);
  await openBook(env);
  expect(isOpen(env, "pasteSelection")).toBe(true);
  env.clipboard.payload = {
    text: "Kiwis\t9",
    tabular: { rows: [["Kiwis", "9"]] },
  };
  selectCell(env, 2, 0);
  await run(env, "pasteSelection");
  expect([await cell(env, "A3"), await cell(env, "B3")]).toEqual([
    "Kiwis",
    "9",
  ]);
  // The paste is ONE step of the sheet context's journal.
  const ctx = env.editContext();
  expect(ctx.onCanUndo?.()).toBe(true);
  expect(ctx.onUndo?.()).toBe(true);
  expect([await cell(env, "A3"), await cell(env, "B3")]).toEqual([
    "Pears",
    "3",
  ]);
  expect(ctx.onRedo?.()).toBe(true);
  expect(await cell(env, "A3")).toBe("Kiwis");
}

export async function styleFromCell(env: SheetEnv): Promise<void> {
  await openBook(env);
  // Nothing placed: the verb needs a placed range to read a cell from.
  let m = env.mark();
  await run(env, "styleFromCell");
  expect(logged(env, "place a range on the page first")).toBe(true);
  expect(env.mutationsSince(m)).toEqual([]);
  const frame = await placeBook(env);
  if (!frame) return;
  selectCell(env, 1, 1);
  const before = (await env.host.document.collection("cellStyles")).length;
  m = env.mark();
  await run(env, "styleFromCell");
  expect(logged(env, "styleFromCell: captured")).toBe(true);
  const ops = env.mutationsSince(m).map((e) => e.op);
  expect(ops[0]).toBe("createCellStyle");
  const styles = (await env.host.document.collection("cellStyles")) as {
    name?: string;
  }[];
  expect(styles.length).toBe(before + 1);
  expect(styles.some((s) => s.name === "Cell style")).toBe(true);
}

export async function paginateToChain(env: SheetEnv): Promise<void> {
  expect(isOpen(env, "paginateToChain")).toBe(false);
  await openBook(env);
  expect(isOpen(env, "paginateToChain")).toBe(true);
  // No frame of a chain selected: the verb names what it needs.
  let m = env.mark();
  await run(env, "paginateToChain");
  expect(warned(env, "select a text frame of the chain")).toBe(true);
  expect(env.mutationsSince(m)).toEqual([]);
  if (env.kind !== "headless") return;
  const frame = async (bounds: [number, number, number, number]) => {
    const o = await env.host.document.mutate({
      op: "insertTextFrame",
      args: { pageId: env.pageId, bounds },
    } as never);
    return (o as unknown as { createdId: { id: string } }).createdId.id;
  };
  const first = await frame([36, 36, 556, 296]);
  const second = await frame([36, 316, 556, 576]);
  await env.host.document.mutate({
    op: "linkFrames",
    args: { from: first, to: second },
  } as never);
  await env.host.selection.set([{ kind: "textFrame", id: first } as ElementId]);
  m = env.mark();
  await run(env, "paginateToChain");
  expect(env.mutationsSince(m).length).toBeGreaterThan(0);
  const h = (env as SheetEnv & { h: HeadlessHost }).h;
  const tables = await exportedTableCells(h);
  expect(tables.length).toBeGreaterThan(0);
  expect([...tables[0]!.values()]).toEqual(
    expect.arrayContaining(["Apples", "Figs"]),
  );
}

export async function newWorkbook(env: SheetEnv): Promise<void> {
  await run(env, "newWorkbook");
  expect(env.opened).toEqual([PANEL.workbook]);
  expect(await env.objects.query(`${P}/sheet` as never)).toEqual([
    `${P}/sheet/Sheet1`,
  ]);
  expect(await value(env, `${P}/cell/Sheet1!A1`, "value")).toBe("");
  // The copy verbs now apply: a workbook is open.
  expect(isOpen(env, "copySelection")).toBe(true);
  // Typed: a fresh workbook replaces the open one.
  await env.objects.set(`${P}/cell/Sheet1!A1` as never, "value", "x");
  expect(await env.objects.invoke(`${C}.newWorkbook` as never, {})).toBe(
    `${P}/workbook/main`,
  );
  await env.settle();
  expect(await value(env, `${P}/cell/Sheet1!A1`, "value")).toBe("");
}

type Structural =
  "insertRows" | "deleteRows" | "insertColumns" | "deleteColumns";

/** The palette verb at the grid selection, then the typed command. */
export async function structural(env: SheetEnv, id: Structural): Promise<void> {
  expect(isOpen(env, id)).toBe(false);
  await openBook(env);
  expect(isOpen(env, id)).toBe(true);
  // No selection: refused with the reason, nothing changed.
  await run(env, id);
  expect(warned(env, `${id}: select the rows or columns first`)).toBe(true);
  const rows = id.endsWith("Rows");
  const insert = id.startsWith("insert");
  // Select row 2 / column B (the second of each) and run the palette verb.
  if (rows) selectCell(env, 1, 0);
  else selectCell(env, 0, 1);
  await run(env, id);
  const probe = rows ? "A2" : "B1";
  const expected = insert ? "" : rows ? "Pears" : "";
  expect(await cell(env, probe)).toBe(expected);
  // The typed command, at an explicit position, is ONE document undo step.
  const read = () => cell(env, rows ? "A1" : "A1");
  const beforeTyped = await read();
  const m = env.mark();
  await env.objects.invoke(`${C}.${id}` as never, {
    sheet: "book",
    at: 0,
    count: 1,
  });
  await env.settle();
  const afterTyped = await read();
  if (insert) expect(afterTyped).toBe("");
  else expect(afterTyped).not.toBe(beforeTyped);
  await oneUndoStep(env, m, read, beforeTyped, afterTyped);
}

export async function addSheet(env: SheetEnv): Promise<void> {
  expect(isOpen(env, "addSheet")).toBe(false);
  await openBook(env);
  await run(env, "addSheet");
  const sheets = await env.objects.query(`${P}/sheet` as never);
  expect(sheets).toHaveLength(2);
  const read = async () =>
    (await env.objects.query(`${P}/sheet` as never)).length;
  const m = env.mark();
  expect(
    await env.objects.invoke(`${C}.addSheet` as never, { name: "Extra" }),
  ).toBe(`${P}/sheet/Extra`);
  await env.settle();
  expect(await read()).toBe(3);
  await oneUndoStep(env, m, read, 2, 3);
}

export async function fill(
  env: SheetEnv,
  id: "fillDown" | "fillRight",
): Promise<void> {
  expect(isOpen(env, id)).toBe(false);
  await openBook(env);
  // No selection: refused.
  await run(env, id);
  expect(warned(env, `${id}:`)).toBe(true);
  const ctx = env.editContext();
  if (id === "fillDown") {
    selectRect(env, 1, 1, 3, 1); // B2:B4
    await run(env, id);
    expect(await column(env, "B")).toEqual(["qty", "12", "12", "12"]);
  } else {
    selectRect(env, 1, 0, 1, 1); // A2:B2
    await run(env, id);
    expect(await cell(env, "B2")).toBe("Apples");
  }
  // The sheet context's journal takes the fill back.
  expect(ctx.onUndo?.()).toBe(true);
  expect(await column(env, "B")).toEqual(["qty", "12", "3", "7"]);
  // Typed, on an explicit range: one document undo step.
  const read = () => column(env, "A");
  const before = await read();
  const m = env.mark();
  await env.objects.invoke(`${C}.${id}` as never, {
    range: id === "fillDown" ? "book!A2:A4" : "book!A3:B3",
  });
  await env.settle();
  const after = await read();
  expect(after).toEqual(
    id === "fillDown"
      ? ["name", "Apples", "Apples", "Apples"]
      : ["name", "Apples", "Pears", "Figs"],
  );
  if (id === "fillRight") expect(await cell(env, "B3")).toBe("Pears");
  if (id === "fillDown") await oneUndoStep(env, m, read, before, after);
  else await oneUndoStep(env, m, () => cell(env, "B3"), "3", "Pears");
}

export async function clearCells(env: SheetEnv): Promise<void> {
  expect(isOpen(env, "clearCells")).toBe(false);
  await openBook(env);
  selectRect(env, 1, 0, 2, 1); // A2:B3
  await run(env, "clearCells");
  expect([await cell(env, "A2"), await cell(env, "B3")]).toEqual(["", ""]);
  expect(await cell(env, "A4")).toBe("Figs");
  expect(env.editContext().onUndo?.()).toBe(true);
  expect([await cell(env, "A2"), await cell(env, "B3")]).toEqual([
    "Apples",
    "3",
  ]);
  const m = env.mark();
  await env.objects.invoke(`${C}.clearCells` as never, { range: "book!A4:B4" });
  await env.settle();
  expect(await cell(env, "A4")).toBe("");
  await oneUndoStep(env, m, () => cell(env, "A4"), "Figs", "");
}

export async function findInSheet(env: SheetEnv): Promise<void> {
  expect(isOpen(env, "findInSheet")).toBe(false);
  await openBook(env);
  expect(isOpen(env, "findInSheet")).toBe(true);
  const m = env.mark();
  await run(env, "findInSheet");
  expect(env.opened).toContain(PANEL.grid);
  expect(env.mutationsSince(m)).toEqual([]);
  expect(
    await env.objects.invoke(`${C}.findInSheet` as never, { needle: "s" }),
  ).toEqual([`${P}/cell/book!A2`, `${P}/cell/book!A3`, `${P}/cell/book!A4`]);
  expect(
    await env.objects.invoke(`${C}.findInSheet` as never, {
      needle: "apples",
      matchCase: true,
    }),
  ).toEqual([]);
}

export async function findNext(env: SheetEnv): Promise<void> {
  expect(isOpen(env, "findNext")).toBe(false);
  await openBook(env);
  expect(isOpen(env, "findNext")).toBe(true);
  // With no search typed yet there is nothing to repeat.
  const m = env.mark();
  await run(env, "findNext");
  expect(logged(env, "findNext: no match (or no search yet)")).toBe(true);
  expect(env.mutationsSince(m)).toEqual([]);
}

export async function publishDataset(env: SheetEnv): Promise<void> {
  await openBook(env);
  await expect(
    env.objects.invoke(`${C}.publishDataset` as never, {
      name: "bad name",
      range: "book!A1:B4",
    }),
  ).rejects.toThrow(/invalidValue/);
  const id = await env.objects.invoke(`${C}.publishDataset` as never, {
    name: "stock",
    range: "book!A1:B4",
  });
  expect(id).toBe("media.paged.sheet.dataset.stock");
  const info = env.host.dataProviders
    .discover("dataset")
    .find((d) => d.id === id);
  expect(info?.schema.fields.map((f) => f.name)).toEqual(["name", "qty"]);
  const snap = await env.host.dataProviders.get(id as string);
  expect(snap?.records.columns).toEqual([
    ["Apples", "Pears", "Figs"],
    [12, 3, 7],
  ]);
}

export async function unpublishDataset(env: SheetEnv): Promise<void> {
  await openBook(env);
  expect(
    await env.objects.invoke(`${C}.unpublishDataset` as never, {
      name: "stock",
    }),
  ).toBe(false);
  await env.objects.invoke(`${C}.publishDataset` as never, {
    name: "stock",
    range: "book!A1:B4",
  });
  expect(env.host.dataProviders.discover("dataset").map((d) => d.id)).toContain(
    "media.paged.sheet.dataset.stock",
  );
  expect(
    await env.objects.invoke(`${C}.unpublishDataset` as never, {
      name: "stock",
    }),
  ).toBe(true);
  expect(
    env.host.dataProviders.discover("dataset").map((d) => d.id),
  ).not.toContain("media.paged.sheet.dataset.stock");
}

// ── the frame grid's verbs and data tools (sheet ADR 510 / 517) ───────────
//
// Several of these change grid UI state only (a card under the bar, the
// circles over invalid cells, the AutoFilter's buttons, hidden rows): that
// is read off the bundle's session (`env.session`), the one place it lives.

const PROPERTIES_PANEL = "media.paged.sheet.panel.properties";

/** The typed command (no arguments) through the object registry. */
const invokeTyped = (env: SheetEnv, id: string, args: object = {}) =>
  env.objects.invoke(`${C}.${id}` as never, args as never);

export async function cutSelection(env: SheetEnv): Promise<void> {
  expect(isOpen(env, "cutSelection")).toBe(false);
  await openBook(env);
  expect(isOpen(env, "cutSelection")).toBe(true);
  // Nothing selected: the copy half refuses, the clipboard stays empty.
  await run(env, "cutSelection");
  expect(env.clipboard.payload).toBeNull();
  expect(warned(env, "cut:")).toBe(true);
  // A2:B2 cut: on the clipboard at once, still in place until the paste.
  selectRect(env, 1, 0, 1, 1);
  const m = env.mark();
  await run(env, "cutSelection");
  expect(env.clipboard.payload?.tabular?.rows).toEqual([["Apples", "12"]]);
  expect([await cell(env, "A2"), await cell(env, "B2")]).toEqual([
    "Apples",
    "12",
  ]);
  expect(env.mutationsSince(m)).toEqual([]);
  // The paste at A4 moves it: the target holds it, the source is empty,
  // and ONE journal step takes both back.
  selectCell(env, 3, 0);
  await run(env, "pasteSelection");
  expect([await cell(env, "A4"), await cell(env, "B4")]).toEqual([
    "Apples",
    "12",
  ]);
  expect([await cell(env, "A2"), await cell(env, "B2")]).toEqual(["", ""]);
  expect(env.editContext().onUndo?.()).toBe(true);
  expect(await column(env, "A")).toEqual(["name", "Apples", "Pears", "Figs"]);
  // The typed twin cuts the grid's selection the same way.
  selectRect(env, 2, 0, 2, 1);
  await invokeTyped(env, "cutSelection");
  await env.settle();
  expect(env.clipboard.payload?.tabular?.rows).toEqual([["Pears", "3"]]);
}

export async function formatCells(env: SheetEnv): Promise<void> {
  expect(isOpen(env, "formatCells")).toBe(false);
  await openBook(env);
  expect(isOpen(env, "formatCells")).toBe(true);
  const m = env.mark();
  const shown = env.opened.length;
  await run(env, "formatCells");
  // Format Cells is the Sheet properties panel; the workbook is untouched.
  expect(env.opened.slice(shown)).toEqual([PROPERTIES_PANEL]);
  expect(env.mutationsSince(m)).toEqual([]);
  expect(await column(env, "A")).toEqual(["name", "Apples", "Pears", "Figs"]);
  await invokeTyped(env, "formatCells");
  expect(env.opened.slice(shown)).toEqual([PROPERTIES_PANEL, PROPERTIES_PANEL]);
}

export async function pasteSpecial(env: SheetEnv): Promise<void> {
  expect(isOpen(env, "pasteSpecial")).toBe(false);
  await openBook(env);
  expect(isOpen(env, "pasteSpecial")).toBe(true);
  expect(env.session.pasteSpecialOpen()).toBe(false);
  const m = env.mark();
  await run(env, "pasteSpecial");
  // The options card opens; nothing is pasted until its OK.
  expect(env.session.pasteSpecialOpen()).toBe(true);
  expect(env.mutationsSince(m)).toEqual([]);
  expect(await column(env, "B")).toEqual(["qty", "12", "3", "7"]);
  // The card's OK pastes with its options (add) and closes it.
  env.clipboard.payload = { text: "10", tabular: { rows: [["10"]] } };
  selectCell(env, 2, 1);
  const r = await env.session.pasteAtSelection({ operation: "add" });
  expect(r.ok).toBe(true);
  expect(env.session.pasteSpecialOpen()).toBe(false);
  expect(await cell(env, "B3")).toBe("13");
  // The typed twin opens it too.
  await invokeTyped(env, "pasteSpecial");
  expect(env.session.pasteSpecialOpen()).toBe(true);
  env.session.closePasteSpecial();
}

export async function dataValidation(env: SheetEnv): Promise<void> {
  expect(isOpen(env, "dataValidation")).toBe(false);
  await openBook(env);
  expect(isOpen(env, "dataValidation")).toBe(true);
  expect(env.session.dataCard()).toBeNull();
  selectRect(env, 1, 1, 3, 1); // B2:B4
  const m = env.mark();
  await run(env, "dataValidation");
  // The Data validation card opens on the selection, which has no rule.
  expect(env.session.dataCard()).toEqual({ kind: "validation" });
  expect(env.session.validationDraft()).toEqual({ range: "B2:B4", rule: null });
  expect(env.mutationsSince(m)).toEqual([]);
  // Its OK puts the rule on the selection and closes the card.
  expect(
    env.session.applyValidation({
      type: "whole",
      operator: "lessThanOrEqual",
      formula1: "10",
    }).ok,
  ).toBe(true);
  expect(env.session.dataCard()).toBeNull();
  expect(env.session.validationDraft()?.rule?.type).toBe("whole");
  // The typed twin opens the card again.
  await invokeTyped(env, "dataValidation");
  expect(env.session.dataCard()).toEqual({ kind: "validation" });
}

export async function circleInvalid(env: SheetEnv): Promise<void> {
  expect(isOpen(env, "circleInvalid")).toBe(false);
  await openBook(env);
  expect(isOpen(env, "circleInvalid")).toBe(true);
  // A rule the workbook already breaks: qty ≤ 10 (Apples has 12).
  selectRect(env, 1, 1, 3, 1);
  expect(
    env.session.applyValidation({
      type: "whole",
      operator: "lessThanOrEqual",
      formula1: "10",
    }).ok,
  ).toBe(true);
  expect(env.session.invalidCircles()).toBeNull();
  const m = env.mark();
  await run(env, "circleInvalid");
  // On: exactly the breaking cell is circled (B2, row 1 col 1).
  expect(env.session.invalidCircles()?.map((c) => [c.row, c.col])).toEqual([
    [1, 1],
  ]);
  expect(env.mutationsSince(m)).toEqual([]);
  // The verb toggles: off again.
  await run(env, "circleInvalid");
  expect(env.session.invalidCircles()).toBeNull();
  await invokeTyped(env, "circleInvalid");
  expect(env.session.invalidCircles()).toHaveLength(1);
}

export async function toggleFilter(env: SheetEnv): Promise<void> {
  expect(isOpen(env, "toggleFilter")).toBe(false);
  await openBook(env);
  expect(isOpen(env, "toggleFilter")).toBe(true);
  // Nothing selected: refused with the reason, no filter.
  await run(env, "toggleFilter");
  expect(warned(env, "toggleFilter: select the data to filter")).toBe(true);
  expect(env.session.filterButtons()).toBeNull();
  await expect(invokeTyped(env, "toggleFilter")).rejects.toThrow(
    /select the data to filter/,
  );
  // A cell in the data: the filter covers its region, buttons on the header.
  selectCell(env, 2, 0);
  await run(env, "toggleFilter");
  expect(env.session.filterButtons()).toEqual({
    row: 0,
    left: 0,
    right: 1,
    filtered: [],
  });
  // Again: off.
  await run(env, "toggleFilter");
  expect(env.session.filterButtons()).toBeNull();
  // The typed twin turns it on over the same region.
  await invokeTyped(env, "toggleFilter");
  expect(env.session.filterButtons()?.right).toBe(1);
}

const outline = (env: SheetEnv) => {
  const e = env.session.state().engine;
  const sheet = env.session.state().activeSheet;
  if (!e?.outline || sheet === null) throw new Error("no outline");
  return e.outline(sheet);
};

export async function hideSelection(
  env: SheetEnv,
  id: "hideSelection" | "unhideSelection",
): Promise<void> {
  expect(isOpen(env, id)).toBe(false);
  await openBook(env);
  expect(isOpen(env, id)).toBe(true);
  // Nothing selected: refused, nothing hidden.
  await run(env, id);
  expect(warned(env, `${id}:`)).toBe(true);
  expect(outline(env).hiddenRows).toEqual([]);
  // Rows 3–4 (Pears, Figs).
  selectRect(env, 2, 0, 3, 1);
  const ctx = env.editContext();
  if (id === "hideSelection") {
    await run(env, id);
    expect(outline(env).hiddenRows).toEqual([2, 3]);
    // One journal step takes it back.
    expect(ctx.onUndo?.()).toBe(true);
    expect(outline(env).hiddenRows).toEqual([]);
    await invokeTyped(env, id);
    expect(outline(env).hiddenRows).toEqual([2, 3]);
  } else {
    await run(env, "hideSelection");
    expect(outline(env).hiddenRows).toEqual([2, 3]);
    await run(env, id);
    expect(outline(env).hiddenRows).toEqual([]);
    expect(ctx.onUndo?.()).toBe(true);
    expect(outline(env).hiddenRows).toEqual([2, 3]);
    await invokeTyped(env, id);
    expect(outline(env).hiddenRows).toEqual([]);
  }
  // Values are untouched: hiding is not deleting.
  expect(await column(env, "A")).toEqual(["name", "Apples", "Pears", "Figs"]);
}

export async function groupSelection(
  env: SheetEnv,
  id: "groupSelection" | "ungroupSelection",
): Promise<void> {
  expect(isOpen(env, id)).toBe(false);
  await openBook(env);
  expect(isOpen(env, id)).toBe(true);
  await run(env, id);
  expect(warned(env, `${id}:`)).toBe(true);
  expect(outline(env).rows).toEqual([]);
  // Rows 2–4: the detail under the header.
  selectRect(env, 1, 0, 3, 1);
  const ctx = env.editContext();
  if (id === "groupSelection") {
    await run(env, id);
    expect(outline(env).rows).toMatchObject([{ first: 1, last: 3, level: 1 }]);
    expect(outline(env).maxRowLevel).toBe(1);
    expect(ctx.onUndo?.()).toBe(true);
    expect(outline(env).rows).toEqual([]);
    await invokeTyped(env, id);
    expect(outline(env).rows).toHaveLength(1);
  } else {
    await run(env, "groupSelection");
    expect(outline(env).rows).toHaveLength(1);
    await run(env, id);
    expect(outline(env).rows).toEqual([]);
    expect(ctx.onUndo?.()).toBe(true);
    expect(outline(env).rows).toHaveLength(1);
    await invokeTyped(env, id);
    expect(outline(env).rows).toEqual([]);
  }
}

export async function goalSeek(env: SheetEnv): Promise<void> {
  expect(isOpen(env, "goalSeek")).toBe(false);
  await openBook(env);
  expect(isOpen(env, "goalSeek")).toBe(true);
  expect(env.session.canGoalSeek()).toBe(true);
  const m = env.mark();
  await run(env, "goalSeek");
  // The Goal Seek card opens under the bar; nothing is solved yet.
  expect(env.session.dataCard()).toEqual({ kind: "goalSeek" });
  expect(env.mutationsSince(m)).toEqual([]);
  // Its OK: C2 = B2 * 2 reaches 30 by changing B2 to 15, one journal step.
  expect(env.session.editCell(0, 1, 2, "=B2*2")).toBe(true);
  const r = env.session.goalSeek("C2", 30, "B2");
  expect(r).toMatchObject({ ok: true, found: true });
  expect(await cell(env, "B2")).toBe("15");
  expect(await cell(env, "C2")).toBe("30");
  expect(env.editContext().onUndo?.()).toBe(true);
  expect(await cell(env, "B2")).toBe("12");
  env.session.closeDataCard();
  await invokeTyped(env, "goalSeek");
  expect(env.session.dataCard()).toEqual({ kind: "goalSeek" });
}
