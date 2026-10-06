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

//! # slide-idml — a resolved deck as a complete IDML package
//!
//! The host opens decks with `host.nativeDocument.open`, which reads IDML
//! (ADR 700). This writes everything in one package: one master spread per
//! used layout, one single-page spread per slide, a story per text frame,
//! RGB swatches (theme colours by name), gradients, paragraph styles for list
//! levels (`Body L1` …), and pictures as inline image bytes.
//!
//! Every page sits at the spread origin with identity transforms, so an
//! item's `ItemTransform` maps its own box straight onto page points — the
//! resolver's transform, written as is.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::io::{Cursor, Write};

use base64::Engine as _;
use slide_geom::SubPath;
use slide_resolve::model::*;

pub const IDML_MIMETYPE: &str = "application/vnd.adobe.indesign-idml-package";
const PKG_NS: &str = "http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging";
const XML_DECL: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#;
const NO_CHAR_STYLE: &str = "CharacterStyle/$ID/[No character style]";

/// The written package and what did not make it.
pub struct Written {
    pub idml: Vec<u8>,
    /// Story id of each text frame, by item id (for the host's metadata).
    pub stories: BTreeMap<String, String>,
    /// The page element each item became, by item id: its wire kind
    /// (`polygon`, `rectangle`, `textFrame`, `group`) and `Self` id. A shape
    /// with both art and text names its polygon.
    pub elements: BTreeMap<String, (&'static str, String)>,
    pub diagnostics: Vec<String>,
}

/// Gradient feather: type, IDML angle, (location %, alpha) stops.
type Feather = (&'static str, Option<f64>, Vec<(f64, f64)>);

/// A gradient feather for a gradient whose stops differ in alpha: type,
/// IDML angle and (location %, alpha) stops. The engine's gradient swatches
/// carry no alpha, so the fade rides on the item instead.
fn feather_of(p: &Paint) -> Option<Feather> {
    if p.uniform_alpha().is_some() {
        return None;
    }
    let (kind, angle, stops) = match p {
        Paint::Linear { stops, angle } => ("Linear", Some(-angle), stops),
        Paint::Radial { stops, .. } => ("Radial", None, stops),
        _ => return None,
    };
    Some((
        kind,
        angle,
        stops.iter().map(|s| (s.pos, s.alpha)).collect(),
    ))
}

/// Where PowerPoint puts a text frame's first baseline, in pt below the top
/// inset, when the font does not decide it. With a percentage line spacing
/// it is three quarters of the first line's pitch, whatever the font
/// (measured: fixture `baselines`, five fonts × three sizes × four
/// spacings). `None`: the font's ascent places it, as in the engine.
pub fn first_baseline(tf: &TextFrame) -> Option<f64> {
    match tf.paragraphs.first() {
        Some(Para {
            line_percent: Some(_),
            leading: Some(lead),
            ..
        }) => Some(0.75 * lead),
        _ => None,
    }
}

/// The width a cell border is written with. PowerPoint draws a double
/// border wider than its width: two lines and the gap between them each
/// 4/9 of it, centred on the edge (measured: fixture `tablestyles`, 3 pt
/// borders drawn 4 pt across, 288 dpi).
fn border_width(s: &Stroke) -> f64 {
    if s.compound.as_deref() == Some("dbl") {
        s.width * 4.0 / 3.0
    } else {
        s.width
    }
}

/// How far the engine moves a table into its frame: half the widest top
/// border of the first row, half the widest left border of the first
/// column (InDesign's rule). PowerPoint centres borders on the cell
/// boundary and moves nothing, so the writer pulls the frame back by this.
fn table_border_offset(t: &Table) -> (f64, f64) {
    let half = |b: &Option<Stroke>| b.as_ref().map_or(0.0, |s| border_width(s) / 2.0);
    let top = t.rows.first().map_or(0.0, |(_, cells)| {
        cells
            .iter()
            .map(|c| half(&c.borders[2]))
            .fold(0.0, f64::max)
    });
    let left = t
        .rows
        .iter()
        .filter_map(|(_, cells)| cells.first())
        .map(|c| half(&c.borders[0]))
        .fold(0.0, f64::max);
    (left, top)
}

/// The engine stroke style for a compound line: PowerPoint's `dbl` is two
/// equal lines a third of the width apart, InDesign's Thick - Thick; its
/// thick-thin pairs are InDesign's striped pairs. Triple lines are not
/// modelled and draw single.
fn compound_type(s: &Stroke) -> Option<&'static str> {
    match s.compound.as_deref()? {
        "dbl" => Some("StrokeStyle/$ID/ThickThick"),
        "thickThin" => Some("StrokeStyle/$ID/ThickThin"),
        "thinThick" => Some("StrokeStyle/$ID/ThinThick"),
        _ => None,
    }
}

/// A fill gradient's placement on a `w` × `h` item: a linear one's angle
/// and span, a radial one's centre and reach.
fn gradient_attrs(p: &Paint, w: f64, h: f64) -> String {
    match p {
        // DrawingML angles run clockwise on a y-down page; IDML's
        // gradient angle runs counter-clockwise.
        Paint::Linear { angle, .. } => gradient_span(-angle, w, h),
        Paint::Radial { center, .. } => format!(
            r#" GradientFillStart="{} {}" GradientFillLength="{}""#,
            n(center.0 * w),
            n(center.1 * h),
            n(slide_resolve::model::radial_reach(*center, w, h))
        ),
        _ => String::new(),
    }
}

/// A linear gradient's angle and span: PowerPoint runs it across the box
/// projected on its direction (w·|cos| + h·|sin|), the engine across the
/// diagonal unless told the length.
fn gradient_span(angle: f64, w: f64, h: f64) -> String {
    let (sn, cs) = angle.to_radians().sin_cos();
    format!(
        r#" GradientFillAngle="{}" GradientFillLength="{}""#,
        n(angle),
        n(w * cs.abs() + h * sn.abs())
    )
}

/// The width a `wrap="none"` text frame is widened to.
const UNWRAPPED_WIDTH_PT: f64 = 4000.0;

fn n(v: f64) -> String {
    let r = (v * 1000.0).round() / 1000.0;
    if r == 0.0 {
        "0".into()
    } else {
        format!("{r}")
    }
}

/// The plugin-metadata key a slide's own state lives under on its page.
pub const SLIDE_LABEL_KEY: &str = "x-paged:media.paged.slide";

/// A slide's own state as its page's plugin metadata (the engine's JSON
/// envelope): speaker notes, the hidden flag and the transition. `None`
/// when the slide has none of them.
pub fn slide_label(s: &SlidePage) -> Option<String> {
    let mut data = serde_json::Map::new();
    if let Some(n) = s.notes.as_ref().filter(|n| !n.trim().is_empty()) {
        data.insert("notes".into(), n.clone().into());
    }
    if s.hidden {
        data.insert("hidden".into(), true.into());
    }
    if let Some(t) = &s.transition {
        data.insert(
            "transition".into(),
            serde_json::json!({
                "kind": t.kind,
                "dir": t.dir,
                "speed": t.speed,
                "durationMs": t.duration_ms,
                "xml": t.xml,
            }),
        );
    }
    if data.is_empty() {
        return None;
    }
    Some(serde_json::json!({ "v": 1, "data": data }).to_string())
}

/// [`esc`] for an attribute value that must keep its line breaks and tabs:
/// a parser normalises a literal newline in an attribute to a space, a
/// character reference survives.
fn esc_attr(s: &str) -> String {
    esc(s)
        .replace('\n', "&#xA;")
        .replace('\r', "&#xD;")
        .replace('\t', "&#x9;")
}

fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => out.push(c),
        }
    }
    out
}

