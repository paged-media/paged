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

// ORACLE PROBE -- the four Pathfinder BOOLEANS.
//
//   bash scripts/illustrator/run-probe.sh \
//     scripts/illustrator/probes/pathfinder-boolean.jsx \
//     packages/draw-bundle/test/fixtures/oracle/pathfinder-boolean.illustrator.json
//
// The engine op under test is the wire mutation
// `pathfinderBoolean { kept, others, kind }` with kind
// "union" | "subtract" | "intersect" | "exclude"; the cases below are
// mirrored one for one by `PATHFINDER_BOOLEAN_CASES` in
// `packages/draw-bundle/test/oracle/pathfinder-boolean.spec.ts`.
//
// INPUT ORDER IS PAINT ORDER. `input.paths[0]` is created first and is the
// BACK object; `input.paths[1]` is created second and lies in FRONT of it.
// "subtract" is therefore back MINUS front -- the Pathfinder panel calls
// it Minus Front.
//
// HOW ILLUSTRATOR IS ASKED. The Pathfinder panel's buttons have no script
// entry point, but the same four operations exist as live effects on a
// GROUP (Effect > Pathfinder), and those menu items take no dialog:
//
//     group the inputs (DOM: groupItems.add + move)
//     app.executeMenuCommand("Live Pathfinder Add")        kind "union"
//                            "Live Pathfinder Subtract"         "subtract"
//                            "Live Pathfinder Intersect"        "intersect"
//                            "Live Pathfinder Exclude"          "exclude"
//     app.executeMenuCommand("expandStyle")   Object > Expand Appearance
//
// The command strings are Illustrator's own (its menu map gives
// "Effect-Pathfinder-Add" as "Live Pathfinder Add", and so on). Soft Mix
// and Trap are the only Pathfinder effects with a dialog; neither is used.
//
// Measured before this probe was written: Add / Subtract / Intersect leave
// one plain path; Exclude leaves TWO separate paths, not a compound path.

(function () {
  var COMMAND = {
    union: "Live Pathfinder Add",
    subtract: "Live Pathfinder Subtract",
    intersect: "Live Pathfinder Intersect",
    exclude: "Live Pathfinder Exclude"
  };
  var KINDS = ["union", "subtract", "intersect", "exclude"];

  // Two overlapping rectangles, points, engine frame (Y down), clockwise.
  //   A (back)  [100,100]-[200,180]  100 x 80 = 8000
  //   B (front) [150,140]-[260,220]  110 x 80 = 8800
  //   overlap   [150,140]-[200,180]   50 x 40 = 2000
  var RECT_A = PagedProbe.polygon(
    [
      [100, 100],
      [200, 100],
      [200, 180],
      [100, 180]
    ],
    true
  );
  var RECT_B = PagedProbe.polygon(
    [
      [150, 140],
      [260, 140],
      [260, 220],
      [150, 220]
    ],
    true
  );

  // A circle of radius 50 about (160,160) as the usual four cubics (handle
  // length 50 x 0.5522847498 = 27.614237), clockwise from its east point;
  // and a rectangle [150,130]-[260,190] that cuts through it. The circle is
  // given as explicit anchors so both sides start from the SAME curve.
  var K = 27.614237;
  var CIRCLE = {
    closed: true,
    anchors: [
      { anchor: [210, 160], left: [210, 160 - K], right: [210, 160 + K] },
      { anchor: [160, 210], left: [160 + K, 210], right: [160 - K, 210] },
      { anchor: [110, 160], left: [110, 160 + K], right: [110, 160 - K] },
      { anchor: [160, 110], left: [160 - K, 110], right: [160 + K, 110] }
    ]
  };
  var RECT_C = PagedProbe.polygon(
    [
      [150, 130],
      [260, 130],
      [260, 190],
      [150, 190]
    ],
    true
  );

  var cases = [];
  var k;
  for (k = 0; k < KINDS.length; k++) {
    cases.push({
      id: "rects-" + KINDS[k],
      input: { paths: [RECT_A, RECT_B] },
      parameters: { kind: KINDS[k] }
    });
  }
  for (k = 0; k < KINDS.length; k++) {
    cases.push({
      id: "circle-rect-" + KINDS[k],
      input: { paths: [CIRCLE, RECT_C] },
      parameters: { kind: KINDS[k] }
    });
  }

  return PagedProbe.run({
    probe: "pathfinder-boolean",
    operation:
      "inputs grouped back-to-front, then app.executeMenuCommand(" +
      '"Live Pathfinder Add" | "... Subtract" | "... Intersect" | "... Exclude") ' +
      'on the group, then app.executeMenuCommand("expandStyle")',
    cases: cases,
    apply: function (doc, items, parameters) {
      var group = PagedProbe.groupInPaintOrder(doc, items);
      PagedProbe.select(doc, [group]);
      app.executeMenuCommand(COMMAND[parameters.kind]);
      app.redraw();
      PagedProbe.select(doc, [group]);
      app.executeMenuCommand("expandStyle");
    }
  });
})();
