/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// Data (paged.data, editor ADR 291): the document's data as a grid over the
// data door. A first-run guide while nothing serves or no table exists; with
// a service, a tab per table, the record count, a header click that sorts
// (the service runs the SQL), a filter, grouping with counts, and the fields
// a binding reads marked in their headers.

import { afterEach, describe, expect, test } from "bun:test";
import { act, fireEvent } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import type {
  DataBindingStatus,
  DataPlacement,
  DataService,
  DataTableInfo,
  ProviderRecordSet,
} from "@paged-media/plugin-api";
import { createDataRegistry } from "@paged-media/plugin-sdk";
import {
  createEditorScope,
  DATA_FIELD_DRAG_TYPE,
  DATA_RECORD_DRAG_TYPE,
  DATA_TABLE_DRAG_TYPE,
  setDataDoorSource,
} from "@paged-media/shell";

import { DataPanel } from "../../src/panels/data-panel";
import { shapesScene } from "./fixtures";
import { mountPanel, unmountAll } from "./harness";

afterEach(unmountAll);

type Row = Record<string, string | number | null>;
const ROWS: Row[] = [
  { sku: "A-1", cat: "Sale", price: 9.5 },
  { sku: "B-2", cat: "New", price: 120 },
  { sku: "C-3", cat: "Sale", price: 30 },
];
const FIELDS = [
  { name: "sku", ty: "text" },
  { name: "cat", ty: "text" },
  { name: "price", ty: "float" },
];

/** Runs exactly the SQL the grid writes (data-grid-model.ts): SELECT * FROM
 *  "t" [WHERE "f" op v (AND|OR) …] [ORDER BY "f" [DESC], …], wrapped in a
 *  count, a column read or a LIMIT/OFFSET window. */
function run(sql: string): Row[] {
  let m = /^SELECT count\(\*\) AS n FROM \((.*)\)$/s.exec(sql);
  if (m) return [{ n: run(m[1]!).length }];
  m = /^SELECT "(\w+)" FROM \((.*)\)$/s.exec(sql);
  if (m) return run(m[2]!).map((r) => ({ [m![1]!]: r[m![1]!] ?? null }));
  m = /^(.*) LIMIT (\d+) OFFSET (\d+)$/s.exec(sql);
  if (m) return run(m[1]!).slice(Number(m[3]), Number(m[3]) + Number(m[2]));
  m = /^SELECT \* FROM "products"(?: WHERE (.*?))?(?: ORDER BY (.*))?$/s.exec(
    sql,
  );
  if (!m) throw new Error(`the test service does not read: ${sql}`);
  let rows = [...ROWS];
  if (m[1]) {
    const or = m[1].includes(" OR ");
    const conds = m[1].split(or ? " OR " : " AND ").map((c) => {
      const x = /^"(\w+)" (=|<>|<|<=|>|>=) (.+)$/.exec(c)!;
      const v = x[3]!.startsWith("'") ? x[3]!.slice(1, -1) : Number(x[3]);
      return (r: Row) => {
        const a = r[x[1]!]!;
        return x[2] === "="
          ? a === v
          : x[2] === "<>"
            ? a !== v
            : x[2] === ">"
              ? a > v
              : x[2] === "<"
                ? a < v
                : x[2] === ">="
                  ? a >= v
                  : a <= v;
      };
    });
    rows = rows.filter((r) =>
      or ? conds.some((c) => c(r)) : conds.every((c) => c(r)),
    );
  }
  if (m[2]) {
    const keys = m[2].split(", ").map((k) => {
      const x = /^"(\w+)"( DESC)?$/.exec(k)!;
      return { f: x[1]!, d: !!x[2] };
    });
    rows.sort((a, b) => {
      for (const k of keys) {
        const c = a[k.f]! < b[k.f]! ? -1 : a[k.f]! > b[k.f]! ? 1 : 0;
        if (c) return k.d ? -c : c;
      }
      return 0;
    });
  }
  return rows;
}

