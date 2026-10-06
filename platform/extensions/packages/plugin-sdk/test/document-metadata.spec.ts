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

// W-21 — document-level plugin metadata: `host.document.getDocumentMetadata`
// / `setDocumentMetadata`, the document twin of the element carrier
// (`getMetadata` / `setMetadata`). Same key (`x-paged:<manifest id>`),
// same envelope, same caller namespace. Coverage: the wire op the write
// sends; the read picks this plugin's own entry out of the document meta
// (and nothing else); the gates; a raw `mutate` cannot reach a foreign
// document key; the flag; and — against the real engine — the write is
// one undoable step that fires `onDidChange`.

import { afterEach, describe, expect, it } from "vitest";

import type { PluginManifest } from "@paged-media/plugin-api";

import { createBundleHost, PluginCapabilityError } from "../src";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { makeFakeEditor } from "./fake-editor";
import { minimalIdml } from "./fixtures/minimal-idml";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const KEY = "x-paged:media.paged.test";

const manifest = (
  capabilities: PluginManifest["capabilities"] = {
    document: { read: "broad", write: "broad" },
  },
): PluginManifest => ({
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities,
});

function makeHost(caps?: PluginManifest["capabilities"]) {
  const fake = makeFakeEditor();
  const handle = createBundleHost(() => fake.editor, manifest(caps), {
    console: silent,
    capabilityMode: "enforce",
  });
  return { ...handle, fake };
}

describe("host.document document metadata (W-21) — the adapter", () => {
  it("writes this plugin's key as one setDocumentMetadata mutation, naming the caller", async () => {
    const { host, fake } = makeHost();
    const out = await host.document.setDocumentMetadata({ v: 1, data: { a: 1 } });
    expect(out.applied).toBe(true);
    expect(fake.mutations).toEqual([
      {
        op: "setDocumentMetadata",
        args: {
          key: KEY,
          value: JSON.stringify({ v: 1, data: { a: 1 } }),
          caller: "media.paged.test",
        },
      },
    ]);
    await host.document.setDocumentMetadata(null);
    expect(fake.mutations[1]).toEqual({
      op: "setDocumentMetadata",
      args: { key: KEY, value: null, caller: "media.paged.test" },
    });
  });

  it("reads only this plugin's entry from the document meta", async () => {
    const { host, fake } = makeHost();
    fake.setDocumentMeta({
      pageCount: 1,
      pluginMetadata: [
        { key: "x-paged:media.paged.other", value: JSON.stringify({ v: 1, data: { theirs: 1 } }) },
        { key: KEY, value: JSON.stringify({ v: 2, data: { mine: true } }) },
      ],
    });
    expect(await host.document.getDocumentMetadata()).toEqual({
      v: 2,
      data: { mine: true },
    });
  });

  it("answers null when absent, when the engine carries no document labels, or when the value is corrupt", async () => {
    const { host, fake } = makeHost();
    fake.setDocumentMeta({ pageCount: 1, pluginMetadata: [] });
    expect(await host.document.getDocumentMetadata()).toBeNull();
    fake.setDocumentMeta({ pageCount: 1 }); // a pre-v69 engine
    expect(await host.document.getDocumentMetadata()).toBeNull();
    fake.setDocumentMeta({ pageCount: 1, pluginMetadata: [{ key: KEY, value: "{nope" }] });
    expect(await host.document.getDocumentMetadata()).toBeNull();
  });

  it("is gated: the read needs document.read, the write document.write", async () => {
    const reader = makeHost({ document: { read: "broad" } });
    await expect(
      makeHost({}).host.document.getDocumentMetadata(),
    ).rejects.toBeInstanceOf(PluginCapabilityError);
    const refused = await reader.host.document.setDocumentMetadata({ v: 1, data: {} });
    expect(refused.applied).toBe(false);
    expect(reader.fake.mutations).toEqual([]);
  });

  it("refuses a raw mutate that names another plugin's document key", async () => {
    const { host, fake } = makeHost();
    const out = await host.document.mutate({
      op: "setDocumentMetadata",
      args: { key: "x-paged:media.paged.other", value: "{}" },
    });
    expect(out.applied).toBe(false);
    expect(out.applied ? "" : out.error).toMatch(/outside this plugin's namespace/);
    const nested = await host.document.mutate({
      op: "batch",
      args: {
        ops: [{ op: "setDocumentMetadata", args: { key: "x-paged:media.paged.other" } }],
      },
    });
    expect(nested.applied).toBe(false);
    expect(fake.mutations).toEqual([]);
  });

  it("supports document.metadata@1", () => {
    expect(makeHost().host.supports("document.metadata@1")).toBe(true);
  });
});

describe("host.document document metadata (W-21) — against the real engine", () => {
  let live: HeadlessHost | null = null;
  afterEach(() => {
    live?.dispose();
    live = null;
  });

  it("is one undoable step that fires onDidChange", async () => {
    live = await createHeadlessHost({ console: silent });
    await live.load(minimalIdml());
    const doc = live.host.document;
    expect(await doc.getDocumentMetadata()).toBeNull();

    let changes = 0;
    doc.onDidChange(() => {
      changes += 1;
    });
    const out = await doc.setDocumentMetadata({ v: 1, data: { values: { title: "A" } } });
    expect(out.applied).toBe(true);
    expect(changes).toBe(1);
    expect(await doc.getDocumentMetadata()).toEqual({
      v: 1,
      data: { values: { title: "A" } },
    });

    await doc.setDocumentMetadata({ v: 1, data: { values: { title: "B" } } });
    await doc.undo();
    expect(await doc.getDocumentMetadata()).toEqual({
      v: 1,
      data: { values: { title: "A" } },
    });
    await doc.undo();
    expect(await doc.getDocumentMetadata()).toBeNull();
    await doc.redo();
    expect((await doc.getDocumentMetadata())?.data).toEqual({ values: { title: "A" } });
    expect(changes).toBeGreaterThanOrEqual(5);
  });

  it("the engine refuses an envelope that is not one", async () => {
    live = await createHeadlessHost({ console: silent });
    await live.load(minimalIdml());
    const out = await live.host.document.mutate({
      op: "setDocumentMetadata",
      args: { key: KEY, value: "[1,2]", caller: "media.paged.test" },
    });
    expect(out.applied).toBe(false);
  });
});
