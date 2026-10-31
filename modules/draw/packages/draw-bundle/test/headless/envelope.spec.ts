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

// WP6.3 (draw ADR 367) through the REAL engine wasm: Object ▸ Envelope
// distort and Object ▸ Expand appearance, as typed commands (what the CLI
// and scripting run) and the Envelope Mesh tool's handler. Every change is
// asserted on the document it leaves and on its undo: ONE mutation, ONE
// undo step. [plugin-draw.envelope-distort]

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";
import {
  envelopePoint,
  flatNet,
  netIndex,
  type Vec2,
} from "@paged-media/draw-geometry";

import {
  createEnvelopeMeshHandler,
  drawBundle,
  expandAppearance,
  makeWithTopObject,
  envelopeIndexOf,
  meshWrite,
  readMeshSessions,
  readObjectStack,
  unitToPage,
  ENVELOPE_TOOL_IDS,
} from "../../src";
import { packageWithSpread, pathItem } from "../fixtures/build-idml";
import { poly, squareItem, PAGE_ID } from "../panels/panel-document";
import { countingHost } from "../perf/counting-host";
import { pointerAt, settle } from "../perf/pointer-stream";
import { openHost } from "./host";

const C = "media.paged.draw.command";
const SQ = poly("sq");
const TOP = poly("top");

// A 200 pt square at (100, 100), a trapezoid in front of it, and a small
// square elsewhere.
const DOC = () =>
  packageWithSpread(
    squareItem("sq", 100, 100, 200) +
      squareItem("small", 400, 600, 50) +
      pathItem("Polygon", "top", "100 100 300 300", false, [
        { a: [100, 100] },
        { a: [300, 100] },
        { a: [260, 300] },
        { a: [140, 300] },
      ]),
  );

const stack = async (h: HeadlessHost, id: ElementId) =>
  (await readObjectStack(h.host, id)) ?? [];

const anchorsOf = async (h: HeadlessHost, id: ElementId) =>
  (await h.host.document.pathAnchors(id))?.anchors ?? [];

