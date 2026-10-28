// VECTORS INSIDE THE IMAGE (image ADR 476): the document's PATHS, a
// SHAPE LAYER whose path has two components, and a ROUND TRIP of a PSD
// that paged wrote. The replay is
// image-conformance/tests/it/psd_vector_paths_photoshop.rs.
//
// Cases:
//   * paths: two saved paths ("Outline": a rectangle that combines and a
//     circle that subtracts; "Open": an open curve) and a work path made
//     from a selection. The PSD carries them as image resources 2000+
//     and 1025; `values` holds what Photoshop's DOM reports for each
//     path, the oracle our resource reader is held to.
//   * shape-subtract: a solid-colour shape layer whose vector mask is a
//     rectangle minus a smaller one; the PSD (real merged data) and a PNG.
//   * roundtrip: Photoshop OPENS `input/paged-vectors.psd` -- written by
//     paged's layered PSD save (a shape layer, a pixel layer with a vector
//     mask, a saved path and the work path; the copy committed as
//     fixtures/photoshop/vector-paths/paged-vectors.psd) -- and reports
//     its paths and layers; a PNG is Photoshop's render of our file. Run
//     with PAGED_PROBE_STAGE set to a directory holding input/ (README).
//
// "Maximize compatibility" is set for the run and restored after.
(function () {
  var P = PagedProbe;
  var st = P.begin("vector-paths");
  var S = 64;
  var DIR = PAGED_STAGE + "/vector-paths/";
  new Folder(DIR).create();
  var prevCompat = app.preferences.maximizeCompatibility;
  app.preferences.maximizeCompatibility = QueryStateType.ALWAYS;
  st.maximize_compatibility_was = String(prevCompat);

  var ADD = ShapeOperation.SHAPEADD;
  var SUB = ShapeOperation.SHAPESUBTRACT;

  function corner(x, y) {
    var p = new PathPointInfo();
    p.kind = PointKind.CORNERPOINT;
    p.anchor = [x, y];
    p.leftDirection = [x, y];
    p.rightDirection = [x, y];
    return p;
  }
  function smooth(ax, ay, inX, inY, outX, outY) {
    var p = new PathPointInfo();
    p.kind = PointKind.SMOOTHPOINT;
    p.anchor = [ax, ay];
    p.rightDirection = [inX, inY];
    p.leftDirection = [outX, outY];
    return p;
  }
  function sub(points, op, closed) {
    var s = new SubPathInfo();
    s.closed = closed !== false;
    s.operation = op;
    s.entireSubPath = points;
    return s;
  }
  function rect(x0, y0, x1, y1, op) {
    return sub([corner(x0, y0), corner(x1, y0), corner(x1, y1), corner(x0, y1)], op);
  }
  function circle(cx, cy, r, op) {
    var k = 0.5522847498 * r;
    return sub(
      [
        smooth(cx + r, cy, cx + r, cy - k, cx + r, cy + k),
        smooth(cx, cy + r, cx + k, cy + r, cx - k, cy + r),
        smooth(cx - r, cy, cx - r, cy + k, cx - r, cy - k),
        smooth(cx, cy - r, cx - k, cy - r, cx + k, cy - r)
      ],
      op
    );
  }

  /** Every path of `d` as plain data: name, kind, and per subpath its
   *  closed flag, operation and points (anchor, the handle ARRIVING --
   *  the DOM's rightDirection -- and the one LEAVING -- leftDirection). */
  function dumpPaths(d) {
    var out = [];
    var i, j, k, p, s, q;
    for (i = 0; i < d.pathItems.length; i++) {
      p = d.pathItems[i];
      var subs = [];
      for (j = 0; j < p.subPathItems.length; j++) {
        s = p.subPathItems[j];
        var pts = [];
        for (k = 0; k < s.pathPoints.length; k++) {
          q = s.pathPoints[k];
          pts.push([
            q.anchor[0],
            q.anchor[1],
            q.rightDirection[0],
            q.rightDirection[1],
            q.leftDirection[0],
            q.leftDirection[1]
          ]);
        }
        subs.push({ closed: s.closed, operation: String(s.operation), points: pts });
      }
      out.push({ name: p.name, kind: String(p.kind), subpaths: subs });
    }
    return out;
  }
  function dumpLayers(d) {
    var out = [];
    var i, l;
    for (i = 0; i < d.artLayers.length; i++) {
      l = d.artLayers[i];
      out.push({ name: l.name, kind: String(l.kind), visible: l.visible });
    }
    return out;
  }
  function contentLayer() {
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putClass(P.cid("contentLayer"));
    desc.putReference(P.cid("null"), ref);
    var cl = new ActionDescriptor();
    var fill = new ActionDescriptor();
    var c = new ActionDescriptor();
    c.putDouble(P.cid("Rd  "), 30);
    c.putDouble(P.cid("Grn "), 120);
    c.putDouble(P.cid("Bl  "), 220);
    fill.putObject(P.cid("Clr "), P.cid("RGBC"), c);
    cl.putObject(P.cid("Type"), P.cid("solidColorLayer"), fill);
    desc.putObject(P.cid("Usng"), P.cid("contentLayer"), cl);
    executeAction(P.cid("Mk  "), desc, DialogModes.NO);
  }
  function savePsd(d, path) {
    var o = new PhotoshopSaveOptions();
    o.layers = true;
    o.embedColorProfile = false;
    o.alphaChannels = false;
    d.saveAs(new File(path), o, true, Extension.LOWERCASE);
  }
  function savePng(d, path) {
    var o = new PNGSaveOptions();
    o.compression = 9;
    d.saveAs(new File(path), o, true, Extension.LOWERCASE);
  }

  function record(id, params, build) {
    var c = { id: id, params: params };
    var d = null;
    try {
      d = build();
      c.values = { paths: dumpPaths(d), layers: dumpLayers(d) };
      savePsd(d, DIR + id + ".psd");
      savePng(d, DIR + id + ".png");
      c.files = ["vector-paths/" + id + ".psd", "vector-paths/" + id + ".png"];
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

  function fresh(id) {
    return app.documents.add(S, S, 72, id, NewDocumentMode.RGB, DocumentFill.WHITE);
  }

  try {
    record("paths", { what: "two saved paths and a work path" }, function () {
      var d = fresh("paths");
      d.pathItems.add("Outline", [rect(8, 8, 56, 40, ADD), circle(32.5, 24.25, 10.5, SUB)]);
      d.pathItems.add("Open", [
        sub([smooth(6, 58, 6, 58, 20, 44), smooth(40, 50, 30, 60, 50, 40), corner(60, 58)], ADD, false)
      ]);
      d.selection.select([[10, 44], [30, 44], [30, 60], [10, 60]]);
      d.selection.makeWorkPath(0.5);
      d.selection.deselect();
      return d;
    });
    record("shape-subtract", { what: "a shape layer: a rectangle minus a rectangle" }, function () {
      var d = fresh("shape-subtract");
      d.pathItems.add("vm", [rect(6.5, 8.25, 57.5, 55.75, ADD), rect(20, 20, 44.5, 40.5, SUB)]);
      d.pathItems.getByName("vm").select();
      contentLayer();
      d.pathItems.getByName("vm").remove();
      return d;
    });
    record("roundtrip", { what: "Photoshop opens the PSD paged wrote" }, function () {
      var f = new File(PAGED_STAGE + "/input/paged-vectors.psd");
      if (!f.exists) throw new Error("missing input/paged-vectors.psd (see README)");
      return app.open(f);
    });
  } finally {
    app.preferences.maximizeCompatibility = prevCompat;
  }
  return P.finish([]);
})();
