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
import { describe, expect, it } from "bun:test";

import {
  deltaE,
  harmonyOf,
  hsbToRgb,
  HARMONY_RULES,
  hueDelta,
  isNeutral,
  kMeansLab,
  labToRgb,
  nearestColorIndex,
  recolorToHarmony,
  reduceColors,
  rgbToHsb,
  rgbToLab,
  rotateHues,
  variationsOf,
  VARIATION_KINDS,
  wheelColor,
  wheelDragDelta,
  wheelPoint,
  type Rgb,
  type WeightedColor,
} from "../src";

const RED: Rgb = [255, 0, 0];
const near = (a: Rgb, b: Rgb, tol = 1) =>
  a.every((v, i) => Math.abs(v - b[i]) <= tol);

describe("colour spaces", () => {
  it("HSB round-trips the primaries and a mid colour", () => {
    expect(rgbToHsb(RED)).toEqual({ h: 0, s: 1, b: 1 });
    expect(rgbToHsb([0, 255, 0]).h).toBe(120);
    expect(rgbToHsb([0, 0, 255]).h).toBe(240);
    for (const c of [
      RED,
      [12, 200, 77],
      [250, 250, 3],
      [40, 40, 40],
    ] as Rgb[]) {
      expect(near(hsbToRgb(rgbToHsb(c)), c)).toBe(true);
    }
  });

  it("Lab matches the D65 reference values and round-trips", () => {
    const white = rgbToLab([255, 255, 255]);
    expect(white.l).toBeCloseTo(100, 1);
    expect(Math.abs(white.a)).toBeLessThan(0.05);
    const red = rgbToLab(RED);
    expect(red.l).toBeCloseTo(53.24, 1);
    expect(red.a).toBeCloseTo(80.09, 0);
    expect(red.b).toBeCloseTo(67.2, 0);
    for (const c of [RED, [12, 200, 77], [3, 3, 3], [128, 64, 200]] as Rgb[]) {
      expect(near(labToRgb(rgbToLab(c)), c)).toBe(true);
    }
  });

  it("ΔE is zero for one colour and grows with the difference", () => {
    const a = rgbToLab([100, 100, 100]);
    expect(deltaE(a, a)).toBe(0);
    expect(deltaE(a, rgbToLab([110, 100, 100]))).toBeLessThan(
      deltaE(a, rgbToLab([200, 100, 100])),
    );
  });

  it("hueDelta takes the short way round", () => {
    expect(hueDelta(350, 10)).toBe(20);
    expect(hueDelta(10, 350)).toBe(-20);
  });
});

