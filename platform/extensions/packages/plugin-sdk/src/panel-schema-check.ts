/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// The object-model PROPERTY row (ADR 323, object-model
// design §4 "Panels"): helpers a bundle builds its panel declarations with,
// and the validator its unit tests (and a host, at register) hold them to.
//
//   · `isPropertyRow(row)` — discriminate the row union;
//   · `propertyRow(path, address, opts)` / `propertyRows(kind, paths, …)` —
//     build rows without restating `field: "property"`;
//   · `validatePanelSchema(schema, { schemaOf })` — every problem as data
//     (never a throw): a malformed address, an unknown path on the kind's
//     schema, a widget row with no widget. Pure; no React, no host.

import type {
  PanelSchema,
  PanelSchemaPropertyRow,
  PanelSchemaRow,
  PropertyFieldAddress,
  PropertySchema,
  ValueType,
} from "@paged-media/plugin-api";

import { parseAddress, parseSelector } from "./object-address";
import { findRow, validateValue } from "./object-schema";

/** Is this row an object-model property row (the property row)? */
export function isPropertyRow(row: PanelSchemaRow): row is PanelSchemaPropertyRow {
  return (row as { field?: unknown }).field === "property";
}

/** Options shared by the row builders (everything but `field`/`path`/`address`). */
export type PropertyRowOptions = Omit<PanelSchemaPropertyRow, "field" | "path" | "address">;

/** One property row. */
export function propertyRow(
  path: string,
  address: PropertyFieldAddress,
  opts: PropertyRowOptions = {},
): PanelSchemaPropertyRow {
  return { field: "property", address, path, ...opts };
}

/** Rows for several paths of one kind, in order. `labels` maps a path to
 *  its row label (absent = the schema row's title). */
export function propertyRows(
  kind: string,
  paths: readonly string[],
  address: PropertyFieldAddress,
  opts: { labels?: Readonly<Record<string, string>>; row?: (path: string) => PropertyRowOptions } = {},
): PanelSchemaPropertyRow[] {
  return paths.map((path) =>
    propertyRow(path, address, {
      kind,
      ...(opts.labels?.[path] ? { label: opts.labels[path] } : {}),
      ...(opts.row?.(path) ?? {}),
    }),
  );
}

/** Every property row of a schema, with where it sits. */
export function propertyRowsOf(
  schema: PanelSchema,
): Array<{ section: number; row: number; field: PanelSchemaPropertyRow }> {
  const out: Array<{ section: number; row: number; field: PanelSchemaPropertyRow }> = [];
  schema.sections.forEach((s, si) =>
    s.rows.forEach((r, ri) => {
      if (isPropertyRow(r)) out.push({ section: si, row: ri, field: r });
    }),
  );
  return out;
}

export interface PanelSchemaIssue {
  /** `sections[1].rows[3]` — where the problem is. */
  at: string;
  message: string;
}

export interface ValidatePanelSchemaOptions {
  /** The schema rows of a qualified kind (`plugin:<id>/<kind>`), or
   *  `undefined` when unknown. With it, every property row's path is
   *  checked against its kind's schema. */
  schemaOf?: (kind: string) => readonly PropertySchema[] | undefined;
  /** The bundle's plugin id: a `plugin:` kind or address of ANOTHER plugin
   *  is then reported (a panel edits its own objects or core's). */
  pluginId?: string;
}

const PLUGIN_KIND = /^plugin:([^/\s]+)\/([^/\s[\]]+)$/;

/** The qualified kind a selector selects (its last step's head), if any. */
export function selectorKind(selector: string): string | null {
  const parsed = parseSelector(selector);
  const last = parsed?.steps[parsed.steps.length - 1];
  if (!last) return null;
  if (last.head.type === "kind") return last.head.kind;
  if (last.head.type === "address") {
    const a = last.head.address;
    if (a.kind === "plugin") return `plugin:${a.plugin}/${a.objectKind}`;
  }
  return null;
}

function checkAddress(address: unknown): string | null {
  if (address === "selection") return null;
  if (typeof address === "string") {
    if (address.trim() === "") return "address is an empty selector";
    return parseSelector(address) ? null : `address "${address}" is not a selector`;
  }
  if (typeof address !== "object" || address === null || Array.isArray(address)) {
    return 'address must be "selection", a selector, { bind } or { addresses }';
  }
  const rec = address as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length === 1 && keys[0] === "bind") {
    return typeof rec.bind === "string" && rec.bind !== "" ? null : "address.bind must be a non-empty name";
  }
  if (keys.length === 1 && keys[0] === "addresses") {
    if (!Array.isArray(rec.addresses)) return "address.addresses must be a list";
    for (const a of rec.addresses) {
      if (typeof a !== "string" || !parseAddress(a)) return `address.addresses: "${String(a)}" is not an address`;
    }
    return null;
  }
  return 'address must be "selection", a selector, { bind } or { addresses }';
}

