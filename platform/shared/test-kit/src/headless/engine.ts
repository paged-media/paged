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
  free(): void;
}

export interface HeadlessEngineModule {
  /** A fresh engine: no document, empty undo history, empty registries. */
  create(): EngineCanvasWorker;
  /** The booted package version (`0.<protocol>.0-dev`). */
  readonly version: string;
  readonly protocolVersion: number;
}

let booted: Promise<HeadlessEngineModule> | null = null;

/**
 * The process-wide engine module (booted on first call, shared after).
 * Rejects, never skips, when the wasm is not built: build it with
 * `moon run core:wasm-pkg`.
 */
export function headlessEngineModule(): Promise<HeadlessEngineModule> {
  booted ??= (async () => {
    const first = await loadHeadlessEngine();
    first.worker.free();
    const { loaderUrl } = await resolveCanvasWasm();
    // The same module record `loadHeadlessEngine` initialised (the import
    // is cached), so the class below already has its wasm instance.
    const mod = (await import(loaderUrl)) as {
      CanvasWorker: new () => EngineCanvasWorker;
    };
    return {
      create: () => new mod.CanvasWorker(),
      version: first.version,
      protocolVersion: first.protocolVersion,
    };
  })();
  return booted;
}
