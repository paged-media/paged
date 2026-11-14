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

import {
  commandNeeds,
  getViewToggle,
  GO_TO_PAGE_COMMAND,
  pageNamed,
  scopeOf,
  toggleViewToggle,
  whenNeeds,
} from "@paged-media/shell";

// SDK Phase 4 — canvas-app-specific commands.
//
// These are the actions that today live as direct event handlers
// (Cmd+Z, Cmd+0, the header file-picker button, etc.). Lifting them
// onto `CommandContribution`s means menu / palette / future bundle
// can all reach the same surface. The shell registers
// `paged.file.openIdml` and `paged.palette.toggle` itself; this
// module fills in the canvas-specific gaps:
//
//   paged.editor.undo / paged.editor.redo
//   paged.view.zoomIn / zoomOut / zoom100 / zoomFit
//
// The "Show: <panel>" Window-menu entries are deferred — the
// DockingSubstrate today exposes `addPanel` / `removePanel` but no
// `focusPanel` / `hasPanel` / `togglePanel`. A later commit can add
// that surface; the menu items follow once it exists.

import { ENGINE_VERSION } from "@paged-media/client";
import type {
  CommandContribution,
  KeybindingContribution,
  MenuItemContribution,
} from "@paged-media/shell";
import { defineMessages, t } from "@paged-media/strings";

const M = defineMessages("app.appCommands", {
  undo: "Undo",
  redo: "Redo",
  openPdf: "Open PDF…",
  saveAsIdml: "Save As IDML…",
  savePaged: "Save (.paged)",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  zoom100: "Zoom to 100%",
  actualSize: "Actual size",
  calibratedSize: "Calibrated size",
  calibrateScreen: "Calibrate screen size…",
  navigateBack: "Go back",
  navigateForward: "Go forward",
  zoomFit: "Fit document",
  fitPage: "Fit page in window",
  fitSpread: "Fit spread in window",
  fitSelection: "Fit selection in window",
  firstPage: "First page",
  previousPage: "Previous page",
  nextPage: "Next page",
  lastPage: "Last page",
  showTextThreads: "Show text threads",
  snapToPoints: "Snap to points",
  showHeadingAnchors: "Show heading anchors",
  showDataMarkers: "Show data markers",
  docs: "Documentation",
  idmlReference: "IDML format reference",
  reportIssue: "Report an issue…",
  goToPage: "Go to page…",
  noPage: "There is no page {page} in this document.",
  helpScripting: "Help: Scripting the editor",
  helpScriptingWords:
    "script, scripting, automate, automation, paged.set, javascript, macro",
  helpTemplates: "Help: Templates and fields",
  helpTemplatesWords:
    "template, fields, fill, form, data merge, variable data, roles",
  helpPlugins: "Help: Built-in modules",
  helpPluginsWords:
    "plugin, module, draw, image, sheet, spreadsheet, slide, word, data, web, pdf",
  helpShortcuts: "Help: Keyboard shortcuts",
  helpShortcutsWords: "keyboard, shortcut, keys, hotkey, chord, accelerator",
  undoNamed: "Undo {name}",
  redoNamed: "Redo {name}",
  about: "paged editor · engine {version}",
});

// The words of this file's menu rows; the shell's menu bar shows each
// path segment through them (`menu.<segment>`).
defineMessages("menu", {
  About: "About",
  "Open PDF…": "Open PDF…",
  "Save (.paged)": "Save (.paged)",
  "Save As IDML…": "Save As IDML…",
  Undo: "Undo",
  Redo: "Redo",
  History: "History",
  "Zoom in": "Zoom in",
  "Zoom out": "Zoom out",
  "Zoom to 100%": "Zoom to 100%",
  "Actual size": "Actual size",
  "Calibrated size": "Calibrated size",
  "Calibrate screen size…": "Calibrate screen size…",
  "Go back": "Go back",
  "Go forward": "Go forward",
  "Fit page in window": "Fit page in window",
  "Fit spread in window": "Fit spread in window",
  "Fit selection in window": "Fit selection in window",
  "Fit document": "Fit document",
  "First page": "First page",
  "Previous page": "Previous page",
  "Next page": "Next page",
  "Last page": "Last page",
  "Snap to points": "Snap to points",
  "Show heading anchors": "Show heading anchors",
  Documentation: "Documentation",
  "IDML format reference": "IDML format reference",
  "Report an issue…": "Report an issue…",
});

