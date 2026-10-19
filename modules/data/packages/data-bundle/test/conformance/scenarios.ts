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

// One behaviour scenario per paged.data command id, run by the unit file
// (`test/commands.spec.ts`, the recording fake editor) and the headless file
// (`test/headless/commands.headless.test.ts`, the real canvas engine), both
// over the real data-js engine and a real DuckDB (./env.ts).
//
// paged.data's palette commands carry no `when` gate: what decides whether
// one can act is the data it needs, so a scenario first runs it with nothing
// defined and asserts the refusal (the panel it opens, the message, no
// write), then with a source, a query and a binding, and asserts the effect.
// On the real engine the effect is read back off the document (the bound
// rectangle's properties, the merged pages, the exported template) and
// `document.undo()` takes it back. The fake editor has no document to bind
// into: there the scenario asserts what the bundle wrote and what it says.
//
// The fixture document (headless) is one Letter page "usp" with one
// rectangle "urect"; the data is a three-row CSV built here.

import { expect } from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";

import type { DataEnv } from "./env";

export const D = "media.paged.data";
export const PANEL = {
  sources: "media.paged.data.panel.sources",
  bindings: "media.paged.data.panel.bindings",
  dataset: "media.paged.data.panel.dataset",
  query: "media.paged.data.panel.query",
};

export const CSV =
  "sku,weight_mm,name,shown\nA-1,2,Alpha,yes\nB-2,4,Beta,no\nC-3,6,Gamma,yes\n";

const MM = 72 / 25.4;
const RECT = "rectangle:urect";

/** A source (through the typed command) and a query over it. */
export async function seed(
  env: DataEnv,
  options: { refresh?: boolean } = {},
): Promise<void> {
  await env.objects.invoke(`${D}.defineSource` as never, {
    name: "products",
    csv: CSV,
  });
  env.session.addQuery(
    "q",
    "SELECT * FROM products ORDER BY sku",
    "recordStream",
  );
  if (options.refresh !== false) await env.session.refreshData();
  await env.settle();
}

const run = async (env: DataEnv, id: string, payload?: unknown) => {
  const out = await env.command(id).handler(env.host.editor, payload);
  await env.settle();
  return out;
};

const invoke = async (env: DataEnv, id: string, args: unknown) => {
  const out = await env.objects.invoke(id as never, args);
  await env.settle();
  return out;
};

const said = (env: DataEnv, text: string) =>
  env.logs.some((l) => l.includes(text));

const prop = async (env: DataEnv, path: string) => {
  const v = (await env.objects.get(RECT as never, path)) as {
    kind: string;
    value?: unknown;
  };
  return v.kind === "value" ? v.value : v;
};

/** The weight binding: the rectangle's stroke weight from `weight_mm`. */
async function bindWeight(env: DataEnv) {
  return (await invoke(env, `${D}.defineProperty`, {
    id: "weight",
    selector: RECT,
    path: "frameStrokeWeight",
    query: "q",
    expr: "MM(weight_mm)",
  })) as { ok: boolean; reason?: string; selector?: string };
}

/** A text frame on the page holding `text` (a Data Merge template field). */
async function templateFrame(env: DataEnv, text: string): Promise<ElementId> {
  const r = (await env.host.document.mutate({
    op: "insertTextFrame",
    args: { pageId: "usp", bounds: [72, 72, 120, 300] },
  } as never)) as unknown as { applied: boolean; createdId: ElementId };
  expect(r.applied).toBe(true);
  const g = await env.host.document.elementGeometry([r.createdId]);
  const storyId = (g[0] as { storyId?: string }).storyId!;
  await env.host.document.mutate({
    op: "insertText",
    args: { storyId, offset: 0, text },
  } as never);
  return r.createdId;
}

// ── the panel doors ───────────────────────────────────────────────────────

export async function opensPanel(
  env: DataEnv,
  id: string,
  panel: string,
): Promise<void> {
  const m = env.mark();
  await run(env, id);
  expect(env.opened).toEqual([panel]);
  expect(env.writesSince(m)).toEqual([]);
}

// ── refresh ───────────────────────────────────────────────────────────────

