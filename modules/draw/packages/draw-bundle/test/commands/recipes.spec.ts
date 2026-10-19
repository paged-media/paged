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

// THE RECIPE COMMANDS with no engine (`unit-kit.ts`) — blends, repeats,
// patterns, objects on a path, live paint, symbols, graphic styles, the
// appearance stack and Image Trace. A record is built by its "make"
// command on the fake document (whose batches report `minted` the way
// the engine does), then every other command of the family runs against
// it: what it sends, as how many writes, what it does to the record's
// library part and to the selection, and that with no record selected it
// sends nothing and says why. The engine's answer is
// `test/headless/commands-recipes.spec.ts`.

import { describe, expect, it } from "bun:test";

import type { ElementId, Mutation } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import { pngBytes } from "../fixtures/build-idml";
import { ringPixels } from "../fixtures/corpus";
import { installPngRealm } from "../headless/raster-realm";
import { openEl, rectEl, unitRig, type FakeElement } from "./unit-kit";

const C = "media.paged.draw.command";
const A = { kind: "polygon", id: "ua" } as ElementId;
const B = { kind: "polygon", id: "ub" } as ElementId;
const POLY = { kind: "polygon", id: "upoly" } as ElementId;
const LINE = { kind: "graphicLine", id: "uline" } as ElementId;

const doc = (): FakeElement[] => [
  rectEl("polygon", "ua", [100, 100, 300, 300]),
  rectEl("polygon", "ub", [200, 200, 400, 400]),
  openEl("upoly", [
    [100, 400],
    [250, 600],
    [400, 400],
  ]),
  openEl(
    "uline",
    [
      [650, 100],
      [700, 400],
    ],
    {},
    "graphicLine",
  ),
];

const ops = (ms: Mutation[]) => ms.map((m) => m.op);
const count = (ms: Mutation[], op: string) =>
  ms.filter((m) => m.op === op).length;
const ids = (s: readonly ElementId[]) => s.map((e) => String(e.id)).sort();
const part = (r: ReturnType<typeof unitRig>, name: string) =>
  JSON.stringify(r.parts()[`paged/media.paged.draw/${name}.json`] ?? null);

/** `run` sent nothing and logged why (a refusal is never silent). */
async function refuses(
  selection: ElementId[],
  id: string,
  payload?: unknown,
): Promise<void> {
  const r = unitRig(doc(), { selection });
  r.reset();
  await r.run(id, payload);
  expect(r.sent(), `${id} sent something`).toEqual([]);
  expect(
    r.logs.some((l) => /^(warn|info|debug): /.test(l) && l.includes(id)),
    `${id} refused without a word`,
  ).toBe(true);
}

