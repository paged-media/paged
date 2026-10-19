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
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// THE Pencil (`paged.tool.pencil`, modules/draw ADR 359) against the real
// engine: the live gesture handler, driven pointer by pointer through the
// headless editor, authors a path the engine accepts — previewed while
// drawn, selected once committed, painted with the graphic default, one
// undo step — and its options reach the geometry the engine stores. The
// fake-editor tier (packages/tools) pins the exact mutations; this tier
// reads the anchor tables and properties back from the engine.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { CanvasPointerEvent, PagedEditor } from "@paged-media/shell";
import { createPencilHandler } from "@paged-media/tools";
import { covers } from "@paged-media/test-kit";
import {
  dumpDiff,
  elementKey,
  type ModelDump,
} from "@paged-media/test-kit/headless";

import { createHeadlessEditor, type HeadlessEditor } from "./harness";

type Pt = [number, number];
type Anchor = { anchor: number[]; left: number[]; right: number[] };

const TOOL = "paged.tool.pencil";

let ed: HeadlessEditor;
let page: string;

beforeAll(async () => {
  ed = await createHeadlessEditor({ blank: [612, 792] });
  page = ((await ed.dump()).collections.pages as Array<{ selfId: string }>)[0]!
    .selfId;
});
afterAll(() => ed?.dispose());

function pointer(
  point: Pt,
  device: "mouse" | "pen",
  pressure: number,
  maxDelta: number,
): CanvasPointerEvent {
  return {
    pageId: page,
    pagePoint: point,
    docPoint: point,
    modifiers: { shift: false, alt: false, cmd: false, ctrl: false },
    maxDelta,
    button: 0,
    target: null,
    pressure,
    tiltX: 0,
    tiltY: 0,
    pointerType: device,
  } as CanvasPointerEvent;
}

interface Drawn {
  before: ModelDump;
  /** The path the stroke selected (`null`: it committed nothing). */
  id: { kind: string; id: string } | null;
  anchors: Anchor[];
  open: boolean;
  /** The preview while the pointer was down, before the lift. */
  previewed: unknown;
}

/** Draw `points` with the live handler; read the result back. */
async function draw(
  points: readonly Pt[],
  options: {
    device?: "mouse" | "pen";
    settings?: Record<string, number | string>;
  } = {},
): Promise<Drawn> {
  const device = options.device ?? "mouse";
  for (const [key, value] of Object.entries(options.settings ?? {}))
    ed.state.toolSettings.set(TOOL, key, value);
  const before = await ed.dump();
  const handler = createPencilHandler();
  handler.onActivate(ed.editor as unknown as PagedEditor);
  const pressure = (i: number) =>
    device === "pen" ? 0.2 + (0.7 * i) / points.length : 0.5;
  handler.onPointerDown(pointer(points[0]!, device, pressure(0), 0));
  for (let i = 1; i < points.length; i++)
    handler.onPointerMove(pointer(points[i]!, device, pressure(i), 10 * i));
  const previewed = (ed.state.overlaySignals as { toolPreview: unknown })
    .toolPreview;
  handler.onPointerUp(
    pointer(
      points.at(-1)!,
      device,
      pressure(points.length),
      10 * points.length,
    ),
  );
  handler.onDeactivate("switch");
  await ed.idle();
  for (const key of Object.keys(options.settings ?? {}))
    ed.state.toolSettings.set(TOOL, key, undefined as never);
  const after = await ed.dump();
  const created = Object.keys(after.elements).filter(
    (k) => !(k in before.elements),
  );
  if (created.length === 0)
    return { before, id: null, anchors: [], open: true, previewed };
  // The stroke selected what it made.
  expect(created).toHaveLength(1);
  const id = ed.state.selection.elementSelection[0] as Drawn["id"];
  expect(id && elementKey(id)).toBe(created[0]!);
  const table = await ed.client.pathAnchors(id as never);
  return {
    before,
    id,
    anchors: (table?.anchors ?? []) as Anchor[],
    open: table?.subpathOpen?.[0] ?? true,
    previewed,
  };
}

async function undoTo(before: ModelDump): Promise<void> {
  await ed.invoke("paged.editor.undo");
  await ed.idle();
  expect(dumpDiff(before, await ed.dump())).toEqual([]);
}

async function paintOf(id: Drawn["id"]) {
  const reply = await ed.send({
    kind: "requestElementProperties",
    payload: { id: id as never },
  });
  const entries =
    reply.kind === "elementProperties"
      ? (reply.payload.result?.entries ?? [])
      : [];
  const value = (path: string) =>
    (entries.find((e) => e.path === path)?.value as { value?: unknown })
      ?.value ?? null;
  return {
    fill: value("frameFillColor"),
    stroke: value("frameStrokeColor"),
    weight: value("frameStrokeWeight"),
  };
}

const isCorner = (a: Anchor) =>
  a.left[0] === a.anchor[0] &&
  a.left[1] === a.anchor[1] &&
  a.right[0] === a.anchor[0] &&
  a.right[1] === a.anchor[1];

