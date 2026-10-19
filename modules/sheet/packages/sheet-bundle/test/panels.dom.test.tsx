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

// paged.sheet's four panels as COMPONENTS (happy-dom, `bun run test:dom`):
// the component the real bundle registered, mounted with
// @testing-library/react over the real session and the real sheet engine
// (the recording fake editor stands in for the editor; ./conformance/env.ts).
// Each test renders a panel against a state and drives one interaction to
// the workbook, the document mutations or a command.
//
// The properties panel is a SCHEMA panel: the editor renders it with its
// PropertyField. Here a small reference renderer stands in (it reads each
// property row's address from the bundle's published bindings and the
// value from `host.objects`, and commits an edit through `objects.set`), so
// what is asserted is the bundle's half: its rows and the addresses it
// publishes for them.

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, useEffect, useState, type ReactElement } from "react";

import type {
  BundleHost,
  PanelSchemaPropertyRow,
  SchemaPanelRendererProps,
} from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import { P, initSheetWasm, unitEnv, type SheetEnv } from "./conformance/env";
import {
  C,
  cell,
  column,
  openBook,
  selectCell,
  selectRect,
} from "./conformance/scenarios";
import { ENGINE_BUILT, WASM } from "./perf/workload";

if (process.env.REQUIRE_REAL_ENGINE === "1" && !ENGINE_BUILT) {
  describe("sheet panels (wasm artifact) — REQUIRED", () => {
    it("FAILS: REQUIRE_REAL_ENGINE=1 but the wasm artifact is missing", () => {
      throw new Error(`REQUIRE_REAL_ENGINE=1 but ${WASM} is missing`);
    });
  });
}

const WORKBOOK = "media.paged.sheet.panel.workbook";
const GRID = "media.paged.sheet.panel.grid";
const DATASETS = "media.paged.sheet.panel.datasets";
const PROPERTIES = "media.paged.sheet.panel.properties";

/** Let the session's queued work land, inside `act`. */
async function settle(env: SheetEnv): Promise<void> {
  await act(async () => {
    await env.settle();
  });
}

function mount(env: SheetEnv, id: string): HTMLElement {
  const panel = env.panel(id);
  const { container } = render(
    createElement(panel.component as never, {
      paged: env.host.editor,
      api: {},
    }),
  );
  return container;
}

const q = (root: HTMLElement, sel: string) => {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`no ${sel} in the panel`);
  return el as HTMLElement;
};

// ── the reference renderer for the schema panel ──────────────────────────

const holder: { objects: BundleHost["objects"] | null } = { objects: null };

function PropertyRow(props: {
  row: PanelSchemaPropertyRow;
  address: string | null;
}): ReactElement {
  const { row, address } = props;
  // Keyed by its address (below), so a new target mounts a fresh row.
  const [v, setV] = useState<string>("");
  useEffect(() => {
    let live = true;
    if (address && holder.objects) {
      void holder.objects.get(address as never, row.path).then((o) => {
        if (live) setV(o.kind === "value" ? String(o.value ?? "") : "");
      });
    }
    return () => {
      live = false;
    };
  }, [address, row.path]);
  const kind = (row.kind ?? "").split("/").pop();
  return createElement("input", {
    "data-prop": `${kind}.${row.path}`,
    "data-address": address ?? "",
    value: v,
    onChange: (e: { target: { value: string } }) => setV(e.target.value),
    onKeyDown: (e: { key: string; currentTarget: { value: string } }) => {
      if (e.key === "Enter" && address)
        void holder.objects?.set(
          address as never,
          row.path,
          e.currentTarget.value,
        );
    },
  });
}

function ReferenceSchemaRenderer({
  schema,
  bindings,
}: SchemaPanelRendererProps): ReactElement {
  const [, force] = useState(0);
  useEffect(() => {
    const d = bindings.onDidChange(() => force((n) => n + 1));
    return () => d.dispose();
  }, [bindings]);
  return createElement(
    "div",
    { "data-schema": schema.id },
    schema.sections.map((sec) =>
      createElement(
        "section",
        { key: sec.title, "data-section": sec.title },
        sec.rows
          .filter(
            (r): r is PanelSchemaPropertyRow =>
              (r as { field?: string }).field === "property",
          )
          .map((row) => {
            const a = row.address as
              { bind: string } | { addresses: readonly string[] };
            const address =
              "bind" in a
                ? ((bindings.get(a.bind) as string | undefined) ?? null)
                : (a.addresses[0] ?? null);
            return createElement(PropertyRow, {
              key: `${row.path}@${address ?? ""}`,
              row,
              address,
            });
          }),
      ),
    ),
  );
}

