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

// Engine ADR 1008, editor ADR 309 — the stack gestures are pure functions
// from the stack read to the stack written, and which kinds exist, which
// targets take them and their parameter forms are core's catalog.

import { describe, expect, test } from "bun:test";
import { CORE_EFFECT_KINDS } from "@paged-media/plugin-sdk";

import {
  add,
  addable,
  canAdd,
  controlOf,
  effectMenu,
  entriesOf,
  isIndesign,
  move,
  paramsOf,
  remove,
  setEnabled,
  setParam,
  stackValue,
  suffixOf,
  type StackEntry,
} from "../../src/panels/effect-stack";
import { withFutureKind } from "./support/future-effect-kind";

const s: StackEntry[] = [
  { kind: "dropShadow", enabled: true },
  { kind: "gaussianBlur", enabled: true, radiusPt: 2 },
  { kind: "outlineStroke", enabled: true },
];

describe("effect stack gestures [effects-transparency.effect-stack]", () => {
  test("add appends an enabled entry at its defaults", () => {
    expect(add(s, "noise").at(-1)).toEqual({ kind: "noise", enabled: true });
  });

  test("move is clamped and keeps the rest in order", () => {
    expect(move(s, 2, -1).map((e) => e.kind)).toEqual([
      "dropShadow",
      "outlineStroke",
      "gaussianBlur",
    ]);
    expect(move(s, 0, -1)).toEqual(s);
    expect(move(s, 2, 5)).toEqual(s);
  });

  test("remove, switch and parameters touch one entry", () => {
    expect(remove(s, 0).map((e) => e.kind)).toEqual([
      "gaussianBlur",
      "outlineStroke",
    ]);
    expect(setEnabled(s, 1, false)[1]!.enabled).toBe(false);
    expect(setParam(s, 1, "radiusPt", 9)[1]!.radiusPt).toBe(9);
    expect(s[1]!.radiusPt).toBe(2);
  });

  test("reads and writes the wire shape", () => {
    expect(entriesOf({ entries: s, prev: null })).toEqual(s);
    expect(entriesOf({ type: "effectStack", value: { entries: s } })).toEqual(
      s,
    );
    expect(entriesOf("nope")).toBeNull();
    expect(stackValue(s)).toEqual({
      type: "effectStack",
      value: { entries: s },
    });
  });
});

describe("effect kinds come from core's catalog [effects-transparency.effect-stack]", () => {
  test("the add menu offers what core lets a target take", () => {
    const object = addable(s, "object");
    // InDesign's once each: the drop shadow is on the stack already.
    expect(object).not.toContain("dropShadow");
    expect(object).toContain("innerShadow");
    // Stack-only kinds as often as wanted.
    expect(object).toContain("gaussianBlur");
    expect(canAdd(s, "object", "gaussianBlur")).toBe(true);
    const fill = addable(s, "fill");
    expect(fill).toContain("innerShadow");
    expect(fill).not.toContain("gaussianBlur");
    // A kind an object takes is offered unless it is once-only and on the
    // stack already; a group-only kind (Pathfinder) is not offered here.
    for (const k of CORE_EFFECT_KINDS)
      if (k.targets.includes("object"))
        expect(object.includes(k.kind) || k.maxPerStack === 1).toBe(true);
      else expect(object).not.toContain(k.kind);
  });

  test("every kind core describes is in exactly one Effect menu group", () => {
    const listed = effectMenu().flatMap((g) => g.kinds.map((k) => k.kind));
    expect(listed.sort()).toEqual(CORE_EFFECT_KINDS.map((k) => k.kind).sort());
    expect(effectMenu()[0]!.category).toBe("stylize");
  });

  test("a parameter's control and unit follow its value type", () => {
    const blur = paramsOf("gaussianBlur");
    expect(blur.map((p) => p.field)).toEqual(["radiusPt"]);
    expect(controlOf(blur[0]!)).toBe("number");
    expect(suffixOf(blur[0]!)).toBe("pt");
    const stroke = paramsOf("outlineStroke");
    expect(stroke.map((p) => controlOf(p))).toEqual([
      "number",
      "enum",
      "color",
    ]);
    const overlay = paramsOf("gradientOverlay");
    expect(overlay.map((p) => controlOf(p))).toEqual([
      "swatch",
      "number",
      "bool",
    ]);
    expect(suffixOf(overlay[1]!)).toBe("°");
    expect(suffixOf(paramsOf("noise")[0]!)).toBe("%");
    expect(isIndesign("satin")).toBe(true);
    expect(paramsOf("satin")).toEqual([]);
  });

  test("a kind core adds later is offered without an editor change (plan C16)", () => {
    withFutureKind(() => {
      expect(addable(s, "object")).toContain("crystallize");
      expect(addable(s, "fill")).not.toContain("crystallize");
      const group = effectMenu().find(
        (g) => g.category === "distortAndTransform",
      );
      expect(group?.kinds.map((k) => k.kind)).toContain("crystallize");
      expect(controlOf(paramsOf("crystallize")[0]!)).toBe("number");
    });
    expect(addable(s, "object")).not.toContain("crystallize");
  });
});
