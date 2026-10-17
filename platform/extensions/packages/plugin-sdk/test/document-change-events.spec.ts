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

// `document.onDidChange` reports EVERY committed change to the document
// (ADR 327), whatever committed it: a mutation (a panel field, a command,
// a bundle's write), an undo or redo, a canvas gesture's commit (a frame
// dragged, resized or rotated by its handles), and a script run. The last
// two used to be silent: a gesture commits on the engine and answers
// `gestureCommitted`, a script writes through the model and answers
// `scriptResult`, and neither is a `mutationApplied`. A bundle that mirrors
// document state (paged.web re-rendering a resized frame, paged.draw's
// link index) missed them, and so did the host's own derived caches (the
// parent index, the core object model).
//
// Coverage: the fake host's broadcast (kinds, pages, what is NOT a change),
// the feature flag, the parent index and the object model dropping their
// caches, and the real engine through the headless harness (a resize
// gesture, its undo, a script that inserts a frame).

import { afterEach, describe, expect, it } from "vitest";

import type {
  DocumentChangeEvent,
  ElementId,
  PluginManifest,
} from "@paged-media/plugin-api";

import { createBundleHost } from "../src";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { makeFakeEditor } from "./fake-editor";
import { minimalIdml } from "./fixtures/minimal-idml";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const manifest = (): PluginManifest => ({
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { document: { read: "broad", write: "broad" } },
});

function fakeHost() {
  const fake = makeFakeEditor();
  const { host } = createBundleHost(() => fake.editor, manifest(), {
    console: silent,
    capabilityMode: "enforce",
  });
  return { fake, host };
}