// The palette categories of this file's commands (`commandCategory.<name>`).
defineMessages("commandCategory", {
  Edit: "Edit",
  File: "File",
  Help: "Help",
  Layout: "Layout",
  View: "View",
});

export const PAGED_EDITOR_UNDO = "paged.editor.undo";
export const PAGED_EDITOR_REDO = "paged.editor.redo";
export const PAGED_FILE_OPEN_PDF = "paged.file.openPdf";
export const PAGED_FILE_SAVE_AS_IDML = "paged.file.saveAsIdml";
export const PAGED_FILE_SAVE_PAGED = "paged.file.savePaged";
export const PAGED_VIEW_ZOOM_IN = "paged.view.zoomIn";
export const PAGED_VIEW_ZOOM_OUT = "paged.view.zoomOut";
export const PAGED_VIEW_ZOOM_100 = "paged.view.zoom100";
export const PAGED_VIEW_ZOOM_FIT = "paged.view.zoomFit";
// ADR 1201 D-12 — the named views beside 100 %, and the calibration
// behind the physical one.
export const PAGED_VIEW_ACTUAL_SIZE = "paged.view.actualSize";
export const PAGED_VIEW_CALIBRATED_SIZE = "paged.view.calibratedSize";
export const PAGED_VIEW_CALIBRATE_SCREEN = "paged.view.calibrateScreen";
// Navigation history (UXI-CAM-016): back and forward through the places
// the explicit navigations left (editor ADR "Navigation history and one
// current page").
export const PAGED_VIEW_NAVIGATE_BACK = "paged.view.navigateBack";
export const PAGED_VIEW_NAVIGATE_FORWARD = "paged.view.navigateForward";
// The fit commands and the page keys (UX audit F-31, F-16; ADR 257).
export const PAGED_VIEW_FIT_PAGE = "paged.view.fitPage";
export const PAGED_VIEW_FIT_SPREAD = "paged.view.fitSpread";
export const PAGED_VIEW_FIT_SELECTION = "paged.view.fitSelection";
export const PAGED_VIEW_FIRST_PAGE = "paged.view.firstPage";
export const PAGED_VIEW_PREVIOUS_PAGE = "paged.view.previousPage";
export const PAGED_VIEW_NEXT_PAGE = "paged.view.nextPage";
export const PAGED_VIEW_LAST_PAGE = "paged.view.lastPage";
/** ADR 1218 — "Go to page 14" / "Go to page B-3": the palette's page
 *  navigation, `{ page }` a page's id, its name (folio) or its position. */
export const PAGED_VIEW_GO_TO_PAGE = GO_TO_PAGE_COMMAND;
/** B4 — View ▸ Show text threads. Flips a module-scope view toggle the
 *  thread-line overlay subscribes to. The menu item carries a tick while
 *  it is on (`checked`, SH-4), as InDesign's View ▸ Extras items do. */
export const PAGED_VIEW_TOGGLE_TEXT_THREADS = "paged.view.toggleTextThreads";
export const PAGED_VIEW_TOGGLE_SNAP_TO_POINTS = "paged.view.toggleSnapToPoints";
/** View ▸ Show heading anchors — the resolver's anchor badges, a
 *  diagnostic drawn only on request. */
export const PAGED_VIEW_TOGGLE_HEADING_ANCHORS =
  "paged.view.toggleHeadingAnchors";
/** View ▸ Show data markers — the frames the document's data is placed in,
 *  bracketed in their binding's sync state (editor ADR 291). */