/** A zig-zag whose wobble is 8 pt: it survives a 2 px fidelity and
 *  collapses under a 10 px one. */
const WOBBLE: Pt[] = [
  [420, 60],
  [440, 68],
  [460, 60],
  [480, 68],
  [500, 60],
  [520, 68],
  [540, 60],
];
/** A loop that ends 5 pt from where it began. */
const LOOP: Pt[] = [
  [450, 150],
  [520, 150],
  [520, 220],
  [450, 220],
  [453, 154],
];
/** An arc: the engine's curve fit has something to bend. */
const ARC: Pt[] = Array.from({ length: 9 }, (_, i) => {
  const t = (i / 8) * Math.PI;
  return [300 - 80 * Math.cos(t), 500 - 80 * Math.sin(t)] as Pt;
});

describe("the Pencil against the real engine", () => {
  test("a stroke previews while drawn, commits ONE selected path in the graphic default, and one undo takes it back", async () => {
    covers("tool:paged.tool.pencil");
    const d = await draw(ARC);
    expect(d.previewed).toMatchObject({ pageId: page });
    expect(d.id?.kind).toBe("polygon");
    expect(d.anchors[0]!.anchor).toEqual([220, 500]);
    // Smooth curves (the default): the engine fitted the simplified
    // corners, so the stored path has real handles.
    expect(d.anchors.some((a) => !isCorner(a))).toBe(true);
    expect(d.open).toBe(true);
    // File ▸ New has no defaults: InDesign's [Normal Graphics Frame].
    expect(await paintOf(d.id)).toEqual({
      fill: null,
      stroke: "Color/Black",
      weight: 1,
    });
    expect(
      (ed.state.overlaySignals as { toolPreview: unknown }).toolPreview,
    ).toBeNull();
    await undoTo(d.before);
  });

  test("a pen stroke is a variable-width outline, still one undo step and still painted", async () => {
    covers("tool:paged.tool.pencil");
    const mouse = await draw(ARC);
    await undoTo(mouse.before);
    const pen = await draw(ARC, { device: "pen" });
    expect(pen.id).not.toBeNull();
    // The outline is a filled shape around the centreline: more anchors
    // than the stroke it was baked from, and closed.
    expect(pen.anchors.length).toBeGreaterThan(mouse.anchors.length);
    expect((await paintOf(pen.id)).stroke).toBe("Color/Black");
    await undoTo(pen.before);
  });

  test("a click commits nothing", async () => {
    const d = await draw([
      [200, 300],
      [200, 300],
    ]);
    expect(d.id).toBeNull();
    expect(dumpDiff(d.before, await ed.dump())).toEqual([]);
  });

  test("defaults the user set win: the tool adds no paint of its own", async () => {
    const reply = await ed.client.mutate({
      op: "setDocumentDefaults",
      args: { fillColor: null, strokeColor: "Color/Black", strokeWeight: 2 },
    } as never);
    expect(reply.kind).toBe("mutationApplied");
    const d = await draw(ARC);
    expect(await paintOf(d.id)).toEqual({
      fill: null,
      stroke: "Color/Black",
      weight: 2,
    });
    await undoTo(d.before);
    await ed.invoke("paged.editor.undo");
    await ed.idle();
  });
});

describe("the Pencil's options reach the engine's geometry", () => {
  test("fidelity: the 8 pt wobble survives the default and collapses under 10 px", async () => {
    covers("setting:paged.tool.pencil.fidelity");
    const fine = await draw(WOBBLE, { settings: { smoothing: "corners" } });
    expect(fine.anchors).toHaveLength(WOBBLE.length);
    await undoTo(fine.before);
    const coarse = await draw(WOBBLE, {
      settings: { smoothing: "corners", fidelity: 10 },
    });
    expect(coarse.anchors.map((a) => a.anchor)).toEqual([
      [420, 60],
      [540, 60],
    ]);
    await undoTo(coarse.before);
  });

  test("smoothing: corner points store the simplified samples as corners; smooth curves are fitted", async () => {
    covers("setting:paged.tool.pencil.smoothing");
    const corners = await draw(WOBBLE, { settings: { smoothing: "corners" } });
    expect(corners.anchors.every(isCorner)).toBe(true);
    expect(corners.anchors.map((a) => a.anchor)).toEqual(WOBBLE);
    await undoTo(corners.before);
    const smooth = await draw(ARC);
    expect(smooth.anchors.some((a) => !isCorner(a))).toBe(true);
    await undoTo(smooth.before);
  });

  test("close distance: the default closes a loop lifted 5 pt from its start; 0 never closes", async () => {
    covers("setting:paged.tool.pencil.closeDistance");
    const closed = await draw(LOOP);
    expect(closed.open).toBe(false);
    await undoTo(closed.before);
    const open = await draw(LOOP, { settings: { closeDistance: 0 } });
    expect(open.open).toBe(true);
    await undoTo(open.before);
  });
});
