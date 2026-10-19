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

// Table (paged.table): drives the selected table cell (the table cell
// selection the canvas sets on a Type-tool click into a cell). Cell and
// table properties are object-model fields on `cell:<table>/<r>,<c>` and
// `table:<id>`; structure edits (rows, columns, header / footer, spans)
// are table ops. Each control: the exact message sent, the model reading
// it back, the panel showing it.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { TablePanel } from "../../src/panels/table-panel";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(TablePanel, { id: "paged.table", scene: richScene });

/** Select cell (row, col) of the scene's 2 × 2 table. */
const enter = (h: H, row = 0, col = 1) =>
  h.enterTable({
    storyId: h.scene.tableStoryId,
    tableId: h.scene.tableId,
    row,
    col,
    pageId: h.scene.pageId,
    frameBounds: null,
  });

const cellAddr = (h: H, row = 0, col = 1) =>
  `cell:${h.scene.tableId}/${row},${col}`;
const tableAddr = (h: H) => `table:${h.scene.tableId}`;

const set = (address: string, path: string, value: unknown) => ({
  op: "set",
  args: { address, path, value },
});

const q = <E extends Element = HTMLElement>(h: H, selector: string) => {
  const el = h.root.querySelector<E>(selector);
  if (!el) throw new Error(`no ${selector}`);
  return el;
};
const text = (h: H, selector: string) => q(h, selector).textContent;
const btn = (h: H, id: string) =>
  q<HTMLButtonElement>(h, `[data-cockpit-action="${id}"]`);
const num = (h: H, id: string) =>
  q<HTMLInputElement>(h, `[data-num-input="${id}"]`);

/** Mutations since `from`, the ops alone. */
const ops = (h: H, from: number) =>
  h.mutations(from).map((m) => (m as { op: string }).op);

describe("Table: states", () => {
  test("no cell selected: says how to get one", async () => {
    covers("panel:paged.table");
    const h = await mount();
    expect(q(h, "[data-table-panel]").getAttribute("data-table-panel")).toBe(
      "empty",
    );
    expect(h.root.textContent).toContain("Click into a table cell");
  });

  test("a caret in body text is not a table cell", async () => {
    covers("panel:paged.table");
    const h = await mount();
    await h.caret(h.scene.storyId, 2);
    expect(q(h, "[data-table-panel]").getAttribute("data-table-panel")).toBe(
      "empty",
    );
  });

  test("a cell: its address, the table's size and the cell's values from the model", async () => {
    covers("panel:paged.table");
    const h = await mount();
    await enter(h);
    expect(text(h, "[data-table-cell-address]")).toBe("R0 · C1");
    expect(text(h, "[data-cell-row]")).toBe("0");
    expect(text(h, "[data-cell-col]")).toBe("1");
    expect(text(h, "[data-table-dims]")).toBe("2 × 2");
    expect(q<HTMLSelectElement>(h, "[data-cell-fill-select]").value).toBe("");
    expect(q<HTMLSelectElement>(h, "[data-cell-vjustify-select]").value).toBe(
      "TopAlign",
    );
    expect(num(h, "inset-top").value).toBe("0");
    expect(
      q<HTMLSelectElement>(h, '[data-edge-color-select="top"]').value,
    ).toBe("Color/Black");
    expect(num(h, "edge-weight-top").value).toBe("1");
    expect(text(h, "[data-cell-span]")).toBe("1 × 1");
    expect(text(h, "[data-header-count]")).toBe("0");
  });

  test("a different cell re-reads", async () => {
    covers("panel:paged.table");
    const h = await mount();
    await h.mutate({
      op: "set",
      args: {
        address: cellAddr(h, 1, 0),
        path: "cellFillColor",
        value: { type: "colorRef", value: h.scene.red },
      },
    } as never);
    await enter(h, 0, 1);
    expect(q<HTMLSelectElement>(h, "[data-cell-fill-select]").value).toBe("");
    await enter(h, 1, 0);
    expect(text(h, "[data-table-cell-address]")).toBe("R1 · C0");
    expect(q<HTMLSelectElement>(h, "[data-cell-fill-select]").value).toBe(
      h.scene.red,
    );
  });
});

