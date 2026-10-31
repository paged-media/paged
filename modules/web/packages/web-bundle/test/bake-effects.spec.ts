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

// CSS effects onto native items (ADR 415) — one spec per mapping, at the
// planner and batch-op level. The end-to-end bake through the real engine and
// the real host is in conformance/bake-effects.spec.ts.

import { describe, expect, it } from "bun:test";

import type {
  SceneEffectGroup,
  SceneItem,
  SceneLayer,
  SceneLayerEffects,
  ScenePathItem,
  ScenePathSeg,
} from "@paged-media/web-model";

import { bakeBatchOps, sceneLayerToBakePlan } from "../src/bake-plan";

const RED = { r: 1, g: 0, b: 0, a: 1 };
const BLUE = { r: 0, g: 0, b: 1, a: 1 };
const M = { advance: 40, ascender: 9, descender: -3 };

const boxPath = (l: number, t: number, r: number, b: number) =>
  [
    { op: "moveTo", x: l, y: t },
    { op: "lineTo", x: r, y: t },
    { op: "lineTo", x: r, y: b },
    { op: "lineTo", x: l, y: b },
    { op: "close" },
  ] satisfies ScenePathSeg[];
const box = (l: number, t: number, r: number, b: number): ScenePathItem => ({
  kind: "fillPath",
  path: boxPath(l, t, r, b),
  paint: RED,
});
const text = (y: number): SceneItem => ({
  kind: "text",
  x: 0,
  y,
  text: "Hi",
  size: 12,
  paint: BLUE,
});
const group = (g: Partial<SceneEffectGroup>): SceneEffectGroup => ({
  start: 0,
  end: 1,
  opacity: 1,
  ...g,
});
const fx = (...groups: SceneEffectGroup[]): SceneLayerEffects => ({ groups });

/** The batch ops of one plan on page "uP" at the origin. */
const opsOf = (layer: SceneLayer, effects: SceneLayerEffects) => {
  const plan = sceneLayerToBakePlan(layer, [], effects);
  const batch = bakeBatchOps([
    {
      plan,
      pageId: "uP",
      top: 0,
      left: 0,
      metrics: plan.texts.map(() => M),
    },
  ]);
  return { plan, ...batch };
};
const propsOf = (ops: { op: string; args: unknown }[], path: string) =>
  ops
    .filter((o) => (o.args as { path?: string }).path === path)
    .map((o) => {
      const a = o.args as {
        elementId: { kind: string; id: string };
        value: { value: unknown };
      };
      return [a.elementId.kind, a.elementId.id, a.value.value];
    });

