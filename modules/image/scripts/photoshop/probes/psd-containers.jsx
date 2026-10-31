// The document STRUCTURES a layered PSD save writes, written by
// Photoshop itself: a 16-bit layered document (its layers live in the
// `Lr16` document block), a PSB (the widened length fields), a CMYK
// layered document and an EMBEDDED smart object (`PlLd`/`SoLd`, the
// source in `lnk2`). paged-psd's writer is held to these layouts
// (image-js tests/it/psd_write.rs, image-conformance tests/it/
// psd_write_photoshop.rs). A LINKED smart object is not recorded: its
// `lnkE` block stores the absolute path of the linked file, a temporary
// path of the recording machine.
//
// "Maximize compatibility" is what makes Photoshop write the merged
// composite; the preference is set for the run and restored after.
(function () {
  var P = PagedProbe;
  var st = P.begin("psd-containers");
  var prevCompat = app.preferences.maximizeCompatibility;
  app.preferences.maximizeCompatibility = QueryStateType.ALWAYS;
  st.maximize_compatibility_was = String(prevCompat);
  var cid = P.cid;
  function sid(s) {
    return stringIDToTypeID(s);
  }
  var DIR = PAGED_STAGE + "/psd-containers/";

  function fillRect(d, rect, c) {
    var col = new SolidColor();
    col.rgb.red = c[0];
    col.rgb.green = c[1];
    col.rgb.blue = c[2];
    d.selection.select(rect);
    d.selection.fill(col);
    d.selection.deselect();
  }
  function curvesLayer() {
    var d = new ActionDescriptor();
    var r = new ActionReference();
    r.putClass(cid("AdjL"));
    d.putReference(cid("null"), r);
    var u = new ActionDescriptor();
    var t = new ActionDescriptor();
    t.putEnumerated(cid("Prst"), cid("Prst"), cid("Cstm"));
    var adjs = new ActionList();
    var c = new ActionDescriptor();
    var ch = new ActionReference();
    ch.putEnumerated(cid("Chnl"), cid("Chnl"), cid("Cmps"));
    c.putReference(cid("Chnl"), ch);
    var pts = new ActionList();
    var xy = [[0, 0], [128, 160], [255, 255]];
    var i;
    for (i = 0; i < xy.length; i++) {
      var p = new ActionDescriptor();
      p.putDouble(cid("Hrzn"), xy[i][0]);
      p.putDouble(cid("Vrtc"), xy[i][1]);
      pts.putObject(cid("Pnt "), p);
    }
    c.putList(cid("Crv "), pts);
    adjs.putObject(cid("CrvA"), c);
    t.putList(cid("Adjs"), adjs);
    u.putObject(cid("Type"), cid("Crvs"), t);
    d.putObject(cid("Usng"), cid("AdjL"), u);
    executeAction(cid("Mk  "), d, DialogModes.NO);
  }
  function addPixelLayer(d) {
    var l = d.artLayers.add();
    l.name = "square";
    fillRect(d, [[32, 32], [96, 32], [96, 96], [32, 96]], [200, 60, 30]);
    return l;
  }
  function savePsd(d, id) {
    var psd = new PhotoshopSaveOptions();
    psd.layers = true;
    psd.embedColorProfile = true;
    psd.alphaChannels = false;
    d.saveAs(new File(DIR + id + ".psd"), psd, true, Extension.LOWERCASE);
    return "psd-containers/" + id + ".psd";
  }
  function savePsb(d, id) {
    var desc = new ActionDescriptor();
    var o = new ActionDescriptor();
    o.putBoolean(sid("maximizeCompatibility"), true);
    desc.putObject(cid("As  "), sid("largeDocumentFormat"), o);
    desc.putPath(cid("In  "), new File(DIR + id + ".psb"));
    desc.putBoolean(cid("Cpy "), true);
    executeAction(cid("save"), desc, DialogModes.NO);
    return "psd-containers/" + id + ".psb";
  }
  function savePng8(d, id) {
    var png = new PNGSaveOptions();
    png.compression = 9;
    d.saveAs(new File(DIR + id + ".png"), png, true, Extension.LOWERCASE);
    return "psd-containers/" + id + ".png";
  }

  function stack(id, params, build) {
    var c = { id: id, params: params };
    var d = null;
    try {
      d = P.open("stimuli/colour-sweep.png");
      c.files = build(d);
      c.profile = P.profileOf(d);
      c.bits = d.bitsPerChannel == BitsPerChannelType.SIXTEEN ? 16 : 8;
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
    stack("sixteen-bit", { depth: 16, layers: ["Background", "square", "Curves"] }, function (d) {
      addPixelLayer(d);
      curvesLayer();
      return [savePsd(d, "sixteen-bit"), savePng8(d, "sixteen-bit")];
    });
    stack("psb", { depth: 8, layers: ["Background", "square", "Curves"] }, function (d) {
      d.bitsPerChannel = BitsPerChannelType.EIGHT;
      addPixelLayer(d);
      curvesLayer();
      var f = [savePsb(d, "psb")];
      f.push(savePng8(d, "psb"));
      return f;
    });
    stack("cmyk", { mode: "CMYK (Coated FOGRA39)", layers: ["Background", "square"] }, function (d) {
      d.bitsPerChannel = BitsPerChannelType.EIGHT;
      addPixelLayer(d);
      d.convertProfile("Coated FOGRA39 (ISO 12647-2:2004)", Intent.RELATIVECOLORIMETRIC, true, false);
      return [savePsd(d, "cmyk")];
    });
    stack("smart-embedded", { what: "the square converted to an embedded smart object" }, function (d) {
      d.bitsPerChannel = BitsPerChannelType.EIGHT;
      addPixelLayer(d);
      executeAction(sid("newPlacedLayer"), undefined, DialogModes.NO);
      return [savePsd(d, "smart-embedded"), savePng8(d, "smart-embedded")];
    });
  } finally {
    app.preferences.maximizeCompatibility = prevCompat;
  }
  return P.finish([]);
})();
