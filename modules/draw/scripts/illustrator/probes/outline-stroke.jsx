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

// ORACLE PROBE -- Outline Stroke.
//
//   bash scripts/illustrator/run-probe.sh \
//     scripts/illustrator/probes/outline-stroke.jsx \
//     packages/draw-bundle/test/fixtures/oracle/outline-stroke.illustrator.json
//
// The engine op under test is the wire mutation
// `outlineStroke { elementId, width, cap, join, miterLimit }`; the cases
// below are mirrored one for one by `OUTLINE_STROKE_CASES` in
// `packages/draw-bundle/test/oracle/outline-stroke.spec.ts`, and that spec
// FAILS when a recording and its table disagree. Change both together.
//
// HOW ILLUSTRATOR IS ASKED. The path is given a plain black stroke (width,
// cap, join, miter limit set on the PathItem itself; no fill, no dashes)
// and then Object > Path > Outline Stroke is run on the selection:
//
//     app.executeMenuCommand("OffsetPath v22")
//
// That string is not a typo: Illustrator's own menu map (Required/UXP/
// extensions/com.adobe.unifiedpanel) gives "Object-Path-Outline_Stroke" as
// "OffsetPath v22" and "Object-Path-Offset_Path" as "OffsetPath v23" (the
// latter opens a dialog and is NOT used). The command takes no parameters
// and shows no dialog. Measured before this probe was written: the live
// effect "Adobe Outline Stroke" + "expandStyle" returns the identical
// path, so either spelling would do; the menu command is the one a user
// reaches.
//
// The result is ONE plain closed PathItem, with no overlap in it.

(function () {
  var WIDTH = 20;
  var MITER_LIMIT = 4;

  // An OPEN 3-point path, in points, engine frame (origin top-left, Y
  // down). Both segments are 100 pt long (a 3-4-5 leg, then a horizontal),
  // so the centreline is 200 pt and width x length is 4000. The corner
  // turns by 53.13 deg (interior 126.87 deg, miter ratio 1.118).
  var BENT = [
    [100, 180],
    [160, 100],
    [260, 100]
  ];
  // A sharper corner for the miter limit: two 3-4-5 legs meeting at an
  // interior angle of 73.74 deg, miter ratio 1/sin(36.87 deg) = 1.6667.
  // Limits 1.5 and 2 straddle it.
  var SHARP = [
    [100, 180],
    [160, 100],
    [220, 180]
  ];

  var caps = ["butt", "round", "square"];
  var joins = ["miter", "round", "bevel"];
  var cases = [];
  var c, j;
  for (c = 0; c < caps.length; c++) {
    for (j = 0; j < joins.length; j++) {
      cases.push({
        id: caps[c] + "-" + joins[j],
        input: { paths: [PagedProbe.polygon(BENT, false)] },
        parameters: { width: WIDTH, cap: caps[c], join: joins[j], miterLimit: MITER_LIMIT }
      });
    }
  }
  cases.push({
    id: "sharp-butt-miter-limit1_5",
    input: { paths: [PagedProbe.polygon(SHARP, false)] },
    parameters: { width: WIDTH, cap: "butt", join: "miter", miterLimit: 1.5 }
  });
  cases.push({
    id: "sharp-butt-miter-limit2",
    input: { paths: [PagedProbe.polygon(SHARP, false)] },
    parameters: { width: WIDTH, cap: "butt", join: "miter", miterLimit: 2 }
  });

  return PagedProbe.run({
    probe: "outline-stroke",
    operation:
      "PathItem stroke set to {width, cap, join, miterLimit} (no fill), selected, " +
      'then app.executeMenuCommand("OffsetPath v22") = Object > Path > Outline Stroke',
    cases: cases,
    apply: function (doc, items, parameters) {
      PagedProbe.setStroke(items[0], parameters);
      PagedProbe.select(doc, items);
      app.executeMenuCommand("OffsetPath v22");
    }
  });
})();
