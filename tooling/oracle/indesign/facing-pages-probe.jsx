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

// Ask InDesign what Facing Pages does to an existing document
// (facing-pages-probe.sh drives it; engine ADR 1312):
//   1. a single-sided document of four pages whose one-page master carries
//      two marked rectangles and uneven margins is switched to facing
//      pages: how many pages its master has then, where its items went,
//      what each body page's side, master and margins are;
//   2. a one-page master is added to that facing document and applied to a
//      left-hand and a right-hand page: which master items each shows;
//   3. a page is moved and one duplicated ("allow document pages to
//      shuffle"): how the pages pair up again and whether a page keeps its
//      own items and master;
//   4. facing pages off again: what the masters keep;
//   5. where a one-page master's item is printed on a left-hand and a
//      right-hand page of a document switched to facing pages: a black
//      rectangle on the master, the pages exported to PROBE_PDF one page
//      per PDF page (facing-pages-probe.sh measures it there; an item an
//      override makes is placed by other rules, so it is not asked).
// Each body page carries a rectangle labelled with its first position, so
// a page is followed by its item, not by its folio.
//
// Inputs: PROBE_OUT (JSON), PROBE_IDML (InDesign's IDML of the end state),
// PROBE_PDF (step 5's PDF).
(function () {
    var OUT = $.global.PROBE_OUT;
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    app.scriptPreferences.measurementUnit = MeasurementUnits.POINTS;
    function q(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }
    function n(v) { return Math.round(v * 100) / 100; }
    function box(b) { return "[" + n(b[0]) + ", " + n(b[1]) + ", " + n(b[2]) + ", " + n(b[3]) + "]"; }
    function side(pg) {
        if (pg.side == PageSideOptions.LEFT_HAND) return "left";
        if (pg.side == PageSideOptions.RIGHT_HAND) return "right";
        return "single";
    }
    function items(owner) {
        var out = [], all = owner.allPageItems;
        for (var i = 0; i < all.length; i++) {
            var it = all[i], on = it.parentPage;
            out.push("{\"label\": " + q(it.label) + ", \"page\": " + q(on ? on.name : "pasteboard") +
                ", \"bounds\": " + box(it.geometricBounds) + "}");
        }
        return "[" + out.join(", ") + "]";
    }
    function masters(doc) {
        var out = [];
        for (var m = 0; m < doc.masterSpreads.length; m++) {
            var ms = doc.masterSpreads[m], pages = [];
            for (var p = 0; p < ms.pages.length; p++) {
                var pg = ms.pages[p], mp = pg.marginPreferences;
                pages.push("{\"side\": " + q(side(pg)) + ", \"bounds\": " + box(pg.bounds) +
                    ", \"margins\": [" + n(mp.left) + ", " + n(mp.right) + "]}");
            }
            out.push("{\"name\": " + q(ms.name) + ", \"pages\": [" + pages.join(", ") + "], \"items\": " + items(ms) + "}");
        }
        return "[" + out.join(",\n    ") + "]";
    }
    function bodyPages(doc) {
        var out = [];
        for (var s = 0; s < doc.spreads.length; s++) {
            var sp = doc.spreads[s];
            for (var p = 0; p < sp.pages.length; p++) {
                var pg = sp.pages[p], mp = pg.marginPreferences, own = [], shown = [];
                for (var i = 0; i < pg.pageItems.length; i++) own.push(q(pg.pageItems[i].label));
                var mi = pg.masterPageItems;
                for (var k = 0; k < mi.length; k++) shown.push(q(mi[k].label));
                out.push("{\"spread\": " + s + ", \"name\": " + q(pg.name) + ", \"side\": " + q(side(pg)) +
                    ", \"master\": " + q(pg.appliedMaster ? pg.appliedMaster.name : "none") +
                    ", \"bounds\": " + box(pg.bounds) + ", \"margins\": [" + n(mp.left) + ", " + n(mp.right) +
                    "], \"items\": [" + own.join(", ") + "], \"masterItems\": [" + shown.join(", ") + "]}");
            }
        }
        return "[" + out.join(",\n    ") + "]";
    }
    function state(doc, step) {
        return "{\"step\": " + q(step) + ", \"facingPages\": " + doc.documentPreferences.facingPages +
            ", \"allowPageShuffle\": " + doc.documentPreferences.allowPageShuffle +
            ",\n  \"masters\": " + masters(doc) + ",\n  \"pages\": " + bodyPages(doc) + "}";
    }

    // A single-sided document is made single-sided, not switched to it: a
    // facing document switched off keeps its two-page master.
    var appFacing = app.documentPreferences.facingPages;
    app.documentPreferences.facingPages = false;
    var doc;
    try {
        doc = app.documents.add(false);
    } finally {
        app.documentPreferences.facingPages = appFacing;
    }
    var steps = [];
    try {
        var dp = doc.documentPreferences;
        dp.pageWidth = 400;
        dp.pageHeight = 600;
        dp.pagesPerDocument = 4;
        var master = doc.masterSpreads[0], mpage = master.pages[0];
        mpage.marginPreferences.left = 20;
        mpage.marginPreferences.right = 50;
        mpage.rectangles.add({ geometricBounds: [30, 5, 60, 45], label: "master-left-edge" });
        mpage.rectangles.add({ geometricBounds: [30, 355, 60, 395], label: "master-right-edge" });
        for (var p = 0; p < doc.pages.length; p++) {
            var pb = doc.pages[p].bounds;
            doc.pages[p].rectangles.add({
                geometricBounds: [pb[0] + 100, pb[1] + 100, pb[0] + 150, pb[1] + 150],
                label: "body-" + (p + 1)
            });
        }
        steps.push(state(doc, "single-sided"));

        dp.facingPages = true;
        steps.push(state(doc, "facing on"));

        var one = doc.masterSpreads.add(1, { namePrefix: "B", baseName: "One" });
        one.pages[0].rectangles.add({ geometricBounds: [30, 5, 60, 45], label: "one-page-master-left-edge" });
        doc.pages[1].appliedMaster = one;
        doc.pages[2].appliedMaster = one;
        steps.push(state(doc, "one-page master on pages 2 and 3"));

        doc.pages[3].move(LocationOptions.AFTER, doc.pages[0]);
        steps.push(state(doc, "page 4 moved after page 1"));

        doc.pages[1].duplicate(LocationOptions.AFTER, doc.pages[1]);
        steps.push(state(doc, "page 2 duplicated after itself"));

        doc.pages[3].move(LocationOptions.AT_BEGINNING);
        steps.push(state(doc, "page 4 moved to the front"));

        dp.facingPages = false;
        steps.push(state(doc, "facing off"));

        if ($.global.PROBE_IDML) doc.exportFile(ExportFormat.INDESIGN_MARKUP, File($.global.PROBE_IDML));
    } finally {
        doc.close(SaveOptions.NO);
    }

    // 5. Where a one-page master's item is printed on each side: a fresh
    //    single-sided document of three pages, a black rectangle 5-45 pt
    //    from its master page's left edge, switched to facing pages and
    //    exported one page per PDF page.
    app.documentPreferences.facingPages = false;
    var doc2;
    try {
        doc2 = app.documents.add(false);
    } finally {
        app.documentPreferences.facingPages = appFacing;
    }
    var sides = [];
    try {
        doc2.documentPreferences.pageWidth = 400;
        doc2.documentPreferences.pageHeight = 600;
        doc2.documentPreferences.pagesPerDocument = 3;
        var edge = doc2.masterSpreads[0].pages[0].rectangles.add({ geometricBounds: [30, 5, 60, 45] });
        edge.fillColor = doc2.swatches.itemByName("Black");
        doc2.documentPreferences.facingPages = true;
        for (var k = 0; k < doc2.pages.length; k++) sides.push(q(side(doc2.pages[k])));
        var pdf = app.pdfExportPreferences, spreads = pdf.exportReaderSpreads, range = pdf.pageRange;
        pdf.exportReaderSpreads = false;
        pdf.pageRange = PageRange.ALL_PAGES;
        try {
            doc2.exportFile(ExportFormat.PDF_TYPE, File($.global.PROBE_PDF));
        } finally {
            pdf.exportReaderSpreads = spreads;
            pdf.pageRange = range;
        }
    } finally {
        doc2.close(SaveOptions.NO);
    }

    var f = File(OUT);
    f.encoding = "UTF-8";
    f.open("w");
    f.write("{\"indesign\": " + q(app.version) + ", \"steps\": [\n" + steps.join(",\n") +
        "\n],\n\"onePageMasterPdfSides\": [" + sides.join(", ") + "]}\n");
    f.close();
})();
