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

// The words of the shell's cockpit components (plan E10): the AI
// Assistant panel, the style apply list, the list rows, the reference
// point grid, the panel status badges and the dialog's close button.

import { defineMessages } from "@paged-media/strings";

export const ASSISTANT = defineMessages("shell.aiAssistant", {
  title: "AI Assistant",
  ask: "Ask",
  newDocument: "New document",
  working: "Working",
  done: "Done",
  stopped: "Stopped",
  thinking: "Thinking…",
  stop: "Stop",
  stoppedEarly: " (It stopped before finishing.)",
  undo: "Undo",
  suggestions: "Suggestions",
  noIssues: "No overset text, image or font issues found.",
  issues: "This document has {issues}.",
  oversetStories:
    "{count, plural, one {# overset story} other {# overset stories}}",
  lowResImages:
    "{count, plural, one {# low-resolution image} other {# low-resolution images}}",
  missingImages:
    "{count, plural, one {# missing image} other {# missing images}}",
  missingFonts: "{count, plural, one {# missing font} other {# missing fonts}}",
  askPlaceholder: "Ask for a change — “make this spread more premium”…",
  askLabel: "Ask the AI Assistant",
  askClaude: "Ask Claude",
  briefIntro:
    "Describe the document. Claude builds it page by page in a new document while you watch; every step can be undone.",
  briefPlaceholder:
    "A four-page spring catalogue for a small tea shop: cover with a large headline, two pages of products with prices, a back page with opening hours and the address.",
  briefLabel: "Brief",
  pageSize: "Page size",
  buildDocument: "Build document",
  sizeLetter: "US Letter",
  sizeSquare: "Square 210 mm",
  creatingDocument: "Creating a new document",
  shortenText: "Shorten text to fit",
  adjustSpacing: "Adjust spacing to fit",
  flowNewFrame: "Flow into a new frame",
  addPage: "Add 1 more page",
  fitImage: "Fit the image proportionally",
  centreImage: "Centre the image in its frame",
  centreOnPage: "Centre on the page",
  alignMargins: "Align to the margins",
  tidyLayout: "Tidy the layout of this page",
});

export const PANEL_STATUS_TEXT = defineMessages("shell.panelStatus", {
  live: "Live",
  partial: "Partial",
  concept: "Concept",
  target: "Target · ",
});

export const APPLY_LIST = defineMessages("shell.applyList", {
  appliedStyle: "Applied style",
  mixed: "(Mixed)",
  none: "[None]",
  clearOverride: "Clear override — awaiting engine support",
  next: "Next:",
  overrides: "Overrides",
  newStyle: "New style",
  redefineStyle: "Redefine style from selection — awaiting engine support",
  deleteStyle: "Delete style",
});

export const LIST_ROWS = defineMessages("shell.listRows", {
  filter: "Filter",
});

export const REFERENCE_POINT = defineMessages("shell.referencePoint", {
  label: "Reference point",
  topLeft: "Top left",
  top: "Top",
  topRight: "Top right",
  left: "Left",
  center: "Center",
  right: "Right",
  bottomLeft: "Bottom left",
  bottom: "Bottom",
  bottomRight: "Bottom right",
});

export const DIALOG = defineMessages("shell.dialog", {
  close: "Close",
});
