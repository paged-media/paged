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

//! The story's table-of-contents style, the inks and the page setup are
//! serde-default: a model written before they existed reads with them
//! absent, and a model that carries them keeps them.

use paged_model::{DocumentPreference, Graphic, InkDef, Story};

#[test]
fn a_model_written_before_the_fields_reads_them_as_absent() {
    let story: Story = serde_json::from_str(
        r#"{"paragraphs":[],"optical_margin_alignment":false,"optical_margin_size":0.0,"story_direction":null}"#,
    )
    .unwrap();
    assert_eq!(story.applied_toc_style, None);

    let palette: Graphic =
        serde_json::from_str(r#"{"colors":{},"swatches":{},"gradients":{},"color_groups":{}}"#)
            .unwrap();
    assert!(palette.inks.is_empty());

    let pref: DocumentPreference = serde_json::from_str(
        r#"{"bleed_top":9.0,"bleed_bottom":0.0,"bleed_inside_or_left":0.0,"bleed_outside_or_right":0.0,"slug_top":0.0,"slug_bottom":0.0,"slug_inside_or_left":0.0,"slug_right_or_outside":0.0}"#,
    )
    .unwrap();
    assert_eq!(pref.bleed_top, 9.0);
    assert_eq!(
        (
            pref.page_width,
            pref.page_height,
            pref.facing_pages,
            pref.page_binding
        ),
        (None, None, None, None)
    );
}

#[test]
fn the_fields_survive_serialization() {
    let story = Story {
        applied_toc_style: Some("TOCStyle/TOC Style".into()),
        ..Default::default()
    };
    let back: Story = serde_json::from_str(&serde_json::to_string(&story).unwrap()).unwrap();
    assert_eq!(
        back.applied_toc_style.as_deref(),
        Some("TOCStyle/TOC Style")
    );

    let palette = Graphic {
        inks: vec![InkDef {
            self_id: "Ink/$ID/Process Cyan".into(),
            name: Some("$ID/Process Cyan".into()),
            angle: Some(75.0),
            frequency: Some(70.0),
            neutral_density: Some(0.61),
            convert_to_process: Some(false),
            print_ink: Some(true),
            trap_order: Some(1),
            ink_type: Some("Normal".into()),
            alias_ink_name: None,
        }],
        ..Default::default()
    };
    let back: Graphic = serde_json::from_str(&serde_json::to_string(&palette).unwrap()).unwrap();
    assert_eq!(back.inks, palette.inks);

    let pref = DocumentPreference {
        page_width: Some(612.0),
        page_height: Some(792.0),
        facing_pages: Some(false),
        page_binding: Some("RightToLeft".into()),
        ..Default::default()
    };
    let back: DocumentPreference =
        serde_json::from_str(&serde_json::to_string(&pref).unwrap()).unwrap();
    assert_eq!(back, pref);
}
