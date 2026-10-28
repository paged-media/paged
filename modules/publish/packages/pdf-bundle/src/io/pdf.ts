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

// paged.pdf — the `.pdf` importer.
//
// Mirrors the publish-bundle IDML importer's shape: a `.pdf` importer
// registered through the public contribution surface, routed to the
// native-document door. Two paths, best-first:
//
//   Phase 1 (editable) — reconstruct the PDF into an editable native document:
//     pdf.js text extraction → the reconstruct heuristics → a Document IR →
//     the `pdf-import` wasm mapper (`loadPdfMapper`) → `.paged` bytes. Text
//     pages come in as editable text frames; image/scanned pages keep a raster
//     background (per-page confidence gate). Used when the wasm mapper loads.
//
//   Phase 0 (image fallback) — rasterize every page and wrap the PNGs in a
//     minimal inline-image IDML (`rasterizePdf` + `buildIdmlFromRasters`).
//     Used when the mapper can't load or the reconstruction throws, so a PDF
//     always opens *something* real.
//
// Either way the engine owns the final parse via `host.nativeDocument.open`.
// Capability-gated on `document.openNative@1`; a failure fails LOUD in the log
// rather than throwing past the host (the mutate-never-throws convention).

import { defineMessages, t } from "@paged-media/strings";

import type {
  BundleHost,
  Disposable,
  ImportRequest,
} from "@paged-media/plugin-api";

import { buildIdmlFromRasters } from "../idml-fallback";
import { extractPdf, pdfPageCount, rasterizePdf } from "../pdfium";
import { loadPdfMapper } from "../engine-loader";

import importPdfArgs from "../../schema/import-pdf.args.json";

const M = defineMessages("publish.pdfImport", {
  pdf: "PDF",
  maxPagesRange: "maxPages is 1–2000 (absent = the path's default)",
  dpiRange: "dpi is 36–600",
  editableFailed: "the editable reconstruction could not run",
});

export const PDF_IMPORTER_ID = "media.paged.pdf.importer.pdf";

/** The pages each path reads when `maxPages` is absent. */
export const DEFAULT_MAX_PAGES = { editable: 12, image: 20 } as const;
export const PDF_MIME = "application/pdf";

// ---------------------------------------------------------- importer

/**
 * Import an opened `.pdf` file: rasterize its pages, wrap them in a minimal
 * IDML package, and hand that to the native-document door (the engine owns
 * the IDML→native parse + inline-image resolve). Capability-gated on
 * `document.openNative@1`; when the door isn't wired we warn and return
 * rather than throw. Loading is destructive, so a failure fails LOUD in the
 * log (never a throw past the host).
 */
async function importPdf(host: BundleHost, file: ImportRequest): Promise<void> {
  if (!host.supports("document.openNative@1")) {
    host.log.warn(
      `${PDF_IMPORTER_ID}: host predates document.openNative@1 — ${file.name} not opened`,
    );
    return;
  }
  try {
    const r = await openPdf(host, file.bytes, PDF_IMPORT_DEFAULTS, (bytes) =>
      host.nativeDocument.open(bytes),
    );
    host.log.info(
      r.mode === "editable"
        ? `${PDF_IMPORTER_ID}: opened ${file.name} as an editable document (${r.pageCount} page(s))`
        : `${PDF_IMPORTER_ID}: opened ${file.name} as ${r.pageCount} image page(s) (image fallback)`,
    );
  } catch (err) {
    // The host asked before replacing an edited document and the user
    // kept it: an answer, not a failure.
    if ((err as { name?: unknown } | null)?.name === "AbortError") {
      host.log.info(
        `${PDF_IMPORTER_ID}: ${file.name} not opened — the user kept the open document`,
      );
      return;
    }
    host.log.error(
      `${PDF_IMPORTER_ID}: failed to open ${file.name} — ${String(err)}`,
    );
  }
}

/** How a PDF is read (`schema/import-pdf.args.json` without the file). */
export interface PdfImportOptions {
  /** `auto`: editable when the mapper loads, else page images. */
  mode: "auto" | "editable" | "image";
  /** Page cap, 1–2000; absent = the path's default (12 editable, 20 image). */
  maxPages?: number;
  /** Raster resolution of the image path, ppi. */
  dpi: number;
}

/** The schema's struct-field DEFAULTS (`schema/import-pdf.args.json`, the
 *  one source): what `host.objects.invoke` fills in for an absent field,
 *  and what File ▸ Open uses. `maxPages` is optional, so it is absent. */
