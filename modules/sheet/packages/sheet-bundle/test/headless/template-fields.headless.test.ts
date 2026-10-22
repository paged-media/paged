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

// paged.sheet's template field kinds (plan G3) and layout commands (G4) on
// the real bundle, the real sheet engine and the real canvas engine: a
// template is authored (a placed price table, fields on page items, the
// document policy), the session becomes a FILLER, and every field is read
// and written through `host.objects` — the engine checking each write
// against the role, as it does for the form and `paged template fill`.

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
import type { TemplateFieldRef } from "@paged-media/plugin-api";

import { headlessEnv, P, value, type SheetEnv } from "../conformance/env";
import { BOOK_CSV, C, openBook } from "../conformance/scenarios";
import { ENGINE_BUILT, exportedTableCells } from "../perf/workload";
import { savedWorkbook } from "../saved-workbook";

type Env = SheetEnv & { h: HeadlessHost };

const send = (env: Env, kind: string, payload?: unknown) =>
  (
    env.h.host.editor.client as unknown as {
      send(m: unknown): Promise<{
        kind: string;
        payload: { createdId?: { id: string } };
      }>;
    }
  ).send(payload === undefined ? { kind } : { kind, payload });

const role = async (env: Env, r: "author" | "filler") =>
  expect(
    (await send(env, "setSessionPolicy", { policy: { role: r } })).kind,
  ).toBe("sessionPolicyApplied");

/** A text frame for a field to live on. */
async function frame(env: Env, top: number): Promise<string> {
  const r = await send(env, "mutate", {
    op: "insertTextFrame",
    args: { pageId: env.pageId, bounds: [top, 300, top + 20, 400] },
  });
  return r.payload.createdId!.id;
}

/** The author makes `id` a sheet field. */
async function field(
  env: Env,
  id: string,
  name: string,
  kind: string,
  def: unknown,
  grants = ["text.edit", "text.style"],
): Promise<TemplateFieldRef> {
  const r = await send(env, "mutate", {
    op: "setPluginMetadata",
    args: {
      elementId: { kind: "textFrame", id },
      key: "x-paged:template",
      value: JSON.stringify({
        v: 1,
        data: {
          field: { name, kind: "module", module: { kind, grants, def } },
        },
      }),
    },
  });
  expect(r.kind).toBe("mutationApplied");
  return { name, targetId: id, kind, def };
}

async function documentPolicy(env: Env, defaults: string[]): Promise<void> {
  const r = await send(env, "mutate", {
    op: "setDocumentMetadata",
    args: {
      key: "x-paged:template",
      value: JSON.stringify({ v: 1, data: { defaults } }),
    },
  });
  expect(r.kind).toBe("mutationApplied");
}

const cellValue = (env: Env, a1: string) =>
  value(env, `${P}/cell/book!${a1}`, "value");

const K = "media.paged.sheet";