export async function resolveBindings(env: DataEnv): Promise<void> {
  await seed(env, { refresh: false });
  expect(await env.session.recordCount("q")).toBe(0);
  const m = env.mark();
  await run(env, `${D}.command.resolveBindings`);
  expect(await env.session.recordCount("q")).toBe(3);
  expect(env.session.getState().message).toBe("Data refreshed from sources.");
  // Refreshing reads the sources; it writes nothing to the document.
  expect(env.writesSince(m)).toEqual([]);
}

export async function refresh(env: DataEnv): Promise<void> {
  await seed(env, { refresh: false });
  expect(await invoke(env, `${D}.refresh`, {})).toBe(
    "Data refreshed from sources.",
  );
  expect(await env.session.recordCount("q")).toBe(3);
  // The source changes; the next refresh reads the new rows.
  await invoke(env, `${D}.defineSource`, {
    name: "products",
    csv: "sku,weight_mm,name,shown\nZ-9,1,Zeta,yes\n",
  });
  await invoke(env, `${D}.refresh`, {});
  expect(await env.session.recordCount("q")).toBe(1);
}

export async function defineSource(env: DataEnv): Promise<void> {
  expect(
    await invoke(env, `${D}.defineSource`, { name: "products", csv: CSV }),
  ).toEqual(["products"]);
  expect(
    await invoke(env, `${D}.defineSource`, {
      name: "regions",
      csv: "region\nNorth\n",
    }),
  ).toEqual(["products", "regions"]);
  expect(await env.objects.query(`plugin:${D}/source` as never)).toEqual([
    `plugin:${D}/source/products`,
    `plugin:${D}/source/regions`,
  ]);
  // A query over the new source reads its rows.
  env.session.addQuery("q", "SELECT * FROM products", "recordStream");
  await env.session.refreshData();
  expect(await env.session.recordCount("q")).toBe(3);
}

// ── lowering / applying ──────────────────────────────────────────────────

export async function lowerBinding(env: DataEnv): Promise<void> {
  // Nothing bound: nothing to place.
  let m = env.mark();
  await run(env, `${D}.command.lowerBinding`);
  expect(env.writesSince(m)).toEqual([]);
  await seed(env);
  const bound = await bindWeight(env);
  if (env.kind === "unit") {
    // The fake document holds no rectangle "urect": the binding is refused
    // with the reason, and placing writes nothing.
    expect(bound).toEqual({
      ok: false,
      reason: "the target rectangle:urect names nothing in this document",
    });
    m = env.mark();
    await run(env, `${D}.command.lowerBinding`);
    expect(env.writesSince(m)).toEqual([]);
    return;
  }
  expect(bound.ok, bound.reason).toBe(true);
  const before = await prop(env, "frameStrokeWeight");
  m = env.mark();
  await run(env, `${D}.command.lowerBinding`);
  // ONE write through host.objects, and the first record's 2 mm landed.
  expect(env.writesSince(m)).toEqual([
    { door: "objects.batch", op: "set", applied: true },
  ]);
  expect(await prop(env, "frameStrokeWeight")).toBeCloseTo(2 * MM, 5);
  await env.undo();
  expect(await prop(env, "frameStrokeWeight")).toEqual(before);
}

export async function apply(env: DataEnv): Promise<void> {
  // With nothing defined it still answers what happened.
  expect(await invoke(env, `${D}.apply`, { record: 0 })).toBe(
    "Data refreshed from sources.",
  );
  await seed(env);
  const bound = await bindWeight(env);
  if (env.kind === "unit") {
    expect(bound.ok).toBe(false);
    const m = env.mark();
    await invoke(env, `${D}.apply`, { record: 1 });
    expect(env.writesSince(m)).toEqual([]);
    return;
  }
  await invoke(env, `${D}.apply`, { record: 0 });
  expect(await prop(env, "frameStrokeWeight")).toBeCloseTo(2 * MM, 5);
  // Record 1 (0-based): the second row's 4 mm.
  await invoke(env, `${D}.apply`, { record: 1 });
  expect(await prop(env, "frameStrokeWeight")).toBeCloseTo(4 * MM, 5);
  // One undo takes back one apply.
  await env.undo();
  expect(await prop(env, "frameStrokeWeight")).toBeCloseTo(2 * MM, 5);
}

