// Stylize filters (WP5.2) on `colour-sweep`. None has a DOM method, so
// every case is an ActionManager event (keys recorded in params.am).
// Several run only on 8-bit documents in Photoshop: such a case converts
// the duplicate to 8 bits, applies, converts back to 16 and says so in
// params.eight_bit (the replay then allows the 8-bit quantisation).
(function () {
  var P = PagedProbe;
  P.begin("filters-stylize");
  var src = P.open("stimuli/colour-sweep.png");
  function am(params, event, entries) {
    return function (d) {
      try {
        P.exec(event, entries);
      } catch (e) {
        d.bitsPerChannel = BitsPerChannelType.EIGHT;
        P.exec(event, entries);
        d.bitsPerChannel = BitsPerChannelType.SIXTEEN;
        params.eight_bit = true;
      }
    };
  }
  function c(id, params, event, entries) {
    params.am = event;
    P.run(id, src, params, am(params, event, entries));
  }
  P.run("identity", src, {}, function (d) {});
  c("solarize", {}, "Slrz", []);
  c("trace-contour-128-lower", { level: 128, edge: "lower" }, "TrcC", [["Lvl ", "int", 128], ["Edg ", "enum", ["CntE", "Lwr "]]]);
  c("trace-contour-128-upper", { level: 128, edge: "upper" }, "TrcC", [["Lvl ", "int", 128], ["Edg ", "enum", ["CntE", "Upr "]]]);
  c("wind-right", { method: "wind", direction: "from-right" }, "Wnd ", [["WndM", "enum", ["WndM", "Wnd "]], ["Drct", "enum", ["Drct", "Rght"]]]);
  c("wind-blast-left", { method: "blast", direction: "from-left" }, "Wnd ", [["WndM", "enum", ["WndM", "Blst"]], ["Drct", "enum", ["Drct", "Left"]]]);
  c("tiles-8-10-bg", { tiles: 8, max_offset: 10, fill: "background", compare: "stats" }, "Tls ", [["TlNm", "int", 8], ["TlOf", "int", 10], ["FlCl", "enum", ["FlCl", "BckC"]]]);
  c("extrude-blocks-16-20-level", { kind: "blocks", size: 16, depth: 20, depth_mode: "level", solid_front: true, mask_incomplete: false }, "Extr", [["ExtT", "enum", ["ExtT", "Blks"]], ["ExtS", "int", 16], ["ExtD", "int", 20], ["ExtR", "enum", ["ExtR", "LvlB"]], ["ExtF", "bool", true], ["ExtM", "bool", false]]);
  c("extrude-pyramids-16-20-level", { kind: "pyramids", size: 16, depth: 20, depth_mode: "level", solid_front: false, mask_incomplete: false }, "Extr", [["ExtT", "enum", ["ExtT", "Pyrm"]], ["ExtS", "int", 16], ["ExtD", "int", 20], ["ExtR", "enum", ["ExtR", "LvlB"]], ["ExtF", "bool", false], ["ExtM", "bool", false]]);
  return P.finish([src]);
})();
