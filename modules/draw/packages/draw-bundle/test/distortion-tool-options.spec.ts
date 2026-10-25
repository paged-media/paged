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

// THE DISTORTION TOOLS' OPTIONS, no engine. Two tiers:
//   · EVERY option: its default is Illustrator's, and a value the host's
//     tool-settings store holds (what the tool-options popover writes)
//     reaches the options the tool hands its machine;
//   · the options whose effect is geometry are also driven through a
//     gesture, twice — default and changed — and the difference named.
// [plugin-draw.distortion-tools]

import { describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";
import { covers, gestures, type GestureDsl } from "@paged-media/test-kit";

import {
  createToolOptionsReader,
  LIQUIFY_OPTIONS,
  liquifyOptionsOf,
  PERSPECTIVE_SELECT_OPTIONS,
  PUPPET_WARP_OPTIONS,
  type ToolOptionsDef,
} from "../src";
import { rectEl, unitRig, type UnitRig } from "./commands/unit-kit";

type Value = number | string | boolean;
const A = { kind: "polygon", id: "ua" } as ElementId;

/** A reader over a store holding `values`. */
function readerOf(def: ToolOptionsDef, values: Record<string, Value>) {
  const r = createToolOptionsReader(def);
  r.attach({
    toolSettings: { getValue: (_t: string, k: string) => values[k] },
  });
  return r;
}

/** One option: default, and a stored value reaching the reader (and, for
 *  a liquify tool, the machine options). */
function option(
  def: ToolOptionsDef,
  key: string,
  want: Value,
  changed: Value,
  machineKey?: string,
) {
  const field = def.fields.find((f) => f.key === key)!;
  expect(field, `${def.toolId}.${key}`).toBeDefined();
  expect(field.default).toBe(want as never);
  const r = readerOf(def, { [key]: changed });
  const got = field.kind === "number" ? r.number(key) : r.select(key);
  expect(got).toBe(changed as never);
  if (machineKey) {
    const kind = def.toolId.split(".").pop() as keyof typeof LIQUIFY_OPTIONS;
    const o = liquifyOptionsOf(kind, r) as unknown as Record<string, Value>;
    const expected = typeof changed === "string" ? changed === "on" : changed;
    expect(o[machineKey]).toBe(expected);
    const d = liquifyOptionsOf(kind, readerOf(def, {})) as unknown as Record<
      string,
      Value
    >;
    expect(d[machineKey]).toBe(typeof want === "string" ? want === "on" : want);
  }
}

describe("the Liquify tools' options — every one reaches the tool [plugin-draw.distortion-tools]", () => {
  it("warp.width: default 100, a stored 250 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.warp.width");
    option(LIQUIFY_OPTIONS.warp, "width", 100, 250, "width");
  });
  it("warp.height: default 100, a stored 40 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.warp.height");
    option(LIQUIFY_OPTIONS.warp, "height", 100, 40, "height");
  });
  it("warp.angle: default 0, a stored 30 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.warp.angle");
    option(LIQUIFY_OPTIONS.warp, "angle", 0, 30, "angle");
  });
  it("warp.intensity: default 50, a stored 90 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.warp.intensity");
    option(LIQUIFY_OPTIONS.warp, "intensity", 50, 90, "intensity");
  });
  it("warp.usePressure: default off, a stored on reaches the tool", () => {
    covers("setting:media.paged.draw.tool.warp.usePressure");
    option(LIQUIFY_OPTIONS.warp, "usePressure", "off", "on", "usePressure");
  });
  it("warp.detail: default 2, a stored 7 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.warp.detail");
    option(LIQUIFY_OPTIONS.warp, "detail", 2, 7, "detail");
  });
  it("warp.simplify: default 50, a stored 10 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.warp.simplify");
    option(LIQUIFY_OPTIONS.warp, "simplify", 50, 10, "simplify");
  });
  it("twirl.width: default 100, a stored 250 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.twirl.width");
    option(LIQUIFY_OPTIONS.twirl, "width", 100, 250, "width");
  });
  it("twirl.height: default 100, a stored 40 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.twirl.height");
    option(LIQUIFY_OPTIONS.twirl, "height", 100, 40, "height");
  });
  it("twirl.angle: default 0, a stored 30 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.twirl.angle");
    option(LIQUIFY_OPTIONS.twirl, "angle", 0, 30, "angle");
  });
  it("twirl.intensity: default 50, a stored 90 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.twirl.intensity");
    option(LIQUIFY_OPTIONS.twirl, "intensity", 50, 90, "intensity");
  });
  it("twirl.usePressure: default off, a stored on reaches the tool", () => {
    covers("setting:media.paged.draw.tool.twirl.usePressure");
    option(LIQUIFY_OPTIONS.twirl, "usePressure", "off", "on", "usePressure");
  });
  it("twirl.detail: default 2, a stored 7 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.twirl.detail");
    option(LIQUIFY_OPTIONS.twirl, "detail", 2, 7, "detail");
  });
  it("twirl.simplify: default 50, a stored 10 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.twirl.simplify");
    option(LIQUIFY_OPTIONS.twirl, "simplify", 50, 10, "simplify");
  });
  it("twirl.twirlRate: default 40, a stored -90 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.twirl.twirlRate");
    option(LIQUIFY_OPTIONS.twirl, "twirlRate", 40, -90, "twirlRate");
  });
  it("pucker.width: default 100, a stored 250 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.pucker.width");
    option(LIQUIFY_OPTIONS.pucker, "width", 100, 250, "width");
  });
  it("pucker.height: default 100, a stored 40 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.pucker.height");
    option(LIQUIFY_OPTIONS.pucker, "height", 100, 40, "height");
  });
  it("pucker.angle: default 0, a stored 30 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.pucker.angle");
    option(LIQUIFY_OPTIONS.pucker, "angle", 0, 30, "angle");
  });
  it("pucker.intensity: default 50, a stored 90 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.pucker.intensity");
    option(LIQUIFY_OPTIONS.pucker, "intensity", 50, 90, "intensity");
  });
  it("pucker.usePressure: default off, a stored on reaches the tool", () => {
    covers("setting:media.paged.draw.tool.pucker.usePressure");
    option(LIQUIFY_OPTIONS.pucker, "usePressure", "off", "on", "usePressure");
  });
  it("pucker.detail: default 2, a stored 7 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.pucker.detail");
    option(LIQUIFY_OPTIONS.pucker, "detail", 2, 7, "detail");
  });
  it("pucker.simplify: default 50, a stored 10 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.pucker.simplify");
    option(LIQUIFY_OPTIONS.pucker, "simplify", 50, 10, "simplify");
  });
  it("bloat.width: default 100, a stored 250 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.bloat.width");
    option(LIQUIFY_OPTIONS.bloat, "width", 100, 250, "width");
  });
  it("bloat.height: default 100, a stored 40 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.bloat.height");
    option(LIQUIFY_OPTIONS.bloat, "height", 100, 40, "height");
  });
  it("bloat.angle: default 0, a stored 30 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.bloat.angle");
    option(LIQUIFY_OPTIONS.bloat, "angle", 0, 30, "angle");
  });
  it("bloat.intensity: default 50, a stored 90 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.bloat.intensity");
    option(LIQUIFY_OPTIONS.bloat, "intensity", 50, 90, "intensity");
  });
  it("bloat.usePressure: default off, a stored on reaches the tool", () => {
    covers("setting:media.paged.draw.tool.bloat.usePressure");
    option(LIQUIFY_OPTIONS.bloat, "usePressure", "off", "on", "usePressure");
  });
  it("bloat.detail: default 2, a stored 7 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.bloat.detail");
    option(LIQUIFY_OPTIONS.bloat, "detail", 2, 7, "detail");
  });
  it("bloat.simplify: default 50, a stored 10 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.bloat.simplify");
    option(LIQUIFY_OPTIONS.bloat, "simplify", 50, 10, "simplify");
  });
  it("scallop.width: default 100, a stored 250 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.scallop.width");
    option(LIQUIFY_OPTIONS.scallop, "width", 100, 250, "width");
  });
  it("scallop.height: default 100, a stored 40 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.scallop.height");
    option(LIQUIFY_OPTIONS.scallop, "height", 100, 40, "height");
  });
  it("scallop.angle: default 0, a stored 30 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.scallop.angle");
    option(LIQUIFY_OPTIONS.scallop, "angle", 0, 30, "angle");
  });
  it("scallop.intensity: default 50, a stored 90 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.scallop.intensity");
    option(LIQUIFY_OPTIONS.scallop, "intensity", 50, 90, "intensity");
  });
  it("scallop.usePressure: default off, a stored on reaches the tool", () => {
    covers("setting:media.paged.draw.tool.scallop.usePressure");
    option(LIQUIFY_OPTIONS.scallop, "usePressure", "off", "on", "usePressure");
  });
  it("scallop.detail: default 2, a stored 7 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.scallop.detail");
    option(LIQUIFY_OPTIONS.scallop, "detail", 2, 7, "detail");
  });
  it("scallop.simplify: default 50, a stored 10 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.scallop.simplify");
    option(LIQUIFY_OPTIONS.scallop, "simplify", 50, 10, "simplify");
  });
  it("scallop.complexity: default 1, a stored 9 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.scallop.complexity");
    option(LIQUIFY_OPTIONS.scallop, "complexity", 1, 9, "complexity");
  });
  it("scallop.affectAnchors: default on, a stored off reaches the tool", () => {
    covers("setting:media.paged.draw.tool.scallop.affectAnchors");
    option(
      LIQUIFY_OPTIONS.scallop,
      "affectAnchors",
      "on",
      "off",
      "affectAnchors",
    );
  });
  it("scallop.affectIn: default on, a stored off reaches the tool", () => {
    covers("setting:media.paged.draw.tool.scallop.affectIn");
    option(LIQUIFY_OPTIONS.scallop, "affectIn", "on", "off", "affectIn");
  });
  it("scallop.affectOut: default on, a stored off reaches the tool", () => {
    covers("setting:media.paged.draw.tool.scallop.affectOut");
    option(LIQUIFY_OPTIONS.scallop, "affectOut", "on", "off", "affectOut");
  });
  it("crystallize.width: default 100, a stored 250 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.crystallize.width");
    option(LIQUIFY_OPTIONS.crystallize, "width", 100, 250, "width");
  });
  it("crystallize.height: default 100, a stored 40 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.crystallize.height");
    option(LIQUIFY_OPTIONS.crystallize, "height", 100, 40, "height");
  });
  it("crystallize.angle: default 0, a stored 30 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.crystallize.angle");
    option(LIQUIFY_OPTIONS.crystallize, "angle", 0, 30, "angle");
  });
  it("crystallize.intensity: default 50, a stored 90 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.crystallize.intensity");
    option(LIQUIFY_OPTIONS.crystallize, "intensity", 50, 90, "intensity");
  });
  it("crystallize.usePressure: default off, a stored on reaches the tool", () => {
    covers("setting:media.paged.draw.tool.crystallize.usePressure");
    option(
      LIQUIFY_OPTIONS.crystallize,
      "usePressure",
      "off",
      "on",
      "usePressure",
    );
  });
  it("crystallize.detail: default 2, a stored 7 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.crystallize.detail");
    option(LIQUIFY_OPTIONS.crystallize, "detail", 2, 7, "detail");
  });
  it("crystallize.simplify: default 50, a stored 10 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.crystallize.simplify");
    option(LIQUIFY_OPTIONS.crystallize, "simplify", 50, 10, "simplify");
  });
  it("crystallize.complexity: default 1, a stored 9 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.crystallize.complexity");
    option(LIQUIFY_OPTIONS.crystallize, "complexity", 1, 9, "complexity");
  });
  it("crystallize.affectAnchors: default on, a stored off reaches the tool", () => {
    covers("setting:media.paged.draw.tool.crystallize.affectAnchors");
    option(
      LIQUIFY_OPTIONS.crystallize,
      "affectAnchors",
      "on",
      "off",
      "affectAnchors",
    );
  });
  it("crystallize.affectIn: default on, a stored off reaches the tool", () => {
    covers("setting:media.paged.draw.tool.crystallize.affectIn");
    option(LIQUIFY_OPTIONS.crystallize, "affectIn", "on", "off", "affectIn");
  });
  it("crystallize.affectOut: default on, a stored off reaches the tool", () => {
    covers("setting:media.paged.draw.tool.crystallize.affectOut");
    option(LIQUIFY_OPTIONS.crystallize, "affectOut", "on", "off", "affectOut");
  });
  it("wrinkle.width: default 100, a stored 250 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.wrinkle.width");
    option(LIQUIFY_OPTIONS.wrinkle, "width", 100, 250, "width");
  });
  it("wrinkle.height: default 100, a stored 40 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.wrinkle.height");
    option(LIQUIFY_OPTIONS.wrinkle, "height", 100, 40, "height");
  });
  it("wrinkle.angle: default 0, a stored 30 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.wrinkle.angle");
    option(LIQUIFY_OPTIONS.wrinkle, "angle", 0, 30, "angle");
  });
  it("wrinkle.intensity: default 50, a stored 90 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.wrinkle.intensity");
    option(LIQUIFY_OPTIONS.wrinkle, "intensity", 50, 90, "intensity");
  });
  it("wrinkle.usePressure: default off, a stored on reaches the tool", () => {
    covers("setting:media.paged.draw.tool.wrinkle.usePressure");
    option(LIQUIFY_OPTIONS.wrinkle, "usePressure", "off", "on", "usePressure");
  });
  it("wrinkle.detail: default 2, a stored 7 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.wrinkle.detail");
    option(LIQUIFY_OPTIONS.wrinkle, "detail", 2, 7, "detail");
  });
  it("wrinkle.simplify: default 50, a stored 10 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.wrinkle.simplify");
    option(LIQUIFY_OPTIONS.wrinkle, "simplify", 50, 10, "simplify");
  });
  it("wrinkle.horizontal: default 0, a stored 60 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.wrinkle.horizontal");
    option(LIQUIFY_OPTIONS.wrinkle, "horizontal", 0, 60, "horizontal");
  });
  it("wrinkle.vertical: default 100, a stored 30 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.wrinkle.vertical");
    option(LIQUIFY_OPTIONS.wrinkle, "vertical", 100, 30, "vertical");
  });
  it("wrinkle.complexity: default 1, a stored 9 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.wrinkle.complexity");
    option(LIQUIFY_OPTIONS.wrinkle, "complexity", 1, 9, "complexity");
  });
  it("wrinkle.affectAnchors: default on, a stored off reaches the tool", () => {
    covers("setting:media.paged.draw.tool.wrinkle.affectAnchors");
    option(
      LIQUIFY_OPTIONS.wrinkle,
      "affectAnchors",
      "on",
      "off",
      "affectAnchors",
    );
  });
  it("wrinkle.affectIn: default on, a stored off reaches the tool", () => {
    covers("setting:media.paged.draw.tool.wrinkle.affectIn");
    option(LIQUIFY_OPTIONS.wrinkle, "affectIn", "on", "off", "affectIn");
  });
  it("wrinkle.affectOut: default on, a stored off reaches the tool", () => {
    covers("setting:media.paged.draw.tool.wrinkle.affectOut");
    option(LIQUIFY_OPTIONS.wrinkle, "affectOut", "on", "off", "affectOut");
  });
});

