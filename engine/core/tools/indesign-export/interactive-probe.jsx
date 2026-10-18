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


// Build a document holding InDesign's interactive objects and export its
// IDML and PDF (interactive-probe.sh drives it): a button with a Normal
// and a Rollover state, a multi-state object with two states, a text
// field, a check box, and a plain rectangle to move. Reports what it
// made to PROBE_OUT.
//
// With PROBE_IN (an absolute .idml) it opens that package instead and
// reports its buttons (with their states), multi-state objects (with
// theirs), text boxes, check boxes and the "Mover" rectangle's bounds.
//
// Inputs: PROBE_OUT (JSON), PROBE_IDML, PROBE_PDF, PROBE_IN (optional).
(function () {
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    app.scriptPreferences.measurementUnit = MeasurementUnits.POINTS;
    function q(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }
    var log = [];
    var IN = $.global.PROBE_IN;
    var doc = IN ? app.open(File(IN), true) : app.documents.add(true);
    try { if (IN) read(); else build(); } finally { doc.close(SaveOptions.NO); }
    function read() {
        var p = doc.pages[0], o = [];
        for (var i = 0; i < p.buttons.length; i++) o.push("button " + p.buttons[i].name + ":" + p.buttons[i].states.length);
        for (var j = 0; j < p.multiStateObjects.length; j++) o.push("mso " + p.multiStateObjects[j].name + ":" + p.multiStateObjects[j].states.length);
        o.push("textboxes:" + p.textBoxes.length, "checkboxes:" + p.checkBoxes.length);
        var m = p.rectangles.itemByName("Mover");
        if (m.isValid) o.push("mover:" + m.geometricBounds.join(" "));
        var out = File($.global.PROBE_OUT); out.encoding = "UTF-8"; out.open("w");
        out.write('{"read": ' + q(o.join(", ")) + "}"); out.close();
    }
    function build() {
        doc.documentPreferences.facingPages = false;
        doc.documentPreferences.pageWidth = 400;
        doc.documentPreferences.pageHeight = 300;
        var page = doc.pages[0];
        var made = [];
        try {
            var b = page.buttons.add({ geometricBounds: [20, 20, 60, 120], name: "Go" });
            b.states.add();
            made.push("button:" + b.states.length);
        } catch (e) { log.push("button: " + e); }
        try {
            var r1 = page.rectangles.add({ geometricBounds: [80, 20, 120, 120] });
            var r2 = page.rectangles.add({ geometricBounds: [80, 20, 120, 120] });
            var mso = page.multiStateObjects.add({ name: "Slides" });
            mso.addItemsAsState([r1]);
            mso.addItemsAsState([r2]);
            made.push("mso:" + mso.states.length);
        } catch (e) { log.push("mso: " + e); }
        try {
            page.textBoxes.add({ geometricBounds: [140, 20, 160, 200], name: "Name field" });
            made.push("textbox");
        } catch (e) { log.push("textbox: " + e); }
        try {
            page.checkBoxes.add({ geometricBounds: [170, 20, 185, 35], name: "Agree" });
            made.push("checkbox");
        } catch (e) { log.push("checkbox: " + e); }
        page.rectangles.add({ geometricBounds: [200, 250, 260, 380], name: "Mover" });
        doc.exportFile(ExportFormat.INDESIGN_MARKUP, File($.global.PROBE_IDML));
        doc.exportFile(ExportFormat.PDF_TYPE, File($.global.PROBE_PDF));
        var out = File($.global.PROBE_OUT); out.encoding = "UTF-8"; out.open("w");
        out.write('{"log": [' + (log.length ? q(log.join("; ")) : "") + '], "made": ' + q(made.join(",")) + "}");
        out.close();
    }
})();