describe("CSS effects → native items @feat:plugin-web.css-effects", () => {
  it("opacity on one item multiplies into its own opacity", () => {
    const { plan, ops } = opsOf(
      { items: [{ ...box(0, 0, 10, 10), paint: { ...RED, a: 0.5 } }] },
      fx(group({ opacity: 0.5 })),
    );
    expect(plan.rects[0].opacity).toBe(25);
    expect(plan.groups).toBeUndefined();
    expect(propsOf(ops, "frameOpacity")).toEqual([["rectangle", "$h:r0", 25]]);
  });

  it("opacity on several items is the opacity of a native group of them", () => {
    const { plan, ops, handles } = opsOf(
      { items: [box(0, 0, 10, 10), text(30)] },
      fx(group({ opacity: 0.4, end: 2 })),
    );
    expect(plan.groups).toEqual([
      {
        members: [
          { kind: "rect", index: 0 },
          { kind: "text", index: 0 },
        ],
        opacity: 40,
      },
    ]);
    expect(handles.groups).toEqual(["g0"]);
    const create = ops.find((o) => o.op === "createGroup") as {
      args: { memberIds: unknown[]; clip?: boolean };
    };
    expect(create.args.memberIds).toEqual([
      { kind: "rectangle", id: "$h:r0" },
      { kind: "textFrame", id: "$h:t0" },
    ]);
    expect(create.args.clip).toBeUndefined();
    expect(propsOf(ops, "frameOpacity")).toEqual([["group", "$h:g0", 40]]);
  });

  it("filter: opacity() is element opacity", () => {
    const { plan } = opsOf(
      { items: [box(0, 0, 10, 10)] },
      fx(group({ opacity: 0.5, filters: [{ kind: "opacity", amount: 0.5 }] })),
    );
    expect(plan.rects[0].opacity).toBe(25);
    expect(plan.deferred).toEqual({});
  });

  it("mix-blend-mode sets the item's blend mode, or the group's", () => {
    const one = opsOf(
      { items: [box(0, 0, 10, 10)] },
      fx(group({ blend: "Multiply" })),
    );
    expect(propsOf(one.ops, "frameBlendMode")).toEqual([
      ["rectangle", "$h:r0", "Multiply"],
    ]);
    const two = opsOf(
      { items: [box(0, 0, 10, 10), box(20, 0, 30, 10)] },
      fx(group({ blend: "Screen", end: 2, isolate: true })),
    );
    expect(propsOf(two.ops, "frameBlendMode")).toEqual([
      ["group", "$h:g0", "Screen"],
    ]);
    expect(propsOf(two.ops, "groupIsolateBlending")).toEqual([
      ["group", "$h:g0", true],
    ]);
  });

  it("a blend inside a blend wraps the inner node, so both apply", () => {
    const { plan } = opsOf(
      { items: [box(0, 0, 10, 10)] },
      fx(group({ blend: "Multiply" }), group({ blend: "Screen", parent: 0 })),
    );
    expect(plan.rects[0].blend).toBe("Screen");
    expect(plan.groups).toEqual([
      { members: [{ kind: "rect", index: 0 }], blend: "Multiply" },
    ]);
  });

  it("filter: drop-shadow() is the item's native drop shadow", () => {
    const { plan, ops } = opsOf(
      { items: [box(0, 0, 10, 10)] },
      fx(
        group({
          filters: [
            {
              kind: "dropShadow",
              dx: 3,
              dy: 4,
              blur: 6,
              r: 0,
              g: 0,
              b: 0,
              a: 0.5,
            },
          ],
        }),
      ),
    );
    expect(plan.rects[0].shadow).toEqual({
      xOffset: 3,
      yOffset: 4,
      size: 6,
      opacityPct: 50,
      colorId: "Color/wb-000000",
    });
    expect(propsOf(ops, "frameDropShadowMode")).toEqual([
      ["rectangle", "$h:r0", "Drop"],
    ]);
  });

  it("a drop-shadow filter on text shadows the text frame", () => {
    const { plan } = opsOf(
      { items: [text(20)] },
      fx(
        group({
          filters: [
            {
              kind: "dropShadow",
              dx: 1,
              dy: 1,
              blur: 0,
              r: 1,
              g: 0,
              b: 0,
              a: 1,
            },
          ],
        }),
      ),
    );
    expect(plan.texts[0].shadow?.colorId).toBe("Color/wb-ff0000");
  });

  it("what has no native twin is deferred by key, never faked", () => {
    const { plan } = opsOf(
      { items: [box(0, 0, 10, 10), box(20, 0, 30, 10)] },
      {
        groups: [
          group({
            end: 2,
            filters: [
              { kind: "blur", radius: 2 },
              { kind: "color", function: "brightness", amount: 1.4 },
              { kind: "color", function: "sepia", amount: 1 },
              { kind: "url" },
              {
                kind: "dropShadow",
                dx: 1,
                dy: 1,
                blur: 1,
                r: 0,
                g: 0,
                b: 0,
                a: 1,
              },
            ],
            losses: ["mixBlendMode.plusLighter"],
          }),
        ],
        losses: { "cssEffect.inline": 2 },
      },
    );
    expect(plan.deferred).toEqual({
      "filter.blur": 1,
      "filter.brightness": 1,
      "filter.sepia": 1,
      "filter.url": 1,
      "filter.dropShadow.group": 1,
      "mixBlendMode.plusLighter": 1,
      "cssEffect.inline": 2,
    });
  });

  it("clip-path makes a clip group whose top member is the clip outline", () => {
    const clip = [
      { op: "moveTo" as const, x: 2, y: 2 },
      { op: "lineTo" as const, x: 8, y: 2 },
      { op: "lineTo" as const, x: 5, y: 8 },
      { op: "close" as const },
    ];
    const { plan, ops, handles } = opsOf(
      { items: [box(0, 0, 10, 10)] },
      fx(group({ clip })),
    );
    expect(plan.groups?.[0].members).toEqual([{ kind: "rect", index: 0 }]);
    expect(plan.groups?.[0].clip?.[0]).toHaveLength(3);
    expect(handles.clips).toEqual(["c0"]);
    const create = ops.find((o) => o.op === "createGroup") as {
      args: { memberIds: unknown[]; clip?: boolean };
    };
    expect(create.args.clip).toBe(true);
    expect(create.args.memberIds).toEqual([
      { kind: "rectangle", id: "$h:r0" },
      { kind: "polygon", id: "$h:c0" },
    ]);
    // The clip path is inserted before the group that takes it.
    const order = ops.map((o) => o.op);
    expect(order.indexOf("insertPath")).toBeLessThan(
      order.indexOf("createGroup"),
    );
  });

  it("a gradient mask is a luminosity opacity mask of the stops' alpha", () => {
    const { plan, ops } = opsOf(
      { items: [box(0, 0, 10, 10)] },
      fx(
        group({
          mask: [
            {
              kind: "fillPathGradient",
              path: boxPath(0, 0, 10, 10),
              gradient: {
                type: "linear",
                x0: 0,
                y0: 0,
                x1: 0,
                y1: 10,
                stops: [
                  { offset: 0, r: 0, g: 0, b: 0, a: 1 },
                  { offset: 1, r: 0, g: 0, b: 0, a: 0 },
                ],
              },
            },
          ],
        }),
      ),
    );
    expect(plan.masks).toHaveLength(1);
    const mask = plan.masks![0];
    expect(mask.kind).toBe("gradient");
    // White (opaque) to black (clear).
    const g = plan.gradients.find(
      (x) => mask.kind === "gradient" && x.id === mask.gradientId,
    );
    expect(g?.stops.map((s) => s.colorId)).toEqual([
      "Color/wb-ffffff",
      "Color/wb-000000",
    ]);
    const apply = ops.find((o) => o.op === "applyOpacityMask") as {
      args: { targetId: unknown; maskId: unknown; maskType: string };
    };
    expect(apply.args).toEqual({
      targetId: { kind: "rectangle", id: "$h:r0" },
      maskId: { kind: "rectangle", id: "$h:m0" },
      maskType: "luminosity",
    });
  });

  it("a mask on text or on several items is deferred", () => {
    const mask: SceneItem[] = [
      {
        kind: "image",
        rgba: new Uint8Array(4),
        width: 1,
        height: 1,
        x: 0,
        y: 0,
        w: 10,
        h: 10,
      },
    ];
    expect(
      opsOf({ items: [text(10)] }, fx(group({ mask }))).plan.deferred,
    ).toEqual({ "mask.text": 1 });
    expect(
      opsOf(
        { items: [box(0, 0, 10, 10), box(20, 0, 30, 10)] },
        fx(group({ mask, end: 2 })),
      ).plan.deferred,
    ).toEqual({ "mask.group": 1 });
  });

  it("an inset box shadow is the inner shadow of the box it is cast in", () => {
    const { plan, ops } = opsOf(
      {
        items: [
          box(0, 0, 40, 30),
          {
            kind: "innerShadow",
            // The border box moved by the CSS offset (4px 3px in points).
            path: boxPath(4, 3, 44, 33),
            offset_x: 0,
            offset_y: 0,
            blur_radius: 6,
            choke: 0,
            r: 0,
            g: 0,
            b: 0,
            a: 0.6,
          },
        ],
      },
      fx(),
    );
    expect(plan.rects[0].innerShadow).toEqual({
      // IDML casts at (-d·cos a, d·sin a): (4, 3) is the light at 143.13°.
      angle: 143.13,
      distance: 5,
      size: 6,
      opacityPct: 60,
      colorId: "Color/wb-000000",
    });
    expect(propsOf(ops, "frameInnerShadowBlendMode")).toEqual([
      ["rectangle", "$h:r0", "Normal"],
    ]);
    expect(plan.deferred).toEqual({});
  });

  it("nested groups bake children first and become members of their parent", () => {
    const { plan, ops } = opsOf(
      { items: [box(0, 0, 10, 10), box(20, 0, 30, 10), text(40)] },
      fx(
        group({ opacity: 0.5, end: 3 }),
        group({ blend: "Multiply", start: 0, end: 2, parent: 0 }),
      ),
    );
    expect(plan.groups).toEqual([
      {
        members: [
          { kind: "rect", index: 0 },
          { kind: "rect", index: 1 },
        ],
        blend: "Multiply",
      },
      {
        members: [
          { kind: "group", index: 0 },
          { kind: "text", index: 0 },
        ],
        opacity: 50,
      },
    ]);
    const creates = ops.filter((o) => o.op === "createGroup") as {
      args: { memberIds: unknown[] };
    }[];
    expect(creates[1].args.memberIds).toEqual([
      { kind: "group", id: "$h:g0" },
      { kind: "textFrame", id: "$h:t0" },
    ]);
  });

  it("without effects the plan and the batch are what they were", () => {
    const layer: SceneLayer = { items: [box(0, 0, 10, 10)] };
    const before = sceneLayerToBakePlan(layer);
    const after = sceneLayerToBakePlan(layer, [], { groups: [] });
    expect(after).toEqual(before);
  });
});
