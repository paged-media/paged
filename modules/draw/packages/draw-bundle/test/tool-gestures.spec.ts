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

// EVERY paged.draw TOOL through the gesture DSL, one test each, over the
// fake document of `commands/unit-kit.ts` (no engine): the gesture a
// designer makes, what it commits — as ONE undo step that one undo takes
// back (INV-1, INV-4 on the fake's own history) — what it leaves alone,
// and that Escape mid-gesture commits nothing (INV-2). A tool that only
// reads (Measure) or only selects (Lasso, Live Paint Selection) is held
// to committing nothing at all. `gestures.spec.ts` keeps the battery every
// tool also passes; the engine-backed versions are in `test/headless/`.

import { describe, expect, it } from "bun:test";

import type { ElementId, Mutation } from "@paged-media/plugin-api";
import { covers, gestures, type GestureDsl } from "@paged-media/test-kit";

import { openEl, rectEl, unitRig, type UnitRig } from "./commands/unit-kit";

const T = "media.paged.draw.tool";
const C = "media.paged.draw.command";
const A = { kind: "polygon", id: "ua" } as ElementId;
const B = { kind: "polygon", id: "ub" } as ElementId;
const POLY = { kind: "polygon", id: "upoly" } as ElementId;

/** Two overlapping closed quads, an open polygon and a line, all on the
 *  page (a point off the page has no page id, and the tools ignore it). */
const doc = () => [
  rectEl("polygon", "ua", [100, 100, 300, 300]),
  rectEl("polygon", "ub", [200, 200, 400, 400]),
  openEl("upoly", [
    [100, 500],
    [250, 650],
    [400, 500],
  ]),
  openEl(
    "uline",
    [
      [500, 100],
      [500, 400],
    ],
    {},
    "graphicLine",
  ),
];

const square = (x0: number, y0: number, x1: number, y1: number) =>
  [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ].map((p) => ({ anchor: p, left: p, right: p }));

type Face = { id: string; signature: number[]; box: number[] };

/** The engine's planar arrangement, scripted: every face for a scope
 *  query, the face under the point for a point query. */
const regionsOf =
  (faces: Face[]) => (m: { kind: string; payload?: unknown }) => {
    if (m.kind !== "requestPlanarRegions") return undefined;
    const point = (m.payload as { point?: [number, number] }).point;
    const hit = faces.filter(
      (f) =>
        !point ||
        (point[0] >= f.box[0] &&
          point[0] <= f.box[2] &&
          point[1] >= f.box[1] &&
          point[1] <= f.box[3]),
    );
    return {
      kind: "planarRegions",
      payload: {
        result: {
          found: true,
          inputCount: 2,
          complete: true,
          faces: hit.map((f) => ({
            id: f.id,
            signature: f.signature,
            anchors: square(f.box[0]!, f.box[1]!, f.box[2]!, f.box[3]!),
            subpathStarts: [0],
            area: (f.box[2]! - f.box[0]!) * (f.box[3]! - f.box[1]!),
            inside: [(f.box[0]! + f.box[2]!) / 2, (f.box[1]! + f.box[3]!) / 2],
          })),
        },
      },
    };
  };

/** The overlapping pair's faces (live paint): A alone, B alone, both. */
const PAIR_FACES = regionsOf([
  { id: "0#0", signature: [0], box: [100, 100, 199, 299] },
  { id: "1#0", signature: [1], box: [301, 201, 400, 400] },
  { id: "0-1#0", signature: [0, 1], box: [200, 200, 300, 300] },
]);

/** A horizontal cut at y = 200 across A: two pieces and the strip. */
const CUT_FACES = regionsOf([
  { id: "0#0", signature: [0], box: [100, 100, 300, 199.97] },
  { id: "0#1", signature: [0], box: [100, 200.03, 300, 300] },
  { id: "0-1#0", signature: [0, 1], box: [100, 199.97, 300, 200.03] },
]);

function rig(
  selection: ElementId[],
  extra: Parameters<typeof unitRig>[1] = {},
): { r: UnitRig; g: GestureDsl } {
  const r = unitRig(doc(), { selection, ...extra });
  return { r, g: gestures(r.fake) };
}

/** Arm the tool (letting its activation reads land), then forget what
 *  the setup sent. */
async function arm(r: UnitRig, g: GestureDsl, tool: string): Promise<void> {
  await g.tool(tool).settle();
  r.reset();
}