function recordSet(rows: Row[]): ProviderRecordSet {
  const names =
    rows.length > 0 ? Object.keys(rows[0]!) : FIELDS.map((f) => f.name);
  return {
    schema: {
      fields: names.map(
        (n) => FIELDS.find((f) => f.name === n) ?? { name: n, ty: "int" },
      ),
    },
    columns: names.map((n) => rows.map((r) => r[n] ?? null)),
    rowCount: rows.length,
  };
}

const TABLE: DataTableInfo = {
  name: "products",
  kind: "source",
  schema: { fields: FIELDS },
  rowCount: 3,
  revision: "1",
  writable: true,
};

function serve(
  tables: DataTableInfo[],
  statuses: DataBindingStatus[] = [],
  placements?: () => DataPlacement[],
) {
  const backend = createDataRegistry();
  const scope = createEditorScope();
  setDataDoorSource(scope, backend);
  const queries: string[] = [];
  let refreshed = 0;
  const service: DataService = {
    tables: () => tables,
    records: async () => recordSet(ROWS),
    async query(sql) {
      queries.push(sql);
      return recordSet(run(sql));
    },
    status: async () => statuses,
    async refresh() {
      refreshed++;
    },
    ...(placements ? { placements: async () => placements() } : {}),
  };
  const handle = act(() => void backend.serve("media.paged.data", service));
  return { scope, backend, queries, handle, refreshes: () => refreshed };
}

const settle = () =>
  act(async () => await new Promise((r) => setTimeout(r, 20)));

