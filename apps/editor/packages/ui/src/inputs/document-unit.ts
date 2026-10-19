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

// The document's measurement unit (editor ADR 245): ONE place that says
// which unit lengths are shown in, and one parser that reads what a user
// types into a length field. InDesign's model: Preferences ▸ Units &
// Increments sets the ruler unit every geometry field shows; a value
// typed with a unit ("10mm", "1in", "6p") is converted, a bare number is
// read in the current unit. Type sizes, leading and stroke weights keep
// points (InDesign's separate "Type" and "Stroke" units).

import { useSyncExternalStore } from "react";

import { POINTS_PER_UNIT, type LengthUnit } from "./units";

/** The units the preference offers, in menu order, with their names. */
export const DOCUMENT_UNITS: ReadonlyArray<readonly [LengthUnit, string]> = [
  ["pt", "Points"],
  ["pc", "Picas"],
  ["in", "Inches"],
  ["mm", "Millimetres"],
  ["cm", "Centimetres"],
  ["px", "Pixels"],
];

const STORAGE_KEY = "paged.units";

export function isLengthUnit(v: unknown): v is LengthUnit {
  return typeof v === "string" && Object.hasOwn(POINTS_PER_UNIT, v);
}

function stored(): LengthUnit {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isLengthUnit(v) ? v : "pt";
  } catch {
    return "pt";
  }
}

let current: LengthUnit | null = null;
const listeners = new Set<() => void>();

/** The unit lengths are shown in now (points until the user picks one). */
export function documentUnit(): LengthUnit {
  if (current === null) current = stored();
  return current;
}

/** Pick the unit; persisted, and every subscribed field re-renders. A value
 *  that is not a unit is ignored. */
export function setDocumentUnit(unit: unknown): void {
  if (!isLengthUnit(unit) || unit === documentUnit()) return;
  current = unit;
  try {
    localStorage.setItem(STORAGE_KEY, unit);
  } catch {
    // Storage unavailable (private window): the choice lasts this session.
  }
  for (const l of listeners) l();
}

/** Re-read the stored preference (a reload, or a test's fresh storage). */
export function resetDocumentUnit(): void {
  current = null;
  for (const l of listeners) l();
}

export function subscribeDocumentUnit(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The document unit, re-rendering when it changes. */
export function useDocumentUnit(): LengthUnit {
  return useSyncExternalStore(
    subscribeDocumentUnit,
    documentUnit,
    documentUnit,
  );
}

/** Decimal places a value in `unit` is shown with. */
export function unitDigits(unit: LengthUnit): number {
  return unit === "in" || unit === "cm" ? 3 : 2;
}

/** Points → the number shown in `unit`, rounded to its digits. */
export function lengthIn(pt: number, unit: LengthUnit): number {
  const factor = Math.pow(10, unitDigits(unit));
  const n = Math.round((pt / POINTS_PER_UNIT[unit]) * factor) / factor;
  return Object.is(n, -0) ? 0 : n;
}

/** Points as text in `unit` (default: the document unit): "28.35 pt",
 *  "10 mm". */
export function formatLength(
  pt: number,
  unit: LengthUnit = documentUnit(),
): string {
  return `${lengthIn(pt, unit)} ${unit}`;
}

/** Points per unit for every suffix a typed length may carry ("p" is the
 *  pica, as InDesign spells it). */
const SUFFIX: Readonly<Record<string, number>> = {
  ...POINTS_PER_UNIT,
  p: POINTS_PER_UNIT.pc,
  "″": POINTS_PER_UNIT.in,
  '"': POINTS_PER_UNIT.in,
};

/** Read a typed length into points: "10mm", "0.5 in", "6p", "12,5 pt"; a
 *  bare number is in `unit`. Null when the text is not a length. */
export function parseLengthText(
  text: string,
  unit: LengthUnit = documentUnit(),
): number | null {
  const m = /^\s*([-+]?(?:\d+(?:[.,]\d*)?|[.,]\d+))\s*([a-z"″]*)\s*$/i.exec(
    text,
  );
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  if (!Number.isFinite(n)) return null;
  const factor = m[2] ? SUFFIX[m[2].toLowerCase()] : POINTS_PER_UNIT[unit];
  return factor === undefined ? null : n * factor;
}

/** A width and height as one readout: "612 × 792 pt", "210 × 297 mm". */
export function formatLengthPair(
  a: number,
  b: number,
  unit: LengthUnit = documentUnit(),
): string {
  const digits = unit === "pt" || unit === "px" ? 0 : unit === "mm" ? 1 : 2;
  const f = Math.pow(10, digits);
  const n = (pt: number) =>
    Math.round((pt / POINTS_PER_UNIT[unit]) * f) / f || 0;
  return `${n(a)} × ${n(b)} ${unit}`;
}
