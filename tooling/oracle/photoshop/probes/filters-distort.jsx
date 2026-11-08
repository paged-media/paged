// Distort filters (WP5.2) applied to `colour-sweep` (16-bit RGB).
// DOM methods where the ArtLayer has one (applyPolarCoordinates,
// applyRipple, applyZigZag, applyShear, applyDisplace). The Displace map
// is the stimulus itself, saved by the probe as an 8-bit PSD in the staging dir:
// channel 1 (red) drives the horizontal shift, channel 2 (green) the
// vertical one, 128 = no shift.
(function () {
  var P = PagedProbe;
  P.begin("filters-distort");
  var src = P.open("stimuli/colour-sweep.png");
  function L(d) {
    return d.activeLayer;
  }
  P.run("identity", src, {}, function (d) {});
  P.run("polar-rect-to-polar", src, { conversion: "rect-to-polar" }, function (d) {
    L(d).applyPolarCoordinates(PolarConversionType.RECTANGULARTOPOLAR);
  });
  P.run("polar-polar-to-rect", src, { conversion: "polar-to-rect" }, function (d) {
    L(d).applyPolarCoordinates(PolarConversionType.POLARTORECTANGULAR);
  });
  P.run("ripple-100-medium", src, { amount: 100, size: "medium" }, function (d) {
    L(d).applyRipple(100, RippleSize.MEDIUM);
  });
  P.run("ripple-300-large", src, { amount: 300, size: "large" }, function (d) {
    L(d).applyRipple(300, RippleSize.LARGE);
  });
  P.run("zigzag-30-5-around", src, { amount: 30, ridges: 5, style: "around-centre" }, function (d) {
    L(d).applyZigZag(30, 5, ZigZagType.AROUNDCENTER);
  });
  P.run("zigzag-30-5-out", src, { amount: 30, ridges: 5, style: "out-from-centre" }, function (d) {
    L(d).applyZigZag(30, 5, ZigZagType.OUTFROMCENTER);
  });
  P.run("zigzag-30-5-pond", src, { amount: 30, ridges: 5, style: "pond-ripples" }, function (d) {
    L(d).applyZigZag(30, 5, ZigZagType.PONDRIPPLES);
  });
  P.run("shear-bow-wrap", src, { curve: [[0, 0], [32, 128], [0, 255]], undefined_areas: "wrap" }, function (d) {
    L(d).applyShear([[0, 0], [32, 128], [0, 255]], UndefinedAreas.WRAPAROUND);
  });
  var map = src.duplicate("displace-map", false);
  app.activeDocument = map;
  // Displace reads an 8-bit map (a 16-bit PSD is refused as "cancelled").
  map.bitsPerChannel = BitsPerChannelType.EIGHT;
  var mapFile = new File(PAGED_STAGE + "/filters-distort/displace-map.psd");
  var po = new PhotoshopSaveOptions();
  map.saveAs(mapFile, po, true, Extension.LOWERCASE);
  map.close(SaveOptions.DONOTSAVECHANGES);
  var c = P.run("displace-10-10-stretch-repeat", src, { horizontal: 10, vertical: 10, map: "colour-sweep (self)", fit: "stretch", undefined_areas: "repeat" }, function (d) {
    L(d).applyDisplace(10, 10, DisplacementMapType.STRETCHTOFIT, UndefinedAreas.REPEATEDGEPIXELS, mapFile);
  });
  c.files = ["filters-distort/displace-map.psd"];
  return P.finish([src]);
})();
