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
    pub diagnostics: Vec<String>,
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
    diagnostics: Vec<String>,
    next: u32,
}

impl Writer<'_> {
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
            Paint::Radial { stops } => (self.gradient("Radial", stops), None),
        }
    }

    fn gradient(&mut self, kind: &'static str, stops: &[(f64, Rgb)]) -> String {
        let refs: Vec<(f64, String)> = stops.iter().map(|(p, c)| (*p, self.color(*c))).collect();
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

    fn transparency(out: &mut String, opacity: f64, shadow: Option<&Shadow>, this: &mut Self) {
        if opacity >= 0.999 && shadow.is_none() {
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
        out.push_str("</TransparencySetting>");
    }

    fn stroke_attrs(&mut self, s: Option<&Stroke>) -> String {
        let Some(s) = s else {
            return r#" StrokeColor="Swatch/None" StrokeWeight="0""#.into();
        };
        let (sw, _) = self.paint(&s.paint);
        let mut a = format!(r#" StrokeColor="{sw}" StrokeWeight="{}""#, n(s.width));
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
                // Detail paths a preset draws stroke-only (fill="none") still
                // belong to the outline; the engine fills every subpath, so
                // they are skipped when the shape has a fill.
                let has_fill = !matches!(fill, Paint::None);
                let paths: Vec<SubPath> = outline
                    .iter()
                    .filter(|s| s.filled || !has_fill)
                    .cloned()
                    .collect();
                if has_fill || stroke.is_some() {
                    let (fc, angle) = self.paint(fill);
                    let sa = self.stroke_attrs(stroke.as_ref());
                    let ga = angle
                        .map(|a| format!(r#" GradientFillAngle="{}""#, n(a)))
                        .unwrap_or_default();
                    let pid = if text.is_some() {
                        format!("{}a", it.id)
                    } else {
                        it.id.clone()
                    };
                    let _ = write!(
                        out,
                        r#"<Polygon Self="{pid}" Name="{}" ItemTransform="{}" FillColor="{fc}"{sa}{ga} AppliedObjectStyle="ObjectStyle/$ID/[None]">"#,
                        esc(&it.name),
                        matrix(&it.transform)
                    );
                    Self::path_geometry(out, &paths);
                    Self::transparency(out, it.opacity, it.shadow.as_ref(), self);
                    out.push_str("</Polygon>");
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
                let _ = write!(
                    out,
                    r#"<Rectangle Self="{}" Name="{}" ItemTransform="{}" FillColor="Swatch/None"{sa} AppliedObjectStyle="ObjectStyle/$ID/[None]" ContentType="GraphicType">"#,
                    it.id,
                    esc(&it.name),
                    matrix(&it.transform)
                );
                Self::path_geometry(out, outline);
                Self::transparency(out, it.opacity, it.shadow.as_ref(), self);
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
    fn table(&mut self, out: &mut String, it: &Item, t: &Table) {
        let story = format!("st{}", it.id);
        let fid = format!("{}t", it.id);
        let _ = write!(
            out,
            r#"<TextFrame Self="{fid}" Name="{}" ParentStory="{story}" PreviousTextFrame="n" NextTextFrame="n" ContentType="TextType" AppliedObjectStyle="ObjectStyle/$ID/[None]" ItemTransform="{}" FillColor="Swatch/None" StrokeColor="Swatch/None" StrokeWeight="0">"#,
            esc(&it.name),
            matrix(&it.transform)
        );
        Self::path_geometry(out, &Self::rect_path(0.0, 0.0, it.w, it.h));
        out.push_str(r#"<TextFramePreference FirstBaselineOffset="AscentOffset" AutoSizingType="HeightOnly" AutoSizingReferencePoint="TopCenterPoint"><Properties><InsetSpacing type="list"><ListItem type="unit">0</ListItem><ListItem type="unit">0</ListItem><ListItem type="unit">0</ListItem><ListItem type="unit">0</ListItem></InsetSpacing></Properties></TextFramePreference></TextFrame>"#);
        let rows = t.rows.len();
        let cols = t.columns.len();
        let tid = format!("{}tb", it.id);
        let mut x = format!(
            r#"<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle"><CharacterStyleRange AppliedCharacterStyle="{NO_CHAR_STYLE}"><Table Self="{tid}" HeaderRowCount="0" FooterRowCount="0" BodyRowCount="{rows}" ColumnCount="{cols}" AppliedTableStyle="TableStyle/$ID/[No table style]">"#
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
                let (fill, _) = self.paint(&cell.fill);
                let _ = write!(
                    x,
                    r#"<Cell Self="{tid}_{c}_{r}" Name="{c}:{r}" RowSpan="{rs}" ColumnSpan="{cs}" FillColor="{fill}""#
                );
                for (edge, b) in ["Left", "Right", "Top", "Bottom"].iter().zip(&cell.borders) {
                    match b {
                        Some(s) => {
                            let (sc, _) = self.paint(&s.paint);
                            let _ = write!(
                                x,
                                r#" {edge}EdgeStrokeColor="{sc}" {edge}EdgeStrokeWeight="{}""#,
                                n(s.width)
                            );
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
        let _ = write!(
            body,
            r#"<Spread Self="s{id}" PageCount="1" BindingLocation="0" ShowMasterItems="{show}" AllowPageShuffle="true" ItemTransform="1 0 0 1 0 0"><Page Self="{id}" Name="{num}" AppliedMaster="{master}" ItemTransform="1 0 0 1 0 0" GeometricBounds="{bounds}" MasterPageTransform="1 0 0 1 0 0"/>"#,
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
    styles.push_str(r#"</RootParagraphStyleGroup><RootObjectStyleGroup Self="u_rosg"><ObjectStyle Self="ObjectStyle/$ID/[None]" Name="$ID/[None]"/></RootObjectStyleGroup>"#);

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
        diagnostics: w.diagnostics,
    })
}
