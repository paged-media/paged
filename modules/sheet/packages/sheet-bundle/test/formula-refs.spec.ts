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

import {
  cycleAbsolute,
  formulaRefs,
  refInsertable,
} from "../src/surface/formula-refs";

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

  it("F4 leaves what only reads like a cell: a function name, a defined name, text", () => {
    // `LOG10` is columns LOG, row 10 by its letters; followed by `(` it is
    // the function, with the caret anywhere on it.
    for (const caret of [1, 3, 6]) {
      expect(cycleAbsolute("=LOG10(A1)", caret)).toBeNull();
    }
    expect(cycleAbsolute("=LOG10(A1)", 9)!.text).toBe("=LOG10($A$1)");
    expect(cycleAbsolute("=ATAN2(1,2)", 6)).toBeNull();
    expect(cycleAbsolute("=DAYS360(B1,B2)", 4)).toBeNull();
    // Part of a longer name.
    expect(cycleAbsolute("=Taxes2024*2", 10)).toBeNull();
    expect(cycleAbsolute("=A1.total+1", 3)).toBeNull();
    expect(cycleAbsolute("=Größe_A1+1", 9)).toBeNull();
    expect(cycleAbsolute("=A1ä+1", 3)).toBeNull();
    // Inside a string literal or a quoted sheet name; a sheet named like a
    // cell; a cell outside the grid.
    expect(cycleAbsolute('="see B2"', 8)).toBeNull();
    expect(cycleAbsolute("='Q1 B2'!C3", 7)).toBeNull();
    expect(cycleAbsolute("=ABC1!D4", 5)).toBeNull();
    expect(cycleAbsolute("=XFE1+1", 5)).toBeNull();
  });

  it("F4 cycles a sheet-qualified reference and one beside a function", () => {
    expect(cycleAbsolute("=Sheet2!F6", 10)!.text).toBe("=Sheet2!$F$6");
    expect(cycleAbsolute("='Q1 B2'!C3:D4", 14)!.text).toBe(
      "='Q1 B2'!$C$3:$D$4",
    );
    expect(cycleAbsolute("=ABC1!D4", 8)!.text).toBe("=ABC1!$D$4");
    expect(cycleAbsolute("=SUM(LOG10(B2),C3)", 13)).toEqual({
      text: "=SUM(LOG10($B$2),C3)",
      caret: 15,
    });
    // The bare cell LOG10 (no call) is a reference, as in Excel.
    expect(cycleAbsolute("=LOG10+1", 6)!.text).toBe("=$LOG$10+1");
  });

  it("the grid colours no function name, sheet name or off-grid cell", () => {
    expect(formulaRefs("=LOG10(A1)+ABC1!B2+XFE1+Taxes2024").length).toBe(1);
    expect(formulaRefs("='A1 B2'!C3+D4").map((r) => [r.top, r.left])).toEqual([
      [3, 3],
    ]);
  });
});
