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

//! `objectStyleCornerOption` / `objectStyleCornerRadius` set an object
//! style's four corners, not only its all-corner pair: InDesign draws a
//! style's corners from the per-corner attributes alone (ADR 149,
//! object-style-corners-probe), so a style the editor rounded through the
//! pair alone would open square in InDesign.

use paged_model::{CornerOption, CornerSpec, ObjectStyleDef};
use paged_mutate::{apply, Operation, PropertyPath, StyleCollection, Value};
use paged_scene::Document;

const STYLE: &str = "ObjectStyle/Corners";

fn document() -> Document {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../corpus/generated/text.idml");
    let bytes = std::fs::read(path).expect("read the text fixture");
    let mut doc = idml_import::import_idml_doc(&bytes).expect("open document");
    doc.styles.object_styles.insert(
        STYLE.into(),
        ObjectStyleDef {
            self_id: STYLE.into(),
            name: Some("Corners".into()),
            ..Default::default()
        },
    );
    doc
}

fn set(doc: &mut Document, path: PropertyPath, value: Value) -> Operation {
    apply(
        doc,
        &Operation::SetStyleProperty {
            collection: StyleCollection::Object,
            style_id: STYLE.into(),
            path,
            value,
        },
    )
    .unwrap_or_else(|e| panic!("{path:?}: {e:?}"))
    .inverse
}

fn corners(doc: &Document) -> [CornerSpec; 4] {
    doc.styles.object_styles[STYLE].corners
}

#[test]
fn the_all_corner_setters_set_the_pair_and_all_four_corners() {
    let mut doc = document();
    let undo_option = set(
        &mut doc,
        PropertyPath::ObjectStyleCornerOption,
        Value::Text("RoundedCorner".into()),
    );
    let undo_radius = set(
        &mut doc,
        PropertyPath::ObjectStyleCornerRadius,
        Value::Length(Some(20.0)),
    );
    let def = &doc.styles.object_styles[STYLE];
    assert_eq!(def.corner_option.as_deref(), Some("RoundedCorner"));
    assert_eq!(def.corner_radius, Some(20.0));
    assert_eq!(
        corners(&doc),
        [CornerSpec {
            option: Some(CornerOption::Rounded),
            radius: Some(20.0),
        }; 4]
    );

    apply(&mut doc, &undo_radius).expect("undo the radius");
    apply(&mut doc, &undo_option).expect("undo the option");
    let def = &doc.styles.object_styles[STYLE];
    assert_eq!(
        (def.corner_option.as_deref(), def.corner_radius),
        (None, None)
    );
    assert!(CornerSpec::all_unset(&corners(&doc)));
}

#[test]
fn clearing_the_option_clears_the_four_corners() {
    let mut doc = document();
    set(
        &mut doc,
        PropertyPath::ObjectStyleCornerOption,
        Value::Text("BevelCorner".into()),
    );
    assert_eq!(corners(&doc)[2].option, Some(CornerOption::Bevel));
    set(
        &mut doc,
        PropertyPath::ObjectStyleCornerOption,
        Value::Text(String::new()),
    );
    assert!(corners(&doc).iter().all(|c| c.option.is_none()));
}
