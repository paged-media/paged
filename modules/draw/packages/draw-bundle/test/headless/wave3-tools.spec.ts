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

// WP6.1 part 2 through the REAL engine wasm: Simplify's live preview and
// corner lane, the Reflect tool, Join, Reshape, Path Eraser, Star, Flare
// and Shaper. Each verb is asserted on the document it leaves AND on its
// undo: ONE mutation, ONE undo step, and the undo restores what was there.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import type {
  ElementId,
  PathAnchorsResult,
  SceneTreeNode,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { recogniseShape, type Vec2 } from "@paged-media/draw-geometry";

import {
  applyInsertFlare,
  applyJoinScrub,
  applyPathErase,
  applyReshapeAt,
  applyShaperStroke,
  applySimplifyPath,
  createFlareHandler,
  createJoinHandler,
  createPathEraserHandler,
  createReflectHandler,
  createReshapeHandler,
  createShaperHandler,
  createStarHandler,
  drawBundle,
  forgetLastTransform,
  simplifyPreviewOf,
  showSimplifyPreview,
  clearSimplifyPreview,
  WAVE3_TOOL_IDS,
  type EraseResult,
  type JoinResult,
  type ShaperResult,
} from "../../src";
import { packageWithSpread, pathItem } from "../fixtures/build-idml";
import { leafIds, poly, squareItem, PAGE_ID } from "../panels/panel-document";
import { countingHost } from "../perf/counting-host";
import { pointerAt, settle } from "../perf/pointer-stream";
import { openHost } from "./host";
import { covers } from "@paged-media/test-kit";
import strokes from "../../../draw-geometry/test/fixtures/shaper-strokes.json";

const S = strokes as unknown as Record<string, Vec2[]>;
const SQ = poly("sq");
const WAVE = poly("wave");
const A = poly("a");
const B = poly("b");

/** A dense open sine polyline (what a pencil leaves): 61 corners. */
const wavePoints = (): { a: [number, number] }[] =>
  Array.from({ length: 61 }, (_, i) => {
    const x = 100 + (i / 60) * 300;
    return { a: [x, 400 + 30 * Math.sin(((x - 100) / 300) * Math.PI * 2)] };
  });

const DOC = () =>
  packageWithSpread(
    squareItem("sq", 100, 100, 100) +
      pathItem("Polygon", "wave", "370 100 430 400", true, wavePoints()) +
      pathItem("Polygon", "a", "250 300 250 400", true, [
        { a: [300, 250] },
        { a: [400, 250] },
      ]) +
      pathItem("Polygon", "b", "250 420 250 520", true, [
        { a: [420, 250] },
        { a: [520, 250] },
      ]),
  );

const tableOf = async (
  h: HeadlessHost,
  id: ElementId,
): Promise<PathAnchorsResult | null> => h.host.document.pathAnchors(id);

const key = (ids: readonly ElementId[]) =>
  ids.map((i) => `${i.kind}:${String(i.id)}`).sort();

const drag = (
  handler: ReturnType<typeof createJoinHandler>,
  pts: [number, number][],
  opts: { alt?: boolean; shift?: boolean } = {},
) => {
  handler.onPointerDown(pointerAt(PAGE_ID, pts[0]!, opts));
  for (const p of pts.slice(1, -1))
    handler.onPointerMove(pointerAt(PAGE_ID, p, opts));
  handler.onPointerUp({
    ...pointerAt(PAGE_ID, pts[pts.length - 1]!, opts),
    maxDelta: 50,
  });
};

