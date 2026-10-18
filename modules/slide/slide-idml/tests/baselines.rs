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

//! PowerPoint's first baseline and line pitch for percentage line spacing
//! (fixture `baselines`, recorded by `scripts/ppt-baseline-probe.py`): every
//! box whose first paragraph sets a percentage lands within the PDF's
//! position quantum (0.96 pt) plus 1 % of the font size of PowerPoint's
//! answer. The 1 % is the font's own residual the rule ignores: at 72 pt
//! Arial sits one quantum below Calibri and Georgia.

use std::path::Path;

use slide_resolve::model::{Item, ItemKind};

fn find<'a>(items: &'a [Item], name: &str) -> Option<&'a Item> {
    items.iter().find_map(|it| match &it.kind {
        _ if it.name == name => Some(it),
        ItemKind::Group { children } => find(children, name),
        _ => None,
    })
}

#[test]
fn percentage_spacing_places_the_first_baseline_like_powerpoint() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../slide-conformance/fixtures");
    let bytes = std::fs::read(dir.join("baselines.pptx")).unwrap();
    let answers: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("baselines.baselines.json")).unwrap())
            .unwrap();
    let quantum = answers["quantum_pt"].as_f64().unwrap();
    let deck = slide_resolve::resolve(&pptx_import::import_pptx(&bytes).unwrap());
    let mut checked = 0;
    for b in answers["boxes"].as_array().unwrap() {
        let slide = &deck.slides[b["slide"].as_u64().unwrap() as usize - 1];
        let name = b["name"].as_str().unwrap();
        let it = find(&slide.items, name).unwrap_or_else(|| panic!("{name}: not resolved"));
        let ItemKind::Shape { text: Some(tf), .. } = &it.kind else {
            panic!("{name}: no text frame");
        };
        let Some(ours) = slide_idml::first_baseline(tf) else {
            continue;
        };
        let size = tf.paragraphs[0].runs[0].size;
        let tolerance = quantum + 0.01 * size + 0.01;
        let theirs = b["first_baseline"].as_f64().unwrap();
        assert!(
            (ours - theirs).abs() <= tolerance,
            "{name}: first baseline {ours:.2} pt, PowerPoint {theirs:.2} pt"
        );
        // The pitch, where the first line did not wrap (two lines, not three).
        let lead = tf.paragraphs[0].leading.unwrap();
        let pitch = b["pitch"].as_f64().unwrap();
        if pitch < 1.5 * lead {
            assert!(
                (lead - pitch).abs() <= tolerance,
                "{name}: pitch {lead:.2} pt, PowerPoint {pitch:.2} pt"
            );
        }
        checked += 1;
    }
    assert!(checked >= 40, "only {checked} percentage boxes checked");
}
