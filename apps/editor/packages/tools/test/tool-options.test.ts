/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// The built-in tools' OPTIONS (settings `<toolId>.<key>`): what the tool
// options popover writes and a gesture reads. Enumerated from the tool
// declarations, so a host tool that gains an option fails here until the
// option has a row below. For each: the declared default the handler
// uses with nothing set, the declared bounds the handler clamps to, a
// non-number falls back to the default, and a value written AFTER the
// tool was activated is the one the next gesture uses (the popover
// writes while the tool is live).

import { describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/client";
import { covers } from "@paged-media/test-kit";

import { BUILT_IN_TOOLS } from "../src/built-in-tools";
import { createPolygonHandler } from "../src/handlers/polygon-tool";
import { createSmoothHandler } from "../src/handlers/smooth-tool";
import { harness, leaves } from "./support";

const PATH = { kind: "polygon", id: "path-1" } as ElementId;

/** Every host tool option, as declared. One settings key may back
 *  several tools (Polygon and Polygon Frame share `paged.tool.polygon`,
 *  as InDesign's one Polygon Settings dialog does); it is one setting. */
const DECLARED = [
  ...new Map(
    BUILT_IN_TOOLS.flatMap((t) =>
      (t.options?.fields ?? []).map((f) => {
        const field = f as {
          key: string;
          kind: string;
          min?: number;
          max?: number;
        };
        return [
          `${t.options!.toolId}.${field.key}`,
          { toolId: t.options!.toolId, field },
        ] as const;
      }),
    ),
  ).values(),
];

/** The anchors one polygon drag commits with these settings. */
async function polygonAnchors(
  settings: Record<string, unknown> | undefined,
): Promise<Array<{ anchor: number[] }>> {
  const { fake, g } = harness({
    toolSettings: settings
      ? { "paged.tool.polygon": settings as Record<string, number> }
      : undefined,
  });
  await g
    .tool(() => createPolygonHandler())
    .drag({ from: [100, 100], to: [300, 300] })
    .settle();
  const insert = leaves(fake).find((m) => m.op === "insertPath");
  return (insert!.args as { anchors: Array<{ anchor: number[] }> }).anchors;
}

/** The tolerance one Smooth click sends with these settings. */
async function smoothTolerance(
  settings: Record<string, unknown> | undefined,
): Promise<number> {
  const { fake, g } = harness({
    hitTest: () => PATH,
    toolSettings: settings
      ? { "paged.tool.smooth": settings as Record<string, number> }
      : undefined,
  });
  await g.tool(createSmoothHandler).click([150, 150]).settle();
  return (fake.mutations()[0] as { args: { tolerance: number } }).args
    .tolerance;
}

const radii = (anchors: Array<{ anchor: number[] }>) =>
  anchors.map((a) => Math.hypot(a.anchor[0] - 200, a.anchor[1] - 200));

describe("the host tool options", () => {
  it("are exactly the options this file covers", () => {
    expect(DECLARED.map((d) => `${d.toolId}.${d.field.key}`).sort()).toEqual([
      "paged.tool.polygon.sides",
      "paged.tool.polygon.starInset",
      "paged.tool.smooth.tolerance",
    ]);
    for (const d of DECLARED) expect(d.field.kind).toBe("number");
  });
});

describe("setting paged.tool.polygon.sides", () => {
  const declared = DECLARED.find(
    (d) => d.toolId === "paged.tool.polygon" && d.field.key === "sides",
  )!.field;

  it("default: a hexagon", async () => {
    covers("setting:paged.tool.polygon.sides");
    expect(await polygonAnchors(undefined)).toHaveLength(6);
  });

  it("the value sets the vertex count; the declared bounds are the clamp", async () => {
    covers("setting:paged.tool.polygon.sides");
    expect(declared.min).toBe(3);
    expect(declared.max).toBe(100);
    expect(await polygonAnchors({ sides: 8 })).toHaveLength(8);
    expect(await polygonAnchors({ sides: 1 })).toHaveLength(3);
    expect(await polygonAnchors({ sides: 500 })).toHaveLength(100);
    // A fraction rounds to whole sides.
    expect(await polygonAnchors({ sides: 4.6 })).toHaveLength(5);
  });

  it("a non-number falls back to the default", async () => {
    covers("setting:paged.tool.polygon.sides");
    for (const sides of ["8", null, Number.NaN, Number.POSITIVE_INFINITY])
      expect({ sides, n: (await polygonAnchors({ sides })).length }).toEqual({
        sides,
        n: 6,
      });
  });

  it("a value written while the tool is active is what the next drag uses", async () => {
    covers("setting:paged.tool.polygon.sides");
    const { fake, g } = harness();
    const dsl = g.tool(() => createPolygonHandler());
    await dsl.drag({ from: [100, 100], to: [300, 300] }).settle();
    fake.setToolSetting("paged.tool.polygon", "sides", 4);
    await dsl.drag({ from: [320, 100], to: [520, 300] }).settle();
    const all = leaves(fake)
      .filter((m) => m.op === "insertPath")
      .map((m) => (m.args as { anchors: unknown[] }).anchors.length);
    expect(all).toEqual([6, 4]);
  });
});

describe("setting paged.tool.polygon.starInset", () => {
  const declared = DECLARED.find(
    (d) => d.toolId === "paged.tool.polygon" && d.field.key === "starInset",
  )!.field;

  it("default: 0, a plain polygon (every vertex on the outer radius)", async () => {
    covers("setting:paged.tool.polygon.starInset");
    const r = radii(await polygonAnchors({ sides: 5 }));
    expect(r).toHaveLength(5);
    for (const x of r) expect(x).toBeCloseTo(100, 9);
  });

  it("an inset makes a star: 2·sides vertices, inner radius × (1 − inset/100)", async () => {
    covers("setting:paged.tool.polygon.starInset");
    const r = radii(await polygonAnchors({ sides: 5, starInset: 25 }));
    expect(r).toHaveLength(10);
    r.forEach((x, i) => expect(x).toBeCloseTo(i % 2 === 0 ? 100 : 75, 9));
  });

  it("the declared bounds 0…100 are the clamp; a non-number is the default", async () => {
    covers("setting:paged.tool.polygon.starInset");
    expect(declared.min).toBe(0);
    expect(declared.max).toBe(100);
    expect(await polygonAnchors({ sides: 5, starInset: -10 })).toHaveLength(5);
    const full = radii(await polygonAnchors({ sides: 5, starInset: 250 }));
    full.forEach((x, i) => expect(x).toBeCloseTo(i % 2 === 0 ? 100 : 0, 9));
    expect(
      await polygonAnchors({ sides: 5, starInset: "40" as unknown as number }),
    ).toHaveLength(5);
  });
});

describe("setting paged.tool.smooth.tolerance", () => {
  const declared = DECLARED.find(
    (d) => d.toolId === "paged.tool.smooth" && d.field.key === "tolerance",
  )!.field;

  it("default: 1.5 pt", async () => {
    covers("setting:paged.tool.smooth.tolerance");
    expect(await smoothTolerance(undefined)).toBe(1.5);
  });

  it("the value is sent as is inside the declared 0.1…20 pt, clamped outside", async () => {
    covers("setting:paged.tool.smooth.tolerance");
    expect(declared.min).toBe(0.1);
    expect(declared.max).toBe(20);
    expect(await smoothTolerance({ tolerance: 4 })).toBe(4);
    expect(await smoothTolerance({ tolerance: 0 })).toBe(0.1);
    expect(await smoothTolerance({ tolerance: 99 })).toBe(20);
  });

  it("a non-number falls back to the default", async () => {
    covers("setting:paged.tool.smooth.tolerance");
    for (const tolerance of ["4", null, Number.NaN])
      expect({ tolerance, t: await smoothTolerance({ tolerance }) }).toEqual({
        tolerance,
        t: 1.5,
      });
  });

  it("a value written while the tool is active is what the next click uses", async () => {
    covers("setting:paged.tool.smooth.tolerance");
    const { fake, g } = harness({ hitTest: () => PATH });
    const dsl = g.tool(createSmoothHandler);
    await dsl.click([150, 150]).settle();
    fake.setToolSetting("paged.tool.smooth", "tolerance", 3);
    await dsl.click([150, 150]).settle();
    expect(
      fake
        .mutations()
        .map((m) => (m as { args: { tolerance: number } }).args.tolerance),
    ).toEqual([1.5, 3]);
  });
});
