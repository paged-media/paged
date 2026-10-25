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

// File ▸ Import ▸ SVG… and File ▸ Export ▸ SVG (engine ADR 1016).
//
// IMPORT. The engine reads the file (`requestSvgImport`, `paged-svg` over
// usvg) and answers ONE batch of native page items: paths and compound
// paths, swatches, gradients, groups, clips, opacity masks, placed
// pictures and text frames. The batch is applied through the ordinary
// mutation lane, so the file is one undo step whatever module context is
// active, and what it made is selected. The engine's report of what was
// approximated or left out reaches the Problems list, never dropped.
//
// EXPORT. The engine writes the page in view, or the selection (its view
// box fitted to what it draws), as an SVG document; it goes out through
// the app's one download door.

import type {
  CommandContribution,
  MenuItemContribution,
  PagedEditor,
} from "@paged-media/shell";
import { chooseFiles } from "@paged-media/shell";
import type {
  ElementId,
  PageId,
  SvgReport,
  WorkerToMain,
} from "@paged-media/client";
import { defineMessages, t } from "@paged-media/strings";

import { objectVerbApplies } from "./object-commands";
import { currentPageTarget } from "./insert-commands";
import { downloadBytes } from "./shell-file-saver";

const M = defineMessages("app.svgCommands", {
  importSvg: "Import SVG…",
  exportSvgPage: "Export page as SVG…",
  exportSvgSelection: "Export selection as SVG…",
  needsDocument: "SVG needs an open document.",
  needsSelection: "Export selection as SVG needs a selected page item.",
  unreadable: "{name} could not be imported: {error}",
  nothing: "{name} draws nothing to import.",
  refused: "{name} could not be imported: {error}",
  imported: "Imported {name}: {count} items.",
  approximated: "{name}: {message} ({count}×)",
  exportFailed: "SVG export failed: {error}",
  exported: "Exported {name}.",
});

// The words of this file's menu rows (`menu.<segment>`).
defineMessages("menu", {
  Import: "Import",
  Export: "Export",
  "SVG…": "SVG…",
  "SVG (page)…": "SVG (page)…",
  "SVG (selection)…": "SVG (selection)…",
});

export const PAGED_FILE_IMPORT_SVG = "paged.file.importSvg";
export const PAGED_FILE_EXPORT_SVG_PAGE = "paged.file.exportSvgPage";
export const PAGED_FILE_EXPORT_SVG_SELECTION = "paged.file.exportSvgSelection";

/** Where the commands report and how they reach files. */
export interface SvgCommandDeps {
  /** Everything one command has to say, at once (the Problems list
   *  replaces the source's rows with these). */
  report: (rows: readonly SvgProblem[]) => void;
  /** The file to import; the browser's picker when absent. */
  pickFile?: () => Promise<File | null>;
  /** Deliver an export; the browser download when absent. */
  save?: (bytes: Uint8Array, name: string, mimeType: string) => void;
}

export interface SvgProblem {
  severity: "info" | "warning" | "error";
  message: string;
}

const isPageItem = (id: ElementId): boolean =>
  id.kind === "textFrame" ||
  id.kind === "rectangle" ||
  id.kind === "oval" ||
  id.kind === "graphicLine" ||
  id.kind === "polygon" ||
  id.kind === "group";

interface SvgState {
  selection?: { elementSelection?: readonly ElementId[] } | null;
  document?: { handle?: { pageCount?: number } | null } | null;
}

const hasDocument = (state: unknown): boolean =>
  ((state as SvgState | null)?.document?.handle?.pageCount ?? 0) > 0;

/** Import and page export need a document, at the object level. */
export const svgDocumentApplies = (state: unknown): boolean =>
  objectVerbApplies(state) && hasDocument(state);

/** Selection export needs selected page items. */
export const svgSelectionApplies = (state: unknown): boolean =>
  svgDocumentApplies(state) &&
  ((state as SvgState | null)?.selection?.elementSelection ?? []).some(
    isPageItem,
  );

/** The page in view, else the document's first. */
function targetPage(paged: PagedEditor): PageId | null {
  const target = currentPageTarget(paged);
  if (target) return target.pageId;
  return paged.document.handle?.pageIds?.[0] ?? null;
}

/** Every loss of a report, one line each, for the Problems list. */
export function reportLines(name: string, report: SvgReport): string[] {
  return report.notes.map((n) =>
    t(M.approximated, { name, message: n.message, count: n.count }),
  );
}

async function selectMinted(
  paged: PagedEditor,
  reply: WorkerToMain,
): Promise<void> {
  if (reply.kind !== "mutationApplied") return;
  const minted = (reply.payload.minted ?? []).map((m) => m.element);
  // The import's top item is minted last (its group), or is the only one.
  const last = minted.at(-1) ?? reply.payload.createdId;
  if (!last) return;
  try {
    const selected = await paged.client.setElementSelection([last], "replace");
    paged.selection.setElementSelection(selected);
    paged.selection.setElementGeometry(
      await paged.client.elementGeometry(selected),
    );
  } catch {
    /* the import stands; the selection is a courtesy */
  }
}

/** Import `file` onto the page in view, as one undo step. */
export async function importSvgFile(
  paged: PagedEditor,
  deps: SvgCommandDeps,
  file: { name: string; bytes: Uint8Array },
): Promise<WorkerToMain | null> {
  const rows: SvgProblem[] = [];
  const say = (severity: SvgProblem["severity"], message: string) =>
    rows.push({ severity, message });
  try {
    return await importInto(paged, file, say);
  } finally {
    deps.report(rows);
  }
}

