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

// `host.viewport.goToPage` fits the page to the viewport once its layout
// holds still (plugin-pages.ts `settledViewportSize`): a slide show's Esc
// brings the chrome back while the page is being fitted, and a size read
// mid-way fitted the slide to the whole window or to a strip of the canvas.
// No frames run here (no requestAnimationFrame), so the timer stands in.

import { describe, expect, test } from "bun:test";

import { settledViewportSize } from "../../../src/plugin-pages";

/** A size that answers `sizes` in turn, one per read, then the last. */
function reads(...sizes: [number, number][]) {
  let i = 0;
  return () => sizes[Math.min(i++, sizes.length - 1)]!;
}

describe("settledViewportSize", () => {
  test("waits out a layout that is still moving and answers where it stops", async () => {
    const peek = reads([1280, 680], [544, 93], [544, 424], [544, 424]);
    expect(await settledViewportSize(peek, 2000)).toEqual([544, 424]);
  });

  test("a size that holds answers at once, after the first frames", async () => {
    const t0 = Date.now();
    expect(await settledViewportSize(() => [800, 600], 2000)).toEqual([
      800, 600,
    ]);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("a layout that never holds answers its last size once the time is up", async () => {
    let w = 400;
    const peek = (): [number, number] => [(w += 10), 300];
    const size = await settledViewportSize(peek, 120);
    expect(size[1]).toBe(300);
    expect(size[0]).toBe(w);
  });

  test("an unmeasured (hidden) canvas is not a settled size", async () => {
    const t0 = Date.now();
    expect(await settledViewportSize(() => [0, 0], 120)).toEqual([0, 0]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(120);
  });
});