fn matrix(m: &[f64; 6]) -> String {
    m.iter().map(|v| n(*v)).collect::<Vec<_>>().join(" ")
}

fn pkg(root: &str, body: &str) -> String {
    format!(
        r#"{XML_DECL}<idPkg:{root} xmlns:idPkg="{PKG_NS}" DOMVersion="20.0">{body}</idPkg:{root}>"#
    )
}

/// Pixel size of a PNG, JPEG or GIF.
fn image_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() > 24 && b.starts_with(b"\x89PNG") {
        let w = u32::from_be_bytes(b[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(b[20..24].try_into().ok()?);
        return Some((w, h));
    }
    if b.len() > 10 && (b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a")) {
        return Some((
            u16::from_le_bytes([b[6], b[7]]) as u32,
            u16::from_le_bytes([b[8], b[9]]) as u32,
        ));
    }
    if b.len() > 4 && b[0] == 0xff && b[1] == 0xd8 {
        let mut i = 2;
        while i + 9 < b.len() {
            if b[i] != 0xff {
                i += 1;
                continue;
            }
            let marker = b[i + 1];
            let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
            if (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
                let h = u16::from_be_bytes([b[i + 5], b[i + 6]]) as u32;
                let w = u16::from_be_bytes([b[i + 7], b[i + 8]]) as u32;
                return Some((w, h));
            }
            i += 2 + len;
        }
    }
    None
}

/// A gradient swatch: id, `Linear` / `Radial`, (location %, colour id) stops.
type GradientSwatch = (String, &'static str, Vec<(f64, String)>);

struct Writer<'a> {
    images: &'a dyn Fn(&str) -> Option<Vec<u8>>,
    colors: BTreeMap<Rgb, String>,
    theme_names: BTreeMap<Rgb, String>,
    gradients: Vec<GradientSwatch>,
    stories: Vec<(String, String)>,
    story_of: BTreeMap<String, String>,
    para_styles: BTreeSet<String>,
    elements: BTreeMap<String, (&'static str, String)>,
    /// Native table styles (Self id, XML), deduplicated by their XML.
    table_styles: Vec<(String, String)>,
    /// Region cell styles (Self id, XML).
    cell_styles: Vec<(String, String)>,
    diagnostics: Vec<String>,
    next: u32,
}

impl Writer<'_> {
    /// Record the element an item became (the first one written wins).
    fn element(&mut self, item: &str, kind: &'static str, id: &str) {
        self.elements
            .entry(item.to_string())
            .or_insert_with(|| (kind, id.to_string()));
    }

    fn id(&mut self, prefix: &str) -> String {
        self.next += 1;
        format!("{prefix}{:x}", self.next)
    }

    fn color(&mut self, rgb: Rgb) -> String {
        if let Some(id) = self.colors.get(&rgb) {
            return id.clone();
        }
        let id = match self.theme_names.get(&rgb) {
            Some(name) => format!("Color/{name}"),
            None => format!("Color/R{:02X}{:02X}{:02X}", rgb[0], rgb[1], rgb[2]),
        };
        self.colors.insert(rgb, id.clone());
        id
    }

    /// The swatch reference for a paint, plus a gradient angle.
    fn paint(&mut self, p: &Paint) -> (String, Option<f64>) {
        match p {
            Paint::None | Paint::Image { .. } => ("Swatch/None".into(), None),
            Paint::Solid { rgb, .. } => (self.color(*rgb), None),
            Paint::Linear { stops, angle } => {
                let id = self.gradient("Linear", stops);
                // DrawingML angles run clockwise on a y-down page; IDML's
                // gradient angle runs counter-clockwise.
                (id, Some(-angle))
            }
            Paint::Radial { stops, .. } => (self.gradient("Radial", stops), None),
        }
    }

    fn gradient(&mut self, kind: &'static str, stops: &[Stop]) -> String {
        let refs: Vec<(f64, String)> = stops.iter().map(|s| (s.pos, self.color(s.rgb))).collect();
        if let Some((id, _, _)) = self
            .gradients
            .iter()
            .find(|(_, k, s)| *k == kind && *s == refs)
        {
            return id.clone();
        }
        let id = format!("Gradient/g{}", self.gradients.len() + 1);
        self.gradients.push((id.clone(), kind, refs));
        id
    }

    fn path_geometry(out: &mut String, subpaths: &[SubPath]) {
        out.push_str("<Properties><PathGeometry>");
        for sp in subpaths {
            let _ = write!(
                out,
                r#"<GeometryPathType PathOpen="{}"><PathPointArray>"#,
                if sp.closed { "false" } else { "true" }
            );
            for p in &sp.points {
                let _ = write!(
                    out,
                    r#"<PathPointType Anchor="{} {}" LeftDirection="{} {}" RightDirection="{} {}"/>"#,
                    n(p.anchor.0),
                    n(p.anchor.1),
                    n(p.left.0),
                    n(p.left.1),
                    n(p.right.0),
                    n(p.right.1)
                );
            }
            out.push_str("</PathPointArray></GeometryPathType>");
        }
        out.push_str("</PathGeometry></Properties>");
    }

    fn rect_path(l: f64, t: f64, r: f64, b: f64) -> Vec<SubPath> {
        let c = |x: f64, y: f64| slide_geom::PathPoint {
            anchor: (x, y),
            left: (x, y),
            right: (x, y),
        };
        vec![SubPath {
            points: vec![c(l, t), c(l, b), c(r, b), c(r, t)],
            closed: true,
            filled: true,
            stroked: true,
            fill_mode: None,
        }]
    }

    fn transparency(
        out: &mut String,
        opacity: f64,
        shadow: Option<&Shadow>,
        feather: Option<&Paint>,
        this: &mut Self,
    ) {
        let feather = feather.and_then(feather_of);
        if opacity >= 0.999 && shadow.is_none() && feather.is_none() {
            return;
        }
        out.push_str("<TransparencySetting>");
        if opacity < 0.999 {
            let _ = write!(
                out,
                r#"<BlendingSetting Opacity="{}"/>"#,
                n(opacity * 100.0)
            );
        }
        if let Some(s) = shadow {
            let c = this.color(s.rgb);
            let _ = write!(
                out,
                r#"<DropShadowSetting Mode="Drop" XOffset="{}" YOffset="{}" Size="{}" Opacity="{}" EffectColor="{}"/>"#,
                n(s.dx),
                n(s.dy),
                n(s.blur / 2.0),
                n(s.alpha * 100.0),
                c
            );
        }
        if let Some((kind, angle, stops)) = feather {
            let angle = angle
                .map(|a| format!(r#" Angle="{}""#, n(a)))
                .unwrap_or_default();
            let _ = write!(
                out,
                r#"<GradientFeatherSetting Applied="true" Type="{kind}"{angle}>"#
            );
            for (pos, alpha) in stops {
                let _ = write!(
                    out,
                    r#"<OpacityGradientStop Opacity="{}" Location="{}"/>"#,
                    n(alpha * 100.0),
                    n(pos)
                );
            }
            out.push_str("</GradientFeatherSetting>");
        }
        out.push_str("</TransparencySetting>");
    }

    fn stroke_attrs(&mut self, s: Option<&Stroke>) -> String {
        let Some(s) = s else {
            return r#" StrokeColor="Swatch/None" StrokeWeight="0""#.into();
        };
        let (sw, _) = self.paint(&s.paint);
        let mut a = format!(r#" StrokeColor="{sw}" StrokeWeight="{}""#, n(s.width));
        // One stroke style: a dashed line's dashes win over its compound.
        if let Some(t) = compound_type(s).filter(|_| s.dash.is_none()) {
            let _ = write!(a, r#" StrokeType="{t}""#);
        }
        if let Some(cap) = &s.cap {
            let v = match cap.as_str() {
                "rnd" => "RoundEndCap",
                "sq" => "ProjectingEndCap",
                _ => "ButtEndCap",
            };
            let _ = write!(a, r#" EndCap="{v}""#);
        }
        if let Some(j) = &s.join {
            let v = match j.as_str() {
                "round" => "RoundEndJoin",
                "bevel" => "BevelEndJoin",
                _ => "MiterEndJoin",
            };
            let _ = write!(a, r#" EndJoin="{v}""#);
        }
        let arrow = |k: &str| match k {
            "triangle" => "TriangleArrowHead",
            "arrow" => "SimpleArrowHead",
            "stealth" => "BarbedArrowHead",
            "diamond" => "SquareArrowHead",
            "oval" => "CircleSolidArrowHead",
            _ => "TriangleArrowHead",
        };
        if let Some(h) = &s.head {
            let _ = write!(a, r#" LeftLineEnd="{}""#, arrow(h));
        }
        if let Some(t) = &s.tail {
            let _ = write!(a, r#" RightLineEnd="{}""#, arrow(t));
        }
        if s.dash.is_some() {
            a.push_str(r#" StrokeType="StrokeStyle/$ID/Dashed""#);
        }
        a
    }

    fn item(&mut self, out: &mut String, it: &Item) {
        match &it.kind {
            ItemKind::Group { children } => {
                self.element(&it.id, "group", &it.id);
                let _ = write!(
                    out,
                    r#"<Group Self="{}" ItemTransform="1 0 0 1 0 0" Name="{}">"#,
                    it.id,
                    esc(&it.name)
                );
                for c in children {
                    self.item(out, c);
                }
                out.push_str("</Group>");
            }
            ItemKind::Shape {
                outline,
                fill,
                stroke,
                text,
            } => {
                // Detail paths a preset draws stroke-only (fill="none", a
                // callout's leader) still belong to the outline; the engine
                // fills every subpath, so a filled shape writes them as a
                // second, unfilled polygon above it.
                let has_fill = !matches!(fill, Paint::None);
                let paths: Vec<SubPath> = outline
                    .iter()
                    .filter(|s| s.filled || !has_fill)
                    .cloned()
                    .collect();
                if has_fill || stroke.is_some() {
                    let (fc, _) = self.paint(fill);
                    let sa = self.stroke_attrs(stroke.as_ref());
                    let ga = gradient_attrs(fill, it.w, it.h);
                    // Item ids are `u` + hex, so derived ids take suffixes
                    // that are not hex digits (`p`, `s`, `t`, `i`).
                    let pid = if text.is_some() {
                        format!("{}p", it.id)
                    } else {
                        it.id.clone()
                    };
                    self.element(&it.id, "polygon", &pid);
                    let _ = write!(
                        out,
                        r#"<Polygon Self="{pid}" Name="{}" ItemTransform="{}" FillColor="{fc}"{sa}{ga} AppliedObjectStyle="ObjectStyle/$ID/[None]">"#,
                        esc(&it.name),
                        matrix(&it.transform)
                    );
                    Self::path_geometry(out, &paths);
                    // A gradient whose stops differ in alpha fades the item:
                    // the fill's, or the stroke's on an unfilled shape.
                    let feather = if has_fill {
                        Some(fill)
                    } else {
                        stroke.as_ref().map(|s| &s.paint)
                    };
                    Self::transparency(out, it.opacity, it.shadow.as_ref(), feather, self);
                    out.push_str("</Polygon>");
                    let details: Vec<SubPath> = outline
                        .iter()
                        .filter(|s| !s.filled && s.stroked)
                        .cloned()
                        .collect();
                    if has_fill && stroke.is_some() && !details.is_empty() {
                        let _ = write!(
                            out,
                            r#"<Polygon Self="{}s" Name="{}" ItemTransform="{}" FillColor="Swatch/None"{sa} AppliedObjectStyle="ObjectStyle/$ID/[None]">"#,
                            it.id,
                            esc(&it.name),
                            matrix(&it.transform)
                        );
                        Self::path_geometry(out, &details);
                        Self::transparency(out, it.opacity, None, None, self);
                        out.push_str("</Polygon>");
                    }
                }
                if let Some(tf) = text {
                    self.text_frame(out, it, tf);
                }
            }
            ItemKind::Picture {
                outline,
                stroke,
                image_part,
                crop,
            } => {
                let Some(bytes) = (self.images)(image_part) else {
                    self.diagnostics
                        .push(format!("{image_part}: image bytes missing"));
                    return;
                };
                let Some((pw, ph)) = image_size(&bytes) else {
                    self.diagnostics
                        .push(format!("{image_part}: not PNG / JPEG / GIF, not placed"));
                    return;
                };
                let sa = self.stroke_attrs(stroke.as_ref());
                self.element(&it.id, "rectangle", &it.id);
                let _ = write!(
                    out,
                    r#"<Rectangle Self="{}" Name="{}" ItemTransform="{}" FillColor="Swatch/None"{sa} AppliedObjectStyle="ObjectStyle/$ID/[None]" ContentType="GraphicType">"#,
                    it.id,
                    esc(&it.name),
                    matrix(&it.transform)
                );
                Self::path_geometry(out, outline);
                Self::transparency(out, it.opacity, it.shadow.as_ref(), None, self);
                // The visible part of the image is (l, t)–(1-r, 1-b); stretch it
                // over the frame.
                let (l, t, r, b) = *crop;
                let vis_w = (1.0 - l - r).max(1e-6);
                let vis_h = (1.0 - t - b).max(1e-6);
                let disp_w = it.w / vis_w;
                let disp_h = it.h / vis_h;
                let (iw, ih) = (pw as f64, ph as f64);
                let m = [disp_w / iw, 0.0, 0.0, disp_h / ih, -l * disp_w, -t * disp_h];
                let img_id = format!("{}i", it.id);
                let uri = format!(
                    "file:{}",
                    image_part.rsplit('/').next().unwrap_or(image_part)
                );
                let _ = write!(
                    out,
                    r#"<Image Self="{img_id}" ItemTransform="{}" LinkResourceURI="{}">"#,
                    matrix(&m),
                    esc(&uri)
                );
                let mut geo = String::new();
                Self::path_geometry(&mut geo, &Self::rect_path(0.0, 0.0, iw, ih));
                // Inline bytes ride inside the image's Properties.
                let geo = geo.trim_end_matches("</Properties>").to_string();
                out.push_str(&geo);
                let _ = write!(
                    out,
                    "<Contents><![CDATA[{}]]></Contents></Properties>",
                    base64::engine::general_purpose::STANDARD.encode(&bytes)
                );
                let _ = write!(
                    out,
                    r#"<Link LinkResourceURI="{}"/></Image></Rectangle>"#,
                    esc(&uri)
                );
            }
            ItemKind::Table(t) => self.table(out, it, t),
        }
    }

    /// A table: a text frame at the table's box holding a story with one
    /// paragraph that carries the table.
    /// The native table style for `look` (region cell styles carrying the
    /// fills, and alternating fills at full tint), shared by every table
    /// that looks the same.
    fn table_style(&mut self, look: &TableLook) -> String {
        let mut regions = String::new();
        for (attr, paint, tag) in [
            ("HeaderRegionCellStyle", &look.header, "header"),
            ("FooterRegionCellStyle", &look.footer, "footer"),
            ("LeftColumnRegionCellStyle", &look.left, "left"),
            ("RightColumnRegionCellStyle", &look.right, "right"),
            ("BodyRegionCellStyle", &look.body, "body"),
        ] {
            let id = if matches!(paint, Paint::None) {
                "CellStyle/$ID/[None]".to_string()
            } else {
                // Regions with the same fill share one cell style.
                let fill = self.paint(paint).0;
                let tail = format!(r#" FillColor="{fill}"/>"#);
                match self.cell_styles.iter().find(|(_, x)| x.ends_with(&tail)) {
                    Some((id, _)) => id.clone(),
                    None => {
                        let id = format!("CellStyle/{} {tag}", look.name);
                        let id = if self.cell_styles.iter().any(|(i, _)| *i == id) {
                            format!("{id} {}", self.cell_styles.len() + 1)
                        } else {
                            id
                        };
                        let xml = format!(
                            r#"<CellStyle Self="{}" Name="{}"{tail}"#,
                            esc(&id),
                            esc(&id["CellStyle/".len()..])
                        );
                        self.cell_styles.push((id.clone(), xml));
                        id
                    }
                }
            };
            let _ = write!(regions, r#" {attr}="{}""#, esc(&id));
        }
        let mut alternate = String::new();
        if let Some(a) = &look.alternate {
            let (start, end) = (self.paint(&a.start).0, self.paint(&a.end).0);
            let axis = if a.rows { "Row" } else { "Column" };
            let _ = write!(
                alternate,
                r#" AlternatingFills="Alternating{axis}s" Start{axis}FillColor="{start}" Start{axis}FillCount="1" Start{axis}FillTint="100" End{axis}FillColor="{end}" End{axis}FillCount="1" End{axis}FillTint="100" SkipFirstAlternatingFill{axis}s="{}" SkipLastAlternatingFill{axis}s="{}""#,
                a.skip_first, a.skip_last
            );
        }
        let body = format!(r#"Name="{}"{regions}{alternate}/>"#, esc(&look.name));
        if let Some((id, _)) = self.table_styles.iter().find(|(_, x)| x.ends_with(&body)) {
            return id.clone();
        }
        let id = format!("TableStyle/{} {}", look.name, self.table_styles.len() + 1);
        let xml = format!(r#"<TableStyle Self="{}" {body}"#, esc(&id));
        self.table_styles.push((id.clone(), xml));
        id
    }

    fn table(&mut self, out: &mut String, it: &Item, t: &Table) {
        let story = format!("st{}", it.id);
        let fid = format!("{}t", it.id);
        self.element(&it.id, "textFrame", &fid);
        // The table style's background (a theme gradient for the themed
        // styles) fills the frame behind the cells.
        let (bg, _) = self.paint(&t.background);
        let h: f64 = t.rows.iter().map(|r| r.0).sum();
        let w: f64 = t.columns.iter().sum();
        let bga = gradient_attrs(&t.background, w, h);
        let (dx, dy) = table_border_offset(t);
        let m = &it.transform;
        let shifted = [
            m[0],
            m[1],
            m[2],
            m[3],
            m[4] - m[0] * dx - m[2] * dy,
            m[5] - m[1] * dx - m[3] * dy,
        ];
        let _ = write!(
            out,
            r#"<TextFrame Self="{fid}" Name="{}" ParentStory="{story}" PreviousTextFrame="n" NextTextFrame="n" ContentType="TextType" AppliedObjectStyle="ObjectStyle/$ID/[None]" ItemTransform="{}" FillColor="{bg}"{bga} StrokeColor="Swatch/None" StrokeWeight="0">"#,
            esc(&it.name),
            matrix(&shifted)
        );
        Self::path_geometry(out, &Self::rect_path(0.0, 0.0, it.w, it.h));
        out.push_str(r#"<TextFramePreference FirstBaselineOffset="AscentOffset" AutoSizingType="HeightOnly" AutoSizingReferencePoint="TopCenterPoint"><Properties><InsetSpacing type="list"><ListItem type="unit">0</ListItem><ListItem type="unit">0</ListItem><ListItem type="unit">0</ListItem><ListItem type="unit">0</ListItem></InsetSpacing></Properties></TextFramePreference></TextFrame>"#);
        let rows = t.rows.len();
        let cols = t.columns.len();
        let tid = format!("{}tb", it.id);
        let (style, header, footer) = match &t.look {
            Some(look) => (
                self.table_style(look),
                look.header_rows as usize,
                look.footer_rows as usize,
            ),
            None => ("TableStyle/$ID/[No table style]".to_string(), 0, 0),
        };
        let body = rows.saturating_sub(header + footer);
        let mut x = format!(
            r#"<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle"><CharacterStyleRange AppliedCharacterStyle="{NO_CHAR_STYLE}"><Table Self="{tid}" HeaderRowCount="{header}" FooterRowCount="{footer}" BodyRowCount="{body}" ColumnCount="{cols}" AppliedTableStyle="{}">"#,
            esc(&style)
        );
        for (r, (h, _)) in t.rows.iter().enumerate() {
            let _ = write!(
                x,
                r#"<Row Self="{tid}_R{r}" Name="{r}" SingleRowHeight="{0}" MinimumHeight="{0}" AutoGrow="true"/>"#,
                n(*h)
            );
        }
        for (c, w) in t.columns.iter().enumerate() {
            let _ = write!(
                x,
                r#"<Column Self="{tid}_C{c}" Name="{c}" SingleColumnWidth="{}"/>"#,
                n(*w)
            );
        }
        // IDML lists cells column by column; a spanning cell occupies the
        // slots it covers, and PowerPoint's continuation cells are skipped.
        let mut occupied = vec![false; rows * cols];
        for c in 0..cols {
            for r in 0..rows {
                if occupied[r * cols + c] {
                    continue;
                }
                let Some(cell) = t.rows[r].1.get(c) else {
                    continue;
                };
                let (rs, cs) = (cell.span.0.max(1) as usize, cell.span.1.max(1) as usize);
                for dr in 0..rs {
                    for dc in 0..cs {
                        if r + dr < rows && c + dc < cols {
                            occupied[(r + dr) * cols + c + dc] = true;
                        }
                    }
                }
                // A fill the table style already paints here is left to it, so
                // the cell keeps following its style.
                let fill = if cell.fill_from_style {
                    String::new()
                } else {
                    format!(r#" FillColor="{}""#, self.paint(&cell.fill).0)
                };
                let _ = write!(
                    x,
                    r#"<Cell Self="{tid}_{c}_{r}" Name="{c}:{r}" RowSpan="{rs}" ColumnSpan="{cs}" AppliedCellStyle="CellStyle/$ID/[None]"{fill}"#
                );
                for (edge, b) in ["Left", "Right", "Top", "Bottom"].iter().zip(&cell.borders) {
                    match b {
                        Some(s) => {
                            let (sc, _) = self.paint(&s.paint);
                            let ty = compound_type(s);
                            let w = border_width(s);
                            let _ = write!(
                                x,
                                r#" {edge}EdgeStrokeColor="{sc}" {edge}EdgeStrokeWeight="{}""#,
                                n(w)
                            );
                            if let Some(t) = ty {
                                let _ = write!(x, r#" {edge}EdgeStrokeType="{t}""#);
                            }
                        }
                        None => {
                            let _ = write!(x, r#" {edge}EdgeStrokeWeight="0""#);
                        }
                    }
                }
                let (il, it_, ir, ib) = cell
                    .text
                    .as_ref()
                    .map(|t| t.inset)
                    .unwrap_or((7.2, 3.6, 7.2, 3.6));
                let vj = match cell.text.as_ref().map(|t| t.anchor.as_str()) {
                    Some("middle") => "CenterAlign",
                    Some("bottom") => "BottomAlign",
                    _ => "TopAlign",
                };
                let _ = write!(
                    x,
                    r#" TextLeftInset="{}" TextTopInset="{}" TextRightInset="{}" TextBottomInset="{}" VerticalJustification="{vj}">"#,
                    n(il),
                    n(it_),
                    n(ir),
                    n(ib)
                );
                if let Some(tf) = &cell.text {
                    let paras = self.paragraphs(&tf.paragraphs);
                    x.push_str(&paras);
                }
                x.push_str("</Cell>");
            }
        }
        x.push_str("</Table></CharacterStyleRange></ParagraphStyleRange>");
        self.story_of.insert(it.id.clone(), story.clone());
        self.stories.push((story, x));
    }

    fn text_frame(&mut self, out: &mut String, it: &Item, tf: &TextFrame) {
        let story = format!("st{}", it.id);
        let (mut l, t, mut r, b) = tf.rect;
        // `wrap="none"`: PowerPoint lays each line out unbounded and places
        // it by its alignment against the box. The engine always wraps at
        // the frame width (its HeightAndWidth sizing looks for the narrowest
        // column), so the frame is widened away from the alignment edge
        // instead: no line reaches the far side, and every line keeps its
        // place.
        if !tf.wrap {
            let extra = (UNWRAPPED_WIDTH_PT - (r - l)).max(0.0);
            match tf.paragraphs.first().map(|p| p.align.as_str()) {
                Some("ctr") => {
                    l -= extra / 2.0;
                    r += extra / 2.0;
                }
                Some("r") => l -= extra,
                _ => r += extra,
            }
        }
        // Vertical text (`vert`, `vert270`): the frame is the text rectangle
        // turned a quarter, so lines run along its long side.
        let (paths, transform) = if tf.rotation != 0.0 {
            let (cx, cy) = ((l + r) / 2.0, (t + b) / 2.0);
            let (hw, hh) = ((b - t) / 2.0, (r - l) / 2.0);
            let (sn, cs) = tf.rotation.to_radians().sin_cos();
            let rot = [
                cs,
                sn,
                -sn,
                cs,
                cx - cs * cx + sn * cy,
                cy - sn * cx - cs * cy,
            ];
            let m = &it.transform;
            let mul = [
                m[0] * rot[0] + m[2] * rot[1],
                m[1] * rot[0] + m[3] * rot[1],
                m[0] * rot[2] + m[2] * rot[3],
                m[1] * rot[2] + m[3] * rot[3],
                m[0] * rot[4] + m[2] * rot[5] + m[4],
                m[1] * rot[4] + m[3] * rot[5] + m[5],
            ];
            (Self::rect_path(cx - hw, cy - hh, cx + hw, cy + hh), mul)
        } else {
            (Self::rect_path(l, t, r, b), it.transform)
        };
        let fid = format!("{}t", it.id);
        self.element(&it.id, "textFrame", &fid);
        let _ = write!(
            out,
            r#"<TextFrame Self="{fid}" Name="{}" ParentStory="{story}" PreviousTextFrame="n" NextTextFrame="n" ContentType="TextType" AppliedObjectStyle="ObjectStyle/$ID/[None]" ItemTransform="{}" FillColor="Swatch/None" StrokeColor="Swatch/None" StrokeWeight="0">"#,
            esc(&it.name),
            matrix(&transform)
        );
        Self::path_geometry(out, &paths);
        let vj = match tf.anchor.as_str() {
            "middle" => "CenterAlign",
            "bottom" => "BottomAlign",
            _ => "TopAlign",
        };
        let (il, it_, ir, ib) = tf.inset;
        let cols = if tf.columns > 1 {
            format!(
                r#" TextColumnCount="{}" TextColumnGutter="{}""#,
                tf.columns,
                n(tf.column_gap)
            )
        } else {
            String::new()
        };
        // PowerPoint draws text that does not fit past its box; the engine
        // hides overset text. Growing the frame from its anchored edge shows
        // the same lines in the same place (a frame that fits is unchanged
        // in effect: shrinking toward the anchor moves no line).
        let vertical = match tf.anchor.as_str() {
            "middle" => "Center",
            "bottom" => "Bottom",
            _ => "Top",
        };
        let reference = match vertical {
            "Center" => "CenterPoint".to_string(),
            v => format!("{v}CenterPoint"),
        };
        let sizing = "HeightOnly";
        let first_baseline = match first_baseline(tf) {
            Some(v) => format!(
                r#"FirstBaselineOffset="FixedHeight" MinimumFirstBaselineOffset="{}""#,
                n(v)
            ),
            None => r#"FirstBaselineOffset="AscentOffset""#.to_string(),
        };
        let _ = write!(
            out,
            r#"<TextFramePreference VerticalJustification="{vj}" {first_baseline} AutoSizingType="{sizing}" AutoSizingReferencePoint="{reference}"{cols}><Properties><InsetSpacing type="list"><ListItem type="unit">{}</ListItem><ListItem type="unit">{}</ListItem><ListItem type="unit">{}</ListItem><ListItem type="unit">{}</ListItem></InsetSpacing></Properties></TextFramePreference>"#,
            n(it_),
            n(il),
            n(ib),
            n(ir)
        );
        out.push_str("</TextFrame>");
        let body = self.story(tf);
        self.story_of.insert(it.id.clone(), story.clone());
        self.stories.push((story, body));
    }

    fn story(&mut self, tf: &TextFrame) -> String {
        self.paragraphs(&tf.paragraphs)
    }

    fn paragraphs(&mut self, paras: &[Para]) -> String {
        let mut s = String::new();
        let count = paras.len();
        for (i, p) in paras.iter().enumerate() {
            let style = match &p.style {
                Some(name) => {
                    self.para_styles.insert(name.clone());
                    format!("ParagraphStyle/{}", esc(name))
                }
                None => "ParagraphStyle/$ID/NormalParagraphStyle".to_string(),
            };
            let just = match p.align.as_str() {
                "ctr" => "CenterAlign",
                "r" => "RightAlign",
                "just" => "LeftJustified",
                "dist" => "FullyJustified",
                _ => "LeftAlign",
            };
            let _ = write!(
                s,
                r#"<ParagraphStyleRange AppliedParagraphStyle="{style}" Justification="{just}" LeftIndent="{}" FirstLineIndent="{}" SpaceBefore="{}" SpaceAfter="{}" Hyphenation="false""#,
                n(p.margin_left),
                n(p.indent),
                n(p.space_before),
                n(p.space_after)
            );
            match &p.bullet {
                Some(Bullet::Char { .. }) => {
                    s.push_str(r#" BulletsAndNumberingListType="BulletList""#)
                }
                Some(Bullet::Number { .. }) => {
                    s.push_str(r#" BulletsAndNumberingListType="NumberedList""#)
                }
                None => s.push_str(r#" BulletsAndNumberingListType="NoList""#),
            }
            s.push('>');
            if let Some(Bullet::Char { ch, .. }) = &p.bullet {
                let cp = ch.chars().next().map(|c| c as u32).unwrap_or(0x2022);
                let _ = write!(
                    s,
                    r#"<Properties><BulletChar BulletCharacterType="UnicodeWithFont" BulletCharacterValue="{cp}"/></Properties>"#
                );
            }
            let last = i + 1 == count;
            if p.runs.is_empty() {
                let _ = write!(
                    s,
                    r#"<CharacterStyleRange AppliedCharacterStyle="{NO_CHAR_STYLE}" PointSize="{}">"#,
                    n(p.empty_size)
                );
                if let Some(lead) = p.leading {
                    let _ = write!(
                        s,
                        r#"<Properties><Leading type="unit">{}</Leading></Properties>"#,
                        n(lead)
                    );
                }
                if !last {
                    s.push_str("<Br/>");
                }
                s.push_str("</CharacterStyleRange>");
            }
            for (k, r) in p.runs.iter().enumerate() {
                let color = self.color(r.rgb);
                let style = match (r.bold, r.italic) {
                    (true, true) => "Bold Italic",
                    (true, false) => "Bold",
                    (false, true) => "Italic",
                    _ => "Regular",
                };
                let tracking = if r.size > 0.0 {
                    r.tracking / r.size * 1000.0
                } else {
                    0.0
                };
                let _ = write!(
                    s,
                    r#"<CharacterStyleRange AppliedCharacterStyle="{NO_CHAR_STYLE}" PointSize="{}" FillColor="{color}" FontStyle="{style}""#,
                    n(r.size)
                );
                if r.underline {
                    s.push_str(r#" Underline="true""#);
                }
                if r.strike {
                    s.push_str(r#" StrikeThru="true""#);
                }
                match r.caps.as_deref() {
                    Some("all") => s.push_str(r#" Capitalization="AllCaps""#),
                    Some("small") => s.push_str(r#" Capitalization="SmallCaps""#),
                    _ => {}
                }
                if tracking.abs() > 0.01 {
                    let _ = write!(s, r#" Tracking="{}""#, n(tracking));
                }
                if r.baseline.abs() > 0.01 {
                    let _ = write!(s, r#" BaselineShift="{}""#, n(r.baseline / 100.0 * r.size));
                }
                s.push('>');
                let _ = write!(
                    s,
                    r#"<Properties><AppliedFont type="string">{}</AppliedFont>"#,
                    esc(&r.font)
                );
                // Leading is a character attribute: a line takes the
                // largest leading of its runs, so every run carries it.
                if let Some(lead) = p.leading {
                    let _ = write!(s, r#"<Leading type="unit">{}</Leading>"#, n(lead));
                }
                s.push_str("</Properties>");
                if r.line_break {
                    s.push_str("<Content>\u{2028}</Content>");
                } else if r.field.as_deref() == Some("slidenum") {
                    // The page's own number, so it follows the slide when
                    // slides move (and resolves per page on a master).
                    s.push_str("<Content><?ACE 18?></Content>");
                } else if !r.text.is_empty() {
                    let _ = write!(
                        s,
                        "<Content>{}</Content>",
                        esc(&r.text.replace(['\n', '\r'], "\u{2028}"))
                    );
                }
                if k + 1 == p.runs.len() && !last {
                    s.push_str("<Br/>");
                }
                s.push_str("</CharacterStyleRange>");
            }
            s.push_str("</ParagraphStyleRange>");
        }
        s
    }
}

/// Write `deck` as IDML. `images` returns a package part's bytes.
pub fn write(
    deck: &Deck,
    images: &dyn Fn(&str) -> Option<Vec<u8>>,
    name: &str,
) -> Result<Written, String> {
    let mut w = Writer {
        images,
        colors: BTreeMap::new(),
        theme_names: deck
            .theme_colors
            .iter()
            .map(|(k, c)| (*c, k.clone()))
            .collect(),
        gradients: Vec::new(),
        stories: Vec::new(),
        story_of: BTreeMap::new(),
        para_styles: BTreeSet::new(),
        elements: BTreeMap::new(),
        table_styles: Vec::new(),
        cell_styles: Vec::new(),
        diagnostics: Vec::new(),
        next: 0,
    };
    let _ = w.id("x");
    let bounds = format!("0 0 {} {}", n(deck.height), n(deck.width));
    let mut files: Vec<(String, String)> = Vec::new();

    let mut master_paths = Vec::new();
    for m in &deck.masters {
        let mut body = String::new();
        let _ = write!(
            body,
            r#"<MasterSpread Self="{id}" Name="{name}" NamePrefix="{prefix}" BaseName="{name}" PageCount="1" ShowMasterItems="true" ItemTransform="1 0 0 1 0 0"><Page Self="{id}pg" Name="{prefix}" AppliedMaster="n" ItemTransform="1 0 0 1 0 0" GeometricBounds="{bounds}" MasterPageTransform="1 0 0 1 0 0"/>"#,
            id = m.id,
            name = esc(&m.name),
            prefix = m.id.to_uppercase(),
        );
        for it in &m.items {
            w.item(&mut body, it);
        }
        body.push_str("</MasterSpread>");
        let path = format!("MasterSpreads/MasterSpread_{}.xml", m.id);
        master_paths.push(path.clone());
        files.push((path, pkg("MasterSpread", &body)));
    }

    let mut spread_paths = Vec::new();
    for s in &deck.slides {
        let mut body = String::new();
        let master = s.master.as_deref().unwrap_or("n");
        // The slide's notes, hidden flag and transition ride its page as
        // plugin metadata, so they move, duplicate and undo with it.
        let page_close = match slide_label(s) {
            Some(v) => format!(
                r#"><Properties><Label><KeyValuePair Key="{SLIDE_LABEL_KEY}" Value="{}"/></Label></Properties></Page>"#,
                esc_attr(&v)
            ),
            None => "/>".to_string(),
        };
        let _ = write!(
            body,
            r#"<Spread Self="s{id}" PageCount="1" BindingLocation="0" ShowMasterItems="{show}" AllowPageShuffle="true" ItemTransform="1 0 0 1 0 0"><Page Self="{id}" Name="{num}" AppliedMaster="{master}" ItemTransform="1 0 0 1 0 0" GeometricBounds="{bounds}" MasterPageTransform="1 0 0 1 0 0"{page_close}"#,
            id = s.id,
            num = s.index + 1,
            show = s.show_master_items,
        );
        for it in &s.items {
            w.item(&mut body, it);
        }
        body.push_str("</Spread>");
        let path = format!("Spreads/Spread_s{}.xml", s.id);
        spread_paths.push(path.clone());
        files.push((path, pkg("Spread", &body)));
    }

    // Resources (after the items, which registered colours and styles).
    let mut graphic = String::from(
        r#"<Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" ColorOverride="Specialblack" Name="Black" ColorEditable="false" ColorRemovable="false" Visible="true"/><Color Self="Color/Paper" Model="Process" Space="CMYK" ColorValue="0 0 0 0" ColorOverride="Specialpaper" Name="Paper" ColorEditable="true" ColorRemovable="false" Visible="true"/>"#,
    );
    for (rgb, id) in &w.colors {
        let name = id.trim_start_matches("Color/");
        let _ = write!(
            graphic,
            r#"<Color Self="{id}" Model="Process" Space="RGB" ColorValue="{} {} {}" Name="{name}" ColorEditable="true" ColorRemovable="true" Visible="true"/>"#,
            rgb[0], rgb[1], rgb[2]
        );
    }
    for (id, kind, stops) in &w.gradients {
        let _ = write!(
            graphic,
            r#"<Gradient Self="{id}" Name="{}" Type="{kind}">"#,
            id.trim_start_matches("Gradient/")
        );
        for (pos, c) in stops {
            let _ = write!(
                graphic,
                r#"<GradientStop StopColor="{c}" Location="{}"/>"#,
                n(*pos)
            );
        }
        graphic.push_str("</Gradient>");
    }
    graphic.push_str(r#"<Swatch Self="Swatch/None" Name="None" ColorEditable="false" ColorRemovable="false" Visible="true"/>"#);

    let mut styles = String::from(
        r#"<RootCharacterStyleGroup Self="u_rcsg"><CharacterStyle Self="CharacterStyle/$ID/[No character style]" Name="$ID/[No character style]"/></RootCharacterStyleGroup><RootParagraphStyleGroup Self="u_rpsg"><ParagraphStyle Self="ParagraphStyle/$ID/[No paragraph style]" Name="$ID/[No paragraph style]"/><ParagraphStyle Self="ParagraphStyle/$ID/NormalParagraphStyle" Name="$ID/NormalParagraphStyle"/>"#,
    );
    for s in &w.para_styles {
        let _ = write!(
            styles,
            r#"<ParagraphStyle Self="ParagraphStyle/{0}" Name="{0}"/>"#,
            esc(s)
        );
    }
    styles.push_str(r#"</RootParagraphStyleGroup><RootCellStyleGroup Self="u_rcesg"><CellStyle Self="CellStyle/$ID/[None]" Name="$ID/[None]"/>"#);
    for (_, xml) in &w.cell_styles {
        styles.push_str(xml);
    }
    styles.push_str(r#"</RootCellStyleGroup><RootTableStyleGroup Self="u_rtsg"><TableStyle Self="TableStyle/$ID/[No table style]" Name="$ID/[No table style]"/>"#);
    for (_, xml) in &w.table_styles {
        styles.push_str(xml);
    }
    styles.push_str(r#"</RootTableStyleGroup><RootObjectStyleGroup Self="u_rosg"><ObjectStyle Self="ObjectStyle/$ID/[None]" Name="$ID/[None]"/></RootObjectStyleGroup>"#);

    let story_list: Vec<String> = w.stories.iter().map(|(id, _)| id.clone()).collect();
    for (id, body) in &w.stories {
        files.push((
            format!("Stories/Story_{id}.xml"),
            pkg("Story", &format!(r#"<Story Self="{id}">{body}</Story>"#)),
        ));
    }
    let mut parts = String::from(
        r#"<idPkg:Graphic src="Resources/Graphic.xml"/><idPkg:Fonts src="Resources/Fonts.xml"/><idPkg:Styles src="Resources/Styles.xml"/><idPkg:Preferences src="Resources/Preferences.xml"/><idPkg:Tags src="XML/Tags.xml"/>"#,
    );
    for p in &master_paths {
        let _ = write!(parts, r#"<idPkg:MasterSpread src="{p}"/>"#);
    }
    for p in &spread_paths {
        let _ = write!(parts, r#"<idPkg:Spread src="{p}"/>"#);
    }
    for (id, _) in &w.stories {
        let _ = write!(parts, r#"<idPkg:Story src="Stories/Story_{id}.xml"/>"#);
    }
    parts.push_str(r#"<idPkg:BackingStory src="XML/BackingStory.xml"/>"#);
    let designmap = format!(
        r#"{XML_DECL}<?aid style="50" type="document" readerVersion="6.0" featureSet="257" product="20.0(32)"?><Document xmlns:idPkg="{PKG_NS}" DOMVersion="20.0" Self="d" StoryList="{}" Name="{}">{parts}</Document>"#,
        story_list.join(" "),
        esc(name)
    );
    files.push(("designmap.xml".into(), designmap));
    files.push(("META-INF/container.xml".into(), format!(r#"{XML_DECL}<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="designmap.xml" media-type="text/xml"/></rootfiles></container>"#)));
    files.push(("Resources/Graphic.xml".into(), pkg("Graphic", &graphic)));
    files.push(("Resources/Fonts.xml".into(), pkg("Fonts", "")));
    files.push(("Resources/Styles.xml".into(), pkg("Styles", &styles)));
    files.push((
        "Resources/Preferences.xml".into(),
        pkg("Preferences", &format!(r#"<DocumentPreference PageWidth="{}" PageHeight="{}" FacingPages="false" PagesPerDocument="{}"/>"#, n(deck.width), n(deck.height), deck.slides.len().max(1))),
    ));
    files.push((
        "XML/BackingStory.xml".into(),
        pkg(
            "BackingStory",
            r#"<XmlStory Self="BackingStory" AppliedXMLTag="XMLTag/$ID/Root"/>"#,
        ),
    ));
    files.push((
        "XML/Tags.xml".into(),
        pkg("Tags", r#"<XMLTag Self="XMLTag/$ID/Root" Name="Root"/>"#),
    ));

    let mut out = Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(&mut out);
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let deflated = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("mimetype", stored)
        .map_err(|e| e.to_string())?;
    zip.write_all(IDML_MIMETYPE.as_bytes())
        .map_err(|e| e.to_string())?;
    for (path, xml) in files {
        zip.start_file(path, deflated).map_err(|e| e.to_string())?;
        zip.write_all(xml.as_bytes()).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(Written {
        idml: out.into_inner(),
        stories: w.story_of,
        elements: w.elements,
        diagnostics: w.diagnostics,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stroke(compound: Option<&str>, dash: Option<&str>) -> Stroke {
        Stroke {
            width: 3.0,
            paint: Paint::None,
            dash: dash.map(str::to_string),
            compound: compound.map(str::to_string),
            cap: None,
            join: None,
            head: None,
            tail: None,
        }
    }

    #[test]
    fn compound_lines_map_to_engine_stroke_styles() {
        let t = |c| compound_type(&stroke(Some(c), None));
        assert_eq!(t("dbl"), Some("StrokeStyle/$ID/ThickThick"));
        assert_eq!(t("thickThin"), Some("StrokeStyle/$ID/ThickThin"));
        assert_eq!(t("thinThick"), Some("StrokeStyle/$ID/ThinThick"));
        assert_eq!(t("tri"), None);
        assert_eq!(compound_type(&stroke(None, None)), None);
    }

    #[test]
    fn a_radial_gradient_is_placed_at_its_centre_with_the_farthest_corner_as_reach() {
        let p = Paint::Radial {
            stops: Vec::new(),
            center: (0.25, 0.5),
        };
        // Centre (50, 50) on a 200 × 100 box; farthest corner (200, 0).
        assert_eq!(
            gradient_attrs(&p, 200.0, 100.0),
            format!(
                r#" GradientFillStart="50 50" GradientFillLength="{}""#,
                n((150.0f64 * 150.0 + 50.0 * 50.0).sqrt())
            )
        );
    }
}