// ── Data Merge ────────────────────────────────────────────────────────────

export async function mergeRecords(env: DataEnv): Promise<void> {
  // No query yet: the Bindings panel opens (it says what is missing).
  let m = env.mark();
  expect(await run(env, `${D}.command.mergeRecords`)).toBeNull();
  expect(env.opened).toEqual([PANEL.bindings]);
  expect(env.writesSince(m)).toEqual([]);
  await seed(env);
  if (env.kind === "unit") {
    // The fake page holds no template frame.
    const r = (await run(env, `${D}.command.mergeRecords`)) as {
      ok: boolean;
      diagnostics: string[];
    };
    expect(r.ok).toBe(false);
    expect(r.diagnostics.join(" ")).toContain(
      "the template page has no frames",
    );
    return;
  }
  await templateFrame(env, "<<name>>");
  m = env.mark();
  const r = (await run(env, `${D}.command.mergeRecords`, {
    template: "consume",
  })) as { ok: boolean; records: { frames: unknown[] }[] };
  expect(r.ok).toBe(true);
  expect(r.records).toHaveLength(3);
  // The whole merge is one document write: one undo step.
  expect(env.writesSince(m).filter((w) => w.door === "mutate")).toHaveLength(1);
}

export async function merge(env: DataEnv): Promise<void> {
  const none = (await invoke(env, `${D}.merge`, {})) as {
    ok: boolean;
    message: string;
  };
  expect(none.ok).toBe(false);
  expect(none.message).toContain("no query to merge");
  await seed(env);
  if (env.kind === "unit") {
    const r = (await invoke(env, `${D}.merge`, {})) as { ok: boolean };
    expect(r.ok).toBe(false);
    return;
  }
  const h = (
    env as DataEnv & { h: import("@paged-media/plugin-sdk").HeadlessHost }
  ).h;
  const pages = async () => (await h.host.document.collection("pages")).length;
  expect(await pages()).toBe(1);
  await templateFrame(env, "Name: <<name>>");
  const out = (await invoke(env, `${D}.merge`, { mode: "single" })) as {
    ok: boolean;
    records: number;
    pages: number;
    message: string;
  };
  expect(out.ok, out.message).toBe(true);
  expect(out.records).toBe(3);
  expect(out.message).toMatch(/^Merged 3 record\(s\) onto \d+ page\(s\)/);
  // `keep` (the default): the template page stays, the records follow it.
  expect(await pages()).toBe(1 + out.pages);
  await env.undo();
  expect(await pages()).toBe(1);
}

export async function exportDataMergeTemplate(env: DataEnv): Promise<void> {
  if (env.kind === "unit") {
    // The fake host wires no documents door to export through.
    expect(
      await invoke(env, `${D}.exportDataMergeTemplate`, { save: false }),
    ).toMatchObject({
      ok: false,
      reason: "this host cannot export the document (documents.exportPaged)",
    });
    return;
  }
  await seed(env);
  // No field in the document: nothing to export, and it says what to do.
  expect(
    await invoke(env, `${D}.exportDataMergeTemplate`, { save: false }),
  ).toMatchObject({ ok: false, fields: [] });
  await templateFrame(env, "<<name>> — <<sku>>");
  const out = (await invoke(env, `${D}.exportDataMergeTemplate`, {
    save: false,
  })) as {
    ok: boolean;
    reason?: string;
    fields: string[];
    idml?: Uint8Array;
    csv?: Uint8Array;
  };
  expect(out.ok, out.reason).toBe(true);
  expect([...out.fields].sort()).toEqual(["name", "sku"]);
  // The template is an IDML package (a ZIP) and the data a CSV.
  expect([...out.idml!.slice(0, 2)]).toEqual([0x50, 0x4b]);
  expect(out.csv!.byteLength).toBeGreaterThan(0);
}

// ── data sets ─────────────────────────────────────────────────────────────

