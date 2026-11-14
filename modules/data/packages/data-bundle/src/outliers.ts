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

// Data ADR 566 — the outlier finder (the UX strategy's §7.5): the records
// most likely to break a layout, so the user previews those instead of
// paging through hundreds. It ranks what the bound fields' values (as the
// engine formats them, `evaluate_at`) say: the longest value of each text
// field against its usual length, a value that is missing, a picture whose
// proportions differ from the others', and — once the user asks to render
// them — the records whose preview oversets. Pure: values in, findings out.

export type OutlierKind = "long" | "missing" | "ratio" | "overflow";

/** One bound field's values over the records (index = record). */
export interface FieldValues {
  bindingId: string;
  /** The field's name as the user knows it (its column or binding). */
  label: string;
  kind: "text" | "image";
  values: ReadonlyArray<string | null>;
  /** An image field's width ÷ height per record, where it was read. */
  ratios?: ReadonlyArray<number | null>;
}

export interface Outlier {
  record: number;
  kind: OutlierKind;
  bindingId: string;
  field: string;
  /** Text: the value's length; ratio: the picture's ratio. */
  measure: number;
  /** What it is compared with: the field's median length or ratio. */
  usual: number;
  /** How far out it is (1 = usual); the list's order. */
  score: number;
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const blank = (v: string | null) => v === null || v.trim() === "";

/** At most this many long values per field. */
const LONG_PER_FIELD = 3;

/**
 * The outliers of `fields`, worst first: every missing value; per text
 * field, its longest values when they are at least 1.5 times the median
 * length and 8 characters longer; per image field, a ratio more than 35 %
 * off the median ratio. Records `rendered` names as overset come first.
 */
export function findOutliers(
  fields: readonly FieldValues[],
  overset: ReadonlyArray<number> = [],
): Outlier[] {
  const out: Outlier[] = [];
  for (const f of fields) {
    f.values.forEach((v, record) => {
      if (blank(v))
        out.push({
          record,
          kind: "missing",
          bindingId: f.bindingId,
          field: f.label,
          measure: 0,
          usual: 0,
          score: 3,
        });
    });
    if (f.kind === "text") {
      const lengths = f.values.map((v) => (blank(v) ? null : v!.length));
      const present = lengths.filter((n): n is number => n !== null);
      const usual = median(present);
      const long = lengths
        .map((n, record) => ({ n, record }))
        .filter(
          (x): x is { n: number; record: number } =>
            x.n !== null && x.n >= usual * 1.5 && x.n >= usual + 8,
        )
        .sort((a, b) => b.n - a.n)
        .slice(0, LONG_PER_FIELD);
      for (const { n, record } of long)
        out.push({
          record,
          kind: "long",
          bindingId: f.bindingId,
          field: f.label,
          measure: n,
          usual,
          score: usual > 0 ? n / usual : n,
        });
    }
    if (f.kind === "image" && f.ratios) {
      const present = f.ratios.filter(
        (r): r is number => r !== null && r > 0 && Number.isFinite(r),
      );
      const usual = median(present);
      if (usual > 0)
        f.ratios.forEach((r, record) => {
          if (r === null || !(r > 0)) return;
          const off = Math.max(r / usual, usual / r);
          if (off >= 1.35)
            out.push({
              record,
              kind: "ratio",
              bindingId: f.bindingId,
              field: f.label,
              measure: r,
              usual,
              score: off,
            });
        });
    }
  }
  for (const record of overset)
    out.push({
      record,
      kind: "overflow",
      bindingId: "",
      field: "",
      measure: 0,
      usual: 0,
      score: 10,
    });
  const rank: Record<OutlierKind, number> = {
    overflow: 0,
    missing: 1,
    long: 2,
    ratio: 3,
  };
  return out.sort(
    (a, b) =>
      rank[a.kind] - rank[b.kind] || b.score - a.score || a.record - b.record,
  );
}

/** The records worth rendering to look for overflow: the long values'
 *  records, worst first, without repeats, at most `max`. */
export function overflowCandidates(
  outliers: readonly Outlier[],
  max = 5,
): number[] {
  const out: number[] = [];
  for (const o of outliers) {
    if (o.kind !== "long" || out.includes(o.record)) continue;
    out.push(o.record);
    if (out.length >= max) break;
  }
  return out;
}

/** A picture's proportions as "3:2", "16:9" or "1.85:1". */
export function ratioText(r: number): string {
  const common: Array<[number, number]> = [
    [1, 1],
    [4, 3],
    [3, 2],
    [16, 9],
    [3, 4],
    [2, 3],
    [9, 16],
    [2, 1],
    [1, 2],
  ];
  for (const [w, h] of common)
    if (Math.abs(r - w / h) < 0.02) return `${w}:${h}`;
  return r >= 1 ? `${r.toFixed(2)}:1` : `1:${(1 / r).toFixed(2)}`;
}
