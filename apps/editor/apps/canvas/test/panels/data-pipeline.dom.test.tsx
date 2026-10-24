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

// The Data panel's pipeline (editor ADR 291, data ADR 562): offered when the
// service has one; the steps in lanes (sources → transforms → queries) with
// their rows or their error; a step selected shows its table in the grid; a
// transform is made, refused with the service's reason, applied and removed.

import { afterEach, describe, expect, test } from "bun:test";
import { act, fireEvent } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import type { DataService, DataTransformDef } from "@paged-media/plugin-api";
import { createDataRegistry, fakeDataService } from "@paged-media/plugin-sdk";
import { createEditorScope, setDataDoorSource } from "@paged-media/shell";

import { DataPanel } from "../../src/panels/data-panel";
import { mountPanel, unmountAll } from "./harness";

afterEach(unmountAll);

const settle = () =>
  act(async () => await new Promise((r) => setTimeout(r, 20)));

function serve(service: DataService) {
  const backend = createDataRegistry();
  const scope = createEditorScope();
  setDataDoorSource(scope, backend);
  act(() => void backend.serve("media.paged.data", service));
  return scope;
}

function service() {
  const fake = fakeDataService({
    products: {
      fields: [
        { name: "sku", ty: "text" },
        { name: "stock", ty: "int" },
      ],
      rows: [
        { sku: "A-1", stock: 3 },
        { sku: "B-2", stock: 0 },
      ],
    },
    q: {
      kind: "query",
      fields: [{ name: "sku", ty: "text" }],
      rows: [{ sku: "A-1" }],
    },
  });
  const defined: DataTransformDef[] = [];
  const s: DataService = {
    ...fake,
    async defineTransform(def) {
      if (def.source.includes("nope"))
        throw new Error('no table "nope" to read');
      defined.push(def);
      await fake.defineTransform!(def);
    },
  };
  return { service: s, defined };
}

describe("Data panel pipeline [editor-shell.data-panel]", () => {
  test("a service without a pipeline offers none", async () => {
    covers("panel:paged.data");
    const { service: s } = service();
    const { pipeline: _p, ...rest } = s;
    const scope = serve(rest);
    const h = await mountPanel(DataPanel, {
      id: "paged.data",
      document: "none",
      scope,
    });
    await settle();
    expect(h.root.querySelector("[data-data-tab='products']")).not.toBeNull();
    expect(h.root.querySelector("[data-data-pipeline-toggle]")).toBeNull();
  });

  test("the steps, a step's rows in the grid, a transform made, refused, applied and removed", async () => {
    covers("panel:paged.data");
    const { service: s, defined } = service();
    const scope = serve(s);
    const h = await mountPanel(DataPanel, {
      id: "paged.data",
      document: "none",
      scope,
    });
    await settle();
    const q = (sel: string) => h.root.querySelector(sel) as HTMLElement | null;
    await act(async () => q("[data-data-pipeline-toggle]")!.click());
    await settle();
    expect(q("[data-data-pipeline-toggle]")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    const lane = (kind: string) =>
      [
        ...h.root.querySelectorAll(
          `[data-pipeline-lane='${kind}'] [data-pipeline-step]`,
        ),
      ].map((e) => e.getAttribute("data-pipeline-step"));
    expect(lane("source")).toEqual(["products"]);
    expect(lane("transform")).toEqual([]);
    expect(lane("query")).toEqual(["q"]);
    expect(
      q("[data-pipeline-step='products'] [data-pipeline-rows]")?.textContent,
    ).toBe("2 rows");

    // A step selected: its table's tab in the grid.
    await act(async () => q("[data-pipeline-step='q']")!.click());
    await settle();
    expect(q("[data-data-tab='q']")?.getAttribute("aria-selected")).toBe(
      "true",
    );

    // A new transform: bad parameters, then the service's refusal, inline.
    await act(async () => q("[data-pipeline-new]")!.click());
    const editor = () => q("[data-pipeline-editor]")!;
    expect(editor()).not.toBeNull();
    fireEvent.change(q("[data-pipeline-name]")!, {
      target: { value: "lowStock" },
    });
    await act(async () => q("[data-pipeline-input='products']")!.click());
    const textarea = (label: string) =>
      editor().querySelector(`textarea[aria-label^='${label}']`)!;
    fireEvent.change(textarea("Parameters"), {
      target: { value: "[1, 2]" },
    });
    await act(async () => q("[data-pipeline-apply]")!.click());
    await settle();
    expect(q("[data-pipeline-error]")?.textContent).toContain(
      "not a JSON object",
    );
    fireEvent.change(textarea("Parameters"), {
      target: { value: '{ "below": 1 }' },
    });
    fireEvent.change(textarea("Source"), {
      target: { value: "(t) => t.nope" },
    });
    await act(async () => q("[data-pipeline-apply]")!.click());
    await settle();
    expect(q("[data-pipeline-error]")?.textContent).toBe(
      'Not applied: no table "nope" to read',
    );
    expect(defined).toEqual([]);

    // Applied: the service has it, the transforms lane shows it selected.
    const source = "(t, p) => t.products.filter((r) => r.stock < p.below)";
    fireEvent.change(textarea("Source"), { target: { value: source } });
    await act(async () => q("[data-pipeline-apply]")!.click());
    await settle();
    expect(defined).toEqual([
      {
        id: "lowStock",
        inputs: ["products"],
        source,
        params: { below: 1 },
      },
    ]);
    expect(lane("transform")).toEqual(["lowStock"]);
    expect(
      q("[data-pipeline-step='lowStock']")?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(q("[data-pipeline-step='lowStock']")?.textContent).toContain(
      "reads products",
    );
    // Its editor, with what it was given; the name stays.
    expect(editor().getAttribute("data-pipeline-editor")).toBe("lowStock");
    expect((q("[data-pipeline-name]") as HTMLInputElement).readOnly).toBe(true);
    expect((textarea("Source") as HTMLTextAreaElement).value).toBe(source);

    // Removed.
    await act(async () => q("[data-pipeline-remove]")!.click());
    await settle();
    expect(lane("transform")).toEqual([]);
    expect(q("[data-pipeline-editor]")).toBeNull();
    expect(await s.pipeline!()).toHaveLength(2);
  });
});
