// Image > Mode, recorded (image ADR 479): Photoshop converting the
// `colour-sweep` stimulus to CMYK (Coated FOGRA39), Gray Gamma 2.2 and
// Lab and back to sRGB, at 16 and at 8 bits per channel, plus a strong
// Levels gamma on the `deep-ramp` stimulus at 16 and at 8 bits.
//
// Each mode case saves the converted document as a PSD (its own numbers:
// inks, grey or L*a*b*, with the profile embedded) in `files`, then
// converts it back to sRGB for the case's PNG -- the colours a document
// of that mode holds, as Photoshop shows them. Profiles are NAMED, so the
// recording does not depend on the user's Color Settings (read, never
// changed). Every conversion is relative colorimetric with black-point
// compensation and dither OFF (deterministic). An 8-bit case converts
// its duplicate to 8 bits first and back to 16 before the PNG is saved,
// so the lane's 16-bit PNG carries the 8-bit quantisation.
(function () {
  var P = PagedProbe;
  var st = P.begin("mode-conversions");
  var CMYK = "Coated FOGRA39 (ISO 12647-2:2004)";
  var GRAY = "Gray Gamma 2.2";
  var SRGB = "sRGB IEC61966-2.1";
  var REL = Intent.RELATIVECOLORIMETRIC;
  st.findings = { cmyk_profile: CMYK, gray_profile: GRAY, rendering: "relative colorimetric, BPC, no dither" };
  var sweep = P.open("stimuli/colour-sweep.png");
  var ramp = P.open("stimuli/deep-ramp.png");

  function savePsd(d, rel) {
    var psd = new PhotoshopSaveOptions();
    psd.layers = false;
    psd.embedColorProfile = true;
    psd.alphaChannels = false;
    d.saveAs(new File(PAGED_STAGE + "/" + rel), psd, true, Extension.LOWERCASE);
    return rel;
  }

  // One case: a fresh duplicate of `src`, `body(doc, case)` converts it.
  function run(id, src, params, eight, body) {
    var c = { id: id, params: params, files: [] };
    var d = null;
    try {
      d = src.duplicate(id, false);
      app.activeDocument = d;
      if (eight) d.bitsPerChannel = BitsPerChannelType.EIGHT;
      body(d, c);
      if (d.bitsPerChannel != BitsPerChannelType.SIXTEEN) d.bitsPerChannel = BitsPerChannelType.SIXTEEN;
      c.output = P.savePng(d, "mode-conversions/" + id + ".png");
      c.profile = P.profileOf(d);
      c.bits = eight ? 8 : 16;
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

  function viaProfile(name, ext) {
    return function (d, c) {
      d.convertProfile(name, REL, true, false);
      c.files.push(savePsd(d, "mode-conversions/" + c.id + "." + ext + ".psd"));
      c.values = { mode_profile: P.profileOf(d) };
      d.convertProfile(SRGB, REL, true, false);
    };
  }
  function viaLab(d, c) {
    d.changeMode(ChangeMode.LAB);
    c.values = { mode_profile: P.profileOf(d) };
    c.files.push(savePsd(d, "mode-conversions/" + c.id + ".lab.psd"));
    d.changeMode(ChangeMode.RGB);
  }

  run("identity", sweep, {}, false, function (d, c) {});
  run("cmyk-16", sweep, { mode: "cmyk", profile: CMYK }, false, viaProfile(CMYK, "cmyk"));
  run("cmyk-8", sweep, { mode: "cmyk", profile: CMYK }, true, viaProfile(CMYK, "cmyk"));
  run("gray-16", sweep, { mode: "gray", profile: GRAY }, false, viaProfile(GRAY, "gray"));
  run("gray-8", sweep, { mode: "gray", profile: GRAY }, true, viaProfile(GRAY, "gray"));
  run("lab-16", sweep, { mode: "lab" }, false, viaLab);
  run("lab-8", sweep, { mode: "lab" }, true, viaLab);
  run("ramp-identity", ramp, {}, false, function (d, c) {});
  run("ramp-levels-16", ramp, { in_black: 0, in_white: 255, gamma: 2.2, out_black: 0, out_white: 255 }, false, function (d, c) {
    d.activeLayer.adjustLevels(0, 255, 2.2, 0, 255);
  });
  run("ramp-levels-8", ramp, { in_black: 0, in_white: 255, gamma: 2.2, out_black: 0, out_white: 255 }, true, function (d, c) {
    d.activeLayer.adjustLevels(0, 255, 2.2, 0, 255);
  });
  return P.finish([sweep, ramp]);
})();