describe("Puppet Warp and Perspective Selection options [plugin-draw.distortion-tools]", () => {
  it("puppetWarp.density: normal by default; more / fewer are read", () => {
    covers("setting:media.paged.draw.tool.puppetWarp.density");
    option(PUPPET_WARP_OPTIONS, "density", "normal", "more");
    option(PUPPET_WARP_OPTIONS, "density", "normal", "fewer");
  });
  it("puppetWarp.showMesh: on by default; off is read", () => {
    covers("setting:media.paged.draw.tool.puppetWarp.showMesh");
    option(PUPPET_WARP_OPTIONS, "showMesh", "on", "off");
  });
  it("perspectiveSelect.shape: nothing by default; rectangle / ellipse are read", () => {
    covers("setting:media.paged.draw.tool.perspectiveSelect.shape");
    option(PERSPECTIVE_SELECT_OPTIONS, "shape", "none", "rectangle");
    option(PERSPECTIVE_SELECT_OPTIONS, "shape", "none", "ellipse");
  });
});

// ------------------------------------------------- through a gesture

async function withOptions(
  tool: string,
  values: Record<string, Value>,
  gesture: (g: GestureDsl) => GestureDsl,
  selection: ElementId[] = [A],
): Promise<UnitRig> {
  const r = unitRig([rectEl("polygon", "ua", [100, 100, 300, 300])], {
    selection,
  });
  const store: Record<string, Value> = { ...values };
  Object.assign(r.fake.editor, {
    toolSettings: {
      getValue: (_tool: string, key: string) => store[key],
      set: (_tool: string, key: string, value: Value) => {
        if (!(key in store)) store[key] = value;
      },
    },
  });
  const g = gestures(r.fake);
  await g.tool(tool).settle();
  r.reset();
  await gesture(g).settle();
  return r;
}

