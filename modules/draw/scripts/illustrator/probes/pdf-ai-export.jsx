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

// ORACLE PROBE -- what Illustrator writes into a PDF and an .ai file, and
// what its own document model says the artwork is.
//
//   bash scripts/illustrator/run-probe.sh \
//     scripts/illustrator/probes/pdf-ai-export.jsx \
//     ../publish/crates/pdf-import/tests/fixtures/illustrator/pdf-ai-export.illustrator.json
//
// The thing under test is publish's place-as-vectors reader (publish ADR
// 658): it reads the PDF Illustrator writes -- into a .pdf, and into the
// PDF-compatible part of an .ai -- back into paths, paints, clips and text.
// Each case draws one kind of artwork, saves the scratch document as
// `<case>.pdf` (Acrobat 7, not editable in Illustrator) and as `<case>.ai`
// (PDF compatible, compressed; one case WITHOUT PDF compatibility), and
// records Illustrator's own model of what it drew: every path's anchors,
// fill, stroke and fill rule (the library's measure), and, in the case's
// `parameters.illustrator`, what the library does not measure -- stroke
// caps, joins and dashes, gradient stops, opacity, blend mode, clipping,
// text. The files go to PAGED_PDF_PROBE_OUT (the runner substitutes the
// directory for __PAGED_PDF_PROBE_OUT__ below); the replay
// (`crates/pdf-import/tests/illustrator_oracle.rs`) reads them with the
// reader and compares.
//
// INPUT ORDER IS PAINT ORDER: `input.paths[0]` is the back object.

