/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// @feat: plugin-platform.object-model
//
// ADR 323 contract fix-ups found by the first consumers (image, sheet,
// publish, slide), on the REAL engine: the plugin-level batch, optional /
// defaulted struct fields, heavy rows in getAll, async hostOf, plugin
// steps scoped by container and plugin steps, the label rules core
// enforces (one key per plugin per host, sub-keys merged), and labels on
// pages (protocol 70) and on the document.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { MutationInput, ObjectWrite } from "@paged-media/plugin-api";

import { CORE_PATHS } from "../src/core-schema";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { checkSchemaRows, checkValueType, findRow, ROW_PATH, rowPathOf, validateValue } from "../src/object-schema";
import { BOARD, BOARD_ID, CARD, makeBoardBundle, type BoardOptions, type BoardProbe } from "./fixtures/board-bundle";
import { minimalIdml } from "./fixtures/minimal-idml";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const value = (v: unknown) => ({ kind: "value", value: v });

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

async function setup(
  options: BoardOptions = {},
): Promise<{ h: HeadlessHost; rect: string; page: string; probe: BoardProbe; attached: unknown }> {
  const h = (live = await createHeadlessHost({ console: silent }));
  const [pageId] = await h.load(minimalIdml());
  const made = await h.host.document.mutate({ op: "insertFrame", args: { pageId: pageId!, bounds: [10, 10, 110, 210] } });
  const created = (made as { createdId?: { kind: string; id: string } }).createdId!;
  const rect = `${created.kind}:${created.id}`;
  const page = `page:${pageId}`;
  const probe: BoardProbe = { gets: [], lists: [], exportArgs: [], plans: [] };
  h.loadBundle(makeBoardBundle(options, probe));
  const labelHost = options.host === "doc" ? "doc" : options.host === "page" ? page : rect;
  const attached = await h.objects.invoke("acme.board.attach", { host: labelHost, frame: rect });
  return { h, rect, page, probe, attached };
}

describe("1 — the plugin-level batch: two kinds, one state", () => {
  it("ops on two kinds of one plugin are planned TOGETHER (neither is lost), one undo step", async () => {
    const { h, attached } = await setup({ pluginBatch: true });
    expect(attached).toBe(true);
    const [card] = await h.objects.query(CARD);
    expect(card).toBeTruthy();
    const mutate = vi.spyOn(h.host.editor.client, "mutate");
    const out = await h.objects.batch([
      { op: "set", address: `${BOARD}/main`, path: "title", value: "Renamed" },
      { op: "set", address: card!, path: "text", value: "edited" },
    ]);
    expect(out).toMatchObject({ applied: true, undoSteps: 1 });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(await h.objects.get(`${BOARD}/main`, "title")).toEqual(value("Renamed"));
    expect(await h.objects.get(card!, "text")).toEqual(value("edited"));
    await h.host.document.undo();
    expect(await h.objects.get(`${BOARD}/main`, "title")).toEqual(value("Board"));
    expect(await h.objects.get(card!, "text")).toEqual(value("one"));
  });

  it("without the plugin-level batch, two per-kind state writes on one host are REFUSED, not silently merged", async () => {
    const { h, attached } = await setup({ pluginBatch: false });
    // attach itself is a two-kind batch: refused under per-kind planning.
    expect(attached).toBe(false);
    const out = await h.objects.batch([
      { op: "set", address: `${BOARD}/main`, path: "title", value: "x" },
      { op: "create", kind: CARD, props: { text: "y" } },
    ]);
    expect(out).toMatchObject({ applied: false, code: "failed", undoSteps: 0 });
    expect(out.reason).toMatch(/conflicting state writes/);
  });
});

