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

import { describe, expect, it } from "vitest";

import { cmykToRgb, parseCssColor, rgbToHex } from "../src";

describe("parseCssColor — hex", () => {
  it("reads #rrggbb", () => {
    expect(parseCssColor("#ff8000")).toEqual([255, 128, 0]);
    expect(parseCssColor("#000000")).toEqual([0, 0, 0]);
    expect(parseCssColor("#ffffff")).toEqual([255, 255, 255]);
  });

  it("expands #rgb by doubling each digit", () => {
    expect(parseCssColor("#f80")).toEqual([255, 136, 0]);
    expect(parseCssColor("#abc")).toEqual(parseCssColor("#aabbcc"));
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(parseCssColor("  #FF8000\n")).toEqual([255, 128, 0]);
    expect(parseCssColor("#AbC")).toEqual([170, 187, 204]);
  });

  it("answers null for a hex of any other length (no #rgba / #rrggbbaa support)", () => {
    expect(parseCssColor("#")).toBeNull();
    expect(parseCssColor("#ff")).toBeNull();
    expect(parseCssColor("#ff80")).toBeNull();
    expect(parseCssColor("#ff800080")).toBeNull();
  });

  it("answers null for a hex with no hex digits in it", () => {
    expect(parseCssColor("#ggg")).toBeNull();
    expect(parseCssColor("#zzzzzz")).toBeNull();
  });
});

describe("parseCssColor — rgb() / rgba()", () => {
  it("reads the comma form", () => {
    expect(parseCssColor("rgb(255, 128, 0)")).toEqual([255, 128, 0]);
    expect(parseCssColor("rgb(0,0,0)")).toEqual([0, 0, 0]);
  });

  it("reads the space form, with or without a slash alpha", () => {
    expect(parseCssColor("rgb(255 128 0)")).toEqual([255, 128, 0]);
    expect(parseCssColor("rgb(255 128 0 / 0.5)")).toEqual([255, 128, 0]);
  });

  it("reads rgba() and drops the alpha", () => {
    expect(parseCssColor("rgba(10, 20, 30, 0.25)")).toEqual([10, 20, 30]);
  });

  it("reads percentages as a fraction of 255, rounded", () => {
    expect(parseCssColor("rgb(100%, 50%, 0%)")).toEqual([255, 128, 0]);
    expect(parseCssColor("rgb(20% 40% 60%)")).toEqual([51, 102, 153]);
  });

  it("rounds fractional components and clamps to 0..255", () => {
    expect(parseCssColor("rgb(12.4, 12.5, 12.6)")).toEqual([12, 13, 13]);
    expect(parseCssColor("rgb(300, -20, 256)")).toEqual([255, 0, 255]);
    expect(parseCssColor("rgb(150%, -10%, 100%)")).toEqual([255, 0, 255]);
  });

  it("is case-insensitive", () => {
    expect(parseCssColor("RGB(1, 2, 3)")).toEqual([1, 2, 3]);
  });

  it("answers null when the call is malformed", () => {
    expect(parseCssColor("rgb(1, 2)")).toBeNull();
    expect(parseCssColor("rgb()")).toBeNull();
    expect(parseCssColor("rgb(1, 2, 3")).toBeNull();
    expect(parseCssColor("rgb 1 2 3")).toBeNull();
  });
});

