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

// paged.data's five panels as COMPONENTS (happy-dom, `bun run test:dom`):
// the component the real bundle registered, mounted with
// @testing-library/react over the real session, the real data-js engine and
// a real DuckDB (the recording fake editor stands in for the editor;
// ./conformance/env.ts). Each test renders a panel against a state and
// drives one interaction to its effect.
//
// The Data overview panel is a SCHEMA panel the editor renders. A small
// reference renderer stands in here (labels with their `visible` gate,
// lists from the published rows with their selection binding, property
// rows reading `host.objects`), so what is asserted is the bundle's half:
// the rows, the gates and the addresses it publishes.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, useEffect, useState, type ReactElement } from "react";

import type {
  BindingsSurface,
  BundleHost,
  PanelSchemaRow,
  SchemaPanelRendererProps,
} from "@paged-media/plugin-api";
import { covers, waitFor } from "@paged-media/test-kit";

import { readiness, unitEnv, type DataEnv } from "./conformance/env";
import { CSV, PANEL, seed } from "./conformance/scenarios";

const gate = readiness(false);
const enc = new TextEncoder();
const OBJECTS = "media.paged.data.panel.objects";

if (gate.required && !gate.ready) {
  describe("data panels (engines) — REQUIRED", () => {
    it("FAILS: a REQUIRE_REAL_* lane but an engine is missing", () => {
      throw new Error(`missing: ${gate.missing}`);
    });
  });
}

async function settle(env: DataEnv): Promise<void> {
  await act(async () => {
    await env.settle();
  });
}

function mount(env: DataEnv, id: string): HTMLElement {
  const { container } = render(
    createElement(env.panel(id).component as never, {
      paged: env.host.editor,
      api: {},
    }),
  );
  return container;
}

const q = (root: ParentNode, sel: string): HTMLElement => {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`no ${sel} in the panel`);
  return el as HTMLElement;
};

// ── the reference renderer for the schema panel ──────────────────────────

const holder: { objects: BundleHost["objects"] | null } = { objects: null };

type Gate = { bind: string; negate?: boolean } | undefined;
const shown = (bindings: BindingsSurface, g: Gate) =>
  !g || !!bindings.get(g.bind) !== !!g.negate;

function Property(props: {
  kind: string;
  path: string;
  address: string | null;
}): ReactElement {
  const { kind, path, address } = props;
  const [v, setV] = useState("");
  useEffect(() => {
    let live = true;
    if (address && holder.objects) {
      void holder.objects.get(address as never, path).then((o) => {
        if (live) setV(o.kind === "value" ? String(o.value ?? "") : "");
      });
    }
    return () => {
      live = false;
    };
  }, [address, path]);
  return createElement("output", {
    "data-prop": `${kind}.${path}`,
    "data-address": address ?? "",
    children: v,
  });
}

function Row(props: {
  row: PanelSchemaRow;
  bindings: BindingsSurface;
}): ReactElement | null {
  const { row, bindings } = props;
  const r = row as {
    widget?: string;
    field?: string;
    props?: { text?: string };
    visible?: Gate;
    list?: { items: { bind: string }; selectionBinding: string };
    address?: { bind?: string };
    kind?: string;
    path?: string;
  };
  if (!shown(bindings, r.visible)) return null;
  if (r.widget === "paged.label")
    return createElement("p", { "data-label": "" }, r.props?.text ?? "");
  if (r.widget === "paged.list" && r.list) {
    const items =
      (bindings.get(r.list.items.bind) as
        { selfId: string; name: string }[] | undefined) ?? [];
    const select = r.list.selectionBinding;
    return createElement(
      "ul",
      { "data-list": r.list.items.bind },
      items.map((it) =>
        createElement(
          "li",
          { key: it.selfId },
          createElement(
            "button",
            {
              "data-item": it.selfId,
              "aria-selected": bindings.get(select) === it.selfId,
              onClick: () => bindings.publish(select, it.selfId),
            },
            it.name,
          ),
        ),
      ),
    );
  }
  if (r.field === "property") {
    const address = r.address?.bind
      ? ((bindings.get(r.address.bind) as string | undefined) ?? null)
      : null;
    return createElement(Property, {
      key: `${r.path}@${address ?? ""}`,
      kind: (r.kind ?? "").split("/").pop() ?? "",
      path: r.path ?? "",
      address,
    });
  }
  return null;
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
    schema.sections.map((sec, i) =>
      createElement(
        "section",
        { key: sec.title ?? i, "data-section": sec.title ?? "" },
        sec.rows.map((row, j) => createElement(Row, { key: j, row, bindings })),
      ),
    ),
  );
}

