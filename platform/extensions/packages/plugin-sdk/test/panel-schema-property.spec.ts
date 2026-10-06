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

// Schema v1.2 — the object-model property row (ADR 323, design §4).

import { describe, expect, it } from "vitest";

import type { PanelSchema, PluginManifest, PropertyFieldProps, PropertySchema } from "@paged-media/plugin-api";

import { createBundleHost } from "../src/host-impl";
import { makeFakeEditor } from "./fake-editor";

import {
  isPropertyRow,
  propertyRow,
  propertyRows,
  propertyRowsOf,
  selectorKind,
  validatePanelSchema,
} from "../src/index";

const LAYER = "plugin:acme.img/layer";
const ROWS: Record<string, PropertySchema[]> = {
  [LAYER]: [
    { path: "opacity", type: { kind: "number", unit: "percent" } },
    { path: "blendMode", type: { kind: "enum", members: ["normal", "multiply"] } },
    { path: "points[].anchor", type: { kind: "point" } },
  ],
};
const schemaOf = (k: string) => ROWS[k];

const panel = (rows: PanelSchema["sections"][number]["rows"]): PanelSchema => ({
  id: "acme.img.panel.layer",
  title: "Layer",
  sections: [{ rows }],
});

describe("schema v1.2 property rows", () => {
  it("the builders produce discriminated rows", () => {
    const r = propertyRow("opacity", { bind: "activeLayer" }, { kind: LAYER, label: "Opacity" });
    expect(r).toEqual({ field: "property", address: { bind: "activeLayer" }, path: "opacity", kind: LAYER, label: "Opacity" });
    expect(isPropertyRow(r)).toBe(true);
    expect(isPropertyRow({ widget: "paged.readout" })).toBe(false);
    const rows = propertyRows(LAYER, ["opacity", "blendMode"], "selection", {
      labels: { blendMode: "Blend" },
      row: (p) => (p === "blendMode" ? { style: "select" } : {}),
    });
    expect(rows.map((x) => [x.path, x.kind, x.label, x.style])).toEqual([
      ["opacity", LAYER, undefined, undefined],
      ["blendMode", LAYER, "Blend", "select"],
    ]);
    const s = panel([{ widget: "paged.readout" }, ...rows]);
    expect(propertyRowsOf(s).map((x) => [x.row, x.field.path])).toEqual([
      [1, "opacity"],
      [2, "blendMode"],
    ]);
  });

  it("a well-formed schema has no issues — every address form", () => {
    const s = panel([
      { widget: "paged.readout", props: { label: "x" } },
      propertyRow("opacity", "selection", { kind: LAYER }),
      propertyRow("blendMode", `${LAYER}[name="Badge"]`),
      propertyRow("points[3].anchor", { bind: "active" }, { kind: LAYER }),
      propertyRow("opacity", { addresses: [`${LAYER}/f1/7`] }, { kind: LAYER }),
    ]);
    expect(validatePanelSchema(s, { schemaOf, pluginId: "acme.img" })).toEqual([]);
  });

  it("reports malformed rows as data, never a throw", () => {
    const s = panel([
      { widget: "" },
      { field: "property", address: "selection", path: "opacity" } as never,
      propertyRow("nope", "selection", { kind: LAYER }),
      propertyRow("opacity", { bind: "" }, { kind: LAYER }),
      propertyRow("opacity", "[[[", { kind: LAYER }),
      propertyRow("opacity", { addresses: ["not an address"] }, { kind: LAYER }),
      propertyRow("opacity", "selection", { kind: "plugin:other.x/layer" }),
      { field: "property", address: "selection", path: "opacity", kind: LAYER, widget: "paged.readout" } as never,
      { field: "widget", widget: "x" } as never,
    ]);
    const issues = validatePanelSchema(s, { schemaOf, pluginId: "acme.img" });
    const at = (i: number) => issues.filter((x) => x.at === `sections[0].rows[${i}]`).map((x) => x.message);
    expect(at(0)).toEqual(['a row needs a widget id or field: "property"']);
    expect(at(1)[0]).toMatch(/needs a kind/);
    expect(at(2)).toEqual([`path "nope" is not a row of ${LAYER}`]);
    expect(at(3)).toEqual(["address.bind must be a non-empty name"]);
    expect(at(4)[0]).toMatch(/is not a selector/);
    expect(at(5)[0]).toMatch(/is not an address/);
    expect(at(6)[0]).toMatch(/belongs to other\.x/);
    expect(at(7)).toEqual(['a property row carries no "widget"']);
    expect(at(8)[0]).toMatch(/is not "property"/);
  });

  it("a selector address types the field by its last step", () => {
    expect(selectorKind(`textFrame[name="a"] > ${LAYER}[name="b"]`)).toBe(LAYER);
    expect(selectorKind("frame")).toBe("frame");
    expect(selectorKind("[[")).toBeNull();
    // An unknown path on the selector's kind is caught without `kind`.
    const issues = validatePanelSchema(panel([propertyRow("nope", `${LAYER}[name="b"]`)]), { schemaOf });
    expect(issues).toEqual([{ at: "sections[0].rows[0]", message: `path "nope" is not a row of ${LAYER}` }]);
  });
});

describe("widgets.PropertyField", () => {
  const MANIFEST: PluginManifest = { id: "acme.img", name: "img", version: "1.0.0", main: "x.js", engines: { paged: ">=0.0.0" } } as never;
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  it("is optional: absent without an object-model host, present (and flagged) when injected", () => {
    const fake = makeFakeEditor();
    const bare = createBundleHost(() => fake.editor, MANIFEST, { console: silent }).host;
    expect(bare.widgets.PropertyField).toBeUndefined();
    expect(bare.supports("widgets.propertyField@1")).toBe(false);
    const Field = (_: PropertyFieldProps) => null;
    const wired = createBundleHost(() => fake.editor, MANIFEST, {
      console: silent,
      widgets: { PropertyField: Field },
    }).host;
    expect(wired.widgets.PropertyField).toBe(Field);
    expect(wired.supports("widgets.propertyField@1")).toBe(true);
    expect(typeof wired.widgets.CodeEditor).toBe("function");
  });
});
