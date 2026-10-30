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

// Editor ADR 310 — the live-shape widgets over the real engine (engine
// ADR 10XX): which widgets a selected shape shows and where, and the ONE
// mutation a drag or an Alt-click commits, read back from the model.
// The overlay is mounted at camera scale 1 with the page at the origin,
// so a client pixel is a page point.

import { afterEach, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";

import { useDocument } from "@paged-media/shell";
import type { ElementId, Mutation } from "@paged-media/client";

import { liveShapeHandlesContribution } from "../../src/overlays/live-shape-handles";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

function Overlay(): ReactElement {
  const Render = liveShapeHandlesContribution.render;
  const { handle } = useDocument();
  const pageRects = new Map(
    (handle?.pageIds ?? []).map((id) => [id, { x: 0, y: 0, w: 612, h: 792 }]),
  );
  return (
    <svg>
      <Render
        paged={null}
        camera={{ scale: 1, tx: 0, ty: 0 }}
        pageRects={pageRects as never}
      />
    </svg>
  );
}

type H = PanelHarness<unknown>;

const mount = () =>
  mountPanel(Overlay, { id: "paged.object-transform", document: "blank" });

async function created(h: H, mutation: unknown): Promise<ElementId> {
  const reply = await h.mutate(mutation as Mutation);
  return (reply as { payload: { createdId: ElementId } }).payload.createdId;
}

const widget = (h: H, id: string) =>
  h.root.querySelector<SVGGElement>(`[data-live-handle="${id}"]`);

/** The page point a widget sits at (its `translate`). */
function at(h: H, id: string): [number, number] {
  const t = widget(h, id)!.getAttribute("transform")!;
  const m = /translate\(([-\d.e]+) ([-\d.e]+)\)/.exec(t)!;
  return [Number(m[1]), Number(m[2])];
}

/** Press a widget, move the pointer to each point, release at the last. */
async function drag(
  h: H,
  id: string,
  to: [number, number][],
  mods: { shiftKey?: boolean; altKey?: boolean } = {},
) {
  const [x, y] = at(h, id);
  const hit = widget(h, id)!.querySelector("circle")!;
  await h.act(() => {
    hit.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: x,
        clientY: y,
        ...mods,
      }),
    );
  });
  for (const [cx, cy] of to) {
    await h.act(() => {
      window.dispatchEvent(
        new PointerEvent("pointermove", { clientX: cx, clientY: cy, ...mods }),
      );
    });
  }
  const [lx, ly] = to.at(-1) ?? [x, y];
  await h.act(() => {
    window.dispatchEvent(
      new PointerEvent("pointerup", { clientX: lx, clientY: ly, ...mods }),
    );
  });
  await h.settle();
  await h.settle();
}

const value = (v: unknown) => (v as { value: unknown } | null)?.value;

