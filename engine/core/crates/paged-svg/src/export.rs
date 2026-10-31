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

//! A page's display list → an SVG document (engine ADR 1031).
//!
//! The display list is what every module's content draws as, so one
//! writer serves them all. Paths are written in page coordinates (the
//! list strokes in page space too, so stroke widths carry over as they
//! are); gradients in page space (`userSpaceOnUse`); clips, blend groups
//! and soft masks as `<clipPath>`, `<g>` with `opacity` /
//! `mix-blend-mode` / `isolation`, and `<mask>`; images as data URIs;
//! text as `<text>` naming its font, or as its outlines. Colours are the
//! list's linear light written as sRGB. What SVG has no word for is
//! reported, never silently dropped.

use std::collections::HashMap;
use std::fmt::Write as _;

use paged_compose::{
    BlendMode, Color, DisplayCommand, DisplayList, FillRule, LineCap, LineJoin, Paint, PathSegment,
    SoftMaskType, Stroke, Transform,
};
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

use crate::report::SvgReport;

/// What text becomes in the export.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub enum SvgTextMode {
    /// Glyph outlines: looks the same everywhere, is not text any more.
    #[default]
    Outlines,
    /// `<text>` naming the font: editable and searchable, drawn by
    /// whatever face the viewer has by that name.
    Text,
}

/// How the export is written. Every field is optional.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct SvgExportOptions {
    /// Absent: [`SvgTextMode::Outlines`].
    #[serde(default)]
    pub text: Option<SvgTextMode>,
    /// No line breaks and no indentation. Absent: false.
    #[serde(default)]
    pub minify: Option<bool>,
    /// Decimal places of coordinates (0–6). Absent: 3 (2 when minified).
    #[serde(default)]
    pub precision: Option<u8>,
    /// The page region written, `[x, y, width, height]` page-local pt.
    /// Absent: the whole page (or, for an export of some items, the box
    /// around what they draw).
    #[serde(default)]
    pub region: Option<[f32; 4]>,
}

/// A font the list's glyphs are set in.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportFont {
    pub family: String,
    pub style: Option<String>,
    pub units_per_em: f32,
}

/// Names the fonts of a list's glyph runs.
pub trait FontName {
    /// The face a glyph run's `face_id` names.
    fn font(&self, face_id: u32) -> Option<ExportFont>;
}

/// No font is known: text mode writes outlines.
impl FontName for () {
    fn font(&self, _: u32) -> Option<ExportFont> {
        None
    }
}

/// What [`export_display_list`] reads.
pub struct ExportInput<'a> {
    pub list: &'a DisplayList,
    /// The page's size (pt): the default region.
    pub width: f32,
    pub height: f32,
    pub fonts: &'a dyn FontName,
    /// Fit the region to what the list draws (an export of some items).
    pub fit_to_content: bool,
}

/// Units per em of a font file (`head.unitsPerEm`), for [`ExportFont`].
pub fn units_per_em(bytes: &[u8]) -> Option<f32> {
    let u16_at = |o: usize| -> Option<u16> {
        Some(u16::from_be_bytes([*bytes.get(o)?, *bytes.get(o + 1)?]))
    };
    let u32_at = |o: usize| -> Option<u32> {
        Some(u32::from_be_bytes([
            *bytes.get(o)?,
            *bytes.get(o + 1)?,
            *bytes.get(o + 2)?,
            *bytes.get(o + 3)?,
        ]))
    };
    let base = if bytes.get(0..4)? == b"ttcf" {
        u32_at(12)? as usize
    } else {
        0
    };
    let n = u16_at(base + 4)? as usize;
    let head = (0..n).find_map(|i| {
        let rec = base + 12 + i * 16;
        (bytes.get(rec..rec + 4)? == b"head").then(|| u32_at(rec + 8))?
    })? as usize;
    let upem = u16_at(head + 18)? as f32;
    (upem > 0.0).then_some(upem)
}

/// One open `<g>` (or the document root): its attributes are known only
/// when it closes (a feather's mask is found after its object).
struct Frame {
    attrs: String,
    children: Vec<(usize, String)>,
    /// What closes it.
    kind: FrameKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FrameKind {
    Root,
    Clip,
    Blend,
    Layer,
    /// A soft mask's artwork, until `BeginMaskedContent`.
    MaskArtwork,
    /// The masked content, until `EndSoftMask`.
    Masked,
    /// A feathered object's run, until its last feather.
    Feather,
}

struct Writer<'a> {
    input: &'a ExportInput<'a>,
    text_mode: SvgTextMode,
    prec: usize,
    defs: Vec<String>,
    stack: Vec<Frame>,
    report: SvgReport,
    next_id: u32,
    items: u32,
    /// Commands that are glyphs, by command index.
    glyphs: HashMap<u32, &'a paged_compose::display_list::GlyphRunEntry>,
    /// Feather runs: start → index of its last feather command.
    feather_end: HashMap<usize, usize>,
    /// The box around what was drawn (page-local), for a fit region.
    bounds: Option<[f32; 4]>,
    /// The box of each open clip (page-local), innermost last: what is
    /// drawn inside a clip grows the fitted region only within it.
    clip_boxes: Vec<[f32; 4]>,
    /// The fill just written, when it is still the frame's last element:
    /// a stroke of the same path joins it as one `<path>`.
    last_fill: Option<(paged_compose::PathId, [f32; 6], usize)>,
    minify: bool,
    /// Engine ADR 1039 (draw ADR 365) — the `<symbol>` written for each
    /// definition form, by `SymbolForm::key`: one per definition (and
    /// tint), however many instances `<use>` it.
    symbols: HashMap<u64, String>,
}

fn srgb(v: f32) -> u8 {
    let s = if v <= 0.003_130_8 {
        12.92 * v
    } else {
        1.055 * v.max(0.0).powf(1.0 / 2.4) - 0.055
    };
    (s.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn css(c: Color) -> String {
    format!("#{:02x}{:02x}{:02x}", srgb(c.r), srgb(c.g), srgb(c.b))
}

fn blend_css(b: BlendMode) -> Option<&'static str> {
    Some(match b {
        BlendMode::Normal => return None,
        BlendMode::Multiply => "multiply",
        BlendMode::Screen => "screen",
        BlendMode::Overlay => "overlay",
        BlendMode::Darken => "darken",
        BlendMode::Lighten => "lighten",
        BlendMode::ColorDodge => "color-dodge",
        BlendMode::ColorBurn => "color-burn",
        BlendMode::HardLight => "hard-light",
        BlendMode::SoftLight => "soft-light",
        BlendMode::Difference => "difference",
        BlendMode::Exclusion => "exclusion",
        BlendMode::Hue => "hue",
        BlendMode::Saturation => "saturation",
        BlendMode::Color => "color",
        BlendMode::Luminosity => "luminosity",
    })
}

fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' => {}
            c => out.push(c),
        }
    }
    out
}

