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

import { peakedWidthProfile } from "../src";

describe("peakedWidthProfile", () => {
  it("peaks at the anchor and decays linearly over `falloff` neighbors", () => {
    expect(peakedWidthProfile(5, 2, 10, 2, 2)).toEqual([2, 6, 10, 6, 2]);
  });

  it("clamps the peak index into range", () => {
    expect(peakedWidthProfile(3, -5, 8, 2, 2)).toEqual([8, 5, 2]);
    expect(peakedWidthProfile(3, 99, 8, 2, 2)).toEqual([2, 5, 8]);
  });

  it("a peak below base thins instead of bulging (still ≥ 0)", () => {
    expect(peakedWidthProfile(3, 1, 0, 4, 1)).toEqual([4, 0, 4]);
    // A profile can never go negative even when peak − base overshoots.
    expect(peakedWidthProfile(1, 0, -10, 2, 1)).toEqual([0]);
  });

  it("falloff clamps to ≥ 1 (the peak's immediate neighbors decay fully)", () => {
    expect(peakedWidthProfile(3, 1, 10, 2, 0)).toEqual([2, 10, 2]);
  });

  it("degenerate input yields []", () => {
    expect(peakedWidthProfile(0, 0, 5, 1)).toEqual([]);
    expect(peakedWidthProfile(NaN, 0, 5, 1)).toEqual([]);
  });
});
