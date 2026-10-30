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

// THE SYMBOLISM TOOLS and the 9-SLICE GUIDES tool through the gesture DSL
// (WP6.8, ADR 365), over the fake document of `commands/unit-kit.ts` in
// its engine-symbols mode (instances with a transform, the `symbols`
// collection): what each tool's drag SENDS — ONE batch of the ops it
// owns — and that Escape mid-drag sends nothing; Replace Symbol and
// Symbol Options as commands; and every tool option reaching the tool.
// The engine-backed versions are `test/headless/symbolism-tools.spec.ts`.
// [plugin-draw.symbols]

import { describe, expect, it } from "bun:test";

import type { ElementId, Mutation } from "@paged-media/plugin-api";
import { covers, gestures, type GestureDsl } from "@paged-media/test-kit";

import {
  createToolOptionsReader,
  SYMBOLISM_OPTIONS,
  type ToolOptionsDef,
} from "../src";
import { symbolismOptionsOf } from "../src/handlers/symbolism";
import { unitRig, type FakeElement, type UnitRig } from "./commands/unit-kit";

const T = "media.paged.draw.tool";
const C = "media.paged.draw.command";
const SYM = "Symbol/s1";

const instance = (id: string, x: number, y: number): FakeElement => ({
  id: { kind: "instance", id } as ElementId,
  bounds: [-10, -10, 10, 10],
  transform: [1, 0, 0, 1, x, y],
  props: {
    frameTransform: { type: "transform", value: [1, 0, 0, 1, x, y] },
    frameOpacity: { type: "length", value: null },
    symbolInstanceTint: { type: "lengths", value: [] },
    symbolInstanceSymbol: { type: "text", value: SYM },
  },
});

const symbols = (nineSlice: number[] | null = null) => [
  {
    id: SYM,
    name: "Dot",
    revision: 0,
    bounds: [-10, -10, 10, 10],
    nineSlice,
    itemCount: 1,
    instances: ["instance:i1", "instance:i2"],
  },
  {
    id: "Symbol/s2",
    name: "Other",
    revision: 0,
    bounds: [-5, -5, 5, 5],
    nineSlice: null,
    itemCount: 1,
    instances: [],
  },
];

const I1 = { kind: "instance", id: "i1" } as ElementId;

function rig(
  selection: ElementId[] = [],
  nineSlice: number[] | null = null,
): { r: UnitRig; g: GestureDsl } {
  const r = unitRig([instance("i1", 100, 100), instance("i2", 400, 400)], {
    selection,
    engineSymbols: true,
    collections: { symbols: symbols(nineSlice) },
  });
  return { r, g: gestures(r.fake) };
}

async function arm(r: UnitRig, g: GestureDsl, tool: string): Promise<void> {
  await g.tool(tool).settle();
  r.reset();
}

const ops = (ms: Mutation[]) => [...new Set(ms.map((m) => m.op))];
const paths = (ms: Mutation[]) => [
  ...new Set(
    ms
      .filter((m) => m.op === "setElementProperty")
      .map((m) => (m as { args: { path: string } }).args.path),
  ),
];

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

async function escapeSendsNothing(tool: string) {
  const { r, g } = rig();
  await arm(r, g, tool);
  await g
    .down([100, 100])
    .settle()
    .move([110, 105])
    .settle()
    .key("Escape")
    .settle()
    .up([110, 105])
    .settle();
  expect(r.sent(), `${tool}: Escape mid-drag committed`).toEqual([]);
}

/** One drag over the instance at (100, 100): ONE batch of `wantOps`
 *  (and, for a modifier, of `wantPath`), touching the near instance only. */
async function drag(tool: string, wantOps: string[], wantPath?: string) {
  const { r, g } = rig();
  await arm(r, g, tool);
  await slowDrag(g, [100, 100], [112, 108]);
  await g.settle();
  expect(r.sent()).toHaveLength(1);
  expect(r.sent()[0]!.op).toBe("batch");
  expect(ops(r.leaves())).toEqual(wantOps);
  if (wantPath) {
    expect(paths(r.leaves())).toEqual([wantPath]);
    // The far instance at (400, 400) was never under the brush.
    expect(
      r
        .leaves()
        .map((m) => (m as { args: { elementId?: ElementId } }).args.elementId)
        .every((e) => e?.id === "i1"),
    ).toBe(true);
  }
  await escapeSendsNothing(tool);
}

