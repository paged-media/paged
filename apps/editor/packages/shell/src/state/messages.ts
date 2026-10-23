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
  togglePreview: "Toggle preview screen mode",
  toggleAll: "Toggle panels and tool rail",
  togglePanels: "Toggle panels (keep tool rail)",
  pickerDocuments: "Paged and IDML documents",
});

export const REPLACE = defineMessages("shell.replace", {
  creatingNew: "Creating a new document",
  opening: "Opening {name}",
  aDocument: "a document",
  requester: "{requester} wants to open {document} in place of this document. ",
  unsaved: "This document has unsaved edits. {who}{action} will discard them.",
  saveFirst: "Save with {chord} first, or continue to discard.",
});

export const LOAD = defineMessages("shell.load", {
  initialFailed: "Could not create the initial document: {error}",
  fontUnavailable:
    "default font unavailable — text in documents with missing fonts will not render",
  importFailed: "import of {name} via {importer} failed: {error}",
  reducedMode:
    "Some features are running in a reduced mode. Reload the page; if it persists, the page is not being served with the headers the editor needs (cross-origin isolation).",
});

export const SCREEN_MODE = defineMessages("shell.screenMode", {
  normal: "Normal",
  preview: "Preview",
  bleed: "Bleed",
  slug: "Slug",
  presentation: "Presentation",
});
