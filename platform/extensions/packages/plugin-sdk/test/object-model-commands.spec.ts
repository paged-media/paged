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

// @feat: plugin-platform.object-model
//
// Typed CORE commands through host.objects (DESIGN.md §21.12): every
// catalog operation is a `core.<op>` command generated from the vendored
// wire, or an exclusion with a reason; a command runs as ONE batch, joins
// `host.objects.batch` beside set / create / delete (one undo step), takes
// addresses in id positions and answers created[]. Real engine (protocol 71).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "bun:test";

// The generator is a plain .mjs (no .d.ts).
// @ts-expect-error — JS module, no types; it exports pure fns and paths.
import { generate, SCHEMA, TARGET } from "../../../scripts/gen-core-commands.mjs";
import {
  CORE_COMMAND_CREATES,
  CORE_COMMAND_EXCLUSIONS,
  CORE_COMMAND_OPS,
  coreCommandInfos,
} from "../src/core-commands";
import { CORE_WIRE_OPS } from "../src/core-commands.generated";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { protocolFromVersion, readVendoredWireVersion } from "../src/wasm-loader";
import { checkValueType } from "../src/object-schema";
import { minimalIdml } from "./fixtures/minimal-idml";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const catalog = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../plugin-api/src/catalog.json", import.meta.url)), "utf8"),
) as { operations: string[] };

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

describe("guard — every catalog operation is a typed command or excluded with a reason", () => {
  it("covers the catalog", () => {
    const missing = catalog.operations.filter((op) => !CORE_COMMAND_OPS.includes(op) && !(op in CORE_COMMAND_EXCLUSIONS));
    expect(missing, "catalog ops with no typed command and no exclusion").toEqual([]);
    for (const [op, why] of Object.entries(CORE_COMMAND_EXCLUSIONS)) {
      expect(catalog.operations, `exclusion ${op} names a catalog op`).toContain(op);
      expect(why.length, `exclusion ${op} has a reason`).toBeGreaterThan(20);
      expect(CORE_COMMAND_OPS).not.toContain(op);
    }
  });

  it("the wire and the catalog list the same ops, and the generated file is current", () => {
    expect(Object.keys(CORE_WIRE_OPS).sort()).toEqual([...catalog.operations].sort());
    expect(readFileSync(TARGET, "utf8")).toBe(generate(readFileSync(SCHEMA, "utf8")));
  });

  it("every command has a well-formed args and result schema; the creates table names commands", () => {
    const infos = coreCommandInfos();
    expect(infos.length).toBe(CORE_COMMAND_OPS.length);
    for (const c of infos) {
      expect(c.id).toBe(`core.${c.id.slice(5)}`);
      expect(c.owner).toBe("core");
      expect(checkValueType(c.args, `${c.id}.args`)).toBeNull();
      expect(checkValueType(c.result, `${c.id}.result`)).toBeNull();
    }
    for (const op of Object.keys(CORE_COMMAND_CREATES)) expect(CORE_COMMAND_OPS).toContain(op);
    // Derived from the wire, not hand-written: insertTable's struct.
    const table = infos.find((c) => c.id === "core.insertTable")!.args;
    expect(table).toMatchObject({
      kind: "struct",
      fields: {
        storyId: { kind: "ref", to: "story" },
        rows: { kind: "number" },
        cols: { kind: "number" },
        headerRows: { kind: "number", optional: true },
        columnWidths: { kind: "list", of: { kind: "number" }, optional: true },
        handle: { kind: "text", optional: true },
      },
    });
  });
});

async function boot() {
  const h = (live = await createHeadlessHost({ console: silent }));
  // The engine the contract's wire was synced from (no skew), not a fixed number.
  expect(h.protocolVersion).toBe(protocolFromVersion((await readVendoredWireVersion())!));
  await h.load(minimalIdml());
  const made = await h.objects.batch([
    { op: "create", kind: "textFrame", within: "page:#1", props: { frameBounds: [10, 10, 100, 200] }, handle: "t" },
  ]);
  expect(made.applied).toBe(true);
  const storyId = made.outcome!.applied ? made.outcome!.minted!.find((m) => m.handle === "t")!.storyId! : "";
  return { h, frame: made.created![0]!, story: `story:${storyId}`, storyId };
}

const value = (v: unknown) => ({ kind: "value", value: v });

