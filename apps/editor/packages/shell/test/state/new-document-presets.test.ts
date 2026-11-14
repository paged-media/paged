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

// The New document dialog's model (editor ADR 1220, UX audit F-04): the
// purpose presets, the locale's paper, validation, the stored shape (ADR
// 247), the payload a script passes, the preview's geometry, and the
// engine writes a setup becomes.

import { describe, expect, test } from "bun:test";

import {
  columnWidth,
  defaultSetup,
  isValidSetup,
  paperFamilyOf,
  PRESETS,
  presetsIn,
  previewGeometry,
  readStoredSetup,
  setupFromPayload,
  setupOfPreset,
  validateSetup,
  withOrientation,
  type NewDocumentSetup,
} from "../../src/state/new-document-presets";
import { setupMutations } from "../../src/state/commands/new-document";

const MM = 72 / 25.4;
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

describe("purpose presets (the strategy's §6.5)", () => {
  test("Print, Digital and Structured carry the named purposes", () => {
    expect(presetsIn("print").map((p) => p.id)).toEqual([
      "magazine",
      "book",
      "brochure",
      "poster",
      "businessCard",
      "packaging",
    ]);
    expect(presetsIn("digital").map((p) => p.id)).toEqual([
      "pdfPublication",
      "presentation",
      "webOutput",
      "marketingGraphic",
    ]);
    expect(presetsIn("structured").map((p) => p.id)).toEqual([
      "catalog",
      "productSheet",
      "variableData",
    ]);
  });

  test("every preset, in either paper family, is a setup that can be created", () => {
    for (const p of PRESETS)
      for (const family of ["a4", "letter"] as const)
        expect({
          id: p.id,
          family,
          ok: isValidSetup(setupOfPreset(p.id, family)),
        }).toEqual({ id: p.id, family, ok: true });
  });

  test("a paper preset takes the locale's paper", () => {
    const a4 = setupOfPreset("magazine", "a4");
    expect(close(a4.widthPt, 210 * MM) && close(a4.heightPt, 297 * MM)).toBe(
      true,
    );
    expect(a4.unit).toBe("mm");
    const letter = setupOfPreset("magazine", "letter");
    expect([letter.widthPt, letter.heightPt]).toEqual([612, 792]);
    expect(letter.unit).toBe("in");
    expect(setupOfPreset("presentation", "a4")).toMatchObject({
      widthPt: 1920,
      heightPt: 1080,
      unit: "px",
    });
  });

  test("Letter where the locale prints on it, A4 elsewhere", () => {
    expect(paperFamilyOf("en-US")).toBe("letter");
    expect(paperFamilyOf("en-CA")).toBe("letter");
    expect(paperFamilyOf("de-DE")).toBe("a4");
    expect(paperFamilyOf("en-GB")).toBe("a4");
    expect(paperFamilyOf(undefined)).toBe("a4");
    expect(defaultSetup("letter")).toMatchObject({
      preset: "custom",
      widthPt: 612,
      heightPt: 792,
      pages: 1,
    });
  });
});

describe("validation says what cannot be created", () => {
  const base = defaultSetup("a4");
  test("the default is valid", () => {
    expect(validateSetup(base)).toEqual({});
  });
  test("each field's problem", () => {
    expect(validateSetup({ ...base, widthPt: 0 })).toMatchObject({
      width: "sizeRange",
    });
    expect(validateSetup({ ...base, pages: 0 })).toEqual({
      pages: "pagesRange",
    });
    expect(validateSetup({ ...base, pages: 2.5 })).toEqual({
      pages: "pagesRange",
    });
    expect(validateSetup({ ...base, bleedPt: -1 })).toEqual({
      bleed: "bleedRange",
    });
    expect(
      validateSetup({
        ...base,
        margins: { ...base.margins, top: base.heightPt },
      }),
    ).toEqual({ marginsVertical: "marginsTooTall" });
    expect(
      validateSetup({
        ...base,
        margins: {
          ...base.margins,
          inside: base.widthPt / 2,
          outside: base.widthPt / 2,
        },
      }),
    ).toMatchObject({ marginsHorizontal: "marginsTooWide" });
    expect(validateSetup({ ...base, columns: 0 })).toEqual({
      columns: "columnsRange",
    });
    expect(validateSetup({ ...base, columns: 40, gutterPt: 20 })).toEqual({
      gutter: "columnsTooNarrow",
    });
  });
  test("a column's width", () => {
    const s: NewDocumentSetup = {
      ...base,
      widthPt: 600,
      margins: { top: 0, bottom: 0, inside: 50, outside: 50 },
      columns: 3,
      gutterPt: 25,
    };
    expect(columnWidth(s)).toBe(150);
  });
});

describe("orientation turns the page and its margins", () => {
  test("portrait to landscape", () => {
    const s = setupOfPreset("productSheet", "letter");
    const turned = withOrientation(s, "landscape");
    expect([turned.widthPt, turned.heightPt]).toEqual([s.heightPt, s.widthPt]);
    expect(withOrientation(turned, "landscape")).toBe(turned);
  });
});

