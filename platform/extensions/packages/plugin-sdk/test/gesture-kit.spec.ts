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

// The public gesture test kit: the recording fake editor, the gesture
// DSL's unit backend, the pointer tape, and the invariants, at the fake
// level and against the real headless engine.

import { afterEach, describe, expect, it } from "bun:test";

import type {
  CanvasPointerEvent,
  ElementId,
  GestureHandler,
  PagedEditor,
  PluginManifest,
  ToolContribution,
} from "@paged-media/plugin-api";

import {
  checkCancel,
  checkUndoRedo,
  createBundleHost,
  createFakeEditor,
  createHeadlessHost,
  engineModelChannel,
  expectNoCommit,
  expectOneCommit,
  expectOneUndoStep,
  gestures,
  InvariantError,
  parseTape,
  serializeTape,
  TapeFormatError,
  unitBackend,
  createGestureDsl,
  validateTape,
  beginPageDrag,
  endLocalFor,
  type HeadlessHost,
  type PageDrag,
} from "../src/index";
import { minimalIdml } from "./fixtures/minimal-idml";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** A handler that records what it is told, as plain data. */
function spyHandler() {
  const calls: Array<{
    on: string;
    e?: Partial<CanvasPointerEvent>;
    key?: string;
    reason?: string;
  }> = [];
  const pick = (e: CanvasPointerEvent) => ({
    pageId: e.pageId,
    pagePoint: e.pagePoint,
    docPoint: e.docPoint,
    maxDelta: Math.round(e.maxDelta * 1000) / 1000,
    modifiers: e.modifiers,
    pointerType: e.pointerType,
    pressure: e.pressure,
  });
  const handler: GestureHandler = {
    onActivate: () => calls.push({ on: "activate" }),
    onDeactivate: (reason) => calls.push({ on: "deactivate", reason }),
    onPointerDown: (e) => calls.push({ on: "down", e: pick(e) }),
    onPointerMove: (e) => calls.push({ on: "move", e: pick(e) }),
    onPointerUp: (e) => calls.push({ on: "up", e: pick(e) }),
    onKey: (e) => calls.push({ on: "key", key: e.key }),
  };
  return { handler, calls };
}

/** The draw-a-frame tool every plugin author writes first: a page-
 *  anchored drag that commits ONE insertFrame (or nothing on Escape). */
function frameTool(): GestureHandler {
  let paged: PagedEditor | null = null;
  let drag: PageDrag | null = null;
  const bounds = (e: CanvasPointerEvent): [number, number, number, number] => {
    const [x0, y0] = drag!.startLocal;
    const [x1, y1] = endLocalFor(drag!, e);
    return [
      Math.min(y0, y1),
      Math.min(x0, x1),
      Math.max(y0, y1),
      Math.max(x0, x1),
    ];
  };
  return {
    onActivate: (p) => (paged = p),
    onDeactivate: () => {
      drag = null;
      paged?.overlaySignals.setToolPreview(null);
    },
    onPointerDown: (e) => (drag = beginPageDrag(e)),
    onPointerMove: (e) => {
      if (!paged || !drag || e.maxDelta <= 4) return;
      paged.overlaySignals.setToolPreview({
        pageId: drag.pageId,
        rect: bounds(e),
      });
    },
    onPointerUp: (e) => {
      if (!paged || !drag) return;
      const b = bounds(e);
      const pageId = drag.pageId;
      drag = null;
      paged.overlaySignals.setToolPreview(null);
      if (b[2] - b[0] < 1 || b[3] - b[1] < 1) return;
      void paged.client.mutate({
        op: "insertFrame",
        args: { pageId, bounds: b },
      });
    },
    onKey: (e) => {
      if (e.key !== "Escape") return;
      drag = null;
      paged?.overlaySignals.setToolPreview(null);
    },
  };
}

const MANIFEST: PluginManifest = {
  id: "media.paged.kit",
  name: "kit",
  version: "1.0.0",
  apiVersion: "^0.2",
  contributes: {
    tools: ["media.paged.kit.tool.frame"],
    commands: ["media.paged.kit.command.hello"],
  },
};