describe("live-shape widgets", () => {
  test("an oval: two pie widgets at three o'clock; dragging the end one cuts a pie in one step", async () => {
    const h = await mount();
    const page = h.handle!.pageIds[0];
    const oval = await created(h, {
      op: "insertOval",
      args: { pageId: page, bounds: [100, 100, 200, 300] },
    });
    await h.select([oval]);
    await h.settle();
    expect(
      h.root
        .querySelector("[data-live-shape-kind]")
        ?.getAttribute("data-live-shape-kind"),
    ).toBe("oval");
    expect(at(h, "pie-start")).toEqual([300, 150]);
    expect(at(h, "pie-end")).toEqual([300, 150]);
    const mark = h.mark();
    // Up to twelve o'clock: the end angle is 90°.
    await drag(h, "pie-end", [
      [290, 120],
      [200, 100],
    ]);
    expect(h.mutations(mark)).toEqual([
      {
        op: "setElementProperty",
        args: {
          elementId: oval,
          path: "frameShapePieEnd",
          value: { type: "length", value: 90 },
        },
      },
    ]);
    const props = await h.props(oval);
    expect(value(props.frameShapePieEnd)).toBe(90);
    expect(at(h, "pie-end")).toEqual([200, 100]);
  });

  test("a rectangle: four corner widgets; a drag rounds all four, Shift one, Alt-click cycles one corner's type", async () => {
    const h = await mount();
    const page = h.handle!.pageIds[0];
    const rect = await created(h, {
      op: "insertFrame",
      args: { pageId: page, bounds: [100, 100, 300, 400] },
    });
    await h.select([rect]);
    await h.settle();
    expect(
      h.root
        .querySelector("[data-live-shape-handles]")!
        .getAttribute("data-count"),
    ).toBe("4");
    // Square corners: each widget sits the minimum 14 px in.
    expect(at(h, "corner-0")).toEqual([114, 114]);
    const mark = h.mark();
    await drag(h, "corner-0", [
      [118, 118],
      [130, 130],
    ]);
    const [m] = h.mutations(mark) as Array<{
      op: string;
      args: { ops: Array<{ args: { path: string; value: unknown } }> };
    }>;
    expect(m!.op).toBe("batch");
    expect(m!.args.ops.map((o) => [o.args.path, value(o.args.value)])).toEqual([
      ["frameCornerRadiusTopLeft", 30],
      ["frameCornerOptionTopLeft", "RoundedCorner"],
      ["frameCornerRadiusTopRight", 30],
      ["frameCornerOptionTopRight", "RoundedCorner"],
      ["frameCornerRadiusBottomRight", 30],
      ["frameCornerOptionBottomRight", "RoundedCorner"],
      ["frameCornerRadiusBottomLeft", 30],
      ["frameCornerOptionBottomLeft", "RoundedCorner"],
    ]);
    let props = await h.props(rect);
    expect(value(props.frameCornerRadiusBottomRight)).toBe(30);
    expect(value(props.frameCornerOptionBottomLeft)).toBe("RoundedCorner");
    expect(at(h, "corner-2")).toEqual([370, 270]);

    // Shift: this corner only.
    const shift = h.mark();
    await drag(h, "corner-2", [[350, 250]], { shiftKey: true });
    const [one] = h.mutations(shift) as Array<{
      args: { ops: Array<{ args: { path: string } }> };
    }>;
    expect(one!.args.ops.map((o) => o.args.path)).toEqual([
      "frameCornerRadiusBottomRight",
    ]);
    props = await h.props(rect);
    expect(value(props.frameCornerRadiusBottomRight)).toBe(50);
    expect(value(props.frameCornerRadiusTopLeft)).toBe(30);

    // Alt-click: the next type, on this corner.
    const alt = h.mark();
    await drag(h, "corner-1", [], { altKey: true });
    expect(h.mutations(alt)).toEqual([
      {
        op: "setElementProperty",
        args: {
          elementId: rect,
          path: "frameCornerOptionTopRight",
          value: { type: "text", value: "InverseRoundedCorner" },
        },
      },
    ]);
  });

  test("a live polygon: the side widget adds a side per 12 px up, the star widget sets the inset", async () => {
    const h = await mount();
    const page = h.handle!.pageIds[0];
    // The Polygon tool's own insert: a pentagon inscribed in 100..300,
    // then its sides.
    const pts = Array.from({ length: 5 }, (_, i) => {
      const t = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
      const p = [200 + 100 * Math.cos(t), 200 + 100 * Math.sin(t)];
      return { anchor: p, left: p, right: p };
    });
    const reply = await h.mutate({
      op: "batch",
      args: {
        ops: [
          {
            op: "insertPath",
            args: { pageId: page, anchors: pts, open: false, smooth: false },
          },
          {
            op: "setElementProperty",
            args: {
              elementId: { kind: "polygon", id: "$created" },
              path: "frameShapeSides",
              value: { type: "length", value: 5 },
            },
          },
        ],
      },
    } as never);
    const poly = (reply as { payload: { createdId: ElementId } }).payload
      .createdId;
    await h.select([poly]);
    await h.settle();
    expect(widget(h, "sides")).not.toBeNull();
    expect(widget(h, "inset")).not.toBeNull();
    const [sx, sy] = at(h, "sides");
    const mark = h.mark();
    await drag(h, "sides", [
      [sx, sy - 10],
      [sx, sy - 25],
    ]);
    expect(h.mutations(mark)).toEqual([
      {
        op: "setElementProperty",
        args: {
          elementId: poly,
          path: "frameShapeSides",
          value: { type: "length", value: 7 },
        },
      },
    ]);
    expect(value((await h.props(poly)).frameShapeSides)).toBe(7);

    // The star widget: drag it to 60 % of the outer radius (the circle
    // is kept: centre 200, 200, radius 100).
    const t = -Math.PI / 2 + Math.PI / 7;
    const insetMark = h.mark();
    await drag(h, "inset", [
      [200 + 80 * Math.cos(t), 200 + 80 * Math.sin(t)],
      [200 + 60 * Math.cos(t), 200 + 60 * Math.sin(t)],
    ]);
    const [m] = h.mutations(insetMark) as Array<{
      args: { path: string; value: { value: number } };
    }>;
    expect(m!.args.path).toBe("frameShapeStarInset");
    expect(m!.args.value.value).toBeCloseTo(40, 0);
    const props = await h.props(poly);
    expect(value(props.frameShapeStarInset)).toBeCloseTo(40, 0);
  });

  test("a plain path has no widgets", async () => {
    const h = await mount();
    const page = h.handle!.pageIds[0];
    const p = (x: number, y: number) => ({
      anchor: [x, y],
      left: [x, y],
      right: [x, y],
    });
    const path = await created(h, {
      op: "insertPath",
      args: {
        pageId: page,
        anchors: [p(10, 10), p(90, 30), p(50, 90)],
        open: false,
        smooth: false,
      },
    });
    await h.select([path]);
    await h.settle();
    expect(
      h.root
        .querySelector("[data-live-shape-handles]")!
        .getAttribute("data-count"),
    ).toBe("0");
  });
});
