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

// The WP6.7 commands with no engine (`unit-kit.ts`'s fake): the liquify
// stroke and the puppet warp as data, the Puppet Warp tool switch, and
// the perspective grid's View / Object verbs — what each SENDS (one batch
// where it changes artwork; nothing where it changes only the grid, which
// is a view setting kept in its container part), and that one that does
// nothing says why. The real engine's answer is
// test/headless/distortion-tools.spec.ts. [plugin-draw.distortion-tools]

import { describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import { PERSPECTIVE_PART } from "../../src";
import { rectEl, unitRig, type UnitRig } from "./unit-kit";

const C = "media.paged.draw.command";
const A = { kind: "polygon", id: "ua" } as ElementId;
const doc = () => [rectEl("polygon", "ua", [100, 100, 300, 300])];

const gridOf = (r: UnitRig) =>
  (
    Object.entries(r.parts()).find(([k]) =>
      k.endsWith(PERSPECTIVE_PART),
    )?.[1] as { grids: Record<string, Record<string, unknown>> } | undefined
  )?.grids["page-1"];

const ops = (r: UnitRig) => r.leaves().map((m) => m.op);

describe("paged.draw commands, no engine — the distortion tools [plugin-draw.distortion-tools]", () => {
  it("liquifyStroke: a pucker stroke over the square is one framePath batch", async () => {
    covers("command:media.paged.draw.command.liquifyStroke");
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.liquifyStroke`, {
      kind: "pucker",
      page: "page-1",
      path: [
        [300, 200],
        [300, 210],
      ],
      intensity: 100,
    });
    expect(r.sent()).toHaveLength(1);
    expect(ops(r)).toEqual(["setElementProperty", "setElementProperty"]);
    expect(r.steps()).toBe(1);
  });

  it("liquifyStroke refuses an unknown kind and a stroke that touches nothing", async () => {
    const r = unitRig(doc(), { selection: [A] });
    await expect(
      r.run(`${C}.liquifyStroke`, { kind: "melt", path: [[0, 0]] }),
    ).rejects.toThrow(/kind is one of/);
    await expect(
      r.run(`${C}.liquifyStroke`, {
        kind: "bloat",
        page: "page-1",
        path: [[900, 900]],
      }),
    ).rejects.toThrow(/touches no path/);
    expect(r.sent()).toEqual([]);
  });

  it("puppetWarp: two holding pins and a dragged one bend the square in one batch", async () => {
    covers("command:media.paged.draw.command.puppetWarp");
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.puppetWarp`, {
      holds: [
        [110, 110],
        [110, 290],
      ],
      from: [290, 200],
      to: [330, 150],
      autoPins: 0,
    });
    expect(r.sent()).toHaveLength(1);
    expect(ops(r)).toEqual(["setElementProperty", "setElementProperty"]);
  });

  it("puppetWarp refuses an empty selection", async () => {
    const r = unitRig(doc(), { selection: [] });
    await expect(
      r.run(`${C}.puppetWarp`, { from: [1, 1], to: [2, 2] }),
    ).rejects.toThrow(/select the paths/);
  });

  it("puppetWarpTool: with no tool door on the host it says how to reach the tool, and changes nothing", async () => {
    covers("command:media.paged.draw.command.puppetWarpTool");
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.puppetWarpTool`);
    expect(r.sent()).toEqual([]);
    expect(r.logs.some((l) => l.includes("Free Transform flyout"))).toBe(true);
  });

  it("puppetWarpTool: on a host whose command registry can run, it switches to the tool", async () => {
    const r = unitRig(doc(), { selection: [A] });
    const ran: string[] = [];
    const commands = r.fake.editor.registries.commands as unknown as Record<
      string,
      unknown
    >;
    commands.invoke = async (id: string) => void ran.push(id);
    await r.run(`${C}.puppetWarpTool`);
    expect(ran).toEqual([
      "paged.tool.activate.media.paged.draw.tool.puppetWarp",
    ]);
  });

  it("perspectiveShowGrid / HideGrid: the page's grid becomes visible / hidden — no mutation", async () => {
    covers("command:media.paged.draw.command.perspectiveShowGrid");
    covers("command:media.paged.draw.command.perspectiveHideGrid");
    const r = unitRig(doc(), {});
    await r.run(`${C}.perspectiveShowGrid`, { page: "page-1" });
    expect(gridOf(r)!.visible).toBe(true);
    await r.run(`${C}.perspectiveHideGrid`, { page: "page-1" });
    expect(gridOf(r)!.visible).toBe(false);
    expect(r.sent()).toEqual([]);
  });

  it("perspectiveLockGrid / UnlockGrid", async () => {
    covers("command:media.paged.draw.command.perspectiveLockGrid");
    covers("command:media.paged.draw.command.perspectiveUnlockGrid");
    const r = unitRig(doc(), {});
    await r.run(`${C}.perspectiveLockGrid`, { page: "page-1" });
    expect(gridOf(r)!.locked).toBe(true);
    await r.run(`${C}.perspectiveUnlockGrid`, { page: "page-1" });
    expect(gridOf(r)!.locked).toBe(false);
  });

  it("the three presets set the grid's kind", async () => {
    covers("command:media.paged.draw.command.perspectiveOnePoint");
    covers("command:media.paged.draw.command.perspectiveTwoPoint");
    covers("command:media.paged.draw.command.perspectiveThreePoint");
    const r = unitRig(doc(), {});
    await r.run(`${C}.perspectiveOnePoint`, { page: "page-1" });
    expect(gridOf(r)!.kind).toBe(1);
    await r.run(`${C}.perspectiveThreePoint`, { page: "page-1" });
    expect(gridOf(r)!.kind).toBe(3);
    await r.run(`${C}.perspectiveTwoPoint`, { page: "page-1" });
    expect(gridOf(r)!.kind).toBe(2);
    expect(r.sent()).toEqual([]);
  });

  it("perspectiveSetPlane picks the active plane and refuses a non-plane", async () => {
    covers("command:media.paged.draw.command.perspectiveSetPlane");
    const r = unitRig(doc(), {});
    await r.run(`${C}.perspectiveSetPlane`, { page: "page-1", plane: "floor" });
    expect(gridOf(r)!.activePlane).toBe("floor");
    await expect(
      r.run(`${C}.perspectiveSetPlane`, { page: "page-1", plane: "ceiling" }),
    ).rejects.toThrow(/plane is/);
  });

  it("attachToPerspective: the selection is projected in place and linked — ONE batch; releaseFromPerspective drops the link in one more", async () => {
    covers("command:media.paged.draw.command.attachToPerspective");
    covers("command:media.paged.draw.command.releaseFromPerspective");
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.perspectiveShowGrid`, { page: "page-1" });
    r.reset();
    await r.run(`${C}.attachToPerspective`, {});
    expect(r.sent()).toHaveLength(1);
    expect(ops(r)).toEqual([
      "setElementProperty",
      "setElementProperty",
      "setPluginMetadata",
    ]);
    expect(
      (r.metaOf(A) as unknown as { data: { perspective: { plane: string } } })
        .data.perspective.plane,
    ).toBe("left");
    r.reset();
    await r.run(`${C}.releaseFromPerspective`, {});
    expect(ops(r)).toEqual(["setPluginMetadata"]);
    expect(r.metaOf(A)).toBeNull();
  });

  it("attachToPerspective refuses when the page has no grid", async () => {
    const r = unitRig(doc(), { selection: [A] });
    await expect(r.run(`${C}.attachToPerspective`, {})).rejects.toThrow(
      /no perspective grid/,
    );
  });

  it("moveOnPerspective re-projects the linked flat geometry, one batch; it refuses unattached artwork", async () => {
    covers("command:media.paged.draw.command.moveOnPerspective");
    const r = unitRig(doc(), { selection: [A] });
    await expect(
      r.run(`${C}.moveOnPerspective`, { from: [200, 200], to: [210, 200] }),
    ).rejects.toThrow(/nothing attached/);
    await r.run(`${C}.perspectiveShowGrid`, { page: "page-1" });
    await r.run(`${C}.attachToPerspective`, {});
    r.reset();
    await r.run(`${C}.moveOnPerspective`, { from: [200, 200], to: [190, 210] });
    expect(r.sent()).toHaveLength(1);
    expect(ops(r)).toEqual([
      "setElementProperty",
      "setElementProperty",
      "setPluginMetadata",
    ]);
  });

  it("drawOnPerspective inserts a painted, linked shape on the active plane — one batch", async () => {
    covers("command:media.paged.draw.command.drawOnPerspective");
    const r = unitRig(doc(), {});
    await r.run(`${C}.perspectiveShowGrid`, { page: "page-1" });
    r.reset();
    await r.run(`${C}.drawOnPerspective`, {
      page: "page-1",
      shape: "rectangle",
      from: [280, 540],
      to: [200, 480],
    });
    expect(r.sent()).toHaveLength(1);
    expect(ops(r)[0]).toBe("insertPath");
    expect(ops(r)).toContain("bindCreated");
    expect(ops(r).at(-1)).toBe("setPluginMetadata");
    expect(r.elements()).toHaveLength(2);
  });
});
