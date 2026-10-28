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

// ORACLE PROBE -- Pathfinder Divide over MANY overlapping shapes.
//
//   bash scripts/illustrator/run-probe.sh \
//     scripts/illustrator/probes/divide-many.jsx \
//     packages/draw-bundle/test/fixtures/oracle/divide-many.illustrator.json
//
// The engine op under test is `pathfinderDivide { elementIds }` over 20,
// 50 and 100 inputs -- the planar arrangement of engine ADR 1019, which
// replaced the 12-input / 256-face kernel. Replayed by
// `packages/draw-bundle/test/oracle/divide-many.spec.ts` (through the
// headless engine) and by `paged-mutate`'s `divide_many_oracle` test (the
// kernel alone, against a summary of this recording).
//
// THE INPUTS are generated here, deterministically, and recorded with the
// answer (`input.paths`), so neither replay regenerates them: a
// Park-Miller generator (x = 16807 x mod 2^31-1; exact in doubles) draws
// axis-aligned rectangles and four-cubic circles inside 40..440 pt, every
// coordinate a multiple of 1/4 pt. Each input carries its own RGB fill so
// the replay can see which input every piece came from: Divide paints a
// piece with the fill of the FRONTMOST input covering it.
//
// HOW ILLUSTRATOR IS ASKED. As `pathfinder-region.jsx`: the inputs are
// grouped back to front, "Live Pathfinder Divide" runs on the group, and
// `expandStyle` turns the appearance into geometry.

(function () {
  var seed = 20261025;
  function next() {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  }
  function q(v) {
    return Math.round(v * 4) / 4;
  }
  var K = 0.5522847498;

  function shape(i) {
    var x = q(40 + next() * 340);
    var y = q(40 + next() * 340);
    // Distinct fills: the input index, spread over the three channels.
    var fill = [(i * 37) % 256, (i * 91 + 64) % 256, (i * 53 + 128) % 256];
    if (i % 2 === 0) {
      var w = q(20 + next() * 80);
      var h = q(20 + next() * 80);
      var r = PagedProbe.polygon(
        [
          [x, y],
          [x + w, y],
          [x + w, y + h],
          [x, y + h]
        ],
        true
      );
      r.fill = fill;
      return r;
    }
    var rad = q(12 + next() * 40);
    var cx = x + rad;
    var cy = y + rad;
    var k = q(rad * K);
    return {
      closed: true,
      fill: fill,
      anchors: [
        { anchor: [cx + rad, cy], left: [cx + rad, cy - k], right: [cx + rad, cy + k] },
        { anchor: [cx, cy + rad], left: [cx + k, cy + rad], right: [cx - k, cy + rad] },
        { anchor: [cx - rad, cy], left: [cx - rad, cy + k], right: [cx - rad, cy - k] },
        { anchor: [cx, cy - rad], left: [cx - k, cy - rad], right: [cx + k, cy - rad] }
      ]
    };
  }

  var cases = [];
  var counts = [20, 50, 100];
  var c, i, paths;
  for (c = 0; c < counts.length; c++) {
    paths = [];
    for (i = 0; i < counts[c]; i++) paths.push(shape(i));
    cases.push({
      id: "divide-" + counts[c],
      input: { paths: paths },
      parameters: { verb: "pathfinderDivide" }
    });
  }

  return PagedProbe.run({
    probe: "divide-many",
    operation:
      'inputs grouped back-to-front, then app.executeMenuCommand("Live Pathfinder Divide") ' +
      'on the group, then app.executeMenuCommand("expandStyle")',
    cases: cases,
    apply: function (doc, items) {
      var group = PagedProbe.groupInPaintOrder(doc, items);
      PagedProbe.select(doc, [group]);
      app.executeMenuCommand("Live Pathfinder Divide");
      app.redraw();
      PagedProbe.select(doc, [group]);
      app.executeMenuCommand("expandStyle");
    }
  });
})();
