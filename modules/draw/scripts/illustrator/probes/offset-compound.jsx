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

// ORACLE PROBE -- Offset Path of COMPOUND paths and of OPEN paths.
//
//   bash scripts/illustrator/run-probe.sh \
//     scripts/illustrator/probes/offset-compound.jsx \
//     packages/draw-bundle/test/fixtures/oracle/offset-compound.illustrator.json
//
// The engine op under test is `offsetPath { elementId, delta, join,
// miterLimit, side? }` (engine ADR 1019). The cases are mirrored by
// `OFFSET_COMPOUND_CASES` in
// `packages/draw-bundle/test/oracle/offset-compound.spec.ts`.
//
// THE QUESTIONS.
//   * A compound path with a hole: does the hole move the OTHER way (an
//     outset shrinks it, an inset grows it), vanish when it shrinks past
//     nothing, and does an island inside the hole move like an outer
//     contour?
//   * Two outer contours that grow into each other: one merged path?
//   * An OPEN path: what does Offset Path make of it? The engine's
//     two-sided answer is the closed band of width 2|delta|; the engine's
//     ONE-sided offset (`side: "left" | "right"`) has no Illustrator
//     counterpart, so the replay checks that it runs along the band's
//     boundary instead.
//
// HOW ILLUSTRATOR IS ASKED. Exactly as `offset-path.jsx` (the live effect
// "Adobe Offset Path" + `expandStyle`), applied to a COMPOUND path made
// from the case's inputs with `executeMenuCommand("compoundPath")` when
// there is more than one input. Make Compound Path re-winds the contours
// by paint order (see `compound-path.jsx`), so every case lists its
// contours outer first.

(function () {
  var JNTP_ROUND = 0;
  var JNTP_BEVEL = 1;
  var JNTP_MITER = 2;
  var MITER_LIMIT = 4;

  function rect(l, t, r, b) {
    return PagedProbe.polygon(
      [
        [l, t],
        [r, t],
        [r, b],
        [l, b]
      ],
      true
    );
  }

  // Points, engine frame (origin top-left, Y down).
  //   RING   [100,100]-[300,300] with the hole [170,170]-[230,230]
  //   ISLAND [190,190]-[210,210] inside that hole
  //   PAIR   [100,100]-[180,180] and [200,100]-[280,180], 20 apart
  var OUTER = rect(100, 100, 300, 300);
  var HOLE = rect(170, 170, 230, 230);
  var ISLAND = rect(190, 190, 210, 210);
  var LEFT = rect(100, 100, 180, 180);
  var RIGHT = rect(200, 100, 280, 180);
  // An open L: right along the top, then down -- and an open S-curve.
  var L_OPEN = PagedProbe.polygon(
    [
      [100, 100],
      [300, 100],
      [300, 250]
    ],
    false
  );
  var CURVE_OPEN = {
    closed: false,
    anchors: [
      { anchor: [100, 300], left: [100, 300], right: [160, 200] },
      { anchor: [300, 300], left: [240, 400], right: [300, 300] }
    ]
  };

  var cases = [];
  var joins = ["miter", "round", "bevel"];
  var j;
  for (j = 0; j < joins.length; j++) {
    cases.push({
      id: "ring-" + joins[j] + "-out",
      input: { paths: [OUTER, HOLE] },
      parameters: { delta: 10, join: joins[j], miterLimit: MITER_LIMIT }
    });
    cases.push({
      id: "ring-" + joins[j] + "-in",
      input: { paths: [OUTER, HOLE] },
      parameters: { delta: -10, join: joins[j], miterLimit: MITER_LIMIT }
    });
  }
  cases.push({
    id: "ring-hole-vanishes",
    input: { paths: [OUTER, HOLE] },
    parameters: { delta: 35, join: "miter", miterLimit: MITER_LIMIT }
  });
  cases.push({
    id: "ring-island-out",
    input: { paths: [OUTER, HOLE, ISLAND] },
    parameters: { delta: 4, join: "miter", miterLimit: MITER_LIMIT }
  });
  cases.push({
    id: "ring-island-in",
    input: { paths: [OUTER, HOLE, ISLAND] },
    parameters: { delta: -4, join: "miter", miterLimit: MITER_LIMIT }
  });
  cases.push({
    id: "pair-merge-out",
    input: { paths: [LEFT, RIGHT] },
    parameters: { delta: 15, join: "miter", miterLimit: MITER_LIMIT }
  });
  for (j = 0; j < joins.length; j++) {
    cases.push({
      id: "open-l-" + joins[j],
      input: { paths: [L_OPEN] },
      parameters: { delta: 10, join: joins[j], miterLimit: MITER_LIMIT }
    });
  }
  cases.push({
    id: "open-curve-round",
    input: { paths: [CURVE_OPEN] },
    parameters: { delta: 10, join: "round", miterLimit: MITER_LIMIT }
  });

  function jntpOf(join) {
    if (join === "round") return JNTP_ROUND;
    if (join === "bevel") return JNTP_BEVEL;
    if (join === "miter") return JNTP_MITER;
    throw new Error("unknown join: " + join);
  }

  return PagedProbe.run({
    probe: "offset-compound",
    operation:
      'inputs made one compound path (app.executeMenuCommand("compoundPath")) when ' +
      'there are several, then PageItem.applyEffect(<LiveEffect name="Adobe Offset Path"> ' +
      'with Dict "R mlim <miterLimit> R ofst <delta> I jntp <0 round | 1 bevel | 2 miter>") ' +
      'then app.executeMenuCommand("expandStyle")',
    cases: cases,
    apply: function (doc, items, parameters) {
      var target = items[0];
      if (items.length > 1) {
        PagedProbe.select(doc, items);
        app.executeMenuCommand("compoundPath");
        if (doc.compoundPathItems.length !== 1) {
          throw new Error("Make Compound Path left " + doc.compoundPathItems.length + " compound paths");
        }
        target = doc.compoundPathItems[0];
      }
      var xml =
        '<LiveEffect name="Adobe Offset Path"><Dict data="R mlim ' +
        parameters.miterLimit +
        " R ofst " +
        parameters.delta +
        " I jntp " +
        jntpOf(parameters.join) +
        ' "/></LiveEffect>';
      PagedProbe.select(doc, [target]);
      target.applyEffect(xml);
      app.redraw();
      PagedProbe.select(doc, [target]);
      app.executeMenuCommand("expandStyle");
    }
  });
})();
