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

//! The engine's label reader against the cases the bundle's reader records
//! (`modules/data/conformance/labels/cases.json`, core ADR 1014): one
//! document reads to one recipe in the editor and on the command line.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use data_session::labels::{
    document_recipe, restore_from_labels, sources_to_relink, LabelledElement,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    elements: Vec<LabelledElement>,
    document_label: Option<String>,
    expect: Value,
}

#[derive(Deserialize)]
struct Cases {
    cases: Vec<Case>,
}

fn cases() -> Vec<Case> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../modules/data/conformance/labels/cases.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str::<Cases>(&text)
        .expect("cases.json")
        .cases
}

fn restore(c: &Case) -> data_session::labels::RestoredRecipe {
    let recipe = c.document_label.as_deref().and_then(document_recipe);
    restore_from_labels(&c.elements, recipe.as_ref())
}

#[test]
fn labels_restore_as_the_bundle_restores_them__feat__data_bind_labels_native() {
    let cases = cases();
    assert!(cases.len() >= 4, "the shared cases are there");
    for c in &cases {
        let got = serde_json::to_value(restore(c)).unwrap();
        assert_eq!(got, c.expect, "case {:?}", c.name);
    }
}

#[test]
fn every_restored_recipe_is_a_session_payload__feat__data_bind_labels_native() {
    for c in &cases() {
        let restored = restore(c);
        let payload = restored
            .document_payload()
            .unwrap_or_else(|e| panic!("case {:?}: {e}", c.name));
        assert_eq!(
            payload.bindings.len(),
            restored.payload["bindings"].as_array().unwrap().len(),
            "case {:?}",
            c.name
        );
        // The session takes the recipe as it took the part it came from.
        let session = data_session::core::DataSession::from_payload(payload, 0);
        assert!(!session.payload().bindings.is_empty(), "case {:?}", c.name);
    }
}

#[test]
fn a_restored_file_source_asks_for_its_file_again__feat__data_bind_labels_native() {
    let c = cases()
        .into_iter()
        .find(|c| c.document_label.is_some())
        .expect("a case with a document label");
    let relink = sources_to_relink(&restore(&c).payload);
    let products = relink.iter().find(|s| s.id == "products").unwrap();
    assert_eq!(products.file.as_deref(), Some("products.csv"));
    assert!(!products.remote);
    let prices = relink.iter().find(|s| s.id == "prices").unwrap();
    assert!(prices.remote && prices.file.is_none());
}