async function importInto(
  paged: PagedEditor,
  file: { name: string; bytes: Uint8Array },
  say: (severity: SvgProblem["severity"], message: string) => void,
): Promise<WorkerToMain | null> {
  const page = targetPage(paged);
  if (!page) {
    say("info", t(M.needsDocument));
    return null;
  }
  let result;
  try {
    result = await paged.client.importSvg(page, file.bytes);
  } catch (e) {
    say("error", t(M.unreadable, { name: file.name, error: String(e) }));
    return null;
  }
  const { plan, reply } = result;
  if (plan.error) {
    say("error", t(M.unreadable, { name: file.name, error: plan.error }));
    return null;
  }
  if (!reply) {
    say("info", t(M.nothing, { name: file.name }));
    return null;
  }
  if (reply.kind !== "mutationApplied") {
    const error =
      reply.kind === "mutationFailed" ? reply.payload.error.kind : reply.kind;
    say("error", t(M.refused, { name: file.name, error }));
    return reply;
  }
  for (const line of reportLines(file.name, plan.report)) {
    say("warning", line);
  }
  say("info", t(M.imported, { name: file.name, count: plan.report.items }));
  await selectMinted(paged, reply);
  return reply;
}

function baseName(paged: PagedEditor): string {
  const source = paged.document.sourceName ?? "document";
  return source.replace(/\.[^.]+$/, "") || "document";
}

/** Export the page in view, or the selection, as SVG. */
export async function exportSvg(
  paged: PagedEditor,
  deps: SvgCommandDeps,
  scope: "page" | "selection",
): Promise<string | null> {
  const rows: SvgProblem[] = [];
  const say = (severity: SvgProblem["severity"], message: string) =>
    rows.push({ severity, message });
  try {
    return await exportFrom(paged, deps, scope, say);
  } finally {
    deps.report(rows);
  }
}

async function exportFrom(
  paged: PagedEditor,
  deps: SvgCommandDeps,
  scope: "page" | "selection",
  say: (severity: SvgProblem["severity"], message: string) => void,
): Promise<string | null> {
  const ids =
    scope === "selection"
      ? paged.selection.elementSelection.filter(isPageItem)
      : [];
  if (scope === "selection" && ids.length === 0) {
    say("info", t(M.needsSelection));
    return null;
  }
  let page = targetPage(paged);
  if (scope === "selection") {
    // The selection's own page, not the one in view.
    try {
      const geometry = await paged.client.elementGeometry(ids);
      page = geometry.find((g) => g.pageId)?.pageId ?? page;
    } catch {
      /* the page in view */
    }
  }
  if (!page) {
    say("info", t(M.needsDocument));
    return null;
  }
  try {
    const { svg, report } = await paged.client.exportSvg(page, ids);
    const name = `${baseName(paged)}${scope === "selection" ? "-selection" : ""}.svg`;
    for (const line of reportLines(name, report)) say("warning", line);
    (deps.save ?? downloadBytes)(
      new TextEncoder().encode(svg),
      name,
      "image/svg+xml",
    );
    say("info", t(M.exported, { name }));
    return svg;
  } catch (e) {
    say("error", t(M.exportFailed, { error: String(e) }));
    return null;
  }
}

export function buildSvgCommands(deps: SvgCommandDeps): CommandContribution[] {
  const pick =
    deps.pickFile ??
    (async () =>
      (await chooseFiles({ accept: [".svg", ".svgz", "image/svg+xml"] }))[0] ??
      null);
  return [
    {
      id: PAGED_FILE_IMPORT_SVG,
      title: t(M.importSvg),
      category: "File",
      when: svgDocumentApplies,
      handler: async (paged) => {
        const file = await pick();
        if (!file) return;
        await importSvgFile(paged as PagedEditor, deps, {
          name: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
      },
    },
    {
      id: PAGED_FILE_EXPORT_SVG_PAGE,
      title: t(M.exportSvgPage),
      category: "File",
      when: svgDocumentApplies,
      handler: async (paged) => {
        await exportSvg(paged as PagedEditor, deps, "page");
      },
    },
    {
      id: PAGED_FILE_EXPORT_SVG_SELECTION,
      title: t(M.exportSvgSelection),
      category: "File",
      when: svgSelectionApplies,
      handler: async (paged) => {
        await exportSvg(paged as PagedEditor, deps, "selection");
      },
    },
  ];
}

/** File ▸ Import ▸ SVG… beside Place, File ▸ Export ▸ SVG beside Export PDF. */
export const SVG_MENU_ITEMS: MenuItemContribution[] = [
  {
    path: "File/Import/SVG…",
    command: PAGED_FILE_IMPORT_SVG,
    order: 41,
    group: "place",
    when: svgDocumentApplies,
  },
  {
    path: "File/Export/SVG (page)…",
    command: PAGED_FILE_EXPORT_SVG_PAGE,
    order: 59,
    group: "produce",
    when: svgDocumentApplies,
  },
  {
    path: "File/Export/SVG (selection)…",
    command: PAGED_FILE_EXPORT_SVG_SELECTION,
    order: 60,
    group: "produce",
    when: svgSelectionApplies,
  },
];
