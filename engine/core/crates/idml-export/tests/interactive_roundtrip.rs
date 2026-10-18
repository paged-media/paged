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

//! D-04 — InDesign's interactive objects survive a save untouched.
//!
//! The fixture is InDesign 20.0.1's own spread (core `interactive-probe`):
//! a button with two states, a multi-state object with four, a text box, a
//! check box, and a plain rectangle. The parser reads a button or a
//! multi-state object as a group of its active state. Moving the plain
//! rectangle used to write a second copy of the button and of the
//! multi-state object (their ids, again) into the text box, and rewrite
//! the button's state rectangle in spread space: the writer did not know
//! `<Button>` / `<MultiStateObject>` as the source of those groups.

use idml_export::rewrite::rewrite_spread;

const SPREAD: &[u8] = include_bytes!("fixtures/interactive-spread.xml");

/// Each interactive element's subtree, by its `Self`.
fn subtrees(xml: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for tag in ["Button", "MultiStateObject", "TextBox", "CheckBox"] {
        let open = format!("<{tag} ");
        let close = format!("</{tag}>");
        let mut at = 0;
        while let Some(i) = xml[at..].find(&open) {
            let start = at + i;
            let end = start + xml[start..].find(&close).expect("closed") + close.len();
            out.push((tag.to_string(), xml[start..end].to_string()));
            at = end;
        }
    }
    out
}

#[test]
fn an_unrelated_move_leaves_every_interactive_object_as_it_was() {
    let mut spread = idml_import::parse_spread(SPREAD).expect("parse");
    let mover = spread
        .rectangles
        .iter_mut()
        .find(|r| r.self_id.as_deref() == Some("uf4"))
        .expect("the plain rectangle");
    mover.bounds.top += 15.0;
    mover.bounds.bottom += 15.0;
    let out = String::from_utf8(rewrite_spread(SPREAD, &spread).expect("rewrite")).unwrap();
    let source = std::str::from_utf8(SPREAD).unwrap();
    let before = subtrees(source);
    assert_eq!(before.len(), 4);
    assert_eq!(
        subtrees(&out),
        before,
        "every interactive subtree byte for byte"
    );
    for id in ["ude", "ue5", "ue0", "udf"] {
        assert_eq!(
            out.matches(&format!("Self=\"{id}\"")).count(),
            1,
            "{id} is written once"
        );
    }
    assert_ne!(out, source, "the move itself is written");
}

#[test]
fn an_unmutated_save_is_identical() {
    let spread = idml_import::parse_spread(SPREAD).expect("parse");
    let out = rewrite_spread(SPREAD, &spread).expect("rewrite");
    assert_eq!(out, SPREAD);
}
