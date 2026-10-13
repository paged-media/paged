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

// The Shape Builder over the two overlaps the editor film found broken —
// driven through the live handler against the REAL engine.
//
// THE CROSS. A horizontal bar 100..340 × 355..415 pt crossed by a vertical
// bar 190..250 × 290..470 pt drawn over it; drag from the left arm into the
// top arm. The result used to be ONLY those two arms, touching at a corner:
// the centre and the two other arms vanished. Expected: the crossed arms
// merge into one path, everything else stays where it was, in the paint of
// the shape that was on top there.
//
// TWO OVALS. The engine reads an oval as its BOUNDING BOX (`pathAnchors`
// answers no geometry for one, and the planar arrangement falls back to the
// box), so the builder merged rectangles. Expected: the merged region is the
// ovals' own curve.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CanvasPointerEvent, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { pointInAnchorPath } from "@paged-media/draw-geometry";

import { createShapeBuilderHandler, drawBundle } from "../../src";
import { packageWithSpread } from "../fixtures/build-idml";
import { openHost } from "./host";

const PAGE = "usp";

function pointer(point: [number, number], alt = false): CanvasPointerEvent {
  return {
    pageId: PAGE,
    pagePoint: point,
    docPoint: point,
    modifiers: { shift: false, alt, cmd: false, ctrl: false },
    maxDelta: 0,
    button: 0,
    target: null,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    pointerType: "mouse",
  };
}

const key = (id: ElementId) => `${id.kind}:${String(id.id)}`;

async function leaves(h: HeadlessHost): Promise<ElementId[]> {
  const out: ElementId[] = [];
  const walk = (nodes: { id?: unknown; children?: unknown[] }[]) => {
    for (const n of nodes) {
      if (n.children && n.children.length > 0) walk(n.children as never);
      else if (n.id) out.push(n.id as ElementId);
    }
  };
  walk((await h.host.document.tree()) as never);
  return out;
}

async function until(predicate: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The swatch a test colour is minted as. */
const swatch = (name: string) => `Color/sb-${name}`;

/** Mint two swatches and fill each element with its own — so where a piece
 *  of the result came from can be read off its paint. */
async function paint(h: HeadlessHost, fills: [ElementId, string][]): Promise<void> {
  const rgb: Record<string, [number, number, number]> = { red: [255, 0, 0], blue: [0, 0, 255] };
  for (const [id, name] of fills) {
    const made = await h.host.document.mutate({
      op: "createSwatch",
      args: { spec: { selfId: swatch(name), name: swatch(name), space: "RGB", value: rgb[name] } },
    } as never);
    expect(made.applied, `createSwatch ${name}`).toBe(true);
    const filled = await h.host.document.mutate({
      op: "setElementProperty",
      args: { elementId: id, path: "frameFillColor", value: { type: "colorRef", value: swatch(name) } },
    });
    expect(filled.applied, `fill ${key(id)}`).toBe(true);
  }
}

async function fillOf(h: HeadlessHost, id: ElementId): Promise<string | null> {
  const props = await h.host.document.elementProperties(id);
  const v = props?.entries.find((e) => e.path === "frameFillColor")?.value as
    | { type: string; value: string | null }
    | undefined;
  return v?.type === "colorRef" ? v.value : null;
}

/** Every element whose painted shape contains `point` (page space), with its
 *  outline — read off the engine's anchor tables, through each element's
 *  transform. */
async function elementsAt(h: HeadlessHost, point: [number, number]) {
  const out: { id: ElementId; anchors: number }[] = [];
  for (const id of await leaves(h)) {
    let t = await h.host.document.pathAnchors(id);
    if (!t || t.anchors.length < 3) {
      // A bounds-only rectangle (no anchor table): its frame box.
      const [g] = await h.host.document.elementGeometry([id]);
      if (!g || id.kind !== "rectangle") continue;
      const [top, left, bottom, right] = g.bounds;
      const c = (x: number, y: number) => ({ anchor: [x, y] as [number, number], left: [x, y] as [number, number], right: [x, y] as [number, number] });
      t = { id, anchors: [c(left, top), c(right, top), c(right, bottom), c(left, bottom)], subpathStarts: [0], itemTransform: g.itemTransform ?? null };
    }
    const m = t.itemTransform ?? [1, 0, 0, 1, 0, 0];
    const at = (p: [number, number]): [number, number] => [
      m[0] * p[0] + m[2] * p[1] + m[4],
      m[1] * p[0] + m[3] * p[1] + m[5],
    ];
    const anchors = t.anchors.map((a) => ({ anchor: at(a.anchor), left: at(a.left), right: at(a.right) }));
    if (pointInAnchorPath(point, anchors, t.subpathStarts)) out.push({ id, anchors: t.anchors.length });
  }
  return out;
}

/** Drag the live handler from `from` to `to` (a move every 2 pt), wait for
 *  the commit to land. */
async function build(h: HeadlessHost, inputs: ElementId[], from: [number, number], to: [number, number], alt = false) {
  await h.host.selection.set(inputs);
  const handler = createShapeBuilderHandler(h.host);
  handler.onActivate(undefined as never);
  await new Promise((r) => setTimeout(r, 40));
  handler.onPointerDown(pointer(from, alt));
  // Let the arrangement land before the drag runs, as it does under a hand.
  await new Promise((r) => setTimeout(r, 60));
  const steps = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 2);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    handler.onPointerMove(pointer([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t], alt));
  }
  await new Promise((r) => setTimeout(r, 30));
  // The commit is the first change applied after the release (a probe the
  // build withdraws is applied AND undone: it is not a commit).
  let applied = 0;
  let undone = 0;
  const sub = h.host.document.onDidChange((e) => {
    if (e.kind === "mutationApplied") applied++;
    if (e.kind === "undoApplied") undone++;
  });
  handler.onPointerUp(pointer(to, alt));
  try {
    await until(async () => applied > undone, "the shape-builder commit");
  } finally {
    sub.dispose();
  }
  // Let any follow-up of the commit (selection, cache drop) settle.
  await new Promise((r) => setTimeout(r, 30));
  handler.onDeactivate("switch");
}

