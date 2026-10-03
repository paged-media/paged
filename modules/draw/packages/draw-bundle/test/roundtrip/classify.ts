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

// Matching observed differences against the classified ones
// (`findings.ts`) — shared by the InDesign replay and the re-import spec.

import { createHash } from "node:crypto";

import { FINDINGS, type FindingId, type Known } from "./findings";
import { stable, type Difference } from "./view";
import { unzip } from "./package";

export interface KnownAt {
  at: string;
  field: string;
  ours: unknown;
  theirs: unknown;
  finding: FindingId;
}

/** One entry per index path. */
export const expand = (known: readonly Known[]): KnownAt[] =>
  known.flatMap((k) =>
    (typeof k.at === "string" ? [k.at] : [...k.at]).map((at) => ({
      at,
      field: k.field,
      ours: k.ours,
      theirs: k.theirs,
      finding: k.finding,
    })),
  );

const key = (at: string, field: string) => `${at} ${field}`;

export interface Classification {
  /** Observed but not classified — or classified with OTHER values. */
  unclassified: Difference[];
  /** Classified but not observed. */
  missing: KnownAt[];
}

/** Every observed difference must be classified with exactly its two
 *  values, and every classified one must still occur. */
export function classify(observed: readonly Difference[], known: readonly KnownAt[]): Classification {
  const byKey = new Map(known.map((k) => [key(k.at, k.field), k]));
  const seen = new Set<string>();
  const unclassified: Difference[] = [];
  for (const d of observed) {
    const k = byKey.get(key(d.at, d.field));
    if (k && stable(k.ours) === stable(d.ours) && stable(k.theirs) === stable(d.theirs)) {
      seen.add(key(d.at, d.field));
    } else {
      unclassified.push(d);
    }
  }
  return { unclassified, missing: known.filter((k) => !seen.has(key(k.at, k.field))) };
}

/** A readable report of a classification failure. */
export const report = (c: Classification): string =>
  [
    ...c.unclassified.map(
      (d) =>
        `UNCLASSIFIED at ${d.at} (${d.refs.join(" / ")}) ${d.field}: ours ${stable(d.ours)}, InDesign ${stable(d.theirs)}`,
    ),
    ...c.missing.map(
      (k) => `NO LONGER OCCURS at ${k.at} ${k.field} (${k.finding}): was ours ${stable(k.ours)}, InDesign ${stable(k.theirs)}`,
    ),
  ].join("\n");

/** The DEFECT findings among a case's classified differences, each with
 *  the entries it covers. */
export function defectsOf(known: readonly KnownAt[]): Map<FindingId, KnownAt[]> {
  const out = new Map<FindingId, KnownAt[]>();
  for (const k of known) {
    if (FINDINGS[k.finding].verdict !== "defect") continue;
    out.set(k.finding, [...(out.get(k.finding) ?? []), k]);
  }
  return out;
}

/** A short "ours X, InDesign Y" for a test title. */
export const bothValues = (entries: readonly KnownAt[], theirs = "InDesign"): string =>
  entries
    .map((k) => `${k.at} ${k.field}: ours ${short(k.ours)}, ${theirs} ${short(k.theirs)}`)
    .join("; ");

const short = (v: unknown): string => {
  if (v && typeof v === "object" && !Array.isArray(v) && "topLeft" in (v as object)) {
    const c = (v as { topLeft: { option: string; radius: number | null } }).topLeft;
    return `${c.option}${c.radius === null ? "" : ` r${c.radius}`} x4`;
  }
  return stable(v);
};

export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The parts of an IDML package with every draw-minted NONCE id
 *  (`Color/udrawsvg<time><seq>`, `Gradient/udrawg<…>`, …) replaced by its
 *  order of first appearance — the only part of an export that depends on
 *  the clock. Everything else must be byte-identical. */
export function normalizedParts(idml: Uint8Array): Map<string, string> {
  const parts = unzip(idml);
  const names = [...parts.keys()].sort();
  const tokens = new Map<string, string>();
  const out = new Map<string, string>();
  for (const name of names) {
    const text = new TextDecoder().decode(parts.get(name)!);
    out.set(
      name,
      text.replace(/udraw[a-z]*[0-9a-f]{6,}/g, (t) => {
        if (!tokens.has(t)) tokens.set(t, `udraw<nonce ${tokens.size + 1}>`);
        return tokens.get(t)!;
      }),
    );
  }
  return out;
}