describe("2 — optional / defaulted struct fields", () => {
  it("invoke fills defaults, leaves optionals absent, still requires the rest", async () => {
    const { h, rect, probe } = await setup({ pluginBatch: true });
    await h.objects.invoke("acme.board.export", { target: rect });
    expect(probe.exportArgs.at(-1)).toEqual({ target: rect, format: "pdf", scale: 1 });
    await h.objects.invoke("acme.board.export", { target: rect, format: "png", pages: [1, 2] });
    expect(probe.exportArgs.at(-1)).toEqual({ target: rect, format: "png", scale: 1, pages: [1, 2] });
    await expect(h.objects.invoke("acme.board.export", { format: "pdf" })).rejects.toThrow(/invalidValue: .*target is missing/);
    await expect(h.objects.invoke("acme.board.export", { target: rect, pages: ["a"] })).rejects.toThrow(/invalidValue/);
  });

  it("checkValueType: optional must be true, a default must satisfy its field", () => {
    const ok = { kind: "struct", fields: { a: { kind: "number", default: 2 }, b: { kind: "text", optional: true } } };
    expect(checkValueType(ok)).toBeNull();
    expect(checkValueType({ kind: "struct", fields: { a: { kind: "number", default: "x" } } })).toMatch(/default/);
    expect(checkValueType({ kind: "struct", fields: { a: { kind: "number", optional: "yes" } } })).toMatch(/optional/);
    expect(validateValue(ok as never, {})).toBeNull();
    expect(validateValue({ kind: "struct", fields: { a: { kind: "number" } } }, {})).toMatch(/a is missing/);
  });
});

describe("3 — getAll leaves heavy rows unread unless asked", () => {
  it("content and heavy rows only with { content: true }", async () => {
    const { h, probe } = await setup({ pluginBatch: true });
    const [card] = await h.objects.query(CARD);
    probe.gets.length = 0;
    const light = await h.objects.getAll(card!);
    expect(Object.keys(light).sort()).toEqual(["text"]);
    expect(probe.gets.some((g) => g.endsWith("#thumbnail") || g.endsWith("#content"))).toBe(false);
    const full = await h.objects.getAll(card!, { content: true });
    expect(Object.keys(full).sort()).toEqual(["content", "text", "thumbnail"]);
  });

  it("core's story content is heavy too", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    await h.load(minimalIdml());
    const rows = await h.objects.schema("story");
    expect(rows.find((r) => r.path === "content")?.heavy).toBe(true);
  });
});

describe("4/5 — async hostOf; plugin steps scoped by containers and by plugin steps", () => {
  it("page > plugin kind resolves through hostOf (async), doc > too", async () => {
    const { h, page, rect } = await setup({ pluginBatch: true });
    expect(await h.objects.query(`${page} > ${CARD}`)).toEqual([`${CARD}/c1`]);
    expect(await h.objects.query(`page:#1 ${CARD}`)).toEqual([`${CARD}/c1`]);
    expect(await h.objects.query(`doc ${BOARD}`)).toEqual([`${BOARD}/main`]);
    expect(await h.objects.query(`${rect} > ${CARD}`)).toEqual([`${CARD}/c1`]);
  });

  it("a page holding no host answers nothing", async () => {
    const { h } = await setup({ pluginBatch: true });
    const pages = await h.objects.query("page");
    const res = await h.objects.query(`page[index=999] > ${CARD}`);
    expect(pages.length).toBeGreaterThan(0);
    expect(res).toEqual([]);
  });

  it("plugin > plugin: the scope reaches list as within", async () => {
    const { h, probe } = await setup({ pluginBatch: true });
    probe.lists.length = 0;
    expect(await h.objects.query(`${BOARD}/main > ${CARD}`)).toEqual([`${CARD}/c1`]);
    expect(probe.lists).toContain(`${BOARD}/main`);
    expect(await h.objects.query(`${BOARD}[title="nope"] > ${CARD}`)).toEqual([]);
  });
});

