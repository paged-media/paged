// The adjustment LAYERS adjustment-layers.jsx does not cover, written by
// Photoshop itself: Vibrance, Color Balance, Black & White, Channel
// Mixer, Posterize, Threshold, Gradient Map and Selective Color. Each case is the colour-sweep stimulus (reduced to 8 bits) with
// one adjustment layer above it, saved as a layered PSD with REAL merged
// data plus a PNG of the same document.
//
// Color Lookup is not recorded: an ActionManager `Mk  ` with a `.cube`
// file's data (`LUT3DFileData`, `LUTFormatCUBE`) makes an EMPTY lookup
// layer (its `clrL` descriptor has no items), so Photoshop compiles the
// look into the layer only through its dialog.
//
// The recorded blocks are what paged-psd's adjustment writer is held to
// (paged-psd tests/it/adjustment_photoshop.rs: each block parses to the
// parameters below, and the writer's block for those parameters reads
// back to the same values), and the composites are what the layered
// import's render is measured against.
//
// "Maximize compatibility" is what makes Photoshop write the merged
// composite; the preference is set for the run and restored after.
(function () {
  var P = PagedProbe;
  var st = P.begin("adjustment-layers-ext");
  var prevCompat = app.preferences.maximizeCompatibility;
  app.preferences.maximizeCompatibility = QueryStateType.ALWAYS;
  st.maximize_compatibility_was = String(prevCompat);
  var cid = P.cid;

  function adjLayer(cls, type) {
    var d = new ActionDescriptor();
    var r = new ActionReference();
    r.putClass(cid("AdjL"));
    d.putReference(cid("null"), r);
    var u = new ActionDescriptor();
    u.putObject(cid("Type"), cid(cls), type);
    d.putObject(cid("Usng"), cid("AdjL"), u);
    executeAction(cid("Mk  "), d, DialogModes.NO);
  }
  function rgb(c) {
    var d = new ActionDescriptor();
    d.putDouble(cid("Rd  "), c[0]);
    d.putDouble(cid("Grn "), c[1]);
    d.putDouble(cid("Bl  "), c[2]);
    return d;
  }
  function ints(a) {
    var l = new ActionList();
    var i;
    for (i = 0; i < a.length; i++) l.putInteger(a[i]);
    return l;
  }
  function vibrance(v, s) {
    var t = new ActionDescriptor();
    t.putInteger(cid("vibrance"), v);
    t.putInteger(cid("Strt"), s);
    adjLayer("vibrance", t);
  }
  function colorBalance(sh, mid, hi, keep) {
    var t = new ActionDescriptor();
    t.putList(cid("ShdL"), ints(sh));
    t.putList(cid("MdtL"), ints(mid));
    t.putList(cid("HghL"), ints(hi));
    t.putBoolean(cid("PrsL"), keep);
    adjLayer("ClrB", t);
  }
  // weights: reds, yellows, greens, cyans, blues, magentas
  function blackWhite(w, tint) {
    var t = new ActionDescriptor();
    t.putInteger(cid("Rd  "), w[0]);
    t.putInteger(cid("Yllw"), w[1]);
    t.putInteger(cid("Grn "), w[2]);
    t.putInteger(cid("Cyn "), w[3]);
    t.putInteger(cid("Bl  "), w[4]);
    t.putInteger(cid("Mgnt"), w[5]);
    t.putBoolean(cid("useTint"), tint !== null);
    if (tint !== null) t.putObject(cid("tintColor"), cid("RGBC"), rgb(tint));
    adjLayer("BanW", t);
  }
  // rows: red, green, blue output rows of [r, g, b, constant] percent
  function channelMixer(rows, mono) {
    var t = new ActionDescriptor();
    var keys = ["Rd  ", "Grn ", "Bl  "];
    var i;
    t.putBoolean(cid("Mnch"), mono);
    for (i = 0; i < (mono ? 1 : 3); i++) {
      var m = new ActionDescriptor();
      m.putUnitDouble(cid("Rd  "), cid("#Prc"), rows[i][0]);
      m.putUnitDouble(cid("Grn "), cid("#Prc"), rows[i][1]);
      m.putUnitDouble(cid("Bl  "), cid("#Prc"), rows[i][2]);
      m.putUnitDouble(cid("Cnst"), cid("#Prc"), rows[i][3]);
      t.putObject(cid(mono ? "Gry " : keys[i]), cid("ChMx"), m);
    }
    adjLayer("ChnM", t);
  }
  function posterize(levels) {
    var t = new ActionDescriptor();
    t.putInteger(cid("Lvls"), levels);
    adjLayer("Pstr", t);
  }
  function threshold(level) {
    var t = new ActionDescriptor();
    t.putInteger(cid("Lvl "), level);
    adjLayer("Thrs", t);
  }
  // stops: [[location 0..4096, [r, g, b]], ...]
  function gradientMap(stops, reverse, dither) {
    var t = new ActionDescriptor();
    var g = new ActionDescriptor();
    g.putString(cid("Nm  "), "Custom");
    g.putEnumerated(cid("GrdF"), cid("GrdF"), cid("CstS"));
    g.putDouble(cid("Intr"), 4096);
    var clrs = new ActionList();
    var i;
    for (i = 0; i < stops.length; i++) {
      var s = new ActionDescriptor();
      s.putObject(cid("Clr "), cid("RGBC"), rgb(stops[i][1]));
      s.putEnumerated(cid("Type"), cid("Clry"), cid("UsrS"));
      s.putInteger(cid("Lctn"), stops[i][0]);
      s.putInteger(cid("Mdpn"), 50);
      clrs.putObject(cid("Clrt"), s);
    }
    g.putList(cid("Clrs"), clrs);
    var trns = new ActionList();
    var ends = [0, 4096];
    for (i = 0; i < 2; i++) {
      var o = new ActionDescriptor();
      o.putUnitDouble(cid("Opct"), cid("#Prc"), 100);
      o.putInteger(cid("Lctn"), ends[i]);
      o.putInteger(cid("Mdpn"), 50);
      trns.putObject(cid("TrnS"), o);
    }
    g.putList(cid("Trns"), trns);
    t.putObject(cid("Grad"), cid("Grdn"), g);
    t.putBoolean(cid("Rvrs"), reverse);
    t.putBoolean(cid("Dthr"), dither);
    adjLayer("GdMp", t);
  }
  // ranges: [[colour code, c, m, y, k], ...]
  function selectiveColor(ranges, absolute) {
    var t = new ActionDescriptor();
    t.putEnumerated(cid("Mthd"), cid("CrcM"), cid(absolute ? "Absl" : "Rltv"));
    var l = new ActionList();
    var i;
    for (i = 0; i < ranges.length; i++) {
      var r = ranges[i];
      var c = new ActionDescriptor();
      c.putEnumerated(cid("Clrs"), cid("Clrs"), cid(r[0]));
      c.putUnitDouble(cid("Cyn "), cid("#Prc"), r[1]);
      c.putUnitDouble(cid("Mgnt"), cid("#Prc"), r[2]);
      c.putUnitDouble(cid("Ylw "), cid("#Prc"), r[3]);
      c.putUnitDouble(cid("Blck"), cid("#Prc"), r[4]);
      l.putObject(cid("ClrC"), c);
    }
    t.putList(cid("ClrC"), l);
    adjLayer("SlcC", t);
  }
  function stack(id, params, build) {
    var c = { id: id, params: params };
    var d = null;
    try {
      d = P.open("stimuli/colour-sweep.png");
      d.bitsPerChannel = BitsPerChannelType.EIGHT;
      build(d);
      var psd = new PhotoshopSaveOptions();
      psd.layers = true;
      psd.embedColorProfile = false;
      psd.alphaChannels = false;
      d.saveAs(new File(PAGED_STAGE + "/adjustment-layers-ext/" + id + ".psd"), psd, true, Extension.LOWERCASE);
      var png = new PNGSaveOptions();
      png.compression = 9;
      d.saveAs(new File(PAGED_STAGE + "/adjustment-layers-ext/" + id + ".png"), png, true, Extension.LOWERCASE);
      c.files = ["adjustment-layers-ext/" + id + ".psd", "adjustment-layers-ext/" + id + ".png"];
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

  new Folder(PAGED_STAGE + "/adjustment-layers-ext").create();
  try {
    stack("vibrance", { vibrance: 40, saturation: -20 }, function () {
      vibrance(40, -20);
    });
    stack("color-balance", {
      shadows: [10, -20, 30],
      midtones: [-15, 25, 0],
      highlights: [5, 0, -40],
      preserve_luminosity: true
    }, function () {
      colorBalance([10, -20, 30], [-15, 25, 0], [5, 0, -40], true);
    });
    stack("black-white", { weights: [40, 60, 40, 60, 20, 80], tint: null }, function () {
      blackWhite([40, 60, 40, 60, 20, 80], null);
    });
    stack("black-white-tint", { weights: [30, 70, 50, 50, 10, 90], tint: [225, 211, 179] }, function () {
      blackWhite([30, 70, 50, 50, 10, 90], [225, 211, 179]);
    });
    stack("channel-mixer", {
      rows: [[80, 20, 0, 0], [10, 70, 20, 5], [0, -10, 110, -5]],
      monochrome: false
    }, function () {
      channelMixer([[80, 20, 0, 0], [10, 70, 20, 5], [0, -10, 110, -5]], false);
    });
    stack("channel-mixer-mono", { rows: [[30, 59, 11, 0]], monochrome: true }, function () {
      channelMixer([[30, 59, 11, 0]], true);
    });
    stack("posterize", { levels: 5 }, function () {
      posterize(5);
    });
    stack("threshold", { level: 140 }, function () {
      threshold(140);
    });
    stack("gradient-map", {
      stops: [[0, [20, 10, 80]], [2048, [200, 60, 40]], [4096, [250, 240, 200]]],
      reverse: false,
      dither: false
    }, function () {
      gradientMap([[0, [20, 10, 80]], [2048, [200, 60, 40]], [4096, [250, 240, 200]]], false, false);
    });
    stack("gradient-map-reversed", {
      stops: [[0, [0, 0, 0]], [4096, [255, 255, 255]]],
      reverse: true,
      dither: false
    }, function () {
      gradientMap([[0, [0, 0, 0]], [4096, [255, 255, 255]]], true, false);
    });
    stack("selective-color", {
      ranges: [["Rds ", 10, -20, 30, 0], ["Ntrl", -5, 0, 15, 10], ["Blks", 0, 0, 0, 20]],
      absolute: false
    }, function () {
      selectiveColor([["Rds ", 10, -20, 30, 0], ["Ntrl", -5, 0, 15, 10], ["Blks", 0, 0, 0, 20]], false);
    });
    stack("selective-color-absolute", {
      ranges: [["Bls ", 25, 0, -25, 0], ["Whts", 0, 10, 0, 0]],
      absolute: true
    }, function () {
      selectiveColor([["Bls ", 25, 0, -25, 0], ["Whts", 0, 10, 0, 0]], true);
    });
  } finally {
    app.preferences.maximizeCompatibility = prevCompat;
  }
  return P.finish([]);
})();