describe("paged.draw commands, no engine — blends", () => {
  async function blended() {
    const r = unitRig(doc(), { selection: [A, B] });
    await r.run(`${C}.blendSelected`, { steps: 2 });
    r.fake.setSelection([A, B]);
    r.reset();
    return r;
  }

  it("Blend builds the steps, links the keys and groups them in ONE batch; one path sends nothing", async () => {
    covers("command:media.paged.draw.command.blendSelected");
    const r = unitRig(doc(), { selection: [A, B] });
    await r.run(`${C}.blendSelected`, { steps: 2 });
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "insertPath")).toBe(2);
    expect(count(r.leaves(), "bindCreated")).toBe(2);
    expect(ops(r.leaves()).at(-1)).toBe("createGroup");
    expect(r.metaOf(A)?.data).toHaveProperty("blendKey");
    expect(part(r, "blend")).toContain("bl-1");
    await refuses([A], `${C}.blendSelected`);
  });

  it("Update blend rebuilds it with the new step count in one batch; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.updateBlend");
    const r = await blended();
    await r.run(`${C}.updateBlend`, { steps: 4 });
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "insertPath")).toBe(4);
    await refuses([POLY], `${C}.updateBlend`, { steps: 4 });
  });

  it("Replace spine runs the blend along the selected path in one batch; a plain selection sends nothing", async () => {
    covers("command:media.paged.draw.command.replaceBlendSpine");
    const r = await blended();
    r.fake.setSelection([POLY]);
    await r.run(`${C}.replaceBlendSpine`);
    expect(r.steps()).toBe(1);
    expect(r.metaOf(POLY)?.data).toHaveProperty("blendSpine");
    await refuses([POLY], `${C}.replaceBlendSpine`);
  });

  it("Reverse spine rebuilds from the far end and records it; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.reverseBlendSpine");
    const r = await blended();
    await r.run(`${C}.reverseBlendSpine`);
    expect(r.steps()).toBe(1);
    expect(part(r, "blend")).toContain('"reverseSpine":true');
    await refuses([POLY], `${C}.reverseBlendSpine`);
  });

  it("Reverse front to back flips the paint order in one batch; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.reverseBlendFrontToBack");
    const r = await blended();
    await r.run(`${C}.reverseBlendFrontToBack`);
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "insertPath")).toBe(2);
    await refuses([POLY], `${C}.reverseBlendFrontToBack`);
  });

  it("Select blend objects selects the keys and writes nothing; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.selectBlendObjects");
    const r = await blended();
    await r.run(`${C}.selectBlendObjects`);
    expect(ids(r.fake.selection())).toEqual(["ua", "ub"]);
    expect(r.sent()).toEqual([]);
    await refuses([POLY], `${C}.selectBlendObjects`);
  });

  it("Expand blend drops every link and keeps every path, in one batch; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.expandBlend");
    const r = await blended();
    await r.run(`${C}.expandBlend`);
    expect(r.steps()).toBe(1);
    expect(new Set(ops(r.leaves()))).toEqual(new Set(["setPluginMetadata"]));
    expect(r.metaOf(A)?.data ?? {}).not.toHaveProperty("blendKey");
    await refuses([POLY], `${C}.expandBlend`);
  });

  it("Release blend deletes the steps, ungroups and unlinks the keys, in one batch; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.releaseBlend");
    const r = await blended();
    await r.run(`${C}.releaseBlend`);
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "deleteFrame")).toBe(2);
    expect(count(r.leaves(), "dissolveGroup")).toBe(1);
    expect(r.metaOf(A)?.data ?? {}).not.toHaveProperty("blendKey");
    await refuses([POLY], `${C}.releaseBlend`);
  });
});

describe("paged.draw commands, no engine — repeats", () => {
  async function repeated() {
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.makeRadialRepeat`, { count: 4 });
    const copies = count(r.leaves(), "insertPath");
    r.fake.setSelection([A]);
    r.reset();
    return { r, copies };
  }

  it("Radial repeat places copies around a centre and groups them in ONE batch; nothing selected sends nothing", async () => {
    covers("command:media.paged.draw.command.makeRadialRepeat");
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.makeRadialRepeat`, { count: 4 });
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "insertPath")).toBeGreaterThan(0);
    expect(ops(r.leaves()).at(-1)).toBe("createGroup");
    expect(part(r, "repeat")).toContain('"radial"');
    await refuses([], `${C}.makeRadialRepeat`);
  });

  it("Grid repeat tiles the selection in one batch, more tiles for a bigger grid; nothing selected sends nothing", async () => {
    covers("command:media.paged.draw.command.makeGridRepeat");
    const small = unitRig(doc(), { selection: [A] });
    await small.run(`${C}.makeGridRepeat`, { columns: 2, rows: 1 });
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.makeGridRepeat`, { columns: 3, rows: 2 });
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "insertPath")).toBeGreaterThan(
      count(small.leaves(), "insertPath"),
    );
    expect(part(r, "repeat")).toContain('"grid"');
    await refuses([], `${C}.makeGridRepeat`);
  });

  it("Mirror repeat inserts the mirrored copy in one batch; nothing selected sends nothing", async () => {
    covers("command:media.paged.draw.command.makeMirrorRepeat");
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.makeMirrorRepeat`);
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "insertPath")).toBe(1);
    expect(part(r, "repeat")).toContain('"mirror"');
    await refuses([], `${C}.makeMirrorRepeat`);
  });

  it("Update repeat rebuilds it in one batch, more copies for a higher count; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.updateRepeat");
    const { r, copies } = await repeated();
    await r.run(`${C}.updateRepeat`, { count: 8 });
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "insertPath")).toBeGreaterThan(copies);
    expect(count(r.leaves(), "deleteFrame")).toBe(copies);
    await refuses([POLY], `${C}.updateRepeat`, { count: 6 });
  });

  it("Select repeat instances selects the copies, not the source, and writes nothing; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.selectRepeatInstances");
    const { r, copies } = await repeated();
    await r.run(`${C}.selectRepeatInstances`);
    expect(r.fake.selection().length).toBeGreaterThanOrEqual(copies);
    expect(r.sent()).toEqual([]);
    await refuses([POLY], `${C}.selectRepeatInstances`);
  });

  it("Expand repeat drops the links and keeps the copies, in one batch; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.expandRepeat");
    const { r } = await repeated();
    await r.run(`${C}.expandRepeat`);
    expect(r.steps()).toBe(1);
    expect(new Set(ops(r.leaves()))).toEqual(new Set(["setPluginMetadata"]));
    await refuses([POLY], `${C}.expandRepeat`);
  });

  it("Release repeat deletes every copy and keeps the source, in one batch; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.releaseRepeat");
    const { r, copies } = await repeated();
    await r.run(`${C}.releaseRepeat`);
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "deleteFrame")).toBe(copies);
    expect(r.elements().map((e) => String(e.id))).toContain("ua");
    await refuses([POLY], `${C}.releaseRepeat`);
  });
});

