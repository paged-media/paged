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

// loadBundleWasm — the host-side door for a bundle-shipped WebAssembly
// module (paged.web W-07: e.g. a future HTML/CSS layout engine compiled
// to wasm). This is the LOADER half of the W-07 design (DESIGN.md §10,
// docs/wasm-packaging.md): given a bundle + a logical artifact name, it
//
//   1. resolves the artifact from `manifest.capabilities.wasm` —
//      UNDECLARED names are refused (declared-only is the contract);
//   2. checks the host GRANT — a name the host did not grant is refused
//      (capability gating, same shape as `host.supports`/manifest caps);
//   3. fetches the bytes through a caller-injected `assetSource` (the
//      bundle's asset base — a URL fetcher in the browser, a file read
//      in Node/tests). The loader never invents a fetch path itself;
//   4. enforces the BUDGETS (per-artifact byte ceiling tightened by the
//      manifest's own `maxBytes`, a wall-clock load-time budget, and a
//      memory-growth ceiling passed to the wasm's `WebAssembly.Memory`);
//   5. instantiates with NO ambient authority: the only imports the
//      module gets are the ones the caller explicitly passes. There is
//      no implicit engine / DOM / network handle — the wasm talks only
//      through the bundle's already-gated JS. Threads / SharedArrayBuffer
//      are OFF in v1 (the host-owned memory is non-shared).
//
// Headlessly testable: pass an in-memory `assetSource` and a hand-built
// wasm byte fixture; no browser, no editor wiring.

import type { PagedBundle, WasmArtifact } from "@paged-media/plugin-api";

/** WASM packaging budgets (v1). Rationale in docs/wasm-packaging.md.
 *  KEEP IN SYNC with plugin-cli's WASM_MAX_* and the schema's `maxBytes`
 *  maximum — the CLI hand-mirrors the contract. */
export const WASM_BUDGETS = {
  /** Hard per-artifact byte ceiling for layout/codec/compute. A
   *  release-optimised wasm layout engine (Blitz-class) lands in the
   *  low-single-digit MiB; 8 MiB rejects an accidentally-bundled debug
   *  build while leaving headroom for one real engine. A manifest
   *  `maxBytes` may only TIGHTEN this. */
  maxArtifactBytes: 8 * 1024 * 1024,
  /** D-07b — the governed HIGHER ceiling for `purpose: "engine"` (a
   *  vendored DB/query engine like DuckDB-WASM ≈ 36 MiB). 64 MiB fits the
   *  real artifacts with headroom; still a hard cap a manifest may only
   *  tighten. Only the `engine` purpose earns it. */
  maxEngineArtifactBytes: 64 * 1024 * 1024,
  /** Total declared wasm across one bundle. Sized so one `engine`
   *  artifact + a codec fit. */
  maxTotalBytes: 80 * 1024 * 1024,
  /** Wall-clock budget for fetch + compile + instantiate. Protects the
   *  editor's main flow from a pathological module; advisory, the loader
   *  aborts with a clear error when exceeded. */
  loadTimeBudgetMs: 3000,
  /** Linear-memory growth ceiling, in 64 KiB wasm pages (4096 = 256 MiB).
   *  Passed as `WebAssembly.Memory({ maximum })` when the host owns the
   *  memory; a per-page layout pass should sit far under this. */
  maxMemoryPages: 4096,
} as const;

/** A loaded bundle wasm module + the resources the host owns for it. */
export interface LoadedBundleWasm {
  /** The artifact descriptor it was loaded from. */
  artifact: WasmArtifact;
  module: WebAssembly.Module;
  instance: WebAssembly.Instance;
  /** The host-owned, non-shared memory the module was given (when the
   *  host provided one — see `provideMemory`). */
  memory?: WebAssembly.Memory;
  /** Compiled byte length (post-budget-check, for telemetry). */
  byteLength: number;
}

/** How the loader reads a bundle-relative asset. The host supplies this
 *  (a URL fetch rooted at the bundle's asset base in the browser; a file
 *  read in Node/tests). The loader passes ONLY the declared `path`. */
export type BundleAssetSource = (
  path: string,
) => Promise<Uint8Array> | Uint8Array;

