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

// One zoom range and the named views (ADR 246, ADR 1201 D-12): 100 % stays
// a camera scale of 1; Actual size shows an inch as 96 CSS px; the
// calibrated size an inch as an inch; the zoom field's text is read into
// the one range; the calibration is a shape-checked editor preference.

import { describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import {
  ACTUAL_SIZE_SCALE,
  calibratedScale,
  parseZoomPercent,
  ZOOM_MAX_SCALE,
  ZOOM_MIN_SCALE,
} from "../../src/state/zoom-range";
import {
  densityFromMeasurement,
  getScreenCalibration,
  setScreenCalibration,
} from "../../src/state/zoom-calibration";
import { createEditorScope } from "../../src/state/editor-scope";
import { memoryStorage, setEditorStorage } from "../../src/state/storage";

describe("the named views", () => {
  test("Actual size is an inch as 96 CSS px, about 133 %; 100 % keeps its meaning", () => {
    covers("command:paged.view.actualSize", "command:paged.view.zoom100");
    expect(ACTUAL_SIZE_SCALE).toBeCloseTo(96 / 72, 12);
    expect(Math.round(ACTUAL_SIZE_SCALE * 100)).toBe(133);
    // 72 pt (an inch) at Actual size is 96 CSS px.
    expect(72 * ACTUAL_SIZE_SCALE).toBeCloseTo(96, 12);
  });

  test("the calibrated size follows the screen's density and the device pixel ratio", () => {
    covers("command:paged.view.calibratedSize");
    // A 254 ppi screen at 2× (a laptop): 127 CSS px per physical inch.
    expect(calibratedScale(254, 2)).toBeCloseTo(127 / 72, 9);
    // The browser zoomed to 125 %: the CSS px grows, the scale shrinks.
    expect(calibratedScale(254, 2.5)).toBeCloseTo(101.6 / 72, 9);
    expect(calibratedScale(null)).toBeNull();
    expect(calibratedScale(0)).toBeNull();
    expect(calibratedScale(Number.NaN)).toBeNull();
  });
});

describe("the zoom field's text", () => {
  test("a percentage, with or without the sign, a comma or a point", () => {
    expect(parseZoomPercent("150")).toBe(1.5);
    expect(parseZoomPercent("150 %")).toBe(1.5);
    expect(parseZoomPercent(" 75% ")).toBe(0.75);
    expect(parseZoomPercent("33,5")).toBeCloseTo(0.335, 12);
    expect(parseZoomPercent("12.5")).toBe(0.125);
  });

  test("held inside the one range; nonsense is refused", () => {
    expect(parseZoomPercent("1")).toBe(ZOOM_MIN_SCALE);
    expect(parseZoomPercent("9000")).toBe(ZOOM_MAX_SCALE);
    expect(parseZoomPercent("")).toBeNull();
    expect(parseZoomPercent("abc")).toBeNull();
    expect(parseZoomPercent("0")).toBeNull();
    expect(parseZoomPercent("-50")).toBeNull();
    expect(parseZoomPercent("1e3")).toBeNull();
  });
});

describe("the screen calibration (paged.view.calibration)", () => {
  const fresh = (stored: Record<string, string> = {}) => {
    const scope = createEditorScope();
    const storage = memoryStorage();
    for (const [k, v] of Object.entries(stored)) storage.setItem(k, v);
    setEditorStorage(scope, storage);
    return { scope, storage };
  };

  test("a measurement gives device pixels per inch", () => {
    covers("command:paged.view.calibrateScreen");
    // A 10 cm bar measured as 500 CSS px at 2×: 254 device px per inch.
    expect(densityFromMeasurement(500, 10 / 2.54, 2)).toBeCloseTo(254, 9);
    // Implausible screens are refused.
    expect(densityFromMeasurement(5, 4, 1)).toBeNull();
    expect(densityFromMeasurement(0, 4, 1)).toBeNull();
  });

  test("is remembered, read back with a shape check, and forgotten", () => {
    covers("setting:paged.view.calibration");
    const { scope, storage } = fresh();
    expect(getScreenCalibration(scope)).toBeNull();
    setScreenCalibration(scope, 254);
    expect(getScreenCalibration(scope)).toBe(254);
    expect(JSON.parse(storage.getItem("paged.view.calibration")!)).toEqual({
      devicePxPerInch: 254,
    });
    // A new editor reads it.
    const again = createEditorScope();
    setEditorStorage(again, storage);
    expect(getScreenCalibration(again)).toBe(254);
    // An implausible value is refused; null forgets.
    setScreenCalibration(scope, 5);
    expect(getScreenCalibration(scope)).toBe(254);
    setScreenCalibration(scope, null);
    expect(getScreenCalibration(scope)).toBeNull();
    expect(storage.getItem("paged.view.calibration")).toBeNull();
  });

  test("a hand-edited or stale value falls back to not calibrated", () => {
    for (const raw of [
      "not json",
      "254",
      '{"devicePxPerInch":"254"}',
      '{"devicePxPerInch":99999}',
      "[]",
    ])
      expect(
        getScreenCalibration(fresh({ "paged.view.calibration": raw }).scope),
      ).toBeNull();
  });
});
