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

// Engine ADR 1040 — gradient meshes and freeform gradients through the
// SDK's doors on the real engine: the feature flag, the vendored catalog
// row, a mesh and a freeform gradient written, read back and undone in
// one step each, and a malformed spec refused.

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

async function read(h: HeadlessHost, id: ElementId) {
  const props = await h.host.document.elementProperties(id);
  return props?.entries.find((e) => e.path === "frameFillMesh")?.value;
}

const rgb = (r: number, g: number, b: number) => ({
  space: "RGB",
  value: [r, g, b],
});

const node = (x: number, y: number, color: ReturnType<typeof rgb>) => ({
  point: [x, y],
  handles: [
    [x, y],
    [x, y],
    [x, y],
    [x, y],
  ],
  color,
});

const mesh = {
  kind: "mesh",
  grids: [
    {
      rows: 1,
      cols: 1,
      nodes: [
        node(20, 20, rgb(255, 0, 0)),
        node(120, 20, rgb(0, 255, 0)),
        node(20, 120, rgb(0, 0, 255)),
        node(120, 120, rgb(255, 255, 0)),
      ],
      tensor: [],
    },
  ],
};

async function set(h: HeadlessHost, id: ElementId, spec: unknown) {
  return h.host.document.mutate({
    op: "setElementProperty",
    args: {
      elementId: id,
      path: "frameFillMesh",
      value: { type: "fillMesh", value: spec } as never,
    },
  });
}

describe("gradient mesh and freeform gradient (engine ADR 1040) [color-swatches.mesh-freeform-gradients]", () => {
  it("is advertised, and the vendored catalog carries its row", () => {
    expect(HOST_FEATURES).toContain("document.meshFill@1");
    const rows = propertySchemas as ReadonlyArray<{
      path: string;
      type: { kind: string; shape?: string };
    }>;
    const row = rows.find((r) => r.path === "frameFillMesh");
    expect(row?.type.kind).toBe("struct");
  });

  it("a mesh writes, reads back and undoes in one step", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    expect(h.host.supports("document.meshFill@1")).toBe(true);
    const id = await frameOn(h);
    expect(await read(h, id)).toEqual({ type: "fillMesh", value: null });
    expect((await set(h, id, mesh)).applied).toBe(true);
    expect(await read(h, id)).toEqual({ type: "fillMesh", value: mesh });
    await h.host.document.undo();
    expect(await read(h, id)).toEqual({ type: "fillMesh", value: null });
  });

  it("a freeform gradient writes; a malformed spec is refused", async () => {
    const h = (live = await createHeadlessHost({ console: silent }));
    const id = await frameOn(h);
    const freeform = {
      kind: "freeform",
      points: [
        { point: [40, 40], color: rgb(255, 0, 0), spreadPct: 10 },
        { point: [100, 90], color: rgb(0, 0, 255) },
      ],
      lines: [[0, 1]],
    };
    expect((await set(h, id, freeform)).applied).toBe(true);
    expect(await read(h, id)).toEqual({ type: "fillMesh", value: freeform });
    const broken = { ...mesh, grids: [{ ...mesh.grids[0], rows: 2 }] };
    expect((await set(h, id, broken)).applied).toBe(false);
    expect(await read(h, id)).toEqual({ type: "fillMesh", value: freeform });
  });
});
