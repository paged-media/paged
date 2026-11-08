// LAYER STYLES, written by Photoshop itself: one small RGB document per
// style and key parameter -- Drop Shadow, Inner Shadow, Outer Glow, Inner
// Glow, Bevel & Emboss, Satin, Color Overlay, Gradient Overlay and Stroke,
// plus the blending options that change how a style composites (fill
// opacity, Blend Interior Effects as Group, Layer Mask Hides Effects,
// layer opacity, two shadows at once). Each is saved as a layered PSD with
// REAL merged data plus a PNG of the same document; the replay is
// image-conformance/tests/it/psd_layer_styles.rs, which also reads every
// effect's descriptor back from these files.
//
// Every effect sets its angle locally (uglg false) except the one case
// that asks for the document's Global Light, so the recording does not
// depend on a document default. Pattern Overlay, Bevel texture and a
// pattern Stroke are NOT recorded: a pattern in a style refers to the
// application's pattern presets, and a probe must not add to them.
(function () {
  var P = PagedProbe;
  var st = P.begin("layer-styles");
  var S = 80;
  var cid = P.cid;
  var prevCompat = app.preferences.maximizeCompatibility;
  app.preferences.maximizeCompatibility = QueryStateType.ALWAYS;
  st.maximize_compatibility_was = String(prevCompat);

  function rgb(r, g, b) {
    var c = new SolidColor();
    c.rgb.red = r;
    c.rgb.green = g;
    c.rgb.blue = b;
    return c;
  }
  function ellipse(d, x0, y0, x1, y1, color) {
    var pts = [];
    var i, t;
    for (i = 0; i < 64; i++) {
      t = (i / 64) * 2 * Math.PI;
      pts.push([(x0 + x1) / 2 + ((x1 - x0) / 2) * Math.cos(t), (y0 + y1) / 2 + ((y1 - y0) / 2) * Math.sin(t)]);
    }
    d.selection.select(pts);
    d.selection.fill(color);
    d.selection.deselect();
  }
  function rect(d, x0, y0, x1, y1, color) {
    d.selection.select([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
    d.selection.fill(color);
    d.selection.deselect();
  }
  function layer(d, name) {
    var l = d.artLayers.add();
    l.name = name;
    return l;
  }

  // -- descriptors ------------------------------------------------------

  function rgbDesc(c) {
    var o = new ActionDescriptor();
    o.putDouble(cid("Rd  "), c[0]);
    o.putDouble(cid("Grn "), c[1]);
    o.putDouble(cid("Bl  "), c[2]);
    return o;
  }
  // A contour: [[x, y], ...] on 0..255.
  function contour(name, pts) {
    var o = new ActionDescriptor();
    o.putString(cid("Nm  "), name);
    var l = new ActionList();
    var i, p;
    for (i = 0; i < pts.length; i++) {
      p = new ActionDescriptor();
      p.putDouble(cid("Hrzn"), pts[i][0]);
      p.putDouble(cid("Vrtc"), pts[i][1]);
      l.putObject(cid("CrPt"), p);
    }
    o.putList(cid("Crv "), l);
    return o;
  }
  var LINEAR = [[0, 0], [255, 255]];
  var CONE = [[0, 0], [128, 255], [255, 0]];
  // A gradient: stops [[pos 0..1, [r, g, b]], ...], opacity stops
  // [[pos, opacity %], ...].
  function gradient(stops, trns) {
    var g = new ActionDescriptor();
    g.putString(cid("Nm  "), "Custom");
    g.putEnumerated(cid("GrdF"), cid("GrdF"), cid("CstS"));
    g.putDouble(cid("Intr"), 4096);
    var cl = new ActionList();
    var i, s;
    for (i = 0; i < stops.length; i++) {
      s = new ActionDescriptor();
      s.putObject(cid("Clr "), cid("RGBC"), rgbDesc(stops[i][1]));
      s.putEnumerated(cid("Type"), cid("Clry"), cid("UsrS"));
      s.putInteger(cid("Lctn"), Math.round(stops[i][0] * 4096));
      s.putInteger(cid("Mdpn"), 50);
      cl.putObject(cid("Clrt"), s);
    }
    g.putList(cid("Clrs"), cl);
    var tl = new ActionList();
    for (i = 0; i < trns.length; i++) {
      s = new ActionDescriptor();
      s.putUnitDouble(cid("Opct"), cid("#Prc"), trns[i][1]);
      s.putInteger(cid("Lctn"), Math.round(trns[i][0] * 4096));
      s.putInteger(cid("Mdpn"), 50);
      tl.putObject(cid("TrnS"), s);
    }
    g.putList(cid("Trns"), tl);
    return g;
  }
  var BW = gradient([[0, [0, 0, 0]], [1, [255, 255, 255]]], [[0, 100], [1, 100]]);

  // Build an effect descriptor from [key, type, value] entries, the same
  // vocabulary as PagedProbe.exec plus "str" and "desc".
  function obj(entries) {
    var d = new ActionDescriptor();
    var i, e;
    for (i = 0; i < entries.length; i++) {
      e = entries[i];
      if (e[1] === "int") d.putInteger(cid(e[0]), e[2]);
      else if (e[1] === "dbl") d.putDouble(cid(e[0]), e[2]);
      else if (e[1] === "bool") d.putBoolean(cid(e[0]), e[2]);
      else if (e[1] === "enum") d.putEnumerated(cid(e[0]), cid(e[2][0]), cid(e[2][1]));
      else if (e[1] === "unit") d.putUnitDouble(cid(e[0]), cid(e[2][0]), e[2][1]);
      else if (e[1] === "obj") d.putObject(cid(e[0]), cid(e[2][0]), e[2][1]);
      else if (e[1] === "str") d.putString(cid(e[0]), e[2]);
      else throw new Error("unknown AM type " + e[1]);
    }
    return d;
  }
  function px(v) {
    return ["#Pxl", v];
  }
  function pct(v) {
    return ["#Prc", v];
  }
  function ang(v) {
    return ["#Ang", v];
  }

  // A shadow (DrSh / IrSh): o = { mode, color, opacity, angle, distance,
  // spread, size, noise, contour, global, knocks }.
  function shadow(o) {
    var e = [
      ["enab", "bool", true],
      ["Md  ", "enum", ["BlnM", o.mode || "Mltp"]],
      ["Clr ", "obj", ["RGBC", rgbDesc(o.color || [0, 0, 0])]],
      ["Opct", "unit", pct(o.opacity === undefined ? 75 : o.opacity)],
      ["uglg", "bool", !!o.global],
      ["lagl", "unit", ang(o.angle === undefined ? 120 : o.angle)],
      ["Dstn", "unit", px(o.distance === undefined ? 5 : o.distance)],
      ["Ckmt", "unit", px(o.spread || 0)],
      ["blur", "unit", px(o.size === undefined ? 5 : o.size)],
      ["Nose", "unit", pct(o.noise || 0)],
      ["AntA", "bool", false],
      ["TrnS", "obj", ["ShpC", contour("Custom", o.contour || LINEAR)]]
    ];
    if (o.knocks !== undefined) e.push(["layerConceals", "bool", o.knocks]);
    return obj(e);
  }
  // A glow (OrGl / IrGl): o = { mode, color, gradient, opacity, precise,
  // spread, size, range, jitter, noise, contour, source }.
  function glow(o, inner) {
    var e = [
      ["enab", "bool", true],
      ["Md  ", "enum", ["BlnM", o.mode || "Scrn"]],
      ["Opct", "unit", pct(o.opacity === undefined ? 75 : o.opacity)],
      ["GlwT", "enum", ["BETE", o.precise ? "PrBL" : "SfBL"]],
      ["Ckmt", "unit", px(o.spread || 0)],
      ["blur", "unit", px(o.size === undefined ? 10 : o.size)],
      ["Nose", "unit", pct(o.noise || 0)],
      ["ShdN", "unit", pct(o.jitter || 0)],
      ["AntA", "bool", false],
      ["TrnS", "obj", ["ShpC", contour("Custom", o.contour || LINEAR)]],
      ["Inpr", "unit", pct(o.range === undefined ? 50 : o.range)]
    ];
    if (o.gradient) e.push(["Grad", "obj", ["Grdn", o.gradient]]);
    else e.push(["Clr ", "obj", ["RGBC", rgbDesc(o.color || [255, 255, 190])]]);
    if (inner) e.push(["glwS", "enum", ["IGSr", o.source === "center" ? "SrcC" : "SrcE"]]);
    return obj(e);
  }
  // Bevel & Emboss: o = { style, technique, depth, down, size, soften,
  // angle, altitude, gloss, contour, hmode, hcolor, hopacity, smode,
  // scolor, sopacity }.
  function bevel(o) {
    var e = [
      ["enab", "bool", true],
      ["hglM", "enum", ["BlnM", o.hmode || "Scrn"]],
      ["hglC", "obj", ["RGBC", rgbDesc(o.hcolor || [255, 255, 255])]],
      ["hglO", "unit", pct(o.hopacity === undefined ? 75 : o.hopacity)],
      ["sdwM", "enum", ["BlnM", o.smode || "Mltp"]],
      ["sdwC", "obj", ["RGBC", rgbDesc(o.scolor || [0, 0, 0])]],
      ["sdwO", "unit", pct(o.sopacity === undefined ? 75 : o.sopacity)],
      ["bvlT", "enum", ["bvlT", o.technique || "SfBL"]],
      ["bvlS", "enum", ["BESl", o.style || "InrB"]],
      ["uglg", "bool", false],
      ["lagl", "unit", ang(o.angle === undefined ? 120 : o.angle)],
      ["Lald", "unit", ang(o.altitude === undefined ? 30 : o.altitude)],
      ["srgR", "unit", pct(o.depth === undefined ? 100 : o.depth)],
      ["blur", "unit", px(o.size === undefined ? 5 : o.size)],
      ["bvlD", "enum", ["BESs", o.down ? "Out " : "In  "]],
      ["TrnS", "obj", ["ShpC", contour("Custom", o.gloss || LINEAR)]],
      ["Sftn", "unit", px(o.soften || 0)],
      ["AntA", "bool", false]
    ];
    if (o.contour) {
      e.push(["useShape", "bool", true]);
      e.push(["MpgS", "obj", ["ShpC", contour("Custom", o.contour)]]);
      e.push(["Inpr", "unit", pct(o.range === undefined ? 50 : o.range)]);
    }
    return obj(e);
  }
  // Satin: o = { mode, color, opacity, angle, distance, size, invert, contour }.
  function satin(o) {
    return obj([
      ["enab", "bool", true],
      ["Md  ", "enum", ["BlnM", o.mode || "Mltp"]],
      ["Clr ", "obj", ["RGBC", rgbDesc(o.color || [0, 0, 0])]],
      ["AntA", "bool", false],
      ["Invr", "bool", !!o.invert],
      ["Opct", "unit", pct(o.opacity === undefined ? 50 : o.opacity)],
      ["lagl", "unit", ang(o.angle === undefined ? 19 : o.angle)],
      ["Dstn", "unit", px(o.distance === undefined ? 11 : o.distance)],
      ["blur", "unit", px(o.size === undefined ? 14 : o.size)],
      ["MpgS", "obj", ["ShpC", contour("Custom", o.contour || LINEAR)]]
    ]);
  }
  function overlay(o) {
    return obj([
      ["enab", "bool", true],
      ["Md  ", "enum", ["BlnM", o.mode || "Nrml"]],
      ["Opct", "unit", pct(o.opacity === undefined ? 100 : o.opacity)],
      ["Clr ", "obj", ["RGBC", rgbDesc(o.color || [40, 90, 200])]]
    ]);
  }
  // Gradient Overlay: o = { mode, opacity, gradient, angle, type, reverse,
  // align, scale, offset }.
  function gradientOverlay(o) {
    return obj([
      ["enab", "bool", true],
      ["Md  ", "enum", ["BlnM", o.mode || "Nrml"]],
      ["Opct", "unit", pct(o.opacity === undefined ? 100 : o.opacity)],
      ["Grad", "obj", ["Grdn", o.gradient || BW]],
      ["Angl", "unit", ang(o.angle === undefined ? 90 : o.angle)],
      ["Type", "enum", ["GrdT", o.type || "Lnr "]],
      ["Rvrs", "bool", !!o.reverse],
      ["Dthr", "bool", false],
      ["Algn", "bool", o.align === undefined ? true : o.align],
      ["Scl ", "unit", pct(o.scale === undefined ? 100 : o.scale)],
      [
        "Ofst",
        "obj",
        [
          "Pnt ",
          obj([
            ["Hrzn", "unit", pct(o.offset ? o.offset[0] : 0)],
            ["Vrtc", "unit", pct(o.offset ? o.offset[1] : 0)]
          ])
        ]
      ]
    ]);
  }
  // Stroke: o = { position, size, mode, opacity, color, gradient, angle, type }.
  function stroke(o) {
    var e = [
      ["enab", "bool", true],
      ["Styl", "enum", ["FStl", o.position || "OutF"]],
      ["PntT", "enum", ["FrFl", o.gradient ? "GrFl" : "SClr"]],
      ["Md  ", "enum", ["BlnM", o.mode || "Nrml"]],
      ["Opct", "unit", pct(o.opacity === undefined ? 100 : o.opacity)],
      ["Sz  ", "unit", px(o.size === undefined ? 3 : o.size)]
    ];
    if (o.gradient) {
      e.push(["Grad", "obj", ["Grdn", o.gradient]]);
      e.push(["Angl", "unit", ang(o.angle === undefined ? 90 : o.angle)]);
      e.push(["Type", "enum", ["GrdT", o.type || "Lnr "]]);
      e.push(["Rvrs", "bool", false]);
      e.push(["Algn", "bool", true]);
      e.push(["Scl ", "unit", pct(100)]);
      e.push(["Ofst", "obj", ["Pnt ", obj([["Hrzn", "unit", pct(0)], ["Vrtc", "unit", pct(0)]])]]);
    } else {
      e.push(["Clr ", "obj", ["RGBC", rgbDesc(o.color || [20, 20, 20])]]);
    }
    return obj(e);
  }

  // Apply a style to the active layer: fx = [[key, descriptor], ...]; a
  // descriptor list (an ActionList) for a "...Multi" key.
  function applyStyle(fx) {
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putProperty(cid("Prpr"), cid("Lefx"));
    ref.putEnumerated(cid("Lyr "), cid("Ordn"), cid("Trgt"));
    desc.putReference(cid("null"), ref);
    var lefx = new ActionDescriptor();
    lefx.putUnitDouble(cid("Scl "), cid("#Prc"), 100);
    var i;
    for (i = 0; i < fx.length; i++) {
      if (fx[i][1] instanceof ActionList) lefx.putList(cid(fx[i][0]), fx[i][1]);
      else lefx.putObject(cid(fx[i][0]), cid(fx[i][2] || fx[i][0]), fx[i][1]);
    }
    desc.putObject(cid("T   "), cid("Lefx"), lefx);
    executeAction(cid("setd"), desc, DialogModes.NO);
  }
  // Set blending options on the active layer: [[stringID, bool], ...].
  function blending(opts) {
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putEnumerated(cid("Lyr "), cid("Ordn"), cid("Trgt"));
    desc.putReference(cid("null"), ref);
    var l = new ActionDescriptor();
    var i;
    for (i = 0; i < opts.length; i++) l.putBoolean(stringIDToTypeID(opts[i][0]), opts[i][1]);
    desc.putObject(cid("T   "), cid("Lyr "), l);
    executeAction(cid("setd"), desc, DialogModes.NO);
  }
  function revealSelectionMask() {
    var desc = new ActionDescriptor();
    desc.putClass(cid("Nw  "), cid("Chnl"));
    var ref = new ActionReference();
    ref.putEnumerated(cid("Chnl"), cid("Chnl"), cid("Msk "));
    desc.putReference(cid("At  "), ref);
    desc.putEnumerated(cid("Usng"), cid("UsrM"), cid("RvlS"));
    executeAction(cid("Mk  "), desc, DialogModes.NO);
  }

  // -- cases ------------------------------------------------------------

  function stack(id, params, build) {
    var c = { id: id, params: params };
    var d = null;
    try {
      d = app.documents.add(S, S, 72, id, NewDocumentMode.RGB, DocumentFill.WHITE);
      d.activeLayer = d.artLayers[d.artLayers.length - 1];
      rect(d, 0, 0, 40, 80, rgb(240, 190, 40));
      build(d);
      var psd = new PhotoshopSaveOptions();
      psd.layers = true;
      psd.embedColorProfile = false;
      psd.alphaChannels = false;
      d.saveAs(new File(PAGED_STAGE + "/layer-styles/" + id + ".psd"), psd, true, Extension.LOWERCASE);
      var png = new PNGSaveOptions();
      png.compression = 9;
      d.saveAs(new File(PAGED_STAGE + "/layer-styles/" + id + ".png"), png, true, Extension.LOWERCASE);
      c.files = ["layer-styles/" + id + ".psd", "layer-styles/" + id + ".png"];
      c.profile = P.profileOf(d);
      c.bits = 8;
    } catch (e) {
      c.error = String(e) + (e.line ? " (line " + e.line + ")" : "");
    }
    if (d !== null) {
      try {
        d.close(SaveOptions.DONOTSAVECHANGES);
      } catch (e2) {
        c.close_error = String(e2);
      }
    }
    st.cases.push(c);
  }

  // The shapes: an ellipse (most cases) or a square (the edge profiles).
  function onEllipse(id, params, fx, after) {
    stack(id, params, function (d) {
      var l = layer(d, "shape");
      ellipse(d, 20, 20, 60, 60, rgb(200, 60, 40));
      applyStyle(fx);
      if (after) after(d, l);
    });
  }
  function onSquare(id, params, fx, after) {
    stack(id, params, function (d) {
      var l = layer(d, "shape");
      rect(d, 24, 24, 56, 56, rgb(200, 60, 40));
      applyStyle(fx);
      if (after) after(d, l);
    });
  }

  try {
    // Drop Shadow.
    onEllipse("ds-basic", { DrSh: "multiply black 75, 120 deg, distance 5, size 5" }, [["DrSh", shadow({})]]);
    onSquare("ds-hard", { DrSh: "normal black 100, 90 deg, distance 8, size 0" }, [
      ["DrSh", shadow({ mode: "Nrml", opacity: 100, angle: 90, distance: 8, size: 0 })]
    ]);
    onSquare("ds-size10", { DrSh: "normal black 100, distance 0, size 10" }, [
      ["DrSh", shadow({ mode: "Nrml", opacity: 100, distance: 0, size: 10 })]
    ]);
    onSquare("ds-size20", { DrSh: "normal black 100, distance 0, size 20" }, [
      ["DrSh", shadow({ mode: "Nrml", opacity: 100, distance: 0, size: 20 })]
    ]);
    onSquare("ds-spread50", { DrSh: "normal black 100, distance 0, size 10, spread 50" }, [
      ["DrSh", shadow({ mode: "Nrml", opacity: 100, distance: 0, size: 10, spread: 50 })]
    ]);
    onSquare("ds-spread100", { DrSh: "normal black 100, distance 0, size 10, spread 100" }, [
      ["DrSh", shadow({ mode: "Nrml", opacity: 100, distance: 0, size: 10, spread: 100 })]
    ]);
    onSquare("ds-contour-cone", { DrSh: "normal black 100, distance 0, size 12, cone contour" }, [
      ["DrSh", shadow({ mode: "Nrml", opacity: 100, distance: 0, size: 12, contour: CONE })]
    ]);
    onEllipse("ds-screen-blue", { DrSh: "screen (0,120,255) 80, 45 deg, distance 6, size 4" }, [
      ["DrSh", shadow({ mode: "Scrn", color: [0, 120, 255], opacity: 80, angle: 45, distance: 6, size: 4 })]
    ]);
    onEllipse("ds-noise", { DrSh: "normal black 100, size 6, noise 40" }, [
      ["DrSh", shadow({ mode: "Nrml", opacity: 100, size: 6, noise: 40 })]
    ]);
    onEllipse("ds-fill0-knocks", { DrSh: "normal black 100, size 4", fill: 0, knocks: true }, [
      ["DrSh", shadow({ mode: "Nrml", opacity: 100, size: 4, knocks: true })]
    ], function (d, l) {
      l.fillOpacity = 0;
    });
    onEllipse("ds-fill0-shows", { DrSh: "normal black 100, size 4", fill: 0, knocks: false }, [
      ["DrSh", shadow({ mode: "Nrml", opacity: 100, size: 4, knocks: false })]
    ], function (d, l) {
      l.fillOpacity = 0;
    });
    // Use Global Light with a LOCAL angle of 0: the document's own Global
    // Light (resource 1037, whatever this document's default is) must win.
    onEllipse("ds-global-light", { DrSh: "use global light (local angle 0), distance 8, size 3" }, [
      ["DrSh", shadow({ mode: "Nrml", opacity: 100, angle: 0, distance: 8, size: 3, global: true })]
    ]);
    onEllipse("ds-layer-opacity-50", { DrSh: "normal black 100, distance 6, size 4", opacity: 50 }, [
      ["DrSh", shadow({ mode: "Nrml", opacity: 100, distance: 6, size: 4 })]
    ], function (d, l) {
      l.opacity = 50;
    });

    // Inner Shadow.
    onEllipse("is-basic", { IrSh: "multiply black 75, 120 deg, distance 5, size 5" }, [["IrSh", shadow({})]]);
    onSquare("is-choke50", { IrSh: "normal black 100, distance 0, size 10, choke 50" }, [
      ["IrSh", shadow({ mode: "Nrml", opacity: 100, distance: 0, size: 10, spread: 50 })]
    ]);
    onSquare("is-hard", { IrSh: "normal black 100, 90 deg, distance 6, size 0" }, [
      ["IrSh", shadow({ mode: "Nrml", opacity: 100, angle: 90, distance: 6, size: 0 })]
    ]);

    // Outer Glow.
    onEllipse("og-softer", { OrGl: "screen (255,255,190) 75, softer, size 10" }, [["OrGl", glow({})]]);
    onSquare("og-softer-black", { OrGl: "normal black 100, softer, size 10" }, [
      ["OrGl", glow({ mode: "Nrml", color: [0, 0, 0], opacity: 100 })]
    ]);
    onSquare("og-precise-black", { OrGl: "normal black 100, precise, size 10" }, [
      ["OrGl", glow({ mode: "Nrml", color: [0, 0, 0], opacity: 100, precise: true })]
    ]);
    onSquare("og-spread50", { OrGl: "normal black 100, softer, size 12, spread 50" }, [
      ["OrGl", glow({ mode: "Nrml", color: [0, 0, 0], opacity: 100, size: 12, spread: 50 })]
    ]);
    onSquare("og-range25", { OrGl: "normal black 100, softer, size 12, range 25" }, [
      ["OrGl", glow({ mode: "Nrml", color: [0, 0, 0], opacity: 100, size: 12, range: 25 })]
    ]);
    onSquare("og-gradient", { OrGl: "normal, gradient blue to red, size 12" }, [
      [
        "OrGl",
        glow({
          mode: "Nrml",
          opacity: 100,
          size: 12,
          gradient: gradient([[0, [0, 0, 255]], [1, [255, 0, 0]]], [[0, 100], [1, 100]])
        })
      ]
    ]);

    // Inner Glow.
    onEllipse("ig-edge", { IrGl: "screen (255,255,190) 75, softer, edge, size 10" }, [["IrGl", glow({}, true)]]);
    onSquare("ig-edge-black", { IrGl: "normal black 100, softer, edge, size 10" }, [
      ["IrGl", glow({ mode: "Nrml", color: [0, 0, 0], opacity: 100 }, true)]
    ]);
    onSquare("ig-center-black", { IrGl: "normal black 100, softer, center, size 10" }, [
      ["IrGl", glow({ mode: "Nrml", color: [0, 0, 0], opacity: 100, source: "center" }, true)]
    ]);
    onSquare("ig-precise-choke", { IrGl: "normal black 100, precise, edge, size 12, choke 40" }, [
      ["IrGl", glow({ mode: "Nrml", color: [0, 0, 0], opacity: 100, precise: true, size: 12, spread: 40 }, true)]
    ]);

    // Bevel & Emboss.
    onEllipse("bv-inner-smooth", { ebbl: "inner bevel, smooth, depth 100, size 5" }, [["ebbl", bevel({})]]);
    onSquare("bv-inner-smooth-10", { ebbl: "inner bevel, smooth, depth 100, size 10" }, [["ebbl", bevel({ size: 10 })]]);
    onSquare("bv-chisel-hard", { ebbl: "inner bevel, chisel hard, size 10" }, [["ebbl", bevel({ size: 10, technique: "PrBL" })]]);
    onSquare("bv-chisel-soft", { ebbl: "inner bevel, chisel soft, size 10" }, [["ebbl", bevel({ size: 10, technique: "Slmt" })]]);
    onSquare("bv-outer", { ebbl: "outer bevel, smooth, size 8" }, [["ebbl", bevel({ size: 8, style: "OtrB" })]]);
    onSquare("bv-emboss", { ebbl: "emboss, smooth, size 8" }, [["ebbl", bevel({ size: 8, style: "Embs" })]]);
    onSquare("bv-pillow", { ebbl: "pillow emboss, smooth, size 8" }, [["ebbl", bevel({ size: 8, style: "PlEb" })]]);
    onSquare("bv-down", { ebbl: "inner bevel, smooth, size 10, down" }, [["ebbl", bevel({ size: 10, down: true })]]);
    onSquare("bv-soften", { ebbl: "inner bevel, chisel hard, size 10, soften 4" }, [
      ["ebbl", bevel({ size: 10, technique: "PrBL", soften: 4 })]
    ]);
    onSquare("bv-altitude-60", { ebbl: "inner bevel, smooth, size 10, altitude 60" }, [["ebbl", bevel({ size: 10, altitude: 60 })]]);
    onSquare("bv-depth-300", { ebbl: "inner bevel, smooth, size 10, depth 300" }, [["ebbl", bevel({ size: 10, depth: 300 })]]);
    onSquare("bv-gloss-cone", { ebbl: "inner bevel, smooth, size 10, gloss contour cone" }, [
      ["ebbl", bevel({ size: 10, gloss: CONE })]
    ]);
    onSquare("bv-contour-cone", { ebbl: "inner bevel, smooth, size 10, contour cone" }, [
      ["ebbl", bevel({ size: 10, contour: CONE })]
    ]);
    onSquare("bv-angle-30-colours", { ebbl: "inner bevel, size 8, 30 deg, normal red / normal blue at 100" }, [
      [
        "ebbl",
        bevel({ size: 8, angle: 30, hmode: "Nrml", hcolor: [255, 0, 0], hopacity: 100, smode: "Nrml", scolor: [0, 0, 255], sopacity: 100 })
      ]
    ]);
    onSquare("bv-stroke-emboss", { ebbl: "stroke emboss, size 6", FrFX: "outside 4" }, [
      ["ebbl", bevel({ size: 6, style: "strokeEmboss" })],
      ["FrFX", stroke({ size: 4, color: [120, 120, 120] })]
    ]);

    // Satin.
    onEllipse("sa-invert", { ChFX: "multiply black 50, 19 deg, distance 11, size 14, invert" }, [["ChFX", satin({ invert: true })]]);
    onEllipse("sa-plain", { ChFX: "multiply black 50, 19 deg, distance 11, size 14" }, [["ChFX", satin({})]]);
    onSquare("sa-normal-cone", { ChFX: "normal black 100, 45 deg, distance 6, size 4, cone" }, [
      ["ChFX", satin({ mode: "Nrml", opacity: 100, angle: 45, distance: 6, size: 4, contour: CONE })]
    ]);

    // Color Overlay (the layer-effects probe covers its modes).
    onEllipse("co-fill0", { SoFi: "normal 100", fill: 0 }, [["SoFi", overlay({})]], function (d, l) {
      l.fillOpacity = 0;
    });

    // Gradient Overlay.
    onEllipse("go-linear", { GrFl: "linear black to white, 90 deg" }, [["GrFl", gradientOverlay({})]]);
    onEllipse("go-radial", { GrFl: "radial" }, [["GrFl", gradientOverlay({ type: "Rdl " })]]);
    onEllipse("go-angle", { GrFl: "angle" }, [["GrFl", gradientOverlay({ type: "Angl", angle: 30 })]]);
    onEllipse("go-reflected", { GrFl: "reflected" }, [["GrFl", gradientOverlay({ type: "Rflc", angle: 0 })]]);
    onEllipse("go-diamond", { GrFl: "diamond" }, [["GrFl", gradientOverlay({ type: "Dmnd", angle: 0 })]]);
    onEllipse("go-scale50-angle30", { GrFl: "linear, 30 deg, scale 50" }, [["GrFl", gradientOverlay({ angle: 30, scale: 50 })]]);
    onEllipse("go-not-aligned", { GrFl: "linear, 0 deg, align off" }, [["GrFl", gradientOverlay({ angle: 0, align: false })]]);
    onEllipse("go-reverse-offset", { GrFl: "linear, reverse, offset 20/-10" }, [
      ["GrFl", gradientOverlay({ angle: 0, reverse: true, offset: [20, -10] })]
    ]);
    onEllipse("go-transparency", { GrFl: "blue opaque to transparent" }, [
      ["GrFl", gradientOverlay({ angle: 0, gradient: gradient([[0, [0, 0, 255]], [1, [0, 0, 255]]], [[0, 100], [1, 0]]) })]
    ]);
    onEllipse("go-multiply-60", { GrFl: "multiply 60, red to yellow" }, [
      ["GrFl", gradientOverlay({ mode: "Mltp", opacity: 60, gradient: gradient([[0, [255, 0, 0]], [1, [255, 255, 0]]], [[0, 100], [1, 100]]) })]
    ]);

    // Stroke.
    onEllipse("st-inside", { FrFX: "inside 4" }, [["FrFX", stroke({ position: "InsF", size: 4 })]]);
    onEllipse("st-center", { FrFX: "center 6" }, [["FrFX", stroke({ position: "CtrF", size: 6 })]]);
    onSquare("st-outside-square", { FrFX: "outside 5" }, [["FrFX", stroke({ size: 5 })]]);
    onEllipse("st-gradient", { FrFX: "outside 6, gradient red to blue" }, [
      ["FrFX", stroke({ size: 6, gradient: gradient([[0, [255, 0, 0]], [1, [0, 0, 255]]], [[0, 100], [1, 100]]) })]
    ]);
    onEllipse("st-multiply-50", { FrFX: "outside 4, multiply 50, blue" }, [
      ["FrFX", stroke({ size: 4, mode: "Mltp", opacity: 50, color: [0, 0, 255] })]
    ]);

    // Blending options.
    onEllipse("bo-fill50-overlay", { SoFi: "normal 60", fill: 50 }, [["SoFi", overlay({ opacity: 60 })]], function (d, l) {
      l.fillOpacity = 50;
    });
    onEllipse("bo-fill50-overlay-interior", { SoFi: "normal 60", fill: 50, blendInterior: true }, [["SoFi", overlay({ opacity: 60 })]], function (d, l) {
      l.fillOpacity = 50;
      blending([["blendInterior", true]]);
    });
    onEllipse("bo-fill0-inner-shadow", { IrSh: "multiply black 100, size 6", fill: 0 }, [
      ["IrSh", shadow({ opacity: 100, size: 6 })]
    ], function (d, l) {
      l.fillOpacity = 0;
    });
    stack("bo-mask-shapes-shadow", { DrSh: "normal black 100, distance 6, size 3", mask: "left half", hides: false }, function (d) {
      layer(d, "shape");
      ellipse(d, 20, 20, 60, 60, rgb(200, 60, 40));
      d.selection.select([[0, 0], [40, 0], [40, 80], [0, 80]]);
      revealSelectionMask();
      d.selection.deselect();
      applyStyle([["DrSh", shadow({ mode: "Nrml", opacity: 100, distance: 6, size: 3 })]]);
    });
    stack("bo-mask-hides-shadow", { DrSh: "normal black 100, distance 6, size 3", mask: "left half", hides: true }, function (d) {
      layer(d, "shape");
      ellipse(d, 20, 20, 60, 60, rgb(200, 60, 40));
      d.selection.select([[0, 0], [40, 0], [40, 80], [0, 80]]);
      revealSelectionMask();
      d.selection.deselect();
      applyStyle([["DrSh", shadow({ mode: "Nrml", opacity: 100, distance: 6, size: 3 })]]);
      blending([["layerMaskAsGlobalMask", true]]);
    });
    (function () {
      var two = new ActionList();
      two.putObject(cid("DrSh"), shadow({ mode: "Nrml", opacity: 100, angle: 0, distance: 6, size: 2, color: [255, 0, 0] }));
      two.putObject(cid("DrSh"), shadow({ mode: "Nrml", opacity: 100, angle: 180, distance: 6, size: 2, color: [0, 0, 255] }));
      onEllipse("bo-two-shadows", { dropShadowMulti: "red right, blue left" }, [["dropShadowMulti", two]]);
    })();
    onEllipse("bo-everything", { all: "shadow, glow, bevel, satin, overlay, stroke" }, [
      ["DrSh", shadow({})],
      ["OrGl", glow({ size: 6 })],
      ["IrGl", glow({ size: 6 }, true)],
      ["ebbl", bevel({})],
      ["ChFX", satin({ opacity: 30 })],
      ["GrFl", gradientOverlay({ opacity: 40 })],
      ["FrFX", stroke({ size: 2 })]
    ]);
  } finally {
    app.preferences.maximizeCompatibility = prevCompat;
  }
  return P.finish([]);
})();
