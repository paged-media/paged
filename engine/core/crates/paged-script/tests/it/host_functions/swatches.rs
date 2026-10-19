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

//! Colour resources: swatch, gradient and colour-group CRUD, read back
//! through `paged.swatches()`, `paged.gradients()` and `paged.colorGroups()`.

use super::*;

const RED: &str = "{ space: 'CMYK', value: [0, 100, 100, 0], name: 'Red' }";

fn named(m: &mut CanvasModel, read: &str, name: &str) -> bool {
    json_of(&ok(m, read))
        .as_array()
        .expect("an array")
        .iter()
        .any(|e| e["name"] == name)
}

/// A blank document with the swatch `Red`; returns its id.
fn with_red(m: &mut CanvasModel) -> String {
    ok(m, &format!("paged.createSwatch({RED})"))
}

fn gradient_spec(name: &str, end: &str) -> String {
    format!(
        "{{ kind: 'Linear', name: '{name}', stops: [ {{ stopColor: 'Color/Black', locationPct: 0 }}, \
         {{ stopColor: '{end}', locationPct: 100 }} ] }}"
    )
}

#[test]
fn create_swatch() {
    covers!("script:paged.createSwatch");
    let mut m = blank();
    refuses(&mut m, "paged.createSwatch()", "null");
    refuses(&mut m, "paged.createSwatch('Red')", "null");
    refuses(&mut m, "paged.createSwatch({ name: 'NoSpace' })", "null");
    let id = mints(&mut m, &format!("paged.createSwatch({RED})"), |s| {
        s.starts_with("Color/")
    });
    assert!(named(&mut m, "paged.swatches()", "Red"), "{id}");
}

#[test]
fn edit_swatch() {
    covers!("script:paged.editSwatch");
    let mut m = blank();
    let id = with_red(&mut m);
    refuses(&mut m, &format!("paged.editSwatch({id:?})"), "false");
    refuses(&mut m, &format!("paged.editSwatch({id:?}, 7)"), "false");
    refuses(
        &mut m,
        &format!("paged.editSwatch('Color/Nope', {RED})"),
        "false",
    );
    throws(
        &mut m,
        &format!("paged.editSwatch(Symbol('s'), {RED})"),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!(
            "paged.editSwatch({id:?}, {{ space: 'CMYK', value: [0, 50, 100, 0], name: 'Amber' }})"
        ),
        "true",
    );
    assert!(named(&mut m, "paged.swatches()", "Amber"));
}

#[test]
fn delete_swatch() {
    covers!("script:paged.deleteSwatch");
    let mut m = blank();
    let id = with_red(&mut m);
    refuses(&mut m, "paged.deleteSwatch()", "false");
    refuses(&mut m, "paged.deleteSwatch('Color/Nope')", "false");
    throws(&mut m, "paged.deleteSwatch(Symbol('s'))", SYMBOL_TO_STRING);
    writes(&mut m, &format!("paged.deleteSwatch({id:?})"), "true");
    assert!(!named(&mut m, "paged.swatches()", "Red"));
}

#[test]
fn create_gradient() {
    covers!("script:paged.createGradient");
    let mut m = blank();
    refuses(&mut m, "paged.createGradient()", "null");
    refuses(
        &mut m,
        "paged.createGradient({ kind: 'Linear', name: 'X', stops: 'none' })",
        "null",
    );
    let id = mints(
        &mut m,
        &format!(
            "paged.createGradient({})",
            gradient_spec("Dawn", "Color/Black")
        ),
        |s| s.starts_with("Gradient/"),
    );
    assert!(named(&mut m, "paged.gradients()", "Dawn"), "{id}");
    has_keys(
        &json_of(&ok(&mut m, "paged.gradients()"))[0],
        &["selfId", "name"],
    );
}

