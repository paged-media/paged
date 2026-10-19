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

// THE OBJECT COMMANDS with no engine (`unit-kit.ts`) — Pathfinder,
// compound paths, inserted shapes, Select Same, opacity masks, type on a
// path, Create Outlines and the Path Options "…" commands: what each one
// sends (or selects, or raises) for the selection, as how many writes,
// and that it sends nothing where it does not apply. The engine's answer
// is `test/headless/commands-objects.spec.ts`.

import { describe, expect, it } from "bun:test";

import type { ElementId, Mutation } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import { openEl, rectEl, unitRig, type FakeElement } from "./unit-kit";

const C = "media.paged.draw.command";
const A = { kind: "polygon", id: "ua" } as ElementId;
const B = { kind: "polygon", id: "ub" } as ElementId;
const POLY = { kind: "polygon", id: "upoly" } as ElementId;
const LINE = { kind: "graphicLine", id: "uline" } as ElementId;

/** F4's overlapping pair (black fill, 1 pt stroke) plus an open polygon
 *  and a line (no fill, 2 pt stroke). */
const doc = (): FakeElement[] => [
  rectEl("polygon", "ua", [100, 100, 300, 300]),
  rectEl("polygon", "ub", [200, 200, 400, 400]),
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
];

const rig = (
  selection: ElementId[],
  extra: Parameters<typeof unitRig>[1] = {},
) => unitRig(doc(), { selection, ...extra });

const args = (m: Mutation) => (m as { args: Record<string, unknown> }).args;
const ids = (s: readonly ElementId[]) => s.map((e) => String(e.id)).sort();

describe("paged.draw commands, no engine — Pathfinder", () => {
  const boolean = async (id: string, kind: string) => {
    const r = rig([A, B]);
    await r.run(id);
    expect(r.sent()).toHaveLength(1);
    expect(r.sent()[0]!.op).toBe("pathfinderBoolean");
    expect(args(r.sent()[0]!)).toMatchObject({ kind });
    const { kept, others } = args(r.sent()[0]!) as {
      kept: ElementId;
      others: ElementId[];
    };
    expect(ids([kept, ...others])).toEqual(["ua", "ub"]);
    expect(r.steps()).toBe(1);
    const one = rig([A]);
    await one.run(id);
    expect(one.sent()).toEqual([]);
  };

  it("Unite sends one pathfinderBoolean over the pair; one path sends nothing", async () => {
    covers("command:media.paged.draw.command.pathfinderUnite");
    await boolean(`${C}.pathfinderUnite`, "union");
  });

  it("Minus front sends one pathfinderBoolean subtract", async () => {
    covers("command:media.paged.draw.command.pathfinderSubtract");
    await boolean(`${C}.pathfinderSubtract`, "subtract");
  });

  it("Intersect sends one pathfinderBoolean intersect", async () => {
    covers("command:media.paged.draw.command.pathfinderIntersect");
    await boolean(`${C}.pathfinderIntersect`, "intersect");
  });

  it("Exclude sends one pathfinderBoolean exclude", async () => {
    covers("command:media.paged.draw.command.pathfinderExclude");
    await boolean(`${C}.pathfinderExclude`, "exclude");
  });

  const region = async (id: string, op: string) => {
    const r = rig([A, B]);
    await r.run(id);
    expect(r.sent()).toHaveLength(1);
    expect(r.sent()[0]!.op).toBe(op);
    expect(ids(args(r.sent()[0]!).elementIds as ElementId[])).toEqual([
      "ua",
      "ub",
    ]);
    expect(r.steps()).toBe(1);
    const one = rig([A]);
    await one.run(id);
    expect(one.sent()).toEqual([]);
  };

  it("Divide sends one pathfinderDivide over the pair; one path sends nothing", async () => {
    covers("command:media.paged.draw.command.pathfinderDivide");
    await region(`${C}.pathfinderDivide`, "pathfinderDivide");
  });

  it("Trim sends one pathfinderTrim", async () => {
    covers("command:media.paged.draw.command.pathfinderTrim");
    await region(`${C}.pathfinderTrim`, "pathfinderTrim");
  });

  it("Merge sends one pathfinderMerge", async () => {
    covers("command:media.paged.draw.command.pathfinderMerge");
    await region(`${C}.pathfinderMerge`, "pathfinderMerge");
  });

  it("Crop sends one pathfinderCrop", async () => {
    covers("command:media.paged.draw.command.pathfinderCrop");
    await region(`${C}.pathfinderCrop`, "pathfinderCrop");
  });

  it("Outline sends one pathfinderOutline", async () => {
    covers("command:media.paged.draw.command.pathfinderOutline");
    await region(`${C}.pathfinderOutline`, "pathfinderOutline");
  });

  it("Minus back sends one pathfinderMinusBack", async () => {
    covers("command:media.paged.draw.command.pathfinderMinusBack");
    await region(`${C}.pathfinderMinusBack`, "pathfinderMinusBack");
  });
});