describe("draw conformance — WP6.1 part 2 tools [plugin-draw.tool-wave-3]", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());
  beforeEach(async () => {
    await h.load(DOC());
    await h.host.selection.set([]);
    forgetLastTransform();
  });

  it("every new tool is keyless, in the host flyout Illustrator keeps it in", () => {
    const tools = h.toolsContributed();
    const group = (id: string) => tools.find((t) => t.id === id);
    expect(WAVE3_TOOL_IDS.map((id) => group(id)?.group)).toEqual([
      "transform",
      "transform",
      "pencil",
      "pencil",
      "shape",
      "shape",
      "pencil",
    ]);
    for (const id of WAVE3_TOOL_IDS)
      expect(group(id)!.shortcut).toBeUndefined();
  });

  describe("Simplify — live preview and the corner angle", () => {
    it("the preview draws the simplified selection in the bundle's overlay layer, before anything is written", async () => {
      const { host, work } = countingHost(h.host);
      const preview = await simplifyPreviewOf(host, [WAVE], {
        tolerance: 2,
        cornerAngle: 0,
      });
      expect(preview.before).toBe(61);
      expect(preview.after).toBeLessThan(12);
      expect(preview.shapes).toHaveLength(1);
      showSimplifyPreview(h.host, preview.shapes);
      const layer = h.overlayLayers().find((l) => l.shapes.length > 0);
      expect(layer?.shapes).toHaveLength(1);
      expect((layer!.shapes[0] as { dashed?: boolean }).dashed).toBe(true);
      clearSimplifyPreview(h.host);
      expect(
        h.overlayLayers().find((l) => l.key === layer!.key)?.shapes,
      ).toEqual([]);
      expect(work.mutations).toEqual([]);
    });

    it("a corner angle (100°) keeps the square's corners and writes EXACTLY the preview in one undo step", async () => {
      await h.host.selection.set([WAVE, SQ]);
      const preview = await simplifyPreviewOf(h.host, [WAVE], {
        tolerance: 2,
        cornerAngle: 100,
      });
      const before = await tableOf(h, WAVE);
      const { host, work } = countingHost(h.host);
      await applySimplifyPath(host, { tolerance: 2, cornerAngle: 100 });
      expect(work.mutations).toHaveLength(1);
      const after = (await tableOf(h, WAVE))!;
      expect(after.anchors).toHaveLength(preview.after);
      const want = (
        preview.shapes[0] as unknown as {
          anchors: { anchor: [number, number] }[];
        }
      ).anchors;
      after.anchors.forEach((a, i) => {
        expect(a.anchor[0]).toBeCloseTo(want[i]!.anchor[0], 3);
        expect(a.anchor[1]).toBeCloseTo(want[i]!.anchor[1], 3);
      });
      expect(after.subpathOpen).toEqual([true]);
      // The square kept its four corners.
      expect((await tableOf(h, SQ))!.anchors.map((a) => a.anchor)).toEqual([
        [100, 100],
        [200, 100],
        [200, 200],
        [100, 200],
      ]);
      await h.host.document.undo();
      expect((await tableOf(h, WAVE))!.anchors).toEqual(before!.anchors);
    });
  });

  describe("Reflect tool", () => {
    it("a click sets the axis point; a drag reflects the selection across the axis through it — one undo step", async () => {
      await h.host.selection.set([SQ]);
      const results: unknown[] = [];
      let reflected!: () => void;
      const done = new Promise<void>((r) => (reflected = r));
      const handler = createReflectHandler(h.host, {
        onReflect: (r) => {
          results.push(r);
          reflected();
        },
      });
      handler.onActivate(undefined as never);
      // Axis point at x = 250, then a vertical drag: a vertical axis.
      handler.onPointerDown(pointerAt(PAGE_ID, [250, 150]));
      handler.onPointerUp(pointerAt(PAGE_ID, [250, 150]));
      handler.onPointerDown(pointerAt(PAGE_ID, [250, 160]));
      handler.onPointerMove(pointerAt(PAGE_ID, [250, 220]));
      handler.onPointerUp(pointerAt(PAGE_ID, [250, 260]));
      await done;
      expect(results).toHaveLength(1);
      const [g] = await h.host.document.elementGeometry([SQ]);
      const m = g!.itemTransform as number[];
      // The square [100..200] mirrored about x = 250 lands on [300..400].
      const x0 = m[0]! * 100 + m[2]! * 100 + m[4]!;
      const x1 = m[0]! * 200 + m[2]! * 100 + m[4]!;
      expect(Math.min(x0, x1)).toBeCloseTo(300, 3);
      expect(Math.max(x0, x1)).toBeCloseTo(400, 3);
      await h.host.document.undo();
      const [back] = await h.host.document.elementGeometry([SQ]);
      expect(back!.itemTransform ?? [1, 0, 0, 1, 0, 0]).toEqual([
        1, 0, 0, 1, 0, 0,
      ]);
    });

    it("Alt+click on a host with no panel door reflects with the last-used angle about the clicked point", async () => {
      await h.host.selection.set([SQ]);
      let raised: boolean | null = null;
      let reflected!: () => void;
      const done = new Promise<void>((r) => (reflected = r));
      const handler = createReflectHandler(h.host, {
        onOptions: (_p, r) => (raised = r),
        onReflect: () => reflected(),
      });
      handler.onActivate(undefined as never);
      handler.onPointerDown(pointerAt(PAGE_ID, [100, 300], { alt: true }));
      handler.onPointerUp(pointerAt(PAGE_ID, [100, 300], { alt: true }));
      await done;
      await settle();
      expect(raised).toBe(false);
      // The default axis is vertical (90°): mirrored about x = 100.
      const [g] = await h.host.document.elementGeometry([SQ]);
      const m = g!.itemTransform as number[];
      expect(m[0]! * 200 + m[4]!).toBeCloseTo(0, 3);
    });
  });

  describe("Join tool", () => {
    it("a scrub over the GAP joins the two paths into one open path, one undo step", async () => {
      const { host, work } = countingHost(h.host);
      const r = await applyJoinScrub(
        host,
        PAGE_ID,
        [
          [395, 245],
          [425, 255],
        ],
        8,
      );
      expect(r).toMatchObject({ applied: true, kind: "gap" });
      expect(work.mutations).toHaveLength(1);
      const leaves = key(await leafIds(h));
      expect(leaves).not.toContain("polygon:b");
      const t = (await tableOf(h, A))!;
      expect(t.subpathOpen).toEqual([true]);
      expect(t.anchors.map((a) => a.anchor)).toEqual([
        [300, 250],
        [400, 250],
        [420, 250],
        [520, 250],
      ]);
      await h.host.document.undo();
      expect(key(await leafIds(h))).toContain("polygon:b");
      expect((await tableOf(h, A))!.anchors).toHaveLength(2);
    });

    it("a scrub over the overhangs of a CROSSING trims both and welds them at the crossing", async () => {
      await h.load(
        packageWithSpread(
          pathItem("Polygon", "a", "250 100 250 220", true, [
            { a: [100, 250] },
            { a: [220, 250] },
          ]) +
            pathItem("Polygon", "b", "150 200 270 200", true, [
              { a: [200, 150] },
              { a: [200, 270] },
            ]),
        ),
      );
      const r = await applyJoinScrub(
        h.host,
        PAGE_ID,
        [
          [210, 256],
          [204, 256],
          [206, 260],
        ],
        6,
      );
      expect(r).toMatchObject({ applied: true, kind: "crossing" });
      const t = (await tableOf(h, A))!;
      const pts = t.anchors.map((a) => a.anchor);
      expect(pts).toHaveLength(3);
      expect(pts[1]![0]).toBeCloseTo(200, 3);
      expect(pts[1]![1]).toBeCloseTo(250, 3);
      expect(key(await leafIds(h))).toEqual(["polygon:a"]);
    });

    it("one path's two ends close it; the live tool scrubs", async () => {
      await h.load(
        packageWithSpread(
          pathItem("Polygon", "u", "100 100 200 200", true, [
            { a: [100, 100] },
            { a: [100, 200] },
            { a: [200, 200] },
            { a: [200, 100] },
          ]),
        ),
      );
      let r: JoinResult | null = null;
      const handler = createJoinHandler(h.host, { onJoin: (x) => (r = x) });
      handler.onActivate(undefined as never);
      drag(handler, [
        [95, 100],
        [150, 102],
        [205, 100],
      ]);
      await settle();
      expect(r).toMatchObject({ applied: true, kind: "close" });
      expect((await tableOf(h, poly("u")))!.subpathOpen).toEqual([false]);
    });
  });

  describe("Reshape tool", () => {
    it("dragging an anchor moves it and its neighbours by the falloff, in one framePath batch", async () => {
      await h.host.selection.set([WAVE]);
      const before = (await tableOf(h, WAVE))!;
      const p = before.anchors[30]!.anchor;
      const { host, work } = countingHost(h.host);
      const ok = await applyReshapeAt(host, WAVE, p, [p[0], p[1] - 40], 50, 2);
      expect(ok).toBe(true);
      expect(work.mutations).toHaveLength(1);
      const after = (await tableOf(h, WAVE))!;
      expect(after.anchors[30]!.anchor[1]).toBeCloseTo(p[1] - 40, 3);
      const d29 = before.anchors[29]!.anchor[1] - after.anchors[29]!.anchor[1];
      expect(d29).toBeGreaterThan(0);
      expect(d29).toBeLessThan(40);
      expect(after.anchors[0]!.anchor).toEqual(before.anchors[0]!.anchor);
      await h.host.document.undo();
      expect((await tableOf(h, WAVE))!.anchors).toEqual(before.anchors);
    });

    it("the live tool adds an anchor where the press lands on a segment", async () => {
      let applied: boolean | null = null;
      const handler = createReshapeHandler(h.host, {
        onReshape: (_id, a) => (applied = a),
      });
      handler.onActivate(undefined as never);
      handler.onPointerDown(pointerAt(PAGE_ID, [150, 100]));
      handler.onPointerMove(pointerAt(PAGE_ID, [150, 80]));
      handler.onPointerUp(pointerAt(PAGE_ID, [150, 70]));
      await settle();
      await settle();
      expect(applied).toBe(true);
      const t = (await tableOf(h, SQ))!;
      expect(t.anchors).toHaveLength(5);
      expect(
        t.anchors.some(
          (a) =>
            Math.abs(a.anchor[0] - 150) < 1e-3 &&
            Math.abs(a.anchor[1] - 70) < 1e-3,
        ),
      ).toBe(true);
    });
  });

  describe("Path Eraser", () => {
    it("a drag across an open line splits it into two painted pieces — one undo step", async () => {
      const { host, work } = countingHost(h.host);
      const r = await applyPathErase(
        host,
        PAGE_ID,
        [
          [350, 230],
          [350, 270],
        ],
        10,
      );
      expect(r.erased).toEqual([A]);
      expect(r.inserted).toBe(1);
      expect(work.mutations).toHaveLength(1);
      const a = (await tableOf(h, A))!;
      expect(a.anchors.at(-1)!.anchor[0]).toBeCloseTo(345, 2);
      expect(await leafIds(h)).toHaveLength(5);
      await h.host.document.undo();
      expect(await leafIds(h)).toHaveLength(4);
      expect((await tableOf(h, A))!.anchors.at(-1)!.anchor).toEqual([400, 250]);
    });

    it("across a CLOSED square's edge it opens the square into one open path", async () => {
      const r = await applyPathErase(
        h.host,
        PAGE_ID,
        [
          [150, 90],
          [150, 110],
        ],
        10,
      );
      expect(r.erased).toEqual([SQ]);
      const t = (await tableOf(h, SQ))!;
      expect(t.subpathOpen).toEqual([true]);
      expect(t.anchors[0]!.anchor[0]).toBeCloseTo(155, 2);
      expect(t.anchors.at(-1)!.anchor[0]).toBeCloseTo(145, 2);
    });

    it("erasing all of a path deletes it; the live tool erases what it is dragged over", async () => {
      const all = await applyPathErase(
        h.host,
        PAGE_ID,
        [
          [290, 250],
          [410, 250],
        ],
        10,
      );
      expect(all.removed).toEqual([A]);
      let r: EraseResult | null = null;
      const handler = createPathEraserHandler(h.host, {
        onErase: (x) => (r = x),
      });
      handler.onActivate(undefined as never);
      drag(handler, [
        [470, 240],
        [470, 250],
        [470, 260],
      ]);
      await settle();
      expect(r!.erased).toEqual([B]);
    });
  });

  describe("Star and Flare", () => {
    it("a Star drag inserts a closed 2·points path; arrow keys add points; one undo step", async () => {
      const handler = createStarHandler(h.host);
      handler.onActivate(undefined as never);
      const before = (await leafIds(h)).length;
      handler.onPointerDown(pointerAt(PAGE_ID, [300, 500]));
      handler.onPointerMove(pointerAt(PAGE_ID, [300, 470]));
      handler.onKey!({ key: "ArrowUp" } as KeyboardEvent);
      handler.onPointerUp(pointerAt(PAGE_ID, [300, 450]));
      await settle();
      const leaves = await leafIds(h);
      expect(leaves).toHaveLength(before + 1);
      const star = leaves.find(
        (id) => !["sq", "wave", "a", "b"].includes(String(id.id)),
      )!;
      const t = (await tableOf(h, star))!;
      expect(t.anchors).toHaveLength(12);
      expect(t.subpathOpen ?? [false]).toEqual([false]);
      expect(t.anchors[0]!.anchor[1]).toBeCloseTo(450, 2);
      // Engine ADR 1047: an upright star is a LIVE star — the engine
      // keeps its points and inset (1 − Radius 2 ÷ Radius 1).
      const props = await h.host.document.elementProperties(star);
      const read = (path: string) =>
        (
          props?.entries.find((e) => e.path === path)?.value as {
            value: number | null;
          } | null
        )?.value;
      expect(read("frameShapeSides")).toBe(6);
      expect(read("frameShapeStarInset")).toBeGreaterThan(0);
      await h.host.document.undo();
      expect(await leafIds(h)).toHaveLength(before);
    });

    it("a Star click on a host with no panel door inserts the last-used star at the click", async () => {
      const handler = createStarHandler(h.host);
      handler.onActivate(undefined as never);
      handler.onPointerDown(pointerAt(PAGE_ID, [500, 500]));
      handler.onPointerUp(pointerAt(PAGE_ID, [500, 500]));
      await settle();
      await settle();
      const leaves = await leafIds(h);
      expect(leaves).toHaveLength(5);
    });

    it("a Flare is its parts GROUPED in one batch; the halo fades with a radial gradient feather", async () => {
      const { host, work } = countingHost(h.host);
      const parts = await applyInsertFlare(
        host,
        { cx: 300, cy: 500, rays: 6, rings: 3 },
        PAGE_ID,
      );
      expect(parts).toBe(11);
      expect(work.mutations).toHaveLength(1);
      const tree = await h.host.document.tree();
      const groups: SceneTreeNode[] = [];
      const walk = (ns: readonly SceneTreeNode[]) =>
        ns.forEach((n) =>
          n.id?.kind === "group" ? groups.push(n) : walk(n.children ?? []),
        );
      walk(tree);
      expect(groups).toHaveLength(1);
      expect(groups[0]!.children).toHaveLength(11);
      const halo = groups[0]!.children![0]!.id as ElementId;
      const props = await h.host.document.elementProperties(halo);
      const feather = props!.entries.find(
        (e) => e.path === "frameGradientFeather",
      );
      expect(feather?.value).toBeTruthy();
      await h.host.document.undo();
      expect(await leafIds(h)).toHaveLength(4);
    });

    it("the Flare tool's two gestures insert a flare", async () => {
      let done = false;
      const handler = createFlareHandler(h.host, {
        onFlare: () => (done = true),
      });
      handler.onActivate(undefined as never);
      handler.onPointerDown(pointerAt(PAGE_ID, [300, 500]));
      handler.onPointerUp(pointerAt(PAGE_ID, [330, 500]));
      handler.onPointerDown(pointerAt(PAGE_ID, [380, 560]));
      handler.onPointerUp(pointerAt(PAGE_ID, [400, 580]));
      await settle();
      expect(done).toBe(true);
      expect((await leafIds(h)).length).toBeGreaterThan(4);
    });
  });

  describe("Shaper", () => {
    it("a recorded rectangle stroke becomes a 4-corner closed path; a circle a 4-anchor ellipse — one undo step each", async () => {
      await h.load(packageWithSpread(""));
      const { host, work } = countingHost(h.host);
      const r = await applyShaperStroke(host, PAGE_ID, S.rectangle!);
      expect(r).toMatchObject({ applied: true, kind: "rectangle" });
      expect(work.mutations).toHaveLength(1);
      const c = await applyShaperStroke(h.host, PAGE_ID, S.circle!);
      expect(c).toMatchObject({ applied: true, kind: "ellipse" });
      const leaves = await leafIds(h);
      expect(leaves).toHaveLength(2);
      const rect = (await tableOf(h, leaves[0]!))!;
      expect(rect.anchors).toHaveLength(4);
      expect(rect.anchors.map((a) => a.anchor)).toEqual(
        recogniseShape(S.rectangle!)!.table!.anchors.map((a) => a.anchor),
      );
      await h.host.document.undo();
      expect(await leafIds(h)).toHaveLength(1);
    });

    it("a scribble ACROSS two overlapping squares merges them; one inside their overlap punches it out", async () => {
      const two = () =>
        packageWithSpread(
          squareItem("p", 100, 100, 100) + squareItem("q", 150, 150, 100),
        );
      await h.load(two());
      const across: [number, number][] = [];
      for (let i = 0; i <= 6; i++)
        across.push([i % 2 === 0 ? 120 : 230, 120 + i * 18]);
      const merged = await applyShaperStroke(h.host, PAGE_ID, across);
      expect(merged).toMatchObject({
        applied: true,
        kind: "scribble",
        mode: "keep",
      });
      expect(await leafIds(h)).toHaveLength(1);
      await h.load(two());
      const inside: [number, number][] = [];
      for (let i = 0; i <= 6; i++)
        inside.push([i % 2 === 0 ? 160 : 190, 160 + i * 5]);
      const punched = (await applyShaperStroke(
        h.host,
        PAGE_ID,
        inside,
      )) as ShaperResult;
      expect(punched).toMatchObject({
        applied: true,
        kind: "scribble",
        mode: "remove",
      });
    });

    it("the live tool recognises a recorded triangle", async () => {
      await h.load(packageWithSpread(""));
      let r: ShaperResult | null = null;
      const handler = createShaperHandler(h.host, { onShape: (x) => (r = x) });
      handler.onActivate(undefined as never);
      drag(
        handler,
        S.triangle!.map((p) => [p[0], p[1]] as [number, number]),
      );
      await settle();
      expect(r).toMatchObject({ applied: true, kind: "triangle" });
    });
  });

  describe("the typed commands (host.objects), one undo step each", () => {
    const C = "media.paged.draw.command";

    it("joinScrub welds the two lines across their gap", async () => {
      covers("command:media.paged.draw.command.joinScrub");
      const r = await h.objects.invoke(`${C}.joinScrub`, {
        targets: ["polygon:a", "polygon:b"],
        page: "",
        path: [
          [395, 245],
          [425, 255],
        ],
        tolerance: 8,
      });
      expect(r).toEqual({ kind: "gap" });
      expect(key(await leafIds(h))).not.toContain("polygon:b");
      await h.host.document.undo();
      expect(key(await leafIds(h))).toContain("polygon:b");
    });

    it("pathErase splits the line it is dragged across", async () => {
      covers("command:media.paged.draw.command.pathErase");
      const r = await h.objects.invoke(`${C}.pathErase`, {
        targets: ["polygon:a"],
        page: "",
        path: [
          [350, 240],
          [350, 260],
        ],
        width: 10,
      });
      expect(r).toEqual({ erased: 1, inserted: 1, removed: 0 });
      await h.host.document.undo();
      expect(await leafIds(h)).toHaveLength(4);
    });

    it("reshapeAt moves the square's corner", async () => {
      covers("command:media.paged.draw.command.reshapeAt");
      await h.objects.invoke(`${C}.reshapeAt`, {
        targets: ["polygon:sq"],
        point: [200, 100],
        to: [230, 70],
        radius: 50,
        tolerance: 2,
      });
      const t = (await tableOf(h, SQ))!;
      expect(t.anchors[1]!.anchor).toEqual([230, 70]);
      await h.host.document.undo();
      expect((await tableOf(h, SQ))!.anchors[1]!.anchor).toEqual([200, 100]);
    });

    it("shaperStroke recognises a recorded pentagon", async () => {
      covers("command:media.paged.draw.command.shaperStroke");
      const r = await h.objects.invoke(`${C}.shaperStroke`, {
        targets: [],
        page: PAGE_ID,
        path: S.pentagon!,
      });
      expect(r).toEqual({ kind: "polygon" });
      expect(await leafIds(h)).toHaveLength(5);
    });

    it("insertStar and insertFlare insert on the named page", async () => {
      covers("command:media.paged.draw.command.insertStar");
      covers("command:media.paged.draw.command.insertFlare");
      await h.objects.invoke(`${C}.insertStar`, {
        page: PAGE_ID,
        cx: 300,
        cy: 500,
        radius1: 40,
        radius2: 15,
        points: 7,
        rotationDeg: 0,
      });
      expect(await leafIds(h)).toHaveLength(5);
      await h.objects.invoke(`${C}.insertFlare`, {
        page: PAGE_ID,
        cx: 300,
        cy: 500,
        centreRadius: 8,
        haloScale: 3,
        rays: 3,
        rayLength: 50,
        rings: 2,
        endX: 400,
        endY: 560,
        ringRadius: 10,
      });
      expect(await leafIds(h)).toHaveLength(5 + 7);
      await h.host.document.undo();
      expect(await leafIds(h)).toHaveLength(5);
    });
  });
});
