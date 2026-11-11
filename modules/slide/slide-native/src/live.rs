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

//! The Insert ▸ Shapes gallery (slide ADR 717): every DrawingML preset by
//! PowerPoint's category, and a preset drawn as a new shape.
//!
//! A preset on the document is the engine's live shape (engine ADR 1096):
//! `Polygon::preset` holds the program, its adjust values, its box, the
//! part an element draws, the key its elements share and a connector's
//! glue. The engine refits a resized preset with its companions, routes a
//! glued connector again and serves the adjust handles; this module only
//! draws new shapes for the paste door and lists the gallery. All geometry
//! is the engine's (`paged-preset-geom`, through `dml-geom`).

use paged_model::live_shape::{PresetPart, PresetShape};
use serde::Serialize;
use serde_json::json;
use slide_geom::live::{self as geom, apply, part_of, Affine, Part};
use slide_geom::SubPath;

use crate::ascii;

/// SVG path data of `subpaths` placed by `t`.
pub fn svg_path(subpaths: &[SubPath], t: &Affine) -> String {
    let mut d = String::new();
    let f = |p: (f64, f64)| {
        let q = apply(t, p);
        format!("{:.2} {:.2}", q.0, q.1)
    };
    for s in subpaths {
        let pts = &s.points;
        let Some(first) = pts.first() else { continue };
        d.push_str(&format!("M{} ", f(first.anchor)));
        let segs = if s.closed { pts.len() } else { pts.len() - 1 };
        for i in 0..segs {
            let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
            d.push_str(&format!("C{} {} {} ", f(a.right), f(b.left), f(b.anchor)));
        }
        if s.closed {
            d.push('Z');
        }
    }
    d.trim_end().to_string()
}

/// A preset drawn as a new shape (Insert ▸ Shapes): page items for the
/// host's paste door (`pasteElements`), one undo step. The outline element
/// and, for a preset with stroke-only detail paths, the detail element
/// above it, each the engine's live preset for the box `(0, 0)`–`(w, h)`
/// (centred where the paste puts it), sharing one key.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewShape {
    /// The paste door's snippet JSON.
    pub snippet: String,
    /// How many elements it holds.
    pub elements: usize,
}

/// The fill and line a new shape takes: PowerPoint's default shape style
/// on the Office theme (Accent 1, its line a shade darker, 1 pt), until
/// the deck's own theme swatches are in the document (slide W3).
const NEW_FILL: (&str, [f32; 3]) = ("Color/paged.slide/shape-fill", [68.0, 114.0, 196.0]);
const NEW_LINE: (&str, [f32; 3]) = ("Color/paged.slide/shape-line", [47.0, 82.0, 143.0]);

