/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// Editor ADR 2XX — Asset Export, the run: collect assets from the
// selection and the pages, and write every asset once per export setting.
//
// Nothing here draws or encodes on its own. Pixels come through the
// engine's snapshot door (`requestSnapshot` with `only`, `clip` and
// `trim` for page items, extensions ADR 338) and the engine encodes them
// (`format: "jpeg" | "webp" | "tiff"`, `paged-raster`); SVG is the
// engine's `paged-svg` export; PDF is the PDF export of one page. Several
// files go out as one ZIP through the shared writer, else one download
// each, through the app's one download door.

import type {
  CanvasClient,
  ElementGeometryItem,
  ElementId,
  SceneTreeNode,
} from "@paged-media/client";
import { zip } from "@paged-media/helpers";
import { regionAround } from "@paged-media/plugin-sdk";

import { elementKey } from "../panels/layer-objects";
import {
  MIME,
  RASTER_FORMATS,
  planFiles,
  type Asset,
  type AssetExportState,
  type PlannedFile,
} from "./model";

/** The page metadata entry that names an artboard (engine ADR 1011). */
export const ARTBOARD_META_KEY = "x-paged:paged.artboard";

/** The `pages` collection fields the collector reads. */
export interface PageRow {
  selfId: string;
  index?: number;
  name?: string;
  pluginMetadata?: ReadonlyArray<{ key: string; value: string }> | null;
}

/** An artboard's own name (`{"v":1,"data":{"name":"…"}}`), or null for a
 *  page that is not a named artboard. */
