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

// WP6.3 (draw ADR 367) over the fake document of `commands/unit-kit.ts`
// (no engine): what the Envelope distort and Expand appearance commands,
// the graphic-style library commands and the Envelope Mesh tool (through
// the gesture DSL) SEND — one batch where they change the document,
// nothing where they refuse. The real engine's answer is
// test/headless/envelope.spec.ts and graphic-styles-native.spec.ts.
// [plugin-draw.envelope-distort]

import { describe, expect, it } from "bun:test";

import type { ElementId, Mutation } from "@paged-media/plugin-api";
import { covers, gestures, type GestureDsl } from "@paged-media/test-kit";
import { flatNet } from "@paged-media/draw-geometry";

import { exportGraphicStyles } from "../src";
import { rectEl, unitRig, type UnitRig } from "./commands/unit-kit";

const C = "media.paged.draw.command";
const A = { kind: "polygon", id: "ua" } as ElementId;
const B = { kind: "polygon", id: "ub" } as ElementId;
const stackOf = (entries: unknown[]) => ({
  frameEffectStack: { type: "effectStack", value: { entries } },
});
const MESH = {
  kind: "envelope",
  enabled: true,
  rows: 2,
  columns: 2,
  mesh: flatNet(2, 2),
};

const ops = (r: UnitRig) => r.leaves().map((m) => m.op);
const paths = (ms: Mutation[]) =>
  ms
    .filter((m) => m.op === "setElementProperty")
    .map((m) => (m as { args: { path: string } }).args.path);
const entriesWritten = (r: UnitRig) =>
  (
    r.leaves().find((m) => m.op === "setElementProperty") as unknown as {
      args: { value: { value: { entries: { kind: string }[] } } };
    }
  ).args.value.value.entries;

describe("Envelope distort and Expand appearance, no engine [plugin-draw.envelope-distort]", () => {
  it("Make with warp appends a warp entry in one batch", async () => {
    covers("command:media.paged.draw.command.envelopeMakeWithWarp");
    const r = unitRig(
      [rectEl("polygon", "ua", [100, 100, 300, 300], stackOf([]))],
      {
        selection: [A],
      },
    );
    await r.run(`${C}.envelopeMakeWithWarp`, { style: "flag", bendPct: 30 });
    expect(r.sent()).toHaveLength(1);
    expect(paths(r.leaves())).toEqual(["frameEffectStack"]);
    expect(entriesWritten(r)).toMatchObject([
      { kind: "warp", style: "flag", bendPct: 30 },
    ]);
  });

  it("Make with mesh appends a flat mesh; a group or nothing takes none", async () => {
    covers("command:media.paged.draw.command.envelopeMakeWithMesh");
    const r = unitRig(
      [rectEl("polygon", "ua", [100, 100, 300, 300], stackOf([]))],
      {
        selection: [A],
      },
    );
    await r.run(`${C}.envelopeMakeWithMesh`, { rows: 3, columns: 2 });
    const [e] = entriesWritten(r) as unknown as {
      rows: number;
      columns: number;
      mesh: unknown[];
    }[];
    expect([e!.rows, e!.columns, e!.mesh.length]).toEqual([3, 2, 10 * 7]);
    const none = unitRig([rectEl("polygon", "ua", [100, 100, 300, 300])], {
      selection: [],
    });
    await expect(
      none.run(`${C}.envelopeMakeWithMesh`, { rows: 2, columns: 2 }),
    ).rejects.toThrow(/select a rectangle/);
    expect(none.sent()).toEqual([]);
  });

  it("Make with top object bends the back item into the front one and deletes it, in one batch", async () => {
    covers("command:media.paged.draw.command.envelopeMakeWithTopObject");
    const r = unitRig(
      [
        rectEl("polygon", "ua", [100, 100, 300, 300], stackOf([])),
        rectEl("polygon", "ub", [120, 80, 280, 320], stackOf([])),
      ],
      { selection: [A, B] },
    );
    await r.run(`${C}.envelopeMakeWithTopObject`, {});
    expect(r.sent()).toHaveLength(1);
    expect(ops(r)).toEqual(["setElementProperty", "deleteFrame"]);
    expect(entriesWritten(r)).toMatchObject([
      { kind: "envelope", rows: 1, columns: 1 },
    ]);
  });

  it("Expand and Expand appearance send expandAppearance; with nothing live they send nothing", async () => {
    covers("command:media.paged.draw.command.envelopeExpand");
    covers("command:media.paged.draw.command.expandAppearance");
    const r = unitRig(
      [rectEl("polygon", "ua", [100, 100, 300, 300], stackOf([MESH]))],
      {
        selection: [A],
      },
    );
    await r.run(`${C}.envelopeExpand`, {});
    expect(ops(r)).toEqual(["expandAppearance"]);
    r.reset();
    await r.run(`${C}.expandAppearance`, {});
    expect(ops(r)).toEqual(["expandAppearance"]);
    const flat = unitRig(
      [rectEl("polygon", "ua", [100, 100, 300, 300], stackOf([]))],
      {
        selection: [A],
      },
    );
    await expect(flat.run(`${C}.envelopeExpand`, {})).rejects.toThrow(
      /no envelope/,
    );
    // From the menu (no payload) the refusal is logged, the click settles.
    await flat.run(`${C}.expandAppearance`);
    expect(flat.sent()).toEqual([]);
  });

  it("Edit contents and the tool row switch tools through the editor's door, writing nothing", async () => {
    covers("command:media.paged.draw.command.envelopeEditContents");
    covers("command:media.paged.draw.command.envelopeMeshTool");
    const r = unitRig(
      [rectEl("polygon", "ua", [100, 100, 300, 300], stackOf([MESH]))],
      {
        selection: [A],
      },
    );
    const ran: string[] = [];
    const commands = r.fake.editor.registries.commands as unknown as Record<
      string,
      unknown
    >;
    commands.invoke = async (id: string) => void ran.push(id);
    await r.run(`${C}.envelopeEditContents`, {});
    await r.run(`${C}.envelopeMeshTool`);
    expect(ran).toEqual([
      "paged.tool.activate.paged.tool.directSelect",
      "paged.tool.activate.media.paged.draw.tool.envelopeMesh",
    ]);
    expect(r.sent()).toEqual([]);
  });
});

