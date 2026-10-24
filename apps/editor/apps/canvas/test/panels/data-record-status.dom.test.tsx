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

// The Data panel's per-record status (editor ADR 291): a query's rows are
// coloured new or changed, placed rows are marked, the placed records gone
// from the data are counted, and a double-click on a placed row selects the
// page items that show that record — also when the grid is sorted.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import type {
  DataBindingStatus,
  DataPlacement,
  DataRecordStatus,
  DataService,
  DataTableInfo,
  ProviderRecordSet,
} from "@paged-media/plugin-api";
import { createDataRegistry } from "@paged-media/plugin-sdk";
import { createEditorScope, setDataDoorSource } from "@paged-media/shell";

import { DataPanel } from "../../src/panels/data-panel";
import { shapesScene } from "./fixtures";
import { mountPanel, unmountAll } from "./harness";

afterEach(unmountAll);

type Row = Record<string, string | number>;
const ROWS: Row[] = [
  { sku: "A-1", price: 9.5 },
  { sku: "B-2", price: 120 },
  { sku: "C-3", price: 30 },
];
const FIELDS = [
  { name: "sku", ty: "text" },
  { name: "price", ty: "float" },
];
const QUERY: DataTableInfo = {
  name: "q",
  kind: "query",
  schema: { fields: FIELDS },
  rowCount: 3,
  revision: "1",
  writable: false,
};

/** Runs the SQL the grid writes for a query (`gridSql` with its records
 *  numbered), wrapped in a count or a LIMIT/OFFSET window. */
function run(sql: string): Row[] {
  let m = /^SELECT count\(\*\) AS n FROM \((.*)\)$/s.exec(sql);
  if (m) return [{ n: run(m[1]!).length }];
  m = /^(.*) LIMIT (\d+) OFFSET (\d+)$/s.exec(sql);
  if (m) return run(m[1]!).slice(Number(m[3]), Number(m[3]) + Number(m[2]));
  m =
    /^SELECT \* FROM \(SELECT row_number\(\) OVER \(\) - 1 AS "__record", \* FROM "q"\)(?: ORDER BY "(\w+)"( DESC)?)?$/s.exec(
      sql,
    );
  if (!m) throw new Error(`the test service does not read: ${sql}`);
  const rows = ROWS.map((r, i) => ({ __record: i, ...r }));
  const [, f, desc] = m;
  if (f)
    rows.sort((a, b) => {
      const c = a[f]! < b[f]! ? -1 : a[f]! > b[f]! ? 1 : 0;
      return desc ? -c : c;
    });
  return rows;
}

function recordSet(rows: Row[]): ProviderRecordSet {
  const names = Object.keys(rows[0] ?? { n: 0 });
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

const settle = () =>
  act(async () => await new Promise((r) => setTimeout(r, 20)));

describe("Data panel, per record [data.bind.record-status]", () => {
  test("rows show new, changed and placed; a double-click selects the record's page items [editor-shell.data-panel]", async () => {
    covers("panel:paged.data");
    const statuses: DataBindingStatus[] = [
      {
        id: "v",
        kind: "variable",
        query: "q",
        fields: ["sku"],
        status: "stale",
      },
      {
        id: "other",
        kind: "variable",
        query: "o",
        fields: ["x"],
        status: "linked",
      },
    ];
    let placed: DataPlacement[] = [];
    const status: DataRecordStatus = {
      query: "q",
      added: [2],
      changed: [1],
      removed: 2,
      placed: [0, 1],
    };
    const backend = createDataRegistry();
    const scope = createEditorScope();
    setDataDoorSource(scope, backend);
    const service: DataService = {
      tables: () => [QUERY],
      records: async () => recordSet(ROWS),
      query: async (sql) => recordSet(run(sql)),
      status: async () => statuses,
      placements: async () => placed,
      recordStatus: async (q) => ({ ...status, query: q }),
    };
    act(() => void backend.serve("media.paged.data", service));
    const h = await mountPanel(DataPanel, {
      id: "paged.data",
      scene: shapesScene,
      scope,
    });
    const address = (id: { kind: string; id: unknown }) =>
      `${id.kind}:${String(id.id)}`;
    placed = [
      // Record 1 is in the rect (the variable) and the oval (a merge).
      {
        binding: "v",
        address: address(h.scene.rect),
        status: "stale",
        record: 1,
      },
      {
        binding: "merge-q",
        address: address(h.scene.oval),
        status: "linked",
        record: 1,
      },
      {
        binding: "v",
        address: address(h.scene.locked),
        status: "stale",
        record: 0,
      },
      // Another query's record 1 is not this one.
      {
        binding: "other",
        address: address(h.scene.locked),
        status: "linked",
        record: 1,
      },
    ];
    await settle();

    const row = (sku: string) =>
      [...h.root.querySelectorAll("[data-data-row]")].find(
        (r) => r.querySelector("[role='gridcell']")?.textContent === sku,
      ) as HTMLElement;
    expect(row("A-1").hasAttribute("data-record-status")).toBe(false);
    expect(row("A-1").hasAttribute("data-record-placed")).toBe(true);
    expect(row("B-2").getAttribute("data-record-status")).toBe("changed");
    expect(row("B-2").title).toContain("double-click to select");
    expect(row("C-3").getAttribute("data-record-status")).toBe("added");
    expect(row("C-3").hasAttribute("data-record-placed")).toBe(false);
    expect(h.root.querySelector("[data-data-removed]")?.textContent).toBe(
      "2 placed records are gone from the data",
    );

    // Sorted by price descending the rows move; each keeps its record.
    const price = h.root.querySelector(
      "[data-data-header='price']",
    ) as HTMLElement;
    await act(async () => price.click());
    await act(async () => price.click());
    await settle();
    expect(
      [...h.root.querySelectorAll("[data-data-row]")].map(
        (r) => r.querySelector("[role='gridcell']")?.textContent,
      ),
    ).toEqual(["B-2", "C-3", "A-1"]);
    expect(row("B-2").getAttribute("data-record-status")).toBe("changed");

    const from = h.mark();
    await h.user.dblClick(row("B-2"));
    await h.settle();
    await settle();
    const sent = h.sent("setElementSelection", from);
    expect(sent.length).toBe(1);
    expect(
      (sent[0]!.payload as { ids: { kind: string; id: unknown }[] }).ids.map(
        address,
      ),
    ).toEqual([address(h.scene.rect), address(h.scene.oval)]);

    // A row nothing places selects nothing.
    const mark = h.mark();
    await h.user.dblClick(row("C-3"));
    await h.settle();
    await settle();
    expect(h.sent("setElementSelection", mark).length).toBe(0);
  });
});
