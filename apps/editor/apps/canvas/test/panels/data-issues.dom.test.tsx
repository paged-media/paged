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

// The Data panel's issues line (editor ADR 291, amended 2026-10-24): the
// service's issues summed up by kind, worst first, each message in the
// tooltip; a click selects the frames concerned; nothing shows when there
// are none, or the service serves no issues.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import type {
  DataIssue,
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

const TABLE: DataTableInfo = {
  name: "products",
  kind: "query",
  schema: { fields: [{ name: "sku", ty: "text" }] },
  rowCount: 1,
  revision: "1",
  writable: false,
};

const ONE: ProviderRecordSet = {
  schema: { fields: [{ name: "sku", ty: "text" }] },
  columns: [["A-1"]],
  rowCount: 1,
};

function serve(issues: (() => DataIssue[]) | null) {
  const backend = createDataRegistry();
  const scope = createEditorScope();
  setDataDoorSource(scope, backend);
  const service: DataService = {
    tables: () => [TABLE],
    records: async () => ONE,
    async query(sql) {
      return sql.startsWith("SELECT count(*)")
        ? {
            schema: { fields: [{ name: "n", ty: "int" }] },
            columns: [[1]],
            rowCount: 1,
          }
        : ONE;
    },
    status: async () => [],
    ...(issues ? { issues: async () => issues() } : {}),
  };
  const handle = {
    current: null as null | {
      changed(c: { table: string; revision: string }): void;
    },
  };
  act(() => {
    handle.current = backend.serve("media.paged.data", service);
  });
  let revision = 1;
  // The data changed: the panel reads the issues again.
  const changed = () =>
    act(() =>
      handle.current!.changed({
        table: "products",
        revision: String(++revision),
      }),
    );
  return { scope, changed };
}

const settle = () =>
  act(async () => await new Promise((r) => setTimeout(r, 20)));

describe("Data panel issues line", () => {
  test("sums the issues by kind and selects their frames [data.issues]", async () => {
    covers("panel:paged.data");
    let issues: DataIssue[] = [];
    const { scope, changed } = serve(() => issues);
    const h = await mountPanel(DataPanel, {
      id: "paged.data",
      scene: shapesScene,
      scope,
    });
    const address = (id: { kind: string; id: unknown }) =>
      `${id.kind}:${String(id.id)}`;
    issues = [
      {
        kind: "overset",
        severity: "warning",
        message: "The text of name does not fit its frame",
        binding: "b1",
        address: address(h.scene.rect),
      },
      {
        kind: "overset",
        severity: "warning",
        message: "The text of title does not fit its frame",
        binding: "b2",
        address: address(h.scene.oval),
      },
      {
        kind: "missingAsset",
        severity: "error",
        message: "The picture of photo is missing",
        binding: "b3",
        address: address(h.scene.rect),
      },
    ];
    await changed();
    await settle();
    const line = h.root.querySelector("[data-data-issues]") as HTMLElement;
    expect(line).not.toBeNull();
    expect(line.getAttribute("data-data-issues")).toBe("error");
    expect(line.textContent).toBe("1 picture missing · 2 texts do not fit");
    expect(line.title).toContain("The text of title does not fit its frame");

    const from = h.mark();
    await h.user.click(line);
    await h.settle();
    await settle();
    const sent = h.sent("setElementSelection", from);
    expect(sent.length).toBe(1);
    expect(
      (sent[0]!.payload as { ids: { kind: string; id: unknown }[] }).ids.map(
        address,
      ),
    ).toEqual([address(h.scene.rect), address(h.scene.oval)]);

    // Fixed: the line goes.
    issues = [];
    await changed();
    await settle();
    expect(h.root.querySelector("[data-data-issues]")).toBeNull();
  });

  test("a service that serves no issues shows no line [data.issues]", async () => {
    covers("panel:paged.data");
    const { scope } = serve(null);
    const h = await mountPanel(DataPanel, {
      id: "paged.data",
      document: "none",
      scope,
    });
    await settle();
    expect(h.root.querySelector("[data-data-panel]")).not.toBeNull();
    expect(h.root.querySelector("[data-data-issues]")).toBeNull();
  });
});
