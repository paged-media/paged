// Photoshop READS the smart objects paged WRITES (image ADR 482): every
// PSD the layered save wrote for a case (image-conformance tests/it/
// smart_objects_photoshop.rs, `write_smart_readback_inputs`, into
// <stage>/smart-readback/ with a manifest of file name and content hash)
// is OPENED, and Photoshop reports, per smart object:
//   * that it IS one (the layer's `smartObject` descriptor), its corners
//     (`smartObjectMore.transform` / `nonAffineTransform`), its size and
//     its smart filters (`filterFX`);
//   * its CONTENTS: `placedLayerEditContents` opens the embedded document
//     paged wrote, whose size and layer count are recorded before it is
//     closed unchanged;
//   * its RENDER, made again by Photoshop from paged's record: the object
//     is scaled to 50 % and back to 200 % about its centre (the corners
//     end where they were; Photoshop re-renders from the source on each
//     step) and each smart filter is switched off and on again (it runs
//     again); the composite is saved as an 8-bit PNG.
// The replay holds each report to what was written and Photoshop's render
// of paged's record to paged's own render.
//
// Run with the inputs staged first (the replay's module docs):
//   PAGED_SMART_READBACK_OUT=<stage>/smart-readback cargo nextest run \
//     -p image-conformance --run-ignored only write_smart_readback_inputs
//   PAGED_PROBE_STAGE=<stage> bash scripts/photoshop/run-probe.sh \
//     scripts/photoshop/probes/smart-readback.jsx
(function () {
  var P = PagedProbe;
  var st = P.begin("smart-readback");
  var cid = P.cid;
  var DIR = PAGED_STAGE + "/smart-readback/";
  function sid(s) {
    return stringIDToTypeID(s);
  }
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
  function activeLayer() {
    var r = new ActionReference();
    r.putEnumerated(cid("Lyr "), cid("Ordn"), cid("Trgt"));
    return executeActionGet(r);
  }
  function smartReport() {
    var d = activeLayer();
    var o = { smart: d.hasKey(sid("smartObject")) };
    if (!o.smart) return o;
    var so = desc(d.getObjectValue(sid("smartObject")));
    o.placed = so.placed;
    o.file_reference = so.fileReference;
    o.filters = so.filterFX ? so.filterFX : [];
    if (d.hasKey(sid("smartObjectMore"))) {
      var more = desc(d.getObjectValue(sid("smartObjectMore")));
      o.transform = more.transform;
      o.non_affine = more.nonAffineTransform;
      o.size = more.size;
    }
    return o;
  }
  function setFilterVisible(index, on) {
    var d = new ActionDescriptor();
    var l = new ActionList();
    var r = new ActionReference();
    r.putIndex(sid("filterFX"), index);
    r.putEnumerated(cid("Lyr "), cid("Ordn"), cid("Trgt"));
    l.putReference(r);
    d.putList(cid("null"), l);
    executeAction(cid(on ? "Shw " : "Hd  "), d, DialogModes.NO);
  }
  function contents() {
    executeAction(sid("placedLayerEditContents"), new ActionDescriptor(), DialogModes.NO);
    var inner = app.activeDocument;
    var o = {
      name: inner.name,
      width: inner.width.as("px"),
      height: inner.height.as("px"),
      layers: inner.layers.length
    };
    inner.close(SaveOptions.DONOTSAVECHANGES);
    return o;
  }
  function savePng8(d, name) {
    var png = new PNGSaveOptions();
    png.compression = 9;
    d.saveAs(new File(DIR + name), png, true, Extension.LOWERCASE);
    return "smart-readback/" + name;
  }
  function readManifest() {
    var f = new File(DIR + "manifest.txt");
    if (!f.exists) throw new Error("no manifest.txt: stage the inputs first");
    f.open("r");
    var lines = [];
    while (!f.eof) {
      var line = f.readln();
      if (line.length > 0) lines.push(line.split("\t"));
    }
    f.close();
    return lines;
  }

  var entries = readManifest();
  var i, j;
  for (i = 0; i < entries.length; i++) {
    var name = entries[i][0];
    var c = { id: name.replace(".psd", ""), params: { file: name, hash: entries[i][1] } };
    var d = null;
    try {
      d = app.open(new File(DIR + name));
      var report = { layers: [] };
      for (j = 0; j < d.layers.length; j++) {
        var l = d.layers[j];
        d.activeLayer = l;
        var row = { name: l.name, kind: String(l.kind) };
        var so = smartReport();
        if (so.smart) {
          row.smart = so;
          row.contents = contents();
          d.activeLayer = l;
          // Photoshop draws the object again from paged's record.
          l.resize(50, 50, AnchorPosition.MIDDLECENTER);
          l.resize(200, 200, AnchorPosition.MIDDLECENTER);
          var k;
          for (k = 1; k <= so.filters.length; k++) {
            if (so.filters[k - 1].enabled) {
              setFilterVisible(k, false);
              setFilterVisible(k, true);
            }
          }
          var again = smartReport();
          row.after = again.transform;
          row.after_non_affine = again.non_affine;
        }
        report.layers.push(row);
      }
      c.values = report;
      c.files = [savePng8(d, c.id + ".png")];
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
  return P.finish([]);
})();
