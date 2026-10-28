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

// Editor ADR 2XX — Asset Export, the actions and the commands. The panel
// (`paged.object-export`) and the commands run the same actions over the
// one scoped store, so File ▸ Export ▸ Asset Export…, Object ▸ Collect for
// Export and the panel's buttons cannot disagree.

import {
  cockpitActionsOf,
  scopeOf,
  type CommandContribution,
  type MenuItemContribution,
  type PagedEditor,
} from "@paged-media/shell";
import type { ElementId } from "@paged-media/client";
import { defineMessages, t } from "@paged-media/strings";

import { objectVerbApplies } from "../object-commands";
import { problemsOf } from "../panels/problems-store";
import { downloadBytes } from "../shell-file-saver";
import {
  addAssets,
  assetExportStoreOf,
  type Asset,
  type AssetExportState,
} from "./model";
import {
  deliverAssets,
  exportAssets,
  itemDrafts,
  pageDrafts,
  type AssetExportResult,
  type AssetNames,
  type AssetProblem,
  type PageRow,
} from "./run";

export const M = defineMessages("app.assetExport", {
  assetExport: "Asset Export…",
  collectMultiple: "Collect for Export: As Multiple Assets",
  collectSingle: "Collect for Export: As Single Asset",
  collectPages: "Collect All Artboards and Pages for Export",
  exportAll: "Export All Assets",
  pageName: "Page {label}",
  objectName: "Asset {n}",
  needsSelection: "Select a page item to collect it for export.",
  skipped:
    "{count, plural, one {# item is on the pasteboard and belongs} other {# items are on the pasteboard and belong}} to no page: not collected.",
  nothingToExport: "Collect an asset to export it.",
  exported: "Exported {count, plural, one {# file} other {# files}}.",
  exportedZip: "Exported {count} files as one ZIP.",
  nothingDrawn: "{name}: the asset draws nothing.",
  unsupported: "{name}: this engine cannot write the format.",
  pdfObject:
    "{name}: a PDF exports a page or an artboard; export an object as SVG.",
  failed: "{name}: the export failed ({detail}).",
  svgNotes:
    "The SVG writer approximated or left out {count, plural, one {# detail} other {# details}}; File ▸ Export ▸ SVG lists them.",
});

defineMessages("menu", {
  "Asset Export…": "Asset Export…",
  "Collect for Export": "Collect for Export",
  "As Multiple Assets": "As Multiple Assets",
  "As Single Asset": "As Single Asset",
});

/** The panel's id: the dock slot of the former Object Export Options
 *  concept. */
export const ASSET_EXPORT_PANEL = "paged.object-export";

export const PAGED_FILE_ASSET_EXPORT = "paged.file.assetExport";
export const PAGED_ASSET_EXPORT_COLLECT = "paged.assetExport.collectMultiple";
export const PAGED_ASSET_EXPORT_COLLECT_SINGLE =
  "paged.assetExport.collectSingle";
export const PAGED_ASSET_EXPORT_COLLECT_PAGES =
  "paged.assetExport.collectPages";
export const PAGED_ASSET_EXPORT_EXPORT_ALL = "paged.assetExport.exportAll";

const PROBLEMS_SOURCE = "paged.assetExport";

const isPageItem = (id: ElementId): boolean =>
  id.kind === "textFrame" ||
  id.kind === "rectangle" ||
  id.kind === "oval" ||
  id.kind === "graphicLine" ||
  id.kind === "polygon" ||
  id.kind === "group";

interface AssetState {
  selection?: { elementSelection?: readonly ElementId[] } | null;
  document?: { handle?: { pageCount?: number } | null } | null;
}

const hasDocument = (state: unknown): boolean =>
  ((state as AssetState | null)?.document?.handle?.pageCount ?? 0) > 0;

/** The panel and Collect All need a document. */
export const assetExportApplies = (state: unknown): boolean =>
  hasDocument(state);

