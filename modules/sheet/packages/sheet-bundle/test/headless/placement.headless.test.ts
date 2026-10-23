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

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";

import { covers } from "@paged-media/test-kit";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import type { ElementId } from "@paged-media/plugin-api";

import { headlessEnv, P, type SheetEnv } from "../conformance/env";
import { C, openBook } from "../conformance/scenarios";
import { ENGINE_BUILT, exportedTableCells } from "../perf/workload";

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
  },
);
