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

// The adjust drag's outline preview (slide ADR 717): the engine's SVG
// path data as the host's cubic preview shapes.

import { describe, expect, it } from "bun:test";

import { previewPaths } from "../src/adjust-handles";

describe("[plugin-slide.live-presets] adjust preview paths", () => {
  it("a closed subpath folds its closing cubic onto the first anchor", () => {
    const d =
      "M0.00 0.00 C10.00 0.00 10.00 0.00 10.00 0.00 C10.00 10.00 10.00 10.00 10.00 10.00 C5.00 5.00 1.00 1.00 0.00 0.00 Z";
    const [p] = previewPaths("p1", d);
    if (!p) throw new Error("no path");
    expect(p.pageId).toBe("p1");
    expect(p.close).toBe(true);
    expect(p.dashed).toBe(true);
    expect(p.anchors.map((a) => a.anchor)).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    expect(p.anchors[0]!.left).toEqual([1, 1]);
    expect(p.anchors[2]!.right).toEqual([5, 5]);
  });

  it("an open subpath and a second one stay apart", () => {
    const out = previewPaths("p1", "M0 0 C1 0 2 0 3 0 M5 5 C6 5 7 5 8 5 Z");
    expect(out).toHaveLength(2);
    expect(out[0]!.close).toBe(false);
    expect(out[0]!.anchors).toHaveLength(2);
    expect(out[1]!.close).toBe(true);
  });
});
