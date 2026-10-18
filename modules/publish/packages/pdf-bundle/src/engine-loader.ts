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

// The MAPPER LOADER — the bundle-side half of Phase 1. It loads the
// `pdf-import` wasm mapper (built by `scripts/build-wasm.sh` to
// `bin/pdf_import.{js,_bg.wasm}`, manifest `capabilities.wasm`) and exposes a
// single call: `mapIrToPaged(documentIr) -> Uint8Array | null` — the native
// `.paged` bytes the importer hands to `host.nativeDocument.open`.
//
// HONESTY: this never fabricates a document. `loadPdfMapper` resolves to
// `null` (and the importer falls back to the Phase 0 image-only path) whenever
// the wasm can't load — no glue resolvable, instantiation failed, or a realm
// that can't fetch the sibling asset. The Rust mapper itself is PDF-blind: it
// only turns the reading-ordered Document IR this bundle produced into the
// native model, so a load failure loses editable text, never correctness.
//
// The import mechanics mirror plugin-web's engine-loader (relative `import()`
// so the glue stays its own module with its own `import.meta.url` when Vite
// builds the editor, plus the `_bg.wasm?url` asset hand-off — the
// bare-relative wasm-bindgen fetch 404s under the editor's Vite SPA fallback).

import type { BundleHost } from "@paged-media/plugin-api";

import type { DocumentIr } from "./ir";

/** The minimal surface of the wasm-bindgen `--target web` glue we use —
 *  declared locally so typecheck never depends on the GENERATED (gitignored)
 *  `bin/pdf_import.d.ts`. `default` is `__wbg_init`. */
interface PdfMapperGlue {
  default: (init?: { module_or_path: unknown } | unknown) => Promise<unknown>;
  /** `pdf_ir_to_paged_wasm(ir_json) -> Uint8Array` (throws a JS error on a
   *  malformed IR or a model-build failure). */
  pdf_ir_to_paged_wasm: (irJson: string) => Uint8Array;
}

/** A loaded mapper: turn a Document IR into native `.paged` bytes, or `null`
 *  if the wasm threw (the importer then reports + falls back). */
export interface PdfMapper {
  mapIrToPaged(ir: DocumentIr): Uint8Array | null;
}

export interface LoadMapperOptions {
  /** Resolve + import the wasm-bindgen glue. Defaults to the bundle-relative
   *  `bin/pdf_import.js`. Tests inject a stub / disk-loaded module. */
  importGlue?: () => Promise<PdfMapperGlue>;
}

/** True under Node or Bun (the unit tests; Bun sets `process.versions.node`), false in the browser (the editor). */
function isNode(): boolean {
  return (
    typeof process !== "undefined" &&
    !!(process as { versions?: { node?: string } }).versions?.node
  );
}

/** The default glue importer: the bundle-relative wasm-bindgen ESM. BROWSER:
 *  instantiate from the bundler's `?url` asset URL. NODE: instantiate from
 *  the wasm bytes read beside the glue. */
async function importBundledGlue(): Promise<PdfMapperGlue> {
  // @ts-ignore — bin/pdf_import.js is the wasm-bindgen glue (build output of
  // scripts/build-wasm.sh from crates/pdf-import), its own module in the
  // editor's build. The type checker doesn't check the JS — typed via PdfMapperGlue.
  // The import stays on one line of its own, so this directive covers it.
  const mod = await import("../bin/pdf_import.js");
  const glue = mod as unknown as PdfMapperGlue;
  if (isNode()) {
    // NODE (the headless host, the Node CLI): instantiate from the bytes
    // beside the glue — wasm-bindgen's own fetch of a file: URL fails here.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const b = await readFile(
      fileURLToPath(new URL("../bin/pdf_import_bg.wasm", import.meta.url)),
    );
    await glue.default({
      module_or_path: new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
    });
    return glue;
  }
  // @ts-ignore — `?url` is a bundler affordance (untyped); Vite resolves it
  // to a served asset URL.
  const wasmUrl = (await import("../bin/pdf_import_bg.wasm?url")) as {
    default: string;
  };
  await glue.default({ module_or_path: wasmUrl.default });
  return glue;
}

let cached: Promise<PdfMapper | null> | undefined;

/**
 * Load the `pdf-import` wasm mapper, or `null` when it cannot be loaded.
 * Idempotent + memoized; never throws — a load failure resolves to `null`
 * (logged through the host) so the importer stays on the Phase 0 image path.
 */
export async function loadPdfMapper(
  host: BundleHost,
  options: LoadMapperOptions = {},
): Promise<PdfMapper | null> {
  if (cached) return cached;
  cached = (async (): Promise<PdfMapper | null> => {
    try {
      const glue = await (options.importGlue ?? importBundledGlue)();
      // Idempotent boot (a no-op if the glue arrived pre-instantiated).
      await glue.default();
      return {
        mapIrToPaged(ir): Uint8Array | null {
          try {
            return glue.pdf_ir_to_paged_wasm(JSON.stringify(ir));
          } catch (err) {
            host.log.warn(
              `pdf mapper: pdf_ir_to_paged_wasm threw — ${stringifyErr(err)}`,
            );
            return null;
          }
        },
      };
    } catch (err) {
      host.log.info(
        `pdf mapper: not loaded (${stringifyErr(err)}) — image-only import`,
      );
      return null;
    }
  })();
  return cached;
}

/** Reset the memoized mapper — for tests (each loads fresh). */
export function _resetPdfMapperCache(): void {
  cached = undefined;
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
