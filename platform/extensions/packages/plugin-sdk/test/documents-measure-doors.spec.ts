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

// @feat: plugin-platform.native-document
// @feat: plugin-platform.text-measurement
//
// D-26 — `host.documents` (exportPaged + the user-guarded open) and D-27 —
// `host.text.measureStrings` (the batched measure). Two layers: the SDK
// adapter over a fake editor (gates, requester, fallbacks, call counts) and
// the headless host over the real engine (export → open round-trip, the
// documentLoaded broadcast, the keep/discard decision, the engine shaper).

import { afterEach, describe, expect, it } from "vitest";

import type { PluginManifest, WorkerToMain } from "@paged-media/plugin-api";

import {
  createBundleHost,
  PluginCapabilityError,
  type DocumentsBackend,
} from "../src";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { makeFakeEditor } from "./fake-editor";
import { minimalIdml } from "./fixtures/minimal-idml";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const manifest = (
  capabilities: PluginManifest["capabilities"] = {},
): PluginManifest => ({
  id: "media.paged.test",
  name: "paged.test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities,
});

function recordingBackend(answer: "opened" | "declined" = "opened") {
  const calls: { bytes: Uint8Array; request: Parameters<DocumentsBackend["open"]>[1] }[] = [];
  let exports = 0;
  const backend: DocumentsBackend = {
    async exportPaged() {
      exports += 1;
      return new Uint8Array([0x50, 0x4b, 3, 4]);
    },
    async open(bytes, request) {
      calls.push({ bytes, request });
      return answer === "opened"
        ? { opened: true, pageIds: ["p1"] }
        : { opened: false, reason: "declined" };
    },
  };
  return { backend, calls, exports: () => exports };
}

describe("host.documents — D-26 (SDK adapter)", () => {
  const caps = { documents: { export: true, open: true } };

  it("is unsupported and rejects both doors when the host wires no backend", async () => {
    const { host } = createBundleHost(() => makeFakeEditor().editor, manifest(caps), {
      console: silent,
      capabilityMode: "enforce",
    });
    expect(host.supports("documents.open@1")).toBe(false);
    expect(host.supports("documents.exportPaged@1")).toBe(false);
    await expect(host.documents.exportPaged()).rejects.toThrow(/no documents backend/);
    await expect(host.documents.open(new Uint8Array([1]))).rejects.toThrow(
      /no documents backend/,
    );
  });

  it("refuses each door undeclared in 'enforce', per direction", async () => {
    const rec = recordingBackend();
    const exportOnly = createBundleHost(
      () => makeFakeEditor().editor,
      manifest({ documents: { export: true } }),
      { console: silent, capabilityMode: "enforce", documents: rec.backend },
    ).host;
    await expect(exportOnly.documents.exportPaged()).resolves.toBeInstanceOf(Uint8Array);
    await expect(exportOnly.documents.open(new Uint8Array([1]))).rejects.toBeInstanceOf(
      PluginCapabilityError,
    );
    const none = createBundleHost(() => makeFakeEditor().editor, manifest({}), {
      console: silent,
      capabilityMode: "enforce",
      documents: rec.backend,
    }).host;
    await expect(none.documents.exportPaged()).rejects.toBeInstanceOf(PluginCapabilityError);
    expect(rec.calls).toHaveLength(0);
    expect(rec.exports()).toBe(1);
  });

  it("forwards open with the MANIFEST's identity, a trimmed name and a copy of the bytes", async () => {
    const rec = recordingBackend();
    const { host } = createBundleHost(() => makeFakeEditor().editor, manifest(caps), {
      console: silent,
      capabilityMode: "enforce",
      documents: rec.backend,
    });
    expect(host.supports("documents.open@1")).toBe(true);
    expect(host.supports("documents.exportPaged@1")).toBe(true);

    const bytes = new Uint8Array([0x50, 0x4b, 3, 4]);
    const r = await host.documents.open(bytes, { name: "  Catalog (merged)  " });
    expect(r).toEqual({ opened: true, pageIds: ["p1"] });
    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0];
    expect(call.request).toEqual({
      name: "Catalog (merged)",
      requester: { id: "media.paged.test", name: "paged.test" },
    });
    expect(Array.from(call.bytes)).toEqual(Array.from(bytes));
    expect(call.bytes).not.toBe(bytes); // a transferring host cannot detach ours

    await host.documents.open(bytes, { name: "   " });
    expect(rec.calls[1].request.name).toBeNull();
    await expect(host.documents.open(new Uint8Array())).rejects.toThrow(/non-empty/);
  });

  it("passes a decline through as an ordinary answer", async () => {
    const rec = recordingBackend("declined");
    const { host } = createBundleHost(() => makeFakeEditor().editor, manifest(caps), {
      console: silent,
      documents: rec.backend,
    });
    await expect(host.documents.open(new Uint8Array([1]))).resolves.toEqual({
      opened: false,
      reason: "declined",
    });
  });
});

