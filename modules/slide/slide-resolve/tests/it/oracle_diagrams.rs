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

//! SmartArt against PowerPoint's own drawing (ADR 705): every block
//! PowerPoint painted inside a diagram of the `smartart` fixture (recorded
//! by `scripts/ppt-chart-probe.py`) is a shape of ours within 1 pt, and the
//! diagram's text is in the colours PowerPoint drew it in.

use std::path::Path;

use slide_resolve::model::{Item, ItemKind, Paint};

fn walk<'a>(it: &'a Item, out: &mut Vec<&'a Item>) {
    out.push(it);
    if let ItemKind::Group { children } = &it.kind {
        for c in children {
            walk(c, out);
        }
    }
}

fn page_box(it: &Item) -> Option<(f64, f64, f64, f64)> {
    let ItemKind::Shape { outline, fill, .. } = &it.kind else {
        return None;
    };
    if matches!(fill, Paint::None) || outline.is_empty() {
        return None;
    }
    let m = &it.transform;
    let mut b = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for sp in outline {
        for p in &sp.points {
            let (x, y) = (
                m[0] * p.anchor.0 + m[2] * p.anchor.1 + m[4],
                m[1] * p.anchor.0 + m[3] * p.anchor.1 + m[5],
            );
            b = (b.0.min(x), b.1.min(y), b.2.max(x), b.3.max(y));
        }
    }
    Some(b)
}

#[test]
fn smartart_draws_what_powerpoint_drew() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../slide-conformance/fixtures");
    let bytes = std::fs::read(dir.join("smartart.pptx")).unwrap();
    let answers: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("smartart.frames.json")).unwrap()).unwrap();
    let deck = slide_resolve::resolve(&pptx_import::import_pptx(&bytes).unwrap());
    let mut misses = Vec::new();
    let mut checked = 0;
    for f in answers["charts"].as_array().unwrap() {
        let slide = &deck.slides[f["slide"].as_u64().unwrap() as usize - 1];
        let name = f["name"].as_str().unwrap();
        let Some(frame) = slide.items.iter().find(|i| i.name == name) else {
            misses.push(format!("{name}: not resolved"));
            continue;
        };
        let mut items = Vec::new();
        walk(frame, &mut items);
        let boxes: Vec<_> = items.iter().filter_map(|i| page_box(i)).collect();
        for r in f["rects"].as_array().unwrap() {
            let v: Vec<f64> = r
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_f64().unwrap())
                .collect();
            let (l, t, rr, b) = (v[0], v[1], v[0] + v[2], v[1] + v[3]);
            checked += 1;
            if !boxes.iter().any(|o| {
                (o.0 - l).abs() <= 1.0
                    && (o.1 - t).abs() <= 1.0
                    && (o.2 - rr).abs() <= 1.0
                    && (o.3 - b).abs() <= 1.0
            }) {
                misses.push(format!(
                    "{name}: PowerPoint block {:.1?} has no shape",
                    (l, t, rr, b)
                ));
            }
        }
        let want: Vec<[u8; 3]> = f["text_rgb"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                let c = c.as_array().unwrap();
                [
                    c[0].as_u64().unwrap() as u8,
                    c[1].as_u64().unwrap() as u8,
                    c[2].as_u64().unwrap() as u8,
                ]
            })
            .collect();
        for it in &items {
            let ItemKind::Shape { text: Some(tf), .. } = &it.kind else {
                continue;
            };
            for run in tf
                .paragraphs
                .iter()
                .flat_map(|p| &p.runs)
                .filter(|r| !r.text.trim().is_empty())
            {
                if !want.contains(&run.rgb) {
                    misses.push(format!(
                        "{name}: text {:?} in {:?}, PowerPoint {want:?}",
                        run.text, run.rgb
                    ));
                }
            }
        }
    }
    assert!(checked >= 40, "only {checked} blocks checked");
    assert!(misses.is_empty(), "{}", misses.join("\n"));
}