/** A drag sampled slowly enough that a tool resolving each sample
 *  asynchronously (the planar point queries) sees every one. */
function slowDrag(
  g: GestureDsl,
  from: [number, number],
  to: [number, number],
): GestureDsl {
  let q = g.down(from).settle();
  for (let i = 1; i <= 4; i++) {
    q = q
      .move([
        from[0] + ((to[0] - from[0]) * i) / 4,
        from[1] + ((to[1] - from[1]) * i) / 4,
      ])
      .settle();
  }
  return q.up(to).settle();
}

/** One commit, one undo step, and the undo puts the document back. */
async function oneUndoStep(r: UnitRig, before: string): Promise<void> {
  expect(r.steps(), "one gesture, one undo step").toBe(1);
  await r.undo();
  expect(r.picture(), "one undo restores the document").toBe(before);
}

/** Escape mid-drag: nothing is committed. */
async function cancelCommitsNothing(
  tool: string,
  selection: ElementId[],
  from: [number, number],
  to: [number, number],
  extra: Parameters<typeof unitRig>[1] = {},
): Promise<void> {
  const { r, g } = rig(selection, extra);
  await arm(r, g, tool);
  await g.drag({ from, to, release: false, steps: 4 }).settle().cancel().up();
  await g.settle();
  expect(r.sent(), `${tool}: Escape mid-gesture committed`).toEqual([]);
  expect(r.steps()).toBe(0);
}

const leafOps = (ms: Mutation[]) => ms.map((m) => m.op);
const paths = (ms: Mutation[]) =>
  ms
    .filter((m) => m.op === "setElementProperty")
    .map((m) => (m as { args: { path: string } }).args.path);

describe("paged.draw tools through the gesture DSL — the anchor tools", () => {
  it("Add Anchor: a click on an edge inserts one anchor there, splitting the segment, as one undo step", async () => {
    covers("tool:media.paged.draw.tool.addAnchor");
    const { r, g } = rig([A]);
    await arm(r, g, `${T}.addAnchor`);
    const before = r.picture();
    await g.click([200, 100]).settle();
    expect(leafOps(r.leaves())).toEqual([
      "pathPointSet",
      "pathPointSet",
      "pathPointInsert",
    ]);
    expect(r.leaves()[2]).toMatchObject({
      args: { elementId: A, index: 1 },
    });
    await oneUndoStep(r, before);
    // Away from every path: nothing.
    r.reset();
    await g.click([450, 300]).settle();
    expect(r.sent()).toEqual([]);
  });

  it("Delete Anchor: a click on an anchor removes it as one undo step; a click away from every anchor sends nothing", async () => {
    covers("tool:media.paged.draw.tool.deleteAnchor");
    const { r, g } = rig([A]);
    await arm(r, g, `${T}.deleteAnchor`);
    await g.click([450, 300]).settle();
    expect(r.sent()).toEqual([]);
    const before = r.picture();
    await g.click([300, 100]).settle();
    expect(r.leaves()).toEqual([
      { op: "pathPointRemove", args: { elementId: A, index: 1 } },
    ]);
    await oneUndoStep(r, before);
  });

  it("Convert Anchor: a click on a corner anchor makes it smooth, as one undo step", async () => {
    covers("tool:media.paged.draw.tool.convertAnchor");
    const { r, g } = rig([A]);
    await arm(r, g, `${T}.convertAnchor`);
    const before = r.picture();
    await g.click([300, 100]).settle();
    expect(r.leaves()).toHaveLength(1);
    expect(r.leaves()[0]).toMatchObject({
      op: "pathPointCurveType",
      args: { elementId: A, index: 1, smooth: true },
    });
    await oneUndoStep(r, before);
  });

  it("Scissors: a click on an edge cuts the closed path open there, as one undo step", async () => {
    covers("tool:media.paged.draw.tool.scissorsAnyPoint");
    const { r, g } = rig([A]);
    await arm(r, g, `${T}.scissorsAnyPoint`);
    const before = r.picture();
    await g.click([200, 100]).settle();
    expect(leafOps(r.leaves())).toEqual([
      "pathPointSet",
      "pathPointSet",
      "pathPointInsert",
      "pathOpenAt",
    ]);
    await oneUndoStep(r, before);
    r.reset();
    await g.click([450, 300]).settle();
    expect(r.sent()).toEqual([]);
  });
});

