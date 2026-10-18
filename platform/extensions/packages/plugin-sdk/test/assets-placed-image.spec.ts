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

// C-5 / I-04 — `host.assets.getPlacedImage` against the REAL published
// engine (canvas-wasm ≥ 0.42.0, protocol v42). Pins: the feature probe,
// the capability gate (images undeclared → the read door throws), and
// the honest null path through the live `requestPlacedAssetBytes` wire
// round-trip (the fixture's rectangle places no image → `found:false`
// → `null`). The bytes-positive path needs a fixture with a resolvable
// placed image — that lands with the image-plugin M4 conformance corpus
// (campaign Phase 2a); THIS file proves the door, the gate and the wire.

import { afterEach, describe, expect, it } from "vitest";

import type { PagedBundle, PluginManifest } from "@paged-media/plugin-api";

import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { defineBundle } from "../src/define-bundle";
import { minimalIdml } from "./fixtures/minimal-idml";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const mapBacking = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => Array.from(m.keys()),
  };
};

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

function bundle(id: string, withImages: boolean): PagedBundle {
  const manifest: PluginManifest = {
    id,
    name: id,
    version: "1.0.0",
    apiVersion: "^0.2",
    capabilities: {
      document: { read: "broad", write: "broad" },
      ...(withImages ? { assets: ["images"] } : {}),
    },
    contributes: {},
  };
  return defineBundle({ manifest, activate: () => ({ dispose() {} }) });
}

describe("host.assets.getPlacedImage (C-5, engine-served)", () => {
  it("probes assets.images@1 and answers null for a non-image frame (live wire)", async () => {
    live = await createHeadlessHost({ console: silent, storage: mapBacking() });
    await live.load(minimalIdml());
    live.loadBundle(bundle("media.paged.c5", true));
    expect(live.host.supports("assets.images@1")).toBe(true);
    // The fixture rectangle links no image: the engine answers
    // found:false over the real v42 wire; the door maps it to null.
    const asset = await live.host.assets.getPlacedImage("urect");
    expect(asset).toBeNull();
    // An unknown element is the same honest null, not a throw.
    expect(await live.host.assets.getPlacedImage("nope")).toBeNull();
  });

  it("gates on capabilities.assets ∋ images (undeclared → the read door throws)", async () => {
    live = await createHeadlessHost({ console: silent, storage: mapBacking() });
    await live.load(minimalIdml());
    live.loadBundle(bundle("media.paged.c5gate", false));
    await expect(
      live.host.assets.getPlacedImage("urect"),
    ).rejects.toThrow(/assets/);
  });
});

describe("host.document.elementProperties (B-19, typed read)", () => {
  it("returns the engine's property snapshot for a frame; null on miss", async () => {
    live = await createHeadlessHost({ console: silent, storage: mapBacking() });
    await live.load(minimalIdml());
    live.loadBundle(bundle("media.paged.b19", true));
    const props = await live.host.document.elementProperties({
      kind: "rectangle",
      id: "urect",
    } as never);
    expect(props).not.toBeNull();
    expect(Array.isArray(props!.entries)).toBe(true);
    expect(props!.entries.length).toBeGreaterThan(0);
    expect(
      await live.host.document.elementProperties({
        kind: "rectangle",
        id: "nope",
      } as never),
    ).toBeNull();
  });
});

describe("host.document.placeholders (D-01, protocol v43)", () => {
  it("insert → enumerate → setFieldValue → re-enumerate, live engine", async () => {
    live = await createHeadlessHost({ console: silent, storage: mapBacking() });
    await live.load(minimalIdml());
    live.loadBundle(bundle("media.paged.d01", true));
    expect(live.host.supports("document.placeholders@1")).toBe(true);
    expect(await live.host.document.placeholders()).toEqual([]);

    // The fixture has a text frame? minimal-idml carries a rectangle
    // only — pour a placeholder into a FRESH frame's minted story
    // (the v0.42.1 story-mint makes this addressable).
    const frame = await live.host.document.mutate({
      op: "insertTextFrame",
      args: { pageId: "usp", bounds: [300, 300, 360, 460] },
    } as never);
    expect(frame.applied).toBe(true);
    const items0 = await live.host.document.placeholders();
    expect(items0).toEqual([]); // a frame alone carries no fields

    // Find the minted story via the stories collection (single story).
    const stories = await live.host.document.collection<{ selfId: string }>(
      "stories",
    );
    expect(stories.length).toBe(1);
    const storyId = stories[0].selfId;

    const ins = await live.host.document.mutate({
      op: "insertField",
      args: {
        storyId,
        offset: 0,
        field: {
          placeholder: { plugin: "media.paged.d01", key: "price", value: null },
        },
      },
    } as never);
    expect(ins.applied).toBe(true);

    const items1 = await live.host.document.placeholders();
    expect(items1.length).toBe(1);
    expect(items1[0]).toMatchObject({
      storyId,
      plugin: "media.paged.d01",
      key: "price",
      value: null,
    });

    const set = await live.host.document.mutate({
      op: "setFieldValue",
      args: { storyId, offset: items1[0].offset, value: "€ 9,99" },
    } as never);
    expect(set.applied).toBe(true);
    const items2 = await live.host.document.placeholders();
    expect(items2[0].value).toBe("€ 9,99");

    // Undo unwinds the resolution (one undoable step).
    await live.host.document.undo();
    const items3 = await live.host.document.placeholders();
    expect(items3[0].value).toBeNull();
  });
});