describe("the stored setup and a script's payload are read field by field (ADR 247)", () => {
  const fallback = defaultSetup("a4");
  test("a stored setup comes back; a broken field reads as the fallback's", () => {
    const stored = {
      ...setupOfPreset("catalog", "a4"),
      unit: "furlong",
      pages: "12",
    };
    const read = readStoredSetup(stored, fallback)!;
    expect(read.preset).toBe("catalog");
    expect(read.unit).toBe(fallback.unit);
    expect(read.pages).toBe(fallback.pages);
    expect(read.columns).toBe(3);
  });
  test("nothing usable reads as nothing", () => {
    expect(readStoredSetup(null, fallback)).toBeNull();
    expect(readStoredSetup([1, 2], fallback)).toBeNull();
    // A stored setup that cannot be created is not offered back.
    expect(readStoredSetup({ ...fallback, columns: 0 }, fallback)).toBeNull();
  });
  test("a payload needs a width and a height; the rest defaults", () => {
    expect(setupFromPayload(undefined)).toBeNull();
    expect(setupFromPayload({ widthPt: 300 })).toBeNull();
    expect(setupFromPayload({ widthPt: 300, heightPt: 400 })).toMatchObject({
      widthPt: 300,
      heightPt: 400,
      pages: 1,
      columns: 1,
      bleedPt: 0,
    });
    expect(
      setupFromPayload({ widthPt: 300, heightPt: 400, pages: 3, columns: 2 }),
    ).toMatchObject({ pages: 3, columns: 2 });
  });
});

describe("the preview is the setup to scale", () => {
  test("bleed outside the page, margins inside, one rect per column", () => {
    const s: NewDocumentSetup = {
      ...defaultSetup("a4"),
      widthPt: 400,
      heightPt: 300,
      bleedPt: 10,
      margins: { top: 20, bottom: 20, inside: 40, outside: 20 },
      columns: 2,
      gutterPt: 20,
    };
    const g = previewGeometry(s, { width: 220, height: 170 });
    // (220 - 12) / 420 and (170 - 12) / 320: the height decides.
    const k = 158 / 320;
    expect(close(g.page.w, 400 * k)).toBe(true);
    expect(g.bleed!.x).toBeLessThan(g.page.x);
    expect(close(g.margins.x - g.page.x, 40 * k)).toBe(true);
    expect(g.columns).toHaveLength(2);
    expect(
      close(g.columns[1]!.x - (g.columns[0]!.x + g.columns[0]!.w), 20 * k),
    ).toBe(true);
    expect(previewGeometry({ ...s, bleedPt: 0, columns: 1 }).bleed).toBeNull();
    expect(previewGeometry({ ...s, columns: 1 }).columns).toEqual([]);
  });
});

describe("a setup becomes the engine's own writes", () => {
  test("further pages, then the bleed and every page's margins and columns", () => {
    const s: NewDocumentSetup = {
      ...defaultSetup("a4"),
      pages: 3,
      bleedPt: 9,
      margins: { top: 1, bottom: 2, inside: 3, outside: 4 },
      columns: 2,
      gutterPt: 12,
    };
    const { pages, layout } = setupMutations(s, "p1");
    expect(pages).toEqual({
      op: "batch",
      args: {
        ops: [
          { op: "insertPage", args: { afterPageId: "p1", masterId: null } },
          { op: "insertPage", args: { afterPageId: "p1", masterId: null } },
        ],
      },
    });
    const ops = (
      layout as { args: { ops: { args: Record<string, unknown> }[] } }
    ).args.ops.map((o) => o.args);
    expect(ops.slice(0, 4).map((a) => [a.address, a.path])).toEqual([
      ["doc", "documentBleedTop"],
      ["doc", "documentBleedBottom"],
      ["doc", "documentBleedInsideOrLeft"],
      ["doc", "documentBleedOutsideOrRight"],
    ]);
    expect(ops.filter((a) => a.path === "pageColumnCount")).toEqual([
      {
        address: "page:#1",
        path: "pageColumnCount",
        value: { type: "number", value: 2 },
      },
      {
        address: "page:#2",
        path: "pageColumnCount",
        value: { type: "number", value: 2 },
      },
      {
        address: "page:#3",
        path: "pageColumnCount",
        value: { type: "number", value: 2 },
      },
    ]);
    expect(
      ops.find((a) => a.address === "page:#2" && a.path === "pageMarginLeft"),
    ).toEqual({
      address: "page:#2",
      path: "pageMarginLeft",
      value: { type: "length", value: 3 },
    });
  });
  test("one page and no bleed: no page inserts, no bleed writes", () => {
    const { pages, layout } = setupMutations(defaultSetup("a4"), "p1");
    expect(pages).toBeNull();
    const paths = (
      layout as { args: { ops: { args: { path: string } }[] } }
    ).args.ops.map((o) => o.args.path);
    expect(paths.some((p) => p.startsWith("documentBleed"))).toBe(false);
    expect(paths).toHaveLength(6);
  });
});
