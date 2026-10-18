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


// Ask InDesign how far a line may run past its measure before the
// Paragraph Composer breaks it (fit-tolerance-probe.sh drives it). For each
// size and alignment it sets "justified, spaces never shrink" (Open Sans,
// hyphenation off, word spacing 100/100/133) in a frame its natural width
// minus d wide, and bisects d to where the last word leaves the line.
//
// Input: PROBE_OUT (the JSON written).
(function () {
    var OUT = $.global.PROBE_OUT;
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    var doc = app.documents.add(false);
    doc.viewPreferences.horizontalMeasurementUnits = MeasurementUnits.POINTS;
    doc.viewPreferences.verticalMeasurementUnits = MeasurementUnits.POINTS;
    var page = doc.pages[0];
    var text = "justified, spaces never shrink";
    function frame(w, align, size) {
        var tf = page.textFrames.add({ geometricBounds: [20, 20, 140, 20 + w] });
        tf.textFramePreferences.insetSpacing = [0, 0, 0, 0];
        tf.contents = text;
        var p = tf.paragraphs[0];
        p.appliedFont = "Open Sans\tRegular";
        p.pointSize = size;
        p.hyphenation = false;
        p.justification = align;
        p.minimumWordSpacing = 100;
        p.desiredWordSpacing = 100;
        p.maximumWordSpacing = 133;
        p.composer = "$ID/HL Composer";
        return tf;
    }
    var rows = [];
    var sizes = [6, 9, 12, 18, 24, 36, 48];
    var aligns = [[Justification.LEFT_ALIGN, "LeftAlign"], [Justification.LEFT_JUSTIFIED, "LeftJustified"]];
    for (var a = 0; a < aligns.length; a++) {
        for (var z = 0; z < sizes.length; z++) {
            var probe = frame(2000, Justification.LEFT_ALIGN, sizes[z]);
            var natural = probe.lines[0].endHorizontalOffset - probe.lines[0].horizontalOffset;
            probe.remove();
            var lo = 0, hi = sizes[z] * 0.2;
            for (var k = 0; k < 14; k++) {
                var mid = (lo + hi) / 2;
                var tf = frame(natural - mid, aligns[a][0], sizes[z]);
                var one = tf.lines.length == 1;
                tf.remove();
                if (one) { lo = mid; } else { hi = mid; }
            }
            rows.push('    {"alignment": "' + aligns[a][1] + '", "size": ' + sizes[z] +
                ', "natural": ' + natural.toFixed(4) + ', "tolerance_pt": ' + lo.toFixed(4) +
                ', "tolerance_em": ' + (lo / sizes[z]).toFixed(5) + '}');
        }
    }
    doc.close(SaveOptions.NO);
    var f = File(OUT);
    f.encoding = "UTF-8";
    f.lineFeed = "Unix";
    f.open("w");
    f.write('{\n  "indesign": "' + app.version + '",\n  "rows": [\n' + rows.join(",\n") + "\n  ]\n}\n");
    f.close();
})();
