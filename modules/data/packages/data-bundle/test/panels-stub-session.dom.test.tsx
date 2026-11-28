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

// The panels as COMPONENTS over a stub session (happy-dom, `bun run
// test:dom`): each panel is mounted with @testing-library/react, driven
// through the DOM (a change event on a field, a click on a button) and read
// back from the DOM. The session is a stub that records what the panel asked
// of it, so what is asserted is the panel's half: what it renders for a
// state, and what it calls for an interaction. (./panels.dom.test.tsx mounts
// the same panels over the real session and engine.)

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, type ComponentType } from "react";

import type { BundleHost } from "@paged-media/plugin-api";
import {
  FALLBACK_WIDGETS,
  silentConsole as silent,
} from "@paged-media/plugin-sdk";

import { makeBindingsPanel, queryOptions } from "../src/panels/bindings-panel";
import { makeDatasetPanel } from "../src/panels/dataset-panel";
import { makeSourcesPanel } from "../src/panels/sources-panel";
import type {
  DataProviderPublication,
  DataSourceSession,
  SessionState,
} from "../src/session";

afterEach(() => cleanup());

function stubSession(
  over: Partial<DataSourceSession>,
  state?: Partial<SessionState>,
): DataSourceSession {
  const base: SessionState = {
    status: "ready",
    message: "",
    sources: ["people"],
    queries: [],
    bindings: [],
    remote: [],
    diagnostics: [],
    persistence: { status: "saved", hash: null },
    files: [],
    refresh: {},
    polling: [],
    ...state,
  };
  const defaults: Record<string, unknown> = {
    getState: () => base,
    onDidChange: () => ({ dispose() {} }),
    // What the panels ask on mount, in an effect.
    templateFieldTargets: async () => [],
    locales: async () => [],
  };
  return new Proxy(over as DataSourceSession, {
    get(target, key) {
      if (key in target)
        return (target as unknown as Record<string | symbol, unknown>)[key];
      if (typeof key === "string" && key in defaults) return defaults[key];
      return () => undefined;
    },
  });
}

const host = {
  log: silent,
  supports: () => true,
  selection: { get: () => [] },
  // The contract's widget catalog (the host's NumericField, editor ADR 1216).
  widgets: FALLBACK_WIDGETS,
} as unknown as BundleHost;

/** Mount a panel and let what its effects started on mount finish; `find`
 *  is the one element carrying an attribute. */
async function mount(Panel: ComponentType) {
  const view = render(createElement(Panel));
  await act(() => new Promise<void>((r) => setTimeout(r, 0)));
  const c = view.container;
  return {
    ...view,
    c,
    find: (attr: string) => c.querySelector<HTMLElement>(`[${attr}]`),
    need(attr: string): HTMLElement {
      const el = c.querySelector<HTMLElement>(`[${attr}]`);
      if (!el) throw new Error(`no [${attr}] in the panel`);
      return el;
    },
    buttons: () => [...c.querySelectorAll<HTMLButtonElement>("button")],
    button(label: RegExp): HTMLButtonElement {
      const b = [...c.querySelectorAll<HTMLButtonElement>("button")].find((e) =>
        label.test(e.textContent ?? ""),
      );
      if (!b) throw new Error(`no button ${label}`);
      return b;
    },
  };
}

/** Type into a field or pick an option. */
const change = (el: Element, value: string) =>
  act(() => void fireEvent.change(el, { target: { value } }));

/** Click, and let the handler's promises and the re-render settle. */
async function click(el: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(el);
    await new Promise((r) => setTimeout(r, 0));
  });
}

const diagnosticsShown = (c: HTMLElement) =>
  [...c.querySelectorAll("li[data-source]")].map((e) => e.textContent);