/** Collect for Export needs selected page items, at the object level. */
export const collectApplies = (state: unknown): boolean =>
  objectVerbApplies(state) &&
  hasDocument(state) &&
  ((state as AssetState | null)?.selection?.elementSelection ?? []).some(
    isPageItem,
  );

const NAMES: AssetNames = {
  page: (label) => t(M.pageName, { label }),
  object: (n) => t(M.objectName, { n }),
};

/** Show the Asset Export panel. */
export function openAssetExport(paged: PagedEditor): void {
  cockpitActionsOf(scopeOf(paged)).openPanel?.(ASSET_EXPORT_PANEL);
}

/** One line in the Problems list (replacing this source's last). */
function report(
  paged: PagedEditor,
  rows: ReadonlyArray<{
    severity: "info" | "warning" | "error";
    message: string;
  }>,
): void {
  problemsOf(scopeOf(paged)).publish(
    PROBLEMS_SOURCE,
    "assetExport",
    rows.map((r) => ({ ...r, source: "assetExport" })),
  );
}

/** Collect page items: one asset each, or (`single`) one for all of
 *  them. The new rows become the panel's selection. Answers the ids
 *  added. */
export async function collectItems(
  paged: PagedEditor,
  ids: readonly ElementId[],
  single: boolean,
): Promise<string[]> {
  const items = ids.filter(isPageItem);
  if (items.length === 0) {
    report(paged, [{ severity: "info", message: t(M.needsSelection) }]);
    return [];
  }
  const store = assetExportStoreOf(scopeOf(paged));
  const taken = store.get().assets.filter((a) => a.kind === "object").length;
  const { drafts, skipped } = await itemDrafts(
    paged.client,
    items,
    single,
    NAMES,
    taken,
  );
  const { state, added } = addAssets(store.get(), drafts);
  store.set({ ...state, selected: added.length ? added : state.selected });
  report(
    paged,
    skipped > 0
      ? [{ severity: "warning", message: t(M.skipped, { count: skipped }) }]
      : [],
  );
  return added;
}

/** Collect the selected page items (Object ▸ Collect for Export). */
export function collectSelection(
  paged: PagedEditor,
  single: boolean,
): Promise<string[]> {
  return collectItems(paged, paged.selection.elementSelection, single);
}

/** Collect pages and artboards (every page when `pageIds` is absent). */
export async function collectPages(
  paged: PagedEditor,
  pageIds?: readonly string[],
): Promise<string[]> {
  const pages = await paged.client.collection<PageRow>("pages");
  const store = assetExportStoreOf(scopeOf(paged));
  const { state, added } = addAssets(
    store.get(),
    pageDrafts(pages, pageIds ?? null, NAMES),
  );
  store.set(state);
  return added;
}

/** The archive's name: the document's, `-assets.zip`. */
function archiveName(paged: PagedEditor): string {
  const source = paged.document.sourceName ?? "document";
  return `${source.replace(/\.[^.]+$/, "") || "document"}-assets.zip`;
}

function problemLine(p: AssetProblem): string {
  const name = p.fileName;
  switch (p.reason) {
    case "nothingDrawn":
      return t(M.nothingDrawn, { name });
    case "unsupported":
      return t(M.unsupported, { name });
    case "pdfObject":
      return t(M.pdfObject, { name });
    default:
      return t(M.failed, { name, detail: p.detail ?? "" });
  }
}

/** What an export run hands back to its caller (the panel shows it). */
export interface AssetExportRun extends AssetExportResult {
  downloads: number;
  message: string;
}

/** The delivery door: the browser download, or a test's recorder. */
export interface AssetExportDeps {
  save?: (bytes: Uint8Array, name: string, mimeType: string) => void;
  onProgress?: (done: number, total: number) => void;
}

/** Export `assets` (every collected asset when absent) with the panel's
 *  settings, deliver the files and report what was not written. */
