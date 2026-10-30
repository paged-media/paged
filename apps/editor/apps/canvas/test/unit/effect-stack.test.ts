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

// Engine ADR 1008 — the panel's stack gestures are pure functions from the
// stack read to the stack written.

import { describe, expect, test } from "bun:test";

import {
  add,
  addable,
  entriesOf,
  move,
  remove,
  setEnabled,
  setParam,
  stackValue,
  type StackEntry,
} from "../../src/panels/effect-stack";

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

  test("the add menu offers InDesign's effects once and the stack-only ones on the object", () => {
    const object = addable(s, "object");
    expect(object).not.toContain("dropShadow");
    expect(object).toContain("innerShadow");
    expect(object).toContain("gaussianBlur");
    const fill = addable(s, "fill");
    expect(fill).toContain("innerShadow");
    expect(fill).not.toContain("gaussianBlur");
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
