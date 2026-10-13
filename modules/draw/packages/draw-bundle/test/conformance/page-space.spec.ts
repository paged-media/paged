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

// PAGE SPACE through the REAL engine, on a page that does NOT start at its
// spread's origin: InDesign's single page, at ItemTransform `1 0 0 1 -612
// -396`. The published engine reads `itemTransform` in spread space there;
// core's page-space fix (paged-media/core#70) reads it in page space and
// reports `pageOrigin`. Every assertion is made in SPREAD space, through
// `storedTransformOf` — and the first case proves that conversion against
// the document's own stored `frameTransform` — so the same spec is right on
// either engine. CI runs the pinned one; `PAGED_ENGINE_FROM` points it at a
// local build of the other (`./host.ts`).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { affineReflect, ovalToPath, type Affine } from "@paged-media/draw-geometry";

import { drawBundle } from "../../src";
import { applyReflect, forgetLastTransform } from "../../src/commands/transform";
import {
  applyMakeObjectsOnPath,
  applyReleaseObjectsOnPath,
} from "../../src/commands/objects-on-path";
import { REPEAT_DEFAULTS, repeatBatchFor, repeatHandle, repeatPlanFor } from "../../src/commands/repeat";
import { bindMinted, mutateMinting } from "../../src/commands/minted";
import { ovalStandIns } from "../../src/handlers/oval-stand-ins";
import { pageOriginOf, storedTransformOf } from "../../src/page-origin";
import { packageWithSpread } from "../fixtures/build-idml";
import { openHost } from "./host";

type Vec = [number, number];

/** Where InDesign puts a single 612 × 792 page in its spread. */
const ORIGIN: Vec = [-612, -396];
const PAGE_TRANSFORM = `1 0 0 1 ${ORIGIN[0]} ${ORIGIN[1]}`;

const poly = (id: string): ElementId => ({ kind: "polygon", id }) as ElementId;
const oval = (id: string): ElementId => ({ kind: "oval", id }) as ElementId;

/** `[a, b, c, d, tx, ty]` placing inner coordinates at PAGE `(x, y)`,
 *  rotated by `deg` — stored in spread space, as InDesign writes it. */
const placed = (x: number, y: number, deg = 0): Affine => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), ORIGIN[0] + x, ORIGIN[1] + y];
};
const itemTransform = (m: Affine) => m.map((v) => +v.toFixed(12)).join(" ");

/** A polygon of one or more closed (or one open) contours in inner space. */
function polygon(self: string, contours: Vec[][], m: Affine, open = false): string {
  const xs = contours.flat().map((p) => p[0]);
  const ys = contours.flat().map((p) => p[1]);
  const bounds = `${Math.min(...ys)} ${Math.min(...xs)} ${Math.max(...ys)} ${Math.max(...xs)}`;
  const paths = contours
    .map(
      (c) =>
        `<GeometryPathType PathOpen="${open}"><PathPointArray>` +
        c.map(([x, y]) => `<PathPointType Anchor="${x} ${y}" LeftDirection="${x} ${y}" RightDirection="${x} ${y}"/>`).join("") +
        `</PathPointArray></GeometryPathType>`,
    )
    .join("");
  return (
    `<Polygon Self="${self}" GeometricBounds="${bounds}" ItemTransform="${itemTransform(m)}" FillColor="Color/Black">` +
    `<Properties><PathGeometry>${paths}</PathGeometry></Properties></Polygon>`
  );
}

const square = (n: number, at: Vec = [0, 0]): Vec[] => [
  [at[0], at[1]],
  [at[0] + n, at[1]],
  [at[0] + n, at[1] + n],
  [at[0], at[1] + n],
];

const TRI_AT = placed(100, 100);
const ROT_AT = placed(300, 200, 30);
const OVAL_AT = placed(200, 450, 30);
const RING_AT = placed(100, 600);

