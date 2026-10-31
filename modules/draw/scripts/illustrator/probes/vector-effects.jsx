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

// ORACLE PROBE -- live vector effects (engine ADR 1042).
//
//   bash scripts/illustrator/run-probe.sh \
//     scripts/illustrator/probes/vector-effects.jsx \
//     ../../engine/core/crates/paged-vector-fx/tests/fixtures/vector-effects.illustrator.json
//
// The engine code under test is `paged-vector-fx`; its replay test
// (`tests/illustrator_oracle.rs`) reads the fixture and runs every case's
// effect on the case's input with the case's parameters.
//
// HOW ILLUSTRATOR IS ASKED. Every case applies ONE live effect with
// `PageItem.applyEffect(<LiveEffect name="..."><Dict data="..."/>)` and
// expands it with `executeMenuCommand("expandStyle")`, the way the
// offset-path probe does. The effect names and their dictionary keys are
// strings in the app's own plug-ins:
//
//   Adobe Zigzag          ZigZag.aip    amount relAmount ridges roundness absoluteness
//   Adobe Punk and Bloat  Punk.aip      d_factor
//   Adobe Twirl           TwirlTool.aip angle
//   Adobe Round Corners   Round.aip     radius
//   Adobe Free Distort    Distort.aip   src0h..src3v dst0h..dst3v
//   Adobe Deform          Deform.aip    DeformStyle DeformValue DeformHoriz DeformVert Rotate
//   Adobe Roughen         Roughen.aip   size asiz dtal smth absoluteness
//   Adobe Transform       Transform.aip scaleH_Percent scaleV_Percent moveH_Pts moveV_Pts
//                                       rotate_Degrees numCopies reflectX reflectY pinPoint
//   Adobe Scribble and Tweak  Scribble.aip  horz vert ahor aver anch in out
//
// Their value types (R real, I integer, B boolean) and units are in no
// dictionary on disk; the recording settles them, and the replay states
// each one it relies on.

