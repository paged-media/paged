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

// THE PATH, STROKE AND FILL COMMANDS with no engine (`unit-kit.ts`): what
// each one sends for the selection, as how many writes, and that it sends
// nothing where it does not apply. The engine's answer to the same
// commands is `test/headless/commands-path.spec.ts`.

import { describe, expect, it } from "bun:test";

import type { ElementId, Mutation } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import { openEl, rectEl, unitRig, type FakeElement } from "./unit-kit";

const C = "media.paged.draw.command";
const RECT = { kind: "rectangle", id: "urect" } as ElementId;
const POLY = { kind: "polygon", id: "upoly" } as ElementId;
const LINE = { kind: "graphicLine", id: "uline" } as ElementId;
const OVAL = { kind: "oval", id: "uoval" } as ElementId;

/** F1's shapes: a stroked rectangle, an open 3-anchor polygon, a line,
 *  and an oval (which no path command accepts). */
const doc = (): FakeElement[] => [
  rectEl("rectangle", "urect", [100, 100, 300, 300], {
    frameStrokeWeight: { type: "length", value: 3 },
  }),
  openEl("upoly", [
    [100, 400],
    [250, 600],
    [400, 400],
  ]),
  openEl(
    "uline",
    [
      [650, 100],
      [700, 400],
    ],
    {},
    "graphicLine",
  ),
  { id: OVAL, bounds: [500, 500, 560, 560] }, // top, left, bottom, right
];

const rig = (selection: ElementId[]) => unitRig(doc(), { selection });

const set = (
  m: Mutation,
): { elementId?: ElementId; path?: string; value?: unknown } =>
  (m as unknown as { args: Record<string, never> }).args;

describe("paged.draw commands, no engine — stroke dashes", () => {
  const dash = async (id: string, lengths: number[]) => {
    const r = rig([RECT]);
    await r.run(id);
    expect(r.sent()).toEqual([
      {
        op: "setElementProperty",
        args: {
          elementId: RECT,
          path: "frameStrokeDashArray",
          value: { type: "lengths", value: lengths },
        },
      },
    ]);
    expect(r.steps()).toBe(1);
    const none = rig([]);
    await none.run(id);
    expect(none.sent()).toEqual([]);
  };

  it("Stroke: Solid writes an empty dash array to the selection; nothing selected sends nothing", async () => {
    covers("command:media.paged.draw.command.strokeDashSolid");
    await dash(`${C}.strokeDashSolid`, []);
  });

  it("Stroke: Dashed writes 6/3", async () => {
    covers("command:media.paged.draw.command.strokeDashDashed");
    await dash(`${C}.strokeDashDashed`, [6, 3]);
  });

  it("Stroke: Dotted writes 1/3", async () => {
    covers("command:media.paged.draw.command.strokeDashDotted");
    await dash(`${C}.strokeDashDotted`, [1, 3]);
  });

  it("Stroke: Dash-dot writes 6/3/1/3", async () => {
    covers("command:media.paged.draw.command.strokeDashDashDot");
    await dash(`${C}.strokeDashDashDot`, [6, 3, 1, 3]);
  });
});

describe("paged.draw commands, no engine — gradient fills", () => {
  const gradient = async (id: string, type: string) => {
    const r = rig([RECT]);
    await r.run(id);
    // Two stops, the gradient over them, then the fill pointing at it.
    expect(r.sent().map((m) => m.op)).toEqual([
      "createSwatch",
      "createSwatch",
      "createGradient",
      "setElementProperty",
    ]);
    const spec = (
      r.sent()[2] as unknown as { args: { spec: Record<string, unknown> } }
    ).args.spec;
    expect(JSON.stringify(spec)).toContain(type);
    const fill = set(r.sent()[3]!);
    expect(fill.elementId).toEqual(RECT);
    expect(fill.path).toBe("frameFillColor");
    const none = rig([]);
    await none.run(id);
    expect(none.sent()).toEqual([]);
    expect(none.logs.some((l) => l.includes("no selection"))).toBe(true);
  };

  it("Fill: Linear gradient creates the ramp and fills the selection with it (DRW-1: four writes)", async () => {
    covers("command:media.paged.draw.command.fillGradientLinear");
    await gradient(`${C}.fillGradientLinear`, "Linear");
  });

  it("Fill: Radial gradient creates the ramp and fills the selection with it (DRW-1: four writes)", async () => {
    covers("command:media.paged.draw.command.fillGradientRadial");
    await gradient(`${C}.fillGradientRadial`, "Radial");
  });
});

