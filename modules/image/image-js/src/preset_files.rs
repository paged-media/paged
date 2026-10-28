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

//! The PRESET MANAGER's file doors (ADR 477): Photoshop's `.grd`, `.pat`
//! and `.asl`, read and written by `paged-psd` (`image_psd::presets`),
//! projected onto the JSON the bundle's preset libraries keep.
//!
//! Patterns travel as JSON metadata plus ONE byte buffer of every
//! pattern's RGBA8 in order (`width × height × 4` each), so pixels never
//! pass through a JSON string. Gradients and styles are `paged-psd`'s
//! serde forms (the Layer Style dialog's JSON for a style). A name in
//! Photoshop's localisable form (`$$$/…=Shown name`) keeps its raw form
//! for a round trip and adds `display`.

use image_psd::descriptor::localized_display;
use image_psd::effects::{Gradient, LayerStyle};
use image_psd::presets::{self, PatternPreset, StylePreset};
use serde_json::{json, Value};

use crate::ingest::IngestError;

fn decode(e: impl std::fmt::Display) -> IngestError {
    IngestError::Decode(e.to_string())
}

/// `.grd` → `{gradients: [{display, gradient}], skipped}`.
pub fn read_grd_json(bytes: &[u8]) -> Result<String, IngestError> {
    let f = presets::read_grd(bytes).map_err(decode)?;
    let mut rows = Vec::with_capacity(f.gradients.len());
    for g in &f.gradients {
        rows.push(json!({
            "display": localized_display(&g.name),
            "gradient": serde_json::to_value(g).map_err(decode)?,
        }));
    }
    Ok(json!({ "gradients": rows, "skipped": f.skipped }).to_string())
}

/// `[gradient…]` (the serde form) → `.grd` bytes.
pub fn write_grd_json(json: &str) -> Result<Vec<u8>, IngestError> {
    let list: Vec<Gradient> = serde_json::from_str(json).map_err(decode)?;
    Ok(presets::write_grd(&list))
}

fn meta(p: &PatternPreset) -> Value {
    json!({
        "name": p.name,
        "display": localized_display(&p.name),
        "id": p.id,
        "width": p.width,
        "height": p.height,
    })
}

fn pixels(ps: &[PatternPreset]) -> Vec<u8> {
    let mut out = Vec::with_capacity(ps.iter().map(|p| p.rgba.len()).sum());
    for p in ps {
        out.extend_from_slice(&p.rgba);
    }
    out
}

/// Rebuild patterns from metadata and the side buffer.
fn patterns_from(meta_json: &str, rgba: &[u8]) -> Result<Vec<PatternPreset>, IngestError> {
    let metas: Vec<Value> = serde_json::from_str(meta_json).map_err(decode)?;
    let mut at = 0usize;
    let mut out = Vec::with_capacity(metas.len());
    for v in metas {
        let m = PatternMeta::from(&v)?;
        if m.width == 0
            || m.height == 0
            || m.width > presets::MAX_PATTERN_SIDE
            || m.height > presets::MAX_PATTERN_SIDE
        {
            return Err(IngestError::Unsupported(format!(
                "pattern \"{}\" is {}×{}",
                m.name, m.width, m.height
            )));
        }
        let n = m.width as usize * m.height as usize * 4;
        let px = rgba.get(at..at + n).ok_or_else(|| {
            IngestError::Decode(format!("pattern \"{}\": the pixel buffer is short", m.name))
        })?;
        at += n;
        out.push(PatternPreset {
            name: m.name,
            id: m.id,
            width: m.width,
            height: m.height,
            rgba: px.to_vec(),
        });
    }
    if at != rgba.len() {
        return Err(IngestError::Decode(
            "the pattern pixel buffer is longer than its patterns".into(),
        ));
    }
    Ok(out)
}

struct PatternMeta {
    name: String,
    id: String,
    width: u32,
    height: u32,
}

impl PatternMeta {
    fn from(v: &Value) -> Result<PatternMeta, IngestError> {
        let s = |k: &str| v[k].as_str().unwrap_or_default().to_string();
        let n = |k: &str| {
            v[k].as_u64()
                .and_then(|x| u32::try_from(x).ok())
                .ok_or_else(|| {
                    IngestError::Decode(format!("pattern metadata: \"{k}\" is not a size"))
                })
        };
        Ok(PatternMeta {
            name: s("name"),
            id: s("id"),
            width: n("width")?,
            height: n("height")?,
        })
    }
}

/// `.pat` → `{patterns: [meta], skipped: [reason]}`.
pub fn read_pat_json(bytes: &[u8]) -> Result<String, IngestError> {
    let f = presets::read_pat(bytes).map_err(decode)?;
    let patterns: Vec<Value> = f.patterns.iter().map(meta).collect();
    Ok(json!({ "patterns": patterns, "skipped": f.skipped }).to_string())
}

/// `.pat` → every pattern's RGBA8, in the order of [`read_pat_json`].
pub fn read_pat_pixels(bytes: &[u8]) -> Result<Vec<u8>, IngestError> {
    Ok(pixels(&presets::read_pat(bytes).map_err(decode)?.patterns))
}

