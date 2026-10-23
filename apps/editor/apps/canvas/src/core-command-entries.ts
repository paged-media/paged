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

// ADR 323 §4 — the menu / palette entry points onto the typed core
// commands. Each row names a core op; its command opens the generated
// form (core-command-dialog.tsx) on `core.<op>`, prefilled from the
// selection / caret plus the row's defaults. The panels add their own
// in-place entries (Masters, Pages, Text Variables, Gradients, Cell /
// Table Styles, Conditions, Table, the Path section).

import type {
  CommandContribution,
  MenuItemContribution,
} from "@paged-media/shell";

import { scopeOf } from "@paged-media/shell";
import { openCoreCommand } from "./core-command-dialog";
import { defineMessages, t } from "@paged-media/strings";

const M = defineMessages("app.coreCommandEntries", {
  insertField: "Insert field…",
  insertHyperlink: "Insert hyperlink…",
  insertAnchoredFrame: "Insert anchored frame…",
  setFieldValue: "Set field value…",
  pathPointInsert: "Path: insert point…",
  pathPointRemove: "Path: remove point…",
  pathPointSet: "Path: move point…",
  closePath: "Path: close path",
  joinPaths: "Path: join paths",
  outlineStroke: "Path: outline stroke",
  offsetPath: "Path: offset path",
  pathfinderFaces: "Pathfinder: keep / remove faces…",
  attachTextToPath: "Type on a path: attach…",
  detachTextFromPath: "Type on a path: detach",
  applyOpacityMask: "Opacity mask: make…",
  releaseOpacityMask: "Opacity mask: release",
  duplicateElements: "Step and repeat…",
  movePage: "Move page…",
  createMaster: "New master…",
  createGradient: "New gradient…",
  renameMaster: "Rename master…",
  deleteMaster: "Delete master…",
  deleteSection: "Delete section…",
  createTextVariable: "New text variable…",
  deleteTextVariable: "Delete text variable…",
  deleteGradient: "Delete gradient…",
  createCellStyle: "New cell style…",
  deleteCellStyle: "Delete cell style…",
  createTableStyle: "New table style…",
  deleteTableStyle: "Delete table style…",
  setConditionVisible: "Show / hide condition…",
  deleteTable: "Delete table…",
  runCommand: "Run command…",
});

// The words of this file's menu rows; the shell's menu bar shows each
// path segment through them (`menu.<segment>`).
defineMessages("menu", {
  "Insert field…": "Insert field…",
  "Insert hyperlink…": "Insert hyperlink…",
  "Insert anchored frame…": "Insert anchored frame…",
  "Set field value…": "Set field value…",
  Path: "Path",
  "Insert point…": "Insert point…",
  "Remove point…": "Remove point…",
  "Move point…": "Move point…",
  "Close path": "Close path",
  "Join paths": "Join paths",
  "Outline stroke…": "Outline stroke…",
  "Offset path…": "Offset path…",
  Pathfinder: "Pathfinder",
  "Keep or remove faces…": "Keep or remove faces…",
  "Type on a path": "Type on a path",
  "Attach…": "Attach…",
  Detach: "Detach",
  "Opacity mask": "Opacity mask",
  "Make…": "Make…",
  Release: "Release",
  "Step and repeat…": "Step and repeat…",
  "Move page…": "Move page…",
  "New master…": "New master…",
  "Run command…": "Run command…",
  "Anchored frame…": "Anchored frame…",
  "Field…": "Field…",
  "Hyperlink…": "Hyperlink…",
});

// The palette categories of this file's commands (`commandCategory.<name>`).
defineMessages("commandCategory", {
  Edit: "Edit",
  Object: "Object",
  Layout: "Layout",
  Type: "Type",
  Document: "Document",
});

export interface CoreCommandEntry {
  /** The core op (the typed command is `core.<op>`). */
  op: string;
  title: string;
  /** Menu path; absent = palette only. */
  menu?: string;
  group?: string;
  order?: number;
  /** Defaults beyond what the selection / caret prefill. */
  prefill?: Record<string, unknown>;
}

/** Run any typed core command (the picker). */
export const RUN_CORE_COMMAND = "paged.core.runCommand";

