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

// ON-CANVAS GRADIENT STOPS through the REAL engine wasm. Pins:
//   (1) the annotator draws the axis AND a marker per stop, each at its
//       location along the line, in ONE multi-shape publish;
//   (2) a drag on a marker moves THAT stop — read back from the engine's
//       own gradient detail — and leaves every other stop and midpoint
//       as it was: ONE `editGradient`, ONE undo step;
//   (3) the stop is clamped between its neighbours; Escape writes
//       nothing; a press off the markers is still the axis drag;
//   (4) a gradient is a SWATCH: a second object filled with it changes
//       too, and the commit says so;
//   (5) a host without the raw hatch shows the bare axis, as before.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  BundleHost,
  ElementId,
  Mutation,
  ToolPreviewPolyline,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  createGradientAnnotatorHandler,
  drawBundle,
  gradientAxisMutationFor,
  gradientSpecWithStop,
  rawGradientDetail,
  type GradientDetailWire,
} from "../../src";
import { packageWithSpread } from "../fixtures/build-idml";
import { rectItem, PAGE_ID } from "../panels/panel-document";
import { countingHost } from "../perf/counting-host";
import { pointerAt, settle } from "../perf/pointer-stream";
import { openHost } from "./host";

// RECTANGLES: the frame kind the gradient axis properties are stored on
// (the annotator's own spec measures them there).
const SQ = { kind: "rectangle", id: "gsq" } as ElementId;
const TWIN = { kind: "rectangle", id: "gtwin" } as ElementId;
const GRAD = "Gradient/ustops";

/** A three-stop ramp (black 0 → grey 50, midpoint 30 → white 100) on
 *  both squares; the axis 0° and 100 pt from sq's centre (150, 150). */
async function seed(h: HeadlessHost): Promise<void> {
  const ops: Mutation[] = [
    { op: "createSwatch", args: { spec: { selfId: "Color/us0", name: "s0", space: "RGB", value: [0, 0, 0] } } },
    { op: "createSwatch", args: { spec: { selfId: "Color/us1", name: "s1", space: "RGB", value: [128, 128, 128] } } },
    { op: "createSwatch", args: { spec: { selfId: "Color/us2", name: "s2", space: "RGB", value: [255, 255, 255] } } },
    {
      op: "createGradient",
      args: {
        spec: {
          selfId: GRAD,
          name: "Stops",
          kind: "Linear",
          stops: [
            { stopColor: "Color/us0", locationPct: 0 },
            { stopColor: "Color/us1", locationPct: 50, midpointPct: 30 },
            { stopColor: "Color/us2", locationPct: 100 },
          ],
        },
      },
    },
    ...[SQ, TWIN].map(
      (elementId): Mutation => ({
        op: "setElementProperty",
        args: { elementId, path: "frameFillColor", value: { type: "colorRef", value: GRAD } },
      }),
    ),
    gradientAxisMutationFor([SQ], 0, 100),
  ];
  for (const m of ops) {
    const out = await h.host.document.mutate(m);
    if (!out.applied) throw new Error(`seed refused at ${m.op}: ${JSON.stringify(out.error)}`);
  }
}

const locationsOf = async (host: BundleHost): Promise<number[]> =>
  ((await rawGradientDetail(host, GRAD))?.stops ?? []).map((s) => s.locationPct);

