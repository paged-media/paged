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

// The column door's shapes (query/recordset.ts): typed buffers read back as
// `{t, v}` cells, nulls from the validity bitmap.

import { describe, expect, it } from "bun:test";

import {
  batchBytes,
  columnToValues,
  type ColumnBatch,
} from "../query/recordset";

describe("columnToValues [data.query.seam]", () => {
  it("reads each buffer kind, a cleared validity bit as null", () => {
    // bit i of byte i>>3: rows 0 and 2 valid, row 1 null.
    const valid = new Uint8Array([0b101]);
    expect(
      columnToValues(
        { kind: "f64", values: new Float64Array([1.5, 0, 3]), valid },
        3,
      ),
    ).toEqual([{ t: "number", v: 1.5 }, { t: "null" }, { t: "number", v: 3 }]);
    expect(
      columnToValues(
        { kind: "bool", values: new Uint8Array([1, 0]), valid: null },
        2,
      ),
    ).toEqual([
      { t: "bool", v: true },
      { t: "bool", v: false },
    ]);
    expect(
      columnToValues(
        { kind: "date", values: new Int32Array([19723]), valid: null },
        1,
      ),
    ).toEqual([{ t: "date", v: 19723 }]);
    const bytes = new TextEncoder().encode("Aéz");
    expect(
      columnToValues(
        {
          kind: "utf8",
          bytes,
          offsets: new Int32Array([0, 1, bytes.length]),
          valid: null,
        },
        2,
      ),
    ).toEqual([
      { t: "text", v: "A" },
      { t: "text", v: "éz" },
    ]);
  });

  it("counts the bytes a batch carries across the door", () => {
    const batch: ColumnBatch = {
      schema: { fields: [] },
      row_count: 2,
      columns: [
        { kind: "f64", values: new Float64Array(2), valid: new Uint8Array(1) },
        {
          kind: "utf8",
          bytes: new Uint8Array(3),
          offsets: new Int32Array(3),
          valid: null,
        },
      ],
    };
    expect(batchBytes(batch)).toBe(16 + 1 + 3 + 12);
  });
});
