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

// W-22 — `host.document.onDidOpen`: the document-opened event, so a
// bundle stops listening to the raw client `documentLoaded` through
// `host.editor`. Coverage: the payload is the clonable page snapshot;
// other messages do not fire it; the doc-read gate; dispose; a throwing
// listener is contained; the static flag; and the headless harness
// fires it on `load()` against the real engine.

import { describe, expect, it } from "vitest";

import type { DocumentOpenedEvent, PluginManifest } from "@paged-media/plugin-api";

import { createBundleHost, PluginCapabilityError } from "../src";
import { createHeadlessHost } from "../src/harness";
import { makeFakeEditor } from "./fake-editor";
import { minimalIdml } from "./fixtures/minimal-idml";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const manifest = (
  capabilities: PluginManifest["capabilities"] = { document: { read: "broad" } },
): PluginManifest => ({
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities,
});

const loaded = {
  kind: "documentLoaded",
  seq: 3,
  payload: {
    docId: "d1",
    pageCount: 2,
    pageIds: ["p1", "p2"],
    pageSizesPt: [
      [612, 792],
      [612, 792],
    ],
    stats: { spreads: 1 },
    rulerGuides: [],
  },
};

describe("host.document.onDidOpen (W-22)", () => {
  it("fires on documentLoaded with the page snapshot, and only on it", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, manifest(), {
      console: silent,
      capabilityMode: "enforce",
    });
    const seen: DocumentOpenedEvent[] = [];
    host.document.onDidOpen((e) => seen.push(e));
    fake.emit({ kind: "mutationApplied", payload: { pageIds: ["p1"] } });
    fake.emit({ kind: "loadFailed", payload: { error: { kind: "parse" } } });
    expect(seen).toEqual([]);
    fake.emit(loaded);
    expect(seen).toEqual([
      {
        docId: "d1",
        pageCount: 2,
        pageIds: ["p1", "p2"],
        pageSizesPt: [
          [612, 792],
          [612, 792],
        ],
      },
    ]);
    // A snapshot, not the host's reply object.
    expect(seen[0].pageIds).not.toBe(loaded.payload.pageIds);
  });

  it("dispose unsubscribes, and the bundle teardown does too", () => {
    const fake = makeFakeEditor();
    const { host, dispose } = createBundleHost(() => fake.editor, manifest(), {
      console: silent,
    });
    let n = 0;
    const d = host.document.onDidOpen(() => n++);
    host.document.onDidOpen(() => n++);
    d.dispose();
    fake.emit(loaded);
    expect(n).toBe(1);
    dispose();
    fake.emit(loaded);
    expect(n).toBe(1);
  });

  it("contains a throwing listener (the next one still runs)", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, manifest(), {
      console: silent,
    });
    let reached = false;
    host.document.onDidOpen(() => {
      throw new Error("boom");
    });
    host.document.onDidOpen(() => {
      reached = true;
    });
    expect(() => fake.emit(loaded)).not.toThrow();
    expect(reached).toBe(true);
  });

  it("is gated on document.read and advertised statically", () => {
    const fake = makeFakeEditor();
    const { host } = createBundleHost(() => fake.editor, manifest({}), {
      console: silent,
      capabilityMode: "enforce",
    });
    expect(() => host.document.onDidOpen(() => {})).toThrow(PluginCapabilityError);
    expect(host.supports("document.onDidOpen@1")).toBe(true);
  });

  it("the headless harness fires it when a document loads", async () => {
    const h = await createHeadlessHost({ console: silent });
    try {
      const seen: DocumentOpenedEvent[] = [];
      h.host.document.onDidOpen((e) => seen.push(e));
      const pageIds = await h.load(minimalIdml());
      expect(seen).toHaveLength(1);
      expect(seen[0].pageIds).toEqual(pageIds);
      expect(seen[0].pageCount).toBe(pageIds.length);
      expect(seen[0].pageSizesPt).toHaveLength(pageIds.length);
      await h.load(minimalIdml());
      expect(seen).toHaveLength(2);
    } finally {
      h.dispose();
    }
  });
});