describe("paged.draw commands, no engine — compound paths", () => {
  it("Make compound path merges the second contour into the first and deletes the second, in one batch", async () => {
    covers("command:media.paged.draw.command.makeCompoundPath");
    const r = rig([A, B]);
    await r.run(`${C}.makeCompoundPath`);
    expect(r.steps()).toBe(1);
    const [merge, del] = r.leaves();
    expect(merge!.op).toBe("setElementProperty");
    expect(args(merge!).path).toBe("framePath");
    const path = (args(merge!).value as { value: { subpathStarts: number[] } })
      .value;
    expect(path.subpathStarts).toEqual([0, 4]);
    expect(del).toEqual({ op: "deleteFrame", args: { frameId: "ub" } });
    const one = rig([A]);
    await one.run(`${C}.makeCompoundPath`);
    expect(one.sent()).toEqual([]);
  });

  it("Release compound path splits a two-contour path back into two elements; a plain path sends nothing", async () => {
    covers("command:media.paged.draw.command.releaseCompoundPath");
    const ring: FakeElement = {
      ...rectEl("polygon", "uring", [100, 100, 400, 400]),
      anchors: [
        [100, 100],
        [400, 100],
        [400, 400],
        [100, 400],
        [200, 200],
        [300, 200],
        [300, 300],
        [200, 300],
      ],
      starts: [0, 4],
    };
    const RING = ring.id;
    const r = unitRig([ring], { selection: [RING] });
    await r.run(`${C}.releaseCompoundPath`);
    expect(r.steps()).toBe(1);
    const ops = r.leaves().map((m) => m.op);
    // The survivor keeps contour 0; the hole is inserted as its own path.
    expect(ops).toContain("insertPath");
    expect(ops).toContain("setElementProperty");
    const plain = rig([A]);
    await plain.run(`${C}.releaseCompoundPath`);
    expect(plain.sent()).toEqual([]);
  });
});

describe("paged.draw commands, no engine — inserted shapes", () => {
  const inserts = async (id: string, paths: number) => {
    const r = rig([]);
    await r.run(id);
    expect(r.steps()).toBe(1);
    expect(r.leaves().filter((m) => m.op === "insertPath")).toHaveLength(paths);
  };

  it("Insert arc inserts one open path in one write", async () => {
    covers("command:media.paged.draw.command.insertArc");
    await inserts(`${C}.insertArc`, 1);
  });

  it("Insert spiral inserts one open path in one write", async () => {
    covers("command:media.paged.draw.command.insertSpiral");
    await inserts(`${C}.insertSpiral`, 1);
  });

  it("Insert rectangular grid inserts its frame and dividers in ONE batch", async () => {
    covers("command:media.paged.draw.command.insertRectGrid");
    await inserts(`${C}.insertRectGrid`, 10);
  });

  it("Insert polar grid inserts its rings and dividers in ONE batch", async () => {
    covers("command:media.paged.draw.command.insertPolarGrid");
    await inserts(`${C}.insertPolarGrid`, 9);
  });
});

