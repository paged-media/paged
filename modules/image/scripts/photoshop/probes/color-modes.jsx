// The colour modes and the depth image ADR 483 adds, recorded: layered
// Lab, Grayscale and 32-bit float documents with REAL merged data (the
// merged composite, in the document's own numbers, is the oracle the
// replay folds the layers against), Photoshop's 8/16 -> 32 Bits/Channel
// conversion, and the single-channel modes -- Indexed (exact and Web
// palettes, no dither) and Multichannel (from RGB) -- each saved as a PSD,
// Indexed with Photoshop's own sRGB render as a 16-bit PNG.
//
// Not recorded: Duotone. Convert Mode to Duotone answers "the parameters
// are not valid" to every descriptor a script can build (the class
// alone, an empty or a monotone object), so no duotone can be made
// without the dialog; the file format leaves its specification
// undocumented and tells readers to treat a duotone as grey.
//
// Profiles are NAMED, so nothing depends on the user's Color Settings
// (read, never changed). "Maximize compatibility" is set for the run and
// restored. A blend mode a mode does not offer (Photoshop greys some out
// in Lab and at 32 bits) is recorded as unavailable on its tile, never as
// a case error.
(function () {
  var P = PagedProbe;
  var st = P.begin("color-modes");
  var GRAY = "Gray Gamma 2.2";
  var SRGB = "sRGB IEC61966-2.1";
  var REL = Intent.RELATIVECOLORIMETRIC;
  var prevCompat = app.preferences.maximizeCompatibility;
  app.preferences.maximizeCompatibility = QueryStateType.ALWAYS;
  st.maximize_compatibility_was = String(prevCompat);
  st.findings = { gray_profile: GRAY, rendering: "relative colorimetric, BPC, no dither" };
  var sweep = P.open("stimuli/colour-sweep.png");

  function savePsd(d, rel, layers) {
    var psd = new PhotoshopSaveOptions();
    psd.layers = layers;
    psd.embedColorProfile = true;
    psd.alphaChannels = true;
    psd.spotColors = true;
    d.saveAs(new File(PAGED_STAGE + "/" + rel), psd, true, Extension.LOWERCASE);
    return rel;
  }
  function rect(d, x0, y0, x1, y1, color, feather) {
    d.selection.select([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
    if (feather) d.selection.feather(feather);
    d.selection.fill(color);
    d.selection.deselect();
  }
  function rgb(r, g, b) {
    var s = new SolidColor();
    s.rgb.red = r;
    s.rgb.green = g;
    s.rgb.blue = b;
    return s;
  }
  function lab(l, a, b) {
    var s = new SolidColor();
    s.lab.l = l;
    s.lab.a = a;
    s.lab.b = b;
    return s;
  }
  function gray(k) {
    var s = new SolidColor();
    s.gray.gray = k;
    return s;
  }
  function channelNames(d) {
    var out = [];
    var i;
    for (i = 0; i < d.channels.length; i++) out.push(d.channels[i].name);
    return out;
  }
  function bitsOf(d) {
    if (d.bitsPerChannel == BitsPerChannelType.THIRTYTWO) return 32;
    if (d.bitsPerChannel == BitsPerChannelType.SIXTEEN) return 16;
    return 8;
  }
  function render(d, c, rel) {
    var dup = null;
    try {
      dup = d.duplicate(c.id + "-render", false);
      app.activeDocument = dup;
      if (dup.layers.length > 1 || dup.layerSets.length > 0) dup.flatten();
      if (dup.mode != DocumentMode.RGB) dup.changeMode(ChangeMode.RGB);
      dup.convertProfile(SRGB, REL, true, false);
      if (dup.bitsPerChannel != BitsPerChannelType.SIXTEEN) dup.bitsPerChannel = BitsPerChannelType.SIXTEEN;
      c.output = P.savePng(dup, rel);
    } finally {
      if (dup !== null) dup.close(SaveOptions.DONOTSAVECHANGES);
    }
  }
  function finishCase(c, d) {
    if (d !== null) {
      try {
        d.close(SaveOptions.DONOTSAVECHANGES);
      } catch (e2) {
        c.close_error = String(e2);
      }
    }
    st.cases.push(c);
  }

  // The tile layout of cmyk-stacks' `blend-modes`: 5 x 4 tiles of 32 px,
  // a two-colour background with a dark band, one feathered layer each.
  var MODES = [
    ["normal-100", BlendMode.NORMAL, 100], ["normal-50", BlendMode.NORMAL, 50],
    ["multiply", BlendMode.MULTIPLY, 100], ["screen", BlendMode.SCREEN, 100],
    ["overlay", BlendMode.OVERLAY, 100], ["darken", BlendMode.DARKEN, 100],
    ["lighten", BlendMode.LIGHTEN, 100], ["color-burn", BlendMode.COLORBURN, 100],
    ["color-dodge", BlendMode.COLORDODGE, 100], ["soft-light", BlendMode.SOFTLIGHT, 100],
    ["hard-light", BlendMode.HARDLIGHT, 100], ["difference", BlendMode.DIFFERENCE, 100],
    ["exclusion", BlendMode.EXCLUSION, 100], ["linear-burn", BlendMode.LINEARBURN, 100],
    ["linear-dodge", BlendMode.LINEARDODGE, 100], ["hue", BlendMode.HUE, 100],
    ["saturation", BlendMode.SATURATION, 100], ["color", BlendMode.COLORBLEND, 100],
    ["luminosity", BlendMode.LUMINOSITY, 100], ["multiply-50", BlendMode.MULTIPLY, 50]
  ];

  function stack(id, mode, bits, profile, colours) {
    var c = { id: id, params: { mode: mode, bits: bits }, files: [] };
    var d = null;
    try {
      // Created as RGB or Grayscale at 8 or 16 bits and converted: the
      // DOM's new-document call quietly makes a Lab document grey and a
      // 32-bit one 16-bit.
      var nm = mode === "gray" ? NewDocumentMode.GRAYSCALE : NewDocumentMode.RGB;
      var bt = bits === 8 ? BitsPerChannelType.EIGHT : BitsPerChannelType.SIXTEEN;
      d = app.documents.add(160, 128, 72, id, nm, DocumentFill.WHITE, 1.0, bt, profile || SRGB);
      if (mode === "lab") d.changeMode(ChangeMode.LAB);
      if (bits === 32) d.bitsPerChannel = BitsPerChannelType.THIRTYTWO;
      var i, x, y, l;
      d.activeLayer = d.artLayers[d.artLayers.length - 1];
      for (i = 0; i < MODES.length; i++) {
        x = (i % 5) * 32;
        y = Math.floor(i / 5) * 32;
        rect(d, x, y, x + 16, y + 32, colours[0], 0);
        rect(d, x + 16, y, x + 32, y + 32, colours[1], 0);
        rect(d, x + 16, y + 20, x + 32, y + 32, colours[2], 0);
      }
      c.params.tiles = [];
      for (i = 0; i < MODES.length; i++) {
        x = (i % 5) * 32;
        y = Math.floor(i / 5) * 32;
        l = d.artLayers.add();
        l.name = MODES[i][0];
        rect(d, x + 6, y + 6, x + 26, y + 26, colours[3], 2);
        var t = { id: MODES[i][0], x: x, y: y, size: 32 };
        try {
          l.blendMode = MODES[i][1];
          l.opacity = MODES[i][2];
          t.available = true;
        } catch (eb) {
          // Not offered in this mode: the layer stays Normal at the
          // opacity it can take, and the tile says so.
          t.available = false;
          t.why = String(eb);
          l.opacity = MODES[i][2];
        }
        t.blend = String(l.blendMode);
        c.params.tiles.push(t);
      }
      c.params.what = "5x4 tiles of 32 px: a three-colour background under one feathered layer per blend mode";
      c.files.push(savePsd(d, "color-modes/" + id + ".psd", true));
      c.profile = P.profileOf(d);
      c.bits = bitsOf(d);
      c.values = { channels: channelNames(d) };
    } catch (e) {
      c.error = String(e) + (e.line ? " (line " + e.line + ")" : "");
    }
    finishCase(c, d);
  }

  function fromSweep(id, params, body) {
    var c = { id: id, params: params, files: [] };
    var d = null;
    try {
      d = sweep.duplicate(id, false);
      app.activeDocument = d;
      body(d, c);
      c.profile = P.profileOf(d);
      c.bits = bitsOf(d);
    } catch (e) {
      c.error = String(e) + (e.line ? " (line " + e.line + ")" : "");
    }
    finishCase(c, d);
  }

  try {
    // Lab: colours named in L*a*b* so the stored numbers are known.
    var labColours = [lab(70, -30, -20), lab(55, 45, 50), lab(20, 5, -10), lab(60, -50, 30)];
    stack("lab-8", "lab", 8, null, labColours);
    stack("lab-16", "lab", 16, null, labColours);
    // Grayscale (Gray Gamma 2.2): ink percentages.
    var grayColours = [gray(25), gray(60), gray(90), gray(40)];
    stack("gray-8", "gray", 8, GRAY, grayColours);
    stack("gray-16", "gray", 16, GRAY, grayColours);
    // 32 bits per channel: sRGB colours stored as linear light; the dark
    // band and the layer are bright so Linear Dodge adds past 1.
    var floatColours = [rgb(120, 200, 230), rgb(240, 120, 40), rgb(40, 40, 60), rgb(200, 230, 120)];
    stack("float-32", "rgb", 32, SRGB, floatColours);

    // 8/16 -> 32 Bits/Channel on the sweep.
    fromSweep("float-from-16", { from_bits: 16 }, function (d, c) {
      d.bitsPerChannel = BitsPerChannelType.THIRTYTWO;
      c.files.push(savePsd(d, "color-modes/" + c.id + ".psd", false));
    });
    fromSweep("float-from-8", { from_bits: 8 }, function (d, c) {
      d.bitsPerChannel = BitsPerChannelType.EIGHT;
      d.bitsPerChannel = BitsPerChannelType.THIRTYTWO;
      c.files.push(savePsd(d, "color-modes/" + c.id + ".psd", false));
    });

    // Indexed: the Web palette (a fixed 216 colours) with no dither --
    // a nearest-colour mapping a replay can reproduce -- and an EXACT
    // palette on a document of fewer than 256 colours.
    fromSweep("indexed-web", { palette: "web", dither: "none" }, function (d, c) {
      d.bitsPerChannel = BitsPerChannelType.EIGHT;
      var o = new IndexedConversionOptions();
      o.palette = Palette.WEBPALETTE;
      o.dither = Dither.NONE;
      o.forced = ForcedColors.NONE;
      o.transparency = false;
      o.preserveExactColors = false;
      d.changeMode(ChangeMode.INDEXEDCOLOR, o);
      c.files.push(savePsd(d, "color-modes/" + c.id + ".psd", false));
      render(d, c, "color-modes/" + c.id + ".png");
    });
    fromSweep("indexed-exact", { palette: "exact", dither: "none" }, function (d, c) {
      d.bitsPerChannel = BitsPerChannelType.EIGHT;
      // Posterize to 4 levels: 64 colours, so an exact palette exists.
      d.activeLayer.posterize(4);
      var o = new IndexedConversionOptions();
      o.palette = Palette.EXACT;
      o.dither = Dither.NONE;
      o.forced = ForcedColors.NONE;
      o.transparency = false;
      d.changeMode(ChangeMode.INDEXEDCOLOR, o);
      c.files.push(savePsd(d, "color-modes/" + c.id + ".psd", false));
      render(d, c, "color-modes/" + c.id + ".png");
    });

    // Multichannel from RGB: Photoshop names the channels Cyan, Magenta,
    // Yellow and stores them as the RGB channels' values.
    fromSweep("multichannel-8", { from: "rgb" }, function (d, c) {
      d.bitsPerChannel = BitsPerChannelType.EIGHT;
      d.changeMode(ChangeMode.MULTICHANNEL);
      c.values = { channels: channelNames(d) };
      c.files.push(savePsd(d, "color-modes/" + c.id + ".psd", false));
    });
  } finally {
    app.preferences.maximizeCompatibility = prevCompat;
  }
  return P.finish([sweep]);
})();
