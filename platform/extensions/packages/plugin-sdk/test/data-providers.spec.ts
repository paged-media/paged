// D-09 — the cross-plugin DATA-PROVIDER registry (`host.dataProviders`).
//
// Coverage:
//   1. rendezvous: a PROVIDER host registers; a CONSUMER host (a DIFFERENT
//      plugin, sharing the injected registry) discovers + reads the snapshot —
//      the §7.1 composition without any inter-plugin contact;
//   2. no identity leak: discovery is by category; the info carries no backing
//      plugin identity;
//   3. the gate: register without `publish`, discover/get without `consume` are
//      refused (PluginCapabilityError in 'enforce');
//   4. onDidChange: the provider's revision bump fans out to the consumer (sync
//      flows through the contract);
//   5. graceful absence: no shared registry wired → discover empty, register a
//      no-op, supports("dataProviders@1") false.

import { describe, expect, it } from "vitest";

import type { PluginManifest, ProviderRecordSet } from "@paged-media/plugin-api";

import {
  createBundleHost,
  createDataProviderRegistry,
  PluginCapabilityError,
  type DataProviderBackend,
} from "../src";
import { makeFakeEditor } from "./fake-editor";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

const PROVIDER: PluginManifest = {
  id: "media.paged.data",
  name: "data",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { dataProviders: { publish: ["dataset"] } },
};
const CONSUMER: PluginManifest = {
  id: "media.paged.sheet",
  name: "sheet",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { dataProviders: { consume: ["dataset"] } },
};
const NEITHER: PluginManifest = {
  id: "media.paged.x",
  name: "x",
  version: "1.0.0",
  apiVersion: "^0.2",
};

const recordSet = (): ProviderRecordSet => ({
  schema: { fields: [{ name: "sku", ty: "text", nullable: true }] },
  columns: [["A-1", "B-2"]],
  rowCount: 2,
});

function host(
  manifest: PluginManifest,
  dataProviders?: DataProviderBackend,
  capabilityMode: "enforce" | "warn" = "enforce",
) {
  return createBundleHost(() => makeFakeEditor().editor, manifest, {
    console: silent,
    dataProviders,
    capabilityMode,
  }).host;
}

describe("host.dataProviders — cross-plugin data-provider registry (D-09)", () => {
  it("rendezvous: a provider registers and a consumer (different host, shared registry) reads it", async () => {
    const registry = createDataProviderRegistry();
    const provider = host(PROVIDER, registry);
    const consumer = host(CONSUMER, registry);

    provider.dataProviders.register({
      id: "fct_products",
      category: "dataset",
      schema: recordSet().schema,
      revision: "rev-1",
      getSnapshot: () => recordSet(),
    });

    const found = consumer.dataProviders.discover("dataset");
    expect(found.map((p) => p.id)).toEqual(["fct_products"]);
    expect(found[0].revision).toBe("rev-1");

    const snap = await consumer.dataProviders.get("fct_products");
    expect(snap?.revision).toBe("rev-1");
    expect(snap?.records.rowCount).toBe(2);
    expect(snap?.records.schema.fields[0].ty).toBe("text");
  });

  it("discovery is by category and leaks no backing-plugin identity", () => {
    const registry = createDataProviderRegistry();
    host(PROVIDER, registry).dataProviders.register({
      id: "d1",
      category: "dataset",
      schema: recordSet().schema,
      revision: "r",
      getSnapshot: recordSet,
    });
    const info = host(CONSUMER, registry).dataProviders.discover("dataset")[0];
    expect(Object.keys(info).sort()).toEqual(["category", "id", "revision", "schema"]);
  });

  it("gate: register needs publish, discover/get need consume (PluginCapabilityError in enforce)", async () => {
    const registry = createDataProviderRegistry();
    const neither = host(NEITHER, registry);
    expect(() =>
      neither.dataProviders.register({
        id: "x",
        category: "dataset",
        schema: recordSet().schema,
        revision: "r",
        getSnapshot: recordSet,
      }),
    ).toThrow(PluginCapabilityError);
    expect(() => neither.dataProviders.discover("dataset")).toThrow(PluginCapabilityError);
    await expect(neither.dataProviders.get("x")).rejects.toBeInstanceOf(PluginCapabilityError);
  });

  it("onDidChange fans the provider's revision bump out to the consumer", () => {
    const registry = createDataProviderRegistry();
    const handle = host(PROVIDER, registry).dataProviders.register({
      id: "d1",
      category: "dataset",
      schema: recordSet().schema,
      revision: "r1",
      getSnapshot: recordSet,
    });
    const consumer = host(CONSUMER, registry);
    const seen: string[] = [];
    consumer.dataProviders.onDidChange("d1", (rev) => seen.push(rev));
    handle.update("r2");
    handle.update("r3");
    expect(seen).toEqual(["r2", "r3"]);
    expect(consumer.dataProviders.discover("dataset")[0].revision).toBe("r3");
  });

  it("graceful absence: no registry wired → discover empty, register a no-op, supports false", () => {
    const provider = host(PROVIDER); // no registry injected
    expect(provider.supports("dataProviders@1")).toBe(false);
    const h = provider.dataProviders.register({
      id: "d1",
      category: "dataset",
      schema: recordSet().schema,
      revision: "r",
      getSnapshot: recordSet,
    });
    expect(() => h.update("r2")).not.toThrow();
    expect(host(CONSUMER).dataProviders.discover("dataset")).toEqual([]);
  });

  it("supports('dataProviders@1') is true once a registry is wired", () => {
    expect(host(PROVIDER, createDataProviderRegistry()).supports("dataProviders@1")).toBe(true);
  });
});
