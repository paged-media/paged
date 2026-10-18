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


// Ask InDesign how far a ragged line may overrun its measure to keep its
// last word, and what it does with the overrun (ragged-squeeze-probe.sh
// drives it). Open Sans, left aligned, Paragraph Composer, hyphenation off.
//
// "allowance": for each size, each run of words before it and each last
// word, the frame is the line's natural width minus d, and d is bisected
// to where the last word leaves the line.
//
// "squeeze": three lines set a little past their measure (inside the
// allowance), with every character's x at natural width and in the frame.
(function () {
    var OUT = $.global.PROBE_OUT;
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    var doc = app.documents.add(false);
    doc.viewPreferences.horizontalMeasurementUnits = MeasurementUnits.POINTS;
    doc.viewPreferences.verticalMeasurementUnits = MeasurementUnits.POINTS;
    var page = doc.pages[0];
    function frame(text, w, size) {
        var tf = page.textFrames.add({ geometricBounds: [20, 20, 400, 20 + w] });
        tf.textFramePreferences.insetSpacing = [0, 0, 0, 0];
        tf.contents = text;
        var p = tf.paragraphs[0];
        p.appliedFont = "Open Sans\tRegular";
        p.pointSize = size;
        p.hyphenation = false;
        p.justification = Justification.LEFT_ALIGN;
        p.composer = "$ID/HL Composer";
        return tf;
    }
    function natural(text, size) {
        var tf = frame(text, 3000, size);
        var line = tf.lines[0];
        var n = line.endHorizontalOffset - line.horizontalOffset;
        var s = text.lastIndexOf(" ");
        var word = n - (tf.characters[s + 1].horizontalOffset - 20);
        var xs = [];
        for (var i = 0; i < tf.characters.length; i++) xs.push(r3(tf.characters[i].horizontalOffset - 20));
        tf.remove();
        return { width: n, word: word, xs: xs };
    }
    function r3(v) { return Math.round(v * 1000) / 1000; }
    function r4(v) { return Math.round(v * 10000) / 10000; }

    var allowance = [];
    var words = ["m", "mm", "shrink", "shrinkshrink", "justified,spacesnevershrink"];
    var befores = ["never ", "justified, spaces never ",
        "justified, spaces never shrink, justified, spaces never "];
    var sizes = [8, 12, 18];
    for (var z = 0; z < sizes.length; z++) {
        for (var b = 0; b < befores.length; b++) {
            for (var w = 0; w < words.length; w++) {
                var text = befores[b] + words[w];
                var nat = natural(text, sizes[z]);
                var lo = 0, hi = 0.05 * sizes[z] + 0.03 * nat.word;
                for (var k = 0; k < 20; k++) {
                    var mid = (lo + hi) / 2;
                    var tf = frame(text, nat.width - mid, sizes[z]);
                    var one = tf.lines.length == 1 && !tf.parentStory.overflows;
                    tf.remove();
                    if (one) lo = mid; else hi = mid;
                }
                allowance.push('    {"size": ' + sizes[z] + ', "text": "' + text + '", "natural": ' + r4(nat.width) +
                    ', "last_word": ' + r4(nat.word) + ', "allowance": ' + r4(lo) + '}');
            }
        }
    }

    var squeeze = [];
    var cases = [
        ["justified, spaces never shrink", 0.3],
        ["a b c d e f g h i j k l m", 0.2],
        ["never justified,spacesnevershrink", 1.4]
    ];
    for (var c = 0; c < cases.length; c++) {
        var nat = natural(cases[c][0], 12);
        var tf = frame(cases[c][0], nat.width - cases[c][1], 12);
        var xs = [];
        for (var i = 0; i < tf.characters.length; i++) xs.push(r3(tf.characters[i].horizontalOffset - 20));
        squeeze.push('    {"size": 12, "text": "' + cases[c][0] + '", "overrun": ' + cases[c][1] +
            ', "natural": ' + r4(nat.width) + ', "lines": ' + tf.lines.length +
            ', "line_end": ' + r4(tf.lines[0].endHorizontalOffset - 20) +
            ', "natural_x": [' + nat.xs.join(", ") + '], "in_frame_x": [' + xs.join(", ") + ']}');
        tf.remove();
    }

    var json = '{\n  "indesign": "' + app.version + '",\n  "allowance": [\n' + allowance.join(",\n") +
        '\n  ],\n  "squeeze": [\n' + squeeze.join(",\n") + '\n  ]\n}\n';
    var f = File(OUT);
    f.encoding = "UTF-8";
    f.lineFeed = "Unix";
    f.open("w");
    f.write(json);
    f.close();
    doc.close(SaveOptions.NO);
})();
