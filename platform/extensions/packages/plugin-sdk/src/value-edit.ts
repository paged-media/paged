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

// List and struct VALUES on property rows (ADR 323; DESIGN.md §12.8).
//
// A host's list field (an appearance stack's fills, a gradient's stops)
// and struct field (an anchor point) edit one ITEM or one FIELD at a time.
// Those edits are not new batch ops: this module reads the current value,
// applies the edit, and LOWERS it to plain `set` ops —
//   · the whole new value on the row's own path (the common case), or
//   · `set path[i].field` when the kind types only the items' fields
//     (`path[].field` rows and no `path` row), for `itemSet` with a field —
// so it lands as ONE `host.objects.batch` = ONE undo step, through the
// registry's validation, and every plugin planner keeps receiving only
// `set` / `create` / `delete`.

import type {
  Address,
  ListEdit,
  ObjectErrorCode,
  ObjectOp,
  ObjectsSurface,
  ObjectWriteResult,
  PropertySchema,
  StructEdit,
  ValueEdit,
  ValueType,
} from "@paged-media/plugin-api";

import { validateValue } from "./object-schema";

type Ok<T> = { ok: true } & T;
type No = { ok: false; code: ObjectErrorCode; reason: string };
const no = (code: ObjectErrorCode, reason: string): No => ({ ok: false, code, reason });

/** The value a new item / an unset field starts from: a struct's field
 *  defaults (required fields without one get their type's default,
 *  optional ones stay absent), an enum's first member, 0, "", false, [],
 *  `Color/Black` for a colour, the zero point / identity transform. */
export function defaultValueOf(type: ValueType, row?: Pick<PropertySchema, "default" | "range">): unknown {
  if (row?.default !== undefined) return structuredClone(row.default);
  switch (type.kind) {
    case "bool":
      return false;
    case "number":
      return row?.range?.min !== undefined && row.range.min > 0 ? row.range.min : 0;
    case "length":
      return 0;
    case "color":
      return "Color/Black";
    case "enum":
      return type.members[0] ?? "";
    case "text":
    case "ref":
    case "asset":
      return "";
    case "bounds":
      return [0, 0, 0, 0];
    case "transform":
      return [1, 0, 0, 1, 0, 0];
    case "point":
      return [0, 0];
    case "bytes":
      return new Uint8Array();
    case "list":
      return [];
    case "map":
      return {};
    case "struct": {
      const out: Record<string, unknown> = {};
      for (const [name, f] of Object.entries(type.fields)) {
        if (f.default !== undefined) out[name] = structuredClone(f.default);
        else if (!f.optional) out[name] = defaultValueOf(f);
      }
      return out;
    }
  }
}

const isIndex = (n: unknown, len: number): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < len;

function setField(item: unknown, type: ValueType, field: string, value: unknown, at: string): Ok<{ value: unknown }> | No {
  if (type.kind !== "struct") return no("invalidValue", `${at}: a ${type.kind} has no fields`);
  const f = type.fields[field];
  if (!f && !type.open) return no("invalidValue", `${at}: no field "${field}" (${Object.keys(type.fields).join(", ")})`);
  if (f) {
    const why = validateValue(f, value, undefined, `${at}.${field}`);
    if (why) return no("invalidValue", why);
  }
  const base = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
  return { ok: true, value: { ...base, [field]: value } };
}

/**
 * Apply one edit to a value of `type` (a list, or a struct for
 * `fieldSet`). Pure; the result is validated against `type`.
 */
