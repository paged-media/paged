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

// The words of the editor's chrome (plan E10): the menu bar, the command
// palette, the header, the tool rail, the fill/stroke cluster and the
// dialogs. Components read them through `useStrings()`; command titles
// registered from an effect read the active catalogue (`t`).

import { defineMessages, type Strings } from "@paged-media/strings";

/**
 * The menu bar's names, by the English path segment. A menu path
 * (`File/Export PDF…`, `Window/Styles/Swatches`) is an identity and stays
 * English; its segments are translated where they are shown
 * (`menuLabel`). A package that registers menu items adds the segments it
 * creates to this namespace.
 */
export const MENU = defineMessages("menu", {
  File: "File",
  Edit: "Edit",
  Insert: "Insert",
  Object: "Object",
  Type: "Type",
  Layout: "Layout",
  View: "View",
  Plugins: "Plugins",
  Window: "Window",
  Help: "Help",
  Workspace: "Workspace",
  Structure: "Structure",
  Styles: "Styles",
  Text: "Text",
  Properties: "Properties",
  Output: "Output",
  Developer: "Developer",
  Other: "Other",
  Panels: "Panels",
});

/** A menu path segment in the editor's language: `menu.<segment>` when a
 *  package defines it, else the segment as it was registered. */
export function menuLabel(strings: Strings, segment: string): string {
  const key = `menu.${segment}`;
  const text = strings.t(key);
  return text === key ? segment : text;
}

/** The command palette's category headings, by the English category a
 *  command registers (`category: "View"`), translated where shown
 *  (`categoryLabel`). */
export const COMMAND_CATEGORY = defineMessages("commandCategory", {
  Actions: "Actions",
  Appearance: "Appearance",
  Assistant: "Assistant",
  Color: "Color",
  Data: "Data",
  Edit: "Edit",
  File: "File",
  Help: "Help",
  Image: "Image",
  Insert: "Insert",
  Layers: "Layers",
  Layout: "Layout",
  Object: "Object",
  Other: "Other",
  Sheet: "Sheet",
  Tools: "Tools",
  Type: "Type",
  View: "View",
  Web: "Web",
});

/** A command category in the editor's language: `commandCategory.<name>`
 *  when a package defines it, else the category as registered. */
export function categoryLabel(strings: Strings, category: string): string {
  const key = `commandCategory.${category}`;
  const text = strings.t(key);
  return text === key ? category : text;
}

export const MENU_BAR = defineMessages("shell.menuBar", {
  mainMenu: "Main menu",
  soon: "soon",
  namesakePanel: "{name} panel",
});

export const PALETTE = defineMessages("shell.palette", {
  placeholder: "Ask or search anything…",
  noResults: "No results.",
  assistant: "Assistant",
  askClaude: "Ask Claude: “{query}”",
  recent: "Recent",
  suggestedIn: "Suggested in {mode}",
  suggestedHere: "Suggested in this mode",
  run: "run",
  navigate: "navigate",
});

export const HEADER = defineMessages("shell.header", {
  untitled: "Untitled document",
  noDocument: "No document",
  edited: "Edited — not saved",
  noUnsavedEdits: "No unsaved edits",
  searchOrAsk: "Search or ask…",
  // Split before ")": the strings guard reads "})" as the end of the call.
  searchOrAskKey: "Search or ask ({key}" + ")",
  lightMode: "Light mode",
  darkMode: "Dark mode",
});

export const COLLAB = defineMessages("shell.collab", {
  share: "Share",
  soon: "Sharing and collaboration are coming soon",
});

export const FILE_DROP = defineMessages("shell.fileDrop", {
  prompt: "Drop an IDML file here, or ",
});

export const ZOOM = defineMessages("shell.zoom", {
  fitPage: "Fit page in window",
  fitSpread: "Fit spread in window",
  fitSelection: "Fit selection in window",
  fitDocument: "Fit document",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  zoom100: "Zoom to 100%",
});

export const MODE_SWITCHER = defineMessages("shell.modeSwitcher", {
  label: "Workflow mode",
  zoom: "Zoom",
});

export const SOFT_PROOF = defineMessages("shell.softProof", {
  label: "Proof colors",
  needsProfile:
    "Proof colors — register an output profile first (Color settings)",
  on: "Proof colors: on — click to turn off",
  simulate: "Proof colors: simulate {profile}",
  simulateOutput: "Proof colors: simulate output",
});

export const SCREEN_MODE = defineMessages("shell.screenMode", {
  title: "Screen mode: {mode}",
});

