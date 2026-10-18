/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// @feat: plugin-platform.object-model
//
// The Boa script host bridge (ADR 323, engine protocol 71) on the REAL
// headless engine: a `paged.*` script names a plugin object, the worker
// suspends with `requestHostObjects`, `answerHostObjects` answers through
// `host.objects`, and core + plugin writes of one script are ONE undo step.
// Needs an engine with the bridge (core om/boa-bridge); skipped on one
// without it unless REQUIRE_REAL_BRIDGE=1.

import { afterEach, describe, expect, it } from "vitest";

import { answerHostObjects } from "../src/script-bridge";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { createObjectRegistry } from "../src/object-registry";
import { minimalIdml } from "./fixtures/minimal-idml";
import { makeNotesBundle, NOTES_ID } from "./fixtures/notes-bundle";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const NOTE = `plugin:${NOTES_ID}/note`;
const value = (v: unknown) => ({ kind: "value", value: v });

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

async function setup(): Promise<{ h: HeadlessHost; rect: string; notes: string[]; pageId: string }> {
  const h = (live = await createHeadlessHost({ console: silent }));
  const [pageId] = await h.load(minimalIdml());
  const made = await h.host.document.mutate({ op: "insertFrame", args: { pageId: pageId!, bounds: [10, 10, 110, 210] } });
  const created = (made as { createdId?: { kind: string; id: string } }).createdId!;
  const rect = `${created.kind}:${created.id}`;
  h.loadBundle(makeNotesBundle());
  await h.objects.invoke("acme.notes.attach", { frame: rect, count: 2 });
  return { h, rect, notes: await h.objects.query(NOTE), pageId: pageId! };
}

/** Does the loaded engine carry the bridge? (`paged.schema` ships with it.) */
async function engineHasBridge(): Promise<boolean> {
  const h = await createHeadlessHost({ console: silent });
  try {
    await h.load(minimalIdml());
    const r = await h.runScript("typeof paged.schema");
    return r.output.join("") === "function";
  } finally {
    h.dispose();
  }
}

const hasBridge = await engineHasBridge();
if (!hasBridge && process.env.REQUIRE_REAL_BRIDGE === "1") {
  throw new Error("REQUIRE_REAL_BRIDGE=1 but the installed canvas-wasm has no script host bridge");
}

describe("answerHostObjects (registry side, no engine)", () => {
  it("answers each call in order; refusals become coded errors, never throws", async () => {
    const objects = createObjectRegistry({ core: null, log: silent });
    const answers = await answerHostObjects(objects, [
      { op: "get", address: "plugin:nobody/thing/1", path: "x" },
      { op: "batch", ops: [{ op: "set", address: "plugin:nobody/thing/1", path: "x", value: 1 }] },
      { op: "query", selector: "plugin:nobody/thing" },
      { op: "schema", target: "plugin:nobody/thing" },
    ]);
    expect(answers).toHaveLength(4);
    expect(answers[0]!.error).toMatchObject({ code: "unknownAddress" });
    expect(answers[1]!.error).toMatchObject({ code: "unknownAddress", index: 0 });
    expect(answers[2]).toEqual({ value: [] });
    expect(answers[3]).toEqual({ value: [] });
  });

  it("answers invoke and commands (no longer `unmapped`); a refused invoke is a coded error", async () => {
    const objects = createObjectRegistry({ core: null, log: silent });
    const answers = await answerHostObjects(objects, [
      { op: "commands" },
      { op: "commands", owner: "nobody" },
      { op: "invoke", id: "nobody.thing", args: {} },
      { op: "invoke", id: "" },
    ]);
    expect(answers[0]).toEqual({ value: [] });
    expect(answers[1]).toEqual({ value: [] });
    expect(answers[2]!.error).toMatchObject({ code: "unknownCommand" });
    expect(answers[3]!.error).toMatchObject({ code: "invalidValue" });
  });
});

