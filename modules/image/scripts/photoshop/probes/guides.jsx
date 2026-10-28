// Ruler GUIDES as Photoshop writes them: the grid-and-guides resource
// (id 1032) of a saved PSD. The replay (psd_guides_photoshop.rs) parses
// each PSD, holds paged-psd's typed guides to the positions Photoshop
// reports for the same document, and re-encodes the record from the typed
// view to prove it writes Photoshop's own bytes (image ADR 474).
//
// What each case pins:
//   * whole-pixel guides of both directions, in creation order;
//   * fractional positions (the record's 1/32-pixel fixed point);
//   * guides outside the canvas (negative, and past the far edge);
//   * a 300 ppi document whose guide is placed in INCHES: the record
//     stores pixels, so 1 in is 300 px;
//   * a document without guides writes no 1032 record (or an empty one).
//
// No stimulus is opened; each case makes its own small document and
// closes it unsaved after the PSD copy is written.
(function () {
  var P = PagedProbe;
  var st = P.begin("guides");
  var DIR = PAGED_STAGE + "/guides/";
  new Folder(DIR).create();

  function savePsd(d, path) {
    var o = new PhotoshopSaveOptions();
    o.layers = true;
    d.saveAs(new File(path), o, true, Extension.LOWERCASE);
  }

  function read(d) {
    var out = [];
    var i, g;
    for (i = 0; i < d.guides.length; i++) {
      g = d.guides[i];
      out.push({
        direction: g.direction == Direction.VERTICAL ? "vertical" : "horizontal",
        px: g.coordinate.as("px")
      });
    }
    return out;
  }

  function record(id, params, ppi, body) {
    var c = { id: id, params: params };
    var d = null;
    try {
      d = app.documents.add(64, 48, ppi, id, NewDocumentMode.RGB, DocumentFill.WHITE);
      body(d);
      var rel = "guides/" + id + ".psd";
      savePsd(d, DIR + id + ".psd");
      c.files = [rel];
      c.values = { guides: read(d), ppi: ppi, width: 64, height: 48 };
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

  function px(v) {
    return new UnitValue(v, "px");
  }

  record("whole-pixels", { what: "two vertical and two horizontal guides at whole pixels" }, 72, function (d) {
    d.guides.add(Direction.VERTICAL, px(10));
    d.guides.add(Direction.HORIZONTAL, px(20));
    d.guides.add(Direction.VERTICAL, px(32));
    d.guides.add(Direction.HORIZONTAL, px(0));
  });
  record("fractional", { what: "guides at 12.5, 0.25 and 33.03125 px" }, 72, function (d) {
    d.guides.add(Direction.VERTICAL, px(12.5));
    d.guides.add(Direction.HORIZONTAL, px(0.25));
    d.guides.add(Direction.VERTICAL, px(33.03125));
  });
  record("outside", { what: "guides left of and below the canvas" }, 72, function (d) {
    d.guides.add(Direction.VERTICAL, px(-8));
    d.guides.add(Direction.HORIZONTAL, px(80));
  });
  record("inches-300ppi", { what: "a 300 ppi document, a guide placed at 0.1 in" }, 300, function (d) {
    d.guides.add(Direction.VERTICAL, new UnitValue(0.1, "in"));
  });
  record("none", { what: "no guides" }, 72, function (d) {});

  return P.finish([]);
})();
