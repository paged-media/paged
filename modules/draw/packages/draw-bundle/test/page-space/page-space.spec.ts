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

// PAGE SPACE vs THE STORED MATRIX, on both engines (`../../src/page-origin.ts`).
//
// Every case runs twice, against a fake engine answering the way the
// PUBLISHED engine does (`itemTransform` in spread space, no `pageOrigin`)
// and the way core's page-space fix does (paged-media/core#70: the page's
// origin folded into `itemTransform`, reported as `pageOrigin`). The
// documents sit on InDesign's facing spread, where NEITHER page starts at
// the spread's origin (verso (-612, -396), recto (0, -396)) — the case
// where the two answers differ. Each case asserts where the artwork ENDS
// UP (stored anchors through the stored transform), not which ops were
// sent.

import { beforeEach, describe, expect, it } from "vitest";

import type { ElementId, PluginMetadataEnvelope } from "@paged-media/plugin-api";
import { affineReflect, type Affine, type AnchorTable } from "@paged-media/draw-geometry";

import {
  applyReflect,
  applyTransformAgain,
  forgetLastTransform,
} from "../../src/commands/transform";
import {
  OBJECTS_ON_PATH_DEFAULTS,
  objectsOnPathBatchFor,
  objectsOnPathPlanFor,
  objectsOnPathReleaseBatchFor,
  onPathObjectOf,
  type ObjectsOnPathParams,
} from "../../src/commands/objects-on-path";
import { ovalStandInBatchFor } from "../../src/handlers/oval-stand-ins";
import { shapeBuildBatchFor } from "../../src/commands/shape-build";
import { knifeBatchFor, knifeTargetOf } from "../../src/commands/knife";
import { REPEAT_DEFAULTS, repeatBatchFor, repeatPlanFor } from "../../src/commands/repeat";
import { PATTERN_DEFAULTS, patternBatchFor, patternPlanFor } from "../../src/commands/pattern";
import { faceTableOf, livePaintArrangement, livePaintBatchFor } from "../../src/commands/live-paint";
import { symbolBatchFor, symbolPlacePlanFor } from "../../src/commands/symbols";
import {
  bindTraceRegions,
  pixelToPageAffine,
  traceFinishBatchFor,
  traceInsertBatchFor,
  tracePlanFor,
} from "../../src/commands/image-trace";
import { TRACE_DEFAULTS } from "../../src/trace-engine";
import {
  pageOriginOf,
  spreadTableOf,
  storedTransformOf,
} from "../../src/page-origin";
import {
  FakeEngine,
  RECTO,
  RT,
  SHAPES,
  T,
  VERSO,
  fakeHost,
  outlineDelta,
} from "./fake-engine";

type Vec = [number, number];

const poly = (id: string): ElementId => ({ kind: "polygon", id }) as ElementId;
const square = (n: number, at: Vec = [0, 0]): Vec[] => [
  [at[0], at[1]],
  [at[0] + n, at[1]],
  [at[0] + n, at[1] + n],
  [at[0], at[1] + n],
];
/** A 40 pt square with a 20 pt square hole. */
const RING: Vec[][] = [square(40), square(20, [10, 10]).reverse()];

const mapOutline = (m: Affine, contours: readonly Vec[][]): Vec[][] =>
  contours.map((c) => c.map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]] as Vec));
const outlineOf = (t: AnchorTable): Vec[][] => {
  const starts = t.subpathStarts.length > 0 ? t.subpathStarts : [0];
  return starts.map((s, i) =>
    t.anchors.slice(s, starts[i + 1] ?? t.anchors.length).map((a) => [a.anchor[0], a.anchor[1]] as Vec),
  );
};
const centreOf = (contours: readonly Vec[][]): Vec => {
  const pts = contours.flat();
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
};
const near = (got: readonly Vec[][], want: readonly Vec[][]) =>
  expect(outlineDelta(got, want), `got ${JSON.stringify(got)}\nwant ${JSON.stringify(want)}`).toBeLessThan(1e-6);
const nearPoint = (got: Vec, want: Vec) => {
  expect(got[0]).toBeCloseTo(want[0], 6);
  expect(got[1]).toBeCloseTo(want[1], 6);
};

