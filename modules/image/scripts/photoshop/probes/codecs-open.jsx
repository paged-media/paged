// Does Photoshop open what paged-raster writes and reads? (engine ADR
// 1038, WP9.4). The files are NOT Photoshop's: `paged-raster`'s example
// `oracle_files` writes them into the staging dir before the run
// (PAGED_PROBE_STAGE, see README.md):
//
//   codecs-open/layered.tif      a PSD's layers written as a TIFF (tag 37724)
//   codecs-open/scene.hdr        scene-linear patches, Radiance RGBE
//   codecs-open/scene.exr        the same patches, OpenEXR float RGB
//   codecs-open/scene-alpha.exr  the same with a float alpha ramp
//
// For the layered TIFF it records the layers Photoshop reads back (name,
// opacity, blend mode, visibility, bounds), colour samples of the
// composite, and a sample of each layer shown alone (opacity 100, Normal).
// For the floats it saves what Photoshop read as an uncompressed 32-bit
// float TIFF (no profile, transparency kept), which the replay decodes
// and holds to paged-raster's own reading of the source file.
(function () {
  var P = PagedProbe;
  var st = P.begin("codecs-open");
  var DIR = "codecs-open/";

  function openStaged(rel) {
    var f = new File(PAGED_STAGE + "/" + rel);
    if (!f.exists) throw new Error("missing input " + rel + " (run the oracle_files example first)");
    return app.open(f);
  }
  function bitsOf(d) {
    if (d.bitsPerChannel == BitsPerChannelType.THIRTYTWO) return 32;
    if (d.bitsPerChannel == BitsPerChannelType.SIXTEEN) return 16;
    return 8;
  }
  function px(v) {
    return Number(String(v).replace(" px", ""));
  }
  function sample(d, x, y) {
    var s = d.colorSamplers.add([UnitValue(x + 0.5, "px"), UnitValue(y + 0.5, "px")]);
    var c = s.color.rgb;
    var out = [x, y, c.red, c.green, c.blue];
    s.remove();
    return out;
  }
  function blendName(m) {
    return String(m).replace("BlendMode.", "");
  }

  function layered(id, rel, points) {
    var c = { id: id, params: { file: rel }, files: [rel], values: {} };
    var d = null;
    try {
      d = openStaged(rel);
      var v = c.values;
      v.width = d.width.as("px");
      v.height = d.height.as("px");
      v.mode = String(d.mode);
      v.bits = bitsOf(d);
      v.layers = [];
      var i, j, l, b;
      for (i = 0; i < d.layers.length; i++) {
        l = d.layers[i];
        b = l.bounds;
        v.layers.push({
          name: l.name,
          opacity: l.opacity,
          blend: blendName(l.blendMode),
          visible: l.visible,
          bounds: [px(b[0]), px(b[1]), px(b[2]), px(b[3])]
        });
      }
      v.composite = [];
      for (i = 0; i < points.length; i++) v.composite.push(sample(d, points[i][0], points[i][1]));
      // Each layer alone, opaque and Normal, sampled at its bounds' centre.
      v.alone = [];
      for (i = 0; i < d.layers.length; i++) {
        for (j = 0; j < d.layers.length; j++) d.layers[j].visible = j === i;
        l = d.layers[i];
        l.opacity = 100;
        l.blendMode = BlendMode.NORMAL;
        b = l.bounds;
        v.alone.push(
          [l.name].concat(
            sample(d, Math.floor((px(b[0]) + px(b[2])) / 2), Math.floor((px(b[1]) + px(b[3])) / 2))
          )
        );
      }
      c.profile = P.profileOf(d);
      c.bits = v.bits;
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

  function floats(id, rel) {
    var c = { id: id, params: { file: rel }, files: [rel], values: {} };
    var d = null;
    try {
      d = openStaged(rel);
      var v = c.values;
      v.width = d.width.as("px");
      v.height = d.height.as("px");
      v.mode = String(d.mode);
      v.bits = bitsOf(d);
      v.layers = d.layers.length;
      v.channels = d.channels.length;
      v.transparent = !d.layers[0].isBackgroundLayer;
      c.profile = P.profileOf(d);
      c.bits = v.bits;
      var o = new TiffSaveOptions();
      o.imageCompression = TIFFEncoding.NONE;
      o.byteOrder = ByteOrder.IBM;
      o.embedColorProfile = false;
      o.alphaChannels = true;
      o.layers = false;
      o.transparency = true;
      var out = DIR + id + ".photoshop.tif";
      d.saveAs(new File(PAGED_STAGE + "/" + out), o, true, Extension.LOWERCASE);
      c.files.push(out);
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

  layered("layered-tiff", DIR + "layered.tif", [
    [5, 5],
    [100, 100],
    [200, 150],
    [300, 200],
    [395, 295]
  ]);
  floats("radiance-hdr", DIR + "scene.hdr");
  floats("openexr", DIR + "scene.exr");
  floats("openexr-alpha", DIR + "scene-alpha.exr");

  return P.finish([]);
})();
