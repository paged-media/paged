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

// The ruler's labelled marks (UX audit F-31, ADR 263): as the view zooms
// out, the labelled step grows along 1-2-5 until the widest number in
// view, plus a gap, fits between two marks, as InDesign's rulers thin;
// a negative label keeps its minus sign, and a label the ruler's start
// would cut is left off rather than shown without its sign.

import { describe, expect, test } from "bun:test";

import {
  RULER_LABEL_GAP,
  RULER_LABEL_INSET,
  rulerLabel,
  rulerLabelWidth,
  rulerMarks,
  rulerStep,
} from "../../src/cockpit/canvas-frame/ruler-marks";

/** Every labelled pair leaves the first label room plus the gap. */
function assertNoOverlap(scale: number, translate: number, length: number) {
  const marks = rulerMarks(scale, translate, length);
  expect(marks.length).toBeGreaterThan(1);
  for (let i = 1; i < marks.length; i++) {
    const a = marks[i - 1]!;
    const room = marks[i]!.px - a.px;
    expect(room).toBeGreaterThanOrEqual(
      RULER_LABEL_INSET + rulerLabelWidth(a.value) + RULER_LABEL_GAP,
    );
  }
}

describe("ruler labels (F-31)", () => {
  test("the step is a 1-2-5 number", () => {
    for (const scale of [0.05, 0.11, 0.33, 1, 2.5, 8, 40]) {
      const step = rulerStep(scale, -1000, 5000);
      const mantissa = step / 10 ** Math.floor(Math.log10(step));
      expect([1, 2, 5]).toContain(Math.round(mantissa));
    }
  });

  test("labels never run into each other, at any zoom", () => {
    // Long document coordinates (a deep pasteboard, page 30 of a
    // spread run) at the extremes of the zoom range and well past them.
    for (const scale of [0.002, 0.0028, 0.01, 0.05, 0.08, 0.25, 1, 4, 40]) {
      for (const docStart of [-12000, -300, 0, 9000, 48000]) {
        assertNoOverlap(scale, -docStart * scale, 1600);
      }
    }
  });

  test("zooming out thins the labels: the step never shrinks", () => {
    let last = 0;
    for (let scale = 40; scale >= 0.01; scale /= 1.25) {
      const step = rulerStep(scale, -500, 6000);
      expect(step).toBeGreaterThanOrEqual(last);
      last = step;
    }
    expect(rulerStep(0.05, -500, 6000)).toBeGreaterThanOrEqual(1000);
    expect(rulerStep(1, -500, 6000)).toBeLessThanOrEqual(100);
  });

  test("a negative label keeps its minus sign", () => {
    expect(rulerLabel(-300)).toBe("−300");
    expect(rulerLabel(0)).toBe("0");
    expect(rulerLabel(-0)).toBe("0");
    expect(rulerLabel(150)).toBe("150");
  });

  test("a label the ruler's start would cut is left off, its tick kept", () => {
    // At 100 %, origin 205 px in: the -300 mark sits at -95 px, the -200
    // mark at 5 px (label visible).
    const marks = rulerMarks(1, 205, 800);
    const cut = marks.filter((m) => m.label === null);
    for (const m of cut) expect(m.px + RULER_LABEL_INSET).toBeLessThan(0);
    for (const m of marks.filter((m) => m.px + RULER_LABEL_INSET >= 0)) {
      expect(m.label).toBe(rulerLabel(m.value));
    }
    expect(marks.some((m) => m.label?.startsWith("−"))).toBe(true);
  });
});
