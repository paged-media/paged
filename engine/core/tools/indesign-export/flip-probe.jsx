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

// Ask InDesign how it reads a reflected item back (flip-probe.sh drives
// it): after Flip Vertical, Flip Horizontal and both, on an unturned item
// and on items turned 30° and 120°, what its transform panel values are —
// rotation, the two scales, `absoluteFlip` — and the matrix itself. The
// engine's decomposition (`decompose_transform`, ADR 192) is held to the
// answers. Works on a fresh, unsaved document with no window and closes
// it without saving. Writes `flip-probe.json` beside this file.
(function () {
    var lines = [];
    function q(s) { s = String(s); return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, " ") + '"'; }
    function r2(v) { return Math.round(v * 100) / 100; }
    function put(label, value) { lines.push(q(label) + ":" + q(value)); }
    var PB = CoordinateSpaces.PASTEBOARD_COORDINATES;
    var prior = app.scriptPreferences.userInteractionLevel;
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    var doc = app.documents.add(false);
    try {
        doc.viewPreferences.horizontalMeasurementUnits = MeasurementUnits.POINTS;
        doc.viewPreferences.verticalMeasurementUnits = MeasurementUnits.POINTS;
        var page = doc.pages[0];
        function read(it) {
            var m = it.transformValuesOf(PB)[0].matrixValues;
            var mv = [];
            for (var i = 0; i < m.length; i++) mv.push(r2(m[i]));
            return "flip=" + it.absoluteFlip + " rotation=" + r2(it.absoluteRotationAngle) +
                " hscale=" + r2(it.absoluteHorizontalScale) + " vscale=" + r2(it.absoluteVerticalScale) +
                " shear=" + r2(it.absoluteShearAngle) + " matrix=[" + mv.join(" ") + "]";
        }
        var turns = [0, 30, 120];
        var flips = [["V", Flip.VERTICAL], ["H", Flip.HORIZONTAL], ["HV", Flip.HORIZONTAL_AND_VERTICAL]];
        for (var t = 0; t < turns.length; t++) {
            for (var f = 0; f < flips.length; f++) {
                var r = page.rectangles.add({ geometricBounds: [100, 100, 160, 260], strokeWeight: 0 });
                if (turns[t]) {
                    r.transform(PB, AnchorPoint.CENTER_ANCHOR,
                        app.transformationMatrices.add({ counterclockwiseRotationAngle: turns[t] }));
                }
                r.flipItem(flips[f][1], AnchorPoint.CENTER_ANCHOR);
                put("turned " + turns[t] + "deg, flip " + flips[f][0], read(r));
                // Flip vertically again: does it read unflipped?
                r.flipItem(Flip.VERTICAL, AnchorPoint.CENTER_ANCHOR);
                put("turned " + turns[t] + "deg, flip " + flips[f][0] + " then V", read(r));
                r.remove();
            }
        }
    } catch (e) {
        put("failed", "ERROR " + e.number + " " + e.message + " line " + e.line);
    } finally {
        try { doc.close(SaveOptions.NO); } catch (e) {}
        app.scriptPreferences.userInteractionLevel = prior;
    }
    var out = File(File($.fileName).parent + "/flip-probe.json");
    out.encoding = "UTF-8";
    out.lineFeed = "Unix";
    out.open("w");
    out.write("{\n  \"indesign\": " + q(app.version) + ",\n  " + lines.join(",\n  ") + "\n}\n");
    out.close();
})();
