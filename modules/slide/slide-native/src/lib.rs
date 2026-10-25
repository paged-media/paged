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

//! # slide-native — a resolved deck as a native document
//!
//! The host opens decks with `host.nativeDocument.open` (ADR 700). The deck
//! is built as the engine's own model (`paged_scene::Document`, ADR 708) and
//! packaged by core's one `.paged` writer
//! (`paged_store::package::wrap_document`): one master spread per used
//! layout, one single-page spread per slide, a story per text frame, RGB
//! swatches (theme colours by name), gradients, paragraph styles for list
//! levels (`Body L1` …), and pictures as image blobs.
//!
//! Every page sits at the spread origin with identity transforms, so an
//! item's transform maps its own box straight onto page points — the
//! resolver's transform, as is.
//!
//! Values are kept to the thousandth of a point the deck has always opened
//! with, so a deck opens to the same model it did when it was written as
//! IDML (the equivalence the ADR records).

use std::collections::{BTreeMap, BTreeSet, HashMap};

use paged_model::{
    ArrowheadType, AutoSizingReferencePoint, AutoSizingType, Bounds, CellStyleDef, CharacterRun,
    CharacterStyleDef, ColorEntry, ColorModel, ColorSpace, DesignMap, DocumentPreference,
    DropShadowSetting, FirstBaselineOffset, FrameEffects, FrameRef, GradientEntry,
    GradientFeatherParams, GradientFeatherStop, GradientKind, GradientStopRef, Graphic, Group,
    Justification, ObjectStyleDef, Page, Paragraph, ParagraphStyleDef, PathAnchor, Polygon,
    Rectangle, Spread, SpreadRef, Story, StoryRef, StyleSheet, SwatchEntry, Table as NativeTable,
    TableCell, TableColumn, TableRow, TableStyleDef, TextFrame as NativeFrame,
    VerticalJustification, XmlTag, AUTO_PAGE_NUMBER_MARKER,
};
use paged_scene::{Document, ParsedMasterSpread, ParsedSpread, ParsedStory};
use slide_geom::SubPath;
use slide_resolve::model::*;

