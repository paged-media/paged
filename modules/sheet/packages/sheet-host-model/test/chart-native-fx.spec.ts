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

// Sheet ADR 527 — a chart role's gradient, translucency and effects, as the
// shared DrawingML mapper lowered them in Rust (`fx` on a primitive), onto
// the native page item: a content-addressed gradient swatch, its placement
// in the page's spread, the opacity, the drop and inner shadow, the glow,
// the soft edge and the gradient feather.

import { describe, expect, it } from "bun:test";

import type { Mutation } from "@paged-media/plugin-api";

import {
  chartGeometryToMutations,
  chartGradientId,
  distinctChartHexes,
  makeBinding,
  paletteSwatchId,
  type ChartGeometry,
  type NativeFx,
} from "../src";

type Op = { op: string; args: Record<string, unknown> };

const fx: NativeFx = {
  gradient: {
    kind: "linear",
    stops: [
      [0, "#4472C4"],
      [100, "#203864"],
    ],
    angle: -90,
    length: 100,
    start: [30, 20],
  },
  opacity: 80,
  dropShadow: {
    xOffset: 2,
    yOffset: 2,
    size: 2,
    opacity: 40,
    color: "#000000",
  },
  innerShadow: {
    angle: 135,
    distance: 4,
    size: 2.5,
    opacity: 50,
    color: "#000000",
  },
  outerGlow: { size: 5, opacity: 60, color: "#FFC000" },
  feather: 2.5,
  gradientFeather: {
    gradientType: "Linear",
    angle: -90,
    stops: [
      [0, 100],
      [100, 25],
    ],
  },
};

const geom = (f: NativeFx = fx): ChartGeometry => ({
  widthPt: 300,
  heightPt: 200,
  prims: [
    {
      kind: "rect",
      x: 10,
      y: 20,
      w: 40,
      h: 100,
      fill: "#4472C4",
      stroke: null,
      strokeW: 0,
      fx: f,
    },
    {
      kind: "rect",
      x: 60,
      y: 20,
      w: 40,
      h: 100,
      fill: "#4472C4",
      stroke: null,
      strokeW: 0,
      fx: f,
    },
    {
      kind: "line",
      pts: [
        [0, 0],
        [10, 10],
      ],
      stroke: "#000000",
      strokeW: 1,
      fx: f,
    },
  ],
  losses: [
    "pattern fill drawn as the mix of its two colours (no pattern paint yet)",
  ],
});

const lower = (
  g: ChartGeometry,
  pageOrigin?: [number, number],
  known?: ReadonlySet<string> | null,
): Op[] => {
  const { batch } = chartGeometryToMutations(
    g,
    {
      pageId: "Page/u1",
      bounds: [10, 20, 210, 320],
      ...(pageOrigin ? { pageOrigin } : {}),
    },
    makeBinding("Sheet1", "chart:0", 0),
    known,
  );
  return (batch as Mutation & { args: { ops: Op[] } }).args.ops;
};

const props = (ops: Op[]) =>
  ops
    .filter((o) => o.op === "setElementProperty")
    .map((o) => [o.args.path, (o.args.value as { value: unknown }).value]);

