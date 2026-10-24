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

// WP6.7 through the REAL engine wasm: the seven Liquify kernels, Puppet
// Warp and the perspective grid — as typed commands (what the CLI and
// scripting run) and as the live tools' handlers. Every artwork change is
// asserted on the document it leaves AND on its undo: ONE mutation, ONE
// undo step, and the undo restores what was there. A grid change is a
// view setting: it is asserted to write NO mutation.
// [plugin-draw.distortion-tools]

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import type { ElementId, PathAnchorsResult } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";
import {
  pageToPlane,
  planeToPage,
  type Vec2,
} from "@paged-media/draw-geometry";

import {
  createLiquifyHandler,
  createPerspectiveGridHandler,
  createPerspectiveSelectHandler,
  createPuppetWarpHandler,
  drawBundle,
  gridFor,
  perspectiveLinkOf,
  DISTORTION_TOOL_IDS,
} from "../../src";
import { packageWithSpread } from "../fixtures/build-idml";
import { leafIds, poly, squareItem, PAGE_ID } from "../panels/panel-document";
import { countingHost } from "../perf/counting-host";
import { pointerAt, settle } from "../perf/pointer-stream";
import { openHost } from "./host";

const SQ = poly("sq");
const C = "media.paged.draw.command";

// A 200 pt square at (100, 100) and a second one far away.
const DOC = () =>
  packageWithSpread(
    squareItem("sq", 100, 100, 200) + squareItem("far", 400, 600, 50),
  );

const tableOf = async (
  h: HeadlessHost,
  id: ElementId,
): Promise<PathAnchorsResult> => (await h.host.document.pathAnchors(id))!;

/** The document's path geometry, for "one undo restores it". */
const picture = async (h: HeadlessHost) =>
  JSON.stringify(
    await Promise.all(
      (await leafIds(h)).map(
        async (id) => (await h.host.document.pathAnchors(id))?.anchors ?? null,
      ),
    ),
  );

const drag = async (
  handler: ReturnType<typeof createLiquifyHandler>,
  pts: Vec2[],
  opts: { alt?: boolean } = {},
) => {
  handler.onPointerDown(pointerAt(PAGE_ID, pts[0] as [number, number], opts));
  await settle();
  for (const p of pts.slice(1, -1)) {
    handler.onPointerMove(pointerAt(PAGE_ID, p as [number, number], opts));
    await settle();
  }
  handler.onPointerUp({
    ...pointerAt(PAGE_ID, pts[pts.length - 1] as [number, number], opts),
    maxDelta: 40,
  });
  await settle();
  await settle();
};

