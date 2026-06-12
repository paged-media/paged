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
      document: { read: "broad" },
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
