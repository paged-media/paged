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
//   bash scripts/illustrator/run-probe.sh \
//     scripts/illustrator/probes/compound-path.jsx \
//     packages/draw-bundle/test/fixtures/oracle/compound-path.illustrator.json
//
// The thing under test on our side is the bundle's Make Compound Path
// command (`media.paged.draw.command.makeCompoundPath`), which merges the
// selected paths into one path with several contours and RE-WINDS them by
// nesting depth, because the engine fills non-zero. The cases below are
// mirrored one for one by `COMPOUND_PATH_CASES` in
// `packages/draw-bundle/test/oracle/compound-path.spec.ts`.
//
// THE QUESTION. A compound path is "the inner shape is a hole". Under a
// non-zero fill that is only true if the inner contour runs the other way.
// So: when the inputs are wound the SAME way, does Illustrator reverse
// one, switch the fill rule to even-odd, or paint a solid shape? And what
// does it do to two shapes that merely OVERLAP?
//
// HOW ILLUSTRATOR IS ASKED. All inputs are selected and
//
//     app.executeMenuCommand("compoundPath")   Object > Compound Path > Make
//
// is run; it has no dialog. Every measured subpath records its direction
// (`winding`, `polarity`, Illustrator's signed `area`) and its fill rule
// (`evenodd`), and carries `compound`: the index of its CompoundPathItem.
//
// INPUT ORDER IS PAINT ORDER: `input.paths[0]` is the back object.

(function () {
  function rect(l, t, r, b, clockwise) {
    var pts = clockwise
      ? [
          [l, t],
          [r, t],
          [r, b],
          [l, b]
        ]
      : [
          [l, t],
          [l, b],
          [r, b],
          [r, t]
        ];
    return PagedProbe.polygon(pts, true);
  }
  var CW = true;
  var CCW = false;

  // Points, engine frame (origin top-left, Y down).
  //   OUTER  [100,100]-[300,300]  40000
  //   HOLE   [150,150]-[250,250]  10000   strictly inside OUTER
  //   ISLAND [180,180]-[220,220]   1600   strictly inside HOLE
  function outer(dir) {
    return rect(100, 100, 300, 300, dir);
  }
  function hole(dir) {
    return rect(150, 150, 250, 250, dir);
  }
  function island(dir) {
    return rect(180, 180, 220, 220, dir);
  }
  //   CORE   [190,190]-[210,210]    400   strictly inside ISLAND
  function core(dir) {
    return rect(190, 190, 210, 210, dir);
  }

  var cases = [
    { id: "nested-cw-cw", input: { paths: [outer(CW), hole(CW)] }, parameters: {} },
    { id: "nested-cw-ccw", input: { paths: [outer(CW), hole(CCW)] }, parameters: {} },
    { id: "nested-ccw-ccw", input: { paths: [outer(CCW), hole(CCW)] }, parameters: {} },
    // The hole created FIRST (behind the outer shape): does paint order matter?
    { id: "nested-hole-behind-cw-cw", input: { paths: [hole(CW), outer(CW)] }, parameters: {} },
    {
      id: "three-deep-cw-cw-cw",
      input: { paths: [outer(CW), hole(CW), island(CW)] },
      parameters: {}
    },
    // One level deeper: where non-zero and even-odd part company.
    {
      id: "four-deep-cw-cw-cw-cw",
      input: { paths: [outer(CW), hole(CW), island(CW), core(CW)] },
      parameters: {}
    },
    {
      id: "disjoint-cw-ccw",
      input: { paths: [rect(100, 100, 180, 180, CW), rect(220, 100, 300, 180, CCW)] },
      parameters: {}
    },
    // Not nested, merely overlapping: [100,100]-[200,180] and
    // [150,140]-[260,220], overlap 50 x 40 = 2000.
    {
      id: "overlap-cw-cw",
      input: { paths: [rect(100, 100, 200, 180, CW), rect(150, 140, 260, 220, CW)] },
      parameters: {}
    },
    {
      id: "overlap-cw-ccw",
      input: { paths: [rect(100, 100, 200, 180, CW), rect(150, 140, 260, 220, CCW)] },
      parameters: {}
    }
  ];

  var i;
  for (i = 0; i < cases.length; i++) cases[i].allowUnchanged = true;

  return PagedProbe.run({
    probe: "compound-path",
    operation:
      'all inputs selected, then app.executeMenuCommand("compoundPath") = ' +
      "Object > Compound Path > Make",
    cases: cases,
    apply: function (doc, items) {
      PagedProbe.select(doc, items);
      app.executeMenuCommand("compoundPath");
      // Make may leave every anchor where it was, so the library's
      // "the result is the input" guard is switched off for these cases
      // (`allowUnchanged`) and replaced by the fact that matters: there
      // is now exactly one compound path.
      if (doc.compoundPathItems.length !== 1) {
        throw new Error(
          "expected 1 compound path after Make, found " + doc.compoundPathItems.length
        );
      }
    }
  });
})();
