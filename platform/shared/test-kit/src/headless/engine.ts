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

// The headless editor's engine: the editor's own canvas-wasm, booted in the
// test process. The module is instantiated ONCE per process (the 29 MB
// compile is the expensive part, a few hundred ms); every headless editor
// gets a FRESH engine object (`new CanvasWorker()`, cheap), so no document,
// undo history or font registry leaks from one editor into the next.
//
// The boot goes through the plugin SDK's Node loader (`loadHeadlessEngine`),
// which also refuses a wasm whose protocol differs from the vendored wire.

import { loadHeadlessEngine, resolveCanvasWasm } from "@paged-media/plugin-sdk";

/**
 * The engine object the render worker drives (apps/canvas/src/worker/
 * worker.ts `CanvasWorkerInstance`), minus the GPU surface: the members the
 * in-process worker calls. Structural, so a test can hand in a fake.
 */
export interface EngineCanvasWorker {
  readonly protocolVersion: number;
  handleMessage(input: string): string;
  loadDocumentDirect(
    seq: number,
    bytes: Uint8Array,
    font?: Uint8Array | null,
    cmykIccProfile?: Uint8Array | null,
  ): string;
  runResolveJson(): string | undefined;
  measureText?(
    family: string,
    style: string | null | undefined,
    text: string,
    sizePt: number,
  ): { advance: number; ascender: number; descender: number } | null;
  updateGestureRaw?(
    handleLo: number,
    handleHi: number,
    dx: number,
    dy: number,
    modifierBits: number,
  ): string;
  submitSceneImageDirect?(
    seq: number,
    elementId: string,
    caller: string | undefined,
    rgba: Uint8Array,
    width: number,
    height: number,
    x: number,
    y: number,
    w: number,
    h: number,
  ): string;
  submitSceneImageTilesDirect?(
    seq: number,
    elementId: string,
    caller: string | undefined,
    rects: Uint32Array,
    rgba: Uint8Array,
  ): string;
  writePagedPartDirect?(
    seq: number,
    path: string,
    caller: string | undefined,
    bytes: Uint8Array,
  ): string;
  readPagedPartDirect?(path: string): Uint8Array | undefined;
  placedAssetBytesDirect?(
    elementId: string,
  ):
    | { uri: string; width: number; height: number; encoded: Uint8Array }
    | undefined;
  mutateWithBytesDirect?(
    seq: number,
    mutationJson: string,
    bytes: Uint8Array,
  ): string;
  amendWithBytesDirect?(
    seq: number,
    appliedSeq: number,
    mutationJson: string,
    bytes: Uint8Array,
  ): string;
  free(): void;
}

export interface HeadlessEngineModule {
  /** A fresh engine: no document, empty undo history, empty registries. */
  create(): EngineCanvasWorker;
  /** The booted package version (`0.<protocol>.0-dev`). */
  readonly version: string;
  readonly protocolVersion: number;
  /** The wasm instance's linear memory, in bytes (it only ever grows). */
  memoryBytes(): number;
}

interface WasmGlue {
  initSync(module: { module: BufferSource }): { memory: WebAssembly.Memory };
  CanvasWorker: new () => EngineCanvasWorker;
}

let booted: Promise<HeadlessEngineModule> | null = null;
/** Per process, not per module: a test runner may evaluate this module
 *  once per test file. */
const INSTANCES = Symbol.for("paged.test-kit.headless.instances");
const nextInstance = () => {
  const g = globalThis as { [INSTANCES]?: number };
  g[INSTANCES] = (g[INSTANCES] ?? 0) + 1;
  return g[INSTANCES];
};

let wasmBytes: Uint8Array<ArrayBuffer> | null = null;

/** A copy of the wasm-bindgen glue under a name of its own: the glue keeps
 *  its instance in module scope, and a module record is keyed by path (a
 *  query string does not make a new one under Bun), so a fresh instance
 *  needs a fresh file. */
async function freshGlue(loaderUrl: string): Promise<string> {
  const [{ readFileSync, writeFileSync, mkdtempSync }, { tmpdir }, path, url] =
    await Promise.all([
      import("node:fs"),
      import("node:os"),
      import("node:path"),
      import("node:url"),
    ]);
  const source = readFileSync(url.fileURLToPath(loaderUrl), "utf8");
  const dir = mkdtempSync(path.join(tmpdir(), "paged-headless-engine-"));
  const file = path.join(dir, `paged_canvas_wasm.${nextInstance()}.js`);
  writeFileSync(file, source);
  return url.pathToFileURL(file).href;
}

async function instantiate(
  first: { version: string; protocolVersion: number },
  loaderUrl: string,
  wasmPath: string,
  fresh: boolean,
): Promise<HeadlessEngineModule> {
  // A fresh copy of the glue is a new module record, hence a new wasm
  // instance with its own memory; the package's own glue is the record
  // (and the instance) `loadHeadlessEngine` initialised.
  const url = fresh ? await freshGlue(loaderUrl) : loaderUrl;
  const glue = (await import(url)) as WasmGlue;
  if (!wasmBytes) {
    const { readFileSync } = await import("node:fs");
    const file = readFileSync(wasmPath);
    wasmBytes = new Uint8Array(file.byteLength);
    wasmBytes.set(file);
  }
  // `initSync` instantiates once per module record and answers the same
  // exports after that.
  const exports = glue.initSync({ module: wasmBytes });
  return {
    create: () => new glue.CanvasWorker(),
    version: first.version,
    protocolVersion: first.protocolVersion,
    memoryBytes: () => exports.memory.buffer.byteLength,
  };
}

/**
 * The process-wide engine module (booted on first call, shared after).
 * Rejects, never skips, when the wasm is not built: build it with
 * `moon run core:wasm-pkg`.
 */
export function headlessEngineModule(): Promise<HeadlessEngineModule> {
  booted ??= (async () => {
    const first = await loadHeadlessEngine();
    first.worker.free();
    const { loaderUrl, wasmPath } = await resolveCanvasWasm();
    return instantiate(first, loaderUrl, wasmPath, false);
  })();
  return booted;
}

/**
 * A NEW wasm instance, made the process's current one: editors created
 * after it use it, editors created before keep theirs. For a long suite:
 * wasm memory never shrinks, and an instance whose engine trapped (a Rust
 * panic) cannot be trusted again.
 */
export async function rebootHeadlessEngine(): Promise<HeadlessEngineModule> {
  const current = await headlessEngineModule();
  const { loaderUrl, wasmPath } = await resolveCanvasWasm();
  const next = instantiate(current, loaderUrl, wasmPath, true);
  booted = next;
  return next;
}
