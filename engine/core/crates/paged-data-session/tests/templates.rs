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

//! The record-template library and a record flow's pagination options: what
//! paged.data's "Record templates" and "Pagination" panels drive.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use data_core::{
    Binding, BindingDef, BindingId, FlowOpts, FooterAgg, FrameChainRef, GroupFooter, Query,
    QueryId, ResultShape, TemplateRef,
};
use data_lower::{FlowBlock, FrameCapacity};
use data_session::core::{DataSession, DocumentPayload};
use data_store::Format;

fn session() -> DataSession {
    let mut s = DataSession::new(0);
    s.store_import(
        "products",
        Format::Csv,
        b"cat,name,price\nTools,Hammer,9.5\nTools,Saw,12\nGarden,Rake,7\n",
        None,
    )
    .unwrap();
    s.define_query(Query {
        id: QueryId::from("q"),
        sql: "SELECT * FROM products".into(),
        params: vec![],
        shape: ResultShape::RecordStream,
    });
    let runs = s.refresh_queries();
    assert!(runs.iter().all(|r| r.outcome.is_ok()), "{runs:?}");
    s
}

fn flow(s: &mut DataSession, id: &str, template: &str, options: FlowOpts) {
    s.define_binding(BindingDef {
        id: BindingId::from(id),
        binding: Binding::RecordFlow {
            chain: FrameChainRef::from("chain"),
            query: QueryId::from("q"),
            template: TemplateRef::from(template),
            options,
        },
    });
}

fn tall_chain(frames: usize, height: f64) -> Vec<FrameCapacity> {
    (0..frames)
        .map(|i| FrameCapacity {
            frame: format!("f{i}"),
            page: format!("p{i}"),
            height_pt: height,
        })
        .collect()
}