describe("9 — label keys the way core takes them (one key per plugin per host)", () => {
  it("a sub-key write merges into data of the ONE x-paged:<id> envelope", async () => {
    const { h, rect, attached } = await setup({ pluginBatch: true, labelMode: "sub" });
    expect(attached).toBe(true);
    const labels = (await h.objects.get(rect, "labels")) as { kind: "value"; value: Record<string, string> };
    expect(Object.keys(labels.value)).toEqual([`x-paged:${BOARD_ID}`]);
    const env = JSON.parse(labels.value[`x-paged:${BOARD_ID}`]!);
    expect(env).toMatchObject({ v: 1, data: { hash: expect.any(String) } });
    expect(await h.objects.get(`${BOARD}/main`, "title")).toEqual(value("Board"));
  });

  it("refuses keys core would refuse, before anything applies", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const [pageId] = await h.load(minimalIdml());
    await h.host.document.mutate({ op: "insertFrame", args: { pageId: pageId!, bounds: [0, 0, 10, 10] } });
    const [rect] = await h.objects.query("frame");
    const tryKey = async (key: (id: string) => string, v?: string) => {
      const plugin = "acme.k" + Math.random().toString(36).slice(2, 8);
      const handle = h.objects.register({
        plugin,
        model: {
          kinds: [
            {
              kind: "x",
              title: "x",
              schema: [{ path: "p", type: { kind: "text" } }],
              hostOf: () => rect!,
              list: () => [],
              get: () => ({ kind: "absent" }),
              set: () => ({ kind: "state", parts: [], host: rect!, labelKey: key(plugin), labelValue: v ?? '{"v":1,"data":{}}' }),
            },
          ],
        },
      });
      const out = await h.objects.set(`plugin:${plugin}/x/1`, "p", "a");
      handle.dispose();
      return out;
    };
    expect(await tryKey((id) => `x-paged:${id}`)).toMatchObject({ applied: true });
    expect(await tryKey((id) => `x-paged:${id}.sub`, '"s"')).toMatchObject({ applied: true });
    expect(await tryKey((id) => `x-paged:${id}x`)).toMatchObject({ applied: false, code: "denied" });
    expect(await tryKey(() => `x-paged:someone.else`)).toMatchObject({ applied: false, code: "denied" });
    expect(await tryKey((id) => `x-paged:${id}.a.b`)).toMatchObject({ applied: false, code: "denied" });
    expect(await tryKey((id) => `x-paged:${id}`, '{"data":{}}')).toMatchObject({ applied: false, code: "invalidValue" });
    expect(await tryKey((id) => `x-paged:${id}`, "not json")).toMatchObject({ applied: false, code: "invalidValue" });
  });
});

describe("10/8 — the document and pages as label hosts", () => {
  it("host = doc: the label is document metadata; undo reverts it", async () => {
    const { h, attached } = await setup({ pluginBatch: true, host: "doc" });
    expect(attached).toBe(true);
    const labels = (await h.objects.get("doc", "labels")) as { kind: string; value: Record<string, string> };
    expect(labels.value[`x-paged:${BOARD_ID}`]).toBeTruthy();
    await h.objects.set(`${BOARD}/main`, "title", "Doc-scoped");
    expect(await h.objects.get(`${BOARD}/main`, "title")).toEqual(value("Doc-scoped"));
    await h.host.document.undo();
    expect(await h.objects.get(`${BOARD}/main`, "title")).toEqual(value("Board"));
  });

  it("host = page (protocol 70 setPageMetadata): labels read back and select the page", async () => {
    const { h, page, attached } = await setup({ pluginBatch: true, host: "page", labelMode: "sub" });
    expect(attached).toBe(true);
    const labels = (await h.objects.get(page, "labels")) as { kind: string; value: Record<string, string> };
    expect(JSON.parse(labels.value[`x-paged:${BOARD_ID}`]!)).toMatchObject({ v: 1, data: { hash: expect.any(String) } });
    expect(await h.objects.query(`page[label.x-paged:${BOARD_ID}^={]`)).toEqual([page]);
    await h.objects.set(`${BOARD}/main`, "title", "Slide");
    expect(await h.objects.get(`${BOARD}/main`, "title")).toEqual(value("Slide"));
    await h.host.document.undo();
    expect(await h.objects.get(`${BOARD}/main`, "title")).toEqual(value("Board"));
  });
});

describe("7 — core seam rows: unit-less numbers are not lengths", () => {
  it("miter limit, chokes, spreads, bevel depth/altitude, cell insets", () => {
    const t = (p: string) => (CORE_PATHS as Record<string, { type?: unknown; wire?: string }>)[p];
    expect(t("frameStrokeMiterLimit")?.type).toEqual({ kind: "number" });
    for (const p of ["frameInnerShadowChoke", "frameOuterGlowSpread", "frameInnerGlowChoke", "frameBevelDepth", "frameFeatherChoke", "frameDirectionalFeatherChoke"]) {
      expect(t(p)?.type, p).toEqual({ kind: "number", unit: "percent" });
    }
    expect(t("frameBevelAltitude")?.type).toEqual({ kind: "number", unit: "deg" });
    for (const p of ["cellInsetTop", "cellInsetLeft", "cellInsetBottom", "cellInsetRight"]) {
      expect(t(p), p).toMatchObject({ wire: "length", type: { kind: "length" } });
    }
  });

  it("a miter limit refuses a unit string and ranges at 1..500", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const [pageId] = await h.load(minimalIdml());
    await h.host.document.mutate({ op: "insertFrame", args: { pageId: pageId!, bounds: [0, 0, 10, 10] } });
    const [rect] = await h.objects.query("rectangle");
    const row = (await h.objects.schema("frame")).find((r) => r.path === "frameStrokeMiterLimit");
    expect(row?.range).toEqual({ min: 1, max: 500 });
    expect(await h.objects.set(rect!, "frameStrokeMiterLimit", 0.5)).toMatchObject({ applied: false, code: "invalidValue" });
    expect(await h.objects.set(rect!, "frameStrokeMiterLimit", 6)).toMatchObject({ applied: true });
    expect(await h.objects.get(rect!, "frameStrokeMiterLimit")).toEqual(value(6));
  });
});

