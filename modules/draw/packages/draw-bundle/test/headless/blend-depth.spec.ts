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

// BLEND CONSTRUCT DEPTH (WP6.6) through the REAL engine: keys with
// DIFFERENT anchor counts blend (the intermediates carry the matched
// structure, the keys keep their own anchors), two GROUPS blend member to
// member by order, and GRADIENT fills blend stop for stop — each one
// build, update and release a single undo step. What still cannot be
// blended is refused with its reason and writes nothing.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import type { ElementId, MutationInput } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import {
  applyMakeBlend,
  applyReleaseBlend,
  applyUpdateBlend,
  blendLinks,
  drawBundle,
  rawGradientDetail,
  readBlendLibrary,
} from "../../src";
import { packageWithSpread, pathItem } from "../fixtures/build-idml";
import { squareItem } from "../panels/panel-document";
import { openHost } from "./host";

const P = (id: string) => ({ kind: "polygon", id }) as ElementId;

const triangle = (id: string, x: number, y: number, s: number) =>
  pathItem("Polygon", id, `${y} ${x} ${y + s} ${x + s}`, false, [
    { a: [x + s / 2, y] },
    { a: [x + s, y + s] },
    { a: [x, y + s] },
  ]);
const hexagon = (id: string, cx: number, cy: number, r: number) =>
  pathItem(
    "Polygon",
    id,
    `${cy - r} ${cx - r} ${cy + r} ${cx + r}`,
    false,
    Array.from({ length: 6 }, (_, i) => ({
      a: [
        cx + r * Math.cos((i * Math.PI) / 3),
        cy + r * Math.sin((i * Math.PI) / 3),
      ] as [number, number],
    })),
  );

const doc = () =>
  packageWithSpread(
    squareItem("sq", 40, 40, 60) +
      triangle("tri", 340, 40, 60) +
      hexagon("hex", 370, 260, 40) +
      squareItem("ga1", 40, 400, 30) +
      squareItem("ga2", 90, 400, 30) +
      squareItem("gb1", 340, 420, 40) +
      squareItem("gb2", 400, 420, 40) +
      squareItem("gc1", 40, 600, 30),
  );

async function leafCount(h: HeadlessHost): Promise<number> {
  let n = 0;
  const walk = (nodes: { children?: unknown[] }[]) => {
    for (const node of nodes) {
      const kids = (node.children ?? []) as never[];
      if (kids.length > 0) walk(kids);
      else n++;
    }
  };
  walk((await h.host.document.tree()) as never);
  return n;
}

async function fillOf(h: HeadlessHost, id: ElementId): Promise<string | null> {
  const props = await h.host.document.elementProperties(id);
  const v = props?.entries.find((e) => e.path === "frameFillColor")?.value;
  return (v?.value as string | null) ?? null;
}

/** Every group in the scene tree, depth first. */
async function groupsOf(h: HeadlessHost): Promise<ElementId[]> {
  const out: ElementId[] = [];
  const walk = (nodes: { id?: ElementId | null; children?: unknown[] }[]) => {
    for (const node of nodes) {
      if (node.id?.kind === "group") out.push(node.id);
      walk((node.children ?? []) as never);
    }
  };
  walk((await h.host.document.tree()) as never);
  return out;
}

const group = (ids: ElementId[]): MutationInput => ({
  op: "createGroup",
  args: { memberIds: ids },
});