describe("paged.draw tools through the gesture DSL — drawing", () => {
  it("Curvature: three clicks and Enter commit one painted path, as one undo step; Escape mid-path commits nothing", async () => {
    covers("tool:media.paged.draw.tool.curvature");
    const { r, g } = rig([]);
    await arm(r, g, `${T}.curvature`);
    const before = r.picture();
    await g
      .click([100, 700])
      .click([200, 650])
      .click([300, 700])
      .key("Enter")
      .settle();
    expect(leafOps(r.leaves())[0]).toBe("insertPath");
    expect(paths(r.leaves())).toEqual([
      "frameStrokeColor",
      "frameStrokeWeight",
    ]);
    await oneUndoStep(r, before);
    const second = rig([]);
    await arm(second.r, second.g, `${T}.curvature`);
    await second.g.click([100, 700]).click([200, 650]).cancel().settle();
    expect(second.r.sent()).toEqual([]);
  });

  it("Paintbrush: a drag commits one variable-width stroke, as one undo step; Escape commits nothing", async () => {
    covers("tool:media.paged.draw.tool.paintbrush");
    const { r, g } = rig([]);
    await arm(r, g, `${T}.paintbrush`);
    const before = r.picture();
    await g.drag({ from: [100, 700], to: [300, 700], steps: 6 }).settle();
    expect(leafOps(r.leaves())).toContain("insertPath");
    expect(paths(r.leaves())).toContain("outlineStrokeVariable");
    await oneUndoStep(r, before);
    await cancelCommitsNothing(`${T}.paintbrush`, [], [100, 700], [300, 700]);
  });

  it("Blob Brush: a stroke over the selected path is united with it, as one undo step; Escape commits nothing", async () => {
    covers("tool:media.paged.draw.tool.blobBrush");
    const { r, g } = rig([A]);
    await arm(r, g, `${T}.blobBrush`);
    const before = r.picture();
    await g.drag({ from: [150, 150], to: [250, 150], steps: 6 }).settle();
    const union = r
      .leaves()
      .find((m) => m.op === "pathfinderBoolean") as Mutation & {
      args: { kind: string };
    };
    expect(union.args.kind).toBe("union");
    await oneUndoStep(r, before);
    await cancelCommitsNothing(`${T}.blobBrush`, [A], [150, 150], [250, 150]);
  });

  it("Eraser: a stroke across the selected path is subtracted from it, as one undo step; Escape commits nothing", async () => {
    covers("tool:media.paged.draw.tool.eraserBrush");
    const { r, g } = rig([A]);
    await arm(r, g, `${T}.eraserBrush`);
    const before = r.picture();
    await g.drag({ from: [50, 200], to: [350, 200], steps: 6 }).settle();
    expect(leafOps(r.leaves())).toEqual([
      "insertPath",
      "bindCreated",
      "outlineStroke",
      "pathfinderBoolean",
    ]);
    expect(
      (r.leaves()[3] as Mutation & { args: { kind: string } }).args.kind,
    ).toBe("subtract");
    await oneUndoStep(r, before);
    await cancelCommitsNothing(`${T}.eraserBrush`, [A], [50, 200], [350, 200]);
  });

  it("Width: a drag at an anchor of the selected open path bakes a width bulge there, as one undo step; Escape commits nothing", async () => {
    covers("tool:media.paged.draw.tool.width");
    const { r, g } = rig([POLY]);
    await arm(r, g, `${T}.width`);
    const before = r.picture();
    await g.drag({ from: [250, 650], to: [250, 690], steps: 4 }).settle();
    expect(paths(r.leaves())).toEqual(["outlineStrokeVariable"]);
    await oneUndoStep(r, before);
    await cancelCommitsNothing(`${T}.width`, [POLY], [250, 650], [250, 690]);
  });
});

