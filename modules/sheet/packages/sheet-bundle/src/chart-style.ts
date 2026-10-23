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

// Sheet ADR 524 — the document chart style, bundle side: what the layout
// document offers a chart (swatches with their display colour, paragraph
// and character styles, colour groups), and the translation of the object
// model's id-only values (`{ swatch: "Color/Brand" }`, a colour group id)
// into the references the engine stores (each swatch with its colour model
// and the sRGB the document shows it as). Every chart rule is Rust's
// (`sheet_chart::style`); this file only reads the document.

import type { BundleHost } from "@paged-media/plugin-api";

import type {
  ChartPalette,
  ChartRoleStyle,
  ChartStyle,
  DocSwatch,
} from "./engine";
import { CHART_COLOR_ROLES, CHART_TEXT_ROLES } from "./engine";

/** The roles in panel order. */
export const CHART_ROLES: readonly string[] = [
  ...CHART_COLOR_ROLES,
  ...CHART_TEXT_ROLES,
];

/** A colour role (swatch only) vs a text role. */
export const isColorRole = (role: string): boolean =>
  (CHART_COLOR_ROLES as readonly string[]).includes(role);

/** One role as the object model reads and writes it: document ids. */
export interface RoleIds {
  swatch?: string;
  paragraphStyle?: string;
  characterStyle?: string;
}

/** The object model's chart-style value (the workbook default, or one
 *  chart's overrides). */
export interface ChartStyleIds {
  roles: Record<string, RoleIds>;
  seriesColorGroup?: string | null;
}

/** What the document offers a chart. */
export interface ChartStyleChoices {
  swatches: { id: string; name: string; rgbHex: string }[];
  paragraphStyles: { id: string; name: string }[];
  characterStyles: { id: string; name: string }[];
  colorGroups: { id: string; name: string; members: string[] }[];
}

/** The session doors this file reads through. */
export interface ChartStyleDocument {
  documentSwatchRef(id: string): Promise<DocSwatch | null>;
  documentStyleChoices(): Promise<{
    paragraphStyles: { id: string; name: string }[];
    swatches: { id: string; name: string; rgbHex: string }[];
  }>;
}