export const CORE_COMMAND_ENTRIES: readonly CoreCommandEntry[] = [
  // Insert (Object menu, text-anchored inserts).
  {
    op: "insertField",
    get title() {
      return t(M.insertField);
    },
    menu: "Object/Insert field…",
    group: "insert-text",
    order: 20,
    prefill: { field: "pageNumber" },
  },
  {
    op: "insertHyperlink",
    get title() {
      return t(M.insertHyperlink);
    },
    menu: "Object/Insert hyperlink…",
    group: "insert-text",
    order: 21,
    prefill: { url: "https://" },
  },
  {
    op: "insertAnchoredFrame",
    get title() {
      return t(M.insertAnchoredFrame);
    },
    menu: "Object/Insert anchored frame…",
    group: "insert-text",
    order: 22,
    prefill: { width: 72, height: 72 },
  },
  {
    op: "setFieldValue",
    get title() {
      return t(M.setFieldValue);
    },
    menu: "Type/Set field value…",
    group: "insert",
    order: 32,
  },
  // Path (Object menu): point edits, construction, masks, type on a path.
  {
    op: "pathPointInsert",
    get title() {
      return t(M.pathPointInsert);
    },
    menu: "Object/Path/Insert point…",
    group: "path",
    order: 60,
    prefill: {
      index: 1,
      anchor: { anchor: [0, 0], left: [0, 0], right: [0, 0] },
    },
  },
  {
    op: "pathPointRemove",
    get title() {
      return t(M.pathPointRemove);
    },
    menu: "Object/Path/Remove point…",
    group: "path",
    order: 61,
    prefill: { index: 0 },
  },
  {
    op: "pathPointSet",
    get title() {
      return t(M.pathPointSet);
    },
    menu: "Object/Path/Move point…",
    group: "path",
    order: 62,
    prefill: { index: 0, role: "anchor" },
  },
  {
    op: "closePath",
    get title() {
      return t(M.closePath);
    },
    menu: "Object/Path/Close path",
    group: "path",
    order: 63,
  },
  {
    op: "joinPaths",
    get title() {
      return t(M.joinPaths);
    },
    menu: "Object/Path/Join paths",
    group: "path",
    order: 64,
  },
  {
    op: "outlineStroke",
    get title() {
      return t(M.outlineStroke);
    },
    menu: "Object/Path/Outline stroke…",
    group: "path",
    order: 65,
    prefill: { width: 1, cap: "butt", join: "miter", miterLimit: 4 },
  },
  {
    op: "offsetPath",
    get title() {
      return t(M.offsetPath);
    },
    menu: "Object/Path/Offset path…",
    group: "path",
    order: 66,
    prefill: { delta: 6, join: "miter", miterLimit: 4 },
  },
  {
    op: "pathfinderFaces",
    get title() {
      return t(M.pathfinderFaces);
    },
    menu: "Object/Pathfinder/Keep or remove faces…",
    group: "path",
    order: 67,
    prefill: { mode: "keep", faces: [] },
  },
  {
    op: "attachTextToPath",
    get title() {
      return t(M.attachTextToPath);
    },
    menu: "Object/Type on a path/Attach…",
    group: "path",
    order: 68,
  },
  {
    op: "detachTextFromPath",
    get title() {
      return t(M.detachTextFromPath);
    },
    menu: "Object/Type on a path/Detach",
    group: "path",
    order: 69,
  },
  {
    op: "applyOpacityMask",
    get title() {
      return t(M.applyOpacityMask);
    },
    menu: "Object/Opacity mask/Make…",
    group: "clip",
    order: 70,
  },
  {
    op: "releaseOpacityMask",
    get title() {
      return t(M.releaseOpacityMask);
    },
    menu: "Object/Opacity mask/Release",
    group: "clip",
    order: 71,
  },
  {
    op: "duplicateElements",
    get title() {
      return t(M.duplicateElements);
    },
    menu: "Object/Step and repeat…",
    group: "duplicate",
    order: 72,
    prefill: { offset: [12, 12] },
  },
  // Layout: pages, masters, sections.
  {
    op: "movePage",
    get title() {
      return t(M.movePage);
    },
    menu: "Layout/Move page…",
    group: "pages",
    order: 7,
  },
  {
    op: "createMaster",
    get title() {
      return t(M.createMaster);
    },
    menu: "Layout/New master…",
    group: "masters",
    order: 10,
  },
  {
    op: "renameMaster",
    get title() {
      return t(M.renameMaster);
    },
    order: 9,
  },
  {
    op: "deleteMaster",
    get title() {
      return t(M.deleteMaster);
    },
    order: 10,
  },
  {
    op: "deleteSection",
    get title() {
      return t(M.deleteSection);
    },
    order: 11,
  },
  // Named document objects (their panels carry the in-place buttons).
  {
    op: "createTextVariable",
    get title() {
      return t(M.createTextVariable);
    },
  },
  {
    op: "deleteTextVariable",
    get title() {
      return t(M.deleteTextVariable);
    },
  },
  {
    op: "createGradient",
    get title() {
      return t(M.createGradient);
    },
    prefill: {
      spec: {
        name: "New gradient",
        kind: "Linear",
        stops: [
          { stopColor: "Color/Paper", locationPct: 0 },
          { stopColor: "Color/Black", locationPct: 100 },
        ],
      },
    },
  },
  {
    op: "deleteGradient",
    get title() {
      return t(M.deleteGradient);
    },
  },
  {
    op: "createCellStyle",
    get title() {
      return t(M.createCellStyle);
    },
  },
  {
    op: "deleteCellStyle",
    get title() {
      return t(M.deleteCellStyle);
    },
  },
  {
    op: "createTableStyle",
    get title() {
      return t(M.createTableStyle);
    },
  },
  {
    op: "deleteTableStyle",
    get title() {
      return t(M.deleteTableStyle);
    },
  },
  {
    op: "setConditionVisible",
    get title() {
      return t(M.setConditionVisible);
    },
  },
  {
    op: "deleteTable",
    get title() {
      return t(M.deleteTable);
    },
  },
];

const entryCommandId = (op: string) => `paged.core.${op}`;

export function buildCoreCommandEntries(): CommandContribution[] {
  return [
    {
      id: RUN_CORE_COMMAND,
      title: t(M.runCommand),
      category: "Edit",
      handler: (paged: unknown) => openCoreCommand(scopeOf(paged), null),
    },
    ...CORE_COMMAND_ENTRIES.map((e) => ({
      id: entryCommandId(e.op),
      title: e.title,
      category: e.menu?.split("/")[0] ?? "Document",
      handler: (paged: unknown) =>
        openCoreCommand(scopeOf(paged), e.op, e.prefill ?? {}, {
          title: e.title,
        }),
    })),
  ];
}

export const CORE_COMMAND_MENU_ITEMS: MenuItemContribution[] = [
  {
    path: "Edit/Run command…",
    command: RUN_CORE_COMMAND,
    order: 90,
    group: "commands",
  },
  ...CORE_COMMAND_ENTRIES.filter((e) => e.menu).map((e) => ({
    path: e.menu!,
    command: entryCommandId(e.op),
    order: e.order ?? 100,
    group: e.group,
  })),
];
