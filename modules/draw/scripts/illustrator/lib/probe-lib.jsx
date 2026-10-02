/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// The shared half of every Illustrator oracle probe. `run-probe.sh`
// PREPENDS this file to the probe it runs and hands Illustrator the
// concatenated text, so a probe needs no `#include` and Illustrator never
// has to read a file from disk.
//
// LANGUAGE. This is ExtendScript -- ECMAScript 3. No `let`/`const`, no
// arrow functions, no `JSON`, no `Array.prototype.map/forEach/indexOf`,
// no trailing commas. Everything below is written to that floor.
//
// COORDINATES. A probe is written in the ENGINE's frame: points,
// page-local, origin top-left, Y DOWN. Illustrator scripts in points too
// (always -- the ruler unit is a display setting and is recorded only as
// provenance), but in DOCUMENT coordinates whose Y axis points UP. Where
// that system puts its origin is not assumed: `run` reads the scratch
// artboard's own rectangle and `toApp` / `fromApp` map through its
// top-left corner, so a probe's `[100, 100]` lands 100 pt right of and
// 100 pt BELOW the artboard's top-left corner whatever the origin is,
// and every recorded coordinate is back in the engine's frame. The
// artboard rectangle the mapping used is recorded as provenance.
//
// Mirroring Y flips the SIGN of a signed area. `winding` is therefore
// computed HERE, from the normalised (Y-down) anchors: "cw" = clockwise
// as drawn on a Y-down page. Illustrator's own `PathItem.area` (signed in
// ITS frame) and `PathItem.polarity` are recorded verbatim next to it, so
// a convention question can be settled from the fixture.

