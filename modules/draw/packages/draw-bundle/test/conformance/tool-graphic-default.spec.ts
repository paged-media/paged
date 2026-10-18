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

// The graphic default on the REAL engine: a shape the Curvature or Pencil
// tool draws wears the document's `[Normal Graphics Frame]` — InDesign's
// (no fill, 1 pt Color/Black) when the document has no such style — unless
// the document has defaults of its own, and the paint lands in the same
// undo step as the shape. The LIVE gesture handlers are driven pointer by
// pointer; the wire shape is pinned in `../graphic-default.spec.ts`.
//
// The brushes are deliberately NOT given it: a Paintbrush / Blob Brush
// stroke is a filled sweep that already paints itself (the creation-
// default fill, else Color/Black — `handlers/brush.ts`). The last case
// pins that it is visible in a File ▸ New document as it is.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  BundleHost,
  CanvasPointerEvent,
  ElementId,
  GestureHandler,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  createCurvatureHandler,
  createPaintbrushHandler,
  createPencilHandler,
  drawBundle,
} from "../../src";
import { packageWithSpread } from "../fixtures/build-idml";
import { settle } from "../perf/pointer-stream";
import { openHost } from "./host";

type Pt = [number, number];

/** A document whose `[Normal Graphics Frame]` carries `attrs`. */
const withNormalGraphicsFrame = (attrs: string): Uint8Array =>
  packageWithSpread("", {
    styles:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<idPkg:Styles xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">` +
      `<RootCharacterStyleGroup Self="rcs">` +
      `<CharacterStyle Self="CharacterStyle/$ID/[No character style]" Name="$ID/[No character style]"/>` +
      `</RootCharacterStyleGroup>` +
      `<RootParagraphStyleGroup Self="rps">` +
      `<ParagraphStyle Self="ParagraphStyle/$ID/[No paragraph style]" Name="$ID/[No paragraph style]"/>` +
      `</RootParagraphStyleGroup>` +
      `<RootObjectStyleGroup Self="ros">` +
      `<ObjectStyle Self="ObjectStyle/$ID/[None]" Name="$ID/[None]"/>` +
      `<ObjectStyle Self="ObjectStyle/$ID/[Normal Graphics Frame]" Name="$ID/[Normal Graphics Frame]" ${attrs}/>` +
      `</RootObjectStyleGroup></idPkg:Styles>`,
  });

/** Filled and 4 pt: every value differs from what an insert gets alone. */
const HEAVY_STYLE = 'FillColor="Color/Black" StrokeColor="Color/Black" StrokeWeight="4"';

function pointer(pageId: string, point: Pt, pressure = 0.5, maxDelta = 0): CanvasPointerEvent {
  return {
    pageId,
    pagePoint: point,
    docPoint: point,
    modifiers: { shift: false, alt: false, cmd: false, ctrl: false },
    maxDelta,
    button: 0,
    target: null,
    pressure,
    tiltX: 0,
    tiltY: 0,
    pointerType: pressure === 0.5 ? "mouse" : "pen",
  };
}

async function leafIds(h: HeadlessHost): Promise<ElementId[]> {
  const out: ElementId[] = [];
  const walk = (nodes: { id?: ElementId | null; children?: unknown[] }[]) => {
    for (const n of nodes) {
      if (n.id && !n.children?.length) out.push(n.id);
      if (n.children) walk(n.children as never);
    }
  };
  walk((await h.host.document.tree()) as never);
  return out;
}

interface Paint {
  fill: unknown;
  stroke: unknown;
  weight: unknown;
}

async function paintOf(h: HeadlessHost, id: ElementId): Promise<Paint> {
  const props = await h.host.document.elementProperties(id);
  const value = (path: string) => props?.entries.find((e) => e.path === path)?.value?.value ?? null;
  return {
    fill: value("frameFillColor"),
    stroke: value("frameStrokeColor"),
    weight: value("frameStrokeWeight"),
  };
}

/** Run `gesture` against a fresh handler and answer the ONE element it
 *  added (and how many undo steps that cost, measured by undoing). */
async function drawn(
  h: HeadlessHost,
  make: (host: BundleHost) => GestureHandler,
  gesture: (handler: GestureHandler) => Promise<void>,
): Promise<{ id: ElementId; paint: Paint; undoSteps: number }> {
  const before = await leafIds(h);
  const handler = make(h.host);
  handler.onActivate(undefined as never);
  await gesture(handler);
  for (let i = 0; i < 50 && (await leafIds(h)).length === before.length; i++) await settle();
  handler.onDeactivate("switch");
  const added = (await leafIds(h)).filter((e) => !before.some((b) => b.id === e.id));
  expect(added, "the gesture drew exactly one shape").toHaveLength(1);
  const id = added[0]!;
  const paint = await paintOf(h, id);
  let undoSteps = 0;
  while ((await leafIds(h)).length > before.length && undoSteps < 5) {
    await h.host.document.undo();
    undoSteps++;
  }
  return { id, paint, undoSteps };
}

