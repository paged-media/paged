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

// Two fingers zoom and move the canvas together (editor ADR 293).

import { describe, expect, test } from "bun:test";

import { ZOOM_MAX_SCALE } from "@paged-media/shell/state/zoom-range";

import { pinchCamera, startPinch } from "../../src/ui/pinch";

describe("pinch", () => {
  const camera = { scale: 1, tx: 0, ty: 0 };

  test("spreading the fingers to twice the distance doubles the scale about their midpoint", () => {
    const pinch = startPinch(camera, [100, 100], [200, 100]);
    const next = pinchCamera(pinch, [50, 100], [250, 100]);
    expect(next.scale).toBeCloseTo(2);
    // The document point under the midpoint (150, 100) stays there.
    expect(next.tx + 150 * next.scale).toBeCloseTo(150);
    expect(next.ty + 100 * next.scale).toBeCloseTo(100);
  });

  test("moving both fingers together pans by the midpoint's travel", () => {
    const pinch = startPinch(camera, [100, 100], [200, 100]);
    const next = pinchCamera(pinch, [130, 140], [230, 140]);
    expect(next).toEqual({ scale: 1, tx: 30, ty: 40 });
  });

  test("the scale stays within the zoom range", () => {
    const pinch = startPinch(camera, [0, 0], [100, 0]);
    expect(pinchCamera(pinch, [0, 0], [100000, 0]).scale).toBe(ZOOM_MAX_SCALE);
    expect(pinchCamera(pinch, [0, 0], [0.001, 0]).scale).toBeGreaterThan(0);
  });
});