describe("harmony rules", () => {
  it("every rule answers the base first", () => {
    for (const rule of HARMONY_RULES) {
      const out = harmonyOf([200, 60, 30], rule);
      expect(out[0]).toEqual([200, 60, 30]);
      expect(out.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("the hue rules sit at their angles", () => {
    const hues = (rule: Parameters<typeof harmonyOf>[1]) =>
      harmonyOf(RED, rule).map((c) => Math.round(rgbToHsb(c).h));
    expect(hues("complementary")).toEqual([0, 180]);
    expect(hues("triadic")).toEqual([0, 120, 240]);
    expect(hues("splitComplementary")).toEqual([0, 150, 210]);
    expect(hues("tetradic")).toEqual([0, 90, 180, 270]);
    expect(hues("analogous")).toEqual([0, 330, 30]);
  });

  it("shades darken, tints lighten, monochromatic keeps the hue", () => {
    const shades = harmonyOf([200, 60, 30], "shades").map((c) => rgbToHsb(c).b);
    for (let i = 1; i < shades.length; i++)
      expect(shades[i]).toBeLessThan(shades[i - 1]);
    const tints = harmonyOf([200, 60, 30], "tints").map((c) => rgbToHsb(c).s);
    for (let i = 1; i < tints.length; i++)
      expect(tints[i]).toBeLessThan(tints[i - 1]);
    const base = rgbToHsb([200, 60, 30]).h;
    for (const c of harmonyOf([200, 60, 30], "monochromatic")) {
      expect(Math.abs(hueDelta(base, rgbToHsb(c).h))).toBeLessThan(2);
    }
  });

  it("rotating the harmony keeps the relations between its colours", () => {
    const harmony = harmonyOf(RED, "triadic");
    const turned = rotateHues(harmony, 40);
    const h = turned.map((c) => rgbToHsb(c).h);
    expect(Math.round(hueDelta(h[0], h[1]))).toBe(120);
    expect(Math.round(hueDelta(h[1], h[2]))).toBe(120);
    expect(Math.round(h[0])).toBe(40);
    // A grey has no hue to turn.
    expect(rotateHues([[90, 90, 90]], 40)[0]).toEqual([90, 90, 90]);
  });

  it("the wheel maps hue to angle and saturation to radius, and a drag to a rotation", () => {
    const [x, y] = wheelPoint([0, 255, 0]);
    expect(Math.atan2(y, x) * (180 / Math.PI)).toBeCloseTo(120, 5);
    expect(Math.hypot(x, y)).toBeCloseTo(1, 5);
    expect(near(wheelColor(x, y, 1), [0, 255, 0])).toBe(true);
    expect(wheelDragDelta([1, 0], [0, 1])).toBeCloseTo(90, 5);
    expect(wheelDragDelta([0, 1], [1, 0])).toBeCloseTo(-90, 5);
  });
});

describe("Color Guide variations", () => {
  it("every row puts the base in the middle and its poles at the ends", () => {
    for (const kind of VARIATION_KINDS) {
      const row = variationsOf([40, 120, 200], kind, 7);
      expect(row).toHaveLength(7);
      expect(row[3]).toEqual([40, 120, 200]);
    }
    const ts = variationsOf([40, 120, 200], "tintsShades", 7).map(
      (c) => rgbToLab(c).l,
    );
    for (let i = 1; i < ts.length; i++)
      expect(ts[i]).toBeGreaterThan(ts[i - 1]);
    const vm = variationsOf([40, 120, 200], "vividMuted", 7).map(
      (c) => rgbToHsb(c).s,
    );
    expect(vm[0]).toBeGreaterThan(vm[3]);
    expect(vm[6]).toBeLessThan(vm[3]);
  });

  it("warm pulls toward orange and cool toward blue", () => {
    const row = variationsOf([0, 200, 0], "warmCool", 5);
    const h = row.map((c) => rgbToHsb(c).h);
    expect(h[0]).toBeLessThan(h[2]); // toward 30°
    expect(h[4]).toBeGreaterThan(h[2]); // toward 220°
  });
});

describe("reduce, map and recolour", () => {
  const artwork: WeightedColor[] = [
    { rgb: [250, 10, 10], weight: 5 },
    { rgb: [240, 20, 30], weight: 1 },
    { rgb: [10, 10, 250], weight: 3 },
    { rgb: [20, 30, 240], weight: 1 },
    { rgb: [10, 200, 20], weight: 2 },
  ];

  it("k-means in Lab is DETERMINISTIC and caps k by the distinct colours", () => {
    const a = kMeansLab(artwork, 3);
    const b = kMeansLab(artwork, 3);
    expect(a).toEqual(b);
    expect(a.centres).toHaveLength(3);
    expect(a.assignment[0]).toBe(a.assignment[1]);
    expect(a.assignment[2]).toBe(a.assignment[3]);
    expect(new Set(a.assignment).size).toBe(3);
    const two: WeightedColor[] = [
      { rgb: [0, 0, 0], weight: 1 },
      { rgb: [0, 0, 0], weight: 1 },
      { rgb: [255, 255, 255], weight: 1 },
    ];
    expect(kMeansLab(two, 6).centres).toHaveLength(2);
  });

  it("reduce to N keeps the HEAVIEST colour of each cluster", () => {
    const out = reduceColors(artwork, 3);
    expect(out[0]).toEqual([250, 10, 10]);
    expect(out[1]).toEqual([250, 10, 10]);
    expect(out[2]).toEqual([10, 10, 250]);
    expect(out[3]).toEqual([10, 10, 250]);
    expect(out[4]).toEqual([10, 200, 20]);
    expect(new Set(reduceColors(artwork, 1).map(String)).size).toBe(1);
  });

  it("a library match is the nearest by ΔE", () => {
    const library: Rgb[] = [
      [0, 0, 0],
      [255, 0, 0],
      [0, 0, 255],
    ];
    expect(nearestColorIndex([200, 30, 20], library)).toBe(1);
    expect(nearestColorIndex([20, 20, 30], library)).toBe(0);
    expect(nearestColorIndex([1, 1, 1], [])).toBe(-1);
  });

  it("recolour to a harmony: the heaviest cluster takes the base, variants keep their offsets, neutrals stay", () => {
    const withNeutral: WeightedColor[] = [
      ...artwork,
      { rgb: [0, 0, 0], weight: 9 },
    ];
    const harmony = harmonyOf([0, 160, 255], "triadic");
    const out = recolorToHarmony(withNeutral, harmony);
    expect(out[5]).toEqual([0, 0, 0]);
    // The red cluster (weight 6) is the heaviest chromatic one → the base.
    expect(
      Math.abs(hueDelta(rgbToHsb(out[0]).h, rgbToHsb(harmony[0]).h)),
    ).toBeLessThan(2);
    // Its lighter variant keeps its hue offset from the cluster lead.
    const offsetBefore = hueDelta(
      rgbToHsb(artwork[0].rgb).h,
      rgbToHsb(artwork[1].rgb).h,
    );
    const offsetAfter = hueDelta(rgbToHsb(out[0]).h, rgbToHsb(out[1]).h);
    expect(Math.abs(offsetAfter - offsetBefore)).toBeLessThan(2);
    // Same input, same output.
    expect(recolorToHarmony(withNeutral, harmony)).toEqual(out);
    // Black is what "preserve neutrals" recognises.
    expect(isNeutral([0, 0, 0])).toBe(true);
  });
});
