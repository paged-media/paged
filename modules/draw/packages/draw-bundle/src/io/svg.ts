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

// paged.draw's SVG importer and exporter (File ▸ Open / Export, the K-2
// registry) — and since draw ADR 364 NOTHING BUT DOORS: the engine's
// `paged-svg` (engine ADR 1031) reads and writes SVG for every module.
//
//   · IMPORT claims `.svg` and hands the file to `document.importSvg`:
//     one batch, one undo step — paths and compound paths (a shape of
//     several contours is ONE element, its holes cut, its fill rule
//     kept), swatches, gradients, groups, clips, masks, pictures and text
//     — and what the engine approximated or left out is logged from its
//     report. The drawing lands where it is drawn (the SVG's corner on
//     the page's, a user unit a point) and each top-level shape stays its
//     own element (`group: false`), as the bundle's imports always did.
//   · EXPORT claims `.svg` and asks `document.exportSvg` for what the
//     selection draws.
//
// The module's own TypeScript reader and writer (draw-geometry's
// `svg-doc.ts`) are gone, and with them the bug they carried: a compound
// shape the reader could not land whole was split into one path per
// contour, its holes painted. On a host without the doors (an engine
// before protocol 77) the importer and the exporter are not registered,
// and the log says why — a refusal, never a second SVG reader.
//
// `importSvgFile` is the one import lane: the DXF importer (`dxf.ts`) and
// the EPS importer (`postscript.ts`) land their SVG through it too.

import type {
  BundleHost,
  Disposable,
  ElementId,
  ExportResult,
  ImportRequest,
  SvgImportRequest,
  SvgImportResult,
} from "@paged-media/plugin-api";

import { defineMessages, t } from "@paged-media/strings";
import { resolveTargetPage } from "../target-page";

const M = defineMessages("draw.svg", {
  importerTitle: "SVG (Scalable Vector Graphics)",
  exporterTitle: "SVG (selection)",
});

export const SVG_IMPORTER_ID = "media.paged.draw.importer.svg";
export const SVG_EXPORTER_ID = "media.paged.draw.exporter.svg";
export const SVG_MIME = "image/svg+xml";

/** The host features of the engine's SVG lane (engine ADR 1031). */
export const IMPORT_SVG_FEATURE = "document.importSvg@1";
export const EXPORT_SVG_FEATURE = "document.exportSvg@1";

/**
 * The largest file handed to the engine's SVG door. The door carries the
 * bytes as a JSON number array, and a 96 MB file (a corpus `.ai` handed to
 * it by the foreign-format lane) makes the engine's allocation fail with a
 * panic that leaves its wasm instance unusable for every later call. A
 * real SVG is far smaller (the corpus's largest is 1 261 contours); the
 * refusal is logged. Follow-up: the door should take bytes, and refuse an
 * oversize file itself.
 */
export const MAX_SVG_BYTES = 32 * 1024 * 1024;

/** What one import through the engine did. */
export interface SvgFileImport {
  /** The engine's answer, or `null` when nothing was asked (no door, no
   *  page). */
  result: SvgImportResult | null;
  /** The elements the batch minted, in mint order (the last one the
   *  import's top item). */
  ids: ElementId[];
}

/**
 * Import SVG `bytes` through the engine (`document.importSvg`) onto the
 * active page, as ONE undo step, logging every row of its report under
 * `source` (the importer's id) and `name` (the file's). Never throws: a
 * host without the door, a document without a page and a refusal are
 * logged and answered with no ids.
 */