const shown = (name: string) => name.replace(/^\$ID\//, "");

/** The document's swatches, styles and colour groups (each list empty
 *  when the host cannot read it). */
export async function chartStyleChoices(
  host: Pick<BundleHost, "document" | "log">,
  doc: ChartStyleDocument,
): Promise<ChartStyleChoices> {
  const base = await doc.documentStyleChoices();
  const out: ChartStyleChoices = {
    swatches: base.swatches,
    paragraphStyles: base.paragraphStyles,
    characterStyles: [],
    colorGroups: [],
  };
  try {
    const cs = await host.document.collection<{
      selfId: string;
      name: string;
    }>("characterStyles");
    out.characterStyles = cs
      .filter((c) => !c.selfId.endsWith("[No character style]"))
      .map((c) => ({ id: c.selfId, name: shown(c.name) }));
  } catch (err) {
    host.log.debug("chartStyleChoices: character styles", err);
  }
  try {
    const groups = await host.document.collection<{
      selfId: string;
      name: string;
      members: string[];
    }>("colorGroups");
    out.colorGroups = groups.map((g) => ({
      id: g.selfId,
      name: shown(g.name),
      members: [...(g.members ?? [])],
    }));
  } catch (err) {
    host.log.debug("chartStyleChoices: colour groups", err);
  }
  return out;
}

/** A colour group as series colours: its members in order, each read
 *  from the document. Null when the group is unknown or has no swatch the
 *  document can show. */
export async function colorGroupPalette(
  host: Pick<BundleHost, "document" | "log">,
  doc: ChartStyleDocument,
  groupId: string,
): Promise<ChartPalette | null> {
  let members: string[] = [];
  try {
    const groups = await host.document.collection<{
      selfId: string;
      members: string[];
    }>("colorGroups");
    members = [...(groups.find((g) => g.selfId === groupId)?.members ?? [])];
  } catch (err) {
    host.log.debug(`colorGroupPalette: ${groupId} unreadable`, err);
    return null;
  }
  const swatches: DocSwatch[] = [];
  for (const id of members) {
    const ref = await doc.documentSwatchRef(id);
    if (ref) swatches.push(ref);
  }
  return swatches.length > 0 ? { group: groupId, swatches } : null;
}

/** The ids of a stored style (what the object model reads). */
export function idsOf(
  roles: Record<string, ChartRoleStyle> | undefined,
  palette: ChartPalette | null | undefined,
): ChartStyleIds {
  const out: ChartStyleIds = { roles: {} };
  for (const [role, r] of Object.entries(roles ?? {})) {
    const ids: RoleIds = {};
    if (r.swatch?.id) ids.swatch = r.swatch.id;
    if (r.paragraphStyle) ids.paragraphStyle = r.paragraphStyle;
    if (r.characterStyle) ids.characterStyle = r.characterStyle;
    if (Object.keys(ids).length > 0) out.roles[role] = ids;
  }
  out.seriesColorGroup = palette?.group ?? null;
  return out;
}

/** The document references an id-only style names, read before a write
 *  (the object model's planning is synchronous). */
export interface StyleRefs {
  swatches: Map<string, DocSwatch | null>;
  groups: Map<string, ChartPalette | null>;
}

export const emptyStyleRefs = (): StyleRefs => ({
  swatches: new Map(),
  groups: new Map(),
});

/** Collect the swatch and colour-group ids of `values` (role maps and
 *  chart-style values, in any mix) and read each from the document. */
export async function readStyleRefs(
  host: Pick<BundleHost, "document" | "log">,
  doc: ChartStyleDocument,
  values: readonly unknown[],
): Promise<StyleRefs> {
  const refs = emptyStyleRefs();
  const roleMaps: unknown[] = [];
  const groups: string[] = [];
  for (const v of values) {
    if (!v || typeof v !== "object") {
      if (typeof v === "string" && v) groups.push(v);
      continue;
    }
    const o = v as Record<string, unknown>;
    if ("roles" in o) {
      roleMaps.push(o.roles);
      if (typeof o.seriesColorGroup === "string" && o.seriesColorGroup)
        groups.push(o.seriesColorGroup);
    } else roleMaps.push(o);
  }
  for (const m of roleMaps) {
    if (!m || typeof m !== "object") continue;
    for (const r of Object.values(m as Record<string, unknown>)) {
      const id =
        r && typeof r === "object"
          ? (r as Record<string, unknown>).swatch
          : undefined;
      if (typeof id === "string" && id && !refs.swatches.has(id))
        refs.swatches.set(id, await doc.documentSwatchRef(id));
    }
  }
  for (const g of groups) {
    if (!refs.groups.has(g))
      refs.groups.set(g, await colorGroupPalette(host, doc, g));
  }
  return refs;
}

/** An id-only role map → the engine's role styles (every known role:
 *  one absent from `ids` is `null`, so a write replaces the chart's
 *  overrides). Throws on an unknown role, a text style on a colour role
 *  or a swatch the document does not have. */
export function rolesFromIds(
  ids: unknown,
  refs: StyleRefs,
  fill: "all" | "given",
): Record<string, ChartRoleStyle | null> {
  if (ids !== null && ids !== undefined && typeof ids !== "object")
    throw new Error(
      "roles must be an object of role → {swatch, paragraphStyle, characterStyle}",
    );
  const given = (ids ?? {}) as Record<string, unknown>;
  const out: Record<string, ChartRoleStyle | null> = {};
  if (fill === "all") for (const role of CHART_ROLES) out[role] = null;
  for (const [role, raw] of Object.entries(given)) {
    if (!CHART_ROLES.includes(role))
      throw new Error(
        `unknown chart style role "${role}" (${CHART_ROLES.join("|")})`,
      );
    if (raw === null || raw === undefined) {
      out[role] = null;
      continue;
    }
    const r = raw as RoleIds;
    const style: ChartRoleStyle = {};
    if (r.swatch) {
      const ref = refs.swatches.get(r.swatch);
      if (!ref) throw new Error(`no swatch "${r.swatch}" in the document`);
      style.swatch = ref;
    }
    if (r.paragraphStyle || r.characterStyle) {
      if (isColorRole(role))
        throw new Error(
          `${role} takes a swatch, not a paragraph or character style`,
        );
      if (r.paragraphStyle) style.paragraphStyle = r.paragraphStyle;
      if (r.characterStyle) style.characterStyle = r.characterStyle;
    }
    out[role] = Object.keys(style).length > 0 ? style : null;
  }
  return out;
}

/** A colour group id → the engine's palette (`null` clears). */
export function paletteFromId(
  group: unknown,
  refs: StyleRefs,
): ChartPalette | null {
  if (group === null || group === undefined || group === "") return null;
  const p = refs.groups.get(String(group));
  if (!p)
    throw new Error(
      `no colour group "${String(group)}" with swatches in the document`,
    );
  return p;
}

/** An id-only chart style → the engine's workbook style (`null` clears). */
export function chartStyleFromIds(v: unknown, refs: StyleRefs): ChartStyle {
  if (v === null || v === undefined) return { roles: {} };
  if (typeof v !== "object") throw new Error("chartStyle must be an object");
  const o = v as ChartStyleIds;
  const roles: Record<string, ChartRoleStyle> = {};
  for (const [k, r] of Object.entries(rolesFromIds(o.roles, refs, "given")))
    if (r) roles[k] = r;
  return { roles, palette: paletteFromId(o.seriesColorGroup, refs) };
}