describe("draw conformance — BLEND construct depth (WP6.6)", () => {
  let h: HeadlessHost;
  beforeAll(async () => {
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());
  beforeEach(async () => {
    await h.load(doc());
  });

  it("a SQUARE blends to a TRIANGLE: every intermediate has four anchors, the triangle keeps three; one undo", async () => {
    covers("command:media.paged.draw.command.blendSelected");
    const before = await leafCount(h);
    await h.host.selection.set([P("sq"), P("tri")]);
    const steps = await applyMakeBlend(h.host, { steps: 3 });
    expect(steps).toHaveLength(3);
    for (const id of steps) {
      expect((await h.host.document.pathAnchors(id))?.anchors).toHaveLength(4);
    }
    expect((await h.host.document.pathAnchors(P("tri")))?.anchors).toHaveLength(
      3,
    );
    expect(await leafCount(h)).toBe(before + 3);
    await h.host.document.undo();
    expect(await leafCount(h)).toBe(before);
  });

  it("a square blends to a HEXAGON and the Update keeps the matched structure", async () => {
    covers("command:media.paged.draw.command.updateBlend");
    await h.host.selection.set([P("sq"), P("hex")]);
    await applyMakeBlend(h.host, { steps: 2 });
    const updated = await applyUpdateBlend(h.host, { steps: 4 });
    expect(updated).toHaveLength(4);
    for (const id of updated) {
      expect((await h.host.document.pathAnchors(id))?.anchors).toHaveLength(6);
    }
  });

  it("two GROUPS blend member to member by order; the groups stay groups; Update and Release work on the pairs", async () => {
    covers("command:media.paged.draw.command.blendSelected");
    covers("command:media.paged.draw.command.releaseBlend");
    await h.host.document.mutate({
      op: "batch",
      args: {
        ops: [
          group([P("ga1"), P("ga2")]),
          group([P("gb1"), P("gb2")]),
        ] as never,
      },
    });
    const groups = await groupsOf(h);
    expect(groups).toHaveLength(2);
    const before = await leafCount(h);
    await h.host.selection.set(groups);
    const steps = await applyMakeBlend(h.host, { steps: 3 });
    // Three steps × two pairs.
    expect(steps).toHaveLength(6);
    expect(await leafCount(h)).toBe(before + 6);
    const record = (await readBlendLibrary(h.host)).blends[0]!;
    expect(record.keys.map((k) => k.id)).toEqual(["ga1", "gb1", "ga2", "gb2"]);
    const links = await blendLinks(h.host, record.id);
    expect(links.keys.map((k) => k.ref.index)).toEqual([0, 1, 2, 3]);
    // Each pair interpolates between ITS members: pair 0's first step sits
    // between ga1 and gb1, not anywhere near the second pair.
    const centre = async (id: ElementId) => {
      const t = await h.host.document.pathAnchors(id);
      const xs = t!.anchors.map((a) => a.anchor[0]);
      return (Math.min(...xs) + Math.max(...xs)) / 2;
    };
    const ga1 = await centre(P("ga1"));
    const gb1 = await centre(P("gb1"));
    const first = await centre(steps[0]!);
    expect(first).toBeGreaterThan(ga1);
    expect(first).toBeLessThan(gb1);
    // Update: four steps × two pairs, in one batch.
    expect(
      await applyUpdateBlend(h.host, { blendId: record.id, steps: 4 }),
    ).toHaveLength(8);
    // Release: the intermediates go, the key groups stay.
    expect(await applyReleaseBlend(h.host, { blendId: record.id })).toBe(8);
    expect(await leafCount(h)).toBe(before);
    expect(await groupsOf(h)).toHaveLength(2);
  });

  it("groups of different sizes, and a group against a path, are refused and write nothing", async () => {
    await h.host.document.mutate(group([P("ga1"), P("ga2")]));
    const [g] = (await groupsOf(h)) as [ElementId];
    await h.host.document.mutate(group([P("gc1"), P("gb1"), P("gb2")]));
    const g3 = (await groupsOf(h)).find((id) => id.id !== g.id)!;
    const before = await leafCount(h);
    await h.host.selection.set([g, g3]);
    expect(await applyMakeBlend(h.host, {})).toEqual([]);
    await h.host.selection.set([g, P("sq")]);
    expect(await applyMakeBlend(h.host, {})).toEqual([]);
    expect(await leafCount(h)).toBe(before);
  });

  it("a GRADIENT key blends stop for stop with a flat key: every intermediate gets its own gradient", async () => {
    covers("command:media.paged.draw.command.blendSelected");
    await h.host.document.mutate({
      op: "batch",
      args: {
        ops: [
          {
            op: "createSwatch",
            args: {
              spec: {
                selfId: "Color/uk",
                name: "#000000",
                space: "RGB",
                value: [0, 0, 0],
              },
            },
          },
          {
            op: "createSwatch",
            args: {
              spec: {
                selfId: "Color/uw",
                name: "#ffffff",
                space: "RGB",
                value: [255, 255, 255],
              },
            },
          },
          {
            op: "createSwatch",
            args: {
              spec: {
                selfId: "Color/ur",
                name: "#ff0000",
                space: "RGB",
                value: [255, 0, 0],
              },
            },
          },
          {
            op: "createGradient",
            args: {
              spec: {
                selfId: "Gradient/ukw",
                name: "Black white",
                kind: "Linear",
                stops: [
                  { stopColor: "Color/uk", locationPct: 0 },
                  { stopColor: "Color/uw", locationPct: 100 },
                ],
              },
            },
          },
          {
            op: "setElementProperty",
            args: {
              elementId: P("sq"),
              path: "frameFillColor",
              value: { type: "colorRef", value: "Gradient/ukw" },
            },
          },
          {
            op: "setElementProperty",
            args: {
              elementId: P("hex"),
              path: "frameFillColor",
              value: { type: "colorRef", value: "Color/ur" },
            },
          },
        ] as never,
      },
    });
    await h.host.selection.set([P("sq"), P("hex")]);
    const steps = await applyMakeBlend(h.host, { steps: 3 });
    expect(steps).toHaveLength(3);
    const firstStop: string[] = [];
    for (const id of steps) {
      const ref = await fillOf(h, id);
      expect(ref?.startsWith("Gradient/")).toBe(true);
      const detail = await rawGradientDetail(h.host, ref!);
      expect(detail?.stops).toHaveLength(2);
      firstStop.push(detail!.stops[0]!.resolvedRgbHex.toLowerCase());
    }
    // Stop 0 travels from black toward red: t = ¼, ½, ¾.
    expect(firstStop).toEqual(["#400000", "#800000", "#bf0000"]);
    // One undo.
    await h.host.document.undo();
    expect(await fillOf(h, P("sq"))).toBe("Gradient/ukw");
  });

  it("a LINEAR gradient against a RADIAL one is refused with its reason", async () => {
    await h.host.document.mutate({
      op: "batch",
      args: {
        ops: [
          {
            op: "createSwatch",
            args: {
              spec: {
                selfId: "Color/uk",
                name: "#000000",
                space: "RGB",
                value: [0, 0, 0],
              },
            },
          },
          {
            op: "createGradient",
            args: {
              spec: {
                selfId: "Gradient/ul",
                name: "L",
                kind: "Linear",
                stops: [
                  { stopColor: "Color/uk", locationPct: 0 },
                  { stopColor: "Color/uk", locationPct: 100 },
                ],
              },
            },
          },
          {
            op: "createGradient",
            args: {
              spec: {
                selfId: "Gradient/ur",
                name: "R",
                kind: "Radial",
                stops: [
                  { stopColor: "Color/uk", locationPct: 0 },
                  { stopColor: "Color/uk", locationPct: 100 },
                ],
              },
            },
          },
          {
            op: "setElementProperty",
            args: {
              elementId: P("sq"),
              path: "frameFillColor",
              value: { type: "colorRef", value: "Gradient/ul" },
            },
          },
          {
            op: "setElementProperty",
            args: {
              elementId: P("hex"),
              path: "frameFillColor",
              value: { type: "colorRef", value: "Gradient/ur" },
            },
          },
        ] as never,
      },
    });
    const logs: string[] = [];
    const warn = h.host.log.warn.bind(h.host.log);
    h.host.log.warn = (m: string) => {
      logs.push(m);
      warn(m);
    };
    try {
      const before = await leafCount(h);
      await h.host.selection.set([P("sq"), P("hex")]);
      expect(await applyMakeBlend(h.host, {})).toEqual([]);
      expect(await leafCount(h)).toBe(before);
      expect(logs.join("\n")).toContain("cannot blend to a radial one");
    } finally {
      h.host.log.warn = warn;
    }
  });
});