/// What a deck became: the `.paged` package, and what the bundle needs
/// beside it.
pub struct Written {
    pub paged: Vec<u8>,
    /// Story id of each text frame, by item id (for the host's metadata).
    pub stories: BTreeMap<String, String>,
    /// The page element each item became, by item id: its wire kind
    /// (`polygon`, `rectangle`, `textFrame`, `group`) and `Self` id. A shape
    /// with both art and text names its polygon.
    pub elements: BTreeMap<String, (&'static str, String)>,
    pub diagnostics: Vec<String>,
}

/// [`Written`] before packaging: the document itself.
pub struct Built {
    pub document: Document,
    pub stories: BTreeMap<String, String>,
    pub elements: BTreeMap<String, (&'static str, String)>,
    pub diagnostics: Vec<String>,
}

/// Gradient feather: type, angle and (location %, alpha) stops.
type Feather = (&'static str, Option<f64>, Vec<(f64, f64)>);

/// A gradient feather for a gradient whose stops differ in alpha: type,
/// angle and (location %, alpha) stops. The engine's gradient swatches
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

/// The width a cell border is drawn with. PowerPoint draws a double
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
/// boundary and moves nothing, so the frame is pulled back by this.
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
#[derive(Default)]
struct GradientPlacement {
    angle: Option<f32>,
    length: Option<f32>,
    start: Option<[f32; 2]>,
}

fn gradient_placement(p: &Paint, w: f64, h: f64) -> GradientPlacement {
    match p {
        // DrawingML angles run clockwise on a y-down page; the engine's
        // gradient angle runs counter-clockwise.
        Paint::Linear { angle, .. } => gradient_span(-angle, w, h),
        Paint::Radial { center, .. } => GradientPlacement {
            angle: None,
            length: Some(n(slide_resolve::model::radial_reach(*center, w, h))),
            start: Some([n(center.0 * w), n(center.1 * h)]),
        },
        _ => GradientPlacement::default(),
    }
}

/// A linear gradient's angle and span: PowerPoint runs it across the box
/// projected on its direction (w·|cos| + h·|sin|), the engine across the
/// diagonal unless told the length.
fn gradient_span(angle: f64, w: f64, h: f64) -> GradientPlacement {
    let (sn, cs) = angle.to_radians().sin_cos();
    GradientPlacement {
        angle: Some(n(angle)),
        length: Some(n(w * cs.abs() + h * sn.abs())),
        start: None,
    }
}

/// The width a `wrap="none"` text frame is widened to.
const UNWRAPPED_WIDTH_PT: f64 = 4000.0;

/// A length or coordinate as the model keeps it: to the thousandth of a
/// point, the precision a deck has always opened with.
fn n(v: f64) -> f32 {
    let r = (v * 1000.0).round() / 1000.0;
    if r == 0.0 {
        0.0
    } else {
        r as f32
    }
}

fn matrix(m: &[f64; 6]) -> [f32; 6] {
    m.map(n)
}

/// The plugin-metadata key a slide's own state lives under on its page.
pub const SLIDE_LABEL_KEY: &str = "x-paged:media.paged.slide";

/// A slide's own state as its page's plugin metadata (the engine's JSON
/// envelope): its layout, speaker notes, the hidden flag and the
/// transition. `None` when the slide has none of them.
pub fn slide_label(s: &SlidePage) -> Option<String> {
    let mut data = serde_json::Map::new();
    // The layout the slide was made from: its master spread's id. A new
    // slide "from this layout" copies a slide that has it.
    // The slide part of the deck it came from: export writes the page back
    // as that slide (a duplicate as a copy of it).
    if !s.part.is_empty() {
        data.insert("part".into(), s.part.clone().into());
    }
    if let Some(m) = &s.master {
        data.insert("layout".into(), m.clone().into());
    }
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

/// The deck's own state as the document's plugin metadata, under
/// [`SLIDE_LABEL_KEY`]: its name, page size and fonts (slide ADR 703). The
/// importer writes it into the package, so opening an imported deck makes
/// no edit (UX audit F-08). Non-ASCII characters are `\uXXXX` escapes, as
/// the bundle's envelope writes them (labels travel through InDesign as
/// XML attribute text).
pub fn deck_label(name: &str, width: f64, height: f64, fonts: &[String]) -> String {
    let text = serde_json::json!({
        "v": 1,
        "data": {
            "deck": {
                "name": name,
                "width": width,
                "height": height,
                "fonts": fonts,
            },
        },
    })
    .to_string();
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            let mut units = [0u16; 2];
            for u in c.encode_utf16(&mut units) {
                out.push_str(&format!("\\u{u:04x}"));
            }
        }
    }
    out
}

/// A placeholder item's metadata: its PowerPoint type and index.
pub fn placeholder_label(it: &Item) -> Option<String> {
    if matches!(it.kind, ItemKind::Group { .. }) {
        return None;
    }
    let (kind, idx) = it.meta.placeholder.as_ref()?;
    Some(
        serde_json::json!({
            "v": 1,
            "data": { "placeholder": { "type": kind, "idx": idx } },
        })
        .to_string(),
    )
}

/// A name as the model keeps it: no control characters, and the white
/// space ones (tab, line feed, carriage return) as spaces.
fn clean_name(s: &str) -> String {
    s.chars()
        .filter_map(|c| match c {
            '\t' | '\n' | '\r' => Some(' '),
            c if (c as u32) < 0x20 => None,
            c => Some(c),
        })
        .collect()
}

/// Run text as the model keeps it: a line break as U+2028, no control
/// characters but tab, and U+2029 as the paragraph break it names.
fn clean_text(s: &str) -> String {
    s.chars()
        .filter_map(|c| match c {
            '\n' | '\r' => Some('\u{2028}'),
            '\u{2029}' => Some('\n'),
            '\t' => Some('\t'),
            c if (c as u32) < 0x20 => None,
            c => Some(c),
        })
        .collect()
}

/// A property value as the model keeps it: no control characters but
/// white space, trimmed.
fn clean_value(s: &str) -> String {
    s.chars()
        .filter(|&c| (c as u32) >= 0x20 || matches!(c, '\t' | '\n' | '\r'))
        .collect::<String>()
        .trim()
        .to_string()
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

const NO_CHAR_STYLE: &str = "CharacterStyle/$ID/[No character style]";
const NO_PARA_STYLE: &str = "ParagraphStyle/$ID/[No paragraph style]";
const NORMAL_PARA_STYLE: &str = "ParagraphStyle/$ID/NormalParagraphStyle";
const NO_OBJECT_STYLE: &str = "ObjectStyle/$ID/[None]";
const NO_CELL_STYLE: &str = "CellStyle/$ID/[None]";
const NO_TABLE_STYLE: &str = "TableStyle/$ID/[No table style]";
const NONE_SWATCH: &str = "Swatch/None";
/// The interchange DOM version the model records. The engine reads it
/// only to report it; it is kept so a deck reads as it did.
const DOM_VERSION: &str = "20.0";

/// A style's colour: none for the None swatch (a style that paints
/// nothing names no colour).
fn swatch(id: String) -> Option<String> {
    (id != NONE_SWATCH).then_some(id)
}

/// A gradient swatch: id, kind, (location %, colour id) stops.
type GradientSwatch = (String, &'static str, Vec<(f64, String)>);

/// The paths of one outline as the model keeps them: the anchors, where
/// each contour after the first starts, which contours are open.
struct Outline {
    anchors: Vec<PathAnchor>,
    starts: Vec<usize>,
    open: Vec<bool>,
}

impl Outline {
    fn of(subpaths: &[SubPath]) -> Outline {
        let mut anchors = Vec::new();
        let mut starts = Vec::new();
        let mut open = Vec::new();
        for sp in subpaths {
            starts.push(anchors.len());
            open.push(!sp.closed);
            for p in &sp.points {
                anchors.push(PathAnchor {
                    anchor: (n(p.anchor.0), n(p.anchor.1)),
                    left: (n(p.left.0), n(p.left.1)),
                    right: (n(p.right.0), n(p.right.1)),
                });
            }
        }
        // A contour start past the last anchor marks nothing; one
        // contour is the canonical empty list (an open one keeps its
        // flag).
        let len = anchors.len();
        let (starts, open): (Vec<usize>, Vec<bool>) = starts
            .into_iter()
            .zip(open)
            .filter(|(s, _)| *s < len)
            .unzip();
        let (starts, open) = if starts.len() <= 1 {
            if open.first().copied().unwrap_or(false) {
                (Vec::new(), vec![true])
            } else {
                (Vec::new(), Vec::new())
            }
        } else {
            (starts, open)
        };
        Outline {
            anchors,
            starts,
            open,
        }
    }

    /// The box of the anchors (handles pull past the curve).
    fn bounds(&self) -> Bounds {
        let (mut l, mut r, mut t, mut b) = (
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::INFINITY,
            f32::NEG_INFINITY,
        );
        for a in &self.anchors {
            let (x, y) = a.anchor;
            if x < l {
                l = x;
            }
            if x > r {
                r = x;
            }
            if y < t {
                t = y;
            }
            if y > b {
                b = y;
            }
        }
        Bounds {
            top: t,
            left: l,
            bottom: b,
            right: r,
        }
    }

    /// One closed contour of four corners on two x and two y values: the
    /// box a rectangle's bounds already describe.
    fn is_plain_box(&self) -> bool {
        let a = &self.anchors;
        if a.len() != 4 || self.starts.len() > 1 || self.open.iter().any(|&o| o) {
            return false;
        }
        let eq = |a: f32, b: f32| (a - b).abs() < 1e-3;
        let corner = |a: &PathAnchor| {
            eq(a.left.0, a.anchor.0)
                && eq(a.left.1, a.anchor.1)
                && eq(a.right.0, a.anchor.0)
                && eq(a.right.1, a.anchor.1)
        };
        if !a.iter().all(corner) {
            return false;
        }
        let mut xs: Vec<f32> = a.iter().map(|a| a.anchor.0).collect();
        let mut ys: Vec<f32> = a.iter().map(|a| a.anchor.1).collect();
        xs.sort_by(f32::total_cmp);
        ys.sort_by(f32::total_cmp);
        eq(xs[0], xs[1]) && eq(xs[2], xs[3]) && eq(ys[0], ys[1]) && eq(ys[2], ys[3])
    }
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

/// A stroke as the model's item fields hold it.
#[derive(Default)]
struct StrokeFields {
    color: Option<String>,
    weight: Option<f32>,
    kind: Option<String>,
    cap: Option<String>,
    join: Option<String>,
    head: Option<ArrowheadType>,
    tail: Option<ArrowheadType>,
}

/// The transparency of an item: opacity, drop shadow, gradient feather.
#[derive(Default)]
struct Transparency {
    opacity: Option<f32>,
    shadow: Option<DropShadowSetting>,
    effects: Option<FrameEffects>,
}

/// The items of one spread, as the model's spread holds them, and the
/// groups being filled.
struct SpreadBuilder {
    spread: Spread,
    /// Open groups, innermost last: their members.
    open_groups: Vec<Vec<FrameRef>>,
}

impl SpreadBuilder {
    fn new(spread: Spread) -> Self {
        SpreadBuilder {
            spread,
            open_groups: Vec::new(),
        }
    }

    /// Place a page item: in the open group, or on the spread in order.
    fn register(&mut self, r: FrameRef) {
        match self.open_groups.last_mut() {
            Some(g) => g.push(r),
            None => self.spread.frames_in_order.push(r),
        }
    }

    fn name(&mut self, id: &str, name: &str) {
        let name = clean_name(name);
        if !name.is_empty() && name != "$ID/" {
            self.spread.item_names.insert(id.to_string(), name);
        }
    }

    fn label(&mut self, id: &str, label: Option<&str>) {
        if let Some(v) = label {
            let entries = self.spread.labels.entry(id.to_string()).or_default();
            match entries.iter_mut().find(|(k, _)| k == SLIDE_LABEL_KEY) {
                Some(slot) => slot.1 = v.to_string(),
                None => entries.push((SLIDE_LABEL_KEY.to_string(), v.to_string())),
            }
        }
    }
}

struct Builder<'a> {
    images: &'a dyn Fn(&str) -> Option<Vec<u8>>,
    colors: BTreeMap<Rgb, String>,
    theme_names: BTreeMap<Rgb, String>,
    gradients: Vec<GradientSwatch>,
    stories: Vec<ParsedStory>,
    story_of: BTreeMap<String, String>,
    para_styles: BTreeSet<String>,
    elements: BTreeMap<String, (&'static str, String)>,
    /// Native table styles, deduplicated by what they say.
    table_styles: Vec<(TableStyleKey, TableStyleDef)>,
    /// Region cell styles: id and fill.
    cell_styles: Vec<(String, String)>,
    diagnostics: Vec<String>,
}

/// What makes two table styles one: name, region cell styles, alternating
/// fills.
type TableStyleKey = (
    String,
    [String; 5],
    Option<(bool, String, String, u32, u32)>,
);

impl Builder<'_> {
    /// Record the element an item became (the first one wins).
    fn element(&mut self, item: &str, kind: &'static str, id: &str) {
        self.elements
            .entry(item.to_string())
            .or_insert_with(|| (kind, id.to_string()));
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

    /// The swatch a paint fills with.
    fn paint(&mut self, p: &Paint) -> String {
        match p {
            Paint::None | Paint::Image { .. } => NONE_SWATCH.into(),
            Paint::Solid { rgb, .. } => self.color(*rgb),
            Paint::Linear { stops, .. } => self.gradient("Linear", stops),
            Paint::Radial { stops, .. } => self.gradient("Radial", stops),
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

    fn transparency(
        &mut self,
        opacity: f64,
        shadow: Option<&Shadow>,
        feather: Option<&Paint>,
    ) -> Transparency {
        let feather = feather.and_then(feather_of);
        let mut t = Transparency::default();
        if opacity >= 0.999 && shadow.is_none() && feather.is_none() {
            return t;
        }
        if opacity < 0.999 {
            t.opacity = Some(n(opacity * 100.0));
        }
        if let Some(s) = shadow {
            t.shadow = Some(DropShadowSetting {
                mode: "Drop".into(),
                x_offset: n(s.dx),
                y_offset: n(s.dy),
                size: n(s.blur / 2.0),
                opacity_pct: n(s.alpha * 100.0),
                effect_color: Some(self.color(s.rgb)),
                blend_mode: None,
                spread_pct: None,
                noise_pct: None,
                knocked_out: None,
                honor_other_effects: None,
                use_global_light: None,
            });
        }
        if let Some((kind, angle, stops)) = feather {
            t.effects = Some(FrameEffects {
                gradient_feather: Some(GradientFeatherParams {
                    gradient_type: Some(kind.into()),
                    start_point: None,
                    end_point: None,
                    angle_deg: angle.map(n),
                    stops: stops
                        .into_iter()
                        .map(|(pos, alpha)| GradientFeatherStop {
                            stop_color: None,
                            location_pct: n(pos),
                            alpha_pct: n(alpha * 100.0),
                            midpoint_pct: 50.0,
                        })
                        .collect(),
                    hilite_angle: None,
                    hilite_length: None,
                }),
                ..FrameEffects::default()
            });
        }
        t
    }

    fn stroke(&mut self, s: Option<&Stroke>) -> StrokeFields {
        let Some(s) = s else {
            return StrokeFields {
                color: Some(NONE_SWATCH.into()),
                weight: Some(0.0),
                ..StrokeFields::default()
            };
        };
        let mut f = StrokeFields {
            color: Some(self.paint(&s.paint)),
            weight: Some(n(s.width)),
            ..StrokeFields::default()
        };
        // One stroke style: a dashed line's dashes win over its compound.
        if let Some(t) = compound_type(s).filter(|_| s.dash.is_none()) {
            f.kind = Some(t.into());
        }
        if let Some(cap) = &s.cap {
            f.cap = Some(
                match cap.as_str() {
                    "rnd" => "RoundEndCap",
                    "sq" => "ProjectingEndCap",
                    _ => "ButtEndCap",
                }
                .into(),
            );
        }
        if let Some(j) = &s.join {
            f.join = Some(
                match j.as_str() {
                    "round" => "RoundEndJoin",
                    "bevel" => "BevelEndJoin",
                    _ => "MiterEndJoin",
                }
                .into(),
            );
        }
        let arrow = |k: &str| match k {
            "triangle" => ArrowheadType::Triangle,
            "arrow" => ArrowheadType::Simple,
            "stealth" => ArrowheadType::Barbed,
            "diamond" => ArrowheadType::Square,
            "oval" => ArrowheadType::CircleSolid,
            _ => ArrowheadType::Triangle,
        };
        f.head = s.head.as_deref().map(arrow);
        f.tail = s.tail.as_deref().map(arrow);
        if s.dash.is_some() {
            f.kind = Some("StrokeStyle/$ID/Dashed".into());
        }
        f
    }

    fn item(&mut self, sb: &mut SpreadBuilder, it: &Item) {
        // A placeholder carries its PowerPoint identity as item metadata, on
        // every element it is written as (outline and text frame): a copied
        // slide knows which of its frames are placeholders.
        let label = placeholder_label(it);
        self.item_body(sb, it, label.as_deref());
    }

    fn item_body(&mut self, sb: &mut SpreadBuilder, it: &Item, label: Option<&str>) {
        match &it.kind {
            ItemKind::Group { children } => {
                self.element(&it.id, "group", &it.id);
                sb.name(&it.id, &it.name);
                sb.open_groups.push(Vec::new());
                for c in children {
                    self.item(sb, c);
                }
                let members = sb.open_groups.pop().unwrap_or_default();
                let idx = sb.spread.groups.len();
                sb.spread.groups.push(Group {
                    self_id: Some(it.id.clone()),
                    members,
                    item_transform: Some([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]),
                    ..Group::default()
                });
                sb.register(FrameRef::Group(idx));
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
                    let fc = self.paint(fill);
                    let sf = self.stroke(stroke.as_ref());
                    let gp = gradient_placement(fill, it.w, it.h);
                    // Item ids are `u` + hex, so derived ids take suffixes
                    // that are not hex digits (`p`, `s`, `t`, `i`).
                    let pid = if text.is_some() {
                        format!("{}p", it.id)
                    } else {
                        it.id.clone()
                    };
                    self.element(&it.id, "polygon", &pid);
                    // A gradient whose stops differ in alpha fades the item:
                    // the fill's, or the stroke's on an unfilled shape.
                    let feather = if has_fill {
                        Some(fill)
                    } else {
                        stroke.as_ref().map(|s| &s.paint)
                    };
                    let tr = self.transparency(it.opacity, it.shadow.as_ref(), feather);
                    self.polygon(sb, it, &pid, Some(fc.clone()), &sf, &gp, &paths, tr, label);
                    let details: Vec<SubPath> = outline
                        .iter()
                        .filter(|s| !s.filled && s.stroked)
                        .cloned()
                        .collect();
                    if has_fill && stroke.is_some() && !details.is_empty() {
                        let sf = self.stroke(stroke.as_ref());
                        let tr = self.transparency(it.opacity, None, None);
                        let sid = format!("{}s", it.id);
                        self.polygon(
                            sb,
                            it,
                            &sid,
                            Some(NONE_SWATCH.into()),
                            &sf,
                            &GradientPlacement::default(),
                            &details,
                            tr,
                            label,
                        );
                    }
                }
                if let Some(tf) = text {
                    self.text_frame(sb, it, tf, label);
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
                let sf = self.stroke(stroke.as_ref());
                self.element(&it.id, "rectangle", &it.id);
                sb.name(&it.id, &it.name);
                let tr = self.transparency(it.opacity, it.shadow.as_ref(), None);
                // The visible part of the image is (l, t)–(1-r, 1-b); stretch it
                // over the frame.
                let (l, t, r, b) = *crop;
                let vis_w = (1.0 - l - r).max(1e-6);
                let vis_h = (1.0 - t - b).max(1e-6);
                let disp_w = it.w / vis_w;
                let disp_h = it.h / vis_h;
                let (iw, ih) = (pw as f64, ph as f64);
                let m = [disp_w / iw, 0.0, 0.0, disp_h / ih, -l * disp_w, -t * disp_h];
                let uri = format!(
                    "file:{}",
                    image_part.rsplit('/').next().unwrap_or(image_part)
                );
                let path = Outline::of(outline);
                sb.label(&it.id, label);
                if path.anchors.is_empty() {
                    // An outline with no point is no item.
                    return;
                }
                let mut rect = Rectangle {
                    item_transform: Some(matrix(&it.transform)),
                    fill_color: Some(NONE_SWATCH.into()),
                    stroke_color: sf.color,
                    stroke_weight: sf.weight,
                    stroke_type: sf.kind,
                    end_cap: sf.cap,
                    end_join: sf.join,
                    applied_object_style: Some(NO_OBJECT_STYLE.into()),
                    has_image_element: true,
                    image_link: Some(uri),
                    image_item_transform: Some(matrix(&m)),
                    image_bytes: Some(bytes),
                    opacity: tr.opacity,
                    drop_shadow: tr.shadow,
                    effects: tr.effects,
                    ..Rectangle::new(it.id.clone(), path.bounds())
                };
                if !path.is_plain_box() {
                    rect.anchors = path.anchors;
                    rect.subpath_starts = path.starts;
                    rect.subpath_open = path.open;
                }
                let idx = sb.spread.rectangles.len();
                sb.spread.rectangles.push(rect);
                sb.register(FrameRef::Rectangle(idx));
            }
            ItemKind::Table(t) => self.table(sb, it, t, label),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn polygon(
        &mut self,
        sb: &mut SpreadBuilder,
        it: &Item,
        id: &str,
        fill: Option<String>,
        sf: &StrokeFields,
        gp: &GradientPlacement,
        paths: &[SubPath],
        tr: Transparency,
        label: Option<&str>,
    ) {
        sb.name(id, &it.name);
        sb.label(id, label);
        let path = Outline::of(paths);
        if path.anchors.is_empty() {
            // An outline with no point is no item.
            return;
        }
        let poly = Polygon {
            item_transform: Some(matrix(&it.transform)),
            fill_color: fill,
            stroke_color: sf.color.clone(),
            stroke_weight: sf.weight,
            stroke_type: sf.kind.clone(),
            end_cap: sf.cap.clone(),
            end_join: sf.join.clone(),
            start_arrow: sf.head.unwrap_or(ArrowheadType::None),
            end_arrow: sf.tail.unwrap_or(ArrowheadType::None),
            gradient_fill_angle: gp.angle,
            gradient_fill_length: gp.length,
            gradient_fill_start: gp.start,
            applied_object_style: Some(NO_OBJECT_STYLE.into()),
            opacity: tr.opacity,
            drop_shadow: tr.shadow,
            effects: tr.effects,
            bounds: path.bounds(),
            anchors: path.anchors,
            subpath_starts: path.starts,
            subpath_open: path.open,
            ..Polygon::new(id.to_string(), Bounds::ZERO)
        };
        let idx = sb.spread.polygons.len();
        sb.spread.polygons.push(poly);
        sb.register(FrameRef::Polygon(idx));
    }

    /// A text frame on `paths`, threading `story`.
    #[allow(clippy::too_many_arguments)]
    fn frame(
        &mut self,
        sb: &mut SpreadBuilder,
        id: &str,
        name: &str,
        story: &str,
        transform: [f32; 6],
        fill: String,
        gp: &GradientPlacement,
        paths: &[SubPath],
        label: Option<&str>,
    ) -> Option<usize> {
        sb.name(id, name);
        sb.label(id, label);
        let path = Outline::of(paths);
        if path.anchors.is_empty() {
            return None;
        }
        let frame = NativeFrame {
            item_transform: Some(transform),
            fill_color: Some(fill),
            stroke_color: Some(NONE_SWATCH.into()),
            stroke_weight: Some(0.0),
            next_text_frame: Some("n".into()),
            applied_object_style: Some(NO_OBJECT_STYLE.into()),
            gradient_fill_angle: gp.angle,
            gradient_fill_length: gp.length,
            gradient_fill_start: gp.start,
            bounds: path.bounds(),
            anchors: path.anchors,
            subpath_starts: path.starts,
            subpath_open: path.open,
            ..NativeFrame::new(id.to_string(), Some(story.to_string()), Bounds::ZERO)
        };
        let idx = sb.spread.text_frames.len();
        sb.spread.text_frames.push(frame);
        sb.register(FrameRef::TextFrame(idx));
        Some(idx)
    }

    /// The native table style for `look` (region cell styles carrying the
    /// fills, and alternating fills at full tint), shared by every table
    /// that looks the same.
    fn table_style(&mut self, look: &TableLook) -> String {
        let mut regions: [String; 5] = Default::default();
        for (k, (paint, tag)) in [
            (&look.header, "header"),
            (&look.footer, "footer"),
            (&look.left, "left"),
            (&look.right, "right"),
            (&look.body, "body"),
        ]
        .into_iter()
        .enumerate()
        {
            regions[k] = if matches!(paint, Paint::None) {
                NO_CELL_STYLE.to_string()
            } else {
                // Regions with the same fill share one cell style.
                let fill = self.paint(paint);
                match self.cell_styles.iter().find(|(_, f)| *f == fill) {
                    Some((id, _)) => id.clone(),
                    None => {
                        let id = format!("CellStyle/{} {tag}", look.name);
                        let id = if self.cell_styles.iter().any(|(i, _)| *i == id) {
                            format!("{id} {}", self.cell_styles.len() + 1)
                        } else {
                            id
                        };
                        self.cell_styles.push((id.clone(), fill));
                        id
                    }
                }
            };
        }
        let alternate = look.alternate.as_ref().map(|a| {
            let (start, end) = (self.paint(&a.start), self.paint(&a.end));
            (a.rows, start, end, a.skip_first, a.skip_last)
        });
        let key: TableStyleKey = (look.name.clone(), regions.clone(), alternate.clone());
        if let Some((_, def)) = self.table_styles.iter().find(|(k, _)| *k == key) {
            return def.self_id.clone();
        }
        let id = format!("TableStyle/{} {}", look.name, self.table_styles.len() + 1);
        let [header, footer, left, right, body] = regions;
        let mut def = TableStyleDef {
            self_id: id.clone(),
            name: Some(look.name.clone()),
            header_region_cell_style: Some(header),
            footer_region_cell_style: Some(footer),
            left_column_region_cell_style: Some(left),
            right_column_region_cell_style: Some(right),
            body_region_cell_style: Some(body),
            ..TableStyleDef::default()
        };
        if let Some((rows, start, end, skip_first, skip_last)) = alternate {
            let (start, end) = (swatch(start), swatch(end));
            if rows {
                def.alternating_fills = Some("AlternatingRows".into());
                def.start_row_fill_color = start;
                def.start_row_fill_count = Some(1);
                def.start_row_fill_tint = Some(100.0);
                def.end_row_fill_color = end;
                def.end_row_fill_count = Some(1);
                def.end_row_fill_tint = Some(100.0);
                def.skip_first_alternating_fill_rows = Some(skip_first);
                def.skip_last_alternating_fill_rows = Some(skip_last);
            } else {
                def.alternating_fills = Some("AlternatingColumns".into());
                def.start_column_fill_color = start;
                def.start_column_fill_count = Some(1);
                def.start_column_fill_tint = Some(100.0);
                def.end_column_fill_color = end;
                def.end_column_fill_count = Some(1);
                def.end_column_fill_tint = Some(100.0);
                def.skip_first_alternating_fill_columns = Some(skip_first);
                def.skip_last_alternating_fill_columns = Some(skip_last);
            }
        }
        self.table_styles.push((key, def));
        id
    }

    /// A table: a text frame at the table's box holding a story with one
    /// paragraph that carries the table.
    fn table(&mut self, sb: &mut SpreadBuilder, it: &Item, t: &Table, label: Option<&str>) {
        let story = format!("st{}", it.id);
        let fid = format!("{}t", it.id);
        self.element(&it.id, "textFrame", &fid);
        // The table style's background (a theme gradient for the themed
        // styles) fills the frame behind the cells.
        let bg = self.paint(&t.background);
        let h: f64 = t.rows.iter().map(|r| r.0).sum();
        let w: f64 = t.columns.iter().sum();
        let gp = gradient_placement(&t.background, w, h);
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
        if let Some(i) = self.frame(
            sb,
            &fid,
            &it.name,
            &story,
            matrix(&shifted),
            bg,
            &gp,
            &rect_path(0.0, 0.0, it.w, it.h),
            label,
        ) {
            let f = &mut sb.spread.text_frames[i];
            f.first_baseline_offset = Some(FirstBaselineOffset::AscentOffset);
            f.auto_sizing = Some(AutoSizingType::HeightOnly);
            f.auto_sizing_reference_point = Some(AutoSizingReferencePoint::TopCenterPoint);
            f.inset_spacing = Some([0.0; 4]);
        }
        let rows = t.rows.len();
        let cols = t.columns.len();
        let tid = format!("{}tb", it.id);
        let (style, header, footer) = match &t.look {
            Some(look) => (
                self.table_style(look),
                look.header_rows as usize,
                look.footer_rows as usize,
            ),
            None => (NO_TABLE_STYLE.to_string(), 0, 0),
        };
        let body = rows.saturating_sub(header + footer);
        let mut table = NativeTable {
            self_id: Some(tid.clone()),
            header_row_count: header as u32,
            footer_row_count: footer as u32,
            body_row_count: body as u32,
            column_count: cols as u32,
            applied_table_style: Some(style),
            ..NativeTable::default()
        };
        for (r, (h, _)) in t.rows.iter().enumerate() {
            table.rows.push(TableRow {
                self_id: Some(format!("{tid}_R{r}")),
                name: Some(r.to_string()),
                single_row_height: Some(n(*h)),
                minimum_height: Some(n(*h)),
                auto_grow: Some(true),
                ..TableRow::default()
            });
        }
        for (c, w) in t.columns.iter().enumerate() {
            table.columns.push(TableColumn {
                self_id: Some(format!("{tid}_C{c}")),
                name: Some(c.to_string()),
                single_column_width: Some(n(*w)),
            });
        }
        // Cells are listed column by column; a spanning cell occupies the
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
                let mut nc = TableCell {
                    self_id: Some(format!("{tid}_{c}_{r}")),
                    name: Some(format!("{c}:{r}")),
                    row_span: rs as u32,
                    column_span: cs as u32,
                    applied_cell_style: Some(NO_CELL_STYLE.into()),
                    text_left_inset: n(il),
                    text_top_inset: n(it_),
                    text_right_inset: n(ir),
                    text_bottom_inset: n(ib),
                    vertical_justification: Some(vj.into()),
                    ..TableCell::default()
                };
                // A fill the table style already paints here is left to it, so
                // the cell keeps following its style.
                if !cell.fill_from_style {
                    nc.fill_color = Some(self.paint(&cell.fill));
                }
                for (edge, b) in cell.borders.iter().enumerate() {
                    let (color, weight, kind) = match b {
                        Some(s) => (
                            Some(self.paint(&s.paint)),
                            Some(n(border_width(s))),
                            compound_type(s).map(str::to_string),
                        ),
                        None => (None, Some(0.0), None),
                    };
                    match edge {
                        0 => {
                            nc.left_edge_stroke_color = color;
                            nc.left_edge_stroke_weight = weight;
                            nc.left_edge_stroke_type = kind;
                        }
                        1 => {
                            nc.right_edge_stroke_color = color;
                            nc.right_edge_stroke_weight = weight;
                            nc.right_edge_stroke_type = kind;
                        }
                        2 => {
                            nc.top_edge_stroke_color = color;
                            nc.top_edge_stroke_weight = weight;
                            nc.top_edge_stroke_type = kind;
                        }
                        _ => {
                            nc.bottom_edge_stroke_color = color;
                            nc.bottom_edge_stroke_weight = weight;
                            nc.bottom_edge_stroke_type = kind;
                        }
                    }
                }
                if let Some(tf) = &cell.text {
                    nc.paragraphs = self.paragraphs(&tf.paragraphs);
                }
                table.cells.push(nc);
            }
        }
        let para = Paragraph {
            paragraph_style: Some(NORMAL_PARA_STYLE.into()),
            table: Some(table),
            table_anchor: Some(0),
            ..Paragraph::default()
        };
        self.story_of.insert(it.id.clone(), story.clone());
        self.stories.push(ParsedStory {
            src: format!("Stories/Story_{story}.xml"),
            self_id: story,
            story: Story {
                paragraphs: vec![para],
                ..Story::default()
            },
        });
    }

    fn text_frame(
        &mut self,
        sb: &mut SpreadBuilder,
        it: &Item,
        tf: &TextFrame,
        label: Option<&str>,
    ) {
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
            (rect_path(cx - hw, cy - hh, cx + hw, cy + hh), mul)
        } else {
            (rect_path(l, t, r, b), it.transform)
        };
        let fid = format!("{}t", it.id);
        self.element(&it.id, "textFrame", &fid);
        if let Some(i) = self.frame(
            sb,
            &fid,
            &it.name,
            &story,
            matrix(&transform),
            NONE_SWATCH.into(),
            &GradientPlacement::default(),
            &paths,
            label,
        ) {
            let f = &mut sb.spread.text_frames[i];
            f.vertical_justification = Some(match tf.anchor.as_str() {
                "middle" => VerticalJustification::Center,
                "bottom" => VerticalJustification::Bottom,
                _ => VerticalJustification::Top,
            });
            // PowerPoint draws text that does not fit past its box; the
            // engine hides overset text. Growing the frame from its
            // anchored edge shows the same lines in the same place (a frame
            // that fits is unchanged in effect: shrinking toward the anchor
            // moves no line).
            f.auto_sizing = Some(AutoSizingType::HeightOnly);
            f.auto_sizing_reference_point = Some(match tf.anchor.as_str() {
                "middle" => AutoSizingReferencePoint::CenterPoint,
                "bottom" => AutoSizingReferencePoint::BottomCenterPoint,
                _ => AutoSizingReferencePoint::TopCenterPoint,
            });
            match first_baseline(tf) {
                Some(v) => {
                    f.first_baseline_offset = Some(FirstBaselineOffset::FixedHeight);
                    f.minimum_first_baseline_offset = Some(n(v));
                }
                None => f.first_baseline_offset = Some(FirstBaselineOffset::AscentOffset),
            }
            if tf.columns > 1 {
                f.column_count = Some(tf.columns);
                f.column_gutter = Some(n(tf.column_gap));
            }
            let (il, it_, ir, ib) = tf.inset;
            f.inset_spacing = Some([n(it_), n(il), n(ib), n(ir)]);
        }
        let paragraphs = self.paragraphs(&tf.paragraphs);
        self.story_of.insert(it.id.clone(), story.clone());
        self.stories.push(ParsedStory {
            src: format!("Stories/Story_{story}.xml"),
            self_id: story,
            story: Story {
                paragraphs,
                ..Story::default()
            },
        });
    }

    fn paragraphs(&mut self, paras: &[Para]) -> Vec<Paragraph> {
        let mut out = Vec::with_capacity(paras.len());
        for p in paras {
            let style = match &p.style {
                Some(name) => {
                    self.para_styles.insert(name.clone());
                    format!("ParagraphStyle/{name}")
                }
                None => NORMAL_PARA_STYLE.to_string(),
            };
            let mut para = Paragraph {
                paragraph_style: Some(style),
                justification: Some(match p.align.as_str() {
                    "ctr" => Justification::CenterAlign,
                    "r" => Justification::RightAlign,
                    "just" => Justification::LeftJustified,
                    "dist" => Justification::FullyJustified,
                    _ => Justification::LeftAlign,
                }),
                left_indent: Some(n(p.margin_left)),
                first_line_indent: Some(n(p.indent)),
                space_before: Some(n(p.space_before)),
                space_after: Some(n(p.space_after)),
                hyphenation: Some(false),
                bullets_list_type: Some(
                    match &p.bullet {
                        Some(Bullet::Char { .. }) => "BulletList",
                        Some(Bullet::Number { .. }) => "NumberedList",
                        None => "NoList",
                    }
                    .into(),
                ),
                ..Paragraph::default()
            };
            if let Some(Bullet::Char { ch, .. }) = &p.bullet {
                para.bullet_character = Some(ch.chars().next().map(|c| c as u32).unwrap_or(0x2022));
            }
            // An empty paragraph's line is its size alone: no run.
            for r in &p.runs {
                let color = self.color(r.rgb);
                let text = if r.line_break {
                    "\u{2028}".to_string()
                } else if r.field.as_deref() == Some("slidenum") {
                    // The page's own number, so it follows the slide when
                    // slides move (and resolves per page on a master).
                    AUTO_PAGE_NUMBER_MARKER.to_string()
                } else {
                    clean_text(&r.text)
                };
                if text.is_empty() {
                    continue;
                }
                let tracking = if r.size > 0.0 {
                    r.tracking / r.size * 1000.0
                } else {
                    0.0
                };
                para.runs.push(CharacterRun {
                    character_style: Some(NO_CHAR_STYLE.into()),
                    font: Some(clean_value(&r.font)).filter(|f| !f.is_empty()),
                    font_style: Some(
                        match (r.bold, r.italic) {
                            (true, true) => "Bold Italic",
                            (true, false) => "Bold",
                            (false, true) => "Italic",
                            _ => "Regular",
                        }
                        .into(),
                    ),
                    point_size: Some(n(r.size)),
                    fill_color: Some(color),
                    underline: r.underline.then_some(true),
                    strikethru: r.strike.then_some(true),
                    capitalization: match r.caps.as_deref() {
                        Some("all") => Some("AllCaps".into()),
                        Some("small") => Some("SmallCaps".into()),
                        _ => None,
                    },
                    tracking: (tracking.abs() > 0.01).then(|| n(tracking)),
                    baseline_shift: (r.baseline.abs() > 0.01)
                        .then(|| n(r.baseline / 100.0 * r.size)),
                    // Leading is a character attribute: a line takes the
                    // largest leading of its runs, so every run carries it.
                    leading: p.leading.map(n),
                    text,
                    ..CharacterRun::default()
                });
            }
            out.push(para);
        }
        out
    }
}

/// Build `deck` as a native document. `images` returns a package part's
/// bytes.
pub fn build(deck: &Deck, images: &dyn Fn(&str) -> Option<Vec<u8>>, name: &str) -> Built {
    let mut w = Builder {
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
    };
    const IDENTITY: [f32; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    let bounds = Bounds {
        top: 0.0,
        left: 0.0,
        bottom: n(deck.height),
        right: n(deck.width),
    };
    let page = |id: String, master: &str, name: String| Page {
        applied_master: Some(master.to_string()),
        item_transform: Some(IDENTITY),
        master_page_transform: Some(IDENTITY),
        name: Some(name),
        ..Page::new(id, bounds)
    };

    let mut master_spreads = HashMap::new();
    let mut master_srcs = Vec::new();
    for m in &deck.masters {
        let mut p = page(format!("{}pg", m.id), "n", m.id.to_uppercase());
        p.show_master_items = Some(true);
        let mut sb = SpreadBuilder::new(Spread {
            self_id: Some(m.id.clone()),
            item_transform: Some(IDENTITY),
            pages: vec![p],
            ..Spread::default()
        });
        for it in &m.items {
            w.item(&mut sb, it);
        }
        let src = format!("MasterSpreads/MasterSpread_{}.xml", m.id);
        master_srcs.push(src.clone());
        let name = clean_name(&m.name);
        master_spreads.insert(
            m.id.clone(),
            ParsedMasterSpread {
                src,
                self_id: m.id.clone(),
                spread: sb.spread,
                name: Some(name),
            },
        );
    }

    let mut spreads = Vec::new();
    for s in &deck.slides {
        let master = s.master.as_deref().unwrap_or("n");
        let mut p = page(s.id.clone(), master, (s.index + 1).to_string());
        p.show_master_items = Some(s.show_master_items);
        let mut sb = SpreadBuilder::new(Spread {
            self_id: Some(format!("s{}", s.id)),
            item_transform: Some(IDENTITY),
            pages: vec![p],
            ..Spread::default()
        });
        // The slide's notes, hidden flag and transition ride its page as
        // plugin metadata, so they move, duplicate and undo with it.
        sb.label(&s.id, slide_label(s).as_deref());
        for it in &s.items {
            w.item(&mut sb, it);
        }
        spreads.push(ParsedSpread {
            src: format!("Spreads/Spread_s{}.xml", s.id),
            spread: sb.spread,
        });
    }

    // Resources (after the items, which registered colours and styles).
    let mut palette = Graphic::default();
    let mut color = |id: &str, name: &str, space: ColorSpace, value: Vec<f32>| {
        palette.colors.insert(
            id.to_string(),
            ColorEntry {
                self_id: id.to_string(),
                name: Some(name.to_string()),
                space,
                value,
                model: ColorModel::Process,
                alternate_space: None,
                alternate_value: Vec::new(),
                tint: None,
                alpha: None,
            },
        );
    };
    color(
        "Color/Black",
        "Black",
        ColorSpace::Cmyk,
        vec![0.0, 0.0, 0.0, 100.0],
    );
    color("Color/Paper", "Paper", ColorSpace::Cmyk, vec![0.0; 4]);
    for (rgb, id) in &w.colors {
        color(
            id,
            id.trim_start_matches("Color/"),
            ColorSpace::Rgb,
            rgb.iter().map(|&c| c as f32).collect(),
        );
    }
    for (id, kind, stops) in &w.gradients {
        palette.gradients.insert(
            id.clone(),
            GradientEntry {
                self_id: id.clone(),
                name: Some(id.trim_start_matches("Gradient/").to_string()),
                kind: if *kind == "Radial" {
                    GradientKind::Radial
                } else {
                    GradientKind::Linear
                },
                stops: stops
                    .iter()
                    .map(|(pos, c)| GradientStopRef {
                        stop_color: c.clone(),
                        location_pct: n(*pos),
                        midpoint_pct: None, opacity_pct: None, inline_color: None, 
                    })
                    .collect(),
            },
        );
    }
    palette.swatches.insert(
        NONE_SWATCH.into(),
        SwatchEntry {
            self_id: NONE_SWATCH.into(),
            name: Some("None".into()),
            color_ref: None,
        },
    );

    let mut styles = StyleSheet::default();
    styles.character_styles.insert(
        NO_CHAR_STYLE.into(),
        CharacterStyleDef {
            self_id: NO_CHAR_STYLE.into(),
            name: Some("$ID/[No character style]".into()),
            ..CharacterStyleDef::default()
        },
    );
    let mut para_style = |id: String, name: String| {
        styles.paragraph_styles.insert(
            id.clone(),
            ParagraphStyleDef {
                self_id: id,
                name: Some(name),
                ..ParagraphStyleDef::default()
            },
        );
    };
    para_style(NO_PARA_STYLE.into(), "$ID/[No paragraph style]".into());
    para_style(NORMAL_PARA_STYLE.into(), "$ID/NormalParagraphStyle".into());
    for s in &w.para_styles {
        para_style(format!("ParagraphStyle/{s}"), s.clone());
    }
    let mut cell_style = |id: &str, name: &str, fill: Option<String>| {
        styles.cell_styles.insert(
            id.to_string(),
            CellStyleDef {
                self_id: id.to_string(),
                name: Some(name.to_string()),
                fill_color: fill,
                ..CellStyleDef::default()
            },
        );
    };
    cell_style(NO_CELL_STYLE, "$ID/[None]", None);
    for (id, fill) in &w.cell_styles {
        cell_style(id, &id["CellStyle/".len()..], swatch(fill.clone()));
    }
    styles.table_styles.insert(
        NO_TABLE_STYLE.into(),
        TableStyleDef {
            self_id: NO_TABLE_STYLE.into(),
            name: Some("$ID/[No table style]".into()),
            ..TableStyleDef::default()
        },
    );
    for (_, def) in w.table_styles.drain(..) {
        styles.table_styles.insert(def.self_id.clone(), def);
    }
    styles.object_styles.insert(
        NO_OBJECT_STYLE.into(),
        ObjectStyleDef {
            self_id: NO_OBJECT_STYLE.into(),
            name: Some("$ID/[None]".into()),
            ..ObjectStyleDef::default()
        },
    );

    let designmap = DesignMap {
        spreads: spreads
            .iter()
            .map(|s| SpreadRef { src: s.src.clone() })
            .collect(),
        stories: w
            .stories
            .iter()
            .map(|s| StoryRef { src: s.src.clone() })
            .collect(),
        master_spreads: master_srcs,
        dom_version: Some(DOM_VERSION.into()),
        document_name: Some(name.to_string()),
        labels: vec![(
            SLIDE_LABEL_KEY.to_string(),
            deck_label(name, deck.width, deck.height, &deck.fonts),
        )],
        document_preference: DocumentPreference {
            page_width: Some(n(deck.width)),
            page_height: Some(n(deck.height)),
            facing_pages: Some(false),
            ..DocumentPreference::default()
        },
        xml_tags: vec![XmlTag {
            self_id: "XMLTag/$ID/Root".into(),
            name: "Root".into(),
            color: None,
        }],
        ..DesignMap::default()
    };

    // The derived caches are not part of the model part; the engine
    // rebuilds them when it opens the package.
    let document = Document {
        designmap,
        palette,
        spreads,
        stories: std::mem::take(&mut w.stories),
        master_spreads,
        frame_for_story: HashMap::new(),
        text_frame_index: HashMap::new(),
        styles,
        anchors: Vec::new(),
    };
    Built {
        document,
        stories: w.story_of,
        elements: w.elements,
        diagnostics: w.diagnostics,
    }
}

/// Build `deck` and package it as `.paged`. `images` returns a package
/// part's bytes.
pub fn write(
    deck: &Deck,
    images: &dyn Fn(&str) -> Option<Vec<u8>>,
    name: &str,
) -> Result<Written, String> {
    let built = build(deck, images, name);
    let paged =
        paged_store::package::wrap_document(&built.document, name, n(deck.width), n(deck.height))
            .map_err(|e| format!("package the deck: {e}"))?;
    Ok(Written {
        paged,
        stories: built.stories,
        elements: built.elements,
        diagnostics: built.diagnostics,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_deck_label_is_an_ascii_envelope_of_the_deck() {
        let label = deck_label("Präsentation 🎉", 960.0, 540.0, &["Calibri".into()]);
        assert!(label.is_ascii(), "{label}");
        assert!(
            label.contains("Pr\\u00e4sentation \\ud83c\\udf89"),
            "{label}"
        );
        let v: serde_json::Value = serde_json::from_str(&label).unwrap();
        assert_eq!(v["v"], 1);
        assert_eq!(v["data"]["deck"]["name"], "Präsentation 🎉");
        assert_eq!(v["data"]["deck"]["width"], 960.0);
        assert_eq!(v["data"]["deck"]["fonts"][0], "Calibri");
    }

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
        let g = gradient_placement(&p, 200.0, 100.0);
        assert_eq!(g.start, Some([50.0, 50.0]));
        assert_eq!(g.length, Some(n((150.0f64 * 150.0 + 50.0 * 50.0).sqrt())));
        assert_eq!(g.angle, None);
    }
}