describe.skipIf(!ENGINE_BUILT)(
  `paged.sheet template fields on the real engine${ENGINE_BUILT ? "" : " (unavailable: the sheet wasm, bash scripts/build-wasm.sh)"}`,
  () => {
    setDefaultTimeout(60_000);
    let env: Env;
    beforeEach(async () => {
      env = (await headlessEnv()) as Env;
    });
    afterEach(() => env.dispose());

    /** The price list: book!A1:B4 placed as a table, a chart over B2:B4. */
    async function template() {
      await openBook(env);
      const placed = (await env.objects.invoke(`${C}.lowerToFrame` as never, {
        range: "book!A1:B4",
      })) as { frame: string };
      const table = placed.frame.replace("textFrame:", "");
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
      await role(env, "author");
      const qty = await field(env, table, "pears", `${K}.cell`, {
        ref: "book!B3",
        type: "number",
        min: 0,
      });
      const fruit = await field(
        env,
        await frame(env, 300),
        "fruit",
        `${K}.cell`,
        {
          ref: "book!A2",
          allowed: ["Apples", "Quince"],
        },
      );
      const list = await field(
        env,
        await frame(env, 330),
        "list",
        `${K}.range`,
        {
          ref: "book!A2:B4",
          columns: ["Fruit", "Qty"],
          rows: { max: 3 },
        },
      );
      const source = await field(
        env,
        await frame(env, 360),
        "chart",
        `${K}.chartSource`,
        {
          chart: 0,
          allowed: [
            {
              name: "all",
              series: [{ values: "book!B2:B4", categories: "book!A2:A4" }],
            },
            {
              name: "two",
              label: "First two",
              series: [{ values: "book!B2:B3", categories: "book!A2:A3" }],
            },
          ],
        },
        [],
      );
      return { table, qty, fruit, list, source };
    }

    it("lists its kinds with their controls and grants", async () => {
      const kinds = await env.objects.templateFieldKinds();
      expect(kinds.map((k) => [k.kind, k.control.kind, k.grants])).toEqual([
        [`${K}.cell`, "text", ["text.edit", "text.style"]],
        [`${K}.range`, "table", ["text.edit", "text.style"]],
        [`${K}.chartSource`, "choice", []],
      ]);
    });

    it("a filler reads and writes a cell, a choice, a range and a chart's source; the placed table follows", async () => {
      const f = await template();
      await documentPolicy(env, ["document.metadata"]);
      await role(env, "filler");

      // cell: a number with a minimum
      expect(await env.objects.readTemplateField(f.qty)).toEqual({
        control: { kind: "number", min: 0 },
        value: 3,
      });
      expect(await env.objects.writeTemplateField(f.qty, 5)).toEqual({
        ok: true,
      });
      expect(await cellValue(env, "B3")).toBe("5");
      expect((await exportedTableCells(env.h))[0]!.get("2:1")).toBe("5");
      expect(await env.objects.writeTemplateField(f.qty, -1)).toEqual({
        ok: false,
        problem: "-1 is less than 0.",
      });
      expect(await env.objects.writeTemplateField(f.qty, "many")).toEqual({
        ok: false,
        problem: '"many" is not a number.',
      });
      expect(await cellValue(env, "B3")).toBe("5");

      // cell: a choice
      expect(await env.objects.readTemplateField(f.fruit)).toEqual({
        control: {
          kind: "choice",
          options: [{ value: "Apples" }, { value: "Quince" }],
        },
        value: "Apples",
      });
      expect(await env.objects.writeTemplateField(f.fruit, "Kiwi")).toEqual({
        ok: false,
        problem: '"Kiwi" is not one of the choices (Apples, Quince).',
      });
      expect(await env.objects.writeTemplateField(f.fruit, "Quince")).toEqual({
        ok: true,
      });
      expect((await exportedTableCells(env.h))[0]!.get("1:0")).toBe("Quince");

      // range: a growable table of up to three rows
      const read = await env.objects.readTemplateField(f.list);
      expect(read).toEqual({
        control: {
          kind: "table",
          columns: [
            { name: "A", title: "Fruit" },
            { name: "B", title: "Qty" },
          ],
        },
        value: [
          ["Quince", "12"],
          ["Pears", "5"],
          ["Figs", "7"],
        ],
      });
      expect(
        await env.objects.writeTemplateField(f.list, [
          ["Plums", "4"],
          ["Limes", 9],
        ]),
      ).toEqual({ ok: true });
      expect((await env.objects.readTemplateField(f.list)).value).toEqual([
        ["Plums", "4"],
        ["Limes", "9"],
      ]);
      expect(await cellValue(env, "A4")).toBe("");
      const tables = await exportedTableCells(env.h);
      expect([tables[0]!.get("1:0"), tables[0]!.get("2:1")]).toEqual([
        "Plums",
        "9",
      ]);
      expect(
        await env.objects.writeTemplateField(f.list, [
          ["a", "1"],
          ["b", "2"],
          ["c", "3"],
          ["d", "4"],
        ]),
      ).toEqual({
        ok: false,
        problem: "The table takes at most 3 rows; 4 were given.",
      });
      expect(
        await env.objects.writeTemplateField(f.list, [["a", "=1+1"]]),
      ).toEqual({
        ok: false,
        problem: "A formula cannot be entered into a template field.",
      });
      expect(await env.objects.writeTemplateField(f.list, [["a"]])).toEqual({
        ok: false,
        problem: "Row 1 has 1 values; the table has 2 columns.",
      });

      // chartSource: which series list the chart draws
      expect(await env.objects.readTemplateField(f.source)).toEqual({
        control: {
          kind: "choice",
          options: [{ value: "all" }, { value: "two", label: "First two" }],
        },
        value: "all",
      });
      expect(await env.objects.writeTemplateField(f.source, "two")).toEqual({
        ok: true,
      });
      expect((await env.objects.readTemplateField(f.source)).value).toBe("two");
      expect(await env.objects.writeTemplateField(f.source, "pie")).toEqual({
        ok: false,
        problem: '"pie" is not one of the choices (all, two).',
      });
    });

    it("refuses a write the template does not allow, and the workbook stays as the document names it", async () => {
      const f = await template();
      // No document policy: the workbook's version label is the document's,
      // which a filler may not write.
      await role(env, "filler");
      const refused = await env.objects.writeTemplateField(f.qty, 8);
      expect(refused.ok).toBe(false);
      expect((refused as { problem: string }).problem).toContain(
        "document.metadata",
      );
      expect(await cellValue(env, "B3")).toBe("3");

      // A second table shows B3 and is no field: the page could not follow.
      await role(env, "author");
      await documentPolicy(env, ["document.metadata"]);
      const other = (await env.objects.invoke(`${C}.lowerToFrame` as never, {
        range: "book!A3:B4",
      })) as { frame: string };
      await env.settle();
      await role(env, "filler");
      const shown = await env.objects.writeTemplateField(f.qty, 8);
      expect(shown).toEqual({
        ok: false,
        problem: `book!B3 is also shown in a table this template does not open (${other.frame} needs text.edit); make that frame a sheet field too.`,
      });
      expect(await cellValue(env, "B3")).toBe("3");
      // A cell only the field's own table shows is still open.
      expect(await env.objects.writeTemplateField(f.fruit, "Quince")).toEqual({
        ok: true,
      });

      // Outside its fields a filler moves nothing: the table's frame is
      // a field of its cell, not of its place.
      const moved = await env.objects.set(
        `textFrame:${f.table}` as never,
        "frameBounds",
        [0, 0, 50, 50],
      );
      expect(moved.applied).toBe(false);
      expect(moved.reason).toContain("item.resize");
    });

    it("a placed chart is redrawn only where the template lets a filler replace its art", async () => {
      const f = await template();
      expect(
        await env.objects.invoke(`${C}.lowerChartToFrame` as never, {
          chart: 0,
        }),
      ).toBe(true);
      await env.settle();
      await documentPolicy(env, ["document.metadata"]);
      await role(env, "filler");
      expect(await env.objects.writeTemplateField(f.source, "two")).toEqual({
        ok: false,
        problem:
          "The chart is placed on the page and redrawing it replaces its artwork, which this template does not allow (document.add-item).",
      });
      expect((await env.objects.readTemplateField(f.source)).value).toBe("all");
    });
  },
);

