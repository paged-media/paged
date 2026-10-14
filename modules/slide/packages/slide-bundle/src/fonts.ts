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
// A face lives for the editing session; the source deck the importer keeps
// as a container part brings the faces back when the document is reopened.

import type { AssetSurface, BundleHost, Diagnostic, DocumentFontOutcome } from "@paged-media/plugin-api";

import type { EmbeddedFaceReport } from "./engine.js";

export type { DocumentFontOutcome };

/** The host's document-font door, or null where the host has no backend for
 *  it (`supports("assets.documentFont@1")` false). */
export function documentFontDoor(host: BundleHost): Pick<AssetSurface, "registerDocumentFont"> | null {
  return host.supports("assets.documentFont@1") ? host.assets : null;
}

/** The faces the document may use, in the report's order. */
export function usableFaces(faces: readonly EmbeddedFaceReport[]): EmbeddedFaceReport[] {
  return faces.filter((f) => f.use === "editable" && f.length > 0);
}

/**
 * Give the document every embedded face it may use. Returns what the host
 * refused (a face over its budget, a door it lacks), as diagnostics: the
 * text set in such a face is drawn in a substitute.
 */
export async function giveDocumentEmbeddedFonts(
  host: BundleHost,
  faces: readonly EmbeddedFaceReport[],
  data: Uint8Array,
): Promise<Diagnostic[]> {
  const usable = usableFaces(faces);
  if (usable.length === 0) return [];
  const door = documentFontDoor(host);
  if (!door) {
    const families = [...new Set(usable.map((f) => f.family))].join(", ");
    return [
      {
        severity: "warning",
        message: `This host cannot give the document the fonts the deck embeds (${families}); text set in them is drawn in a substitute.`,
        source: "pptx",
      },
    ];
  }
  const out: Diagnostic[] = [];
  for (const f of usable) {
    let outcome: DocumentFontOutcome;
    try {
      outcome = await door.registerDocumentFont(data.slice(f.offset, f.offset + f.length), f.family, f.style);
    } catch (err) {
      outcome = { status: "refused", reason: err instanceof Error ? err.message : String(err) };
    }
    if (outcome.status === "refused") {
      out.push({
        severity: "warning",
        message: `The embedded font “${f.family}” (${f.style}) was not loaded: ${outcome.reason}. Text set in it is drawn in a substitute.`,
        source: "pptx",
      });
    }
  }
  return out;
}