describe("paged.draw tools through the gesture DSL — paint and shape", () => {
  it("Gradient Annotator: a drag across the selection sets its gradient's angle and length, as one undo step; Escape commits nothing", async () => {
    covers("tool:media.paged.draw.tool.gradientAnnotator");
    const { r, g } = rig([A]);
    await arm(r, g, `${T}.gradientAnnotator`);
    const before = r.picture();
    await g.drag({ from: [120, 200], to: [280, 200], steps: 6 }).settle();
    expect(paths(r.leaves())).toEqual([
      "frameGradientFillAngle",
      "frameGradientFillLength",
    ]);
    await oneUndoStep(r, before);
    await cancelCommitsNothing(
      `${T}.gradientAnnotator`,
      [A],
      [120, 200],
      [280, 200],
    );
  });

  it("Eyedropper: a click on a path copies its paint onto the selection, as one undo step; alt+click only samples", async () => {
    covers("tool:media.paged.draw.tool.eyedropper");
    const { r, g } = rig([B]);
    await arm(r, g, `${T}.eyedropper`);
    await g.click([150, 150], { mods: ["alt"] }).settle();
    expect(r.sent()).toEqual([]);
    const before = r.picture();
    await g.click([150, 150]).settle();
    expect(paths(r.leaves())).toEqual([
      "frameFillColor",
      "frameStrokeColor",
      "frameStrokeWeight",
    ]);
    expect(
      r
        .leaves()
        .every(
          (m) =>
            (m as { args: { elementId: ElementId } }).args.elementId.id ===
            "ub",
        ),
    ).toBe(true);
    await oneUndoStep(r, before);
  });

  it("Shape Builder: a drag across the overlapping pair unites them, as one undo step; Escape commits nothing", async () => {
    covers("tool:media.paged.draw.tool.shapeBuilder");
    const { r, g } = rig([A, B]);
    await arm(r, g, `${T}.shapeBuilder`);
    const before = r.picture();
    await g.drag({ from: [150, 150], to: [350, 350], steps: 6 }).settle();
    const applied = r.leaves().filter((m) => !m.op.startsWith("mediaPaged"));
    expect(leafOps(applied)).toEqual(["pathfinderBoolean"]);
    await oneUndoStep(r, before);
    await cancelCommitsNothing(
      `${T}.shapeBuilder`,
      [A, B],
      [150, 150],
      [350, 350],
    );
  });

  it("Corner Radius: dragging a corner of the selected polygon inward rounds every corner, as one undo step; Escape commits nothing", async () => {
    covers("tool:media.paged.draw.tool.cornerRadius");
    const { r, g } = rig([A]);
    await arm(r, g, `${T}.cornerRadius`);
    const before = r.picture();
    await g.drag({ from: [102, 102], to: [140, 140], steps: 4 }).settle();
    expect(
      paths(r.leaves()).filter((p) => p.startsWith("frameCornerRadius")),
    ).toHaveLength(4);
    await oneUndoStep(r, before);
    await cancelCommitsNothing(
      `${T}.cornerRadius`,
      [A],
      [102, 102],
      [140, 140],
    );
  });

  it("Knife: a cut across the selected quad splits it in two — the probe strip withdrawn, ONE undo step; Escape commits nothing", async () => {
    covers("tool:media.paged.draw.tool.knife");
    const { r, g } = rig([A], { reply: CUT_FACES });
    await arm(r, g, `${T}.knife`);
    const before = r.picture();
    await slowDrag(g, [50, 200], [350, 200]);
    // The target is rewritten to the first piece, the second is inserted.
    expect(paths(r.leaves())).toContain("framePath");
    expect(r.elements()).toHaveLength(doc().length + 1);
    await oneUndoStep(r, before);
    await cancelCommitsNothing(`${T}.knife`, [A], [50, 200], [350, 200], {
      reply: CUT_FACES,
    });
  });
});

