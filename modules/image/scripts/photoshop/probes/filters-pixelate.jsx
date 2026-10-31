// Pixelate filters (WP5.2) on `colour-sweep`, all ActionManager events
// (keys in params.am). Crystallize, Pointillize and Mezzotint place their
// cells / dots at random: the replay compares statistics
// (params.compare = "stats"). 8-bit-only filters convert as in
// filters-stylize.jsx (params.eight_bit).
(function () {
  var P = PagedProbe;
  P.begin("filters-pixelate");
  var src = P.open("stimuli/colour-sweep.png");
  var bg0 = app.backgroundColor;
  var white = new SolidColor();
  white.rgb.red = 255;
  white.rgb.green = 255;
  white.rgb.blue = 255;
  app.backgroundColor = white;
  function c(id, params, event, entries) {
    params.am = event;
    P.run(id, src, params, function (d) {
      try {
        P.exec(event, entries);
      } catch (e) {
        d.bitsPerChannel = BitsPerChannelType.EIGHT;
        P.exec(event, entries);
        d.bitsPerChannel = BitsPerChannelType.SIXTEEN;
        params.eight_bit = true;
      }
    });
  }
  try {
    P.run("identity", src, {}, function (d) {});
    c("facet", {}, "Fct ", []);
    c("crystallize-10", { cell: 10, compare: "stats" }, "Crst", [["ClSz", "int", 10]]);
    c("pointillize-6", { cell: 6, bg: [255, 255, 255], compare: "stats" }, "Pntl", [["ClSz", "int", 6]]);
    c("mezzotint-fine-dots", { kind: "fine-dots", compare: "stats" }, "Mztn", [["MztT", "enum", ["MztT", "FnDt"]]]);
    c("mezzotint-long-lines", { kind: "long-lines", compare: "stats" }, "Mztn", [["MztT", "enum", ["MztT", "LngL"]]]);
    c("color-halftone-8", { max_radius: 8, angles: [108, 162, 90, 45] }, "ClrH", [["Rds ", "int", 8], ["Ang1", "int", 108], ["Ang2", "int", 162], ["Ang3", "int", 90], ["Ang4", "int", 45]]);
  } finally {
    app.backgroundColor = bg0;
  }
  return P.finish([src]);
})();
