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

// THE DISTORTION TOOLS through the gesture DSL, over the fake document
// of `commands/unit-kit.ts` (no engine): what each tool's gesture SENDS —
// ONE batch, ONE undo step that one undo takes back — and that Escape
// mid-gesture sends nothing. The engine-backed versions are
// `test/headless/distortion-tools.spec.ts`.
// [plugin-draw.distortion-tools]

import { describe, expect, it } from "bun:test";

import type { ElementId, Mutation } from "@paged-media/plugin-api";
import { covers, gestures, type GestureDsl } from "@paged-media/test-kit";

import { PERSPECTIVE_PART } from "../src";
import { rectEl, unitRig, type UnitRig } from "./commands/unit-kit";

const T = "media.paged.draw.tool";
const A = { kind: "polygon", id: "ua" } as ElementId;

const doc = () => [rectEl("polygon", "ua", [100, 100, 300, 300])];

/** The perspective-grid part as the fake holds it (the parts door
 *  prefixes the bundle's namespace). */
const gridPart = (r: UnitRig) =>
  Object.entries(r.parts()).find(([k]) => k.endsWith(PERSPECTIVE_PART))?.[1];

function rig(selection: ElementId[]): { r: UnitRig; g: GestureDsl } {
  const r = unitRig(doc(), { selection });
  return { r, g: gestures(r.fake) };
}

async function arm(r: UnitRig, g: GestureDsl, tool: string): Promise<void> {
  await g.tool(tool).settle();
  r.reset();
}

const paths = (ms: Mutation[]) =>
  ms
    .filter((m) => m.op === "setElementProperty")
    .map((m) => (m as { args: { path: string } }).args.path);

/** A drag sampled slowly so every queued sample resolves. */
function slowDrag(
  g: GestureDsl,
  from: [number, number],
  to: [number, number],
  n = 4,
): GestureDsl {
  let q = g.down(from).settle();
  for (let i = 1; i <= n; i++)
    q = q
      .move([
        from[0] + ((to[0] - from[0]) * i) / n,
        from[1] + ((to[1] - from[1]) * i) / n,
      ])
      .settle();
  return q.up(to).settle();
}

async function oneUndoStep(r: UnitRig, before: string): Promise<void> {
  expect(r.steps(), "one gesture, one undo step").toBe(1);
  await r.undo();
  expect(r.picture(), "one undo restores the document").toBe(before);
}

async function escapeSendsNothing(
  tool: string,
  selection: ElementId[],
  from: [number, number],
  to: [number, number],
) {
  const { r, g } = rig(selection);
  await arm(r, g, tool);
  await g
    .down(from)
    .settle()
    .move(to)
    .settle()
    .key("Escape")
    .settle()
    .up(to)
    .settle();
  expect(r.sent(), `${tool}: Escape mid-gesture committed`).toEqual([]);
}

describe("the Liquify tools through the gesture DSL [plugin-draw.distortion-tools]", () => {
  const liquify = async (
    tool: string,
    from: [number, number],
    to: [number, number],
  ) => {
    const { r, g } = rig([A]);
    await arm(r, g, `${T}.${tool}`);
    const before = r.picture();
    await slowDrag(g, from, to);
    await g.settle();
    expect(r.sent()).toHaveLength(1);
    expect(r.sent()[0]!.op).toBe("batch");
    expect(paths(r.leaves())).toEqual(["framePath", "frameBounds"]);
    await oneUndoStep(r, before);
    await escapeSendsNothing(`${T}.${tool}`, [A], from, to);
  };

  it("Warp: a drag over the square's edge bends it in ONE framePath batch, one undo step", async () => {
    covers("tool:media.paged.draw.tool.warp");
    await liquify("warp", [200, 100], [200, 140]);
  });
  it("Twirl: a press on the square twirls it, one undo step", async () => {
    covers("tool:media.paged.draw.tool.twirl");
    await liquify("twirl", [300, 200], [300, 210]);
  });
  it("Pucker: one batch, one undo step", async () => {
    covers("tool:media.paged.draw.tool.pucker");
    await liquify("pucker", [300, 200], [300, 205]);
  });
  it("Bloat: one batch, one undo step", async () => {
    covers("tool:media.paged.draw.tool.bloat");
    await liquify("bloat", [300, 200], [300, 205]);
  });
  it("Scallop: one batch, one undo step", async () => {
    covers("tool:media.paged.draw.tool.scallop");
    await liquify("scallop", [300, 200], [300, 205]);
  });
  it("Crystallize: one batch, one undo step", async () => {
    covers("tool:media.paged.draw.tool.crystallize");
    await liquify("crystallize", [300, 200], [300, 205]);
  });
  it("Wrinkle: one batch, one undo step", async () => {
    covers("tool:media.paged.draw.tool.wrinkle");
    await liquify("wrinkle", [200, 100], [210, 100]);
  });

  it("a stroke away from every path sends nothing", async () => {
    const { r, g } = rig([]);
    await arm(r, g, `${T}.pucker`);
    await slowDrag(g, [600, 600], [620, 600]);
    expect(r.sent()).toEqual([]);
  });
});

