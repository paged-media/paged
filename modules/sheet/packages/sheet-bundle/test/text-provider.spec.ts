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

// ADR 023 phase D — the paged.sheet CHARACTER/PARAGRAPH binding
// provider: the VALUE axis, which is the axis neither the Layers nor
// the Swatches proof can reach.
//
// A layer row has ONE visibility and a swatch list is a list; only a
// range of cells can be MIXED. So the assertions here are about the
// collapse, and about the three answers that are NOT a value:
//
//   · `mixed`   — the cells disagree. Never a winner, and never the
//                 first one.
//   · `absent`  — owned, and nothing to say. Must NOT fall through: the
//                 text caret is independent of the edit-context stack,
//                 so core's answer would be some unrelated paragraph's.
//   · `decline` — no workbook / nothing lowered. NOT `absent`: there is
//                 no cell here to own.
//
// Pure: a hand-rolled source, no engine, no editor.

import { describe, expect, it } from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";
import type { LoweredContent, LoweredStyle } from "../../sheet-host-model/src";

import {
  ABSENT_PATHS,
  SERVED_PATHS,
  VALUED_PATHS,
  WRITABLE_PATHS,
  collapseCells,
  makeTextBindingProvider,
  patchForWrite,
  stylesOfRange,
} from "../src/binding-provider/text-provider";
import type { CellStylePatch } from "../src/engine";

const silentHost = {
  log: { debug() {}, info() {}, warn() {}, error() {} },
} as unknown as BundleHost;

/** A style table entry — the mirror of the Rust `LoweredStyle`. */
function style(key: number, over: Partial<LoweredStyle> = {}): LoweredStyle {
  return {
    key,
    bold: false,
    italic: false,
    fontSizePt: null,
    fontName: null,
    fillRgb: null,
    textRgb: null,
    borderTop: false,
    borderRight: false,
    borderBottom: false,
    borderLeft: false,
    ...over,
  };
}

/** A lowered range whose cells carry the given style keys, row-major.
 *  Geometry is irrelevant here — the provider reads styles only. */
function content(styles: LoweredStyle[], keys: number[][]): LoweredContent {
  return {
    cols: keys[0].map((_, i) => ({ index: i, widthPt: 60 })),
    rows: keys.map((row, r) => ({
      index: r,
      heightPt: 14,
      cells: row.map((styleKey, c) => ({
        col: c,
        text: `r${r}c${c}`,
        align: "left" as const,
        styleKey,
      })),
    })),
    rules: { h: [], v: [] },
    merges: [],
    styles,
  };
}

const DEFAULT = style(0);
const BIG = style(1, { bold: true, fontSizePt: 18, fontName: "Georgia" });
const SMALL = style(2, { italic: true, fontSizePt: 9, fontName: "Verdana" });

function providerOver(
  styles: LoweredStyle[],
  keys: number[][],
  range = "A1:B1",
) {
  return makeTextBindingProvider(silentHost, {
    textSelectionRange: () => ({ sheet: 0, range }),
    lowerRange: () => content(styles, keys),
  }).provider;
}

const SELECTION = { kind: "selection", scope: "content" } as const;

