/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// How a built-in module boots its engine wasm: once per realm, in the
// browser and under Node (docs/adr/PM-0002: internal shared code, never part
// of the extension contract).
//
// THE RACE THIS GUARDS. A wasm-bindgen `--target web` glue keeps ONE
// module-level instance. Its async `default()` checks "already initialised"
// BEFORE its first await, so two boots in flight at once both pass the check,
// both instantiate, and the second replaces the instance. An engine object
// built on the first then reads the second's memory with its own pointers
// ("memory access out of bounds", seen in paged.sheet when a reopened
// document restored on activation and on `documentLoaded`). Every boot of a
// module therefore shares one promise; a failed boot is forgotten, so a later
// call retries.
//
// WHY THUNKS. The bundler only rewrites an import it can read: the glue's
// `import("../bin/x.js")` and the asset's `import("../bin/x_bg.wasm?url")`
// must stay literal in the module's own file, relative to it. The module
// passes them here as thunks; this file never builds a specifier.

/** A load that runs at most once at a time and is remembered once it
 *  succeeds. Call it to get the shared promise. */
export interface SingleFlight<T, A extends unknown[] = []> {
  (...args: A): Promise<T>;
  /** Forget the remembered result (tests; a deliberate re-boot). A flight
   *  still running is not cancelled: its callers keep their promise. */
  reset(): void;
}

/**
 * Wrap `load` so that concurrent callers share one promise. The first call
 * starts the load with its arguments; every call until it settles, and every
 * call after it resolved, gets the same promise. A rejection is forgotten
 * (only if it is still the remembered flight), so the next call starts a new
 * load.
 */
export function singleFlight<T, A extends unknown[] = []>(
  load: (...args: A) => Promise<T>,
): SingleFlight<T, A> {
  let flight: Promise<T> | null = null;
  const run = (...args: A): Promise<T> => {
    if (flight) return flight;
    const started = Promise.resolve()
      .then(() => load(...args))
      .catch((err: unknown) => {
        if (flight === started) flight = null;
        throw err;
      });
    flight = started;
    return started;
  };
  return Object.assign(run, {
    reset(): void {
      flight = null;
    },
  });
}

/** True under Node and Bun (the unit tests, the headless host, the Node
 *  CLI; Bun sets `process.versions.node`), false in a browser realm. */
export function isNodeRealm(): boolean {
  return (
    typeof process !== "undefined" &&
    (process as { versions?: { node?: string } }).versions?.node != null
  );
}

/** The two entry points every wasm-bindgen `--target web` glue exports. */
export interface WasmBindgenGlue {
  default(init?: { module_or_path: unknown }): Promise<unknown>;
  initSync?(init: { module: BufferSource | WebAssembly.Module }): unknown;
}

/** Where a module's wasm is, written in the module's own file. */
export interface WasmSource {
  /** BROWSER: the bundler's asset URL, as a literal thunk:
   *  `() => import("../bin/x_bg.wasm?url")`. A bare relative URL resolves
   *  against the served module path and gets the dev server's HTML fallback
   *  ("expected magic word 00 61 73 6d"). */
  wasmUrl: () => Promise<{ default: string }>;
  /** NODE: the `_bg.wasm` file, resolved in the module's own file:
   *  `() => new URL("../bin/x_bg.wasm", import.meta.url)`, or a path from
   *  `createRequire(import.meta.url).resolve(...)`. wasm-bindgen's own
   *  fetch of a `file:` URL fails under Node, so the bytes are read. */
  wasmFile: () => URL | string | Promise<URL | string>;
  /** Overrides the realm test (paged.image treats a realm with a `window`,
   *  such as happy-dom, as a browser). */
  isNode?: () => boolean;
}

/** A wasm-bindgen module to boot. */
export interface WasmBindgenSpec<G> extends WasmSource {
  /** The glue, as a literal thunk: `() => import("../bin/x.js")`. */
  glue: () => Promise<unknown>;
  /** The message when the glue cannot be imported: the artifact is a build
   *  output, absent until the module's `scripts/build-wasm.sh` ran. */
  notBuilt: string;
  /** Runs once on the instantiated glue, inside the single flight (an
   *  engine-wide init export, such as paged.draw's `traceInit`). */
  ready?: (glue: G) => void | Promise<void>;
}

/** The wasm bytes: read from disk under Node, fetched from the bundler's
 *  asset URL in a browser (for a loader that instantiates them itself, such
 *  as an Emscripten module's `wasmBinary`). */
export async function wasmBytes(source: WasmSource): Promise<Uint8Array> {
  if ((source.isNode ?? isNodeRealm)()) {
    return readWasmFile(await source.wasmFile());
  }
  const url = (await source.wasmUrl()).default;
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

/** Behind a computed specifier, so a browser bundler leaves it alone: the
 *  Node path never runs there, and esbuild cannot resolve a literal
 *  `node:` import for a browser build (paged.data's browser lane). */
const NODE_FS = "node:fs/promises";

async function readWasmFile(file: URL | string): Promise<Uint8Array> {
  const { readFile } = (await import(
    /* @vite-ignore */ NODE_FS
  )) as typeof import("node:fs/promises");
  const path =
    typeof file === "string" && file.startsWith("file:") ? new URL(file) : file;
  const bytes = await readFile(path);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Import and instantiate a wasm-bindgen glue, NOT memoized: one call, one
 * instantiation attempt. Modules use [`wasmBindgenModule`]; this is for a
 * loader that keeps its own single flight around more work.
 *
 * NODE: reads the `_bg.wasm` bytes and calls `initSync` (or `default` with
 * the bytes, for a glue typed without it). BROWSER: hands `default` the
 * bundler's asset URL. Rejects with `notBuilt` (the import error as its
 * cause) when the glue is absent.
 */
export async function instantiateWasmBindgen<G extends WasmBindgenGlue>(
  spec: WasmBindgenSpec<G>,
): Promise<G> {
  let glue: G;
  try {
    glue = (await spec.glue()) as G;
  } catch (cause) {
    throw new Error(spec.notBuilt, { cause });
  }
  if ((spec.isNode ?? isNodeRealm)()) {
    const module = await readWasmFile(await spec.wasmFile());
    if (typeof glue.initSync === "function") glue.initSync({ module });
    else await glue.default({ module_or_path: module });
  } else {
    const url = (await spec.wasmUrl()).default;
    await glue.default({ module_or_path: url });
  }
  await spec.ready?.(glue);
  return glue;
}

/**
 * The module's boot: [`instantiateWasmBindgen`] behind a [`singleFlight`].
 * Declare it once at module scope and call it from every boot path:
 *
 * ```ts
 * const docModule = wasmBindgenModule<DocWasmModule>({
 *   // @ts-ignore: built by scripts/build-wasm.sh, absent from the source tree.
 *   glue: () => import("../bin/docx_js.js"),
 *   // @ts-ignore: `?url` is a bundler affordance.
 *   wasmUrl: () => import("../bin/docx_js_bg.wasm?url"),
 *   wasmFile: () => new URL("../bin/docx_js_bg.wasm", import.meta.url),
 *   notBuilt: "paged.doc engine wasm not built: run scripts/build-wasm.sh",
 * });
 * ```
 */
export function wasmBindgenModule<G extends WasmBindgenGlue>(
  spec: WasmBindgenSpec<G>,
): SingleFlight<G> {
  return singleFlight(() => instantiateWasmBindgen(spec));
}
