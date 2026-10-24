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

// The Data panel's picture columns (editor ADR 291; data ADR 563): a query's
// field is declared an asset column from its header (right-click) or the
// toolbar, with a base URL and a chain of the registered actions that take
// and give an asset; each step's parameters are edited from the action's
// defaults (or as JSON when it has none), steps reorder and go; Save hands
// the service the column, Clear removes it, and the header marks it. A
// service without the members shows none of it.

import { afterEach, describe, expect, test } from "bun:test";
import { act, fireEvent } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import type {
  DataAssetColumn,
  DataAssetColumnDef,
  DataService,
  DataTableInfo,
} from "@paged-media/plugin-api";
import {
  createActionRegistry,
  createDataRegistry,
} from "@paged-media/plugin-sdk";
import {
  createEditorScope,
  setDataDoorSource,
  setRegisteredActionsSource,
} from "@paged-media/shell";

import { DataPanel } from "../../src/panels/data-panel";
import { mountPanel, unmountAll } from "./harness";

afterEach(unmountAll);

const TABLE: DataTableInfo = {
  name: "q",
  kind: "query",
  schema: {
    fields: [
      { name: "sku", ty: "text" },
      { name: "photo", ty: "text" },
    ],
  },
  rowCount: 1,
  revision: "1",
  writable: false,
};

function serve(assets: boolean) {
  const backend = createDataRegistry();
  const actions = createActionRegistry();
  const scope = createEditorScope();
  setDataDoorSource(scope, backend);
  setRegisteredActionsSource(scope, actions);
  for (const a of [
    {
      id: "img/blur",
      title: "Blur",
      input: "asset" as const,
      output: "asset" as const,
      params: { radius: 2, sharp: false },
    },
    {
      id: "img/trim",
      title: "Trim",
      input: "asset" as const,
      output: "asset" as const,
    },
    {
      id: "img/measure",
      title: "Measure",
      input: "asset" as const,
      output: "value" as const,
    },
  ])
    actions.register("test.images", { ...a, run: (x: unknown) => x });
  const columns = new Map<string, DataAssetColumn>();
  const calls: [string, string, DataAssetColumnDef | null][] = [];
  let revision = 1;
  let handle!: ReturnType<typeof backend.serve>;
  const service: DataService = {
    tables: () => [TABLE],
    records: async () => ({ schema: TABLE.schema, columns: [], rowCount: 0 }),
    async query(sql) {
      if (sql.startsWith("SELECT count(*)"))
        return {
          schema: { fields: [{ name: "n", ty: "int" }] },
          columns: [[1]],
          rowCount: 1,
        };
      return {
        schema: TABLE.schema,
        columns: [["A-1"], ["a.png"]],
        rowCount: 1,
      };
    },
    status: async () => [],
    ...(assets
      ? {
          assetColumns: async () => [...columns.values()],
          async setAssetColumn(
            query: string,
            field: string,
            def: DataAssetColumnDef | null,
          ) {
            calls.push([query, field, def]);
            if (def) columns.set(field, { query, field, ...def });
            else columns.delete(field);
            handle.changed({ table: query, revision: String(++revision) });
          },
        }
      : {}),
  };
  act(() => {
    handle = backend.serve("media.paged.data", service);
  });
  return { scope, calls };
}

const settle = () =>
  act(async () => await new Promise((r) => setTimeout(r, 20)));

