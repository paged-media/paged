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


// How large a document label can InDesign keep (label-size-probe.sh drives
// it; engine ADR 1057 needs the figure for the x-paged:core.theme label).
// Sets one label of N characters on a new, windowless document for a ladder
// of N, reads it back, and for the sizes in PROBE_ROUNDTRIP also exports the
// document as IDML, reopens that and reads the label again, so the answer
// covers what InDesign keeps through a save and an open, not only in memory.
// The text holds quotes, angle brackets, an ampersand and non-ASCII
// characters, as the theme label's JSON does.
//
// Inputs: PROBE_OUT (JSON), PROBE_IDML (scratch IDML path).
(function () {
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    var KEY = "x-paged:probe";
    var SIZES = [1024, 16384, 65536, 262144, 1048576, 4194304, 16777216];
    var ROUND = { 65536: true, 262144: true, 1048576: true, 4194304: true, 16777216: true };
    var unit = '{"a":"<&>äü — x","n":12}';
    function text(n) {
        var s = unit;
        while (s.length < n) s += s;
        return s.substr(0, n);
    }
    function q(s) { return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }
    var rows = [];
    var doc = app.documents.add(false);
    try {
        for (var i = 0; i < SIZES.length; i++) {
            var n = SIZES[i], want = text(n), row = '{"chars": ' + n;
            try {
                doc.insertLabel(KEY, want);
                var got = doc.extractLabel(KEY);
                row += ', "memory": ' + (got === want ? '"kept"' : '"altered(' + got.length + ')"');
            } catch (e) {
                row += ', "memory": ' + q("error: " + e);
            }
            if (ROUND[n]) {
                try {
                    var f = File($.global.PROBE_IDML);
                    doc.exportFile(ExportFormat.INDESIGN_MARKUP, f);
                    var back = app.open(f, false);
                    try {
                        var again = back.extractLabel(KEY);
                        row += ', "idmlRoundTrip": ' + (again === want ? '"kept"' : '"altered(' + again.length + ')"');
                    } finally { back.close(SaveOptions.NO); }
                } catch (e2) {
                    row += ', "idmlRoundTrip": ' + q("error: " + e2);
                }
            }
            rows.push(row + "}");
        }
    } finally { doc.close(SaveOptions.NO); }
    var out = '{\n  "app": ' + q(app.name + " " + app.version) + ',\n  "rows": [\n    ' + rows.join(",\n    ") + '\n  ]\n}\n';
    var o = File($.global.PROBE_OUT); o.encoding = "UTF-8"; o.open("w"); o.write(out); o.close();
})();