fn apply(t: &Transform, x: f32, y: f32) -> (f32, f32) {
    let [a, b, c, d, e, f] = t.0;
    (a * x + c * y + e, b * x + d * y + f)
}

impl<'a> Writer<'a> {
    fn num(&self, v: f32) -> String {
        let v = if v.abs() < 0.5 * 10f32.powi(-(self.prec as i32)) {
            0.0
        } else {
            v
        };
        let mut s = format!("{:.*}", self.prec, v);
        if s.contains('.') {
            while s.ends_with('0') {
                s.pop();
            }
            if s.ends_with('.') {
                s.pop();
            }
        }
        if s == "-0" {
            s = "0".into();
        }
        s
    }

    fn id(&mut self, prefix: &str) -> String {
        self.next_id += 1;
        format!("{prefix}{}", self.next_id)
    }

    fn grow(&mut self, x: f32, y: f32, pad: f32) {
        if !x.is_finite() || !y.is_finite() {
            return;
        }
        let (x, y, pad) = match self.clip_boxes.last() {
            Some(&[x0, y0, x1, y1]) => (x.clamp(x0, x1), y.clamp(y0, y1), 0.0),
            None => (x, y, pad),
        };
        let b = self.bounds.get_or_insert([x, y, x, y]);
        b[0] = b[0].min(x - pad);
        b[1] = b[1].min(y - pad);
        b[2] = b[2].max(x + pad);
        b[3] = b[3].max(y + pad);
    }

    /// The path's `d` in page coordinates.
    fn d(
        &mut self,
        path_id: paged_compose::PathId,
        t: &Transform,
        pad: Option<f32>,
    ) -> Option<(String, FillRule)> {
        let data = self.input.list.paths.get(path_id)?;
        let mut d = String::new();
        let segs = data.segments.clone();
        let mut cur = (0.0f32, 0.0f32);
        let mut start = cur;
        for s in &segs {
            match *s {
                PathSegment::MoveTo { x, y } => {
                    let (x, y) = apply(t, x, y);
                    cur = (x, y);
                    start = cur;
                    if let Some(p) = pad {
                        self.grow(x, y, p);
                    }
                    let _ = write!(d, "M{} {}", self.num(x), self.num(y));
                }
                PathSegment::LineTo { x, y } => {
                    let (x, y) = apply(t, x, y);
                    cur = (x, y);
                    if let Some(p) = pad {
                        self.grow(x, y, p);
                    }
                    let _ = write!(d, "L{} {}", self.num(x), self.num(y));
                }
                PathSegment::QuadTo { cx, cy, x, y } => {
                    let (cx, cy) = apply(t, cx, cy);
                    let (x, y) = apply(t, x, y);
                    cur = (x, y);
                    if let Some(p) = pad {
                        self.grow(cx, cy, p);
                        self.grow(x, y, p);
                    }
                    let _ = write!(
                        d,
                        "Q{} {} {} {}",
                        self.num(cx),
                        self.num(cy),
                        self.num(x),
                        self.num(y)
                    );
                }
                PathSegment::CubicTo {
                    cx1,
                    cy1,
                    cx2,
                    cy2,
                    x,
                    y,
                } => {
                    let (a, b) = apply(t, cx1, cy1);
                    let (c, e) = apply(t, cx2, cy2);
                    let (x, y) = apply(t, x, y);
                    // A cubic whose handles sit on its ends is a line
                    // (a corner of a native path is written this way).
                    let flat = |p: (f32, f32), q: (f32, f32)| {
                        (p.0 - q.0).abs() < 1e-4 && (p.1 - q.1).abs() < 1e-4
                    };
                    if flat((a, b), cur) && flat((c, e), (x, y)) {
                        if let Some(p) = pad {
                            self.grow(x, y, p);
                        }
                        let _ = write!(d, "L{} {}", self.num(x), self.num(y));
                        cur = (x, y);
                        continue;
                    }
                    cur = (x, y);
                    if let Some(p) = pad {
                        self.grow(a, b, p);
                        self.grow(c, e, p);
                        self.grow(x, y, p);
                    }
                    let _ = write!(
                        d,
                        "C{} {} {} {} {} {}",
                        self.num(a),
                        self.num(b),
                        self.num(c),
                        self.num(e),
                        self.num(x),
                        self.num(y)
                    );
                }
                PathSegment::Close => {
                    d.push('Z');
                    cur = start;
                }
            }
        }
        Some((d, data.fill_rule))
    }

    fn push(&mut self, at: usize, el: String) {
        self.last_fill = None;
        self.items += 1;
        self.stack
            .last_mut()
            .expect("the root frame is never popped")
            .children
            .push((at, el));
    }

    fn open(&mut self, kind: FrameKind, attrs: String) {
        self.last_fill = None;
        self.stack.push(Frame {
            attrs,
            children: Vec::new(),
            kind,
        });
    }

    /// Close the innermost frame if it is `kind`; its element joins its
    /// parent. Returns the closed frame's children as one string when
    /// `as_def` (a mask's artwork).
    fn close(&mut self, at: usize, kind: FrameKind) -> Option<Frame> {
        if self.stack.last().map(|f| f.kind) != Some(kind) || self.stack.len() == 1 {
            self.report.approximated(
                "list.unbalanced",
                "a clip, group or mask that does not close where it opened is closed early",
            );
            return None;
        }
        let _ = at;
        self.stack.pop()
    }

    fn join(&self, children: &[(usize, String)]) -> String {
        let sep = if self.minify { "" } else { "\n" };
        children
            .iter()
            .map(|(_, s)| s.as_str())
            .collect::<Vec<_>>()
            .join(sep)
    }

