// K-4 / S-08 — the capability-gated BINARY blob store (`host.blob`).
//
// Coverage:
//   1. the door: write/read/delete/keys round-trip through the injected
//      backend; overwrite replaces (usage doesn't double-count);
//   2. the gate: a manifest WITHOUT `capabilities.storage: { blob: true }`
//      is refused — throw in 'enforce', warn+proceed in 'warn';
//   3. the quota: a write over the granted ceiling rejects; the manifest's
//      quotaBytes only tightens the host default;
//   4. the no-store door: no backend → read null / keys [] / usage 0,0;
//      write rejects (the honest no-store posture); supports() is false.

import { describe, expect, it } from "vitest";

import type { PluginManifest } from "@paged-media/plugin-api";

import {
  BLOB_BUDGETS,
  createBundleHost,
  PluginCapabilityError,
  type BlobStore,
} from "../src";
import { inMemoryBlobStore } from "../src/harness";
import { makeFakeEditor } from "./fake-editor";

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

const DECLARED: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { storage: { blob: true } },
};
const TINY: PluginManifest = {
  ...DECLARED,
  capabilities: { storage: { blob: true, quotaBytes: 8 } },
};
const UNDECLARED: PluginManifest = {
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
};

function makeHost(
  manifest: PluginManifest,
  blobStore?: BlobStore,
  capabilityMode: "enforce" | "warn" = "enforce",
  console = silent,
) {
  return createBundleHost(() => makeFakeEditor().editor, manifest, {
    console,
    storage: mapBacking(),
    capabilityMode,
    blobStore,
  });
}

describe("host.blob — the door (K-4)", () => {
  it("round-trips bytes through the injected backend", async () => {
    const { host } = makeHost(DECLARED, inMemoryBlobStore());
    expect(await host.blob.read("wb")).toBeNull();

    await host.blob.write("wb", new Uint8Array([1, 2, 3]));
    expect(Array.from((await host.blob.read("wb"))!)).toEqual([1, 2, 3]);
    expect(await host.blob.keys()).toEqual(["wb"]);

    await host.blob.delete("wb");
    expect(await host.blob.read("wb")).toBeNull();
    expect(await host.blob.keys()).toEqual([]);
  });

  it("overwrite replaces (usage does not double-count)", async () => {
    const { host } = makeHost(DECLARED, inMemoryBlobStore());
    await host.blob.write("wb", new Uint8Array(10));
    expect((await host.blob.usage()).used).toBe(10);
    await host.blob.write("wb", new Uint8Array(3));
    expect((await host.blob.usage()).used).toBe(3);
  });

  it("usage reports the granted quota (host default by default)", async () => {
    const { host } = makeHost(DECLARED, inMemoryBlobStore());
    expect((await host.blob.usage()).quota).toBe(
      BLOB_BUDGETS.defaultQuotaBytes,
    );
  });
});

describe("host.blob — the quota (K-4)", () => {
  it("a manifest quotaBytes tightens the ceiling and rejects an over-write", async () => {
    const { host } = makeHost(TINY, inMemoryBlobStore());
    expect((await host.blob.usage()).quota).toBe(8);
    await host.blob.write("ok", new Uint8Array(8)); // exactly the cap
    await expect(
      host.blob.write("over", new Uint8Array(1)),
    ).rejects.toThrow(/quota/);
  });
});

describe("host.blob — the gate (K-4)", () => {
  it("throws in enforce mode when storage.blob is not declared", async () => {
    const { host } = makeHost(UNDECLARED, inMemoryBlobStore(), "enforce");
    await expect(host.blob.write("wb", new Uint8Array(1))).rejects.toBeInstanceOf(
      PluginCapabilityError,
    );
  });

  it("warns + proceeds in warn mode when undeclared", async () => {
    let warned = 0;
    const { host } = makeHost(UNDECLARED, inMemoryBlobStore(), "warn", {
      ...silent,
      warn: () => void (warned += 1),
    });
    await host.blob.write("wb", new Uint8Array([9]));
    expect(Array.from((await host.blob.read("wb"))!)).toEqual([9]);
    expect(warned).toBeGreaterThan(0);
  });
});

describe("host.blob — the no-store door (K-4)", () => {
  it("reads empty + write rejects when no backend is wired", async () => {
    const { host } = makeHost(DECLARED); // no blobStore injected
    expect(host.supports("storage.blob@1")).toBe(false);
    expect(await host.blob.read("wb")).toBeNull();
    expect(await host.blob.keys()).toEqual([]);
    expect(await host.blob.usage()).toEqual({ used: 0, quota: 0 });
    await expect(host.blob.write("wb", new Uint8Array(1))).rejects.toThrow(
      /no blob store/,
    );
  });

  it("supports('storage.blob@1') tracks whether a backend is wired", () => {
    expect(makeHost(DECLARED).host.supports("storage.blob@1")).toBe(false);
    expect(
      makeHost(DECLARED, inMemoryBlobStore()).host.supports("storage.blob@1"),
    ).toBe(true);
  });
});
