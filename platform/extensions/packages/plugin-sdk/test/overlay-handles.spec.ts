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

// Extensions ADR 339 — `host.overlay.handles` (overlay.handles@1) and
// `host.transformBox` (host.transformBox@1) through the real adapter:
//   1. a handle set draws the handle primitive on its own layer and
//      answers hits in screen px (the fake camera is at 2×);
//   2. the bundle's tools receive `hitHandle` and the handle's cursor;
//   3. frame-content positions follow the frame's geometry;
//   4. the transform box takes the pointer of the bundle's tools first,
//      reports a projective matrix per move, commits on Enter and
//      cancels on Escape, and lets presses outside it through;
//   5. the flags are dynamic (the layer sink), and the overlay gate holds.

import { describe, expect, it } from "bun:test";

import type {
  CanvasPointerEvent,
  GestureHandler,
  PluginManifest,
  TransformBoxUpdate,
} from "@paged-media/plugin-api";

import { applyMatrix3, createBundleHost, isAffine3 } from "../src";
import { makeFakeEditor } from "./fake-editor";

import { silentConsole as silent } from "../src/testing";

const manifest = (
  capabilities: PluginManifest["capabilities"] = { rendering: ["overlay"] },
): PluginManifest => ({
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities,
  contributes: { tools: ["media.paged.test.tool"] },
});

function makeHost(overlayLayers = true, caps?: PluginManifest["capabilities"]) {
  const fake = makeFakeEditor({ overlayLayers, multiPreview: true });
  const handle = createBundleHost(() => fake.editor, manifest(caps), {
    console: silent,
    capabilityMode: "enforce",
  });
  return { ...handle, fake };
}

const ev = (
  pagePoint: [number, number],
  mods: Partial<CanvasPointerEvent["modifiers"]> = {},
): CanvasPointerEvent => ({
  pageId: "p1",
  pagePoint,
  docPoint: pagePoint,
  modifiers: { shift: false, alt: false, cmd: false, ctrl: false, ...mods },
  maxDelta: 10,
  button: 0,
  target: null,
  pressure: 0.5,
  tiltX: 0,
  tiltY: 0,
  pointerType: "mouse",
});

/** Register a recording tool and return its WRAPPED handler. */
function recordingTool(h: ReturnType<typeof makeHost>) {
  const seen: { phase: string; e: CanvasPointerEvent }[] = [];
  const keys: string[] = [];
  const inner: GestureHandler = {
    onActivate() {},
    onDeactivate() {},
    onPointerDown: (e) => void seen.push({ phase: "down", e }),
    onPointerMove: (e) => void seen.push({ phase: "move", e }),
    onPointerUp: (e) => void seen.push({ phase: "up", e }),
    onKey: (e) => void keys.push(e.key),
  };
  h.host.contribute.tool({
    id: "media.paged.test.tool",
    title: "T",
    icon: "x",
    group: "g",
    section: "drawType",
    gesture: () => inner,
  });
  const reg = h.fake.tools.get("media.paged.test.tool") as {
    gesture: () => GestureHandler;
  };
  return { handler: reg.gesture(), seen, keys };
}

const key = (k: string) => ({ key: k }) as KeyboardEvent;