describe("document.onDidChange reports every committed change", () => {
  it("a canvas gesture's commit is a change, with the pages it touched", () => {
    const { fake, host } = fakeHost();
    const seen: DocumentChangeEvent[] = [];
    host.document.onDidChange((e) => seen.push(e));
    // A gesture in flight, a cancelled one and a failed one change nothing.
    fake.emit({ kind: "gestureBegun", payload: { handle: 1 } });
    fake.emit({ kind: "gestureUpdated", payload: { handle: 1, pageIds: ["p1"] } });
    fake.emit({ kind: "gestureCancelled", payload: { handle: 1, pageIds: ["p1"] } });
    fake.emit({ kind: "gestureFailed", payload: { error: { kind: "noDocument" } } });
    expect(seen).toEqual([]);
    fake.emit({
      kind: "gestureCommitted",
      payload: { handle: 2, appliedSeq: 7, pageIds: ["p1", "p2"], cacheStats: {} },
    });
    expect(seen).toEqual([{ kind: "gestureCommitted", pageIds: ["p1", "p2"] }]);
  });

  it("an older engine's script reply (no writes, no pageIds) is a change on pages it does not name", () => {
    const { fake, host } = fakeHost();
    const seen: DocumentChangeEvent[] = [];
    host.document.onDidChange((e) => seen.push(e));
    // A script suspended on the host's objects has not finished.
    fake.emit({ kind: "requestHostObjects", payload: { session: 1, calls: [] } });
    expect(seen).toEqual([]);
    fake.emit({ kind: "scriptResult", payload: { output: [], error: null } });
    expect(seen).toEqual([{ kind: "scriptResult", pageIds: [], pagesUnknown: true }]);
  });

  // Core ADR 159 (engine 0.71.13): the gesture reply carries a one-frame
  // resize's reflow, and the script reply counts its own writes and names
  // the pages they changed. Keyed off presence: an absent field is an
  // older engine, which keeps the fallback above.
  it("a gesture that resized one frame passes its reflow through", () => {
    const { fake, host } = fakeHost();
    const seen: DocumentChangeEvent[] = [];
    host.document.onDidChange((e) => seen.push(e));
    fake.emit({
      kind: "gestureCommitted",
      payload: {
        handle: 3,
        appliedSeq: 8,
        pageIds: ["p1"],
        cacheStats: {},
        reflow: { frameId: "f1", contentBox: [10, 10, 110, 250] },
      },
    });
    expect(seen).toEqual([
      { kind: "gestureCommitted", pageIds: ["p1"], reflow: { frameId: "f1", contentBox: [10, 10, 110, 250] } },
    ]);
  });

  it("a script that wrote nothing (writes: 0) is no change", async () => {
    const { fake, host } = fakeHost();
    const seen: DocumentChangeEvent[] = [];
    host.document.onDidChange((e) => seen.push(e));
    // The parent index follows the same definition: a read-only script
    // does not drop it.
    const r1 = { kind: "rectangle", id: "r1" } as ElementId;
    fake.setSceneTree([{ id: r1, kind: "rectangle", label: "R" }]);
    const reads = () => fake.sent.filter((m) => m.kind === "requestSceneTree").length;
    await host.document.parentOf(r1);
    expect(reads()).toBe(1);
    fake.emit({ kind: "scriptResult", payload: { output: ["42"], error: null, writes: 0, pageIds: [] } });
    expect(seen).toEqual([]);
    await host.document.parentOf(r1);
    expect(reads()).toBe(1);
  });

  it("a script that wrote takes its pages from the reply", () => {
    const { fake, host } = fakeHost();
    const seen: DocumentChangeEvent[] = [];
    host.document.onDidChange((e) => seen.push(e));
    fake.emit({ kind: "scriptResult", payload: { output: [], error: null, writes: 2, pageIds: ["p2"] } });
    // A write that changes nothing a page draws still changed the document.
    fake.emit({ kind: "scriptResult", payload: { output: [], error: null, writes: 1, pageIds: [] } });
    expect(seen).toEqual([
      { kind: "scriptResult", pageIds: ["p2"] },
      { kind: "scriptResult", pageIds: [] },
    ]);
  });

  it("a script that wrote on a reply without pageIds keeps pagesUnknown", () => {
    const { fake, host } = fakeHost();
    const seen: DocumentChangeEvent[] = [];
    host.document.onDidChange((e) => seen.push(e));
    fake.emit({ kind: "scriptResult", payload: { output: [], error: null, writes: 1 } });
    expect(seen).toEqual([{ kind: "scriptResult", pageIds: [], pagesUnknown: true }]);
  });

  it("mutations, undo and redo keep their events, reflow included", () => {
    const { fake, host } = fakeHost();
    const seen: DocumentChangeEvent[] = [];
    host.document.onDidChange((e) => seen.push(e));
    fake.emit({
      kind: "mutationApplied",
      payload: {
        pageIds: ["p1"],
        reflow: { frameId: "f1", contentBox: [0, 0, 10, 20] },
      },
    });
    fake.emit({ kind: "undoApplied", payload: { pageIds: ["p1"] } });
    fake.emit({ kind: "redoApplied", payload: { pageIds: ["p1"] } });
    expect(seen).toEqual([
      {
        kind: "mutationApplied",
        pageIds: ["p1"],
        reflow: { frameId: "f1", contentBox: [0, 0, 10, 20] },
      },
      { kind: "undoApplied", pageIds: ["p1"] },
      { kind: "redoApplied", pageIds: ["p1"] },
    ]);
  });

  it("advertises the widened event as document.onDidChange@2", () => {
    const { host } = fakeHost();
    expect(host.supports("document.onDidChange@1")).toBe(true);
    expect(host.supports("document.onDidChange@2")).toBe(true);
  });

  it("advertises the reply-keyed event (gesture reflow, script writes and pages) as document.onDidChange@3", () => {
    const { host } = fakeHost();
    expect(host.supports("document.onDidChange@3")).toBe(true);
  });

  it("a gesture's commit and a script run drop the parent index", async () => {
    const { fake, host } = fakeHost();
    const r1 = { kind: "rectangle", id: "r1" } as ElementId;
    const g1 = { kind: "group", id: "g1" } as ElementId;
    fake.setSceneTree([{ id: g1, kind: "group", label: "G", children: [{ id: r1, kind: "rectangle", label: "R" }] }]);
    const reads = () => fake.sent.filter((m) => m.kind === "requestSceneTree").length;
    expect(await host.document.parentOf(r1)).toEqual(g1);
    expect(await host.document.parentOf(r1)).toEqual(g1);
    expect(reads()).toBe(1);
    // A script dissolved the group.
    fake.setSceneTree([{ id: r1, kind: "rectangle", label: "R" }]);
    fake.emit({ kind: "scriptResult", payload: { output: [], error: null } });
    expect(await host.document.parentOf(r1)).toBeNull();
    expect(reads()).toBe(2);
    fake.emit({ kind: "gestureCommitted", payload: { handle: 1, appliedSeq: 2, pageIds: [], cacheStats: {} } });
    await host.document.parentOf(r1);
    expect(reads()).toBe(3);
  });
});

