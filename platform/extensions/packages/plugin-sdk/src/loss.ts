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

// The loss report on the host's diagnostics channel (capability register
// C18). Every importer, exporter and mapper answers with the one
// `LossReport` shape (`paged_loss` in the engine, `LossEntry` in the
// contract); this file is the ONE translation of its entries into the
// `host.diagnostics` rows a panel lists, so a module words its format's
// codes and nothing else.

import type {
  Diagnostic,
  LossEntry,
  LossSeverity,
} from "@paged-media/plugin-api";

/** How a loss shows on the diagnostics channel: a construct left out or
 *  drawn differently is a warning, one only worth knowing is info. An
 *  entry without a severity was left out. */
export function lossDiagnosticSeverity(
  severity: LossSeverity | null | undefined,
): Diagnostic["severity"] {
  return severity === "info" ? "info" : "warning";
}

/** The order a list shows losses in: left out, drawn differently, worth
 *  knowing. */
export function lossRank(severity: LossSeverity | null | undefined): number {
  return severity === "info" ? 2 : severity === "approximated" ? 1 : 0;
}

/** What {@link lossDiagnostics} needs beyond the entries. */
export interface LossDiagnosticsOptions {
  /** Put before each message (`"paged.doc: "`). */
  prefix?: string;
  /** The diagnostic's `source` (a file or frame name). */
  source?: string;
  /** Words an entry the producer left unworded (its `message` empty):
   *  the module's own wording of its codes. Default: the code. */
  word?: (entry: LossEntry) => string;
}

/** Each loss entry as one diagnostic row, in the entries' order. The
 *  message is the entry's own (or the module's wording of its code), with
 *  `(n×)` when it happened more than once. PURE. */
export function lossDiagnostics(
  losses: Iterable<LossEntry>,
  opts: LossDiagnosticsOptions = {},
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const e of losses) {
    const text = e.message ? e.message : (opts.word?.(e) ?? e.code);
    const times = e.count > 1 ? ` (${e.count}×)` : "";
    out.push({
      severity: lossDiagnosticSeverity(e.severity),
      message: `${opts.prefix ?? ""}${text}${times}`,
      ...(opts.source != null ? { source: opts.source } : {}),
      // The entry itself rides along (extensions ADR 1107), so the host's
      // compatibility report explains the code and points at its items.
      loss: e,
    });
  }
  return out;
}
