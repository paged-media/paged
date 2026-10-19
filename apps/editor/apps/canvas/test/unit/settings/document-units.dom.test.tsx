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

// Setting `paged.units` (packages/ui inputs/document-unit.ts, editor ADR
// 245): the unit geometry lengths are shown and read in, points by
// default, persisted under `localStorage["paged.units"]`. One formatter
// and one parser: a bare number is in the unit, a typed unit converts.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";
import {
  documentUnit,
  formatLength,
  formatLengthPair,
  parseLengthText,
  resetDocumentUnit,
  setDocumentUnit,
  useDocumentUnit,
} from "@paged-media/ui";

const KEY = "paged.units";

beforeEach(() => {
  localStorage.clear();
  resetDocumentUnit();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  resetDocumentUnit();
});

describe("setting paged.units", () => {
  test("defaults to points", () => {
    covers("setting:paged.units");
    expect(documentUnit()).toBe("pt");
    expect(formatLength(36)).toBe("36 pt");
  });

  test("a choice is persisted, survives a reload, and re-renders its readers", () => {
    covers("setting:paged.units");
    const { result } = renderHook(() => useDocumentUnit());
    act(() => setDocumentUnit("mm"));
    expect(result.current).toBe("mm");
    expect(localStorage.getItem(KEY)).toBe("mm");
    resetDocumentUnit(); // what a reload does
    expect(documentUnit()).toBe("mm");
    expect(formatLength(72 / 2.54)).toBe("10 mm");
  });

  test("a stored value that is not a unit reads as points, and is never written", () => {
    covers("setting:paged.units");
    localStorage.setItem(KEY, "furlongs");
    resetDocumentUnit();
    expect(documentUnit()).toBe("pt");
    setDocumentUnit("furlongs");
    expect(documentUnit()).toBe("pt");
    expect(localStorage.getItem(KEY)).toBe("furlongs");
  });
});

describe("one length parser and formatter", () => {
  test("a bare number is in the unit, a typed unit converts", () => {
    covers("setting:paged.units");
    expect(parseLengthText("12", "pt")).toBe(12);
    expect(parseLengthText("10", "mm")).toBeCloseTo(28.3465, 3);
    expect(parseLengthText("10mm", "pt")).toBeCloseTo(28.3465, 3);
    expect(parseLengthText("0.5 in", "mm")).toBe(36);
    expect(parseLengthText("6p", "pt")).toBe(72);
    expect(parseLengthText("1 pc", "pt")).toBe(12);
    expect(parseLengthText("12,5pt", "mm")).toBe(12.5);
    expect(parseLengthText("abc", "pt")).toBeNull();
    expect(parseLengthText("10 furlongs", "pt")).toBeNull();
  });

  test("sizes read in the unit once", () => {
    covers("setting:paged.units");
    expect(formatLengthPair(612, 792, "pt")).toBe("612 × 792 pt");
    expect(formatLengthPair(595.276, 841.89, "mm")).toBe("210 × 297 mm");
    expect(formatLengthPair(612, 792, "in")).toBe("8.5 × 11 in");
  });
});
