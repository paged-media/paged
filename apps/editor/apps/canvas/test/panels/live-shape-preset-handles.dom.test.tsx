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

// Engine ADR 1096 — an Office preset's adjust handles in the host's
// live-shape overlay, over the real engine: a path given a preset shows
// its yellow handles where the engine reads them, and a drag commits ONE
// `frameShapePresetHandle` write, after which the engine has solved the
// adjust value (a rounded rectangle's corner radius follows the handle).

import { afterEach, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";

import { useDocument } from "@paged-media/shell";
import type { ElementId, Mutation } from "@paged-media/client";

import {
  liveShapeHandlesContribution,
  liveShapeStateOf,
  presetHandleMutation,
  presetHandlesOf,
} from "../../src/overlays/live-shape-handles";
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

const widget = (h: H, id: string) =>
  h.root.querySelector<SVGGElement>(`[data-live-handle="${id}"]`);

function at(h: H, id: string): [number, number] {
  const t = widget(h, id)!.getAttribute("transform")!;
  const m = /translate\(([-\d.e]+) ([-\d.e]+)\)/.exec(t)!;
  return [Number(m[1]), Number(m[2])];
}

async function drag(h: H, id: string, to: [number, number]) {
  const [x, y] = at(h, id);
  const hit = widget(h, id)!.querySelector("circle")!;
  await h.act(() => {
    hit.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: x,
        clientY: y,
      }),
    );
  });
  await h.act(() => {
    window.dispatchEvent(
      new PointerEvent("pointermove", { clientX: to[0], clientY: to[1] }),
    );
  });
  await h.act(() => {
    window.dispatchEvent(
      new PointerEvent("pointerup", { clientX: to[0], clientY: to[1] }),
    );
  });
  await h.settle();
  await h.settle();
}

const corner = (x: number, y: number) => ({
  anchor: [x, y],
  left: [x, y],
  right: [x, y],
});

describe("preset adjust handles", () => {
  test("the read and the write the widgets use", () => {
    const text = JSON.stringify({
      name: "roundRect",
      frame: [0, 0, 200, 100],
      handles: [{ x: 16.667, y: 0, polar: false, refs: ["adj"] }],
    });
    expect(presetHandlesOf(text)).toEqual({
      name: "roundRect",
      handles: [{ x: 16.667, y: 0, polar: false }],
    });
    expect(presetHandlesOf("")).toBeNull();
    expect(presetHandlesOf("not json")).toBeNull();
    const item = {
      id: { kind: "polygon", id: "p" },
      pageId: "pg",
      bounds: [0, 0, 100, 200],
      itemTransform: null,
    };
    const s = liveShapeStateOf(
      item as never,
      [
        { path: "frameShapePreset", value: { type: "text", value: text } },
      ] as never,
    )!;
    expect(s.preset?.handles.length).toBe(1);
    expect(presetHandleMutation(s, 0, [10, 0])).toEqual({
      op: "setElementProperty",
      args: {
        elementId: { kind: "polygon", id: "p" },
        path: "frameShapePresetHandle",
        value: {
          type: "pathPoint",
          value: { address: { index: 0, role: "anchor" }, position: [10, 0] },
        },
      },
    });
  });

  test("a rounded rectangle shows its handle and a drag sets its radius in one step", async () => {
    const h = await mount();
    const page = h.handle!.pageIds[0];
    const reply = await h.mutate({
      op: "insertPath",
      args: {
        pageId: page,
        anchors: [
          corner(100, 100),
          corner(300, 100),
          corner(300, 200),
          corner(100, 200),
        ],
        open: false,
        smooth: false,
      },
    } as unknown as Mutation);
    const poly = (reply as { payload: { createdId: ElementId } }).payload
      .createdId;
    await h.mutate({
      op: "setElementProperty",
      args: {
        elementId: poly,
        path: "frameShapePreset",
        value: {
          type: "text",
          value: JSON.stringify({
            name: "roundRect",
            frame: [100, 100, 200, 100],
          }),
        },
      },
    } as unknown as Mutation);
    await h.select([poly]);
    await h.settle();
    expect(widget(h, "preset-0")).not.toBeNull();
    // A sixth of the short side in from the left, on the top edge.
    const [x, y] = at(h, "preset-0");
    expect(Math.abs(x - 116.667)).toBeLessThan(0.01);
    expect(y).toBe(100);
    const mark = h.mark();
    await drag(h, "preset-0", [130, 100]);
    const sent = h.mutations(mark);
    expect(sent.length).toBe(1);
    expect((sent[0] as { args: { path: string } }).args.path).toBe(
      "frameShapePresetHandle",
    );
    // The engine solved it: the handle now sits 30 pt in.
    const [x2] = at(h, "preset-0");
    expect(Math.abs(x2 - 130)).toBeLessThan(0.1);
  });
});
