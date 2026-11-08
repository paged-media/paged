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

// Ask Adobe InDesign what it SEES in one IDML file. `run-roundtrip.sh`
// prepends a few globals (below) and hands InDesign the text of this file;
// the value of the last expression -- a JSON STRING, always, even on
// failure -- comes back through the Apple event, so the runner judges an
// artifact and never an exit code.
//
// Globals set by the runner:
//   PAGED_RT_IDML        absolute path of the IDML to open (read-only)
//   PAGED_RT_PDF         where to export a PDF of the document ("" = none)
//   PAGED_RT_EXPORT      where to write InDesign's OWN IDML export (always)
//   PAGED_RT_LABEL_KEYS  the `<Label><KeyValuePair Key=...>` keys the file
//                        carries (InDesign can answer a keyed label but
//                        cannot list the keys), as an array of strings
//
// LANGUAGE. ExtendScript -- ECMAScript 3: no JSON, no let/const, no
// Array.map/indexOf, no trailing commas, and a NESTED TERNARY parses left
// to right (`a ? x : b ? y : z` is `(a ? x : b) ? y : z`) -- so there are
// none below. Plain ASCII only; the runner refuses anything else.
//
// COORDINATES. Everything is measured in POINTS (`scriptPreferences.
// measurementUnit`, whatever the rulers show) with the ruler origin on the
// PAGE and the zero point at its top-left corner -- so a coordinate is
// page-local, origin top-left, Y DOWN: the engine's own frame. InDesign's
// `geometricBounds` is [top, left, bottom, right]; it is recorded as
// [minX, minY, maxX, maxY] like the Illustrator oracle lane.
//
// Z-ORDER is NOT read here, because the DOM does not answer it: a
// parent's `pageItems` collection is grouped BY KIND (every Rectangle,
// then every Polygon...) and `index` counts within one kind -- measured on
// 20.0.1, a group holding a Rectangle under three Polygons listed the
// Rectangle first with index 0 and the frontmost Polygon ALSO at index 0.
// Both are recorded raw (`position`, `index`). The stacking order comes
// from InDesign's OWN IDML export of the opened document instead, whose
// children are written back to front; `run-roundtrip.sh` reads it and
// `write-fixture.mjs` adds `z` (0 = back) to every item, matching the
// export's `Self="u<hex id>"` to the item's `id`.
//
// ENUMERATIONS are recorded by NAME (`EndCap.ROUND_END_CAP`), never by the
// four-character number InDesign hands back, and swatch / stroke-style
// names are recorded as InDesign spells them internally ("None", "Black",
// "$ID/Solid") -- the UI names are localised and are kept only beside them.

