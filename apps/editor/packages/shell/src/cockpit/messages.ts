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

// The words of the cockpit: its landmarks, the dock, the document's title
// bar and the page strip (plan E10).

import { defineMessages } from "@paged-media/strings";

export const COCKPIT = defineMessages("shell.cockpit", {
  leftPanels: "Left panels",
  document: "Document",
  panels: "Panels",
  closePanel: "Close {panel}",
  morePanels: "More panels",
  noPanelOpen: "No panel open.",
  panelUnavailable:
    "This panel is unavailable. It may belong to a plugin that failed to load.",
  untitled: "Untitled document",
  noDocument: "No document",
  edited: "Edited",
  scrollPagesLeft: "Scroll pages left",
  scrollPagesRight: "Scroll pages right",
  noSpreads: "Open a document to navigate its spreads.",
  fields: "Fields",
  showPreview: "Show preview",
  hidePreview: "Hide preview",
  zoom: "Zoom",
});

export const PAGES = defineMessages("shell.pages", {
  cover: "Cover",
  page: "Page {range}",
  pages: "Pages {range}",
});