export const REGIONS = defineMessages("shell.regions", {
  actions: "Actions",
});

export const EDIT_CONTEXT = defineMessages("shell.editContext", {
  label: "Edit context",
  editing: "Editing",
  exit: "Exit edit context (Esc)",
});

export const TOOL_OPTIONS = defineMessages("shell.toolOptions", {
  label: "Tool options",
});

export const CONTEXT_MENU = defineMessages("shell.contextMenu", {
  label: "Canvas",
});

export const PANEL_RAIL = defineMessages("shell.panelRail", {
  label: "Panels",
});

export const CONTEXT_TOOLBAR = defineMessages("shell.contextToolbar", {
  focusMode: "Focus mode (⌘\\, or Tab on the canvas)",
  noTools: "no canvas tools apply here",
  escToLeave: "Esc to leave",
});

export const APPLICABILITY = defineMessages("shell.applicability", {
  elsewhere: " — leaves this context",
  absent: " — coming soon",
});

export const REPLACE = defineMessages("shell.replaceDocument", {
  titleNamed: "Save changes to “{name}” first?",
  title: "Save changes to this document first?",
  wantsToOpen:
    "{requester} wants to open {document} in place of this document.",
  aDocument: "a document",
  replaces: "{action} replaces this document.",
  replacesWith: "{action} replaces this document with {document}.",
  unsaved: "It has unsaved edits; if you don’t save, they are lost.",
  dontSave: "Don’t save",
  cancel: "Cancel",
  save: "Save",
});

export const EXPORT_PDF = defineMessages("shell.exportPdf", {
  title: "Export PDF",
  description:
    "Print-grade PDF from the live document — text stays text, CMYK and spot inks keep their numbers.",
  conformance: "Conformance",
  outputIntent: "Output intent",
  workingSpace: "Document working space",
  // Split before ")": the strings guard reads "})" as the end of the call.
  workingSpaceNamed: "Document working space ({profile}" + ")",
  x4NeedsProfile:
    "PDF/X-4 requires an output-intent profile — register one in the Color settings panel or switch to PDF 1.7.",
  color: "Color",
  preserveNumbers: "Preserve numbers",
  convertToDestination: "Convert to destination",
  pages: "Pages",
  // Split before ")": the strings guard reads "})" as the end of the call.
  allPages: "All ({count}" + ")",
  rangeInvalid: "Range must be within 1–{count}.",
  bleed: "Bleed",
  documentBleed: "Use document bleed",
  ptAllSides: "pt (all sides)",
  marks: "Marks",
  cropMarks: "Crop",
  registrationMarks: "Registration",
  colorBars: "Color bars",
  include: "Include",
  bookmarks: "Bookmarks",
  tagged: "Create Tagged PDF",
  downsample: "Downsample images",
  downsampleOff: "Off (preserve)",
  downsampleTo: "to {ppi} ppi",
  progress: "Exporting page {done} / {total}…",
  failed: "Export failed: {message}",
  cancel: "Cancel",
  export: "Export",
  exported: "Exported {file} · {count, plural, one {# page} other {# pages}}",
  dismiss: "Dismiss",
  findings: "{count, plural, one {# finding} other {# findings}}: {list}",
});

export const FILL_STROKE = defineMessages("shell.fillStroke", {
  swap: "Swap fill and stroke",
  swapKey: "Swap fill and stroke (X)",
  default: "Default fill and stroke",
  defaultKey: "Default fill and stroke (D)",
  toggleAffects: "Toggle formatting affects container/text",
  applyColor: "Apply last colour",
  applyGradient: "Apply last gradient",
  noGradients: "No gradient swatches in this document",
  applyNone: "Apply None",
  affects: "Formatting affects {target}",
  affectsKey: "Formatting affects: {target} (J)",
  affectsContainer: "container",
  affectsText: "text",
  waiting: "Waiting for the document to load",
  fillWell: "Fill — click to choose a colour",
  strokeWell: "Stroke — click to choose a colour",
  none: "None",
});

export const TOOL_RAIL = defineMessages("shell.toolRail", {
  tools: "Tools",
  foot: "Fill, stroke and view",
  groupTools: "{tool} tools",
  closePalette: "Close palette",
  tearOff: "Tear off",
  tearOffTitle: "Tear off into a floating palette",
  comingSoon: "Coming soon",
  toolComingSoon: "{tool} — coming soon",
  more: "Hold or right-click for {count, plural, one {# more tool} other {# more tools}}",
});