export async function runAssetExport(
  paged: PagedEditor,
  deps: AssetExportDeps = {},
  assets?: readonly Asset[],
): Promise<AssetExportRun> {
  const state: AssetExportState = assetExportStoreOf(scopeOf(paged)).get();
  const list = assets ?? state.assets;
  if (list.length === 0) {
    const message = t(M.nothingToExport);
    report(paged, [{ severity: "info", message }]);
    return { files: [], problems: [], svgNotes: 0, downloads: 0, message };
  }
  const result = await exportAssets(
    {
      client: paged.client,
      pageIds: (paged.document.handle?.pageIds ?? []) as readonly string[],
      onProgress: deps.onProgress,
    },
    state,
    list,
  );
  const zipped = state.zip && result.files.length > 1;
  const downloads = deliverAssets(
    result.files,
    { zipped, archiveName: archiveName(paged) },
    deps.save ?? downloadBytes,
  );
  const message = t(zipped ? M.exportedZip : M.exported, {
    count: result.files.length,
  });
  report(paged, [
    ...result.problems.map((p) => ({
      severity: "warning" as const,
      message: problemLine(p),
    })),
    ...(result.svgNotes > 0
      ? [
          {
            severity: "info" as const,
            message: t(M.svgNotes, { count: result.svgNotes }),
          },
        ]
      : []),
    { severity: "info" as const, message },
  ]);
  return { ...result, downloads, message };
}

/** The problem lines of a run, for the panel. */
export function problemLines(run: AssetExportRun): string[] {
  return run.problems.map(problemLine);
}

export function buildAssetExportCommands(
  deps: AssetExportDeps = {},
): CommandContribution[] {
  return [
    {
      id: PAGED_FILE_ASSET_EXPORT,
      get title() {
        return t(M.assetExport);
      },
      category: "File",
      when: assetExportApplies,
      handler: (paged) => openAssetExport(paged as PagedEditor),
    },
    {
      id: PAGED_ASSET_EXPORT_COLLECT,
      get title() {
        return t(M.collectMultiple);
      },
      category: "Object",
      when: collectApplies,
      handler: async (paged) => {
        await collectSelection(paged as PagedEditor, false);
        openAssetExport(paged as PagedEditor);
      },
    },
    {
      id: PAGED_ASSET_EXPORT_COLLECT_SINGLE,
      get title() {
        return t(M.collectSingle);
      },
      category: "Object",
      when: collectApplies,
      handler: async (paged) => {
        await collectSelection(paged as PagedEditor, true);
        openAssetExport(paged as PagedEditor);
      },
    },
    {
      id: PAGED_ASSET_EXPORT_COLLECT_PAGES,
      get title() {
        return t(M.collectPages);
      },
      category: "File",
      when: assetExportApplies,
      handler: async (paged) => {
        await collectPages(paged as PagedEditor);
        openAssetExport(paged as PagedEditor);
      },
    },
    {
      id: PAGED_ASSET_EXPORT_EXPORT_ALL,
      get title() {
        return t(M.exportAll);
      },
      category: "File",
      when: assetExportApplies,
      handler: async (paged) => {
        await runAssetExport(paged as PagedEditor, deps);
      },
    },
  ];
}

/** File ▸ Export ▸ Asset Export… beside the SVG rows; Object ▸ Collect for
 *  Export ▸ As Multiple Assets / As Single Asset (Illustrator's places). */
export const ASSET_EXPORT_MENU_ITEMS: MenuItemContribution[] = [
  {
    path: "File/Export/Asset Export…",
    command: PAGED_FILE_ASSET_EXPORT,
    order: 61,
    group: "produce",
    when: assetExportApplies,
  },
  {
    path: "Object/Collect for Export/As Multiple Assets",
    command: PAGED_ASSET_EXPORT_COLLECT,
    order: 90,
    group: "export",
    when: collectApplies,
  },
  {
    path: "Object/Collect for Export/As Single Asset",
    command: PAGED_ASSET_EXPORT_COLLECT_SINGLE,
    order: 91,
    group: "export",
    when: collectApplies,
  },
];