describe("paged.draw commands, no engine — path operations", () => {
  it("Outline stroke outlines the selected path at its OWN stroke weight; an oval sends nothing", async () => {
    covers("command:media.paged.draw.command.outlineStroke");
    const r = rig([RECT]);
    await r.run(`${C}.outlineStroke`);
    expect(r.sent()).toEqual([
      {
        op: "outlineStroke",
        args: {
          elementId: RECT,
          width: 3,
          cap: "butt",
          join: "miter",
          miterLimit: 4,
        },
      },
    ]);
    expect(r.steps()).toBe(1);
    const oval = rig([OVAL]);
    await oval.run(`${C}.outlineStroke`);
    expect(oval.sent()).toEqual([]);
  });

  it("Offset path offsets by the payload's delta (6 pt by default); an oval sends nothing", async () => {
    covers("command:media.paged.draw.command.offsetPath");
    const r = rig([RECT]);
    await r.run(`${C}.offsetPath`, { delta: -2 });
    expect(r.sent()).toEqual([
      {
        op: "offsetPath",
        args: { elementId: RECT, delta: -2, join: "miter", miterLimit: 4 },
      },
    ]);
    const bare = rig([RECT]);
    await bare.run(`${C}.offsetPath`);
    expect(set(bare.sent()[0]!)).toMatchObject({ delta: 6 });
    const oval = rig([OVAL]);
    await oval.run(`${C}.offsetPath`);
    expect(oval.sent()).toEqual([]);
  });

  it("Simplify path sends the tolerance (1 pt by default); an oval sends nothing", async () => {
    covers("command:media.paged.draw.command.simplifyPath");
    const r = rig([POLY]);
    await r.run(`${C}.simplifyPath`, { tolerance: 30 });
    expect(r.sent()).toEqual([
      { op: "simplifyPath", args: { elementId: POLY, tolerance: 30 } },
    ]);
    const bare = rig([POLY]);
    await bare.run(`${C}.simplifyPath`);
    expect(set(bare.sent()[0]!)).toMatchObject({ tolerance: 1 });
    const oval = rig([OVAL]);
    await oval.run(`${C}.simplifyPath`);
    expect(oval.sent()).toEqual([]);
  });

  it("Join endpoints joins the two open paths with the engine's weld; one write", async () => {
    covers("command:media.paged.draw.command.joinEndpoints");
    const r = rig([POLY, LINE]);
    await r.run(`${C}.joinEndpoints`);
    // The vocabulary probe is refused (it is no write); the weld is one.
    const applied = r.sent().filter((m) => !m.op.startsWith("mediaPaged"));
    expect(applied).toEqual([
      { op: "joinPaths", args: { elementId: POLY, otherId: LINE } },
    ]);
    expect(r.steps()).toBe(1);
    const none = rig([]);
    await none.run(`${C}.joinEndpoints`);
    expect(none.sent()).toEqual([]);
  });

  it("Close path closes the selected open path; nothing selected sends nothing", async () => {
    covers("command:media.paged.draw.command.closePath");
    const r = rig([POLY]);
    await r.run(`${C}.closePath`);
    const applied = r.sent().filter((m) => !m.op.startsWith("mediaPaged"));
    expect(applied).toEqual([{ op: "closePath", args: { elementId: POLY } }]);
    expect(r.steps()).toBe(1);
    const none = rig([]);
    await none.run(`${C}.closePath`);
    expect(none.sent()).toEqual([]);
  });

  it("Average endpoints moves both ends of the open path to their midpoint, in one batch; a closed rectangle sends nothing", async () => {
    covers("command:media.paged.draw.command.averageEndpoints");
    const r = rig([POLY]);
    await r.run(`${C}.averageEndpoints`);
    expect(r.steps()).toBe(1);
    const moves = r.leaves();
    expect(moves.map((m) => m.op)).toEqual(["pathPointSet", "pathPointSet"]);
    // (100,400) and (400,400) meet at (250,400).
    for (const m of moves) {
      expect((m as { args: { position: number[] } }).args.position).toEqual([
        250, 400,
      ]);
    }
    const closed = rig([RECT]);
    await closed.run(`${C}.averageEndpoints`);
    expect(closed.sent()).toEqual([]);
  });

  it("Reverse path direction rewrites the selection's anchor table back to front; an oval sends nothing", async () => {
    covers("command:media.paged.draw.command.reversePathDirection");
    const r = rig([POLY]);
    await r.run(`${C}.reversePathDirection`);
    expect(r.steps()).toBe(1);
    const write = set(r.leaves()[0]!);
    expect(write.path).toBe("framePath");
    const anchors = (
      write.value as { value: { anchors: { anchor: number[] }[] } }
    ).value.anchors.map((a) => a.anchor);
    expect(anchors).toEqual([
      [400, 400],
      [250, 600],
      [100, 400],
    ]);
    const oval = rig([OVAL]);
    await oval.run(`${C}.reversePathDirection`);
    expect(oval.sent()).toEqual([]);
  });
});

