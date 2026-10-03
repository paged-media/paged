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

// THE CORNER-RADIUS TOOL through the REAL engine wasm — the handle in the
// element's OWN space. Pins:
//   (1) an axis-aligned rectangle: a drag at a corner writes THAT
//       corner's radius, one batch, one undo step;
//   (2) a ROTATED rectangle (which the tool used to skip) and a SCALED
//       one: the press is found at the corner where it lands on the page,
//       the radius is the own-space distance, and the preview is drawn
//       on the page where the corner is;
//   (3) a POLYGON: a handle at each corner anchor; the drag reads the
//       renderer's inscribed-circle rule, and the ONE uniform radius is
//       written to all four slots (the renderer reads the first) in one
//       batch; a rotated polygon too;
//   (4) a text frame is a box like a rectangle; an oval is not a target;
//       Escape writes nothing.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ElementId, ToolPreviewPolyline } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { affineRotate, applyAffine, type Affine } from "@paged-media/draw-geometry";

import { createCornerRadiusHandler, drawBundle } from "../../src";
import { packageWithSpread, pathItem } from "../fixtures/build-idml";
import { rectItem, PAGE_ID } from "../panels/panel-document";
import { countingHost } from "../perf/counting-host";
import { pointerAt, settle } from "../perf/pointer-stream";
import { openHost } from "./host";

const RECT = { kind: "rectangle", id: "crect" } as ElementId;
const TRI = { kind: "polygon", id: "ctri" } as ElementId;

/** crect: 100 pt rectangle at (100, 100). ctri: a right triangle with
 *  its right angle at (300, 100), legs 100 pt along +x and +y. */
const DOC = () =>
  packageWithSpread(
    rectItem("crect", 100, 100, 100) +
      pathItem("Polygon", "ctri", "100 300 200 400", false, [
        { a: [300, 100] },
        { a: [400, 100] },
        { a: [300, 200] },
      ]),
  );

const RADIUS_PATHS = [
  "frameCornerRadiusTopLeft",
  "frameCornerRadiusTopRight",
  "frameCornerRadiusBottomRight",
  "frameCornerRadiusBottomLeft",
] as const;

async function radii(h: HeadlessHost, id: ElementId): Promise<(number | null)[]> {
  const props = await h.host.document.elementProperties(id);
  return RADIUS_PATHS.map((path) => {
    const e = props?.entries.find((x) => x.path === path);
    return e?.value?.type === "length" ? e.value.value : null;
  });
}

async function transform(h: HeadlessHost, id: ElementId, m: Affine): Promise<void> {
  const out = await h.host.document.mutate({
    op: "setElementProperty",
    args: { elementId: id, path: "frameTransform", value: { type: "transform", value: [...m] } },
  });
  if (!out.applied) throw new Error("transform setup refused");
}

/** Drive one drag from `from` to `to` (page pt). */
async function dragCorner(
  h: HeadlessHost,
  host: HeadlessHost["host"],
  from: [number, number],
  to: [number, number],
): Promise<ToolPreviewPolyline | null> {
  const handler = createCornerRadiusHandler(host);
  handler.onActivate(undefined as never);
  handler.onPointerDown(pointerAt(PAGE_ID, from));
  await settle();
  handler.onPointerMove(pointerAt(PAGE_ID, to));
  const preview = h.lastToolPreview() as ToolPreviewPolyline | null;
  handler.onPointerUp(pointerAt(PAGE_ID, to));
  await settle();
  return preview;
}

const page = (m: Affine, x: number, y: number): [number, number] => {
  const p = applyAffine(m, x, y);
  return [p[0], p[1]];
};