describe("14 — the planner sees the whole batch once", () => {
  it("two kinds -> ONE plugin-level planner call with every op, ONE label mutation", async () => {
    const { h, probe } = await setup({ pluginBatch: true });
    const [card] = await h.objects.query(CARD);
    probe.plans.length = 0;
    const mutate = vi.spyOn(h.host.editor.client, "mutate");
    await h.objects.batch([
      { op: "set", address: `${BOARD}/main`, path: "title", value: "A" },
      { op: "set", address: card!, path: "text", value: "B" },
      { op: "create", kind: CARD, props: { text: "C" } },
    ]);
    expect(probe.plans).toEqual([3]);
    const sent = mutate.mock.calls[0]![0] as { op: string; args: { ops?: { op: string }[] } };
    const labelOps = (sent.op === "batch" ? sent.args.ops! : [sent]).filter((m) => m.op === "setPluginMetadata");
    expect(labelOps).toHaveLength(1);
  });

  it("two objects of ONE kind (draw's two libraries) -> one kind-level call; distinct sub-keys from two kinds merge", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const [pageId] = await h.load(minimalIdml());
    await h.host.document.mutate({ op: "insertFrame", args: { pageId: pageId!, bounds: [0, 0, 10, 10] } });
    const [rect] = await h.objects.query("rectangle");
    const calls: number[] = [];
    const kind = (name: string) => ({
      kind: name,
      title: name,
      schema: [{ path: "p", type: { kind: "text" as const } }],
      hostOf: () => rect!,
      list: () => [],
      get: () => ({ kind: "absent" as const }),
      batch: (ops: readonly unknown[]): ObjectWrite => {
        calls.push(ops.length);
        return { kind: "state", parts: [], host: rect!, labelKey: `x-paged:acme.lib.${name}`, labelValue: JSON.stringify(ops.length) };
      },
    });
    h.objects.register({ plugin: "acme.lib", model: { kinds: [kind("swatches"), kind("styles")] } });
    const out = await h.objects.batch([
      { op: "set", address: "plugin:acme.lib/styles/a", path: "p", value: "1" },
      { op: "set", address: "plugin:acme.lib/styles/b", path: "p", value: "2" },
      { op: "set", address: "plugin:acme.lib/swatches/c", path: "p", value: "3" },
    ]);
    expect(out).toMatchObject({ applied: true, undoSteps: 1 });
    expect(calls.sort()).toEqual([1, 2]);
    const labels = (await h.objects.get(rect!, "labels")) as { value: Record<string, string> };
    expect(JSON.parse(labels.value["x-paged:acme.lib"]!)).toEqual({ v: 1, data: { styles: 2, swatches: 1 } });
  });
});

