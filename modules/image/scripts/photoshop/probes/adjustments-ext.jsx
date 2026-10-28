// Adjustments added with WP5.2 on `colour-sweep` (16-bit RGB): Desaturate
// and Equalize (DOM), Shadows/Highlights ('adaptCorrect'), Replace Color
// ('RplC') and Match Color ('matchColor', the document against itself
// with Neutralize). HDR Toning is NOT recorded: it flattens and, without
// its full descriptor, runs with the dialog's last-used settings (state
// we may not change), so a recording would not be reproducible.
(function () {
  var P = PagedProbe;
  P.begin("adjustments-ext");
  var src = P.open("stimuli/colour-sweep.png");
  function L(d) {
    return d.activeLayer;
  }
  function tones(amount, width, radius) {
    var t = new ActionDescriptor();
    t.putInteger(P.cid("Amnt"), amount);
    t.putInteger(P.cid("Wdth"), width);
    t.putInteger(P.cid("Rds "), radius);
    return t;
  }
  function sh(s, h, cc, mid) {
    P.exec("adaptCorrect", [
      ["sdwM", "obj", ["adaptCorrectTones", tones(s[0], s[1], s[2])]],
      ["hglM", "obj", ["adaptCorrectTones", tones(h[0], h[1], h[2])]],
      ["BlcC", "dbl", 0.01],
      ["WhtC", "dbl", 0.01],
      ["Cntr", "int", mid],
      ["ClrC", "int", cc]
    ]);
  }
  function lab(l, a, b) {
    var c = new ActionDescriptor();
    c.putDouble(P.cid("Lmnc"), l);
    c.putDouble(P.cid("A   "), a);
    c.putDouble(P.cid("B   "), b);
    return c;
  }
  P.run("identity", src, {}, function (d) {});
  P.run("desaturate", src, {}, function (d) {
    L(d).desaturate();
  });
  P.run("equalize", src, {}, function (d) {
    L(d).equalize();
  });
  P.run("shadows-highlights-defaults", src, { shadows: [35, 50, 30], highlights: [0, 50, 30], color_correction: 20, midtone_contrast: 0, clip: [0.01, 0.01] }, function (d) {
    sh([35, 50, 30], [0, 50, 30], 20, 0);
  });
  P.run("shadows-highlights-strong", src, { shadows: [80, 70, 10], highlights: [60, 40, 10], color_correction: 0, midtone_contrast: 30, clip: [0.01, 0.01] }, function (d) {
    sh([80, 70, 10], [60, 40, 10], 0, 30);
  });
  P.run("replace-color-red-hue60", src, { colour_lab: [54, 81, 70], fuzziness: 40, hue: 60, saturation: 0, lightness: 0 }, function (d) {
    P.exec("RplC", [
      ["Fzns", "int", 40],
      ["Mnm ", "obj", ["LbCl", lab(54, 81, 70)]],
      ["Mxm ", "obj", ["LbCl", lab(54, 81, 70)]],
      ["H   ", "int", 60],
      ["Strt", "int", 0],
      ["Lght", "int", 0]
    ]);
  });
  P.run("match-color-self-neutralize", src, { source: "self", luminance: 100, intensity: 100, fade: 0, neutralize: true }, function (d) {
    P.exec("matchColor", [
      ["Lmnc", "int", 100],
      ["ClrR", "int", 100],
      ["Fade", "int", 0],
      ["neutralizeColor", "bool", true]
    ]);
  });
  return P.finish([src]);
})();