/// Preset `prst` with its default adjust values, drawn for a `w` × `h`
/// box, its elements keyed `key` (a shape key of the editor's own, `new:…`:
/// the engine's preset key, so they refit together, and the slide label's
/// shape key, so export writes them as one shape). `None` for an unknown
/// preset.
pub fn new_shape(prst: &str, w: f64, h: f64, key: &str) -> Option<NewShape> {
    use paged_model::{Bounds, ColorEntry, ColorModel, ColorSpace, FrameRef, Polygon, Spread};
    let out = slide_geom::preset(prst, &[], w, h)?;
    let label = ascii(&json!({ "v": 1, "data": { "shape": key } }).to_string());
    let preset = |part: PresetPart| PresetShape {
        part,
        key: Some(key.to_string()),
        ..PresetShape::new(prst, w as f32, h as f32)
    };
    let filled = part_of(&out.subpaths, Part::Fill);
    let parts: Vec<(Vec<SubPath>, bool, PresetPart)> = if filled.is_empty() {
        vec![(part_of(&out.subpaths, Part::All), false, PresetPart::All)]
    } else {
        vec![
            (filled, true, PresetPart::Fill),
            (
                part_of(&out.subpaths, Part::Detail),
                false,
                PresetPart::Detail,
            ),
        ]
    };
    let mut spread = Spread::default();
    let name = format!("{} 1", crate::live::display_name(prst));
    for (i, (sub, fill, part)) in parts.into_iter().enumerate() {
        if sub.is_empty() {
            continue;
        }
        let id = format!("s{}", i + 1);
        let path = crate::Outline::of(&sub);
        let poly = Polygon {
            item_transform: Some([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]),
            fill_color: Some(if fill { NEW_FILL.0 } else { crate::NONE_SWATCH }.to_string()),
            stroke_color: Some(NEW_LINE.0.to_string()),
            stroke_weight: Some(1.0),
            applied_object_style: Some(crate::NO_OBJECT_STYLE.into()),
            bounds: path.bounds(),
            anchors: path.anchors,
            subpath_starts: path.starts,
            subpath_open: path.open,
            preset: Some(preset(part)),
            ..Polygon::new(id.clone(), Bounds::ZERO)
        };
        spread.labels.insert(
            id.clone(),
            vec![(crate::SLIDE_LABEL_KEY.to_string(), label.clone())],
        );
        spread.item_names.insert(id.clone(), name.clone());
        spread.polygons.push(poly);
        spread
            .frames_in_order
            .push(FrameRef::Polygon(spread.polygons.len() - 1));
    }
    if spread.frames_in_order.is_empty() {
        return None;
    }
    let color = |(id, rgb): (&str, [f32; 3])| ColorEntry {
        self_id: id.to_string(),
        name: None,
        space: ColorSpace::Rgb,
        value: rgb.to_vec(),
        model: ColorModel::Process,
        alternate_space: None,
        alternate_value: Vec::new(),
        tint: None,
        alpha: None,
        theme_ref: None,
    };
    let elements = spread.frames_in_order.len();
    let snippet = json!({
        "format": "paged.snippet/1",
        "spread": spread,
        "stories": [],
        "bounds": [0.0, 0.0, h, w],
        "resources": {
            "colors": {
                NEW_FILL.0: color(NEW_FILL),
                NEW_LINE.0: color(NEW_LINE),
            }
        }
    });
    Some(NewShape {
        snippet: snippet.to_string(),
        elements,
    })
}

/// A preset's name as people read it: `roundRect` → `Round Rect`.
pub fn display_name(prst: &str) -> String {
    let mut out = String::new();
    for (i, c) in prst.chars().enumerate() {
        if i == 0 {
            out.extend(c.to_uppercase());
        } else if c.is_ascii_uppercase()
            || (c.is_ascii_digit() && !out.ends_with(|d: char| d.is_ascii_digit()))
        {
            out.push(' ');
            out.push(c);
        } else {
            out.push(c);
        }
    }
    out
}

/// The gallery: every preset, by PowerPoint's Insert ▸ Shapes category,
/// with a small outline to show (SVG path data in a 40 × 30 box).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryItem {
    pub prst: String,
    pub category: &'static str,
    pub path: String,
}

/// PowerPoint's Insert ▸ Shapes category of a preset.
pub fn category(prst: &str) -> &'static str {
    const LINES: &[&str] = &[
        "line",
        "straightConnector1",
        "bentConnector2",
        "bentConnector3",
        "bentConnector4",
        "bentConnector5",
        "curvedConnector2",
        "curvedConnector3",
        "curvedConnector4",
        "curvedConnector5",
        "lineInv",
    ];
    const RECTS: &[&str] = &[
        "rect",
        "roundRect",
        "snip1Rect",
        "snip2SameRect",
        "snip2DiagRect",
        "snipRoundRect",
        "round1Rect",
        "round2SameRect",
        "round2DiagRect",
    ];
    const EQUATION: &[&str] = &[
        "mathPlus",
        "mathMinus",
        "mathMultiply",
        "mathDivide",
        "mathEqual",
        "mathNotEqual",
    ];
    if LINES.contains(&prst) {
        "lines"
    } else if RECTS.contains(&prst) {
        "rectangles"
    } else if EQUATION.contains(&prst) {
        "equation"
    } else if prst.starts_with("flowChart") {
        "flowchart"
    } else if prst.starts_with("actionButton") {
        "actionButtons"
    } else if prst.contains("Callout")
        || prst.starts_with("callout")
        || prst.starts_with("wedge")
        || prst == "cloudCallout"
    {
        "callouts"
    } else if prst.starts_with("star")
        || prst.contains("Ribbon")
        || prst.starts_with("ribbon")
        || prst.contains("Scroll")
        || prst == "wave"
        || prst == "doubleWave"
        || prst.starts_with("irregularSeal")
    {
        "starsAndBanners"
    } else if prst.contains("Arrow") || prst.starts_with("chevron") || prst == "homePlate" {
        "blockArrows"
    } else {
        "basicShapes"
    }
}