    fn emit_group(&mut self, at: usize, f: Frame) {
        self.last_fill = None;
        if f.children.is_empty() {
            return;
        }
        let body = self.join(&f.children);
        let nl = if self.minify { "" } else { "\n" };
        let el = format!("<g{}>{nl}{body}{nl}</g>", f.attrs);
        self.stack.last_mut().expect("root").children.push((at, el));
    }

    /// The `fill` / `stroke` value of `paint` for a shape drawn by `t`.
    fn paint(&mut self, paint: &Paint, t: &Transform) -> Option<(String, f32)> {
        let list = self.input.list;
        match paint {
            Paint::Solid(c) => Some((css(*c), c.a)),
            Paint::Cmyk { rgb, .. } => Some((css(*rgb), rgb.a)),
            Paint::LinearGradient(id) => {
                let g = list.linear_gradient(*id)?;
                let (sx, sy) = apply(t, g.start.0, g.start.1);
                let (ex, ey) = apply(t, g.end.0, g.end.1);
                let gid = self.id("g");
                let stops = self.stops(&g.stops);
                let def = format!(
                    "<linearGradient id=\"{gid}\" gradientUnits=\"userSpaceOnUse\" x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\">{stops}</linearGradient>",
                    self.num(sx),
                    self.num(sy),
                    self.num(ex),
                    self.num(ey)
                );
                self.defs.push(def);
                Some((format!("url(#{gid})"), 1.0))
            }
            Paint::RadialGradient(id) => {
                let g = list.radial_gradient(*id)?;
                let (cx, cy) = apply(t, g.center.0, g.center.1);
                let [a, b, c, d, ..] = t.0;
                let r =
                    ((a * g.radius).hypot(b * g.radius) + (c * g.radius).hypot(d * g.radius)) * 0.5;
                let gid = self.id("g");
                let stops = self.stops(&g.stops);
                let def = format!(
                    "<radialGradient id=\"{gid}\" gradientUnits=\"userSpaceOnUse\" cx=\"{}\" cy=\"{}\" r=\"{}\">{stops}</radialGradient>",
                    self.num(cx),
                    self.num(cy),
                    self.num(r)
                );
                self.defs.push(def);
                Some((format!("url(#{gid})"), 1.0))
            }
            Paint::SweepGradient(id) => {
                // SVG has no conic gradient: the ramp's mean colour.
                let g = list.sweep_gradient(*id)?;
                self.report.approximated(
                    "gradient.conic",
                    "a conic (sweep) gradient is written as its mean colour (SVG has no conic gradient)",
                );
                let n = g.stops.len().max(1) as f32;
                let mut m = Color::rgba(0.0, 0.0, 0.0, 0.0);
                for s in &g.stops {
                    m.r += s.color.r / n;
                    m.g += s.color.g / n;
                    m.b += s.color.b / n;
                    m.a += s.color.a / n;
                }
                Some((css(m), m.a))
            }
        }
    }

    fn stops(&self, stops: &[paged_compose::GradientStop]) -> String {
        let mut out = String::new();
        for s in stops {
            let _ = write!(
                out,
                "<stop offset=\"{}\" stop-color=\"{}\"",
                self.num(s.offset.clamp(0.0, 1.0)),
                css(s.color)
            );
            if s.color.a < 1.0 {
                let _ = write!(
                    out,
                    " stop-opacity=\"{}\"",
                    self.num(s.color.a.clamp(0.0, 1.0))
                );
            }
            out.push_str("/>");
        }
        out
    }

    fn stroke_attrs(&self, s: &Stroke) -> String {
        let mut a = format!(" stroke-width=\"{}\"", self.num(s.width));
        match s.cap {
            LineCap::Butt => {}
            LineCap::Round => a.push_str(" stroke-linecap=\"round\""),
            LineCap::Square => a.push_str(" stroke-linecap=\"square\""),
        }
        match s.join {
            LineJoin::Miter => {
                if (s.miter_limit - 4.0).abs() > 1e-3 {
                    let _ = write!(
                        a,
                        " stroke-miterlimit=\"{}\"",
                        self.num(s.miter_limit.max(1.0))
                    );
                }
            }
            LineJoin::Round => a.push_str(" stroke-linejoin=\"round\""),
            LineJoin::Bevel => a.push_str(" stroke-linejoin=\"bevel\""),
        }
        if !s.dash.is_solid() {
            let d: Vec<String> = s.dash.as_slice().iter().map(|v| self.num(*v)).collect();
            let _ = write!(a, " stroke-dasharray=\"{}\"", d.join(" "));
        }
        a
    }

    fn fill_path(
        &mut self,
        at: usize,
        path_id: paged_compose::PathId,
        paint: &Paint,
        t: &Transform,
        blend: Option<BlendMode>,
    ) {
        let Some((d, rule)) = self.d(path_id, t, Some(0.0)) else {
            return;
        };
        let Some((fill, alpha)) = self.paint(paint, t) else {
            return;
        };
        let mut el = format!("<path d=\"{d}\" fill=\"{fill}\"");
        if alpha < 1.0 {
            let _ = write!(el, " fill-opacity=\"{}\"", self.num(alpha.max(0.0)));
        }
        if rule == FillRule::EvenOdd {
            el.push_str(" fill-rule=\"evenodd\"");
        }
        if let Some(m) = blend.and_then(blend_css) {
            let _ = write!(el, " style=\"mix-blend-mode:{m}\"");
        }
        el.push_str("/>");
        self.push(at, el);
        if blend.is_none() {
            self.last_fill = Some((path_id, t.0, self.stack.len()));
        }
    }

    fn stroke_path(
        &mut self,
        at: usize,
        path_id: paged_compose::PathId,
        paint: &Paint,
        s: &Stroke,
        t: &Transform,
    ) {
        let Some((d, _)) = self.d(path_id, t, Some(s.width / 2.0)) else {
            return;
        };
        let Some((stroke, alpha)) = self.paint(paint, t) else {
            return;
        };
        let mut attrs = format!(" stroke=\"{stroke}\"");
        attrs.push_str(&self.stroke_attrs(s));
        if alpha < 1.0 {
            let _ = write!(attrs, " stroke-opacity=\"{}\"", self.num(alpha.max(0.0)));
        }
        // The stroke of the fill just written: one element, as SVG says it.
        if self.last_fill == Some((path_id, t.0, self.stack.len())) {
            if let Some(last) = self.stack.last_mut().and_then(|f| f.children.last_mut()) {
                if let Some(body) = last.1.strip_suffix("/>") {
                    last.1 = format!("{body}{attrs}/>");
                    self.last_fill = None;
                    return;
                }
            }
        }
        let el = format!("<path d=\"{d}\" fill=\"none\"{attrs}/>");
        self.push(at, el);
    }