/// Metadata + side buffer → `.pat` bytes.
pub fn write_pat_json(meta_json: &str, rgba: &[u8]) -> Result<Vec<u8>, IngestError> {
    Ok(presets::write_pat(&patterns_from(meta_json, rgba)?))
}

/// `.asl` → `{styles: [{name, display, id, style}], patterns: [meta],
/// skipped}`; the patterns' pixels come from [`read_asl_pixels`].
pub fn read_asl_json(bytes: &[u8]) -> Result<String, IngestError> {
    let f = presets::read_asl(bytes).map_err(decode)?;
    let mut styles = Vec::with_capacity(f.styles.len());
    for s in &f.styles {
        styles.push(json!({
            "name": s.name,
            "display": localized_display(&s.name),
            "id": s.id,
            "style": serde_json::to_value(&s.style).map_err(decode)?,
        }));
    }
    let patterns: Vec<Value> = f.patterns.iter().map(meta).collect();
    Ok(json!({ "styles": styles, "patterns": patterns, "skipped": f.skipped }).to_string())
}

/// `.asl` → its patterns' RGBA8, in the order of [`read_asl_json`].
pub fn read_asl_pixels(bytes: &[u8]) -> Result<Vec<u8>, IngestError> {
    Ok(pixels(&presets::read_asl(bytes).map_err(decode)?.patterns))
}

/// `[style row]`, pattern metadata and their pixels → `.asl` bytes.
pub fn write_asl_json(
    styles_json: &str,
    patterns_json: &str,
    rgba: &[u8],
) -> Result<Vec<u8>, IngestError> {
    let rows: Vec<Value> = serde_json::from_str(styles_json).map_err(decode)?;
    let mut styles = Vec::with_capacity(rows.len());
    for r in rows {
        let style: LayerStyle = serde_json::from_value(r["style"].clone()).map_err(decode)?;
        styles.push(StylePreset {
            name: r["name"].as_str().unwrap_or("Style").to_string(),
            id: r["id"].as_str().unwrap_or_default().to_string(),
            style,
        });
    }
    Ok(presets::write_asl(
        &styles,
        &patterns_from(patterns_json, rgba)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(non_snake_case)]
    fn gradients_cross_the_json_door_both_ways__feat__image_editor_snapshots_presets() {
        let g = Gradient {
            name: "$$$/Presets/Gradients/BW=Black, White".into(),
            ..Gradient::two([0; 3], [255; 3])
        };
        let bytes = presets::write_grd(&[g]);
        let json = read_grd_json(&bytes).expect("read");
        let v: serde_json::Value = serde_json::from_str(&json).expect("json");
        assert_eq!(v["gradients"][0]["display"], "Black, White");
        assert_eq!(v["skipped"], 0);
        let list = serde_json::to_string(&[&v["gradients"][0]["gradient"]]).expect("list");
        let again = write_grd_json(&list).expect("write");
        assert_eq!(again, bytes, "the serde form writes the same file");
    }

    #[test]
    #[allow(non_snake_case)]
    fn patterns_travel_as_metadata_and_one_pixel_buffer__feat__image_editor_snapshots_presets() {
        let meta_json = r#"[{"name":"A","id":"a","width":2,"height":1},{"name":"B","id":"b","width":1,"height":1}]"#;
        let rgba = [1u8, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 128];
        let bytes = write_pat_json(meta_json, &rgba).expect("write");
        let back: serde_json::Value =
            serde_json::from_str(&read_pat_json(&bytes).expect("read")).expect("json");
        assert_eq!(back["patterns"][1]["id"], "b");
        assert_eq!(back["patterns"][0]["display"], "A");
        assert_eq!(read_pat_pixels(&bytes).expect("px"), rgba.to_vec());
        assert!(write_pat_json(meta_json, &rgba[..8]).is_err(), "short");
        let mut long = rgba.to_vec();
        long.push(0);
        assert!(write_pat_json(meta_json, &long).is_err(), "long");
    }

    #[test]
    #[allow(non_snake_case)]
    fn styles_cross_the_json_door_with_their_patterns__feat__image_editor_snapshots_presets() {
        let mut style = LayerStyle::default();
        style
            .drop_shadows
            .push(image_psd::effects::Shadow::drop_default());
        let styles_json = json!([{
            "name": "Lift",
            "id": "s1",
            "style": serde_json::to_value(&style).expect("style"),
        }])
        .to_string();
        let pats = r#"[{"name":"P","id":"p","width":1,"height":1}]"#;
        let bytes = write_asl_json(&styles_json, pats, &[9, 9, 9, 255]).expect("write");
        let v: serde_json::Value =
            serde_json::from_str(&read_asl_json(&bytes).expect("read")).expect("json");
        assert_eq!(v["styles"][0]["name"], "Lift");
        assert_eq!(v["styles"][0]["id"], "s1");
        assert_eq!(
            v["styles"][0]["style"]["dropShadows"]
                .as_array()
                .map(Vec::len),
            Some(1)
        );
        assert_eq!(v["patterns"][0]["id"], "p");
        assert_eq!(read_asl_pixels(&bytes).expect("px"), vec![9, 9, 9, 255]);
    }
}
