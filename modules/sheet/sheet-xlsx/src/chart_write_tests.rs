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

#![allow(non_snake_case)] // `__feat__<id>` test-name links (cockpit rule)

use super::*;

#[test]
fn relative_targets() {
    assert_eq!(
        relative("xl/drawings", "xl/charts/chart1.xml"),
        "../charts/chart1.xml"
    );
    assert_eq!(
        relative("xl/worksheets", "xl/drawings/drawing2.xml"),
        "../drawings/drawing2.xml"
    );
    assert_eq!(relative("xl", "xl/charts/c.xml"), "charts/c.xml");
}

fn chart(title: &str) -> ParsedChart {
    let mut c = ParsedChart::authored(0, ChartModel::default());
    c.model.title = Some(title.into());
    c
}

#[test]
fn recorded_indexes_keep_every_handle__feat__sheet_chart_writer() {
    // Discovery order: a, b (unrecorded, read from the file), then the
    // authored c recorded at 0… no: c recorded at 2, d recorded at 4.
    let found = vec![
        (chart("a"), None),
        (chart("d"), Some(4)),
        (chart("b"), None),
        (chart("c"), Some(2)),
    ];
    let out = order_by_recorded_index(found);
    let titles: Vec<String> = out
        .iter()
        .map(|c| {
            if c.removed {
                "-".into()
            } else {
                c.model.title.as_deref().unwrap_or("").to_string()
            }
        })
        .collect();
    assert_eq!(titles, ["a", "b", "c", "-", "d"]);
    // Nothing recorded: discovery order as it was.
    let plain = order_by_recorded_index(vec![(chart("x"), None), (chart("y"), None)]);
    assert_eq!(plain[1].model.title.as_deref(), Some("y"));
}

#[test]
fn theme_colours_write_as_scheme_slots() {
    let c = color_scheme(5, -0.25);
    assert_eq!(
        color_out(&c),
        Some(ColorOut::Scheme {
            slot: "accent2".into(),
            lum_mod: Some(75000),
            lum_off: None
        })
    );
    let dk = color_scheme(0, 0.4);
    assert_eq!(
        color_out(&dk),
        Some(ColorOut::Scheme {
            slot: "tx1".into(),
            lum_mod: Some(60000),
            lum_off: Some(40000)
        })
    );
    // A document swatch on an automatic colour writes the swatch's sRGB.
    let sw = ColorRef::auto().with_doc(doc_swatch("Color/Spot", 0x112233));
    assert_eq!(color_out(&sw), Some(ColorOut::Srgb(0x112233)));
}
