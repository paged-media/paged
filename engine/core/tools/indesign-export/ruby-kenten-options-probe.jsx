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

// Ask InDesign what each ruby and kenten setting does
// (ruby-kenten-options-probe.sh drives it). One frame per case: Kozuka
// Mincho Pr6N R 30 pt "漢字漢字漢字" under the Japanese Paragraph
// Composer, group ruby かんじ over the 5th and 6th characters (ruby cases)
// or sesame kenten over the first two (kenten cases), one setting changed
// from InDesign's default. Writes ruby-kenten-options.{pdf,idml,json} into
// PROBE_OUT; the marks are measured from the PDF (pdf-text.py).
(function () {
    var OUT = Folder(String($.global.PROBE_OUT));
    var errors = [], names = [];
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    var doc = app.documents.add(false);
    try {
        doc.documentPreferences.pageWidth = 595.276;
        doc.documentPreferences.pageHeight = 841.89;
        doc.viewPreferences.horizontalMeasurementUnits = MeasurementUnits.POINTS;
        doc.viewPreferences.verticalMeasurementUnits = MeasurementUnits.POINTS;
        doc.viewPreferences.rulerOrigin = RulerOrigin.PAGE_ORIGIN;
        doc.zeroPoint = [0, 0];
        var R = function (set) { return { ruby: set }; }, K = function (set) { return { kenten: set }; };
        // Wide bases: ruby かんじ over FOUR characters (2..5, 120 pt), so
        // JIS, 1-aki and equal aki part ways; offsets with the marks below.
        var R = function (set) { return { ruby: set, wide: true }; };
        var B = function (set) { return { ruby: set }; }, K = function (set) { return { kenten: set }; };
        // One setting changed per frame. Ruby cases set group ruby かんじ
        // over the 5th and 6th characters (60 pt), "wide" ones over the 2nd
        // to 5th (120 pt, where JIS, 1-aki and equal aki part ways); kenten
        // cases set sesame kenten over the first two.
        var R = function (set) { return { ruby: set }; }, W = function (set) { return { ruby: set, wide: true }; };
        var K = function (set) { return { kenten: set }; };
        var CASES = [
            ["ruby-default", R(function (r) {})],
            ["ruby-size12", R(function (r) { r.rubyFontSize = 12; })],
            ["ruby-xscale50", R(function (r) { r.rubyXScale = 50; })],
            ["ruby-yscale200", R(function (r) { r.rubyYScale = 200; })],
            ["ruby-xoffset5", R(function (r) { r.rubyXOffset = 5; })],
            ["ruby-yoffset5", R(function (r) { r.rubyYOffset = 5; })],
            ["ruby-below", R(function (r) { r.rubyPosition = RubyKentenPosition.BELOW_LEFT; })],
            ["ruby-below-yoffset5", R(function (r) { r.rubyPosition = RubyKentenPosition.BELOW_LEFT; r.rubyYOffset = 5; })],
            ["ruby-below-xoffset5", R(function (r) { r.rubyPosition = RubyKentenPosition.BELOW_LEFT; r.rubyXOffset = 5; })],
            ["ruby-left", R(function (r) { r.rubyAlignment = RubyAlignments.RUBY_LEFT; })],
            ["ruby-center", R(function (r) { r.rubyAlignment = RubyAlignments.RUBY_CENTER; })],
            ["ruby-right", R(function (r) { r.rubyAlignment = RubyAlignments.RUBY_RIGHT; })],
            ["ruby-full", R(function (r) { r.rubyAlignment = RubyAlignments.RUBY_FULL_JUSTIFY; })],
            ["ruby-equalaki", R(function (r) { r.rubyAlignment = RubyAlignments.RUBY_EQUAL_AKI; })],
            ["ruby-1aki", R(function (r) { r.rubyAlignment = RubyAlignments.RUBY_1_AKI; })],
            ["wide-jis", W(function (r) {})],
            ["wide-1aki", W(function (r) { r.rubyAlignment = RubyAlignments.RUBY_1_AKI; })],
            ["wide-equalaki", W(function (r) { r.rubyAlignment = RubyAlignments.RUBY_EQUAL_AKI; })],
            ["wide-full", W(function (r) { r.rubyAlignment = RubyAlignments.RUBY_FULL_JUSTIFY; })],
            ["kenten-default", K(function (k) {})],
            ["kenten-size12", K(function (k) { k.kentenFontSize = 12; })],
            ["kenten-xscale50", K(function (k) { k.kentenXScale = 50; })],
            ["kenten-yscale200", K(function (k) { k.kentenYScale = 200; })],
            ["kenten-placement5", K(function (k) { k.kentenPlacement = 5; })],
            ["kenten-below", K(function (k) { k.kentenPosition = RubyKentenPosition.BELOW_LEFT; })],
            ["kenten-below-placement5", K(function (k) { k.kentenPosition = RubyKentenPosition.BELOW_LEFT; k.kentenPlacement = 5; })],
            ["kenten-left", K(function (k) { k.kentenAlignment = KentenAlignment.ALIGN_KENTEN_LEFT; })],
            ["kenten-custom", K(function (k) { k.kentenKind = KentenCharacter.CUSTOM; k.kentenCustomCharacter = "★"; })],
            ["kenten-custom-font", K(function (k) { k.kentenKind = KentenCharacter.CUSTOM; k.kentenCustomCharacter = "A"; k.kentenFont = app.fonts.itemByName("Minion Pro\tRegular"); })]
        ];
        var page = doc.pages[0];
        for (var c = 0; c < CASES.length; c++) {
            if (c > 0 && c % 11 === 0) page = doc.pages.add();
            var top = 50 + (c % 11) * 70;
            var tf = page.textFrames.add({ geometricBounds: [top, 60, top + 60, 500] });
            tf.contents = "漢字漢字漢字";
            var t = tf.parentStory.texts[0];
            t.appliedFont = app.fonts.itemByName("Kozuka Mincho Pr6N\tR");
            t.pointSize = 30;
            tf.parentStory.paragraphs[0].composer = "$ID/HL Composer J";
            var cs = CASES[c][1];
            try {
                if (cs.ruby) {
                    var r = cs.wide ? tf.parentStory.characters.itemByRange(1, 4) : tf.parentStory.characters.itemByRange(4, 5);
                    r.rubyFlag = true; r.rubyType = RubyTypes.GROUP_RUBY; r.rubyString = "かんじ";
                    cs.ruby(r);
                } else {
                    var k = tf.parentStory.characters.itemByRange(0, 1);
                    k.kentenKind = KentenCharacter.KENTEN_SESAME_DOT;
                    cs.kenten(k);
                }
            } catch (e) { errors.push(CASES[c][0] + ": " + e); }
            names.push(CASES[c][0] + "@" + (doc.pages.length - 1) + ":" + top);
        }
        doc.exportFile(ExportFormat.PDF_TYPE, File(OUT.fsName + "/ruby-kenten-options.pdf"));
        doc.exportFile(ExportFormat.INDESIGN_MARKUP, File(OUT.fsName + "/ruby-kenten-options.idml"));
    } catch (e) {
        errors.push(String(e) + " @" + e.line);
    }
    doc.close(SaveOptions.NO);
    var f = File(OUT.fsName + "/ruby-kenten-options.json");
    f.encoding = "UTF-8"; f.open("w");
    f.write('{"version":"' + app.version + '","cases":["' + names.join('","') + '"],"errors":["' + errors.join('","').replace(/\\/g, "\\\\") + '"]}');
    f.close();
})();
