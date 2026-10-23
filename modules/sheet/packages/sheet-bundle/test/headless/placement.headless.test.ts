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

// The typed placement and chart-delete commands (plan G4), on the plugin-sdk
// harness over the REAL canvas engine: `place` puts a range, a defined name
// or a print area on the page, in one frame or across a frame chain, and
// `deleteChart` takes a chart out of the workbook together with its placed
// art. Each is one document undo step.

import { readFileSync } from "node:fs";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";

import { covers } from "@paged-media/test-kit";
import {
  createHeadlessHost,
  mapBacking,
  type HeadlessHost,
} from "@paged-media/plugin-sdk";
import type { ElementId } from "@paged-media/plugin-api";

import { parseBinding } from "../../../sheet-host-model/src";
import { sheetBundle } from "../../src";
import { headlessEnv, P, type SheetEnv } from "../conformance/env";
import { C, openBook } from "../conformance/scenarios";
import { ENGINE_BUILT, exportedTableCells, settle } from "../perf/workload";

type Env = SheetEnv & { h: HeadlessHost };

/** Every node kind in the scene tree, counted. */
async function kinds(env: Env): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const walk = (nodes: Awaited<ReturnType<typeof env.host.document.tree>>) => {
    for (const n of nodes) {
      if (n.id) out[n.id.kind] = (out[n.id.kind] ?? 0) + 1;
      if (n.children) walk(n.children);
    }
  };
  walk(await env.host.document.tree());
  return out;
}

/** Two threaded frames; the first one's id. */
async function chain(env: Env): Promise<string> {
  const frame = async (bounds: [number, number, number, number]) => {
    const o = await env.host.document.mutate({
      op: "insertTextFrame",
      args: { pageId: env.pageId, bounds },
    } as never);
    return (o as unknown as { createdId: ElementId }).createdId.id as string;
  };
  // Short frames, so the four rows need both.
  const first = await frame([36, 36, 80, 296]);
  const second = await frame([36, 316, 200, 576]);
  await env.host.document.mutate({
    op: "linkFrames",
    args: { from: first, to: second },
  } as never);
  await env.settle();
  return first;
}

async function addChart(env: Env): Promise<void> {
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
  expect(made.reason ?? "").toBe("");
  await env.settle();
}

const charts = (env: Env) => env.objects.query(`${P}/chart` as never);

/** The binding a placed frame carries. */
async function bindingOf(env: Env, frame: string) {
  const b = parseBinding(
    await env.host.document.getMetadata({
      kind: "textFrame",
      id: frame.replace(/^textFrame:/, ""),
    } as ElementId),
  );
  if (!b) throw new Error(`${frame} carries no binding`);
  return b.data;
}

/** A frame's page-space bounds `[top, left, bottom, right]`. */
async function boundsOf(
  env: Env,
  frame: string,
): Promise<[number, number, number, number]> {
  const [g] = await env.host.document.elementGeometry([
    { kind: "textFrame", id: frame.replace(/^textFrame:/, "") } as ElementId,
  ]);
  return g!.bounds as [number, number, number, number];
}

/** The group ids on the page (a placed chart is one group). */
async function groups(
  host: Pick<HeadlessHost["host"], "document">,
): Promise<string[]> {
  const out: string[] = [];
  const walk = (
    nodes: Awaited<ReturnType<HeadlessHost["host"]["document"]["tree"]>>,
  ) => {
    for (const n of nodes) {
      if (n.id?.kind === "group") out.push(String(n.id.id));
      if (n.children) walk(n.children);
    }
  };
  walk(await host.document.tree());
  return out;
}

/** Past the session's refresh debounce. */
const refreshed = async () => {
  await new Promise((r) => setTimeout(r, 450));
  await settle();
};

const place = (env: Env, args: unknown) =>
  env.objects.invoke(`${C}.place` as never, args as never) as Promise<{
    frame: string;
    frames: string[];
  }>;