export const PAGED_VIEW_TOGGLE_DATA_MARKERS = "paged.view.toggleDataMarkers";

/** Help — the places the app sends you to learn it. */
const HELP_LINKS = [
  {
    id: "paged.help.docs",
    title: "Documentation",
    label: M.docs,
    url: "https://docs.paged.media/",
    icon: "ui-doc",
    order: 10,
  },
  {
    id: "paged.help.idmlReference",
    title: "IDML format reference",
    label: M.idmlReference,
    url: "https://idml.paged.media/",
    icon: "ui-component",
    order: 11,
  },
  {
    id: "paged.help.reportIssue",
    title: "Report an issue…",
    label: M.reportIssue,
    url: "https://github.com/paged-media/paged/issues/new",
    icon: "ui-warn",
    order: 30,
  },
] as const;

/** ADR 1218 — "Help: …" entries the palette finds by their words (the
 *  strategy's §5.7: "How do I …" → the relevant help). Each opens its
 *  page of the documentation, or a panel of the editor's own. */
const HELP_TOPICS = [
  {
    id: "paged.help.topic.scripting",
    label: M.helpScripting,
    words: M.helpScriptingWords,
    url: "https://docs.paged.media/scripting/",
  },
  {
    id: "paged.help.topic.templates",
    label: M.helpTemplates,
    words: M.helpTemplatesWords,
    url: "https://docs.paged.media/templates/",
  },
  {
    id: "paged.help.topic.plugins",
    label: M.helpPlugins,
    words: M.helpPluginsWords,
    url: "https://docs.paged.media/plugins/",
  },
] as const;

const openExternal = (url: string) => {
  window.open(url, "_blank", "noopener,noreferrer");
};

export interface AppCommandHandlers {
  undo: () => void | Promise<void>;
  redo: () => void | Promise<void>;
  /** Pick a `.pdf` and open it as an editable native document through the
   *  paged.pdf importer (pdf.js reconstruction → host.nativeDocument.open).
   *  The counterpart to the shell's "Open IDML…", for the plugin format. */
  openPdf: () => void | Promise<void>;
  /** W3.B2 — serialise the loaded document to an `.idml` package and
   *  trigger a browser download (mirrors Export PDF's download). */
  saveAsIdml: () => void | Promise<void>;
  /** Save the loaded document as a `.paged` container — the same IDML
   *  bytes plus `manifest.json`, the native `document.pgm` model part
   *  and every `paged/<plugin>/…` part the loaded bundles wrote. This
   *  is the format that keeps plugin content; "Save As IDML…" is the
   *  lossy interchange sibling. */
  savePaged: () => void | Promise<void>;
  zoomIn: () => void;
  zoomOut: () => void;
  zoom100: () => void;
  /** An inch of the document as 96 CSS px (about 133 %), about the
   *  viewport's centre. */
  actualSize: () => void;
  /** An inch of the document as an inch on this screen; the calibration
   *  first when there is none. */
  calibratedSize: () => void;
  /** Open the screen calibration. */
  calibrateScreen: () => void;
  /** Back to the place the last explicit navigation left. */
  navigateBack: () => void;
  /** Forward again after Back. */
  navigateForward: () => void;
  zoomFit: () => void;
  fitPage: () => void;
  fitSpread: () => void | Promise<void>;
  fitSelection: () => void | Promise<void>;
  goToPage: (which: "first" | "previous" | "next" | "last") => void;
  /** Fit the page with this id in the window (ADR 1218's "Go to page"). */
  goToPageId?: (pageId: string) => void;
  /** Show a registered panel (Help: Keyboard shortcuts). */
  showPanel?: (panelId: string) => void;
}

/** How many places Back (or Forward) holds in the editor `state` is, 0
 *  when it cannot say. */
function navigationCount(state: unknown, which: "back" | "forward"): number {
  const s = state as {
    camera?: { navigation?: { state(): Record<string, number> } };
  } | null;
  return s?.camera?.navigation?.state()[which] ?? 0;
}

