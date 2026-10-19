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

// The editor's automation layer (`paged.run`, `editor.*`, `demo.*`,
// packages/shell/src/demo/automation.ts), one test per function, in the
// headless editor: the real client, engine, command registry and object
// registry behind the `__canvas` handle the automation reads.
//
// Each test asserts what the function does to the editor or the document
// (read back through the engine: `editor.get`, the model dump, the engine's
// own selection), what it answers, how it refuses bad input, and, for the
// functions that write the document, that one undo restores the model byte
// for byte. `AUTOMATION_FUNCTIONS` is the roster; the first test holds it
// equal to what `buildAutomation` builds, so a function added to the
// automation without a test here fails.

import { afterEach, describe, expect, test } from "bun:test";

import {
  buildAutomation,
  demoResetOverlay,
  ObjectModelError,
  runDemoScript,
} from "@paged-media/shell";
import {
  covers,
  gestureFixture,
  GESTURE_TARGETS as T,
} from "@paged-media/test-kit";
import { dumpDiff, elementKey } from "@paged-media/test-kit/headless";

import { createHeadlessEditor, type HeadlessEditor } from "./harness";

let ed: HeadlessEditor | null = null;
afterEach(async () => {
  demoResetOverlay();
  await ed?.dispose();
  ed = null;
});

async function open(): Promise<HeadlessEditor> {
  ed = await createHeadlessEditor({ idml: gestureFixture("targets") });
  return ed;
}

/** One undo through the registry, as Edit ▸ Undo does. */
async function undo(e: HeadlessEditor): Promise<void> {
  await e.invoke("paged.editor.undo");
  await e.idle();
}

const FRAME = `rectangle:${T.frame.id.id}`;

/** Every function the automation installs, by global. */
const AUTOMATION_FUNCTIONS = {
  paged: ["run"],
  editor: [
    "openPanel",
    "runCommand",
    "setTool",
    "setMode",
    "select",
    "pageIds",
    "setProperty",
    "mutate",
    "query",
    "get",
    "set",
    "batch",
    "schema",
  ],
  demo: ["showInfo", "pause", "step", "highlight", "wait"],
} as const;

describe("the automation roster", () => {
  test("buildAutomation installs exactly the functions this file tests", async () => {
    const e = await open();
    const built = buildAutomation(e.canvas);
    const names = (o: object) =>
      Object.entries(o)
        .filter(([, v]) => typeof v === "function")
        .map(([k]) => k)
        .sort();
    expect(names(built.paged)).toEqual([...AUTOMATION_FUNCTIONS.paged].sort());
    expect(names(built.editor)).toEqual(
      [...AUTOMATION_FUNCTIONS.editor].sort(),
    );
    expect(names(built.demo)).toEqual([...AUTOMATION_FUNCTIONS.demo].sort());
  });
});

describe("paged.*", () => {
  test("paged.run executes a Boa snippet in the engine and returns its output", async () => {
    covers("script:paged.run");
    const e = await open();
    const { paged, editor } = e.automation;
    const before = await e.dump();
    const out = await paged.run(
      `console.log(JSON.parse(paged.pages()).length);
       console.log(paged.insertTextFrame("${T.pageId}", [400, 300, 500, 500]));`,
    );
    expect(out[0]).toBe("[log] 2");
    // The created frame's address, which the editor's object model reads.
    const made = out[1]!.replace(/^\[log\] /, "");
    expect(made).toMatch(/^textFrame:u/);
    expect(await editor.query("textFrame")).toContain(made);
    // A script error rejects with the engine's message.
    await expect(paged.run("throw new Error('boom')")).rejects.toThrow(
      /^paged\.run: .*boom/,
    );
    await expect(paged.run("paged.noSuchFunction()")).rejects.toThrow(
      /^paged\.run: /,
    );
    // A script is one undo step.
    await undo(e);
    expect(dumpDiff(before, await e.dump())).toEqual([]);
  });
});

