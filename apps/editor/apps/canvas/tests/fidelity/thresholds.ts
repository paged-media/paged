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

// Per-pack ΔE/SSIM thresholds for the canvas fidelity gate.
//
// The file is the corpus's `config/canvas-fidelity-thresholds.json`, beside
// `fidelity-thresholds.json` (the engine's gate) and `break-thresholds.json`,
// whose schema it mirrors so the tooling (and human understanding) carries
// over directly. It used to be looked for at `corpus/idml/`, where it does
// not live, and a missing file read as "no thresholds": every gated pack then
// passed without a single comparison.
//
// A missing or unreadable file now FAILS when the corpus is present. Without
// a corpus the gate has nothing to compare and says so (`unavailable`); it
// never passes silently.
//
// `FIDELITY_MODE=capture` writes a fresh thresholds JSON from the
// most-recent run's worst-page metric per pack, rounded up to give
// some headroom (~25 %). Default (`gate`) mode reads the JSON and
// fails any `stage: gated` pack whose metrics exceed it.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { REPO_ROOT } from "./fixtures";

export const CORPUS_DIR = resolve(REPO_ROOT, "corpus");
export const THRESHOLDS_PATH = resolve(
  CORPUS_DIR,
  "config",
  "canvas-fidelity-thresholds.json",
);

export interface PackThreshold {
  name: string;
  /** Cap the pages we gate against — packs with > N pages clip here. */
  max_pages_with_pdf?: number;
  max_mean_de: number;
  max_p99_de: number;
  min_ssim: number;
  rationale?: string;
}

export interface ThresholdsFile {
  fixtures: PackThreshold[];
  /** Set when there is no corpus to read: the gate reports this and
   *  compares nothing. Absent whenever the file was read. */
  unavailable?: string;
}

/**
 * The thresholds the gate compares against. Throws when the corpus is
 * present but the file is missing or unreadable (a gate with no
 * thresholds would pass every pack); returns `unavailable` when there is
 * no corpus at all. `allowMissing` is for capture mode, which may write
 * the file for the first time.
 */
export function loadThresholds(
  opts: { allowMissing?: boolean } = {},
): ThresholdsFile {
  if (!existsSync(CORPUS_DIR)) {
    return {
      fixtures: [],
      unavailable: `no corpus at ${CORPUS_DIR}: the canvas fidelity thresholds are unavailable`,
    };
  }
  if (!existsSync(THRESHOLDS_PATH)) {
    if (opts.allowMissing) return { fixtures: [] };
    throw new Error(
      `[thresholds] the corpus is present but ${THRESHOLDS_PATH} is missing: the canvas fidelity gate has nothing to compare against`,
    );
  }
  let parsed: ThresholdsFile;
  try {
    parsed = JSON.parse(
      readFileSync(THRESHOLDS_PATH, "utf8"),
    ) as ThresholdsFile;
  } catch (err) {
    throw new Error(
      `[thresholds] ${THRESHOLDS_PATH} is not valid JSON: ${String(err)}`,
    );
  }
  if (!Array.isArray(parsed.fixtures) || parsed.fixtures.length === 0) {
    throw new Error(`[thresholds] ${THRESHOLDS_PATH} lists no fixtures`);
  }
  return parsed;
}

/**
 * Per-pack baseline collected by a `FIDELITY_MODE=capture` run. The
 * caller passes the worst-page metric across the pack; we apply a
 * 25 % headroom on the ΔE values and round SSIM down to two decimal
 * places (matches the `corpus/config/fidelity-thresholds.json`
 * convention).
 */
export interface CapturedBaseline {
  name: string;
  pagesWithPdf: number;
  worstMeanDe: number;
  worstP99De: number;
  worstSsim: number;
}

/**
 * Merge `baselines` into the existing thresholds file, then write
 * the file back. Existing entries with a manually-set rationale are
 * preserved unless `overwrite` is true. Returns the count of entries
 * (re)written.
 */
export function writeThresholds(
  baselines: CapturedBaseline[],
  opts: { overwrite?: boolean } = {},
): number {
  const overwrite = opts.overwrite ?? false;
  const cur = loadThresholds({ allowMissing: true });
  if (cur.unavailable) throw new Error(`[thresholds] ${cur.unavailable}`);
  const byName = new Map(cur.fixtures.map((f) => [f.name, f]));
  let written = 0;
  for (const b of baselines) {
    const existing = byName.get(b.name);
    if (existing && existing.rationale && !overwrite) continue;
    const thr: PackThreshold = {
      name: b.name,
      max_pages_with_pdf: b.pagesWithPdf,
      max_mean_de: roundUp2(b.worstMeanDe * 1.25),
      max_p99_de: roundUp2(b.worstP99De * 1.25),
      min_ssim: floorDown2(b.worstSsim * 0.98),
      rationale:
        `auto-captured by FIDELITY_MODE=capture; baseline worst page ` +
        `meanΔE=${b.worstMeanDe.toFixed(3)} p99ΔE=${b.worstP99De.toFixed(3)} ` +
        `ssim=${b.worstSsim.toFixed(4)}, +25% headroom`,
    };
    byName.set(b.name, thr);
    written += 1;
  }
  const next: ThresholdsFile = {
    fixtures: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
  writeFileSync(THRESHOLDS_PATH, JSON.stringify(next, null, 2) + "\n");
  return written;
}

function roundUp2(n: number): number {
  return Math.ceil(n * 100) / 100;
}

function floorDown2(n: number): number {
  return Math.max(0, Math.floor(n * 100) / 100);
}
