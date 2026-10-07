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

// ADR 323 — draw's panels declare property rows (fields, not widgets):
// every row validates (address form, own-plugin kinds, paths on the kind's
// manifest schema); the stroke/fill panels' scalar rows are core-path
// property rows; DRAW_PANEL_FIELDS is every writable scalar row of each
// kind it lists.

import { describe, expect, it } from "vitest";

import type { PanelSchema, PropertySchema } from "@paged-media/plugin-api";
import { propertyRowsOf, validatePanelSchema } from "@paged-media/plugin-sdk";

import manifest from "../manifest.json";
import { fillPanel } from "../src/panels/fill-panel";
import {
  DRAW_PANEL_FIELDS,
  DRAW_PANEL_ITEM_ROWS,
  DRAW_PROPERTIES_PANEL,
  DRAW_PROPERTIES_PANEL_ID,
} from "../src/panels/properties-panel";
import { strokePanel } from "../src/panels/stroke-panel";

const PREFIX = `plugin:${manifest.id}/`;
const kinds = manifest.contributes.objectModel.kinds as unknown as Array<{ kind: string; schema: PropertySchema[] }>;
const schemaOf = (k: string) =>
  k.startsWith(PREFIX) ? kinds.find((x) => x.kind === k.slice(PREFIX.length))?.schema : undefined;

const CORE_STROKE_FILL = [
  "frameStrokeWeight", "frameStrokeColor", "frameStrokeEndCap", "frameStrokeStartArrowhead",
  "frameStrokeEndArrowhead", "frameCornerRadiusTopLeft", "frameCornerRadiusTopRight",
  "frameCornerRadiusBottomRight", "frameCornerRadiusBottomLeft",
  "frameFillColor", "frameFillTint", "frameGradientFillAngle", "frameGradientFillLength",
];

describe("draw panels — property rows (ADR 323)", () => {
  it("the properties panel validates (own-plugin kinds, paths on the manifest schemas)", () => {
    expect(validatePanelSchema(DRAW_PROPERTIES_PANEL, { pluginId: manifest.id, schemaOf })).toEqual([]);
  });
  // Core-path rows: no `pluginId` (the validator then reads a kind-less
  // "selection" row as a plugin property); core kinds have no schemaOf.
  it.each([strokePanel.schema, fillPanel.schema].map((p) => [p.id, p] as const))(
    "%s validates",
    (_id, p: PanelSchema) => {
      expect(validatePanelSchema(p, { schemaOf })).toEqual([]);
    },
  );

  it("stroke + fill edit every core path through a selection property row (no selectionProperty widget left)", () => {
    const rows = [strokePanel.schema, fillPanel.schema].flatMap((p) => propertyRowsOf(p).map((r) => r.field));
    expect(rows.every((r) => r.address === "selection" && r.kind === undefined)).toBe(true);
    expect(rows.map((r) => r.path).sort()).toEqual([...CORE_STROKE_FILL].sort());
    const widgets = [strokePanel.schema, fillPanel.schema].flatMap((p) => p.sections.flatMap((s) => s.rows));
    expect(widgets.some((r) => r.value?.kind === "selectionProperty")).toBe(false);
  });

  it("DRAW_PANEL_FIELDS is EVERY writable row of every kind (item rows: documented, reached through their list)", () => {
    const writable = (k: { schema: PropertySchema[] }) =>
      k.schema.filter((r) => (r.access ?? "readWrite") === "readWrite").map((r) => r.path);
    for (const k of kinds) {
      const listed = (DRAW_PANEL_FIELDS as Record<string, readonly string[]>)[k.kind] ?? [];
      const items = writable(k).filter((p) => `${k.kind}.${p}` in DRAW_PANEL_ITEM_ROWS);
      expect([...listed, ...items].sort(), k.kind).toEqual(writable(k).sort());
    }
    const declared = propertyRowsOf(DRAW_PROPERTIES_PANEL).map((r) => `${r.field.kind!.slice(PREFIX.length)}.${r.field.path}`);
    const expected = Object.entries(DRAW_PANEL_FIELDS).flatMap(([k, ps]) => ps.map((p) => `${k}.${p}`));
    expect(declared.sort()).toEqual(expected.sort());
  });

  it("each documented item row is an item (field) of a list row the panel declares with items", () => {
    const rows = propertyRowsOf(DRAW_PROPERTIES_PANEL).map((r) => r.field);
    for (const [row, { via }] of Object.entries(DRAW_PANEL_ITEM_ROWS)) {
      const [kind, path] = [row.slice(0, row.indexOf(".")), row.slice(row.indexOf(".") + 1)];
      const list = rows.find((r) => r.kind === `${PREFIX}${kind}` && `${kind}.${r.path}` === via)!;
      expect(list, row).toBeDefined();
      expect(path.startsWith(`${list.path}[]`), row).toBe(true);
      const field = path.split("].")[1];
      if (field) expect(list.items?.fields, row).toContain(field);
    }
  });

  it("list and struct rows carry their presentation (stacks top-first, point items, overlap fields)", () => {
    const row = (kind: string, path: string) =>
      propertyRowsOf(DRAW_PROPERTIES_PANEL).find((r) => r.field.kind === `${PREFIX}${kind}` && r.field.path === path)!.field;
    for (const k of ["appearance", "graphicStyle"]) for (const p of ["fills", "strokes"]) expect(row(k, p).items).toMatchObject({ reversed: true, itemLabel: "color" });
    expect(row("path", "points").items?.fields).toEqual(["anchor", "left", "right"]);
    expect(row("path", "points").address).toBe("selection");
    expect(row("pattern", "overlap").fields?.map((f) => (typeof f === "string" ? f : f.field))).toEqual(["horizontal", "vertical"]);
  });

  it("every panel is declared in the manifest", () => {
    for (const id of [strokePanel.id, fillPanel.id, DRAW_PROPERTIES_PANEL_ID]) {
      expect(manifest.contributes.panels).toContain(id);
    }
  });
});