describe("paged.draw commands, no engine — Select Same", () => {
  it("Select same fill selects every element filled like the selection, and writes nothing", async () => {
    covers("command:media.paged.draw.command.selectSameFill");
    const r = rig([A]);
    await r.run(`${C}.selectSameFill`);
    expect(ids(r.fake.selection())).toEqual(["ua", "ub"]);
    expect(r.sent()).toEqual([]);
    const none = rig([]);
    await none.run(`${C}.selectSameFill`);
    expect(none.fake.selection()).toEqual([]);
  });

  it("Select same stroke selects every element stroked in that colour", async () => {
    covers("command:media.paged.draw.command.selectSameStroke");
    const r = rig([POLY]);
    await r.run(`${C}.selectSameStroke`);
    expect(ids(r.fake.selection())).toEqual(["ua", "ub", "uline", "upoly"]);
    expect(r.sent()).toEqual([]);
    const none = rig([]);
    await none.run(`${C}.selectSameStroke`);
    expect(none.fake.selection()).toEqual([]);
  });

  it("Select same stroke weight selects every element of that weight", async () => {
    covers("command:media.paged.draw.command.selectSameStrokeWeight");
    const r = rig([POLY]);
    await r.run(`${C}.selectSameStrokeWeight`);
    expect(ids(r.fake.selection())).toEqual(["uline", "upoly"]);
    expect(r.sent()).toEqual([]);
    const none = rig([]);
    await none.run(`${C}.selectSameStrokeWeight`);
    expect(none.fake.selection()).toEqual([]);
  });
});

describe("paged.draw commands, no engine — opacity masks", () => {
  it("Make opacity mask masks the lower path with the upper one and stamps the record, in one batch; one path sends nothing", async () => {
    covers("command:media.paged.draw.command.makeOpacityMask");
    const r = rig([A, B]);
    await r.run(`${C}.makeOpacityMask`);
    expect(r.steps()).toBe(1);
    const [mask, stamp] = r.leaves();
    expect(mask!.op).toBe("applyOpacityMask");
    expect(ids([args(mask!).targetId as ElementId])).toEqual(["ua"]);
    expect(ids([args(mask!).maskId as ElementId])).toEqual(["ub"]);
    expect(stamp!.op).toBe("setPluginMetadata");
    const one = rig([A]);
    await one.run(`${C}.makeOpacityMask`);
    expect(one.sent()).toEqual([]);
  });

  it("Release opacity mask asks the engine to release the selected target, in one batch; nothing selected sends nothing", async () => {
    covers("command:media.paged.draw.command.releaseOpacityMask");
    const r = rig([A]);
    await r.run(`${C}.releaseOpacityMask`);
    expect(r.steps()).toBe(1);
    expect(r.leaves()[0]).toEqual({
      op: "releaseOpacityMask",
      args: { targetId: A },
    });
    const none = rig([]);
    await none.run(`${C}.releaseOpacityMask`);
    expect(none.sent()).toEqual([]);
  });
});

describe("paged.draw commands, no engine — type on a path", () => {
  it("Attach story to path flows the named story along the selected line and stamps the record; nothing selected sends nothing", async () => {
    covers("command:media.paged.draw.command.attachTextToPath");
    const r = rig([LINE]);
    await r.run(`${C}.attachTextToPath`, { storyId: "st1" });
    expect(r.steps()).toBe(1);
    const [attach, stamp] = r.leaves();
    expect(attach).toMatchObject({
      op: "attachTextToPath",
      args: { elementId: LINE, storyId: "st1" },
    });
    expect(stamp!.op).toBe("setPluginMetadata");
    expect(r.metaOf(LINE)?.data).toHaveProperty("textOnPath");
    const none = rig([]);
    await none.run(`${C}.attachTextToPath`, { storyId: "st1" });
    expect(none.sent()).toEqual([]);
    expect(none.logs.some((l) => l.includes("nothing selected"))).toBe(true);
  });

  it("Detach text from path unflows the story and clears the record, in one batch; nothing selected sends nothing", async () => {
    covers("command:media.paged.draw.command.detachTextFromPath");
    const r = rig([LINE]);
    await r.run(`${C}.attachTextToPath`, { storyId: "st1" });
    r.reset();
    await r.run(`${C}.detachTextFromPath`);
    expect(r.steps()).toBe(1);
    expect(r.leaves()[0]).toEqual({
      op: "detachTextFromPath",
      args: { elementId: LINE },
    });
    expect(r.metaOf(LINE)?.data ?? {}).not.toHaveProperty("textOnPath");
    const none = rig([]);
    await none.run(`${C}.detachTextFromPath`);
    expect(none.sent()).toEqual([]);
  });
});