describe("paged.draw commands, no engine — patterns", () => {
  async function patterned() {
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.makePatternFromSelection`, { columns: 2, rows: 2 });
    r.fake.setSelection([A]);
    r.reset();
    return r;
  }

  it("Make pattern tiles the selection into a field and groups it in ONE batch; nothing selected sends nothing", async () => {
    covers("command:media.paged.draw.command.makePatternFromSelection");
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.makePatternFromSelection`, { columns: 2, rows: 2 });
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "insertPath")).toBe(3);
    expect(ops(r.leaves()).at(-1)).toBe("createGroup");
    expect(part(r, "pattern")).toContain("pat-1");
    await refuses([], `${C}.makePatternFromSelection`);
  });

  it("Edit pattern rebuilds the field with the new grid in one batch; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.editPatternField");
    const r = await patterned();
    await r.run(`${C}.editPatternField`, { columns: 3, rows: 1 });
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "deleteFrame")).toBe(3);
    await refuses([POLY], `${C}.editPatternField`);
  });

  it("Select pattern tiles selects the tiles and writes nothing; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.selectPatternTiles");
    const r = await patterned();
    await r.run(`${C}.selectPatternTiles`);
    expect(r.fake.selection().length).toBeGreaterThan(0);
    expect(ids(r.fake.selection())).not.toContain("ua");
    expect(r.sent()).toEqual([]);
    await refuses([POLY], `${C}.selectPatternTiles`);
  });

  it("Delete pattern tiles removes the tiles and keeps the source, in one batch; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.deletePatternTiles");
    const r = await patterned();
    await r.run(`${C}.deletePatternTiles`);
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "deleteFrame")).toBe(3);
    await refuses([POLY], `${C}.deletePatternTiles`);
  });

  it("Release pattern field unlinks the tiles and keeps them, in one batch; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.releasePatternField");
    const r = await patterned();
    await r.run(`${C}.releasePatternField`);
    expect(r.steps()).toBe(1);
    expect(new Set(ops(r.leaves()))).toEqual(new Set(["setPluginMetadata"]));
    await refuses([POLY], `${C}.releasePatternField`);
  });
});