describe("host.text.measureStrings — D-27 (SDK adapter)", () => {
  const metric = (t: string, sizePt: number) => ({
    advance: t.length * sizePt * 0.6,
    ascender: sizePt * 0.75,
    descender: -sizePt * 0.25,
  });

  function editorWith(text: "none" | "single" | "batch") {
    const fake = makeFakeEditor();
    const counts = { measure: 0, measureMany: 0 };
    if (text !== "none") {
      fake.editor.text = {
        async measure(_f, _s, t, sizePt) {
          counts.measure += 1;
          return metric(t, sizePt);
        },
        ...(text === "batch"
          ? {
              async measureMany(_f: string, _s: string | null, texts: readonly string[], sizePt: number) {
                counts.measureMany += 1;
                return texts.map((t) => metric(t, sizePt));
              },
            }
          : {}),
      };
    }
    const { host } = createBundleHost(() => fake.editor, manifest(), { console: silent });
    return { host, counts };
  }

  const words = ["Lorem", "ipsum", "dolor", "sit", "amet"];

  it("is ONE host round-trip when the editor wires measureMany", async () => {
    const { host, counts } = editorWith("batch");
    expect(host.supports("text.measureStrings@1")).toBe(true);
    const out = await host.text.measureStrings("Minion Pro", "Regular", words, 10);
    expect(out).toEqual(words.map((w) => metric(w, 10)));
    expect(counts).toEqual({ measure: 0, measureMany: 1 });
  });

  it("answers exactly what measureString answers, entry by entry", async () => {
    const { host } = editorWith("batch");
    const batch = await host.text.measureStrings("Minion Pro", null, words, 12);
    const single = await Promise.all(
      words.map((w) => host.text.measureString("Minion Pro", null, w, 12)),
    );
    expect(batch).toEqual(single);
  });

  it("fans out to measure (unsupported flag) when no batch backend is wired", async () => {
    const { host, counts } = editorWith("single");
    expect(host.supports("text.measure@1")).toBe(true);
    expect(host.supports("text.measureStrings@1")).toBe(false);
    const out = await host.text.measureStrings("Minion Pro", null, words, 10);
    expect(out).toEqual(words.map((w) => metric(w, 10)));
    expect(counts.measure).toBe(words.length);
  });

  it("falls back to the estimate with no shaper, and [] costs no call", async () => {
    const none = editorWith("none").host;
    const out = await none.text.measureStrings("X", null, ["abcd"], 12);
    expect(out).toEqual([await none.text.measureString("X", null, "abcd", 12)]);
    const batch = editorWith("batch");
    expect(await batch.host.text.measureStrings("X", null, [], 12)).toEqual([]);
    expect(batch.counts.measureMany).toBe(0);
  });

  it("refuses a host answer of the wrong length", async () => {
    const fake = makeFakeEditor();
    fake.editor.text = {
      measure: async () => metric("x", 1),
      measureMany: async () => [metric("x", 1)],
    };
    const { host } = createBundleHost(() => fake.editor, manifest(), { console: silent });
    await expect(host.text.measureStrings("X", null, ["a", "b"], 10)).rejects.toThrow(
      /answered 1 metrics for 2 strings/,
    );
  });
});