describe("host.overlay.handles (overlay.handles@1) [editor-tools.free-transform]", () => {
  it("draws the handle primitive on its own layer; rotate zones draw nothing", () => {
    const h = makeHost();
    const set = h.host.overlay.handles("crop");
    set.set({ pageId: "p1" }, [
      { id: "nw", at: [10, 10], kind: "square" },
      { id: "spin", at: [0, 0], kind: "rotateZone" },
      { id: "c", at: [50, 50], kind: "centre", active: true },
    ]);
    expect(h.fake.getOverlayLayers()).toEqual([
      {
        key: "media.paged.test/handles:crop",
        shapes: [
          { kind: "handle", pageId: "p1", x: 10, y: 10, shape: "square" },
          {
            kind: "handle",
            pageId: "p1",
            x: 50,
            y: 50,
            shape: "centre",
            active: true,
          },
        ],
      },
    ]);
  });

  it("answers hits in screen px (camera 2× → a 6 px handle is 3 pt)", () => {
    const h = makeHost();
    const set = h.host.overlay.handles("crop");
    set.set({ pageId: "p1" }, [
      { id: "nw", at: [10, 10], kind: "square" },
      { id: "spin", at: [10, 10], kind: "rotateZone" },
    ]);
    expect(set.hitTest("p1", [12.5, 12.5])).toBe("nw");
    // Outside the square but inside the 28 px (14 pt) rotate zone.
    expect(set.hitTest("p1", [20, 10])).toBe("spin");
    expect(set.hitTest("p1", [40, 10])).toBeNull();
    expect(set.hitTest("p2", [10, 10])).toBeNull();
  });

  it("stamps hitHandle on the bundle's tool events and offers the cursor", () => {
    const h = makeHost();
    const set = h.host.overlay.handles("crop");
    set.set({ pageId: "p1" }, [
      {
        id: "nw",
        at: [10, 10],
        kind: "square",
        cursor: { kind: "css", token: "nwse-resize" },
      },
    ]);
    const { handler, seen } = recordingTool(h);
    handler.onPointerDown(ev([11, 11]));
    handler.onPointerMove(ev([90, 90]));
    expect(seen[0]!.e.hitHandle).toEqual({ set: "crop", id: "nw" });
    expect(seen[1]!.e.hitHandle).toBeUndefined();
    expect(handler.cursorAt!(ev([10, 10]))).toEqual({
      kind: "css",
      token: "nwse-resize",
    });
    expect(handler.cursorAt!(ev([90, 90]))).toBeUndefined();
  });

  it("frame-content positions follow the frame's geometry", async () => {
    const h = makeHost();
    h.fake.setElementGeometryReply(() => [
      {
        id: { kind: "rectangle", id: "r1" },
        pageId: "p1",
        bounds: [100, 50, 200, 150],
        // Moved by (10, 20).
        itemTransform: [1, 0, 0, 1, 10, 20],
      },
    ]);
    const set = h.host.overlay.handles();
    set.set({ element: { kind: "rectangle", id: "r1" } as never }, [
      { id: "a", at: [5, 5], kind: "round" },
    ]);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.fake.getOverlayLayers()[0]!.shapes).toEqual([
      { kind: "handle", pageId: "p1", x: 65, y: 125, shape: "round" },
    ]);
    expect(set.hitTest("p1", [65, 125])).toBe("a");
  });

  it("dispose drops the set; a live duplicate id throws", () => {
    const h = makeHost();
    const set = h.host.overlay.handles("x");
    expect(() => h.host.overlay.handles("x")).toThrow(/already live/);
    set.dispose();
    expect(h.fake.getOverlayLayers()).toEqual([]);
    expect(set.hitTest("p1", [0, 0])).toBeNull();
  });

  it("is dynamic and gated", () => {
    expect(makeHost(true).host.supports("overlay.handles@1")).toBe(true);
    expect(makeHost(false).host.supports("overlay.handles@1")).toBe(false);
    // No sink: still hits, draws nothing.
    const bare = makeHost(false);
    const set = bare.host.overlay.handles();
    set.set({ pageId: "p1" }, [{ id: "a", at: [0, 0], kind: "square" }]);
    expect(set.hitTest("p1", [0, 0])).toBe("a");
    expect(() => makeHost(true, {}).host.overlay.handles()).toThrow();
  });
});

