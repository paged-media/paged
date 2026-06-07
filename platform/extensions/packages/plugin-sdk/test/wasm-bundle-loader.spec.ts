// loadBundleWasm — host-side door for a bundle-shipped wasm module
// (W-07). Headless: a hand-assembled wasm fixture + an in-memory asset
// source, no browser, no editor. Pins declared-only access, the host
// grant, the budgets, and the no-ambient-authority instantiation.

import { describe, expect, it } from "vitest";

import type { PagedBundle, PluginManifest } from "@paged-media/plugin-api";

import {
  loadBundleWasm,
  WASM_BUDGETS,
  type BundleAssetSource,
} from "../src/wasm-bundle-loader";

// A minimal VALID wasm module, hand-assembled (verified to compile):
//   (import "env" "memory" (memory 1))
//   (func (export "add") (param i32 i32) (result i32)
//     local.get 0  local.get 1  i32.add)
// imports env.memory (so we exercise host-owned memory) and exports add.
const ADD_WASM = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 2, 15, 1, 3,
  101, 110, 118, 6, 109, 101, 109, 111, 114, 121, 2, 0, 1, 3, 2, 1, 0, 7, 7, 1,
  3, 97, 100, 100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11,
]);

// The 8-byte empty module (magic + version) — a valid module with no
// imports/exports; used to prove plain instantiation needs no ambient
// anything.
const EMPTY_WASM = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);

function bundleWith(wasm: PluginManifest["capabilities"]): PagedBundle {
  const manifest: PluginManifest = {
    id: "media.paged.web",
    name: "paged.web",
    version: "1.0.0",
    apiVersion: "^0.2",
    capabilities: wasm,
  };
  return { manifest, activate: () => ({ dispose() {} }) };
}

/** An in-memory asset base: maps bundle-relative paths to bytes. */
function memSource(map: Record<string, Uint8Array>): BundleAssetSource {
  return (path) => {
    const bytes = map[path];
    if (!bytes) throw new Error(`asset not found: ${path}`);
    return bytes;
  };
}

const LAYOUT_BUNDLE = bundleWith({
  wasm: [{ name: "layout", path: "engine/layout.wasm", purpose: "layout" }],
});

const ASSETS = memSource({ "engine/layout.wasm": ADD_WASM });

describe("loadBundleWasm — declared-only + grant", () => {
  it("loads a declared, granted artifact and instantiates it", async () => {
    const loaded = await loadBundleWasm(LAYOUT_BUNDLE, "layout", {
      assetSource: ASSETS,
      grant: "*",
    });
    expect(loaded.artifact.path).toBe("engine/layout.wasm");
    expect(loaded.byteLength).toBe(ADD_WASM.byteLength);
    // host-owned, non-shared memory was injected (the module imports it).
    expect(loaded.memory).toBeInstanceOf(WebAssembly.Memory);
    // the exported function actually runs.
    const add = loaded.instance.exports.add as (a: number, b: number) => number;
    expect(add(2, 3)).toBe(5);
  });

  it("grant by name set also loads", async () => {
    const loaded = await loadBundleWasm(LAYOUT_BUNDLE, "layout", {
      assetSource: ASSETS,
      grant: new Set(["layout"]),
    });
    expect(loaded.instance).toBeInstanceOf(WebAssembly.Instance);
  });

  it("refuses an UNDECLARED artifact name (declared-only)", async () => {
    await expect(
      loadBundleWasm(LAYOUT_BUNDLE, "secret", {
        assetSource: ASSETS,
        grant: "*",
      }),
    ).rejects.toThrow(/no declared wasm artifact "secret"/);
  });

  it("refuses a declared artifact the host did NOT grant", async () => {
    await expect(
      loadBundleWasm(LAYOUT_BUNDLE, "layout", { assetSource: ASSETS }),
    ).rejects.toThrow(/not granted by the host/);
    // explicit empty grant set is still no-grant.
    await expect(
      loadBundleWasm(LAYOUT_BUNDLE, "layout", {
        assetSource: ASSETS,
        grant: new Set<string>(),
      }),
    ).rejects.toThrow(/not granted/);
  });
});

describe("loadBundleWasm — budgets", () => {
  it("rejects an artifact over the manifest's own maxBytes", async () => {
    const tight = bundleWith({
      wasm: [
        { name: "layout", path: "engine/layout.wasm", purpose: "layout", maxBytes: 8 },
      ],
    });
    await expect(
      loadBundleWasm(tight, "layout", { assetSource: ASSETS, grant: "*" }),
    ).rejects.toThrow(/over its 8-byte ceiling/);
  });

  it("rejects an artifact over the host hard per-artifact ceiling", async () => {
    // A source that returns a buffer larger than the ceiling without
    // allocating it for real: budget is checked on byteLength.
    const huge = new Uint8Array(WASM_BUDGETS.maxArtifactBytes + 1);
    const bundle = bundleWith({
      wasm: [{ name: "big", path: "big.wasm", purpose: "compute" }],
    });
    await expect(
      loadBundleWasm(bundle, "big", {
        assetSource: () => huge,
        grant: "*",
      }),
    ).rejects.toThrow(/over its \d+-byte ceiling/);
  });

  it("aborts when fetch blows the load-time budget", async () => {
    let t = 0;
    const clock = () => t;
    await expect(
      loadBundleWasm(LAYOUT_BUNDLE, "layout", {
        assetSource: () => {
          t += 10_000; // simulate a slow fetch
          return ADD_WASM;
        },
        grant: "*",
        loadTimeBudgetMs: 100,
        now: clock,
      }),
    ).rejects.toThrow(/load-time budget at fetch/);
  });

  it("the memory ceiling is the v1 256 MiB cap (4096 pages)", async () => {
    const loaded = await loadBundleWasm(LAYOUT_BUNDLE, "layout", {
      assetSource: ASSETS,
      grant: "*",
      initialMemoryPages: 1,
    });
    // grow to just under the cap succeeds; one more page throws (cap bites).
    expect(() => loaded.memory!.grow(WASM_BUDGETS.maxMemoryPages - 1)).not.toThrow();
    expect(() => loaded.memory!.grow(1)).toThrow();
  });
});

describe("loadBundleWasm — no ambient authority", () => {
  it("instantiates a no-import module with an empty import object", async () => {
    const bundle = bundleWith({
      wasm: [{ name: "empty", path: "empty.wasm", purpose: "compute" }],
    });
    const loaded = await loadBundleWasm(bundle, "empty", {
      assetSource: memSource({ "empty.wasm": EMPTY_WASM }),
      grant: "*",
      provideMemory: false,
    });
    // No exports, no imports — proves the loader adds nothing implicitly.
    expect(Object.keys(loaded.instance.exports)).toHaveLength(0);
    expect(loaded.memory).toBeUndefined();
  });

  it("a caller-provided memory is used as-is (loader injects nothing)", async () => {
    const mem = new WebAssembly.Memory({ initial: 2, maximum: 4 });
    const loaded = await loadBundleWasm(LAYOUT_BUNDLE, "layout", {
      assetSource: ASSETS,
      grant: "*",
      imports: { env: { memory: mem } },
    });
    // The loader did not create its own memory — it honored the caller's.
    expect(loaded.memory).toBeUndefined();
    const add = loaded.instance.exports.add as (a: number, b: number) => number;
    expect(add(10, 20)).toBe(30);
  });
});
