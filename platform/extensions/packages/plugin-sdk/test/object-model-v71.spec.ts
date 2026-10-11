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
// The core seam on engine protocol 71 (ADR 131 / 132 / 323): address
// strings straight into `Set` / `RequestGet` / `RequestQuery`, rows from
// the vendored catalog's `propertySchemas`, core creates and deletes in
// the same one-undo-step batch, and the feature-detected fallback to the
// pre-71 table. Real engine (the local protocol-71 canvas-wasm while 71 is
// unreleased).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { PagedEditor } from "@paged-media/plugin-api";

import { createCoreObjects } from "../src/core-objects";
import { codeOfEngineRefusal } from "../src/core-objects-v71";
import { CORE_CATALOG_ROWS, CORE_PATHS, CORE_ROWLESS_PATHS, coreSchema71 } from "../src/core-schema";
import { assetFromBytes, validateValue } from "../src/object-schema";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { createObjectRegistry } from "../src/object-registry";
import { minimalIdml } from "./fixtures/minimal-idml";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

const value = (v: unknown) => ({ kind: "value", value: v });

/** One document holding an object of every core kind with a writable row:
 *  made through `host.objects` creates where core has one, the raw wire
 *  for the rest. */
async function everything(h: HeadlessHost) {
  const [pageId] = await h.load(minimalIdml());
  const made = await h.objects.batch([
    { op: "create", kind: "textFrame", within: "page:#1", props: { frameBounds: [10, 10, 100, 200] }, handle: "t" },
    { op: "create", kind: "oval", props: { frameBounds: [120, 10, 160, 50] } },
    { op: "create", kind: "style:paragraph", props: { name: "Body" } },
    { op: "create", kind: "style:character", props: { name: "Em" } },
    { op: "create", kind: "style:object", props: { name: "Box" } },
    { op: "create", kind: "style:cell", props: { name: "Cell" } },
    { op: "create", kind: "style:table", props: { name: "Grid" } },
    { op: "create", kind: "gradient", props: { name: "Fade", stops: [{ stopColor: "Color/Black", locationPct: 0 }, { stopColor: "Color/Black", locationPct: 100 }] } },
    { op: "create", kind: "colorGroup", props: { name: "Brand" } },
    { op: "create", kind: "textVariable", props: { name: "Price", textVariableContents: "12 €" } },
    { op: "create", kind: "layer", props: { name: "Notes" } },
  ]);
  expect(made).toMatchObject({ applied: true, undoSteps: 1 });
  const [text, oval] = made.created!;
  expect(text).toMatch(/^textFrame:/);
  expect(oval).toMatch(/^oval:/);
  expect(made.created![10]).toMatch(/^layer:/);
  const storyId = made.outcome!.applied ? made.outcome!.minted!.find((m) => m.handle === "t")!.storyId! : "";
  const spread = (await h.objects.query("spread"))[0]!.slice("spread:".length);
  const anchor = (x: number, y: number) => ({ anchor: [x, y], left: [x, y], right: [x, y] });
  const raw = await h.host.document.mutate({
    op: "batch",
    args: {
      ops: [
        { op: "insertText", args: { storyId, offset: 0, text: "hello world" } },
        { op: "insertLine", args: { pageId: pageId!, start: [10, 300], end: [100, 300] } },
        { op: "insertTable", args: { storyId, rows: 2, cols: 2 } },
        { op: "insertField", args: { storyId, offset: 0, field: { placeholder: { plugin: "media.paged.data", key: "price" } } } },
        { op: "createNumberingList", args: { spec: { selfId: "NumberingList/Steps", name: "Steps" } } },
        { op: "insertGuide", args: { spreadId: spread, orientation: "horizontal", position: 72 } },
        { op: "insertSection", args: { atPage: pageId!, prefix: "A" } },
      ],
    },
  } as never);
  expect(raw.applied).toBe(true);
  const path = async (x: number) => {
    const r = await h.host.document.mutate({
      op: "insertPath",
      args: { pageId: pageId!, open: false, anchors: [anchor(x, 300), anchor(x + 40, 300), anchor(x + 20, 330)] },
    } as never);
    return r.applied ? r.createdId! : null;
  };
  const members = [await path(300), await path(400)];
  expect((await h.host.document.mutate({ op: "createGroup", args: { memberIds: members as never } } as never)).applied).toBe(true);
  const first = async (sel: string) => {
    const [a] = await h.objects.query(sel);
    expect(a, sel).toBeTruthy();
    return a!;
  };
  return {
    storyId,
    text: text!,
    oval: oval!,
    line: await first("graphicLine"),
    polygon: await first("polygon"),
    group: await first("group"),
    table: await first("table"),
    cell: await first("cell"),
    field: `field:${storyId}@0`,
    guide: await first("guide"),
    section: await first("section"),
    numberingList: await first("numberingList"),
    layer: made.created![10]!,
    master: await first("master"),
  };
}

