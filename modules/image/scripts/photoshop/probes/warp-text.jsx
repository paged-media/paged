// WARP TEXT, as Photoshop bends type (WP5.10): one line of type, set in
// each of the fifteen Warp Text styles at +50 % and -50 % bend (and two
// distortion cases), recorded as the warped layer's BOUNDS and saved as a
// layered PSD (its TySh warp descriptor is what the import reads). A 300
// ppi document records how a type layer's size and transform are stored
// at a resolution other than 72 ppi.
//
// The replay (image-conformance/tests/it/warp_text_photoshop.rs) reads each
// PSD's warp back as the style that made it, and holds paged-warp's mesh
// extent to Photoshop's bounds as a CONVENTION with a recorded distance:
// the styles are paged-warp's own closed forms, not Photoshop's meshes.
(function () {
  var P = PagedProbe;
  var st = P.begin("warp-text");
  var styles = [
    ["arc", WarpStyle.ARC],
    ["arcLower", WarpStyle.ARCLOWER],
    ["arcUpper", WarpStyle.ARCUPPER],
    ["arch", WarpStyle.ARCH],
    ["bulge", WarpStyle.BULGE],
    ["shellLower", WarpStyle.SHELLLOWER],
    ["shellUpper", WarpStyle.SHELLUPPER],
    ["flag", WarpStyle.FLAG],
    ["wave", WarpStyle.WAVE],
    ["fish", WarpStyle.FISH],
    ["rise", WarpStyle.RISE],
    ["fishEye", WarpStyle.FISHEYE],
    ["inflate", WarpStyle.INFLATE],
    ["squeeze", WarpStyle.SQUEEZE],
    ["twist", WarpStyle.TWIST]
  ];

  function black() {
    var c = new SolidColor();
    c.rgb.red = 0;
    c.rgb.green = 0;
    c.rgb.blue = 0;
    return c;
  }

  function px(v) {
    return Number(v.as("px"));
  }

  function bounds(l) {
    var b = l.bounds;
    return [px(b[0]), px(b[1]), px(b[2]), px(b[3])];
  }

  function one(id, params, ppi, warp) {
    var c = { id: id, params: params };
    var d = null;
    try {
      d = app.documents.add(480, 240, ppi, id, NewDocumentMode.RGB, DocumentFill.WHITE);
      var l = d.artLayers.add();
      l.kind = LayerKind.TEXT;
      var t = l.textItem;
      t.font = "MyriadPro-Regular";
      t.contents = "WARP TEXT";
      t.size = new UnitValue(params.size, "px");
      t.color = black();
      t.position = [new UnitValue(60, "px"), new UnitValue(140, "px")];
      var flat = bounds(l);
      if (warp !== null) {
        t.warpStyle = warp;
        t.warpBend = params.bend;
        t.warpHorizontalDistortion = params.horizontal;
        t.warpVerticalDistortion = params.vertical;
        t.warpDirection = params.vertical_orientation ? Direction.VERTICAL : Direction.HORIZONTAL;
      }
      c.values = { flat_bounds: flat, warped_bounds: bounds(l) };
      var psd = new PhotoshopSaveOptions();
      psd.layers = true;
      psd.embedColorProfile = false;
      psd.alphaChannels = false;
      d.saveAs(new File(PAGED_STAGE + "/warp-text/" + id + ".psd"), psd, true, Extension.LOWERCASE);
      c.files = ["warp-text/" + id + ".psd"];
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

  new Folder(PAGED_STAGE + "/warp-text").create();
  // Every length is a UnitValue in px, so no ruler or type unit
  // preference is read or changed.
  {
    one("none", { style: "none", bend: 0, horizontal: 0, vertical: 0, size: 48 }, 72, null);
    var i;
    for (i = 0; i < styles.length; i++) {
      one(styles[i][0] + "-50", { style: styles[i][0], bend: 50, horizontal: 0, vertical: 0, size: 48 }, 72, styles[i][1]);
      one(styles[i][0] + "-minus-50", { style: styles[i][0], bend: -50, horizontal: 0, vertical: 0, size: 48 }, 72, styles[i][1]);
    }
    one("arc-distorted", { style: "arc", bend: 30, horizontal: 40, vertical: -20, size: 48 }, 72, WarpStyle.ARC);
    one("flag-vertical", { style: "flag", bend: 50, horizontal: 0, vertical: 0, size: 48, vertical_orientation: true }, 72, WarpStyle.FLAG);
    one("none-300ppi", { style: "none", bend: 0, horizontal: 0, vertical: 0, size: 48 }, 300, null);
  }
  return P.finish([]);
})();