const DOC = () =>
  packageWithSpread(
    polygon(
      "tri",
      [
        [
          [0, 0],
          [100, 0],
          [0, 60],
        ],
      ],
      TRI_AT,
    ) +
      polygon("rot", [square(40)], ROT_AT) +
      polygon(
        "spine",
        [
          [
            [0, 0],
            [400, 0],
          ],
        ],
        placed(100, 300),
        true,
      ) +
      polygon("o1", [square(20)], placed(50, 50)) +
      polygon("o2", [square(20)], placed(80, 50)) +
      polygon("ring", [square(40), square(20, [10, 10]).reverse()], RING_AT) +
      `<Oval Self="ov" GeometricBounds="0 0 60 100" ItemTransform="${itemTransform(OVAL_AT)}" FillColor="Color/Black"/>` +
      `<Oval Self="ov2" GeometricBounds="0 0 60 100" ItemTransform="${itemTransform(placed(260, 450))}" FillColor="Color/Black"/>`,
    { pageTransform: PAGE_TRANSFORM },
  );

const apply = (m: Affine, [x, y]: readonly number[]): Vec => [
  m[0] * x! + m[2] * y! + m[4],
  m[1] * x! + m[3] * y! + m[5],
];

describe("draw conformance — page space on a page that does not start at its spread's origin", () => {
  let h: HeadlessHost;

  /** Every contour of `id` in SPREAD space: its anchors through the
   *  STORED transform the read converts to. */
  async function spreadOutline(id: ElementId): Promise<Vec[][]> {
    const t = await h.host.document.pathAnchors(id);
    if (!t) throw new Error(`no anchors for ${String(id.id)}`);
    const m = storedTransformOf((t.itemTransform ?? null) as Affine | null, pageOriginOf(t)) ?? [1, 0, 0, 1, 0, 0];
    const starts = t.subpathStarts.length > 0 ? t.subpathStarts : [0];
    return starts.map((s, i) => t.anchors.slice(s, starts[i + 1] ?? t.anchors.length).map((a) => apply(m, a.anchor)));
  }
  /** The document's own stored transform for `id`. */
  async function frameTransform(id: ElementId): Promise<Affine> {
    const props = await h.host.document.elementProperties(id);
    const e = props?.entries.find((x) => x.path === "frameTransform");
    const v = e?.value;
    if (!v || v.type !== "transform" || !v.value) throw new Error(`no frameTransform for ${String(id.id)}`);
    return v.value as unknown as Affine;
  }
  const near = (got: readonly Vec[][], want: readonly Vec[][]) => {
    expect(got.length).toBe(want.length);
    got.forEach((c, i) => {
      expect(c.length).toBe(want[i]!.length);
      c.forEach((p, j) => {
        expect(p[0]).toBeCloseTo(want[i]![j]![0], 3);
        expect(p[1]).toBeCloseTo(want[i]![j]![1], 3);
      });
    });
  };
  const centre = (contours: readonly Vec[][]): Vec => {
    const pts = contours.flat();
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  };
  /** Does this engine read geometry in page space (and say so)? */
  let pageSpaceEngine = false;

  beforeAll(async () => {
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());
  beforeEach(async () => {
    await h.load(DOC());
    forgetLastTransform();
    await h.host.selection.set([]);
    const [g] = await h.host.document.elementGeometry([poly("tri")]);
    pageSpaceEngine = (g as { pageOrigin?: unknown } | undefined)?.pageOrigin !== undefined;
  });

  it("translate(pageOrigin ?? [0, 0]) ∘ itemTransform IS the stored frameTransform, from both geometry doors", async () => {
    for (const id of [poly("tri"), poly("rot"), poly("ring")]) {
      const stored = await frameTransform(id);
      const [g] = await h.host.document.elementGeometry([id]);
      const t = await h.host.document.pathAnchors(id);
      for (const read of [g, t]) {
        const m = storedTransformOf((read!.itemTransform ?? null) as Affine | null, pageOriginOf(read));
        m!.forEach((v, i) => expect(v).toBeCloseTo(stored[i]!, 6));
        if (pageSpaceEngine) expect(pageOriginOf(read)).toEqual(ORIGIN);
      }
    }
  });

  it("Reflect mirrors an item in place", async () => {
    await h.host.selection.set([poly("tri")]);
    expect((await applyReflect(h.host, 90)).applied).toBe(true);
    // Page (100, 100)–(200, 160), mirrored about its own centre, in spread space.
    near(await spreadOutline(poly("tri")), [
      [
        [-412, -296],
        [-512, -296],
        [-412, -236],
      ],
    ]);
  });

  it("Reflect keeps a rotated item's rotation and mirrors it about its box's centre", async () => {
    const before = await spreadOutline(poly("rot"));
    await h.host.selection.set([poly("rot")]);
    await applyReflect(h.host, 0);
    const r = affineReflect(0, centre(before));
    near(await spreadOutline(poly("rot")), before.map((c) => c.map((p) => apply(r, p))));
  });

  it("Objects on a path: MAKE slots the objects on the path, RELEASE puts them back exactly", async () => {
    const home = await spreadOutline(poly("o1"));
    await h.host.selection.set([poly("o1"), poly("o2"), poly("spine")]);
    const moved = await applyMakeObjectsOnPath(h.host, { alignToPath: false, fitToArtboard: false });
    expect(moved).toHaveLength(2);
    // The path runs from page (100, 300) to (500, 300).
    const a = centre(await spreadOutline(poly("o1")));
    const b = centre(await spreadOutline(poly("o2")));
    expect(a[0]).toBeCloseTo(ORIGIN[0] + 100, 3);
    expect(a[1]).toBeCloseTo(ORIGIN[1] + 300, 3);
    expect(b[0]).toBeCloseTo(ORIGIN[0] + 500, 3);
    expect(b[1]).toBeCloseTo(ORIGIN[1] + 300, 3);
    expect(await applyReleaseObjectsOnPath(h.host)).toBe(2);
    near(await spreadOutline(poly("o1")), home);
  });

  it("Objects on a path: the ARTBOARD fit holds the objects on THIS page (an engine that reports the origin)", async (ctx) => {
    // The published engine reads spread space here and reports no origin,
    // so its artboard fit compares against the wrong rect and refuses;
    // that is the engine fix's to correct, and the bundle uses the origin
    // as soon as it is reported.
    if (!pageSpaceEngine) ctx.skip();
    await h.host.selection.set([poly("o1"), poly("o2"), poly("spine")]);
    const moved = await applyMakeObjectsOnPath(h.host, { alignToPath: false });
    expect(moved).toHaveLength(2);
    expect(centre(await spreadOutline(poly("o2")))[0]).toBeCloseTo(ORIGIN[0] + 500, 3);
  });

  it("Shape Builder: an oval's stand-in lies exactly on the oval's curve", async () => {
    const probe = await ovalStandIns(h.host, [oval("ov"), oval("ov2")], "spec");
    expect(probe).not.toBeNull();
    try {
      for (const [k, id] of [oval("ov"), oval("ov2")].entries()) {
        // The frame box is the oval's own (inner) space either way.
        const [g] = await h.host.document.elementGeometry([id]);
        const m = await frameTransform(id);
        const curve = [ovalToPath(g!.bounds).anchors.map((a) => apply(m, a.anchor))];
        near(await spreadOutline(probe!.ids[k]!), curve);
      }
    } finally {
      await probe!.release();
    }
    // Withdrawn: the stand-ins are gone, the ovals untouched.
    expect(await h.host.document.pathAnchors(probe!.ids[0]!).catch(() => null)).toBeNull();
  });

  it("Repeat: a compound source's copy keeps its hole and lands where its plan puts it", async () => {
    const plan = await repeatPlanFor(h.host, {
      repeat: "rep-ps",
      params: { ...REPEAT_DEFAULTS, kind: "grid", columns: 2, rows: 1, spacing: [10, 10], fitToArtboard: false },
      ids: [poly("ring")],
      label: "spec",
    });
    expect(plan!.placements).toHaveLength(1);
    const [, , , , dx, dy] = plan!.placements[0]!.matrix;
    const batch = repeatBatchFor({ plan: plan!, sourceEnvelopes: [null] });
    const made = await mutateMinting(h.host, batch);
    expect(made.outcome.applied).toBe(true);
    const copy = bindMinted(made, batch)!.byHandle.get(repeatHandle(0, 0))!;
    const source = await spreadOutline(poly("ring"));
    near(await spreadOutline(copy), source.map((c) => c.map(([x, y]) => [x + dx, y + dy] as Vec)));
  });
});
