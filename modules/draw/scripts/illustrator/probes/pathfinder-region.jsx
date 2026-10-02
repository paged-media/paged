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

// ORACLE PROBE -- the six Pathfinder REGION verbs.
//
//   bash scripts/illustrator/run-probe.sh \
//     scripts/illustrator/probes/pathfinder-region.jsx \
//     packages/draw-bundle/test/fixtures/oracle/pathfinder-region.illustrator.json
//
// The engine ops under test are the wire mutations `pathfinderDivide`,
// `pathfinderTrim`, `pathfinderMerge`, `pathfinderCrop`,
// `pathfinderOutline` and `pathfinderMinusBack`, each `{ elementIds }` with
// the ids TOP TO BOTTOM. The cases below are mirrored one for one by
// `PATHFINDER_REGION_CASES` in
// `packages/draw-bundle/test/oracle/pathfinder-region.spec.ts`.
//
// INPUT ORDER IS PAINT ORDER. `input.paths[0]` is created first and is the
// BACK object; `input.paths[1]` lies in FRONT of it. So the engine's
// `elementIds` for a case is its inputs REVERSED.
//
// FILL MATTERS HERE, which it did not for the booleans: Merge unites pieces
// of the SAME fill, Divide and Trim hand each piece the fill of whatever
// was on top there, Crop keeps the lower object's fill. Inputs carry an
// explicit `fill` and every measured path records `filled`, `stroked` and
// its RGB `fill`.
//
// HOW ILLUSTRATOR IS ASKED. Exactly as for the booleans -- the inputs are
// grouped back to front, one of
//
//     "Live Pathfinder Divide"      "Live Pathfinder Crop"
//     "Live Pathfinder Trim"        "Live Pathfinder Outline"
//     "Live Pathfinder Merge"       "Live Pathfinder Minus Back"
//
// is run on the group with `app.executeMenuCommand` (Effect > Pathfinder;
// none of the six has a dialog), and `expandStyle` turns the appearance
// into geometry.

(function () {
  var COMMAND = {
    pathfinderDivide: "Live Pathfinder Divide",
    pathfinderTrim: "Live Pathfinder Trim",
    pathfinderMerge: "Live Pathfinder Merge",
    pathfinderCrop: "Live Pathfinder Crop",
    pathfinderOutline: "Live Pathfinder Outline",
    pathfinderMinusBack: "Live Pathfinder Minus Back"
  };
  var VERBS = [
    { name: "divide", verb: "pathfinderDivide" },
    { name: "trim", verb: "pathfinderTrim" },
    { name: "merge", verb: "pathfinderMerge" },
    { name: "crop", verb: "pathfinderCrop" },
    { name: "outline", verb: "pathfinderOutline" },
    { name: "minus-back", verb: "pathfinderMinusBack" }
  ];
  var RED = [255, 0, 0];
  var BLUE = [0, 0, 255];

  function filled(spec, fill) {
    return { closed: spec.closed, anchors: spec.anchors, fill: fill };
  }

  // The booleans' two rectangles, points, engine frame (Y down), clockwise.
  //   A (back)  [100,100]-[200,180]  8000
  //   B (front) [150,140]-[260,220]  8800      overlap 50 x 40 = 2000
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
  // The booleans' circle (radius 50 about (160,160), four cubics) and the
  // rectangle [150,130]-[260,190] in front of it.
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
  var v;
  for (v = 0; v < VERBS.length; v++) {
    cases.push({
      id: "rects-" + VERBS[v].name,
      input: { paths: [filled(RECT_A, RED), filled(RECT_B, BLUE)] },
      parameters: { verb: VERBS[v].verb }
    });
  }
  // Merge is the one verb whose answer depends on the fills being EQUAL.
  cases.push({
    id: "rects-merge-same-fill",
    input: { paths: [filled(RECT_A, RED), filled(RECT_B, RED)] },
    parameters: { verb: "pathfinderMerge" }
  });
  // Curves: do the pieces keep their cubics, and which side is "back"?
  cases.push({
    id: "circle-rect-divide",
    input: { paths: [filled(CIRCLE, RED), filled(RECT_C, BLUE)] },
    parameters: { verb: "pathfinderDivide" }
  });
  cases.push({
    id: "circle-rect-minus-back",
    input: { paths: [filled(CIRCLE, RED), filled(RECT_C, BLUE)] },
    parameters: { verb: "pathfinderMinusBack" }
  });

  return PagedProbe.run({
    probe: "pathfinder-region",
    operation:
      "inputs grouped back-to-front, then app.executeMenuCommand(" +
      '"Live Pathfinder Divide" | "... Trim" | "... Merge" | "... Crop" | "... Outline" | ' +
      '"... Minus Back") on the group, then app.executeMenuCommand("expandStyle")',
    cases: cases,
    apply: function (doc, items, parameters) {
      var group = PagedProbe.groupInPaintOrder(doc, items);
      PagedProbe.select(doc, [group]);
      app.executeMenuCommand(COMMAND[parameters.verb]);
      app.redraw();
      PagedProbe.select(doc, [group]);
      app.executeMenuCommand("expandStyle");
    }
  });
})();