describe("createFakeEditor — the recording fake", () => {
  it("records registry calls made through the real host adapter", async () => {
    const fake = createFakeEditor();
    const { host } = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
    });
    const tool = host.contribute.tool({
      id: "media.paged.kit.tool.frame",
      title: "Frame",
      icon: "tool-rect",
      group: "kit",
      section: "drawType",
      gesture: frameTool,
    } as ToolContribution);
    host.contribute.command({
      id: "media.paged.kit.command.hello",
      title: "Hello",
      handler: () => "hi",
    });
    expect(fake.tools().map((t) => t.id)).toEqual([
      "media.paged.kit.tool.frame",
    ]);
    const regs = fake
      .ofChannel("registry")
      .filter((e) => e.action === "register");
    expect(regs.map((e) => `${e.registry}:${e.id}`)).toContain(
      "tools:media.paged.kit.tool.frame",
    );
    expect(regs.map((e) => `${e.registry}:${e.id}`)).toContain(
      "commands:media.paged.kit.command.hello",
    );
    expect(await fake.invokeCommand("media.paged.kit.command.hello")).toBe(
      "hi",
    );
    expect(fake.ofChannel("command")).toEqual([
      {
        channel: "command",
        id: "media.paged.kit.command.hello",
        payload: undefined,
        result: "hi",
      },
    ]);
    tool.dispose();
    expect(fake.tools()).toEqual([]);
    expect(fake.ofChannel("registry").at(-1)).toMatchObject({
      action: "dispose",
      id: "media.paged.kit.tool.frame",
    });
  });

  it("applies mutations with a fresh createdId, refuses on request, and keeps an undo stack", async () => {
    const fake = createFakeEditor({
      refuse: (m) => (m.op === "deletePage" ? "the only page" : null),
    });
    const a = await fake.editor.client.mutate({
      op: "insertOval",
      args: { pageId: "page-1", bounds: [0, 0, 10, 10] },
    });
    expect(a.kind).toBe("mutationApplied");
    expect(
      (a as { payload: { createdId: ElementId } }).payload.createdId.kind,
    ).toBe("oval");
    const b = await fake.editor.client.mutate({
      op: "batch",
      args: {
        ops: [
          {
            op: "insertFrame",
            args: { pageId: "page-1", bounds: [0, 0, 5, 5] },
          },
        ],
      },
    });
    expect(
      (b as { payload: { createdId: ElementId } }).payload.createdId.kind,
    ).toBe("rectangle");
    const refused = await fake.editor.client.mutate({
      op: "deletePage",
      args: { pageId: "page-1" },
    });
    expect(refused.kind).toBe("mutationFailed");
    expect(fake.undoDepth()).toBe(2);
    await fake.editor.client.undo();
    expect(fake.undoDepth()).toBe(1);
    await fake.editor.client.redo();
    expect(fake.undoDepth()).toBe(2);
    expect(fake.mutations().map((m) => m.op)).toEqual([
      "insertOval",
      "batch",
      "deletePage",
    ]);
  });

  it("fans every reply out to subscribers, as the editor's client does", async () => {
    const fake = createFakeEditor();
    const seen: string[] = [];
    fake.editor.client.subscribe((m) => seen.push(m.kind));
    await fake.editor.client.mutate({
      op: "insertFrame",
      args: { pageId: "page-1", bounds: [0, 0, 5, 5] },
    });
    await fake.editor.client.send({
      kind: "beginGesture",
      payload: { nodes: [], gesture: { kind: "translate" } },
    });
    fake.emit({ kind: "documentLoaded", payload: {} });
    expect(seen).toEqual(["mutationApplied", "gestureBegun", "documentLoaded"]);
  });

  it("records the gesture channel and holds replies in manual mode", async () => {
    const fake = createFakeEditor({ replies: "manual" });
    let resolved = false;
    const begun = fake.editor.client
      .send({
        kind: "beginGesture",
        payload: { nodes: [], gesture: { kind: "rotate" } },
      })
      .then((r) => {
        resolved = true;
        return r;
      });
    await Promise.resolve();
    expect(resolved).toBe(false);
    fake.flushReplies();
    expect((await begun).kind).toBe("gestureBegun");
    expect(fake.gestureMessages().map((g) => g.message)).toEqual([
      "beginGesture",
    ]);
  });
});

