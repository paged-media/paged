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

// ORACLE PROBE -- ENVELOPE DISTORT, Make with Top Object (draw ADR 367).
//
//   bash scripts/illustrator/run-probe.sh \
//     scripts/illustrator/probes/envelope.jsx \
//     packages/draw-bundle/test/fixtures/oracle/envelope.illustrator.json
//
// Each case selects the inputs -- the CONTENTS first (back), the envelope
// SHAPE last (front) -- and runs Object > Envelope Distort > Make with
// Top Object (`Make Envelope`), then Object > Envelope Distort > Expand
// (`Expand Envelope`), and records the expanded contents. Replayed by
// `packages/draw-bundle/test/oracle/envelope.spec.ts` against
// draw-geometry's `outlinePatch` / `restrictPatch` / `envelopePoint` (the
// engine's envelope map).
//
// Make with Warp (`Make Warp`) and Make with Mesh (`Create Envelope
// Grid`) open their options dialog, which `executeMenuCommand` cannot fill
// in; they are not asked (README: a command that opens a dialog leaves it
// open).

(function () {
  var K = 0.5522847498 * 100;
  var square = PagedProbe.polygon(
    [
      [100, 100],
      [300, 100],
      [300, 300],
      [100, 300]
    ],
    true
  );
  var trapezoid = PagedProbe.polygon(
    [
      [100, 100],
      [300, 100],
      [260, 300],
      [140, 300]
    ],
    true
  );
  var circle = {
    closed: true,
    anchors: [
      { anchor: [200, 100], left: [200 - K, 100], right: [200 + K, 100] },
      { anchor: [300, 200], left: [300, 200 - K], right: [300, 200 + K] },
      { anchor: [200, 300], left: [200 + K, 300], right: [200 - K, 300] },
      { anchor: [100, 200], left: [100, 200 + K], right: [100, 200 - K] }
    ]
  };
  // A box whose top edge is one cubic bowing up and down.
  var wave = {
    closed: true,
    anchors: [
      { anchor: [100, 100], left: [100, 100], right: [166, 60] },
      { anchor: [300, 100], left: [233, 140], right: [300, 100] },
      { anchor: [300, 300], left: [300, 300], right: [300, 300] },
      { anchor: [100, 300], left: [100, 300], right: [100, 300] }
    ]
  };
  var quarterA = PagedProbe.polygon(
    [
      [100, 100],
      [200, 100],
      [200, 200],
      [100, 200]
    ],
    true
  );
  var quarterB = PagedProbe.polygon(
    [
      [200, 200],
      [300, 200],
      [300, 300],
      [200, 300]
    ],
    true
  );
  var cases = [
    { id: "top-trapezoid", input: { paths: [square, trapezoid] }, parameters: { contents: 1 } },
    { id: "top-circle", input: { paths: [square, circle] }, parameters: { contents: 1 } },
    { id: "top-wave", input: { paths: [square, wave] }, parameters: { contents: 1 } },
    {
      id: "two-contents-trapezoid",
      input: { paths: [quarterA, quarterB, trapezoid] },
      parameters: { contents: 2 }
    }
  ];

  return PagedProbe.run({
    probe: "envelope",
    operation:
      "select contents + front shape; executeMenuCommand('Make Envelope'); " +
      "executeMenuCommand('Expand Envelope')",
    cases: cases,
    apply: function (doc, items, p) {
      PagedProbe.select(doc, items);
      app.executeMenuCommand("Make Envelope");
      app.executeMenuCommand("Expand Envelope");
      p.paths_after = doc.pathItems.length;
    }
  });
})();