describe("page-origin helpers", () => {
  it("reads `pageOrigin` when the engine sends one, [0, 0] otherwise", () => {
    expect(pageOriginOf({ pageOrigin: [-612, -396] })).toEqual([-612, -396]);
    expect(pageOriginOf({})).toEqual([0, 0]);
    expect(pageOriginOf(null)).toEqual([0, 0]);
    expect(pageOriginOf({ pageOrigin: [1, Number.NaN] })).toEqual([0, 0]);
    expect(pageOriginOf({ pageOrigin: "x" })).toEqual([0, 0]);
  });

  it("stored = translate(pageOrigin) ∘ itemTransform; null stays null at the spread's origin", () => {
    expect(storedTransformOf([0, 1, -1, 0, 10, 20], [-612, -396])).toEqual([0, 1, -1, 0, -602, -376]);
    expect(storedTransformOf(null, [-612, -396])).toEqual([1, 0, 0, 1, -612, -396]);
    expect(storedTransformOf(null, [0, 0])).toBeNull();
    const m: Affine = [2, 0, 0, 2, 5, 5];
    expect(storedTransformOf(m, [0, 0])).toBe(m);
  });

  it("a page-space table moves into its spread by the origin, anchors and handles", () => {
    const t: AnchorTable = {
      anchors: [{ anchor: [1, 2], left: [0, 2], right: [2, 2] }],
      subpathStarts: [0],
    };
    expect(spreadTableOf(t, [0, 0])).toBe(t);
    expect(spreadTableOf(t, [-10, 5]).anchors[0]).toEqual({ anchor: [-9, 7], left: [-10, 7], right: [-8, 7] });
  });
});