describe.skipIf(!ENGINE_BUILT)("paged.sheet layout commands (plan G4)", () => {
  setDefaultTimeout(60_000);
  let env: Env;
  beforeEach(async () => {
    env = (await headlessEnv()) as Env;
  });
  afterEach(() => env.dispose());

  it("importCsv — delimited text becomes the workbook; one sheet named after the file", async () => {
    covers("command:media.paged.sheet.command.importCsv");
    expect(
      await env.objects.invoke(`${C}.importCsv` as never, {
        text: BOOK_CSV,
        name: "book.csv",
      }),
    ).toBe(`${P}/workbook/main`);
    expect(await value(env, `${P}/workbook/main`, "sheets")).toEqual(["book"]);
    expect(await cellValue(env, "A2")).toBe("Apples");
  });

  it("mergeCells / unmergeCells / setBorders / setColumnWidth / setRowHeight — engine layout, one undo step each", async () => {
    covers(
      "command:media.paged.sheet.command.mergeCells",
      "command:media.paged.sheet.command.unmergeCells",
      "command:media.paged.sheet.command.setBorders",
      "command:media.paged.sheet.command.setColumnWidth",
      "command:media.paged.sheet.command.setRowHeight",
    );
    await openBook(env);
    await env.objects.invoke(`${C}.mergeCells` as never, {
      range: "book!A1:B1",
    });
    await env.objects.invoke(`${C}.setColumnWidth` as never, {
      sheet: "book",
      first: 0,
      last: 1,
      size: 20,
    });
    await env.objects.invoke(`${C}.setRowHeight` as never, {
      sheet: "book",
      first: 2,
      size: 30,
    });
    await env.objects.invoke(`${C}.setBorders` as never, {
      range: "book!A2:B4",
      edges: "outline",
      style: "medium",
      color: "#FF0000",
    });
    let x = await savedWorkbook(env);
    expect(x.sheet).toContain('<mergeCell ref="A1:B1"/>');
    // Columns 1 and 2 at width 20: one span, or one <col> each.
    expect(x.sheet).toMatch(
      /<col min="1" max="2" width="20"|<col min="1" max="1" width="20"[^>]*\/><col min="2" max="2" width="20"/,
    );
    expect(x.sheet).toMatch(/<row r="3"[^>]*ht="30"/);
    expect(x.styles).toMatch(/<left style="medium"><color rgb="FFFF0000"\/>/);
    expect(
      await env.objects.invoke(`${C}.unmergeCells` as never, {
        range: "book!A1:B1",
      }),
    ).toBe(1);
    x = await savedWorkbook(env);
    expect(x.sheet).not.toContain("<mergeCell ");
    // Each command is one undo step: undo brings the merge back.
    await env.undo();
    await env.settle();
    x = await savedWorkbook(env);
    expect(x.sheet).toContain('<mergeCell ref="A1:B1"/>');
    await expect(
      env.objects.invoke(`${C}.setRowHeight` as never, {
        sheet: "book",
        first: 0,
        size: -1,
      }),
    ).rejects.toThrow(/invalidValue/);
  });
});