describe("12 — indexed paths", () => {
  it("a points[] row types every points[n]; nested and concrete forms; grammar", async () => {
    expect(rowPathOf("points[3].anchor")).toBe("points[].anchor");
    const rows = new Map([
      ["points[]", { path: "points[]" }],
      ["colorize[0]", { path: "colorize[0]" }],
    ]);
    expect(findRow(rows, "points[7]")?.path).toBe("points[]");
    expect(findRow(rows, "colorize[0]")?.path).toBe("colorize[0]");
    expect(findRow(rows, "colorize[1]")).toBeNull();
    expect(checkSchemaRows([{ path: "points[]", type: { kind: "point" } }, { path: "ranges[0][1]", type: { kind: "number" } }])).toBeNull();
    expect(checkSchemaRows([{ path: "a..b", type: { kind: "number" } }])).toMatch(/not a row path/);
    expect(checkSchemaRows([{ path: "a[", type: { kind: "number" } }])).toMatch(/not a row path/);
    const cli = readFileSync(fileURLToPath(new URL("../../plugin-cli/bin/paged-plugin.mjs", import.meta.url)), "utf8");
    expect(cli).toContain(`const ROW_PATH = /${ROW_PATH.source}/;`);

    const h = (live = await createHeadlessHost({ console: silent }));
    await h.load(minimalIdml());
    const seen: string[] = [];
    h.objects.register({
      plugin: "acme.path",
      model: {
        kinds: [
          {
            kind: "shape",
            title: "shape",
            schema: [
              { path: "name", type: { kind: "text" } },
              { path: "points[]", type: { kind: "point" } },
              { path: "points[].smooth", type: { kind: "bool" } },
            ],
            hostOf: () => null,
            list: () => ["plugin:acme.path/shape/1"],
            get: (_a, path) => ({ kind: "value", value: path }),
            set: (_a, path) => {
              seen.push(path);
              return { kind: "mutations", mutations: [] };
            },
          },
        ],
      },
    });
    const S = "plugin:acme.path/shape/1";
    expect(await h.objects.get(S, "points[4]")).toEqual(value("points[4]"));
    expect(await h.objects.set(S, "points[2]", [1, 2])).toMatchObject({ applied: true });
    expect(await h.objects.set(S, "points[2].smooth", true)).toMatchObject({ applied: true });
    expect(seen).toEqual(["points[2]", "points[2].smooth"]);
    expect(await h.objects.set(S, "points[2]", "x")).toMatchObject({ applied: false, code: "invalidValue" });
    expect(await h.objects.set(S, "nope[1]", 1)).toMatchObject({ applied: false, code: "unknownPath" });
    expect(Object.keys(await h.objects.getAll(S))).toEqual(["name"]);
  });
});

describe("13 — returned mutations pass the label-key check", () => {
  it("a foreign or sub key, a bad envelope, a foreign caller are refused; the own key gets its caller", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const [pageId] = await h.load(minimalIdml());
    await h.host.document.mutate({ op: "insertFrame", args: { pageId: pageId!, bounds: [0, 0, 10, 10] } });
    const [rect] = await h.objects.query("rectangle");
    const elementId = { kind: "rectangle", id: rect!.split(":")[1]! };
    let next: MutationInput[] = [];
    h.objects.register({
      plugin: "acme.mut",
      model: {
        kinds: [
          {
            kind: "x",
            title: "x",
            schema: [{ path: "p", type: { kind: "text" } }],
            hostOf: () => rect!,
            list: () => [],
            get: () => ({ kind: "absent" }),
            set: () => ({ kind: "mutations", mutations: next }),
          },
        ],
      },
    });
    const meta = (key: string, value: string | null, caller?: string) =>
      ({ op: "setPluginMetadata", args: { elementId, key, value, ...(caller ? { caller } : {}) } }) as unknown as MutationInput;
    const env = '{"v":1,"data":{"a":1}}';
    const run = async (m: MutationInput[]) => {
      next = m;
      return h.objects.set("plugin:acme.mut/x/1", "p", "v");
    };
    expect(await run([meta("x-paged:other", env)])).toMatchObject({ applied: false, code: "denied" });
    expect(await run([meta("x-paged:acme.mut.sub", env)])).toMatchObject({ applied: false, code: "denied" });
    expect(await run([meta("x-paged:acme.mut", env, "other")])).toMatchObject({ applied: false, code: "denied" });
    expect(await run([meta("x-paged:acme.mut", '{"data":1}')])).toMatchObject({ applied: false, code: "invalidValue" });
    expect(await run([{ op: "batch", args: { ops: [meta("x-paged:other", env)] } } as unknown as MutationInput])).toMatchObject({
      applied: false,
      code: "denied",
    });
    const mutate = vi.spyOn(h.host.editor.client, "mutate");
    expect(await run([meta("x-paged:acme.mut", env)])).toMatchObject({ applied: true });
    expect((mutate.mock.calls[0]![0] as { args: { caller?: string } }).args.caller).toBe("acme.mut");
  });
});
