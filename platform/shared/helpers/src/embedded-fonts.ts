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

// THE EMBEDDED-FONT HAND-OFF of the Office importers (doc ADR 626, slide ADR
// 707): the faces a .docx or .pptx embeds whose licence lets an editable
// document use them go to the host's document-font door
// (`host.assets.registerDocumentFont`, plugin-sdk ADR 328), each with its own
// bytes; what the host refuses comes back for the module to report in its own
// words. One implementation (PM-0017) for paged.doc and paged.slide.
//
// The door fills a gap and never replaces a face the document already has,
// so a font installed on the machine wins over the copy in the file, as in
// Word and PowerPoint.

/** One embedded face as the engine reports it: where its bytes sit in the
 *  package data, and what its licence allows (`"editable"` may be used). */
export interface EmbeddedFace {
  family: string;
  style: string;
  use: string;
  offset: number;
  length: number;
}

/** A face the host would not take, and why. */
export interface FontRefusal {
  family: string;
  style: string;
  reason: string;
}

/** The part of the host's asset surface the hand-off uses. */
export interface DocumentFontDoor {
  registerDocumentFont(
    bytes: Uint8Array,
    family: string,
    style?: string,
  ): Promise<{ status: string; reason?: string }>;
}

/** The faces the document may use, in the report's order. */
export function usableFaces<F extends EmbeddedFace>(faces: readonly F[]): F[] {
  return faces.filter((f) => f.use === "editable" && f.length > 0);
}

/** Give the document every usable face of `faces` (bytes in `data`) through
 *  `door`; the faces the host refused (a face over its budget, a door that
 *  throws), in order. */
export async function giveEmbeddedFonts(
  door: DocumentFontDoor,
  faces: readonly EmbeddedFace[],
  data: Uint8Array,
): Promise<FontRefusal[]> {
  const out: FontRefusal[] = [];
  for (const f of usableFaces(faces)) {
    let reason: string | null = null;
    try {
      const outcome = await door.registerDocumentFont(
        data.slice(f.offset, f.offset + f.length),
        f.family,
        f.style,
      );
      if (outcome.status === "refused") reason = outcome.reason ?? "";
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
    if (reason !== null) out.push({ family: f.family, style: f.style, reason });
  }
  return out;
}