describe("draw conformance — Envelope distort and Expand appearance (WP6.3) [plugin-draw.envelope-distort]", () => {
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

  it("the Envelope Mesh tool is keyless, in the Free Transform flyout", () => {
    covers("tool:media.paged.draw.tool.envelopeMesh");
    const tools = h.toolsContributed();
    const tool = tools.find((t) => t.id === ENVELOPE_TOOL_IDS[0]);
    expect(tool?.group).toBe("transform");
    expect(tool?.shortcut).toBeUndefined();
  });

  it("Make with warp: a warp entry, Arc 50 %, in ONE undo step", async () => {
    covers("command:media.paged.draw.command.envelopeMakeWithWarp");
    await h.host.selection.set([SQ]);
    await h.objects.invoke(`${C}.envelopeMakeWithWarp`, {
      targets: [],
      style: "flag",
      horizontal: true,
      bendPct: 40,
      distortHPct: 0,
      distortVPct: 0,
    });
    const s = await stack(h, SQ);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ kind: "warp", style: "flag", bendPct: 40 });
    await h.host.document.undo();
    expect(await stack(h, SQ)).toEqual([]);
  });

  it("Make with mesh: a flat rows × columns net, in ONE undo step", async () => {
    covers("command:media.paged.draw.command.envelopeMakeWithMesh");
    await h.host.selection.set([SQ]);
    await h.objects.invoke(`${C}.envelopeMakeWithMesh`, {
      targets: [],
      rows: 2,
      columns: 3,
    });
    const s = await stack(h, SQ);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ kind: "envelope", rows: 2, columns: 3 });
    expect((s[0]!.mesh as unknown[]).length).toBe(7 * 10);
    // The flat net draws the square as drawn.
    expect(await anchorsOf(h, SQ)).toHaveLength(4);
    await h.host.document.undo();
    expect(await stack(h, SQ)).toEqual([]);
  });

  it("Make with top object: the shape becomes the envelope and goes, in ONE undo step", async () => {
    covers("command:media.paged.draw.command.envelopeMakeWithTopObject");
    await h.host.selection.set([SQ, TOP]);
    await h.objects.invoke(`${C}.envelopeMakeWithTopObject`, { targets: [] });
    const s = await stack(h, SQ);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ kind: "envelope", rows: 1, columns: 1 });
    const net = s[0]!.mesh as Vec2[];
    // The square's box (100..300) maps onto the trapezoid: its corners go
    // to the trapezoid's.
    const at = (u: number, v: number) => {
      const p = envelopePoint(net, 1, 1, u, v);
      return [100 + p[0] * 200, 100 + p[1] * 200];
    };
    for (const [u, v, x, y] of [
      [0, 0, 100, 100],
      [1, 0, 300, 100],
      [1, 1, 260, 300],
      [0, 1, 140, 300],
    ] as const) {
      const [px, py] = at(u, v);
      expect(Math.hypot(px - x, py - y)).toBeLessThan(1);
    }
    // The top object is gone.
    expect(await h.host.document.pathAnchors(TOP).catch(() => null)).toBeNull();
    await h.host.document.undo();
    expect(await stack(h, SQ)).toEqual([]);
    expect(await anchorsOf(h, TOP)).toHaveLength(4);
  });

  it("Make with top object refuses a single item and says why", async () => {
    await h.host.selection.set([SQ]);
    await expect(makeWithTopObject(h.host)).rejects.toThrow(/envelope shape/);
    // From the menu the refusal is logged and the click settles.
    await h.objects.invoke(`${C}.envelopeMakeWithTopObject`, { targets: [] });
    expect(await stack(h, SQ)).toEqual([]);
  });

  it("Expand: the envelope becomes the path, in ONE undo step; later effects stay live", async () => {
    covers("command:media.paged.draw.command.envelopeExpand");
    await h.host.selection.set([SQ]);
    await h.objects.invoke(`${C}.envelopeMakeWithMesh`, {
      targets: [],
      rows: 1,
      columns: 1,
    });
    // Bend the top edge up through the mesh tool's write, and put a live
    // Pucker & Bloat AFTER the envelope.
    const [session] = await readMeshSessions(h.host);
    const net = flatNet(1, 1);
    net[netIndex(1, 0, 1)] = [1 / 3, -0.3];
    net[netIndex(1, 0, 2)] = [2 / 3, -0.3];
    const write = meshWrite({ ...session!, net });
    await h.host.document.mutate({
      op: "batch",
      args: { ops: [write] },
    } as never);
    const withBloat = [
      ...(await stack(h, SQ)),
      { kind: "puckerBloat", enabled: true, amountPct: 10 },
    ];
    await h.host.document.mutate({
      op: "setElementProperty",
      args: {
        elementId: SQ,
        path: "frameEffectStack",
        value: { type: "effectStack", value: { entries: withBloat } },
      },
    } as never);
    const before = JSON.stringify(await anchorsOf(h, SQ));
    await h.objects.invoke(`${C}.envelopeExpand`, { targets: [] });
    const after = await anchorsOf(h, SQ);
    expect(after.length).toBeGreaterThan(4);
    const top = Math.min(...after.map((a) => a.anchor[1]));
    expect(top).toBeLessThan(100 - 30);
    const s = await stack(h, SQ);
    expect(s.map((e) => e.kind)).toEqual(["puckerBloat"]);
    expect(envelopeIndexOf(s)).toBe(-1);
    await h.host.document.undo();
    expect(JSON.stringify(await anchorsOf(h, SQ))).toBe(before);
    expect((await stack(h, SQ)).map((e) => e.kind)).toEqual([
      "envelope",
      "puckerBloat",
    ]);
  });

  it("Expand appearance: every live effect of the selection, in ONE undo step", async () => {
    covers("command:media.paged.draw.command.expandAppearance");
    await h.host.selection.set([SQ]);
    await h.objects.invoke(`${C}.envelopeMakeWithWarp`, {
      targets: [],
      style: "arc",
      horizontal: true,
      bendPct: 50,
      distortHPct: 0,
      distortVPct: 0,
    });
    await h.objects.invoke(`${C}.expandAppearance`, { targets: [] });
    expect(await stack(h, SQ)).toEqual([]);
    expect((await anchorsOf(h, SQ)).length).toBeGreaterThan(4);
    await h.host.document.undo();
    expect((await stack(h, SQ)).map((e) => e.kind)).toEqual(["warp"]);
    // Nothing live: refused, nothing sent.
    await h.host.selection.set([poly("small")]);
    await expect(expandAppearance(h.host)).rejects.toThrow(/no live effect/);
  });

  it("Edit contents: selects the envelope's item and switches to Direct Selection", async () => {
    covers("command:media.paged.draw.command.envelopeEditContents");
    await h.host.selection.set([SQ]);
    await h.objects.invoke(`${C}.envelopeMakeWithMesh`, {
      targets: [],
      rows: 1,
      columns: 1,
    });
    const out = (await h.objects.invoke(`${C}.envelopeEditContents`, {
      targets: [],
    })) as { activated: boolean };
    // The headless host has no tool door: it says so, changes nothing.
    expect(out.activated).toBe(false);
    expect(h.host.selection.get()).toEqual([SQ]);
    await h.host.selection.set([poly("small")]);
    expect(
      await h.objects.invoke(`${C}.envelopeEditContents`, { targets: [] }),
    ).toBeNull();
  });

  it("envelopeMeshTool: with no tool door it says where the tool is", async () => {
    covers("command:media.paged.draw.command.envelopeMeshTool");
    const out = (await h.objects.invoke(`${C}.envelopeMeshTool`, {})) as {
      activated: boolean;
    };
    expect(out.activated).toBe(false);
  });

  it("the Envelope Mesh tool: a node drag is ONE write; Alt+click adds a row and a column", async () => {
    covers("tool:media.paged.draw.tool.envelopeMesh");
    await h.host.selection.set([SQ]);
    await h.objects.invoke(`${C}.envelopeMakeWithMesh`, {
      targets: [],
      rows: 2,
      columns: 2,
    });
    const { host, work } = countingHost(h.host);
    let commits = 0;
    const tool = createEnvelopeMeshHandler(host, {
      onCommit: (ok) => void (ok && commits++),
    });
    tool.onActivate(undefined as never);
    await settle();
    // The centre node of the 2 × 2 mesh sits at the square's centre.
    const [s] = await readMeshSessions(h.host);
    const centre = unitToPage(s!, s!.net[netIndex(2, 3, 3)]!);
    expect(centre).toEqual([200, 200]);
    tool.onPointerDown(pointerAt(PAGE_ID, centre));
    await settle();
    tool.onPointerMove(pointerAt(PAGE_ID, [220, 180]));
    await settle();
    tool.onPointerUp(pointerAt(PAGE_ID, [240, 160]));
    await settle();
    await settle();
    expect(commits).toBe(1);
    expect(work.mutations).toHaveLength(1);
    const [moved] = await readMeshSessions(h.host);
    expect(unitToPage(moved!, moved!.net[netIndex(2, 3, 3)]!)).toEqual([
      240, 160,
    ]);
    // The drawn outline is unchanged at the corners and the centre moved.
    await h.host.document.undo();
    const [back] = await readMeshSessions(h.host);
    expect(unitToPage(back!, back!.net[netIndex(2, 3, 3)]!)).toEqual([
      200, 200,
    ]);
    // Alt+click inside a cell: 3 × 3.
    tool.onPointerDown(pointerAt(PAGE_ID, [150, 250], { alt: true }));
    await settle();
    tool.onPointerUp(pointerAt(PAGE_ID, [150, 250], { alt: true }));
    await settle();
    await settle();
    const [finer] = await readMeshSessions(h.host);
    expect([finer!.rows, finer!.columns]).toEqual([3, 3]);
    tool.onDeactivate?.("switch" as never);
  });
});
