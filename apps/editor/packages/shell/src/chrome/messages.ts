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
  // The Window menu's categories (UX audit F-18, InDesign's).
  Color: "Color",
  "Type & Tables": "Type & Tables",
  "Object & Layout": "Object & Layout",
  Interactive: "Interactive",
  Utilities: "Utilities",
  Settings: "Settings",
  "Tab hides panels (InDesign)": "Tab hides panels (InDesign)",
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
  notAvailable: "Not available here",
  goToPage: "Go to page {page}",
  goToPageWords: "go to page, go to, goto, page, p",
  noSuchPage: "No page {page} in this document",
  help: "Help",
  helpTopic: "Help: {title}",
  helpWords: "help, how do i, how to",
});

export const HEADER = defineMessages("shell.header", {
  untitled: "Untitled document",
  noDocument: "No document",
  searchOrAsk: "Search or ask…",
  // Split before ")": the strings guard reads "})" as the end of the call.
  searchOrAskKey: "Search or ask ({key}" + ")",
  lightMode: "Light mode",
  darkMode: "Dark mode",
  /** The browser tab's title while a document is open (F-24). */
  pageTitle: "{name} — paged",
});

/** The header's save status (editor ADR 1203): a label per state, and the
 *  details its popover gives (where, when, why, Retry). */
export const SAVE_STATUS = defineMessages("shell.saveStatus", {
  noChanges: "No changes",
  notSavedYet: "Not saved yet",
  editing: "Unsaved changes",
  saving: "Saving…",
  savedLocally: "Saved locally",
  downloaded: "Downloaded",
  syncing: "Saved locally · Syncing…",
  synced: "Saved",
  notSynced: "Saved locally · Not synced",
  failed: "Couldn't save",
  readOnly: "Read-only",
  recovered: "Recovered · Not saved",
  detailsTitle: "Save status",
  openedFrom: "Opened from {name} at {time}. Nothing has been saved since.",
  blank: "This document has not been saved yet.",
  editingSince: "Changes made since {time} are not saved anywhere yet.",
  savingNow: "Saving now. Nothing has been written yet.",
  syncingTo: "Writing to {target}…",
  savedAt: "Saved at {time}:",
  notSyncedBecause: "Could not write to {target}: {reason}.",
  failedBecause: "The document was not saved: {reason}.",
  readOnlyBecause: "This editor cannot save this document.",
  recoveredFrom:
    "Restored from the recovery copy of {time}. It is not saved: save it to keep it.",
  inLibrary: "In this browser's library",
  inFile: "In {name}",
  asDownload: "Downloaded as {name}",
  toHost: "Handed to the application this editor runs in",
  onServer: "On the server, in {repo}",
  theFile: "the file",
  theHost: "the application",
  theServer: "the server",
  checkpoint:
    "A recovery copy was kept in this browser at {time}. It is not a save.",
  libraryFailed: "This browser's library did not keep a version of this save.",
  notPrepared:
    "{plugin} did not finish preparing; its last committed state was saved.",
  permissionDenied: "permission to write it was not granted",
  fileMissing: "it was moved or deleted",
  writeFailed: "it could not be written",
  exportFailed: "the document could not be written out",
  hostRefused: "the application did not accept it",
  remoteFailed: "the server did not accept it",
  unknown: "something went wrong",
  retry: "Retry",
  details: "Details",
});

/** The recovery prompt (editor ADR 1204): Restore, Compare, Discard. */
export const RECOVERY_PROMPT = defineMessages("shell.recoveryPrompt", {
  title: "Recover unsaved work?",
  body: "{name} had unsaved changes when the editor last closed. A recovery copy from {time} is kept in this browser.",
  restore: "Restore recovered work",
  compare: "Compare with saved",
  hideCompare: "Hide comparison",
  discard: "Discard recovered copy",
  later: "Not now",
  recoveredCopy: "Recovered copy",
  recoveredFacts: "Kept at {time}; {edits} unsaved changes; {pages} pages",
  savedVersion: "Saved version",
  inLibrary: "{name} in this browser's library, saved {time}",
  inLibraryUndated: "{name} in this browser's library",
  inFile: "The file {name}",
  neverSaved: "Never saved",
  restoreNote:
    "Restoring opens the copy as a new document, {name}. The saved version is not changed.",
  unknownPages: "?",
});

export const ENGINE_FAILURE = defineMessages("shell.engineFailure", {
  title: "The canvas engine stopped",
  body: "Nothing more can be changed in this session, and the change in progress was not applied. Work since the last save is kept in this browser's recovery copy: reload to get it back.",
  reload: "Reload",
});

/** Hover preselection and the locked mark (editor ADR 235, amended by
 *  IC6): the type of the item a click would select. */
export const HOVER = defineMessages("shell.hover", {
  rectangle: "Rectangle",
  oval: "Ellipse",
  polygon: "Polygon",
  line: "Line",
  textFrame: "Text frame",
  group: "Group",
  item: "Item",
  locked: "{kind} · locked",
});

/** What a snap line snaps to (editor ADR 1226, IC8). */
export const SNAP = defineMessages("shell.snap", {
  guide: "guide",
  margin: "margin",
  column: "column",
  pageEdge: "page edge",
  pageCenter: "page centre",
  grid: "grid",
  baseline: "baseline",
  objectEdge: "edge",
  objectCenter: "centre",
  point: "point",
  equalSpacing: "equal spacing",
  pixel: "pixel",
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
  actualSize: "Actual size",
  calibratedSize: "Calibrated size",
  calibrate: "Calibrate screen size…",
  field: "Zoom percent",
  menu: "Zoom options",
});