#[test]
fn edit_gradient() {
    covers!("script:paged.editGradient");
    let mut m = blank();
    let id = ok(
        &mut m,
        &format!(
            "paged.createGradient({})",
            gradient_spec("Dawn", "Color/Black")
        ),
    );
    refuses(&mut m, &format!("paged.editGradient({id:?})"), "false");
    refuses(
        &mut m,
        &format!(
            "paged.editGradient('Gradient/Nope', {})",
            gradient_spec("Dusk", "Color/Black")
        ),
        "false",
    );
    throws(
        &mut m,
        &format!(
            "paged.editGradient(Symbol('g'), {})",
            gradient_spec("Dusk", "Color/Black")
        ),
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!(
            "paged.editGradient({id:?}, {})",
            gradient_spec("Dusk", "Color/Black")
        ),
        "true",
    );
    assert!(named(&mut m, "paged.gradients()", "Dusk"));
}

#[test]
fn delete_gradient() {
    covers!("script:paged.deleteGradient");
    let mut m = blank();
    let id = ok(
        &mut m,
        &format!(
            "paged.createGradient({})",
            gradient_spec("Dawn", "Color/Black")
        ),
    );
    refuses(&mut m, "paged.deleteGradient()", "false");
    refuses(&mut m, "paged.deleteGradient('Gradient/Nope')", "false");
    throws(
        &mut m,
        "paged.deleteGradient(Symbol('g'))",
        SYMBOL_TO_STRING,
    );
    writes(&mut m, &format!("paged.deleteGradient({id:?})"), "true");
    assert_eq!(ok(&mut m, "paged.gradients()"), "[]");
}

#[test]
fn create_color_group() {
    covers!("script:paged.createColorGroup");
    let mut m = blank();
    let sw = with_red(&mut m);
    refuses(&mut m, "paged.createColorGroup()", "null");
    refuses(
        &mut m,
        "paged.createColorGroup({ name: 'Inks', members: 'Red' })",
        "null",
    );
    let id = mints(
        &mut m,
        &format!("paged.createColorGroup({{ name: 'Inks', members: [{sw:?}] }})"),
        |s| s.starts_with("ColorGroup/"),
    );
    assert!(named(&mut m, "paged.colorGroups()", "Inks"), "{id}");
}

#[test]
fn edit_color_group() {
    covers!("script:paged.editColorGroup");
    let mut m = blank();
    let sw = with_red(&mut m);
    let id = ok(
        &mut m,
        &format!("paged.createColorGroup({{ name: 'Inks', members: [{sw:?}] }})"),
    );
    refuses(&mut m, &format!("paged.editColorGroup({id:?})"), "false");
    refuses(
        &mut m,
        "paged.editColorGroup('ColorGroup/Nope', { name: 'X', members: [] })",
        "false",
    );
    throws(
        &mut m,
        "paged.editColorGroup(Symbol('g'), { name: 'X' })",
        SYMBOL_TO_STRING,
    );
    writes(
        &mut m,
        &format!("paged.editColorGroup({id:?}, {{ name: 'Spot inks', members: [{sw:?}] }})"),
        "true",
    );
    assert!(named(&mut m, "paged.colorGroups()", "Spot inks"));
}

#[test]
fn delete_color_group() {
    covers!("script:paged.deleteColorGroup");
    let mut m = blank();
    let sw = with_red(&mut m);
    let id = ok(
        &mut m,
        &format!("paged.createColorGroup({{ name: 'Inks', members: [{sw:?}] }})"),
    );
    refuses(&mut m, "paged.deleteColorGroup()", "false");
    refuses(&mut m, "paged.deleteColorGroup('ColorGroup/Nope')", "false");
    throws(
        &mut m,
        "paged.deleteColorGroup(Symbol('g'))",
        SYMBOL_TO_STRING,
    );
    writes(&mut m, &format!("paged.deleteColorGroup({id:?})"), "true");
    assert_eq!(ok(&mut m, "paged.colorGroups()"), "[]");
}
