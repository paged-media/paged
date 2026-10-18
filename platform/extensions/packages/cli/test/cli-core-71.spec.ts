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

// @feat: plugin-platform.object-model.node-cli
//
// The CLI on the protocol-71 core seam (DESIGN.md §21.9): `paged create` /
// `paged delete` for core objects, and `paged get` / `paged set` on EVERY
// core address kind, each write saved to a .paged file and read back from
// it by a fresh session. Protocol-aware: on a protocol-70 engine (the
// published lane) a core create answers `unmapped` and the every-kind sweep
// does not apply.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHeadlessHost } from "@paged-media/plugin-sdk";

import { minimalIdml } from "../../plugin-sdk/test/fixtures/minimal-idml";
import { cli, engineOptions, laneProtocol, silent, tempDir, writeFixture } from "./helpers";

const NP = "--no-plugins";

let tmp: ReturnType<typeof tempDir>;
let fx: Awaited<ReturnType<typeof writeFixture>>;
let lane = 0;
beforeAll(async () => {
  tmp = tempDir();
  fx = await writeFixture(tmp.dir);
  lane = await laneProtocol();
});
afterAll(() => tmp.done());

/** A .paged file holding an object of every core kind with a writable row
 *  (core creates where core has one, the raw wire for the rest). */
async function writeEverything(dir: string) {
  const h = await createHeadlessHost({ console: silent, ...(await engineOptions()) });
  try {
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
    if (!made.applied) throw new Error(`everything: ${made.code} ${made.reason}`);
    const [text, oval] = made.created!;
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
    if (!raw.applied) throw new Error("everything: raw batch refused");
    const path = async (x: number) => {
      const r = await h.host.document.mutate({
        op: "insertPath",
        args: { pageId: pageId!, open: false, anchors: [anchor(x, 300), anchor(x + 40, 300), anchor(x + 20, 330)] },
      } as never);
      return r.applied ? r.createdId! : null;
    };
    const members = [await path(300), await path(400)];
    if (!(await h.host.document.mutate({ op: "createGroup", args: { memberIds: members as never } } as never)).applied) throw new Error("everything: group refused");
    const first = async (sel: string) => (await h.objects.query(sel))[0]!;
    const o = {
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
    const file = join(dir, "everything.paged");
    writeFileSync(file, (await h.exportDocument("paged")).bytes);
    return { file, ...o };
  } finally {
    h.dispose();
  }
}

describe("paged create / delete — core objects", () => {
  it("creates a swatch with its props in one undo step, reads it back from the file, deletes it", async () => {
    const out = join(tmp.dir, "swatch.paged");
    const made = await cli(["create", fx.paged, "swatch", '{"name":"Brand","space":"CMYK","value":[100,0,0,0]}', "-o", out, NP]);
    if (lane < 71) {
      // the pre-71 seam has no wire form for a core create
      expect(made.code).toBe(1);
      expect(made.json.result).toMatchObject({ applied: false, code: "unmapped" });
      return;
    }
    expect(made.code).toBe(0);
    expect(made.json.created).toEqual(["swatch:Color/Brand"]);
    expect(made.json.result).toMatchObject({ applied: true, undoSteps: 1 });
    // the created address is not %-escaped (core's protocol-71 grammar)
    expect((await cli(["get", out, "swatch:Color/Brand", "value", NP])).json.value).toEqual([100, 0, 0, 0]);
    expect((await cli(["query", out, "swatch[name=Brand]", NP])).json.addresses).toEqual(["swatch:Color/Brand"]);

    const gone = join(tmp.dir, "swatch-gone.paged");
    const del = await cli(["delete", out, "swatch:Color/Brand", "-o", gone, NP]);
    expect(del.code).toBe(0);
    expect(del.json.result).toMatchObject({ applied: true, undoSteps: 1 });
    expect((await cli(["query", gone, "swatch[name=Brand]", NP])).json.addresses).toEqual([]);
  });

  it("creates a text frame within a page (props from a file), and deletes by selector", async () => {
    if (lane < 71) return;
    const props = join(tmp.dir, "frame.json");
    writeFileSync(props, JSON.stringify({ frameBounds: [300, 20, 360, 220], itemName: "caption" }));
    const out = join(tmp.dir, "frame.paged");
    const made = await cli(["create", fx.paged, "textFrame", props, "--within", "page:#1", "-o", out, NP]);
    expect(made.code).toBe(0);
    expect(made.json.created).toHaveLength(1);
    expect(made.json.created[0]).toMatch(/^textFrame:/);
    expect((await cli(["query", out, 'frame[name="caption"]', NP])).json.addresses).toEqual(made.json.created);

    const gone = join(tmp.dir, "frame-gone.paged");
    const del = await cli(["delete", out, 'frame[name="caption"]', "-o", gone, NP]);
    expect(del.code).toBe(0);
    expect(del.json.targets).toEqual(made.json.created);
    expect((await cli(["query", gone, 'frame[name="caption"]', NP])).json.addresses).toEqual([]);
  });

  it("a create prop that does not fit the kind's schema applies nothing (exit 1); usage errors exit 2", async () => {
    const bad = await cli(["create", fx.paged, "swatch", '{"name":"X","space":"Pantone"}', "--no-save", NP]);
    expect(bad.code).toBe(1);
    expect(bad.json.result).toMatchObject({ applied: false });
    if (lane >= 71) expect(bad.json.result.code).toBe("invalidValue");
    expect((await cli(["create", fx.paged, "swatch", "{not json", "--no-save", NP])).code).toBe(2);
    expect((await cli(["create", fx.paged, "textFrame", "{}", "--within", "nowhere", "--no-save", NP])).code).toBe(2);
    expect((await cli(["delete", fx.paged, "swatch[name=Nope]", "--no-save", NP])).code).toBe(1);
  });
});

describe("paged get / set — every core address kind on the protocol-71 seam", () => {
  it("each write is saved to the file and read back by a fresh session", async () => {
    if (lane < 71) return;
    const o = await writeEverything(tmp.dir);
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
      const text = typeof v === "string" ? v : JSON.stringify(v);
      const set = await cli(["set", o.file, address, path, text, NP]);
      if (set.code !== 0) {
        failures.push(`set ${address} ${path}: ${JSON.stringify(set.json?.result ?? set.json?.error ?? set.err)}`);
        continue;
      }
      if (set.json.result.undoSteps !== 1) failures.push(`set ${address} ${path}: ${set.json.result.undoSteps} undo steps`);
      const got = await cli(["get", o.file, address, path, NP]);
      const r = got.json?.value;
      if (got.code !== 0) failures.push(`get ${address} ${path}: ${JSON.stringify(got.json?.result ?? got.json?.error)}`);
      else if (JSON.stringify(r) !== JSON.stringify(v) && !(typeof v === "number" && Math.abs((r as number) - v) < 1e-3)) {
        failures.push(`get ${address} ${path}: wrote ${JSON.stringify(v)}, read ${JSON.stringify(r)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("paged get / set — the closure rows (core 15f51e3)", () => {
  it("imageBytes (asset), a thread link, an opacity mask and indexed path points survive the file", async () => {
    if (lane < 71) return;
    const o = await writeEverything(tmp.dir);
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const id = (a: string) => a.slice(a.indexOf(":") + 1);
    const cases: Array<[address: string, path: string, text: string, read: unknown]> = [
      ["rectangle:urect", "imageBytes", png, png],
      ["rectangle:urect", "opacityMask", o.oval, id(o.oval)],
      [o.polygon, "points[1].anchor", "[345, 305]", [345, 305]],
      [o.polygon, "points[2].curveType", "Smooth", "Smooth"],
    ];
    const failures: string[] = [];
    for (const [address, path, text, want] of cases) {
      const set = await cli(["set", o.file, address, path, text, NP]);
      if (set.code !== 0 || set.json.result.undoSteps !== 1) {
        failures.push(`set ${address} ${path}: ${JSON.stringify(set.json?.result ?? set.json?.error ?? set.err)}`);
        continue;
      }
      const got = await cli(["get", o.file, address, path, NP]);
      if (JSON.stringify(got.json?.value) !== JSON.stringify(want)) failures.push(`get ${address} ${path}: read ${JSON.stringify(got.json?.value ?? got.json)}`);
    }
    expect(failures).toEqual([]);
    // null clears through the row's clearOp; a bad asset is refused before the engine (exit 1)
    expect((await cli(["set", o.file, "rectangle:urect", "opacityMask", "null", NP])).code).toBe(0);
    expect((await cli(["get", o.file, "rectangle:urect", "opacityMask", NP])).json.value).toBeNull();
    const bad = await cli(["set", o.file, "rectangle:urect", "imageBytes", "data:image/png;base64,***", NP]);
    expect(bad.code).not.toBe(0);
  });
});

describe("the engine lane", () => {
  it("the session boots the INSTALLED engine (70 or 71) and reports its protocol", async () => {
    const r = await cli(["plugins", NP]);
    expect(r.code).toBe(0);
    expect(r.json.protocol).toBe(lane);
    expect(lane).toBeGreaterThanOrEqual(70);
  });
});
