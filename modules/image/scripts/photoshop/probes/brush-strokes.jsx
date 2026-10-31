// Photoshop's own DAB PLACEMENT and DAB PROFILE: the Brush tool strokes a
// straight work path (Stroke Path, simulate pressure off) on a white
// 128 x 128 16-bit document, painting black, with every dynamics pane
// off, opacity and flow 100 %, Normal, smoothing 0. Photoshop cannot
// replay a pointer stroke from a script, but Stroke Path with a brush is
// its own dab planner and its own tip rasteriser, which is what the
// engine's spacing walk and tip falloff are compared against
// (image-js/tests/it/brush_photoshop.rs).
//
// Cases:
//   round-*      a computed round tip: hardness 0/50/100 as a SINGLE dab
//                (spacing 1000 % on a 10 px path, so only the first dab
//                lands), one at a half-pixel anchor (the sub-pixel
//                convention), spacing 10/25/100/200 % along a line, and
//                angle/roundness ellipses (30 deg / 40 %, -60 deg / 25 %).
//   tip-source   the asymmetric artwork (a right triangle plus a square)
//                a SAMPLED tip is defined from (Define Brush Preset on the
//                whole document; Photoshop crops to the artwork).
//   sampled-*    single dabs of that tip: as defined, angle 30, flip X,
//                flip Y, flip X + angle 30 -- the rotation sign and the
//                flip/rotate composition order the engine registry says
//                only a Photoshop rendering can settle.
//
// Every case READS BACK the tool's options after configuring them
// (params.readback) so the fixture records what Photoshop actually used,
// not what the probe asked for. The user's paintbrush options, the
// foreground colour and the current tool are restored at the end, and
// the temporary brush preset is deleted by name.
(function () {
  var P = PagedProbe;
  var c = P.cid;
  P.begin("brush-strokes");
  var TIP_NAME = "paged probe tip (temporary)";

  function toolOptions() {
    var r = new ActionReference();
    r.putProperty(c("Prpr"), stringIDToTypeID("tool"));
    r.putEnumerated(c("capp"), c("Ordn"), c("Trgt"));
    return executeActionGet(r).getObjectValue(c("currentToolOptions"));
  }

  function setToolOptions(o) {
    var d = new ActionDescriptor();
    var r = new ActionReference();
    r.putClass(c("paintbrushTool"));
    d.putReference(c("null"), r);
    d.putObject(c("T   "), c("null"), o);
    executeAction(c("setd"), d, DialogModes.NO);
  }

  // A PARTIAL options descriptor resets the unnamed gates to Photoshop's
  // own defaults (scatter came back on at 30 % in trials), so every gate
  // is named on every call.
  function configure(brushClass, brush) {
    var o = new ActionDescriptor();
    var gates = [
      "useTipDynamics",
      "useScatter",
      "useTexture",
      "useColorDynamics",
      "usePaintDynamics",
      "useBrushPose",
      "wetEdges",
      "noise",
      "repeat",
      "smoothing",
      "usePressureOverridesSize",
      "usePressureOverridesOpacity"
    ];
    var i;
    for (i = 0; i < gates.length; i++) o.putBoolean(c(gates[i]), false);
    o.putInteger(c("smoothingValue"), 0);
    o.putInteger(c("smooth"), 0);
    o.putInteger(c("opacity"), 100);
    o.putInteger(stringIDToTypeID("flow"), 100);
    o.putEnumerated(c("Md  "), c("BlnM"), c("Nrml"));
    var db = new ActionDescriptor();
    db.putBoolean(c("useDualBrush"), false);
    o.putObject(c("dualBrush"), c("dualBrush"), db);
    o.putObject(c("Brsh"), c(brushClass), brush);
    setToolOptions(o);
  }

  function computed(t) {
    var b = new ActionDescriptor();
    b.putUnitDouble(c("Dmtr"), c("#Pxl"), t.diameter);
    b.putUnitDouble(c("Hrdn"), c("#Prc"), t.hardness);
    b.putUnitDouble(c("Angl"), c("#Ang"), t.angle);
    b.putUnitDouble(c("Rndn"), c("#Prc"), t.roundness);
    b.putUnitDouble(c("Spcn"), c("#Prc"), t.spacing);
    b.putBoolean(c("Intr"), true);
    b.putBoolean(c("flipX"), false);
    b.putBoolean(c("flipY"), false);
    return b;
  }

  var sampled = null; // { id, name } of the defined tip

  function sampledDesc(t) {
    var b = new ActionDescriptor();
    b.putUnitDouble(c("Dmtr"), c("#Pxl"), t.diameter);
    b.putUnitDouble(c("Angl"), c("#Ang"), t.angle);
    b.putUnitDouble(c("Rndn"), c("#Prc"), 100);
    b.putUnitDouble(c("Spcn"), c("#Prc"), t.spacing);
    b.putBoolean(c("Intr"), true);
    b.putBoolean(c("flipX"), t.flipX);
    b.putBoolean(c("flipY"), t.flipY);
    b.putString(c("sampledData"), sampled.id);
    b.putString(c("Nm  "), sampled.name);
    return b;
  }

  /** What the tool will paint with, read back from Photoshop. */
  function readback() {
    var o = toolOptions();
    var b = o.getObjectValue(c("Brsh"));
    function get(f) {
      try {
        return f();
      } catch (e) {
        return "unavailable: " + e;
      }
    }
    var out = {
      tip_class: get(function () {
        return typeIDToStringID(o.getObjectType(c("Brsh")));
      }),
      opacity: get(function () {
        return o.getInteger(c("opacity"));
      }),
      flow: get(function () {
        return o.getInteger(stringIDToTypeID("flow"));
      }),
      mode: get(function () {
        return typeIDToStringID(o.getEnumerationValue(stringIDToTypeID("mode")));
      }),
      smoothing: get(function () {
        return o.getBoolean(c("smoothing"));
      }),
      gates: {}
    };
    var keys = [
      ["diameter", "Dmtr"],
      ["hardness", "Hrdn"],
      ["angle", "Angl"],
      ["roundness", "Rndn"],
      ["spacing", "Spcn"]
    ];
    var i;
    for (i = 0; i < keys.length; i++) {
      if (b.hasKey(c(keys[i][1]))) out[keys[i][0]] = b.getUnitDoubleValue(c(keys[i][1]));
    }
    out.flipX = b.getBoolean(c("flipX"));
    out.flipY = b.getBoolean(c("flipY"));
    var gates = [
      "useTipDynamics",
      "useScatter",
      "useTexture",
      "useColorDynamics",
      "usePaintDynamics",
      "useBrushPose",
      "wetEdges",
      "noise",
      "repeat"
    ];
    for (i = 0; i < gates.length; i++) {
      out.gates[gates[i]] = o.hasKey(c(gates[i])) ? o.getBoolean(c(gates[i])) : null;
    }
    return out;
  }

  function line(doc, x0, y0, x1, y1) {
    function pt(x, y) {
      var a = new PathPointInfo();
      a.kind = PointKind.CORNERPOINT;
      a.anchor = [x, y];
      a.leftDirection = a.anchor;
      a.rightDirection = a.anchor;
      return a;
    }
    var s = new SubPathInfo();
    s.operation = ShapeOperation.SHAPEXOR;
    s.closed = false;
    s.entireSubPath = [pt(x0, y0), pt(x1, y1)];
    return doc.pathItems.add("paged probe stroke", [s]);
  }

  function black() {
    var k = new SolidColor();
    k.rgb.red = 0;
    k.rgb.green = 0;
    k.rgb.blue = 0;
    return k;
  }

  function stroke(d, params, configureTip) {
    configureTip();
    params.readback = readback();
    app.foregroundColor = black();
    var p = line(d, params.from[0], params.from[1], params.to[0], params.to[1]);
    p.strokePath(ToolType.BRUSH, false);
    p.remove();
  }

  var prevTool = app.currentTool;
  var prevFg = app.foregroundColor;
  app.currentTool = "paintbrushTool";
  var saved = toolOptions();
  var base = app.documents.add(
    128,
    128,
    72,
    "paged brush probe",
    NewDocumentMode.RGB,
    DocumentFill.WHITE,
    1,
    BitsPerChannelType.SIXTEEN
  );
  var owned = [base];
  try {
    // -- computed round tips --
    var SINGLE = [
      ["round-d40-h0-single", 40, 0, [64, 64]],
      ["round-d40-h50-single", 40, 50, [64, 64]],
      ["round-d40-h100-single", 40, 100, [64, 64]],
      ["round-d40-h50-single-half", 40, 50, [64.5, 64.5]],
      ["round-d11-h100-single", 11, 100, [64, 64]]
    ];
    var i;
    for (i = 0; i < SINGLE.length; i++) {
      (function (s) {
        var params = {
          tip: "computed",
          diameter: s[1],
          hardness: s[2],
          angle: 0,
          roundness: 100,
          spacing: 1000,
          from: s[3],
          to: [s[3][0] + 10, s[3][1]]
        };
        P.run(s[0], base, params, function (d) {
          stroke(d, params, function () {
            configure("computedBrush", computed(params));
          });
        });
      })(SINGLE[i]);
    }
    var LINES = [
      ["round-d20-h100-sp10", 20, 100, 10],
      ["round-d20-h100-sp25", 20, 100, 25],
      ["round-d20-h50-sp25", 20, 50, 25],
      ["round-d10-h100-sp100", 10, 100, 100],
      ["round-d10-h100-sp200", 10, 100, 200],
      ["round-d10-h100-sp150", 10, 100, 150]
    ];
    for (i = 0; i < LINES.length; i++) {
      (function (s) {
        var params = {
          tip: "computed",
          diameter: s[1],
          hardness: s[2],
          angle: 0,
          roundness: 100,
          spacing: s[3],
          from: [14, 64],
          to: [114, 64]
        };
        P.run(s[0], base, params, function (d) {
          stroke(d, params, function () {
            configure("computedBrush", computed(params));
          });
        });
      })(LINES[i]);
    }
    var ELLIPSES = [
      ["round-d40-h100-a30-r40", 40, 100, 30, 40],
      ["round-d40-h100-am60-r25", 40, 100, -60, 25],
      ["round-d40-h50-a90-r50", 40, 50, 90, 50]
    ];
    for (i = 0; i < ELLIPSES.length; i++) {
      (function (s) {
        var params = {
          tip: "computed",
          diameter: s[1],
          hardness: s[2],
          angle: s[3],
          roundness: s[4],
          spacing: 1000,
          from: [64, 64],
          to: [74, 64]
        };
        P.run(s[0], base, params, function (d) {
          stroke(d, params, function () {
            configure("computedBrush", computed(params));
          });
        });
      })(ELLIPSES[i]);
    }

    // -- the sampled tip --
    // Artwork: a right triangle (right angle top-left, long leg along x)
    // plus a small square below it. Bounding box x 8..56, y 8..48, so
    // the defined tip is 48 x 40 and its default diameter 48.
    var tipParams = {
      tip: "source",
      triangle: [[8, 8], [56, 8], [8, 32]],
      square: [[8, 40], [16, 40], [16, 48], [8, 48]]
    };
    P.run("tip-source", base, tipParams, function (d) {
      d.selection.select(tipParams.triangle);
      d.selection.fill(black());
      d.selection.select(tipParams.square);
      d.selection.fill(black());
      d.selection.selectAll();
      var m = new ActionDescriptor();
      var r = new ActionReference();
      r.putClass(c("Brsh"));
      m.putReference(c("null"), r);
      var u = new ActionReference();
      u.putProperty(c("Prpr"), c("fsel"));
      u.putEnumerated(c("Dcmn"), c("Ordn"), c("Trgt"));
      m.putReference(c("Usng"), u);
      m.putString(c("Nm  "), TIP_NAME);
      executeAction(c("Mk  "), m, DialogModes.NO);
      var b = toolOptions().getObjectValue(c("Brsh"));
      sampled = {
        id: b.getString(c("sampledData")),
        name: b.getString(c("Nm  "))
      };
      tipParams.defined = {
        diameter: b.getUnitDoubleValue(c("Dmtr")),
        spacing: b.getUnitDoubleValue(c("Spcn"))
      };
      d.selection.deselect();
    });
    var SAMPLED = [
      ["sampled-a0", 0, false, false],
      ["sampled-a30", 30, false, false],
      ["sampled-am30", -30, false, false],
      ["sampled-flipx", 0, true, false],
      ["sampled-flipy", 0, false, true],
      ["sampled-flipx-a30", 30, true, false]
    ];
    for (i = 0; i < SAMPLED.length; i++) {
      (function (s) {
        var params = {
          tip: "sampled",
          diameter: 48,
          angle: s[1],
          flipX: s[2],
          flipY: s[3],
          spacing: 1000,
          from: [64, 64],
          to: [74, 64]
        };
        P.run(s[0], base, params, function (d) {
          if (sampled === null) throw new Error("the sampled tip was not defined");
          stroke(d, params, function () {
            configure("sampledBrush", sampledDesc(params));
          });
        });
      })(SAMPLED[i]);
    }
  } finally {
    // Delete ONLY the preset this probe made, by its name.
    try {
      var dd = new ActionDescriptor();
      var rr = new ActionReference();
      rr.putName(c("Brsh"), TIP_NAME);
      dd.putReference(c("null"), rr);
      executeAction(c("Dlt "), dd, DialogModes.NO);
    } catch (e) {}
    setToolOptions(saved);
    app.foregroundColor = prevFg;
    app.currentTool = prevTool;
  }
  return P.finish(owned);
})();
