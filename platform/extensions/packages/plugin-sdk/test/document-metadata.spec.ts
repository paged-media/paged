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

// Document-scoped plugin metadata (`host.document.getDocumentMetadata` /
// `setDocumentMetadata`, flag `document.documentMetadata@1`): what
// `protocol-69-doors.spec.ts` does not already cover. The adapter: a
// corrupt value reads as absent, and the capability gates. Against the
// real engine: the write is one undoable step that fires `onDidChange`,
// and the engine refuses a value that is not an envelope.

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

describe("host.document document metadata — the adapter", () => {
  it("answers null when the stored value is corrupt", async () => {
    const { host, fake } = makeHost();
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
});

describe("host.document document metadata — against the real engine", () => {
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
