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

// ADR 560 — a catalogue's values as mutations. The engine (data-bind
// `resolve_catalogue`) has decided every field's value per instance and
// refused the ones the template's constraints forbid; this writes them the
// way the canvas engine writes a template form (`lower_template_fields`,
// engine ADR 1001), so a field filled by data is indistinguishable from one
// filled by hand:
//
//   text        the new text inserted before the old, then the old deleted
//               after it, so the text keeps the first run's style;
//   image       `placeImage` with the field's fit;
//   visibility  the item's own `elementVisible`.
//
// Data in, mutations out: no expression, value or constraint is decided here.

import type { ElementId, Mutation, Value } from "@paged-media/plugin-api";

/** A row of the engine's `templateFields` collection, as far as a catalogue
 *  reads it. */
export interface TemplateFieldRow {
  field: {
    name: string;
    kind: string;
    required?: boolean;
    constraints?: { maxLength?: number | null; fit?: string | null } | null;
  };
  targetId: string;
  elementId: ElementId | null;
  storyId: string | null;
  value:
    | { kind: "text"; text: string }
    | { kind: "image"; uri: string }
    | { kind: "visible"; visible: boolean }
    | null;
}

/** The template field kinds a catalogue fills: the engine's own kinds. */
export type CatalogueFieldKind = "text" | "image" | "visibility";

/** The catalogue kind of a template field kind, or null when a catalogue
 *  does not fill it (a module field is its module's; a choice or a text run
 *  cannot be set yet). */
export function catalogueFieldKind(kind: string): CatalogueFieldKind | null {
  return kind === "text" || kind === "image" || kind === "visibility"
    ? kind
    : null;
}

/** One field's decided value (data-bind `CatalogueValue`). */
export type CatalogueValue =
  | { outcome: "text"; text: string }
  | { outcome: "image"; uri: string }
  | { outcome: "visible"; visible: boolean }
  | { outcome: "leave" }
  | { outcome: "refused"; code: string; detail: string };

export type CatalogueFieldValue = { field: string } & CatalogueValue;

export interface CatalogueInstance {
  label: string;
  records: number[];
  values: CatalogueFieldValue[];
}

/** What the engine planned (data-bind `CataloguePlan`). */
export interface CataloguePlan {
  instances: CatalogueInstance[];
  totalRecords: number;
  unknownColumns?: string[];
}

/** Characters as the engine counts them (Unicode scalar values). */
const chars = (s: string): number => [...s].length;

/** The mutations that give `row` its `value`; empty when the value leaves
 *  the field as it is or does not fit the field's kind. */
export function fieldValueOps(
  row: TemplateFieldRow,
  value: CatalogueValue,
): Mutation[] {
  const kind = catalogueFieldKind(row.field.kind);
  if (kind === "text" && value.outcome === "text") {
    if (!row.storyId) return [];
    const len = chars(value.text);
    const old = row.value?.kind === "text" ? chars(row.value.text) : 0;
    const ops: Mutation[] = [];
    if (len > 0)
      ops.push({
        op: "insertText",
        args: { storyId: row.storyId, offset: 0, text: value.text },
      });
    if (old > 0)
      ops.push({
        op: "deleteRange",
        args: { storyId: row.storyId, start: len, end: len + old },
      });
    return ops;
  }
  if (kind === "image" && value.outcome === "image")
    return [
      {
        op: "placeImage",
        args: {
          elementId: row.targetId,
          uri: value.uri,
          fit: row.field.constraints?.fit ?? null,
        },
      },
    ];
  if (kind === "visibility" && value.outcome === "visible" && row.elementId)
    return [
      {
        op: "setElementProperty",
        args: {
          elementId: row.elementId,
          path: "elementVisible",
          value: { type: "bool", value: value.visible } satisfies Value,
        },
      },
    ];
  return [];
}

/** One copy of the template: its fields by name, and the values the
 *  instance gives them. */
export interface CatalogueCopy {
  rows: ReadonlyMap<string, TemplateFieldRow>;
  values: readonly CatalogueFieldValue[];
}

export interface CatalogueFill {
  ops: Mutation[];
  /** `copy index → field names` the copy does not have. */
  missing: Record<number, string[]>;
}

/** Every copy's writes, in copy order, for ONE batch. */
export function catalogueFillOps(
  copies: readonly CatalogueCopy[],
): CatalogueFill {
  const out: CatalogueFill = { ops: [], missing: {} };
  copies.forEach((copy, i) => {
    for (const v of copy.values) {
      const row = copy.rows.get(v.field);
      if (!row) {
        (out.missing[i] ??= []).push(v.field);
        continue;
      }
      out.ops.push(...fieldValueOps(row, v));
    }
  });
  return out;
}