describe("draw conformance — the distortion tools (WP6.7) [plugin-draw.distortion-tools]", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());
  beforeEach(async () => {
    await h.load(DOC());
    await h.host.selection.set([]);
  });

  it("every new tool is keyless and in the flyout Illustrator keeps it in", () => {
    const tools = h.toolsContributed();
    const of = (id: string) => tools.find((t) => t.id === id);
    expect(DISTORTION_TOOL_IDS.map((id) => of(id)?.group)).toEqual([
      ...Array(7).fill("liquify"),
      "transform",
      "perspective",
      "perspective",
    ]);
    for (const id of DISTORTION_TOOL_IDS)
      expect(of(id)?.shortcut).toBeUndefined();
  });

  describe("the Liquify family", () => {
    const KINDS = [
      "warp",
      "twirl",
      "pucker",
      "bloat",
      "scallop",
      "crystallize",
      "wrinkle",
    ] as const;
    const stroke = (kind: string) => ({
      targets: ["polygon:sq"],
      page: PAGE_ID,
      kind,
      path:
        kind === "warp"
          ? [
              [200, 100],
              [200, 115],
              [200, 130],
            ]
          : kind === "pucker" || kind === "bloat"
            ? // Off the edge, so the edge moves across itself, not along.
              [
                [320, 200],
                [320, 205],
              ]
            : [
                [300, 200],
                [300, 205],
              ],
      width: 100,
      height: 100,
      angle: 0,
      intensity: 100,
      detail: 3,
      simplify: 20,
      twirlRate: 60,
      complexity: 4,
      horizontal: 40,
      vertical: 100,
      affectAnchors: true,
      affectIn: true,
      affectOut: true,
      seed: 1,
    });

    for (const kind of KINDS) {
      it(`liquifyStroke ${kind}: the square changes under the brush only, in ONE undo step`, async () => {
        covers("command:media.paged.draw.command.liquifyStroke");
        const before = await picture(h);
        const far = (await tableOf(h, poly("far"))).anchors;
        const out = await h.objects.invoke(`${C}.liquifyStroke`, stroke(kind));
        expect(out).toEqual({ changed: 1 });
        const after = await tableOf(h, SQ);
        expect(after.anchors.length).toBeGreaterThan(4);
        // The far square was never under the brush.
        expect((await tableOf(h, poly("far"))).anchors).toEqual(far);
        // The corner the brush never reached is exactly where it was.
        expect(
          after.anchors.some((a) => a.anchor[0] === 100 && a.anchor[1] === 100),
        ).toBe(true);
        await h.host.document.undo();
        expect(await picture(h)).toBe(before);
      });
    }

    it("the live tool: a Bloat drag writes ONE mutation; Escape writes none", async () => {
      covers("tool:media.paged.draw.tool.bloat");
      const { host, work } = countingHost(h.host);
      let result: [number, boolean] | null = null;
      const handler = createLiquifyHandler(host, "bloat", {
        onCommit: (n, a) => (result = [n, a]),
      });
      handler.onActivate(undefined as never);
      await drag(handler, [
        [300, 200],
        [302, 200],
        [304, 200],
      ]);
      expect(result).toEqual([1, true]);
      expect(work.mutations).toHaveLength(1);
      // Escape mid-drag.
      const quiet = countingHost(h.host);
      const h2 = createLiquifyHandler(quiet.host, "pucker");
      h2.onActivate(undefined as never);
      h2.onPointerDown(pointerAt(PAGE_ID, [300, 200]));
      await settle();
      h2.onKey!({ key: "Escape" } as KeyboardEvent);
      await settle();
      h2.onPointerUp(pointerAt(PAGE_ID, [300, 200]));
      await settle();
      expect(quiet.work.mutations).toHaveLength(0);
    });
  });

  it("a BOX rectangle (no path of its own) is distorted through its frame box, in ONE undo step", async () => {
    const made = await h.host.document.mutate({
      op: "insertFrame",
      args: { pageId: PAGE_ID, bounds: [120, 320, 240, 500] },
    } as never);
    if (!made.applied) throw new Error("insertFrame refused");
    const box = made.createdId!;
    expect((await h.host.document.pathAnchors(box))!.anchors).toEqual([]);
    await h.host.selection.set([box]);
    await h.objects.invoke(`${C}.perspectiveShowGrid`, { page: PAGE_ID });
    await h.objects.invoke(`${C}.attachToPerspective`, {
      targets: [`rectangle:${String(box.id)}`],
    });
    expect((await h.host.document.pathAnchors(box))!.anchors).toHaveLength(4);
    expect(
      perspectiveLinkOf(await h.host.document.getMetadata(box)),
    ).not.toBeNull();
    await h.host.document.undo();
    expect((await h.host.document.pathAnchors(box))!.anchors).toEqual([]);
  });

  describe("Puppet Warp", () => {
    it("puppetWarp: holding the left side and dragging the right bends the square — ONE undo step", async () => {
      covers("command:media.paged.draw.command.puppetWarp");
      const before = await picture(h);
      await h.objects.invoke(`${C}.puppetWarp`, {
        targets: ["polygon:sq"],
        holds: [
          [110, 110],
          [110, 290],
        ],
        from: [290, 200],
        to: [330, 140],
        autoPins: 0,
      });
      const after = await tableOf(h, SQ);
      const right = after.anchors[1]!.anchor; // (300, 100)
      expect(right[1]).toBeLessThan(100);
      // The held side barely moved.
      expect(Math.abs(after.anchors[0]!.anchor[0] - 100)).toBeLessThan(4);
      await h.host.document.undo();
      expect(await picture(h)).toBe(before);
    });

    it("puppetWarpTool: the headless host cannot switch tools, and says so", async () => {
      covers("command:media.paged.draw.command.puppetWarpTool");
      const out = await h.objects.invoke(`${C}.puppetWarpTool`, {});
      expect(out).toEqual({ activated: false });
    });

    it("the live tool: auto pins, a pin drag is ONE mutation, Alt+click removes a pin and settles in another", async () => {
      covers("tool:media.paged.draw.tool.puppetWarp");
      await h.host.selection.set([SQ]);
      const { host, work } = countingHost(h.host);
      const commits: boolean[] = [];
      const handler = createPuppetWarpHandler(host, {
        onCommit: (a) => commits.push(a),
      });
      handler.onActivate(undefined as never);
      await settle();
      await drag(handler, [
        [295, 105],
        [320, 80],
        [340, 60],
      ]);
      expect(commits).toEqual([true]);
      expect(work.mutations).toHaveLength(1);
      const moved = (await tableOf(h, SQ)).anchors[1]!.anchor;
      expect(moved[0]).toBeGreaterThan(300);
      // The dragged pin is where the drag ended: Alt+click it.
      await drag(
        handler,
        [
          [340, 60],
          [340, 60],
        ],
        { alt: true },
      );
      expect(commits).toEqual([true, true]);
      expect(work.mutations).toHaveLength(2);
      await h.host.document.undo();
      await h.host.document.undo();
      expect((await tableOf(h, SQ)).anchors[1]!.anchor).toEqual([300, 100]);
    });
  });

  describe("the perspective grid", () => {
    it("View ▸ Perspective grid: show / hide / lock / unlock / the presets / the plane change the grid and write NO mutation", async () => {
      covers("command:media.paged.draw.command.perspectiveShowGrid");
      covers("command:media.paged.draw.command.perspectiveHideGrid");
      covers("command:media.paged.draw.command.perspectiveLockGrid");
      covers("command:media.paged.draw.command.perspectiveUnlockGrid");
      covers("command:media.paged.draw.command.perspectiveOnePoint");
      covers("command:media.paged.draw.command.perspectiveTwoPoint");
      covers("command:media.paged.draw.command.perspectiveThreePoint");
      covers("command:media.paged.draw.command.perspectiveSetPlane");
      const { host, work } = countingHost(h.host);
      void host;
      await h.objects.invoke(`${C}.perspectiveShowGrid`, { page: PAGE_ID });
      expect((await gridFor(h.host, PAGE_ID))!.visible).toBe(true);
      await h.objects.invoke(`${C}.perspectiveHideGrid`, { page: PAGE_ID });
      expect((await gridFor(h.host, PAGE_ID))!.visible).toBe(false);
      await h.objects.invoke(`${C}.perspectiveLockGrid`, { page: PAGE_ID });
      expect((await gridFor(h.host, PAGE_ID))!.locked).toBe(true);
      await h.objects.invoke(`${C}.perspectiveUnlockGrid`, { page: PAGE_ID });
      expect((await gridFor(h.host, PAGE_ID))!.locked).toBe(false);
      await h.objects.invoke(`${C}.perspectiveThreePoint`, { page: PAGE_ID });
      expect((await gridFor(h.host, PAGE_ID))!.kind).toBe(3);
      await h.objects.invoke(`${C}.perspectiveOnePoint`, { page: PAGE_ID });
      expect((await gridFor(h.host, PAGE_ID))!.kind).toBe(1);
      await h.objects.invoke(`${C}.perspectiveTwoPoint`, { page: PAGE_ID });
      expect((await gridFor(h.host, PAGE_ID))!.kind).toBe(2);
      await h.objects.invoke(`${C}.perspectiveSetPlane`, {
        page: PAGE_ID,
        plane: "right",
      });
      expect((await gridFor(h.host, PAGE_ID))!.activePlane).toBe("right");
      expect(work.mutations).toHaveLength(0);
    });

    it("attach in place, move along the plane, release — each ONE undo step; the link carries the flat geometry", async () => {
      covers("command:media.paged.draw.command.attachToPerspective");
      covers("command:media.paged.draw.command.moveOnPerspective");
      covers("command:media.paged.draw.command.releaseFromPerspective");
      await h.objects.invoke(`${C}.perspectiveShowGrid`, { page: PAGE_ID });
      const before = await picture(h);
      await h.objects.invoke(`${C}.attachToPerspective`, {
        targets: ["polygon:sq"],
      });
      const env = await h.host.document.getMetadata(SQ);
      const link = perspectiveLinkOf(env)!;
      expect(link.plane).toBe("left");
      expect(link.page).toBe(PAGE_ID);
      const attached = await tableOf(h, SQ);
      expect(attached.anchors).toHaveLength(4);
      expect(await picture(h)).not.toBe(before);
      // Move along the plane.
      const grid = (await gridFor(h.host, PAGE_ID))!;
      const from = attached.anchors[0]!.anchor;
      const q = pageToPlane(grid, "left", from)!;
      const to = planeToPage(grid, "left", [q[0] - 30, q[1]])!;
      const atAttach = await picture(h);
      await h.objects.invoke(`${C}.moveOnPerspective`, {
        targets: ["polygon:sq"],
        from,
        to,
      });
      const moved = await tableOf(h, SQ);
      expect(moved.anchors[0]!.anchor[0]).toBeCloseTo(to[0], 1);
      expect(moved.anchors[0]!.anchor[1]).toBeCloseTo(to[1], 1);
      await h.host.document.undo();
      expect(await picture(h)).toBe(atAttach);
      // Release keeps the geometry and drops the link.
      await h.objects.invoke(`${C}.releaseFromPerspective`, {
        targets: ["polygon:sq"],
      });
      expect(
        perspectiveLinkOf(await h.host.document.getMetadata(SQ)),
      ).toBeNull();
      expect(await picture(h)).toBe(atAttach);
      await h.host.document.undo();
      expect(
        perspectiveLinkOf(await h.host.document.getMetadata(SQ)),
      ).not.toBeNull();
      await h.host.document.undo();
      expect(await picture(h)).toBe(before);
    });

    it("drawOnPerspective inserts a linked rectangle on the active plane — ONE undo step", async () => {
      covers("command:media.paged.draw.command.drawOnPerspective");
      await h.objects.invoke(`${C}.perspectiveShowGrid`, { page: PAGE_ID });
      const grid = (await gridFor(h.host, PAGE_ID))!;
      const a = planeToPage(grid, "left", [-150, -100])!;
      const b = planeToPage(grid, "left", [-40, -20])!;
      const leaves = (await leafIds(h)).length;
      await h.objects.invoke(`${C}.drawOnPerspective`, {
        page: PAGE_ID,
        shape: "rectangle",
        from: a,
        to: b,
      });
      const ids = await leafIds(h);
      expect(ids).toHaveLength(leaves + 1);
      const created = h.host.selection.get()[0]!;
      const link = perspectiveLinkOf(
        await h.host.document.getMetadata(created),
      )!;
      expect(link.plane).toBe("left");
      expect((await tableOf(h, created)).anchors).toHaveLength(4);
      await h.host.document.undo();
      expect(await leafIds(h)).toHaveLength(leaves);
    });

    it("the Grid tool drags the origin (no mutation); the Selection tool attaches what it drags (ONE mutation)", async () => {
      covers("tool:media.paged.draw.tool.perspectiveGrid");
      covers("tool:media.paged.draw.tool.perspectiveSelect");
      const { host, work } = countingHost(h.host);
      const grid = createPerspectiveGridHandler(host);
      grid.onActivate(undefined as never);
      await settle();
      const g0 = (await gridFor(h.host, PAGE_ID))!;
      await drag(grid as never, [
        g0.origin,
        [g0.origin[0] + 10, g0.origin[1]],
        [g0.origin[0] + 20, g0.origin[1]],
      ]);
      const g1 = (await gridFor(h.host, PAGE_ID))!;
      expect(g1.origin[0]).toBeCloseTo(g0.origin[0] + 20, 6);
      expect(work.mutations).toHaveLength(0);
      grid.onDeactivate("switch" as never);
      const kinds: string[] = [];
      const select = createPerspectiveSelectHandler(host, {
        onCommit: (k, a) => a && kinds.push(k),
      });
      select.onActivate(undefined as never);
      await settle();
      const drop = planeToPage(g1, "left", [-60, -40])!;
      await drag(select as never, [[150, 150], [180, 300], drop]);
      expect(kinds).toEqual(["attach"]);
      expect(work.mutations).toHaveLength(1);
      expect(
        perspectiveLinkOf(await h.host.document.getMetadata(SQ))!.plane,
      ).toBe("left");
      // …and dragging it again moves it ALONG the plane.
      const at = (await tableOf(h, SQ)).anchors[0]!.anchor;
      const along = planeToPage(g1, "left", [
        pageToPlane(g1, "left", at)![0] - 20,
        pageToPlane(g1, "left", at)![1],
      ])!;
      await drag(select as never, [drop, along]);
      expect(kinds).toEqual(["attach", "move"]);
      expect(work.mutations).toHaveLength(2);
    });
  });
});
