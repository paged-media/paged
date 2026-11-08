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

// Ask InDesign what Update Cross-References writes into stale sources
// (xref-update-probe.sh drives it). Opens the IDML (core's `xref`
// sample), recomposes, reports every cross-reference source before and
// after `update()`: its text range by range (character style, text, and
// for a page-number variable its result), with every special character
// spelled as its code point. Exports InDesign's PDF before the update
// (what it prints from the stored text) and after.
//
// Inputs: PROBE_IDML (to open), PROBE_OUT (JSON), PROBE_PDF_BEFORE,
// PROBE_PDF_AFTER.
(function () {
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    function q(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }
    function spell(s) {
        var o = "";
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            o += (c < 32 || c > 126) ? "<U+" + ("000" + c.toString(16).toUpperCase()).slice(-4) + ">" : s.charAt(i);
        }
        return o;
    }
    var doc = app.open(File($.global.PROBE_IDML), true);
    var out = "{";
    try {
        doc.recompose();
        function dump() {
            var srcs = doc.crossReferenceSources, o = "[";
            for (var i = 0; i < srcs.length; i++) {
                var t = srcs[i].sourceText, rs = t.textStyleRanges, parts = [];
                for (var r = 0; r < rs.length; r++) {
                    var v = "";
                    try {
                        if (rs[r].textVariableInstances.length) v = rs[r].textVariableInstances[0].resultText;
                    } catch (e) { v = "?"; }
                    parts.push("[" + q(rs[r].appliedCharacterStyle.name) + "," + q(spell(rs[r].contents)) + "," + q(v) + "]");
                }
                o += (i ? "," : "") + "{\"name\":" + q(srcs[i].name) + ",\"ranges\":[" + parts.join(",") + "]}";
            }
            return o + "]";
        }
        out += "\"before\":" + dump();
        doc.exportFile(ExportFormat.PDF_TYPE, File($.global.PROBE_PDF_BEFORE));
        var err = "";
        try { doc.crossReferenceSources.everyItem().update(); } catch (e) { err = String(e); }
        doc.recompose();
        out += ",\"after\":" + dump() + ",\"error\":" + q(err) + "}";
        doc.exportFile(ExportFormat.PDF_TYPE, File($.global.PROBE_PDF_AFTER));
    } finally {
        doc.close(SaveOptions.NO);
    }
    var f = File($.global.PROBE_OUT);
    f.encoding = "UTF-8";
    f.open("w");
    f.write(out);
    f.close();
})();