describe("paged.sheet text provider — the declaration", () => {
  it("declares the WHOLE Character/Paragraph surface; without a write door it writes NONE of it", async () => {
    const p = providerOver([DEFAULT, BIG], [[1]]);
    // Owning the selection means owning the whole panel surface — see
    // the module header. A path left undeclared would DECLINE, and a
    // decline falls through to core.
    expect(p.provides.paths).toEqual(SERVED_PATHS);
    expect(SERVED_PATHS.length).toBe(VALUED_PATHS.length + ABSENT_PATHS.length);
    // A source without `applyStyle` is a read-only readout, and says so.
    expect(p.provides.writablePaths).toEqual([]);
    const w = await p.writeProperty!({
      path: "characterFontSize",
      target: SELECTION,
      value: { type: "length", value: 12 },
    });
    expect(w).toMatchObject({ kind: "applied", outcome: { applied: false } });
    expect(p.applyMutation).toBeUndefined();
  });

  it("with a write door (P7) the valued paths write the selected cells", async () => {
    const patches: CellStylePatch[] = [];
    const p = makeTextBindingProvider(silentHost, {
      textSelectionRange: () => ({ sheet: 0, range: "A1" }),
      lowerRange: () => content([DEFAULT], [[0]]),
      applyStyle: (patch) => {
        patches.push(patch);
        return { ok: true };
      },
      swatchRef: async (id) =>
        id === "Color/Brand"
          ? { id, model: "spot", fallbackRgb: "#C8102E" }
          : null,
    }).provider;
    expect(p.provides.writablePaths).toEqual(WRITABLE_PATHS);
    const write = (path: string, value: unknown) =>
      p.writeProperty!({ path, target: SELECTION, value } as never);
    expect(
      await write("appliedParagraphStyle", {
        type: "text",
        value: "ParagraphStyle/Table body",
      }),
    ).toMatchObject({ kind: "applied", outcome: { applied: true } });
    await write("characterFillColor", {
      type: "colorRef",
      value: "Color/Brand",
    });
    await write("characterFontStyle", { type: "text", value: "Bold Italic" });
    await write("paragraphJustification", {
      type: "text",
      value: "CenterAlign",
    });
    expect(patches).toEqual([
      { docParaStyle: "ParagraphStyle/Table body" },
      {
        fontSwatch: {
          id: "Color/Brand",
          model: "spot",
          fallbackRgb: "#C8102E",
        },
      },
      { bold: true, italic: true },
      { hAlign: "center" },
    ]);
    // A swatch the document lacks is refused, not guessed.
    expect(
      await write("characterFillColor", {
        type: "colorRef",
        value: "Color/None",
      }),
    ).toMatchObject({ kind: "applied", outcome: { applied: false } });
  });

  it("maps a cleared text colour and the positions to patches", async () => {
    expect(
      await patchForWrite(
        "characterFillColor",
        { type: "colorRef", value: null },
        undefined,
      ),
    ).toEqual({ fontColor: "", fontSwatch: null });
    expect(
      await patchForWrite(
        "characterPosition",
        { type: "text", value: "Subscript" },
        undefined,
      ),
    ).toEqual({ vertAlign: "subscript" });
    expect(
      await patchForWrite(
        "characterLeading",
        { type: "length", value: 12 },
        undefined,
      ),
    ).toMatch(/no "characterLeading"/);
  });

  it("serves NO collections and NO ops — this is not a second Swatches provider", () => {
    const p = providerOver([DEFAULT, BIG], [[1]]);
    expect(p.provides.collections).toBeUndefined();
    expect(p.provides.ops).toBeUndefined();
  });

  it("`characterFillColor` answers only a DOCUMENT swatch (P7)", async () => {
    // A plain workbook colour names no swatch the document carries (the
    // page mints one only when it lowers); a document swatch reference
    // does, so only that is a value.
    expect(VALUED_PATHS).toContain("characterFillColor");
    const plain = providerOver([style(0, { textRgb: "#FF0000" })], [[0]]);
    expect(
      (
        await plain.readProperty!({
          path: "characterFillColor",
          target: SELECTION,
        })
      ).kind,
    ).toBe("absent");
    const doc = providerOver(
      [style(0, { textRgb: "#C8102E", textSwatch: "Color/Brand" })],
      [[0]],
    );
    expect(
      await doc.readProperty!({
        path: "characterFillColor",
        target: SELECTION,
      }),
    ).toEqual({
      kind: "value",
      value: { type: "colorRef", value: "Color/Brand" },
    });
  });
});

