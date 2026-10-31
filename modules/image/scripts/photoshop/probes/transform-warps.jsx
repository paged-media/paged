// TRANSFORM AND WARP ON PIXELS (WP5.6, image ADR 483): the `colour-sweep`
// stimulus as a normal layer (the Background unlocked), transformed through
// the ActionManager's Transform event (`Trnf`, ScriptListener keys):
//
//   * Warp: the `warp` object, keyed by the STRING id "warp" (the char
//     id 'warp' is accepted and silently ignored) (`warpStyle`, `warpValue`, `warpPerspective`,
//     `warpPerspectiveOther`, `warpRotate`) over the whole layer, each of
//     the fifteen styles at +50 % bend;
//   * Content-Aware Scale: `Wdth` 75 % with `contentAware`, and the same
//     scale without it (the plain scale, so the replay can tell them apart).
//
// What the transform leaves uncovered is transparent; the flatten puts it on
// white.
//
// NOT RECORDED: Distort and Perspective. Trnf accepts and IGNORES every
// corner form tried (`nonAffineTransform` as Pnt objects, doubles or px unit
// doubles, `quadCorners`, `quadrilateral`, `corners`; a `warpCustom` mesh
// too) -- the layer comes back untouched, which a recording would have
// passed off as Photoshop's answer. A homography is fixed by its corners, so
// those two are held to the maths instead (family_geom.rs,
// paged-warp's from_quads). The replay is image-conformance/tests/it/transform_warps_photoshop.rs.
(function () {
  var P = PagedProbe;
  P.begin("transform-warps");
  var src = P.open("stimuli/colour-sweep.png");
  var c = P.cid;
  function layer(d) {
    var l = d.activeLayer;
    if (l.isBackgroundLayer) l.isBackgroundLayer = false;
    return l;
  }
  function target() {
    var r = new ActionReference();
    r.putEnumerated(c("Lyr "), c("Ordn"), c("Trgt"));
    var d = new ActionDescriptor();
    d.putReference(c("null"), r);
    d.putEnumerated(c("FTcs"), c("QCSt"), c("Qcsa"));
    return d;
  }
  function warp(style, bend) {
    var d = target();
    var w = new ActionDescriptor();
    w.putEnumerated(c("warpStyle"), c("warpStyle"), c(style));
    w.putDouble(c("warpValue"), bend);
    w.putDouble(c("warpPerspective"), 0);
    w.putDouble(c("warpPerspectiveOther"), 0);
    w.putEnumerated(c("warpRotate"), c("Ornt"), c("Hrzn"));
    d.putObject(stringIDToTypeID("warp"), stringIDToTypeID("warp"), w);
    d.putEnumerated(c("Intr"), c("Intp"), c("Bcbc"));
    executeAction(c("Trnf"), d, DialogModes.NO);
  }
  function scaleWidth(pct, aware) {
    var d = target();
    d.putUnitDouble(c("Wdth"), c("#Prc"), pct);
    if (aware) d.putBoolean(c("contentAware"), true);
    d.putEnumerated(c("Intr"), c("Intp"), c("Bcbc"));
    executeAction(c("Trnf"), d, DialogModes.NO);
  }
  P.run("identity", src, {}, function (d) {
    layer(d);
  });
  var styles = [
    ["arc", "warpArc"], ["arcLower", "warpArcLower"], ["arcUpper", "warpArcUpper"],
    ["arch", "warpArch"], ["bulge", "warpBulge"], ["shellLower", "warpShellLower"],
    ["shellUpper", "warpShellUpper"], ["flag", "warpFlag"], ["wave", "warpWave"],
    ["fish", "warpFish"], ["rise", "warpRise"], ["fishEye", "warpFisheye"],
    ["inflate", "warpInflate"], ["squeeze", "warpSqueeze"], ["twist", "warpTwist"]
  ];
  var i;
  for (i = 0; i < styles.length; i++) {
    (function (s) {
      P.run("warp-" + s[0] + "-50", src, { style: s[0], bend: 50 }, function (d) {
        layer(d);
        warp(s[1], 50);
      });
    })(styles[i]);
  }
  P.run("content-aware-scale-w75", src, { width_percent: 75, content_aware: true }, function (d) {
    layer(d);
    scaleWidth(75, true);
  });
  P.run("plain-scale-w75", src, { width_percent: 75, content_aware: false }, function (d) {
    layer(d);
    scaleWidth(75, false);
  });
  return P.finish([src]);
})();