describe("chart native effects [sheet.chart.native-effects]", () => {
  it("mints the gradient once, after its stop colours, and paints with it", () => {
    const ops = lower(geom());
    const grads = ops.filter((o) => o.op === "createGradient");
    expect(grads).toHaveLength(1);
    const id = chartGradientId(fx.gradient!);
    expect(id).toBe("Gradient/uPagedSheetChartL-0-4472C4-100-203864");
    const spec = grads[0].args.spec as {
      selfId: string;
      kind: string;
      stops: unknown[];
    };
    expect(spec.selfId).toBe(id);
    expect(spec.kind).toBe("Linear");
    expect(spec.stops).toEqual([
      { stopColor: paletteSwatchId("chart", "4472C4"), locationPct: 0 },
      { stopColor: paletteSwatchId("chart", "203864"), locationPct: 100 },
    ]);
    // The stop colours are minted before the gradient that names them.
    const firstGrad = ops.findIndex((o) => o.op === "createGradient");
    const mints = ops
      .map((o, i) => [o, i] as const)
      .filter(([o]) => o.op === "createSwatch")
      .map(([, i]) => i);
    expect(Math.max(...mints)).toBeLessThan(firstGrad);
    expect(distinctChartHexes(geom())).toEqual(
      expect.arrayContaining(["4472C4", "203864", "000000", "FFC000"]),
    );
    const fills = props(ops).filter(([p]) => p === "frameFillColor");
    expect(fills).toEqual([
      ["frameFillColor", id],
      ["frameFillColor", id],
    ]);
  });

  it("places the gradient in the spread and carries the effects", () => {
    const ops = lower(geom(), [612, 0]);
    const p = props(ops);
    // Rect 1: chart origin (20, 10) page-local + page origin (612, 0).
    expect(p).toContainEqual([
      "frameGradientFillStart",
      [612 + 20 + 30, 0 + 10 + 20],
    ]);
    expect(p).toContainEqual(["frameGradientFillAngle", -90]);
    expect(p).toContainEqual(["frameGradientFillLength", 100]);
    expect(p).toContainEqual(["frameOpacity", 80]);
    expect(p).toContainEqual(["frameDropShadow", true]);
    expect(p).toContainEqual(["frameDropShadowSize", 2]);
    expect(p).toContainEqual([
      "frameDropShadowColor",
      paletteSwatchId("chart", "000000"),
    ]);
    expect(p).toContainEqual(["frameInnerShadowEnabled", true]);
    expect(p).toContainEqual(["frameInnerShadowAngle", 135]);
    expect(p).toContainEqual(["frameInnerShadowDistance", 4]);
    expect(p).toContainEqual(["frameOuterGlowEnabled", true]);
    expect(p).toContainEqual([
      "frameOuterGlowColor",
      paletteSwatchId("chart", "FFC000"),
    ]);
    expect(p).toContainEqual(["frameFeatherWidth", 2.5]);
    expect(p).toContainEqual([
      "frameGradientFeather",
      {
        gradientType: "Linear",
        angleDeg: -90,
        stops: [
          { locationPct: 0, alphaPct: 100 },
          { locationPct: 100, alphaPct: 25 },
        ],
      },
    ]);
  });

  it("writes no start without the page's origin, and a line takes no gradient", () => {
    const p = props(lower(geom()));
    expect(p.some(([k]) => k === "frameGradientFillStart")).toBe(false);
    // Two filled rects carry the gradient's angle; the line does not.
    expect(p.filter(([k]) => k === "frameGradientFillAngle")).toHaveLength(2);
    expect(p.filter(([k]) => k === "frameGradientFeather")).toHaveLength(2);
    // Each of the three items carries the shadow.
    expect(p.filter(([k]) => k === "frameDropShadow")).toHaveLength(3);
  });

  it("references a gradient the document has and mints nothing on a failed read", () => {
    const id = chartGradientId(fx.gradient!);
    expect(
      lower(geom(), undefined, new Set([id])).some(
        (o) => o.op === "createGradient",
      ),
    ).toBe(false);
    const failed = lower(geom(), undefined, null);
    expect(
      failed.some((o) => o.op === "createGradient" || o.op === "createSwatch"),
    ).toBe(false);
  });

  it("a primitive without fx lowers as before", () => {
    const plain = lower(geom({}));
    expect(plain.some((o) => o.op === "createGradient")).toBe(false);
    const p = props(plain);
    expect(p.some(([k]) => String(k).startsWith("frameDropShadow"))).toBe(
      false,
    );
  });
  it("writes the effect stack after the effects its InDesign entries name", () => {
    const stacked: NativeFx = {
      dropShadow: fx.dropShadow,
      gradientFeather: fx.gradientFeather,
      effectStack: [
        { kind: "dropShadow" },
        { kind: "gradientFeather" },
        { kind: "colorOverlay", blendMode: "Multiply", color: "#ED7D31" },
        { kind: "gaussianBlur", radiusPt: 1 },
        { kind: "reflection", sizePct: 55, startOpacityPct: 50 },
      ],
    };
    const ops = lower(geom(stacked));
    const p = props(ops);
    const stacks = p.filter(([path]) => path === "frameEffectStack");
    // Two rects and the line.
    expect(stacks).toHaveLength(3);
    const entries = (stacks[0][1] as { entries: { kind: string }[] }).entries;
    expect(entries.map((e) => e.kind)).toEqual([
      "dropShadow",
      "gradientFeather",
      "colorOverlay",
      "gaussianBlur",
      "reflection",
    ]);
    expect(entries[2]).toEqual({
      kind: "colorOverlay",
      blendMode: "Multiply",
      color: paletteSwatchId("chart", "ED7D31"),
    });
    // A line draws no gradient feather: its stack names none.
    const line = (stacks[2][1] as { entries: { kind: string }[] }).entries;
    expect(line.map((e) => e.kind)).not.toContain("gradientFeather");
    // The stack comes after the drop shadow it orders.
    const at = (path: string) => p.findIndex(([q]) => q === path);
    expect(at("frameDropShadow")).toBeLessThan(at("frameEffectStack"));
    expect(distinctChartHexes(geom(stacked))).toContain("ED7D31");
  });
});
