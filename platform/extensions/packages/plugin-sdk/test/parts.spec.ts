// v51 — the `.paged` CONTAINER parts door (`host.parts`, file-format.md §8).
//
// Coverage:
//   1. write → read round-trips through the v51 wire ops, namespaced to the
//      plugin's own paged/<plugin-id>/ subtree (the host prepends + strips);
//   2. list returns RELATIVE paths within the namespace;
//   3. a path escaping the namespace (`..`) is rejected before any send;
//   4. supports("storage.parts@1") is true (the engine is the writer).

import { describe, expect, it } from "vitest";

import type { PluginManifest } from "@paged-media/plugin-api";

import { createBundleHost } from "../src";
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

const MANIFEST: PluginManifest = {
  id: "media.paged.web",
  name: "web",
  version: "1.0.0",
  apiVersion: "^0.2",
};

function makeHost() {
  // ONE fake-editor instance — its in-memory parts store must persist across
  // the host.parts sends (createBundleHost calls the accessor per send).
  const fake = makeFakeEditor();
  const { host } = createBundleHost(() => fake.editor, MANIFEST, {
    console: silent,
    storage: mapBacking(),
  });
  return { host };
}

describe("host.parts — the .paged container door (v51)", () => {
  it("write → read round-trips, namespaced to the plugin's subtree", async () => {
    const { host } = makeHost();
    expect(await host.parts.read("o1/spec.json")).toBeNull();
    await host.parts.write("o1/spec.json", new Uint8Array([1, 2, 3]));
    expect(Array.from((await host.parts.read("o1/spec.json"))!)).toEqual([1, 2, 3]);
  });

  it("list returns relative paths within the plugin namespace", async () => {
    const { host } = makeHost();
    await host.parts.write("o1/spec.json", new Uint8Array([1]));
    await host.parts.write("o1/values.parquet", new Uint8Array([2, 2]));
    const listed = (await host.parts.list("o1/")).sort();
    expect(listed).toEqual(["o1/spec.json", "o1/values.parquet"]);
  });

  it("rejects a path that escapes the namespace with ..", async () => {
    const { host } = makeHost();
    await expect(
      host.parts.write("../media.paged.data/x.json", new Uint8Array([1])),
    ).rejects.toThrow(/\.\./);
  });

  it("supports(storage.parts@1) is true", () => {
    const { host } = makeHost();
    expect(host.supports("storage.parts@1")).toBe(true);
  });
});