describe("paged.draw commands, no engine — objects on a path", () => {
  async function onPath() {
    const r = unitRig(doc(), { selection: [A, POLY] });
    await r.run(`${C}.makeObjectsOnPath`, { alignToPath: false });
    r.fake.setSelection([POLY]);
    r.reset();
    return r;
  }

  it("Objects on path moves the object onto the open path and links both, in ONE batch; nothing selected sends nothing", async () => {
    covers("command:media.paged.draw.command.makeObjectsOnPath");
    const r = unitRig(doc(), { selection: [A, POLY] });
    await r.run(`${C}.makeObjectsOnPath`, { alignToPath: false });
    expect(r.steps()).toBe(1);
    expect(ops(r.leaves())).toEqual([
      "setElementProperty",
      "setPluginMetadata",
      "setPluginMetadata",
    ]);
    expect(part(r, "objects-on-path")).toContain("op-1");
    await refuses([], `${C}.makeObjectsOnPath`);
  });

  it("Update objects on path re-places them with the new offset; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.updateObjectsOnPath");
    const r = await onPath();
    await r.run(`${C}.updateObjectsOnPath`, { startOffsetPt: 30 });
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "setElementProperty")).toBe(1);
    await refuses([B], `${C}.updateObjectsOnPath`);
  });

  it("Select objects on path selects the objects and writes nothing; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.selectObjectsOnPath");
    const r = await onPath();
    await r.run(`${C}.selectObjectsOnPath`);
    expect(ids(r.fake.selection())).toEqual(["ua"]);
    expect(r.sent()).toEqual([]);
    await refuses([B], `${C}.selectObjectsOnPath`);
  });

  it("Expand objects on path drops the links and keeps the objects where they are; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.expandObjectsOnPath");
    const r = await onPath();
    await r.run(`${C}.expandObjectsOnPath`);
    expect(r.steps()).toBe(1);
    expect(new Set(ops(r.leaves()))).toEqual(new Set(["setPluginMetadata"]));
    await refuses([B], `${C}.expandObjectsOnPath`);
  });

  it("Release objects on path puts the object back and drops the links; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.releaseObjectsOnPath");
    const r = await onPath();
    await r.run(`${C}.releaseObjectsOnPath`);
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "setElementProperty")).toBe(1);
    await refuses([B], `${C}.releaseObjectsOnPath`);
  });
});

describe("paged.draw commands, no engine — live paint", () => {
  const square = (x0: number, y0: number, x1: number, y1: number) =>
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ].map((p) => ({ anchor: p, left: p, right: p }));
  /** The engine's planar regions of the overlapping pair: A alone, B
   *  alone, and the overlap. */
  const regions = (m: { kind: string }) =>
    m.kind === "requestPlanarRegions"
      ? {
          kind: "planarRegions",
          payload: {
            result: {
              found: true,
              inputCount: 2,
              complete: true,
              faces: [
                {
                  id: "0#0",
                  signature: [0],
                  anchors: square(100, 100, 300, 200),
                  subpathStarts: [0],
                  area: 20000,
                  inside: [150, 150],
                },
                {
                  id: "1#0",
                  signature: [1],
                  anchors: square(300, 200, 400, 400),
                  subpathStarts: [0],
                  area: 20000,
                  inside: [350, 350],
                },
                {
                  id: "0-1#0",
                  signature: [0, 1],
                  anchors: square(200, 200, 300, 300),
                  subpathStarts: [0],
                  area: 10000,
                  inside: [250, 250],
                },
              ],
            },
          },
        }
      : undefined;
  const OVERLAP = "0-1#0";

  async function painted(fill = true) {
    const r = unitRig(doc(), { selection: [A, B], reply: regions });
    await r.run(`${C}.makeLivePaintGroup`);
    if (fill) await r.run(`${C}.fillLivePaintFace`, { face: OVERLAP });
    r.reset();
    return r;
  }

  it("Make live paint group records the pair's regions; one path sends nothing", async () => {
    covers("command:media.paged.draw.command.makeLivePaintGroup");
    const r = unitRig(doc(), { selection: [A, B], reply: regions });
    await r.run(`${C}.makeLivePaintGroup`);
    expect(r.steps()).toBe(1);
    expect(r.metaOf(A)?.data).toHaveProperty("livePaintMember");
    expect(part(r, "live-paint")).toContain("lp-1");
    const one = unitRig(doc(), { selection: [A], reply: regions });
    await one.run(`${C}.makeLivePaintGroup`);
    expect(one.sent()).toEqual([]);
  });

  it("Fill face inserts the overlap's artwork and records it, in one batch; with no group it sends nothing", async () => {
    covers("command:media.paged.draw.command.fillLivePaintFace");
    const r = await painted(false);
    await r.run(`${C}.fillLivePaintFace`, { face: OVERLAP });
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "insertPath")).toBe(1);
    await refuses([POLY], `${C}.fillLivePaintFace`, { face: OVERLAP });
  });

  it("Regenerate re-cuts the painted faces in one batch; with no group it sends nothing", async () => {
    covers("command:media.paged.draw.command.regenerateLivePaint");
    const r = await painted();
    await r.run(`${C}.regenerateLivePaint`, { groupId: "lp-1" });
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "insertPath")).toBe(1);
    await refuses([POLY], `${C}.regenerateLivePaint`, { groupId: "lp-1" });
  });

  it("Select faces selects the painted faces and writes nothing; with no group it sends nothing", async () => {
    covers("command:media.paged.draw.command.selectLivePaintFaces");
    const r = await painted();
    await r.run(`${C}.selectLivePaintFaces`, { groupId: "lp-1" });
    expect(r.fake.selection()).toHaveLength(1);
    expect(r.sent()).toEqual([]);
    await refuses([POLY], `${C}.selectLivePaintFaces`, { groupId: "lp-1" });
  });

  it("Delete face removes the painted face in one batch; with no group it sends nothing", async () => {
    covers("command:media.paged.draw.command.deleteLivePaintFace");
    const r = await painted();
    await r.run(`${C}.deleteLivePaintFace`, { groupId: "lp-1", face: OVERLAP });
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "deleteFrame")).toBe(1);
    await refuses([POLY], `${C}.deleteLivePaintFace`, {
      groupId: "lp-1",
      face: OVERLAP,
    });
  });

  it("Release live paint drops the group's records and keeps the paths, in one batch; with no group it sends nothing", async () => {
    covers("command:media.paged.draw.command.releaseLivePaint");
    const r = await painted();
    await r.run(`${C}.releaseLivePaint`, { groupId: "lp-1" });
    expect(r.steps()).toBe(1);
    expect(r.metaOf(A)?.data ?? {}).not.toHaveProperty("livePaintMember");
    await refuses([POLY], `${C}.releaseLivePaint`, { groupId: "lp-1" });
  });
});

