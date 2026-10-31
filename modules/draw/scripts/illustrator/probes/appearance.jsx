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

// ORACLE PROBE -- an object with several fills and strokes (Illustrator's
// appearance), for the engine's native appearance (engine ADR 1043).
//
//   PAGED_PROBE_OUT=../../engine/core/crates/paged-renderer/tests/fixtures/illustrator/appearance \
//   bash scripts/illustrator/run-probe.sh \
//     scripts/illustrator/probes/appearance.jsx \
//     ../../engine/core/crates/paged-renderer/tests/fixtures/illustrator/appearance/appearance.illustrator.json
//
// Each case builds the appearance on the FRONT input path (input.paths[0]
// is a grey backdrop where a case blends) with the Appearance panel's own
// commands -- `Adobe New Fill Shortcut` / `Adobe New Stroke Shortcut` add a
// fill or stroke ABOVE the targeted one and target it -- and the DOM's
// fillColor / strokeColor / strokeWidth, which write the TARGETED fill or
// stroke. Steps that name `opacity` or `blend` write the item's opacity
// and blending mode right after a layer was added; whether Illustrator
// applies them to that layer or to the object is what Expand Appearance
// answers. The case then
//
//   1. exports the artboard as `<case>.png` (PNG-24, 72 ppi, anti-aliased,
//      no transparency) into PAGED_PROBE_OUT -- the pixels the replay
//      compares the engine's CPU raster with;
//   2. runs Object > Expand Appearance (`expandStyle`) on the item and
//      records what the appearance WAS, part by part, back to front: each
//      part's paint (the library's measure) and, in `parameters.parts`,
//      its opacity and blending mode.
//
// INPUT ORDER IS PAINT ORDER: input.paths[0] is the back object.

(function () {
  var OUT = "__PAGED_PDF_PROBE_OUT__";

  function rgb(t) {
    var c = new RGBColor();
    c.red = t[0];
    c.green = t[1];
    c.blue = t[2];
    return c;
  }
  function rect(l, t, r, b, fill) {
    var s = PagedProbe.polygon(
      [
        [l, t],
        [r, t],
        [r, b],
        [l, b]
      ],
      true
    );
    s.fill = fill;
    return s;
  }
  var BLENDS = {
    Normal: BlendModes.NORMAL,
    Multiply: BlendModes.MULTIPLY,
    Screen: BlendModes.SCREEN,
    Overlay: BlendModes.OVERLAY,
    Darken: BlendModes.DARKEN,
    Lighten: BlendModes.LIGHTEN,
    Difference: BlendModes.DIFFERENCE
  };
  function blendName(b) {
    var k;
    for (k in BLENDS) {
      if (BLENDS.hasOwnProperty(k) && BLENDS[k] === b) return k;
    }
    return String(b);
  }

  var SQUARE = rect(200, 200, 300, 300, [255, 255, 0]);
  var BACKDROP = rect(150, 150, 350, 250, [128, 128, 128]);

  // A step: { add: "fill" | "stroke", color, width?, opacity?, blend? }
  // or { object: true, opacity?, blend? } for the object's own
  // transparency. The square starts as a yellow fill, no stroke.
  var CASES = [
    {
      id: "two-fills",
      steps: [{ add: "fill", color: [0, 0, 255] }]
    },
    {
      id: "fill-multiply",
      backdrop: true,
      steps: [{ add: "fill", color: [255, 0, 0], blend: "Multiply" }]
    },
    {
      id: "fill-opacity",
      steps: [{ add: "fill", color: [255, 0, 0], opacity: 50 }]
    },
    {
      id: "three-fills",
      backdrop: true,
      steps: [
        { add: "fill", color: [255, 0, 0], opacity: 50 },
        { add: "fill", color: [0, 0, 255], blend: "Screen" }
      ]
    },
    {
      id: "two-strokes",
      steps: [
        { add: "stroke", color: [0, 0, 0], width: 16 },
        { add: "stroke", color: [0, 0, 255], width: 6 }
      ]
    },
    {
      id: "strokes-blend",
      backdrop: true,
      steps: [
        { add: "stroke", color: [255, 0, 0], width: 20 },
        { add: "stroke", color: [0, 0, 255], width: 8, blend: "Multiply" },
        { add: "fill", color: [0, 255, 0], opacity: 40 }
      ]
    },
    {
      id: "object-opacity",
      backdrop: true,
      steps: [
        { add: "fill", color: [0, 0, 255] },
        { add: "stroke", color: [255, 0, 0], width: 10 },
        { object: true, opacity: 50, blend: "Multiply" }
      ]
    }
  ];

  function applyStep(doc, item, step) {
    if (step.object) {
      PagedProbe.select(doc, [item]);
      if (step.opacity !== undefined) item.opacity = step.opacity;
      if (step.blend) item.blendingMode = BLENDS[step.blend];
      return;
    }
    PagedProbe.select(doc, [item]);
    if (step.add === "fill") {
      app.executeMenuCommand("Adobe New Fill Shortcut");
      item = doc.selection[0];
      item.filled = true;
      item.fillColor = rgb(step.color);
    } else {
      app.executeMenuCommand("Adobe New Stroke Shortcut");
      item = doc.selection[0];
      item.stroked = true;
      item.strokeColor = rgb(step.color);
      item.strokeWidth = step.width;
    }
    if (step.opacity !== undefined) item.opacity = step.opacity;
    if (step.blend) item.blendingMode = BLENDS[step.blend];
  }

  function partsOf(doc) {
    var out = [];
    function walk(items) {
      var i, it, p;
      for (i = items.length - 1; i >= 0; i--) {
        it = items[i];
        if (it.typename === "GroupItem") {
          out.push({ group: true, opacity: it.opacity, blend: blendName(it.blendingMode) });
          walk(it.pageItems);
          continue;
        }
        p = { type: it.typename, opacity: it.opacity, blend: blendName(it.blendingMode) };
        if (it.typename === "PathItem") {
          p.filled = it.filled;
          p.stroked = it.stroked;
          if (it.stroked) p.strokeWidth = it.strokeWidth;
        }
        out.push(p);
      }
    }
    walk(doc.pageItems);
    return out;
  }

  var spec = {
    probe: "appearance",
    operation:
      "an object's several fills and strokes (Appearance > Add New Fill / Add New Stroke), " +
      "exported as PNG-24 at 72 ppi, then Object > Expand Appearance (expandStyle)",
    cases: [],
    apply: function (doc, items, parameters, theCase) {
      var item = items[items.length - 1];
      var i, f, o;
      for (i = 0; i < parameters.steps.length; i++) {
        applyStep(doc, item, parameters.steps[i]);
        item = doc.selection.length > 0 ? doc.selection[0] : item;
      }
      PagedProbe.select(doc, []);
      f = new File(OUT + "/" + theCase.id + ".png");
      o = new ExportOptionsPNG24();
      o.antiAliasing = true;
      o.artBoardClipping = true;
      o.transparency = false;
      o.horizontalScale = 100;
      o.verticalScale = 100;
      doc.exportFile(f, ExportType.PNG24, o);
      parameters.png = theCase.id + ".png";
      PagedProbe.select(doc, [item]);
      app.executeMenuCommand("expandStyle");
      parameters.parts = partsOf(doc);
    }
  };
  var i, c;
  for (i = 0; i < CASES.length; i++) {
    c = CASES[i];
    spec.cases.push({
      id: c.id,
      input: { paths: c.backdrop ? [BACKDROP, SQUARE] : [SQUARE] },
      parameters: { steps: c.steps }
    });
  }
  return PagedProbe.run(spec);
})();