/** The undo hooks an active edit context may declare (ADR-012 Tier 1). */
interface UndoOwner {
  onUndo?(): boolean;
  onCanUndo?(): boolean;
  onCanRedo?(): boolean;
  undoLabel?(): string | null;
  redoLabel?(): string | null;
}

/** v66 — the edit context that owns undo right now, read off the editor
 *  handle the menu evaluates against: the active frame's type, looked up
 *  in the edit-context registry. `null` when the document stack owns it. */
function undoOwner(state: unknown): UndoOwner | null {
  const s = state as {
    editContext?: { type?: string } | null;
    registries?: { editContexts?: { get(type: string): unknown } };
  } | null;
  const type = s?.editContext?.type;
  if (!type) return null;
  const c = s?.registries?.editContexts?.get(type) as UndoOwner | undefined;
  return c?.onUndo ? c : null;
}

/** Edit ▸ Undo/Redo enablement while a context owns undo: its
 *  `onCanUndo` / `onCanRedo` (absent ⇒ enabled, ADR-012). The document
 *  stack answers no probe, so outside a context the items stay live. */
function undoOwnerAllows(state: unknown, which: "undo" | "redo"): boolean {
  const owner = undoOwner(state);
  if (!owner) return true;
  const probe = which === "undo" ? owner.onCanUndo : owner.onCanRedo;
  return probe ? probe.call(owner) : true;
}

/** "Undo Brush stroke" when the owning context names its next step. */
function undoOwnerLabel(state: unknown, which: "undo" | "redo"): string | null {
  const owner = undoOwner(state);
  const name = owner
    ? (which === "undo" ? owner.undoLabel : owner.redoLabel)?.call(owner)
    : null;
  if (!name) return null;
  return t(which === "undo" ? M.undoNamed : M.redoNamed, { name });
}

/** Build the canvas-app's command set. `handlers` is the bag of
 *  closures owned by `CanvasAppIntegration` — it's wired in there
 *  so the commands close over the same camera + animateCamera
 *  bindings the keyboard shortcuts use. */
