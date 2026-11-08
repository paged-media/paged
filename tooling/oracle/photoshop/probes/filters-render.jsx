// Render filters (WP5.2) on `colour-sweep` (16-bit RGB). Clouds,
// Difference Clouds and Fibers are RANDOM: the ActionManager takes a seed
// ('RndS'), but Photoshop's generator is not ours, so the replay compares
// per-channel STATISTICS (params.compare = "stats"), never pixels. The
// foreground/background colours are set to black/white for the run and
// restored afterwards (tool state, not a preference).
(function () {
  var P = PagedProbe;
  P.begin("filters-render");
  var src = P.open("stimuli/colour-sweep.png");
  var fg0 = app.foregroundColor;
  var bg0 = app.backgroundColor;
  var black = new SolidColor();
  black.rgb.red = 0;
  black.rgb.green = 0;
  black.rgb.blue = 0;
  var white = new SolidColor();
  white.rgb.red = 255;
  white.rgb.green = 255;
  white.rgb.blue = 255;
  app.foregroundColor = black;
  app.backgroundColor = white;
  try {
    P.run("identity", src, {}, function (d) {});
    P.run("clouds", src, { seed: 1, fg: [0, 0, 0], bg: [255, 255, 255], compare: "stats" }, function (d) {
      P.exec("Clds", [["RndS", "int", 1]]);
    });
    P.run("difference-clouds", src, { seed: 1, fg: [0, 0, 0], bg: [255, 255, 255], compare: "stats" }, function (d) {
      P.exec("DfrC", [["RndS", "int", 1]]);
    });
    P.run("fibers-16-4", src, { variance: 16, strength: 4, seed: 1, fg: [0, 0, 0], bg: [255, 255, 255], compare: "stats" }, function (d) {
      P.exec("Fbrs", [["Vrnc", "int", 16], ["Strg", "int", 4], ["RndS", "int", 1]]);
    });
    P.run("lens-flare-100-zoom", src, { brightness: 100, centre: [64, 64], lens: "50-300mm zoom" }, function (d) {
      d.activeLayer.applyLensFlare(100, [64, 64], LensType.ZOOMLENS);
    });
    P.run("lens-flare-150-movie", src, { brightness: 150, centre: [40, 50], lens: "movie prime" }, function (d) {
      d.activeLayer.applyLensFlare(150, [40, 50], LensType.MOVIEPRIME);
    });
  } finally {
    app.foregroundColor = fg0;
    app.backgroundColor = bg0;
  }
  return P.finish([src]);
})();
