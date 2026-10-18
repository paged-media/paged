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


// Ask InDesign how it writes a document's XML structure (tagged content)
// to IDML (xml-structure-probe.sh drives it). Builds one page: a story
// tagged Article whose two paragraphs are tagged Title and Body, an image
// frame tagged Figure carrying an attribute, and an untagged frame. Reports
// the structure depth-first (tag, attributes, contents) to PROBE_OUT and
// exports IDML and PDF.
//
// With PROBE_IN (an absolute .idml) it opens that package instead and
// reports its structure.
//
// Inputs: PROBE_OUT (JSON), PROBE_IDML, PROBE_PDF, PROBE_IN (optional).
(function () {
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    app.scriptPreferences.measurementUnit = MeasurementUnits.POINTS;
    function q(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\t]/g, " ") + '"'; }
    var log = [];
    var IN = $.global.PROBE_IN;
    var doc = IN ? app.open(File(IN), true) : app.documents.add(true);
    try { if (IN) read(); else build(); } finally { doc.close(SaveOptions.NO); }
    function read() {
        var out = [];
        walk(doc.xmlElements[0], 0, out);
        var f2 = File($.global.PROBE_OUT); f2.encoding = "UTF-8"; f2.open("w");
        f2.write('{"structure": [' + out.join(", ") + "]}");
        f2.close();
    }
    function walk(el, depth, out) {
        var attrs = [];
        for (var a = 0; a < el.xmlAttributes.length; a++) attrs.push(el.xmlAttributes[a].name + "=" + el.xmlAttributes[a].value);
        var c = "";
        try { c = String(el.contents).substr(0, 30); } catch (e) {}
        out.push("[" + depth + ", " + q(el.markupTag.name) + ", " + q(attrs.join(";")) + ", " + q(c) + "]");
        for (var i = 0; i < el.xmlElements.length; i++) walk(el.xmlElements[i], depth + 1, out);
    }
    function build() {
        doc.documentPreferences.facingPages = false;
        doc.documentPreferences.pageWidth = 400;
        doc.documentPreferences.pageHeight = 300;
        var page = doc.pages[0];
        var tags = {};
        var names = ["Article", "Title", "Body", "Figure"];
        for (var t = 0; t < names.length; t++) tags[names[t]] = doc.xmlTags.add(names[t]);
        var root = doc.xmlElements[0];
        var f = page.textFrames.add({ geometricBounds: [20, 20, 150, 380] });
        f.parentStory.contents = "A Tagged Title\rThe tagged body text.";
        try {
            var art = root.xmlElements.add(tags.Article);
            art.markup(f.parentStory);
            var st = f.parentStory;
            st.paragraphs[0].texts[0].associatedXMLElements;
            art.xmlElements.add(tags.Title, st.paragraphs[0].texts[0]);
            art.xmlElements.add(tags.Body, st.paragraphs[1].texts[0]);
        } catch (e) { log.push("story: " + e); }
        try {
            var r = page.rectangles.add({ geometricBounds: [160, 20, 280, 180] });
            var fig = root.xmlElements.add(tags.Figure);
            fig.markup(r);
            fig.xmlAttributes.add("alt", "A grey box");
        } catch (e) { log.push("figure: " + e); }
        page.textFrames.add({ geometricBounds: [160, 200, 280, 380], contents: "Untagged." });
        var out = [];
        walk(root, 0, out);
        doc.exportFile(ExportFormat.INDESIGN_MARKUP, File($.global.PROBE_IDML));
        doc.exportFile(ExportFormat.PDF_TYPE, File($.global.PROBE_PDF));
        var f2 = File($.global.PROBE_OUT); f2.encoding = "UTF-8"; f2.open("w");
        f2.write('{"log": [' + (log.length ? q(log.join("; ")) : "") + '], "structure": [' + out.join(", ") + "]}");
        f2.close();
    }
})();
