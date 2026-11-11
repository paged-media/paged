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

// The fonts a Word document embeds, given to the document (doc ADR 626).
// The engine (docx-js) unlocks every face Word obfuscated and decides from its
// licence which ones an editable document may use; this file only hands
// those to the host's document-font door and reports what the host refused,
// as paged.slide does for a deck (slide ADR 707).
//
// The door (`host.assets.registerDocumentFont`, plugin-sdk ADR 328) fills a
// gap and never replaces a face the document already has, so a font
// installed on the machine wins over the copy in the file, as in Word. A face
// lives as long as the document it was given to (plugin-sdk ADR 330), so it
// is given after the document opens; the source .docx the document keeps as
// a container part brings the faces back each time it is reopened. The
// font parts themselves are never touched: they stay in the source package.

import type { BundleHost, Diagnostic } from "@paged-media/plugin-api";
import { giveEmbeddedFonts, usableFaces } from "@paged-media/helpers";

import { t } from "@paged-media/strings";

import type { DocFonts, EmbeddedFaceReport } from "./engine.js";
import { DOC } from "./messages.js";

/** The diagnostics lane of the embedded fonts. */
export const FONT_DIAGNOSTICS = "media.paged.doc/embedded-fonts";

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
    message: t(DOC.fontRefused, {
      family: r.family,
      style: r.style,
      reason: r.reason,
    }),
    source: "docx",
  }));
}

/**
 * Give the open document the faces its engine session holds and set the
 * lane: the engine's lines for the faces it did not use, then what the host
 * refused. Nothing happens, and no lane is set, for a document that embeds
 * no font.
 */
export async function giveEngineFonts(
  host: BundleHost,
  fonts: DocFonts,
): Promise<void> {
  if (fonts.faces.length === 0) return;
  const refused = await giveDocumentEmbeddedFonts(
    host,
    fonts.faces,
    fonts.data,
  );
  host.diagnostics.set(FONT_DIAGNOSTICS, [
    ...fonts.diagnostics.map((message) => ({
      severity: "warning" as const,
      message,
      source: "docx",
    })),
    ...refused,
  ]);
}