describe("Puppet Warp through the gesture DSL [plugin-draw.distortion-tools]", () => {
  it("dragging on the selection's mesh pins and bends it: ONE batch, one undo step; Escape sends nothing", async () => {
    covers("tool:media.paged.draw.tool.puppetWarp");
    const { r, g } = rig([A]);
    await arm(r, g, `${T}.puppetWarp`);
    const before = r.picture();
    await slowDrag(g, [290, 110], [330, 60]);
    await g.settle();
    expect(r.sent()).toHaveLength(1);
    expect(paths(r.leaves())).toEqual(["framePath", "frameBounds"]);
    await oneUndoStep(r, before);
    await escapeSendsNothing(`${T}.puppetWarp`, [A], [290, 110], [330, 60]);
  });

  it("with nothing selected there is nothing to warp", async () => {
    const { r, g } = rig([]);
    await arm(r, g, `${T}.puppetWarp`);
    await slowDrag(g, [200, 200], [240, 240]);
    expect(r.sent()).toEqual([]);
  });
});

describe("the Perspective tools through the gesture DSL [plugin-draw.distortion-tools]", () => {
  it("Perspective Grid: dragging the origin moves the grid — a view setting, saved in its part, no undo step", async () => {
    covers("tool:media.paged.draw.tool.perspectiveGrid");
    const { r, g } = rig([]);
    await arm(r, g, `${T}.perspectiveGrid`);
    // Activation showed the page's default grid (origin at 50 % / 72 %
    // of a Letter page).
    await slowDrag(g, [306, 570.24], [326, 560]);
    await g.settle();
    expect(r.sent()).toEqual([]);
    expect(r.steps()).toBe(0);
    const lib = gridPart(r) as {
      grids: Record<string, { origin: [number, number] }>;
    };
    const grid = Object.values(lib.grids)[0]!;
    expect(grid.origin[0]).toBeCloseTo(326, 6);
    expect(grid.origin[1]).toBeCloseTo(560, 6);
  });

  it("Perspective Grid: keys 1–4 switch the active plane", async () => {
    const { r, g } = rig([]);
    await arm(r, g, `${T}.perspectiveGrid`);
    await g.key("3").settle();
    const lib = gridPart(r) as {
      grids: Record<string, { activePlane: string }>;
    };
    expect(Object.values(lib.grids)[0]!.activePlane).toBe("right");
  });

  it("Perspective Selection: dragging free artwork onto the active plane attaches it — geometry and link in ONE batch, one undo step", async () => {
    covers("tool:media.paged.draw.tool.perspectiveSelect");
    const { r, g } = rig([]);
    await arm(r, g, `${T}.perspectiveSelect`);
    const before = r.picture();
    await slowDrag(g, [150, 150], [240, 520]);
    await g.settle();
    expect(r.sent()).toHaveLength(1);
    expect(r.leaves().map((m) => m.op)).toEqual([
      "setElementProperty",
      "setElementProperty",
      "setPluginMetadata",
    ]);
    const env = r.metaOf(A) as unknown as {
      data: { perspective: { plane: string } };
    };
    expect(env.data.perspective.plane).toBe("left");
    await oneUndoStep(r, before);
    await escapeSendsNothing(
      `${T}.perspectiveSelect`,
      [],
      [150, 150],
      [240, 520],
    );
  });
});
