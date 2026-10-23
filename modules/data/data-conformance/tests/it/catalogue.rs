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

//! ADR 560 — catalogues: a template's fields as binding targets, one
//! instance of the template per record or per group, the values typed by
//! the field's kind and checked against the template's constraints.

use data_bind::catalogue::{
    CatalogueField, CatalogueFieldKind, CatalogueFieldValue, CatalogueMode, CatalogueSpec,
    CatalogueValue,
};
use data_bind::{ResolutionEngine, ResolveError};
use data_conformance::{n, record_set, t, today};
use data_core::{FieldType, Query, QueryId, ResultShape};

fn engine() -> ResolutionEngine {
    let mut e = ResolutionEngine::new(today());
    e.add_query(Query {
        id: QueryId::from("q"),
        sql: "SELECT * FROM products ORDER BY sku".into(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    e.set_result(
        QueryId::from("q"),
        record_set(
            &[
                ("sku", FieldType::Text),
                ("name", FieldType::Text),
                ("cat", FieldType::Text),
                ("photo", FieldType::Text),
                ("stock", FieldType::Float),
            ],
            vec![
                vec![t("A-1"), t("B-2"), t("C-3")],
                vec![t("Alpha"), t("Beta"), t("Gamma")],
                vec![t("tools"), t("toys"), t("tools")],
                vec![t("a.png"), t(""), t("c.png")],
                vec![n(3.0), n(0.0), n(7.0)],
            ],
        ),
    );
    e
}

fn field(name: &str, kind: CatalogueFieldKind, expr: &str) -> CatalogueField {
    CatalogueField {
        name: name.into(),
        kind,
        expr: expr.into(),
        required: false,
        max_length: None,
        invert: false,
    }
}

fn refused(code: &str, detail: &str) -> CatalogueValue {
    CatalogueValue::Refused {
        code: code.into(),
        detail: detail.into(),
    }
}

#[test]
fn catalogue_one_instance_per_record_with_typed_values() {
    let plan = engine()
        .resolve_catalogue(
            &QueryId::from("q"),
            &CatalogueSpec {
                fields: vec![
                    field("title", CatalogueFieldKind::Text, "UPPER(name)"),
                    field("picture", CatalogueFieldKind::Image, "photo"),
                    field("badge", CatalogueFieldKind::Visibility, "stock > 0"),
                ],
                mode: CatalogueMode::PerRecord,
            },
        )
        .expect("plan");
    assert_eq!(plan.total_records, 3);
    assert_eq!(plan.instances.len(), 3);
    let second = &plan.instances[1];
    assert_eq!(second.records, vec![1]);
    assert_eq!(second.label, "2");
    assert_eq!(
        second.values,
        vec![
            CatalogueFieldValue {
                field: "title".into(),
                value: CatalogueValue::Text {
                    text: "BETA".into()
                },
            },
            CatalogueFieldValue {
                field: "picture".into(),
                value: CatalogueValue::Leave,
            },
            CatalogueFieldValue {
                field: "badge".into(),
                value: CatalogueValue::Visible { visible: false },
            },
        ]
    );
    assert_eq!(
        plan.instances[2].values[1].value,
        CatalogueValue::Image {
            uri: "c.png".into()
        }
    );
    assert!(!plan.refused());
}

#[test]
fn catalogue_inverted_visibility_and_a_non_boolean_hides() {
    let mut shown = field("sold", CatalogueFieldKind::Visibility, "stock > 0");
    shown.invert = true;
    let plan = engine()
        .resolve_catalogue(
            &QueryId::from("q"),
            &CatalogueSpec {
                fields: vec![shown, field("odd", CatalogueFieldKind::Visibility, "name")],
                mode: CatalogueMode::PerRecord,
            },
        )
        .expect("plan");
    let sold: Vec<&CatalogueValue> = plan.instances.iter().map(|i| &i.values[0].value).collect();
    assert_eq!(
        sold,
        vec![
            &CatalogueValue::Visible { visible: false },
            &CatalogueValue::Visible { visible: true },
            &CatalogueValue::Visible { visible: false },
        ]
    );
    assert_eq!(
        plan.instances[0].values[1].value,
        CatalogueValue::Visible { visible: false }
    );
}

#[test]
fn catalogue_one_instance_per_group_from_its_first_record() {
    let plan = engine()
        .resolve_catalogue(
            &QueryId::from("q"),
            &CatalogueSpec {
                fields: vec![field(
                    "title",
                    CatalogueFieldKind::Text,
                    "cat & \": \" & name",
                )],
                mode: CatalogueMode::PerGroup {
                    by: vec!["cat".into(), "nope".into()],
                },
            },
        )
        .expect("plan");
    let groups: Vec<(&str, &[usize])> = plan
        .instances
        .iter()
        .map(|i| (i.label.as_str(), i.records.as_slice()))
        .collect();
    assert_eq!(groups, vec![("tools", &[0, 2][..]), ("toys", &[1][..])]);
    assert_eq!(
        plan.instances[0].values[0].value,
        CatalogueValue::Text {
            text: "tools: Alpha".into()
        }
    );
    assert_eq!(plan.unknown_columns, vec!["nope".to_string()]);
}

#[test]
fn catalogue_the_template_constraints_refuse_a_value() {
    let mut title = field("title", CatalogueFieldKind::Text, "name");
    title.max_length = Some(4);
    let mut picture = field("picture", CatalogueFieldKind::Image, "photo");
    picture.required = true;
    let plan = engine()
        .resolve_catalogue(
            &QueryId::from("q"),
            &CatalogueSpec {
                fields: vec![
                    title,
                    picture,
                    field("x", CatalogueFieldKind::Text, "NOPE(1)"),
                ],
                mode: CatalogueMode::PerRecord,
            },
        )
        .expect("plan");
    assert!(plan.refused());
    // "Alpha" has five characters; "Beta" fits, but has no picture.
    assert_eq!(plan.instances[0].values[0].value, refused("tooLong", "4"));
    assert_eq!(
        plan.instances[1].values[0].value,
        CatalogueValue::Text {
            text: "Beta".into()
        }
    );
    assert_eq!(plan.instances[1].values[1].value, refused("required", ""));
    assert!(matches!(
        &plan.instances[0].values[2].value,
        CatalogueValue::Refused { code, .. } if code == "error"
    ));
}

#[test]
fn catalogue_a_query_without_a_result_is_an_error() {
    let e = ResolutionEngine::new(today());
    assert!(matches!(
        e.resolve_catalogue(
            &QueryId::from("q"),
            &CatalogueSpec {
                fields: vec![],
                mode: CatalogueMode::PerRecord
            }
        ),
        Err(ResolveError::NoResult(_))
    ));
}

#[test]
fn catalogue_the_spec_and_the_plan_speak_the_bundles_json() {
    let spec: CatalogueSpec = serde_json::from_str(
        r#"{"mode":"perGroup","by":["cat"],"fields":[{"name":"t","kind":"text","expr":"name","maxLength":3}]}"#,
    )
    .expect("spec");
    assert_eq!(
        spec.mode,
        CatalogueMode::PerGroup {
            by: vec!["cat".into()]
        }
    );
    assert_eq!(spec.fields[0].max_length, Some(3));
    let v = serde_json::to_value(CatalogueFieldValue {
        field: "t".into(),
        value: refused("tooLong", "3"),
    })
    .expect("json");
    assert_eq!(
        v,
        serde_json::json!({"field":"t","outcome":"refused","code":"tooLong","detail":"3"})
    );
}