describe("Table: cell properties", () => {
  test("Fill: picking Red fills the cell", async () => {
    covers("panel:paged.table");
    const h = await mount();
    await enter(h);
    const from = h.mark();
    await h.choose(q(h, "[data-cell-fill-select]"), h.scene.red);
    expect(h.mutations(from)).toEqual([
      set(cellAddr(h), "cellFillColor", {
        type: "colorRef",
        value: h.scene.red,
      }),
    ] as never);
    expect(await h.get(cellAddr(h), "cellFillColor")).toEqual({
      type: "colorRef",
      value: h.scene.red,
    });
    expect(q<HTMLSelectElement>(h, "[data-cell-fill-select]").value).toBe(
      h.scene.red,
    );
  });

  test("Tint: typing 50 sets the fill tint", async () => {
    covers("panel:paged.table");
    const h = await mount();
    await enter(h);
    const from = h.mark();
    await h.typeInto("cellFillTint", "50");
    const sent = h.mutations(from) as unknown as Array<{
      args: { address: string; path: string; value: { value: number } };
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0].args.address).toBe(cellAddr(h));
    expect(sent[0].args.path).toBe("cellFillTint");
    expect(sent[0].args.value.value).toBe(50);
  });

  for (const side of ["top", "left", "bottom", "right"] as const) {
    test(`Inset ${side}: typing 4 sets it`, async () => {
      covers("panel:paged.table");
      const h = await mount();
      await enter(h);
      const path = `cellInset${side[0].toUpperCase()}${side.slice(1)}`;
      const from = h.mark();
      await h.typeInto(num(h, `inset-${side}`), "4");
      expect(h.mutations(from)).toEqual([
        set(cellAddr(h), path, { type: "length", value: 4 }),
      ] as never);
      expect(await h.get(cellAddr(h), path)).toEqual({
        type: "length",
        value: 4,
      });
      expect(num(h, `inset-${side}`).value).toBe("4");
    });
  }

  test("Vertical justification: Center", async () => {
    covers("panel:paged.table");
    const h = await mount();
    await enter(h);
    const from = h.mark();
    await h.choose(q(h, "[data-cell-vjustify-select]"), "CenterAlign");
    expect(h.mutations(from)).toEqual([
      set(cellAddr(h), "cellVerticalJustification", {
        type: "text",
        value: "CenterAlign",
      }),
    ] as never);
    expect(await h.get(cellAddr(h), "cellVerticalJustification")).toEqual({
      type: "text",
      value: "CenterAlign",
    });
  });

  test("Edge strokes: the top edge's colour, weight and tint", async () => {
    covers("panel:paged.table");
    const h = await mount();
    await enter(h);
    let from = h.mark();
    await h.choose(q(h, '[data-edge-color-select="top"]'), h.scene.red);
    expect(h.mutations(from)).toEqual([
      set(cellAddr(h), "cellTopEdgeStrokeColor", {
        type: "colorRef",
        value: h.scene.red,
      }),
    ] as never);
    from = h.mark();
    await h.typeInto(num(h, "edge-weight-top"), "2");
    expect(h.mutations(from)).toEqual([
      set(cellAddr(h), "cellTopEdgeStrokeWeight", { type: "length", value: 2 }),
    ] as never);
    from = h.mark();
    await h.typeInto(num(h, "edge-tint-top"), "50");
    expect(h.mutations(from)).toEqual([
      set(cellAddr(h), "cellTopEdgeStrokeTint", { type: "length", value: 50 }),
    ] as never);
    expect(await h.get(cellAddr(h), "cellTopEdgeStrokeWeight")).toEqual({
      type: "length",
      value: 2,
    });
    expect(num(h, "edge-weight-top").value).toBe("2");
  });

  test("Cell style and table style: applied from the document's styles", async () => {
    covers("panel:paged.table");
    const h = await mount();
    await enter(h);
    let from = h.mark();
    await h.choose(
      q(h, '[data-apply-select="apply-cell-style"]'),
      h.scene.cellStyle,
    );
    expect(h.mutations(from)).toEqual([
      set(cellAddr(h), "appliedCellStyle", {
        type: "text",
        value: h.scene.cellStyle,
      }),
    ] as never);
    from = h.mark();
    await h.choose(
      q(h, '[data-apply-select="apply-table-style"]'),
      h.scene.tableStyle,
    );
    expect(h.mutations(from)).toEqual([
      set(tableAddr(h), "appliedTableStyle", {
        type: "text",
        value: h.scene.tableStyle,
      }),
    ] as never);
    expect(await h.get(tableAddr(h), "appliedTableStyle")).toEqual({
      type: "text",
      value: h.scene.tableStyle,
    });
  });

  test("Keep options: the row starts on the next page and keeps with the next", async () => {
    covers("panel:paged.table");
    const h = await mount();
    await enter(h);
    let from = h.mark();
    await h.choose("rowStartRow", "NextPage");
    expect(h.mutations(from)).toEqual([
      set(cellAddr(h), "rowStartRow", { type: "text", value: "NextPage" }),
    ] as never);
    from = h.mark();
    await h.click(h.field("rowKeepWithNext").querySelector('[role="switch"]')!);
    expect(h.mutations(from)).toEqual([
      set(cellAddr(h), "rowKeepWithNext", { type: "bool", value: true }),
    ] as never);
    expect(await h.get(cellAddr(h), "rowKeepWithNext")).toEqual({
      type: "bool",
      value: true,
    });
  });

  test("Row height and column width: the selected row's and column's", async () => {
    covers("panel:paged.table");
    const h = await mount();
    await enter(h, 0, 1);
    let from = h.mark();
    await h.typeInto("rows[0].height", "20");
    const height = h.mutations(from) as unknown as Array<{
      args: { address: string; path: string; value: { value: number } };
    }>;
    expect(height).toHaveLength(1);
    expect(height[0].args.address).toBe(tableAddr(h));
    expect(height[0].args.path).toBe("rows[0].height");
    expect(height[0].args.value.value).toBe(20);
    from = h.mark();
    await h.typeInto("columns[1].width", "80");
    const width = h.mutations(from) as unknown as Array<{
      args: { path: string; value: { value: number } };
    }>;
    expect(width[0].args.path).toBe("columns[1].width");
    expect(width[0].args.value.value).toBe(80);
    expect(await h.get(tableAddr(h), "columns[1].width")).toMatchObject({
      value: 80,
    });
  });
});

