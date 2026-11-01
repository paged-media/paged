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

//! Engine ADR 1052 — content controls from a script: a value set, a
//! checkbox toggled, a list item chosen, each one undo step.

use super::*;

/// "Agree ☐ colour Red": a checkbox control over char 6 and a drop-down
/// control over "Red" (chars 15..18), made through the control's path.
fn with_controls() -> (CanvasModel, String) {
    let (mut m, _, _, story) = with_story("Agree \u{2610} colour Red");
    let checkbox = r#"{"id":"1","kind":{"type":"checkbox","checked":false,"checkedGlyph":"☒","uncheckedGlyph":"☐"}}"#;
    let drop_down = r#"{"id":"2","kind":{"type":"dropDown","items":[{"display":"Red","value":"r"},{"display":"Blue","value":"b"}],"value":"r"}}"#;
    for (range, control) in [("6..7", checkbox), ("15..18", drop_down)] {
        let out = ok(
            &mut m,
            &format!(
                "paged.set('storyRange:{story}@{range}', 'characterContentControl', {control:?})"
            ),
        );
        assert_eq!(last_line(&out), "true", "{range}");
    }
    (m, story)
}

#[test]
fn set_content_control_value() {
    covers!("script:paged.setContentControlValue");
    let (mut m, story) = with_controls();
    refuses(
        &mut m,
        &format!("paged.setContentControlValue({story:?}, 'nope', 'b')"),
        "false",
    );
    writes(
        &mut m,
        &format!("paged.setContentControlValue({story:?}, '2', 'b')"),
        "true",
    );
    throws(
        &mut m,
        "paged.setContentControlValue(Symbol('s'), '2', 'b')",
        SYMBOL_TO_STRING,
    );
}

#[test]
fn toggle_content_control() {
    covers!("script:paged.toggleContentControl");
    let (mut m, story) = with_controls();
    refuses(
        &mut m,
        &format!("paged.toggleContentControl({story:?}, 'nope')"),
        "false",
    );
    writes(
        &mut m,
        &format!("paged.toggleContentControl({story:?}, '1')"),
        "true",
    );
    throws(
        &mut m,
        "paged.toggleContentControl(Symbol('s'), '1')",
        SYMBOL_TO_STRING,
    );
}

#[test]
fn choose_content_control_item() {
    covers!("script:paged.chooseContentControlItem");
    let (mut m, story) = with_controls();
    refuses(
        &mut m,
        &format!("paged.chooseContentControlItem({story:?}, '2', 9)"),
        "false",
    );
    writes(
        &mut m,
        &format!("paged.chooseContentControlItem({story:?}, '2', 1)"),
        "true",
    );
    throws(
        &mut m,
        "paged.chooseContentControlItem(Symbol('s'), '2', 1)",
        SYMBOL_TO_STRING,
    );
}