describe("paged.draw commands, no engine — symbols", () => {
  async function defined() {
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.defineSymbol`, { name: "Tile" });
    r.reset();
    return r;
  }
  async function placed() {
    const r = await defined();
    await r.run(`${C}.placeSymbolInstance`, {
      symbolId: "sym-1",
      x: 500,
      y: 500,
    });
    const instance = r.fake.selection()[0]!;
    r.reset();
    return { r, instance };
  }

  it("Define symbol writes the selection into the library and nothing into the document; nothing selected sends nothing", async () => {
    covers("command:media.paged.draw.command.defineSymbol");
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.defineSymbol`, { name: "Tile" });
    expect(r.sent()).toEqual([]);
    expect(part(r, "symbols")).toContain("Tile");
    const none = unitRig(doc(), { selection: [] });
    await none.run(`${C}.defineSymbol`, { name: "Tile" });
    expect(part(none, "symbols")).not.toContain("Tile");
  });

  it("Place instance inserts a linked copy in one batch and selects it; an unknown symbol sends nothing", async () => {
    covers("command:media.paged.draw.command.placeSymbolInstance");
    const r = await defined();
    await r.run(`${C}.placeSymbolInstance`, {
      symbolId: "sym-1",
      x: 500,
      y: 500,
    });
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "insertPath")).toBe(1);
    const instance = r.fake.selection()[0]!;
    expect(r.metaOf(instance)?.data).toHaveProperty("symbolInstance");
    await refuses([], `${C}.placeSymbolInstance`, {
      symbolId: "sym-404",
      x: 0,
      y: 0,
    });
  });

  it("Redefine symbol rebuilds the placed instance from the selection in one batch; an unknown symbol sends nothing", async () => {
    covers("command:media.paged.draw.command.redefineSymbol");
    const { r } = await placed();
    r.fake.setSelection([B]);
    await r.run(`${C}.redefineSymbol`, { symbolId: "sym-1" });
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "insertPath")).toBe(1);
    expect(count(r.leaves(), "deleteFrame")).toBe(1);
    await refuses([B], `${C}.redefineSymbol`, { symbolId: "sym-404" });
  });

  it("Break link unlinks the instance and keeps its art, in one write; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.breakSymbolLink");
    const { r, instance } = await placed();
    r.fake.setSelection([instance]);
    await r.run(`${C}.breakSymbolLink`);
    expect(r.steps()).toBe(1);
    expect(ops(r.leaves())).toEqual(["setPluginMetadata"]);
    expect(r.metaOf(instance)?.data ?? {}).not.toHaveProperty("symbolInstance");
    await refuses([B], `${C}.breakSymbolLink`);
  });

  it("Reset transform re-emits the instance from its definition in one batch; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.resetSymbolTransform");
    const { r, instance } = await placed();
    r.fake.setSelection([instance]);
    await r.run(`${C}.resetSymbolTransform`);
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "insertPath")).toBe(1);
    await refuses([B], `${C}.resetSymbolTransform`);
  });

  it("Rename symbol renames it in the library and writes nothing; an unknown symbol leaves the library alone", async () => {
    covers("command:media.paged.draw.command.renameSymbol");
    const r = await defined();
    await r.run(`${C}.renameSymbol`, { symbolId: "sym-1", name: "Badge" });
    expect(r.sent()).toEqual([]);
    expect(part(r, "symbols")).toContain("Badge");
    const before = part(r, "symbols");
    await r.run(`${C}.renameSymbol`, { symbolId: "sym-404", name: "x" });
    expect(part(r, "symbols")).toBe(before);
  });

  it("Delete symbol unlinks its instances in one write and drops it from the library; an unknown symbol sends nothing", async () => {
    covers("command:media.paged.draw.command.deleteSymbol");
    const { r } = await placed();
    await r.run(`${C}.deleteSymbol`, { symbolId: "sym-1" });
    expect(r.steps()).toBe(1);
    expect(ops(r.leaves())).toEqual(["setPluginMetadata"]);
    expect(part(r, "symbols")).not.toContain("Tile");
    await refuses([], `${C}.deleteSymbol`, { symbolId: "sym-404" });
  });
});