    fn image(&mut self, at: usize, image_id: paged_compose::ImageId, t: &Transform) {
        let Some(img) = self.input.list.image(image_id) else {
            return;
        };
        if img.width == 0 || img.height == 0 {
            return;
        }
        let enc = img.encoded.as_ref();
        let mime = if enc.starts_with(&[0x89, b'P', b'N', b'G']) {
            Some("image/png")
        } else if enc.starts_with(&[0xff, 0xd8]) {
            Some("image/jpeg")
        } else if enc.starts_with(b"GIF8") {
            Some("image/gif")
        } else if enc.len() > 12 && &enc[0..4] == b"RIFF" && &enc[8..12] == b"WEBP" {
            Some("image/webp")
        } else {
            None
        };
        use base64::Engine as _;
        let (mime, data) = match mime {
            Some(m) => (m, enc.to_vec()),
            None => {
                // TIFF, PSD, a decoded PDF page, …: the pixels as PNG.
                let Some(buf) =
                    image::RgbaImage::from_raw(img.width, img.height, img.rgba.to_vec())
                else {
                    self.report
                        .dropped("image.undecoded", "an image with no pixels is left out");
                    return;
                };
                let mut out = std::io::Cursor::new(Vec::new());
                if buf.write_to(&mut out, image::ImageFormat::Png).is_err() {
                    self.report
                        .dropped("image.undecoded", "an image with no pixels is left out");
                    return;
                }
                ("image/png", out.into_inner())
            }
        };
        for (x, y) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)] {
            let (x, y) = apply(t, x, y);
            self.grow(x, y, 0.0);
        }
        let [a, b, c, d, e, f] = t.0;
        let el = format!(
            "<image width=\"1\" height=\"1\" preserveAspectRatio=\"none\" transform=\"matrix({} {} {} {} {} {})\" href=\"data:{mime};base64,{}\"/>",
            self.num_m(a),
            self.num_m(b),
            self.num_m(c),
            self.num_m(d),
            self.num(e),
            self.num(f),
            base64::engine::general_purpose::STANDARD.encode(&data)
        );
        self.push(at, el);
    }

    /// Engine ADR 1048 — a gradient mesh or freeform gradient. SVG has no
    /// mesh paint (SVG 2's `meshgradient` was dropped), so the shading is
    /// written as a picture of it, rasterised by the engine's one mesh
    /// rasteriser at twice its page scale, and reported as approximated.
    fn mesh(&mut self, at: usize, mesh_id: paged_compose::MeshId, t: &Transform) {
        let Some(mesh) = self.input.list.mesh(mesh_id) else {
            return;
        };
        let [a, b, c, d, _, _] = t.0;
        let scale = a.hypot(b).max(c.hypot(d)).max(1e-3);
        let Some(raster) = paged_compose::mesh_raster(mesh, 2.0 * scale) else {
            return;
        };
        if raster.width == 0 || raster.height == 0 {
            return;
        }
        let Some(buf) =
            image::RgbaImage::from_raw(raster.width, raster.height, raster.rgba.to_vec())
        else {
            return;
        };
        let mut out = std::io::Cursor::new(Vec::new());
        if buf.write_to(&mut out, image::ImageFormat::Png).is_err() {
            return;
        }
        self.report.approximated(
            "mesh.rasterized",
            "a gradient mesh or freeform gradient is written as a picture of it",
        );
        // The unit square → the raster's pixels → the shading's local
        // space → the page.
        let m = t.compose(&raster.to_local).compose(&Transform([
            raster.width as f32,
            0.0,
            0.0,
            raster.height as f32,
            0.0,
            0.0,
        ]));
        for (x, y) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)] {
            let (x, y) = apply(&m, x, y);
            self.grow(x, y, 0.0);
        }
        use base64::Engine as _;
        let [a, b, c, d, e, f] = m.0;
        let el = format!(
            "<image width=\"1\" height=\"1\" preserveAspectRatio=\"none\" transform=\"matrix({} {} {} {} {} {})\" href=\"data:image/png;base64,{}\"/>",
            self.num_m(a),
            self.num_m(b),
            self.num_m(c),
            self.num_m(d),
            self.num(e),
            self.num(f),
            base64::engine::general_purpose::STANDARD.encode(out.into_inner())
        );
        self.push(at, el);
    }

    /// A matrix's linear part needs more places than a coordinate.
    fn num_m(&self, v: f32) -> String {
        let mut s = format!("{:.6}", v);
        while s.ends_with('0') {
            s.pop();
        }
        if s.ends_with('.') {
            s.pop();
        }
        if s == "-0" {
            s = "0".into();
        }
        s
    }

    /// A glyph as `<text>`, when its font and character are known.
    fn glyph_text(
        &mut self,
        at: usize,
        e: &paged_compose::display_list::GlyphRunEntry,
        stroke: Option<&Stroke>,
    ) -> bool {
        let Some(ch) = e.unicode else {
            return false;
        };
        // `font_id` keys the outline cache (the weight mixed in); the
        // face's bytes, and so its name, are under `face_id`.
        let Some(font) = self.input.fonts.font(e.face_id.unwrap_or(e.font_id)) else {
            return false;
        };
        let k = font.units_per_em / e.font_size.max(1e-6);
        let [a, b, c, d, x, y] = e.transform.0;
        let (a, b, c, d) = (a * k, b * k, -c * k, -d * k);
        let Some((paint, alpha)) = self.paint(&e.paint, &e.transform) else {
            return false;
        };
        let mut el = String::from("<text");
        let upright =
            (a - 1.0).abs() < 1e-3 && b.abs() < 1e-3 && c.abs() < 1e-3 && (d - 1.0).abs() < 1e-3;
        if upright {
            let _ = write!(el, " x=\"{}\" y=\"{}\"", self.num(x), self.num(y));
        } else {
            let _ = write!(
                el,
                " transform=\"matrix({} {} {} {} {} {})\"",
                self.num_m(a),
                self.num_m(b),
                self.num_m(c),
                self.num_m(d),
                self.num(x),
                self.num(y)
            );
        }
        let _ = write!(
            el,
            " font-family=\"{}\" font-size=\"{}\"",
            esc(&font.family),
            self.num(e.font_size)
        );
        if let Some(style) = font.style.as_deref() {
            let s = style.to_ascii_lowercase();
            if s.contains("bold") {
                el.push_str(" font-weight=\"bold\"");
            }
            if s.contains("italic") || s.contains("oblique") {
                el.push_str(" font-style=\"italic\"");
            }
        }
        match stroke {
            None => {
                let _ = write!(el, " fill=\"{paint}\"");
                if alpha < 1.0 {
                    let _ = write!(el, " fill-opacity=\"{}\"", self.num(alpha));
                }
            }
            Some(s) => {
                let _ = write!(el, " fill=\"none\" stroke=\"{paint}\"");
                el.push_str(&self.stroke_attrs(s));
            }
        }
        let _ = write!(el, ">{}</text>", esc(&ch.to_string()));
        self.grow(x, y, e.font_size);
        // Merge with the previous glyph when it is the same run on the
        // same baseline: one <text> with its x positions.
        if upright {
            if let Some(last) = self.stack.last_mut().and_then(|f| f.children.last_mut()) {
                if merge_text(&mut last.1, &el) {
                    return true;
                }
            }
        }
        self.push(at, el);
        true
    }

    /// The id of `sf`'s `<symbol>`, writing it into `<defs>` the first
    /// time: the definition's own list walked by a writer of its own (in
    /// the definition's space, so its gradients and clips are too), its
    /// ids drawn from this writer's counter.
    fn symbol_def(&mut self, sf: &paged_compose::SymbolForm) -> String {
        if let Some(id) = self.symbols.get(&sf.key) {
            return id.clone();
        }
        let id = self.id("sym");
        self.symbols.insert(sf.key, id.clone());
        let sub_input = ExportInput {
            list: &sf.list,
            width: sf.bbox[2],
            height: sf.bbox[3],
            fonts: self.input.fonts,
            fit_to_content: false,
        };
        let mut sub = Writer::new(&sub_input, self.text_mode, self.prec, self.minify);
        sub.next_id = self.next_id;
        sub.symbols = std::mem::take(&mut self.symbols);
        sub.walk();
        self.next_id = sub.next_id;
        self.symbols = std::mem::take(&mut sub.symbols);
        let root = sub.stack.pop().expect("root");
        let body = sub.join(&root.children);
        self.defs.append(&mut sub.defs);
        for n in sub.report.notes {
            for _ in 0..n.count {
                self.report.note(&n.code, n.severity, &n.message);
            }
        }
        let nl = if self.minify { "" } else { "\n" };
        self.defs.push(format!(
            "<symbol id=\"{id}\" overflow=\"visible\">{nl}{body}{nl}</symbol>"
        ));
        id
    }

    fn walk(&mut self) {
        let list = self.input.list;
        let mut i = 0usize;
        let mut feather_close: Vec<usize> = Vec::new();
        while i < list.commands.len() {
            let cmd = &list.commands[i];
            if let Some(&end) = self.feather_end.get(&i) {
                self.open(FrameKind::Feather, String::new());
                feather_close.push(end);
            }
            match cmd {
                DisplayCommand::FillPath {
                    path_id,
                    paint,
                    transform,
                } => {
                    let glyph = self.glyphs.get(&(i as u32)).copied();
                    let done = match glyph {
                        Some(e) if self.text_mode == SvgTextMode::Text && !e.is_stroke => {
                            self.glyph_text(i, e, None)
                        }
                        _ => false,
                    };
                    if !done {
                        if glyph.is_some() && self.text_mode == SvgTextMode::Text {
                            self.report.approximated(
                                "text.outlined",
                                "a glyph whose font or character is not known is written as its outline",
                            );
                        }
                        self.fill_path(i, *path_id, paint, transform, None);
                    }
                }
                DisplayCommand::FillPathOverprint {
                    path_id,
                    paint,
                    transform,
                } => {
                    self.report
                        .approximated("overprint", "overprint is written as ordinary paint");
                    self.fill_path(i, *path_id, paint, transform, None);
                }
                DisplayCommand::FillPathBlend {
                    path_id,
                    paint,
                    transform,
                    blend_mode,
                } => self.fill_path(i, *path_id, paint, transform, Some(*blend_mode)),
                DisplayCommand::StrokePath {
                    path_id,
                    paint,
                    stroke,
                    transform,
                }
                | DisplayCommand::StrokePathOverprint {
                    path_id,
                    paint,
                    stroke,
                    transform,
                } => {
                    if matches!(cmd, DisplayCommand::StrokePathOverprint { .. }) {
                        self.report
                            .approximated("overprint", "overprint is written as ordinary paint");
                    }
                    if !stroke.dash.is_solid()
                        && stroke.dash.marks != paged_compose::display_list::StrokeMarks::None
                    {
                        self.report.approximated(
                            "stroke.marks",
                            "a stroke style's marks are written as dashes",
                        );
                    }
                    let glyph = self.glyphs.get(&(i as u32)).copied();
                    let done = match glyph {
                        Some(e) if self.text_mode == SvgTextMode::Text && e.is_stroke => {
                            self.glyph_text(i, e, Some(stroke))
                        }
                        _ => false,
                    };
                    if !done {
                        self.stroke_path(i, *path_id, paint, stroke, transform);
                    }
                }
                DisplayCommand::Image {
                    image_id,
                    transform,
                } => self.image(i, *image_id, transform),
                DisplayCommand::MeshShade {
                    mesh_id, transform, ..
                } => self.mesh(i, *mesh_id, transform),
                DisplayCommand::PushClip { path_id, transform } => {
                    let cid = self.id("c");
                    let mut b = clip_box(self.input.list, *path_id, transform);
                    if let (Some(c), Some(outer)) = (b.as_mut(), self.clip_boxes.last()) {
                        c[0] = c[0].max(outer[0]);
                        c[1] = c[1].max(outer[1]);
                        c[2] = c[2].min(outer[2]);
                        c[3] = c[3].min(outer[3]);
                    }
                    let inherited = self.clip_boxes.last().copied();
                    self.clip_boxes.push(b.or(inherited).unwrap_or([
                        f32::MIN,
                        f32::MIN,
                        f32::MAX,
                        f32::MAX,
                    ]));
                    if let Some((d, rule)) = self.d(*path_id, transform, None) {
                        let rule = if rule == FillRule::EvenOdd {
                            " clip-rule=\"evenodd\""
                        } else {
                            ""
                        };
                        self.defs.push(format!(
                            "<clipPath id=\"{cid}\"><path d=\"{d}\"{rule}/></clipPath>"
                        ));
                    }
                    self.open(FrameKind::Clip, format!(" clip-path=\"url(#{cid})\""));
                }
                DisplayCommand::PopClip(_) => {
                    self.clip_boxes.pop();
                    if let Some(f) = self.close(i, FrameKind::Clip) {
                        self.emit_group(i, f);
                    }
                }
                DisplayCommand::BeginBlendGroup {
                    blend_mode,
                    opacity,
                    isolated,
                    knockout,
                    ..
                } => {
                    let mut attrs = String::new();
                    if *opacity < 1.0 {
                        let _ = write!(attrs, " opacity=\"{}\"", self.num(opacity.max(0.0)));
                    }
                    let mut style = Vec::new();
                    if let Some(m) = blend_css(*blend_mode) {
                        style.push(format!("mix-blend-mode:{m}"));
                    }
                    if *isolated {
                        style.push("isolation:isolate".to_string());
                    }
                    if *knockout {
                        self.report.approximated(
                            "group.knockout",
                            "a knockout group is written as an ordinary group (SVG has no knockout)",
                        );
                    }
                    if !style.is_empty() {
                        let _ = write!(attrs, " style=\"{}\"", style.join(";"));
                    }
                    self.open(FrameKind::Blend, attrs);
                }
                DisplayCommand::EndBlendGroup(_) => {
                    if let Some(f) = self.close(i, FrameKind::Blend) {
                        self.emit_group(i, f);
                    }
                }
                DisplayCommand::PushLayer {
                    effect,
                    blend_mode,
                    opacity,
                    ..
                } => {
                    let mut attrs = String::new();
                    if *opacity < 1.0 {
                        let _ = write!(attrs, " opacity=\"{}\"", self.num(opacity.max(0.0)));
                    }
                    if let Some(m) = blend_css(*blend_mode) {
                        let _ = write!(attrs, " style=\"mix-blend-mode:{m}\"");
                    }
                    let sigma = effect.sigma_pt();
                    if sigma > 0.0 {
                        let fid = self.id("f");
                        self.defs.push(format!(
                            "<filter id=\"{fid}\" x=\"-50%\" y=\"-50%\" width=\"200%\" height=\"200%\"><feGaussianBlur stdDeviation=\"{}\"/></filter>",
                            self.num(sigma)
                        ));
                        let _ = write!(attrs, " filter=\"url(#{fid})\"");
                    }
                    self.open(FrameKind::Layer, attrs);
                }
                DisplayCommand::PopLayer(_) => {
                    if let Some(f) = self.close(i, FrameKind::Layer) {
                        self.emit_group(i, f);
                    }
                }
                DisplayCommand::BeginSoftMask {
                    mask_type, invert, ..
                } => {
                    let mut attrs = format!(
                        " mask-type=\"{}\"",
                        match mask_type {
                            SoftMaskType::Luminosity => "luminance",
                            SoftMaskType::Alpha => "alpha",
                        }
                    );
                    if *invert {
                        self.report.approximated(
                            "mask.invert",
                            "an inverted mask is written with an inverting filter on its artwork; where the artwork paints nothing, the content stays hidden",
                        );
                        let fid = self.id("f");
                        let values = match mask_type {
                            SoftMaskType::Luminosity => {
                                "-1 0 0 0 1 0 -1 0 0 1 0 0 -1 0 1 0 0 0 1 0"
                            }
                            SoftMaskType::Alpha => "1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 -1 1",
                        };
                        self.defs.push(format!(
                            "<filter id=\"{fid}\"><feColorMatrix type=\"matrix\" values=\"{values}\"/></filter>"
                        ));
                        let _ = write!(attrs, " data-invert=\"url(#{fid})\"");
                    }
                    self.open(FrameKind::MaskArtwork, attrs);
                }
                DisplayCommand::BeginMaskedContent(_) => {
                    if let Some(f) = self.close(i, FrameKind::MaskArtwork) {
                        let mid = self.id("m");
                        let body = self.join(&f.children);
                        let (attrs, filter) = match f.attrs.split_once(" data-invert=\"") {
                            Some((a, rest)) => {
                                (a.to_string(), Some(rest.trim_end_matches('"').to_string()))
                            }
                            None => (f.attrs.clone(), None),
                        };
                        let body = match filter {
                            Some(fl) => format!("<g filter=\"{fl}\">{body}</g>"),
                            None => body,
                        };
                        self.defs.push(format!(
                            "<mask id=\"{mid}\"{attrs} maskUnits=\"userSpaceOnUse\" x=\"-100000\" y=\"-100000\" width=\"200000\" height=\"200000\">{body}</mask>"
                        ));
                        // The artwork painted nothing of its own.
                        self.items = self.items.saturating_sub(f.children.len() as u32);
                        self.open(FrameKind::Masked, format!(" mask=\"url(#{mid})\""));
                    }
                }
                DisplayCommand::EndSoftMask(_) => {
                    if let Some(f) = self.close(i, FrameKind::Masked) {
                        self.emit_group(i, f);
                    }
                }
                // Engine ADR 1039 (draw ADR 365) — an instance is a `<use>` of
                // its definition's `<symbol>`, written once; the copy between
                // the markers (what the rasterizers draw) is skipped. A form
                // the list does not hold leaves the copy to be drawn inline.
                DisplayCommand::BeginSymbol { form, transform } => {
                    if let Some(sf) = list.symbol_forms.get(*form as usize) {
                        let id = self.symbol_def(sf);
                        let [x, y, w, h] = sf.bbox;
                        for (px, py) in [(x, y), (x + w, y), (x, y + h), (x + w, y + h)] {
                            let (qx, qy) = apply(transform, px, py);
                            self.grow(qx, qy, 0.0);
                        }
                        let [a, b, c, d, e, f] = transform.0;
                        let m = format!(
                            "matrix({} {} {} {} {} {})",
                            self.num_m(a),
                            self.num_m(b),
                            self.num_m(c),
                            self.num_m(d),
                            self.num(e),
                            self.num(f)
                        );
                        self.push(i, format!("<use xlink:href=\"#{id}\" transform=\"{m}\"/>"));
                        i = symbol_end(&list.commands, i);
                    }
                }
                DisplayCommand::EndSymbol(_) => {}
                DisplayCommand::DropShadow {
                    path_id,
                    transform,
                    shadow,
                }
                | DisplayCommand::PathShadow {
                    path_id,
                    transform,
                    shadow,
                } => {
                    let Some((d, rule)) =
                        self.d(*path_id, transform, Some(shadow.blur_radius.max(0.0) * 2.0))
                    else {
                        i += 1;
                        continue;
                    };
                    let fid = self.id("f");
                    self.defs.push(format!(
                        "<filter id=\"{fid}\" x=\"-50%\" y=\"-50%\" width=\"200%\" height=\"200%\"><feGaussianBlur stdDeviation=\"{}\"/></filter>",
                        self.num((shadow.blur_radius / 2.0).max(0.0))
                    ));
                    let rule = if rule == FillRule::EvenOdd {
                        " fill-rule=\"evenodd\""
                    } else {
                        ""
                    };
                    let mut el = format!(
                        "<path d=\"{d}\"{rule} fill=\"{}\" fill-opacity=\"{}\" transform=\"translate({} {})\" filter=\"url(#{fid})\"",
                        css(shadow.color),
                        self.num((shadow.opacity * shadow.color.a).clamp(0.0, 1.0)),
                        self.num(shadow.offset_x),
                        self.num(shadow.offset_y),
                    );
                    if let Some(m) = blend_css(shadow.blend_mode) {
                        let _ = write!(el, " style=\"mix-blend-mode:{m}\"");
                    }
                    el.push_str("/>");
                    if shadow.spread > 0.0 || shadow.noise > 0.0 {
                        self.report.approximated(
                            "effect.dropShadow",
                            "a drop shadow's spread and noise are not written",
                        );
                    }
                    self.push(i, el);
                }
                DisplayCommand::GradientFeather {
                    path_id,
                    transform,
                    params,
                } => {
                    if let Some(f) = self
                        .stack
                        .last_mut()
                        .filter(|f| f.kind == FrameKind::Feather)
                    {
                        let _ = f;
                        let (sx, sy) = apply(transform, params.start_x, params.start_y);
                        let (ex, ey) = apply(transform, params.end_x, params.end_y);
                        let gid = self.id("g");
                        let mut stops = String::new();
                        for s in &params.stops {
                            let _ = write!(
                                stops,
                                "<stop offset=\"{}\" stop-color=\"#ffffff\" stop-opacity=\"{}\"/>",
                                self.num(s.location.clamp(0.0, 1.0)),
                                self.num(s.alpha.clamp(0.0, 1.0))
                            );
                        }
                        let grad = match params.kind {
                            paged_compose::display_list::GradientFeatherKind::Linear => format!(
                                "<linearGradient id=\"{gid}\" gradientUnits=\"userSpaceOnUse\" x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\">{stops}</linearGradient>",
                                self.num(sx), self.num(sy), self.num(ex), self.num(ey)
                            ),
                            paged_compose::display_list::GradientFeatherKind::Radial => {
                                if (params.radial_aspect - 1.0).abs() > 1e-3 {
                                    self.report.approximated(
                                        "effect.gradientFeather",
                                        "an elliptical radial gradient feather is written as a circle",
                                    );
                                }
                                format!(
                                    "<radialGradient id=\"{gid}\" gradientUnits=\"userSpaceOnUse\" cx=\"{}\" cy=\"{}\" r=\"{}\">{stops}</radialGradient>",
                                    self.num(sx), self.num(sy), self.num((ex - sx).hypot(ey - sy))
                                )
                            }
                        };
                        self.defs.push(grad);
                        let mid = self.id("m");
                        if let Some((d, _)) = self.d(*path_id, transform, None) {
                            self.defs.push(format!(
                                "<mask id=\"{mid}\" maskUnits=\"userSpaceOnUse\" x=\"-100000\" y=\"-100000\" width=\"200000\" height=\"200000\"><path d=\"{d}\" fill=\"url(#{gid})\"/></mask>"
                            ));
                            if let Some(f) = self.stack.last_mut() {
                                let _ = write!(f.attrs, " mask=\"url(#{mid})\"");
                            }
                        }
                    } else {
                        self.report
                            .dropped("effect.gradientFeather", "a gradient feather is left out");
                    }
                }
                DisplayCommand::Feather { .. } | DisplayCommand::DirectionalFeather { .. } => {
                    self.report
                        .dropped("effect.feather", "a feather (soft edge) is left out");
                }
                DisplayCommand::InnerShadow { .. } => self
                    .report
                    .dropped("effect.innerShadow", "an inner shadow is left out"),
                DisplayCommand::OuterGlow { .. } => self
                    .report
                    .dropped("effect.outerGlow", "an outer glow is left out"),
                DisplayCommand::InnerGlow { .. } => self
                    .report
                    .dropped("effect.innerGlow", "an inner glow is left out"),
                DisplayCommand::BevelEmboss { .. } => self
                    .report
                    .dropped("effect.bevel", "a bevel and emboss is left out"),
                DisplayCommand::Satin { .. } => self
                    .report
                    .dropped("effect.satin", "a satin effect is left out"),
                DisplayCommand::BeginFeatheredObject { .. } => {}
            }
            while feather_close.last() == Some(&i) {
                feather_close.pop();
                if let Some(f) = self.close(i, FrameKind::Feather) {
                    self.emit_group(i, f);
                }
            }
            i += 1;
        }
        // Close what the list left open.
        while self.stack.len() > 1 {
            let f = self.stack.pop().expect("len > 1");
            self.report.approximated(
                "list.unbalanced",
                "a clip, group or mask that does not close where it opened is closed early",
            );
            if f.kind != FrameKind::MaskArtwork {
                self.emit_group(list.commands.len(), f);
            }
        }
    }
}

