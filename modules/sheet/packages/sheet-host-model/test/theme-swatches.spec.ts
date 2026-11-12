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

// Engine ADR 1056 — a theme-coloured cell fill or text colour is painted
// with a swatch that FOLLOWS its theme slot, so applying a theme recolours it.

import { describe, expect, it } from "bun:test";
import type { SwatchSpec } from "@paged-media/plugin-api";

import type { LoweredContent, LoweredStyle } from "../src/lowered";
import { cellCharacterFormats } from "../src/cell-text-format";
import { cellFillSwatchOps, tableDecorOps } from "../src/lower-to-table";
import { cellTextSwatchOps } from "../src/lower-to-mutations";
import {
  cellFillRef,
  cellTextRef,
  distinctCellFillHexes,
  themeSwatchId,
  workbookPalette,
} from "../src/palette";

const LIGHT = {
  slot: "accent1",
  transforms: [
    ["lumMod", 60000],
    ["lumOff", 40000],
  ] as [string, number][],
};

function style(over: Partial<LoweredStyle>): LoweredStyle {
  return {
    key: 1,
    bold: false,
    italic: false,
    borderTop: false,
    borderRight: false,
    borderBottom: false,
    borderLeft: false,
    ...over,
  };
}

function content(styles: LoweredStyle[]): LoweredContent {
  return {
    cols: [{ index: 0, widthPt: 60 }],
    rows: [
      {
        index: 0,
        heightPt: 14,
        cells: styles.map((s) => ({
          col: 0,
          text: "1",
          align: "right" as const,
          styleKey: s.key,
        })),
      },
    ],
    rules: { h: [], v: [] },
    merges: [],
    styles: [style({ key: 0 }), ...styles],
  } as LoweredContent;
}

/** `SwatchSpec` with the reference `createSwatch` carries (engine ADR 1056). */
type Spec = SwatchSpec & {
  themeRef?: { slot: string; transforms: [string, number][] };
};

const specs = (ops: { op: string; args: unknown }[]): Spec[] =>
  ops
    .filter((o) => o.op === "createSwatch")
    .map((o) => (o.args as { spec: Spec }).spec);

describe("sheet theme swatches (engine ADR 1056)", () => {
  it("names the swatch by slot and transforms, not by colour", () => {
    expect(themeSwatchId("cellFill", { slot: "accent1" })).toBe(
      "Color/uPagedSheetCellFillThemeaccent1",
    );
    expect(themeSwatchId("cellFill", LIGHT)).toBe(
      "Color/uPagedSheetCellFillThemeaccent1lumMod60000lumOff40000",
    );
    expect(themeSwatchId("cellText", LIGHT)).not.toBe(
      themeSwatchId("cellFill", LIGHT),
    );
  });

  it("mints a themed fill once, with themeRef, and no literal swatch for it", () => {
    const c = content([
      style({ key: 1, fillRgb: "#B4C7E7", fillTheme: LIGHT }),
      style({ key: 2, fillRgb: "#B4C7E7", fillTheme: LIGHT }),
      style({ key: 3, fillRgb: "#FFFF00" }),
    ]);
    expect(distinctCellFillHexes(c)).toEqual(["FFFF00"]);
    const minted = specs(cellFillSwatchOps(c));
    const themed = minted.filter((s) => s.themeRef);
    expect(themed).toHaveLength(1);
    expect(themed[0].selfId).toBe(themeSwatchId("cellFill", LIGHT));
    expect(themed[0].value).toEqual([0xb4, 0xc7, 0xe7]);
    expect(themed[0].themeRef).toEqual({
      slot: "accent1",
      transforms: [
        ["lumMod", 60000],
        ["lumOff", 40000],
      ],
    });
    // The literal colour stays a plain swatch.
    expect(minted.filter((s) => !s.themeRef)).toHaveLength(1);
    // Read-first: a swatch the document has is not minted again; a failed
    // read mints nothing.
    expect(
      specs(
        cellFillSwatchOps(c, new Set([themeSwatchId("cellFill", LIGHT)])),
      ).filter((s) => s.themeRef),
    ).toHaveLength(0);
    expect(cellFillSwatchOps(c, null)).toEqual([]);
  });

  it("paints the cell with the themed swatch; a document swatch still wins", () => {
    const themed = style({ fillRgb: "#B4C7E7", fillTheme: LIGHT });
    expect(cellFillRef(themed)).toBe(themeSwatchId("cellFill", LIGHT));
    expect(cellFillRef({ ...themed, fillSwatch: "Color/Brand" })).toBe(
      "Color/Brand",
    );
    expect(cellFillRef(style({ fillRgb: "#FFFF00" }))).toBe(
      "Color/uPagedSheetCellFillFFFF00",
    );
    expect(
      cellTextRef(style({ textRgb: "#000000", textTheme: { slot: "dk1" } })),
    ).toBe("Color/uPagedSheetCellTextThemedk1");
    const decor = tableDecorOps(content([themed]), "story", "table");
    const refs = JSON.stringify(decor.ops);
    expect(refs).toContain(themeSwatchId("cellFill", LIGHT));
  });

  it("names the themed text swatch from the cell's text format and mints it", () => {
    const c = content([
      style({ key: 1, textRgb: "#44546A", textTheme: { slot: "dk2" } }),
    ]);
    const cs = cellCharacterFormats(c).get(1);
    expect(JSON.stringify(cs?.props)).toContain(
      themeSwatchId("cellText", { slot: "dk2" }),
    );
    const minted = specs(cellTextSwatchOps(c));
    expect(minted).toHaveLength(1);
    expect(minted[0].themeRef?.slot).toBe("dk2");
  });

  it("lists the themed fill in the workbook palette with its reference", () => {
    const c = content([style({ fillRgb: "#B4C7E7", fillTheme: LIGHT })]);
    const entry = workbookPalette({ regions: [c] }).find(
      (e) => e.selfId === themeSwatchId("cellFill", LIGHT),
    );
    expect(entry?.themeRef?.slot).toBe("accent1");
    expect(entry?.hex).toBe("B4C7E7");
  });
});
