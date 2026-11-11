/*
 * This file is part of paged (https://paged.media).
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

// The deck's embedded fonts, given to the document (ADR 707). The engine
// (slide-js) decodes every face PowerPoint embedded and decides from its
// licence which ones an editable document may use; this file only hands
// those to the host's document-font door and reports what the host refused.
//
// The door (`host.assets.registerDocumentFont`, ADR 328 in plugin-sdk)
// fills a gap and never replaces a face the document already has, so a font
// installed on the machine wins over the copy in the deck, as in PowerPoint.
// A face lives as long as the document it was given to (plugin-sdk ADR 330;
// for the editing session on a host without `assets.documentFont@2`), so it
// is given after the deck's document opens; the source deck the importer
// keeps as a container part brings the faces back each time it is reopened.

import type {
  BundleHost,
  Diagnostic,
  DocumentFontOutcome,
} from "@paged-media/plugin-api";
import { giveEmbeddedFonts, usableFaces } from "@paged-media/helpers";

import { t } from "@paged-media/strings";

import type { EmbeddedFaceReport } from "./engine.js";
import { DECK } from "./messages.js";

export type { DocumentFontOutcome };

export { usableFaces };

/**
 * Give the document every embedded face it may use. Returns what the host
 * refused (a face over its budget), as diagnostics: the text set in such a
 * face is drawn in a substitute. The hand-off is `@paged-media/helpers`'
 * `giveEmbeddedFonts`, shared with the other Office importer.
 */
export async function giveDocumentEmbeddedFonts(
  host: BundleHost,
  faces: readonly EmbeddedFaceReport[],
  data: Uint8Array,
): Promise<Diagnostic[]> {
  const refused = await giveEmbeddedFonts(host.assets, faces, data);
  return refused.map((r) => ({
    severity: "warning" as const,
    message: t(DECK.fontRefused, {
      family: r.family,
      style: r.style,
      reason: r.reason,
    }),
    source: "pptx",
  }));
}