describe("paged.draw commands, no engine — graphic styles", () => {
  async function styled() {
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.saveGraphicStyle`, { name: "Heavy" });
    r.reset();
    return r;
  }

  it("Save style records the selection's appearance in the library and links the source, in one write; nothing selected sends nothing", async () => {
    covers("command:media.paged.draw.command.saveGraphicStyle");
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.saveGraphicStyle`, { name: "Heavy" });
    expect(r.steps()).toBe(1);
    expect(part(r, "graphic-styles")).toContain("Heavy");
    expect(r.metaOf(A)?.data).toHaveProperty("graphicStyle");
    await refuses([], `${C}.saveGraphicStyle`, { name: "Heavy" });
  });

  it("Apply style paints and links the selection in one write; an unknown style sends nothing", async () => {
    covers("command:media.paged.draw.command.applyGraphicStyle");
    const r = await styled();
    r.fake.setSelection([POLY]);
    await r.run(`${C}.applyGraphicStyle`, { styleId: "gs-1" });
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "setElementProperty")).toBe(3);
    expect(r.metaOf(POLY)?.data).toHaveProperty("graphicStyle");
    await refuses([POLY], `${C}.applyGraphicStyle`, { styleId: "gs-404" });
  });

  it("Redefine style updates the library and repaints each linked element (DRW-3: one write each); an unknown style sends nothing", async () => {
    covers("command:media.paged.draw.command.redefineGraphicStyle");
    const r = await styled();
    r.fake.setSelection([POLY]);
    await r.run(`${C}.applyGraphicStyle`, { styleId: "gs-1" });
    r.fake.setSelection([LINE]);
    r.reset();
    await r.run(`${C}.redefineGraphicStyle`, { styleId: "gs-1" });
    // Two linked elements (the source and the polygon): two writes.
    expect(r.steps()).toBe(2);
    expect(count(r.leaves(), "setPluginMetadata")).toBe(2);
    await refuses([LINE], `${C}.redefineGraphicStyle`, { styleId: "gs-404" });
  });

  it("Break style link drops the link and keeps the paint, in one write; an unlinked path sends nothing", async () => {
    covers("command:media.paged.draw.command.breakGraphicStyleLink");
    const r = await styled();
    r.fake.setSelection([A]);
    await r.run(`${C}.breakGraphicStyleLink`);
    expect(r.steps()).toBe(1);
    expect(ops(r.leaves())).toEqual(["setPluginMetadata"]);
    expect(r.metaOf(A)?.data ?? {}).not.toHaveProperty("graphicStyle");
    await refuses([POLY], `${C}.breakGraphicStyleLink`);
  });

  it("Rename style renames it in the library and writes nothing; an unknown style leaves it alone", async () => {
    covers("command:media.paged.draw.command.renameGraphicStyle");
    const r = await styled();
    await r.run(`${C}.renameGraphicStyle`, {
      styleId: "gs-1",
      name: "Heavy rule",
    });
    expect(r.sent()).toEqual([]);
    expect(part(r, "graphic-styles")).toContain("Heavy rule");
    const before = part(r, "graphic-styles");
    await r.run(`${C}.renameGraphicStyle`, { styleId: "gs-404", name: "x" });
    expect(part(r, "graphic-styles")).toBe(before);
  });

  it("Delete style breaks its link and drops it from the library; an unknown style sends nothing", async () => {
    covers("command:media.paged.draw.command.deleteGraphicStyle");
    const r = await styled();
    await r.run(`${C}.deleteGraphicStyle`, { styleId: "gs-1" });
    expect(r.steps()).toBe(1);
    expect(ops(r.leaves())).toEqual(["setPluginMetadata"]);
    expect(part(r, "graphic-styles")).not.toContain("Heavy");
    await refuses([], `${C}.deleteGraphicStyle`, { styleId: "gs-404" });
  });
});

