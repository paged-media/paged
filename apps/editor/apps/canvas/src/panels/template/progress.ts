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

// Editor ADR 1225 — a filler's progress through a template (the UX
// strategy's §7.8): which fields hold a value, which required ones are
// still empty, the field to fill next. Read from the engine's
// `templateFields` collection; the engine's role policy stays the
// authority on what may be written (hiding is not security). Pure.

import type { TemplateFieldSummary } from "@paged-media/client";

/** A field holds a value: text that is not blank, a placed picture, any
 *  value of another kind. */
export function fieldFilled(row: TemplateFieldSummary): boolean {
  const v = row.value;
  if (!v) return false;
  if (v.kind === "text") return v.text.trim() !== "";
  if (v.kind === "image") return v.uri.trim() !== "";
  if (v.kind === "runs")
    return v.runs.some((r) => "text" in r && r.text.trim() !== "");
  return true;
}

export interface FormProgress {
  total: number;
  filled: number;
  /** Required fields still empty, in the form's order. */
  requiredMissing: string[];
  /** Fields whose text does not fit its frame. */
  overset: string[];
  /** The field to fill next: the first required one still empty, else the
   *  first empty one; null when every field holds a value. */
  next: string | null;
  /** Every required field holds a value and nothing oversets. */
  ready: boolean;
}

export function formProgress(
  rows: readonly TemplateFieldSummary[],
): FormProgress {
  const empty = rows.filter((r) => !fieldFilled(r));
  const requiredMissing = empty
    .filter((r) => r.field.required === true)
    .map((r) => r.field.name);
  const overset = rows.filter((r) => r.overset).map((r) => r.field.name);
  return {
    total: rows.length,
    filled: rows.length - empty.length,
    requiredMissing,
    overset,
    next: requiredMissing[0] ?? empty[0]?.field.name ?? null,
    ready: requiredMissing.length === 0 && overset.length === 0,
  };
}

/** The field after `current` that still needs a value (round the form),
 *  required ones first. */
export function nextIncomplete(
  rows: readonly TemplateFieldSummary[],
  current: string | null,
): string | null {
  const order = rows.map((r) => r.field.name);
  const want = (r: TemplateFieldSummary) => !fieldFilled(r);
  const required = rows.filter((r) => want(r) && r.field.required === true);
  const pool = required.length > 0 ? required : rows.filter(want);
  if (pool.length === 0) return null;
  const at = current ? order.indexOf(current) : -1;
  const after = pool.find((r) => order.indexOf(r.field.name) > at);
  return (after ?? pool[0]!).field.name;
}