describe("Table: structure", () => {
  for (const [id, op, at, dims] of [
    ["insert-row", "insertTableRow", "row", "3 × 2"],
    ["delete-row", "deleteTableRow", "row", "1 × 2"],
    ["insert-column", "insertTableColumn", "col", "2 × 3"],
    ["delete-column", "deleteTableColumn", "col", "2 × 1"],
  ] as const) {
    test(`${id}: ${op} at the selected ${at}`, async () => {
      covers("panel:paged.table");
      const h = await mount();
      await enter(h, 1, 1);
      const from = h.mark();
      await h.click(btn(h, id));
      expect(h.mutations(from)).toEqual([
        {
          op,
          args: {
            storyId: h.scene.tableStoryId,
            tableId: h.scene.tableId,
            at: 1,
          },
        },
      ] as never);
      expect(text(h, "[data-table-dims]")).toBe(dims);
    });
  }

  for (const [id, op, count, total] of [
    ["insert-header-row", "insertHeaderRow", "[data-header-count]", "3"],
    ["insert-footer-row", "insertFooterRow", "[data-footer-count]", "3"],
  ] as const) {
    test(`${id}: ${op}; the count and the table's rows follow`, async () => {
      covers("panel:paged.table");
      const h = await mount();
      await enter(h);
      const from = h.mark();
      await h.click(btn(h, id));
      expect(h.mutations(from)).toEqual([
        {
          op,
          args: { storyId: h.scene.tableStoryId, tableId: h.scene.tableId },
        },
      ] as never);
      expect(text(h, count)).toBe("1");
      expect(text(h, "[data-table-total-rows]")).toBe(total);
    });
  }

  test("− Header removes the header row it added", async () => {
    covers("panel:paged.table");
    const h = await mount();
    await enter(h);
    await h.click(btn(h, "insert-header-row"));
    const from = h.mark();
    await h.click(btn(h, "remove-header-row"));
    expect(ops(h, from)).toEqual(["removeHeaderRow"]);
    expect(text(h, "[data-header-count]")).toBe("0");
    expect(text(h, "[data-table-total-rows]")).toBe("2");
  });

  test("Merge 2×2 spans the cell over four; Split returns it to one", async () => {
    covers("panel:paged.table");
    const h = await mount();
    await enter(h, 0, 0);
    let from = h.mark();
    await h.click(btn(h, "merge-cells"));
    const span = (rowSpan: number, columnSpan: number) => ({
      op: "setCellSpan",
      args: {
        storyId: h.scene.tableStoryId,
        tableId: h.scene.tableId,
        row: 0,
        col: 0,
        rowSpan,
        columnSpan,
      },
    });
    expect(h.mutations(from)).toEqual([span(2, 2)] as never);
    expect(text(h, "[data-cell-span]")).toBe("2 × 2");
    from = h.mark();
    await h.click(btn(h, "split-cells"));
    expect(h.mutations(from)).toEqual([span(1, 1)] as never);
    expect(text(h, "[data-cell-span]")).toBe("1 × 1");
  });

  test("Row span typed as 2: one setCellSpan of 2 × 1", async () => {
    covers("panel:paged.table");
    const h = await mount();
    await enter(h, 0, 0);
    const from = h.mark();
    await h.typeInto(num(h, "row-span"), "2");
    expect(h.mutations(from)).toEqual([
      {
        op: "setCellSpan",
        args: {
          storyId: h.scene.tableStoryId,
          tableId: h.scene.tableId,
          row: 0,
          col: 0,
          rowSpan: 2,
          columnSpan: 1,
        },
      },
    ] as never);
  });

  test("Delete table removes it from its story", async () => {
    covers("panel:paged.table", "command:paged.core.deleteTable");
    const h = await mount();
    await enter(h);
    const from = h.mark();
    await h.click(btn(h, "delete-table"));
    expect(h.mutations(from)).toEqual([
      {
        op: "deleteTable",
        args: { storyId: h.scene.tableStoryId, tableId: h.scene.tableId },
      },
    ] as never);
    expect(btn(h, "delete-table").getAttribute("data-command-error")).toBe(
      null,
    );
  });

  // The table cell selection is not dropped when its table goes, so the
  // panel keeps offering every control on a cell that no longer exists.
  test.failing(
    "PN-209: after Delete table the panel no longer edits the deleted cell",
    async () => {
      covers("panel:paged.table");
      const h = await mount();
      await enter(h);
      await h.click(btn(h, "delete-table"));
      expect(q(h, "[data-table-panel]").getAttribute("data-table-panel")).toBe(
        "empty",
      );
    },
  );
});
