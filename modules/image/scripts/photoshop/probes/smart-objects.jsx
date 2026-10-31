// SMART OBJECTS as Photoshop writes them (image ADR 482, WP5.14): an
// embedded smart object made from a textured square of the colour-sweep
// stimulus, then
//   * TRANSFORMED non-destructively (scale, rotate, move; skew; flip) --
//     the layer's `SoLd` keeps the source corners (`Trnf`) and the layer
//     pixels are Photoshop's render of the source through them;
//   * given SMART FILTERS (Gaussian Blur; Gaussian Blur under a Motion
//     Blur that is switched off; a filter mask that hides the blur on the
//     left half; a blur after a transform) -- the `filterFX` list in
//     `SoLd`, the filter mask in the record's extra channel;
//   * EDITED THROUGH ITS CONTENTS: the embedded document opened
//     (`placedLayerEditContents`), a red square filled into it, saved and
//     closed, so the parent re-renders from the new source.
// Every case saves the layered PSD and an 8-bit PNG of the composite, and
// records what the ActionManager says about the smart object (its
// transform corners, size, the filter list). The replay
// (image-conformance tests/it/smart_objects_photoshop.rs) renders each
// smart object from its EMBEDDED source through the recorded transform
// and filters and holds it to Photoshop's stored layer render.
//
// "Maximize compatibility" is set for the run (restored after) so every
// PSD carries its merged composite.
(function () {
  var P = PagedProbe;
  var st = P.begin("smart-objects");
  var prevCompat = app.preferences.maximizeCompatibility;
  app.preferences.maximizeCompatibility = QueryStateType.ALWAYS;
  st.maximize_compatibility_was = String(prevCompat);
  var cid = P.cid;
  function sid(s) {
    return stringIDToTypeID(s);
  }
  var DIR = PAGED_STAGE + "/smart-objects/";

  // -- the descriptor reader psd-readback uses ---------------------------
  function key(id) {
    var s = "";
    try {
      s = typeIDToStringID(id);
    } catch (e) {
      s = "";
    }
    if (!s) {
      try {
        s = typeIDToCharID(id);
      } catch (e2) {
        s = String(id);
      }
    }
    return s;
  }
  function value(get, t, k) {
    if (t == DescValueType.INTEGERTYPE) return get.getInteger(k);
    if (t == DescValueType.DOUBLETYPE) return get.getDouble(k);
    if (t == DescValueType.UNITDOUBLE) return get.getUnitDoubleValue(k);
    if (t == DescValueType.BOOLEANTYPE) return get.getBoolean(k);
    if (t == DescValueType.STRINGTYPE) return get.getString(k);
    if (t == DescValueType.ENUMERATEDTYPE) return key(get.getEnumerationValue(k));
    if (t == DescValueType.OBJECTTYPE) return desc(get.getObjectValue(k));
    if (t == DescValueType.LISTTYPE) return list(get.getList(k));
    if (t == DescValueType.CLASSTYPE) return key(get.getClass(k));
    if (t == DescValueType.RAWTYPE) return "raw";
    if (t == DescValueType.REFERENCETYPE) return "reference";
    if (t == DescValueType.ALIASTYPE) return "alias";
    return String(t);
  }
  function desc(d) {
    var o = {};
    var i, k;
    for (i = 0; i < d.count; i++) {
      k = d.getKey(i);
      o[key(k)] = value(d, d.getType(k), k);
    }
    return o;
  }
  function list(l) {
    var a = [];
    var i;
    for (i = 0; i < l.count; i++) a.push(value(l, l.getType(i), i));
    return a;
  }
  /** The active layer's descriptor, through the ActionManager. */
  function activeLayer() {
    var r = new ActionReference();
    r.putEnumerated(cid("Lyr "), cid("Ordn"), cid("Trgt"));
    return executeActionGet(r);
  }
  /** What the ActionManager says about the active smart object. */
  function smartReport() {
    var d = activeLayer();
    var o = {};
    if (d.hasKey(sid("smartObject"))) {
      var so = desc(d.getObjectValue(sid("smartObject")));
      o.smart_object = {
        placed: so.placed,
        file_reference: so.fileReference,
        link_changed: so.linkChanged,
        filters: so.filterFX ? so.filterFX.length : 0
      };
      if (so.filterFX) o.filter_fx = so.filterFX;
    }
    if (d.hasKey(sid("smartObjectMore"))) {
      var more = desc(d.getObjectValue(sid("smartObjectMore")));
      o.transform = more.transform;
      o.non_affine = more.nonAffineTransform;
      o.size = more.size;
      o.resolution = more.resolution;
      o.type = more.type;
    }
    return o;
  }

  function fillRect(d, rect, c) {
    var col = new SolidColor();
    col.rgb.red = c[0];
    col.rgb.green = c[1];
    col.rgb.blue = c[2];
    d.selection.select(rect);
    d.selection.fill(col);
    d.selection.deselect();
  }
  /** A 64 x 64 textured square of the stimulus at (16, 16) as its own
   *  layer, turned into an embedded smart object. */
  function makeSmart(d) {
    d.bitsPerChannel = BitsPerChannelType.EIGHT;
    d.selection.select([[16, 16], [80, 16], [80, 80], [16, 80]]);
    d.selection.copy();
    d.selection.deselect();
    var l = d.paste();
    l.name = "art";
    // A mark in one corner, so a flip or a turn is visible.
    fillRect(d, [[16, 16], [32, 16], [32, 28], [16, 28]], [230, 30, 30]);
    executeAction(sid("newPlacedLayer"), undefined, DialogModes.NO);
    return d.activeLayer;
  }
  function skew(hDeg, vDeg) {
    var t = new ActionDescriptor();
    var r = new ActionReference();
    r.putEnumerated(cid("Lyr "), cid("Ordn"), cid("Trgt"));
    t.putReference(cid("null"), r);
    t.putEnumerated(cid("FTcs"), cid("QCSt"), cid("Qcsa"));
    var s = new ActionDescriptor();
    s.putUnitDouble(cid("Hrzn"), cid("#Ang"), hDeg);
    s.putUnitDouble(cid("Vrtc"), cid("#Ang"), vDeg);
    t.putObject(cid("Skew"), cid("Pnt "), s);
    executeAction(cid("Trnf"), t, DialogModes.NO);
  }
  /** Select the active smart object's filter mask, for painting. */
  function selectFilterMask() {
    var d = new ActionDescriptor();
    var r = new ActionReference();
    r.putEnumerated(cid("Chnl"), cid("Chnl"), sid("filterMask"));
    d.putReference(cid("null"), r);
    d.putBoolean(cid("MkVs"), false);
    executeAction(cid("slct"), d, DialogModes.NO);
  }
  function selectRgb() {
    var d = new ActionDescriptor();
    var r = new ActionReference();
    r.putEnumerated(cid("Chnl"), cid("Chnl"), cid("RGB "));
    d.putReference(cid("null"), r);
    executeAction(cid("slct"), d, DialogModes.NO);
  }
  /** Switch smart filter `index` (1-based, bottom first) of the active
   *  layer off. */
  function hideFilter(index) {
    var d = new ActionDescriptor();
    var list = new ActionList();
    var r = new ActionReference();
    r.putIndex(sid("filterFX"), index);
    r.putEnumerated(cid("Lyr "), cid("Ordn"), cid("Trgt"));
    list.putReference(r);
    d.putList(cid("null"), list);
    executeAction(cid("Hd  "), d, DialogModes.NO);
  }
  function editContents(body) {
    executeAction(sid("placedLayerEditContents"), new ActionDescriptor(), DialogModes.NO);
    var inner = app.activeDocument;
    var info = {
      name: inner.name,
      width: inner.width.as("px"),
      height: inner.height.as("px"),
      layers: inner.layers.length
    };
    body(inner);
    inner.close(SaveOptions.SAVECHANGES);
    return info;
  }

  function savePsd(d, id) {
    var psd = new PhotoshopSaveOptions();
    psd.layers = true;
    psd.embedColorProfile = true;
    psd.alphaChannels = false;
    d.saveAs(new File(DIR + id + ".psd"), psd, true, Extension.LOWERCASE);
    return "smart-objects/" + id + ".psd";
  }
  function savePng8(d, id) {
    var png = new PNGSaveOptions();
    png.compression = 9;
    d.saveAs(new File(DIR + id + ".png"), png, true, Extension.LOWERCASE);
    return "smart-objects/" + id + ".png";
  }

  function smartCase(id, params, build) {
    var c = { id: id, params: params };
    var d = null;
    try {
      d = P.open("stimuli/colour-sweep.png");
      makeSmart(d);
      var extra = build(d);
      c.values = smartReport();
      if (extra) c.values.extra = extra;
      c.files = [savePsd(d, id), savePng8(d, id)];
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

  new Folder(DIR).create();
  try {
    smartCase("so-plain", { what: "the smart object as made" }, function () {
      return null;
    });
    smartCase(
      "so-scale-rotate",
      { scale: [75, 75], rotate: 30, move: [10, -5] },
      function (d) {
        var l = d.activeLayer;
        l.resize(75, 75, AnchorPosition.MIDDLECENTER);
        l.rotate(30, AnchorPosition.MIDDLECENTER);
        l.translate(10, -5);
        return null;
      }
    );
    smartCase("so-skew", { scale: [120, 80], skew: [20, 0] }, function (d) {
      d.activeLayer.resize(120, 80, AnchorPosition.MIDDLECENTER);
      skew(20, 0);
      return null;
    });
    smartCase("so-flip", { scale: [-100, 100], move: [20, 30] }, function (d) {
      d.activeLayer.resize(-100, 100, AnchorPosition.MIDDLECENTER);
      d.activeLayer.translate(20, 30);
      return null;
    });
    smartCase("so-upscale", { scale: [180, 180] }, function (d) {
      d.activeLayer.resize(180, 180, AnchorPosition.MIDDLECENTER);
      return null;
    });
    smartCase("so-downscale-restore", { scale: [25, 25], then: [400, 400] }, function (d) {
      d.activeLayer.resize(25, 25, AnchorPosition.MIDDLECENTER);
      d.activeLayer.resize(400, 400, AnchorPosition.MIDDLECENTER);
      return null;
    });
    smartCase("sf-gaussian", { filters: [["gaussianBlur", 3]] }, function (d) {
      d.activeLayer.applyGaussianBlur(3);
      return null;
    });
    smartCase(
      "sf-stack",
      { filters: [["gaussianBlur", 2], ["motionBlur", 30, 10, "off"]] },
      function (d) {
        d.activeLayer.applyGaussianBlur(2);
        d.activeLayer.applyMotionBlur(30, 10);
        hideFilter(2);
        return null;
      }
    );
    smartCase(
      "sf-mask",
      { filters: [["gaussianBlur", 4]], mask: "left half hidden" },
      function (d) {
        d.activeLayer.applyGaussianBlur(4);
        selectFilterMask();
        fillRect(d, [[0, 0], [48, 0], [48, 128], [0, 128]], [0, 0, 0]);
        selectRgb();
        return null;
      }
    );
    smartCase(
      "sf-transformed",
      { scale: [75, 75], rotate: 30, filters: [["gaussianBlur", 2]] },
      function (d) {
        var l = d.activeLayer;
        l.resize(75, 75, AnchorPosition.MIDDLECENTER);
        l.rotate(30, AnchorPosition.MIDDLECENTER);
        l.applyGaussianBlur(2);
        return null;
      }
    );
    // One filter of each class paged maps (its Fltr descriptor's layout).
    smartCase("sf-box-blur", { filters: [["boxBlur", 3]] }, function () {
      var bd = new ActionDescriptor();
      bd.putUnitDouble(cid("Rds "), cid("#Pxl"), 3);
      executeAction(sid("boxblur"), bd, DialogModes.NO);
      return null;
    });
    smartCase("sf-high-pass", { filters: [["highPass", 2]] }, function (d) {
      d.activeLayer.applyHighPass(2);
      return null;
    });
    smartCase("sf-median", { filters: [["median", 2]] }, function (d) {
      d.activeLayer.applyMedianNoise(2);
      return null;
    });
    smartCase("sf-maximum", { filters: [["maximum", 2]] }, function (d) {
      d.activeLayer.applyMaximum(2);
      return null;
    });
    smartCase("sf-minimum", { filters: [["minimum", 2]] }, function (d) {
      d.activeLayer.applyMinimum(2);
      return null;
    });
    smartCase("sf-opacity", { filters: [["gaussianBlur", 3, "opacity 50"]] }, function (d) {
      d.activeLayer.applyGaussianBlur(3);
      // The filter's blending options: 50 % Normal.
      var bd = new ActionDescriptor();
      var r = new ActionReference();
      r.putIndex(sid("filterFX"), 1);
      r.putEnumerated(cid("Lyr "), cid("Ordn"), cid("Trgt"));
      bd.putReference(cid("null"), r);
      var fx = new ActionDescriptor();
      var bo = new ActionDescriptor();
      bo.putUnitDouble(cid("Opct"), cid("#Prc"), 50);
      bo.putEnumerated(cid("Md  "), cid("BlnM"), cid("Nrml"));
      fx.putObject(sid("blendOptions"), sid("blendOptions"), bo);
      bd.putObject(sid("filterFX"), sid("filterFX"), fx);
      executeAction(cid("setd"), bd, DialogModes.NO);
      return null;
    });
    smartCase(
      "so-edit-contents",
      { scale: [75, 75], edit: "red square at (40, 40) 16x16 in the contents" },
      function (d) {
        d.activeLayer.resize(75, 75, AnchorPosition.MIDDLECENTER);
        return editContents(function (inner) {
          fillRect(inner, [[40, 40], [56, 40], [56, 56], [40, 56]], [220, 20, 20]);
        });
      }
    );
  } finally {
    app.preferences.maximizeCompatibility = prevCompat;
  }
  return P.finish([]);
})();