describe("host.transformBox (host.transformBox@1) [editor-tools.free-transform]", () => {
  const quad: [number, number][] = [
    [100, 100],
    [300, 100],
    [300, 200],
    [100, 200],
  ];
  const open = (h: ReturnType<typeof makeHost>) => {
    const changes: TransformBoxUpdate[] = [];
    const commits: TransformBoxUpdate[] = [];
    let cancelled = 0;
    const session = h.host.transformBox.open({
      pageId: "p1",
      quad: quad as never,
      onChange: (u) => void changes.push(u),
      onCommit: (u) => void commits.push(u),
      onCancel: () => void cancelled++,
    });
    return { session, changes, commits, cancelled: () => cancelled };
  };

  it("draws the box: outline, eight handles and the reference point", () => {
    const h = makeHost();
    open(h);
    const layer = h.fake
      .getOverlayLayers()
      .find((l) => l.key === "media.paged.test/transformBox")!;
    const shapes = layer.shapes as { kind?: string; shape?: string }[];
    expect(shapes.filter((s) => s.shape === "square")).toHaveLength(8);
    expect(shapes.filter((s) => s.shape === "centre")).toHaveLength(1);
    expect(shapes.filter((s) => s.kind === undefined)).toHaveLength(1);
  });

  it("takes the bundle tool's drag, reports per move, commits on Enter", () => {
    const h = makeHost();
    const { handler, seen } = recordingTool(h);
    const b = open(h);
    // A corner: scale from the opposite corner.
    handler.onPointerDown(ev([300, 200]));
    handler.onPointerMove(ev([400, 250]));
    handler.onPointerUp(ev([400, 250]));
    expect(seen).toHaveLength(0);
    expect(b.changes.at(-1)!.operation).toBe("scale");
    const [sx, sy] = applyMatrix3(b.changes.at(-1)!.matrix, [300, 200]);
    expect(sx).toBeCloseTo(400);
    expect(sy).toBeCloseTo(250);
    // Cmd on a corner distorts: the matrix turns projective.
    handler.onPointerDown(ev([400, 250], { cmd: true }));
    handler.onPointerMove(ev([420, 300], { cmd: true }));
    handler.onPointerUp(ev([420, 300], { cmd: true }));
    expect(b.changes.at(-1)!.operation).toBe("distort");
    expect(isAffine3(b.changes.at(-1)!.matrix)).toBe(false);
    handler.onKey!(key("Enter"));
    expect(b.commits).toHaveLength(1);
    const m = b.commits[0]!.matrix;
    const [x, y] = applyMatrix3(m, [300, 200]);
    expect(x).toBeCloseTo(420);
    expect(y).toBeCloseTo(300);
    expect(b.session.open).toBe(false);
    expect(h.host.transformBox.active()).toBeNull();
  });

  it("Escape cancels; a press outside reaches the tool", () => {
    const h = makeHost();
    const { handler, seen, keys } = recordingTool(h);
    const b = open(h);
    handler.onPointerDown(ev([600, 600]));
    expect(seen.map((s) => s.phase)).toEqual(["down"]);
    handler.onKey!(key("Escape"));
    expect(b.cancelled()).toBe(1);
    expect(keys).toEqual([]);
    // Once closed, keys reach the tool again.
    handler.onKey!(key("Escape"));
    expect(keys).toEqual(["Escape"]);
  });

  it("modes: perspective mode makes a plain corner drag a perspective", () => {
    const h = makeHost();
    const { handler } = recordingTool(h);
    const b = open(h);
    b.session.setMode("perspective");
    expect(b.changes.at(-1)!.mode).toBe("perspective");
    handler.onPointerDown(ev([300, 100]));
    handler.onPointerMove(ev([340, 102]));
    handler.onPointerUp(ev([340, 102]));
    const u = b.changes.at(-1)!;
    expect(u.operation).toBe("perspective");
    expect(u.quad[0][0]).toBeCloseTo(60);
    expect(u.quad[0][1]).toBeCloseTo(100);
  });

  it("rotating outside a corner turns about the reference point", () => {
    const h = makeHost();
    const { handler } = recordingTool(h);
    const b = open(h);
    // 2× camera: the 28 px rotate zone is 14 pt; (308, 208) is in it.
    handler.onPointerDown(ev([308, 208]));
    handler.onPointerMove(ev([200 - 58, 150 + 108]));
    handler.onPointerUp(ev([200 - 58, 150 + 108]));
    expect(b.changes.at(-1)!.operation).toBe("rotate");
    expect(b.changes.at(-1)!.reference).toEqual([200, 150]);
  });

  it("a second open cancels the first; disposing the bundle cancels", () => {
    const h = makeHost();
    const a = open(h);
    const b = open(h);
    expect(a.cancelled()).toBe(1);
    h.dispose();
    expect(b.cancelled()).toBe(1);
  });

  it("is dynamic and gated", () => {
    expect(makeHost(true).host.supports("host.transformBox@1")).toBe(true);
    expect(makeHost(false).host.supports("host.transformBox@1")).toBe(false);
    expect(() =>
      makeHost(true, {}).host.transformBox.open({
        pageId: "p1",
        quad: quad as never,
        onCommit() {},
      }),
    ).toThrow();
  });
});

describe("host.transformBox — tool and edit context [editor-tools.free-transform]", () => {
  const quad = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ] as never;

  it("toolId makes the bundle's tool the one in hand", () => {
    const h = makeHost();
    const set: string[] = [];
    (h.fake.editor as unknown as { tool: unknown }).tool = {
      setBaseTool: (id: string) => void set.push(id),
    };
    h.host.transformBox.open({
      pageId: "p1",
      quad,
      toolId: "media.paged.test.tool",
      onCommit() {},
    });
    expect(set).toEqual(["media.paged.test.tool"]);
  });

  it("an open box makes the bundle's edit context dirty, so Esc and Enter reach the box", () => {
    const fake = makeFakeEditor({ overlayLayers: true });
    const { host } = createBundleHost(
      () => fake.editor,
      {
        ...manifest(),
        contributes: {
          tools: ["media.paged.test.tool"],
          editContexts: [{ type: "testContext" }],
        },
      } as PluginManifest,
      { console: silent, capabilityMode: "enforce" },
    );
    host.contribute.editContext({ type: "testContext", entry: "doubleClick" });
    const ctx = fake.editContexts.get("testContext") as { isDirty(): boolean };
    expect(ctx.isDirty()).toBe(false);
    const box = host.transformBox.open({ pageId: "p1", quad, onCommit() {} });
    expect(ctx.isDirty()).toBe(true);
    box.cancel();
    expect(ctx.isDirty()).toBe(false);
  });
});
