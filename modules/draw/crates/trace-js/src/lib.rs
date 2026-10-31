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

//! The wasm-bindgen surface of paged.draw — JSON in and JSON out: the
//! image trace over [`draw_trace`], and since draw ADR 364 the DXF
//! interchange over [`draw_dxf`] and the SVG paint reader of the engine's
//! `paged-svg` (a recolour that rewrites colours in place).
//!
//! **Why JSON and not a typed binding.** The boundary is crossed ONCE per
//! trace with a result of a few hundred KB, so a `serde_json` string is
//! the cheapest thing that keeps the TS side free of hand-written
//! decoding and keeps this crate free of `serde-wasm-bindgen` and
//! `js-sys`. It is not free — a 512-region spline trace serialises to a
//! megabyte or so — and that cost is named rather than hidden. A typed /
//! flat-buffer boundary is a v1 change with a real measurement behind it,
//! not a v0 guess.
//!
//! **Never panics across the boundary.** The artifact is built with
//! `panic = abort`, so a panic here is an unrecoverable abort of the
//! bundle realm, not a catchable exception. Every entry point therefore
//! returns `Result<String, String>` and the kernel's own refusals
//! (over-cap, bad raster) are ERRORS, not asserts. `console_error_panic_hook`
//! is installed so that if one ever does escape, the console says where.

#![allow(clippy::unused_unit)] // wasm-bindgen's generated shims

use draw_trace::{trace_rgba, TraceOptions, MAX_DIMENSION, MAX_PIXELS};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

/// Install the panic hook. Idempotent; called by the bundle right after
/// instantiation.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen(js_name = traceInit))]
pub fn trace_init() {
    #[cfg(target_arch = "wasm32")]
    console_error_panic_hook::set_once();
}

/// The kernel's HARD CAPS, as JSON — read by the bundle so the decoder's
/// downsample target and the tracer's refusal threshold can never drift
/// apart (there is one source of truth, and it is the Rust constant).
#[cfg_attr(target_arch = "wasm32", wasm_bindgen(js_name = traceLimits))]
pub fn trace_limits() -> String {
    format!("{{\"maxDimension\":{MAX_DIMENSION},\"maxPixels\":{MAX_PIXELS}}}")
}

/// Trace an RGBA8 raster. `options_json` is a camelCase
/// [`TraceOptions`] object (`"{}"` = every documented default).
///
/// Returns the [`draw_trace::TraceResult`] as JSON, or an error string
/// that is safe to show a user (it names the size that was refused).
///
/// **Synchronous and CPU-bound.** The bundle calls this on the thread it
/// runs on — in the editor, the MAIN thread — so a trace at the cap
/// stalls the UI for its duration. See `draw_trace`'s module docs.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen(js_name = traceRgba))]
pub fn trace_rgba_json(
    pixels: &[u8],
    width: u32,
    height: u32,
    options_json: &str,
) -> Result<String, String> {
    let options: TraceOptions = if options_json.trim().is_empty() {
        TraceOptions::default()
    } else {
        serde_json::from_str(options_json)
            .map_err(|e| format!("image trace: unreadable options ({e})"))?
    };
    let result = trace_rgba(pixels, width, height, options).map_err(|e| e.to_string())?;
    serde_json::to_string(&result).map_err(|e| format!("image trace: unserialisable result ({e})"))
}

/// A DXF file read into an SVG document (draw ADR 364): the
/// [`draw_dxf::DxfImport`] as JSON (`svg`, `report`, `layers`, `scale`).
#[cfg_attr(target_arch = "wasm32", wasm_bindgen(js_name = dxfToSvg))]
pub fn dxf_to_svg_json(bytes: &[u8]) -> Result<String, String> {
    let out = draw_dxf::dxf_to_svg(bytes)?;
    serde_json::to_string(&out).map_err(|e| format!("dxf: unserialisable result ({e})"))
}

/// An SVG document (the engine's export) written as DXF: the
/// [`draw_dxf::DxfExport`] as JSON (`dxf`, `report`).
#[cfg_attr(target_arch = "wasm32", wasm_bindgen(js_name = svgToDxf))]
pub fn svg_to_dxf_json(svg: &str) -> Result<String, String> {
    let out = draw_dxf::svg_to_dxf(svg)?;
    serde_json::to_string(&out).map_err(|e| format!("dxf: unserialisable result ({e})"))
}

