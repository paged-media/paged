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

// paged.pdf TYPED COMMAND (plugin-sdk ADR 323): `media.paged.pdf.importPdf`
// opens a PDF with validated options, so the Node CLI and scripts choose the
// editable or the image path, the page cap and the raster resolution — the
// importer (File ▸ Open) runs the same code with `PDF_IMPORT_DEFAULTS` —
// the schema's own struct-field defaults, which `host.objects.invoke` fills
// in, so a caller passes `{ bytes }` alone (SDK 0.2.43 StructField).
// A PDF has no editable model of its own once opened (it becomes a native
// document), so the plugin contributes no object kinds.

import type { BundleHost, ObjectModelHandle, TypedCommandContribution, ValueType } from "@paged-media/plugin-api";

import importPdfArgs from "../schema/import-pdf.args.json";
import importPdfResult from "../schema/import-pdf.result.json";

import { openPdf, type PdfImportOptions } from "./io/pdf";

export const IMPORT_PDF_COMMAND = "media.paged.pdf.importPdf";
export const IMPORT_PDF_ARGS_TYPE = importPdfArgs as ValueType;
export const IMPORT_PDF_RESULT_TYPE = importPdfResult as ValueType;

/** The args after `host.objects.invoke` filled the schema's defaults:
 *  `name`, `mode` and `dpi` are always there, `maxPages` only when given. */
export interface PdfImportArgs extends PdfImportOptions {
  bytes: Uint8Array;
  name: string;
}

/** The door that replaces the active document: the native one (the
 *  editor), else the documents door (headless hosts, the Node CLI). */
function openDoor(host: BundleHost, name: string): ((bytes: Uint8Array) => Promise<void>) | null {
  if (host.supports("document.openNative@1")) return (bytes) => host.nativeDocument.open(bytes);
  if (host.supports("documents.open@1")) {
    return async (bytes) => {
      const r = await host.documents.open(bytes, { name });
      if (!r.opened) throw new Error(`failed: the host declined to open ${name}`);
    };
  }
  return null;
}

export function contributePdfCommands(host: BundleHost): ObjectModelHandle | null {
  if (!host.supports("contribute.objectModel@1")) return null;
  const importPdf: TypedCommandContribution<PdfImportArgs, { mode: "editable" | "image"; pageCount: number }> = {
    id: IMPORT_PDF_COMMAND,
    title: "Open PDF",
    args: IMPORT_PDF_ARGS_TYPE,
    result: IMPORT_PDF_RESULT_TYPE,
    async handler(_ctx, args) {
      const open = openDoor(host, args.name);
      if (!open) throw new Error("failed: this host cannot open a document");
      const options: PdfImportOptions = { mode: args.mode, dpi: args.dpi };
      if (args.maxPages !== undefined) options.maxPages = args.maxPages;
      return openPdf(host, args.bytes, options, open);
    },
  };
  return host.contribute.objectModel({ kinds: [], commands: [importPdf as TypedCommandContribution] });
}