describe("paged.draw commands, no engine — live corners", () => {
  const corners = async (id: string, option: string) => {
    const r = rig([RECT]);
    await r.run(id);
    const writes = r.leaves().filter((m) => m.op === "setElementProperty");
    // The option and the radius of all four corners…
    expect(writes.map((m) => set(m).path).sort()).toEqual(
      [
        "frameCornerOptionBottomLeft",
        "frameCornerOptionBottomRight",
        "frameCornerOptionTopLeft",
        "frameCornerOptionTopRight",
        "frameCornerRadiusBottomLeft",
        "frameCornerRadiusBottomRight",
        "frameCornerRadiusTopLeft",
        "frameCornerRadiusTopRight",
      ].sort(),
    );
    expect(
      writes
        .filter((m) => String(set(m).path).startsWith("frameCornerOption"))
        .map((m) => (set(m).value as { value: string }).value),
    ).toEqual([option, option, option, option]);
    // …and the live marker that lets the panel read the preset back
    // (DRW-2: a second write).
    const marker = r.metaOf(RECT)?.data as { liveCorners?: unknown };
    if (option === "") expect(marker?.liveCorners).toBeUndefined();
    else expect(marker?.liveCorners).toMatchObject({ style: option });
    const line = rig([LINE]);
    await line.run(id);
    expect(line.sent()).toEqual([]);
  };

  it("Corners: Rounded rounds all four corners and stamps the live marker; a line sends nothing", async () => {
    covers("command:media.paged.draw.command.cornersRounded");
    await corners(`${C}.cornersRounded`, "RoundedCorner");
  });

  it("Corners: Inverse rounded", async () => {
    covers("command:media.paged.draw.command.cornersInverseRounded");
    await corners(`${C}.cornersInverseRounded`, "InverseRoundedCorner");
  });

  it("Corners: Bevel", async () => {
    covers("command:media.paged.draw.command.cornersBevel");
    await corners(`${C}.cornersBevel`, "BeveledCorner");
  });

  it("Corners: Fancy", async () => {
    covers("command:media.paged.draw.command.cornersFancy");
    await corners(`${C}.cornersFancy`, "FancyCorner");
  });

  it("Corners: None clears the corners (empty option, zero radius) and the marker", async () => {
    covers("command:media.paged.draw.command.cornersNone");
    await corners(`${C}.cornersNone`, "");
  });
});

describe("paged.draw commands, no engine — transforms", () => {
  /** The frameTransform writes, rounded (a reflection's sine terms come
   *  back as 1e-16, not 0). */
  const transformOf = (r: ReturnType<typeof rig>) =>
    r
      .leaves()
      .filter((m) => set(m).path === "frameTransform")
      .map((m) =>
        (set(m).value as { value: number[] }).value.map(
          (v) => Math.round(v * 1e6) / 1e6 + 0,
        ),
      );

  it("Reflect horizontally mirrors the selection about its own centre, in one write; nothing selected sends nothing", async () => {
    covers("command:media.paged.draw.command.reflectHorizontal");
    const r = rig([RECT]);
    await r.run(`${C}.reflectHorizontal`);
    expect(r.steps()).toBe(1);
    // x → 400 − x about the rectangle's centre x = 200.
    expect(transformOf(r)).toEqual([[-1, 0, 0, 1, 400, 0]]);
    const none = rig([]);
    await none.run(`${C}.reflectHorizontal`);
    expect(none.sent()).toEqual([]);
  });

  it("Reflect vertically mirrors the selection about its own centre; nothing selected sends nothing", async () => {
    covers("command:media.paged.draw.command.reflectVertical");
    const r = rig([RECT]);
    await r.run(`${C}.reflectVertical`);
    expect(r.steps()).toBe(1);
    expect(transformOf(r)).toEqual([[1, 0, 0, -1, 0, 400]]);
    const none = rig([]);
    await none.run(`${C}.reflectVertical`);
    expect(none.sent()).toEqual([]);
  });

  it("Transform again repeats the last reflection about the new selection's centre", async () => {
    covers("command:media.paged.draw.command.transformAgain");
    const r = rig([RECT]);
    await r.run(`${C}.reflectHorizontal`);
    r.fake.setSelection([POLY]);
    r.reset();
    await r.run(`${C}.transformAgain`);
    expect(r.steps()).toBe(1);
    // The polygon spans x 100..400: centre 250, x → 500 − x.
    expect(transformOf(r)).toEqual([[-1, 0, 0, 1, 500, 0]]);
    const none = rig([]);
    await none.run(`${C}.transformAgain`);
    expect(none.sent()).toEqual([]);
  });
});
