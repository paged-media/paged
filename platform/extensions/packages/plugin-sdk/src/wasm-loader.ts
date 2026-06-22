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

// Node loader for the PUBLISHED engine wasm (Decision B): boots
// `@paged-media/canvas-wasm` outside a browser and outside the editor,
// and exposes the SAME `handleMessage` JSON-envelope dispatch the
// editor worker drives (apps/canvas/src/worker/worker.ts). This is the
// missing piece B-13 names: "the engine wasm consumable headless".
//
// MECHANISM. The package ships a wasm-bindgen `--target web` loader
// (`paged_canvas_wasm.js` + `_bg.wasm`). Its async `default()` would
// `fetch(new URL(...))` — fine in a browser, wrong in Node. But the
// loader ALSO exports `initSync({ module })`, which accepts a
// `WebAssembly.Module` OR raw bytes and instantiates synchronously with
// no fetch. So the Node path is: read the `_bg.wasm` bytes off disk,
// `initSync({ module: bytes })`, `new CanvasWorker()`. The only
// Node-hostile import the wasm reaches is `globalThis.crypto.
// getRandomValues`, present on Node ≥ 19 (Web Crypto). No DOM, no GPU
// (the GPU surface methods stay dormant — headless never attaches a
// canvas), no SAB.
//
// PROTOCOL PIN. The wire types this SDK vendors are stamped
// `// Synced from @paged-media/canvas-wasm@<version>` (scripts/
// sync-wire.mjs). The package minor IS the wire protocol
// (`0.<protocol>.<patch>`, editor CLAUDE.md). The loader reads that
// stamp, derives the expected protocol, and asserts the booted wasm's
// `protocolVersion` matches — a wasm/wire skew fails LOUDLY here rather
// than producing silent garbage replies (the conformance harness must
// replay against a TRUE engine, B-13).

// NOTE: the `node:*` builtins this headless loader needs (module / fs /
// path / url) are imported LAZILY, inside the functions that use them —
// never at module top level. The plugin-sdk barrel (index.ts) re-exports
// this file, and the EDITOR imports that barrel for the BROWSER runtime
// (loadBundle, the gesture kit). A top-level `import "node:module"` runs
// when Vite pulls the barrel into the client graph, where `node:module`
// is an externalized stub whose `createRequire` access THROWS — which
// killed the editor's React mount (whole app boot) even though the
// browser never calls a single headless function. Deferring the
// builtins keeps this module import-safe everywhere; the Node-only code
// paths still resolve the real builtins on first call.

/** The published package the headless harness boots. */
export const CANVAS_WASM_PKG = "@paged-media/canvas-wasm";

/** Lazy Node builtins — resolved on first headless call, never at import
 *  (so the browser graph can pull this module without touching them). */
async function nodeBuiltins() {
  const [{ createRequire }, { readFileSync }, path, url] = await Promise.all([
    import("node:module"),
    import("node:fs"),
    import("node:path"),
    import("node:url"),
  ]);
  return {
    createRequire,
    readFileSync,
    dirname: path.dirname,
    resolve: path.resolve,
    fileURLToPath: url.fileURLToPath,
    pathToFileURL: url.pathToFileURL,
  };
}

/**
 * The wasm `CanvasWorker` surface the harness drives. A structural
 * subset of the package's class — only the members the headless host
 * needs. `handleMessage` is the JSON-envelope door; `loadDocumentDirect`
 * is the binary side-channel for IDML bytes (the editor uses it to dodge
 * the 8× `number[]` JSON inflation, and it is the only load path that
 * does not require a `LoadDocument` envelope round-trip).
 */
export interface HeadlessCanvasWorker {
  readonly protocolVersion: number;
  handleMessage(input: string): string;
  loadDocumentDirect(
    seq: number,
    bytes: Uint8Array,
    font?: Uint8Array,
    cmykIccProfile?: Uint8Array,
  ): string;
  runResolveJson(): string | undefined;
  free(): void;
}

interface CanvasWasmModule {
  initSync(module: { module: BufferSource | WebAssembly.Module }): unknown;
  default(input?: unknown): Promise<unknown>;
  CanvasWorker: new () => HeadlessCanvasWorker;
}

export interface LoadedEngine {
  worker: HeadlessCanvasWorker;
  /** The resolved package version (`0.<protocol>.<patch>`). */
  version: string;
  /** The wasm's reported protocol (the package minor). */
  protocolVersion: number;
}

export interface LoadHeadlessEngineOptions {
  /**
   * Where to resolve `@paged-media/canvas-wasm` from. Defaults to this
   * module's own resolution (the SDK's node_modules), then the editor's
   * `packages/client` (the sibling-checkout dev luxury) — mirroring
   * scripts/sync-wire.mjs so the loader and the wire stamp agree on
   * WHICH installed package they describe.
   */
  resolveFrom?: string;
  /**
   * Override the expected protocol the booted wasm must report. Defaults
   * to the protocol derived from the vendored wire stamp. A mismatch
   * throws — never silently downgrades.
   */
  expectedProtocol?: number;
}

