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

// Shared pieces of paged.draw's object model (ADR 323): the value types
// several kinds reuse, and the address helpers.
//
// ADDRESSES. A draw object is `plugin:media.paged.draw/<kind>/<id>`.
//   · element-anchored kinds (`path`, `appearance`) use the CORE address
//     of their element as the id — `plugin:media.paged.draw/path/polygon:u1`
//     — so the object and the page item it lives on name each other, and
//     `hostOf` is that core address;
//   · library kinds use the library-local id (`gs-1`, `sym-2`, …), which
//     is stable across saves (InDesign renumbers `Self`, not these), and
//     their labels live on the document (`hostOf` = `doc`).
// Addresses are SESSION handles (ADR 131): a persisted reference is a
// selector over `name`, never an element id.

import type {
  ElementId,
  ObjectValue,
  PropertySchema,
  SceneTreeNode,
  ValueType,
} from "@paged-media/plugin-api";
import { formatAddress, parseAddress, toElementId } from "@paged-media/plugin-sdk";

import manifest from "../../manifest.json";

export const DRAW_ID: string = manifest.id;

export const addressOf = (kind: string, id: string): string =>
  `plugin:${DRAW_ID}/${kind}/${id}`;

/** The plugin-local id of a draw address (null when it is not one). */
export function localIdOf(address: string, kind?: string): string | null {
  const p = parseAddress(address);
  if (p?.kind !== "plugin" || p.plugin !== DRAW_ID) return null;
  if (kind !== undefined && p.objectKind !== kind) return null;
  return p.id;
}

/** A recipe / library id given either bare (`gs-1`) or as an address. */
export const bareIdOf = (value: string, kind: string): string =>
  value.startsWith("plugin:") ? (localIdOf(value, kind) ?? value) : value;

/** The core element an element-anchored draw id names. */
export function elementOfId(id: string): ElementId | null {
  const p = parseAddress(id);
  if (!p) return null;
  if (p.kind !== "item") return null;
  return toElementId(p);
}

/** The core address of a wire element ref (`{ kind, id }`). */
export function coreAddressOf(ref: { kind: string; id: unknown }): string {
  return formatAddress({
    kind: "item",
    itemKind: ref.kind as never,
    id: String(ref.id),
  });
}

/** Every page-item leaf the scene tree lists, in tree (= paint) order. */
export function treeItems(roots: readonly SceneTreeNode[]): ElementId[] {
  const out: ElementId[] = [];
  const walk = (nodes: readonly SceneTreeNode[]) => {
    for (const n of nodes) {
      if (n.id && n.id.kind !== "storyRange" && n.id.kind !== "table" && n.id.kind !== "tableCell") {
        out.push(n.id);
      }
      if (n.children) walk(n.children);
    }
  };
  walk(roots);
  return out;
}

export const val = (value: unknown): ObjectValue => ({ kind: "value", value });
export const refuse = (
  code: "unknownAddress" | "unknownPath" | "failed" | "unmapped",
  reason: string,
): ObjectValue => ({ kind: "refused", code, reason });

// ---------------------------------------------------------- value types

export const PCT: ValueType = { kind: "number", unit: "percent" };
export const DEG: ValueType = { kind: "number", unit: "deg" };
export const INT: ValueType = { kind: "number", integer: true };
export const NUM: ValueType = { kind: "number" };
export const LEN: ValueType = { kind: "length" };
export const BOOL: ValueType = { kind: "bool" };
export const TEXT: ValueType = { kind: "text" };
export const COLOR: ValueType = { kind: "color" };
export const POINT: ValueType = { kind: "point" };
export const REF_FRAME: ValueType = { kind: "ref", to: "frame" };
export const REFS: ValueType = { kind: "list", of: REF_FRAME };
export const enumOf = (members: readonly string[]): ValueType => ({
  kind: "enum",
  members,
});

/** IDML `BlendMode` values (InDesign's Effects panel set). */
export const BLEND_MODES = [
  "Normal",
  "Multiply",
  "Screen",
  "Overlay",
  "SoftLight",
  "HardLight",
  "ColorDodge",
  "ColorBurn",
  "Darken",
  "Lighten",
  "Difference",
  "Exclusion",
  "Hue",
  "Saturation",
  "Color",
  "Luminosity",
] as const;

export const BLEND_MODE: ValueType = enumOf(BLEND_MODES);

/** One appearance FILL layer (`commands/appearance.ts` `FillLayer`, every
 *  optional field made explicit — a struct has no optional members). */
export const FILL_LAYER: ValueType = {
  kind: "struct",
  fields: { color: COLOR, tint: PCT, opacity: PCT, blendMode: BLEND_MODE },
};

/** One appearance STROKE layer (`StrokeLayer`). */
export const STROKE_LAYER: ValueType = {
  kind: "struct",
  fields: { color: COLOR, weight: LEN, opacity: PCT, blendMode: BLEND_MODE },
};

/** One anchor's three control points (`PathAnchorTriple`). */
export const ANCHOR: ValueType = {
  kind: "struct",
  fields: { anchor: POINT, left: POINT, right: POINT },
};

/** A schema row helper. */
export const row = (
  path: string,
  type: ValueType,
  extra: Omit<PropertySchema, "path" | "type"> = {},
): PropertySchema => ({ path, type, ...extra });

export const ro = (path: string, type: ValueType, summary: string): PropertySchema =>
  row(path, type, { access: "readOnly", summary });

export const derived = (path: string, type: ValueType, summary: string): PropertySchema =>
  row(path, type, { access: "derived", summary });