describe("paged.draw commands, no engine — Create Outlines", () => {
  const FRAME = { kind: "textFrame", id: "tf" } as ElementId;
  const square = (x: number, y: number, s: number) =>
    [
      [x, y],
      [x + s, y],
      [x + s, y + s],
      [x, y + s],
    ].map((p) => ({ anchor: p, left: p, right: p }));

  it("replaces the selected text frame with one path per colour, grouped, the frame deleted last — in ONE batch; a path sends nothing", async () => {
    covers("command:media.paged.draw.command.createOutlines");
    const frame = rectEl("textFrame", "tf", [40, 300, 400, 380]);
    const r = unitRig([frame], {
      selection: [FRAME],
      reply: (m) =>
        m.kind === "requestTextOutlines"
          ? {
              kind: "textOutlines",
              payload: {
                result: {
                  id: FRAME,
                  pageId: "page-1",
                  skippedGlyphs: 0,
                  runs: [
                    {
                      rgb: [0, 0, 0],
                      cmyk: [0, 0, 0, 1],
                      anchors: [...square(40, 300, 20), ...square(45, 305, 5)],
                      subpathStarts: [0, 4],
                      glyphs: 1,
                    },
                    {
                      rgb: [1, 0, 0],
                      cmyk: null,
                      anchors: square(80, 300, 20),
                      subpathStarts: [0],
                      glyphs: 1,
                    },
                  ],
                },
              },
            }
          : undefined,
    });
    await r.run(`${C}.createOutlines`);
    expect(r.steps()).toBe(1);
    const ops = r.leaves().map((m) => m.op);
    expect(ops.filter((o) => o === "insertPath")).toHaveLength(2);
    expect(ops).toContain("createGroup");
    expect(ops.at(-1)).toBe("deleteFrame");
    const path = unitRig(doc(), { selection: [POLY] });
    await path.run(`${C}.createOutlines`);
    expect(path.sent()).toEqual([]);
  });
});

describe("paged.draw commands, no engine — the Path Options “…” commands raise the panel", () => {
  /** A "…" command on a host with shell doors: the Path Options panel is
   *  raised, the focus binding names the section, nothing is written. */
  const raises = async (id: string, section: string) => {
    const r = rig([A], { shell: true });
    await r.run(id);
    expect(r.opened).toEqual(["media.paged.draw.panel.pathOptions"]);
    expect(
      r.host.bindings.get("media.paged.draw.pathOptions.focus"),
    ).toMatchObject({ section, seq: 1 });
    expect(r.sent()).toEqual([]);
  };

  it("Offset path… raises Path Options at Offset path and writes nothing", async () => {
    covers("command:media.paged.draw.command.offsetPathOptions");
    await raises(`${C}.offsetPathOptions`, "offset");
  });

  it("Simplify… raises Path Options at Simplify", async () => {
    covers("command:media.paged.draw.command.simplifyPathOptions");
    await raises(`${C}.simplifyPathOptions`, "simplify");
  });

  it("Outline stroke… raises Path Options at Outline stroke", async () => {
    covers("command:media.paged.draw.command.outlineStrokeOptions");
    await raises(`${C}.outlineStrokeOptions`, "outlineStroke");
  });

  it("Dashes… raises Path Options at Stroke dashes", async () => {
    covers("command:media.paged.draw.command.strokeDashOptions");
    await raises(`${C}.strokeDashOptions`, "dash");
  });

  it("Reflect… raises Path Options at Reflect", async () => {
    covers("command:media.paged.draw.command.reflectOptions");
    await raises(`${C}.reflectOptions`, "reflect");
  });

  it("Arc… raises Path Options at Arc", async () => {
    covers("command:media.paged.draw.command.insertArcOptions");
    await raises(`${C}.insertArcOptions`, "arc");
  });

  it("Spiral… raises Path Options at Spiral", async () => {
    covers("command:media.paged.draw.command.insertSpiralOptions");
    await raises(`${C}.insertSpiralOptions`, "spiral");
  });

  it("Rectangular grid… raises Path Options at Rectangular grid", async () => {
    covers("command:media.paged.draw.command.insertRectGridOptions");
    await raises(`${C}.insertRectGridOptions`, "rectGrid");
  });

  it("Polar grid… raises Path Options at Polar grid", async () => {
    covers("command:media.paged.draw.command.insertPolarGridOptions");
    await raises(`${C}.insertPolarGridOptions`, "polarGrid");
  });

  it("Stroke weight within… raises Path Options at Select same weight", async () => {
    covers("command:media.paged.draw.command.selectSameStrokeWeightOptions");
    await raises(`${C}.selectSameStrokeWeightOptions`, "selectSameWeight");
  });
});
