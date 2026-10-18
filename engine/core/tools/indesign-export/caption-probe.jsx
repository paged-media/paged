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


// Ask InDesign what a live caption prints (caption-probe.sh drives it).
// Places PROBE_IMAGE_A in a frame, puts a text frame under it touching
// it, and inserts a Live Caption variable reading the link's Name. Reports
// the caption's text and exports IDML and PDF; then relinks the frame to
// PROBE_IMAGE_B and exports a second PDF without touching the caption,
// to ask whether the caption follows the link.
//
// Inputs: PROBE_OUT (JSON), PROBE_IDML, PROBE_PDF, PROBE_PDF_RELINKED,
// PROBE_IMAGE_A, PROBE_IMAGE_B (absolute paths).
(function () {
    var OUT = $.global.PROBE_OUT;
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
        var page = doc.pages[0];
        var pic = page.rectangles.add({ geometricBounds: [20, 20, 148, 148] });
        pic.place(File($.global.PROBE_IMAGE_A));
        var cap = page.textFrames.add({ geometricBounds: [148, 20, 180, 300] });
        var tv = doc.textVariables.add({ name: "Caption Name", variableType: VariableTypes.LIVE_CAPTION_TYPE });
        try { tv.variableOptions.metadataProviderName = "$ID/#LinkInfoNameStr"; } catch (e) { log.push("provider: " + e); }
        try { tv.variableOptions.textBefore = "Image: "; } catch (e) { log.push("before: " + e); }
        cap.insertionPoints[0].textVariableInstances.add({ associatedTextVariable: tv });
        doc.recompose();
        var before = "";
        try { before = String(cap.parentStory.textVariableInstances[0].resultText); } catch (e) { log.push("result: " + e); }
        doc.exportFile(ExportFormat.INDESIGN_MARKUP, File($.global.PROBE_IDML));
        doc.exportFile(ExportFormat.PDF_TYPE, File($.global.PROBE_PDF));
        try { pic.graphics[0].itemLink.relink(File($.global.PROBE_IMAGE_B)); } catch (e) { log.push("relink: " + e); }
        doc.recompose();
        var after = "";
        try { after = String(cap.parentStory.textVariableInstances[0].resultText); } catch (e) { log.push("result2: " + e); }
        if ($.global.PROBE_PDF_RELINKED) doc.exportFile(ExportFormat.PDF_TYPE, File($.global.PROBE_PDF_RELINKED));
        var out = "{\"log\":[";
        for (var l = 0; l < log.length; l++) out += (l ? "," : "") + q(log[l]);
        out += "],\"before\":" + q(before) + ",\"afterRelink\":" + q(after) + "}";
        var f = File(OUT);
        f.encoding = "UTF-8";
        f.open("w");
        f.write(out);
        f.close();
    }
})();