describe("editor.*", () => {
  test("editor.openPanel asks the shell to open the panel", async () => {
    covers("script:editor.openPanel");
    const e = await open();
    e.automation.editor.openPanel("paged.layers");
    e.automation.editor.openPanel("paged.properties");
    expect(e.opened.filter((o) => o.kind === "panel")).toEqual([
      { kind: "panel", detail: "paged.layers" },
      { kind: "panel", detail: "paged.properties" },
    ]);
  });

  test("editor.runCommand runs a registered command; an unknown id is refused", async () => {
    covers("script:editor.runCommand");
    const e = await open();
    const { editor } = e.automation;
    const before = await e.dump();
    await editor.select([T.frame.id]);
    await editor.runCommand("paged.object.delete");
    await e.idle();
    expect(e.problems()).toEqual([]);
    expect(Object.keys((await e.dump()).elements)).not.toContain(
      elementKey(T.frame.id),
    );
    await editor.runCommand("paged.editor.undo");
    await e.idle();
    expect(dumpDiff(before, await e.dump())).toEqual([]);
    let refused: unknown = null;
    try {
      await editor.runCommand("paged.no.such.command");
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(Error);
    expect(String(refused)).toContain("paged.no.such.command");
  });

  test("editor.setTool activates a tool", async () => {
    covers("script:editor.setTool");
    const e = await open();
    e.automation.editor.setTool("paged.tool.rectangle");
    expect(e.state.tool.effectiveTool).toBe("paged.tool.rectangle");
    e.automation.editor.setTool("paged.tool.select");
    expect(e.state.tool.toolState).toEqual({
      base: "paged.tool.select",
      overrides: [],
    });
  });

  test("editor.setMode switches the workflow mode", async () => {
    covers("script:editor.setMode");
    const e = await open();
    e.automation.editor.setMode("review");
    expect(e.opened).toContainEqual({ kind: "mode", detail: "review" });
  });

  test("editor.select selects as a click does: engine, mirror and geometry", async () => {
    covers("script:editor.select");
    const e = await open();
    const { editor, paged } = e.automation;
    await editor.select([T.frame.id]);
    expect(e.state.selection.elementSelection).toEqual([T.frame.id]);
    expect(e.state.selection.elementGeometry).toHaveLength(1);
    // The engine follows: a script reads the same selection.
    const [sel] = await paged.run("console.log(paged.selection())");
    expect(sel).toContain(T.frame.id.id);
    await editor.select([T.path.id], "add");
    expect(e.state.selection.elementSelection).toHaveLength(2);
    await editor.select([T.frame.id], "toggle");
    expect(e.state.selection.elementSelection).toEqual([T.path.id]);
    // A malformed id is refused before it reaches the panels.
    await expect(editor.select(["rectangle:uframe"])).rejects.toThrow(
      'editor.select: "rectangle:uframe" is not an element id ({ kind, id })',
    );
    await expect(editor.select([null])).rejects.toThrow(
      "editor.select: null is not an element id",
    );
    expect(e.state.selection.elementSelection).toEqual([T.path.id]);
  });

  test("editor.pageIds lists the open document's pages", async () => {
    covers("script:editor.pageIds");
    const e = await open();
    expect(e.automation.editor.pageIds()).toEqual([T.pageId, T.secondPageId]);
    await e.automation.editor.mutate({
      op: "insertPage",
      args: { afterPageId: T.secondPageId },
    });
    await e.idle();
    // A live read: the handle republished after the write.
    const after = e.automation.editor.pageIds();
    expect(after.slice(0, 2)).toEqual([T.pageId, T.secondPageId]);
  });

  test("editor.setProperty writes a property on every selected element", async () => {
    covers("script:editor.setProperty");
    const e = await open();
    const { editor } = e.automation;
    const before = await e.dump();
    await editor.select([T.frame.id]);
    await editor.setProperty("frameFillColor", {
      type: "colorRef",
      value: "Color/Black",
    });
    await e.idle();
    expect(await editor.get(FRAME, "frameFillColor")).toEqual({
      kind: "value",
      value: "Color/Black",
    });
    await undo(e);
    expect(dumpDiff(before, await e.dump())).toEqual([]);
    // With nothing selected it writes nothing.
    await editor.select([]);
    await editor.setProperty("frameFillColor", {
      type: "colorRef",
      value: "Color/Black",
    });
    await e.idle();
    expect(dumpDiff(before, await e.dump())).toEqual([]);
  });

  // finding AUTO-1 (fixed, ADR 248): `editor.setProperty` discarded the engine's reply, so a
  // write the engine refuses (an unknown path) resolves as if it landed;
  // `editor.set` and `editor.mutate`'s callers see the refusal. It should
  // reject with the engine's reason.
  test(
    "finding AUTO-1: editor.setProperty rejects a write the engine refuses",
    async () => {
      covers("script:editor.setProperty");
      const e = await open();
      await e.automation.editor.select([T.frame.id]);
      await expect(
        e.automation.editor.setProperty("noSuchPath", 1),
      ).rejects.toThrow();
    },
  );

  test("editor.mutate sends one wire op and answers the engine's reply", async () => {
    covers("script:editor.mutate");
    const e = await open();
    const { editor } = e.automation;
    const before = await e.dump();
    const reply = (await editor.mutate({
      op: "insertTextFrame",
      args: { pageId: T.pageId, bounds: [400, 300, 500, 500] },
    })) as {
      kind: string;
      payload: { createdId?: { kind: string; id: string } };
    };
    expect(reply.kind).toBe("mutationApplied");
    const made = reply.payload.createdId!;
    expect(made.kind).toBe("textFrame");
    expect(await editor.query("textFrame")).toContain(`textFrame:${made.id}`);
    await undo(e);
    expect(dumpDiff(before, await e.dump())).toEqual([]);
    // A refused op is an answer, not a throw.
    const refused = (await editor.mutate({
      op: "deleteFrame",
      args: { frameId: "no-such-frame" },
    })) as { kind: string };
    expect(refused.kind).not.toBe("mutationApplied");
    expect(dumpDiff(before, await e.dump())).toEqual([]);
  });

  test("editor.query lists the addresses a selector names", async () => {
    covers("script:editor.query");
    const e = await open();
    const { editor } = e.automation;
    expect(await editor.query("page")).toEqual([
      `page:${T.pageId}`,
      `page:${T.secondPageId}`,
    ]);
    expect(await editor.query("rectangle")).toContain(FRAME);
    expect(await editor.query("rectangle", { limit: 1 })).toHaveLength(1);
    expect(
      await editor.query("rectangle[name=nothing-is-called-this]"),
    ).toEqual([]);
  });

  // finding AUTO-2 (fixed, ADR 248): `editor.query` with a selector that does not parse
  // resolves to an empty list (the registry logs "is not a selector" to the
  // console), so a typo reads as "nothing matched". `paged query` on the
  // command line refuses it ("selector does not parse"); the automation
  // should reject too, as its own doc promises for refusals.
  test(
    "finding AUTO-2: editor.query rejects a selector that does not parse",
    async () => {
      covers("script:editor.query");
      const e = await open();
      await expect(e.automation.editor.query("frame[")).rejects.toThrow();
    },
  );

  test("editor.get reads one property; a refusal throws with its code", async () => {
    covers("script:editor.get");
    const e = await open();
    const { editor } = e.automation;
    const bounds = await editor.get(FRAME, "frameBounds");
    expect(bounds.kind).toBe("value");
    expect((bounds as { value: unknown }).value).toEqual([...T.frame.box]);
    let refused: unknown = null;
    try {
      await editor.get(FRAME, "noSuchPath");
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(ObjectModelError);
    expect((refused as ObjectModelError).code).toBe("unknownPath");
    await expect(editor.get("rectangle:nope", "frameBounds")).rejects.toThrow(
      "unknownAddress: frame.frameBounds: the target does not exist",
    );
  });

  test("editor.set writes one property as one undo step; a refusal throws", async () => {
    covers("script:editor.set");
    const e = await open();
    const { editor } = e.automation;
    const before = await e.dump();
    const r = await editor.set(FRAME, "frameFillColor", "Color/Black");
    expect(r).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await editor.get(FRAME, "frameFillColor")).toEqual({
      kind: "value",
      value: "Color/Black",
    });
    await undo(e);
    expect(dumpDiff(before, await e.dump())).toEqual([]);
    let refused: unknown = null;
    try {
      await editor.set(FRAME, "noSuchPath", 1);
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(ObjectModelError);
    expect((refused as ObjectModelError).code).toBe("unknownPath");
    expect(dumpDiff(before, await e.dump())).toEqual([]);
  });

  test("editor.batch applies all or nothing as one undo step, and answers rather than throws", async () => {
    covers("script:editor.batch");
    const e = await open();
    const { editor } = e.automation;
    const before = await e.dump();
    const ok = await editor.batch([
      {
        op: "set",
        address: FRAME,
        path: "frameFillColor",
        value: "Color/Black",
      },
      { op: "set", address: FRAME, path: "frameOpacity", value: 50 },
    ]);
    expect(ok).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await editor.get(FRAME, "frameOpacity")).toEqual({
      kind: "value",
      value: 50,
    });
    await undo(e);
    expect(dumpDiff(before, await e.dump())).toEqual([]);
    // One bad op: nothing lands, and the answer names it.
    const bad = await editor.batch([
      {
        op: "set",
        address: FRAME,
        path: "frameFillColor",
        value: "Color/Black",
      },
      { op: "set", address: FRAME, path: "noSuchPath", value: 1 },
    ]);
    expect(bad.applied).toBe(false);
    expect(bad.index).toBe(1);
    expect(bad.code).toBe("unknownPath");
    expect(dumpDiff(before, await e.dump())).toEqual([]);
  });

  test("editor.schema lists the rows of an address's kind, or a kind's", async () => {
    covers("script:editor.schema");
    const e = await open();
    const { editor } = e.automation;
    const rows = await editor.schema(FRAME);
    const paths = rows.map((r) => r.path);
    expect(paths).toContain("frameFillColor");
    expect(paths).toContain("frameBounds");
    const byKind = await editor.schema("frame");
    expect(byKind.map((r) => r.path)).toEqual(paths);
    expect(rows.find((r) => r.path === "frameBounds")?.type).toMatchObject({
      kind: "bounds",
    });
  });

  test("editor.get/set/query/batch/schema without an object registry throw `unavailable`", async () => {
    covers(
      "script:editor.query",
      "script:editor.get",
      "script:editor.set",
      "script:editor.batch",
      "script:editor.schema",
    );
    const e = await open();
    // Built against a handle with no registry, and no live publication.
    const handle = { ...e.canvas, objects: null };
    const saved = (globalThis as { __canvas?: unknown }).__canvas;
    (globalThis as { __canvas?: unknown }).__canvas = undefined;
    try {
      const { editor } = buildAutomation(handle);
      for (const call of [
        () => editor.query("page"),
        () => editor.get(FRAME, "frameBounds"),
        () => editor.set(FRAME, "frameOpacity", 1),
        () => editor.batch([]),
        () => editor.schema("frame"),
      ]) {
        await expect(call()).rejects.toThrow(
          "unavailable: no object registry is wired in this editor",
        );
      }
    } finally {
      (globalThis as { __canvas?: unknown }).__canvas = saved;
    }
  });
});

describe("demo.*", () => {
  test("demo.showInfo suspends the script until the box is advanced; silent replay does not", async () => {
    covers("script:demo.showInfo");
    const e = await open();
    // Silent (the editor's replay / seek): resolves at once.
    await e.automation.demo.showInfo("Title", "Body", { index: 1, total: 2 });
    // Live: pending until the box goes away.
    const live = buildAutomation(e.canvas);
    let done = false;
    const shown = live.demo.showInfo("Step", "Wait for me").then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    demoResetOverlay();
    await shown;
    expect(done).toBe(true);
  });

  test("demo.pause is a titled box that suspends the same way", async () => {
    covers("script:demo.pause");
    const e = await open();
    await e.automation.demo.pause("Silent");
    const live = buildAutomation(e.canvas);
    let done = false;
    const paused = live.demo.pause("Look here").then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    // A second box resolves the first (sequential stepping).
    const next = live.demo.pause("Next");
    await paused;
    expect(done).toBe(true);
    demoResetOverlay();
    await next;
  });

  test("demo.step is a chapter marker that resolves at once", async () => {
    covers("script:demo.step");
    const e = await open();
    const before = await e.dump();
    await e.automation.demo.step("Chapter 1");
    await buildAutomation(e.canvas).demo.step("Chapter 2");
    expect(dumpDiff(before, await e.dump())).toEqual([]);
  });

  test("demo.highlight sets the spotlight, even during silent replay", async () => {
    covers("script:demo.highlight");
    const e = await open();
    await e.automation.demo.highlight("[data-panel='paged.layers']");
    await e.automation.demo.highlight(null);
    // Through a whole demo script, the globals a demo author sees.
    const run = await e.runDemo(`
      await demo.highlight("#toolbar");
      await demo.step("one");
      await demo.highlight(null);
      editor.openPanel("paged.layers");
    `);
    expect(run).toEqual({ ok: true });
    expect(e.opened).toContainEqual({ kind: "panel", detail: "paged.layers" });
  });

  test("demo.wait sleeps when live and not during silent replay", async () => {
    covers("script:demo.wait");
    const e = await open();
    const t0 = performance.now();
    await e.automation.demo.wait(400);
    expect(performance.now() - t0).toBeLessThan(200);
    const t1 = performance.now();
    await buildAutomation(e.canvas).demo.wait(60);
    expect(performance.now() - t1).toBeGreaterThanOrEqual(50);
    // A demo script's error is its result, not a throw.
    const failed = await runDemoScript(
      "await demo.wait(1); throw new Error('stop');",
      e.automation,
    );
    expect(failed).toEqual({ ok: false, error: "stop" });
  });
});
