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

// Editor ADR 292 — the bind popover over a data service (data@1): pick a
// field and bind it; compose rules and see what they give at each record; a
// service with no query says there is nothing to bind to yet.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import type {
  DataBindingSpec,
  DataService,
  DataTableInfo,
} from "@paged-media/plugin-api";

import { BindPopover } from "../../src/catalog/bind-popover";

const Q: DataTableInfo = {
  name: "q",
  kind: "query",
  schema: {
    fields: [
      { name: "sku", ty: "text" },
      { name: "price", ty: "float" },
      { name: "unit price", ty: "float" },
    ],
  },
  rowCount: 2,
  revision: "1",
  writable: false,
};

const ROWS = [
  { sku: "A-1", price: 9.5 },
  { sku: "B-2", price: 120 },
];

/** A service that knows one query and evaluates fields and the rules the
 *  popover writes for `price > 100`. */
function service(tables: DataTableInfo[] = [Q]) {
  const bound: DataBindingSpec[] = [];
  const asked: string[] = [];
  const svc: DataService = {
    tables: () => tables,
    records: async () => ({ schema: Q.schema, columns: [], rowCount: 0 }),
    async evaluate(_query, expr, record) {
      asked.push(expr);
      const row = ROWS[record]!;
      if (expr in row) {
        const v = row[expr as keyof typeof row];
        return { display: String(v), value: v };
      }
      if (expr === "IF(price > 100, 14, 10)") {
        const v = row.price > 100 ? 14 : 10;
        return { display: String(v), value: v };
      }
      return { display: "", value: null, error: "not understood" };
    },
    async bind(spec) {
      bound.push(spec);
      return { ...spec, id: "b1" };
    },
  };
  return { svc, bound, asked };
}

const target = {
  selector: "rectangle:u1",
  path: "frameOpacity",
  label: "Opacity",
};
const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;

afterEach(() => cleanup());

describe("the bind popover [editor-shell.bind-popover]", () => {
  test("a field is picked, previewed per record and bound", async () => {
    const { svc, bound } = service();
    let closed = false;
    render(
      <BindPopover
        service={svc}
        target={target}
        onClose={() => (closed = true)}
      />,
    );
    await flush();
    expect(q("[data-bind-field='unit price']")?.hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.click(q("[data-bind-field='price']")!);
    await flush();
    expect(q("[data-bind-compiled]")?.textContent).toBe("price");
    expect(q("[data-bind-value]")?.textContent).toBe("9.5");
    fireEvent.click(document.querySelector("[aria-label='Next record']")!);
    await flush();
    expect(q("[data-bind-value]")?.textContent).toBe("120");
    fireEvent.click(q("[data-bind-confirm]")!);
    await flush();
    expect(bound).toEqual([
      {
        target: "rectangle:u1",
        path: "frameOpacity",
        query: "q",
        expr: "price",
      },
    ]);
    expect(closed).toBe(true);
  });

  test("rules compile to one expression and preview what they give", async () => {
    const { svc } = service();
    render(<BindPopover service={svc} target={target} onClose={() => {}} />);
    await flush();
    fireEvent.click(q("[data-bind-mode='rules']")!);
    fireEvent.click(document.querySelector("[data-bind-rules] > button")!);
    const row = q("[data-bind-rule='0']")!;
    const selects = row.querySelectorAll("select");
    fireEvent.change(selects[0]!, { target: { value: "price" } });
    fireEvent.change(selects[1]!, { target: { value: ">" } });
    const inputs = row.querySelectorAll("input");
    fireEvent.change(inputs[0]!, { target: { value: "100" } });
    fireEvent.change(inputs[1]!, { target: { value: "14" } });
    const otherwise = document.querySelectorAll(
      "[data-bind-rules] > label input",
    )[0]!;
    fireEvent.change(otherwise, { target: { value: "10" } });
    await flush();
    expect(q("[data-bind-compiled]")?.textContent).toBe(
      "IF(price > 100, 14, 10)",
    );
    expect(q("[data-bind-value]")?.textContent).toBe("10");
    fireEvent.click(document.querySelector("[aria-label='Next record']")!);
    await flush();
    expect(q("[data-bind-value]")?.textContent).toBe("14");
  });

  test("an expression the service cannot read shows why, and no data says so", async () => {
    const { svc } = service();
    const { unmount } = render(
      <BindPopover service={svc} target={target} onClose={() => {}} />,
    );
    await flush();
    fireEvent.click(q("[data-bind-mode='expression']")!);
    fireEvent.change(q("[data-bind-expression]")!, {
      target: { value: "price +" },
    });
    await flush();
    expect(q("[data-bind-value]")?.textContent).toContain("not understood");
    unmount();
    render(
      <BindPopover
        service={service([]).svc}
        target={target}
        onClose={() => {}}
      />,
    );
    await flush();
    expect(q("[data-bind-no-data]")).not.toBeNull();
    expect((q("[data-bind-confirm]") as HTMLButtonElement).disabled).toBe(true);
  });
});