/// The index of the `EndSymbol` that closes the `BeginSymbol` at `start`
/// (the list's last command when it is not closed).
fn symbol_end(commands: &[DisplayCommand], start: usize) -> usize {
    let mut depth = 0usize;
    for (k, c) in commands.iter().enumerate().skip(start) {
        match c {
            DisplayCommand::BeginSymbol { .. } => depth += 1,
            DisplayCommand::EndSymbol(_) => {
                depth -= 1;
                if depth == 0 {
                    return k;
                }
            }
            _ => {}
        }
    }
    commands.len().saturating_sub(1)
}

/// The page-space box of a clip path's points (control points included).
fn clip_box(list: &DisplayList, path_id: paged_compose::PathId, t: &Transform) -> Option<[f32; 4]> {
    let data = list.paths.get(path_id)?;
    let mut b: Option<[f32; 4]> = None;
    let mut add = |x: f32, y: f32| {
        let (x, y) = apply(t, x, y);
        let r = b.get_or_insert([x, y, x, y]);
        r[0] = r[0].min(x);
        r[1] = r[1].min(y);
        r[2] = r[2].max(x);
        r[3] = r[3].max(y);
    };
    for s in &data.segments {
        match *s {
            PathSegment::MoveTo { x, y } | PathSegment::LineTo { x, y } => add(x, y),
            PathSegment::QuadTo { cx, cy, x, y } => {
                add(cx, cy);
                add(x, y);
            }
            PathSegment::CubicTo {
                cx1,
                cy1,
                cx2,
                cy2,
                x,
                y,
            } => {
                add(cx1, cy1);
                add(cx2, cy2);
                add(x, y);
            }
            PathSegment::Close => {}
        }
    }
    b
}

