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

// ORACLE PROBE -- LIVE SHAPES: where Illustrator puts a polygon's and a
// star's points, and what its scripting says about an ellipse's pie.
//
//   bash scripts/illustrator/run-probe.sh \
//     scripts/illustrator/probes/live-shapes.jsx \
//     packages/draw-bundle/test/fixtures/oracle/live-shapes.illustrator.json
//
// The thing under test on our side is the live polygon and star of
// engine ADR 1047 (`paged_model::live_shape`), which the Star tool makes
// from draw-geometry's `regularPolygonPath` + the star's points and inset
// (`starPath` is the same outline): the first point and the direction
// the points run in, and the inner radius a star's inset gives. Replayed
// by `packages/draw-bundle/test/oracle/live-shapes.spec.ts`.
//
// HOW ILLUSTRATOR IS ASKED. `PathItems.polygon(cx, cy, radius, sides)`
// and `PathItems.star(cx, cy, radius, innerRadius, points)` draw the shape
// about a centre in document coordinates (Y up), the way the tools draw
// it from a click. The pie angles of a live ellipse (Transform panel >
// Pie Start / Pie End) are NOT in Illustrator's scripting DOM: the probe
// records which of an ellipse's reflected properties name a pie or a
// live shape, so the replay states it from the recording, not from
// memory.

(function () {
  var CX = 200, CY = 200, R = 50;
  // [id, kind, sides/points, inner radius]
  var RUNS = [
    ["polygon-3", "polygon", 3, 0],
    ["polygon-5", "polygon", 5, 0],
    ["polygon-6", "polygon", 6, 0],
    ["star-5", "star", 5, 25],
    ["star-6", "star", 6, 20],
    ["ellipse", "ellipse", 0, 0]
  ];
  var cases = [];
  var i;
  for (i = 0; i < RUNS.length; i++) {
    cases.push({
      id: RUNS[i][0],
      input: { paths: [] },
      parameters: {
        kind: RUNS[i][1],
        centre: [CX, CY],
        radius: R,
        sides: RUNS[i][2],
        innerRadius: RUNS[i][3]
      }
    });
  }

  return PagedProbe.run({
    probe: "live-shapes",
    operation:
      "PathItems.polygon(cx, cy, r, sides); PathItems.star(cx, cy, r, ri, points); " +
      "PathItems.ellipse(top, left, w, h).reflect.properties",
    cases: cases,
    apply: function (doc, items, p) {
      // The artboard's top-left is the engine frame's origin (Y flips).
      var ab = doc.artboards[0].artboardRect;
      var c = [ab[0] + p.centre[0], ab[1] - p.centre[1]];
      var item, props, k, name, found;
      if (p.kind === "polygon") {
        doc.pathItems.polygon(c[0], c[1], p.radius, p.sides, false);
      } else if (p.kind === "star") {
        doc.pathItems.star(c[0], c[1], p.radius, p.innerRadius, p.sides, false);
      } else {
        item = doc.pathItems.ellipse(c[1] + p.radius, c[0] - p.radius, 2 * p.radius, 2 * p.radius);
        props = item.reflect.properties;
        found = [];
        for (k = 0; k < props.length; k++) {
          name = String(props[k].name);
          if (/pie|live|shape|angle/i.test(name)) found.push(name);
        }
        p.reflected_shape_properties = found;
        p.reflected_property_count = props.length;
      }
    }
  });
})();