describe.each(SHAPES)("page space on the %s-space engine", (shape) => {
  let engine: FakeEngine;
  beforeEach(() => {
    engine = new FakeEngine(shape);
    forgetLastTransform();
  });

  // ------------------------------------------------------------ Reflect

  describe("Reflect and Transform again", () => {
    /** A right triangle at page (100, 100)–(200, 160) on the verso. */
    const TRI: Vec[] = [
      [0, 0],
      [100, 0],
      [0, 60],
    ];

    it("mirrors an item on a verso about its own centre, in place", async () => {
      engine.addPath("tri", VERSO, TRI, T(100, 100));
      const done = await applyReflect(fakeHost(engine, [poly("tri")]), 90);
      expect(done.applied).toBe(true);
      near(engine.pageOutline("tri", VERSO), [
        [
          [200, 100],
          [100, 100],
          [200, 160],
        ],
      ]);
    });

    it("keeps a rotated item's rotation and mirrors it about its box's centre", async () => {
      const onPage = RT(30, 300, 200);
      engine.addPath("tri", VERSO, TRI, onPage);
      const before = engine.pageOutline("tri", VERSO);
      await applyReflect(fakeHost(engine, [poly("tri")]), 90);
      const c = centreOf(before);
      near(engine.pageOutline("tri", VERSO), mapOutline(affineReflect(90, c), before));
    });

    it("a selection across the spine mirrors about ONE centre, in spread space", async () => {
      engine.addPath("tri", VERSO, TRI, T(100, 100));
      engine.addPath("sq", RECTO, square(40), T(300, 100));
      const before = { tri: engine.spreadOutline("tri"), sq: engine.spreadOutline("sq") };
      await applyReflect(fakeHost(engine, [poly("tri"), poly("sq")]), 90);
      const c = centreOf([...before.tri, ...before.sq]);
      near(engine.spreadOutline("tri"), mapOutline(affineReflect(90, c), before.tri));
      near(engine.spreadOutline("sq"), mapOutline(affineReflect(90, c), before.sq));
    });

    it("a GROUP (spread-space box and transform) and an item mirror about one centre", async () => {
      engine.addPath("tri", VERSO, TRI, T(100, 100));
      engine.addPath("m", VERSO, square(40), T(300, 400));
      engine.addGroup("g", ["m"]);
      const before = { tri: engine.spreadOutline("tri"), m: engine.spreadOutline("m") };
      const group = { kind: "group", id: "g" } as ElementId;
      const done = await applyReflect(fakeHost(engine, [poly("tri"), group]), 0);
      expect(done.applied).toBe(true);
      const c = centreOf([...before.tri, ...before.m]);
      near(engine.spreadOutline("tri"), mapOutline(affineReflect(0, c), before.tri));
      near(engine.spreadOutline("m"), mapOutline(affineReflect(0, c), before.m));
    });

    it("Transform again repeats it about the NEW selection's centre", async () => {
      engine.addPath("tri", VERSO, TRI, T(100, 100));
      engine.addPath("sq", RECTO, square(40), T(300, 100));
      await applyReflect(fakeHost(engine, [poly("tri")]), 0);
      const before = engine.pageOutline("sq", RECTO);
      const again = await applyTransformAgain(fakeHost(engine, [poly("sq")]));
      expect(again.applied).toBe(true);
      near(engine.pageOutline("sq", RECTO), mapOutline(affineReflect(0, centreOf(before)), before));
    });
  });

  // ---------------------------------------------------- objects on a path

  describe("Objects on a path", () => {
    const params = (over: Partial<ObjectsOnPathParams> = {}): ObjectsOnPathParams => ({
      ...OBJECTS_ON_PATH_DEFAULTS,
      alignToPath: false,
      fitToArtboard: false,
      ...over,
    });
    /** An open straight path from page (100, 300) to (500, 300) on the
     *  verso, and two 20 pt squares (one rotated) above it. */
    const seed = () => {
      engine.addPath(
        "spine",
        VERSO,
        [
          [0, 0],
          [400, 0],
        ],
        T(100, 300),
        true,
      );
      engine.addPath("o1", VERSO, square(20), T(50, 50));
      engine.addPath("o2", VERSO, square(20), RT(30, 120, 50));
    };
    const plan = (over: Partial<ObjectsOnPathParams> = {}, homes: Record<string, Affine> = {}) =>
      objectsOnPathPlanFor(fakeHost(engine), {
        onPath: "op-1",
        params: params(over),
        pathId: poly("spine"),
        objects: ["o1", "o2"].map((id) => ({ id: poly(id), home: homes[id] ?? null })),
        label: "spec",
      });

    it("MAKE puts each object's centre on its slot of the path, on the path's page", async () => {
      seed();
      const p = await plan();
      expect(p).not.toBeNull();
      expect(engine.mutate(objectsOnPathBatchFor({ plan: p!, envelopes: new Map() })).applied).toBe(true);
      nearPoint(centreOf(engine.pageOutline("o1", VERSO)), [100, 300]);
      nearPoint(centreOf(engine.pageOutline("o2", VERSO)), [500, 300]);
    });

    it("the HOME it remembers is the STORED matrix — what frameTransform writes back", async () => {
      seed();
      const stored = { o1: engine.storedTransform("o1")!, o2: engine.storedTransform("o2")! };
      const p = await plan();
      const batch = objectsOnPathBatchFor({ plan: p!, envelopes: new Map() }) as {
        args: { ops: { op: string; args: { elementId: ElementId; value: string | null } }[] };
      };
      const homes = new Map<string, number[]>();
      for (const op of batch.args.ops) {
        if (op.op !== "setPluginMetadata" || !op.args.value) continue;
        const ref = onPathObjectOf(JSON.parse(op.args.value) as PluginMetadataEnvelope);
        if (ref) homes.set(String(op.args.elementId.id), [...ref.home]);
      }
      for (const id of ["o1", "o2"] as const) {
        homes.get(id)!.forEach((v, i) => expect(v).toBeCloseTo(stored[id][i]!, 9));
      }
    });

    it("RELEASE writes a home remembered by an earlier version back verbatim — exact on either engine", async () => {
      seed();
      // An earlier version remembered the matrix the published engine
      // read: the stored one. The object has since moved onto the path.
      const home = engine.storedTransform("o1")!;
      const before = engine.pageOutline("o1", VERSO);
      engine.mutate(objectsOnPathBatchFor({ plan: (await plan())!, envelopes: new Map() }));
      const release = objectsOnPathReleaseBatchFor([{ id: poly("o1"), envelope: null, key: "onPathObject", home }]);
      expect(engine.mutate(release).applied).toBe(true);
      expect(engine.storedTransform("o1")).toEqual(home);
      near(engine.pageOutline("o1", VERSO), before);
    });

    it("UPDATE places from a remembered (stored) home, wherever the object now is", async () => {
      seed();
      const homes = { o1: engine.storedTransform("o1")!, o2: engine.storedTransform("o2")! };
      engine.mutate(objectsOnPathBatchFor({ plan: (await plan())!, envelopes: new Map() }));
      const update = await plan({ reverseOrder: true }, homes);
      expect(engine.mutate(objectsOnPathBatchFor({ plan: update!, envelopes: new Map() })).applied).toBe(true);
      nearPoint(centreOf(engine.pageOutline("o1", VERSO)), [500, 300]);
      nearPoint(centreOf(engine.pageOutline("o2", VERSO)), [100, 300]);
    });

    it.runIf(shape === "page")(
      "the ARTBOARD fit measures against the path's page where it sits in the spread",
      async () => {
        // A path running past the verso's right edge (612 pt): the object
        // slotted at x 700 would leave the page, the one at x 100 does not.
        engine.addPath(
          "spine",
          VERSO,
          [
            [0, 0],
            [600, 0],
          ],
          T(100, 300),
          true,
        );
        engine.addPath("o1", VERSO, square(20), T(50, 50));
        engine.addPath("o2", VERSO, square(20), T(80, 50));
        const p = await plan({ fitToArtboard: true });
        expect(p!.placements.map((x) => x.skipped)).toEqual([null, "offPage"]);
        engine.mutate(objectsOnPathBatchFor({ plan: p!, envelopes: new Map() }));
        nearPoint(centreOf(engine.pageOutline("o1", VERSO)), [100, 300]);
      },
    );
  });

  // ------------------------------------------------------- oval stand-ins

  describe("Shape Builder oval stand-ins", () => {
    it.each([
      ["a rotated oval on the verso", VERSO, RT(30, 200, 300)],
      ["a scaled oval on the recto", RECTO, [1.5, 0, 0, 0.5, 100, 400] as Affine],
      ["an unrotated oval on the verso", VERSO, T(150, 150)],
    ])("%s gets a stand-in exactly on its curve", async (_name, page, onPage) => {
      engine.addOval("ov", page, [0, 0, 60, 100], onPage);
      const geom = engine.elementGeometry([{ kind: "oval", id: "ov" } as ElementId]);
      const probe = ovalStandInBatchFor(
        geom.map((g) => ({
          pageId: g.pageId,
          bounds: g.bounds,
          itemTransform: g.itemTransform,
          pageOrigin: pageOriginOf(g),
        })),
      );
      const out = engine.mutate(probe);
      expect(out.applied).toBe(true);
      near(engine.spreadOutline(String(out.minted[0]!.id)), engine.spreadOutline("ov"));
    });
  });

  // ------------------------------------------------- Shape Builder pieces

  describe("Shape Builder pieces", () => {
    /** The frontmost input: a rotated 100 pt square on the verso. A face
     *  of the arrangement is RAW space — the inputs' own. */
    const seed = () => engine.addPath("front", VERSO, square(100), RT(20, 200, 200));
    const TRI_FACE = {
      anchors: (
        [
          [10, 10],
          [90, 10],
          [10, 70],
        ] as Vec[]
      ).map((p) => ({ anchor: p, left: p, right: p })),
      subpathStarts: [0],
    };
    const HOLED_FACE = {
      anchors: [...square(80, [10, 10]), ...square(20, [40, 40]).reverse()].map((p) => ({
        anchor: p,
        left: p,
        right: p,
      })),
      subpathStarts: [0, 4],
    };
    const ctxFor = (faces: Record<string, typeof TRI_FACE>) => {
      const read = engine.pathAnchors(poly("front"))!;
      return {
        inputs: [poly("front")],
        faces: new Map(Object.entries(faces)),
        matrix: (read.itemTransform ?? null) as Affine | null,
        pageOrigin: pageOriginOf(read),
        pageId: read.pageId!,
        paints: new Map(),
      };
    };

    it.each([
      ["a one-contour piece", TRI_FACE],
      ["a holed piece", HOLED_FACE],
    ])("%s lands where the face is, in the inputs' own space", async (_n, face) => {
      seed();
      const batch = shapeBuildBatchFor(
        { rewrites: [], inserts: [{ face: "f", paintFrom: 0 }], merge: null, deletes: [], untouched: [] },
        ctxFor({ f: face }),
      );
      const out = engine.mutate(batch);
      expect(out.applied).toBe(true);
      const piece = String(out.minted[0]!.id);
      // The piece STORES the raw face and the input's stored transform —
      // the frame the engine's union of pieces reads.
      expect(engine.storedTransform(piece)).toEqual(engine.storedTransform("front"));
      near(engine.spreadOutline(piece), mapOutline(engine.storedTransform("front")!, outlineOf(face)));
    });
  });

  // ---------------------------------------------- framePath on a new path

  describe("a new path re-tabled by framePath lands on its page", () => {
    it("Knife: a holed piece inserted beside the target", async () => {
      engine.addPath("t", VERSO, square(100), RT(15, 200, 200));
      const host = fakeHost(engine);
      const read = engine.pathAnchors(poly("t"))!;
      const m = read.itemTransform as Affine;
      const cut: Vec[] = [
        [50, -10],
        [50, 110],
      ].map(([x, y]) => [m[0] * x! + m[2] * y! + m[4], m[1] * x! + m[3] * y! + m[5]] as Vec);
      const target = await knifeTargetOf(host, poly("t"), read.pageId!, cut);
      expect("skip" in target).toBe(false);
      const holed: AnchorTable = {
        anchors: [...square(40, [55, 5]), ...square(10, [70, 20]).reverse()].map((p) => ({
          anchor: p,
          left: p,
          right: p,
        })),
        subpathStarts: [0, 4],
      };
      const keep: AnchorTable = {
        anchors: square(45).map((p) => ({ anchor: p, left: p, right: p })),
        subpathStarts: [0],
      };
      const out = engine.mutate(
        knifeBatchFor([
          {
            target: target as Exclude<typeof target, { skip: unknown }>,
            pieces: [keep, holed],
            paint: { fill: null, stroke: null, weight: null },
          },
        ]),
      );
      expect(out.applied).toBe(true);
      near(engine.spreadOutline(String(out.minted[0]!.id)), mapOutline(engine.storedTransform("t")!, outlineOf(holed)));
    });

    it("Repeat: a compound source's copy keeps its hole and its place", async () => {
      engine.addPath("ring", VERSO, RING, T(100, 100));
      const host = fakeHost(engine);
      const plan = await repeatPlanFor(host, {
        repeat: "rep-1",
        params: { ...REPEAT_DEFAULTS, kind: "grid", columns: 2, rows: 1, spacing: [10, 10], fitToArtboard: false },
        ids: [poly("ring")],
        label: "spec",
      });
      expect(plan!.placements).toHaveLength(1);
      const [, , , , dx, dy] = plan!.placements[0]!.matrix;
      const out = engine.mutate(repeatBatchFor({ plan: plan!, sourceEnvelopes: [null] }));
      expect(out.applied).toBe(true);
      const copy = String(out.minted[0]!.id);
      near(engine.spreadOutline(copy), mapOutline(T(dx, dy), engine.spreadOutline("ring")));
    });

    it("Pattern: a compound source's tile keeps its hole and its place", async () => {
      engine.addPath("ring", VERSO, RING, T(100, 100));
      const host = fakeHost(engine);
      const plan = await patternPlanFor(host, {
        field: "pat-1",
        params: { ...PATTERN_DEFAULTS, columns: 2, rows: 1, fitToArtboard: false },
        ids: [poly("ring")],
        label: "spec",
      });
      expect(plan).not.toBeNull();
      const out = engine.mutate(patternBatchFor({ plan: plan!, sourceEnvelopes: [null] }));
      expect(out.applied).toBe(true);
      // The first tile is the source's own position: its copy sits on it.
      const tile = plan!.tiles[0]!;
      near(
        engine.spreadOutline(String(out.minted[0]!.id)),
        mapOutline(T(tile.offset[0], tile.offset[1]), engine.spreadOutline("ring")),
      );
    });

    it("Live Paint: a holed face's fill lands on the face", async () => {
      engine.addPath("a", VERSO, square(100), RT(10, 200, 200));
      engine.addPath("b", VERSO, square(100), RT(10, 250, 250));
      const raw = [...square(80, [10, 10]), ...square(20, [40, 40]).reverse()];
      engine.planarFaces = [
        {
          id: "sig#0",
          signature: [0],
          anchors: raw.map((p) => ({ anchor: p, left: p, right: p })),
          subpathStarts: [0, 4],
        },
      ];
      const group = {
        id: "lp-1",
        name: "Live paint 1",
        inputs: [
          { kind: "polygon", id: "a" },
          { kind: "polygon", id: "b" },
        ],
        faces: [],
      };
      const arrangement = await livePaintArrangement(fakeHost(engine), group, "spec");
      expect(arrangement).not.toBeNull();
      const face = arrangement!.faces[0]!;
      const out = engine.mutate(
        livePaintBatchFor({
          ...arrangement!,
          groupId: group.id,
          faces: [{ face: face.id, fill: null, table: faceTableOf(face) }],
          stale: [],
        }),
      );
      expect(out.applied).toBe(true);
      near(
        engine.spreadOutline(String(out.minted[0]!.id)),
        mapOutline(engine.storedTransform("a")!, [raw.slice(0, 4), raw.slice(4)]),
      );
    });

    it("Image Trace: a holed region lands on the frame", async () => {
      engine.addPath("frame", VERSO, square(100), RT(5, 150, 150));
      const [g] = engine.elementGeometry([poly("frame")]);
      const result = {
        width: 100,
        height: 100,
        clusters: 1,
        truncated: 0,
        speckles: 0,
        regions: [
          {
            color: [200, 10, 10] as [number, number, number],
            pixels: 2000,
            contours: [square(80, [10, 10]), square(20, [40, 40])].map((c) => ({
              area: 1,
              anchors: c.map((p) => ({ anchor: p, left: p, right: p })),
            })),
          },
        ],
      };
      const common = {
        source: poly("frame"),
        sourceUri: "spec.png",
        result,
        scale: 1,
        sourcePixels: [100, 100] as [number, number],
        options: TRACE_DEFAULTS,
      };
      const plan = tracePlanFor({
        ...common,
        pageId: g!.pageId!,
        pageOrigin: pageOriginOf(g),
        pixelToPage: pixelToPageAffine(g!.bounds, (g!.itemTransform ?? null) as Affine | null, 100, 100)!,
      });
      // Where it belongs: the same trace through the STORED transform.
      const truth = tracePlanFor({
        ...common,
        pageId: g!.pageId!,
        pixelToPage: pixelToPageAffine(g!.bounds, engine.storedTransform("frame"), 100, 100)!,
      });
      const inserted = engine.mutate(traceInsertBatchFor(plan));
      expect(inserted.applied).toBe(true);
      const bindings = bindTraceRegions(plan, inserted.minted)!;
      const finish = engine.mutate(
        traceFinishBatchFor({ plan, bindings, record: {} as never, sourceEnvelope: null }),
      );
      expect(finish.applied).toBe(true);
      near(engine.spreadOutline(String(bindings[0]!.keep.id)), outlineOf(truth.regions[0]!.table));
    });

    it.runIf(shape === "page")("Symbols: a compound piece rebuilt on a verso keeps its hole and its place", () => {
      // A rebuild plans at the instance's LIVE origin, read in page space,
      // with that read's page origin.
      const symbol = {
        id: "sym-1",
        name: "Ring",
        registration: "center" as const,
        origin: [0, 0] as [number, number],
        pieces: [
          {
            table: {
              anchors: RING.flat().map((p) => ({ anchor: p, left: p, right: p })),
              subpathStarts: [0, 4],
            },
            paint: { fill: null, stroke: null, weight: null },
          },
        ],
      };
      const plan = symbolPlacePlanFor({
        symbol,
        pageId: VERSO.id,
        pageOrigin: VERSO.origin,
        instanceId: "si-1",
        origin: [300, 300],
      });
      const out = engine.mutate(symbolBatchFor([{ plan }]));
      expect(out.applied).toBe(true);
      near(engine.pageOutline(String(out.minted[0]!.id), VERSO), mapOutline(T(300, 300), RING));
    });
  });
});