describe.skipIf(!ENGINE_BUILT)(
  `paged.sheet placement and chart delete (plan G4)${ENGINE_BUILT ? "" : " (unavailable: the sheet wasm, bash scripts/build-wasm.sh)"}`,
  () => {
    setDefaultTimeout(60_000);
    let env: Env;
    beforeEach(async () => {
      env = (await headlessEnv()) as Env;
    });
    afterEach(() => env.dispose());

    it("place — a range, a defined name and a print area, each one table in one undo step", async () => {
      covers("command:media.paged.sheet.command.place");
      await openBook(env);
      await env.objects.batch([
        {
          op: "create",
          kind: `${P}/namedRange`,
          props: { name: "Fruit", refersTo: "book!A2:A4" },
        } as never,
        {
          op: "create",
          kind: `${P}/namedRange`,
          props: {
            name: "_xlnm.Print_Area",
            refersTo: "book!A1:B2",
            scope: "book",
          },
        } as never,
      ]);
      await env.settle();

      let m = env.mark();
      const placed = (await env.objects.invoke(`${C}.place` as never, {
        ref: "book!A1:B3",
      })) as { frame: string };
      expect(placed.frame).toMatch(/^textFrame:/);
      expect(env.mutationsSince(m)).toHaveLength(1);
      await env.settle();
      let tables = await exportedTableCells(env.h);
      expect(tables).toHaveLength(1);
      expect([...tables[0]!.values()]).toEqual(
        expect.arrayContaining(["Apples", "Pears"]),
      );
      expect([...tables[0]!.values()]).not.toContain("Figs");

      m = env.mark();
      await env.objects.invoke(`${C}.place` as never, {
        source: "name",
        ref: "Fruit",
      });
      expect(env.mutationsSince(m)).toHaveLength(1);
      await env.settle();
      tables = await exportedTableCells(env.h);
      expect(tables).toHaveLength(2);
      expect([...tables[1]!.values()].sort()).toEqual([
        "Apples",
        "Figs",
        "Pears",
      ]);

      await env.objects.invoke(`${C}.place` as never, {
        source: "printArea",
        ref: "book",
      });
      await env.settle();
      tables = await exportedTableCells(env.h);
      expect(tables).toHaveLength(3);
      expect([...tables[2]!.values()].sort()).toEqual([
        "12",
        "Apples",
        "name",
        "qty",
      ]);

      // One undo takes the last placement back whole.
      await env.undo();
      expect(await exportedTableCells(env.h)).toHaveLength(2);

      // What cannot be placed is refused with a reason, before any write.
      m = env.mark();
      await expect(
        env.objects.invoke(`${C}.place` as never, {
          source: "printArea",
          ref: "nosuch",
        }),
      ).rejects.toThrow(/no sheet named/);
      await expect(
        env.objects.invoke(`${C}.place` as never, {
          source: "name",
          ref: "Nothing",
        }),
      ).rejects.toThrow(/no defined name or table/);
      await env.objects.invoke(`${C}.addSheet` as never, { name: "empty" });
      m = env.mark();
      await expect(
        env.objects.invoke(`${C}.place` as never, {
          source: "printArea",
          ref: "empty",
        }),
      ).rejects.toThrow(/has no print area/);
      expect(env.mutationsSince(m)).toEqual([]);
    });

    it("place with a chain — the range paginated across the threaded frames in one undo step", async () => {
      await openBook(env);
      const first = await chain(env);
      const m = env.mark();
      const r = (await env.objects.invoke(`${C}.place` as never, {
        ref: "book!A1:B4",
        chain: `textFrame:${first}`,
        repeatHeaderRows: 1,
      })) as { frame: string };
      expect(r.frame).toBe(`textFrame:${first}`);
      expect(env.mutationsSince(m)).toHaveLength(1);
      await env.settle();
      const tables = await exportedTableCells(env.h);
      expect(tables.length).toBe(2);
      const all = tables.flatMap((t) => [...t.values()]);
      expect(all).toEqual(expect.arrayContaining(["Apples", "Pears", "Figs"]));
      // The header row repeats on the second frame.
      expect([...tables[1]!.values()]).toContain("name");
      await env.undo();
      expect(await exportedTableCells(env.h)).toHaveLength(0);
      // A frame that threads nothing (or no frame) is refused.
      await expect(
        env.objects.invoke(`${C}.place` as never, {
          ref: "book!A1:B4",
          chain: "nosuch",
        }),
      ).rejects.toThrow(/could not place/);
    });

    it("deleteChart — the chart and its placed art go in one undo step; undo brings both back", async () => {
      covers("command:media.paged.sheet.command.deleteChart");
      await openBook(env);
      await addChart(env);
      await addChart(env);
      expect(
        await env.objects.invoke(`${C}.lowerChartToFrame` as never, {
          chart: 0,
        }),
      ).toBe(true);
      await env.settle();
      const placed = await kinds(env);
      expect(placed.group).toBe(1);
      expect(placed.polygon).toBeGreaterThan(0);

      const m = env.mark();
      expect(
        await env.objects.invoke(`${C}.deleteChart` as never, { chart: 0 }),
      ).toBe(1);
      expect(env.mutationsSince(m)).toHaveLength(1);
      await env.settle();
      const after = await kinds(env);
      expect(after.group ?? 0).toBe(0);
      expect(after.polygon ?? 0).toBe(0);
      // The other chart keeps its index.
      expect(await charts(env)).toEqual([`${P}/chart/1`]);

      await env.undo();
      const back = await kinds(env);
      expect(back.group).toBe(1);
      expect(back.polygon).toBe(placed.polygon);
      expect(await charts(env)).toEqual([`${P}/chart/0`, `${P}/chart/1`]);

      // Redo deletes it again (the stored version replays the delete).
      await env.redo();
      expect(await charts(env)).toEqual([`${P}/chart/1`]);

      // A chart that is not there is refused, and nothing is written.
      const m2 = env.mark();
      await expect(
        env.objects.invoke(`${C}.deleteChart` as never, { chart: 0 }),
      ).rejects.toThrow(/no chart 0/);
      expect(env.mutationsSince(m2)).toEqual([]);
    });

    it("deleting a chart through host.objects takes its placed art with it, one batch", async () => {
      await openBook(env);
      await addChart(env);
      await env.objects.invoke(`${C}.lowerChartToFrame` as never, {
        chart: 0,
      });
      await env.settle();
      const r = await env.objects.batch([
        { op: "delete", address: `${P}/chart/0` } as never,
      ]);
      expect(r.applied).toBe(true);
      expect(r.undoSteps).toBe(1);
      await env.settle();
      expect((await kinds(env)).polygon ?? 0).toBe(0);
      expect(await charts(env)).toEqual([]);
    });

    it("place — a frame's view: printed headings and gridlines, a window that starts elsewhere, a fixed box, fit", async () => {
      await openBook(env);

      let m = env.mark();
      const printed = await place(env, {
        ref: "book!A1:B3",
        print: { headings: true, gridlines: true },
      });
      expect(env.mutationsSince(m)).toHaveLength(1);
      await env.settle();
      let tables = await exportedTableCells(env.h);
      expect([...tables[0]!.values()]).toEqual(
        expect.arrayContaining(["A", "B", "1", "2", "3", "Apples"]),
      );
      let b = await bindingOf(env, printed.frame);
      expect(b.sizing).toBe("window");
      expect(b.print).toEqual({ headings: true, gridlines: true });

      // A window over A1:B4's size that starts at A3, locked there.
      m = env.mark();
      const moved = await place(env, {
        ref: "book!A1:B2",
        view: { topLeft: "a3", lock: true },
      });
      expect(env.mutationsSince(m)).toHaveLength(1);
      await env.settle();
      tables = await exportedTableCells(env.h);
      expect([...tables[1]!.values()].sort()).toEqual([
        "3",
        "7",
        "Figs",
        "Pears",
      ]);
      b = await bindingOf(env, moved.frame);
      expect(b.view).toEqual({ topLeft: "A3", lock: true });
      expect(b.range).toBe("A3:B4");

      // A fixed box: the frame is the box, the window the rows it holds.
      const fixed = await place(env, {
        ref: "book!A1:B4",
        sizing: "fixed",
        box: { width: 160, height: 32 },
      });
      await env.settle();
      const [top, , bottom] = await boundsOf(env, fixed.frame);
      expect(bottom - top).toBeCloseTo(32, 3);
      tables = await exportedTableCells(env.h);
      expect([...tables[2]!.values()].filter((v) => v !== "").sort()).toEqual([
        "12",
        "Apples",
        "name",
        "qty",
      ]);
      expect((await bindingOf(env, fixed.frame)).sizing).toBe("window");

      // fit: the earlier fixed range with measured widths.
      const fit = await place(env, { ref: "book!A1:B2", sizing: "fit" });
      expect((await bindingOf(env, fit.frame)).sizing).toBe("fit");

      // What a view cannot be is refused before any write.
      m = env.mark();
      for (const [args, why] of [
        [{ ref: "book!A1:B2", sizing: "fixed" }, /needs a box/],
        [{ ref: "book!A1:B2", box: { width: 9, height: 9 } }, /sizing "fixed"/],
        [
          { ref: "book!A1:B2", sizing: "fit", print: { headings: true } },
          /"fit"/,
        ],
        [
          { source: "name", ref: "Fruit", view: { lock: true } },
          /placed by name/,
        ],
        [{ ref: "book!A1:B2", view: { topLeft: "nowhere" } }, /is not a cell/],
        [
          { ref: "book!A1:B2", chain: "x", print: { gridlines: true } },
          /a chain paginates/,
        ],
      ] as const)
        await expect(place(env, args)).rejects.toThrow(why);
      expect(env.mutationsSince(m)).toEqual([]);
    });

    it("place — a print area of several ranges: one table per area, in order; across a chain in sequence", async () => {
      await openBook(env);
      const made = await env.objects.batch([
        {
          op: "create",
          kind: `${P}/namedRange`,
          props: {
            name: "_xlnm.Print_Area",
            refersTo: "book!A1:A2,book!B3:B4",
            scope: "book",
          },
        } as never,
      ]);
      expect(made.reason ?? "").toBe("");
      await env.settle();

      const r = await place(env, { source: "printArea", ref: "book" });
      expect(r.frames).toHaveLength(2);
      expect(r.frame).toBe(r.frames[0]!);
      await env.settle();
      let tables = await exportedTableCells(env.h);
      expect(tables.map((t) => [...t.values()])).toEqual([
        ["name", "Apples"],
        ["3", "7"],
      ]);
      // The second area stands under the first.
      const first = await boundsOf(env, r.frames[0]!);
      const second = await boundsOf(env, r.frames[1]!);
      expect(second[0]).toBeGreaterThan(first[2]);
      expect(second[1]).toBeCloseTo(first[1], 3);

      // Across a chain: the areas' tables follow one another in the story.
      await env.undo();
      await env.undo();
      expect(await exportedTableCells(env.h)).toHaveLength(0);
      const head = await chain(env);
      const m = env.mark();
      await place(env, {
        source: "printArea",
        ref: "book",
        chain: `textFrame:${head}`,
      });
      expect(env.mutationsSince(m)).toHaveLength(1);
      await env.settle();
      tables = await exportedTableCells(env.h);
      expect(tables.flatMap((t) => [...t.values()])).toEqual([
        "name",
        "Apples",
        "3",
        "7",
      ]);
    });

    it("an undone deleteChart's art is tracked again: a later edit redraws it", async () => {
      await openBook(env);
      await addChart(env);
      await env.objects.invoke(`${C}.lowerChartToFrame` as never, { chart: 0 });
      await env.settle();
      const placed = await groups(env.host);
      expect(placed).toHaveLength(1);

      await env.objects.invoke(`${C}.deleteChart` as never, { chart: 0 });
      await env.settle();
      await env.undo();
      await env.settle();
      expect(await groups(env.host)).toEqual(placed);

      // The data under the chart changes: the restored art is redrawn.
      const w = await env.objects.batch([
        {
          op: "set",
          address: `${P}/cell/book!B2`,
          path: "value",
          value: "40",
        } as never,
      ]);
      expect(w.reason ?? "").toBe("");
      await refreshed();
      const after = await groups(env.host);
      expect(after).toHaveLength(1);
      expect(after).not.toEqual(placed);
    });

    it("a reopened document's placed chart is tracked: an edit redraws it", async () => {
      await openBook(env);
      await addChart(env);
      await env.objects.invoke(`${C}.lowerChartToFrame` as never, { chart: 0 });
      await env.settle();
      // The workbook part lands after the persist debounce.
      await new Promise((r) => setTimeout(r, 1200));
      const { bytes } = await env.h.exportDocument("paged");

      const h2 = await createHeadlessHost({
        console: { log() {}, warn() {}, error() {}, debug() {}, info() {} },
        storage: mapBacking(),
        resolveFrom: new URL("../..", import.meta.url).pathname,
      } as never);
      try {
        await h2.load(bytes);
        h2.loadBundle(sheetBundle);
        await settle();
        await new Promise((r) => setTimeout(r, 200));
        const placed = await groups(h2.host);
        expect(placed).toHaveLength(1);
        const w = await h2.objects.batch([
          {
            op: "set",
            address: `${P}/cell/book!B3`,
            path: "value",
            value: "30",
          } as never,
        ]);
        expect(w.reason ?? "").toBe("");
        await refreshed();
        const after = await groups(h2.host);
        expect(after).toHaveLength(1);
        expect(after).not.toEqual(placed);
      } finally {
        h2.dispose();
      }
    });

    it("a chart read from an xlsx and deleted leaves the saved workbook; its slot keeps the other indices", async () => {
      const xlsx = readFileSync(
        new URL(
          "../../../../corpus/xlsx-corpus/annual-charts.xlsx",
          import.meta.url,
        ),
      );
      await env.importer("media.paged.sheet.importer.xlsx").import({
        name: "annual.xlsx",
        bytes: new Uint8Array(xlsx),
        mimeType: "",
      });
      await env.settle();
      const before = await charts(env);
      expect(before).toHaveLength(10);
      await env.objects.invoke(`${C}.deleteChart` as never, { chart: 2 });
      await env.settle();
      const left = before.filter((a) => a !== `${P}/chart/2`);
      expect(await charts(env)).toEqual(left);
      // Undo and redo reload stored versions: the redone delete's bytes
      // carry nine charts, the slot keeps chart 3 at index 3.
      await env.undo();
      expect(await charts(env)).toEqual(before);
      await env.redo();
      expect(await charts(env)).toEqual(left);
      // The saved workbook no longer carries the chart's part.
      const out = (await env
        .exporter("media.paged.sheet.exporter.xlsx")
        .export()) as { bytes: Uint8Array } | null;
      // Entry names stand uncompressed in a zip's headers.
      const names = new TextDecoder("latin1").decode(out!.bytes);
      expect(names).not.toContain("xl/charts/chart3.xml");
      expect(names).toContain("xl/charts/chart4.xml");
    });
  },
);