describe("the graphic-style library as a file, no engine [plugin-draw.graphic-styles]", () => {
  it("export answers the library file; import adds its styles under new ids; merge makes a new one", async () => {
    covers("command:media.paged.draw.command.exportGraphicStyles");
    covers("command:media.paged.draw.command.importGraphicStyles");
    covers("command:media.paged.draw.command.mergeGraphicStyles");
    const r = unitRig([rectEl("polygon", "ua", [100, 100, 300, 300])], {
      selection: [A],
    });
    await r.run(`${C}.saveGraphicStyle`, { name: "One" });
    await r.run(`${C}.saveGraphicStyle`, { name: "Two" });
    const text = await exportGraphicStyles(r.host, [], false);
    expect(JSON.parse(text)).toMatchObject({ paged: "graphicStyles" });
    await r.run(`${C}.exportGraphicStyles`, { save: false });
    await r.run(`${C}.importGraphicStyles`, { json: text });
    await r.run(`${C}.mergeGraphicStyles`, { styles: ["gs-1", "gs-2"] });
    const lib = Object.entries(r.parts()).find(([k]) =>
      k.endsWith("graphic-styles.json"),
    )![1] as { styles: { id: string; name: string }[] };
    expect(lib.styles.map((s) => s.name)).toEqual([
      "One",
      "Two",
      "One 2",
      "Two 2",
      "One + Two",
    ]);
    expect(lib.styles.at(-1)!.id).toBe("gs-5");
  });
});

describe("the Envelope Mesh tool through the gesture DSL [plugin-draw.envelope-distort]", () => {
  const rig = (): { r: UnitRig; g: GestureDsl } => {
    const r = unitRig(
      [rectEl("polygon", "ua", [100, 100, 300, 300], stackOf([MESH]))],
      {
        selection: [A],
      },
    );
    return { r, g: gestures(r.fake) };
  };

  it("dragging the centre node writes the mesh once; Escape mid-drag writes nothing", async () => {
    covers("tool:media.paged.draw.tool.envelopeMesh");
    const { r, g } = rig();
    await g.tool("media.paged.draw.tool.envelopeMesh").settle();
    r.reset();
    let q = g.down([200, 200]).settle();
    for (const p of [
      [210, 190],
      [220, 180],
    ] as [number, number][])
      q = q.move(p).settle();
    await q.up([230, 170]).settle();
    expect(r.sent()).toHaveLength(1);
    expect(paths(r.leaves())).toEqual(["frameEffectStack"]);
    const [e] = entriesWritten(r) as unknown as { mesh: [number, number][] }[];
    // Node (1, 1) of the 2 × 2 net is net point 3 · 7 + 3.
    expect(e!.mesh[24]).toEqual([0.65, 0.35]);

    const quiet = rig();
    await quiet.g.tool("media.paged.draw.tool.envelopeMesh").settle();
    quiet.r.reset();
    await quiet.g
      .down([200, 200])
      .settle()
      .move([240, 160])
      .settle()
      .key("Escape")
      .settle()
      .up([240, 160])
      .settle();
    expect(quiet.r.sent()).toEqual([]);
  });
});
