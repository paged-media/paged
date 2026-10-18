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


// Ask InDesign how a tagged PDF structures a table (tagged-tables-probe.sh
// drives it). Builds one story: a paragraph, a 3x2 table whose first row is
// a header row, and a paragraph after it. Exports InDesign's IDML and a
// tagged PDF with the application's PDF preferences; the PDF's structure is
// read with pdf-structure.py.
//
// Inputs: PROBE_OUT (JSON), PROBE_IDML, PROBE_PDF.
(function () {
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    app.scriptPreferences.measurementUnit = MeasurementUnits.POINTS;
    function q(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }
    var log = [];
    var doc = app.documents.add(true);
    try { build(); } finally { doc.close(SaveOptions.NO); }
    function build() {
        doc.documentPreferences.facingPages = false;
        doc.documentPreferences.pageWidth = 400;
        doc.documentPreferences.pageHeight = 300;
        var f = doc.pages[0].textFrames.add({ geometricBounds: [20, 20, 280, 380] });
        var story = f.parentStory;
        story.contents = "Before the table.\r\rAfter the table.";
        try {
            var t = story.paragraphs[1].insertionPoints[0].tables.add({ bodyRowCount: 2, headerRowCount: 1, columnCount: 2 });
            var texts = ["Head A", "Head B", "Cell 1", "Cell 2", "Cell 3", "Cell 4"];
            for (var i = 0; i < t.cells.length; i++) t.cells[i].contents = texts[i];
        } catch (e) { log.push("table: " + e); }
        doc.recompose();
        doc.exportFile(ExportFormat.INDESIGN_MARKUP, File($.global.PROBE_IDML));
        var prefs = app.pdfExportPreferences;
        var was = prefs.includeStructure;
        prefs.includeStructure = true;
        try { doc.exportFile(ExportFormat.PDF_TYPE, File($.global.PROBE_PDF), false); }
        finally { prefs.includeStructure = was; }
        var out = File($.global.PROBE_OUT); out.encoding = "UTF-8"; out.open("w");
        out.write('{"log": [' + (log.length ? q(log.join("; ")) : "") + ']}'); out.close();
    }
})();