function checkPropertyRow(
  row: PanelSchemaPropertyRow,
  at: string,
  opts: ValidatePanelSchemaOptions,
  out: PanelSchemaIssue[],
): void {
  const issue = (message: string) => out.push({ at, message });
  const rec = row as unknown as Record<string, unknown>;
  for (const k of ["widget", "value", "list"]) {
    if (rec[k] !== undefined) issue(`a property row carries no "${k}"`);
  }
  if (typeof row.path !== "string" || row.path === "") issue("path must be a non-empty string");
  const bad = checkAddress(row.address);
  if (bad) issue(bad);
  if (row.options !== undefined && !Array.isArray(row.options)) issue("options must be a list");
  if (row.style !== undefined && !["select", "segments", "collection"].includes(row.style)) {
    issue(`style "${String(row.style)}" is not select | segments | collection`);
  }

  // The kind that types the field: declared, else the selector's own.
  const kind =
    row.kind ?? (typeof row.address === "string" && row.address !== "selection" ? selectorKind(row.address) : null);
  if (row.kind !== undefined && (typeof row.kind !== "string" || row.kind === "")) {
    issue("kind must be a non-empty string");
    return;
  }
  // `"selection"` without a kind is a CORE row (the selected object's own
  // kind types it — a stroke panel's frameStrokeWeight); a plugin row
  // names its kind, which the checks below hold to the plugin.
  const m = kind ? PLUGIN_KIND.exec(kind) : null;
  if (kind && kind.startsWith("plugin:") && !m) issue(`kind "${kind}" is not plugin:<id>/<kind>`);
  if (m && opts.pluginId && m[1] !== opts.pluginId) {
    issue(`kind "${kind}" belongs to ${m[1]}, not ${opts.pluginId}`);
  }
  if (!kind || !opts.schemaOf || typeof row.path !== "string") return;
  const rows = opts.schemaOf(kind);
  if (!rows) {
    if (m) issue(`kind "${kind}" has no schema`);
    return;
  }
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const schemaRow = findRow(byPath, row.path);
  if (!schemaRow) {
    issue(`path "${row.path}" is not a row of ${kind}`);
    return;
  }
  checkValuePresentation(row, schemaRow.type, issue);
}

/** The sub-field names of a struct type, or null (open / not a struct). */
function structFields(type: ValueType): ReadonlyMap<string, ValueType> | null {
  if (type.kind !== "struct" || type.open) return null;
  return new Map(Object.entries(type.fields));
}

function checkSubFields(
  fields: unknown,
  type: ValueType,
  at: string,
  issue: (m: string) => void,
): void {
  if (!Array.isArray(fields)) {
    issue(`${at} must be a list`);
    return;
  }
  const known = structFields(type);
  for (const f of fields) {
    const name = typeof f === "string" ? f : (f as { field?: unknown } | null)?.field;
    if (typeof name !== "string" || name === "") {
      issue(`${at}: an entry needs a field name`);
      continue;
    }
    if (known && !known.has(name)) issue(`${at}: "${name}" is not a field (${[...known.keys()].join(", ")})`);
  }
}

/** §12.8 — `items` only on a list-typed path, `fields` only on a struct
 *  (or on a list's struct items via `items.fields`). */
function checkValuePresentation(row: PanelSchemaPropertyRow, type: ValueType, issue: (m: string) => void): void {
  if (row.fields !== undefined) {
    if (type.kind !== "struct") issue(`fields: "${row.path}" is a ${type.kind}, not a struct`);
    else checkSubFields(row.fields, type, "fields", issue);
  }
  const items = row.items;
  if (items === undefined) return;
  if (type.kind !== "list") {
    issue(`items: "${row.path}" is a ${type.kind}, not a list`);
    return;
  }
  if (typeof items !== "object" || items === null || Array.isArray(items)) {
    issue("items must be an object");
    return;
  }
  for (const k of ["add", "remove", "reorder", "reversed"] as const) {
    if (items[k] !== undefined && typeof items[k] !== "boolean") issue(`items.${k} must be a boolean`);
  }
  if (items.fields !== undefined) {
    if (type.of.kind !== "struct") issue(`items.fields: the items are ${type.of.kind}, not structs`);
    else checkSubFields(items.fields, type.of, "items.fields", issue);
  }
  if (items.itemLabel !== undefined) {
    const known = structFields(type.of);
    if (typeof items.itemLabel !== "string" || (known && !known.has(items.itemLabel)) || type.of.kind !== "struct") {
      issue(`items.itemLabel "${String(items.itemLabel)}" is not a field of the items`);
    }
  }
  if (items.newItem !== undefined) {
    const why = validateValue(type.of, items.newItem, undefined, "items.newItem");
    if (why) issue(why.startsWith("items.newItem") ? why : `items.newItem: ${why}`);
  }
}

/**
 * Every problem in a panel schema, as data. An empty list = it renders as
 * declared. Checks the property rows in full (address form, kind,
 * path against `schemaOf`) and the v1 rows' one structural rule (a
 * non-empty widget id).
 */
export function validatePanelSchema(
  schema: PanelSchema,
  opts: ValidatePanelSchemaOptions = {},
): PanelSchemaIssue[] {
  const out: PanelSchemaIssue[] = [];
  if (!schema || typeof schema !== "object") return [{ at: "schema", message: "not an object" }];
  if (typeof schema.id !== "string" || schema.id === "") out.push({ at: "id", message: "id must be non-empty" });
  if (!Array.isArray(schema.sections)) return [...out, { at: "sections", message: "sections must be a list" }];
  schema.sections.forEach((section, si) => {
    if (!Array.isArray(section.rows)) {
      out.push({ at: `sections[${si}]`, message: "rows must be a list" });
      return;
    }
    section.rows.forEach((row, ri) => {
      const at = `sections[${si}].rows[${ri}]`;
      const field = (row as { field?: unknown }).field;
      if (field !== undefined && field !== "property") {
        out.push({ at, message: `field "${String(field)}" is not "property"` });
        return;
      }
      if (isPropertyRow(row)) checkPropertyRow(row, at, opts, out);
      else if (typeof row.widget !== "string" || row.widget === "") {
        out.push({ at, message: 'a row needs a widget id or field: "property"' });
      }
    });
  });
  return out;
}