const curvature = (page: string) => async (handler: GestureHandler) => {
  for (const p of [
    [100, 100],
    [200, 160],
    [300, 100],
  ] as Pt[]) {
    handler.onPointerDown(pointer(page, p));
    await settle();
    handler.onPointerUp(pointer(page, p));
    await settle();
  }
  handler.onKey?.({ key: "Enter" } as KeyboardEvent);
  await settle();
};

/** A pencil stroke; `pen` makes the pressures vary (the variable-width
 *  outline lane), otherwise a mouse's constant pressure. */
const pencil = (page: string, pen: boolean) => async (handler: GestureHandler) => {
  const points: Pt[] = [];
  for (let x = 100; x <= 400; x += 20) points.push([x, 300 + (x % 40 === 0 ? 30 : 0)]);
  const pressure = (i: number) => (pen ? 0.2 + (0.7 * i) / (points.length - 1) : 0.5);
  handler.onPointerDown(pointer(page, points[0]!, pressure(0)));
  for (let i = 1; i < points.length; i++) {
    handler.onPointerMove(pointer(page, points[i]!, pressure(i), 20 * i));
  }
  const last = points.length - 1;
  handler.onPointerUp(pointer(page, points[last]!, pressure(last), 20 * last));
  await settle();
};

const paintbrush = (page: string) => async (handler: GestureHandler) => {
  handler.onPointerDown(pointer(page, [300, 500]));
  handler.onPointerMove(pointer(page, [340, 520], 0.5, 40));
  handler.onPointerMove(pointer(page, [380, 560], 0.5, 80));
  handler.onPointerUp(pointer(page, [380, 560], 0.5, 80));
  await settle();
};

const INDESIGN: Paint = { fill: null, stroke: "Color/Black", weight: 1 };
const HEAVY: Paint = { fill: "Color/Black", stroke: "Color/Black", weight: 4 };

describe("draw conformance — the drawing tools paint their shape with the graphic default", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    await h.newBlank(612, 792);
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  it("File ▸ New (no defaults, no object styles): InDesign's [Normal Graphics Frame] — no fill, 1 pt Color/Black", async () => {
    const [page] = await h.newBlank(612, 792);
    const curve = await drawn(h, createCurvatureHandler, curvature(page!));
    expect(curve.paint).toEqual(INDESIGN);
    expect(curve.undoSteps).toBe(1);
    const mouse = await drawn(h, createPencilHandler, pencil(page!, false));
    expect(mouse.paint).toEqual(INDESIGN);
    expect(mouse.undoSteps).toBe(1);
    const pen = await drawn(h, createPencilHandler, pencil(page!, true));
    expect(pen.paint).toEqual(INDESIGN);
    expect(pen.undoSteps).toBe(1);
  });

  it("the document's own [Normal Graphics Frame] (filled, 4 pt) is what the shape wears — in the insert's undo step", async () => {
    const [page] = await h.load(withNormalGraphicsFrame(HEAVY_STYLE));
    const curve = await drawn(h, createCurvatureHandler, curvature(page!));
    expect(curve.paint).toEqual(HEAVY);
    expect(curve.undoSteps).toBe(1);
    const mouse = await drawn(h, createPencilHandler, pencil(page!, false));
    expect(mouse.paint).toEqual(HEAVY);
    expect(mouse.undoSteps).toBe(1);
    // The pressure stroke: painted BEFORE it is outlined, and still one
    // batch — the outline keeps the paint and the shape is the outline.
    const pen = await drawn(h, createPencilHandler, pencil(page!, true));
    expect(pen.paint).toEqual(HEAVY);
    expect(pen.undoSteps).toBe(1);
  });

  it("defaults the user set win: the tool adds nothing, the engine paints with them", async () => {
    const [page] = await h.load(withNormalGraphicsFrame(HEAVY_STYLE));
    const setDefaults = await h.host.document.mutate({
      op: "setDocumentDefaults",
      args: { fillColor: null, strokeColor: "Color/Black", strokeWeight: 2 },
    });
    expect(setDefaults.applied).toBe(true);
    const expected: Paint = { fill: null, stroke: "Color/Black", weight: 2 };
    expect((await drawn(h, createCurvatureHandler, curvature(page!))).paint).toEqual(expected);
    expect((await drawn(h, createPencilHandler, pencil(page!, false))).paint).toEqual(expected);
  });

  it("left alone: a Paintbrush stroke is already a visible, filled shape in a File ▸ New document", async () => {
    const [page] = await h.newBlank(612, 792);
    const sweep = await drawn(h, createPaintbrushHandler, paintbrush(page!));
    expect(sweep.paint.fill).toBe("Color/Black");
    expect(sweep.undoSteps).toBe(1);
  });
});
