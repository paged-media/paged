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

// The typed engine facade. The Rust wasm (slide-js) does all the PPTX work:
// OPC and PresentationML reading, inheritance, geometry, the IDML package.
// This file only boots it and types its JSON report (CLAUDE.md hard rule:
// no PresentationML semantics in TypeScript).
//
// Boot: the artifact is the wasm-bindgen `--target web` glue
// (bin/slide_js.js + bin/slide_js_bg.wasm, built by scripts/build-wasm.sh).
// It is loaded in the bundle's realm like @paged-media/canvas-wasm, branching
// browser and Node like plugin-sdk's wasm-loader; until it is built the
// dynamic import rejects and boot says so.

const ENGINE_NOT_BUILT = "paged.slide engine wasm not built: run scripts/build-wasm.sh";

/** A DrawingML transition as the deck wrote it (pptx-core `Transition`). */
export interface Transition {
  xml: string;
  kind: string | null;
  dir: string | null;
  speed: string | null;
  duration_ms: number | null;
  advance_on_click: boolean | null;
  advance_after_ms: number | null;
}

/** A slide's top-level item: the page element it became. */
export interface ItemReport {
  name: string;
  kind: "polygon" | "rectangle" | "textFrame" | "group";
  id: string;
  /** Page-space bounds of its outline (l, t, r, b), pt. */
  bounds: [number, number, number, number];
  shapeId: number;
  placeholder: [string, number | null] | null;
}

/** One slide, by the page id it opened as. */
export interface SlideReport {
  pageId: string;
  part: string;
  hidden: boolean;
  notes: string | null;
  transition: Transition | null;
  timingXml: string | null;
  items: ItemReport[];
}

/** What an import produced beside the package (slide-js `Report`). */
export interface ImportReport {
  width: number;
  height: number;
  slides: SlideReport[];
  fonts: string[];
  diagnostics: string[];
}

export interface Imported {
  idml: Uint8Array;
  report: ImportReport;
}

interface WasmImported {
  readonly idml: Uint8Array;
  readonly report: string;
  free(): void;
}

interface SlideWasmModule {
  default(init: { module_or_path: string | URL | BufferSource | WebAssembly.Module }): Promise<unknown>;
  initSync(module: { module: BufferSource | WebAssembly.Module }): unknown;
  importPptx(bytes: Uint8Array, name: string): WasmImported;
}

let booted: Promise<SlideWasmModule> | null = null;

/** The engine, booted once per realm. */
export async function slideEngine(): Promise<SlideEngine> {
  booted ??= loadModule();
  try {
    return new SlideEngine(await booted);
  } catch (err) {
    booted = null;
    throw err;
  }
}

export class SlideEngine {
  constructor(private readonly mod: SlideWasmModule) {}

  /** Read a `.pptx` into the IDML package of its native slides. Throws with
   *  the engine's message when the file is not a presentation. */
  importPptx(bytes: Uint8Array, name: string): Imported {
    const out = this.mod.importPptx(bytes, name);
    try {
      return { idml: out.idml, report: JSON.parse(out.report) as ImportReport };
    } finally {
      out.free();
    }
  }
}

function isNode(): boolean {
  return typeof process !== "undefined" && process.versions?.node != null;
}

async function loadModule(): Promise<SlideWasmModule> {
  let mod: SlideWasmModule;
  try {
    // @ts-ignore: built by scripts/build-wasm.sh, absent from the source tree.
    mod = (await import("../bin/slide_js.js")) as SlideWasmModule;
  } catch (cause) {
    throw new Error(ENGINE_NOT_BUILT, { cause });
  }
  if (isNode()) {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const bytes = await readFile(fileURLToPath(new URL("../bin/slide_js_bg.wasm", import.meta.url)));
    mod.initSync({ module: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
  } else {
    // @ts-ignore: `?url` is a bundler affordance (the editor's wasm convention).
    const wasmUrl = (await import("../bin/slide_js_bg.wasm?url")) as { default: string };
    await mod.default({ module_or_path: wasmUrl.default });
  }
  return mod;
}