describe("document.onDidChange on the real engine (headless harness)", () => {
  let h: HeadlessHost | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  type Send = (m: { kind: string; payload?: unknown }) => Promise<{ kind: string; payload?: any }>;
  const sendOf = (live: HeadlessHost): Send => {
    const client = (live.host.editor as unknown as { client: { send: Send } }).client;
    return client.send.bind(client);
  };

  it("a frame resized by its handle (a gesture, as the editor commits it) and its undo are changes", async () => {
    h = await createHeadlessHost({ console: silent });
    await h.load(minimalIdml());
    const seen: DocumentChangeEvent[] = [];
    h.host.document.onDidChange((e) => seen.push(e));
    // A panel bound through the object model (a frame's X/Y/W/H field)
    // follows the same commits.
    let objectChanges = 0;
    h.objects.onDidChange(() => objectChanges++);
    const send = sendOf(h);
    const rect = { kind: "rectangle", id: "urect" } as ElementId;
    const [before] = await h.host.document.elementGeometry([rect]);

    const begun = await send({
      kind: "beginGesture",
      payload: { nodes: [rect], gesture: { kind: "resize", handle: "south" }, anchor: null },
    });
    expect(begun.kind).toBe("gestureBegun");
    const handle = begun.payload.handle as number;
    await send({
      kind: "updateGesture",
      payload: { handle, delta: [0, 40], modifiers: { shift: false, alt: false, disableSnap: true } },
    });
    expect(seen).toEqual([]); // in flight: nothing committed yet
    const done = await send({ kind: "commitGesture", payload: { handle } });
    expect(done.kind).toBe("gestureCommitted");
    const [after] = await h.host.document.elementGeometry([rect]);
    expect(after.bounds[2] - after.bounds[0]).not.toBeCloseTo(before.bounds[2] - before.bounds[0], 1);

    expect(seen.map((e) => e.kind)).toEqual(["gestureCommitted"]);
    expect(seen[0].pageIds).toEqual(done.payload.pageIds);
    // Engine 0.71.13 (core ADR 159): a resize of one frame by its handles
    // reports the frame's committed content box, as a `resizeFrame` does.
    expect(done.payload.reflow).toMatchObject({ frameId: "urect" });
    expect(seen[0].reflow).toEqual(done.payload.reflow);
    expect(seen[0].reflow!.contentBox[2] - seen[0].reflow!.contentBox[0]).toBeCloseTo(after.bounds[2] - after.bounds[0], 6);
    expect(objectChanges).toBe(1);
    await h.host.document.undo();
    expect(seen.map((e) => e.kind)).toEqual(["gestureCommitted", "undoApplied"]);

    // A move by the handles is display geometry only: no reflow.
    const moved = await send({ kind: "beginGesture", payload: { nodes: [rect], gesture: { kind: "translate" }, anchor: null } });
    const moveHandle = moved.payload.handle as number;
    await send({
      kind: "updateGesture",
      payload: { handle: moveHandle, delta: [15, 15], modifiers: { shift: false, alt: false, disableSnap: true } },
    });
    await send({ kind: "commitGesture", payload: { handle: moveHandle } });
    expect(seen.map((e) => e.kind)).toEqual(["gestureCommitted", "undoApplied", "gestureCommitted"]);
    expect(seen[2].reflow).toBeUndefined();
  });

  it("a script that writes is a change, to the document and the object model", async () => {
    h = await createHeadlessHost({ console: silent });
    const [pageId] = await h.load(minimalIdml());
    const seen: DocumentChangeEvent[] = [];
    h.host.document.onDidChange((e) => seen.push(e));
    let objectChanges = 0;
    h.objects.onDidChange(() => objectChanges++);
    const framesBefore = (await h.objects.query("frame")).length;
    const run = await h.runScript(`paged.insertTextFrame(${JSON.stringify(pageId)}, [300, 300, 400, 400]);`);
    expect(run.error).toBeNull();
    // Engine 0.71.13 names the pages the script's writes changed (a frame
    // write: every page), so the event is no longer `pagesUnknown`.
    expect(seen).toEqual([{ kind: "scriptResult", pageIds: [pageId] }]);
    expect(objectChanges).toBe(1);
    expect((await h.objects.query("frame")).length).toBe(framesBefore + 1);
  });

  it("a script that only reads is no change (engine writes: 0)", async () => {
    h = await createHeadlessHost({ console: silent });
    await h.load(minimalIdml());
    const seen: DocumentChangeEvent[] = [];
    h.host.document.onDidChange((e) => seen.push(e));
    let objectChanges = 0;
    h.objects.onDidChange(() => objectChanges++);
    const run = await h.runScript("paged.pages();");
    expect(run.error).toBeNull();
    expect(run.output.length).toBe(1);
    expect(seen).toEqual([]);
    expect(objectChanges).toBe(0);
  });
});
