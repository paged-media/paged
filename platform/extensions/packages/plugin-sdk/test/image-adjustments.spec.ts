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

// Engine ADR 1037 — an image frame's filter stack. Through the SDK's doors
// on the real engine: the feature flag, the vendored catalog row,
// `setElementProperty` and `host.objects` writes, the read back, the
// refusal of an op out of range, and one undo step.

import { afterEach, describe, expect, it } from "bun:test";

import type { ElementId, RasterOp } from "@paged-media/plugin-api";

import { propertySchemas } from "../../plugin-api/src/catalog.json";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { HOST_FEATURES } from "../src/host-impl";
import { minimalIdml } from "./fixtures/minimal-idml";

import { silentConsole as silent } from "../src/testing";

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

async function frameOn(h: HeadlessHost): Promise<ElementId> {
  const [pageId] = await h.load(minimalIdml());
  const out = await h.host.document.mutate({
    op: "insertFrame",
    args: { pageId: pageId!, bounds: [20, 20, 120, 120] },
  });
  if (!out.applied || !out.createdId) throw new Error("no frame inserted");
  return out.createdId;
}

async function stackOf(h: HeadlessHost, id: ElementId): Promise<unknown> {
  const props = await h.host.document.elementProperties(id);
  const v = props?.entries.find((e) => e.path === "frameImageAdjustments")
    ?.value as { type?: string; value?: unknown } | undefined;
  return v?.type === "imageAdjustments" ? v.value : undefined;
}

describe("frameImageAdjustments (engine ADR 1037) [images-graphics.image-filter-stack]", () => {
  it("is advertised, and the vendored catalog carries its row", () => {
    expect(HOST_FEATURES).toContain("document.imageAdjustments@1");
    const row = (
      propertySchemas as ReadonlyArray<{ path: string; type: { kind: string } }>
    ).find((r) => r.path === "frameImageAdjustments");
    expect(row?.type.kind).toBe("list");
  });

  it("a frame reads an empty stack, writes one, and one undo restores it", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    expect(h.host.supports("document.imageAdjustments@1")).toBe(true);
    const id = await frameOn(h);
    expect(await stackOf(h, id)).toEqual([]);
    const ops: RasterOp[] = [{ op: "exposure", ev: 1 }, { op: "invert" }];
    const out = await h.host.document.mutate({
      op: "setElementProperty",
      args: {
        elementId: id,
        path: "frameImageAdjustments",
        value: { type: "imageAdjustments", value: ops },
      },
    });
    expect(out.applied).toBe(true);
    expect(await stackOf(h, id)).toEqual(ops);
    await h.host.document.undo();
    expect(await stackOf(h, id)).toEqual([]);
  });

  it("host.objects sets it on a frame address; an op out of range is refused", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const id = await frameOn(h);
    const address = `frame:${String(id.id)}`;
    const ops = [
      { op: "duotone", shadow: [0, 0, 0.2], highlight: [1, 1, 0.8] },
    ];
    expect(
      await h.objects.set(address, "frameImageAdjustments", ops),
    ).toMatchObject({ applied: true });
    expect(await h.objects.get(address, "frameImageAdjustments")).toEqual({
      kind: "value",
      value: ops,
    });
    const bad = await h.objects.set(address, "frameImageAdjustments", [
      { op: "threshold", level: 4 },
    ]);
    expect(bad.applied).toBe(false);
    expect(await stackOf(h, id)).toEqual(ops);
  });
});
