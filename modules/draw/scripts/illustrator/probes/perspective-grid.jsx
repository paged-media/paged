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

// ORACLE PROBE -- drawing on Illustrator's PERSPECTIVE GRID.
//
//   bash scripts/illustrator/run-probe.sh \
//     scripts/illustrator/probes/perspective-grid.jsx \
//     packages/draw-bundle/test/fixtures/oracle/perspective-grid.illustrator.json
//
// The thing under test on our side is draw-geometry's perspective grid
// (`src/warp/perspective-grid.ts`, `src/warp/homography.ts`): a plane of a
// two-point grid is a HOMOGRAPHY, its ground lines run to a vanishing
// point on one horizontal horizon shared by the left and right planes, and
// its verticals stay vertical. Replayed by
// `packages/draw-bundle/test/oracle/perspective-grid.spec.ts`.
//
// HOW ILLUSTRATOR IS ASKED. `PageItem.bringInPerspective` exists in the
// object model but answers PARM ('MRAP') for every plane and position in
// 30.1 -- recorded so nobody tries it again. What DOES work, and is the
// Perspective Grid's own drawing behaviour: with the grid SHOWN
// (`Document.showPerspectiveGrid`) and a plane ACTIVE
// (`Document.setPerspectiveActivePlane`), `pathItems.rectangle` and
// `pathItems.ellipse` draw ON that plane -- their arguments are taken as
// the plane's own coordinates and the item comes back projected. The
// document's default grid is used (the localized preset names are not
// stable to script: `selectPerspectivePreset("[2P-Normal View]")` is
// refused on a German install). Each case records its arguments verbatim
// (Illustrator's document coordinates, Y up) and the projected path.

(function () {
  var P = {
    left: PerspectiveGridPlaneType.LEFTPLANE,
    right: PerspectiveGridPlaneType.RIGHTPLANE,
    floor: PerspectiveGridPlaneType.FLOORPLANE
  };
  // [top, left, width, height] in Illustrator document coordinates.
  var RECTS = [
    [300, 400, 50, 30],
    [380, 420, 120, 40],
    [250, 330, 30, 90],
    [420, 300, 70, 70]
  ];
  var planes = ["right", "left", "floor"];
  var cases = [];
  var i, j, r;
  for (i = 0; i < planes.length; i++) {
    for (j = 0; j < RECTS.length; j++) {
      r = RECTS[j];
      cases.push({
        id: planes[i] + "-rect-" + j,
        input: { paths: [] },
        parameters: { plane: planes[i], shape: "rectangle", top: r[0], left: r[1], width: r[2], height: r[3] }
      });
    }
    cases.push({
      id: planes[i] + "-ellipse",
      input: { paths: [] },
      parameters: { plane: planes[i], shape: "ellipse", top: 360, left: 380, width: 80, height: 60 }
    });
  }

  return PagedProbe.run({
    probe: "perspective-grid",
    operation:
      "Document.showPerspectiveGrid(); Document.setPerspectiveActivePlane(plane); " +
      "pathItems.rectangle / pathItems.ellipse(top, left, width, height) -- drawn on the active plane",
    cases: cases,
    apply: function (doc, items, p) {
      doc.showPerspectiveGrid();
      doc.setPerspectiveActivePlane(P[p.plane]);
      if (p.shape === "rectangle") doc.pathItems.rectangle(p.top, p.left, p.width, p.height);
      else doc.pathItems.ellipse(p.top, p.left, p.width, p.height);
      if (doc.pathItems.length !== 1) {
        throw new Error("expected 1 path after drawing, found " + doc.pathItems.length);
      }
    }
  });
})();
