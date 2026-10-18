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

// THE ENGINE'S OWN SENTENCE for a refused opacity-mask (C-28) or
// type-on-a-path (C-29) op. Both op families refuse with a SENTENCE, and
// the sentences are the whole point (see `commands/opacity-mask.ts` /
// `commands/text-on-path.ts` for the lists). The engine wraps them twice —
//   "frame mutation failed: invalid value for FrameTransform on
//    Polygon(\"ua\"): C-28: an item cannot mask itself"
// — so this peels the envelope and hands back the clause a user can act
// on. The `C-28` / `C-29` tag is an internal RFI marker, so it is
// stripped too; the SENTENCE is what reaches the log and the binding.

/** The engine's own sentence for a refused C-28 / C-29 op, or null when
 *  the error carries no readable text. The `regionRefusalReason`
 *  precedent, with this op family's marker. */
export function maskOrPathRefusalReason(error: unknown): string | null {
  // `JSON.stringify(null)` is the STRING "null", which would otherwise
  // be reported to a user as the reason. An absent error has no reason.
  if (error === null || error === undefined) return null;
  let text: string;
  try {
    text = typeof error === "string" ? error : (JSON.stringify(error) ?? "");
  } catch {
    return null;
  }
  if (!text) return null;
  const what = /"what"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  const raw = (what ? what[1].replace(/\\"/g, '"') : text).trim();
  const marked = /C-2[89]:\s*([\s\S]*)$/.exec(raw);
  return (marked ? marked[1] : raw).trim() || null;
}
