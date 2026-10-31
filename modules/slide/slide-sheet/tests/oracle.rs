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

//! Live charts against PowerPoint's drawing (ADR 705, ADR 715): the corpus
//! decks' charts, their workbooks opened through paged.sheet, laid out from
//! the cells. Every rectangle PowerPoint painted (`oracle/primary.charts.json`)
//! has a bar within 3 pt in the slide-chart layout of the live values; the
//! same chart drawn by paged.sheet's geometry is measured and reported, as
//! the record of why slide-chart keeps the kinds it draws.

use paged_ooxml::OpcPackage;

const TOLERANCE: f64 = 3.0;

type R = (f64, f64, f64, f64);

fn nearest(ours: &[R], r: R) -> f64 {
    ours.iter()
        .map(|o| {
            (o.0 - r.0)
                .abs()
                .max((o.1 - r.1).abs())
                .max((o.2 - r.2).abs())
                .max((o.3 - r.3).abs())
        })
        .fold(f64::MAX, f64::min)
}

#[test]
#[ignore = "corpus: pptx"]
fn corpus_live_charts_land_where_powerpoint_draws_them() {
    let Some(pptx) = paged_test_resources::corpus("pptx", &["PAGED_CORPUS"]) else {
        return;
    };
    let packs = pptx.join("packs");
    let mut checked = 0;
    let mut misses = Vec::new();
    let mut sheet_worst: f64 = 0.0;
    for entry in std::fs::read_dir(&packs).unwrap().filter_map(|e| e.ok()) {
        let Ok(text) = std::fs::read(entry.path().join("oracle/primary.charts.json")) else {
            continue;
        };
        let answers: serde_json::Value = serde_json::from_slice(&text).unwrap();
        let bytes = std::fs::read(entry.path().join("primary.pptx")).unwrap();
        let pkg = OpcPackage::read(&bytes).unwrap();
        let mut deck = pptx_import::import_pptx(&bytes).unwrap();
        // Every chart through its workbook.
        let parts: Vec<String> = deck.charts.keys().cloned().collect();
        let mut books = Vec::new();
        for part in parts {
            let book = slide_sheet::open_for(&pkg, &part).unwrap();
            book.apply(deck.charts.get_mut(&part).unwrap());
            books.push((part, book));
        }
        let resolved = slide_resolve::resolve(&deck);
        for c in answers["charts"].as_array().unwrap() {
            let slide = &resolved.slides[c["slide"].as_u64().unwrap() as usize - 1];
            let name = c["name"].as_str().unwrap();
            let group = slide.items.iter().find(|i| i.name == name).unwrap();
            let mut ours = Vec::new();
            rects(group, &mut ours);
            // paged.sheet's geometry at the frame's box.
            let (tx, ty) = (group.transform[4], group.transform[5]);
            let g = books[0].1.geometry(group.w, group.h, None);
            let sheet: Vec<R> = g
                .prims
                .iter()
                .filter_map(|p| match p {
                    sheet_chart::Primitive::Rect {
                        x, y, w, h, fill, ..
                    } if fill.is_some() => Some((tx + x, ty + y, tx + x + w, ty + y + h)),
                    _ => None,
                })
                .collect();
            for r in c["rects"].as_array().unwrap() {
                let v: Vec<f64> = r
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_f64().unwrap())
                    .collect();
                let r = (v[0], v[1], v[0] + v[2], v[1] + v[3]);
                checked += 1;
                let d = nearest(&ours, r);
                if d > TOLERANCE {
                    misses.push(format!(
                        "{}: bar {r:.1?} off by {d:.1}",
                        entry.file_name().to_string_lossy()
                    ));
                }
                sheet_worst = sheet_worst.max(nearest(&sheet, r));
            }
        }
    }
    eprintln!(
        "live charts: {checked} bars checked; paged.sheet geometry worst edge {sheet_worst:.1} pt"
    );
    assert!(checked > 0);
    assert!(misses.is_empty(), "{}", misses.join("\n"));
}

fn rects(it: &slide_resolve::model::Item, out: &mut Vec<R>) {
    use slide_resolve::model::{ItemKind, Paint};
    match &it.kind {
        ItemKind::Group { children } => children.iter().for_each(|c| rects(c, out)),
        ItemKind::Shape { outline, fill, .. }
            if outline.len() == 1
                && outline[0].points.len() == 4
                && !matches!(fill, Paint::None) =>
        {
            let m = &it.transform;
            let mut b = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
            for p in &outline[0].points {
                let (x, y) = (
                    m[0] * p.anchor.0 + m[2] * p.anchor.1 + m[4],
                    m[1] * p.anchor.0 + m[3] * p.anchor.1 + m[5],
                );
                b = (b.0.min(x), b.1.min(y), b.2.max(x), b.3.max(y));
            }
            out.push(b);
        }
        _ => {}
    }
}
