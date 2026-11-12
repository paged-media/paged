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

// paged.slide's losses (engine ADR 1097): the import, the resolver, the
// native writer and the export answer with the engine's one loss entry
// (`pptx-core`'s `loss`, codes `pptx.<area>.<what>`); the SDK's
// `lossDiagnostics` puts them on the diagnostics channel. An import report
// kept in a document by an older version holds plain sentences: `readLosses`
// reads either form, a sentence as a `pptx.legacy` entry (its `(×n)` suffix,
// the old count, as the count) — the same rule as the Rust reader.

import type { Diagnostic, LossEntry } from "@paged-media/plugin-api";
import { lossDiagnostics } from "@paged-media/plugin-sdk";

/** The code of a loss an older version kept as a plain sentence. */
export const LEGACY_LOSS = "pptx.legacy";

/** One loss line as an older version wrote it. */
export function legacyLoss(line: string): LossEntry {
  const m = /^(.*) \(×(\d+)\)$/s.exec(line);
  return {
    code: LEGACY_LOSS,
    count: m ? Number(m[2]) : 1,
    severity: "dropped",
    message: m ? m[1] : line,
  };
}

/** A loss list in either form (entries, or an older version's sentences);
 *  anything else is left out. */
export function readLosses(raw: unknown): LossEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: LossEntry[] = [];
  for (const r of raw) {
    if (typeof r === "string") out.push(legacyLoss(r));
    else if (r && typeof r === "object" && typeof r.code === "string")
      out.push(r as LossEntry);
  }
  return out;
}

/** Losses as the diagnostics channel's rows (the SDK's one translation). */
export function slideLossDiagnostics(
  losses: Iterable<LossEntry>,
): Diagnostic[] {
  return lossDiagnostics(losses, { source: "pptx" });
}

/** Losses as one line each, worded as the diagnostics channel words them:
 *  the typed import and export commands answer these. */
export function lossLines(losses: Iterable<LossEntry>): string[] {
  return lossDiagnostics(losses).map((d) => d.message);
}