/// The distinct colours an SVG declares, each with how many places
/// declare it: `[[r, g, b, count], …]` in order of first appearance.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen(js_name = svgColors))]
pub fn svg_colors_json(svg: &str) -> Result<String, String> {
    let counts = paged_svg::paint::color_counts(svg)?;
    let rows: Vec<[u32; 4]> = counts
        .iter()
        .map(|([r, g, b], n)| [u32::from(*r), u32::from(*g), u32::from(*b), *n])
        .collect();
    serde_json::to_string(&rows).map_err(|e| format!("svg: unserialisable result ({e})"))
}

/// `svg` with its declared colours replaced by `map_json`
/// (`[[[r, g, b], [r, g, b]], …]`, from → to), every other byte kept.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen(js_name = svgRecolor))]
pub fn svg_recolor(svg: &str, map_json: &str) -> Result<String, String> {
    let pairs: Vec<([u8; 3], [u8; 3])> =
        serde_json::from_str(map_json).map_err(|e| format!("svg: unreadable colour map ({e})"))?;
    paged_svg::paint::recolor(svg, &|c| {
        pairs.iter().find(|(from, _)| *from == c).map(|(_, to)| *to)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recolour_crosses_as_a_map_and_the_colours_as_rows() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#ff0000"/><rect fill="red" stroke="#00f"/></svg>"##;
        assert_eq!(svg_colors_json(svg).unwrap(), "[[255,0,0,2],[0,0,255,1]]");
        let out = svg_recolor(svg, "[[[255,0,0],[0,128,0]]]").unwrap();
        assert_eq!(out.matches("#008000").count(), 2, "{out}");
        assert!(svg_recolor(svg, "nope").is_err());
        assert!(svg_colors_json("<html/>").is_err());
    }

    #[test]
    fn dxf_crosses_both_ways_as_json() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M0 0 L10 10" stroke="#000"/></svg>"##;
        let out: serde_json::Value = serde_json::from_str(&svg_to_dxf_json(svg).unwrap()).unwrap();
        assert_eq!(out["report"]["items"], 1);
        let dxf = out["dxf"].as_str().unwrap();
        let back: serde_json::Value =
            serde_json::from_str(&dxf_to_svg_json(dxf.as_bytes()).unwrap()).unwrap();
        assert_eq!(back["report"]["items"], 1);
        assert!(back["svg"].as_str().unwrap().contains("<path"));
        assert!(svg_to_dxf_json("not svg").is_err());
    }

    #[test]
    fn limits_report_the_kernel_constants() {
        let json: serde_json::Value = serde_json::from_str(&trace_limits()).unwrap();
        assert_eq!(json["maxDimension"], MAX_DIMENSION);
        assert_eq!(json["maxPixels"], MAX_PIXELS);
    }

    #[test]
    fn an_empty_options_string_means_the_documented_defaults() {
        let pixels = vec![255u8; 16 * 16 * 4];
        let out = trace_rgba_json(&pixels, 16, 16, "").unwrap();
        let json: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(json["width"], 16);
        // Defaults are colour mode + ignore_white, so an all-white raster
        // traces to NOTHING rather than a page-sized white rectangle.
        assert_eq!(json["regions"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn a_refusal_crosses_the_boundary_as_an_error_string_never_a_panic() {
        let err = trace_rgba_json(&[], 9000, 9000, "{}").unwrap_err();
        assert!(err.contains("9000×9000"), "{err}");
        let bad = trace_rgba_json(&[], 16, 16, "{ not json }").unwrap_err();
        assert!(bad.contains("unreadable options"), "{bad}");
    }

    #[test]
    fn options_json_reaches_the_kernel() {
        // 8×8 black square: bw + ignore_white keeps it, and turning
        // ignore_white off adds nothing (there is no white).
        let pixels = [0u8, 0, 0, 255].repeat(8 * 8);
        let out = trace_rgba_json(&pixels, 8, 8, r#"{"mode":"bw","pathMode":"polygon"}"#).unwrap();
        let json: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(json["regions"].as_array().unwrap().len(), 1);
        assert_eq!(json["regions"][0]["color"][0], 0);
    }

    #[test]
    fn a_centreline_trace_crosses_as_strokes() {
        // A 3 px horizontal bar: one open stroke, no fills.
        let (w, h) = (32u32, 12u32);
        let mut pixels = vec![255u8; (w * h * 4) as usize];
        for y in 5..8 {
            for x in 2..30 {
                let i = ((y * w + x) * 4) as usize;
                pixels[i..i + 3].copy_from_slice(&[0, 0, 0]);
            }
        }
        let out = trace_rgba_json(&pixels, w, h, r#"{"mode":"centerline"}"#).unwrap();
        let json: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(json["regions"].as_array().unwrap().len(), 0);
        assert_eq!(json["strokes"].as_array().unwrap().len(), 1);
        assert_eq!(json["strokes"][0]["closed"], false);
    }
}
