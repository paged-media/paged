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

// Extensions ADR 347 — the lowering kit's look translator: one NativeFx
// (dml-native's wire form) to the frame paths, for a page item and for an
// anchored frame alike; the gradient swatch id and its mint; the one label
// escape.

import { describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";

import {
  escapeLabelValue,
  nativeFxColors,
  nativeFxOps,
  nativeGradientId,
  nativeGradientMintOps,
  type NativeFx,
} from "../src/index.js";

type Op = {
  op: string;
  args: { elementId: ElementId; path: string; value: unknown };
};

const target: ElementId = { kind: "rectangle", id: "$h:pic" };
const color = (hex: string) => `Color/t-${hex.slice(1)}`;

const full: NativeFx = {
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
  stroke: {
    color: "#FFFFFF",
    weight: 4,
    kind: "StrokeStyle/$ID/Dashed",
    dash: [6, 3],
    cap: "RoundEndCap",
    join: "BevelEndJoin",
    miterLimit: 8,
  },
  opacity: 80,
  dropShadow: {
    xOffset: 2,
    yOffset: 3,
    size: 4,
    opacity: 40,
    color: "#000000",
  },
  innerShadow: {
    angle: 135,
    distance: 4,
    size: 2.5,
    opacity: 50,
    color: "#111111",
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

const paths = (ops: unknown[]) => (ops as Op[]).map((o) => o.args.path);
const value = (ops: unknown[], path: string) =>
  (ops as Op[]).find((o) => o.args.path === path)?.args.value;

describe("[plugin-platform.lowering-kit] nativeFxOps", () => {
  it("writes every part of a look on the target, in a fixed order", () => {
    const ops = nativeFxOps(full, {
      target,
      color,
      gradient: (g) => nativeGradientId("Gradient/t", g),
      origin: [100, 200],
    });
    for (const o of ops as unknown as Op[]) {
      expect(o.op).toBe("setElementProperty");
      expect(o.args.elementId).toEqual(target);
    }
    expect(paths(ops)).toEqual([
      "frameFillColor",
      "frameGradientFillAngle",
      "frameGradientFillLength",
      "frameGradientFillStart",
      "frameStrokeColor",
      "frameStrokeWeight",
      "frameStrokeType",
      "frameStrokeDashArray",
      "frameStrokeEndCap",
      "frameStrokeJoin",
      "frameStrokeMiterLimit",
      "frameOpacity",
      "frameDropShadow",
      "frameDropShadowXOffset",
      "frameDropShadowYOffset",
      "frameDropShadowSize",
      "frameDropShadowOpacity",
      "frameDropShadowColor",
      "frameInnerShadowEnabled",
      "frameInnerShadowBlendMode",
      "frameInnerShadowAngle",
      "frameInnerShadowDistance",
      "frameInnerShadowSize",
      "frameInnerShadowOpacity",
      "frameInnerShadowColor",
      "frameOuterGlowEnabled",
      "frameOuterGlowBlendMode",
      "frameOuterGlowSize",
      "frameOuterGlowOpacity",
      "frameOuterGlowColor",
      "frameFeatherEnabled",
      "frameFeatherWidth",
      "frameGradientFeather",
    ]);
    expect(value(ops, "frameFillColor")).toEqual({
      type: "colorRef",
      value: "Gradient/tL-0-4472C4-100-203864",
    });
    expect(value(ops, "frameGradientFillStart")).toEqual({
      type: "lengths",
      value: [130, 220],
    });
    expect(value(ops, "frameStrokeColor")).toEqual({
      type: "colorRef",
      value: "Color/t-FFFFFF",
    });
    expect(value(ops, "frameStrokeDashArray")).toEqual({
      type: "lengths",
      value: [6, 3],
    });
    expect(value(ops, "frameGradientFeather")).toEqual({
      type: "gradientFeather",
      value: {
        gradientType: "Linear",
        angleDeg: -90,
        stops: [
          { locationPct: 0, alphaPct: 100 },
          { locationPct: 100, alphaPct: 25 },
        ],
      },
    });
  });

  it("leaves the fill to the module without a gradient swatch, and the start without an origin", () => {
    const ops = nativeFxOps(full, { target, color });
    expect(paths(ops)).not.toContain("frameFillColor");
    expect(paths(ops)).not.toContain("frameGradientFillStart");
    expect(paths(ops)).toContain("frameGradientFillAngle");
  });

  it("an unfilled item takes neither gradient nor gradient feather", () => {
    const ops = nativeFxOps(
      { ...full, fill: "#FF0000" },
      { target, color, filled: false },
    );
    for (const p of [
      "frameFillColor",
      "frameGradientFillAngle",
      "frameGradientFeather",
    ])
      expect(paths(ops)).not.toContain(p);
    expect(paths(ops)).toContain("frameDropShadow");
  });

  it("a solid fill paints with its swatch", () => {
    const ops = nativeFxOps({ fill: "#00FF00" }, { target, color });
    expect(ops).toEqual([
      {
        op: "setElementProperty",
        args: {
          elementId: target,
          path: "frameFillColor",
          value: { type: "colorRef", value: "Color/t-00FF00" },
        },
      },
    ]);
  });

  it("nothing for no look", () => {
    expect(nativeFxOps(undefined, { target, color })).toEqual([]);
    expect(nativeFxOps({}, { target, color })).toEqual([]);
  });

  it("names every colour it paints with", () => {
    expect(nativeFxColors(full)).toEqual([
      "#4472C4",
      "#203864",
      "#FFFFFF",
      "#000000",
      "#111111",
      "#FFC000",
    ]);
    expect(nativeFxColors(full, false)).not.toContain("#4472C4");
  });
});

describe("[plugin-platform.lowering-kit] gradient swatches", () => {
  const g = full.gradient!;

  it("are content-addressed by kind and stops", () => {
    expect(nativeGradientId("Gradient/x", g)).toBe(
      "Gradient/xL-0-4472C4-100-203864",
    );
    expect(
      nativeGradientId("Gradient/x", {
        kind: "radial",
        stops: [
          [12.5, "#abc"],
          [100, "#000000"],
        ],
      }),
    ).toBe("Gradient/xR-12p5-AABBCC-100-000000");
  });

  it("mint once each, skip what the document holds, and nothing on a failed read", () => {
    const opts = {
      prefix: "Gradient/x",
      color,
      name: (n: number) => `g${n}`,
    };
    const ops = nativeGradientMintOps([g, g], opts);
    expect(ops).toHaveLength(1);
    expect(
      (ops[0] as unknown as { args: { spec: unknown } }).args.spec,
    ).toEqual({
      selfId: "Gradient/xL-0-4472C4-100-203864",
      name: "g1",
      kind: "Linear",
      stops: [
        { stopColor: "Color/t-4472C4", locationPct: 0 },
        { stopColor: "Color/t-203864", locationPct: 100 },
      ],
    });
    expect(
      nativeGradientMintOps([g], {
        ...opts,
        known: new Set(["Gradient/xL-0-4472C4-100-203864"]),
      }),
    ).toEqual([]);
    expect(nativeGradientMintOps([g], { ...opts, known: null })).toEqual([]);
  });
});

describe("[plugin-platform.lowering-kit] the one label escape", () => {
  it("escapes from U+007F up, surrogate pairs as two escapes", () => {
    expect(escapeLabelValue('{"a":"x\u007fé😀"}')).toBe(
      '{"a":"x\\u007f\\u00e9\\ud83d\\ude00"}',
    );
    expect(escapeLabelValue("~ plain ASCII")).toBe("~ plain ASCII");
    const v = { note: "Grüße\u007f" };
    expect(JSON.parse(escapeLabelValue(JSON.stringify(v)))).toEqual(v);
  });
});
