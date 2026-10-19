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

// C-68 — draw's point-placing tools snap through the ENGINE (engine ADR
// 125): a Curvature point lands exactly on the page's centre and on
// ANOTHER path's anchor, Cmd bypasses it, and the tool reads no page
// geometry of its own (there is no TypeScript fallback resolver, ADR 358).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { createCurvatureHandler, drawBundle } from "../../src";
import { F4_OVERLAP } from "../fixtures/corpus";
import { countingHost } from "../perf/counting-host";
import { pointerAt, settle } from "../perf/pointer-stream";
import { openHost } from "./host";

const PAGE = F4_OVERLAP.pageId; // 612 × 792 pt
const CENTRE: [number, number] = [306, 396];

async function curve(
  h: HeadlessHost,
  points: [number, number][],
  opts: { cmd?: boolean } = {},
): Promise<number[][]> {
  const before = new Set(
    (await h.host.document.tree()).flatMap(function walk(n: any): string[] {
      return [n.id?.id, ...(n.children ?? []).flatMap(walk)].filter(Boolean);
    }),
  );
  const { host, work } = countingHost(h.host);
  const handler = createCurvatureHandler(host);
  handler.onActivate(undefined as never);
  for (const p of points) {
    const e = pointerAt(PAGE, p);
    if (opts.cmd) (e.modifiers as { cmd: boolean }).cmd = true;
    handler.onPointerDown(e);
    await settle();
    handler.onPointerUp(e);
    await settle();
  }
  handler.onKey?.({ key: "Enter" } as never);
  await settle();
  expect(work.count("document.collection")).toBe(0);
  const after = (await h.host.document.tree()).flatMap(function walk(
    n: any,
  ): any[] {
    return [n, ...(n.children ?? []).flatMap(walk)];
  });
  const created = after.find((n) => n.id && !before.has(n.id.id));
  expect(created, "the run created a path").toBeDefined();
  const table = await h.host.document.pathAnchors(created.id);
  return table!.anchors.map((a: { anchor: number[] }) => a.anchor);
}

describe("draw conformance — snapping for point-placing tools (C-68)", () => {
  let h: HeadlessHost;
  beforeAll(async () => {
    h = await openHost();
    await h.load(F4_OVERLAP.bytes());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  it("a Curvature point near the page centre lands exactly on it", async () => {
    const anchors = await curve(h, [
      [50, 50],
      [CENTRE[0] + 3, CENTRE[1] - 2],
      [560, 60],
    ]);
    expect(anchors[1]![0]).toBeCloseTo(CENTRE[0], 3);
    expect(anchors[1]![1]).toBeCloseTo(CENTRE[1], 3);
  });

  it("the engine answers the snap query", async () => {
    const probe = await h.host.document.snapPoint({
      pageId: PAGE,
      point: [1, 1],
      cameraScale: 1,
    });
    expect(probe.tolerancePt).toBeGreaterThan(0);
  });

  it("a Curvature point lands on another path's anchor", async () => {
    // A first path with an anchor at (200, 520): clear of the page's
    // centre lines (306 / 396) and edges.
    await curve(h, [
      [100, 500],
      [200, 520],
      [300, 500],
    ]);
    // A second run clicks 2.2 pt from that anchor: a target only the
    // engine knows (it sees the whole page).
    const anchors = await curve(h, [
      [120, 600],
      [201.5, 518.4],
      [300, 620],
    ]);
    expect(anchors[1]![0]).toBeCloseTo(200, 3);
    expect(anchors[1]![1]).toBeCloseTo(520, 3);
  });

  it("with Cmd held the point stays where the pointer was", async () => {
    const anchors = await curve(
      h,
      [
        [50, 50],
        [CENTRE[0] + 3, CENTRE[1] - 2],
        [560, 60],
      ],
      { cmd: true },
    );
    expect(anchors[1]![0]).toBeCloseTo(CENTRE[0] + 3, 3);
    expect(anchors[1]![1]).toBeCloseTo(CENTRE[1] - 2, 3);
  });
});
