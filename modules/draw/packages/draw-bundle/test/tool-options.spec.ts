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

// EVERY paged.draw TOOL OPTION, with no engine: the value the host's
// tool-settings store holds (what the tool-options popover writes) reaches
// what the tool sends, and the default is the tool as it shipped. Each
// test draws the same gesture twice — once on the defaults, once with the
// one option changed — and names the difference the option must make.
// The engine-backed proof that the geometry follows is
// `test/headless/tool-options.spec.ts`.

import { describe, expect, it } from "bun:test";

import type { ElementId, Mutation } from "@paged-media/plugin-api";
import { covers, gestures, type GestureDsl } from "@paged-media/test-kit";

import { openEl, rectEl, unitRig, type UnitRig } from "./commands/unit-kit";

const T = "media.paged.draw.tool";
const A = { kind: "polygon", id: "ua" } as ElementId;
const POLY = { kind: "polygon", id: "upoly" } as ElementId;

const doc = () => [
  rectEl("polygon", "ua", [100, 100, 300, 300]),
  rectEl("polygon", "ub", [200, 200, 400, 400]),
  openEl("upoly", [
    [100, 500],
    [250, 650],
    [400, 500],
  ]),
];

type Value = number | string | boolean;

/**
 * Arm `tool` over a host whose tool-settings store holds `values` (the
 * structural door the bundle probes, `toolSettingsDoorOf`), run `gesture`
 * and hand back what it sent.
 */
