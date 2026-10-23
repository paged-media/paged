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

// sheet ADR 510 — the references of a formula being typed: found (not in
// strings, not inside names), coloured by first appearance, the caret's
// point-mode test, and F4's dollar cycle.

import { describe, expect, it } from "bun:test";

import { a1Of, cycleAbsolute, formulaRefs, refInsertable } from "../src/surface/formula-refs";

describe("formula references", () => {
  it("finds plain references and ranges, not strings, names or sheet-qualified ones", () => {
    const refs = formulaRefs('=SUM(A1:B2)+$C$3*"D4"+LOG10(E5)+Sheet2!F6+A1');
    expect(refs.map((r) => [r.top, r.left, r.bottom, r.right])).toEqual([
      [0, 0, 1, 1],
      [2, 2, 2, 2],
      [4, 4, 4, 4],
      [0, 0, 0, 0],
    ]);
    expect(refs[0]!.color).toBe(0);
    expect(refs[3]!.color).toBe(3); // "A1" alone is a new reference text
    expect(formulaRefs("A1")).toEqual([]);
  });

  it("point mode after an operator, a paren or a comma, or at the end of a reference", () => {
    expect(refInsertable("=", 1)).toBe(true);
    expect(refInsertable("=SUM(", 5)).toBe(true);
    expect(refInsertable("=A1+", 4)).toBe(true);
    expect(refInsertable("=A1", 3)).toBe(true);
    expect(refInsertable("=SUM", 4)).toBe(false);
    expect(refInsertable("12", 2)).toBe(false);
  });

  it("F4 cycles A1 → $A$1 → A$1 → $A1 → A1, on both ends of a range", () => {
    let t = "=A1+B2:C3";
    const seq: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = cycleAbsolute(t, 3)!;
      t = r.text;
      seq.push(t.slice(1, t.indexOf("+")));
    }
    expect(seq).toEqual(["$A$1", "A$1", "$A1", "A1"]);
    expect(cycleAbsolute("=A1+B2:C3", 8)!.text).toBe("=A1+$B$2:$C$3");
    expect(cycleAbsolute("=SUM(", 4)).toBeNull();
  });

  it("A1 text of a cell and a range", () => {
    expect(a1Of(0, 0)).toBe("A1");
    expect(a1Of(9, 26, 10, 27)).toBe("AA10:AB11");
  });
});