describe("draw conformance — the corner-radius tool, in the element's own space", () => {
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

  it("an axis-aligned rectangle: the drag writes THAT corner's radius — one batch, one undo", async () => {
    await h.host.selection.set([RECT]);
    const before = await radii(h, RECT);
    const { host, work } = countingHost(h.host);
    await dragCorner(h, host, [101, 101], [115, 112]);
    expect(work.mutations).toEqual([{ op: "batch", ops: 2 }]);
    const after = await radii(h, RECT);
    expect(after[0]).toBeCloseTo(12, 6);
    expect(after.slice(1)).toEqual(before.slice(1));
    await h.host.document.undo();
    expect(await radii(h, RECT)).toEqual(before);
  });

  it("a ROTATED rectangle: found at its corner ON THE PAGE, the radius its own-space distance, the preview on the page", async () => {
    const m = affineRotate(45, [150, 150]);
    await transform(h, RECT, m);
    await h.host.selection.set([RECT]);
    // The own-space BOTTOM-RIGHT corner (200, 200), wherever it lands.
    const preview = await dragCorner(h, h.host, page(m, 199, 199), page(m, 180, 185));
    const after = await radii(h, RECT);
    expect(after[2]).toBeCloseTo(15, 4);
    // The preview's middle point IS the corner on the page.
    const corner = page(m, 200, 200);
    expect(preview!.points[1]![0]).toBeCloseTo(corner[0], 4);
    expect(preview!.points[1]![1]).toBeCloseTo(corner[1], 4);
  });

  it("a SCALED rectangle: 20 pt on the page is 10 pt in its own space", async () => {
    const m: Affine = [2, 0, 0, 2, -100, -100];
    await transform(h, RECT, m);
    await h.host.selection.set([RECT]);
    // Own-space top-left (100, 100) is at page (100, 100).
    await dragCorner(h, h.host, [101, 101], [120, 124]);
    expect((await radii(h, RECT))[0]).toBeCloseTo(10, 4);
  });

  it("a POLYGON: the right-angle corner's drag is the radius, written UNIFORMLY to all four slots in one batch", async () => {
    await h.host.selection.set([TRI]);
    const before = await radii(h, TRI);
    const { host, work } = countingHost(h.host);
    await dragCorner(h, host, [301, 101], [314, 318 - 200]);
    expect(work.mutations).toEqual([{ op: "batch", ops: 8 }]);
    expect(await radii(h, TRI)).toEqual([14, 14, 14, 14].map(() => expect.closeTo(14, 4)));
    await h.host.document.undo();
    expect(await radii(h, TRI)).toEqual(before);
  });

  it("a polygon's ACUTE corner reads the inscribed-circle rule: r = d · tan(θ/2)", async () => {
    await h.host.selection.set([TRI]);
    // The 45° corner at (400, 100): drag 20 pt back along the base.
    await dragCorner(h, h.host, [399, 101], [380, 100.5]);
    const d = Math.min(20, (20 + 0.5) * Math.SQRT1_2);
    expect((await radii(h, TRI))[0]).toBeCloseTo(d * Math.tan(Math.PI / 8), 3);
  });

  it("a ROTATED polygon works the same", async () => {
    const m = affineRotate(-30, [330, 130]);
    await transform(h, TRI, m);
    await h.host.selection.set([TRI]);
    await dragCorner(h, h.host, page(m, 301, 101), page(m, 311, 109));
    expect((await radii(h, TRI))[0]).toBeCloseTo(9, 4);
  });

  it("a TEXT FRAME is a box like a rectangle", async () => {
    const made = await h.host.document.mutate({
      op: "insertTextFrame",
      args: { pageId: PAGE_ID, bounds: [300, 100, 400, 200] },
    });
    expect(made.applied).toBe(true);
    const tf = (made as { createdId: ElementId }).createdId;
    expect(tf.kind).toBe("textFrame");
    await h.host.selection.set([tf]);
    await dragCorner(h, h.host, [199, 399], [190, 392]);
    expect((await radii(h, tf))[2]).toBeCloseTo(8, 4);
  });

  it("nothing corner-bearing selected, a press off every corner, or Escape: nothing is written", async () => {
    const { host, work } = countingHost(h.host);
    await dragCorner(h, host, [101, 101], [115, 115]); // nothing selected
    await h.host.selection.set([RECT]);
    await dragCorner(h, host, [150, 150], [160, 160]); // the middle
    const handler = createCornerRadiusHandler(host);
    handler.onActivate(undefined as never);
    handler.onPointerDown(pointerAt(PAGE_ID, [101, 101]));
    await settle();
    handler.onPointerMove(pointerAt(PAGE_ID, [115, 115]));
    handler.onKey!({ key: "Escape" } as KeyboardEvent);
    handler.onPointerUp(pointerAt(PAGE_ID, [115, 115]));
    await settle();
    expect(work.mutations).toEqual([]);
    expect(h.lastToolPreview()).toBeNull();
  });
});
