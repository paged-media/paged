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


// Ask InDesign which fonts a package's text resolves to (fonts-probe.sh
// drives it): opens PROBE_IN (an absolute .idml) and reports, per story,
// its first character's applied font and that font's status, and the
// document's font list with each font's status, to PROBE_OUT; exports a
// PDF to PROBE_PDF.
(function () {
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    function q(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t") + '"'; }
    var doc = app.open(File($.global.PROBE_IN), true);
    try {
        doc.recompose();
        var stories = [];
        for (var s = 0; s < doc.stories.length; s++) {
            var st = doc.stories[s];
            if (!st.characters.length) continue;
            var f = st.characters[0].appliedFont;
            var name = f && f.isValid ? f.name : String(f);
            var status = f && f.isValid ? String(f.status) : "?";
            stories.push("[" + q(name) + ", " + q(status) + "]");
        }
        var fonts = [];
        for (var i = 0; i < doc.fonts.length; i++) fonts.push("[" + q(doc.fonts[i].name) + ", " + q(String(doc.fonts[i].status)) + "]");
        if ($.global.PROBE_PDF) doc.exportFile(ExportFormat.PDF_TYPE, File($.global.PROBE_PDF));
        var out = File($.global.PROBE_OUT); out.encoding = "UTF-8"; out.open("w");
        out.write('{"stories": [' + stories.join(", ") + '], "fonts": [' + fonts.join(", ") + "]}");
        out.close();
    } finally { doc.close(SaveOptions.NO); }
})();