(function () {
  var K = 0.5522847498;
  var RECT = [
    [100, 100],
    [200, 100],
    [200, 160],
    [100, 160]
  ];
  var TRI = [
    [100, 100],
    [220, 100],
    [100, 190]
  ];
  // A circle of radius 40 about (150, 130), four cubic anchors, clockwise
  // on a Y-down page (top, right, bottom, left).
  function circle(cx, cy, r) {
    var k = r * K;
    return {
      closed: true,
      anchors: [
        { anchor: [cx, cy - r], left: [cx - k, cy - r], right: [cx + k, cy - r] },
        { anchor: [cx + r, cy], left: [cx + r, cy - k], right: [cx + r, cy + k] },
        { anchor: [cx, cy + r], left: [cx + k, cy + r], right: [cx - k, cy + r] },
        { anchor: [cx - r, cy], left: [cx - r, cy + k], right: [cx - r, cy - k] }
      ]
    };
  }

  function rect() {
    return PagedProbe.polygon(RECT, true);
  }
  function tri() {
    return PagedProbe.polygon(TRI, true);
  }

  var WARP_STYLES = [
    "arc",
    "arcLower",
    "arcUpper",
    "arch",
    "bulge",
    "shellLower",
    "shellUpper",
    "flag",
    "wave",
    "fish",
    "rise",
    "fisheye",
    "inflate",
    "squeeze",
    "twist"
  ];

  function cases() {
    var out = [];
    var i;
    // Zig Zag: absolute size 10 pt, 4 ridges per segment.
    out.push({
      id: "zigzag-rect-corner",
      input: { paths: [rect()] },
      parameters: { effect: "zigZag", size: 10, ridges: 4, smooth: false },
      effect: "Adobe Zigzag",
      dict: "R amount 10 R relAmount 10 R ridges 4 R roundness 0 R absoluteness 1"
    });
    out.push({
      id: "zigzag-rect-smooth",
      input: { paths: [rect()] },
      parameters: { effect: "zigZag", size: 10, ridges: 4, smooth: true },
      effect: "Adobe Zigzag",
      dict: "R amount 10 R relAmount 10 R ridges 4 R roundness 1 R absoluteness 1"
    });
    out.push({
      id: "zigzag-tri-corner",
      input: { paths: [tri()] },
      parameters: { effect: "zigZag", size: 6, ridges: 3, smooth: false },
      effect: "Adobe Zigzag",
      dict: "R amount 6 R relAmount 6 R ridges 3 R roundness 0 R absoluteness 1"
    });
    // Pucker & Bloat.
    out.push({
      id: "bloat-50-rect",
      input: { paths: [rect()] },
      parameters: { effect: "puckerBloat", amountPct: 50 },
      effect: "Adobe Punk and Bloat",
      dict: "R d_factor 0.5"
    });
    out.push({
      id: "pucker-50-rect",
      input: { paths: [rect()] },
      parameters: { effect: "puckerBloat", amountPct: -50 },
      effect: "Adobe Punk and Bloat",
      dict: "R d_factor -0.5"
    });
    out.push({
      id: "bloat-30-circle",
      input: { paths: [circle(150, 130, 40)] },
      parameters: { effect: "puckerBloat", amountPct: 30 },
      effect: "Adobe Punk and Bloat",
      dict: "R d_factor 0.3"
    });
    out.push({
      id: "pucker-30-tri",
      input: { paths: [tri()] },
      parameters: { effect: "puckerBloat", amountPct: -30 },
      effect: "Adobe Punk and Bloat",
      dict: "R d_factor -0.3"
    });
    // Twist.
    out.push({
      id: "twist-45-rect",
      input: { paths: [rect()] },
      parameters: { effect: "twist", angleDeg: 45 },
      effect: "Adobe Twirl",
      dict: "R angle 45"
    });
    out.push({
      id: "twist-90-tri",
      input: { paths: [tri()] },
      parameters: { effect: "twist", angleDeg: 90 },
      effect: "Adobe Twirl",
      dict: "R angle 90"
    });
    // Round Corners.
    out.push({
      id: "round-10-rect",
      input: { paths: [rect()] },
      parameters: { effect: "roundCorners", radius: 10 },
      effect: "Adobe Round Corners",
      dict: "R radius 10"
    });
    out.push({
      id: "round-15-tri",
      input: { paths: [tri()] },
      parameters: { effect: "roundCorners", radius: 15 },
      effect: "Adobe Round Corners",
      dict: "R radius 15"
    });
    // Offset path (the dedicated probe has the full matrix; one case here
    // keeps the effect's replay in the same file).
    out.push({
      id: "offset-8-tri-round",
      input: { paths: [tri()] },
      parameters: { effect: "offsetPath", offset: 8, join: "round", miterLimit: 4 },
      effect: "Adobe Offset Path",
      dict: "R mlim 4 R ofst 8 I jntp 0"
    });
    // Free Distort: the bounding box's corners (Illustrator's document
    // frame, Y up) to moved corners. Filled in by `apply`.
    out.push({
      id: "freedistort-rect",
      input: { paths: [rect()] },
      parameters: {
        effect: "freeDistort",
        // engine frame: top-left, top-right, bottom-right, bottom-left
        corners: [
          [90, 95],
          [215, 100],
          [205, 170],
          [100, 160]
        ]
      },
      effect: "Adobe Free Distort",
      dict: "freedistort"
    });
    // Warp: every style, horizontal, bend 50 %.
    for (i = 0; i < WARP_STYLES.length; i++) {
      out.push({
        id: "warp-" + WARP_STYLES[i] + "-h50",
        input: { paths: [rect()] },
        parameters: {
          effect: "warp",
          style: WARP_STYLES[i],
          horizontal: true,
          bendPct: 50,
          distortHPct: 0,
          distortVPct: 0
        },
        effect: "Adobe Deform",
        dict:
          "I DeformStyle " +
          (i + 1) +
          " R DeformValue 0.5 R DeformHoriz 0 R DeformVert 0 I Rotate 0"
      });
    }
    out.push({
      id: "warp-arc-v30",
      input: { paths: [rect()] },
      parameters: {
        effect: "warp",
        style: "arc",
        horizontal: false,
        bendPct: 30,
        distortHPct: 0,
        distortVPct: 0
      },
      effect: "Adobe Deform",
      dict: "I DeformStyle 1 R DeformValue 0.3 R DeformHoriz 0 R DeformVert 0 I Rotate 1"
    });
    out.push({
      id: "warp-bulge-h40-dh20",
      input: { paths: [rect()] },
      parameters: {
        effect: "warp",
        style: "bulge",
        horizontal: true,
        bendPct: 40,
        distortHPct: 20,
        distortVPct: 0
      },
      effect: "Adobe Deform",
      dict: "I DeformStyle 5 R DeformValue 0.4 R DeformHoriz 0.2 R DeformVert 0 I Rotate 0"
    });
    // Transform (copies).
    out.push({
      id: "transform-copies-rect",
      input: { paths: [rect()] },
      parameters: {
        effect: "transformCopies",
        scaleHPct: 50,
        scaleVPct: 50,
        moveH: 20,
        moveV: 10,
        rotateDeg: 30,
        copies: 2
      },
      effect: "Adobe Transform",
      dict:
        "R scaleH_Percent 50 R scaleV_Percent 50 R scaleH_Factor 0.5 R scaleV_Factor 0.5 " +
        "R moveH_Pts 20 R moveV_Pts 10 R rotate_Degrees 30 R rotate_Radians 0.5235987756 " +
        "I numCopies 2 B reflectX 0 B reflectY 0 I pinPoint 4 B randomize 0 " +
        "B transformObjects 1 B transformPatterns 1 B scaleLines 0"
    });
    // Roughen (random: recorded twice, compared statistically).
    out.push({
      id: "roughen-rect-corner-a",
      input: { paths: [rect()] },
      parameters: { effect: "roughen", size: 5, absolute: true, detailPerInch: 10, smooth: false },
      effect: "Adobe Roughen",
      dict: "R asiz 5 R size 5 R dtal 10 I smth 0 R absoluteness 1"
    });
    out.push({
      id: "roughen-rect-corner-b",
      input: { paths: [rect()] },
      parameters: { effect: "roughen", size: 5, absolute: true, detailPerInch: 10, smooth: false },
      effect: "Adobe Roughen",
      dict: "R asiz 5 R size 5 R dtal 10 I smth 0 R absoluteness 1"
    });
    out.push({
      id: "roughen-circle-smooth",
      input: { paths: [circle(150, 130, 40)] },
      parameters: { effect: "roughen", size: 4, absolute: true, detailPerInch: 20, smooth: true },
      effect: "Adobe Roughen",
      dict: "R asiz 4 R size 4 R dtal 20 I smth 1 R absoluteness 1"
    });
    // Tweak (random).
    out.push({
      id: "tweak-rect",
      input: { paths: [rect()] },
      parameters: {
        effect: "tweak",
        horizontal: 10,
        vertical: 10,
        absolute: true,
        anchors: true,
        inHandles: true,
        outHandles: true
      },
      effect: "Adobe Scribble and Tweak",
      dict: "R horz 10 R vert 10 R ahor 10 R aver 10 B anch 1 B in 1 B out 1 I absoluteness 1"
    });
    return out;
  }

  function freeDistortDict(doc, item, corners) {
    // Illustrator's frame: the input's bounds, Y up. src0 is taken as the
    // top-left corner, then clockwise -- settled by the recording.
    var gb = item.geometricBounds; // [left, top, right, bottom], Y up
    var src = [
      [gb[0], gb[1]],
      [gb[2], gb[1]],
      [gb[2], gb[3]],
      [gb[0], gb[3]]
    ];
    var s = "";
    var i, d;
    for (i = 0; i < 4; i++) {
      s += "R src" + i + "h " + src[i][0] + " R src" + i + "v " + src[i][1] + " ";
    }
    for (i = 0; i < 4; i++) {
      d = [corners[i][0], corners[i][1]];
      // engine frame -> Illustrator's, through the same origin the
      // library uses (the input's own corners map back exactly).
      d = [gb[0] + (d[0] - 100), gb[1] - (d[1] - 100)];
      s += "R dst" + i + "h " + d[0] + " R dst" + i + "v " + d[1] + " ";
    }
    return s;
  }

  return PagedProbe.run({
    probe: "vector-effects",
    operation:
      'PageItem.applyEffect(<LiveEffect name="<effect>"><Dict data="<dict>"/>) ' +
      'then app.executeMenuCommand("expandStyle"); each case names its effect and dict',
    cases: cases(),
    apply: function (doc, items, parameters, theCase) {
      var dict = theCase.dict;
      if (dict === "freedistort") dict = freeDistortDict(doc, items[0], parameters.corners);
      theCase.parameters.illustratorEffect = theCase.effect;
      theCase.parameters.illustratorDict = dict;
      var xml =
        '<LiveEffect name="' + theCase.effect + '"><Dict data="' + dict + ' "/></LiveEffect>';
      PagedProbe.select(doc, items);
      items[0].applyEffect(xml);
      app.redraw();
      PagedProbe.select(doc, items);
      app.executeMenuCommand("expandStyle");
    }
  });
})();
