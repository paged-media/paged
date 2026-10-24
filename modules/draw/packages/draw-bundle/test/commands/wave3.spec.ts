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

// The WP6.1 part-2 commands with no engine (`unit-kit.ts`'s fake): the
// Join / Path Eraser / Reshape / Shaper gestures as data and the Star /
// Flare inserts — what each SENDS, that it is ONE batch (one undo step),
// and that one that does nothing throws its reason. The real engine's
// answer is test/headless/wave3-tools.spec.ts.

import { describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import { openEl, rectEl, unitRig } from "./unit-kit";

const C = "media.paged.draw.command";
const A = { kind: "polygon", id: "ua" } as ElementId;
const SQ = { kind: "polygon", id: "usq" } as ElementId;

const doc = () => [
  rectEl("polygon", "usq", [100, 100, 200, 200]),
  openEl("ua", [
    [300, 250],
    [400, 250],
  ]),
  openEl("ub", [
    [420, 250],
    [520, 250],
  ]),
];

describe("paged.draw commands, no engine — WP6.1 part 2 [plugin-draw.tool-wave-3]", () => {
  it("joinScrub: a scrub over the gap extends the first path and welds the second, one batch", async () => {
    covers("command:media.paged.draw.command.joinScrub");
    const r = unitRig(doc(), { selection: [] });
    await r.run(`${C}.joinScrub`, { page: "page-1", path: [[395, 245], [425, 255]], tolerance: 8 });
    expect(r.sent()).toHaveLength(1);
    expect(r.steps()).toBe(1);
    const ops = r.leaves().map((m) => m.op);
    expect(ops[0]).toBe("setElementProperty");
    expect(ops).toContain("joinPaths");
    await expect(
      r.run(`${C}.joinScrub`, { page: "page-1", path: [[900, 900], [901, 900]] }),
    ).rejects.toThrow(/^failed:/);
  });

  it("pathErase: a drag across the open path rewrites it and inserts the far piece, one batch", async () => {
    covers("command:media.paged.draw.command.pathErase");
    const r = unitRig(doc(), { selection: [A] });
    await r.run(`${C}.pathErase`, { page: "page-1", path: [[350, 240], [350, 260]], width: 10 });
    expect(r.sent()).toHaveLength(1);
    expect(r.steps()).toBe(1);
    const ops = r.leaves().map((m) => m.op);
    expect(ops[0]).toBe("insertPath");
    expect(r.elements()).toHaveLength(4);
    await r.undo();
    expect(r.elements()).toHaveLength(3);
    await expect(
      r.run(`${C}.pathErase`, { page: "page-1", path: [[900, 900]] }),
    ).rejects.toThrow("failed: the drag passes over no path");
  });

  it("reshapeAt: the selected path's anchor moves, as one framePath batch", async () => {
    covers("command:media.paged.draw.command.reshapeAt");
    const r = unitRig(doc(), { selection: [SQ] });
    await r.run(`${C}.reshapeAt`, { point: [200, 100], to: [220, 80], radius: 40 });
    expect(r.sent()).toHaveLength(1);
    const ops = r.leaves();
    expect(ops[0]).toMatchObject({ op: "setElementProperty", args: { path: "framePath" } });
    await expect(
      r.run(`${C}.reshapeAt`, { point: [600, 600], to: [610, 600] }),
    ).rejects.toThrow(/^failed: the point is on no anchor/);
  });

  it("shaperStroke: a drawn triangle becomes one closed three-corner path", async () => {
    covers("command:media.paged.draw.command.shaperStroke");
    const r = unitRig([], { selection: [] });
    const tri: [number, number][] = [];
    const corners: [number, number][] = [[200, 100], [280, 230], [120, 230], [200, 100]];
    for (let i = 1; i < corners.length; i++)
      for (let k = 0; k < 20; k++) {
        const [a, b] = [corners[i - 1]!, corners[i]!];
        tri.push([a[0] + ((b[0] - a[0]) * k) / 20, a[1] + ((b[1] - a[1]) * k) / 20]);
      }
    tri.push([201, 102]);
    await r.run(`${C}.shaperStroke`, { page: "page-1", path: tri });
    expect(r.sent()).toHaveLength(1);
    const insert = r.leaves().find((m) => m.op === "insertPath") as { args: { anchors: unknown[]; open: boolean } };
    expect(insert.args.anchors).toHaveLength(3);
    expect(insert.args.open).toBe(false);
    await expect(
      r.run(`${C}.shaperStroke`, { page: "page-1", path: [[0, 0], [1, 1]] }),
    ).rejects.toThrow(/^failed:/);
  });

  it("insertStar: one closed 2·points path at the typed centre", async () => {
    covers("command:media.paged.draw.command.insertStar");
    const r = unitRig([], { selection: [] });
    await r.run(`${C}.insertStar`, { page: "page-1", cx: 100, cy: 100, radius1: 40, radius2: 10, points: 6 });
    expect(r.sent()).toHaveLength(1);
    const insert = r.leaves().find((m) => m.op === "insertPath") as { args: { anchors: { anchor: number[] }[] } };
    expect(insert.args.anchors).toHaveLength(12);
    expect(insert.args.anchors[0]!.anchor[1]).toBeCloseTo(60, 9);
  });

  it("insertFlare: every part inserted, named and grouped in ONE batch", async () => {
    covers("command:media.paged.draw.command.insertFlare");
    const r = unitRig([], { selection: [] });
    await r.run(`${C}.insertFlare`, { page: "page-1", rays: 4, rings: 2 });
    expect(r.sent()).toHaveLength(1);
    expect(r.steps()).toBe(1);
    const ops = r.leaves().map((m) => m.op);
    expect(ops.filter((o) => o === "insertPath")).toHaveLength(8);
    expect(ops.at(-1)).toBe("createGroup");
  });
});
