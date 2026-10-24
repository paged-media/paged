// The data door's status (editor ADR 291's colour cues): the fields a
// binding's expressions read.
import { describe, expect, it } from "bun:test";

import { fieldsRead } from "../data-door";

describe("the fields a binding reads [plugin-platform.data-door]", () => {
  it("bare names, not functions, not strings, not logic words", () => {
    expect(
      fieldsRead({ expr: 'IF(cat = "Sale price", MM(weight) * 2, price)' }),
    ).toEqual(["cat", "weight", "price"]);
    expect(fieldsRead({ when: "stock < 5 AND NOT active" })).toEqual([
      "stock",
      "active",
    ]);
    expect(fieldsRead({ expr: "'it''s' & name" })).toEqual(["name"]);
    expect(fieldsRead({ columns: [] })).toEqual([]);
  });
});
