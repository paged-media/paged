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

// ORACLE PROBE -- EPS import (engine paged-ps, engine ADR 1016).
//
//   bash scripts/illustrator/run-probe.sh \
//     scripts/illustrator/probes/eps-import.jsx \
//     ../../engine/core/crates/paged-ps/tests/fixtures/eps-import.illustrator.json
//
// Each case is a small EPS program. Illustrator places it, embeds it
// (Embed turns a placed EPS into Illustrator's own paths: Illustrator
// interprets the PostScript) and the resulting paths are measured. The
// engine's replay (`crates/paged-ps/tests/it/oracle.rs`) runs the same
// programs through paged-ps and compares the filled and stroked paths'
// bounds and colours. The programs are mirrored one for one by
// `CASES` there; change both together.
//
// The placed EPS is positioned with its bounding box's top-left corner at
// the artboard's, so the recorded (engine-frame) coordinates are the
// EPS's image space: x from the box's left, y down from its top.
//
// ASCII only (the runner refuses anything else).

(function () {
  var HEAD = "%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 200 100\n%%EndComments\n";
  var cases = [
    {
      id: "rgb-rect",
      ps: "1 0 0 setrgbcolor 10 10 80 30 rectfill"
    },
    {
      id: "cmyk-triangle",
      ps: "0 1 1 0 setcmykcolor newpath 20 20 moveto 120 20 lineto 70 90 lineto closepath fill"
    },
    {
      id: "circle-arc",
      ps: "0 0 1 setrgbcolor newpath 100 50 40 0 360 arc closepath fill"
    },
    {
      id: "evenodd-ring",
      ps: "0 setgray newpath 20 10 160 80 rectfill 1 setgray newpath 30 20 moveto 170 20 lineto 170 80 lineto 30 80 lineto closepath 60 35 moveto 140 35 lineto 140 65 lineto 60 65 lineto closepath eofill"
    },
    {
      id: "transformed-curve",
      ps: "0 0.5 0 setrgbcolor gsave 100 50 translate 30 rotate 2 1 scale newpath -20 -10 moveto 0 30 20 -30 40 10 curveto closepath fill grestore"
    },
    {
      id: "stroked-line",
      ps: "0 0 0 setrgbcolor 4 setlinewidth newpath 20 20 moveto 180 80 lineto stroke"
    }
  ];
  var i;
  for (i = 0; i < cases.length; i++) {
    cases[i].input = { paths: [] };
    cases[i].parameters = { eps: HEAD + cases[i].ps + "\nshowpage\n%%EOF\n" };
  }

  return PagedProbe.run({
    probe: "eps-import",
    operation:
      "the EPS written to Folder.temp, doc.placedItems.add() with .file set, positioned at the " +
      "artboard's top-left, then placed.embed() (Illustrator interprets the PostScript)",
    cases: cases,
    apply: function (doc, items, parameters, theCase) {
      var f = new File(Folder.temp + "/paged-eps-probe-" + theCase.id + ".eps");
      f.encoding = "BINARY";
      f.lineFeed = "Unix";
      if (!f.open("w")) throw new Error("cannot write " + f.fsName);
      f.write(parameters.eps);
      f.close();
      try {
        var placed = doc.placedItems.add();
        placed.file = f;
        var ab = doc.artboards[0].artboardRect;
        placed.position = [ab[0], ab[1]];
        placed.embed();
      } finally {
        f.remove();
      }
    }
  });
})();