describe("paged.sheet text provider — reads", () => {
  it("a UNIFORM selection answers with the value", async () => {
    const p = providerOver([DEFAULT, BIG], [[1, 1]]);
    expect(
      await p.readProperty!({ path: "characterFontSize", target: SELECTION }),
    ).toEqual({ kind: "value", value: { type: "length", value: 18 } });
    expect(
      await p.readProperty!({ path: "characterFontStyle", target: SELECTION }),
    ).toEqual({ kind: "value", value: { type: "text", value: "Bold" } });
    expect(
      await p.readProperty!({ path: "characterFontFamily", target: SELECTION }),
    ).toEqual({ kind: "value", value: { type: "text", value: "Georgia" } });
  });

  it("cells that DISAGREE are MIXED — never the first one, never a winner", async () => {
    const p = providerOver([DEFAULT, BIG, SMALL], [[1, 2]]);
    for (const path of [
      "characterFontFamily",
      "characterFontStyle",
      "characterFontSize",
    ] as const) {
      expect(await p.readProperty!({ path, target: SELECTION })).toEqual({
        kind: "mixed",
      });
    }
  });

  it("SOME declare and some do not: also MIXED, not the declared one", async () => {
    // A cell with no override inherits the workbook default, which by
    // construction is NOT 18pt — the engine records an override only
    // when it differs from the default font. So they genuinely
    // disagree; rounding that to "18 pt" is the same silent winner in a
    // subtler costume.
    const p = providerOver([DEFAULT, BIG], [[1, 0]]);
    expect(
      await p.readProperty!({ path: "characterFontSize", target: SELECTION }),
    ).toEqual({ kind: "mixed" });
  });

  it("nobody declares: ABSENT with a reason, not mixed and not a fall-through", async () => {
    const p = providerOver([DEFAULT], [[0, 0]]);
    const read = await p.readProperty!({
      path: "characterFontSize",
      target: SELECTION,
    });
    expect(read.kind).toBe("absent");
    expect((read as { reason: string }).reason).toMatch(/workbook default/);
  });

  it("a path a CELL does not model is ABSENT — the conflation this axis exists to prevent", async () => {
    const p = providerOver([DEFAULT, BIG], [[1]]);
    for (const path of ["characterLeading", "paragraphRuleAbove"] as const) {
      const read = await p.readProperty!({ path, target: SELECTION });
      // NOT `decline`. A decline continues down the stack and then to
      // core, and core's content selection is the TEXT CARET's, which
      // entering this context did not clear.
      expect(read.kind).toBe("absent");
    }
  });

  it("EMPTY cells are skipped, not counted as a disagreement", async () => {
    // The IR is sparse: an empty cell is simply absent from the row. An
    // empty cell has no text, so no text formatting to disagree about.
    const sparse: LoweredContent = {
      ...content([DEFAULT, BIG], [[1, 1]]),
      rows: [
        {
          index: 0,
          heightPt: 14,
          cells: [{ col: 0, text: "x", align: "left", styleKey: 1 }],
        },
        { index: 1, heightPt: 14, cells: [] },
      ],
    };
    const p = makeTextBindingProvider(silentHost, {
      textSelectionRange: () => ({ sheet: 0, range: "A1:A2" }),
      lowerRange: () => sparse,
    }).provider;
    expect(
      await p.readProperty!({ path: "characterFontSize", target: SELECTION }),
    ).toEqual({ kind: "value", value: { type: "length", value: 18 } });
  });

  it("no workbook / nothing lowered DECLINES — there is no cell here to own", async () => {
    const p = makeTextBindingProvider(silentHost, {
      textSelectionRange: () => null,
      lowerRange: () => null,
    }).provider;
    const read = await p.readProperty!({
      path: "characterFontSize",
      target: SELECTION,
    });
    expect(read.kind).toBe("decline");
  });

  it("a lowering that THROWS declines rather than wedging the panel", async () => {
    const p = makeTextBindingProvider(silentHost, {
      textSelectionRange: () => ({ sheet: 0, range: "A1" }),
      lowerRange: () => {
        throw new Error("engine gone");
      },
    }).provider;
    expect(
      (await p.readProperty!({ path: "characterFontSize", target: SELECTION }))
        .kind,
    ).toBe("decline");
  });

  it("a ROW- or ELEMENT-scoped read is declined — this provider answers for the SELECTION", async () => {
    const p = providerOver([DEFAULT, BIG], [[1]]);
    expect(
      (
        await p.readProperty!({
          path: "characterFontSize",
          target: { kind: "element", id: { kind: "rectangle", id: "u1" } },
        })
      ).kind,
    ).toBe("decline");
    expect(
      (
        await p.readProperty!({
          path: "characterFontSize",
          target: { kind: "row", collection: "layers", id: "L1" },
        })
      ).kind,
    ).toBe("decline");
  });

  it("the ELEMENT scope is served too — the target is the SELECTION, not the caret", async () => {
    // `{scope:"element"}` and `{scope:"content"}` are the same cells
    // here: the sheet has one selection, and it is neither the host's
    // page-item selection nor its text caret.
    const p = providerOver([DEFAULT, BIG], [[1]]);
    expect(
      await p.readProperty!({
        path: "characterFontSize",
        target: { kind: "selection", scope: "element" },
      }),
    ).toEqual({ kind: "value", value: { type: "length", value: 18 } });
  });
});

describe("paged.sheet text provider — the pure pieces", () => {
  it("collapseCells: agreement, disagreement, partial declaration, silence", () => {
    const a = { type: "length" as const, value: 18 };
    const b = { type: "length" as const, value: 9 };
    expect(collapseCells([a, { ...a }], "characterFontSize")).toEqual({
      kind: "value",
      value: a,
    });
    expect(collapseCells([a, b], "characterFontSize")).toEqual({
      kind: "mixed",
    });
    expect(collapseCells([a, undefined], "characterFontSize")).toEqual({
      kind: "mixed",
    });
    expect(
      collapseCells([undefined, undefined], "characterFontSize").kind,
    ).toBe("absent");
    expect(collapseCells([], "characterFontSize").kind).toBe("absent");
  });

  it("stylesOfRange walks row-major and defaults a keyless cell to key 0", () => {
    const c = content(
      [DEFAULT, BIG, SMALL],
      [
        [1, 2],
        [0, 1],
      ],
    );
    expect(stylesOfRange(c).map((s) => s.key)).toEqual([1, 2, 0, 1]);
  });
});