export function artboardName(page: PageRow): string | null {
  const entry = page.pluginMetadata?.find((e) => e.key === ARTBOARD_META_KEY);
  if (!entry) return null;
  try {
    const parsed = JSON.parse(entry.value) as { data?: { name?: unknown } };
    const name = parsed?.data?.name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

/** The names the collector gives what has none of its own. */
export interface AssetNames {
  page: (label: string) => string;
  object: (n: number) => string;
}

/** Asset drafts for pages: an artboard by its name, a page by its
 *  1-based number (a page's own name can be an IDML id). */
export function pageDrafts(
  pages: readonly PageRow[],
  pageIds: readonly string[] | null,
  names: AssetNames,
): Omit<Asset, "id">[] {
  const wanted = pageIds ? new Set(pageIds) : null;
  return pages
    .filter((p) => !wanted || wanted.has(p.selfId))
    .map((p, i) => {
      const board = artboardName(p);
      return {
        kind: board ? ("artboard" as const) : ("page" as const),
        name: board ?? names.page(String(p.index ?? i + 1)),
        pageId: p.selfId,
        elementIds: [],
      };
    });
}

/** The label the scene tree gives each item, by `elementKey`. */
function labels(roots: readonly SceneTreeNode[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: SceneTreeNode) => {
    if (n.id && n.label) out.set(elementKey(n.id), n.label);
    for (const c of n.children ?? []) walk(c);
  };
  roots.forEach(walk);
  return out;
}

/** Asset drafts for page items: one per item, or (`single`) one for all
 *  of them on the first item's page. An item on the pasteboard belongs to
 *  no page and is left out (`skipped`). */
export async function itemDrafts(
  client: Pick<CanvasClient, "elementGeometry" | "sceneTree">,
  ids: readonly ElementId[],
  single: boolean,
  names: AssetNames,
  taken: number,
): Promise<{ drafts: Omit<Asset, "id">[]; skipped: number }> {
  if (ids.length === 0) return { drafts: [], skipped: 0 };
  const geometry = await client.elementGeometry([...ids]);
  const pageOf = new Map<string, string>();
  for (const g of geometry) {
    if (g.pageId) pageOf.set(elementKey(g.id), g.pageId);
  }
  const named = await client
    .sceneTree()
    .then(labels)
    .catch(() => new Map<string, string>());
  const placed = ids.filter((id) => pageOf.has(elementKey(id)));
  let skipped = ids.length - placed.length;
  if (placed.length === 0) return { drafts: [], skipped };
  if (single) {
    const page = pageOf.get(elementKey(placed[0]!))!;
    const on = placed.filter((id) => pageOf.get(elementKey(id)) === page);
    skipped += placed.length - on.length;
    const name =
      on.length === 1
        ? (named.get(elementKey(on[0]!)) ?? names.object(taken + 1))
        : names.object(taken + 1);
    return {
      drafts: [{ kind: "object", name, pageId: page, elementIds: on }],
      skipped,
    };
  }
  return {
    drafts: placed.map((id, i) => ({
      kind: "object" as const,
      name: named.get(elementKey(id)) ?? names.object(taken + i + 1),
      pageId: pageOf.get(elementKey(id))!,
      elementIds: [id],
    })),
    skipped,
  };
}

/** One written file. */
export interface AssetFile {
  fileName: string;
  bytes: Uint8Array;
  mimeType: string;
}

/** Why a planned file was not written. */
export type AssetProblemReason =
  "nothingDrawn" | "unsupported" | "pdfObject" | "failed";

export interface AssetProblem {
  fileName: string;
  reason: AssetProblemReason;
  detail?: string;
}

export interface AssetExportResult {
  files: AssetFile[];
  problems: AssetProblem[];
  /** Notes of what the SVG writer approximated or left out. */
  svgNotes: number;
}

export interface AssetRunDeps {
  client: Pick<
    CanvasClient,
    "requestSnapshot" | "exportSvg" | "exportPdf" | "elementGeometry"
  >;
  /** The document's page order (a page's PDF is its index). */
  pageIds: readonly string[];
  onProgress?: (done: number, total: number) => void;
}

/** The pixels of one asset at one scale, encoded as `format`. */
async function raster(
  deps: AssetRunDeps,
  state: AssetExportState,
  file: PlannedFile,
): Promise<Uint8Array | AssetProblem> {
  const { asset, setting, fileName } = file;
  const format = setting.format as "png" | "jpeg" | "webp" | "tiff";
  const dpi = 72 * setting.scale;
  const common = {
    format,
    ...(format === "jpeg" ? { quality: state.quality } : {}),
  };
  let options;
  if (asset.elementIds.length > 0) {
    // The items alone, cropped to what they draw (stroke and effects
    // included) within 72 pt of their bounds — `host.render.element`'s
    // recipe — on a transparent ground (a JPEG is flattened onto white).
    const geometry = (await deps.client.elementGeometry(asset.elementIds))
      .filter((g: ElementGeometryItem) => g.pageId === asset.pageId)
      .map((g) => ({
        bounds: g.bounds as [number, number, number, number],
        itemTransform: g.itemTransform ?? null,
      }));
    if (geometry.length === 0) return { fileName, reason: "nothingDrawn" };
    options = {
      ...common,
      only: asset.elementIds,
      clip: regionAround(geometry, 72),
      background: "transparent" as const,
      trim: true,
    };
  } else {
    options = {
      ...common,
      background: state.transparentPages
        ? ("transparent" as const)
        : ("paper" as const),
    };
  }
  let snap;
  try {
    snap = await deps.client.requestSnapshot(asset.pageId, 0, dpi, options);
  } catch (e) {
    const detail = String(e);
    return {
      fileName,
      reason: /nothingDrawn/i.test(detail) ? "nothingDrawn" : "failed",
      detail,
    };
  }
  // An engine before the file formats answers a PNG: never hand that out
  // under another format's name.
  const got = snap.format ?? "png";
  if (got !== format) return { fileName, reason: "unsupported" };
  const bytes = format === "png" ? snap.pngBytes : snap.bytes;
  if (!bytes || bytes.length === 0) return { fileName, reason: "failed" };
  return Uint8Array.from(bytes);
}

/** Write `assets` (all of them when absent) with the state's settings. */
export async function exportAssets(
  deps: AssetRunDeps,
  state: AssetExportState,
  assets: readonly Asset[] = state.assets,
): Promise<AssetExportResult> {
  const plan = planFiles(assets, state.settings);
  const files: AssetFile[] = [];
  const problems: AssetProblem[] = [];
  let svgNotes = 0;
  deps.onProgress?.(0, plan.length);
  for (const [i, file] of plan.entries()) {
    const { asset, setting, fileName } = file;
    const mimeType = MIME[setting.format];
    try {
      if (RASTER_FORMATS.has(setting.format)) {
        const out = await raster(deps, state, file);
        if (out instanceof Uint8Array) {
          files.push({ fileName, bytes: out, mimeType });
        } else {
          problems.push(out);
        }
      } else if (setting.format === "svg") {
        const { svg, report } = await deps.client.exportSvg(
          asset.pageId as never,
          asset.elementIds,
        );
        svgNotes += report.notes.length;
        files.push({
          fileName,
          bytes: new TextEncoder().encode(svg),
          mimeType,
        });
      } else if (asset.elementIds.length > 0) {
        // A PDF of some items needs an item-filtered PDF export, which
        // the engine does not have yet: SVG is the vector file of an
        // object today.
        problems.push({ fileName, reason: "pdfObject" });
      } else {
        const index = deps.pageIds.indexOf(asset.pageId);
        if (index < 0) {
          problems.push({ fileName, reason: "failed", detail: "no page" });
        } else {
          const { bytes } = await deps.client.exportPdf({
            pageFrom: index,
            pageTo: index,
            title: asset.name,
          } as never);
          files.push({ fileName, bytes, mimeType });
        }
      }
    } catch (e) {
      problems.push({ fileName, reason: "failed", detail: String(e) });
    }
    deps.onProgress?.(i + 1, plan.length);
  }
  return { files, problems, svgNotes };
}

/** Hand the files over: several as one ZIP (`zipped`), else one download
 *  each. Answers how many downloads were started. */
export function deliverAssets(
  files: readonly AssetFile[],
  options: { zipped: boolean; archiveName: string },
  save: (bytes: Uint8Array, name: string, mimeType: string) => void,
): number {
  if (files.length === 0) return 0;
  if (options.zipped && files.length > 1) {
    save(
      zip(files.map((f) => [f.fileName, f.bytes] as const)),
      options.archiveName,
      "application/zip",
    );
    return 1;
  }
  for (const f of files) save(f.bytes, f.fileName, f.mimeType);
  return files.length;
}