describe("paged.draw commands, no engine — the appearance stack", () => {
  const stackOf = (r: ReturnType<typeof unitRig>) =>
    (
      r.metaOf(A)?.data as {
        appearance?: { fills: unknown[]; strokes: unknown[] };
      }
    )?.appearance;

  it("Add fill stacks a fill seeded from the frame and paints the front-most layer (DRW-4: two writes); nothing selected sends nothing", async () => {
    covers("command:media.paged.draw.command.appearanceAddFill");
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.appearanceAddFill`);
    expect(stackOf(r)?.fills).toEqual([{ color: "Color/Black", tint: 100 }]);
    expect(ops(r.sent())).toEqual(["setPluginMetadata", "batch"]);
    await refuses([], `${C}.appearanceAddFill`);
  });

  it("Add stroke stacks a stroke seeded from the frame (DRW-4: two writes); nothing selected sends nothing", async () => {
    covers("command:media.paged.draw.command.appearanceAddStroke");
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.appearanceAddStroke`);
    expect(stackOf(r)?.strokes).toEqual([{ color: "Color/Black", weight: 1 }]);
    expect(ops(r.sent())).toEqual(["setPluginMetadata", "batch"]);
    await refuses([], `${C}.appearanceAddStroke`);
  });

  it("Clear appearance drops the stack in one write; nothing selected sends nothing", async () => {
    covers("command:media.paged.draw.command.appearanceClear");
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.appearanceAddFill`);
    r.reset();
    await r.run(`${C}.appearanceClear`);
    expect(r.steps()).toBe(1);
    expect(stackOf(r)).toBeUndefined();
    await refuses([], `${C}.appearanceClear`);
  });

  it("Remove layer drops the addressed fill in one write; nothing selected sends nothing", async () => {
    covers("command:media.paged.draw.command.appearanceRemoveLayer");
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.appearanceAddFill`);
    await r.run(`${C}.appearanceAddStroke`);
    r.reset();
    await r.run(`${C}.appearanceRemoveLayer`, { kind: "fill", index: 0 });
    expect(stackOf(r)?.fills).toEqual([]);
    expect(stackOf(r)?.strokes).toHaveLength(1);
    await refuses([], `${C}.appearanceRemoveLayer`, { kind: "fill", index: 0 });
  });

  it("Move layer reorders the stack; nothing selected sends nothing", async () => {
    covers("command:media.paged.draw.command.appearanceMoveLayer");
    const r = unitRig(
      [
        {
          ...rectEl("polygon", "ua", [100, 100, 300, 300]),
          meta: {
            v: 1,
            data: {
              appearance: {
                fills: [
                  { color: "Color/Black", tint: 100 },
                  { color: "Color/Black", tint: 40 },
                ],
                strokes: [],
              },
            },
          },
        },
      ],
      { selection: [A] },
    );
    await r.run(`${C}.appearanceMoveLayer`, {
      kind: "fill",
      index: 0,
      delta: 1,
    });
    expect(stackOf(r)?.fills).toEqual([
      { color: "Color/Black", tint: 40 },
      { color: "Color/Black", tint: 100 },
    ]);
    await refuses([], `${C}.appearanceMoveLayer`, {
      kind: "fill",
      index: 0,
      delta: 1,
    });
  });

  it("Bake appearance inserts one path per layer and groups them (DRW-5: two writes); with no stack it sends nothing", async () => {
    covers("command:media.paged.draw.command.bakeAppearance");
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.appearanceAddFill`);
    await r.run(`${C}.appearanceAddStroke`);
    r.fake.setSelection([A]);
    r.reset();
    await r.run(`${C}.bakeAppearance`);
    expect(r.steps()).toBe(2);
    expect(count(r.leaves(), "insertPath")).toBe(2);
    expect(ops(r.leaves()).at(-1)).toBe("createGroup");
    await refuses([A], `${C}.bakeAppearance`);
  });

  it("Release appearance deletes the derived layers and gives the stack back to the frame, in one batch; an unbaked frame sends nothing", async () => {
    covers("command:media.paged.draw.command.releaseAppearance");
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.appearanceAddFill`);
    await r.run(`${C}.appearanceAddStroke`);
    r.fake.setSelection([A]);
    await r.run(`${C}.bakeAppearance`);
    r.fake.setSelection([A]);
    r.reset();
    await r.run(`${C}.releaseAppearance`);
    expect(r.steps()).toBe(1);
    expect(count(r.leaves(), "deleteFrame")).toBe(2);
    expect(count(r.leaves(), "dissolveGroup")).toBe(1);
    await refuses([A], `${C}.releaseAppearance`);
  });
});

