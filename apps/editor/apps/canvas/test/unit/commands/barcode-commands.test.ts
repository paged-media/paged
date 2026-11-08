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

// `paged.insert.barcode`: the pure parts (what a payload means, how the
// engine's unit-box modules become one batch).

import { describe, expect, test } from "bun:test";

import {
  barcodeBatch,
  hasBarcodeParams,
  mergeRuns,
} from "../../../src/barcode-commands";

describe("paged.insert.barcode helpers", () => {
  test("a payload is an insert; none (or unrelated keys) opens the dialog", () => {
    expect(hasBarcodeParams(undefined)).toBe(false);
    expect(hasBarcodeParams({ page: "p" })).toBe(false);
    expect(hasBarcodeParams({ data: "x" })).toBe(true);
    expect(hasBarcodeParams({ symbology: "qr" })).toBe(true);
  });

  test("modules that touch on one row become one rectangle", () => {
    const row = (x: number, y: number) => ({ x, y, w: 0.25, h: 0.5 });
    expect(
      mergeRuns([row(0.5, 0), row(0, 0), row(0.25, 0), row(0.75, 0.5)]),
    ).toEqual([
      { x: 0, y: 0, w: 0.75, h: 0.5 },
      { x: 0.75, y: 0.5, w: 0.25, h: 0.5 },
    ]);
  });

  test("the batch scales into the box, paints black on no stroke, and groups", () => {
    const m = barcodeBatch(
      "page-1",
      [
        { x: 0, y: 0, w: 0.5, h: 1 },
        { x: 0.75, y: 0, w: 0.25, h: 1 },
      ],
      10,
      20,
      100,
      50,
    ) as unknown as {
      op: string;
      args: { ops: Array<{ op: string; args: Record<string, unknown> }> };
    };
    expect(m.op).toBe("batch");
    const ops = m.args.ops;
    expect(ops.map((o) => o.op)).toEqual([
      "insertPath",
      "bindCreated",
      "setElementProperty",
      "setElementProperty",
      "insertPath",
      "bindCreated",
      "setElementProperty",
      "setElementProperty",
      "createGroup",
    ]);
    const anchors = (
      ops[0]!.args.anchors as Array<{ anchor: [number, number] }>
    ).map((a) => a.anchor);
    expect(anchors).toEqual([
      [10, 20],
      [60, 20],
      [60, 70],
      [10, 70],
    ]);
    expect(ops[2]!.args.value).toEqual({
      type: "colorRef",
      value: "Color/Black",
    });
    expect(ops[3]!.args.value).toEqual({
      type: "colorRef",
      value: "Swatch/None",
    });
    expect(ops[8]!.args.memberIds).toEqual([
      { kind: "polygon", id: "$h:bc0" },
      { kind: "polygon", id: "$h:bc1" },
    ]);
  });
});