export function buildAppCommands(
  handlers: AppCommandHandlers,
): CommandContribution[] {
  return [
    {
      id: PAGED_EDITOR_UNDO,
      title: t(M.undo),
      category: "Edit",
      handler: () => handlers.undo(),
    },
    {
      id: PAGED_EDITOR_REDO,
      title: t(M.redo),
      category: "Edit",
      handler: () => handlers.redo(),
    },
    {
      id: PAGED_FILE_OPEN_PDF,
      title: t(M.openPdf),
      category: "File",
      handler: () => handlers.openPdf(),
    },
    {
      id: PAGED_FILE_SAVE_AS_IDML,
      title: t(M.saveAsIdml),
      category: "File",
      handler: () => handlers.saveAsIdml(),
    },
    {
      id: PAGED_FILE_SAVE_PAGED,
      title: t(M.savePaged),
      category: "File",
      handler: () => handlers.savePaged(),
    },
    {
      id: PAGED_VIEW_ZOOM_IN,
      title: t(M.zoomIn),
      category: "View",
      handler: () => handlers.zoomIn(),
    },
    {
      id: PAGED_VIEW_ZOOM_OUT,
      title: t(M.zoomOut),
      category: "View",
      handler: () => handlers.zoomOut(),
    },
    {
      id: PAGED_VIEW_ZOOM_100,
      title: t(M.zoom100),
      category: "View",
      handler: () => handlers.zoom100(),
    },
    {
      id: PAGED_VIEW_ZOOM_FIT,
      title: t(M.zoomFit),
      category: "View",
      handler: () => handlers.zoomFit(),
    },
    {
      id: PAGED_VIEW_ACTUAL_SIZE,
      title: t(M.actualSize),
      category: "View",
      handler: () => handlers.actualSize(),
    },
    {
      id: PAGED_VIEW_CALIBRATED_SIZE,
      title: t(M.calibratedSize),
      category: "View",
      handler: () => handlers.calibratedSize(),
    },
    {
      id: PAGED_VIEW_CALIBRATE_SCREEN,
      title: t(M.calibrateScreen),
      category: "View",
      handler: () => handlers.calibrateScreen(),
    },
    {
      id: PAGED_VIEW_NAVIGATE_BACK,
      title: t(M.navigateBack),
      category: "Layout",
      handler: () => handlers.navigateBack(),
      when: (paged) => navigationCount(paged, "back") > 0,
    },
    {
      id: PAGED_VIEW_NAVIGATE_FORWARD,
      title: t(M.navigateForward),
      category: "Layout",
      handler: () => handlers.navigateForward(),
      when: (paged) => navigationCount(paged, "forward") > 0,
    },
    {
      id: PAGED_VIEW_FIT_PAGE,
      title: t(M.fitPage),
      category: "View",
      handler: () => handlers.fitPage(),
    },
    {
      id: PAGED_VIEW_FIT_SPREAD,
      title: t(M.fitSpread),
      category: "View",
      handler: () => handlers.fitSpread(),
    },
    {
      id: PAGED_VIEW_FIT_SELECTION,
      title: t(M.fitSelection),
      category: "View",
      handler: () => handlers.fitSelection(),
    },
    {
      id: PAGED_VIEW_GO_TO_PAGE,
      title: t(M.goToPage),
      category: "Layout",
      args: {
        kind: "struct",
        fields: { page: { kind: "text" } },
      },
      when: whenNeeds("document"),
      applicability: commandNeeds("document"),
      handler: async (paged, payload) => {
        const page = String(
          (payload as { page?: unknown } | undefined)?.page ?? "",
        );
        const client = (
          paged as {
            client?: {
              collection<T>(name: "pages"): Promise<readonly T[]>;
            };
          } | null
        )?.client;
        const rows = client
          ? await client.collection<{
              selfId: string;
              index: number;
              name: string;
            }>("pages")
          : [];
        const row =
          rows.find((r) => r.selfId === page) ?? pageNamed(rows, page);
        if (!row) throw new Error(`notFound: ${t(M.noPage, { page })}`);
        handlers.goToPageId?.(row.selfId);
      },
    },
    {
      id: PAGED_VIEW_FIRST_PAGE,
      title: t(M.firstPage),
      category: "Layout",
      handler: () => handlers.goToPage("first"),
    },
    {
      id: PAGED_VIEW_PREVIOUS_PAGE,
      title: t(M.previousPage),
      category: "Layout",
      handler: () => handlers.goToPage("previous"),
    },
    {
      id: PAGED_VIEW_NEXT_PAGE,
      title: t(M.nextPage),
      category: "Layout",
      handler: () => handlers.goToPage("next"),
    },
    {
      id: PAGED_VIEW_LAST_PAGE,
      title: t(M.lastPage),
      category: "Layout",
      handler: () => handlers.goToPage("last"),
    },
    {
      id: PAGED_VIEW_TOGGLE_TEXT_THREADS,
      title: t(M.showTextThreads),
      category: "View",
      handler: (paged) => {
        toggleViewToggle(scopeOf(paged), "textThreads");
      },
    },
    {
      id: PAGED_VIEW_TOGGLE_SNAP_TO_POINTS,
      title: t(M.snapToPoints),
      category: "View",
      handler: (paged) => {
        toggleViewToggle(scopeOf(paged), "snapToPoints");
      },
    },
    {
      id: PAGED_VIEW_TOGGLE_HEADING_ANCHORS,
      title: t(M.showHeadingAnchors),
      category: "View",
      handler: (paged) => {
        toggleViewToggle(scopeOf(paged), "headingAnchors");
      },
    },
    {
      id: PAGED_VIEW_TOGGLE_DATA_MARKERS,
      title: t(M.showDataMarkers),
      category: "View",
      handler: (paged) => {
        toggleViewToggle(scopeOf(paged), "dataMarkers");
      },
    },
    ...HELP_LINKS.map((l) => ({
      id: l.id,
      title: t(l.label),
      category: "Help",
      handler: () => openExternal(l.url),
    })),
    ...HELP_TOPICS.map((h) => ({
      id: h.id,
      title: t(h.label),
      category: "Help",
      keywords: t(h.words),
      handler: () => openExternal(h.url),
    })),
    {
      id: "paged.help.topic.shortcuts",
      title: t(M.helpShortcuts),
      category: "Help",
      keywords: t(M.helpShortcutsWords),
      handler: () => handlers.showPanel?.("paged.keyboard-shortcuts"),
    },
  ];
}