describe("protocol 71 — every core address kind round-trips Set / Get", () => {
  it("one representative writable path per kind, read back through RequestGet", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    expect(h.protocolVersion).toBe(71);
    const o = await everything(h);
    const cases: Array<[address: string, path: string, value: unknown]> = [
      ["doc", "documentBleedTop", 9],
      ["page:#1", "pageMarginTop", 36],
      ["page:#1", "pageColumnCount", 2],
      ["rectangle:urect", "frameOpacity", 50],
      ["frame:urect", "frameStrokeWeight", 2],
      [o.text, "itemName", "price"],
      [o.oval, "frameFillColor", "Color/Black"],
      [o.line, "frameStrokeWeight", 3],
      [o.polygon, "frameOpacity", 70],
      [o.group, "groupTransform", [1, 0, 0, 1, 5, 5]],
      [`story:${o.storyId}`, "flowGrow", true],
      [`storyRange:${o.storyId}@1..6`, "characterFontSize", 18],
      [`storyRange:${o.storyId}@1..6`, "paragraphJustification", "CenterAlign"],
      [o.field, "value", "12,00"],
      [o.table, "appliedTableStyle", "TableStyle/Grid"],
      [o.table, "rows[0].height", 30],
      [o.cell, "cellFillColor", "Color/Black"],
      [o.cell, "cellVerticalJustification", "CenterAlign"],
      ["style:paragraph/ParagraphStyle/Body", "characterFontSize", 14],
      ["style:character/Em", "characterTracking", 50],
      ["style:object/ObjectStyle/Box", "objectStyleStrokeTint", 40],
      ["style:cell/CellStyle/Cell", "cellStyleRotationAngle", 90],
      ["style:table/TableStyle/Grid", "tableStyleBodyRegionCellStyle", "CellStyle/Cell"],
      ["swatch:Color/Black", "tint", 80],
      ["gradient:Gradient/Fade", "name", "Fade 2"],
      ["colorGroup:ColorGroup/Brand", "name", "Brand 2"],
      [o.numberingList, "continueAcrossStories", true],
      [o.guide, "position", 100],
      [o.section, "prefix", "B"],
      ["textVariable:dTextVariablenPrice", "textVariableContents", "15 €"],
      [o.layer, "layerVisible", false],
      [o.master, "name", "B"],
    ];
    const failures: string[] = [];
    for (const [address, path, v] of cases) {
      const w = await h.objects.set(address, path, v);
      if (!w.applied) {
        failures.push(`set ${address} ${path}: ${w.code} ${w.reason}`);
        continue;
      }
      expect(w.undoSteps).toBe(1);
      const r = await h.objects.get(address, path);
      if (r.kind !== "value") failures.push(`get ${address} ${path}: ${JSON.stringify(r)}`);
      else if (JSON.stringify(r.value) !== JSON.stringify(v) && !(typeof v === "number" && Math.abs((r.value as number) - v) < 1e-3)) {
        failures.push(`get ${address} ${path}: wrote ${JSON.stringify(v)}, read ${JSON.stringify(r.value)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("selectors are evaluated by core (and a cell needs no story id)", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const o = await everything(h);
    expect(await h.objects.query("page:#1 > oval")).toEqual([o.oval]);
    expect(await h.objects.set(o.text, "itemName", "price")).toMatchObject({ applied: true });
    expect(await h.objects.query('frame[name="price"]')).toEqual([o.text]);
    expect(await h.objects.query("textVariable")).toEqual(["textVariable:dTextVariablenPrice"]);
    expect(await h.objects.query("style:paragraph")).toContain("style:paragraph/ParagraphStyle/Body");
    expect((await h.objects.query("style:paragraph")).every((a) => a.startsWith("style:paragraph/"))).toBe(true);
    expect(o.cell).toMatch(/^cell:[^/]+\/0,0$/);
    // the paths core's catalog has no row for still read (the old
    // element read; a table's story is found through core's query)
    expect(await h.objects.get(o.table, "tableRowCount")).toEqual({ kind: "value", value: 2 });
    expect(await h.objects.get(o.text, "nextTextFrame")).toMatchObject({ kind: expect.stringMatching(/value|absent/) });
    // a predicate key core's grammar does not know is still answered (SDK evaluation)
    expect(await h.objects.query("page[index=1]")).toEqual(["page:usp"]);
  });
});

describe("protocol 71 — schemas come from core's catalog", () => {
  it("enum members validate before anything reaches the engine; no inferred rows", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const o = await everything(h);
    const range = `storyRange:${o.storyId}@0..5`;
    const rows = await h.objects.schema(range);
    const just = rows.find((r) => r.path === "paragraphJustification")!;
    expect(just.type).toMatchObject({ kind: "enum", members: expect.arrayContaining(["LeftAlign", "CenterAlign", "FullyJustified"]) });
    expect(just.default).toBe("LeftAlign");
    expect(rows.some((r) => (r as { inferred?: true }).inferred)).toBe(false);
    const bad = await h.objects.set(range, "paragraphJustification", "Middle");
    expect(bad).toMatchObject({ applied: false, code: "invalidValue", undoSteps: 0 });
    expect(bad.reason).toMatch(/one of LeftAlign/);
    // a percent row carries core's range
    expect(await h.objects.set("rectangle:urect", "frameOpacity", 140)).toMatchObject({ code: "invalidValue" });
    // struct shapes are named (open structs; core validates the fields)
    const swatchRows = await h.objects.schema("swatch:Color/Black");
    expect(swatchRows.find((r) => r.path === "color")!.type).toMatchObject({ kind: "struct", shape: "SwatchColorSpec", open: true });
    // style rows are per family
    const objectRows = await h.objects.schema("style:object/ObjectStyle/Box");
    expect(objectRows.some((r) => r.path === "objectStyleStrokeTint")).toBe(true);
    expect(objectRows.some((r) => r.path === "paragraphJustification")).toBe(false);
    // kinds core added at 71
    expect((await h.objects.kinds()).map((k) => k.kind)).toEqual(expect.arrayContaining(["textVariable", "gradient", "guide", "section"]));
  });

  it("a row core accepts but does not store is read-only here (cellFillTint: engine 71 reads null, drops the write)", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const o = await everything(h);
    const row = (await h.objects.schema(o.cell)).find((r) => r.path === "cellFillTint")!;
    expect(row).toMatchObject({ access: "readOnly", bindable: false });
    expect(row.summary).toMatch(/not stored/);
    expect(await h.objects.set(o.cell, "cellFillTint", 50)).toMatchObject({ applied: false, code: "readOnly", undoSteps: 0 });
    expect(await h.objects.get(o.cell, "cellFillTint")).toMatchObject({ kind: expect.stringMatching(/value|absent/) });
  });

  it("final 71 reads: mixed is its own result, refusals carry core's code, null clears a nullable text row", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const o = await everything(h);
    // A range whose runs disagree: `mixed`, not a null value or an error.
    expect(await h.objects.set(`storyRange:${o.storyId}@1..6`, "characterFontSize", 18)).toMatchObject({ applied: true });
    expect(await h.objects.get(`storyRange:${o.storyId}@1..10`, "characterFontSize")).toEqual({ kind: "mixed" });
    expect(await h.objects.get(`storyRange:${o.storyId}@1..6`, "characterFontSize")).toEqual(value(18));
    // Core's refusal codes, not message matching.
    expect(await h.objects.get("frame:nosuchframe", "frameOpacity")).toMatchObject({ kind: "refused", code: "unknownAddress" });
    // null clears (the engine reads it as the empty string): one undo step.
    expect(await h.objects.set(o.text, "appliedObjectStyle", "ObjectStyle/Box")).toMatchObject({ applied: true });
    expect(await h.objects.get(o.text, "appliedObjectStyle")).toEqual(value("ObjectStyle/Box"));
    expect(await h.objects.set(o.text, "appliedObjectStyle", null)).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get(o.text, "appliedObjectStyle")).not.toEqual(value("ObjectStyle/Box"));
    await h.host.document.undo();
    expect(await h.objects.get(o.text, "appliedObjectStyle")).toEqual(value("ObjectStyle/Box"));
  });

  it("codeOfEngineRefusal maps core's typed codes, and falls back to the text", () => {
    expect(codeOfEngineRefusal("noSuchPath", "x")).toBe("unknownPath");
    expect(codeOfEngineRefusal("notFound", "x")).toBe("unknownAddress");
    expect(codeOfEngineRefusal("noDocument", "x")).toBe("unknownAddress");
    expect(codeOfEngineRefusal("badAddress", "x")).toBe("badAddress");
    expect(codeOfEngineRefusal(undefined, "frame:x names nothing")).toBe("unknownAddress");
  });

  it("every PropertyPath of the wire has a catalog row (operations aside), and the catalog names no path the wire lacks", () => {
    const wire = new Set(Object.keys(CORE_PATHS));
    const catalogPaths = new Set(CORE_CATALOG_ROWS.map((r) => r.path));
    const rowless = [...wire].filter((p) => !catalogPaths.has(p));
    // pluginMetadata is the label door (`labels[key]` rows), not a value
    // Operations (path edits) and the label door have no value row; the
    // catalog lists a few paths under their Boa alias; four wire paths
    // have no row in core's catalog at all (CORE_ROWLESS_PATHS).
    const aliases = new Map(
      (JSON.parse(readFileSync(fileURLToPath(new URL("../../plugin-api/src/catalog.json", import.meta.url)), "utf8")) as {
        pathAliases: { name: string; wire: string }[];
      }).pathAliases.map((a) => [a.wire, a.name]),
    );
    const ops = new Set(Object.entries(CORE_PATHS).filter(([, r]) => "op" in r).map(([p]) => p));
    const unexplained = rowless.filter((p) => !ops.has(p) && !catalogPaths.has(aliases.get(p) ?? ""));
    expect(unexplained.sort()).toEqual([...CORE_ROWLESS_PATHS].sort());
    // (`nextTextFrame` / `previousTextFrame` became catalog rows in core 15f51e3)
    expect([...CORE_ROWLESS_PATHS].sort()).toEqual(["tableColumnCount", "tableRowCount"]);
    const catalog = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../plugin-api/src/catalog.json", import.meta.url)), "utf8"),
    ) as { settablePaths: string[] };
    for (const p of catalog.settablePaths) expect(wire.has(p) || catalog.settablePaths.includes(p), p).toBe(true);
    // the normalised table has every kind core publishes
    expect([...coreSchema71().keys()]).toEqual(
      expect.arrayContaining(["frame", "story", "page", "doc", "swatch", "style:paragraph", "style:table", "textVariable", "cell", "table", "layer", "field"]),
    );
  });
});

/** A 1×1 PNG: bytes, and the `data:` URI core reads them back as. */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_URI = `data:image/png;base64,${PNG_B64}`;
const PNG_BYTES = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

describe("protocol 71 closure — the bindable gaps are rows (core 15f51e3)", () => {
  it("the 8 rows are typed from the catalog: asset, textFrame / pageItem refs with clearOp, indexed points", async () => {
    const rows = coreSchema71().get("frame")!;
    expect(rows.get("imageBytes")!.schema).toMatchObject({ type: { kind: "asset", shape: "data:<mime>;base64,<payload>" }, nullable: true, bindable: true });
    expect(rows.get("nextTextFrame")!.schema).toMatchObject({ type: { kind: "ref", to: "textFrame" }, virtual: { op: "linkFrames", clearOp: "unlinkFrames" } });
    expect(rows.get("previousTextFrame")!.inferred).toBeUndefined();
    expect(rows.get("opacityMask")!.schema).toMatchObject({ type: { kind: "ref", to: "pageItem" }, virtual: { clearOp: "releaseOpacityMask" } });
    expect(rows.get("points[].anchor")!.schema.type).toMatchObject({ kind: "list", of: { kind: "length" } });
    expect(rows.get("points[].curveType")!.schema.type).toEqual({ kind: "enum", members: ["Corner", "Smooth"] });
    expect(assetFromBytes(PNG_BYTES)).toBe(PNG_URI);
    expect(validateValue({ kind: "asset" }, "data:image/png;base64,***")).toMatch(/not base64/);
    expect(validateValue({ kind: "asset" }, "data:image/png,abc")).toMatch(/base64/);
    expect(validateValue({ kind: "asset" }, new Uint8Array())).toMatch(/no bytes/);
    expect(validateValue({ kind: "asset" }, PNG_B64)).toBeNull();
  });

  it("imageBytes: set from bytes / data URI / bare base64, null clears, one undo step each", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    await h.load(minimalIdml());
    const fromBytes = await h.objects.set("rectangle:urect", "imageBytes", PNG_BYTES);
    expect(fromBytes).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get("rectangle:urect", "imageBytes")).toEqual(value(PNG_URI));
    expect(await h.objects.set("rectangle:urect", "imageBytes", null)).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get("rectangle:urect", "imageBytes")).toEqual(value(null));
    await h.host.document.undo();
    expect(await h.objects.get("rectangle:urect", "imageBytes")).toEqual(value(PNG_URI));
    expect(await h.objects.set("rectangle:urect", "imageBytes", PNG_B64)).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.set("rectangle:urect", "imageBytes", PNG_BYTES.buffer)).toMatchObject({ applied: true, undoSteps: 1 });
    // refused before the engine: nothing applied
    expect(await h.objects.set("rectangle:urect", "imageBytes", "data:image/png;base64,***")).toMatchObject({ applied: false, code: "invalidValue", undoSteps: 0 });
    expect(await h.objects.set("rectangle:urect", "imageBytes", 42)).toMatchObject({ applied: false, code: "invalidValue", undoSteps: 0 });
    // a batch: bytes and another write are ONE step
    const b = await h.objects.batch([
      { op: "set", address: "rectangle:urect", path: "imageBytes", value: null },
      { op: "set", address: "rectangle:urect", path: "frameOpacity", value: 40 },
    ]);
    expect(b).toMatchObject({ applied: true, undoSteps: 1 });
    await h.host.document.undo();
    expect(await h.objects.get("rectangle:urect", "imageBytes")).toEqual(value(PNG_URI));
  });

  it("a span count takes its keyword: \"All\" goes to the engine as a typed Enum and reads back", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const o = await everything(h);
    const at = `storyRange:${o.storyId}@0..1`;
    expect(await h.objects.set(at, "paragraphSpanSplitColumnCount", "All")).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get(at, "paragraphSpanSplitColumnCount")).toEqual(value("All"));
    expect(await h.objects.set(at, "paragraphSpanSplitColumnCount", "Some")).toMatchObject({ applied: false, code: "invalidValue", undoSteps: 0 });
  });

  it("a caret is an address: storyRange@n..n reads and writes the paragraph it stands in (core v0.71.2)", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const o = await everything(h);
    const caret = `storyRange:${o.storyId}@0..0`;
    expect(await h.objects.set(caret, "paragraphSpaceBefore", 7)).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get(caret, "paragraphSpaceBefore")).toEqual(value(7));
  });

  it("nextTextFrame / previousTextFrame: link by address, unlink with null, undo restores", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const o = await everything(h);
    const made = await h.objects.batch([{ op: "create", kind: "textFrame", within: "page:#1", props: { frameBounds: [200, 10, 260, 200] } }]);
    expect(made).toMatchObject({ applied: true });
    const tail = made.created![0]!;
    const id = (a: string) => a.slice(a.indexOf(":") + 1);
    expect(await h.objects.get(o.text, "nextTextFrame")).toEqual(value(null));
    expect(await h.objects.set(o.text, "nextTextFrame", tail)).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get(o.text, "nextTextFrame")).toEqual(value(id(tail)));
    expect(await h.objects.get(tail, "previousTextFrame")).toEqual(value(id(o.text)));
    // unlink from the other end (clearOp unlinkFrames)
    expect(await h.objects.set(tail, "previousTextFrame", null)).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get(o.text, "nextTextFrame")).toEqual(value(null));
    await h.host.document.undo();
    expect(await h.objects.get(o.text, "nextTextFrame")).toEqual(value(id(tail)));
    await h.host.document.undo();
    expect(await h.objects.get(o.text, "nextTextFrame")).toEqual(value(null));
    // a thread target must be a text frame (core refuses; nothing applied)
    expect(await h.objects.set(o.text, "nextTextFrame", o.oval)).toMatchObject({ applied: false, undoSteps: 0 });
  });

  it("opacityMask: set to another item, null releases (clearOp), undo restores", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const o = await everything(h);
    const id = (a: string) => a.slice(a.indexOf(":") + 1);
    expect(await h.objects.get("rectangle:urect", "opacityMask")).toEqual(value(null));
    expect(await h.objects.set("rectangle:urect", "opacityMask", o.oval)).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get("rectangle:urect", "opacityMask")).toEqual(value(id(o.oval)));
    expect(await h.objects.set("rectangle:urect", "opacityMask", null)).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get("rectangle:urect", "opacityMask")).toEqual(value(null));
    await h.host.document.undo();
    expect(await h.objects.get("rectangle:urect", "opacityMask")).toEqual(value(id(o.oval)));
  });

  it("points[i].anchor / left / right / curveType: indexed rows get and set", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const o = await everything(h);
    const p = o.polygon;
    expect(await h.objects.get(p, "points[1].anchor")).toEqual(value([340, 300]));
    expect(await h.objects.set(p, "points[1].anchor", [345, 305])).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get(p, "points[1].anchor")).toEqual(value([345, 305]));
    // core reads Corner while both handles sit on the anchor
    expect(await h.objects.get(p, "points[1].curveType")).toEqual(value("Corner"));
    expect(await h.objects.set(p, "points[1].curveType", "Smooth")).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get(p, "points[1].curveType")).toEqual(value("Smooth"));
    await h.host.document.undo();
    expect(await h.objects.get(p, "points[1].curveType")).toEqual(value("Corner"));
    expect(await h.objects.set(p, "points[1].left", [335, 305])).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get(p, "points[1].left")).toEqual(value([335, 305]));
    expect(await h.objects.get(p, "points[1].curveType")).toEqual(value("Smooth"));
    // the enum is checked here; the index and the arity by core
    expect(await h.objects.set(p, "points[1].curveType", "Symmetric")).toMatchObject({ applied: false, code: "invalidValue", undoSteps: 0 });
    expect(await h.objects.get(p, "points[99].anchor")).toMatchObject({ kind: "refused" });
    expect(await h.objects.set(p, "points[0].anchor", [1, 2, 3])).toMatchObject({ applied: false, undoSteps: 0 });
  });
});

describe("protocol 71 — core creates and deletes are ordinary batch ops", () => {
  it("a binding that mints a swatch and applies it is ONE undo step", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    await h.load(minimalIdml());
    const w = await h.objects.batch([
      { op: "create", kind: "swatch", props: { name: "Brand", color: { space: "CMYK", value: [10, 80, 0, 0] } } },
      { op: "set", address: "rectangle:urect", path: "frameFillColor", value: "Color/Brand" },
    ]);
    expect(w).toMatchObject({ applied: true, undoSteps: 1, created: ["swatch:Color/Brand"] });
    expect(await h.objects.get("swatch:Color/Brand", "value")).toEqual(value([10, 80, 0, 0]));
    expect(await h.objects.get("swatch:Brand", "name")).toEqual(value("Brand")); // a name resolves too
    expect(await h.objects.get("rectangle:urect", "frameFillColor")).toEqual(value("Color/Brand"));
    await h.host.document.undo();
    expect(await h.objects.get("swatch:Color/Brand", "value")).toMatchObject({ kind: "refused", code: "unknownAddress" });
    expect(await h.objects.get("rectangle:urect", "frameFillColor")).toEqual(value("Color/Black"));
  });

  it("create props become sets on the new object; minted items resolve; a refusal applies nothing", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    await h.load(minimalIdml());
    const w = await h.objects.batch([
      { op: "create", kind: "page", props: { pageMarginTop: 48 }, handle: "p" },
      { op: "create", kind: "rectangle", within: "page:#1", props: { frameBounds: [0, 0, 20, 20], frameOpacity: 30 }, handle: "r" },
      { op: "set", address: "$h:r", path: "itemName", value: "logo" },
      { op: "create", kind: "style:paragraph", props: { name: "Head", characterFontSize: 24 } },
    ]);
    expect(w).toMatchObject({ applied: true, undoSteps: 1 });
    const [page, rect, style] = w.created!;
    expect(page).toMatch(/^page:/);
    expect(rect).toMatch(/^rectangle:/);
    expect(style).toBe("style:paragraph/ParagraphStyle/Head");
    expect(await h.objects.get(page!, "pageMarginTop")).toEqual(value(48));
    expect(await h.objects.get(rect!, "frameOpacity")).toEqual(value(30));
    expect(await h.objects.query('rectangle[name="logo"]')).toEqual([rect]);
    expect(await h.objects.get(style!, "characterFontSize")).toEqual(value(24));

    const pages = (await h.objects.query("page")).length;
    const refusedBatch = await h.objects.batch([
      { op: "create", kind: "page" },
      { op: "create", kind: "swatch", props: { name: "X", tint: 400 } },
    ]);
    expect(refusedBatch).toMatchObject({ applied: false, code: "invalidValue", index: 1, undoSteps: 0 });
    expect(await h.objects.query("page")).toHaveLength(pages);
    expect(await h.objects.batch([{ op: "set", address: "$h:nope", path: "frameOpacity", value: 1 }])).toMatchObject({ code: "unmapped" });

    // deletes
    expect(await h.objects.batch([{ op: "delete", address: style! }, { op: "delete", address: rect! }])).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get(style!, "characterFontSize")).toMatchObject({ kind: "refused", code: "unknownAddress" });
  });

  it("text variable: create, instance it in text, switch its value with one set", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const [pageId] = await h.load(minimalIdml());
    const made = await h.objects.batch([
      { op: "create", kind: "textFrame", within: `page:${pageId}`, props: { frameBounds: [10, 10, 100, 200] }, handle: "t" },
      { op: "create", kind: "textVariable", props: { name: "Price", textVariableContents: "12 €" } },
    ]);
    expect(made).toMatchObject({ applied: true, created: [expect.stringMatching(/^textFrame:/), "textVariable:dTextVariablenPrice"] });
    const storyId = made.outcome!.applied ? made.outcome!.minted![0]!.storyId! : "";
    const ins = await h.host.document.mutate({
      op: "batch",
      args: {
        ops: [
          { op: "insertText", args: { storyId, offset: 0, text: "Price: " } },
          { op: "insertField", args: { storyId, offset: 7, field: { textVariable: { variableId: "dTextVariablenPrice" } } } },
        ],
      },
    } as never);
    expect(ins.applied).toBe(true);
    expect(await h.objects.get(`story:${storyId}`, "content")).toEqual(value("Price: 12 €"));
    expect(await h.objects.set("textVariable:dTextVariablenPrice", "textVariableContents", "15 €")).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get(`story:${storyId}`, "content")).toEqual(value("Price: 15 €"));
    // core refuses deleting a variable that is still instanced
    expect(await h.objects.batch([{ op: "delete", address: "textVariable:dTextVariablenPrice" }])).toMatchObject({ applied: false });
    await h.host.document.undo();
    expect(await h.objects.get(`story:${storyId}`, "content")).toEqual(value("Price: 12 €"));
  });
});

describe("protocol fallback — below 71 the interim table answers", () => {
  it("feature detection: a probe reply without queryResult means the old seam", async () => {
    const replies: string[] = [];
    const fake = (protocol: number | undefined, kind: string): PagedEditor =>
      ({
        client: {
          async send(m: { kind: string }) {
            replies.push(m.kind);
            return { kind, ...(protocol !== undefined ? { protocol } : {}), payload: {} };
          },
          subscribe: () => () => {},
          collection: async () => [],
        },
      }) as unknown as PagedEditor;
    expect(await createCoreObjects(() => fake(70, "mutationFailed")).ready!()).toBe(70);
    expect(await createCoreObjects(() => fake(undefined, "queryResult")).ready!()).toBe(71);
    expect(await createCoreObjects(() => fake(undefined, "mutationFailed")).ready!()).toBe(70);
    expect(await createCoreObjects(() => fake(71, "x"), { protocol: 69 }).ready!()).toBe(69);
    expect(replies.every((k) => k === "requestQuery")).toBe(true);

    // a registry over a pre-71 engine: core creates are unmapped, the
    // table's rows answer, Set is never sent
    const sent: unknown[] = [];
    const old = {
      client: {
        async send(m: { kind: string }) {
          return m.kind === "requestQuery" ? { kind: "mutationFailed", protocol: 70, payload: {} } : { kind: "x", payload: {} };
        },
        async mutate(m: unknown) {
          sent.push(m);
          return { kind: "mutationApplied", payload: { pageIds: [], createdId: null } };
        },
        subscribe: () => () => {},
        collection: async () => [],
        documentMeta: async () => ({}),
      },
    } as unknown as PagedEditor;
    const reg = createObjectRegistry({ core: createCoreObjects(() => old) });
    expect(await reg.batch([{ op: "create", kind: "swatch", props: { name: "A" } }])).toMatchObject({ code: "unmapped" });
    const rows = await reg.schema("frame");
    // the table's rows, typed by the catalog where it has the path
    expect(rows.find((r) => r.path === "frameStrokeType")!.type).toMatchObject({ kind: "enum" });
    expect(rows.some((r) => r.path === "itemName")).toBe(false); // a protocol-71 path
    expect(await reg.get("cell:t/0,0", "cellFillColor")).toMatchObject({ kind: "refused", code: "unmapped" });
    expect(sent).toEqual([]);
  });
});
