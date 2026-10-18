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

// The InDesign round-trip lane (lane.sh drives it). For each scenario
// directory under LANE_DIR it opens `out.idml` (the engine's export),
// records InDesign's view of it (lib/oracle.jsx), saves it as an .indd,
// reopens that and records the view again, and exports the reopened
// document as `resaved.idml`. Writes `<scenario>/indesign-view.json`:
//
//   { "indesign": version, "opened": view, "reopened": view }
//
// Inputs: LANE_DIR, LANE_SCENARIOS (comma-separated), LANE_ORACLE (the
// path of lib/oracle.jsx).
(function () {
    $.evalFile(File($.global.LANE_ORACLE));
    var prior = app.scriptPreferences.userInteractionLevel;
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    try {
        var names = String($.global.LANE_SCENARIOS).split(",");
        for (var i = 0; i < names.length; i++) {
            var dir = $.global.LANE_DIR + "/" + names[i];
            var doc = app.open(File(dir + "/out.idml"), false);
            var opened = pagedOracleView(doc);
            var indd = File(dir + "/out.indd");
            doc.save(indd);
            doc.close(SaveOptions.NO);
            var again = app.open(indd, false);
            var reopened = pagedOracleView(again);
            again.exportFile(ExportFormat.INDESIGN_MARKUP, File(dir + "/resaved.idml"));
            again.close(SaveOptions.NO);
            indd.remove();
            var f = File(dir + "/indesign-view.json");
            f.encoding = "UTF-8";
            f.open("w");
            f.write('{"indesign":"' + app.version + '","opened":' + opened + ',"reopened":' + reopened + "}\n");
            f.close();
        }
    } finally {
        app.scriptPreferences.userInteractionLevel = prior;
    }
})();
