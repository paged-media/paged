// Photoshop READS what paged writes (image ADR 478): every PSD/PSB the
// layered save wrote for a case (image-conformance tests/it/
// psd_write_photoshop.rs, `write_psd_readback_inputs`, into
// <stage>/psd-readback/ with a manifest of file name and content hash) is
// OPENED, and Photoshop reports what it found:
//   * the document: mode, depth, layer count;
//   * every layer, top first: name, kind (LayerKind), opacity, fill
//     opacity, blend mode, visibility, clipping, the adjustment's
//     parameters (the layer's `adjustment` descriptor through the
//     ActionManager) and the style's effects (`layerEffects`);
//   * a PNG of its render (RGB documents, and the documents paged
//     converted to another mode: merged in that mode, then through
//     Photoshop's conversion to sRGB), saved beside it.
// The replay compares the report with what was written and Photoshop's
// render of a paged-written adjustment layer with its render of its own.
//
// Run with the inputs staged first (the replay's module docs):
//   PAGED_PROBE_STAGE=<stage> bash scripts/photoshop/run-probe.sh \
//     scripts/photoshop/probes/psd-readback.jsx
(function () {
  var P = PagedProbe;
  var st = P.begin("psd-readback");
  var DIR = PAGED_STAGE + "/psd-readback/";

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

  function layerInfo(l) {
    var o = {
      name: l.name,
      kind: l.typename == "LayerSet" ? "LayerSet" : String(l.kind),
      opacity: l.opacity,
      blend: String(l.blendMode),
      visible: l.visible
    };
    if (l.typename != "LayerSet") {
      o.fill_opacity = l.fillOpacity;
      o.clipped = l.grouped;
    }
    var ref = new ActionReference();
    ref.putIdentifier(charIDToTypeID("Lyr "), l.id);
    var d = executeActionGet(ref);
    var adj = stringIDToTypeID("adjustment");
    if (d.hasKey(adj)) {
      var al = d.getList(adj);
      if (al.count > 0) o.adjustment = desc(al.getObjectValue(0));
    }
    var fx = stringIDToTypeID("layerEffects");
    if (d.hasKey(fx)) o.effects = desc(d.getObjectValue(fx));
    var so = stringIDToTypeID("smartObject");
    if (d.hasKey(so)) {
      var sd = d.getObjectValue(so);
      o.smart = {
        linked: sd.hasKey(stringIDToTypeID("linked")) ? sd.getBoolean(stringIDToTypeID("linked")) : null,
        file: sd.hasKey(stringIDToTypeID("fileReference")) ? sd.getString(stringIDToTypeID("fileReference")) : null
      };
    }
    return o;
  }
  function walk(layers, out, depth) {
    var i, l, info;
    for (i = 0; i < layers.length; i++) {
      l = layers[i];
      info = layerInfo(l);
      info.depth = depth;
      out.push(info);
      if (l.typename == "LayerSet") walk(l.layers, out, depth + 1);
    }
  }

  var mf = new File(DIR + "manifest.txt");
  if (!mf.exists) throw new Error("no psd-readback/manifest.txt in the stage (see the probe header)");
  mf.open("r");
  var lines = mf.read().split("\n");
  mf.close();

  var i;
  for (i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    var parts = lines[i].split("\t");
    var file = parts[0];
    var id = file.replace(/\.ps[db]$/, "");
    var c = { id: id, params: { file: file, hash: parts[1] } };
    var d = null;
    try {
      d = app.open(new File(DIR + file));
      var ls = [];
      walk(d.layers, ls, 0);
      c.values = {
        document: {
          mode: String(d.mode),
          bits: String(d.bitsPerChannel),
          width: d.width.as("px"),
          height: d.height.as("px"),
          layers: ls.length
        },
        layers: ls
      };
      c.files = [];
      c.profile = P.profileOf(d);
      c.bits = d.bitsPerChannel == BitsPerChannelType.SIXTEEN ? 16 : 8;
      // A document paged CONVERTED (image ADR 481): Photoshop's render of
      // it in sRGB, through Photoshop's own conversion (relative
      // colorimetric, black-point compensation -- the Color Settings
      // default), on the open copy, which is closed unsaved.
      // Merged FIRST: converting a layered document converts each layer
      // and blends them again in RGB, which is not how the document
      // composites in its own mode (a CMYK document blends its inks).
      if (d.mode != DocumentMode.RGB && /^converted-/.test(id)) {
        d.flatten();
        d.convertProfile("sRGB IEC61966-2.1", Intent.RELATIVECOLORIMETRIC, true, false);
      }
      if (d.mode == DocumentMode.RGB) {
        var png = new PNGSaveOptions();
        png.compression = 9;
        d.saveAs(new File(DIR + id + ".png"), png, true, Extension.LOWERCASE);
        c.files.push("psd-readback/" + id + ".png");
      }
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
  return P.finish([]);
})();
