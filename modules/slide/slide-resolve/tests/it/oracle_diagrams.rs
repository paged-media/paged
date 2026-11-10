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
//! by `tooling/oracle/office/powerpoint/ppt-chart-probe.py`) is a shape of ours within 1 pt, and the
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

/// Slide ADR 705 amendment — SmartArt text turns as PowerPoint draws it: a
/// shape's text box (`dsp:txXfrm`) turns with the shape and by its own
/// `rot`. Every word PowerPoint drew in the `rotated-text` fixture's diagrams
/// (`rotated-text.words.json`, from its PDF) stands inside the text frame we
/// resolve for it, and stands as that frame turns: the vertical chevron
/// list's and the manual-operation list's turned shapes keep their text
/// upright, the hierarchy's quarter-turned root turns its text with it.
/// A text frame's text, its page box and its turn, degrees.
type Frame = (String, (f64, f64, f64, f64), f64);

#[test]
fn smartart_text_turns_as_powerpoint_drew_it() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../slide-conformance/fixtures");
    let bytes = std::fs::read(dir.join("rotated-text.pptx")).unwrap();
    let words: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("rotated-text.words.json")).unwrap())
            .unwrap();
    let deck = slide_resolve::resolve(&pptx_import::import_pptx(&bytes).unwrap());
    let mut checked = 0;
    let mut misses = Vec::new();
    let mut turned = 0;
    for (k, page) in words["pages"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .skip(1)
    {
        let mut items = Vec::new();
        for it in &deck.slides[k].items {
            walk(it, &mut items);
        }
        // Each text frame: its text, its page box and its turn, degrees.
        let frames: Vec<Frame> = items
            .iter()
            .filter_map(|it| {
                let ItemKind::Shape { text: Some(tf), .. } = &it.kind else {
                    return None;
                };
                let text: String = tf
                    .paragraphs
                    .iter()
                    .flat_map(|p| p.runs.iter().map(|r| r.text.as_str()))
                    .collect::<Vec<_>>()
                    .join(" ");
                let m = &it.transform;
                let turn =
                    (m[1].atan2(m[0]).to_degrees() + tf.rotation + tf.turn).rem_euclid(360.0);
                let (l, t, r, b) = tf.rect;
                let (cx, cy) = ((l + r) / 2.0, (t + b) / 2.0);
                let (hw, hh) = if tf.rotation != 0.0 {
                    ((b - t) / 2.0, (r - l) / 2.0)
                } else {
                    ((r - l) / 2.0, (b - t) / 2.0)
                };
                let (s, c) = (tf.rotation + tf.turn).to_radians().sin_cos();
                let mut bx = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
                for (dx, dy) in [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)] {
                    let (x, y) = (cx + c * dx - s * dy, cy + s * dx + c * dy);
                    let (px, py) = (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
                    bx = (bx.0.min(px), bx.1.min(py), bx.2.max(px), bx.3.max(py));
                }
                Some((text, bx, turn))
            })
            .collect();
        for w in page.as_array().unwrap() {
            let text = w["text"].as_str().unwrap();
            let v: Vec<f64> = w["box"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_f64().unwrap())
                .collect();
            let (wx, wy) = ((v[0] + v[2]) / 2.0, (v[1] + v[3]) / 2.0);
            let tall = (v[3] - v[1]) > 1.2 * (v[2] - v[0]);
            // The frame holding the word where PowerPoint drew it (a word
            // can stand in several).
            let holding: Vec<_> = frames
                .iter()
                .filter(|(t, ..)| t.split(' ').any(|p| p == text))
                .collect();
            if holding.is_empty() {
                misses.push(format!("slide {}: no frame holds {text:?}", k + 1));
                continue;
            }
            checked += 1;
            let inside = |bx: &(f64, f64, f64, f64)| {
                bx.0 - 2.0 <= wx && wx <= bx.2 + 2.0 && bx.1 - 2.0 <= wy && wy <= bx.3 + 2.0
            };
            let Some(&&(_, _, turn)) = holding.iter().find(|(_, bx, _)| inside(bx)) else {
                misses.push(format!(
                    "slide {}: {text:?} drawn at ({wx:.1}, {wy:.1}), our frames {:.1?}",
                    k + 1,
                    holding.iter().map(|h| h.1).collect::<Vec<_>>()
                ));
                continue;
            };
            let quarter = (turn - 90.0).abs() < 1.0 || (turn - 270.0).abs() < 1.0;
            let upright = turn < 1.0 || turn > 359.0;
            turned += usize::from(quarter);
            if (tall && !quarter) || (!tall && !upright) {
                misses.push(format!(
                    "slide {}: {text:?} drawn {}, our frame turned {turn:.1}",
                    k + 1,
                    if tall { "turned" } else { "upright" }
                ));
            }
        }
    }
    assert!(checked >= 15, "only {checked} words checked");
    assert_eq!(turned, 1, "one turned word (the hierarchy's root)");
    assert!(misses.is_empty(), "{}", misses.join("\n"));
}
