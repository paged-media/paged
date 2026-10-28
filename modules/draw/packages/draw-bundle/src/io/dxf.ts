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

// DXF in and out (draw ADR 364), THROUGH SVG and the engine's doors:
//
//   · IMPORT claims `.dxf`. The draw wasm (`crates/draw-dxf`) reads the
//     drawing's model space into an SVG document — a named group per
//     layer, every curve as cubic Béziers, true sizes in points — and
//     `importSvgFile` (the engine's `document.importSvg`) lands it: one
//     undo step, the layers as named groups, centred on the page. What
//     the DXF reader left out (TEXT, HATCH, DIMENSION, …) and what the
//     engine approximated are both logged.
//   · EXPORT claims `.dxf`. `document.exportSvg` writes what the
//     selection — or, with nothing selected, the page — draws, and the
//     wasm writes that as DXF entities in millimetres: LWPOLYLINE for a
//     straight contour, an exact cubic SPLINE for a curved one, true
//     colours with the nearest index colour, line weights.
//
// No DXF lowering of its own and no reading of the document of its own:
// the one SVG import and the one SVG export do that for every format
// that rides them.

import type {
  BundleHost,
  Disposable,
  ElementId,
  ExportResult,
  ImportRequest,
} from "@paged-media/plugin-api";

import { defineMessages, t } from "@paged-media/strings";
import { bootInterchange, type InterchangeReport } from "../interchange-wasm";
import {
  EXPORT_SVG_FEATURE,
  IMPORT_SVG_FEATURE,
  exportFileName,
  importSvgFile,
} from "./svg";

const M = defineMessages("draw.dxf", {
  importerTitle: "DXF (AutoCAD drawing exchange)",
  exporterTitle: "DXF (selection or page)",
});

export const DXF_IMPORTER_ID = "media.paged.draw.importer.dxf";
export const DXF_EXPORTER_ID = "media.paged.draw.exporter.dxf";
export const DXF_MIME = "image/vnd.dxf";

function logReport(
  host: BundleHost,
  source: string,
  name: string,
  report: InterchangeReport,
): void {
  for (const note of report.notes) {
    host.log.warn(`${source}: ${name}: ${note.message} (${note.count}×)`);
  }
}

/** Import a `.dxf` file — what File ▸ Open runs. Answers the minted
 *  element ids (the layer groups and their paths; empty when nothing
 *  applied). */
export async function importDxf(
  host: BundleHost,
  file: ImportRequest,
): Promise<ElementId[]> {
  let read;
  try {
    read = (await bootInterchange()).dxfToSvg(file.bytes);
  } catch (e) {
    host.log.warn(
      `${DXF_IMPORTER_ID}: ${file.name} not imported — ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
  logReport(host, DXF_IMPORTER_ID, file.name, read.report);
  if (read.report.items === 0) {
    host.log.warn(`${DXF_IMPORTER_ID}: ${file.name} draws nothing to import`);
    return [];
  }
  const { ids } = await importSvgFile(
    host,
    DXF_IMPORTER_ID,
    file.name,
    new TextEncoder().encode(read.svg),
    // The layers are the top-level items: no group around them.
    { group: false },
  );
  return ids;
}

/** The DXF of the selection, or of the page in view when nothing is
 *  selected; null when the engine declined or the wasm could not write
 *  it (the reason logged). */
export async function exportDxf(
  host: BundleHost,
): Promise<ExportResult | null> {
  const selection = host.selection.get();
  const svg = await host.document.exportSvg(
    selection.length > 0 ? { elementIds: selection } : {},
  );
  for (const note of svg.report.notes) {
    host.log.warn(`${DXF_EXPORTER_ID}: ${note.message} (${note.count}×)`);
  }
  if (svg.svg === null) {
    host.log.warn(
      `${DXF_EXPORTER_ID}: the engine did not export (${svg.error ?? "no answer"})`,
    );
    return null;
  }
  let written;
  try {
    written = (await bootInterchange()).svgToDxf(svg.svg);
  } catch (e) {
    host.log.warn(
      `${DXF_EXPORTER_ID}: nothing written — ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
  logReport(host, DXF_EXPORTER_ID, "export", written.report);
  return {
    bytes: new TextEncoder().encode(written.dxf),
    fileName: await exportFileName(host, ".dxf"),
  };
}

/** Register the DXF importer and exporter (K-2), each where the host has
 *  its registry door and the engine's SVG door it rides. */
export function contributeDxfIo(host: BundleHost): Disposable {
  const disposers: Disposable[] = [];
  if (
    host.supports("contribute.importer@1") &&
    host.supports(IMPORT_SVG_FEATURE)
  ) {
    disposers.push(
      host.contribute.importer({
        id: DXF_IMPORTER_ID,
        title: t(M.importerTitle),
        extensions: [".dxf"],
        mimeTypes: [DXF_MIME, "application/dxf"],
        import: (file) => void importDxf(host, file),
      }),
    );
  } else {
    host.log.warn(
      `${DXF_IMPORTER_ID}: the host has no importer registry or no ${IMPORT_SVG_FEATURE} door — not registered`,
    );
  }
  if (
    host.supports("contribute.exporter@1") &&
    host.supports(EXPORT_SVG_FEATURE)
  ) {
    disposers.push(
      host.contribute.exporter({
        id: DXF_EXPORTER_ID,
        title: t(M.exporterTitle),
        extension: ".dxf",
        mimeType: DXF_MIME,
        export: () => exportDxf(host),
      }),
    );
  } else {
    host.log.warn(
      `${DXF_EXPORTER_ID}: the host has no exporter registry or no ${EXPORT_SVG_FEATURE} door — not registered`,
    );
  }
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