/** Menu projection. Mirrors the command ids; the MenuBar renders
 *  these grouped by the leading path segment.
 *
 *  The shell already registers `File/Open IDML…` (pointing at
 *  `paged.file.openIdml`) and `View/Toggle command palette`, so
 *  this projection covers only the items unique to the canvas app:
 *  Edit > Undo/Redo and View > Zoom*. */
export const APP_MENU_ITEMS: MenuItemContribution[] = [
  ...HELP_LINKS.map((l) => ({
    path: `Help/${l.title}`,
    command: l.id,
    order: l.order,
    group: l.order < 20 ? "learn" : "feedback",
    icon: l.icon,
  })),
  {
    path: "Help/About",
    command: "paged.help.version",
    order: 90,
    group: "about",
    kind: "label",
    labelFor: () => t(M.about, { version: ENGINE_VERSION }),
  },
  // File menu — "Open PDF…" sits right after the shell's "Open IDML…"
  // (order 10, group "open"), the plugin-format sibling of the native open.
  {
    path: "File/Open PDF…",
    command: PAGED_FILE_OPEN_PDF,
    order: 15,
    group: "open",
  },
  // File menu — real "Save As IDML…" (W3.B2). Sits in the "save"
  // group just below the disabled "Save as…" kit seam.
  // File menu — the native container save. It takes slot 31, which
  // `cockpit-menus.ts` held as a disabled `soon(...)` seam until the
  // engine's protocol-51 export door got a caller; the MenuRegistry
  // dedupes by path and would throw on a collision, so the seam is
  // gone rather than shadowed.
  {
    path: "File/Save (.paged)",
    command: PAGED_FILE_SAVE_PAGED,
    order: 31,
    group: "save",
  },
  {
    path: "File/Save As IDML…",
    command: PAGED_FILE_SAVE_AS_IDML,
    order: 33,
    group: "save",
  },
  // Edit menu
  {
    path: "Edit/Undo",
    command: PAGED_EDITOR_UNDO,
    // First in Edit whatever a bundle contributes there (paged.image's
    // selection conversions ranked above it at their own low orders).
    order: -20,
    group: "undo",
    when: (state) => undoOwnerAllows(state, "undo"),
    labelFor: (state) => undoOwnerLabel(state, "undo"),
    // Bound by useTextEditing, not the registry (see APP_KEYBINDINGS),
    // so the accelerator column needs telling.
    accelerator: "cmd+z",
  },
  {
    path: "Edit/Redo",
    command: PAGED_EDITOR_REDO,
    order: -10,
    group: "undo",
    when: (state) => undoOwnerAllows(state, "redo"),
    labelFor: (state) => undoOwnerLabel(state, "redo"),
    accelerator: "cmd+shift+z",
  },
  // Editor ADR 285 — the History panel: every step by name, click to go
  // back to one. The registry derives `paged.panel.show.<id>` for every
  // panel, which is also the palette's entry.
  {
    path: "Edit/History",
    command: "paged.panel.show.paged.history",
    order: -5,
    group: "undo",
  },
  // View menu
  {
    path: "View/Zoom in",
    command: PAGED_VIEW_ZOOM_IN,
    order: 20,
    group: "zoom",
  },
  {
    path: "View/Zoom out",
    command: PAGED_VIEW_ZOOM_OUT,
    order: 30,
    group: "zoom",
  },
  {
    path: "View/Zoom to 100%",
    command: PAGED_VIEW_ZOOM_100,
    order: 40,
    group: "zoom",
  },
  // ADR 1201 D-12 — the named views, after 100 % (which they never
  // redefine) and before the fits.
  {
    path: "View/Actual size",
    command: PAGED_VIEW_ACTUAL_SIZE,
    order: 41,
    group: "zoom",
  },
  {
    path: "View/Calibrated size",
    command: PAGED_VIEW_CALIBRATED_SIZE,
    order: 41.5,
    group: "zoom",
  },
  {
    path: "View/Calibrate screen size…",
    command: PAGED_VIEW_CALIBRATE_SCREEN,
    order: 51,
    group: "zoom",
  },
  // InDesign's View menu order: the three fits, then the whole
  // document (its "Entire pasteboard").
  {
    path: "View/Fit page in window",
    command: PAGED_VIEW_FIT_PAGE,
    order: 42,
    group: "zoom",
  },
  {
    path: "View/Fit spread in window",
    command: PAGED_VIEW_FIT_SPREAD,
    order: 44,
    group: "zoom",
  },
  {
    path: "View/Fit selection in window",
    command: PAGED_VIEW_FIT_SELECTION,
    order: 46,
    group: "zoom",
  },
  {
    path: "View/Fit document",
    command: PAGED_VIEW_ZOOM_FIT,
    order: 50,
    group: "zoom",
  },
  // Layout ▸ the page keys, as InDesign's Layout menu lists them.
  {
    path: "Layout/First page",
    command: PAGED_VIEW_FIRST_PAGE,
    order: 20,
    group: "navigate",
  },
  {
    path: "Layout/Previous page",
    command: PAGED_VIEW_PREVIOUS_PAGE,
    order: 21,
    group: "navigate",
  },
  {
    path: "Layout/Next page",
    command: PAGED_VIEW_NEXT_PAGE,
    order: 22,
    group: "navigate",
  },
  {
    path: "Layout/Last page",
    command: PAGED_VIEW_LAST_PAGE,
    order: 23,
    group: "navigate",
  },
  // InDesign's Layout ▸ Go Back / Go Forward, after the page keys.
  {
    path: "Layout/Go back",
    command: PAGED_VIEW_NAVIGATE_BACK,
    order: 24,
    group: "navigate",
  },
  {
    path: "Layout/Go forward",
    command: PAGED_VIEW_NAVIGATE_FORWARD,
    order: 25,
    group: "navigate",
  },
  // View ▸ Show text threads moved into View ▸ Editing aids ▸ Text threads
  // (view-commands.ts; editor ADR "Editing aids and Proof view"), the
  // same command and toggle.
  {
    path: "View/Snap to points",
    command: PAGED_VIEW_TOGGLE_SNAP_TO_POINTS,
    checked: (paged) => getViewToggle(scopeOf(paged), "snapToPoints"),
    order: 70,
    group: "extras",
  },
  {
    path: "View/Show heading anchors",
    command: PAGED_VIEW_TOGGLE_HEADING_ANCHORS,
    checked: (paged) => getViewToggle(scopeOf(paged), "headingAnchors"),
    order: 65,
    group: "extras",
  },
  // View ▸ Show data markers moved into View ▸ Editing aids ▸ Data
  // bindings (view-commands.ts; data ADR 566), the same command and toggle.
];