describe("Shape Builder on a cross-shaped overlap — the regions it does not cross stay [plugin-draw.shape-builder]", () => {
  // Back to front: the horizontal bar, then the vertical bar over it.
  const H: ElementId = { kind: "rectangle", id: "uh" };
  const V: ElementId = { kind: "rectangle", id: "uv" };
  const CROSS = packageWithSpread(
    `<Rectangle Self="uh" GeometricBounds="355 100 415 340" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black"/>` +
      `<Rectangle Self="uv" GeometricBounds="290 190 470 250" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black"/>`,
  );
  const LEFT: [number, number] = [145, 385];
  const TOP: [number, number] = [220, 322];
  const CENTRE: [number, number] = [220, 385];
  const RIGHT: [number, number] = [295, 385];
  const BOTTOM: [number, number] = [220, 442];

  let h: HeadlessHost;
  beforeEach(async () => {
    h = await openHost();
    await h.load(CROSS);
    h.loadBundle(drawBundle);
    await paint(h, [
      [H, "red"],
      [V, "blue"],
    ]);
  });
  afterEach(() => h?.dispose());

  it("dragging from the left arm into the top arm merges those two arms into ONE path", async () => {
    await build(h, [H, V], [150, 385], [220, 320]);
    const left = await elementsAt(h, LEFT);
    const top = await elementsAt(h, TOP);
    expect(left, "the left arm is covered").toHaveLength(1);
    expect(top, "the top arm is covered").toHaveLength(1);
    expect(key(left[0].id), "the two arms are ONE path").toBe(key(top[0].id));
    // It belongs to the vertical bar — the topmost shape the drag crossed.
    expect(await fillOf(h, left[0].id)).toBe(swatch("blue"));
  });

  it("the centre and the other two arms are still there, in the paint that was on top of them", async () => {
    await build(h, [H, V], [150, 385], [220, 320]);
    const merged = (await elementsAt(h, LEFT))[0]?.id;
    for (const [where, at, fill] of [
      ["the centre", CENTRE, "blue"],
      ["the right arm", RIGHT, "red"],
      ["the bottom arm", BOTTOM, "blue"],
    ] as const) {
      const hits = await elementsAt(h, at);
      expect(hits.length, `${where} vanished`).toBeGreaterThan(0);
      // Not part of the merged path: the drag never crossed it.
      expect(hits.every((x) => !merged || key(x.id) !== key(merged)), `${where} was merged`).toBe(true);
      expect(await fillOf(h, hits[0].id), `${where}'s paint`).toBe(swatch(fill));
    }
  });

  it("is ONE undo step: one undo brings both bars back as they were", async () => {
    const before = (await leaves(h)).map(key).sort();
    await build(h, [H, V], [150, 385], [220, 320]);
    await h.host.document.undo();
    expect((await leaves(h)).map(key).sort()).toEqual(before);
    expect(await fillOf(h, H)).toBe(swatch("red"));
    expect((await elementsAt(h, RIGHT)).map((x) => key(x.id))).toEqual([key(H)]);
  });

  it("an Alt-drag over the left arm deletes that arm and nothing else", async () => {
    await build(h, [H, V], [110, 385], [180, 385], true);
    expect(await elementsAt(h, LEFT), "the left arm is gone").toHaveLength(0);
    for (const at of [TOP, CENTRE, RIGHT, BOTTOM]) {
      expect((await elementsAt(h, at)).length, `${at} vanished`).toBeGreaterThan(0);
    }
    // The vertical bar was never touched: it is still one whole bar, over
    // the centre as before...
    expect((await elementsAt(h, TOP)).map((x) => key(x.id))).toContain(key(V));
    expect((await elementsAt(h, BOTTOM)).map((x) => key(x.id))).toContain(key(V));
    // ...and the horizontal bar keeps what is left of it, in its own paint
    // (the engine's `remove` alone united everything left into one shape,
    // repainting the right arm in the vertical bar's colour).
    const right = await elementsAt(h, RIGHT);
    expect(right.map((x) => key(x.id))).toEqual([key(H)]);
    expect(await fillOf(h, H)).toBe(swatch("red"));
  });
});