/// Append `next` (a one-glyph upright `<text>`) to `last` when both are
/// the same run on one baseline: `x` grows a position per character.
fn merge_text(last: &mut String, next: &str) -> bool {
    fn split(s: &str) -> Option<(&str, &str, &str, &str)> {
        // <text x="X" y="Y"REST>CH</text>
        let rest = s.strip_prefix("<text x=\"")?;
        let (x, rest) = rest.split_once("\" y=\"")?;
        let (y, rest) = rest.split_once('"')?;
        let (attrs, rest) = rest.split_once('>')?;
        let ch = rest.strip_suffix("</text>")?;
        Some((x, y, attrs, ch))
    }
    let (Some((lx, ly, la, lc)), Some((nx, ny, na, nc))) = (split(last), split(next)) else {
        return false;
    };
    if ly != ny || la != na || nc.contains(' ') && nc.trim().is_empty() {
        return false;
    }
    let merged = format!("<text x=\"{lx} {nx}\" y=\"{ly}\"{la}>{lc}{nc}</text>");
    *last = merged;
    true
}

impl<'a> Writer<'a> {
    fn new(input: &'a ExportInput<'a>, text_mode: SvgTextMode, prec: usize, minify: bool) -> Self {
        let glyphs = input
            .list
            .glyph_runs
            .as_ref()
            .map(|t| t.entries.iter().map(|e| (e.command_index, e)).collect())
            .unwrap_or_default();
        let feather_end = {
            let starts = paged_compose::mask::feather_run_starts(input.list);
            let mut out = HashMap::new();
            for (start, first) in starts {
                let mut end = first;
                let pair = paged_compose::mask::cmd_path_and_transform(&input.list.commands[first])
                    .map(|(p, t)| (p, *t));
                while end + 1 < input.list.commands.len() {
                    let next = &input.list.commands[end + 1];
                    if paged_compose::mask::feather_pad_pt(next).is_some()
                        && paged_compose::mask::cmd_path_and_transform(next).map(|(p, t)| (p, *t))
                            == pair
                    {
                        end += 1;
                    } else {
                        break;
                    }
                }
                out.insert(start, end);
            }
            out
        };
        Writer {
            input,
            text_mode,
            prec,
            defs: Vec::new(),
            stack: vec![Frame {
                attrs: String::new(),
                children: Vec::new(),
                kind: FrameKind::Root,
            }],
            report: SvgReport::default(),
            next_id: 0,
            items: 0,
            glyphs,
            feather_end,
            bounds: None,
            clip_boxes: Vec::new(),
            last_fill: None,
            minify,
            symbols: HashMap::new(),
        }
    }
}