const STAMP_PREFIX = `// Synced from ${CANVAS_WASM_PKG}@`;

/** This module's own dir + the vendored wire `.d.ts` path, resolved
 *  lazily (the builtins aren't available at import in the browser). */
async function modulePaths() {
  const { dirname, resolve, fileURLToPath } = await nodeBuiltins();
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    here,
    wireDts: resolve(here, "../../plugin-api/src/wire.d.ts"),
  };
}

/** Extract `@<version>` from the vendored wire stamp, or null. Async:
 *  the file read pulls `node:fs`, deferred so the browser barrel stays
 *  import-safe (only the Node headless path ever calls this). */
export async function readVendoredWireVersion(
  wireDtsPath?: string,
): Promise<string | null> {
  const { readFileSync } = await nodeBuiltins();
  const path = wireDtsPath ?? (await modulePaths()).wireDts;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n", 8)) {
    if (line.startsWith(STAMP_PREFIX)) {
      return line.slice(STAMP_PREFIX.length).trim();
    }
  }
  return null;
}

/** The package minor IS the wire protocol (`0.<protocol>.<patch>`). */
export function protocolFromVersion(version: string): number | null {
  const m = /^\d+\.(\d+)\.\d+/.exec(version.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Resolve the published package's loader JS + `_bg.wasm` on disk.
 * Throws (never warn-skips) when the package cannot be resolved: a
 * headless host with no engine behind it is the exact fiction the
 * harness exists to prevent (B-13).
 */
export async function resolveCanvasWasm(resolveFrom?: string): Promise<{
  loaderUrl: string;
  wasmPath: string;
  version: string;
  dir: string;
}> {
  const { createRequire, readFileSync, dirname, resolve, pathToFileURL } =
    await nodeBuiltins();
  const { here } = await modulePaths();
  // Anchor candidates: this module first (standalone install), then the
  // editor's packages/client (the sync-wire default), then the SDK root.
  const anchors = [
    resolveFrom,
    here,
    resolve(here, "../../../../editor/packages/client"),
    resolve(here, "../../.."),
  ].filter((a): a is string => Boolean(a));

  let lastErr: unknown;
  for (const anchor of anchors) {
    try {
      const req = createRequire(pathToFileURL(resolve(anchor, "package.json")));
      const pkgJsonPath = req.resolve(`${CANVAS_WASM_PKG}/package.json`);
      const dir = dirname(pkgJsonPath);
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
        version?: string;
        main?: string;
      };
      const loaderPath = resolve(dir, pkg.main ?? "paged_canvas_wasm.js");
      const wasmPath = resolve(dir, "paged_canvas_wasm_bg.wasm");
      return {
        loaderUrl: pathToFileURL(loaderPath).href,
        wasmPath,
        version: pkg.version ?? "unknown",
        dir,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `plugin-sdk: ${CANVAS_WASM_PKG} is not resolvable for the headless ` +
      `harness (tried ${anchors.length} anchors). Install it as a ` +
      `devDependency, or run inside a workspace where the editor's ` +
      `packages/client provides it. No warn-skip: a headless host with ` +
      `no real engine is the fiction createHeadlessHost exists to ` +
      `prevent (B-13). Last error: ${String(lastErr)}`,
  );
}

/**
 * Boot the published engine wasm in Node and return a `CanvasWorker`
 * driving the editor's own dispatch. Asserts the booted protocol
 * matches the vendored wire stamp.
 */
export async function loadHeadlessEngine(
  options: LoadHeadlessEngineOptions = {},
): Promise<LoadedEngine> {
  const { readFileSync } = await nodeBuiltins();
  const { loaderUrl, wasmPath, version } = await resolveCanvasWasm(
    options.resolveFrom,
  );
  const mod = (await import(loaderUrl)) as unknown as CanvasWasmModule;
  const bytes = readFileSync(wasmPath);
  // initSync accepts raw bytes (it wraps them in `new WebAssembly.
  // Module(bytes)` when not already a Module) — no fetch, works in Node.
  // Pass a Uint8Array view over the file buffer.
  mod.initSync({
    module: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  });
  const worker = new mod.CanvasWorker();

  const stampedVersion = await readVendoredWireVersion();
  const expectedProtocol =
    options.expectedProtocol ??
    (stampedVersion ? protocolFromVersion(stampedVersion) : null);

  if (
    expectedProtocol !== null &&
    worker.protocolVersion !== expectedProtocol
  ) {
    const booted = worker.protocolVersion;
    // Release the handle, then drop our reference so the
    // FinalizationRegistry can't double-free a manually-freed ptr.
    try {
      worker.free();
    } catch {
      /* best-effort */
    }
    throw new Error(
      `plugin-sdk: headless engine protocol mismatch — booted ` +
        `${CANVAS_WASM_PKG}@${version} reports protocol ` +
        `v${booted}, but the vendored wire types are ` +
        `stamped @${stampedVersion ?? "?"} (protocol v${expectedProtocol}). ` +
        `Re-run scripts/sync-wire.mjs and reinstall the matching package.`,
    );
  }

  return { worker, version, protocolVersion: worker.protocolVersion };
}