describe.skipIf(!ENGINE_BUILT)(
  `paged.sheet panels${ENGINE_BUILT ? "" : " (unavailable: the sheet wasm, bash scripts/build-wasm.sh)"}`,
  () => {
    setDefaultTimeout(30_000);
    let env: SheetEnv;
    beforeAll(initSheetWasm);
    beforeEach(() => {
      env = unitEnv({ schemaPanelRenderer: ReferenceSchemaRenderer });
      holder.objects = env.objects;
    });
    afterEach(() => {
      cleanup();
      holder.objects = null;
      env.dispose();
    });

    it("Workbook: empty until a workbook opens; then its sheet and range; Place on page emits the table", async () => {
      covers("panel:media.paged.sheet.panel.workbook");
      const root = mount(env, WORKBOOK);
      expect(root.querySelector("[data-sheet-empty]")).not.toBeNull();
      expect(root.querySelector("[data-sheet-select]")).toBeNull();
      await act(async () => {
        await openBook(env);
      });
      await settle(env);
      expect(root.querySelector("[data-sheet-empty]")).toBeNull();
      const select = q(root, "[data-sheet-select]") as HTMLSelectElement;
      expect([...select.options].map((o) => o.textContent)).toEqual([
        "book (4 × 2)",
      ]);
      const range = q(root, "[data-sheet-range]") as HTMLInputElement;
      expect(range.value).toBe("A1:B4");
      // Narrow the range in the field, then place it.
      fireEvent.change(range, { target: { value: "A1:B2" } });
      const m = env.mark();
      await act(async () => {
        fireEvent.click(q(root, "[data-sheet-lower]"));
      });
      await settle(env);
      expect(env.mutationsSince(m).map((e) => e.op)).toContain("batch");
    });

    it("Workbook: New blank workbook asks a second click before it replaces the open one", async () => {
      covers("panel:media.paged.sheet.panel.workbook");
      await openBook(env);
      const root = mount(env, WORKBOOK);
      await settle(env);
      const neu = q(root, "[data-sheet-new]");
      fireEvent.click(neu);
      expect(neu.hasAttribute("data-armed")).toBe(true);
      expect(neu.textContent).toBe("Confirm replace");
      expect(await cell(env, "A2")).toBe("Apples"); // not replaced yet
      await act(async () => {
        fireEvent.click(neu);
      });
      await settle(env);
      expect(
        [...(q(root, "[data-sheet-select]") as HTMLSelectElement).options].map(
          (o) => o.textContent,
        ),
      ).toEqual([expect.stringMatching(/^Sheet1 /)]);
    });

    it("Grid: renders the cells; Find all lists the hits; a hit selects the cell; the formula bar writes it", async () => {
      covers("panel:media.paged.sheet.panel.grid");
      await openBook(env);
      const root = mount(env, GRID);
      await settle(env);
      const svg = q(root, "[data-grid-svg-root]");
      for (const t of ["name", "Apples", "Pears", "Figs", "12"])
        expect(svg.textContent).toContain(t);
      // The formula bar is disabled until a cell is selected.
      const bar = q(root, "[data-formula-input]") as HTMLInputElement;
      expect(bar.disabled).toBe(true);
      fireEvent.change(q(root, "[data-sheet-find-needle]"), {
        target: { value: "Pears" },
      });
      await act(async () => {
        fireEvent.click(q(root, "[data-sheet-find]"));
      });
      await settle(env);
      const hit = q(root, '[data-sheet-find-hit="2:0"]');
      expect(hit.textContent).toContain("A3");
      await act(async () => {
        fireEvent.click(hit);
      });
      await settle(env);
      expect(q(root, "[data-formula-cellref]").textContent).toBe("A3");
      expect(bar.disabled).toBe(false);
      expect(bar.value).toBe("Pears");
      fireEvent.change(bar, { target: { value: "Plums" } });
      await act(async () => {
        fireEvent.keyDown(bar, { key: "Enter" });
      });
      await settle(env);
      expect(await cell(env, "A3")).toBe("Plums");
      expect(svg.textContent).toContain("Plums");
    });

    it("Grid: Replace all rewrites every match", async () => {
      covers("panel:media.paged.sheet.panel.grid");
      await openBook(env);
      const root = mount(env, GRID);
      await settle(env);
      fireEvent.change(q(root, "[data-sheet-find-needle]"), {
        target: { value: "s" },
      });
      fireEvent.change(q(root, "[data-sheet-find-replacement]"), {
        target: { value: "z" },
      });
      await act(async () => {
        fireEvent.click(q(root, "[data-sheet-replace-all]"));
      });
      await settle(env);
      expect(await column(env, "A")).toEqual([
        "name",
        "Applez",
        "Pearz",
        "Figz",
      ]);
    });

    it("Grid + Find next: after a search in the panel, the palette's Find next moves to the next match", async () => {
      covers(
        "panel:media.paged.sheet.panel.grid",
        "command:media.paged.sheet.command.findNext",
      );
      await openBook(env);
      const root = mount(env, GRID);
      await settle(env);
      const needle = q(root, "[data-sheet-find-needle]");
      fireEvent.change(needle, { target: { value: "s" } });
      await act(async () => {
        fireEvent.keyDown(needle, { key: "Enter" });
      });
      await settle(env);
      expect(q(root, "[data-formula-cellref]").textContent).toBe("A2");
      await act(async () => {
        await env.command(`${C}.findNext`).handler(env.host.editor);
      });
      await settle(env);
      expect(q(root, "[data-formula-cellref]").textContent).toBe("A3");
      expect(
        env.logs.some((l) => l.text.includes("no match (or no search yet)")),
      ).toBe(false);
    });

    it("Datasets: an honest empty state; a published dataset is listed and Use seeds a sheet from it", async () => {
      covers("panel:media.paged.sheet.panel.datasets");
      let root = mount(env, DATASETS);
      expect(root.querySelector("[data-datasets-empty]")).not.toBeNull();
      cleanup();
      env.providers.register({
        id: "regional_sales-dataset",
        category: "dataset",
        schema: {
          fields: [
            { name: "region", ty: "text" },
            { name: "units", ty: "float" },
          ],
        },
        revision: "r1",
        getSnapshot: () => ({
          schema: {
            fields: [
              { name: "region", ty: "text" },
              { name: "units", ty: "float" },
            ],
          },
          columns: [["North"], [5]],
          rowCount: 1,
        }),
      } as never);
      root = mount(env, DATASETS);
      const row = q(root, '[data-dataset-id="regional_sales-dataset"]');
      expect(q(row, "[data-dataset-name]").textContent).toBe("Regional sales");
      expect(
        q(row, "[data-dataset-fields]").getAttribute("data-dataset-fields"),
      ).toBe("2");
      await act(async () => {
        fireEvent.click(q(row, "[data-dataset-source]"));
      });
      await settle(env);
      expect(
        await env.objects.get(`${P}/cell/Sheet1!A2` as never, "value"),
      ).toMatchObject({ value: "North" });
      expect(q(row, "[data-dataset-fields]").textContent).toContain("in use");
    });

    it("Properties: the Cell rows follow the grid's active cell, and an edit writes that cell", async () => {
      covers("panel:media.paged.sheet.panel.properties");
      await openBook(env);
      const root = mount(env, PROPERTIES);
      await settle(env);
      expect(
        q(root, '[data-section="Cell"] [data-prop="cell.value"]').getAttribute(
          "data-address",
        ),
      ).toBe("");
      await act(async () => {
        selectCell(env, 1, 1);
      });
      await settle(env);
      const value = q(
        root,
        '[data-section="Cell"] [data-prop="cell.value"]',
      ) as HTMLInputElement;
      expect(value.getAttribute("data-address")).toBe(`${P}/cell/book!B2`);
      expect(value.value).toBe("12");
      fireEvent.change(value, { target: { value: "99" } });
      await act(async () => {
        fireEvent.keyDown(value, { key: "Enter" });
      });
      await settle(env);
      expect(await cell(env, "B2")).toBe("99");
      // A multi-cell selection publishes the Selected range rows' address.
      await act(async () => {
        selectRect(env, 1, 0, 2, 1);
      });
      await settle(env);
      expect(
        q(
          root,
          '[data-section="Selected range"] [data-prop="range.values"]',
        ).getAttribute("data-address"),
      ).toBe(`${P}/range/book!A2:B3`);
      // The workbook rows address the one workbook.
      expect(
        q(
          root,
          '[data-section="Workbook"] [data-prop="workbook.name"]',
        ).getAttribute("data-address"),
      ).toBe(`${P}/workbook/main`);
    });
  },
);