/// Write `input` as an SVG document.
pub fn export_display_list(
    input: &ExportInput<'_>,
    options: &SvgExportOptions,
) -> (String, SvgReport) {
    let minify = options.minify.unwrap_or(false);
    let prec = options
        .precision
        .map(|p| p.min(6) as usize)
        .unwrap_or(if minify { 2 } else { 3 });
    let mut w = Writer::new(input, options.text.unwrap_or_default(), prec, minify);
    w.walk();
    let [x, y, vw, vh] = match options.region {
        Some(r) if r[2] > 0.0 && r[3] > 0.0 => r,
        _ if input.fit_to_content => match w.bounds {
            Some([x0, y0, x1, y1]) if x1 > x0 && y1 > y0 => [x0, y0, x1 - x0, y1 - y0],
            _ => [0.0, 0.0, input.width, input.height],
        },
        _ => [0.0, 0.0, input.width, input.height],
    };
    let nl = if minify { "" } else { "\n" };
    let mut out = String::new();
    let _ = write!(
        out,
        "<svg xmlns=\"http://www.w3.org/2000/svg\"{} width=\"{}pt\" height=\"{}pt\" viewBox=\"{} {} {} {}\">{nl}",
        if w.symbols.is_empty() {
            ""
        } else {
            " xmlns:xlink=\"http://www.w3.org/1999/xlink\""
        },
        w.num(vw),
        w.num(vh),
        w.num(x),
        w.num(y),
        w.num(vw),
        w.num(vh)
    );
    if !w.defs.is_empty() {
        let _ = write!(out, "<defs>{nl}{}{nl}</defs>{nl}", w.defs.join(nl));
    }
    let root = w.stack.pop().expect("root");
    let body = w.join(&root.children);
    if !body.is_empty() {
        out.push_str(&body);
        out.push_str(nl);
    }
    out.push_str("</svg>");
    out.push_str(nl);
    let mut report = w.report;
    report.items = w.items;
    (out, report)
}