describe("Data panel picture columns [editor-shell.data-panel]", () => {
  test("declare a field a picture column with a chain; the header marks it; clear it", async () => {
    covers("panel:paged.data");
    const { scope, calls } = serve(true);
    const h = await mountPanel(DataPanel, {
      id: "paged.data",
      document: "none",
      scope,
    });
    await settle();
    const header = (f: string) =>
      h.root.querySelector(`[data-data-header='${f}']`) as HTMLElement;
    expect(header("photo").querySelector("[data-data-asset-marker]")).toBe(
      null,
    );

    // Right-click the header: the editor opens for that field.
    await act(async () => void fireEvent.contextMenu(header("photo")));
    const editor = () =>
      h.root.querySelector("[data-data-asset-editor]") as HTMLElement | null;
    expect(editor()?.getAttribute("data-data-asset-editor")).toBe("photo");

    // Only the actions that take and give an asset are offered.
    const pick = editor()!.querySelector("[data-asset-pick]")!;
    expect(
      [...pick.querySelectorAll("option")].map((o) => o.textContent),
    ).toEqual(["Add an action…", "Blur", "Trim"]);

    await h.user.type(
      editor()!.querySelector("[data-asset-base]")!,
      "https://m.example/",
    );
    await h.user.selectOptions(pick, "img/blur");
    await act(async () =>
      (editor()!.querySelector("[data-asset-add]") as HTMLElement).click(),
    );
    // A registered action's parameters are fields over its defaults.
    const radius = editor()!.querySelector(
      "[data-asset-param='radius']",
    ) as HTMLInputElement;
    expect(radius.value).toBe("2");
    await act(
      async () => void fireEvent.change(radius, { target: { value: "5" } }),
    );
    await h.user.selectOptions(
      editor()!.querySelector("[data-asset-pick]")!,
      "img/trim",
    );
    await act(async () =>
      (editor()!.querySelector("[data-asset-add]") as HTMLElement).click(),
    );
    // An action without defaults takes JSON.
    const json = editor()!.querySelector("[data-asset-json]")!;
    await act(
      async () =>
        void fireEvent.change(json, { target: { value: '{"tolerance":1}' } }),
    );
    // Move Trim before Blur.
    await act(async () =>
      (
        editor()!.querySelectorAll("[aria-label='Move up']")[1] as HTMLElement
      ).click(),
    );
    expect(
      [...editor()!.querySelectorAll("[data-asset-step]")].map((s) =>
        s.getAttribute("data-asset-step"),
      ),
    ).toEqual(["img/trim", "img/blur"]);

    await act(async () =>
      (editor()!.querySelector("[data-asset-save]") as HTMLElement).click(),
    );
    await settle();
    expect(calls).toEqual([
      [
        "q",
        "photo",
        {
          chain: [
            { action: "img/trim", params: { tolerance: 1 } },
            { action: "img/blur", params: { radius: 5 } },
          ],
          base: "https://m.example/",
        },
      ],
    ]);
    expect(editor()).toBe(null);
    expect(header("photo").querySelector("[data-data-asset-marker]")).not.toBe(
      null,
    );
    expect(header("sku").querySelector("[data-data-asset-marker]")).toBe(null);

    // The toolbar opens the declared column; Clear removes it.
    await act(async () =>
      (
        h.root.querySelector("[data-data-picture-toggle]") as HTMLElement
      ).click(),
    );
    expect(editor()?.getAttribute("data-data-asset-editor")).toBe("photo");
    expect(editor()!.querySelectorAll("[data-asset-step]").length).toBe(2);
    await act(async () =>
      (editor()!.querySelector("[data-asset-clear]") as HTMLElement).click(),
    );
    await settle();
    expect(calls.at(-1)).toEqual(["q", "photo", null]);
    expect(header("photo").querySelector("[data-data-asset-marker]")).toBe(
      null,
    );
  });

  test("parameters that are not a JSON object are not saved", async () => {
    covers("panel:paged.data");
    const { scope, calls } = serve(true);
    const h = await mountPanel(DataPanel, {
      id: "paged.data",
      document: "none",
      scope,
    });
    await settle();
    await act(async () =>
      (
        h.root.querySelector("[data-data-picture-toggle]") as HTMLElement
      ).click(),
    );
    const editor = h.root.querySelector("[data-data-asset-editor]")!;
    expect(editor.getAttribute("data-data-asset-editor")).toBe("sku");
    await h.user.selectOptions(
      editor.querySelector("[data-asset-pick]")!,
      "img/trim",
    );
    await act(async () =>
      (editor.querySelector("[data-asset-add]") as HTMLElement).click(),
    );
    await act(
      async () =>
        void fireEvent.change(editor.querySelector("[data-asset-json]")!, {
          target: { value: "[1]" },
        }),
    );
    await act(async () =>
      (editor.querySelector("[data-asset-save]") as HTMLElement).click(),
    );
    expect(editor.querySelector("[data-asset-failure]")?.textContent).toContain(
      "Trim",
    );
    expect(calls).toEqual([]);
  });

  test("a service without asset columns shows no picture column control", async () => {
    covers("panel:paged.data");
    const { scope } = serve(false);
    const h = await mountPanel(DataPanel, {
      id: "paged.data",
      document: "none",
      scope,
    });
    await settle();
    expect(h.root.querySelector("[data-data-picture-toggle]")).toBe(null);
    await act(
      async () =>
        void fireEvent.contextMenu(
          h.root.querySelector("[data-data-header='photo']")!,
        ),
    );
    expect(h.root.querySelector("[data-data-asset-editor]")).toBe(null);
  });
});