describe("parseCssColor — keywords", () => {
  it("knows the sixteen base CSS colours", () => {
    expect(parseCssColor("black")).toEqual([0, 0, 0]);
    expect(parseCssColor("silver")).toEqual([192, 192, 192]);
    expect(parseCssColor("gray")).toEqual([128, 128, 128]);
    expect(parseCssColor("white")).toEqual([255, 255, 255]);
    expect(parseCssColor("maroon")).toEqual([128, 0, 0]);
    expect(parseCssColor("red")).toEqual([255, 0, 0]);
    expect(parseCssColor("purple")).toEqual([128, 0, 128]);
    expect(parseCssColor("fuchsia")).toEqual([255, 0, 255]);
    expect(parseCssColor("green")).toEqual([0, 128, 0]);
    expect(parseCssColor("lime")).toEqual([0, 255, 0]);
    expect(parseCssColor("olive")).toEqual([128, 128, 0]);
    expect(parseCssColor("yellow")).toEqual([255, 255, 0]);
    expect(parseCssColor("navy")).toEqual([0, 0, 128]);
    expect(parseCssColor("blue")).toEqual([0, 0, 255]);
    expect(parseCssColor("teal")).toEqual([0, 128, 128]);
    expect(parseCssColor("aqua")).toEqual([0, 255, 255]);
  });

  it("knows the common aliases and orange", () => {
    expect(parseCssColor("grey")).toEqual(parseCssColor("gray"));
    expect(parseCssColor("magenta")).toEqual(parseCssColor("fuchsia"));
    expect(parseCssColor("cyan")).toEqual(parseCssColor("aqua"));
    expect(parseCssColor("orange")).toEqual([255, 165, 0]);
  });

  it("is case-insensitive and trims", () => {
    expect(parseCssColor(" Red ")).toEqual([255, 0, 0]);
    expect(parseCssColor("NAVY")).toEqual([0, 0, 128]);
  });

  it("answers null for `none`, `transparent` and the empty string (no paint)", () => {
    expect(parseCssColor("none")).toBeNull();
    expect(parseCssColor("NONE")).toBeNull();
    expect(parseCssColor("transparent")).toBeNull();
    expect(parseCssColor("")).toBeNull();
    expect(parseCssColor("   ")).toBeNull();
  });

  it("answers null for anything it does not know — the caller picks the fallback", () => {
    expect(parseCssColor("rebeccapurple")).toBeNull();
    expect(parseCssColor("hsl(120, 100%, 50%)")).toBeNull();
    expect(parseCssColor("currentColor")).toBeNull();
    expect(parseCssColor("url(#gradient)")).toBeNull();
    expect(parseCssColor("not a colour")).toBeNull();
  });
});

describe("rgbToHex", () => {
  it("formats a triple as lowercase #rrggbb, zero-padded", () => {
    expect(rgbToHex([255, 128, 0])).toBe("#ff8000");
    expect(rgbToHex([0, 0, 0])).toBe("#000000");
    expect(rgbToHex([1, 2, 3])).toBe("#010203");
    expect(rgbToHex([171, 205, 239])).toBe("#abcdef");
  });

  it("rounds and clamps out-of-gamut input rather than emitting a bad string", () => {
    expect(rgbToHex([254.6, 0.4, 127.5])).toBe("#ff0080");
    expect(rgbToHex([300, -4, 256])).toBe("#ff00ff");
  });

  it("round-trips with parseCssColor", () => {
    expect(parseCssColor(rgbToHex([18, 52, 86]))).toEqual([18, 52, 86]);
    expect(rgbToHex(parseCssColor("#123456")!)).toBe("#123456");
    expect(rgbToHex(parseCssColor("orange")!)).toBe("#ffa500");
  });
});

describe("cmykToRgb — the naive subtractive model", () => {
  it("no ink is paper white, full black is black", () => {
    expect(cmykToRgb(0, 0, 0, 0)).toEqual([255, 255, 255]);
    expect(cmykToRgb(0, 0, 0, 100)).toEqual([0, 0, 0]);
    expect(cmykToRgb(100, 100, 100, 0)).toEqual([0, 0, 0]);
  });

  it("each process ink removes its complement", () => {
    expect(cmykToRgb(100, 0, 0, 0)).toEqual([0, 255, 255]); // cyan
    expect(cmykToRgb(0, 100, 0, 0)).toEqual([255, 0, 255]); // magenta
    expect(cmykToRgb(0, 0, 100, 0)).toEqual([255, 255, 0]); // yellow
  });

  it("K darkens every channel proportionally", () => {
    expect(cmykToRgb(0, 0, 0, 50)).toEqual([128, 128, 128]);
    expect(cmykToRgb(100, 0, 0, 50)).toEqual([0, 128, 128]);
  });

  it("takes 0–100 (the IDML swatch convention), not 0–1", () => {
    expect(cmykToRgb(50, 0, 0, 0)).toEqual([128, 255, 255]);
    expect(cmykToRgb(0.5, 0, 0, 0)).toEqual([254, 255, 255]);
  });

  it("clamps out-of-range ink values", () => {
    expect(cmykToRgb(150, -20, 0, 0)).toEqual([0, 255, 255]);
    expect(cmykToRgb(0, 0, 0, 250)).toEqual([0, 0, 0]);
  });
});