describe("core commands on the real engine", () => {
  it("lists core commands beside plugin commands", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const list = await h.objects.commands();
    expect(list.filter((c) => c.owner === "core").length).toBe(CORE_COMMAND_OPS.length);
  });

  it("content: insert text + a table + set a cell, ONE batch, one undo step", async () => {
    const { h, story } = await boot();
    const r = await h.objects.batch([
      { op: "invoke", command: "core.insertText", args: { storyId: story, offset: 0, text: "Prices" } },
      { op: "invoke", command: "core.insertTable", args: { storyId: story, rows: 2, cols: 3, handle: "tbl" } },
      { op: "invoke", command: "core.insertText", args: { storyId: story, offset: 0, text: "12 €", cell: { tableId: "$h:tbl", row: 1, col: 2 } } },
      { op: "set", address: "cell:$h:tbl/1,2", path: "cellFillColor", value: "Color/Black" },
    ]);
    expect(r, r.reason).toMatchObject({ applied: true, undoSteps: 1 });
    const table = r.commands![1]!.created[0]!;
    expect(table).toMatch(/^table:/);
    expect(r.commands![0]).toEqual({ index: 0, command: "core.insertText", created: [] });
    expect(await h.objects.get(`cell:${table.slice(6)}/1,2`, "cellFillColor")).toEqual(value("Color/Black"));
    expect(await h.objects.get(`${table}`, "tableColumnCount")).toEqual(value(3));
    // One undo step takes text, table and cell back.
    await h.host.document.undo();
    expect(await h.objects.query("table")).toEqual([]);
  });

  it("table structure: row / column insert + delete and a span, each by command", async () => {
    const { h, story, storyId } = await boot();
    const { created } = (await h.objects.invoke("core.insertTable", { storyId: story, rows: 2, cols: 2 })) as { created: string[] };
    const table = created[0]!;
    const tableId = table.slice("table:".length);
    const run = (command: string, args: Record<string, unknown>) => h.objects.invoke(command, { storyId, tableId: table, ...args });
    await run("core.insertTableRow", { at: 1 });
    await run("core.insertTableColumn", { at: 0 });
    expect(await h.objects.get(table, "tableRowCount")).toEqual(value(3));
    expect(await h.objects.get(table, "tableColumnCount")).toEqual(value(3));
    await run("core.deleteTableColumn", { at: 0 });
    await run("core.setCellSpan", { row: 0, col: 0, rowSpan: 1, columnSpan: 2 });
    expect(await h.objects.get(`cell:${tableId}/0,0`, "columnSpan")).toEqual(value(2));
    await run("core.deleteTableRow", { at: 2 });
    expect(await h.objects.get(table, "tableRowCount")).toEqual(value(2));
    // The bands (core 0.71.13): a header row the host added is counted as one,
    // and the band counts are read-only (they change through the commands).
    expect(await h.objects.get(table, "tableHeaderRowCount")).toEqual(value(0));
    await run("core.insertHeaderRow", {});
    expect(await h.objects.get(table, "tableHeaderRowCount")).toEqual(value(1));
    expect(await h.objects.get(table, "tableFooterRowCount")).toEqual(value(0));
    expect(await h.objects.set(table, "tableHeaderRowCount", 2)).toMatchObject({ applied: false, undoSteps: 0 });
  });

  it("structure: duplicate page, move page, insert page by handle — created pages", async () => {
    const { h } = await boot();
    const dup = (await h.objects.invoke("core.duplicatePage", { page: "page:#1" })) as { created: string[] };
    expect(dup.created).toHaveLength(1);
    expect(dup.created[0]).toMatch(/^page:/);
    const pages = await h.objects.query("page");
    expect(pages).toHaveLength(2);
    expect(pages[1]).toBe(dup.created[0]);
    await h.objects.invoke("core.movePage", { page: dup.created[0], after: null });
    const moved = await h.objects.query("page");
    expect(moved[0]).toBe(dup.created[0]);
    // insert a page and put a frame on it in the SAME batch through its handle
    const r = await h.objects.batch([
      { op: "invoke", command: "core.insertPage", args: { afterPageId: "page:#2", handle: "np" } },
      { op: "invoke", command: "core.insertFrame", args: { pageId: "$h:np", bounds: [20, 20, 60, 60], handle: "box" } },
      { op: "set", address: "$h:box", path: "itemName", value: "on the new page" },
    ]);
    expect(r, r.reason).toMatchObject({ applied: true, undoSteps: 1 });
    const page = r.commands![0]!.created[0]!;
    const frame = r.commands![1]!.created[0]!;
    expect(await h.objects.query(`${page} > rectangle`)).toEqual([frame]);
    expect(await h.objects.get(frame, "itemName")).toEqual(value("on the new page"));
  });

  it("structure: two page inserts in one batch — each command names the page it made", async () => {
    const { h } = await boot();
    // Both go right after page 1, so the second one ends up FIRST in the
    // document: the pages new since the batch, in document order, would
    // hand each command the other's page.
    const r = await h.objects.batch([
      { op: "invoke", command: "core.insertPage", args: { afterPageId: "page:#1", handle: "a" } },
      { op: "invoke", command: "core.insertPage", args: { afterPageId: "page:#1", handle: "b" } },
    ]);
    expect(r, r.reason).toMatchObject({ applied: true, undoSteps: 1 });
    const pages = await h.objects.query("page");
    expect(pages).toHaveLength(3);
    expect(r.commands![0]!.created).toEqual([pages[2]]);
    expect(r.commands![1]!.created).toEqual([pages[1]]);
    // The outcome names them, in creation order.
    const outcome = r.outcome!;
    expect(outcome.applied && outcome.createdPages?.map((id) => `page:${id}`)).toEqual([pages[2], pages[1]]);
  });

  it("the host's mutate outcome names the pages a write created, and only then", async () => {
    const { h } = await boot();
    const [first] = (await h.host.document.collection<{ selfId: string }>("pages")).map((p) => p.selfId);
    const made = await h.host.document.mutate({ op: "duplicatePage", args: { page: first! } });
    expect(made.applied).toBe(true);
    const pages = (await h.host.document.collection<{ selfId: string }>("pages")).map((p) => p.selfId);
    expect(made.applied && made.createdPages).toEqual(pages.filter((p) => p !== first));
    const moved = await h.host.document.mutate({ op: "movePage", args: { page: pages[1]!, after: null } });
    expect(moved.applied).toBe(true);
    expect(moved.applied && "createdPages" in moved, "a move creates nothing").toBe(false);
  });

  it("structure: duplicate elements, group, z-order, layer insert — addresses in, addresses out", async () => {
    const { h, frame } = await boot();
    const dup = (await h.objects.invoke("core.duplicateElements", { elementIds: [frame, "rectangle:urect"], offset: [10, 10] })) as {
      created: string[];
    };
    expect(dup.created).toHaveLength(2);
    expect(dup.created[0]).toMatch(/^textFrame:/);
    expect(dup.created[1]).toMatch(/^rectangle:/);
    const group = (await h.objects.invoke("core.createGroup", { memberIds: dup.created })) as { created: string[] };
    expect(group.created[0]).toMatch(/^group:/);
    await h.objects.invoke("core.reorderElement", { elementId: group.created[0], to: "back" });
    const layer = (await h.objects.invoke("core.layerInsert", { position: 0, name: "Notes" })) as { created: string[] };
    expect(layer.created[0]).toMatch(/^layer:/);
    expect(await h.objects.get(layer.created[0]!, "layerName")).toEqual(value("Notes"));
  });

  it("place image: a placed link on an existing frame", async () => {
    const { h } = await boot();
    const r = (await h.objects.invoke("core.placeImage", { elementId: "rectangle:urect", uri: "file:///photo.png" })) as {
      undoSteps: number;
    };
    expect(r.undoSteps).toBe(1);
    const links = (await h.host.document.collection("links")) as Array<{ uri?: string; linkResourceUri?: string }>;
    expect(JSON.stringify(links)).toContain("photo.png");
  });

  it("refusals are typed: unknown command, bad args, unknown argument, a handle on a non-creating command", async () => {
    const { h, story } = await boot();
    await expect(h.objects.invoke("core.nope", {})).rejects.toThrow(/^unknownCommand/);
    await expect(h.objects.invoke("core.insertText", { storyId: story, offset: "x", text: "a" })).rejects.toThrow(/^invalidValue/);
    await expect(h.objects.invoke("core.insertText", { storyId: story, offset: 0, text: "a", colour: 1 })).rejects.toThrow(
      /^invalidValue: .*no argument "colour"/,
    );
    await expect(h.objects.invoke("core.insertText", { storyId: story, offset: 0, text: "a", handle: "x" })).rejects.toThrow(
      /creates nothing to bind/,
    );
    const r = await h.objects.batch([
      { op: "set", address: "rectangle:urect", path: "itemName", value: "kept?" },
      { op: "invoke", command: "core.insertTable", args: { storyId: story, rows: "two", cols: 2 } },
    ]);
    expect(r).toMatchObject({ applied: false, code: "invalidValue", index: 1, undoSteps: 0 });
    expect(await h.objects.get("rectangle:urect", "itemName")).not.toEqual(value("kept?"));
  });

  it("a plugin cannot claim the core. prefix", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    expect(() =>
      h.objects.register({ plugin: "x.y", model: { kinds: [], commands: [{ id: "core.fake", title: "f", args: { kind: "struct", fields: {} }, handler: () => 1 }] } }),
    ).toThrow(/"core\." prefix/);
  });
});
