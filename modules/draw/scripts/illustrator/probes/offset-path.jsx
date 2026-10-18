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

// ORACLE PROBE -- Offset Path.
//
//   bash scripts/illustrator/run-probe.sh \
//     scripts/illustrator/probes/offset-path.jsx \
//     packages/draw-bundle/test/fixtures/oracle/offset-path.illustrator.json
//
// The engine op under test is the wire mutation
// `offsetPath { elementId, delta, join, miterLimit }`; the cases below
// are mirrored one for one by `OFFSET_PATH_CASES` in
// `packages/draw-bundle/test/oracle/offset-path.spec.ts`, and that spec
// FAILS when a recording and its table disagree. Change both together.
//
// HOW ILLUSTRATOR IS ASKED. Offset Path exists three times in
// Illustrator and only one of them takes parameters from a script:
//
//   Object > Path > Offset Path...  a menu command that opens a dialog;
//                                  `executeMenuCommand` cannot pass it the
//                                  offset, so it is unusable with
//                                  DONTDISPLAYALERTS. (The shortcut table
//                                  lists "OffsetPath v22" and "OffsetPath
//                                  v23"; published command lists give v23
//                                  as this one and v22 as Outline Stroke.
//                                  Not verified here.)
//   Effect > Path > Offset Path...  menu command "Live Offset Path" -- the
//                                  same dialog, same problem.
//   the LIVE EFFECT itself         `PageItem.applyEffect(xml)` with the
//                                  effect named "Adobe Offset Path" and
//                                  its parameters in a <Dict>, then
//                                  `executeMenuCommand("expandStyle")`
//                                  (Object > Expand Appearance) to turn
//                                  the appearance into real geometry.
//
// The third is what this probe does. Where each fact comes from:
//   * the effect name "Adobe Offset Path" and its three dictionary keys
//     `ofst` / `jntp` / `mlim` are strings in the app's own plug-in
//     (Required/Plug-ins/Illustrator Filters/OffsetPath.aip);
//   * the menu command strings are entries in the app's own keyboard-
//     shortcut table (Presets/<locale>/.../*.kys);
//   * `applyEffect`, `executeMenuCommand`, `PathItem.area`, `.polarity`,
//     `.pathPoints[i].anchor/leftDirection/rightDirection` are in the
//     ExtendScript object model (Scripting Dictionaries CC/.../omv.xml).
//
// CONFIRMED BY THE FIRST RUN (Illustrator 30.1.0, 2026-10-02):
//   1. the `jntp` enumeration is 0 = round, 1 = bevel, 2 = miter. It is in
//      no dictionary on disk; the recording settled it (the cases asked
//      for a miter measure a miter's area, and so on), and the replay
//      spec re-checks it against the closed form on every run.
//   2. `ofst` is in points; positive is outward whatever the path's
//      direction (see the two `rectccw` cases).
//   3. `expandStyle` leaves ONE plain PathItem -- no group, no copy of
//      the source path.
//
// Beyond the 12 base cases, two families answer a question each:
//   * `rectccw-*`: the rectangle drawn the OTHER way round. Is the
//     result's direction kept, reversed, or normalised?
//   * `tri-miter-out-limit*`: the triangle's sharpest corner has a miter
//     ratio of 1/sin(36.87 deg / 2) = 3.1623. Limits 3.1 and 3.2 straddle
//     it; limit 2 also catches the 53.13 deg corner (ratio 2.2361).

(function () {
  var JNTP_ROUND = 0;
  var JNTP_BEVEL = 1;
  var JNTP_MITER = 2;

  // Illustrator's own default in the Offset Path dialog, and the engine
  // bundle's DEFAULT_MITER_LIMIT.
  var MITER_LIMIT = 4;

  // Inputs, in points, engine frame (origin top-left, Y down). Both are
  // drawn clockwise on a Y-down page.
  //
  // RECT: 100 x 60. Area 6000, perimeter 320.
  var RECT = [
    [100, 100],
    [200, 100],
    [200, 160],
    [100, 160]
  ];
  // TRI: a 3-4-5 right triangle (legs 120 and 90, hypotenuse 150). Area
  // 5400, perimeter 360, inradius 30. Its sharpest corner is 36.87 deg,
  // whose miter ratio 1/sin(18.43 deg) = 3.16 is UNDER the limit of 4 -- so
  // under the stroke definition of a miter limit this case is not clipped.
  var TRI = [
    [100, 100],
    [220, 100],
    [100, 190]
  ];

  function offsetCases() {
    var shapes = [
      { name: "rect", points: RECT },
      { name: "tri", points: TRI }
    ];
    var joins = ["miter", "round", "bevel"];
    var deltas = [
      { name: "out", value: 10 },
      { name: "in", value: -10 }
    ];
    var cases = [];
    var s, j, d;
    for (s = 0; s < shapes.length; s++) {
      for (j = 0; j < joins.length; j++) {
        for (d = 0; d < deltas.length; d++) {
          cases.push({
            id: shapes[s].name + "-" + joins[j] + "-" + deltas[d].name,
            input: { paths: [PagedProbe.polygon(shapes[s].points, true)] },
            parameters: {
              delta: deltas[d].value,
              join: joins[j],
              miterLimit: MITER_LIMIT
            }
          });
        }
      }
    }
    // Direction: the same rectangle, counter-clockwise.
    var rectCcw = [RECT[0], RECT[3], RECT[2], RECT[1]];
    for (d = 0; d < deltas.length; d++) {
      cases.push({
        id: "rectccw-miter-" + deltas[d].name,
        input: { paths: [PagedProbe.polygon(rectCcw, true)] },
        parameters: { delta: deltas[d].value, join: "miter", miterLimit: MITER_LIMIT }
      });
    }
    // Miter-limit semantics.
    var limits = [
      { name: "2", value: 2 },
      { name: "3_1", value: 3.1 },
      { name: "3_2", value: 3.2 }
    ];
    for (d = 0; d < limits.length; d++) {
      cases.push({
        id: "tri-miter-out-limit" + limits[d].name,
        input: { paths: [PagedProbe.polygon(TRI, true)] },
        parameters: { delta: 10, join: "miter", miterLimit: limits[d].value }
      });
    }
    return cases;
  }

  function jntpOf(join) {
    if (join === "round") return JNTP_ROUND;
    if (join === "bevel") return JNTP_BEVEL;
    if (join === "miter") return JNTP_MITER;
    throw new Error("unknown join: " + join);
  }

  return PagedProbe.run({
    probe: "offset-path",
    operation:
      'PageItem.applyEffect(<LiveEffect name="Adobe Offset Path"> with Dict ' +
      '"R mlim <miterLimit> R ofst <delta> I jntp <0 round | 1 bevel | 2 miter>") ' +
      'then app.executeMenuCommand("expandStyle")',
    cases: offsetCases(),
    apply: function (doc, items, parameters) {
      var xml =
        '<LiveEffect name="Adobe Offset Path"><Dict data="R mlim ' +
        parameters.miterLimit +
        " R ofst " +
        parameters.delta +
        " I jntp " +
        jntpOf(parameters.join) +
        ' "/></LiveEffect>';
      PagedProbe.select(doc, items);
      items[0].applyEffect(xml);
      app.redraw();
      // Expand Appearance acts on the SELECTION.
      PagedProbe.select(doc, items);
      app.executeMenuCommand("expandStyle");
    }
  });
})();
