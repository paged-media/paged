/**
 * paged.sheet — the menu bar entries.
 *
 * A top-level `Sheet` menu, plus the one verb that belongs in the host's `Object` menu: importing a workbook MINTS a page item, which is what Object ▸ Insert already means.
 *
 * Registered through `contribute.menu()`.
 *
 * The verb that puts a range or a chart on the page reads "Place … on
 * page" here, in the command titles and in the panels alike. The command
 * ids keep their older `lower…ToFrame` names, which are API.
 *
 * `Object ▸ Insert spreadsheet…` is the path the host once curated for
 * this bundle, so the item stays put for the user.
 * */

import type { BundleHost, Disposable } from "@paged-media/plugin-api";

const C = "media.paged.sheet.command";

/** `[path, command suffix, group]`. */
const ENTRIES: [path: string, suffix: string, group: string][] = [
  ["Object/Insert spreadsheet…", "importXlsx", "insert-plugin"],
  ["Sheet/New blank workbook", "newWorkbook", "workbook"],
  ["Sheet/Add sheet", "addSheet", "workbook"],
  ["Sheet/Open sheet grid", "openGrid", "grid"],
  ["Sheet/Show grid in frame", "showGridInFrame", "grid-frame"],
  ["Sheet/Hide grid in frame", "hideGridInFrame", "grid-frame"],
  ["Sheet/Place selection on page", "lowerToFrame", "place"],
  ["Sheet/Place chart on page", "lowerChartToFrame", "place"],
  ["Sheet/Paginate into threaded frames", "paginateToChain", "place"],
  ["Sheet/Insert rows", "insertRows", "structure"],
  ["Sheet/Delete rows", "deleteRows", "structure"],
  ["Sheet/Insert columns", "insertColumns", "structure"],
  ["Sheet/Delete columns", "deleteColumns", "structure"],
  ["Sheet/Sort range…", "sortRange", "edit"],
  ["Sheet/Find & replace…", "findReplace", "edit"],
  ["Sheet/Copy cells", "copySelection", "clipboard"],
  ["Sheet/Paste into sheet", "pasteSelection", "clipboard"],
  ["Sheet/Style from cell", "styleFromCell", "style"],
  ["Sheet/New sheet from dataset", "sheetFromDataset", "dataset"],
];

/** Register every entry; one Disposable drops them all. */
export function contributeMenu(host: BundleHost): Disposable {
  const handles: Disposable[] = [];
  const perGroup = new Map<string, number>();
  for (const [path, suffix, group] of ENTRIES) {
    const n = (perGroup.get(group) ?? 0) + 1;
    perGroup.set(group, n);
    handles.push(
      host.contribute.menu({
        path,
        command: `${C}.${suffix}`,
        group,
        order: n * 10,
      }),
    );
  }
  host.log.info(`contributed ${handles.length} menu entries`);
  return {
    dispose() {
      for (const h of handles) h.dispose();
      handles.length = 0;
    },
  };
}

/** Exported for the bundle's own test. */
export const MENU_ENTRIES = ENTRIES;
export const MENU_COMMAND_PREFIX = C;