describe("the Symbolism tools through the gesture DSL [plugin-draw.symbols]", () => {
  it("the Symbol Sprayer: one drag is one batch; Escape sends nothing", async () => {
    covers("tool:media.paged.draw.tool.symbolSprayer");
    await drag(`${T}.symbolSprayer`, ["placeSymbolInstance"]);
  });
  it("the Symbol Shifter: one drag is one batch; Escape sends nothing", async () => {
    covers("tool:media.paged.draw.tool.symbolShifter");
    await drag(`${T}.symbolShifter`, ["setElementProperty"], "frameTransform");
  });
  it("the Symbol Scruncher: one drag is one batch; Escape sends nothing", async () => {
    covers("tool:media.paged.draw.tool.symbolScruncher");
    await drag(
      `${T}.symbolScruncher`,
      ["setElementProperty"],
      "frameTransform",
    );
  });
  it("the Symbol Sizer: one drag is one batch; Escape sends nothing", async () => {
    covers("tool:media.paged.draw.tool.symbolSizer");
    await drag(`${T}.symbolSizer`, ["setElementProperty"], "frameTransform");
  });
  it("the Symbol Spinner: one drag is one batch; Escape sends nothing", async () => {
    covers("tool:media.paged.draw.tool.symbolSpinner");
    await drag(`${T}.symbolSpinner`, ["setElementProperty"], "frameTransform");
  });
  it("the Symbol Stainer: one drag is one batch; Escape sends nothing", async () => {
    covers("tool:media.paged.draw.tool.symbolStainer");
    await drag(
      `${T}.symbolStainer`,
      ["setElementProperty"],
      "symbolInstanceTint",
    );
  });
  it("the Symbol Screener: one drag is one batch; Escape sends nothing", async () => {
    covers("tool:media.paged.draw.tool.symbolScreener");
    await drag(`${T}.symbolScreener`, ["setElementProperty"], "frameOpacity");
  });
  it("the Sprayer with Alt deletes the instances it sweeps, in one batch", async () => {
    const { r, g } = rig();
    await arm(r, g, `${T}.symbolSprayer`);
    await g
      .down([100, 100], { mods: ["alt"] })
      .settle()
      .move([104, 100], { mods: ["alt"] })
      .settle()
      .up([104, 100], { mods: ["alt"] })
      .settle();
    await g.settle();
    expect(r.sent()).toHaveLength(1);
    expect(r.leaves()).toEqual([
      { op: "deleteFrame", args: { frameId: "i1" } },
    ]);
  });

  it("the 9-Slice Guides tool drags a guide of the selected instance's symbol: one redefineSymbol", async () => {
    covers("tool:media.paged.draw.tool.symbolNineSlice");
    const { r, g } = rig([I1]);
    await arm(r, g, `${T}.symbolNineSlice`);
    // The default guides sit 5 pt in from the 20 pt box: the left one at
    // x = 100 − 10 + 5 = 95.
    await g
      .down([95, 100])
      .settle()
      .move([97, 100])
      .settle()
      .up([97, 100])
      .settle();
    await g.settle();
    expect(r.sent()).toEqual([
      {
        op: "redefineSymbol",
        args: { symbolId: SYM, nineSlice: [7, 5, 5, 5] },
      },
    ]);
  });
});

describe("Replace Symbol and Symbol Options as commands [plugin-draw.symbols]", () => {
  it("replaceSymbol: the selected instances draw the named symbol, one batch", async () => {
    covers("command:media.paged.draw.command.replaceSymbol");
    const { r } = rig([I1]);
    r.reset();
    await r.run(`${C}.replaceSymbol`, { symbolId: "Symbol/s2" });
    expect(r.leaves()).toEqual([
      {
        op: "setElementProperty",
        args: {
          elementId: I1,
          path: "symbolInstanceSymbol",
          value: { type: "text", value: "Symbol/s2" },
        },
      },
    ]);
    expect(r.sent()).toHaveLength(1);
  });

  it("symbolOptions: values apply in one redefineSymbol; bare, it raises the Symbols panel", async () => {
    covers("command:media.paged.draw.command.symbolOptions");
    const { r } = rig();
    r.reset();
    await r.run(`${C}.symbolOptions`, {
      symbolId: SYM,
      name: "Badge",
      nineSlice: [1, 2, 3, 4],
    });
    expect(r.sent()).toEqual([
      {
        op: "redefineSymbol",
        args: { symbolId: SYM, name: "Badge", nineSlice: [1, 2, 3, 4] },
      },
    ]);
    const shell = unitRig([instance("i1", 100, 100)], {
      engineSymbols: true,
      shell: true,
      collections: { symbols: symbols() },
    });
    shell.reset();
    await shell.run(`${C}.symbolOptions`);
    expect(shell.sent()).toEqual([]);
    expect(shell.opened).toEqual(["media.paged.draw.panel.symbols"]);
  });
});

type Value = number | string;

function readerOf(def: ToolOptionsDef, values: Record<string, Value>) {
  const r = createToolOptionsReader(def);
  r.attach({
    toolSettings: { getValue: (_t: string, k: string) => values[k] },
  });
  return r;
}

