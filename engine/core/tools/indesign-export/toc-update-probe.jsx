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

// Ask InDesign what Update Table of Contents writes into an existing TOC
// story (toc-update-probe.sh drives it). Opens the IDML, reports each TOC
// story before and after `createTOC(style, replacing = true)` paragraph
// by paragraph (style; character ranges with their style and text, every
// special character spelled as its code point) and the document's
// hyperlink and bookmark counts, then saves InDesign's IDML and PDF.
//
// Inputs: PROBE_IDML (to open), PROBE_OUT (JSON), PROBE_RESAVE (IDML),
// PROBE_PDF.
(function () {
    var IN = $.global.PROBE_IDML, OUT = $.global.PROBE_OUT;
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    app.scriptPreferences.measurementUnit = MeasurementUnits.POINTS;
    function q(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }
    function spell(s) {
        var o = "";
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            o += (c < 32 || c > 126) ? "<U+" + ("000" + c.toString(16).toUpperCase()).slice(-4) + ">" : s.charAt(i);
        }
        return o;
    }
    function dump(story) {
        var o = "[", ps = story.paragraphs;
        for (var k = 0; k < ps.length; k++) {
            o += (k ? "," : "") + "{\"style\":" + q(ps[k].appliedParagraphStyle.name) + ",\"ranges\":[";
            var rs = ps[k].textStyleRanges;
            for (var r = 0; r < rs.length; r++) {
                o += (r ? "," : "") + "[" + q(rs[r].appliedCharacterStyle.name) + "," + q(spell(rs[r].contents)) + "]";
            }
            o += "]}";
        }
        return o + "]";
    }
    function tocStories(doc) {
        var out = [];
        for (var i = 0; i < doc.stories.length; i++) {
            if (doc.stories[i].storyType == StoryTypes.TOC_STORY) out.push(doc.stories[i]);
        }
        return out;
    }
    var doc = app.open(File(IN), true);
    var out = "{\"log\":[";
    var log = [];
    try {
        var before = tocStories(doc);
        out += "],\"tocStoriesBefore\":" + before.length + ",\"before\":" + (before.length ? dump(before[0]) : "[]");
        var counts = [doc.hyperlinks.length, doc.bookmarks.length];
        var style = doc.tocStyles.itemByName("Contents");
        try { doc.createTOC(style, true); } catch (e) { log.push("createTOC: " + e); }
        var after = tocStories(doc);
        out += ",\"tocStoriesAfter\":" + after.length + ",\"after\":" + (after.length ? dump(after[0]) : "[]");
        out += ",\"linksBefore\":" + counts[0] + ",\"bookmarksBefore\":" + counts[1]
            + ",\"linksAfter\":" + doc.hyperlinks.length + ",\"bookmarksAfter\":" + doc.bookmarks.length;
        out += ",\"errors\":[";
        for (var l = 0; l < log.length; l++) out += (l ? "," : "") + q(log[l]);
        out += "]}";
        doc.exportFile(ExportFormat.INDESIGN_MARKUP, File($.global.PROBE_RESAVE));
        doc.exportFile(ExportFormat.PDF_TYPE, File($.global.PROBE_PDF));
    } finally {
        doc.close(SaveOptions.NO);
    }
    var f = File(OUT);
    f.encoding = "UTF-8";
    f.open("w");
    f.write(out);
    f.close();
})();