export const PDF_IMPORT_DEFAULTS: Readonly<PdfImportOptions> = Object.freeze({
  mode: importPdfArgs.fields.mode.default as PdfImportOptions["mode"],
  dpi: importPdfArgs.fields.dpi.default,
});

/** Read `bytes` per `options` and hand the document to `open`. Throws
 *  `invalidValue: …` on out-of-range options and `failed: …` when the
 *  requested path cannot run. */
export async function openPdf(
  host: BundleHost,
  bytes: Uint8Array,
  options: PdfImportOptions,
  open: (bytes: Uint8Array) => Promise<void>,
): Promise<{
  mode: "editable" | "image";
  pageCount: number;
  sourcePageCount: number;
}> {
  const read = await readPdf(host, bytes, options, open);
  // Pages past the cap are left out: said, never silent.
  const sourcePageCount = (await pdfPageCount(bytes)) ?? read.pageCount;
  if (sourcePageCount > read.pageCount) {
    const cap = options.maxPages ?? DEFAULT_MAX_PAGES[read.mode];
    host.log.warn(
      `${PDF_IMPORTER_ID}: read ${read.pageCount} of ${sourcePageCount} pages (the ${read.mode} path reads ${cap}; maxPages, up to 2000, reads more)`,
    );
  }
  return { ...read, sourcePageCount };
}

async function readPdf(
  host: BundleHost,
  bytes: Uint8Array,
  options: PdfImportOptions,
  open: (bytes: Uint8Array) => Promise<void>,
): Promise<{ mode: "editable" | "image"; pageCount: number }> {
  if (
    options.maxPages !== undefined &&
    (!Number.isInteger(options.maxPages) ||
      options.maxPages < 1 ||
      options.maxPages > 2000)
  ) {
    throw new Error(`invalidValue: ${t(M.maxPagesRange)}`);
  }
  if (options.dpi < 36 || options.dpi > 600)
    throw new Error(`invalidValue: ${t(M.dpiRange)}`);
  const maxPages = options.maxPages;
  if (options.mode !== "image") {
    // Phase 1 — the editable reconstruction (wasm mapper present).
    const editable = await tryEditableImport(host, bytes, maxPages);
    if (editable) {
      await open(editable.paged);
      return { mode: "editable", pageCount: editable.pageCount };
    }
    if (options.mode === "editable")
      throw new Error(`failed: ${t(M.editableFailed)}`);
  }
  // Phase 0 — image-only fallback (mapper unavailable or reconstruction failed).
  const pages = await rasterizePdf(bytes, {
    dpi: options.dpi,
    ...(maxPages ? { maxPages } : {}),
  });
  const idml = await buildIdmlFromRasters(pages);
  await open(idml);
  return { mode: "image", pageCount: pages.length };
}

/** Attempt the Phase 1 editable path: reconstruct → wasm map → `.paged`.
 *  Returns `null` (never throws) when the wasm mapper isn't loaded or the
 *  reconstruction/mapping fails, so the caller cleanly falls back to Phase 0. */
async function tryEditableImport(
  host: BundleHost,
  bytes: Uint8Array,
  maxPages?: number,
): Promise<{ paged: Uint8Array; pageCount: number } | null> {
  const mapper = await loadPdfMapper(host);
  if (!mapper) return null;
  try {
    const ir = await extractPdf(bytes, maxPages ? { maxPages } : {});
    // The page reader's vectors (publish ADR 658) where it reads the
    // file; the IR alone (PDFium's polylines) where it does not.
    const paged = mapper.mapPdfToPaged(bytes, ir) ?? mapper.mapIrToPaged(ir);
    if (!paged) return null;
    return { paged, pageCount: ir.pages.length };
  } catch (err) {
    host.log.warn(
      `${PDF_IMPORTER_ID}: editable reconstruction failed (${String(err)}) — image fallback`,
    );
    return null;
  }
}

// ------------------------------------------------------- registration

/** Register the PDF importer through the K-2 door, capability-gated
 *  (degrades honestly when a host predates the door). Returns a Disposable
 *  dropping it. */
export function contributePdfIo(host: BundleHost): Disposable {
  const disposers: Disposable[] = [];
  if (host.supports("contribute.importer@1")) {
    disposers.push(
      host.contribute.importer({
        id: PDF_IMPORTER_ID,
        title: t(M.pdf),
        extensions: [".pdf"],
        mimeTypes: [PDF_MIME],
        import: (file) => importPdf(host, file),
      }),
    );
  } else {
    host.log.warn(
      `${PDF_IMPORTER_ID}: host predates contribute.importer@1 — not registered`,
    );
  }
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
