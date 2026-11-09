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

// Extensions ADR 1103 — the host's Selection tool routes a press on a
// bundle's handle (`OverlayHandleSet.onHostDrag`) to the bundle: the
// selected frame under the handle does not move, no marquee is drawn, the
// bundle hears start / moves / one end in page space, and its one write
// is one undo step. Driven through the DOM backend on a mounted canvas
// over the real engine, with a real bundle host on the editor's handle.

import { act } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import type {
  OverlayHandleDrag,
  PluginManifest,
} from "@paged-media/plugin-api";
import { createBundleHost, silentConsole } from "@paged-media/plugin-sdk";
import {
  covers,
  gestureFixture,
  GESTURE_TARGETS as T,
} from "@paged-media/test-kit";
import { dumpDiff } from "@paged-media/test-kit/headless";

import { mountCanvas, type MountedCanvas } from "./canvas-dom";

let c: MountedCanvas | null = null;
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  c?.dispose();
  c = null;
});

const MANIFEST: PluginManifest = {
  id: "media.paged.test.handles",
  name: "handles",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: {
    rendering: ["overlay"],
    document: { read: "broad", write: "broad" },
  },
};

/** The handle: on the frame's body (box 100,72 – 172,216), away from
 *  the point a click selects the frame at. Without the route a press
 *  here moves the selected frame. */
const HANDLE: [number, number] = [100, 130];

const on = (at: readonly [number, number]) => ({
  page: 0,
  at: [at[0], at[1]] as [number, number],
});

async function setup() {
  const m = (c = await mountCanvas(gestureFixture("targets")));
  const bundle = createBundleHost(() => m.state.paged, MANIFEST, {
    console: silentConsole,
    capabilityMode: "enforce",
  });
  disposers.push(() => bundle.dispose());
  const host = bundle.host;
  const pageId = m.state.handle!.pageIds[0]!;
  const set = host.overlay.handles("adjust");
  set.set({ pageId }, [{ id: "a0", at: HANDLE, kind: "round" }]);
  const seen: string[] = [];
  let end: OverlayHandleDrag | null = null;
  set.onHostDrag({
    onStart: (d) => void seen.push(`start ${d.id}`),
    onMove: () => void seen.push("move"),
    onEnd: (d) => {
      end = d;
      seen.push("end");
      void host.document.mutate({
        op: "createSwatch",
        args: {
          spec: {
            name: "Dragged",
            space: "CMYK",
            value: [Math.round(d.pagePoint[0] - d.startPoint[0]), 0, 0, 0],
            model: "Process",
          },
        },
      } as never);
    },
    onCancel: () => void seen.push("cancel"),
  });
  return { m, host, seen, end: () => end };
}

describe("Selection tool: a bundle's handle (overlay.handles.hostDrag@1)", () => {
  test("the bundle's handle takes the drag: the frame stays, one end, one undo step", async () => {
    covers("tool:paged.tool.select");
    const { m, host, seen, end } = await setup();
    expect(host.supports("overlay.handles.hostDrag@1")).toBe(true);
    await m.g.tool("paged.tool.select").click(on(T.frame.at)).settle();
    expect(m.state.elementSelection).toEqual([T.frame.id]);
    const before = await m.dump();
    const box = await m.bounds(T.frame.id);
    await m.g
      .drag({ from: on(HANDLE), to: on([HANDLE[0] + 30, HANDLE[1] + 5]) })
      .settle();
    expect(seen[0]).toBe("start a0");
    expect(seen.filter((s) => s === "end")).toHaveLength(1);
    expect(seen).not.toContain("cancel");
    expect(end()!.pagePoint[0] - end()!.startPoint[0]).toBeCloseTo(30, 0);
    // The host did nothing of its own: no move, the selection kept.
    expect(await m.bounds(T.frame.id)).toEqual(box);
    expect(m.state.elementSelection).toEqual([T.frame.id]);
    // The bundle's one write landed.
    const swatches = async () =>
      (await host.document.collection<{ name?: string }>("swatches")).map(
        (x) => x.name,
      );
    expect(await swatches()).toContain("Dragged");
    await act(async () => {
      await m.client.undo();
    });
    await m.settle();
    expect(await swatches()).not.toContain("Dragged");
    expect(dumpDiff(before, await m.dump())).toEqual([]);
  });

  test("Escape mid-drag cancels it: the bundle writes nothing", async () => {
    covers("tool:paged.tool.select");
    const { m, seen } = await setup();
    await m.g.tool("paged.tool.select").click(on(T.frame.at)).settle();
    const before = await m.dump();
    await m.g
      .drag({
        from: on(HANDLE),
        to: on([HANDLE[0] + 30, HANDLE[1]]),
        release: false,
      })
      .cancel()
      .up(on([HANDLE[0] + 30, HANDLE[1]]))
      .settle();
    expect(seen).toContain("cancel");
    expect(seen).not.toContain("end");
    expect(dumpDiff(before, await m.dump())).toEqual([]);
  });

  test("a press beside the handle is the host's: the selected frame moves", async () => {
    covers("tool:paged.tool.select");
    const { m, seen } = await setup();
    await m.g.tool("paged.tool.select").click(on(T.frame.at)).settle();
    const [top, left] = await m.bounds(T.frame.id);
    const from: [number, number] = [T.frame.at[0], T.frame.at[1]];
    await m.g
      .drag({ from: on(from), to: on([from[0] + 20, from[1]]) })
      .settle();
    expect(seen).toEqual([]);
    const [top2, left2] = await m.bounds(T.frame.id);
    expect([top2, left2]).toEqual([top, left + 20]);
  });
});