export async function importSvgFile(
  host: BundleHost,
  source: string,
  name: string,
  bytes: Uint8Array,
  options: SvgImportRequest = {},
): Promise<SvgFileImport> {
  if (!host.supports(IMPORT_SVG_FEATURE)) {
    host.log.warn(
      `${source}: the host has no ${IMPORT_SVG_FEATURE} door — ${name} not imported`,
    );
    return { result: null, ids: [] };
  }
  if (bytes.byteLength > MAX_SVG_BYTES) {
    host.log.warn(
      `${source}: ${name} is larger than ${MAX_SVG_BYTES >> 20} MB — not imported`,
    );
    return { result: null, ids: [] };
  }
  const pageId = options.pageId ?? (await resolveTargetPage(host));
  if (!pageId) {
    host.log.warn(`${source}: no target page — ${name} not imported`);
    return { result: null, ids: [] };
  }
  const result = await host.document.importSvg(bytes, { ...options, pageId });
  for (const note of result.report.notes) {
    host.log.warn(`${source}: ${name}: ${note.message} (${note.count}×)`);
  }
  if (!result.applied) {
    host.log.warn(
      `${source}: ${name} not imported — ${result.error ?? "refused"}`,
    );
    return { result, ids: [] };
  }
  const outcome = result.outcome;
  const ids =
    outcome && outcome.applied
      ? (outcome.minted ?? []).map((m) => m.element)
      : [];
  host.log.info(
    `${source}: imported ${name} through the engine ` +
      `(${result.report.items} items) in 1 undo step`,
  );
  return { result, ids };
}

/**
 * Import an `.svg` file — what File ▸ Open runs. The drawing lands where
 * it is drawn and each top-level shape stays its own element. Answers the
 * minted element ids (empty when nothing applied).
 */
export async function importSvg(
  host: BundleHost,
  file: ImportRequest,
): Promise<ElementId[]> {
  const { ids } = await importSvgFile(
    host,
    SVG_IMPORTER_ID,
    file.name,
    file.bytes,
    { origin: [0, 0], group: false },
  );
  return ids;
}

/** The file name an export offers: the document's, else "drawing". */
export async function exportFileName(
  host: BundleHost,
  extension: string,
): Promise<string> {
  const meta = await host.document.meta();
  const base = meta.documentName?.trim() || "drawing";
  return `${base}${extension}`;
}

/**
 * The SVG of what the selection draws (`document.exportSvg`), or null —
 * nothing selected, or the engine declined (the reason logged).
 */
export async function exportSvg(
  host: BundleHost,
): Promise<ExportResult | null> {
  const selection = host.selection.get();
  if (selection.length === 0) {
    host.log.debug(`${SVG_EXPORTER_ID}: empty selection — nothing to export`);
    return null;
  }
  const result = await host.document.exportSvg({ elementIds: selection });
  for (const note of result.report.notes) {
    host.log.warn(`${SVG_EXPORTER_ID}: ${note.message} (${note.count}×)`);
  }
  if (result.svg === null) {
    host.log.warn(
      `${SVG_EXPORTER_ID}: the engine did not export (${result.error ?? "no answer"})`,
    );
    return null;
  }
  return {
    bytes: new TextEncoder().encode(result.svg),
    fileName: await exportFileName(host, ".svg"),
  };
}

/** Register the SVG importer and exporter through the K-2 doors, each
 *  only where the host has both its registry door and the engine's SVG
 *  door. Returns a Disposable dropping both. */
export function contributeSvgIo(host: BundleHost): Disposable {
  const disposers: Disposable[] = [];
  if (
    host.supports("contribute.importer@1") &&
    host.supports(IMPORT_SVG_FEATURE)
  ) {
    disposers.push(
      host.contribute.importer({
        id: SVG_IMPORTER_ID,
        title: t(M.importerTitle),
        extensions: [".svg"],
        mimeTypes: [SVG_MIME],
        import: (file) => void importSvg(host, file),
      }),
    );
  } else {
    host.log.warn(
      `${SVG_IMPORTER_ID}: the host has no importer registry or no ${IMPORT_SVG_FEATURE} door — not registered`,
    );
  }
  if (
    host.supports("contribute.exporter@1") &&
    host.supports(EXPORT_SVG_FEATURE)
  ) {
    disposers.push(
      host.contribute.exporter({
        id: SVG_EXPORTER_ID,
        title: t(M.exporterTitle),
        extension: ".svg",
        mimeType: SVG_MIME,
        export: () => exportSvg(host),
      }),
    );
  } else {
    host.log.warn(
      `${SVG_EXPORTER_ID}: the host has no exporter registry or no ${EXPORT_SVG_FEATURE} door — not registered`,
    );
  }
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
