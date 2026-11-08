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

// Ask InDesign when it prints ruby and emphasis marks (kenten)
// (cjk-composer-probe.sh drives it). One frame per composer, the same
// Kozuka Mincho text in each, kenten on the first two characters and ruby
// on the fifth and sixth. Writes cjk-composer.pdf and cjk-composer.idml
// into PROBE_OUT. InDesign 20.0.1 prints ruby and kenten under its
// Japanese composers only (HL Composer J / HL Single J); the answer is
// pinned in crates/paged-renderer/src/pipeline/tests.rs.
(function () {
    var out = Folder(String($.global.PROBE_OUT));
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    var doc = app.documents.add(false);
    var composers = ["$ID/HL Composer", "$ID/HL Composer Optyca", "$ID/HL Composer J", "$ID/HL Single J"];
    try {
        for (var c = 0; c < composers.length; c++) {
            var tf = doc.pages[0].textFrames.add({ geometricBounds: [80 + c * 140, 60, 180 + c * 140, 500] });
            tf.contents = "漢字漢字漢字";
            var t = tf.parentStory.texts[0];
            t.appliedFont = "Kozuka Mincho Pr6N";
            t.fontStyle = "R";
            t.pointSize = 30;
            tf.parentStory.paragraphs[0].composer = composers[c];
            tf.parentStory.characters.itemByRange(0, 1).kentenKind = KentenCharacter.KENTEN_SESAME_DOT;
            var r = tf.parentStory.characters.itemByRange(4, 5);
            r.rubyFlag = true;
            r.rubyString = "かんじ";
        }
        doc.exportFile(ExportFormat.PDF_TYPE, File(out.fsName + "/cjk-composer.pdf"));
        doc.exportFile(ExportFormat.INDESIGN_MARKUP, File(out.fsName + "/cjk-composer.idml"));
    } catch (e) {
        var f = File(out.fsName + "/cjk-composer.error.txt"); f.open("w"); f.write(String(e)); f.close();
    }
    doc.close(SaveOptions.NO);
})();