describe("bindings panel [data.bind.authoring]", () => {
  it("a variable binding gets the chosen field as its expression, not an empty one [data.bind.authoring]", async () => {
    const calls: unknown[][] = [];
    const session = stubSession({
      addQuery: () => {},
      addVariableBinding: (...a: unknown[]) => void calls.push(a),
    });
    const p = await mount(makeBindingsPanel(host, session));
    change(p.need("data-data-bind-field"), "unit_price");
    await click(p.need("data-data-bind-add"));

    expect(calls).toHaveLength(1);
    const [, , query, expr] = calls[0];
    expect(query).toBe("q_all");
    expect(expr).toBe("unit_price");
  });

  it('"Bind to data…" completes the editor\'s draft into a property binding [data.bind.property]', async () => {
    const calls: unknown[][] = [];
    let draft: unknown = {
      selector: "rectangle:u9",
      path: "frameFillColor",
      schema: '{"path":"frameFillColor","type":{"kind":"color"}}',
    };
    const session = stubSession(
      {
        getPropertyDraft: () => draft as never,
        setPropertyDraft: (d: unknown) => void (draft = d),
        addPropertyBinding: async (...a: unknown[]) => (
          calls.push(a),
          { ok: true }
        ),
        applyProperties: async () => ({
          applied: 1,
          undoSteps: 1,
          skipped: {},
          written: {},
          calls: 2,
        }),
      } as never,
      { queries: ["q"] },
    );
    const p = await mount(makeBindingsPanel(host, session));
    expect(p.need("data-data-bind-property").textContent).toContain(
      "frameFillColor",
    );
    change(p.need("data-data-bind-property-expr"), "tint");
    await click(p.need("data-data-bind-property-define"));
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual({
      target: "rectangle:u9",
      path: "frameFillColor",
      query: "q",
      expr: "tint",
      schema: '{"path":"frameFillColor","type":{"kind":"color"}}',
    });
    expect(draft).toBeNull();
  });

  it("shows the session's refresh/binding diagnostics [data.plugin.bundle]", async () => {
    const session = stubSession(
      {},
      {
        diagnostics: [
          { level: "error", source: "import", message: "bad csv" },
          {
            level: "warn",
            source: "refresh",
            binding: "v_price",
            message: "did not resolve",
          },
        ],
      },
    );
    const p = await mount(makeBindingsPanel(host, session));
    expect(diagnosticsShown(p.c)).toEqual([
      "refresh · v_price: did not resolve",
    ]);
  });
});

describe("sources panel [data.plugin.bundle]", () => {
  it("shows a failed import [data.plugin.bundle]", async () => {
    const session = stubSession(
      {},
      {
        status: "error",
        diagnostics: [
          {
            level: "error",
            source: "import",
            message: 'Import of "x" failed: bad csv',
          },
        ],
      },
    );
    const p = await mount(makeSourcesPanel(host, session));
    expect(diagnosticsShown(p.c)).toEqual([
      'import: Import of "x" failed: bad csv',
    ]);
  });
});