describe("paged.draw tools through the gesture DSL — reading and selecting", () => {
  it("Measure: a drag publishes the distance and angle and commits nothing", async () => {
    covers("tool:media.paged.draw.tool.measure");
    const { r, g } = rig([]);
    await arm(r, g, `${T}.measure`);
    await g.drag({ from: [100, 100], to: [400, 500] }).settle();
    const shown = r.fake.previews().filter(Array.isArray).at(-1) as Array<
      Record<string, unknown>
    >;
    expect(shown.at(-1)).toMatchObject({
      kind: "text",
      text: "500.00 pt · 53.1°",
    });
    expect(r.sent()).toEqual([]);
  });

  it("Lasso Select: a lasso around the first quad selects what it encloses and commits nothing", async () => {
    covers("tool:media.paged.draw.tool.lassoSelect");
    const { r, g } = rig([]);
    await arm(r, g, `${T}.lassoSelect`);
    await g
      .drag({
        from: [90, 90],
        to: [90, 310],
        via: [
          [310, 90],
          [310, 310],
        ],
        steps: 8,
      })
      .settle();
    expect(r.fake.selection().map((e) => String(e.id))).toContain("ua");
    expect(r.sent()).toEqual([]);
  });

  it("Type on a Path: a click on a line flows the one free story along it, as one undo step", async () => {
    covers("tool:media.paged.draw.tool.typeOnPath");
    const { r, g } = rig([], {
      collections: { stories: [{ selfId: "st1", characterCount: 4 }] },
    });
    await arm(r, g, `${T}.typeOnPath`);
    const before = r.picture();
    await g.click([500, 250]).settle();
    expect(r.leaves()[0]).toMatchObject({
      op: "attachTextToPath",
      args: { storyId: "st1" },
    });
    await oneUndoStep(r, before);
    // Empty canvas: nothing.
    r.reset();
    await g.click([560, 600]).settle();
    expect(r.sent()).toEqual([]);
  });
});

describe("paged.draw tools through the gesture DSL — live constructs", () => {
  it("Live Paint Bucket: a click in the overlap paints that face, as one undo step", async () => {
    covers("tool:media.paged.draw.tool.livePaintBucket");
    const { r, g } = rig([A, B], { reply: PAIR_FACES });
    await r.run(`${C}.makeLivePaintGroup`);
    await arm(r, g, `${T}.livePaintBucket`);
    const before = r.picture();
    await slowDrag(g, [250, 250], [251, 251]);
    expect(leafOps(r.leaves()).filter((o) => o === "insertPath")).toHaveLength(
      1,
    );
    await oneUndoStep(r, before);
  });

  it("Live Paint Selection: a click on a painted face selects its fill and commits nothing", async () => {
    covers("tool:media.paged.draw.tool.livePaintSelect");
    const { r, g } = rig([A, B], { reply: PAIR_FACES });
    await r.run(`${C}.makeLivePaintGroup`);
    await r.run(`${C}.fillLivePaintFace`, { face: "0-1#0" });
    const fill = r.elements().at(-1)!;
    r.fake.setSelection([A, B]);
    await arm(r, g, `${T}.livePaintSelect`);
    await slowDrag(g, [250, 250], [251, 251]);
    expect(r.fake.selection()).toEqual([fill]);
    expect(r.sent()).toEqual([]);
  });

  it("Repeat: dragging with the repeat's source selected re-places the ring, as one undo step; Escape commits nothing", async () => {
    covers("tool:media.paged.draw.tool.repeat");
    const { r, g } = rig([A]);
    await r.run(`${C}.makeRadialRepeat`, { count: 4 });
    r.fake.setSelection([A]);
    await arm(r, g, `${T}.repeat`);
    const before = r.picture();
    await slowDrag(g, [200, 200], [400, 450]);
    expect(leafOps(r.leaves())).toContain("insertPath");
    expect(leafOps(r.leaves()).at(-1)).toBe("createGroup");
    await oneUndoStep(r, before);
  });
});

