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
// The import mechanics are @paged-media/wasm-boot's (relative `import()` so
// the glue stays its own module with its own `import.meta.url` when Vite
// builds the editor, plus the `_bg.wasm?url` asset hand-off — the
// bare-relative wasm-bindgen fetch 404s under the editor's Vite SPA
// fallback), and so is the single flight: every load shares one boot.

import type { BundleHost } from "@paged-media/plugin-api";
import { instantiateWasmBindgen, singleFlight } from "@paged-media/wasm-boot";

import type { DocumentIr } from "./ir";
import type { PdfInfo, PlaceRequest, PlaceResult } from "./vectors/ir";

/** The minimal surface of the wasm-bindgen `--target web` glue we use —
 *  declared locally so typecheck never depends on the GENERATED (gitignored)
 *  `bin/pdf_import.d.ts`. `default` is `__wbg_init`. */
interface PdfMapperGlue {
  default: (init?: { module_or_path: unknown } | unknown) => Promise<unknown>;
  /** `pdf_ir_to_paged_wasm(ir_json) -> Uint8Array` (throws a JS error on a
   *  malformed IR or a model-build failure). */
  pdf_ir_to_paged_wasm: (irJson: string) => Uint8Array;
  /** `pdf_to_paged_wasm(bytes, ir_json)`: the open path with the page
   *  reader's vectors (publish ADR 658). */
  pdf_to_paged_wasm: (bytes: Uint8Array, irJson: string) => Uint8Array;
  /** `pdf_inspect_wasm(bytes) -> PdfInfo JSON`; throws `"<code>: <why>"`. */
  pdf_inspect_wasm: (bytes: Uint8Array) => string;
  /** `pdf_place_wasm(bytes, request_json) -> PlaceResult JSON`; throws
   *  `"<code>: <why>"`. */
  pdf_place_wasm: (bytes: Uint8Array, requestJson: string) => string;
}

/** A loaded mapper: turn a Document IR into native `.paged` bytes, or `null`
 *  if the wasm threw (the importer then reports + falls back). */
export interface PdfMapper {
  mapIrToPaged(ir: DocumentIr): Uint8Array | null;
  /** The open path with the PDF's own bytes: vectors and images from the
   *  page reader, text from the IR. `null` when the wasm threw. */
  mapPdfToPaged(bytes: Uint8Array, ir: DocumentIr): Uint8Array | null;
  /** What a file is; throws `"<code>: <why>"` (place-as-vectors). */
  inspect(bytes: Uint8Array): PdfInfo;
  /** A page lowered into a snippet; throws `"<code>: <why>"`. */
  place(bytes: Uint8Array, request: PlaceRequest): PlaceResult;
}

export interface LoadMapperOptions {
  /** Resolve + import the wasm-bindgen glue. Defaults to the bundle-relative
   *  `bin/pdf_import.js`. Tests inject a stub / disk-loaded module. */
  importGlue?: () => Promise<PdfMapperGlue>;
}

/** The default glue importer: the bundle-relative wasm-bindgen ESM,
 *  instantiated from the bundler's `?url` asset URL in a browser and from the
 *  bytes beside the glue under Node (the headless host, the Node CLI). */
function importBundledGlue(): Promise<PdfMapperGlue> {
  return instantiateWasmBindgen<PdfMapperGlue>({
    // bin/pdf_import.js is the wasm-bindgen glue (build output of
    // scripts/build-wasm.sh from crates/pdf-import), its own module in the
    // editor's build; typed via PdfMapperGlue.
    // @ts-ignore — absent until built.
    glue: () => import("../bin/pdf_import.js"),
    // @ts-ignore — `?url` is a bundler affordance (untyped); Vite resolves it
    // to a served asset URL.
    wasmUrl: () => import("../bin/pdf_import_bg.wasm?url"),
    wasmFile: () => new URL("../bin/pdf_import_bg.wasm", import.meta.url),
    notBuilt: "the pdf-import wasm is not built (scripts/build-wasm.sh)",
  });
}

/**
 * Load the `pdf-import` wasm mapper, or `null` when it cannot be loaded.
 * Idempotent + memoized; never throws — a load failure resolves to `null`
 * (logged through the host) so the importer stays on the Phase 0 image path.
 */
export function loadPdfMapper(
  host: BundleHost,
  options: LoadMapperOptions = {},
): Promise<PdfMapper | null> {
  return mapperOnce(host, options);
}

const mapperOnce = singleFlight(
  async (
    host: BundleHost,
    options: LoadMapperOptions,
  ): Promise<PdfMapper | null> => {
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
        mapPdfToPaged(bytes, ir): Uint8Array | null {
          try {
            return glue.pdf_to_paged_wasm(bytes, JSON.stringify(ir));
          } catch (err) {
            host.log.warn(
              `pdf mapper: pdf_to_paged_wasm threw — ${stringifyErr(err)}`,
            );
            return null;
          }
        },
        inspect(bytes): PdfInfo {
          return JSON.parse(glue.pdf_inspect_wasm(bytes)) as PdfInfo;
        },
        place(bytes, request): PlaceResult {
          return JSON.parse(
            glue.pdf_place_wasm(bytes, JSON.stringify(request)),
          ) as PlaceResult;
        },
      };
    } catch (err) {
      host.log.info(
        `pdf mapper: not loaded (${stringifyErr(err)}) — image-only import`,
      );
      return null;
    }
  },
);

/** Reset the memoized mapper — for tests (each loads fresh). */
export function _resetPdfMapperCache(): void {
  mapperOnce.reset();
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