/** Keybindings that route through the command registry. Cmd-Z /
 *  Cmd-Shift-Z stay in useTextEditing.ts for now — moving them
 *  would risk a race with command registration on cold start.
 *  Zoom keybindings are safe to add because no existing shortcut
 *  already binds Cmd+= / Cmd+- in the canvas. Both cmd (mac) and
 *  ctrl (linux/win) variants register so the command fires
 *  regardless of platform — the registry treats them as distinct
 *  contributions per the parseCombo modifier vocabulary
 *  (`cmd` / `meta`, `ctrl` / `control`, `alt` / `option`, `shift`). */
export const APP_KEYBINDINGS: KeybindingContribution[] = [
  { key: "cmd+=", command: PAGED_VIEW_ZOOM_IN },
  { key: "ctrl+=", command: PAGED_VIEW_ZOOM_IN },
  { key: "cmd+-", command: PAGED_VIEW_ZOOM_OUT },
  { key: "ctrl+-", command: PAGED_VIEW_ZOOM_OUT },
  // Fit and 100 % (F-16, SH-9). They lived in a canvas hook, so the View
  // menu showed no chord and a bundle could neither see nor rebind them.
  // InDesign's chords (F-31, ADR 257): Cmd+0 fits the PAGE, Alt+Cmd+0 the
  // spread, Alt+Cmd+= the selection; the whole document takes the chord
  // InDesign gives its pasteboard view.
  { key: "cmd+0", command: PAGED_VIEW_FIT_PAGE },
  { key: "ctrl+0", command: PAGED_VIEW_FIT_PAGE },
  { key: "alt+cmd+0", command: PAGED_VIEW_FIT_SPREAD },
  { key: "alt+ctrl+0", command: PAGED_VIEW_FIT_SPREAD },
  { key: "alt+cmd+=", command: PAGED_VIEW_FIT_SELECTION },
  { key: "alt+ctrl+=", command: PAGED_VIEW_FIT_SELECTION },
  { key: "alt+shift+cmd+0", command: PAGED_VIEW_ZOOM_FIT },
  { key: "alt+shift+ctrl+0", command: PAGED_VIEW_ZOOM_FIT },
  { key: "cmd+1", command: PAGED_VIEW_ZOOM_100 },
  { key: "ctrl+1", command: PAGED_VIEW_ZOOM_100 },
  // The page keys (F-16): they lived in a canvas hook too. A text caret
  // keeps Home and End (useTextEditing consumes them first, in capture).
  { key: "home", command: PAGED_VIEW_FIRST_PAGE },
  { key: "pageup", command: PAGED_VIEW_PREVIOUS_PAGE },
  { key: "pagedown", command: PAGED_VIEW_NEXT_PAGE },
  { key: "end", command: PAGED_VIEW_LAST_PAGE },
  // Go back / Go forward (UXI-CAM-016): InDesign's Layout ▸ Go Back and
  // Go Forward chords, Cmd/Ctrl+PageUp and PageDown (on a Mac keyboard
  // without page keys, Fn+Cmd+↑ / ↓). None was taken: the bare page keys
  // page, Alt+← / → is tracking in text and Cmd+[ / ] is Arrange
  // (test/unit/keybindings.test.ts).
  { key: "cmd+pageup", command: PAGED_VIEW_NAVIGATE_BACK },
  { key: "ctrl+pageup", command: PAGED_VIEW_NAVIGATE_BACK },
  { key: "cmd+pagedown", command: PAGED_VIEW_NAVIGATE_FORWARD },
  { key: "ctrl+pagedown", command: PAGED_VIEW_NAVIGATE_FORWARD },
  // Save. Both commands shipped without a key, so the single most
  // reflexive gesture in any editor did nothing at all — and the app has
  // no autosave, so the reflex failing is not a small matter. Cmd+S is
  // the native container (.paged); Cmd+Shift+S is the interchange
  // export, which mirrors how the File menu orders them.
  //
  // Note this is still SAVE-AS-DOWNLOAD, not a save: the handler mints a
  // Blob and clicks an <a download>, so a second Cmd+S produces
  // "document (1).paged" rather than overwriting. Binding the key does
  // not fix that; it stops the gesture being silently inert while the
  // fix lands.
  { key: "cmd+s", command: PAGED_FILE_SAVE_PAGED },
  { key: "ctrl+s", command: PAGED_FILE_SAVE_PAGED },
  { key: "cmd+shift+s", command: PAGED_FILE_SAVE_AS_IDML },
  { key: "ctrl+shift+s", command: PAGED_FILE_SAVE_AS_IDML },
];
