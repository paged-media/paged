// Selections made by Photoshop on `colour-sweep` (16-bit RGB): Select >
// Color Range (sampled colours with fuzziness, the colour presets, the
// tonal presets, skin tones, invert) and Select > Grow / Similar.
//
// A selection is not an image, so every case renders its selection the
// same way: a new layer filled WHITE through the selection (so the
// layer's alpha IS the coverage) over the background filled BLACK, then
// flattened. The output's grey level is the coverage, 0..65535.
//
// Parameters are Photoshop's own units; `params` records them and the
// replay (image-conformance/tests/it/oracle_photoshop_selection.rs) maps
// them onto the engine's.
(function () {
  var P = PagedProbe;
  P.begin("selection");
  var src = P.open("stimuli/colour-sweep.png");

  function rgb(r, g, b) {
    var c = new SolidColor();
    c.rgb.red = r;
    c.rgb.green = g;
    c.rgb.blue = b;
    return c;
  }

  // Render the live selection as grey: white through it, black elsewhere.
  function render(d) {
    var bg = d.activeLayer;
    var top = d.artLayers.add();
    d.selection.fill(rgb(255, 255, 255), ColorBlendMode.NORMAL, 100, false);
    d.selection.deselect();
    d.activeLayer = bg;
    d.selection.selectAll();
    d.selection.fill(rgb(0, 0, 0), ColorBlendMode.NORMAL, 100, false);
    d.selection.deselect();
    d.activeLayer = top;
  }

  function lab(l, a, b) {
    var x = new ActionDescriptor();
    x.putDouble(P.cid("Lmnc"), l);
    x.putDouble(P.cid("A   "), a);
    x.putDouble(P.cid("B   "), b);
    return x;
  }

  // Sampled colours: the Lab box [mn, mx] widened by `fuzz`.
  function sampled(fuzz, mn, mx, invert) {
    var x = new ActionDescriptor();
    x.putInteger(P.cid("Fzns"), fuzz);
    x.putObject(P.cid("Mnm "), P.cid("LbCl"), lab(mn[0], mn[1], mn[2]));
    x.putObject(P.cid("Mxm "), P.cid("LbCl"), lab(mx[0], mx[1], mx[2]));
    if (invert) x.putBoolean(P.cid("Invr"), true);
    x.putInteger(P.cid("colorModel"), 0);
    executeAction(P.cid("ClrR"), x, DialogModes.NO);
  }

  // A preset: Reds .. Magentas, Highlights / Midtones / Shadows, skin.
  function preset(key, extra) {
    var x = new ActionDescriptor();
    var i;
    x.putEnumerated(P.cid("Clrs"), P.cid("Clrs"), P.cid(key));
    for (i = 0; i < extra.length; i++) x.putInteger(P.cid(extra[i][0]), extra[i][1]);
    x.putInteger(P.cid("colorModel"), 0);
    executeAction(P.cid("ClrR"), x, DialogModes.NO);
  }

  function rect(d, x0, y0, x1, y1) {
    d.selection.select([
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1]
    ]);
  }

  // Grow / Similar through the DOM, which takes the tolerance (the Magic
  // Wand's) and the anti-alias flag as arguments; the ActionManager event
  // with a Tlrn key reports the command as unavailable.
  function grow(d, similar, tol) {
    if (similar) d.selection.similar(tol, false);
    else d.selection.grow(tol, false);
  }

  P.run("identity", src, {}, function (d) {});

  // The sampled red of the sweep's top-left (hue 0, full saturation and
  // value): sRGB (255, 0, 0) is Lab D50 (54.29, 80.80, 69.89).
  var RED = [54.29, 80.8, 69.89];
  var fz = [0, 10, 40, 100, 200];
  var i;
  for (i = 0; i < fz.length; i++) {
    (function (f) {
      P.run("sampled-red-f" + f, src, { mode: "sampled", fuzziness: f, min: RED, max: RED }, function (d) {
        sampled(f, RED, RED, false);
        render(d);
      });
    })(fz[i]);
  }
  P.run("sampled-red-f40-invert", src, { mode: "sampled", fuzziness: 40, min: RED, max: RED, invert: true }, function (d) {
    sampled(40, RED, RED, true);
    render(d);
  });
  // A box from two samples: a mid green and a light cyan.
  var BOX_MIN = [60, -60, -20];
  var BOX_MAX = [85, -30, 40];
  P.run("sampled-box-f20", src, { mode: "sampled", fuzziness: 20, min: BOX_MIN, max: BOX_MAX }, function (d) {
    sampled(20, BOX_MIN, BOX_MAX, false);
    render(d);
  });
  // A neutral grey sample: the grey ramp and the low-saturation rows.
  var GREY = [50, 0, 0];
  P.run("sampled-grey-f40", src, { mode: "sampled", fuzziness: 40, min: GREY, max: GREY }, function (d) {
    sampled(40, GREY, GREY, false);
    render(d);
  });

  var hues = [
    ["reds", "Rds "],
    ["yellows", "Ylws"],
    ["greens", "Grns"],
    ["cyans", "Cyns"],
    ["blues", "Bls "],
    ["magentas", "Mgnt"]
  ];
  for (i = 0; i < hues.length; i++) {
    (function (h) {
      P.run("preset-" + h[0], src, { mode: "preset", preset: h[0] }, function (d) {
        preset(h[1], []);
        render(d);
      });
    })(hues[i]);
  }
  P.run("preset-highlights", src, { mode: "preset", preset: "highlights" }, function (d) {
    preset("Hghl", []);
    render(d);
  });
  P.run("preset-midtones", src, { mode: "preset", preset: "midtones" }, function (d) {
    preset("Mdtn", []);
    render(d);
  });
  P.run("preset-shadows", src, { mode: "preset", preset: "shadows" }, function (d) {
    preset("Shdw", []);
    render(d);
  });
  P.run(
    "preset-shadows-f40-u100",
    src,
    { mode: "preset", preset: "shadows", fuzziness: 40, upper: 100 },
    function (d) {
      preset("Shdw", [
        ["shadowsFuzziness", 40],
        ["shadowsUpperLimit", 100]
      ]);
      render(d);
    }
  );
  P.run(
    "preset-highlights-f10-l200",
    src,
    { mode: "preset", preset: "highlights", fuzziness: 10, lower: 200 },
    function (d) {
      preset("Hghl", [
        ["highlightsFuzziness", 10],
        ["highlightsLowerLimit", 200]
      ]);
      render(d);
    }
  );
  P.run(
    "preset-midtones-f30-l80-u160",
    src,
    { mode: "preset", preset: "midtones", fuzziness: 30, lower: 80, upper: 160 },
    function (d) {
      preset("Mdtn", [
        ["midtonesFuzziness", 30],
        ["midtonesLowerLimit", 80],
        ["midtonesUpperLimit", 160]
      ]);
      render(d);
    }
  );
  P.run("preset-skin", src, { mode: "preset", preset: "skin" }, function (d) {
    preset("skinTone", []);
    render(d);
  });

  // Grow and Similar from a rectangle in the saturated top half (hue
  // 45..56 deg, value rows 20..30) and one in the grey ramp.
  P.run("grow-t16", src, { op: "grow", tolerance: 16, rect: [16, 20, 20, 30] }, function (d) {
    rect(d, 16, 20, 20, 30);
    grow(d, false, 16);
    render(d);
  });
  P.run("grow-t32", src, { op: "grow", tolerance: 32, rect: [16, 20, 20, 30] }, function (d) {
    rect(d, 16, 20, 20, 30);
    grow(d, false, 32);
    render(d);
  });
  P.run("similar-t16", src, { op: "similar", tolerance: 16, rect: [16, 20, 20, 30] }, function (d) {
    rect(d, 16, 20, 20, 30);
    grow(d, true, 16);
    render(d);
  });
  P.run("similar-t32-grey", src, { op: "similar", tolerance: 32, rect: [60, 122, 64, 126] }, function (d) {
    rect(d, 60, 122, 64, 126);
    grow(d, true, 32);
    render(d);
  });
  return P.finish([src]);
})();