describe("Shape Builder over ovals — merges the curve, not the bounding box [plugin-draw.shape-builder]", () => {
  // Back to front: B (centre 300,200), then A (centre 200,200) over it; r = 100.
  const A: ElementId = { kind: "oval", id: "uoa" };
  const B: ElementId = { kind: "oval", id: "uob" };
  const OVALS = packageWithSpread(
    `<Oval Self="uob" GeometricBounds="100 200 300 400" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black"/>` +
      `<Oval Self="uoa" GeometricBounds="100 100 300 300" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black"/>`,
  );

  let h: HeadlessHost;
  beforeEach(async () => {
    h = await openHost();
    await h.load(OVALS);
    h.loadBundle(drawBundle);
    await paint(h, [
      [B, "red"],
      [A, "blue"],
    ]);
  });
  afterEach(() => h?.dispose());

  it("merging A's crescent and the lens gives A's circle — not its box", async () => {
    // From A's crescent (120,200) through the lens (250,200).
    await build(h, [A, B], [120, 200], [250, 200]);
    const merged = await elementsAt(h, [150, 200]);
    expect(merged, "the merged region").toHaveLength(1);
    expect(await fillOf(h, merged[0].id)).toBe(swatch("blue"));
    // A's box corner is NOT in the result: the curve was merged.
    expect(await elementsAt(h, [110, 110]), "a bounding-box corner was merged").toHaveLength(0);
    // The lens is part of it, and so is the curve's widest point.
    expect((await elementsAt(h, [250, 200])).map((x) => key(x.id))).toEqual([key(merged[0].id)]);
    expect((await elementsAt(h, [105, 200])).map((x) => key(x.id))).toEqual([key(merged[0].id)]);
  });

  it("B's own crescent stays — a curve in B's paint, its box corner empty", async () => {
    await build(h, [A, B], [120, 200], [250, 200]);
    const rest = await elementsAt(h, [370, 200]);
    expect(rest, "B's crescent").toHaveLength(1);
    expect(await fillOf(h, rest[0].id)).toBe(swatch("red"));
    expect(await elementsAt(h, [390, 110]), "B's box corner").toHaveLength(0);
    expect(await elementsAt(h, [390, 290]), "B's box corner").toHaveLength(0);
  });

  it("is ONE undo step: one undo brings both ovals back", async () => {
    const before = (await leaves(h)).map(key).sort();
    await build(h, [A, B], [120, 200], [250, 200]);
    await h.host.document.undo();
    expect((await leaves(h)).map(key).sort()).toEqual(before);
  });
});
