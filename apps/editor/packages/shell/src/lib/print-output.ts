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

// The print-output facts (ADR 266): ONE derivation from the document
// meta that every surface naming the working CMYK profile, the output
// intent or the print PDF's standard reads — the Prepress bar, the
// PDF/X-4 checklist, Publication health, the Document Map, the Export
// Center and its inspector, and the export dialog's default. Each surface
// used to read `cmykProfileName` / `cmykProfileActive` on its own and
// word the result its own way, so the bar named a profile the checklist
// said was not active, and Health warned about PDF/X-4 while Export read
// "Ready · PDF 1.7".

import type { DocumentMeta } from "@paged-media/client";

/** The standard the Print PDF target exports by default. */
export type PrintStandard = "pdfx4" | "pdf17";

export interface PrintOutputFacts {
  /** The working CMYK profile the document names: set in Color
   *  settings, else declared by the file (the designmap's
   *  `CMYKProfile`). A name alone may have no profile bytes behind it. */
  profileName: string | null;
  /** True only when real ICC bytes back the working space (a profile
   *  given at load, a registry hit for the declared name, or one chosen
   *  in Color settings). THE fact for "CMYK working space active". */
  profileActive: boolean;
  /** What a Print PDF embeds as its output intent unless the export
   *  dialog picks another registered profile: the active working space,
   *  else nothing. */
  outputIntent: string | null;
  /** The strictest standard the document can meet, which is what the
   *  Print PDF exports by default (finding PN-305): PDF/X-4 with an
   *  output intent, PDF 1.7 without one. */
  standard: PrintStandard;
}

type MetaFacts = Pick<DocumentMeta, "cmykProfileName" | "cmykProfileActive">;

/** Derive the facts. `null` meta (no document) reads as no profile. */
export function printOutputFacts(
  meta: MetaFacts | null | undefined,
): PrintOutputFacts {
  const profileName = meta?.cmykProfileName ?? null;
  const profileActive = meta?.cmykProfileActive ?? false;
  return {
    profileName,
    profileActive,
    outputIntent: profileActive ? profileName : null,
    standard: profileActive ? "pdfx4" : "pdf17",
  };
}

/** The working profile in words: the name when it is active, the name
 *  marked "not loaded" when the document only declares it, and "No CMYK
 *  profile" when there is none. Never the bare name of a profile whose
 *  bytes the editor does not have. */
export function workingProfileLabel(facts: PrintOutputFacts): string {
  if (facts.profileName == null) return "No CMYK profile";
  return facts.profileActive
    ? facts.profileName
    : `${facts.profileName} · not loaded`;
}

/** The standard's display name. */
export function printStandardLabel(standard: PrintStandard): string {
  return standard === "pdfx4" ? "PDF/X-4" : "PDF 1.7";
}

/** The Print PDF readiness pill (Export Center, its inspector, Health,
 *  the Document Map): either standard exports, so both read ready. */
export function printReadinessLabel(facts: PrintOutputFacts): string {
  return facts.standard === "pdfx4" ? "Ready · X-4" : "Ready · PDF 1.7";
}

/** Why the print PDF is not PDF/X-4, for a tooltip; `null` when it is. */
export function printStandardReason(facts: PrintOutputFacts): string | null {
  if (facts.standard === "pdfx4") return null;
  return facts.profileName == null
    ? "No output intent: the document has no CMYK working space, so the print PDF is PDF 1.7. Choose a profile in Color settings for PDF/X-4."
    : `No output intent: ${facts.profileName} is named but not loaded, so the print PDF is PDF 1.7. Load the profile in Color settings for PDF/X-4.`;
}