describe("draw conformance — on-canvas gradient stops", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());
  beforeEach(async () => {
    await h.load(packageWithSpread(rectItem("gsq", 100, 100, 100) + rectItem("gtwin", 300, 100, 60)));
    await seed(h);
    await h.host.selection.set([SQ]);
  });

  it("the pure half: a moved stop keeps every other stop, colour and midpoint; an unknown kind is not guessed", () => {
    const detail: GradientDetailWire = {
      selfId: GRAD,
      name: "Stops",
      kind: "radial",
      stops: [
        { stopColorRef: "Color/a", resolvedRgbHex: "#000000", locationPct: 0, midpointPct: null },
        { stopColorRef: "Color/b", resolvedRgbHex: "#ffffff", locationPct: 100, midpointPct: 40 },
      ],
    };
    expect(gradientSpecWithStop(detail, 0, 12.5)).toEqual({
      selfId: GRAD,
      name: "Stops",
      kind: "Radial",
      stops: [
        { stopColor: "Color/a", locationPct: 12.5 },
        { stopColor: "Color/b", locationPct: 100, midpointPct: 40 },
      ],
    });
    expect(gradientSpecWithStop({ ...detail, kind: "unknown" }, 0, 10)).toBeNull();
    expect(gradientSpecWithStop(detail, 5, 10)).toBeNull();
  });

  it("draws the axis AND a marker at every stop, in one multi-shape publish", async () => {
    const handler = createGradientAnnotatorHandler(h.host);
    handler.onActivate(undefined as never);
    await settle();
    const shapes = h.lastToolPreviews() as ToolPreviewPolyline[];
    expect(shapes).toHaveLength(4);
    expect(shapes[0]!.points).toEqual([
      [150, 150],
      [250, 150],
    ]);
    const centres = shapes.slice(1).map((m) => {
      const xs = m.points.map((p) => p[0]);
      return [(Math.min(...xs) + Math.max(...xs)) / 2, m.points[0]![1] + (m.points[2]![1] - m.points[0]![1]) / 2];
    });
    expect(centres).toEqual([
      [150, 150],
      [200, 150],
      [250, 150],
    ]);
    expect(shapes.slice(1).every((m) => m.close === true)).toBe(true);
    handler.onDeactivate("switch" as never);
  });

  it("a drag on a marker moves THAT stop — ONE editGradient, ONE undo step; the rest untouched", async () => {
    const { host, work } = countingHost(h.host);
    let applied: boolean | null = null;
    const handler = createGradientAnnotatorHandler(host, { onStopCommit: (a) => (applied = a) });
    handler.onActivate(undefined as never);
    await settle();
    work.reset();
    handler.onPointerDown(pointerAt(PAGE_ID, [201, 151]));
    handler.onPointerMove(pointerAt(PAGE_ID, [215, 170]));
    handler.onPointerUp(pointerAt(PAGE_ID, [230, 160]));
    await settle();
    expect(applied).toBe(true);
    expect(work.mutations).toEqual([{ op: "editGradient", ops: 1 }]);
    const detail = (await rawGradientDetail(h.host, GRAD))!;
    expect(detail.stops.map((s) => s.locationPct)).toEqual([0, 80, 100]);
    expect(detail.stops.map((s) => s.stopColorRef)).toEqual(["Color/us0", "Color/us1", "Color/us2"]);
    expect(detail.stops[1]!.midpointPct).toBe(30);
    // The markers follow what was written.
    const shapes = h.lastToolPreviews() as ToolPreviewPolyline[];
    expect(shapes[2]!.points[0]![0]).toBeCloseTo(230, 6);
    await h.host.document.undo();
    expect(await locationsOf(h.host)).toEqual([0, 50, 100]);
    handler.onDeactivate("switch" as never);
  });

  it("a stop is CLAMPED between its neighbours; Escape writes nothing", async () => {
    const handler = createGradientAnnotatorHandler(h.host);
    handler.onActivate(undefined as never);
    await settle();
    handler.onPointerDown(pointerAt(PAGE_ID, [150, 150]));
    handler.onPointerUp(pointerAt(PAGE_ID, [400, 150]));
    await settle();
    // The FIRST stop cannot pass the second (at 50).
    expect(await locationsOf(h.host)).toEqual([50, 50, 100]);
    await h.host.document.undo();

    const { host, work } = countingHost(h.host);
    const again = createGradientAnnotatorHandler(host);
    again.onActivate(undefined as never);
    await settle();
    work.reset();
    again.onPointerDown(pointerAt(PAGE_ID, [200, 150]));
    again.onPointerMove(pointerAt(PAGE_ID, [240, 150]));
    again.onKey!({ key: "Escape" } as KeyboardEvent);
    again.onPointerUp(pointerAt(PAGE_ID, [240, 150]));
    await settle();
    expect(work.mutations).toEqual([]);
    expect(await locationsOf(h.host)).toEqual([0, 50, 100]);
    handler.onDeactivate("switch" as never);
    again.onDeactivate("switch" as never);
  });

  it("a press OFF the markers is still the axis drag (angle + length, one batch)", async () => {
    const { host, work } = countingHost(h.host);
    const handler = createGradientAnnotatorHandler(host);
    handler.onActivate(undefined as never);
    await settle();
    work.reset();
    handler.onPointerDown(pointerAt(PAGE_ID, [120, 120]));
    handler.onPointerUp(pointerAt(PAGE_ID, [120, 180]));
    await settle();
    expect(work.mutations).toEqual([{ op: "batch", ops: 2 }]);
    expect(await locationsOf(h.host)).toEqual([0, 50, 100]);
    handler.onDeactivate("switch" as never);
  });

  it("a gradient is a SWATCH: the stop moves for every object filled with it, and the commit says so", async () => {
    const infos: string[] = [];
    const host = new Proxy(h.host, {
      get(target, prop, receiver) {
        if (prop === "log") return { ...target.log, info: (m: string) => void infos.push(m) };
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as BundleHost;
    const handler = createGradientAnnotatorHandler(host);
    handler.onActivate(undefined as never);
    await settle();
    handler.onPointerDown(pointerAt(PAGE_ID, [200, 150]));
    handler.onPointerUp(pointerAt(PAGE_ID, [180, 150]));
    await settle();
    const fillOf = async (id: ElementId) =>
      (await h.host.document.elementProperties(id))?.entries.find((e) => e.path === "frameFillColor")
        ?.value?.value;
    expect(await fillOf(SQ)).toBe(GRAD);
    expect(await fillOf(TWIN)).toBe(GRAD);
    expect(await locationsOf(h.host)).toEqual([0, 30, 100]);
    expect(infos.join("\n")).toContain("every object filled with it changes");
    handler.onDeactivate("switch" as never);
  });

  it("a host WITHOUT the raw hatch shows the bare axis and grabs no stop", async () => {
    const bare = new Proxy(h.host, {
      get(target, prop, receiver) {
        if (prop === "editor") return {};
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as BundleHost;
    const { host, work } = countingHost(bare);
    const handler = createGradientAnnotatorHandler(host);
    handler.onActivate(undefined as never);
    await settle();
    expect(h.lastToolPreviews()).toHaveLength(1);
    work.reset();
    // A "drag" from where the middle marker would be is the AXIS drag.
    handler.onPointerDown(pointerAt(PAGE_ID, [200, 150]));
    handler.onPointerUp(pointerAt(PAGE_ID, [200, 190]));
    await settle();
    expect(work.mutations).toEqual([{ op: "batch", ops: 2 }]);
    expect(await locationsOf(h.host)).toEqual([0, 50, 100]);
    handler.onDeactivate("switch" as never);
  });
});