fn record_cells(flow: &data_lower::PaginatedFlow) -> Vec<Vec<String>> {
    flow.frames
        .iter()
        .flat_map(|f| f.blocks.iter())
        .filter_map(|b| match b {
            FlowBlock::Record { cells, .. } => Some(cells.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn data_lower_record_templates_from_frame_text_renders_each_record__feat__data_lower_record_templates(
) {
    let mut s = session();
    let draft = s
        .template_from_text(
            &TemplateRef::from("Product card"),
            "<<name>>\nPrice: <<price>> EUR\n<<bad name>>",
            14.0,
        )
        .unwrap();
    assert_eq!(draft.template.fields.len(), 3);
    assert_eq!(draft.template.line_height_pt, 14.0);
    assert_eq!(draft.unreferenced, ["bad name"]);
    flow(&mut s, "rf", "Product card", FlowOpts::default());
    let out = s
        .lower_record_flow(
            &BindingId::from("rf"),
            tall_chain(1, 1000.0),
            s.flow_layout(&BindingId::from("rf")).unwrap(),
        )
        .unwrap();
    let cells = record_cells(&out);
    assert_eq!(cells.len(), 3);
    assert_eq!(cells[0][0], "Hammer");
    assert_eq!(cells[0][1], "Price: 9.5 EUR");
    assert_eq!(
        cells[0][2], "<<bad name>>",
        "an unreferenced name stays text"
    );

    // The template filled with record 2 of the query, as the flow renders it.
    let lines = s
        .preview_template(&TemplateRef::from("Product card"), &QueryId::from("q"), 1)
        .unwrap();
    let texts: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
    assert_eq!(texts, ["Saw", "Price: 12 EUR", "<<bad name>>"]);
    assert!(lines.iter().all(|l| l.error.is_none()));
    assert!(s
        .preview_template(&TemplateRef::from("nope"), &QueryId::from("q"), 0)
        .is_err());

    // A name is taken once; empty text makes nothing.
    assert!(s
        .template_from_text(&TemplateRef::from("Product card"), "<<name>>", 12.0)
        .is_err());
    assert!(s
        .template_from_text(&TemplateRef::from("empty"), "\n \n", 12.0)
        .is_err());
}

#[test]
fn data_lower_record_templates_rename_moves_the_flows_and_delete_is_refused_in_use__feat__data_lower_record_templates(
) {
    let mut s = session();
    s.template_from_text(&TemplateRef::from("a"), "<<name>>", 12.0)
        .unwrap();
    s.template_from_text(&TemplateRef::from("spare"), "<<cat>>", 12.0)
        .unwrap();
    flow(&mut s, "rf", "a", FlowOpts::default());

    let lib = s.template_library();
    assert_eq!(lib.len(), 2);
    assert_eq!(lib[0].used_by, [BindingId::from("rf")]);
    assert!(lib[1].used_by.is_empty());

    assert!(s
        .rename_template(&TemplateRef::from("a"), &TemplateRef::from("spare"))
        .is_err());
    let moved = s
        .rename_template(&TemplateRef::from("a"), &TemplateRef::from("card"))
        .unwrap();
    assert_eq!(moved, [BindingId::from("rf")]);
    assert_eq!(
        s.record_flow(&BindingId::from("rf")).unwrap().template,
        TemplateRef::from("card")
    );
    // The renamed flow still resolves.
    let out = s
        .lower_record_flow(
            &BindingId::from("rf"),
            tall_chain(1, 1000.0),
            Default::default(),
        )
        .unwrap();
    assert_eq!(out.placed, 3);

    let err = s.remove_template(&TemplateRef::from("card")).unwrap_err();
    assert!(err.to_string().contains("rf"), "{err}");
    assert!(s.remove_template(&TemplateRef::from("spare")).unwrap());
    assert!(!s.remove_template(&TemplateRef::from("spare")).unwrap());

    // The library is saved with the document.
    let payload: DocumentPayload = s.payload();
    assert_eq!(payload.templates.len(), 1);
    assert_eq!(payload.templates[0].id, TemplateRef::from("card"));
}

#[test]
fn data_lower_pagination_options_of_a_flow_reach_the_paginator__feat__data_lower_pagination() {
    let mut s = session();
    s.template_from_text(&TemplateRef::from("t"), "<<name>>\n<<price>>", 10.0)
        .unwrap();
    s.template_from_text(&TemplateRef::from("one"), "<<name>>", 10.0)
        .unwrap();
    flow(&mut s, "rf", "t", FlowOpts::default());
    let id = BindingId::from("rf");

    s.set_record_flow(
        &id,
        &TemplateRef::from("t"),
        FlowOpts {
            group_by: vec!["cat".into()],
            repeat_header: true,
            continued_marker: true,
            footer: Some(GroupFooter {
                label: "{count} items".into(),
                sum_field: Some("price".into()),
                agg: FooterAgg::Sum,
            }),
        },
    )
    .unwrap();
    let layout = s.flow_layout(&id).unwrap();
    assert!(layout.repeat_header && layout.continued_marker);
    // A frame holds one header (16) and two records (20 each): the Tools
    // group spills, and its header comes back marked continued.
    let out = s
        .lower_record_flow(&id, tall_chain(6, 40.0), layout)
        .unwrap();
    let continued = out.frames.iter().flat_map(|f| f.blocks.iter()).any(|b| {
        matches!(
            b,
            FlowBlock::GroupHeader {
                continued: true,
                ..
            }
        )
    });
    assert!(continued, "{out:?}");
    let footers = out
        .frames
        .iter()
        .flat_map(|f| f.blocks.iter())
        .filter(|b| matches!(b, FlowBlock::GroupFooter { .. }))
        .count();
    assert_eq!(footers, 2);

    // Without repeated headers the continuation frame carries no header.
    s.set_record_flow(
        &id,
        &TemplateRef::from("t"),
        FlowOpts {
            group_by: vec!["cat".into()],
            repeat_header: false,
            continued_marker: false,
            footer: None,
        },
    )
    .unwrap();
    let out = s
        .lower_record_flow(&id, tall_chain(4, 40.0), s.flow_layout(&id).unwrap())
        .unwrap();
    let headers = out
        .frames
        .iter()
        .flat_map(|f| f.blocks.iter())
        .filter(|b| matches!(b, FlowBlock::GroupHeader { .. }))
        .count();
    assert_eq!(headers, 2, "one header per group, none repeated: {out:?}");

    // Switching the template changes the record height.
    s.set_record_flow(&id, &TemplateRef::from("one"), FlowOpts::default())
        .unwrap();
    let out = s
        .lower_record_flow(&id, tall_chain(1, 1000.0), s.flow_layout(&id).unwrap())
        .unwrap();
    assert_eq!(out.frames[0].used_pt, 30.0);

    assert!(s
        .set_record_flow(&id, &TemplateRef::from("missing"), FlowOpts::default())
        .is_err());
    assert!(s.flow_layout(&BindingId::from("nope")).is_none());
}
