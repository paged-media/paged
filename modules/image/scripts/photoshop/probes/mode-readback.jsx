// Photoshop OPENS what paged's layered save writes in the modes and the
// depth of image ADR 483: a 32-bit document with two live layers, an
// Indexed one and a Multichannel one. The inputs are written by
// `write_mode_readback_inputs` (image-conformance, ignored test) into
// <stage>/mode-readback/ with a manifest of file names:
//
//   PAGED_MODE_READBACK_OUT=<stage>/mode-readback cargo nextest run \
//     -p image-conformance --run-ignored only write_mode_readback_inputs
//   PAGED_PROBE_STAGE=<stage> bash scripts/photoshop/run-probe.sh \
//     scripts/photoshop/probes/mode-readback.jsx
//
// Per file the probe records the document's mode, depth, layer count and
// channel names, then MERGES it in its own mode and depth (a duplicate,
// flattened) and saves that as a PSD: Photoshop's own composite of the
// file, in the file's numbers, which the replay holds ours to
// (`color_modes_photoshop.rs`).
(function () {
  var P = PagedProbe;
  var st = P.begin("mode-readback");
  var DIR = PAGED_STAGE + "/mode-readback/";
  var mf = new File(DIR + "manifest.txt");
  if (!mf.exists) throw new Error("no mode-readback/manifest.txt in the stage (see the probe header)");
  mf.open("r");
  var lines = mf.read().split("\n");
  mf.close();

  function bitsOf(d) {
    if (d.bitsPerChannel == BitsPerChannelType.THIRTYTWO) return 32;
    if (d.bitsPerChannel == BitsPerChannelType.SIXTEEN) return 16;
    return 8;
  }

  var i;
  for (i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    var file = lines[i];
    var id = file.replace(/\.psd$/, "");
    var c = { id: id, params: { file: file }, files: [] };
    var d = null;
    var dup = null;
    try {
      d = app.open(new File(DIR + file));
      var names = [];
      var k;
      for (k = 0; k < d.channels.length; k++) names.push(d.channels[k].name);
      c.values = {
        mode: String(d.mode),
        bits: bitsOf(d),
        layers: d.layers.length,
        channels: names
      };
      dup = d.duplicate(id + "-merged", false);
      app.activeDocument = dup;
      if (dup.layers.length > 1 || dup.layerSets.length > 0) dup.flatten();
      var psd = new PhotoshopSaveOptions();
      psd.layers = false;
      psd.embedColorProfile = true;
      psd.alphaChannels = true;
      psd.spotColors = true;
      var rel = "mode-readback/" + id + ".merged.psd";
      dup.saveAs(new File(PAGED_STAGE + "/" + rel), psd, true, Extension.LOWERCASE);
      c.files.push(rel);
      c.profile = P.profileOf(d);
      c.bits = bitsOf(d);
    } catch (e) {
      c.error = String(e) + (e.line ? " (line " + e.line + ")" : "");
    }
    if (dup !== null) {
      try {
        dup.close(SaveOptions.DONOTSAVECHANGES);
      } catch (e2) {
        c.close_error = String(e2);
      }
    }
    if (d !== null) {
      try {
        d.close(SaveOptions.DONOTSAVECHANGES);
      } catch (e3) {
        c.close_error = String(e3);
      }
    }
    st.cases.push(c);
  }
  return P.finish([]);
})();
