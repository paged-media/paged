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

//! Vector items → native page items (publish ADR 658).
//!
//! The one mapping both of the bundle's ways in write through: opening a
//! PDF as a new document ([`crate::build`]) and placing a page into the
//! open one ([`crate::snippet`]). It takes the page reader's items
//! ([`crate::vectors::ir`]) and the text frames the bundle's text reader
//! recovered ([`crate::ir::TextFrameIr`]), and pushes model items into a
//! [`Spread`] under a placement transform:
//!
//! - a path becomes a `Polygon`: its anchors, every contour's open flag,
//!   the fill rule, the fill and stroke (swatches deduped by colour), the
//!   stroke's cap, join, miter limit and dashes, the fill's and stroke's
//!   own opacity, the item's opacity and blend mode; an axial or radial
//!   ramp becomes a gradient swatch with the ramp's start, angle and
//!   length on the item (`GradientFillStart`/`Angle`/`Length`);
//! - an image becomes a `Rectangle` holding its bytes, its transform the
//!   image's (a rotated or sheared image keeps its placement);
//! - a group becomes a `Group`: a clip group (engine ADR 1010) when it
//!   clips, with its opacity, blend mode and knockout;
//! - a soft mask becomes a native opacity mask (C-28) where the engine's
//!   model can say it — one mask item over graphic items — and is
//!   reported where it cannot;
//! - a text run either places the recovered text frame it belongs to, at
//!   the run's place in the paint order, or — when the host lacks the
//!   font, the text is turned, or no frame claims it — its glyph outlines
//!   as one compound path.

use std::collections::{BTreeMap, HashMap, HashSet};

use kurbo::{Affine, BezPath, Point, Shape, Vec2};
use paged_model::{
    Bounds, CharacterRun, ColorEntry, ColorModel, ColorSpace, FrameRef, GradientEntry,
    GradientKind, GradientStopRef, Graphic, Group, OpacityMask, OpacityMaskType, Paragraph,
    PathAnchor, Polygon, Rectangle, Spread, Story, TargetTransparency, TextFrame,
};
use paged_scene::ParsedStory;

use crate::ir::{RectIr, TextFrameIr};
use crate::vectors::ir::{Contour, GroupItem, ImageItem, Item, MaskIr, Paint, PathItem, TextItem};