describe("Data panel", () => {
  test("nothing serves the data: the guide says so", async () => {
    covers("panel:paged.data");
    const scope = createEditorScope();
    setDataDoorSource(scope, createDataRegistry());
    const h = await mountPanel(DataPanel, {
      id: "paged.data",
      document: "none",
      scope,
    });
    expect(h.root.querySelector("[data-data-start]")?.textContent).toContain(
      "No module serves",
    );
  });

  test("a service with no table: the three steps", async () => {
    covers("panel:paged.data");
    const { scope } = serve([]);
    const h = await mountPanel(DataPanel, {
      id: "paged.data",
      document: "none",
      scope,
    });
    await settle();
    expect(h.root.querySelectorAll("[data-data-start] li").length).toBe(3);
  });

  test("a table: its tab, count, rows; sort, filter and group run in the service", async () => {
    covers("panel:paged.data");
    const { scope, queries, refreshes } = serve(
      [TABLE],
      [
        {
          id: "b1",
          kind: "property",
          query: "products",
          fields: ["price"],
          status: "linked",
        },
        {
          id: "b2",
          kind: "variable",
          query: "products",
          fields: ["cat"],
          status: "stale",
        },
      ],
    );
    const h = await mountPanel(DataPanel, {
      id: "paged.data",
      document: "none",
      scope,
    });
    await settle();
    expect(h.root.querySelector("[data-data-tab='products']")).not.toBeNull();
    expect(h.root.querySelector("[data-data-count]")?.textContent).toBe(
      "3 records",
    );
    const firstColumn = () =>
      [...h.root.querySelectorAll("[data-data-row]")].map(
        (r) => r.querySelector("[role='gridcell']")?.textContent,
      );
    expect(firstColumn()).toEqual(["A-1", "B-2", "C-3"]);
    // The fields bindings read carry their state; the bar counts them.
    const header = (f: string) =>
      h.root.querySelector(`[data-data-header='${f}']`);
    expect(header("price")?.getAttribute("data-bound")).toBe("ok");
    expect(header("cat")?.getAttribute("data-bound")).toBe("warn");
    expect(header("sku")?.hasAttribute("data-bound")).toBe(false);
    expect(
      h.root.querySelector("[data-data-status='stale']")?.textContent,
    ).toContain("1 changed in the data");
    await act(async () =>
      (h.root.querySelector("[data-data-update]") as HTMLElement).click(),
    );
    await settle();
    expect(refreshes()).toBe(1);

    // Sort by price, descending on a second click.
    await act(async () =>
      (
        h.root.querySelector("[data-data-header='price']") as HTMLElement
      ).click(),
    );
    await act(async () =>
      (
        h.root.querySelector("[data-data-header='price']") as HTMLElement
      ).click(),
    );
    await settle();
    expect(
      queries.some((q) =>
        q.endsWith('ORDER BY "price" DESC LIMIT 200 OFFSET 0'),
      ),
    ).toBe(true);
    expect(firstColumn()).toEqual(["B-2", "C-3", "A-1"]);

    // Filter: price > 10.
    await act(async () =>
      (h.root.querySelector("[data-data-add-filter]") as HTMLElement).click(),
    );
    const row = h.root.querySelector("[data-data-filter='0']")!;
    await h.user.selectOptions(row.querySelectorAll("select")[0]!, "price");
    await h.user.selectOptions(row.querySelectorAll("select")[1]!, ">");
    await h.user.type(row.querySelector("input")!, "10");
    await settle();
    expect(h.root.querySelector("[data-data-count]")?.textContent).toBe(
      "2 records",
    );

    // Group by category: a header per group, with its count.
    await h.user.selectOptions(
      h.root.querySelector("[data-data-group]")!,
      "cat",
    );
    await settle();
    const groups = [...h.root.querySelectorAll("[data-data-group-row]")].map(
      (g) => g.getAttribute("data-data-group-row"),
    );
    expect(groups).toEqual(["New", "Sale"]);
  });

  test("double-click a bound field's header: its bindings' placed frames are selected [editor-shell.data-panel]", async () => {
    covers("panel:paged.data");
    let placed: DataPlacement[] = [];
    const { scope, queries } = serve(
      [TABLE],
      [
        {
          id: "b1",
          kind: "property",
          query: "products",
          fields: ["price"],
          status: "linked",
        },
        {
          id: "b2",
          kind: "image",
          query: "products",
          fields: ["price", "sku"],
          status: "stale",
        },
        {
          id: "b3",
          kind: "variable",
          query: "products",
          fields: ["cat"],
          status: "linked",
        },
      ],
      () => placed,
    );
    const h = await mountPanel(DataPanel, {
      id: "paged.data",
      scene: shapesScene,
      scope,
    });
    const address = (id: { kind: string; id: unknown }) =>
      `${id.kind}:${String(id.id)}`;
    placed = [
      { binding: "b1", address: address(h.scene.rect), status: "linked" },
      { binding: "b2", address: address(h.scene.oval), status: "stale" },
      { binding: "b2", address: address(h.scene.rect), status: "stale" },
      { binding: "b3", address: address(h.scene.locked), status: "linked" },
    ];
    await settle();
    const header = h.root.querySelector(
      "[data-data-header='price']",
    ) as HTMLElement;
    expect(header.title).toContain("double-click to select");
    const from = h.mark();
    await h.user.dblClick(header);
    await h.settle();
    await settle();
    const sent = h.sent("setElementSelection", from);
    expect(sent.length).toBe(1);
    const payload = sent[0]!.payload as {
      ids: { kind: string; id: unknown }[];
      mode: string;
    };
    expect(payload.mode).toBe("replace");
    // b1 and b2 read price; b3 (cat) is not selected; the rect once.
    expect(payload.ids.map(address)).toEqual([
      address(h.scene.rect),
      address(h.scene.oval),
    ]);
    // The double-click's second click did not reverse the sort.
    expect(queries.at(-1)).toContain('ORDER BY "price" LIMIT');

    // Another field: only the frames of the bindings reading it.
    const mark = h.mark();
    await h.user.dblClick(
      h.root.querySelector("[data-data-header='cat']") as HTMLElement,
    );
    await h.settle();
    await settle();
    const again = h.sent("setElementSelection", mark);
    expect(again.length).toBe(1);
    expect(
      (again[0]!.payload as { ids: { kind: string; id: unknown }[] }).ids.map(
        address,
      ),
    ).toEqual([address(h.scene.locked)]);
  });

  test("a query's field header drags out as a field to place [editor-shell.data-panel]", async () => {
    covers("panel:paged.data");
    const { scope } = serve([{ ...TABLE, kind: "query", writable: false }]);
    const h = await mountPanel(DataPanel, {
      id: "paged.data",
      document: "none",
      scope,
    });
    await settle();
    const header = h.root.querySelector(
      "[data-data-header='sku']",
    ) as HTMLElement;
    expect(header.getAttribute("draggable")).toBe("true");
    expect(header.title).toContain("drag onto a text or graphic frame");
    const data: Record<string, string> = {};
    const dataTransfer = {
      setData: (type: string, value: string) => void (data[type] = value),
    };
    fireEvent.dragStart(header, { dataTransfer });
    expect(JSON.parse(data[DATA_FIELD_DRAG_TYPE]!)).toEqual({
      query: "products",
      field: "sku",
    });
  });

  test("a query drags out as a table of its shown columns, a row as a record [editor-shell.data-panel]", async () => {
    covers("panel:paged.data");
    const { scope } = serve([{ ...TABLE, kind: "query", writable: false }]);
    const h = await mountPanel(DataPanel, {
      id: "paged.data",
      document: "none",
      scope,
    });
    await settle();
    const drag = (el: Element) => {
      const data: Record<string, string> = {};
      fireEvent.dragStart(el, {
        dataTransfer: {
          setData: (type: string, value: string) => void (data[type] = value),
        },
      });
      return data;
    };
    // Hide `cat`: the table carries the shown columns, in order.
    fireEvent.click(
      [...h.root.querySelectorAll("button")].find(
        (b) => b.textContent === "Columns",
      )!,
    );
    const cat = [...h.root.querySelectorAll("[data-data-columns] label")].find(
      (l) => l.textContent === "cat",
    )!;
    fireEvent.click(cat.querySelector("input")!);
    await settle();
    const handle = h.root.querySelector("[data-data-table-drag]")!;
    expect(handle.getAttribute("draggable")).toBe("true");
    expect(JSON.parse(drag(handle)[DATA_TABLE_DRAG_TYPE]!)).toEqual({
      query: "products",
      fields: ["sku", "price"],
    });
    const row = h.root.querySelector("[data-data-row='1']")!;
    expect(row.getAttribute("draggable")).toBe("true");
    expect(JSON.parse(drag(row)[DATA_RECORD_DRAG_TYPE]!)).toEqual({
      query: "products",
      record: 1,
    });
    // Sorted, a row's place is not its record number: it does not drag.
    fireEvent.click(h.root.querySelector("[data-data-header='price']")!);
    await settle();
    expect(
      h.root.querySelector("[data-data-row='1']")?.getAttribute("draggable"),
    ).toBe("false");
  });

  test("the first run offers the sample data; loaded, its query's tab shows [editor-shell.data-panel]", async () => {
    covers("panel:paged.data");
    const backend = createDataRegistry();
    const scope = createEditorScope();
    setDataDoorSource(scope, backend);
    const tables: DataTableInfo[] = [];
    const sample: DataTableInfo = {
      ...TABLE,
      name: "sample",
      kind: "query",
      writable: false,
    };
    let handle!: ReturnType<typeof backend.serve>;
    act(() => {
      handle = backend.serve("media.paged.data", {
        tables: () => tables,
        records: async () => recordSet(ROWS),
        query: async (sql) =>
          recordSet(run(sql.replace('"sample"', '"products"'))),
        async loadSample() {
          tables.push(TABLE, sample);
          handle.changed({ table: "sample", revision: "1" });
          return "sample";
        },
      });
    });
    const h = await mountPanel(DataPanel, {
      id: "paged.data",
      document: "none",
      scope,
    });
    await settle();
    const button = h.root.querySelector("[data-data-sample]") as HTMLElement;
    expect(button.textContent).toBe("Try it with sample data");
    fireEvent.click(button);
    await settle();
    expect(
      h.root
        .querySelector("[data-data-tab='sample']")
        ?.getAttribute("aria-selected"),
    ).toBe("true");
  });

  test("a service without sample data offers none", async () => {
    const { scope } = serve([]);
    const h = await mountPanel(DataPanel, {
      id: "paged.data",
      document: "none",
      scope,
    });
    await settle();
    expect(h.root.querySelector("[data-data-sample]")).toBeNull();
  });

  test("a source table's headers do not drag", async () => {
    const { scope } = serve([TABLE]);
    const h = await mountPanel(DataPanel, {
      id: "paged.data",
      document: "none",
      scope,
    });
    await settle();
    expect(
      h.root
        .querySelector("[data-data-header='sku']")
        ?.getAttribute("draggable"),
    ).toBe("false");
  });
});
