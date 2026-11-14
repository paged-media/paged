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

// The words of the shell's own commands, the replace question and the
// screen modes (plan E10). Command titles are read when a command
// registers, so they follow the editor's locale.

import { defineMessages } from "@paged-media/strings";

export const COMMANDS = defineMessages("shell.commands", {
  togglePalette: "Toggle command palette",
  showPanel: "Show: {panel}",
  hidePanel: "Hide: {panel}",
  exportPdf: "Export PDF…",
  newDocument: "New document",
  open: "Open…",
  newFromBrief: "New document from a brief…",
  importSwatches: "Import swatches (.ase)…",
  saveSwatches: "Save swatches (.ase)…",
  activateTool: "Tool: {tool}",
  togglePreview: "Proof view",
  toggleAll: "Toggle panels and tool rail",
  togglePanels: "Toggle panels (keep tool rail)",
  tabHidesPanels: "Tab hides panels (InDesign)",
  pickerDocuments: "Paged and IDML documents",
  pickerEverything: "Everything Paged opens",
});

export const REPLACE = defineMessages("shell.replace", {
  creatingNew: "Creating a new document",
  opening: "Opening {name}",
  closing: "Closing {name}",
  aDocument: "a document",
  requester: "{requester} wants to open {document} in place of this document. ",
  unsaved: "This document has unsaved edits. {who}{action} will discard them.",
  saveFirst: "Save with {chord} first, or continue to discard.",
});

/** What a drop will do (editor ADR 1205): the ghost label and its reason. */
export const DROP = defineMessages("shell.drop", {
  nothing: "Nothing to drop",
  oneAtATime: "Drop one file at a time",
  oneAtATimeReason: "Several files were dragged; Paged takes one per drop.",
  cannotDrop: "Cannot drop here",
  readOnly: "This editor is read-only.",
  fillerRole: "Filling a template does not take dropped files.",
  openPicture: "Open {name} as a new document",
  openPictureUnnamed: "Open this picture as a new document",
  importWith: "Import {name} ({importer})",
  importUnnamed: "Import this file",
  cannotPlace: "Cannot place this picture",
  noPlace: "Placing pictures is not available in this editor.",
  replacePicture: "Replace the picture in this frame",
  placeInFrame: "Place {name} in this frame",
  placeInFrameUnnamed: "Place the picture in this frame",
  place: "Place {name}",
  placeOnPasteboard: "Place {name} on the pasteboard",
  placeUnnamed: "Place this picture",
  open: "Open {name}",
  openUnnamed: "Open this document",
  replace: "Open {name} in place of this document",
  replaceUnnamed: "Open this document in place of this one",
  askFirst: "You will be asked to save your changes first.",
  importMayAsk:
    "If it opens as a document, you will be asked to save your changes first.",
  decideOnDrop: "Drop to open or import this file",
  unsupported: "Paged cannot open {ext} files",
  unsupportedNamed: "Paged cannot open {name}",
  unsupportedType: "Paged cannot open this kind of file",
  unsupportedReason:
    "It opens Paged and InDesign (IDML) documents, pictures, and the formats its modules import.",
  changed: "The document changed while dragging",
  changedReason: "Nothing was dropped. Drag the file again.",
  refused: "{label}. {reason}",
});

/** The recovery journal (editor ADR 1204). */
export const RECOVERY = defineMessages("shell.recovery", {
  recoveredName: "{name} (recovered)",
  restoring: "Restoring the recovered copy of {name}",
  unreadable: "The recovery copy of {name} could not be read.",
  notRestored:
    "The recovery copy of {name} did not open. It is kept for the next start.",
});

/** The actions the shell's own feedback names (editor ADR "Operation
 *  feedback"). */
export const FEEDBACK_ACTIONS = defineMessages("shell.feedbackActions", {
  shell: "complete the operation",
  engine: "complete the last step",
  engineReason: "the engine reported an error",
  open: "open {name}",
  openReason: "the file is damaged or uses something Paged cannot read",
});

export const LOAD = defineMessages("shell.load", {
  initialFailed: "Could not create the initial document: {error}",
  fontUnavailable:
    "default font unavailable — text in documents with missing fonts will not render",
  importFailed: "import of {name} via {importer} failed: {error}",
  notAPackage:
    "{name} was not opened: it is not a Paged or IDML document. The open document is unchanged.",
  openFailed:
    "{name} could not be opened: the file is damaged or uses something Paged cannot read. The open document is unchanged.",
  reducedMode:
    "Some features are running in a reduced mode. Reload the page; if it persists, the page is not being served with the headers the editor needs (cross-origin isolation).",
});

export const SCREEN_MODE = defineMessages("shell.screenMode", {
  normal: "Normal",
  preview: "Proof view",
  bleed: "Bleed",
  slug: "Slug",
  presentation: "Presentation",
});

export const SUB_CONTEXT = defineMessages("shell.subContext", {
  header: "Header",
  footer: "Footer",
  note: "Note",
  close: "Close",
  closeTitle: "Back to the document (Esc)",
});
