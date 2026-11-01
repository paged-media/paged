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

// Engine ADR 1041 — pattern swatches through the SDK's doors on the real
// engine: the feature flag, the vendored catalog row, a pattern swatch
// created (listed with kind "pattern"), applied as a fill, moved per
// frame, edited and deleted with one undo step each, and a malformed
// pattern refused.

import { afterEach, describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";

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

async function prop(h: HeadlessHost, id: ElementId, path: string) {
  const props = await h.host.document.elementProperties(id);
  return props?.entries.find((e) => e.path === path)?.value;
}

const corner = (x: number, y: number) => ({
  anchor: [x, y],
  left: [x, y],
  right: [x, y],
});

const pattern = (width: number) => ({
  width,
  height: 10,
  tileType: "BrickByRow",
  items: [
    {
      anchors: [corner(0, 0), corner(5, 0), corner(5, 5), corner(0, 5)],
      fill: { space: "RGB", value: [255, 0, 0] },
    },
  ],
});

const swatch = (selfId: string, p: unknown) => ({
  selfId,
  name: "Dots",
  space: "",
  value: [],
  pattern: p,
});

async function patternIds(h: HeadlessHost): Promise<string[]> {
  return (
    (await h.host.document.collection("swatches")) as {
      selfId: string;
      kind: string;
    }[]
  )
    .filter((s) => s.kind === "pattern")
    .map((s) => s.selfId);
}

describe("pattern swatches (engine ADR 1041) [color-swatches.pattern-paint]", () => {
  it("is advertised, and the vendored catalog carries the transform row", () => {
    expect(HOST_FEATURES).toContain("document.patternPaint@1");
    const rows = propertySchemas as ReadonlyArray<{
      path: string;
      type: { kind: string };
    }>;
    expect(
      rows.find((r) => r.path === "framePatternTransform")?.type.kind,
    ).toBe("transform");
  });

  it("a pattern swatch is created, applied, moved, edited and deleted in one step each", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    expect(h.host.supports("document.patternPaint@1")).toBe(true);
    const id = await frameOn(h);
    const created = await h.host.document.mutate({
      op: "createSwatch",
      args: { spec: swatch("Pattern/dots", pattern(10)) as never },
    });
    expect(created.applied).toBe(true);
    expect(await patternIds(h)).toEqual(["Pattern/dots"]);

    const fill = await h.host.document.mutate({
      op: "setElementProperty",
      args: {
        elementId: id,
        path: "frameFillColor",
        value: { type: "colorRef", value: "Pattern/dots" },
      },
    });
    expect(fill.applied).toBe(true);
    expect(await prop(h, id, "frameFillColor")).toEqual({
      type: "colorRef",
      value: "Pattern/dots",
    });

    const moved = await h.host.document.mutate({
      op: "setElementProperty",
      args: {
        elementId: id,
        path: "framePatternTransform",
        value: { type: "transform", value: [1, 0, 0, 1, 3, 4] },
      },
    });
    expect(moved.applied).toBe(true);
    expect(await prop(h, id, "framePatternTransform")).toEqual({
      type: "transform",
      value: [1, 0, 0, 1, 3, 4],
    });
    await h.host.document.undo();
    expect(await prop(h, id, "framePatternTransform")).toEqual({
      type: "transform",
      value: null,
    });

    const edited = await h.host.document.mutate({
      op: "editSwatch",
      args: {
        swatchId: "Pattern/dots",
        spec: swatch("Pattern/dots", pattern(20)) as never,
      },
    });
    expect(edited.applied).toBe(true);

    await h.host.document.undo(); // the edit
    await h.host.document.undo(); // the fill
    expect(await prop(h, id, "frameFillColor")).not.toEqual({
      type: "colorRef",
      value: "Pattern/dots",
    });
    const deleted = await h.host.document.mutate({
      op: "deleteSwatch",
      args: { swatchId: "Pattern/dots" },
    });
    expect(deleted.applied).toBe(true);
    expect(await patternIds(h)).toEqual([]);
    await h.host.document.undo();
    expect(await patternIds(h)).toEqual(["Pattern/dots"]);
  });

  it("a malformed pattern is refused and creates nothing", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    await frameOn(h);
    const bad = await h.host.document.mutate({
      op: "createSwatch",
      args: {
        spec: swatch("Pattern/bad", { ...pattern(10), width: 0 }) as never,
      },
    });
    expect(bad.applied).toBe(false);
    const spiral = await h.host.document.mutate({
      op: "createSwatch",
      args: {
        spec: swatch("Pattern/bad", {
          ...pattern(10),
          tileType: "Spiral",
        }) as never,
      },
    });
    expect(spiral.applied).toBe(false);
    expect(await patternIds(h)).toEqual([]);
  });
});
