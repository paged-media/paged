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

// ORACLE PROBE -- BRUSHES: what Illustrator's own brushes make of a
// straight open path, expanded (engine ADR 1053, draw ADR 366).
//
//   bash tooling/oracle/illustrator/run-probe.sh \
//     tooling/oracle/illustrator/probes/brushes.jsx \
//     packages/draw-bundle/test/fixtures/oracle/brushes.illustrator.json
//
// HOW ILLUSTRATOR IS ASKED. Scripting has no door to make a brush or to
// read its type, its options or a width profile: `Brush` carries a name
// and `applyTo`. So the probe applies the brushes a new RGB document
// carries, by index, to a 1 pt stroke along a straight line of three
// lengths, and expands them (`expandStyle`). Index 5 of Illustrator
// 30.1's default document is an art brush (its name, in the app's
// language, is recorded per case); the default pattern and bristle
// brushes expand to raster images (Ledernaht, Katzenzunge), which say
// nothing about geometry, so they are not asked.
// Replayed by `packages/draw-bundle/test/oracle/brushes.spec.ts`: the
// constructions the replay holds the engine to are the ones these cases
// can show -- the artwork spans the whole path and follows its length.

(function () {
  var RUNS = [
    ["art-200", 5, 200],
    ["art-303", 5, 303],
    ["art-420", 5, 420]
  ];
  var cases = [];
  var i;
  for (i = 0; i < RUNS.length; i++) {
    cases.push({
      id: RUNS[i][0],
      input: {
        paths: [
          {
            closed: false,
            anchors: [
              { anchor: [50, 300], left: [50, 300], right: [50, 300] },
              {
                anchor: [50 + RUNS[i][2], 300],
                left: [50 + RUNS[i][2], 300],
                right: [50 + RUNS[i][2], 300]
              }
            ]
          }
        ]
      },
      parameters: { brushIndex: RUNS[i][1], length: RUNS[i][2], strokeWidth: 1 }
    });
  }

  return PagedProbe.run({
    probe: "brushes",
    operation:
      "document.brushes[i].applyTo(path) on a 1 pt stroke, then " +
      'app.executeMenuCommand("expandStyle")',
    cases: cases,
    apply: function (doc, items, p) {
      var brush = doc.brushes[p.brushIndex];
      p.brushName = String(brush.name);
      PagedProbe.setStroke(items[0], {
        width: p.strokeWidth,
        cap: "butt",
        join: "miter",
        miterLimit: 4
      });
      brush.applyTo(items[0]);
      app.redraw();
      PagedProbe.select(doc, items);
      app.executeMenuCommand("expandStyle");
    }
  });
})();
