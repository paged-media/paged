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

// @paged-media/publish — the paged.publish plugin bundle (ADR-022 Phase 4):
// IDML import (native-document door) + IDML export (engine escape hatch).

export { publishBundle, activate } from "./activate";
export {
  contributeIdmlIo,
  IDML_IMPORTER_ID,
  IDML_EXPORTER_ID,
  IDML_MIME,
} from "./io/idml";
export {
  contributePublishCommands,
  exportPdf,
  exportIdmlResult,
  openIdml,
  parsePageRange,
  pdfExportArgs,
  pdfWireOptions,
  EXPORT_IDML_COMMAND,
  EXPORT_PAGED_COMMAND,
  EXPORT_PDF_ARGS_TYPE,
  EXPORT_PDF_COMMAND,
  EXPORT_RESULT_TYPE,
  IMPORT_IDML_COMMAND,
  PDF_EXPORT_DEFAULTS,
} from "./commands";
export type {
  ExportDiagnostic,
  ExportResult,
  PdfExportArgs,
  PdfExportDefaults,
  PdfWireOptions,
} from "./commands";
