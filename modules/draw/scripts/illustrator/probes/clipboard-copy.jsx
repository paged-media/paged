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

// ORACLE PROBE -- Compound Path > Make, and what it does to WINDING.
//
// ORACLE PROBE -- Edit > Copy, and what Illustrator puts on the clipboard.
//
//   bash scripts/illustrator/run-clipboard-probe.sh \
//     ../../apps/editor/apps/canvas/test/fixtures/clipboard
//
// The thing under test on our side is the editor's vector clipboard
// (apps/editor ADR 289): a paste of what Illustrator copied must land as
// native page items with the geometry Illustrator drew. This probe draws
// two filled paths on a scratch artboard, selects both and runs
// `app.copy()`; the runner then reads the macOS pasteboard (every type
// and its size, the SVG text and the PDF) and records them beside the
// geometry this probe measured.
//
// ONE case only: the pasteboard holds what the LAST case copied.

(function () {
  var cases = [
    {
      id: "rect-and-triangle",
      input: {
        paths: [
          // Back: a red rectangle [100,100]-[300,200].
          (function () {
            var p = PagedProbe.polygon(
              [
                [100, 100],
                [300, 100],
                [300, 200],
                [100, 200]
              ],
              true
            );
            p.fill = [255, 0, 0];
            return p;
          })(),
          // Front: a blue triangle under it.
          (function () {
            var p = PagedProbe.polygon(
              [
                [150, 250],
                [250, 250],
                [200, 330]
              ],
              true
            );
            p.fill = [0, 0, 255];
            return p;
          })()
        ]
      },
      parameters: {},
      allowUnchanged: true
    }
  ];

  return PagedProbe.run({
    probe: "clipboard-copy",
    operation: "both inputs selected, then app.copy() = Edit > Copy",
    cases: cases,
    apply: function (doc, items) {
      PagedProbe.select(doc, items);
      app.copy();
    }
  });
})();