describe.skipIf(!gate.ready && !gate.required)(
  `paged.data panels${gate.ready ? "" : ` (unavailable: ${gate.missing})`}`,
  () => {
    setDefaultTimeout(60_000);
    let env: DataEnv;
    beforeEach(async () => {
      env = await unitEnv({ schemaPanelRenderer: ReferenceSchemaRenderer });
      holder.objects = env.objects;
    });
    afterEach(() => {
      cleanup();
      holder.objects = null;
      env.dispose();
    });

    it("Data sources: no sources; Import file… takes the picked CSV and lists it with its format", async () => {
      covers("panel:media.paged.data.panel.sources");
      const root = mount(env, PANEL.sources);
      expect(root.textContent).toContain("No sources yet.");
      env.pick([
        {
          name: "products.csv",
          bytes: enc.encode(CSV),
          mimeType: "text/csv",
        } as never,
      ]);
      await act(async () => {
        fireEvent.click(q(root, "[data-data-import-file]"));
      });
      // The first import boots DuckDB: wait for the session to hold the
      // source (outside `act`, which would hold the import's own turns),
      // then let the panel render it.
      await waitFor(
        () => expect(env.session.getState().sources).toEqual(["products"]),
        { timeout: 30_000 },
      );
      await settle(env);
      const row = q(root, '[data-data-source="products"]');
      expect(row.textContent).toContain("products.csv");
      expect(env.session.getState().sources).toEqual(["products"]);
    });

    it("Bindings: with no source it says so and leads to Data sources; with one, Merge records reports the outcome", async () => {
      covers("panel:media.paged.data.panel.bindings");
      let root = mount(env, PANEL.bindings);
      expect(q(root, "[data-data-bind-empty]").textContent).toContain(
        "Import a data source to start binding.",
      );
      fireEvent.click(q(root, "[data-data-bind-open-sources]"));
      expect(env.opened).toEqual([PANEL.sources]);
      cleanup();
      await seed(env);
      root = mount(env, PANEL.bindings);
      await settle(env);
      expect(root.querySelector("[data-data-bind-empty]")).toBeNull();
      await act(async () => {
        fireEvent.click(q(root, "[data-data-merge-run]"));
      });
      await settle(env);
      // The fake page holds no <<field>> frame: the panel says why.
      expect(q(root, "[data-data-merge-msg]").textContent).toContain(
        "the template page has no frames",
      );
    });

    it("Dataset preview: Preview rows shows the query's first rows", async () => {
      covers("panel:media.paged.data.panel.dataset");
      let root = mount(env, PANEL.dataset);
      expect(q(root, "[data-data-dataset-empty]").textContent).toContain(
        "Import a data source first.",
      );
      fireEvent.click(q(root, "[data-data-dataset-open-sources]"));
      expect(env.opened).toEqual([PANEL.sources]);
      cleanup();
      await seed(env);
      root = mount(env, PANEL.dataset);
      await settle(env);
      await act(async () => {
        fireEvent.click(q(root, "[data-data-dataset-preview]"));
      });
      await settle(env);
      const rows = q(root, "[data-data-dataset-rows]");
      expect(rows.getAttribute("data-data-dataset-rows")).toBe("3");
      for (const t of ["sku", "Alpha", "Beta", "Gamma"])
        expect(rows.textContent).toContain(t);
    });

    it("Data query: SQL previews in the grid, and Save query adds it to the session", async () => {
      covers("panel:media.paged.data.panel.query");
      await seed(env);
      const root = mount(env, PANEL.query);
      await settle(env);
      fireEvent.change(q(root, "[data-data-query-sql]"), {
        target: { value: "SELECT name FROM products WHERE weight_mm > 3" },
      });
      await act(async () => {
        fireEvent.click(q(root, "[data-data-query-preview]"));
      });
      await settle(env);
      const grid = q(root, "[data-data-query-grid]");
      expect(grid.textContent).toContain("Beta");
      expect(grid.textContent).toContain("Gamma");
      expect(grid.textContent).not.toContain("Alpha");
      fireEvent.change(q(root, "[data-data-query-id]"), {
        target: { value: "heavy" },
      });
      await act(async () => {
        fireEvent.click(q(root, "[data-data-query-save]"));
      });
      await settle(env);
      expect(q(root, "[data-data-query-saved]").textContent).toContain("heavy");
      expect(env.session.listQueries().map((x) => x.id)).toContain("heavy");
    });

    it("Data overview: empty lines until data exists; then the lists, the first item picked, its rows addressed", async () => {
      covers("panel:media.paged.data.panel.objects");
      const root = mount(env, OBJECTS);
      await settle(env);
      const sources = () => q(root, '[data-section="Sources"]');
      expect(sources().textContent).toContain("No sources yet.");
      expect(sources().querySelector("[data-list]")).toBeNull();
      await act(async () => {
        await seed(env);
        await env.objects.invoke("media.paged.data.defineSource" as never, {
          name: "regions",
          csv: "region\nNorth\n",
        });
      });
      await settle(env);
      const items = [...sources().querySelectorAll("[data-item]")].map((b) =>
        b.getAttribute("data-item"),
      );
      expect(items).toEqual([
        "plugin:media.paged.data/source/products",
        "plugin:media.paged.data/source/regions",
      ]);
      // The selection falls back to the first row; its rows address it.
      const name = () => q(sources(), '[data-prop="source.name"]');
      expect(name().getAttribute("data-address")).toBe(
        "plugin:media.paged.data/source/products",
      );
      await settle(env);
      expect(name().textContent).toBe("products");
      await act(async () => {
        fireEvent.click(
          q(sources(), '[data-item="plugin:media.paged.data/source/regions"]'),
        );
      });
      await settle(env);
      expect(name().getAttribute("data-address")).toBe(
        "plugin:media.paged.data/source/regions",
      );
      expect(name().textContent).toBe("regions");
      // The query the seed defined is listed under Queries.
      expect(
        q(root, '[data-section="Queries"]').querySelector(
          '[data-item="plugin:media.paged.data/query/q"]',
        ),
      ).not.toBeNull();
    });
  },
);
