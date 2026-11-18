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

//! Engine ADR 1315 — a script's value outside a path's enum is refused,
//! and the refusal names the values the path takes.
//!
//! `paged.set(frame, 'frameCornerOptionTopLeft', 'Rounded')` answered
//! `true` and stored no corner: the schema called the corner vocabulary
//! open, and the model has no corner named "Rounded". It answers `false`
//! now, with a warning that lists the six corner options; `paged.batch`
//! carries the same reason in its typed `invalidValue` result.

use paged_introspect::schema::ValueType;

use crate::host_functions::{blank, js, json_of, ok, page_id, refuses, writes};

/// The lab's seed: one text frame on a blank page; its address.
fn frame(m: &mut paged_canvas::CanvasModel) -> String {
    let pid = page_id(m);
    ok(
        m,
        &format!("paged.insertTextFrame({pid:?}, [144, 72, 360, 540])"),
    )
}

const MEMBERS: &str =
    "None | RoundedCorner | InverseRoundedCorner | InsetCorner | BeveledCorner | FancyCorner";

#[test]
fn a_corner_option_outside_the_enum_is_refused_with_the_members() {
    let mut m = blank();
    let f = frame(&mut m);
    refuses(
        &mut m,
        &format!("paged.set({f:?}, 'frameCornerOptionTopLeft', 'Rounded')"),
        "false",
    );
    let r = js(
        &mut m,
        &format!("paged.set({f:?}, 'frameCornerOptionTopLeft', 'Rounded')"),
    );
    let warning = r
        .output
        .iter()
        .find(|l| l.starts_with("[warn] paged.set"))
        .unwrap_or_else(|| panic!("no warning: {:?}", r.output));
    assert!(
        warning.contains("frameCornerOptionTopLeft") && warning.contains(MEMBERS),
        "the warning names the path and the members: {warning}"
    );

    // The member lands, and reads back.
    writes(
        &mut m,
        &format!("paged.set({f:?}, 'frameCornerOptionTopLeft', 'RoundedCorner')"),
        "true",
    );
    let back = json_of(&ok(
        &mut m,
        &format!("paged.get({f:?}, 'frameCornerOptionTopLeft')"),
    ));
    assert_eq!(back["value"], "RoundedCorner", "{back}");
}

#[test]
fn a_batch_refusal_carries_the_reason() {
    let mut m = blank();
    let f = frame(&mut m);
    let out = ok(
        &mut m,
        &format!(
            "paged.batch([{{ op: 'set', address: {f:?}, path: 'frameCornerOptionTopLeft', value: 'Rounded' }}])"
        ),
    );
    let results = json_of(&out);
    let first = &results[0];
    assert_eq!(first["ok"], false, "{results}");
    assert_eq!(first["code"], "invalidValue", "{results}");
    let reason = first["reason"].as_str().unwrap_or_default();
    assert!(reason.contains(MEMBERS), "{reason}");
}

#[test]
fn an_object_styles_corner_option_outside_the_enum_is_refused() {
    let mut m = blank();
    let style = ok(&mut m, "paged.createObjectStyle({ name: 'Callout' })");
    let r = js(
        &mut m,
        &format!(
            "paged.setStyleProperty('object', {style:?}, 'objectStyleCornerOption', 'Rounded')"
        ),
    );
    assert!(r.error.is_none(), "{:?}", r.error);
    assert_eq!(r.output.last().map(String::as_str), Some("false"));
    assert!(
        r.output
            .iter()
            .any(|l| l.starts_with("[warn] paged.setStyleProperty") && l.contains(MEMBERS)),
        "{:?}",
        r.output
    );
    // Through the style's address too.
    refuses(
        &mut m,
        &format!("paged.set('style:object/' + {style:?}, 'objectStyleCornerOption', 'Rounded')"),
        "false",
    );
    writes(
        &mut m,
        &format!(
            "paged.setStyleProperty('object', {style:?}, 'objectStyleCornerOption', 'RoundedCorner')"
        ),
        "true",
    );
}

/// The frame proxy throws on the refusal, and the warning says why.
#[test]
fn the_frame_proxy_throws_and_the_warning_says_why() {
    let mut m = blank();
    let f = frame(&mut m);
    let r = js(
        &mut m,
        &format!("paged.frame({f:?}).frameCornerOptionTopLeft = 'Rounded'"),
    );
    assert!(
        r.error
            .as_deref()
            .is_some_and(|e| e.contains("the write was refused")),
        "{:?}",
        r.error
    );
    assert!(
        r.output.iter().any(|l| l.contains(MEMBERS)),
        "{:?}",
        r.output
    );
}

/// Through the bridge, a stranger reaches no closed enum path: the
/// conversion refuses it before the engine sees it. (The engine-side
/// gate over every row, open ones included, is paged-canvas's
/// `every_enum_row_refuses_a_stranger_and_keeps_its_members`.)
#[test]
fn no_closed_enum_path_converts_a_stranger() {
    let catalog = paged_script::api_catalog();
    let mut converted = Vec::new();
    for name in &catalog.settable_paths {
        let path = paged_introspect::lookup_path(name).expect("advertised resolves");
        let schema = paged_introspect::catalog::schema(path);
        if schema.value_type != ValueType::Enum || schema.open {
            continue;
        }
        if paged_script::js_literal_to_wire("'NotAMember'", name).is_some() {
            converted.push(*name);
        }
    }
    assert!(converted.is_empty(), "{converted:?}");
}