var PagedRoundtrip = (function () {
  // -- JSON -------------------------------------------------------------

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

  /** Numbers to 1e-6: far finer than any replay tolerance, coarse enough
   *  to drop float noise. */
  function num(n) {
    if (!isFinite(n)) return "null";
    var r = Math.round(n * 1e6) / 1e6;
    if (r === 0) r = 0;
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

  // -- reading values defensively -------------------------------------------

  /** `o[k]`, or `{ error }` when InDesign refuses the read (a property the
   *  item's kind does not carry throws rather than answering null). */
  function Unreadable(why) {
    this.unreadable = why;
  }

  function read(o, k) {
    try {
      return o[k];
    } catch (e) {
      return new Unreadable(String(e.message || e));
    }
  }

  /** `instanceof`, never a property probe: asking an InDesign DOM object
   *  for a property it does not have THROWS ("Object does not support the
   *  property or method"). */
  function isUnreadable(v) {
    return v instanceof Unreadable;
  }

  /** The NAME of an enumeration value: reverse lookup over the enum
   *  object's own properties. The enum is named by its GLOBAL name (a
   *  string), so one this InDesign does not define degrades instead of
   *  throwing. Falls back to "#<number>" so an unmapped value is visible
   *  rather than invented. */
  function enumName(enumGlobal, v) {
    var props, i, n, E;
    if (v === null || v === undefined) return null;
    if (isUnreadable(v)) return v;
    try {
      E = $.global[enumGlobal];
      props = E.reflect.properties;
      for (i = 0; i < props.length; i++) {
        n = props[i].name;
        if (n === "reflect" || n === "__proto__" || n === "prototype") continue;
        try {
          if (E[n] == v) return n;
        } catch (e1) {}
      }
    } catch (e) {}
    return "#" + String(v);
  }

  function enumRead(o, k, E) {
    return enumName(E, read(o, k));
  }

  function numRead(o, k) {
    var v = read(o, k);
    if (isUnreadable(v)) return v;
    if (typeof v === "number") return v;
    if (v === null || v === undefined) return null;
    return { unexpected: String(v) };
  }

  // -- coordinates ----------------------------------------------------------

  /** [top, left, bottom, right] -> [minX, minY, maxX, maxY]. */
  function bounds(gb) {
    if (!gb || isUnreadable(gb)) return gb;
    return [gb[1], gb[0], gb[3], gb[2]];
  }

  /** One `entirePath` entry -> {anchor, left, right}. A corner point comes
   *  back as [x, y]; a point with handles as [[lx, ly], [x, y], [rx, ry]]. */
  function anchorOf(p) {
    if (p.length === 3 && p[0] instanceof Array) {
      return {
        anchor: [p[1][0], p[1][1]],
        left: [p[0][0], p[0][1]],
        right: [p[2][0], p[2][1]]
      };
    }
    return { anchor: [p[0], p[1]], left: [p[0], p[1]], right: [p[0], p[1]] };
  }

  function pathsOf(item) {
    var paths = read(item, "paths");
    var out = [];
    var i, j, path, entire, anchors;
    if (!paths || isUnreadable(paths)) return null;
    for (i = 0; i < paths.length; i++) {
      path = paths[i];
      entire = path.entirePath;
      anchors = [];
      for (j = 0; j < entire.length; j++) anchors.push(anchorOf(entire[j]));
      out.push({
        closed: path.pathType == PathType.CLOSED_PATH,
        pathType: enumName("PathType", path.pathType),
        anchors: anchors
      });
    }
    return out;
  }

  // -- paint ------------------------------------------------------------------

  function swatchOf(sw) {
    var o, stops, i, st, type;
    if (sw === null || sw === undefined) return null;
    if (isUnreadable(sw)) return sw;
    if (typeof sw === "string") return { name: sw, type: "string" };
    try {
      if (!sw.isValid) return { invalid: true };
    } catch (e0) {}
    type = sw.constructor.name;
    o = { name: String(read(sw, "name")), type: type };
    if (type === "Color") {
      o.model = enumRead(sw, "model", "ColorModel");
      o.space = enumRead(sw, "space", "ColorSpace");
      o.value = read(sw, "colorValue");
    } else if (type === "Tint") {
      o.tintValue = numRead(sw, "tintValue");
      o.base = swatchOf(read(sw, "baseColor"));
    } else if (type === "Gradient") {
      o.gradientType = enumRead(sw, "type", "GradientType");
      stops = [];
      try {
        for (i = 0; i < sw.gradientStops.length; i++) {
          st = sw.gradientStops[i];
          stops.push({
            location: numRead(st, "location"),
            midpoint: numRead(st, "midpoint"),
            color: swatchOf(read(st, "stopColor"))
          });
        }
      } catch (e1) {
        stops.push({ unreadable: String(e1.message || e1) });
      }
      o.stops = stops;
    }
    return o;
  }

  // Stroke styles are named "Durchgezogen" on a German install; the
  // internal key is what an IDML file spells (`StrokeStyle/$ID/Solid`).
  var STROKE_STYLE_KEYS = [
    "$ID/Solid",
    "$ID/Dashed",
    "$ID/Canned Dashed 3x2",
    "$ID/Canned Dashed 4x4",
    "$ID/Canned Dotted",
    "$ID/Japanese Dots",
    "$ID/Left Slant Hash",
    "$ID/Right Slant Hash",
    "$ID/Straight Hash",
    "$ID/White Diamond",
    "$ID/Wavy",
    "$ID/ThickThick",
    "$ID/ThickThin",
    "$ID/ThinThick",
    "$ID/ThickThinThick",
    "$ID/ThinThickThin",
    "$ID/ThinThin",
    "$ID/Triple_Stroke"
  ];

  function strokeStyleOf(doc, st) {
    var o, i, cand;
    if (st === null || st === undefined) return null;
    if (isUnreadable(st)) return st;
    o = { name: String(read(st, "name")), key: null };
    for (i = 0; i < STROKE_STYLE_KEYS.length; i++) {
      try {
        cand = doc.strokeStyles.itemByName(STROKE_STYLE_KEYS[i]);
        if (cand.isValid && cand.id === st.id) {
          o.key = STROKE_STYLE_KEYS[i];
          break;
        }
      } catch (e) {}
    }
    return o;
  }

  function transparencyOf(settings) {
    var b;
    if (!settings || isUnreadable(settings)) return settings;
    try {
      b = settings.blendingSettings;
      return {
        opacity: numRead(b, "opacity"),
        blendMode: enumRead(b, "blendMode", "BlendMode")
      };
    } catch (e) {
      return { unreadable: String(e.message || e) };
    }
  }

  var CORNERS = ["topLeft", "topRight", "bottomRight", "bottomLeft"];

  function cornersOf(item) {
    var o = {};
    var i, c;
    for (i = 0; i < CORNERS.length; i++) {
      c = CORNERS[i];
      o[c] = {
        option: enumRead(item, c + "CornerOption", "CornerOptions"),
        radius: numRead(item, c + "CornerRadius")
      };
    }
    return o;
  }

  // -- page items -------------------------------------------------------------

  function labelsOf(item, keys) {
    var o = {};
    var i, v;
    for (i = 0; i < keys.length; i++) {
      try {
        v = item.extractLabel(keys[i]);
      } catch (e) {
        v = "<unreadable: " + String(e.message || e) + ">";
      }
      if (v !== "") o[keys[i]] = v;
    }
    return o;
  }

  function textPathsOf(item) {
    var tps = read(item, "textPaths");
    var out = [];
    var i, tp;
    if (!tps || isUnreadable(tps)) return null;
    for (i = 0; i < tps.length; i++) {
      tp = tps[i];
      out.push({
        contents: String(read(tp, "contents")),
        storyContents: String(read(read(tp, "parentStory"), "contents")),
        pathEffect: enumRead(tp, "pathEffect", "PathEffects"),
        flipPathEffect: enumRead(tp, "flipPathEffect", "FlipValues"),
        startBracket: numRead(tp, "startBracket"),
        endBracket: numRead(tp, "endBracket"),
        overflows: read(tp, "overflows") === true
      });
    }
    return out;
  }

  /** Everything this lane compares, for one page item. */
  function describe(doc, item, keys, parentLabel, position) {
    var kind = item.constructor.name;
    var o = {
      kind: kind,
      id: read(item, "id"),
      parent: parentLabel,
      position: position,
      index: numRead(item, "index"),
      name: String(read(item, "name")),
      label: String(read(item, "label")),
      labels: labelsOf(item, keys),
      layer: String(read(read(item, "itemLayer"), "name")),
      visible: read(item, "visible"),
      locked: read(item, "locked"),
      geometricBounds: bounds(read(item, "geometricBounds")),
      visibleBounds: bounds(read(item, "visibleBounds"))
    };
    var paths;
    if (kind === "Group") return o;
    paths = pathsOf(item);
    if (paths !== null) o.paths = paths;
    o.fill = swatchOf(read(item, "fillColor"));
    o.fillTint = numRead(item, "fillTint");
    o.gradientFillAngle = numRead(item, "gradientFillAngle");
    o.gradientFillLength = numRead(item, "gradientFillLength");
    o.gradientFillStart = read(item, "gradientFillStart");
    o.stroke = swatchOf(read(item, "strokeColor"));
    o.strokeTint = numRead(item, "strokeTint");
    o.strokeWeight = numRead(item, "strokeWeight");
    o.endCap = enumRead(item, "endCap", "EndCap");
    o.endJoin = enumRead(item, "endJoin", "EndJoin");
    o.miterLimit = numRead(item, "miterLimit");
    o.strokeAlignment = enumRead(item, "strokeAlignment", "StrokeAlignment");
    o.strokeType = strokeStyleOf(doc, read(item, "strokeType"));
    o.strokeDashAndGap = read(item, "strokeDashAndGap");
    o.gapColor = swatchOf(read(item, "gapColor"));
    o.gapTint = numRead(item, "gapTint");
    o.leftLineEnd = enumRead(item, "leftLineEnd", "ArrowHead");
    o.rightLineEnd = enumRead(item, "rightLineEnd", "ArrowHead");
    o.corners = cornersOf(item);
    o.transparency = transparencyOf(read(item, "transparencySettings"));
    o.fillTransparency = transparencyOf(read(item, "fillTransparencySettings"));
    o.strokeTransparency = transparencyOf(read(item, "strokeTransparencySettings"));
    o.overprintFill = read(item, "overprintFill");
    o.overprintStroke = read(item, "overprintStroke");
    o.textPaths = textPathsOf(item);
    if (kind === "TextFrame") {
      o.contents = String(read(item, "contents"));
      o.overflows = read(item, "overflows") === true;
    }
    return o;
  }

  /** Every page item on the spread, depth first, each with its parent and
   *  its position in the parent's `pageItems`. Pasted-in content (a page
   *  item nested in a spline item) is walked the same way as a group's. */
  function walk(doc, spread, keys) {
    var out = [];
    function visit(collection, parentLabel) {
      var i, item, kids, label;
      for (i = 0; i < collection.length; i++) {
        item = collection[i].getElements()[0];
        out.push(describe(doc, item, keys, parentLabel, i));
        kids = read(item, "pageItems");
        if (kids && !isUnreadable(kids) && kids.length > 0) {
          label = item.constructor.name + "#" + item.id;
          visit(kids, label);
        }
      }
    }
    visit(spread.pageItems, "spread");
    return out;
  }

  // -- what InDesign complained about -------------------------------------

  /** Opening runs with NEVER_INTERACT, so an alert InDesign would have shown
   *  is suppressed and NOT observable from a script. What IS observable is
   *  recorded: fonts that did not resolve, links that are not normal, and
   *  stories that overset.
   *
   *  InDesign's PREFLIGHT is deliberately NOT asked: it is an idle task, and
   *  a script never yields idle time -- measured on 20.0.1, a process over a
   *  document with an overset frame answered `waitForProcess(30) == false`
   *  and an EMPTY result list, i.e. it reads as "no problems" while having
   *  checked nothing. */
  function warningsOf(doc) {
    var out = [];
    var i, f, l, st;
    try {
      for (i = 0; i < doc.fonts.length; i++) {
        f = doc.fonts[i];
        if (f.status != FontStatus.INSTALLED) {
          out.push({
            source: "font",
            name: String(f.name),
            status: enumName("FontStatus", f.status)
          });
        }
      }
    } catch (e1) {
      out.push({ source: "font", unreadable: String(e1.message || e1) });
    }
    try {
      for (i = 0; i < doc.links.length; i++) {
        l = doc.links[i];
        if (l.status != LinkStatus.NORMAL) {
          out.push({
            source: "link",
            name: String(l.name),
            status: enumName("LinkStatus", l.status)
          });
        }
      }
    } catch (e2) {
      out.push({ source: "link", unreadable: String(e2.message || e2) });
    }
    try {
      for (i = 0; i < doc.stories.length; i++) {
        st = doc.stories[i];
        if (st.overflows) {
          out.push({ source: "overset", story: String(st.contents).substr(0, 40) });
        }
      }
    } catch (e3) {
      out.push({ source: "overset", unreadable: String(e3.message || e3) });
    }
    return out;
  }

  // -- exports ----------------------------------------------------------------

  var PDF_PRESETS = [
    "[High Quality Print]",
    "[Qualitativ hochwertiger Druck]",
    "[Calidad de impresi\u00f3n alta]",
    "[Qualit\u00e9 sup\u00e9rieure]"
  ];

  function exportPdf(doc, path) {
    var i, preset;
    for (i = 0; i < PDF_PRESETS.length; i++) {
      preset = app.pdfExportPresets.itemByName(PDF_PRESETS[i]);
      if (preset.isValid) {
        doc.exportFile(ExportFormat.PDF_TYPE, File(path), false, preset);
        return PDF_PRESETS[i];
      }
    }
    preset = app.pdfExportPresets[0];
    doc.exportFile(ExportFormat.PDF_TYPE, File(path), false, preset);
    return String(preset.name);
  }

  // -- the run ------------------------------------------------------------

  function run() {
    var result = {
      reader: "roundtrip",
      app: { name: app.name, version: app.version, locale: enumName("Locale", app.locale) },
      units: "pt",
      coordinates:
        "page-local, origin top-left of the page, Y down (ruler origin PAGE, zero point 0,0, " +
        "script measurement unit POINTS); bounds as [minX, minY, maxX, maxY]",
      idml: String(PAGED_RT_IDML),
      documents_before: app.documents.length
    };
    var level = app.scriptPreferences.userInteractionLevel;
    var unit = app.scriptPreferences.measurementUnit;
    var doc = null;
    var i, spread, pages, layers;
    // No dialog may ever wait for a click: the runner cannot see the screen.
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    app.scriptPreferences.measurementUnit = MeasurementUnits.POINTS;
    try {
      try {
        doc = app.open(File(PAGED_RT_IDML), false);
      } catch (eo) {
        result.open_error = String(eo.message || eo);
        throw eo;
      }
      result.open = { converted: read(doc, "converted"), modified: read(doc, "modified") };
      doc.viewPreferences.rulerOrigin = RulerOrigin.PAGE_ORIGIN;
      doc.zeroPoint = [0, 0];
      pages = [];
      for (i = 0; i < doc.pages.length; i++) {
        pages.push({ name: String(doc.pages[i].name), bounds: bounds(doc.pages[i].bounds) });
      }
      result.pages = pages;
      layers = [];
      for (i = 0; i < doc.layers.length; i++) layers.push(String(doc.layers[i].name));
      result.layers = layers;
      result.spreads = doc.spreads.length;
      spread = doc.spreads[0];
      result.items = walk(doc, spread, PAGED_RT_LABEL_KEYS);
      // Cross-check the walk against InDesign's own flat collection: an
      // item the walk missed (or met twice) would silently drop geometry.
      result.all_page_items = spread.allPageItems.length;
      if (result.items.length !== result.all_page_items) {
        throw new Error(
          "walk found " + result.items.length + " items, spread.allPageItems has " +
            result.all_page_items
        );
      }
      result.warnings = warningsOf(doc);
      // Every story, with what holds it -- a story that arrived with no
      // container (no frame, no text path) is text InDesign has but shows
      // nowhere.
      result.stories = [];
      for (i = 0; i < doc.stories.length; i++) {
        result.stories.push({
          contents: String(doc.stories[i].contents).substr(0, 80),
          textContainers: doc.stories[i].textContainers.length,
          containerKinds: (function (st) {
            var kinds = [];
            var j;
            for (j = 0; j < st.textContainers.length; j++) {
              kinds.push(st.textContainers[j].constructor.name);
            }
            return kinds;
          })(doc.stories[i])
        });
      }
      if (String(PAGED_RT_PDF) !== "") result.pdf_preset = exportPdf(doc, String(PAGED_RT_PDF));
      // InDesign's OWN IDML export, always: the runner reads the stacking
      // order out of it (see the Z-ORDER note at the top) and keeps it as
      // the re-import fixture when asked to.
      doc.exportFile(ExportFormat.INDESIGN_MARKUP, File(String(PAGED_RT_EXPORT)));
      result.exported = true;
    } catch (e) {
      result.error = String(e.message || e) + (e.line ? " (line " + e.line + ")" : "");
    } finally {
      // The document is never saved and never left open.
      if (doc !== null) {
        try {
          doc.close(SaveOptions.NO);
        } catch (ec) {
          result.close_error = String(ec.message || ec);
        }
      }
      app.scriptPreferences.measurementUnit = unit;
      app.scriptPreferences.userInteractionLevel = level;
    }
    result.documents_after = app.documents.length;
    return json(result);
  }

  return { run: run, json: json };
})();

PagedRoundtrip.run();
