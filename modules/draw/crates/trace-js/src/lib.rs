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

//! The wasm-bindgen surface over [`draw_trace`] — three functions, JSON
//! in and JSON out.
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