// ------------------------------------------------- headless, real engine

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

describe("headless host — documents + measureStrings over the real engine", () => {
  it("exportPaged → open round-trips the document and broadcasts documentLoaded", async () => {
    live = await createHeadlessHost({ console: silent });
    const [pageId] = await live.load(minimalIdml());
    const host = live.host;
    expect(host.supports("documents.open@1")).toBe(true);
    expect(host.supports("documents.exportPaged@1")).toBe(true);

    const bytes = await host.documents.exportPaged();
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x50, 0x4b]); // a ZIP container

    const seen: WorkerToMain["kind"][] = [];
    host.editor.client.subscribe((m) => seen.push(m.kind));
    const r = await host.documents.open(bytes, { name: "Copy" });
    expect(r).toEqual({ opened: true, pageIds: [pageId] });
    expect(seen).toContain("documentLoaded");
    expect(live.openedDocuments()).toEqual([
      { name: "Copy", requester: "media.paged.harness", pageIds: [pageId] },
    ]);
    // The opened copy starts clean, and it is a live document: a mutation
    // applies to it and marks it edited.
    expect((await host.document.meta()).dirty).toBe(false);
    const out = await host.document.mutate({
      op: "insertFrame",
      args: { pageId, bounds: [10, 10, 60, 60] },
    } as never);
    expect(out.applied).toBe(true);
    expect((await host.document.meta()).dirty).toBe(true);
  });

  it("asks before discarding unsaved edits; a decline changes nothing", async () => {
    const asked: unknown[] = [];
    let keep = true;
    live = await createHeadlessHost({
      console: silent,
      confirmReplace: (req) => {
        asked.push(req);
        return !keep;
      },
    });
    const [pageId] = await live.load(minimalIdml());
    const host = live.host;
    const template = await host.documents.exportPaged();

    // Clean document: no question asked.
    expect((await host.documents.open(template)).opened).toBe(true);
    expect(asked).toHaveLength(0);

    await host.document.mutate({
      op: "insertFrame",
      args: { pageId, bounds: [10, 10, 60, 60] },
    } as never);
    const before = (await host.document.collection("pageItems" as never)).length;
    expect(await host.documents.open(template, { name: "Merged" })).toEqual({
      opened: false,
      reason: "declined",
    });
    expect(asked).toEqual([
      { name: "Merged", requester: { id: "media.paged.harness", name: "harness" } },
    ]);
    expect((await host.document.meta()).dirty).toBe(true);
    expect((await host.document.collection("pageItems" as never)).length).toBe(before);

    keep = false;
    expect((await host.documents.open(template)).opened).toBe(true);
    expect((await host.document.meta()).dirty).toBe(false);
  });

  it("rejects bytes that do not load", async () => {
    live = await createHeadlessHost({ console: silent });
    await live.load(minimalIdml());
    await expect(live.host.documents.open(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /headless load failed/,
    );
  });

  it("estimate by default; the engine shaper on request, batch == single", async () => {
    live = await createHeadlessHost({ console: silent });
    expect(live.host.supports("text.measureStrings@1")).toBe(false);
    live.dispose();

    live = await createHeadlessHost({ console: silent, engineShaper: true });
    await live.load(minimalIdml());
    const host = live.host;
    expect(host.supports("text.measure@1")).toBe(true);
    expect(host.supports("text.measureStrings@1")).toBe(true);
    const words = ["Lorem", "ipsum", "dolor", "WWW", "i"];
    const batch = await host.text.measureStrings("Minion Pro", "Regular", words, 12);
    const single = await Promise.all(
      words.map((w) => host.text.measureString("Minion Pro", "Regular", w, 12)),
    );
    expect(batch).toEqual(single);
    expect(batch).toHaveLength(words.length);
  });
});