/** A visibility binding on the rectangle: record 0 shows it, record 1
 *  hides it (`shown`). */
async function bindBadge(env: DataEnv): Promise<void> {
  env.session.addVisibilityBinding("badge", "urect", "q", "shown", {
    kind: "rectangle",
  });
  await env.session.lowerAll();
  await env.settle();
}

export async function captureDataSetCommand(env: DataEnv): Promise<void> {
  await seed(env);
  await bindBadge(env);
  const m = env.mark();
  expect(
    await run(env, `${D}.command.captureDataSet`, { name: "First" }),
  ).toEqual(["First"]);
  expect(
    await run(env, `${D}.command.captureDataSet`, {
      name: "Second",
      record: 1,
    }),
  ).toEqual(["First", "Second"]);
  // Capturing reads the bound values; it writes nothing to the document.
  expect(env.writesSince(m)).toEqual([]);
  expect(await env.objects.query(`plugin:${D}/dataSet` as never)).toEqual([
    `plugin:${D}/dataSet/First`,
    `plugin:${D}/dataSet/Second`,
  ]);
  // Without a name it is captured as "Data Set".
  expect(await run(env, `${D}.command.captureDataSet`)).toContain("Data Set");
}

export async function captureDataSet(env: DataEnv): Promise<void> {
  await seed(env);
  await bindBadge(env);
  expect(
    await invoke(env, `${D}.captureDataSet`, { name: "Beta", record: 1 }),
  ).toEqual(["Beta"]);
  expect(await env.session.listDataSets()).toEqual(["Beta"]);
  const values = (await env.objects.get(
    `plugin:${D}/dataSet/Beta` as never,
    "values",
  )) as { kind: string; value?: Record<string, unknown> };
  expect(values.kind).toBe("value");
  expect(Object.keys(values.value!)).toContain("badge");
}

export async function applyDataSetCommand(env: DataEnv): Promise<void> {
  // No set named (the menu row): the Dataset preview, where sets are picked.
  let m = env.mark();
  expect(await run(env, `${D}.command.applyDataSet`)).toEqual({
    applied: 0,
    skipped: {},
  });
  expect(env.opened).toEqual([PANEL.dataset]);
  expect(env.writesSince(m)).toEqual([]);
  await seed(env);
  await bindBadge(env);
  await run(env, `${D}.command.captureDataSet`, { name: "Hidden", record: 1 });
  m = env.mark();
  expect(
    await run(env, `${D}.command.applyDataSet`, { name: "Hidden" }),
  ).toEqual({ applied: 1, skipped: {} });
  // ONE write: one undo step.
  expect(env.writesSince(m)).toEqual([
    { door: "mutate", op: "batch", applied: true },
  ]);
  if (env.kind !== "headless") return;
  expect(await prop(env, "elementVisible")).toBe(false);
  await env.undo();
  expect(await prop(env, "elementVisible")).toBe(true);
}

export async function applyDataSet(env: DataEnv): Promise<void> {
  await seed(env);
  await bindBadge(env);
  await invoke(env, `${D}.captureDataSet`, { name: "Shown", record: 0 });
  await invoke(env, `${D}.captureDataSet`, { name: "Hidden", record: 1 });
  const m = env.mark();
  expect(await invoke(env, `${D}.applyDataSet`, { name: "Hidden" })).toEqual({
    applied: 1,
    skipped: {},
  });
  expect(env.writesSince(m)).toHaveLength(1);
  if (env.kind === "headless") {
    expect(await prop(env, "elementVisible")).toBe(false);
    await invoke(env, `${D}.applyDataSet`, { name: "Shown" });
    expect(await prop(env, "elementVisible")).toBe(true);
  }
  // A set nobody captured applies nothing.
  const none = (await invoke(env, `${D}.applyDataSet`, { name: "Nope" })) as {
    applied: number;
  };
  expect(none.applied).toBe(0);
}

/** DAT-2: a data set over a property binding AND a visibility binding is
 *  still ONE undo step. */