describe("paged.draw tools through the gesture DSL — WP6.1 part 2 [plugin-draw.tool-wave-3]", () => {
  it("Reflect: a click sets the axis point, a drag reflects the selection across the axis, as one undo step; Escape commits nothing", async () => {
    covers("tool:media.paged.draw.tool.reflect");
    const { r, g } = rig([A]);
    await arm(r, g, `${T}.reflect`);
    const before = r.picture();
    await g.click([350, 200]).settle();
    expect(r.sent()).toEqual([]);
    await slowDrag(g, [350, 210], [350, 280]);
    expect(paths(r.leaves())).toEqual(["frameTransform"]);
    await oneUndoStep(r, before);
    await cancelCommitsNothing(`${T}.reflect`, [A], [350, 210], [350, 280]);
  });

  it("Reshape: dragging an anchor writes the reshaped table in one framePath batch, one undo step; Escape commits nothing", async () => {
    covers("tool:media.paged.draw.tool.reshape");
    const { r, g } = rig([]);
    await arm(r, g, `${T}.reshape`);
    const before = r.picture();
    await slowDrag(g, [250, 650], [250, 600]);
    await g.settle(); // the commit waits on the path read the press made
    expect(paths(r.leaves())).toEqual(["framePath", "frameBounds"]);
    await oneUndoStep(r, before);
    await cancelCommitsNothing(`${T}.reshape`, [], [250, 650], [250, 600]);
  });

  it("Shaper: a drawn triangle becomes one closed three-corner path, one undo step; Escape commits nothing", async () => {
    covers("tool:media.paged.draw.tool.shaper");
    const { r, g } = rig([]);
    await arm(r, g, `${T}.shaper`);
    const before = r.picture();
    await g
      .drag({
        from: [600, 100],
        to: [601, 103],
        via: [
          [680, 230],
          [520, 230],
          [600, 100],
        ],
        steps: 12,
      })
      .settle();
    const insert = r.leaves().find((m) => m.op === "insertPath") as {
      args: { anchors: unknown[]; open: boolean };
    };
    expect(insert.args.anchors).toHaveLength(3);
    expect(insert.args.open).toBe(false);
    await oneUndoStep(r, before);
    await cancelCommitsNothing(`${T}.shaper`, [], [600, 100], [680, 230]);
  });

  it("Path Eraser: a drag across the line splits it — the far piece inserted, the line rewritten — one undo step; Escape commits nothing", async () => {
    covers("tool:media.paged.draw.tool.pathEraser");
    const { r, g } = rig([]);
    await arm(r, g, `${T}.pathEraser`);
    const before = r.picture();
    await g.drag({ from: [490, 250], to: [510, 250], steps: 4 }).settle();
    const ops = leafOps(r.leaves());
    expect(ops[0]).toBe("insertPath");
    expect(paths(r.leaves())).toContain("framePath");
    await oneUndoStep(r, before);
    await cancelCommitsNothing(`${T}.pathEraser`, [], [490, 250], [510, 250]);
  });

  it("Join: a scrub over an open path's two ends closes it, one undo step; Escape commits nothing", async () => {
    covers("tool:media.paged.draw.tool.join");
    const { r, g } = rig([]);
    await arm(r, g, `${T}.join`);
    const before = r.picture();
    await g.drag({ from: [95, 498], to: [405, 498], steps: 8 }).settle();
    expect(leafOps(r.leaves())).toEqual(["closePath"]);
    expect(r.steps()).toBe(1);
    await r.undo();
    expect(r.picture()).toBe(before);
    await cancelCommitsNothing(`${T}.join`, [], [95, 498], [405, 498]);
  });

  it("Star: a drag inserts a closed 2·points path, one undo step; Escape commits nothing", async () => {
    covers("tool:media.paged.draw.tool.star");
    const { r, g } = rig([]);
    await arm(r, g, `${T}.star`);
    const before = r.picture();
    await g.drag({ from: [600, 600], to: [600, 560], steps: 4 }).settle();
    const insert = r.leaves().find((m) => m.op === "insertPath") as {
      args: { anchors: unknown[]; open: boolean };
    };
    // Engine ADR 1047: an upright star is a LIVE star — the pentagon on
    // Radius 1, then its points and inset in the same batch; the engine
    // draws the ten points.
    expect(insert.args.anchors).toHaveLength(5);
    expect(insert.args.open).toBe(false);
    expect(
      r
        .leaves()
        .filter((m) =>
          String((m.args as { path?: string }).path ?? "").startsWith(
            "frameShape",
          ),
        )
        .map((m) => (m.args as { path: string }).path),
    ).toEqual(["frameShapeSides", "frameShapeStarInset"]);
    await oneUndoStep(r, before);
    await cancelCommitsNothing(`${T}.star`, [], [600, 600], [600, 560]);
  });

  it("Flare: two drags insert the flare's parts grouped in one batch, one undo step; Escape in the first drag commits nothing", async () => {
    covers("tool:media.paged.draw.tool.flare");
    const { r, g } = rig([]);
    await arm(r, g, `${T}.flare`);
    const before = r.picture();
    await g.drag({ from: [450, 600], to: [480, 600], steps: 4 }).settle();
    expect(r.sent()).toEqual([]);
    await g.drag({ from: [500, 700], to: [520, 720], steps: 4 }).settle();
    expect(r.sent()).toHaveLength(1);
    expect(leafOps(r.leaves()).at(-1)).toBe("createGroup");
    await oneUndoStep(r, before);
    await cancelCommitsNothing(`${T}.flare`, [], [450, 600], [480, 600]);
  });
});
