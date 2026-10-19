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

// @paged-media/pdf — the paged.pdf plugin bundle. PDFium (wasm) reads the PDF:
// text/vector/image objects → a Document IR → the pdf-import wasm mapper →
// native .paged (editable). A PDFium page raster is the Phase-0 image fallback
// when the editable path can't run. No pdf.js.

export { pdfBundle, activate } from "./activate";
export {
  contributePdfIo,
  openPdf,
  PDF_IMPORT_DEFAULTS,
  PDF_IMPORTER_ID,
  PDF_MIME,
} from "./io/pdf";
export type { PdfImportOptions } from "./io/pdf";
export {
  contributePdfCommands,
  IMPORT_PDF_ARGS_TYPE,
  IMPORT_PDF_COMMAND,
  IMPORT_PDF_RESULT_TYPE,
} from "./commands";
export type { PdfImportArgs } from "./commands";
export { buildIdmlFromRasters } from "./idml-fallback";
export type { PdfPageRaster } from "./idml-fallback";
// The PDFium reader engine — editable reconstruction + the raster fallback.
export { extractPdf, rasterizePdf, loadPdfium, _resetPdfium } from "./pdfium";
export type { ExtractOptions, RasterOptions } from "./pdfium";
export { loadPdfMapper, _resetPdfMapperCache } from "./engine-loader";
export type { PdfMapper, LoadMapperOptions } from "./engine-loader";
export {
  itemsToParagraphs,
  groupLines,
  lineToParagraph,
  textBBox,
  textCharCount,
  DEFAULT_OPTIONS,
} from "./extract";
export type { PositionedItem, ReconstructOptions } from "./extract";
export type {
  DocumentIr,
  PageIr,
  FrameIr,
  TextFrameIr,
  ImageFrameIr,
  ParagraphIr,
  RunIr,
} from "./ir";