describe("paged.draw commands, no engine — Image Trace", () => {
  const IMAGE = { kind: "rectangle", id: "uimg" } as ElementId;
  const PNG = pngBytes(48, 48, ringPixels(48));
  const image: FakeElement = rectEl("rectangle", "uimg", [100, 100, 196, 196]);

  it("traces the selected image's own pixels into paths (DRW-6: two batches); a path sends nothing", async () => {
    covers("command:media.paged.draw.command.imageTrace");
    const uninstall = installPngRealm();
    try {
      const r = unitRig([image], {
        selection: [IMAGE],
        reply: (m) =>
          m.kind === "requestPlacedAssetBytes"
            ? {
                kind: "placedAssetBytes",
                payload: {
                  elementId: "uimg",
                  found: true,
                  uri: "file:ring-48.png",
                  width: 48,
                  height: 48,
                  encoded: Array.from(PNG),
                },
              }
            : undefined,
      });
      // The fake's geometry answers no image: say there is one.
      const geometry = r.fake.editor.client.elementGeometry.bind(
        r.fake.editor.client,
      );
      r.fake.editor.client.elementGeometry = async (ids) =>
        (await geometry(ids)).map((g) => ({ ...g, hasImage: true }));
      await r.run(`${C}.imageTrace`, { mode: "bw" });
      expect(r.steps()).toBe(2);
      // The ring traces to one compound region: one path, then its paint.
      expect(count(r.leaves(), "insertPath")).toBeGreaterThan(0);
      const path = unitRig(doc(), { selection: [POLY] });
      await path.run(`${C}.imageTrace`, { mode: "bw" });
      expect(path.sent()).toEqual([]);
    } finally {
      uninstall();
    }
  }, 30_000);
});