describe.skipIf(!hasBridge)("Boa scripts reach plugin objects (real engine, protocol 71 bridge)", () => {
  it("a script sets a plugin property and a core property: one round trip, ONE undo step", async () => {
    const { h, rect, notes } = await setup();
    await h.objects.set(rect, "frameStrokeWeight", 3);
    const r = await h.runScript(`
      paged.set(${JSON.stringify(notes[0])}, "text", "from a script");
      paged.set(${JSON.stringify(notes[1])}, "size", 30);
      console.log(paged.set(${JSON.stringify(rect)}, "frameStrokeWeight", 7));
    `);
    expect(r).toMatchObject({ error: null, hostRounds: 1, output: ["[log] true"] });
    expect(await h.objects.get(notes[0]!, "text")).toEqual(value("from a script"));
    expect(await h.objects.get(notes[1]!, "size")).toEqual(value(30));
    expect(await h.objects.get(rect, "frameStrokeWeight")).toEqual(value(7));

    await h.host.document.undo();
    expect(await h.objects.get(rect, "frameStrokeWeight")).toEqual(value(3));
    expect(await h.objects.get(notes[0]!, "text")).toEqual(value("hello"));
    expect(await h.objects.get(notes[1]!, "size")).toEqual(value(12));
    await h.host.document.redo();
    expect(await h.objects.get(notes[0]!, "text")).toEqual(value("from a script"));
    expect(await h.objects.get(rect, "frameStrokeWeight")).toEqual(value(7));
  });

  it("the host's own writes join the script's step (committed); foreign writes during the wait stay separate", async () => {
    const { h, rect, notes, pageId } = await setup();
    const framesBefore = (await h.objects.query("frame")).length;
    const weightBefore = await h.objects.get(rect, "frameStrokeWeight");
    // Writes NOT made answering the round land while the script waits on a
    // read: a raw engine write AND a write through the SAME registry (what
    // a panel field does) — neither is the script's.
    const orig = h.objects.get.bind(h.objects);
    let foreign = 0;
    (h.objects as { get: typeof orig }).get = async (address, path) => {
      if (foreign++ === 0) {
        expect((await h.host.document.mutate({ op: "insertFrame", args: { pageId, bounds: [300, 10, 340, 50] } })).applied).toBe(true);
        expect((await h.objects.set(rect, "frameStrokeWeight", 9)).applied).toBe(true);
      }
      return orig(address, path);
    };
    const r = await h.runScript(`
      await paged.get(${JSON.stringify(notes[0])}, "text");
      paged.set(${JSON.stringify(notes[0])}, "text", "scripted");
    `);
    expect(r).toMatchObject({ error: null, hostRounds: 2 });
    expect((await h.objects.query("frame")).length).toBe(framesBefore + 1);
    // Undo 1: the script (its plugin write folded in); the foreign writes stay.
    await h.host.document.undo();
    expect(await h.objects.get(notes[0]!, "text")).toEqual(value("hello"));
    expect((await h.objects.query("frame")).length).toBe(framesBefore + 1);
    expect(await h.objects.get(rect, "frameStrokeWeight")).toEqual(value(9));
    // Undo 2 and 3: the foreign writes, each its own step.
    await h.host.document.undo();
    expect(await h.objects.get(rect, "frameStrokeWeight")).toEqual(weightBefore);
    await h.host.document.undo();
    expect((await h.objects.query("frame")).length).toBe(framesBefore);
  });

  it("reads await the host; a refusal is an exception carrying the registry's code", async () => {
    const { h, notes } = await setup();
    const n1 = JSON.stringify(notes[0]);
    const r = await h.runScript(`
      console.log(JSON.parse(await paged.get(${n1}, "text")), JSON.parse(await paged.get(${n1}, "length")));
      console.log(JSON.parse(await paged.query(${JSON.stringify(NOTE)})).length);
      console.log(JSON.parse(await paged.schema(${JSON.stringify(NOTE)})).map(r => r.path).join());
      try { await paged.set(${n1}, "size", 99); } catch (e) { console.log("refused", e.code); }
      try { await paged.set(${n1}, "length", 3); } catch (e) { console.log("refused", e.code); }
    `);
    expect(r.error).toBeNull();
    expect(r.output).toEqual([
      "[log] hello 5",
      "[log] 2",
      "[log] text,size,visible,tone,length,content",
      "[log] refused invalidValue",
      "[log] refused readOnly",
    ]);
  });

  it("an unawaited refused write fails the script with its code; nothing applies", async () => {
    const { h, notes } = await setup();
    const r = await h.runScript(`
      paged.set(${JSON.stringify(notes[0])}, "text", "never");
      paged.set(${JSON.stringify(notes[1])}, "tone", "green");
    `);
    expect(r.error).toMatch(/invalidValue/);
    expect(await h.objects.get(notes[0]!, "text")).toEqual(value("hello"));
  });

  it("paged.batch of object ops (core + plugin) resolves to per-op results in one undo step", async () => {
    const { h, rect, notes } = await setup();
    const r = await h.runScript(`
      const ok = await paged.batch([
        { op: "set", address: ${JSON.stringify(rect)}, path: "frameStrokeWeight", value: 4 },
        { op: "set", address: ${JSON.stringify(notes[0])}, path: "text", value: "batched" },
      ]);
      const bad = await paged.batch([
        { op: "set", address: ${JSON.stringify(notes[0])}, path: "text", value: "x" },
        { op: "set", address: ${JSON.stringify(notes[1])}, path: "size", value: 1000 },
      ]);
      console.log(ok);
      console.log(bad);
    `);
    expect(r.error).toBeNull();
    expect(JSON.parse(r.output[0]!.replace("[log] ", ""))).toEqual([{ ok: true }, { ok: true }]);
    const bad = JSON.parse(r.output[1]!.replace("[log] ", ""));
    expect(bad[0]).toMatchObject({ ok: false, code: "aborted" });
    expect(bad[1]).toMatchObject({ ok: false, code: "invalidValue" });
    expect(await h.objects.get(notes[0]!, "text")).toEqual(value("batched"));
    await h.host.document.undo();
    expect(await h.objects.get(notes[0]!, "text")).toEqual(value("hello"));
    expect(await h.objects.get(rect, "frameStrokeWeight")).not.toEqual(value(4));
  });

  it("paged.invoke runs a core command and a plugin command: committed seqs reported, ONE undo step", async () => {
    const { h, rect, pageId } = await setup();
    const framesBefore = (await h.objects.query("frame")).length;
    const notesBefore = (await h.objects.query(NOTE)).length;
    const r = await h.runScript(`
      const made = JSON.parse(await paged.invoke("core.insertFrame", { pageId: "page:${pageId}", bounds: [200, 20, 260, 80] }));
      console.log(made.created.length, made.undoSteps);
      console.log(JSON.parse(await paged.invoke("acme.notes.attach", { frame: ${JSON.stringify(rect)}, count: 1 })));
      try { await paged.invoke("acme.notes.nothing", {}); } catch (e) { console.log("refused", e.code); }
    `);
    expect(r.error).toBeNull();
    expect(r.output).toEqual(["[log] 1 1", `[log] ${notesBefore + 1}`, "[log] refused unknownCommand"]);
    expect((await h.objects.query("frame")).length).toBe(framesBefore + 1);
    expect((await h.objects.query(NOTE)).length).toBe(notesBefore + 1);
    // ONE undo step takes the core command AND the plugin command's write.
    await h.host.document.undo();
    expect((await h.objects.query("frame")).length).toBe(framesBefore);
    expect((await h.objects.query(NOTE)).length).toBe(notesBefore);
  });

  it("paged.commands lists core commands first and filters by owner", async () => {
    const { h } = await setup();
    const r = await h.runScript(`
      const all = JSON.parse(await paged.commands());
      const mine = JSON.parse(await paged.commands("acme.notes"));
      console.log(all[0].owner, all.some(c => c.id === "core.insertFrame"), all.some(c => c.id === "acme.notes.attach"));
      console.log(mine.map(c => c.id).join());
    `);
    expect(r.error).toBeNull();
    expect(r.output).toEqual(["[log] core true true", "[log] acme.notes.attach"]);
  });

  it("an invoke op inside paged.batch shares the batch's ONE undo step (handle binds what it made)", async () => {
    const { h, rect, notes, pageId } = await setup();
    const before = await h.objects.query("frame");
    const framesBefore = before.length;
    const r = await h.runScript(`
      console.log(await paged.batch([
        { op: "set", address: ${JSON.stringify(notes[0])}, path: "text", value: "with a command" },
        { op: "invoke", id: "core.insertFrame", args: { pageId: "page:${pageId}", bounds: [200, 20, 260, 80] }, handle: "box" },
        { op: "set", address: "$h:box", path: "frameStrokeWeight", value: 5 },
        { op: "set", address: ${JSON.stringify(rect)}, path: "frameStrokeWeight", value: 6 },
      ]));
    `);
    expect(r).toMatchObject({ error: null, hostRounds: 1 });
    expect(JSON.parse(r.output[0]!.replace("[log] ", ""))).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
    const frames = await h.objects.query("frame");
    expect(frames.length).toBe(framesBefore + 1);
    const box = frames.find((f) => !before.includes(f))!;
    expect(await h.objects.get(box, "frameStrokeWeight")).toEqual(value(5));
    expect(await h.objects.get(notes[0]!, "text")).toEqual(value("with a command"));
    await h.host.document.undo();
    expect((await h.objects.query("frame")).length).toBe(framesBefore);
    expect(await h.objects.get(notes[0]!, "text")).toEqual(value("hello"));
    expect(await h.objects.get(rect, "frameStrokeWeight")).not.toEqual(value(6));
  });

  it("a script with no plugin address never suspends", async () => {
    const { h } = await setup();
    expect(await h.runScript("1 + 1")).toMatchObject({ output: ["2"], error: null, hostRounds: 0 });
  });

  it("host.objects queries fields by kind and as story children", async () => {
    const { h } = await setup();
    const tf = await h.objects.batch([
      { op: "create", kind: "textFrame", within: "page:#1", props: { frameBounds: [200, 10, 300, 200] }, handle: "t" },
    ]);
    const storyId = (tf.outcome as { minted?: { handle?: string; storyId?: string }[] }).minted!.find((m) => m.handle === "t")!.storyId!;
    await h.host.document.mutate({
      op: "batch",
      args: {
        ops: [
          { op: "insertText", args: { storyId, offset: 0, text: "price " } },
          { op: "insertField", args: { storyId, offset: 6, field: { placeholder: { plugin: "media.paged.data", key: "price" } } } },
        ],
      },
    });
    const all = (await h.objects.query("*")).filter((a) => a.startsWith("field:"));
    expect(all).toHaveLength(1);
    expect(await h.objects.query("field")).toEqual(all);
    expect(await h.objects.query("story > field")).toEqual(all);
  });
});
