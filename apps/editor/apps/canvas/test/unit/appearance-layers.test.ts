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

// Engine ADR 1043, editor ADR 312 — the Appearance panel's gestures are
// pure functions from the layer list read to the list written; the
// placeholders the engine implies are made explicit first.

import { describe, expect, test } from "bun:test";

import {
  addFill,
  addStroke,
  appearanceValue,
  clear,
  duplicate,
  explicit,
  layersOf,
  move,
  remove,
  setEnabled,
  setField,
  viewOrder,
  type PaintLayer,
} from "../../src/panels/appearance-layers";

const kinds = (l: readonly PaintLayer[]) => l.map((x) => x.kind);

const red: PaintLayer = { kind: "fill", enabled: true, color: "Color/Red" };
const thick: PaintLayer = {
  kind: "stroke",
  enabled: true,
  color: "Color/Blue",
  weight: 6,
};

describe("appearance layers [frames-paths.native-appearance]", () => {
  test("the empty list is the implied frame fill below the frame stroke", () => {
    expect(kinds(explicit([]))).toEqual(["frameFill", "frameStroke"]);
  });

  test("missing placeholders go where the engine implies them", () => {
    expect(kinds(explicit([red]))).toEqual([
      "frameFill",
      "frameStroke",
      "fill",
    ]);
    expect(kinds(explicit([red, { kind: "frameFill" }]))).toEqual([
      "fill",
      "frameFill",
      "frameStroke",
    ]);
    expect(kinds(explicit([{ kind: "frameStroke" }, red]))).toEqual([
      "frameFill",
      "frameStroke",
      "fill",
    ]);
  });

  test("the view lists front-most first, each row with its list index", () => {
    expect(
      viewOrder([{ kind: "frameFill" }, red, { kind: "frameStroke" }]).map(
        (r) => [r.layer.kind, r.index],
      ),
    ).toEqual([
      ["frameStroke", 2],
      ["fill", 1],
      ["frameFill", 0],
    ]);
  });

  test("reads the object model's list and the raw wire value", () => {
    expect(layersOf([red])).toEqual([red]);
    expect(layersOf({ type: "appearance", value: { layers: [red] } })).toEqual([
      red,
    ]);
    expect(layersOf({ layers: [] })).toEqual([]);
    expect(layersOf(null)).toBeNull();
    expect(layersOf("x")).toBeNull();
    expect(appearanceValue([red])).toEqual({
      type: "appearance",
      value: { layers: [red] },
    });
  });

  test("add new fill: above the topmost fill, seeded with the frame's fill", () => {
    const out = addFill([], { fillColor: "Color/Green" });
    expect(kinds(out)).toEqual(["frameFill", "fill", "frameStroke"]);
    expect(out[1]).toEqual({
      kind: "fill",
      enabled: true,
      color: "Color/Green",
    });
    // Above an extra fill, seeded with that fill's colour.
    const twice = addFill(out.map((l, i) => (i === 1 ? red : l)));
    expect(kinds(twice)).toEqual(["frameFill", "fill", "fill", "frameStroke"]);
    expect(twice[2]!.color).toBe("Color/Red");
  });

  test("add new fill: a frame without a fill seeds black", () => {
    expect(addFill([], { fillColor: "Swatch/None" })[1]!.color).toBe(
      "Color/Black",
    );
    expect(addFill([])[1]!.color).toBe("Color/Black");
  });

  test("add new stroke: above the topmost stroke, with the seed's weight", () => {
    const out = addStroke([], { strokeColor: "Color/Red", strokeWeight: 3 });
    expect(kinds(out)).toEqual(["frameFill", "frameStroke", "stroke"]);
    expect(out[2]).toEqual({
      kind: "stroke",
      enabled: true,
      color: "Color/Red",
      weight: 3,
    });
    const again = addStroke([
      { kind: "frameFill" },
      thick,
      { kind: "frameStroke" },
    ]);
    // The topmost stroke-kind layer is the frame's own stroke.
    expect(kinds(again)).toEqual([
      "frameFill",
      "stroke",
      "frameStroke",
      "stroke",
    ]);
    expect(again[3]!.weight).toBe(1);
    expect(again[3]!.color).toBe("Color/Black");
    const above = addStroke([{ kind: "frameStroke" }, thick]);
    expect(above.at(-1)).toEqual({ ...thick });
  });

  test("duplicate copies a layer directly above it; a placeholder's copy is an extra layer", () => {
    const out = duplicate([red], 2);
    expect(kinds(out)).toEqual(["frameFill", "frameStroke", "fill", "fill"]);
    expect(out[3]).toEqual(red);
    expect(out[3]).not.toBe(red);
    const own = duplicate([], 0, { fillColor: "Color/Green" });
    expect(kinds(own)).toEqual(["frameFill", "fill", "frameStroke"]);
    expect(own[1]!.color).toBe("Color/Green");
  });

  test("delete removes a layer of its own, never a placeholder", () => {
    expect(kinds(remove([red], 2))).toEqual(["frameFill", "frameStroke"]);
    expect(kinds(remove([red], 0))).toEqual([
      "frameFill",
      "frameStroke",
      "fill",
    ]);
  });

  test("move is clamped, and placeholders move", () => {
    expect(kinds(move([red], 2, -1))).toEqual([
      "frameFill",
      "fill",
      "frameStroke",
    ]);
    expect(kinds(move([red], 2, 1))).toEqual([
      "frameFill",
      "frameStroke",
      "fill",
    ]);
    expect(kinds(move([], 0, 1))).toEqual(["frameStroke", "frameFill"]);
  });

  test("the switch works on any layer, placeholders too", () => {
    expect(setEnabled([], 0, false)[0]).toEqual({
      kind: "frameFill",
      enabled: false,
    });
    expect(setEnabled([red], 2, false)[2]!.enabled).toBe(false);
  });

  test("a field is set on a layer of its own, not on a placeholder", () => {
    expect(setField([red], 2, "opacityPct", 40)[2]!.opacityPct).toBe(40);
    expect(setField([thick], 2, "weight", 2)[2]!.weight).toBe(2);
    expect(setField([], 0, "color", "Color/Red")[0]).toEqual({
      kind: "frameFill",
      enabled: true,
    });
  });

  test("clear is the empty list: the item as it always was", () => {
    expect(clear()).toEqual([]);
  });
});
