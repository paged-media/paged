// The engine's effect stack (engine ADR 1008), asked of Photoshop: a black
// 32 px square on white in a 64 px document at 72 ppi (one pixel per pt),
// with the layer-style Stroke (4 px, red, Normal 100 %) outside, inside
// and centred, a Color Overlay, and the Gaussian Blur filter at radius 3.
// Each document is saved as a PNG; the replay is paged-renderer's
// tests/it/effect_stack_photoshop.rs, which draws the same square
// through the engine's stack and compares.
(function () {
  var P = PagedProbe;
  var st = P.begin("effect-stack");
  var S = 64;
  var cid = P.cid;
  function rgb(r, g, b) {
    var c = new SolidColor();
    c.rgb.red = r;
    c.rgb.green = g;
    c.rgb.blue = b;
    return c;
  }
  function rgbDesc(r, g, b) {
    var c = new ActionDescriptor();
    c.putDouble(cid("Rd  "), r);
    c.putDouble(cid("Grn "), g);
    c.putDouble(cid("Bl  "), b);
    return c;
  }
  function effects(spec) {
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putProperty(cid("Prpr"), cid("Lefx"));
    ref.putEnumerated(cid("Lyr "), cid("Ordn"), cid("Trgt"));
    desc.putReference(cid("null"), ref);
    var fx = new ActionDescriptor();
    fx.putUnitDouble(cid("Scl "), cid("#Prc"), 100);
    if (spec.stroke) {
      var fr = new ActionDescriptor();
      fr.putBoolean(cid("enab"), true);
      fr.putEnumerated(cid("Styl"), cid("FStl"), cid(spec.stroke));
      fr.putEnumerated(cid("PntT"), cid("FrFl"), cid("SClr"));
      fr.putEnumerated(cid("Md  "), cid("BlnM"), cid("Nrml"));
      fr.putUnitDouble(cid("Opct"), cid("#Prc"), 100);
      fr.putUnitDouble(cid("Sz  "), cid("#Pxl"), 4);
      fr.putObject(cid("Clr "), cid("RGBC"), rgbDesc(255, 0, 0));
      fx.putObject(cid("FrFX"), cid("FrFX"), fr);
    }
    if (spec.overlay) {
      var so = new ActionDescriptor();
      so.putBoolean(cid("enab"), true);
      so.putEnumerated(cid("Md  "), cid("BlnM"), cid("Nrml"));
      so.putUnitDouble(cid("Opct"), cid("#Prc"), 100);
      so.putObject(cid("Clr "), cid("RGBC"), rgbDesc(255, 0, 0));
      fx.putObject(cid("SoFi"), cid("SoFi"), so);
    }
    desc.putObject(cid("T   "), cid("Lefx"), fx);
    executeAction(cid("setd"), desc, DialogModes.NO);
  }
  function square(id, params, build) {
    var c = { id: id, params: params };
    var d = null;
    try {
      d = app.documents.add(S, S, 72, id, NewDocumentMode.RGB, DocumentFill.WHITE);
      var l = d.artLayers.add();
      l.name = "square";
      d.selection.select([[16, 16], [48, 16], [48, 48], [16, 48]]);
      d.selection.fill(rgb(0, 0, 0));
      d.selection.deselect();
      build(d, l);
      var png = new PNGSaveOptions();
      png.compression = 9;
      d.saveAs(new File(PAGED_STAGE + "/effect-stack/" + id + ".png"), png, true, Extension.LOWERCASE);
      c.files = ["effect-stack/" + id + ".png"];
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
  square("identity", {}, function () {});
  square("stroke-outside", { stroke: "Outside", size: 4 }, function () {
    effects({ stroke: "OutF" });
  });
  square("stroke-inside", { stroke: "Inside", size: 4 }, function () {
    effects({ stroke: "InsF" });
  });
  square("stroke-center", { stroke: "Center", size: 4 }, function () {
    effects({ stroke: "CtrF" });
  });
  square("color-overlay", { overlay: [255, 0, 0] }, function () {
    effects({ overlay: true });
  });
  square("gaussian-blur-3", { radius: 3 }, function (d, l) {
    l.applyGaussianBlur(3);
  });
  return P.finish([]);
})();
