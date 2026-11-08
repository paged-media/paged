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

// Ask InDesign what structure it writes into a tagged PDF
// (tagged-pdf-probe.sh drives it): opens PROBE_IN (an absolute .idml),
// exports it with the application's PDF preferences and Create Tagged PDF on
// to PROBE_PDF, and reports the document's stories in its own order, each
// with its paragraphs' style names and first words, to PROBE_OUT. The PDF's
// structure tree is read with pdf-structure.py.
//
// Inputs: PROBE_IN, PROBE_OUT (JSON), PROBE_IDML, PROBE_PDF.
(function () {
    var OUT = $.global.PROBE_OUT;
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    app.scriptPreferences.measurementUnit = MeasurementUnits.POINTS;
    function q(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\t]/g, " ") + '"'; }
    var doc = app.open(File($.global.PROBE_IN), true);
    try {
        doc.recompose();
        var stories = [];
        for (var s = 0; s < doc.stories.length; s++) {
            var st = doc.stories[s], paras = [];
            for (var p = 0; p < st.paragraphs.length; p++) {
                var para = st.paragraphs[p];
                paras.push("[" + q(para.appliedParagraphStyle.name) + ", " + q(String(para.contents).substr(0, 24)) + "]");
            }
            stories.push('{"id": ' + st.id + ', "paragraphs": [' + paras.join(", ") + "]}");
        }
        // The application's PDF preferences, Create Tagged PDF on (a
        // preset passed to exportFile would override it).
        var prefs = app.pdfExportPreferences;
        var was = [prefs.includeStructure, prefs.includeBookmarks];
        prefs.includeStructure = true;
        prefs.includeBookmarks = true;
        try { doc.exportFile(ExportFormat.PDF_TYPE, File($.global.PROBE_PDF), false); }
        finally { prefs.includeStructure = was[0]; prefs.includeBookmarks = was[1]; }
        var f = File(OUT); f.encoding = "UTF-8"; f.open("w");
        f.write('{\n  "includeStructure": ' + app.pdfExportPreferences.includeStructure + ',\n  "stories": [\n    ' + stories.join(",\n    ") + "\n  ]\n}\n");
        f.close();
    } finally { doc.close(SaveOptions.NO); }
})();