const written = (r: UnitRig) => {
  const m = r
    .leaves()
    .find(
      (x) => (x as { args?: { path?: string } }).args?.path === "framePath",
    ) as
    | { args: { value: { value: { anchors: { anchor: number[] }[] } } } }
    | undefined;
  return m?.args.value.value.anchors ?? [];
};

const press = (at: [number, number]) => (g: GestureDsl) =>
  g
    .down(at)
    .settle()
    .move([at[0], at[1] + 1])
    .settle()
    .up([at[0], at[1] + 1])
    .settle();

describe("liquify options change the geometry [plugin-draw.distortion-tools]", () => {
  it("a bigger brush reaches more of the path", async () => {
    const small = await withOptions(
      "media.paged.draw.tool.bloat",
      { width: 30, height: 30, simplify: 0.2 },
      press([300, 200]),
    );
    const big = await withOptions(
      "media.paged.draw.tool.bloat",
      { width: 300, height: 300, simplify: 0.2 },
      press([300, 200]),
    );
    const moved = (r: UnitRig) =>
      written(r).filter(
        (a) =>
          a.anchor[0] > 300.01 ||
          a.anchor[0] < 99.99 ||
          a.anchor[1] < 99.99 ||
          a.anchor[1] > 300.01,
      ).length;
    expect(moved(big)).toBeGreaterThan(moved(small));
  });

  it("more intensity moves the path further", async () => {
    // The brush sits just outside the right edge, so bloating pushes the
    // edge in, away from the brush centre.
    const reach = (r: UnitRig) =>
      Math.min(
        ...written(r)
          .map((a) => a.anchor[0])
          .filter((x) => x > 200),
      );
    const soft = await withOptions(
      "media.paged.draw.tool.bloat",
      { intensity: 10 },
      press([320, 200]),
    );
    const hard = await withOptions(
      "media.paged.draw.tool.bloat",
      { intensity: 100 },
      press([320, 200]),
    );
    expect(reach(hard)).toBeLessThan(reach(soft));
  });

  it("a finer simplify keeps more anchors", async () => {
    const fine = await withOptions(
      "media.paged.draw.tool.crystallize",
      { simplify: 0.2, detail: 8, complexity: 8 },
      press([300, 200]),
    );
    const coarse = await withOptions(
      "media.paged.draw.tool.crystallize",
      { simplify: 100, detail: 8, complexity: 8 },
      press([300, 200]),
    );
    expect(written(fine).length).toBeGreaterThan(written(coarse).length);
  });

  it("the twirl rate's sign sets the direction", async () => {
    const ccw = await withOptions(
      "media.paged.draw.tool.twirl",
      { twirlRate: 90, width: 400, height: 400 },
      press([200, 200]),
    );
    const cw = await withOptions(
      "media.paged.draw.tool.twirl",
      { twirlRate: -90, width: 400, height: 400 },
      press([200, 200]),
    );
    expect(written(ccw)).not.toEqual(written(cw));
  });

  it("Wrinkle with 0 % vertical and horizontal leaves the path in place", async () => {
    const still = await withOptions(
      "media.paged.draw.tool.wrinkle",
      { horizontal: 0, vertical: 0 },
      press([200, 100]),
    );
    for (const a of written(still))
      expect(Math.abs(a.anchor[1] - 100) < 1e-6 || a.anchor[1] > 100).toBe(
        true,
      );
  });
});