async function withOptions(
  tool: string,
  selection: ElementId[],
  values: Record<string, Value>,
  gesture: (g: GestureDsl) => GestureDsl,
): Promise<UnitRig> {
  const r = unitRig(doc(), { selection });
  const store: Record<string, Value> = { ...values };
  Object.assign(r.fake.editor, {
    toolSettings: {
      getValue: (_tool: string, key: string) => store[key],
      // The tool seeds each still-unset default into the store.
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

const inserted = (r: UnitRig) =>
  r.leaves().find((m) => m.op === "insertPath") as
    | (Mutation & {
        args: {
          anchors: { anchor: number[]; left: number[] }[];
          open: boolean;
        };
      })
    | undefined;

const widths = (r: UnitRig): number[] => {
  const write = r
    .leaves()
    .find(
      (m) =>
        (m as { args?: { path?: string } }).args?.path ===
        "outlineStrokeVariable",
    ) as { args: { value: { value: { widths: number[] } } } } | undefined;
  return write?.args.value.value.widths ?? [];
};

const max = (xs: number[]) => Math.max(...xs);
const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

/** A long stroke with small wiggles: the fidelity tolerance decides how
 *  many of them survive. */
const wiggle = (g: GestureDsl) =>
  g.drag({
    from: [100, 700],
    to: [460, 700],
    via: Array.from({ length: 17 }, (_, i) => [
      120 + i * 20,
      i % 2 === 0 ? 696 : 704,
    ]) as [number, number][],
    steps: 2,
  });

/** A smooth arc through three points. */
const arc = (g: GestureDsl) =>
  g.drag({
    from: [100, 700],
    to: [400, 720],
    via: [
      [200, 690],
      [300, 730],
    ],
    steps: 24,
  });

describe("paged.draw tool options, no engine — Paintbrush", () => {
  it("size: a bigger nib sweeps wider", async () => {
    covers("setting:media.paged.draw.tool.paintbrush.size");
    const base = widths(await withOptions(`${T}.paintbrush`, [], {}, arc));
    const big = widths(
      await withOptions(`${T}.paintbrush`, [], { size: 20 }, arc),
    );
    expect(max(big)).toBeGreaterThan(max(base) * 2);
  });

  it("angle: turning the flat nib changes the width it sweeps along the same stroke", async () => {
    covers("setting:media.paged.draw.tool.paintbrush.angle");
    const base = widths(await withOptions(`${T}.paintbrush`, [], {}, arc));
    const turned = widths(
      await withOptions(`${T}.paintbrush`, [], { angle: 0 }, arc),
    );
    expect(turned).not.toEqual(base);
  });

  it("roundness: a round nib (100 %) sweeps one width everywhere; the default flat nib does not", async () => {
    covers("setting:media.paged.draw.tool.paintbrush.roundness");
    expect(
      spread(widths(await withOptions(`${T}.paintbrush`, [], {}, arc))),
    ).toBeGreaterThan(0.1);
    expect(
      spread(
        widths(
          await withOptions(`${T}.paintbrush`, [], { roundness: 100 }, arc),
        ),
      ),
    ).toBeLessThan(0.01);
  });

  it("fidelity: a coarser tolerance keeps fewer anchors of a wiggly stroke", async () => {
    covers("setting:media.paged.draw.tool.paintbrush.fidelity");
    const fine = await withOptions(
      `${T}.paintbrush`,
      [],
      { fidelity: 0.5 },
      wiggle,
    );
    const coarse = await withOptions(
      `${T}.paintbrush`,
      [],
      { fidelity: 20 },
      wiggle,
    );
    expect(inserted(coarse)!.args.anchors.length).toBeLessThan(
      inserted(fine)!.args.anchors.length,
    );
  });
});

describe("paged.draw tool options, no engine — Blob Brush", () => {
  const over = (g: GestureDsl) =>
    g.drag({
      from: [150, 150],
      to: [250, 160],
      via: [[200, 140]],
      steps: 12,
    });

  it("size: a bigger nib sweeps wider", async () => {
    covers("setting:media.paged.draw.tool.blobBrush.size");
    const base = widths(await withOptions(`${T}.blobBrush`, [A], {}, over));
    const big = widths(
      await withOptions(`${T}.blobBrush`, [A], { size: 20 }, over),
    );
    expect(max(big)).toBeGreaterThan(max(base) * 2);
  });

  it("angle: turning the flat nib changes the width it sweeps", async () => {
    covers("setting:media.paged.draw.tool.blobBrush.angle");
    const base = widths(await withOptions(`${T}.blobBrush`, [A], {}, over));
    const turned = widths(
      await withOptions(`${T}.blobBrush`, [A], { angle: 0 }, over),
    );
    expect(turned).not.toEqual(base);
  });

  it("roundness: a round nib sweeps one width everywhere", async () => {
    covers("setting:media.paged.draw.tool.blobBrush.roundness");
    expect(
      spread(
        widths(
          await withOptions(`${T}.blobBrush`, [A], { roundness: 100 }, over),
        ),
      ),
    ).toBeLessThan(0.01);
  });

  it("fidelity: a coarser tolerance keeps fewer anchors of a wiggly stroke", async () => {
    covers("setting:media.paged.draw.tool.blobBrush.fidelity");
    const fine = await withOptions(
      `${T}.blobBrush`,
      [A],
      { fidelity: 0.5 },
      wiggle,
    );
    const coarse = await withOptions(
      `${T}.blobBrush`,
      [A],
      { fidelity: 20 },
      wiggle,
    );
    expect(inserted(coarse)!.args.anchors.length).toBeLessThan(
      inserted(fine)!.args.anchors.length,
    );
  });
});

describe("paged.draw tool options, no engine — Eraser", () => {
  const cut = (g: GestureDsl) =>
    g.drag({ from: [50, 200], to: [350, 210], steps: 12 });
  const outlineWidth = (r: UnitRig) =>
    (
      r.leaves().find((m) => m.op === "outlineStroke") as {
        args: { width: number };
      }
    ).args.width;

  it("size: the cut's width is the eraser's size (6 pt by default)", async () => {
    covers("setting:media.paged.draw.tool.eraserBrush.size");
    expect(
      outlineWidth(await withOptions(`${T}.eraserBrush`, [A], {}, cut)),
    ).toBe(6);
    expect(
      outlineWidth(
        await withOptions(`${T}.eraserBrush`, [A], { size: 20 }, cut),
      ),
    ).toBe(20);
  });

  it("fidelity: a coarser tolerance keeps fewer anchors of a wiggly cut", async () => {
    covers("setting:media.paged.draw.tool.eraserBrush.fidelity");
    const zig = (g: GestureDsl) =>
      g.drag({
        from: [50, 200],
        to: [350, 200],
        via: Array.from({ length: 13 }, (_, i) => [
          70 + i * 20,
          i % 2 === 0 ? 196 : 204,
        ]) as [number, number][],
        steps: 2,
      });
    const fine = await withOptions(
      `${T}.eraserBrush`,
      [A],
      { fidelity: 0.5 },
      zig,
    );
    const coarse = await withOptions(
      `${T}.eraserBrush`,
      [A],
      { fidelity: 20 },
      zig,
    );
    expect(inserted(coarse)!.args.anchors.length).toBeLessThan(
      inserted(fine)!.args.anchors.length,
    );
  });
});

describe("paged.draw tool options, no engine — Width", () => {
  const pull = (g: GestureDsl) =>
    g.drag({ from: [250, 650], to: [250, 700], steps: 4 });

  it("maxWidth: the bulge is capped at it (72 pt by default)", async () => {
    covers("setting:media.paged.draw.tool.width.maxWidth");
    const base = widths(await withOptions(`${T}.width`, [POLY], {}, pull));
    const capped = widths(
      await withOptions(`${T}.width`, [POLY], { maxWidth: 10 }, pull),
    );
    expect(max(capped)).toBe(10);
    expect(max(base)).toBeGreaterThan(10);
  });

  it("gain: a higher gain makes the same drag a wider bulge", async () => {
    covers("setting:media.paged.draw.tool.width.gain");
    const base = widths(await withOptions(`${T}.width`, [POLY], {}, pull));
    const strong = widths(
      await withOptions(`${T}.width`, [POLY], { gain: 3 }, pull),
    );
    expect(max(strong)).toBeGreaterThan(max(base));
  });

  it("falloff: at 0 the bulge stays on its anchor; by default it spreads to the neighbours", async () => {
    covers("setting:media.paged.draw.tool.width.falloff");
    const base = widths(await withOptions(`${T}.width`, [POLY], {}, pull));
    const sharp = widths(
      await withOptions(`${T}.width`, [POLY], { falloff: 0 }, pull),
    );
    expect(sharp[0]!).toBeLessThan(base[0]!);
    expect(sharp[1]).toBe(base[1]);
  });
});

describe("paged.draw tool options, no engine — Lasso Select", () => {
  /** A lasso over x, y 250..450: it touches the first quad (100..300)
   *  but not its centre (200, 200); the second quad's centre is inside. */
  const lasso = (g: GestureDsl) =>
    g.drag({
      from: [250, 250],
      to: [250, 450],
      via: [
        [450, 250],
        [450, 450],
      ],
      steps: 12,
    });
  const selected = (r: UnitRig) =>
    r.fake
      .selection()
      .map((e) => String(e.id))
      .sort();

  it("mode: Touched (the default) selects both quads; Centre inside selects only the second", async () => {
    covers("setting:media.paged.draw.tool.lassoSelect.mode");
    expect(
      selected(await withOptions(`${T}.lassoSelect`, [], {}, lasso)),
    ).toEqual(["ua", "ub"]);
    expect(
      selected(
        await withOptions(`${T}.lassoSelect`, [], { mode: "centre" }, lasso),
      ),
    ).toEqual(["ub"]);
  });
});

describe("paged.draw tool options, no engine — Star and Reshape [plugin-draw.tool-wave-3]", () => {
  const starDrag = (g: GestureDsl) =>
    g.drag({ from: [500, 600], to: [500, 560], steps: 4 });
  const radii = (r: UnitRig) =>
    inserted(r)!.args.anchors.map((a) =>
      Math.hypot(a.anchor[0]! - 500, a.anchor[1]! - 600),
    );
  /** A live star's write (engine ADR 1047): the star a drag makes is
   *  the polygon on Radius 1 plus its points and inset. */
  const shape = (r: UnitRig, path: string) =>
    (
      r.leaves().find((m) => (m.args as { path?: string }).path === path)!
        .args as {
        value: { value: number };
      }
    ).value.value;

  it("points: the star a drag starts with has that many tips", async () => {
    covers("setting:media.paged.draw.tool.star.points");
    const base = await withOptions(`${T}.star`, [], {}, starDrag);
    expect(inserted(base)!.args.anchors).toHaveLength(5);
    expect(shape(base, "frameShapeSides")).toBe(5);
    const eight = await withOptions(`${T}.star`, [], { points: 8 }, starDrag);
    expect(inserted(eight)!.args.anchors).toHaveLength(8);
    expect(shape(eight, "frameShapeSides")).toBe(8);
  });

  it("radius2: the valleys sit at that percentage of Radius 1", async () => {
    covers("setting:media.paged.draw.tool.star.radius2");
    // The outer points sit on Radius 1; the valleys are the inset's
    // 1 − inset/100 of it.
    const baseRig = await withOptions(`${T}.star`, [], {}, starDrag);
    const base = radii(baseRig);
    expect(base[0]).toBeCloseTo(40, 6);
    expect(40 * (1 - shape(baseRig, "frameShapeStarInset") / 100)).toBeCloseTo(
      20,
      6,
    );
    const deepRig = await withOptions(
      `${T}.star`,
      [],
      { radius2: 25 },
      starDrag,
    );
    expect(radii(deepRig)[0]).toBeCloseTo(40, 6);
    expect(40 * (1 - shape(deepRig, "frameShapeStarInset") / 100)).toBeCloseTo(
      10,
      6,
    );
  });

  it("radius: a small falloff moves only the dragged anchor; a wide one carries its neighbours", async () => {
    covers("setting:media.paged.draw.tool.reshape.radius");
    const pull = (g: GestureDsl) =>
      g
        .down([250, 650])
        .settle()
        .move([250, 630])
        .settle()
        .up([250, 610])
        .settle()
        .settle();
    const table = (r: UnitRig) =>
      (
        r
          .leaves()
          .find(
            (m) =>
              (m as { args?: { path?: string } }).args?.path === "framePath",
          ) as {
          args: { value: { value: { anchors: { anchor: number[] }[] } } };
        }
      ).args.value.value.anchors.map((a) => a.anchor);
    // The neighbours are 212 pt away along the path: past the 72 pt
    // default, inside 400.
    const wide = table(
      await withOptions(`${T}.reshape`, [], { radius: 400 }, pull),
    );
    expect(wide[0]![1]).toBeLessThan(500);
    const tight = table(
      await withOptions(`${T}.reshape`, [], { radius: 1 }, pull),
    );
    expect(tight[0]).toEqual([100, 500]);
    expect(tight[1]).toEqual([250, 610]);
  });
});