(function () {
  var OUT = "__PAGED_PDF_PROBE_OUT__";

  function rgbColor(t) {
    var c = new RGBColor();
    c.red = t[0];
    c.green = t[1];
    c.blue = t[2];
    return c;
  }
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
  // A circle of four cubics, kappa 0.5523, engine frame.
  function circle(cx, cy, r) {
    var k = 0.5523 * r;
    return {
      closed: true,
      anchors: [
        { anchor: [cx + r, cy], left: [cx + r, cy - k], right: [cx + r, cy + k] },
        { anchor: [cx, cy + r], left: [cx + k, cy + r], right: [cx - k, cy + r] },
        { anchor: [cx - r, cy], left: [cx - r, cy + k], right: [cx - r, cy - k] },
        { anchor: [cx, cy - r], left: [cx - k, cy - r], right: [cx + k, cy - r] }
      ]
    };
  }
  function withFill(spec, fill) {
    spec.fill = fill;
    return spec;
  }

  function capName(c) {
    if (c === StrokeCap.ROUNDENDCAP) return "round";
    if (c === StrokeCap.PROJECTINGENDCAP) return "square";
    return "butt";
  }
  function joinName(j) {
    if (j === StrokeJoin.ROUNDENDJOIN) return "round";
    if (j === StrokeJoin.BEVELENDJOIN) return "bevel";
    return "miter";
  }
  function colorOf(c) {
    if (c.typename === "RGBColor") return [c.red, c.green, c.blue];
    if (c.typename === "GradientColor") {
      var stops = [];
      var i, s;
      for (i = 0; i < c.gradient.gradientStops.length; i++) {
        s = c.gradient.gradientStops[i];
        stops.push({
          rampPoint: s.rampPoint,
          midPoint: s.midPoint,
          color: s.color.typename === "RGBColor" ? [s.color.red, s.color.green, s.color.blue] : null
        });
      }
      return {
        gradient: c.gradient.type === GradientType.RADIAL ? "radial" : "linear",
        angle: c.angle,
        length: c.length,
        origin: [c.origin[0], c.origin[1]],
        stops: stops
      };
    }
    return c.typename;
  }

  /** What the library's measure leaves out, for every path, back to
   *  front within each container, in the order collectPaths walks. */
  function paintOf(doc) {
    var out = [];
    function walk(items, clippedBy) {
      var i, it, j;
      for (i = 0; i < items.length; i++) {
        it = items[i];
        if (it.typename === "PathItem") {
          out.push(describe(it, clippedBy));
        } else if (it.typename === "CompoundPathItem") {
          for (j = 0; j < it.pathItems.length; j++) out.push(describe(it.pathItems[j], clippedBy));
        } else if (it.typename === "GroupItem") {
          walk(it.pageItems, it.clipped ? clippedBy + 1 : clippedBy);
        }
      }
    }
    function describe(p, clippedBy) {
      var d = {
        clipping: p.clipping,
        clippedBy: clippedBy,
        opacity: p.opacity,
        blend: String(p.blendingMode)
      };
      if (p.filled && !p.clipping) d.fill = colorOf(p.fillColor);
      if (p.stroked && !p.clipping) {
        d.stroke = colorOf(p.strokeColor);
        d.strokeWidth = p.strokeWidth;
        d.cap = capName(p.strokeCap);
        d.join = joinName(p.strokeJoin);
        d.miterLimit = p.strokeMiterLimit;
        d.dashes = [];
        for (var k = 0; k < p.strokeDashes.length; k++) d.dashes.push(p.strokeDashes[k]);
      }
      return d;
    }
    var l;
    for (l = 0; l < doc.layers.length; l++) walk(doc.layers[l].pageItems, 0);
    return out;
  }

  function save(doc, id, pdfCompatible) {
    var pdf = new PDFSaveOptions();
    pdf.compatibility = PDFCompatibility.ACROBAT7;
    pdf.preserveEditability = false;
    pdf.generateThumbnails = false;
    pdf.viewAfterSaving = false;
    doc.saveAs(new File(OUT + "/" + id + ".pdf"), pdf);
    var ai = new IllustratorSaveOptions();
    ai.pdfCompatible = pdfCompatible;
    ai.compressed = true;
    ai.embedICCProfile = false;
    ai.embedLinkedFiles = false;
    doc.saveAs(new File(OUT + "/" + id + ".ai"), ai);
  }

  // The text case sets Roboto (Apache License 2.0): the saved files embed a
  // subset of it, and they are committed.
  var cases = [
    {
      id: "fills-strokes",
      input: {
        paths: [
          withFill(rect(60, 60, 260, 160), [220, 30, 40]),
          withFill(circle(400, 120, 60), [20, 160, 80]),
          PagedProbe.polygon(
            [
              [80, 260],
              [200, 220],
              [320, 300],
              [460, 240]
            ],
            false
          )
        ]
      },
      parameters: { stroke: { index: 2, width: 6, cap: "round", join: "round", dashes: [12, 6] } }
    },
    {
      id: "compound-evenodd",
      input: { paths: [withFill(rect(100, 100, 300, 300), [40, 40, 200]), rect(150, 150, 250, 250)] },
      parameters: { compound: true, evenodd: true }
    },
    {
      id: "clip-group",
      input: {
        paths: [
          withFill(rect(100, 100, 260, 200), [250, 180, 0]),
          withFill(rect(180, 160, 340, 300), [0, 120, 200]),
          circle(220, 200, 80)
        ]
      },
      parameters: { clip: true }
    },
    {
      id: "linear-gradient",
      input: { paths: [rect(80, 80, 380, 230)] },
      parameters: { gradient: "linear", from: [255, 0, 0], to: [0, 0, 255], rotate: 30 }
    },
    {
      id: "radial-gradient",
      input: { paths: [circle(250, 250, 120)] },
      parameters: { gradient: "radial", from: [255, 255, 255], to: [0, 90, 40] }
    },
    {
      id: "opacity-blend",
      input: {
        paths: [withFill(rect(80, 80, 280, 280), [250, 200, 0]), withFill(rect(180, 180, 380, 380), [0, 100, 255])]
      },
      parameters: { opacity: 50, blend: "multiply" }
    },
    {
      id: "text",
      input: { paths: [withFill(rect(40, 40, 560, 200), [240, 240, 240])] },
      parameters: { text: "Hello PDF import", font: "Roboto-Regular", size: 36 }
    },
    {
      id: "no-pdf-content",
      input: { paths: [withFill(rect(100, 100, 300, 200), [10, 10, 10])] },
      parameters: { pdfCompatible: false }
    }
  ];

  var i;
  for (i = 0; i < cases.length; i++) cases[i].allowUnchanged = true;

  return PagedProbe.run({
    probe: "pdf-ai-export",
    operation:
      "the artwork drawn, then doc.saveAs(<case>.pdf, PDFSaveOptions Acrobat 7) and " +
      "doc.saveAs(<case>.ai, IllustratorSaveOptions pdfCompatible)",
    cases: cases,
    apply: function (doc, items, parameters, theCase) {
      var p = parameters;
      var s, g, gc, group, cp, j, tf;
      if (p.stroke) {
        s = p.stroke;
        PagedProbe.setStroke(items[s.index], { width: s.width, cap: s.cap, join: s.join, miterLimit: 4 });
        items[s.index].strokeColor = rgbColor([20, 60, 200]);
        items[s.index].strokeDashes = s.dashes;
      }
      if (p.compound) {
        cp = doc.compoundPathItems.add();
        for (j = items.length - 1; j >= 0; j--) items[j].move(cp, ElementPlacement.PLACEATEND);
        for (j = 0; j < cp.pathItems.length; j++) {
          cp.pathItems[j].evenodd = p.evenodd;
          cp.pathItems[j].fillColor = rgbColor([40, 40, 200]);
        }
      }
      if (p.clip) {
        group = PagedProbe.groupInPaintOrder(doc, items);
        items[items.length - 1].clipping = true;
        group.clipped = true;
      }
      if (p.gradient) {
        g = doc.gradients.add();
        g.type = p.gradient === "radial" ? GradientType.RADIAL : GradientType.LINEAR;
        g.gradientStops[0].color = rgbColor(p.from);
        g.gradientStops[1].color = rgbColor(p.to);
        gc = new GradientColor();
        gc.gradient = g;
        items[0].filled = true;
        items[0].fillColor = gc;
        if (p.rotate) items[0].rotate(p.rotate, false, false, true, false);
      }
      if (p.opacity) {
        items[1].opacity = p.opacity;
        items[1].blendingMode = BlendModes.MULTIPLY;
      }
      if (p.text) {
        tf = doc.textFrames.add();
        tf.contents = p.text;
        tf.textRange.characterAttributes.textFont = app.textFonts.getByName(p.font);
        tf.textRange.characterAttributes.size = p.size;
        tf.textRange.characterAttributes.fillColor = rgbColor([30, 30, 30]);
        tf.left = doc.artboards[0].artboardRect[0] + 60;
        tf.top = doc.artboards[0].artboardRect[1] - 80;
      }
      p.illustrator = { paint: paintOf(doc) };
      if (tf) {
        p.illustrator.text = {
          contents: tf.contents,
          font: tf.textRange.characterAttributes.textFont.name,
          family: tf.textRange.characterAttributes.textFont.family,
          size: tf.textRange.characterAttributes.size,
          // Engine frame: left, top of the frame's bounds.
          left: tf.geometricBounds[0] - doc.artboards[0].artboardRect[0],
          top: doc.artboards[0].artboardRect[1] - tf.geometricBounds[1]
        };
      }
      save(doc, theCase.id, p.pdfCompatible !== false);
      // The library measures paths only: a text frame goes once saved.
      if (tf) tf.remove();
      p.files = { pdf: theCase.id + ".pdf", ai: theCase.id + ".ai" };
    }
  });
})();