export async function applyDataSetIsOneUndoStep(env: DataEnv): Promise<void> {
  await seed(env);
  expect((await bindWeight(env)).ok).toBe(true);
  await bindBadge(env);
  await invoke(env, `${D}.captureDataSet`, { name: "Second", record: 1 });
  const before = {
    visible: await prop(env, "elementVisible"),
    weight: await prop(env, "frameStrokeWeight"),
  };
  await invoke(env, `${D}.applyDataSet`, { name: "Second" });
  expect(await prop(env, "elementVisible")).toBe(false);
  await env.undo();
  expect({
    visible: await prop(env, "elementVisible"),
    weight: await prop(env, "frameStrokeWeight"),
  }).toEqual(before);
}

// ── property bindings ────────────────────────────────────────────────────

export async function bindPropertyCommand(env: DataEnv): Promise<void> {
  // Without a target there is nothing to draft: the Bindings panel opens.
  expect(await run(env, `${D}.bindProperty`)).toBeNull();
  expect(said(env, "bindProperty: the payload needs")).toBe(true);
  expect(env.opened).toEqual([PANEL.bindings]);
  expect(env.session.getPropertyDraft()).toBeNull();
  const m = env.mark();
  expect(
    await run(env, `${D}.bindProperty`, {
      selector: RECT,
      path: "frameFillColor",
      schema: "{}",
    }),
  ).toEqual({ status: "draft", opened: true });
  expect(env.session.getPropertyDraft()).toMatchObject({
    selector: RECT,
    path: "frameFillColor",
  });
  // A draft is not a binding yet: nothing is written.
  expect(env.writesSince(m)).toEqual([]);
  // The typed twin takes the same path.
  expect(
    await invoke(env, `${D}.bindProperty`, {
      selector: RECT,
      path: "frameStrokeWeight",
      schema: "{}",
    }),
  ).toEqual({ status: "draft", opened: true });
  expect(env.session.getPropertyDraft()?.path).toBe("frameStrokeWeight");
}

export async function defineProperty(env: DataEnv): Promise<void> {
  await seed(env);
  const m = env.mark();
  const r = await bindWeight(env);
  if (env.kind === "unit") {
    expect(r).toEqual({
      ok: false,
      reason: "the target rectangle:urect names nothing in this document",
    });
    expect(env.writesSince(m)).toEqual([]);
    return;
  }
  expect(r.ok, r.reason).toBe(true);
  // The raw id becomes a durable selector over the frame's own label.
  expect(r.selector).toMatch(/^frame\[label\.x-paged:media\.paged\.data/);
  expect(await env.objects.query(r.selector! as never)).toEqual([RECT]);
  // The label is ONE document write.
  expect(env.writesSince(m)).toEqual([
    { door: "mutate", op: "batch", applied: true },
  ]);
  // A path the frame does not have is refused.
  const bad = (await invoke(env, `${D}.defineProperty`, {
    id: "nope",
    selector: RECT,
    path: "noSuchPath",
    query: "q",
    expr: "name",
  })) as { ok: boolean };
  expect(bad.ok).toBe(false);
}

export async function propertyBindings(env: DataEnv): Promise<void> {
  await seed(env);
  const bound = await bindWeight(env);
  const listed = (await invoke(env, `${D}.propertyBindings`, {
    address: RECT,
    path: "frameStrokeWeight",
  })) as { binding: string; addresses: string[] }[];
  if (env.kind === "unit") {
    expect(bound.ok).toBe(false);
    expect(listed).toEqual([]);
    return;
  }
  expect(listed.map((b) => b.binding)).toEqual(["weight"]);
  expect(listed[0]!.addresses).toEqual([RECT]);
  expect(
    await invoke(env, `${D}.propertyBindings`, {
      address: RECT,
      path: "frameFillColor",
    }),
  ).toEqual([]);
}

/** DAT-1: the filter is optional — every binding on the object. */
export async function propertyBindingsByAddress(env: DataEnv): Promise<void> {
  await seed(env);
  expect((await bindWeight(env)).ok).toBe(true);
  const listed = (await invoke(env, `${D}.propertyBindings`, {
    address: RECT,
  })) as { binding: string }[];
  expect(listed.map((b) => b.binding)).toEqual(["weight"]);
}
