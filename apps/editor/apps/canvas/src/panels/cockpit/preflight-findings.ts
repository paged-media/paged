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

// Cockpit — shared last-export preflight findings store (app-local).
//
// The worker's `pdfExported` reply carries structured
// `PreflightFinding[]` (code/severity/message/pageIndex) alongside the
// legacy flat `diagnostics: string[]`.
//
// W3.A2: `client.exportPdf(...)` now surfaces BOTH off its typed return
// (the packages/client gap is closed), so the Preflight panel feeds
// this store directly from the export's resolved value via
// `recordFindings(...)` — the W2.12 broadcast-capture workaround is
// gone. A store in the editor's scope (plan task E1) still lets the
// Preflight panel (which runs the export) and the Publication-health
// panel (which reflects the last run's counts) read the SAME findings
// without re-exporting; only the `documentLoaded` RESET still rides the
// broadcast (it has no typed return to hang off).
//
// One CanvasClient exists per editor, so one store per editor is
// sufficient; it resets on `documentLoaded` so stale findings never bleed
// across documents.

import { useSyncExternalStore } from "react";

import type { CanvasClient, PreflightFinding } from "@paged-media/client";
import {
  createValueStore,
  scoped,
  useScoped,
  type EditorScope,
} from "@paged-media/shell";

export interface PreflightFindingsState {
  /** `null` until the first export of the current document completes. */
  findings: PreflightFinding[] | null;
  /** Legacy flat diagnostics from the same reply (kept for the
   *  Preflight panel's text cards when no structured findings exist). */
  diagnostics: string[];
  /** Monotonic counter — bumps on every captured export reply so
   *  consumers can tell "ran but found nothing" from "never ran". */
  runCount: number;
}

const EMPTY: PreflightFindingsState = {
  findings: null,
  diagnostics: [],
  runCount: 0,
};

const FINDINGS = scoped("preflightFindings", () => ({
  store: createValueStore<PreflightFindingsState>(EMPTY),
  wired: new WeakSet<CanvasClient>(),
}));

/** Record the findings from an export's TYPED return. The Preflight
 *  panel calls this with the resolved value of `client.exportPdf(...)`
 *  — the structured findings + legacy diagnostics in one shot, no
 *  broadcast capture. Bumps `runCount` so consumers tell "ran but
 *  found nothing" from "never ran". */
export function recordFindings(
  scope: EditorScope,
  result: {
    findings: PreflightFinding[];
    diagnostics: string[];
  },
): void {
  const { store } = scope.get(FINDINGS);
  store.set({
    findings: result.findings ?? [],
    diagnostics: result.diagnostics ?? [],
    runCount: store.get().runCount + 1,
  });
}

/** Live last-export findings of this component's editor. Re-renders the
 *  caller whenever a fresh export reply (or a document load) lands. The
 *  client's broadcast is subscribed once, so its `documentLoaded` reply
 *  resets the store across documents. */
export function usePreflightFindings(
  client: CanvasClient,
): PreflightFindingsState {
  const { store, wired } = useScoped(FINDINGS);
  if (!wired.has(client)) {
    wired.add(client);
    client.subscribe((msg) => {
      if (msg.kind === "documentLoaded") store.set(EMPTY);
    });
  }
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Severity rollup for the health tiles — `error` and `warning`
 *  counts, with everything else folded into `warning` (the engine
 *  emits only those two today, but be forgiving). */
export function severityCounts(findings: PreflightFinding[] | null): {
  errors: number;
  warnings: number;
} {
  if (!findings) return { errors: 0, warnings: 0 };
  let errors = 0;
  let warnings = 0;
  for (const f of findings) {
    if (f.severity === "error") errors++;
    else warnings++;
  }
  return { errors, warnings };
}