describe("dataset panel provider note [data.provider.contract]", async () => {
  const pub: DataProviderPublication = {
    id: "q_all-dataset",
    category: "dataset",
    revision: "r1",
    schema: { fields: [] },
    rowCount: 0,
    records: null,
  };

  for (const registered of [true, false]) {
    it(`says "can't share" only when registration did not happen (registered=${registered}) [data.provider.contract]`, async () => {
      const session = stubSession(
        {
          publishProvider: async () => pub,
          isProviderRegistered: () => registered,
          listBindings: () => [],
        },
        { queries: ["q_all"] },
      );
      const p = await mount(makeDatasetPanel(host, session));
      await click(p.button(/publish/i));
      const all = p.c.textContent ?? "";
      expect(/can't share/.test(all)).toBe(!registered);
      expect(all).toContain('Provider "q_all-dataset"');
    });
  }
});

describe("bindings panel — every binding kind is reachable [data.bind.authoring]", () => {
  type Mounted = Awaited<ReturnType<typeof mount>>;
  async function author(
    kind: string,
    field: string,
    over: Partial<DataSourceSession>,
    hostOver: Record<string, unknown> = {},
    extra: (p: Mounted) => void = () => {},
  ): Promise<string | undefined> {
    const session = stubSession({ addQuery: () => {}, ...over });
    const p = await mount(
      makeBindingsPanel(
        { ...host, ...hostOver } as unknown as BundleHost,
        session,
      ),
    );
    change(p.need("data-data-bind-kind"), kind);
    change(p.need("data-data-bind-field"), field);
    extra(p);
    await click(p.need("data-data-bind-add"));
    return p.find("data-data-bind-msg")?.textContent ?? undefined;
  }

  it("a table binding takes its columns from the comma-separated fields [data.bind.authoring]", async () => {
    const calls: unknown[][] = [];
    await author("table", "sku, price", {
      addTableBinding: (...a: unknown[]) => void calls.push(a),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0][3]).toEqual([
      { header: "sku", expr: "sku" },
      { header: "price", expr: "price" },
    ]);
  });

  it("a show/hide binding binds the selected element, with its kind and invert [data.bind.authoring]", async () => {
    const calls: unknown[][] = [];
    const msg = await author(
      "visibility",
      "discontinued",
      { addVisibilityBinding: (...a: unknown[]) => void calls.push(a) },
      { selection: { get: () => [{ kind: "oval", id: "u9" }] } },
      (p) => act(() => void fireEvent.click(p.need("data-data-bind-invert"))),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(1)).toEqual([
      "u9",
      "q_all",
      "discontinued",
      { invert: true, kind: "oval" },
    ]);
    expect(msg).toMatch(/hidden when true/);
  });

  it("a show/hide binding with nothing selected says what is missing [data.bind.authoring]", async () => {
    const calls: unknown[][] = [];
    const msg = await author("visibility", "x", {
      addVisibilityBinding: (...a: unknown[]) => void calls.push(a),
    });
    expect(calls).toHaveLength(0);
    expect(msg).toMatch(/Select the frame/);
  });

  it("a style rule over the caret's story applies the named style [data.bind.authoring]", async () => {
    const calls: unknown[][] = [];
    await author(
      "rule",
      "stock < 5",
      { addRuleBinding: (...a: unknown[]) => void calls.push(a) },
      {
        text: { caret: () => ({ storyId: "s1", offset: 2 }) },
        document: {
          storyContent: async () => ({
            selfId: "s1",
            paragraphs: [{ runs: [{ text: "Hello" }, { text: "!" }] }],
          }),
        },
      },
      (p) => change(p.need("data-data-bind-rule-style"), "Low stock"),
    );
    expect(calls).toHaveLength(1);
    const [, , query, when, apply, target] = calls[0];
    expect([query, when, apply, target]).toEqual([
      "q_all",
      "stock < 5",
      { action: "characterStyle", name: "Low stock" },
      { kind: "storyRange", storyId: "s1", start: 0, end: 6 },
    ]);
  });

  it("a cell-style rule on a selected table cell targets its column [data.bind.authoring]", async () => {
    const calls: unknown[][] = [];
    await author(
      "rule",
      "stock < 5",
      { addRuleBinding: (...a: unknown[]) => void calls.push(a) },
      {
        selection: {
          get: () => [
            {
              kind: "tableCell",
              id: { story_id: "s1", table_id: "t1", row: 2, col: 3 },
            },
          ],
        },
      },
      (p) => {
        change(p.need("data-data-bind-rule-style"), "Alert");
        change(p.need("data-data-bind-rule-action"), "tableStyle");
      },
    );
    expect(calls[0][5]).toEqual({
      kind: "tableColumn",
      storyId: "s1",
      tableId: "t1",
      col: 3,
      headerRows: 1,
    });
  });

  it("a record flow is defined with its fields and grouping [data.bind.authoring]", async () => {
    const calls: unknown[][] = [];
    await author(
      "recordFlow",
      "sku, price",
      { defineRecordFlow: (...a: unknown[]) => void calls.push(a) },
      {},
      (p) => change(p.need("data-data-bind-group-by"), "region"),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(1)).toEqual([
      "q_all",
      [{ expr: "sku" }, { expr: "price" }],
      { groupBy: ["region"] },
    ]);
  });

  it("a record flow lists its preview [data.bind.authoring]", async () => {
    const session = stubSession(
      {
        listBindings: () => [{ id: "rf", kind: "recordFlow" }],
        refreshData: async () => {},
        previewRecordFlow: async () => ({
          total: 2,
          blocks: [
            { kind: "header", text: "North" },
            { kind: "record", text: "A-1 · 9.99" },
          ],
        }),
      },
      { bindings: ["rf"] },
    );
    const p = await mount(makeBindingsPanel(host, session));
    await click(p.need("data-data-flow-preview"));
    expect(
      [...p.c.querySelectorAll("[data-flow-block]")].map((e) => e.textContent),
    ).toEqual(["North", "A-1 · 9.99"]);
  });
});

describe("sources panel says whether the session is saved [data.plugin.persistence]", () => {
  it.each([["saved", /saved with the document/]] as const)(
    "%s",
    async (status, re) => {
      const session = stubSession({}, { persistence: { status, hash: null } });
      const p = await mount(makeSourcesPanel(host, session));
      expect(p.need("data-data-persistence").textContent).toMatch(re);
    },
  );
});

describe("bindings panel — the record-preview stepper [data.bind.preview-step]", () => {
  /** A session whose state the test changes, as the real one does. */
  function liveSession(
    state: Partial<SessionState>,
    over: Partial<DataSourceSession> = {},
  ) {
    const live: SessionState = {
      status: "ready",
      message: "",
      sources: ["people"],
      queries: ["q_all"],
      bindings: [],
      remote: [],
      diagnostics: [],
      persistence: { status: "saved", hash: null },
      files: [],
      refresh: {},
      polling: [],
      ...state,
    };
    const session = stubSession({
      getState: () => live,
      listQueries: () => [{ id: "q_all", sql: "SELECT * FROM people" }],
      addQuery: () => {},
      recordCount: async (q: string) => live.records?.[q] ?? 0,
      setPreviewPosition: (q: string, record: number) =>
        void (live.preview = { ...live.preview, [q]: record }),
      ...over,
    } as Partial<DataSourceSession>);
    return { live, session };
  }
  const position = (p: Awaited<ReturnType<typeof mount>>) =>
    p.c.querySelector('[data-testid="preview-position"]')?.textContent;

  it("shows the record count the session holds as soon as it opens, without stepping first", async () => {
    const { session } = liveSession({ records: { q_all: 24 } });
    const p = await mount(makeBindingsPanel(host, session));
    expect(position(p)).toBe("Record 1 of 24");
    expect(p.button(/^Next$/).disabled).toBe(false);
    expect(p.button(/^Previous$/).disabled).toBe(true);
  });

  it("keeps its record when the panel is shown again (another tab, then back)", async () => {
    const { session } = liveSession({ records: { q_all: 24 } });
    const Panel = makeBindingsPanel(host, session);
    let p = await mount(Panel);
    await click(p.button(/^Next$/));
    expect(position(p)).toBe("Record 2 of 24");
    // A remount: the panel's own state is gone, the session's is not.
    p.unmount();
    p = await mount(Panel);
    expect(position(p)).toBe("Record 2 of 24");
    expect(p.button(/^Previous$/).disabled).toBe(false);
  });

  it("before the data ran, next › runs it and shows the first record", async () => {
    let refreshed = 0;
    const { live, session } = liveSession(
      {},
      {
        refreshData: async () => {
          refreshed += 1;
          live.records = { q_all: 3 };
        },
      },
    );
    const p = await mount(makeBindingsPanel(host, session));
    expect(position(p)).toBe("No records yet");
    expect(p.button(/^Next$/).disabled).toBe(false);
    await click(p.button(/^Next$/));
    expect(refreshed).toBe(1);
    expect(position(p)).toBe("Record 1 of 3");
  });
});

describe("bindings panel — empty state and the query picker [data.bind.authoring]", () => {
  it("with no data source it shows one sentence and a way to Data sources, not the authoring controls [data.bind.authoring]", async () => {
    const opened: string[] = [];
    const session = stubSession({}, { sources: [] });
    const p = await mount(
      makeBindingsPanel(
        {
          ...host,
          shell: { openPanel: (id: string) => void opened.push(id) },
        } as unknown as BundleHost,
        session,
      ),
    );
    expect(p.find("data-data-bind-author")).toBeNull();
    expect(p.find("data-data-merge")).toBeNull();
    expect(p.need("data-data-bind-empty").textContent).toMatch(
      /Import a data source/,
    );
    await click(p.need("data-data-bind-open-sources"));
    expect(opened).toEqual(["media.paged.data.panel.sources"]);
  });

  it("ships no demo-binding buttons [data.bind.authoring]", async () => {
    const p = await mount(makeBindingsPanel(host, stubSession({})));
    const labels = p.buttons().map((b) => b.textContent ?? "");
    expect(labels.length).toBeGreaterThan(0);
    expect(
      labels.filter((l) => /demo|Bind image|Bind barcode/i.test(l)),
    ).toEqual([]);
  });

  it("a binding reads the query picked under Records from, not always the first source [data.bind.authoring]", async () => {
    const calls: unknown[][] = [];
    const added: unknown[][] = [];
    const session = stubSession(
      {
        addQuery: (...a: unknown[]) => void added.push(a),
        addVariableBinding: (...a: unknown[]) => void calls.push(a),
        listQueries: () => [
          { id: "q_all", sql: "SELECT * FROM people" },
          { id: "cheap", sql: "SELECT * FROM people WHERE price < 5" },
        ],
      },
      { sources: ["people", "orders"], queries: ["q_all", "cheap"] },
    );
    const p = await mount(makeBindingsPanel(host, session));
    const pick = p.need("data-data-bind-query-pick");
    const options = [...pick.querySelectorAll("option")].filter((o) =>
      /^[sq]:/.test(o.value),
    );
    expect(options.map((o) => o.textContent)).toEqual([
      "All rows of people",
      "All rows of orders",
      "Query cheap",
    ]);

    // A saved query: bound as is, nothing new defined.
    change(pick, "q:cheap");
    change(p.need("data-data-bind-field"), "name");
    await click(p.need("data-data-bind-add"));
    expect(calls[0][2]).toBe("cheap");
    expect(added).toEqual([]);

    // The second source's rows: a query over it is defined on commit.
    change(p.need("data-data-bind-query-pick"), "s:orders");
    await click(p.need("data-data-bind-add"));
    expect(calls[1][2]).toBe("q_all_orders");
    expect(added).toEqual([
      ["q_all_orders", "SELECT * FROM orders", "recordStream"],
    ]);
  });

  it("queryOptions reuses a query that already selects a source's rows [data.bind.authoring]", async () => {
    const opts = queryOptions(
      ["people"],
      ["mine"],
      new Map([["mine", 'SELECT * FROM "people";']]),
    );
    expect(opts).toEqual([
      {
        value: "s:people",
        label: "All rows of people",
        query: "mine",
        title: 'SELECT * FROM "people";',
      },
    ]);
  });
});

describe("dataset preview — rows and an honest batch [data.plugin.bundle]", async () => {
  it("Preview rows shows the selected query's first rows [data.plugin.bundle]", async () => {
    const session = stubSession(
      {
        refreshData: async () => {},
        governedCatalog: async () =>
          ({ columns: [], diagnostics: [] }) as never,
        listQueries: () => [{ id: "q_all", sql: "SELECT * FROM people" }],
        previewQuery: async () => ({
          columns: [{ name: "name", type: "VARCHAR" }],
          rows: [["Ada"], ["Grace"]],
          total: 7,
          diagnostic: null,
        }),
        listBindings: () => [],
      },
      { queries: ["q_all"] },
    );
    const p = await mount(makeDatasetPanel(host, session));
    await click(p.need("data-data-dataset-preview"));
    expect([...p.c.querySelectorAll("td")].map((e) => e.textContent)).toEqual([
      "Ada",
      "Grace",
    ]);
    expect(p.need("data-data-dataset-rows").textContent).toMatch(
      /First 2 of 7 rows/,
    );
  });

  it("the batch button is a plan, disabled with a reason without a record flow [data.plugin.bundle]", async () => {
    const session = stubSession(
      {
        planBatch: async () =>
          ({
            mode: "oneCatalog",
            units: [{ label: "all", recordIndices: [0] }],
            totalRecords: 1,
          }) as never,
        listBindings: () => [],
      },
      { queries: ["q_all"] },
    );
    const p = await mount(makeDatasetPanel(host, session));
    await click(p.button(/^One catalog$/));
    const run = p.need("data-data-batch-run") as HTMLButtonElement;
    expect(run.textContent).toBe("Plan batch");
    expect(run.disabled).toBe(true);
    expect(run.title).toMatch(/record-flow binding/);
  });

  it("with no source the empty state links to Data sources [data.plugin.bundle]", async () => {
    const p = await mount(
      makeDatasetPanel(host, stubSession({}, { sources: [] })),
    );
    expect(p.need("data-data-dataset-empty").textContent).toMatch(
      /No queries yet\. Import a data source first/,
    );
    expect(p.find("data-data-dataset-open-sources")).not.toBeNull();
  });
});

describe("sources panel — a refused remote URL is said in the panel [data.plugin.bundle]", () => {
  it("shows the refusal inline [data.plugin.bundle]", async () => {
    const session = stubSession({
      addRemoteSource: () => "embedded credentials are not allowed",
    } as never);
    const p = await mount(makeSourcesPanel(host, session));
    const add = () => p.need("data-data-remote-add") as HTMLButtonElement;
    expect(add().disabled).toBe(true);
    change(
      p.c.querySelector('input[type="url"]')!,
      "https://u:p@example.com/x.csv",
    );
    expect(add().disabled).toBe(false);
    await click(add());
    expect(p.need("data-data-remote-error").textContent).toMatch(/credentials/);
  });
});