describe("the gesture DSL — unit backend", () => {
  const TWO_PAGES = [
    { id: "p1", origin: [0, 0] as const, size: [600, 800] as const },
    { id: "p2", origin: [0, 824] as const, size: [600, 800] as const },
  ];

  it("resolves pages, page-local points and pasteboard points", async () => {
    const fake = createFakeEditor({ pages: TWO_PAGES });
    const { handler, calls } = spyHandler();
    const g = gestures(fake);
    await g
      .tool(handler)
      .click([100, 100])
      .click([100, 900])
      .click([700, 100])
      .click({ page: 1, at: [10, 20] });
    const downs = calls
      .filter((c) => c.on === "down")
      .map((c) => [c.e!.pageId, c.e!.pagePoint]);
    expect(downs).toEqual([
      ["p1", [100, 100]],
      ["p2", [100, 76]],
      [null, null],
      ["p2", [10, 20]],
    ]);
  });

  it("measures maxDelta in screen px at the current zoom (click vs drag)", async () => {
    const fake = createFakeEditor({ zoom: 4 });
    const { handler, calls } = spyHandler();
    await gestures(fake)
      .tool(handler)
      .drag({ from: [100, 100], to: [102, 100], steps: 2 });
    // 2 pt at 400% is 8 screen px: past the 4 px click threshold.
    expect(calls.find((c) => c.on === "up")!.e!.maxDelta).toBe(8);
    const { handler: h2, calls: c2 } = spyHandler();
    fake.setZoom(0.25);
    await gestures(fake)
      .tool(h2)
      .drag({ from: [100, 100], to: [102, 100], steps: 2 });
    expect(c2.find((c) => c.on === "up")!.e!.maxDelta).toBe(0.5);
  });

  it("carries modifiers per sample, keys mid-drag, hover with maxDelta 0, and pen pressure", async () => {
    const fake = createFakeEditor();
    const { handler, calls } = spyHandler();
    await gestures(fake)
      .tool(handler)
      .hover([10, 10])
      .drag({
        from: [20, 20],
        to: [60, 20],
        steps: 4,
        modsAt: (i) => (i % 2 === 1 ? ["shift"] : []),
        keys: [{ at: 1, key: "ArrowRight" }],
        device: "pen",
        pressureAt: (i, n) => i / n,
      });
    expect(calls[1]).toMatchObject({ on: "move", e: { maxDelta: 0 } });
    const moves = calls.filter((c) => c.on === "move").slice(1);
    expect(moves.map((c) => c.e!.modifiers!.shift)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(moves.map((c) => c.e!.pressure)).toEqual([0.25, 0.5, 0.75, 1]);
    expect(moves.every((c) => c.e!.pointerType === "pen")).toBe(true);
    const order = calls.map((c) => c.on);
    expect(order.slice(order.indexOf("down"))).toEqual([
      "down",
      "move",
      "move",
      "key",
      "move",
      "move",
      "up",
    ]);
  });

  it("mounts tools like the gesture spine: switch deactivates; pointercancel is Escape", async () => {
    const fake = createFakeEditor();
    const a = spyHandler();
    const b = spyHandler();
    await gestures(fake)
      .tool(a.handler)
      .down([5, 5])
      .pointerCancel()
      .tool(b.handler)
      .dblclick([9, 9]);
    expect(a.calls.map((c) => c.on + (c.key ?? "") + (c.reason ?? ""))).toEqual(
      ["activate", "down", "keyEscape", "deactivateswitch"],
    );
    expect(b.calls.map((c) => c.on)).toEqual([
      "activate",
      "down",
      "up",
      "down",
      "up",
    ]);
  });

  it("mounts registered tools by id or short name, and refuses a handler-less tool", async () => {
    const fake = createFakeEditor();
    fake.editor.registries.tools.register({
      id: "media.paged.kit.tool.frame",
      title: "Frame",
      icon: "x",
      group: "g",
      section: "drawType",
      gesture: frameTool,
    } as ToolContribution);
    fake.editor.registries.tools.register({
      id: "media.paged.kit.tool.hand",
      title: "Hand",
      icon: "x",
      group: "h",
      section: "modNav",
    } as ToolContribution);
    const g = gestures(fake);
    await g.tool("frame").drag({ from: [72, 72], to: [216, 144] });
    await fake.settle();
    expect(g.tape().samples[0]).toEqual({
      t: 0,
      type: "tool",
      tool: "media.paged.kit.tool.frame",
    });
    await expect(gestures(fake).tool("hand").run()).rejects.toThrow(
      /no gesture handler/,
    );
    await expect(gestures(fake).tool("nope").run()).rejects.toThrow(
      /no registered tool/,
    );
  });

  it("wheel needs a camera model on the unit backend", async () => {
    const fake = createFakeEditor();
    const g = createGestureDsl(
      unitBackend({
        editor: fake.editor,
        wheel: (s) =>
          fake.setZoom(fake.camera().scale * Math.exp(-s.deltaY * 0.005)),
      }),
    );
    await g.wheel({ ctrl: true, deltaY: -Math.log(2) / 0.005 });
    expect(fake.camera().scale).toBeCloseTo(2, 9);
    await expect(gestures(fake).wheel({ deltaY: 10 }).run()).rejects.toThrow(
      /camera model/,
    );
  });
});

describe("the pointer tape", () => {
  it("is what the DSL sent; it serialises, parses and replays to the same handler calls (INV-3)", async () => {
    const fake = createFakeEditor({ zoom: 2 });
    const first = spyHandler();
    const g = gestures(fake);
    await g
      .tool(first.handler)
      .drag({
        from: [10, 10],
        to: [80, 50],
        via: [[40, 60]],
        mods: ["alt"],
        steps: 3,
      })
      .key("Escape")
      .click([5, 5], { mods: ["shift", "cmd"] });
    const tape = g.tape("frame-drag");
    expect(tape.samples.filter((s) => s.type === "pointermove")).toHaveLength(
      6,
    );
    const text = serializeTape(tape);
    const parsed = parseTape(text);
    expect(parsed).toEqual(tape);

    const second = spyHandler();
    const replay = gestures(fake);
    await replay.tool(second.handler).replay(parsed);
    // The recorded tool was an object, not an id, so the replay keeps the
    // tool mounted on its target: mount the second spy first.
    expect(second.calls.slice(1)).toEqual(first.calls.slice(1));
    const again = replay.tape("frame-drag");
    expect(again.samples.filter((s) => s.type !== "tool")).toEqual(
      tape.samples.filter((s) => s.type !== "tool"),
    );
  });

  it("validates: version, coords, monotonic time, modifiers, sample types", () => {
    const ok = { version: 1, coords: "doc", samples: [] };
    expect(validateTape(ok)).toBe(ok as never);
    const bad = (v: unknown, path: RegExp) => {
      try {
        validateTape(v);
      } catch (e) {
        expect(e).toBeInstanceOf(TapeFormatError);
        expect((e as TapeFormatError).path).toMatch(path);
        return;
      }
      throw new Error("expected a TapeFormatError");
    };
    bad({ ...ok, version: 2 }, /\$\.version/);
    bad({ ...ok, coords: "client" }, /\$\.coords/);
    bad(
      {
        ...ok,
        samples: [
          { t: 5, type: "keydown", key: "a", mods: [] },
          { t: 4, type: "keyup", key: "a", mods: [] },
        ],
      },
      /samples\[1\]\.t/,
    );
    bad(
      {
        ...ok,
        samples: [{ t: 0, type: "keydown", key: "a", mods: ["hyper"] }],
      },
      /mods\[0\]/,
    );
    bad({ ...ok, samples: [{ t: 0, type: "swipe" }] }, /type/);
    bad({ ...ok, viewport: { zoom: 0 } }, /viewport/);
  });
});

describe("the invariants — fake level", () => {
  it("expectOneCommit / expectNoCommit / expectOneUndoStep", async () => {
    const fake = createFakeEditor();
    const g = gestures(fake).tool(frameTool);
    let mark = fake.mark();
    await expectOneUndoStep(fake, () =>
      g.drag({ from: [72, 72], to: [216, 144] }),
    );
    expect(expectOneCommit(fake, mark)).toMatchObject({
      channel: "mutation",
      mutation: { op: "insertFrame" },
    });
    expect(fake.currentPreview()).toBeNull();

    mark = fake.mark();
    await g
      .drag({ from: [72, 72], to: [216, 144], release: false })
      .cancel()
      .up([216, 144])
      .settle();
    expectNoCommit(fake, mark);

    mark = fake.mark();
    await g
      .drag({ from: [72, 72], to: [100, 100] })
      .drag({ from: [72, 72], to: [100, 100] })
      .settle();
    expect(() => expectOneCommit(fake, mark)).toThrow(InvariantError);
  });

  it("flags a begun worker gesture that is never cancelled", async () => {
    const fake = createFakeEditor();
    const mark = fake.mark();
    await fake.editor.client.send({
      kind: "beginGesture",
      payload: { nodes: [], gesture: { kind: "translate" } },
    });
    expect(() => expectNoCommit(fake, mark)).toThrow(
      /begun but only 0 cancelled/,
    );
  });
});

describe("the invariants — against the real headless engine", () => {
  let h: HeadlessHost | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  const editorOf = (live: HeadlessHost) =>
    live.host.editor as unknown as PagedEditor;

  it("a DSL drag through a contract tool is one undo step, undone and redone exactly (INV-1, INV-4)", async () => {
    h = await createHeadlessHost({ console: silent });
    const [pageId] = await h.load(minimalIdml());
    const editor = editorOf(h);
    const channel = engineModelChannel((m) => editor.client.send(m));
    const g = gestures({
      editor,
      pages: [{ id: pageId, origin: [0, 0], size: [612, 792] }],
    });
    const report = await checkUndoRedo(channel, () =>
      g
        .tool(frameTool)
        .drag({ from: [300, 300], to: [400, 380] })
        .settle(),
    );
    expect(report.changed).toBe(true);
    expect(report.after).toContain('"kind":"rectangle"');
  });

  it("Escape mid-drag leaves the model byte-identical (INV-2)", async () => {
    h = await createHeadlessHost({ console: silent });
    const [pageId] = await h.load(minimalIdml());
    const editor = editorOf(h);
    const channel = engineModelChannel((m) => editor.client.send(m));
    const g = gestures({
      editor,
      pages: [{ id: pageId, origin: [0, 0], size: [612, 792] }],
    });
    await checkCancel(channel, () =>
      g
        .tool(frameTool)
        .drag({ from: [300, 300], to: [400, 380], release: false })
        .cancel()
        .up()
        .settle(),
    );
  });

  it("a worker gesture (translate) through the contract client commits once and undoes exactly", async () => {
    h = await createHeadlessHost({ console: silent });
    await h.load(minimalIdml());
    const editor = editorOf(h);
    const channel = engineModelChannel((m) => editor.client.send(m));
    const rect = { kind: "rectangle", id: "urect" } as ElementId;
    const report = await checkUndoRedo(channel, async () => {
      const begun = await editor.client.send({
        kind: "beginGesture",
        payload: { nodes: [rect], gesture: { kind: "translate" } },
      });
      const handle = (begun.payload as { handle: number }).handle;
      await editor.client.send({
        kind: "updateGesture",
        payload: {
          handle,
          delta: [30, 12],
          modifiers: { shift: false, alt: false, disableSnap: true },
        },
      });
      await editor.client.send({ kind: "commitGesture", payload: { handle } });
    });
    expect(report.changed).toBe(true);
  });
});