var PagedProbe = (function () {
  // -- JSON ---------------------------------------------------------------

  function quote(s) {
    var out = '"';
    var i, c, code;
    for (i = 0; i < s.length; i++) {
      c = s.charAt(i);
      code = s.charCodeAt(i);
      if (c === '"') out += '\\"';
      else if (c === "\\") out += "\\\\";
      else if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else if (code < 32 || code > 126) {
        out += "\\u" + ("0000" + code.toString(16)).slice(-4);
      } else out += c;
    }
    return out + '"';
  }

  /** Numbers are recorded to 1e-6 (pt, or pt^2 for an area): far finer
   *  than any tolerance the replay uses, coarse enough to drop float
   *  noise from the artboard-origin subtraction. */
  function num(n) {
    if (!isFinite(n)) return "null";
    var r = Math.round(n * 1e6) / 1e6;
    if (r === 0) r = 0; // no "-0"
    return String(r);
  }

  function json(v) {
    var parts, i, k;
    if (v === null || v === undefined) return "null";
    if (typeof v === "number") return num(v);
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "string") return quote(v);
    if (v instanceof Array) {
      parts = [];
      for (i = 0; i < v.length; i++) parts.push(json(v[i]));
      return "[" + parts.join(",") + "]";
    }
    parts = [];
    for (k in v) {
      if (v.hasOwnProperty(k) && v[k] !== undefined) {
        parts.push(quote(k) + ":" + json(v[k]));
      }
    }
    return "{" + parts.join(",") + "}";
  }

  // -- coordinates ----------------------------------------------------------

  // The scratch artboard's top-left corner in Illustrator's document
  // coordinates; set by `run` before any path is built.
  var originX = 0;
  var originTop = 0;

  function toApp(p) {
    return [originX + p[0], originTop - p[1]];
  }
  function fromApp(p) {
    return [p[0] - originX, originTop - p[1]];
  }

  // -- building inputs ------------------------------------------------------

  /** A straight-edged path spec from explicit points. */
  function polygon(points, closed) {
    var anchors = [];
    var i;
    for (i = 0; i < points.length; i++) {
      anchors.push({
        anchor: [points[i][0], points[i][1]],
        left: [points[i][0], points[i][1]],
        right: [points[i][0], points[i][1]]
      });
    }
    return { closed: closed !== false, anchors: anchors };
  }

  /** Create one PathItem from a spec `{closed, anchors:[{anchor,left,
   *  right}]}` given in the ENGINE frame. Black fill, no stroke: the
   *  default appearance of a new item follows whatever the user last
   *  used, and an inherited stroke would change what "expand" returns. */
  function buildPath(doc, spec) {
    var item = doc.pathItems.add();
    var i, a, pp;
    for (i = 0; i < spec.anchors.length; i++) {
      a = spec.anchors[i];
      pp = item.pathPoints.add();
      pp.anchor = toApp(a.anchor);
      pp.leftDirection = toApp(a.left);
      pp.rightDirection = toApp(a.right);
      pp.pointType = PointType.CORNER;
    }
    item.closed = spec.closed;
    var black = new RGBColor();
    black.red = 0;
    black.green = 0;
    black.blue = 0;
    item.filled = true;
    item.fillColor = black;
    item.stroked = false;
    return item;
  }

  // -- measuring outputs ----------------------------------------------------

  function cross(a, b) {
    return a[0] * b[1] - a[1] * b[0];
  }

  /** Exact signed area of a path of cubics (Green's theorem in closed
   *  form), in the ENGINE frame: positive = clockwise on a Y-down page.
   *  The same formula as `test/oracle/oracle.ts`, on purpose -- the spec
   *  recomputes it from the recorded anchors and the two must agree. */
  function signedArea(anchors, closed) {
    var n = anchors.length;
    var sum = 0;
    var i, a, b, p0, p1, p2, p3;
    if (n < 2) return 0;
    for (i = 0; i < n; i++) {
      a = anchors[i];
      b = anchors[(i + 1) % n];
      if (i === n - 1 && !closed) {
        sum += cross(a.anchor, b.anchor) / 2;
        continue;
      }
      p0 = a.anchor;
      p1 = a.right;
      p2 = b.left;
      p3 = b.anchor;
      sum +=
        (6 * cross(p0, p1) +
          3 * cross(p0, p2) +
          cross(p0, p3) +
          3 * cross(p1, p2) +
          3 * cross(p1, p3) +
          6 * cross(p2, p3)) /
        20;
    }
    return sum;
  }

  function measurePath(item, compoundIndex) {
    var anchors = [];
    var i, pp, gb, signed, winding, out;
    for (i = 0; i < item.pathPoints.length; i++) {
      pp = item.pathPoints[i];
      anchors.push({
        anchor: fromApp(pp.anchor),
        left: fromApp(pp.leftDirection),
        right: fromApp(pp.rightDirection)
      });
    }
    // geometricBounds is [left, top, right, bottom] with top > bottom
    // (Y up); in the engine frame minY comes from `top` and maxY from
    // `bottom`.
    gb = item.geometricBounds;
    signed = signedArea(anchors, item.closed);
    // NOT a nested ternary. ExtendScript parses `a ? x : b ? y : z` as
    // `(a ? x : b) ? y : z`, so that spelling answered "ccw" for every
    // path with any area at all -- the first recording said so, and the
    // replay's own recomputation from the anchors caught it.
    winding = "none";
    if (signed > 1e-9) winding = "cw";
    if (signed < -1e-9) winding = "ccw";
    out = {
      closed: item.closed,
      anchors: anchors,
      area: Math.abs(item.area),
      bounds: [gb[0] - originX, originTop - gb[1], gb[2] - originX, originTop - gb[3]],
      winding: winding,
      areaSignedApp: item.area,
      polarity: item.polarity === PolarityValues.POSITIVE ? "positive" : "negative"
    };
    if (compoundIndex !== undefined) out.compound = compoundIndex;
    return out;
  }

  /** Every path in the document, front to back, walking groups and
   *  compound paths. A subpath of a compound path carries `compound`:
   *  the index of its compound path among the compound paths met. */
  function collectPaths(doc) {
    var out = [];
    var compounds = 0;
    function walk(items) {
      var i, it, j, ci;
      for (i = 0; i < items.length; i++) {
        it = items[i];
        if (it.typename === "PathItem") {
          out.push(measurePath(it));
        } else if (it.typename === "CompoundPathItem") {
          ci = compounds++;
          for (j = 0; j < it.pathItems.length; j++) {
            out.push(measurePath(it.pathItems[j], ci));
          }
        } else if (it.typename === "GroupItem") {
          walk(it.pageItems);
        } else {
          throw new Error("unexpected result item: " + it.typename);
        }
      }
    }
    var l;
    for (l = 0; l < doc.layers.length; l++) walk(doc.layers[l].pageItems);
    // Cross-check the walk against Illustrator's own flat collection: a
    // path the walk missed (or met twice) would silently drop geometry.
    if (out.length !== doc.pathItems.length) {
      throw new Error(
        "walk found " + out.length + " paths, document.pathItems has " + doc.pathItems.length
      );
    }
    return out;
  }

  /** The closed flags and anchor tables of a path list, as one string,
   *  so two lists can be compared for being the same geometry. */
  function geometryOf(paths) {
    var parts = [];
    var i;
    for (i = 0; i < paths.length; i++) {
      parts.push(json({ closed: paths[i].closed, anchors: paths[i].anchors }));
    }
    return parts.join("|");
  }

  function clearDocument(doc) {
    doc.selection = null;
    while (doc.pageItems.length > 0) doc.pageItems[0].remove();
  }

  // -- the run --------------------------------------------------------------

  /**
   * Run a probe. `spec` is
   *   { probe, operation, cases: [{ id, input: {paths}, parameters }],
   *     apply: function (doc, items, parameters, theCase) }
   * For every case a clean scratch document holds exactly the input
   * paths; `apply` performs ONE Illustrator operation on them; whatever
   * paths the document then holds are the answer.
   *
   * Returns a JSON STRING -- always, even on failure -- so the runner
   * judges an artifact and not an exit code. A case that throws records
   * `error` and the runner refuses the recording.
   */
  function run(spec) {
    var result = {
      probe: spec.probe,
      app: {
        name: app.name,
        version: app.version,
        build: String(app.buildNumber),
        locale: String(app.locale)
      },
      units: "pt",
      coordinates:
        "page-local, origin top-left of the artboard, Y down " +
        "(mapped in and out of Illustrator's Y-up document coordinates " +
        "through the scratch artboard's top-left corner)",
      operation: spec.operation,
      documents_before: app.documents.length,
      cases: []
    };
    var previousLevel = app.userInteractionLevel;
    var previousSystem = app.coordinateSystem;
    var doc = null;
    var i, j, c, items, entry, ab;
    // No alert may ever wait for a click: the runner cannot see the screen.
    app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
    try {
      // US Letter in points -- the size of the engine's fixture page.
      doc = app.documents.add(DocumentColorSpace.RGB, 612, 792);
      // Path points and the artboard rectangle must be read in ONE
      // system; pin it rather than inherit the user's setting.
      app.coordinateSystem = CoordinateSystem.DOCUMENTCOORDINATESYSTEM;
      ab = doc.artboards[0].artboardRect; // [left, top, right, bottom]
      originX = ab[0];
      originTop = ab[1];
      result.artboard_rect_app = [ab[0], ab[1], ab[2], ab[3]];
      result.ruler_units = String(doc.rulerUnits);
      for (i = 0; i < spec.cases.length; i++) {
        c = spec.cases[i];
        entry = { id: c.id, input: c.input, parameters: c.parameters };
        try {
          clearDocument(doc);
          items = [];
          for (j = 0; j < c.input.paths.length; j++) {
            items.push(buildPath(doc, c.input.paths[j]));
          }
          spec.apply(doc, items, c.parameters, c);
          entry.measured = { paths: collectPaths(doc) };
          // An operation that silently did nothing (an effect name the
          // app did not recognise, a menu command with no selection)
          // leaves the input standing, and the input would then be
          // recorded as Illustrator's answer. Refuse that.
          if (!c.allowUnchanged && geometryOf(entry.measured.paths) === geometryOf(c.input.paths)) {
            throw new Error("the operation changed nothing: the result is the input");
          }
        } catch (e) {
          entry.error = String(e.message || e) + (e.line ? " (line " + e.line + ")" : "");
        }
        result.cases.push(entry);
      }
    } catch (e2) {
      result.error = String(e2.message || e2) + (e2.line ? " (line " + e2.line + ")" : "");
    } finally {
      // The scratch document is never saved and never left open.
      if (doc !== null) {
        try {
          doc.close(SaveOptions.DONOTSAVECHANGES);
        } catch (e3) {
          result.close_error = String(e3.message || e3);
        }
      }
      app.coordinateSystem = previousSystem;
      app.userInteractionLevel = previousLevel;
    }
    result.documents_after = app.documents.length;
    return json(result);
  }

  /** Select exactly `items` (menu commands and `expandStyle` act on the
   *  selection, not on an object reference). */
  function select(doc, items) {
    var i;
    doc.selection = null;
    for (i = 0; i < items.length; i++) items[i].selected = true;
  }

  return {
    json: json,
    polygon: polygon,
    buildPath: buildPath,
    measurePath: measurePath,
    collectPaths: collectPaths,
    signedArea: signedArea,
    select: select,
    run: run
  };
})();
