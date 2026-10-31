/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// The Mesh tool and the Gradient tool's freeform modes, driven through
// the gesture DSL against the editor-shaped fake: what each gesture
// writes (one whole-value `frameFillMesh` per gesture), the paint target
// the Color panel reads, the overlay, and the two tool options.

import { describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/client";
import {
  createEditorScope,
  PAINT_TARGET,
  type PaintTargetStore,
} from "@paged-media/shell";
import {
  BUILT_IN_LOCALES,
  createStrings,
  englishSource,
  setActiveStrings,
} from "@paged-media/strings";
import { covers, expectOneCommit } from "@paged-media/test-kit";

import "../src/translations";
import { BUILT_IN_TOOLS } from "../src/built-in-tools";
import { createGradientSwatchHandler } from "../src/handlers/gradient-tool";
import { createMeshHandler } from "../src/handlers/mesh-tool";
import type { MeshFillSpec } from "../src/mesh/types";
import { harness, leaves } from "./support";

const R = { kind: "rectangle", id: "r1" } as ElementId;
const BOX: [number, number, number, number] = [100, 100, 200, 300];
const RED_CMYK = { space: "CMYK" as const, value: [0, 100, 100, 0] };

/** The fills the tool wrote, in order. */
function writes(fake: ReturnType<typeof harness>["fake"]): MeshFillSpec[] {
  return leaves(fake)
    .filter(
      (m) =>
        m.op === "setElementProperty" &&
        (m.args as { path: string }).path === "frameFillMesh",
    )
    .map(
      (m) =>
        (m.args as { value: { type: string; value: MeshFillSpec } }).value
          .value,
    );
}

/** A fake with one red rectangle under every point, its geometry, its
 *  properties (the last mesh written reads back) and a paint-target
 *  store of its own. `transform` is the inner → page map. */
function meshHarness(
  options: {
    transform?: [number, number, number, number, number, number] | null;
    settings?: Record<string, string | number>;
    initial?: MeshFillSpec | null;
  } = {},
) {
  const h = harness({
    selection: [R],
    hitTest: () => R,
    geometry: (id) =>
      ({
        id,
        pageId: "page-1",
        spreadId: "s1",
        bounds: BOX,
        itemTransform: options.transform ?? null,
      }) as never,
    toolSettings: options.settings
      ? { "paged.tool.gradientSwatch": options.settings }
      : undefined,
  });
  const scope = createEditorScope();
  const shell = h.fake.shell as Record<string, unknown>;
  shell.scope = scope;
  const client = shell.client as Record<string, unknown>;
  client.elementProperties = async (id: ElementId) => ({
    id,
    kind: "rectangle",
    entries: [
      {
        path: "frameFillColor",
        value: { type: "colorRef", value: "Color/Red" },
      },
      {
        path: "frameFillMesh",
        value: {
          type: "fillMesh",
          value: writes(h.fake).at(-1) ?? options.initial ?? null,
        },
      },
    ],
  });
  client.colorPreview = async () => ({
    selfId: "Color/Red",
    name: "Red",
    model: "process",
    cmyk: [0, 100, 100, 0],
    rgbHex: "#ed1c24",
    space: "CMYK",
    value: [0, 100, 100, 0],
  });
  const paint = () => scope.get(PAINT_TARGET) as PaintTargetStore;
  return { ...h, paint };
}

type Mesh = Extract<MeshFillSpec, { kind: "mesh" }>;
const grid0 = (spec: MeshFillSpec | undefined) => (spec as Mesh).grids[0]!;

describe("Mesh tool", () => {
  it("a click inside a filled shape makes a 2×2 mesh in its fill colour with a point at the click, in ONE write @level:gesture", async () => {
    covers("tool:paged.tool.mesh");
    const { fake, g, paint } = meshHarness();
    await g.tool(createMeshHandler).settle();
    const mark = fake.mark();
    await g.click([150, 120]).settle();
    expectOneCommit(fake, mark);
    const [spec] = writes(fake);
    const grid = grid0(spec);
    expect([grid.rows, grid.cols]).toEqual([2, 2]);
    expect(grid.tensor).toEqual([]);
    // The middle node is the click (inner = page with no transform).
    expect(grid.nodes[4]!.point[0]).toBeCloseTo(150, 6);
    expect(grid.nodes[4]!.point[1]).toBeCloseTo(120, 6);
    // Corners are the box; every node is the fill colour.
    expect(grid.nodes[0]!.point).toEqual([100, 100]);
    expect(grid.nodes[8]!.point).toEqual([300, 200]);
    for (const n of grid.nodes) expect(n.color).toEqual(RED_CMYK);
    // The new point is selected: the Color panel colours it.
    expect(paint().get()?.owner).toBe("paged.tool.mesh");
    expect(paint().get()?.label).toBe("1 mesh point");
  });

  it("the overlay draws the mesh lines and a marker per point", async () => {
    const { fake, g } = meshHarness();
    await g.tool(createMeshHandler).click([150, 120]).settle();
    const shapes = fake.currentPreview() as unknown as Array<{
      points: Array<[number, number]>;
      close?: boolean;
    }>;
    expect(Array.isArray(shapes)).toBe(true);
    // 12 edges, 9 node squares, the selected node's inner square, and its
    // four handles (a line and a diamond each).
    expect(shapes.filter((s) => !s.close)).toHaveLength(12 + 4);
    expect(shapes.filter((s) => s.close)).toHaveLength(9 + 1 + 4);
  });

  it("a click into an existing mesh adds a point (a 3×3 grid), one write; Delete takes it out again", async () => {
    const { fake, g } = meshHarness();
    await g.tool(createMeshHandler).click([150, 120]).settle();
    const mark = fake.mark();
    await g.click([250, 170]).settle();
    expectOneCommit(fake, mark);
    const grid = grid0(writes(fake).at(-1));
    expect([grid.rows, grid.cols]).toEqual([3, 3]);
    await g.key("Delete").settle();
    const back = grid0(writes(fake).at(-1));
    expect([back.rows, back.cols]).toEqual([2, 2]);
    expect(writes(fake)).toHaveLength(3);
  });

  it("dragging a point moves it with its handles, in one write; Escape clears the selection", async () => {
    const { fake, g, paint } = meshHarness();
    await g.tool(createMeshHandler).click([150, 120]).settle();
    const before = grid0(writes(fake)[0]).nodes[4]!;
    const mark = fake.mark();
    await g.drag({ from: [150, 120], to: [170, 140] }).settle();
    expectOneCommit(fake, mark);
    const after = grid0(writes(fake).at(-1)).nodes[4]!;
    expect(after.point[0]).toBeCloseTo(before.point[0] + 20, 6);
    expect(after.point[1]).toBeCloseTo(before.point[1] + 20, 6);
    after.handles.forEach((h, k) => {
      expect(h[0]).toBeCloseTo(before.handles[k]![0] + 20, 6);
      expect(h[1]).toBeCloseTo(before.handles[k]![1] + 20, 6);
    });
    await g.key("Escape").settle();
    expect(paint().get()).toBeNull();
  });

  it("dragging a handle of the selected point moves that handle alone", async () => {
    const { fake, g } = meshHarness();
    await g.tool(createMeshHandler).click([150, 120]).settle();
    const node = grid0(writes(fake)[0]).nodes[4]!;
    const right = node.handles[1];
    await g
      .drag({ from: [right[0], right[1]], to: [right[0] + 10, right[1] + 30] })
      .settle();
    const moved = grid0(writes(fake).at(-1)).nodes[4]!;
    expect(moved.point).toEqual(node.point);
    expect(moved.handles[1][0]).toBeCloseTo(right[0] + 10, 6);
    expect(moved.handles[1][1]).toBeCloseTo(right[1] + 30, 6);
    expect(moved.handles[0]).toEqual(node.handles[0]);
  });

  it("the Color panel's colour reaches the selected point through the paint target, in one write", async () => {
    const { fake, g, paint } = meshHarness();
    await g.tool(createMeshHandler).click([150, 120]).settle();
    const mark = fake.mark();
    await paint()
      .get()!
      .apply({ space: "RGB", value: [0, 128, 255] });
    await g.settle();
    expectOneCommit(fake, mark);
    const grid = grid0(writes(fake).at(-1));
    expect(grid.nodes[4]!.color).toEqual({
      space: "RGB",
      value: [0, 128, 255],
    });
    expect(grid.nodes[0]!.color).toEqual(RED_CMYK);
  });

  it("maps the click through the frame's item transform into inner coordinates", async () => {
    // Inner → page: shifted by (50, 10).
    const { fake, g } = meshHarness({ transform: [1, 0, 0, 1, 50, 10] });
    await g.tool(createMeshHandler).click([200, 130]).settle();
    const n = grid0(writes(fake)[0]).nodes[4]!;
    expect(n.point[0]).toBeCloseTo(150, 6);
    expect(n.point[1]).toBeCloseTo(120, 6);
  });

  it("deactivating takes the overlay and the paint target back", async () => {
    const { fake, g, paint } = meshHarness();
    for (const t of BUILT_IN_TOOLS) fake.editor.registries.tools.register(t);
    await g.tool(createMeshHandler).click([150, 120]).settle();
    await g.tool("paged.tool.rectangle").settle();
    expect(paint().get()).toBeNull();
    expect(fake.currentPreview()).toBeNull();
  });
});

type Freeform = Extract<MeshFillSpec, { kind: "freeform" }>;

describe("Gradient Swatch tool, freeform modes", () => {
  it("setting mode: freeform points — a click adds a point in the fill colour, the next a distinct colour, each in one write @level:gesture", async () => {
    covers(
      "tool:paged.tool.gradientSwatch",
      "setting:paged.tool.gradientSwatch.mode",
    );
    const { fake, g, paint } = meshHarness({
      settings: { mode: "freeformPoints" },
    });
    await g.tool(createGradientSwatchHandler).settle();
    let mark = fake.mark();
    await g.click([150, 120]).settle();
    expectOneCommit(fake, mark);
    let spec = writes(fake).at(-1) as Freeform;
    expect(spec).toEqual({
      kind: "freeform",
      points: [{ point: [150, 120], color: RED_CMYK }],
      lines: [],
    });
    expect(paint().get()?.label).toBe("1 gradient point");
    mark = fake.mark();
    await g.click([250, 180]).settle();
    expectOneCommit(fake, mark);
    spec = writes(fake).at(-1) as Freeform;
    expect(spec.points).toHaveLength(2);
    expect(spec.points[1]!.color).not.toEqual(RED_CMYK);
  });

  it("setting spread: new points carry the Spread option", async () => {
    covers("setting:paged.tool.gradientSwatch.spread");
    const { fake, g } = meshHarness({
      settings: { mode: "freeformPoints", spread: 40 },
    });
    await g.tool(createGradientSwatchHandler).click([150, 120]).settle();
    expect((writes(fake)[0] as Freeform).points[0]!.spreadPct).toBe(40);
  });

  it("dragging a point moves it; Delete removes it; the last point removed clears the gradient", async () => {
    const { fake, g } = meshHarness({ settings: { mode: "freeformPoints" } });
    await g.tool(createGradientSwatchHandler).click([150, 120]).settle();
    await g.drag({ from: [150, 120], to: [160, 150] }).settle();
    expect((writes(fake).at(-1) as Freeform).points[0]!.point).toEqual([
      160, 150,
    ]);
    await g.key("Backspace").settle();
    expect(writes(fake).at(-1)).toBeNull();
    expect(writes(fake)).toHaveLength(3);
  });

  it("freeform lines: consecutive clicks join one line; Escape ends it", async () => {
    const { fake, g } = meshHarness({ settings: { mode: "freeformLines" } });
    await g
      .tool(createGradientSwatchHandler)
      .click([120, 120])
      .settle()
      .click([180, 150])
      .settle()
      .click([260, 130])
      .settle();
    expect((writes(fake).at(-1) as Freeform).lines).toEqual([[0, 1, 2]]);
    await g.key("Escape").click([200, 190]).settle();
    const spec = writes(fake).at(-1) as Freeform;
    expect(spec.points).toHaveLength(4);
    expect(spec.lines).toEqual([[0, 1, 2]]);
  });

  it("Linear (the default) is the axis drag, unchanged: no mesh write", async () => {
    const { fake, g } = meshHarness();
    await g
      .tool(createGradientSwatchHandler)
      .drag({ from: [100, 100], to: [100, 200] })
      .settle();
    expect(writes(fake)).toEqual([]);
    expect(leaves(fake).map((m) => (m.args as { path?: string }).path)).toEqual(
      ["frameGradientFillAngle", "frameGradientFillLength"],
    );
  });
});

describe("the tools' German (plan E10)", () => {
  it("covers every message the tools define, with their parameters; the Mesh tool's title follows the locale", () => {
    const english = englishSource();
    const de = BUILT_IN_LOCALES.de!;
    const keys = Object.keys(english).filter((k) => k.startsWith("tools."));
    expect(keys.length).toBeGreaterThan(5);
    expect(keys.filter((k) => !(k in de))).toEqual([]);
    const params = (s: string) =>
      [...s.matchAll(/\{(\w+)[},]/g)].map((m) => m[1]).sort();
    for (const k of keys)
      expect({ k, p: params(de[k]!) }).toEqual({ k, p: params(english[k]!) });
    const mesh = BUILT_IN_TOOLS.find((t) => t.id === "paged.tool.mesh")!;
    expect(mesh.title).toBe("Mesh");
    setActiveStrings(createStrings("de", BUILT_IN_LOCALES.de));
    try {
      expect(mesh.title).toBe("Gitter");
    } finally {
      setActiveStrings(createStrings());
    }
  });
});