export const MODE_SWITCHER = defineMessages("shell.modeSwitcher", {
  label: "Workflow mode",
  zoom: "Zoom",
  back: "Go back",
  forward: "Go forward",
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
  group: "Group",
});

export const FRAME_CONTENT = defineMessages("shell.frameContent", {
  label: "Edit level",
  frame: "Frame",
  content: "Content",
  imageContent: "Image content",
  editImage: "Edit image",
});

export const CONTEXT_EXIT = defineMessages("shell.contextExit", {
  title: "Keep the changes in {label}?",
  body: "{label} has changes that are not finished yet.",
  bodyDocument:
    "Another document is about to open. {label} has changes that are not finished yet.",
  commit: "Keep changes",
  discard: "Discard changes",
  cancel: "Cancel",
});

export const TOOL_OPTIONS = defineMessages("shell.toolOptions", {
  label: "Tool options",
});

export const CONTEXT_MENU = defineMessages("shell.contextMenu", {
  label: "Canvas",
  selectUnder: "Select",
});

export const PANEL_RAIL = defineMessages("shell.panelRail", {
  label: "Panels",
});

export const CONTEXT_TOOLBAR = defineMessages("shell.contextToolbar", {
  // Split before ")": the strings guard reads "})" as the end of the call.
  focusWorkspace: "Focus workspace ({key}" + ")",
  noTools: "no canvas tools apply here",
  escToLeave: "Esc to leave",
  // Image ADR 487 (UX audit F-43): the rail is the one tool set; the bar
  // names the tool in hand and carries its options.
  toolInHand: "Tool in hand: {tool}",
  toolsInRail: "Pick tools in the tool rail",
  placement: "Placement · non-destructive",
  placementHint:
    "Moves, scales or rotates the picture inside its frame; the image's pixels are not changed.",
});

export const APPLICABILITY = defineMessages("shell.applicability", {
  elsewhere: " — leaves this context",
  absent: " — coming soon",
  openDocument: "Open a document first.",
  leaveContext: "Not while editing inside an object: press Esc to leave it.",
  leaveNamedContext: "Not while editing the {context}: press Esc to leave it.",
  leaveText: "Not while typing: press Esc to leave the text.",
  leavePathEdit: "Not while editing points: press Esc first.",
  selectObject: "Select an object first.",
  notHere: "Does not apply here.",
  notOffered: "This editor does not offer it.",
  unknownCommand: "No such command.",
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
  color: "Color",
  preserveNumbers: "Preserve numbers",
  convertToDestination: "Convert to destination",
  pages: "Pages",
  // Split before ")": the strings guard reads "})" as the end of the call.
  allPages: "All ({count}" + ")",
  currentPage: "Current page",
  range: "Range",
  fromPage: "From page",
  toPage: "To page",
  bleed: "Bleed",
  documentBleed: "Use document bleed",
  ptAllSides: "pt (all sides)",
  marks: "Marks",
  cropMarks: "Crop",
  registrationMarks: "Registration",
  colorBars: "Color bars",
  include: "Include",
  bookmarks: "Bookmarks",
  headingOutline: "Outline from headings",
  tagged: "Create Tagged PDF",
  comments: "Comments as annotations",
  downsample: "Downsample images",
  downsampleOff: "Off (preserve)",
  downsampleTo: "to {ppi} ppi",
  progress: "Writing page {done} of {total}…",
  stagePreparing: "Preparing the document…",
  stageFinishing: "Finishing the file…",
  cancel: "Cancel",
  export: "Export",
  action: "export {file}",
  notAPdf: "the engine answered with something that is not a PDF",
  exportedTo:
    "Exported {file} · {count, plural, one {# page} other {# pages}} · in your downloads",
  exportedFindings:
    "Exported {file} · {count, plural, one {# page} other {# pages}} · in your downloads · {findings, plural, one {# finding} other {# findings}}",
  showFindings: "Show findings",
  stepOutput: "1 · Output",
  stepReadiness: "2 · Readiness",
  stepPreview: "3 · What the file will be",
  preset: "Preset",
  presetCustom: "Custom",
  presetPress: "Press quality (PDF/X-4, marks)",
  presetPrint: "High-quality print (PDF 1.7, 300 ppi)",
  presetScreen: "Smallest file (PDF 1.7, 150 ppi, tagged)",
  savePreset: "Save preset…",
  presetName: "Preset name",
  save: "Save",
  levelBlocker: "Blocks the export",
  levelWarning: "Warning",
  levelOk: "Ready",
  summaryBlocked:
    "{count, plural, one {# problem blocks} other {# problems block}} the export",
  summaryWarnings:
    "Ready · {count, plural, one {# warning} other {# warnings}}",
  summaryReady: "Ready to export",
});

export const FILL_STROKE = defineMessages("shell.fillStroke", {
  swap: "Swap fill and stroke",
  swapKey: "Swap fill and stroke (X)",
  default: "Default fill and stroke",
  defaultKey: "Default fill and stroke (D)",
  toggleAffects: "Toggle formatting affects container/text",
  applyColor: "Apply last color",
  applyGradient: "Apply last gradient",
  noGradients: "No gradient swatches in this document",
  applyNone: "Apply None",
  affects: "Formatting affects {target}",
  affectsKey: "Formatting affects: {target} (J)",
  affectsContainer: "container",
  affectsText: "text",
  waiting: "Waiting for the document to load",
  fillWell: "Fill — click to choose a color",
  strokeWell: "Stroke — click to choose a color",
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
