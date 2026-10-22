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

// The tool-only cuts as typed commands (plan G4): the Knife, Scissors at a
// point and the Shape Builder, their gesture given as data, through
// `host.objects.invoke` on a real engine — each the tool's one undo step,
// and a cut that does nothing refused with a reason.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { drawBundle } from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const C = "media.paged.draw.command";

async function leaves(h: HeadlessHost): Promise<string[]> {
  const out: string[] = [];
  const walk = (nodes: { id?: unknown; children?: unknown[] }[]) => {
    for (const n of nodes) {
      const id = n.id as { kind?: string; id?: string } | undefined;
      if (id?.id && !n.children?.length) out.push(`${id.kind}:${id.id}`);
      if (n.children) walk(n.children as never);
    }
  };
  walk((await h.host.document.tree()) as never);
  return out.sort();
}

describe("paged.draw — the cuts as typed commands", () => {
  let h: HeadlessHost;
  beforeEach(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
    h.loadBundle(drawBundle);
  });
  afterEach(() => h?.dispose());

  it("knife: cuts the named square in two along the line — one undo step", async () => {
    const before = await leaves(h);
    const r = await h.objects.invoke(`${C}.knife`, {
      targets: ["rectangle:urect"],
      page: "",
      cut: [
        [200, 50],
        [200, 350],
      ],
    });
    expect(r).toEqual({ cut: 1, pieces: 2 });
    const after = await leaves(h);
    expect(after).toHaveLength(before.length + 1);
    expect(after).toContain("rectangle:urect");
    await h.host.document.undo();
    expect(await leaves(h)).toEqual(before);
  });

  it("knife: a cut that misses everything is refused with a reason", async () => {
    await expect(
      h.objects.invoke(`${C}.knife`, {
        targets: ["rectangle:urect"],
        page: "",
        cut: [
          [500, 500],
          [520, 520],
        ],
      }),
    ).rejects.toThrow(/^failed: /);
  });

  it("scissorsAt: cuts the open path at a point on a segment — one undo step", async () => {
    const id = { kind: "polygon", id: "upoly" } as ElementId;
    const before = await h.host.document.pathAnchors(id);
    const r = await h.objects.invoke(`${C}.scissorsAt`, {
      targets: ["polygon:upoly"],
      point: [175, 500],
      tolerance: 1,
    });
    expect(r).toEqual({ cut: "upoly" });
    const after = await h.host.document.pathAnchors(id);
    expect(after!.anchors.length).toBeGreaterThan(before!.anchors.length);
    expect(after!.subpathStarts.length).toBe(2); // two contours now
    await h.host.document.undo();
    expect((await h.host.document.pathAnchors(id))!.anchors).toEqual(
      before!.anchors,
    );
    await expect(
      h.objects.invoke(`${C}.scissorsAt`, {
        targets: ["polygon:upoly"],
        point: [250, 450],
        tolerance: 1,
      }),
    ).rejects.toThrow(/on no cuttable segment/);
  });

  it("shapeBuild: a drag across two overlapping squares merges them", async () => {
    const made = await h.host.document.mutate({
      op: "insertFrame",
      args: { pageId: F1_MULTI_SHAPE.pageId, bounds: [200, 200, 400, 400] },
    });
    expect(made.applied).toBe(true);
    const other = `rectangle:${String(
      (made as { createdId?: { id: unknown } }).createdId!.id,
    )}`;
    const before = await leaves(h);
    await h.objects.invoke(`${C}.shapeBuild`, {
      targets: [other, "rectangle:urect"],
      path: [
        [150, 150],
        [250, 250],
        [350, 350],
      ],
      mode: "keep",
    });
    expect(await leaves(h)).toHaveLength(before.length - 1);
    await h.host.document.undo();
    expect(await leaves(h)).toEqual(before);

    await expect(
      h.objects.invoke(`${C}.shapeBuild`, {
        targets: [other, "rectangle:urect"],
        path: [
          [600, 600],
          [650, 650],
        ],
        mode: "keep",
      }),
    ).rejects.toThrow(/crosses no region/);
  });
});