/** One option: its default, and a stored value reaching the machine
 *  options the tool builds. */
function option(
  kind: keyof typeof SYMBOLISM_OPTIONS,
  key: string,
  want: Value,
  changed: Value,
  read: (o: ReturnType<typeof symbolismOptionsOf>) => unknown,
  expected: unknown,
) {
  const def = SYMBOLISM_OPTIONS[kind];
  const field = def.fields.find((f) => f.key === key)!;
  expect(field, `${def.toolId}.${key}`).toBeDefined();
  expect(field.default).toBe(want as never);
  expect(
    read(symbolismOptionsOf(kind, readerOf(def, { [key]: changed }))),
  ).toEqual(expected);
}

describe("the Symbolism tools' options — every one reaches the tool [plugin-draw.symbols]", () => {
  it("symbolSprayer.diameter: default 100, a stored 40 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolSprayer.diameter");
    option("sprayer", "diameter", 100, 40, (o) => o.diameter, 40);
  });
  it("symbolSprayer.intensity: default 8, a stored 3 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolSprayer.intensity");
    option("sprayer", "intensity", 8, 3, (o) => o.intensity, 3);
  });
  it("symbolSprayer.density: default 5, a stored 9 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolSprayer.density");
    option("sprayer", "density", 5, 9, (o) => o.density, 9);
  });
  it("symbolSprayer.sizeScatter: default 0, a stored 30 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolSprayer.sizeScatter");
    option("sprayer", "sizeScatter", 0, 30, (o) => o.sizeScatter, 30);
  });
  it("symbolSprayer.rotationScatter: default 0, a stored 45 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolSprayer.rotationScatter");
    option("sprayer", "rotationScatter", 0, 45, (o) => o.rotationScatter, 45);
  });
  it("symbolSprayer.orientation: default fixed, a stored drag reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolSprayer.orientation");
    option(
      "sprayer",
      "orientation",
      "fixed",
      "drag",
      (o) => o.followDrag,
      true,
    );
  });
  it("symbolShifter.diameter: default 100, a stored 40 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolShifter.diameter");
    option("shifter", "diameter", 100, 40, (o) => o.diameter, 40);
  });
  it("symbolShifter.intensity: default 8, a stored 3 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolShifter.intensity");
    option("shifter", "intensity", 8, 3, (o) => o.intensity, 3);
  });
  it("symbolScruncher.diameter: default 100, a stored 40 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolScruncher.diameter");
    option("scruncher", "diameter", 100, 40, (o) => o.diameter, 40);
  });
  it("symbolScruncher.intensity: default 8, a stored 3 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolScruncher.intensity");
    option("scruncher", "intensity", 8, 3, (o) => o.intensity, 3);
  });
  it("symbolSizer.diameter: default 100, a stored 40 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolSizer.diameter");
    option("sizer", "diameter", 100, 40, (o) => o.diameter, 40);
  });
  it("symbolSizer.intensity: default 8, a stored 3 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolSizer.intensity");
    option("sizer", "intensity", 8, 3, (o) => o.intensity, 3);
  });
  it("symbolSpinner.diameter: default 100, a stored 40 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolSpinner.diameter");
    option("spinner", "diameter", 100, 40, (o) => o.diameter, 40);
  });
  it("symbolSpinner.intensity: default 8, a stored 3 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolSpinner.intensity");
    option("spinner", "intensity", 8, 3, (o) => o.intensity, 3);
  });
  it("symbolStainer.diameter: default 100, a stored 40 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolStainer.diameter");
    option("stainer", "diameter", 100, 40, (o) => o.diameter, 40);
  });
  it("symbolStainer.intensity: default 8, a stored 3 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolStainer.intensity");
    option("stainer", "intensity", 8, 3, (o) => o.intensity, 3);
  });
  it("symbolScreener.diameter: default 100, a stored 40 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolScreener.diameter");
    option("screener", "diameter", 100, 40, (o) => o.diameter, 40);
  });
  it("symbolScreener.intensity: default 8, a stored 3 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolScreener.intensity");
    option("screener", "intensity", 8, 3, (o) => o.intensity, 3);
  });
  it("symbolStainer.red: default 255, a stored 0 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolStainer.red");
    option("stainer", "red", 255, 0, (o) => o.color[0], 0);
  });
  it("symbolStainer.green: default 0, a stored 255 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolStainer.green");
    option("stainer", "green", 0, 255, (o) => o.color[1], 1);
  });
  it("symbolStainer.blue: default 0, a stored 255 reaches the tool", () => {
    covers("setting:media.paged.draw.tool.symbolStainer.blue");
    option("stainer", "blue", 0, 255, (o) => o.color[2], 1);
  });
});