export interface LoadBundleWasmOptions {
  /** Reads the declared artifact's bytes (required). */
  assetSource: BundleAssetSource;
  /**
   * The host grant. A wasm artifact loads only if the host has granted
   * it — `"*"` grants all declared artifacts; a `Set`/array grants by
   * name. ABSENT means NO grant (refuse): wasm is opt-in, never ambient.
   */
  grant?: "*" | ReadonlyArray<string> | ReadonlySet<string>;
  /**
   * Import object handed to the module at instantiation. The loader adds
   * NOTHING implicitly — if `provideMemory` is true and the imports omit
   * `env.memory`, a host-owned bounded `WebAssembly.Memory` is injected;
   * otherwise the module is on its own (no ambient engine/DOM/network).
   */
  imports?: WebAssembly.Imports;
  /**
   * When true (default), the loader owns linear memory: it creates a
   * non-shared `WebAssembly.Memory` bounded by `maxMemoryPages` and
   * injects it as `imports.env.memory` if not already present. Set false
   * to let a module declare its own (still non-shared) memory.
   */
  provideMemory?: boolean;
  /** Initial pages for the host-owned memory (default 16 = 1 MiB). */
  initialMemoryPages?: number;
  /** Override the load-time budget (ms). */
  loadTimeBudgetMs?: number;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

function findArtifact(
  bundle: PagedBundle,
  name: string,
): WasmArtifact | undefined {
  return bundle.manifest.capabilities?.wasm?.find((a) => a.name === name);
}

function isGranted(
  grant: LoadBundleWasmOptions["grant"],
  name: string,
): boolean {
  if (grant === undefined) return false;
  if (grant === "*") return true;
  if (Array.isArray(grant)) return grant.includes(name);
  return (grant as ReadonlySet<string>).has(name);
}

/**
 * Load a bundle-declared wasm artifact, enforcing declared-only access,
 * the host grant, and the v1 budgets. Resolves to the instantiated
 * module; rejects (loudly) on an undeclared name, a missing grant, an
 * over-budget artifact, or a load-time overrun.
 */
export async function loadBundleWasm(
  bundle: PagedBundle,
  name: string,
  options: LoadBundleWasmOptions,
): Promise<LoadedBundleWasm> {
  const id = bundle.manifest.id;
  const artifact = findArtifact(bundle, name);
  if (!artifact) {
    throw new Error(
      `loadBundleWasm: ${id} has no declared wasm artifact "${name}" — ` +
        `only artifacts listed in manifest.capabilities.wasm are ` +
        `loadable (declared-only).`,
    );
  }
  if (!isGranted(options.grant, name)) {
    throw new Error(
      `loadBundleWasm: wasm artifact "${name}" of ${id} is not granted by ` +
        `the host — wasm carries no ambient authority; the host must grant ` +
        `it explicitly (pass grant: "*" or a name set).`,
    );
  }

  const now = options.now ?? (() => Date.now());
  const budgetMs = options.loadTimeBudgetMs ?? WASM_BUDGETS.loadTimeBudgetMs;
  const started = now();
  const overBudget = (stage: string): never => {
    throw new Error(
      `loadBundleWasm: "${name}" of ${id} exceeded the ${budgetMs}ms ` +
        `load-time budget at ${stage} (${Math.round(now() - started)}ms).`,
    );
  };

  // 1. fetch bytes through the bundle's asset base (declared path only).
  const bytes = await options.assetSource(artifact.path);
  if (now() - started > budgetMs) overBudget("fetch");
  // Normalize to a plain-ArrayBuffer-backed view (WebAssembly.compile's
  // BufferSource rejects a possibly-SharedArrayBuffer-backed view under
  // strict lib typings; we own non-shared memory only — §3).
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new Uint8Array(src.byteLength);
  view.set(src);

  // 2. byte-budget gate — host hard ceiling, tightened by the manifest's
  //    own maxBytes (the stricter wins). D-07b: a `purpose: "engine"`
  //    artifact earns the higher governed ceiling; everything else stays
  //    at the default 8 MiB.
  const hostCeiling =
    artifact.purpose === "engine"
      ? WASM_BUDGETS.maxEngineArtifactBytes
      : WASM_BUDGETS.maxArtifactBytes;
  const ceiling =
    typeof artifact.maxBytes === "number" && artifact.maxBytes > 0
      ? Math.min(artifact.maxBytes, hostCeiling)
      : hostCeiling;
  if (view.byteLength > ceiling) {
    throw new Error(
      `loadBundleWasm: "${name}" of ${id} is ${view.byteLength} bytes, over ` +
        `its ${ceiling}-byte ceiling.`,
    );
  }

  // 3. host-owned, non-shared memory (no SAB/threads in v1).
  let memory: WebAssembly.Memory | undefined;
  const imports: WebAssembly.Imports = { ...(options.imports ?? {}) };
  const provideMemory = options.provideMemory ?? true;
  if (provideMemory) {
    const env = { ...(imports.env as Record<string, unknown> | undefined) };
    if (!("memory" in env)) {
      memory = new WebAssembly.Memory({
        initial: options.initialMemoryPages ?? 16,
        maximum: WASM_BUDGETS.maxMemoryPages,
        // shared is intentionally absent — non-shared memory only (v1).
      });
      env.memory = memory;
    }
    imports.env = env as WebAssembly.ModuleImports;
  }

  // 4. compile + instantiate within the remaining load-time budget.
  const module = await WebAssembly.compile(view);
  if (now() - started > budgetMs) overBudget("compile");
  const instance = await WebAssembly.instantiate(module, imports);
  if (now() - started > budgetMs) overBudget("instantiate");

  return { artifact, module, instance, memory, byteLength: view.byteLength };
}
