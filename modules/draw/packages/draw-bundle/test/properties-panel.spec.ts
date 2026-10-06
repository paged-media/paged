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
  DRAW_PROPERTIES_PANEL,
  DRAW_PROPERTIES_PANEL_ID,
} from "../src/panels/properties-panel";
import { strokePanel } from "../src/panels/stroke-panel";

const PREFIX = `plugin:${manifest.id}/`;
const kinds = manifest.contributes.objectModel.kinds as unknown as Array<{ kind: string; schema: PropertySchema[] }>;
const schemaOf = (k: string) =>
  k.startsWith(PREFIX) ? kinds.find((x) => x.kind === k.slice(PREFIX.length))?.schema : undefined;
const SCALAR = new Set(["bool", "number", "length", "enum", "text", "color", "ref"]);

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

  it("DRAW_PANEL_FIELDS is every writable scalar row of each listed kind, each through a property row", () => {
    for (const [kind, paths] of Object.entries(DRAW_PANEL_FIELDS)) {
      const want = kinds
        .find((k) => k.kind === kind)!
        .schema.filter((r) => (r.access ?? "readWrite") === "readWrite" && SCALAR.has(r.type.kind))
        .map((r) => r.path);
      expect([...paths], kind).toEqual(want);
    }
    const declared = propertyRowsOf(DRAW_PROPERTIES_PANEL).map((r) => `${r.field.kind!.slice(PREFIX.length)}.${r.field.path}`);
    const expected = Object.entries(DRAW_PANEL_FIELDS).flatMap(([k, ps]) => ps.map((p) => `${k}.${p}`));
    expect(declared.sort()).toEqual(expected.sort());
  });

  it("every panel is declared in the manifest", () => {
    for (const id of [strokePanel.id, fillPanel.id, DRAW_PROPERTIES_PANEL_ID]) {
      expect(manifest.contributes.panels).toContain(id);
    }
  });
});