pub(crate) const IDENTITY: [f32; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// The document's colours and gradients, deduped: one `Color/pdf_r_g_b`
/// per sRGB colour (stored 0..=255), one `Gradient/pdf_<hash>` per ramp.
pub(crate) struct Palette {
    pub graphic: Graphic,
    seen: HashMap<(u8, u8, u8), String>,
}

impl Palette {
    pub(crate) fn new() -> Self {
        Palette {
            graphic: Graphic::default(),
            seen: HashMap::new(),
        }
    }

    /// sRGB in 0..=1 → a deduped `"Color/pdf_r_g_b"` swatch id.
    pub(crate) fn color_id(&mut self, rgb: [f32; 3]) -> String {
        let key = (to_u8(rgb[0]), to_u8(rgb[1]), to_u8(rgb[2]));
        if let Some(id) = self.seen.get(&key) {
            return id.clone();
        }
        let id = format!("Color/pdf_{}_{}_{}", key.0, key.1, key.2);
        self.graphic.colors.insert(
            id.clone(),
            ColorEntry {
                self_id: id.clone(),
                name: None,
                space: ColorSpace::Rgb,
                value: vec![key.0 as f32, key.1 as f32, key.2 as f32],
                model: ColorModel::Process,
                alternate_space: None,
                alternate_value: Vec::new(),
                tint: None,
                alpha: None,
            },
        );
        self.seen.insert(key, id.clone());
        id
    }

    /// A gradient swatch over `stops` (offset 0..=1, sRGB), deduped by
    /// its kind and stops: the id is a hash of them, so the same ramp
    /// pasted twice names one swatch.
    pub(crate) fn gradient_id(
        &mut self,
        kind: GradientKind,
        stops: &[crate::vectors::ir::Stop],
    ) -> String {
        let mut key = String::from(if kind == GradientKind::Radial {
            "r"
        } else {
            "l"
        });
        for s in stops {
            let [r, g, b] = s.rgb.map(to_u8);
            key.push_str(&format!(";{:.4},{r},{g},{b}", s.offset));
        }
        let id = format!("Gradient/pdf_{:016x}", fnv1a(key.as_bytes()));
        if !self.graphic.gradients.contains_key(&id) {
            let stops = stops
                .iter()
                .map(|s| GradientStopRef {
                    stop_color: self.color_id(s.rgb),
                    location_pct: s.offset * 100.0,
                    midpoint_pct: None,
                })
                .collect();
            self.graphic.gradients.insert(
                id.clone(),
                GradientEntry {
                    self_id: id.clone(),
                    name: None,
                    kind,
                    stops,
                },
            );
        }
        id
    }
}

pub(crate) fn to_u8(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// FNV-1a, 64 bit: a stable, dependency-free name for a ramp.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Monotonic id source — the model only needs unique strings, and a paste
/// re-mints every id anyway.
pub(crate) struct IdGen {
    n: u32,
}

impl IdGen {
    pub(crate) fn new() -> Self {
        IdGen { n: 0 }
    }
    pub(crate) fn id(&mut self, prefix: &str) -> String {
        self.n += 1;
        format!("{prefix}{}", self.n)
    }
}

/// How text runs land.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TextMode {
    /// Editable text frames where the host has the font; outlines where
    /// it does not.
    #[default]
    Frames,
    /// Every run as its glyph outlines.
    Outlines,
}

/// The text frames the bundle's text reader recovered for the page, and
/// what may become of them.
pub struct TextPlan {
    pub frames: Vec<TextFrameIr>,
    /// Font families the host does not have: a frame set in one is drawn
    /// as its outlines where the page's runs carry them.
    pub missing_fonts: HashSet<String>,
    pub mode: TextMode,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FrameState {
    Pending,
    Placed,
    Outlined,
}

/// A polygon's anchors, contour starts, open flags and bounds.
type Geometry = (Vec<PathAnchor>, Vec<usize>, Vec<bool>, Bounds);

/// The state of one lowering.
pub(crate) struct Lowering<'a> {
    pub spread: &'a mut Spread,
    pub stories: &'a mut Vec<ParsedStory>,
    pub palette: &'a mut Palette,
    pub ids: &'a mut IdGen,
    /// PDF page points → target space.
    place: Affine,
    /// The placement's area scale, √|det|: what stroke widths, dash
    /// lengths, radii and font sizes scale by.
    scale: f64,
    /// The placement neither shears nor scales unevenly.
    similar: bool,
    text: TextPlan,
    frame_state: Vec<FrameState>,
    pub losses: BTreeMap<&'static str, u32>,
}

impl<'a> Lowering<'a> {
    pub(crate) fn new(
        spread: &'a mut Spread,
        stories: &'a mut Vec<ParsedStory>,
        palette: &'a mut Palette,
        ids: &'a mut IdGen,
        place: Affine,
        text: TextPlan,
    ) -> Self {
        let [a, b, c, d, ..] = place.as_coeffs();
        let (sx, sy) = (a.hypot(b), c.hypot(d));
        let similar = (sx - sy).abs() <= 1e-6 * sx.max(sy).max(1e-9)
            && (a * c + b * d).abs() <= 1e-6 * sx * sy;
        let frame_state = vec![FrameState::Pending; text.frames.len()];
        Lowering {
            spread,
            stories,
            palette,
            ids,
            place,
            scale: (a * d - b * c).abs().sqrt(),
            similar,
            text,
            frame_state,
            losses: BTreeMap::new(),
        }
    }

    fn loss(&mut self, code: &'static str) {
        *self.losses.entry(code).or_default() += 1;
    }

    /// Lower `items` (paint order) and return the roots they became.
    pub(crate) fn items(&mut self, items: &[Item]) -> Vec<FrameRef> {
        let mut out = Vec::new();
        for item in items {
            if let Some(r) = self.item(item, false) {
                out.push(r);
            }
        }
        out
    }

    /// The recovered frames no run placed: text the page reader saw no
    /// glyphs for (a font it could not load). They go on top, where the
    /// open path always put text.
    pub(crate) fn remaining_text(&mut self) -> Vec<FrameRef> {
        let mut out = Vec::new();
        for k in 0..self.text.frames.len() {
            if self.frame_state[k] != FrameState::Pending {
                continue;
            }
            if self.frame_missing_font(k) {
                self.loss("text.missing_font");
            }
            if let Some(r) = self.text_frame(k) {
                out.push(r);
            }
        }
        out
    }

    fn item(&mut self, item: &Item, in_mask: bool) -> Option<FrameRef> {
        match item {
            Item::Path(p) => self.path(p).map(|p| self.push_polygon(p)),
            Item::Image(i) => self.image(i).map(|r| self.push_rectangle(r)),
            Item::Group(g) => self.group(g, in_mask),
            Item::Text(t) => self.text_item(t, in_mask),
        }
    }

    fn pt(&self, p: [f32; 2]) -> (f32, f32) {
        let q = self.place * Point::new(p[0] as f64, p[1] as f64);
        (q.x as f32, q.y as f32)
    }

    fn polygon_geometry(&self, contours: &[Contour]) -> Option<Geometry> {
        let contours: Vec<&Contour> = contours
            .iter()
            .filter(|c| c.anchors.len() >= 2 || c.closed)
            .collect();
        if contours.is_empty() {
            return None;
        }
        let mut anchors = Vec::new();
        let mut starts = Vec::new();
        let mut opens = Vec::new();
        let mut path = BezPath::new();
        for c in &contours {
            starts.push(anchors.len());
            opens.push(!c.closed);
            let mapped: Vec<PathAnchor> = c
                .anchors
                .iter()
                .map(|a| PathAnchor {
                    anchor: self.pt(a.anchor),
                    left: self.pt(a.left),
                    right: self.pt(a.right),
                })
                .collect();
            append_bez(&mut path, &mapped, c.closed);
            anchors.extend(mapped);
        }
        // The canonical single-contour form the reader and the renderer
        // agree on: no explicit starts; a closed one no open flags either.
        if contours.len() == 1 {
            starts.clear();
            if !opens[0] {
                opens.clear();
            }
        } else if opens.iter().all(|o| !o) {
            opens.clear();
        }
        let bb = path.bounding_box();
        let bounds = Bounds {
            top: bb.y0 as f32,
            left: bb.x0 as f32,
            bottom: bb.y1 as f32,
            right: bb.x1 as f32,
        };
        Some((anchors, starts, opens, bounds))
    }

    fn path(&mut self, p: &PathItem) -> Option<Polygon> {
        let (anchors, starts, opens, bounds) = self.polygon_geometry(&p.contours)?;
        let id = self.ids.id("pdfv");
        let mut poly = Polygon {
            item_transform: Some(IDENTITY),
            anchors,
            subpath_starts: starts,
            subpath_open: opens,
            fill_rule: if p.fill_rule == "evenodd" {
                paged_model::FillRule::EvenOdd
            } else {
                paged_model::FillRule::NonZero
            },
            ..Polygon::new(id, bounds)
        };
        if let Some(fill) = &p.fill {
            self.fill(&mut poly, fill);
        }
        if let Some(s) = &p.stroke {
            let rgb = match &s.paint {
                Paint::Solid { rgb, .. } => *rgb,
                Paint::Linear { stops, .. } | Paint::Radial { stops, .. } => {
                    self.loss("stroke.gradient");
                    stops.first().map_or([0.0; 3], |s| s.rgb)
                }
            };
            poly.stroke_color = Some(self.palette.color_id(rgb));
            poly.stroke_weight = Some((s.width as f64 * self.scale) as f32);
            poly.end_cap = Some(
                match s.cap {
                    "round" => "RoundEndCap",
                    "square" => "ProjectingEndCap",
                    _ => "ButtEndCap",
                }
                .to_string(),
            );
            poly.end_join = Some(
                match s.join {
                    "round" => "RoundEndJoin",
                    "bevel" => "BevelEndJoin",
                    _ => "MiterEndJoin",
                }
                .to_string(),
            );
            poly.miter_limit = Some(s.miter_limit);
            if !s.dash.is_empty() {
                poly.stroke_dash = s
                    .dash
                    .iter()
                    .map(|d| (*d as f64 * self.scale) as f32)
                    .collect();
                if s.dash_phase.abs() > 1e-3 {
                    self.loss("stroke.dash_phase");
                }
            }
            if !self.similar {
                self.loss("stroke.nonuniform");
            }
            let o = paint_opacity(&s.paint);
            if o < 0.9999 {
                poly.stroke_transparency = Some(TargetTransparency {
                    opacity: Some(o * 100.0),
                    ..Default::default()
                });
            }
        } else {
            poly.stroke_weight = Some(0.0);
        }
        set_object(&mut poly.opacity, &mut poly.blend_mode, p.opacity, p.blend);
        Some(poly)
    }

    fn fill(&mut self, poly: &mut Polygon, fill: &Paint) {
        match fill {
            Paint::Solid { rgb, opacity } => {
                poly.fill_color = Some(self.palette.color_id(*rgb));
                if *opacity < 0.9999 {
                    poly.fill_transparency = Some(TargetTransparency {
                        opacity: Some(opacity * 100.0),
                        ..Default::default()
                    });
                }
            }
            Paint::Linear {
                start,
                end,
                stops,
                opacity,
                ..
            } => {
                let s = self.place * Point::new(start[0] as f64, start[1] as f64);
                let e = self.place * Point::new(end[0] as f64, end[1] as f64);
                let d: Vec2 = e - s;
                if !self.similar {
                    // An uneven placement turns the ramp's isolines; the
                    // mapped end points keep its ends.
                    self.loss("gradient.nonuniform");
                }
                poly.fill_color = Some(self.palette.gradient_id(GradientKind::Linear, stops));
                poly.gradient_fill_start = Some([s.x as f32, s.y as f32]);
                poly.gradient_fill_length = Some(d.hypot() as f32);
                // The renderer's angle: degrees, counter-clockwise on the
                // page, the axis running to (cos θ, −sin θ) (y down).
                poly.gradient_fill_angle = Some((-d.y).atan2(d.x).to_degrees() as f32);
                if *opacity < 0.9999 {
                    poly.fill_transparency = Some(TargetTransparency {
                        opacity: Some(opacity * 100.0),
                        ..Default::default()
                    });
                }
            }
            Paint::Radial {
                center,
                radius,
                stops,
                opacity,
                ..
            } => {
                let c = self.place * Point::new(center[0] as f64, center[1] as f64);
                if !self.similar {
                    self.loss("gradient.nonuniform");
                }
                poly.fill_color = Some(self.palette.gradient_id(GradientKind::Radial, stops));
                poly.gradient_fill_start = Some([c.x as f32, c.y as f32]);
                poly.gradient_fill_length = Some((*radius as f64 * self.scale) as f32);
                if *opacity < 0.9999 {
                    poly.fill_transparency = Some(TargetTransparency {
                        opacity: Some(opacity * 100.0),
                        ..Default::default()
                    });
                }
            }
        }
    }

    fn push_polygon(&mut self, p: Polygon) -> FrameRef {
        self.spread.polygons.push(p);
        FrameRef::Polygon(self.spread.polygons.len() - 1)
    }

    fn push_rectangle(&mut self, r: Rectangle) -> FrameRef {
        self.spread.rectangles.push(r);
        FrameRef::Rectangle(self.spread.rectangles.len() - 1)
    }

    /// An image frame: the bytes stretched over the frame's bounds (no
    /// image transform), the frame placed by the image's own transform.
    fn image(&mut self, i: &ImageItem) -> Option<Rectangle> {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(i.data_b64.as_bytes())
            .ok()?;
        let [a, b, c, d, e, f] = i.transform.map(|v| v as f64);
        let t = self.place * Affine::new([a, b, c, d, e, f]);
        let [a, b, c, d, e, f] = t.as_coeffs();
        let id = self.ids.id("pdfi");
        let (bounds, item_transform) = if b.abs() < 1e-9 && c.abs() < 1e-9 && a > 0.0 && d > 0.0 {
            // Upright: the bounds are the image's box.
            (
                Bounds {
                    top: f as f32,
                    left: e as f32,
                    bottom: (f + d) as f32,
                    right: (e + a) as f32,
                },
                IDENTITY,
            )
        } else {
            // Turned, sheared or mirrored: the frame's own box is the
            // image's size, its transform the rest.
            let w = a.hypot(b).max(1e-6);
            let h = c.hypot(d).max(1e-6);
            let rest = t * Affine::scale_non_uniform(1.0 / w, 1.0 / h);
            (
                Bounds {
                    top: 0.0,
                    left: 0.0,
                    bottom: h as f32,
                    right: w as f32,
                },
                rest.as_coeffs().map(|v| v as f32),
            )
        };
        let mut r = Rectangle {
            item_transform: Some(item_transform),
            image_bytes: Some(bytes),
            has_image_element: true,
            stroke_weight: Some(0.0),
            ..Rectangle::new(id, bounds)
        };
        set_object(&mut r.opacity, &mut r.blend_mode, i.opacity, i.blend);
        Some(r)
    }

    fn group(&mut self, g: &GroupItem, in_mask: bool) -> Option<FrameRef> {
        let mut members: Vec<FrameRef> = g
            .items
            .iter()
            .filter_map(|i| self.item(i, in_mask))
            .collect();
        if members.is_empty() {
            return None;
        }
        if let Some(mask) = &g.mask {
            self.apply_mask(&members, mask);
        }
        let clip = match &g.clip {
            Some(clip) => {
                let (anchors, starts, opens, bounds) = self.polygon_geometry(&clip.contours)?;
                let _ = opens;
                let id = self.ids.id("pdfc");
                let poly = Polygon {
                    item_transform: Some(IDENTITY),
                    anchors,
                    subpath_starts: starts,
                    subpath_open: Vec::new(),
                    fill_rule: if clip.fill_rule == "evenodd" {
                        paged_model::FillRule::EvenOdd
                    } else {
                        paged_model::FillRule::NonZero
                    },
                    stroke_weight: Some(0.0),
                    ..Polygon::new(id, bounds)
                };
                // The clipping path is the top-most member (ADR 1010).
                members.push(self.push_polygon(poly));
                true
            }
            None => false,
        };
        if !clip
            && members.len() == 1
            && (g.opacity - 1.0).abs() < 1e-4
            && g.blend.is_none()
            && !g.knockout
        {
            return members.pop();
        }
        let mut group = Group {
            self_id: Some(self.ids.id("pdfg")),
            members,
            item_transform: Some(IDENTITY),
            clip,
            ..Default::default()
        };
        if (g.opacity - 1.0).abs() >= 1e-4 {
            group.transparency.opacity = Some(g.opacity * 100.0);
        }
        group.transparency.blend_mode = g.blend.map(str::to_string);
        group.transparency.isolate_blending = g.isolated;
        group.transparency.knockout_group = g.knockout;
        self.spread.groups.push(group);
        Some(FrameRef::Group(self.spread.groups.len() - 1))
    }

    /// The `Self` id of `r`.
    fn id_of(&self, r: FrameRef) -> Option<String> {
        let s = &*self.spread;
        match r {
            FrameRef::TextFrame(i) => s.text_frames.get(i).and_then(|f| f.self_id.clone()),
            FrameRef::Rectangle(i) => s.rectangles.get(i).and_then(|f| f.self_id.clone()),
            FrameRef::Oval(i) => s.ovals.get(i).and_then(|f| f.self_id.clone()),
            FrameRef::GraphicLine(i) => s.graphic_lines.get(i).and_then(|f| f.self_id.clone()),
            FrameRef::Polygon(i) => s.polygons.get(i).and_then(|f| f.self_id.clone()),
            FrameRef::Group(i) => s.groups.get(i).and_then(|f| f.self_id.clone()),
            FrameRef::Instance(i) => s.instances.get(i).and_then(|f| f.self_id.clone()),
        }
    }

    /// The graphic leaves under `refs` (a group's members, recursively),
    /// and how many text frames are among them.
    fn leaves(&self, refs: &[FrameRef], out: &mut Vec<FrameRef>, text: &mut u32) {
        for r in refs {
            match r {
                FrameRef::Group(gi) => {
                    let g = &self.spread.groups[*gi];
                    // A clip group's clipping path is geometry, not paint.
                    let members: Vec<FrameRef> = if g.clip {
                        g.members[..g.members.len().saturating_sub(1)].to_vec()
                    } else {
                        g.members.clone()
                    };
                    self.leaves(&members, out, text);
                }
                FrameRef::TextFrame(_) => *text += 1,
                other => out.push(*other),
            }
        }
    }

    /// A PDF soft mask as native opacity masks (C-28): the engine masks one
    /// graphic item by one mask item, so a mask that is one item is
    /// applied to every graphic item under it (exact for items that do
    /// not overlap; reported when there are several), and a mask of
    /// several items is left out and reported.
    fn apply_mask(&mut self, members: &[FrameRef], mask: &MaskIr) {
        let single = match mask.items.as_slice() {
            [Item::Path(p)] => Some(Item::Path(p.clone())),
            [Item::Image(i)] => Some(Item::Image(i.clone())),
            _ => None,
        };
        let Some(single) = single else {
            self.loss("mask.complex_dropped");
            return;
        };
        if mask.backdrop_rgb.is_some() {
            // Already reported by the reader.
        }
        let mut targets = Vec::new();
        let mut text = 0;
        self.leaves(members, &mut targets, &mut text);
        if text > 0 {
            self.loss("mask.text_target");
        }
        if targets.len() > 1 {
            self.loss("mask.per_item");
        }
        let mask_type = if mask.mask_type == "alpha" {
            OpacityMaskType::Alpha
        } else {
            OpacityMaskType::Luminosity
        };
        for target in targets {
            let Some(target_id) = self.id_of(target) else {
                continue;
            };
            if self.spread.opacity_masks.contains_key(&target_id) {
                // A mask under a mask: the inner one stays.
                self.loss("mask.nested_dropped");
                continue;
            }
            // The mask item is in its kind's list but in no z-order and no
            // group: it paints only through the mask.
            let mask_ref = match &single {
                Item::Path(p) => self.path(p).map(|p| self.push_polygon(p)),
                Item::Image(i) => self.image(i).map(|r| self.push_rectangle(r)),
                _ => None,
            };
            let Some(mask_id) = mask_ref.and_then(|r| self.id_of(r)) else {
                continue;
            };
            self.spread.opacity_masks.insert(
                target_id,
                OpacityMask {
                    mask_item: mask_id,
                    mask_type,
                    invert: false,
                    // A PDF soft mask hides what its group does not paint.
                    clip: true,
                },
            );
        }
    }

    fn frame_missing_font(&self, k: usize) -> bool {
        self.text.frames[k].paragraphs.iter().any(|p| {
            p.runs.iter().any(|r| {
                r.font_family
                    .as_deref()
                    .is_some_and(|f| self.text.missing_fonts.contains(f))
            })
        })
    }

    /// The recovered frame the run at `bbox` belongs to: the one holding
    /// the most of it, and at least half.
    fn frame_for(&self, bbox: kurbo::Rect) -> Option<usize> {
        let area = bbox.area().max(1e-6);
        let mut best = None;
        let mut best_share = 0.5;
        for (k, f) in self.text.frames.iter().enumerate() {
            let r = rect_of(f.rect);
            let share = bbox.intersect(r).area() / area;
            if share >= best_share {
                best_share = share;
                best = Some(k);
            }
        }
        best
    }

    fn text_item(&mut self, t: &TextItem, in_mask: bool) -> Option<FrameRef> {
        let [x, y, w, h] = t.bbox.map(|v| v as f64);
        let bbox = kurbo::Rect::new(x, y, x + w, y + h);
        let frame = self.frame_for(bbox);
        let outline = in_mask
            || self.text.mode == TextMode::Outlines
            || match frame {
                None => {
                    if !t.text.trim().is_empty() {
                        self.loss("text.unmatched_outlined");
                    }
                    true
                }
                Some(k) => match self.frame_state[k] {
                    FrameState::Placed => return None,
                    FrameState::Outlined => true,
                    FrameState::Pending => {
                        if t.rotated {
                            self.loss("text.rotated_outlined");
                            self.frame_state[k] = FrameState::Outlined;
                            true
                        } else if self.frame_missing_font(k) {
                            self.loss("text.missing_font_outlined");
                            self.frame_state[k] = FrameState::Outlined;
                            true
                        } else {
                            false
                        }
                    }
                },
            };
        if !outline {
            let k = frame.expect("a frame was found");
            return self.text_frame(k);
        }
        if t.outlines.is_empty() {
            return None;
        }
        let path = PathItem {
            contours: t.outlines.clone(),
            fill: t.fill.clone().or(Some(Paint::Solid {
                rgb: [0.0; 3],
                opacity: 1.0,
            })),
            stroke: None,
            fill_rule: "nonzero",
            opacity: t.opacity,
            blend: t.blend,
        };
        self.path(&path).map(|p| self.push_polygon(p))
    }

    /// Recovered frame `k` as a text frame and its story.
    fn text_frame(&mut self, k: usize) -> Option<FrameRef> {
        self.frame_state[k] = FrameState::Placed;
        let tf = self.text.frames[k].clone();
        if !self.similar {
            self.loss("text.nonuniform_scale");
        }
        let scale = self.scale as f32;
        let mut story = Story::default();
        for p in &tf.paragraphs {
            let mut para = Paragraph::default();
            for run in &p.runs {
                if run.text.is_empty() {
                    continue;
                }
                para.runs.push(CharacterRun {
                    font: run.font_family.clone(),
                    font_style: font_style(run.bold, run.italic),
                    point_size: Some(run.font_size_pt * scale),
                    fill_color: run.color_rgb.map(|c| self.palette.color_id(c)),
                    text: run.text.clone(),
                    ..Default::default()
                });
            }
            if !para.runs.is_empty() {
                story.paragraphs.push(para);
            }
        }
        if story.paragraphs.is_empty() {
            return None;
        }
        // The frame's own box is its rect at the placement's scale; the
        // rest of the placement (a turn, the offset) is its transform.
        let r = tf.rect;
        let s = self.scale.max(1e-9);
        let bounds = Bounds {
            top: (r.y_pt as f64 * s) as f32,
            left: (r.x_pt as f64 * s) as f32,
            bottom: ((r.y_pt + r.height_pt) as f64 * s) as f32,
            right: ((r.x_pt + r.width_pt) as f64 * s) as f32,
        };
        let rest = self.place * Affine::scale(1.0 / s);
        let story_id = self.ids.id("pdfs");
        let frame = TextFrame {
            item_transform: Some(rest.as_coeffs().map(|v| v as f32)),
            ..TextFrame::new(self.ids.id("pdft"), Some(story_id.clone()), bounds)
        };
        self.spread.text_frames.push(frame);
        self.stories.push(ParsedStory {
            src: format!("Stories/Story_{story_id}.xml"),
            self_id: story_id,
            story,
        });
        Some(FrameRef::TextFrame(self.spread.text_frames.len() - 1))
    }
}

fn paint_opacity(p: &Paint) -> f32 {
    match p {
        Paint::Solid { opacity, .. }
        | Paint::Linear { opacity, .. }
        | Paint::Radial { opacity, .. } => *opacity,
    }
}

/// An item's own opacity (0..=100, `None` = opaque) and blend mode.
fn set_object(
    opacity: &mut Option<f32>,
    blend: &mut Option<String>,
    o: f32,
    b: Option<&'static str>,
) {
    if o < 0.9999 {
        *opacity = Some(o * 100.0);
    }
    *blend = b.map(str::to_string);
}

fn rect_of(r: RectIr) -> kurbo::Rect {
    kurbo::Rect::new(
        r.x_pt as f64,
        r.y_pt as f64,
        (r.x_pt + r.width_pt) as f64,
        (r.y_pt + r.height_pt) as f64,
    )
}

/// Append one contour of mapped anchors to `path` (for its bounds).
fn append_bez(path: &mut BezPath, anchors: &[PathAnchor], closed: bool) {
    let Some(first) = anchors.first() else {
        return;
    };
    let p = |t: (f32, f32)| Point::new(t.0 as f64, t.1 as f64);
    path.move_to(p(first.anchor));
    for w in anchors.windows(2) {
        path.curve_to(p(w[0].right), p(w[1].left), p(w[1].anchor));
    }
    if closed && anchors.len() > 1 {
        let last = anchors[anchors.len() - 1];
        path.curve_to(p(last.right), p(first.left), p(first.anchor));
        path.close_path();
    }
}

/// IDML expresses bold/italic through the font *style* string, not flags.
pub(crate) fn font_style(bold: bool, italic: bool) -> Option<String> {
    match (bold, italic) {
        (true, true) => Some("Bold Italic".to_string()),
        (true, false) => Some("Bold".to_string()),
        (false, true) => Some("Italic".to_string()),
        (false, false) => None,
    }
}

/// The bounds of the items `refs` name, `[top, left, bottom, right]`.
pub(crate) fn bounds_of_refs(spread: &Spread, refs: &[FrameRef]) -> Option<[f32; 4]> {
    let mut acc: Option<[f32; 4]> = None;
    let mut add = |b: &Bounds, t: Option<[f32; 6]>| {
        let t = t.unwrap_or(IDENTITY);
        let corners = [
            (b.left, b.top),
            (b.right, b.top),
            (b.left, b.bottom),
            (b.right, b.bottom),
        ]
        .map(|(x, y)| (t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]));
        for (x, y) in corners {
            acc = Some(match acc {
                None => [y, x, y, x],
                Some([top, left, bottom, right]) => {
                    [top.min(y), left.min(x), bottom.max(y), right.max(x)]
                }
            });
        }
    };
    fn walk(spread: &Spread, r: FrameRef, add: &mut dyn FnMut(&Bounds, Option<[f32; 6]>)) {
        match r {
            FrameRef::TextFrame(i) => {
                let f = &spread.text_frames[i];
                add(&f.bounds, f.item_transform)
            }
            FrameRef::Rectangle(i) => {
                let f = &spread.rectangles[i];
                add(&f.bounds, f.item_transform)
            }
            FrameRef::Oval(i) => {
                let f = &spread.ovals[i];
                add(&f.bounds, f.item_transform)
            }
            FrameRef::GraphicLine(i) => {
                let f = &spread.graphic_lines[i];
                add(&f.bounds, f.item_transform)
            }
            FrameRef::Polygon(i) => {
                let f = &spread.polygons[i];
                add(&f.bounds, f.item_transform)
            }
            FrameRef::Group(i) => {
                for m in spread.groups[i].members.clone() {
                    walk(spread, m, add);
                }
            }
            // Engine ADR 1039 — an instance's box is its definition's.
            FrameRef::Instance(i) => {
                let f = &spread.instances[i];
                add(&f.bounds, Some(f.item_transform))
            }
        }
    }
    for r in refs {
        walk(spread, *r, &mut add);
    }
    acc
}
