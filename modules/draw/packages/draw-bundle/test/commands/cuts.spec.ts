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

// The tool-only cuts as commands (plan G4), with no engine: what each
// sends, and that a cut which does nothing throws its reason rather than
// passing for done. The real arrangement is the headless spec's.

import { describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import { openEl, rectEl, unitRig } from "./unit-kit";

const C = "media.paged.draw.command";
const POLY = { kind: "polygon", id: "upoly" } as ElementId;
const RECT = { kind: "rectangle", id: "urect" } as ElementId;

const doc = () => [
  rectEl("rectangle", "urect", [100, 100, 300, 300]),
  openEl("upoly", [
    [100, 400],
    [250, 600],
    [400, 400],
  ]),
];

describe("paged.draw commands, no engine — the cuts", () => {
  it("scissorsAt: splits the segment under the point and opens the path there, one batch", async () => {
    covers("command:media.paged.draw.command.scissorsAt");
    const r = unitRig(doc(), { selection: [POLY] });
    await r.run(`${C}.scissorsAt`, { point: [175, 500], tolerance: 1 });
    expect(r.sent()).toHaveLength(1);
    expect(r.steps()).toBe(1);
    const ops = r.leaves().map((m) => m.op);
    expect(ops).toContain("pathPointInsert");
    expect(ops.at(-1)).toBe("pathOpenAt");
    await expect(
      r.run(`${C}.scissorsAt`, { point: [900, 900], tolerance: 1 }),
    ).rejects.toThrow(/^failed: the point is on no cuttable segment/);
  });

  it("knife: refuses a cut of fewer than two points, and one with no page", async () => {
    covers("command:media.paged.draw.command.knife");
    const r = unitRig(doc(), { selection: [RECT] });
    await expect(r.run(`${C}.knife`, { cut: [[1, 1]] })).rejects.toThrow(
      "failed: a cut is at least two points",
    );
    const none = unitRig(doc(), { selection: [] });
    await expect(
      none.run(`${C}.knife`, {
        page: "",
        cut: [
          [0, 0],
          [9, 9],
        ],
      }),
    ).rejects.toThrow("failed: name the page, or select what to cut");
    expect(r.sent()).toEqual([]);
  });

  it("shapeBuild: refuses with nothing selected, or a one-point gesture", async () => {
    covers("command:media.paged.draw.command.shapeBuild");
    const empty = unitRig(doc(), { selection: [] });
    await expect(
      empty.run(`${C}.shapeBuild`, { path: [], mode: "keep" }),
    ).rejects.toThrow("failed: select the shapes to build from");
    const r = unitRig(doc(), { selection: [RECT] });
    await expect(
      r.run(`${C}.shapeBuild`, { path: [[150, 150]], mode: "keep" }),
    ).rejects.toThrow("failed: a gesture is at least two points");
    expect(r.sent()).toEqual([]);
  });
});