/// Every preset for the gallery, in category order, then by name.
pub fn gallery() -> Vec<GalleryItem> {
    const ORDER: &[&str] = &[
        "lines",
        "rectangles",
        "basicShapes",
        "blockArrows",
        "equation",
        "flowchart",
        "starsAndBanners",
        "callouts",
        "actionButtons",
    ];
    let mut items: Vec<GalleryItem> = slide_geom::preset_names()
        .into_iter()
        .filter_map(|n| {
            let o = slide_geom::preset(n, &[], 40.0, 30.0)?;
            Some(GalleryItem {
                prst: n.to_string(),
                category: category(n),
                path: svg_path(&o.subpaths, &geom::IDENTITY),
            })
        })
        .collect();
    items.sort_by_key(|i| (ORDER.iter().position(|c| *c == i.category), i.prst.clone()));
    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn a_new_shape_is_a_paste_snippet_of_live_presets() {
        let s = new_shape("can", 120.0, 80.0, "new:7").unwrap();
        assert_eq!(s.elements, 2);
        let v: Value = serde_json::from_str(&s.snippet).unwrap();
        assert_eq!(v["format"], "paged.snippet/1");
        let polys: Vec<paged_model::Polygon> =
            serde_json::from_value(v["spread"]["polygons"].clone()).unwrap();
        assert_eq!(polys.len(), 2);
        let (fill, detail) = (&polys[0], &polys[1]);
        // Each element is the engine's live preset for the box, keyed as one shape.
        for (p, part) in [(fill, PresetPart::Fill), (detail, PresetPart::Detail)] {
            let preset = paged_preset_geom::model::live_preset(p).expect("live");
            assert_eq!(preset.name, "can");
            assert_eq!(preset.frame, [0.0, 0.0, 120.0, 80.0]);
            assert_eq!(preset.part, part);
            assert_eq!(preset.key.as_deref(), Some("new:7"));
        }
        // The slide label keeps only the shape key.
        let labels = v["spread"]["labels"].as_object().unwrap();
        let l: Value = serde_json::from_str(labels["s1"][0][1].as_str().unwrap()).unwrap();
        assert_eq!(l["data"], json!({ "shape": "new:7" }));
        // Every preset can be inserted, and each is live.
        for n in slide_geom::preset_names() {
            let s = new_shape(n, 100.0, 60.0, "new:1").unwrap_or_else(|| panic!("{n}"));
            let v: Value = serde_json::from_str(&s.snippet).unwrap();
            let polys: Vec<paged_model::Polygon> =
                serde_json::from_value(v["spread"]["polygons"].clone()).unwrap();
            for p in &polys {
                assert!(paged_preset_geom::model::live_preset(p).is_some(), "{n}");
            }
        }
    }

    #[test]
    fn the_gallery_holds_every_preset_once() {
        let g = gallery();
        assert_eq!(g.len(), 187);
        assert_eq!(g[0].category, "lines");
        assert!(g
            .iter()
            .any(|i| i.prst == "roundRect" && i.category == "rectangles"));
        assert!(g
            .iter()
            .any(|i| i.prst == "flowChartProcess" && i.category == "flowchart"));
        assert_eq!(display_name("roundRect"), "Round Rect");
        assert_eq!(display_name("star24"), "Star 24");
    }
}
