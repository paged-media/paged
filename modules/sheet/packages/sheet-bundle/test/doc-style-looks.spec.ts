// Sheet ADR 524 — grid parity: the frame surface draws a document-styled
// cell in its document style's face, size, weight and colour, filling only
// what the cell leaves unset (direct formatting wins).

import { describe, expect, it } from "bun:test";

import type { GridScene } from "@paged-media/sheet-host-model";

import {
  docStyleIdsOf,
  withDocumentStyles,
} from "../src/surface/doc-style-looks";

const scene = (styles: GridScene["styles"]): GridScene =>
  ({ styles }) as unknown as GridScene;

describe("document style looks in the grid [sheet.format.doc-style-map]", () => {
  const looks = new Map([
    [
      "P/H1",
      { family: "Minion Pro", style: "Bold", sizePt: 18, color: "#112233" },
    ],
    ["C/Em", { style: "Italic" }],
  ]);

  it("fills a mapped cell from its paragraph and character styles", () => {
    const s = scene([
      { key: 0 },
      { key: 1, docParaStyle: "P/H1", docCharStyle: "C/Em" },
    ] as GridScene["styles"]);
    expect(docStyleIdsOf(s)).toEqual([
      { collection: "character", id: "C/Em" },
      { collection: "paragraph", id: "P/H1" },
    ]);
    const st = withDocumentStyles(s, looks).styles[1];
    expect(st.fontName).toBe("Minion Pro");
    expect(st.fontSizePt).toBe(18);
    expect(st.italic).toBe(true);
    expect(st.bold).toBe(false); // the character style's face wins
    expect(st.textRgb).toBe("#112233");
  });

  it("keeps the cell's own formatting", () => {
    const s = scene([
      { key: 0 },
      {
        key: 1,
        docParaStyle: "P/H1",
        fontSizePt: 9,
        textRgb: "#FF0000",
      },
    ] as GridScene["styles"]);
    const st = withDocumentStyles(s, looks).styles[1];
    expect(st.fontSizePt).toBe(9);
    expect(st.textRgb).toBe("#FF0000");
    expect(st.bold).toBe(true);
    expect(withDocumentStyles(s, new Map())).toBe(s);
  });
});