export function applyValueEdit(current: unknown, edit: ValueEdit, type: ValueType): Ok<{ value: unknown }> | No {
  if (edit.edit === "fieldSet") {
    if (type.kind !== "struct") return no("invalidValue", `fieldSet needs a struct value, not ${type.kind}`);
    return setField(current ?? defaultValueOf(type), type, edit.field, edit.value, "value");
  }
  if (type.kind !== "list") return no("invalidValue", `${edit.edit} needs a list value, not ${type.kind}`);
  const list = Array.isArray(current) ? [...current] : current == null ? [] : null;
  if (!list) return no("invalidValue", "the current value is not a list");
  const it = type.of;
  switch (edit.edit) {
    case "add": {
      if (type.maxItems !== undefined && list.length >= type.maxItems) {
        return no("invalidValue", `the list is full (maxItems ${type.maxItems})`);
      }
      const at = edit.index ?? list.length;
      if (!Number.isInteger(at) || at < 0 || at > list.length) return no("invalidValue", `add: index ${at} is outside 0..${list.length}`);
      const item = edit.item !== undefined ? edit.item : defaultValueOf(it);
      const why = validateValue(it, item, undefined, `item ${at}`);
      if (why) return no("invalidValue", why);
      list.splice(at, 0, item);
      return { ok: true, value: list };
    }
    case "remove":
      if (!isIndex(edit.index, list.length)) return no("invalidValue", `remove: no item ${edit.index}`);
      list.splice(edit.index, 1);
      return { ok: true, value: list };
    case "move": {
      if (!isIndex(edit.from, list.length)) return no("invalidValue", `move: no item ${edit.from}`);
      if (!isIndex(edit.to, list.length)) return no("invalidValue", `move: index ${edit.to} is outside 0..${list.length - 1}`);
      const [item] = list.splice(edit.from, 1);
      list.splice(edit.to, 0, item);
      return { ok: true, value: list };
    }
    case "itemSet": {
      if (!isIndex(edit.index, list.length)) return no("invalidValue", `itemSet: no item ${edit.index}`);
      if (edit.field !== undefined) {
        const r = setField(list[edit.index], it, edit.field, edit.value, `item ${edit.index}`);
        if (!r.ok) return r;
        list[edit.index] = r.value;
      } else {
        const why = validateValue(it, edit.value, undefined, `item ${edit.index}`);
        if (why) return no("invalidValue", why);
        list[edit.index] = edit.value;
      }
      return { ok: true, value: list };
    }
  }
}

type Reader = Pick<ObjectsSurface, "get" | "schema">;

/**
 * Lower one edit of `path` on every target to `set` ops (read, apply,
 * set). Each target is edited from its OWN current value, so a multi-
 * selection stays per-object. Refusals are typed; no op is produced
 * unless every target accepts the edit.
 */
export async function planValueEdit(
  objects: Reader,
  addresses: readonly Address[],
  path: string,
  edit: ValueEdit,
): Promise<Ok<{ ops: ObjectOp[] }> | No> {
  if (addresses.length === 0) return no("unknownAddress", "no target");
  const ops: ObjectOp[] = [];
  for (const address of addresses) {
    const rows = await objects.schema(address);
    const row = rows.find((r) => r.path === path);
    if (!row) {
      // Items typed only by their fields: `path[].field` rows.
      const itemRow = rows.find((r) => edit.edit === "itemSet" && edit.field !== undefined && r.path === `${path}[].${edit.field}`);
      if (!itemRow || edit.edit !== "itemSet") {
        const typedItems = rows.some((r) => r.path.startsWith(`${path}[].`));
        return no(
          "unknownPath",
          typedItems
            ? `${address}: "${path}" has no whole-list row; only item-set of a typed field (${path}[].<field>) is possible`
            : `${address} has no path "${path}"`,
        );
      }
      if ((itemRow.access ?? "readWrite") !== "readWrite") return no("readOnly", `${path}[].${edit.field} is ${itemRow.access}`);
      const why = validateValue(itemRow.type, edit.value, itemRow, `${path}[${edit.index}].${edit.field}`);
      if (why) return no("invalidValue", why);
      ops.push({ op: "set", address, path: `${path}[${edit.index}].${edit.field}`, value: edit.value });
      continue;
    }
    if ((row.access ?? "readWrite") !== "readWrite") return no("readOnly", `${path} is ${row.access}`);
    const read = await objects.get(address, path);
    if (read.kind === "refused") return no(read.code, read.reason);
    if (read.kind === "mixed") return no("invalidValue", `${address} ${path}: mixed`);
    const current = read.kind === "value" ? read.value : row.default !== undefined ? row.default : null;
    const next = applyValueEdit(current, edit, row.type);
    if (!next.ok) return { ...next, reason: `${address} ${path}: ${next.reason}` };
    ops.push({ op: "set", address, path, value: next.value });
  }
  return { ok: true, ops };
}

/** {@link planValueEdit}, then ONE `batch` (one undo step). */
export async function editValue(
  objects: Reader & Pick<ObjectsSurface, "batch">,
  addresses: readonly Address[],
  path: string,
  edit: ListEdit | StructEdit,
  opts?: { label?: string },
): Promise<ObjectWriteResult> {
  const plan = await planValueEdit(objects, addresses, path, edit);
  if (!plan.ok) return { applied: false, code: plan.code, reason: plan.reason, undoSteps: 0 };
  return objects.batch(plan.ops, opts);
}
