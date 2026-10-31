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

//! The `hayro-interpret` device that collects a page into vector items.
//!
//! hayro hands every drawing operation over in device space (here: the
//! page box's points, y down) or with the transform that takes it there,
//! and brackets clips and transparency groups with push/pop calls. The
//! collector keeps a stack of open brackets; each pop closes one into a
//! [`GroupItem`].

use std::collections::BTreeMap;

use hayro_interpret::font::Glyph;
use hayro_interpret::font::GlyphRun;
use hayro_interpret::hayro_syntax::object::Name;
use hayro_interpret::hayro_syntax::Filter;
use hayro_interpret::pattern::{Pattern, TilingPattern};
use hayro_interpret::{
    BlendMode, ClipPath, Device, DrawMode, DrawProps, FillRule, Image, ImageData, ImageDrawProps,
    LumaData, MaskType, Paint as HPaint, SoftMask, StrokeProps,
};
use kurbo::{Affine, BezPath, PathEl, Point, Rect, Shape};

use super::encode;
use super::ir::{
    Anchor, ClipIr, Contour, GroupItem, ImageItem, Item, Loss, MaskIr, Paint, PathItem, StrokeIr,
    TextItem,
};
use super::paint::{self, Shaded};
use super::ReadOptions;

/// Soft masks and tiling cells nest at most this deep; a deeper one is
/// left out and reported.
const MAX_DEPTH: u32 = 6;

enum OpenKind {
    Root,
    Clip(ClipIr),
    Group {
        opacity: f32,
        blend: Option<&'static str>,
        mask: Option<MaskIr>,
    },
}

struct Open {
    kind: OpenKind,
    items: Vec<Item>,
}

pub(super) struct Collector {
    stack: Vec<Open>,
    losses: BTreeMap<&'static str, u32>,
    page: Rect,
    opts: ReadOptions,
    depth: u32,
}

impl Collector {
    pub(super) fn new(page: Rect, opts: ReadOptions) -> Collector {
        Collector {
            stack: vec![Open {
                kind: OpenKind::Root,
                items: Vec::new(),
            }],
            losses: BTreeMap::new(),
            page,
            opts,
            depth: 0,
        }
    }

    fn nested(&self) -> Collector {
        let mut c = Collector::new(self.page, self.opts);
        c.depth = self.depth + 1;
        c
    }

    /// Open a clip of `rect` (the page box, when it is not the crop box).
    pub(super) fn push_box_clip(&mut self, rect: Rect) {
        self.stack.push(Open {
            kind: OpenKind::Clip(ClipIr {
                contours: contours_of(&rect.to_path(0.1)),
                fill_rule: "nonzero",
            }),
            items: Vec::new(),
        });
    }

    /// Close every bracket the page left open; the items and the losses.
    pub(super) fn finish(mut self) -> (Vec<Item>, Vec<Loss>) {
        while self.stack.len() > 1 {
            self.close_top();
        }
        let root = self.stack.pop().map(|o| o.items).unwrap_or_default();
        let losses = self
            .losses
            .into_iter()
            .map(|(code, count)| Loss { code, count })
            .collect();
        (root, losses)
    }

    fn loss(&mut self, code: &'static str) {
        *self.losses.entry(code).or_default() += 1;
    }

    fn absorb(&mut self, losses: Vec<Loss>) {
        for l in losses {
            *self.losses.entry(l.code).or_default() += l.count;
        }
    }

    fn top(&mut self) -> &mut Vec<Item> {
        &mut self
            .stack
            .last_mut()
            .expect("the root is never popped")
            .items
    }

    /// Append `item`. A stroke of the path the previous item filled (a
    /// PDF `B`, which hayro hands over as a fill and then a stroke) joins
    /// that item.
    fn push(&mut self, item: Item) {
        if let Item::Path(p) = &item {
            if p.fill.is_none() {
                if let Some(Item::Path(prev)) = self.top().last_mut() {
                    if prev.stroke.is_none()
                        && prev.fill.is_some()
                        && prev.blend == p.blend
                        && prev.contours == p.contours
                    {
                        prev.stroke = p.stroke.clone();
                        return;
                    }
                }
            }
        }
        self.top().push(item);
    }

    fn close_top(&mut self) {
        if self.stack.len() <= 1 {
            return;
        }
        let open = self.stack.pop().expect("checked");
        let group = match open.kind {
            OpenKind::Root => unreachable!("the root stays at the bottom"),
            OpenKind::Clip(clip) => GroupItem {
                items: open.items,
                clip: Some(clip),
                opacity: 1.0,
                blend: None,
                isolated: false,
                knockout: false,
                mask: None,
            },
            OpenKind::Group {
                opacity,
                blend,
                mask,
            } => GroupItem {
                items: open.items,
                clip: None,
                opacity,
                blend,
                // hayro does not hand over a group's /I and /K; PDF's
                // default for both is false.
                isolated: false,
                knockout: false,
                mask,
            },
        };
        self.top().push(Item::Group(group));
    }

    /// Close brackets down to and including the topmost one `is` names.
    fn close_through(&mut self, is: fn(&OpenKind) -> bool) {
        if !self.stack.iter().skip(1).any(|o| is(&o.kind)) {
            return;
        }
        while self.stack.len() > 1 {
            let done = is(&self.stack.last().expect("non-empty").kind);
            self.close_top();
            if done {
                break;
            }
        }
    }

    fn mask(&mut self, m: &SoftMask<'_>) -> Option<MaskIr> {
        if self.depth >= MAX_DEPTH {
            self.loss("mask.too_deep");
            return None;
        }
        let mut sub = self.nested();
        m.interpret(&mut sub);
        let (items, losses) = sub.finish();
        self.absorb(losses);
        let mask_type = match m.mask_type() {
            MaskType::Luminosity => "luminosity",
            MaskType::Alpha => "alpha",
        };
        let backdrop_rgb = match m.mask_type() {
            MaskType::Luminosity => {
                let [r, g, b, _] = m.background_color().to_rgba().components();
                (r > 1e-3 || g > 1e-3 || b > 1e-3).then_some([r, g, b])
            }
            MaskType::Alpha => None,
        };
        if backdrop_rgb.is_some() {
            self.loss("mask.backdrop");
        }
        if m.transfer_function().is_some() {
            self.loss("mask.transfer");
        }
        Some(MaskIr {
            mask_type,
            items,
            backdrop_rgb,
        })
    }

    /// Push `item` with the blend mode and soft mask it was drawn with.
    fn emit(&mut self, mut item: Item, mask: Option<&SoftMask<'_>>, mode: BlendMode) {
        let b = blend_name(mode);
        match &mut item {
            Item::Path(p) => p.blend = b,
            Item::Image(i) => i.blend = b,
            Item::Text(t) => t.blend = b,
            Item::Group(g) => {
                if b.is_some() {
                    g.blend = b;
                }
            }
        }
        if let Some(m) = mask {
            if let Some(mask) = self.mask(m) {
                item = Item::Group(GroupItem {
                    items: vec![item],
                    clip: None,
                    opacity: 1.0,
                    blend: None,
                    isolated: false,
                    knockout: false,
                    mask: Some(mask),
                });
            }
        }
        self.push(item);
    }

    fn region_of(&self, dev: &BezPath) -> Rect {
        let b = dev.bounding_box();
        b.intersect(self.page.inflate(1.0, 1.0))
    }

    fn fill(&mut self, dev: &BezPath, rule: &FillRule, props: &DrawProps<'_>) {
        let contours = contours_of(dev);
        if contours.is_empty() {
            return;
        }
        let fill_rule = rule_name(rule);
        let item = match &props.paint {
            HPaint::Color(c) => Item::Path(PathItem {
                contours,
                fill: Some(paint::solid(c)),
                stroke: None,
                fill_rule,
                opacity: 1.0,
                blend: None,
            }),
            HPaint::Pattern(p) => match &**p {
                Pattern::Shading(sp) => match paint::shading(sp, self.region_of(dev), &self.opts) {
                    Shaded::Native(fill, losses) => {
                        for l in losses {
                            self.loss(l);
                        }
                        Item::Path(PathItem {
                            contours,
                            fill: Some(fill),
                            stroke: None,
                            fill_rule,
                            opacity: 1.0,
                            blend: None,
                        })
                    }
                    Shaded::Sampled(image, why) => {
                        self.loss(why);
                        clipped(contours, fill_rule, vec![Item::Image(image)])
                    }
                    Shaded::Nothing => return,
                },
                Pattern::Tiling(tp) => match self.tiling(tp, dev, contours, fill_rule) {
                    Some(item) => item,
                    None => return,
                },
            },
        };
        self.emit(item, props.soft_mask.as_ref(), props.blend_mode);
    }

    /// A tiling-pattern fill: the cell's items repeated over the path and
    /// clipped to it, or, past [`ReadOptions::max_tiles`] copies, the
    /// path filled with the cell's first colour.
    fn tiling(
        &mut self,
        tp: &TilingPattern<'_>,
        dev: &BezPath,
        contours: Vec<Contour>,
        fill_rule: &'static str,
    ) -> Option<Item> {
        if self.depth >= MAX_DEPTH {
            self.loss("pattern.too_deep");
            return None;
        }
        let region = self.region_of(dev);
        let inv = tp.matrix.inverse();
        let corners = [
            Point::new(region.x0, region.y0),
            Point::new(region.x1, region.y0),
            Point::new(region.x0, region.y1),
            Point::new(region.x1, region.y1),
        ]
        .map(|p| inv * p);
        let lo_x = corners.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
        let hi_x = corners
            .iter()
            .map(|p| p.x)
            .fold(f64::NEG_INFINITY, f64::max);
        let lo_y = corners.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
        let hi_y = corners
            .iter()
            .map(|p| p.y)
            .fold(f64::NEG_INFINITY, f64::max);
        let (xs, ys) = (tp.x_step as f64, tp.y_step as f64);
        let (sx, sy) = (xs.abs().max(1e-6), ys.abs().max(1e-6));
        let i0 = ((lo_x - tp.bbox.x1) / sx).floor() as i64;
        let i1 = ((hi_x - tp.bbox.x0) / sx).ceil() as i64;
        let j0 = ((lo_y - tp.bbox.y1) / sy).floor() as i64;
        let j1 = ((hi_y - tp.bbox.y0) / sy).ceil() as i64;
        let count = (i1 - i0 + 1).max(0) as u64 * (j1 - j0 + 1).max(0) as u64;
        if count == 0 {
            return None;
        }
        if count > self.opts.max_tiles as u64 {
            self.loss("pattern.tiling_flattened");
            let mut sub = self.nested();
            tp.interpret(&mut sub, tp.matrix, false);
            let (cell, _) = sub.finish();
            let rgb = first_solid(&cell).unwrap_or([0.5, 0.5, 0.5]);
            return Some(Item::Path(PathItem {
                contours,
                fill: Some(Paint::Solid { rgb, opacity: 1.0 }),
                stroke: None,
                fill_rule,
                opacity: 1.0,
                blend: None,
            }));
        }
        self.loss("pattern.tiling_expanded");
        let mut sub = self.nested();
        for i in i0..=i1 {
            for j in j0..=j1 {
                let at = tp.matrix * Affine::translate((i as f64 * xs, j as f64 * ys));
                tp.interpret(&mut sub, at, false);
            }
        }
        let (items, losses) = sub.finish();
        self.absorb(losses);
        Some(clipped(contours, fill_rule, items))
    }

    fn stroke(&mut self, dev: &BezPath, sp: &StrokeProps, props: &DrawProps<'_>) {
        let contours = contours_of(dev);
        if contours.is_empty() {
            return;
        }
        let t = props.transform;
        let [a, b, c, d, ..] = t.as_coeffs();
        let scale = (a * d - b * c).abs().sqrt();
        let (sx, sy) = (a.hypot(b), c.hypot(d));
        if (sx - sy).abs() > 1e-3 * sx.max(sy) || (a * c + b * d).abs() > 1e-3 * sx * sy {
            self.loss("stroke.nonuniform");
        }
        let paint = match &props.paint {
            HPaint::Color(col) => paint::solid(col),
            HPaint::Pattern(p) => {
                self.loss("stroke.pattern");
                let rgb = match &**p {
                    Pattern::Shading(sh) => {
                        let enc = sh.encode();
                        let at = self.region_of(dev).center();
                        let [r, g, b, _] = enc.sample(enc.base_transform * at);
                        [r, g, b]
                    }
                    Pattern::Tiling(_) => [0.5, 0.5, 0.5],
                };
                Paint::Solid { rgb, opacity: 1.0 }
            }
        };
        let mut width = sp.line_width * scale as f32;
        if width <= 0.0 {
            // PDF's 0 is the thinnest line the device can draw.
            self.loss("stroke.hairline");
            width = 0.25;
        }
        let item = Item::Path(PathItem {
            contours,
            fill: None,
            stroke: Some(StrokeIr {
                paint,
                width,
                cap: match sp.line_cap {
                    kurbo::Cap::Butt => "butt",
                    kurbo::Cap::Round => "round",
                    kurbo::Cap::Square => "square",
                },
                join: match sp.line_join {
                    kurbo::Join::Miter => "miter",
                    kurbo::Join::Round => "round",
                    kurbo::Join::Bevel => "bevel",
                },
                miter_limit: sp.miter_limit,
                dash: sp.dash_array.iter().map(|v| v * scale as f32).collect(),
                dash_phase: sp.dash_offset * scale as f32,
            }),
            fill_rule: "nonzero",
            opacity: 1.0,
            blend: None,
        });
        self.emit(item, props.soft_mask.as_ref(), props.blend_mode);
    }
}

fn clipped(contours: Vec<Contour>, fill_rule: &'static str, items: Vec<Item>) -> Item {
    Item::Group(GroupItem {
        items,
        clip: Some(ClipIr {
            contours,
            fill_rule,
        }),
        opacity: 1.0,
        blend: None,
        isolated: false,
        knockout: false,
        mask: None,
    })
}

fn first_solid(items: &[Item]) -> Option<[f32; 3]> {
    items.iter().find_map(|i| match i {
        Item::Path(PathItem {
            fill: Some(Paint::Solid { rgb, .. }),
            ..
        }) => Some(*rgb),
        Item::Path(PathItem {
            stroke:
                Some(StrokeIr {
                    paint: Paint::Solid { rgb, .. },
                    ..
                }),
            ..
        }) => Some(*rgb),
        Item::Group(g) => first_solid(&g.items),
        _ => None,
    })
}

fn rule_name(r: &FillRule) -> &'static str {
    match r {
        FillRule::NonZero => "nonzero",
        FillRule::EvenOdd => "evenodd",
    }
}

/// A PDF blend mode in IDML's spelling; `None` for `Normal`.
pub(super) fn blend_name(b: BlendMode) -> Option<&'static str> {
    Some(match b {
        BlendMode::Normal => return None,
        BlendMode::Multiply => "Multiply",
        BlendMode::Screen => "Screen",
        BlendMode::Overlay => "Overlay",
        BlendMode::Darken => "Darken",
        BlendMode::Lighten => "Lighten",
        BlendMode::ColorDodge => "ColorDodge",
        BlendMode::ColorBurn => "ColorBurn",
        BlendMode::HardLight => "HardLight",
        BlendMode::SoftLight => "SoftLight",
        BlendMode::Difference => "Difference",
        BlendMode::Exclusion => "Exclusion",
        BlendMode::Hue => "Hue",
        BlendMode::Saturation => "Saturation",
        BlendMode::Color => "Color",
        BlendMode::Luminosity => "Luminosity",
    })
}

fn p2(p: Point) -> [f32; 2] {
    [p.x as f32, p.y as f32]
}

/// `p` (device space) as anchor contours. A contour that closes on its
/// own start (a curve back to the first anchor) folds the duplicate end
/// into the first anchor's incoming handle.
pub(super) fn contours_of(p: &BezPath) -> Vec<Contour> {
    let mut out = Vec::new();
    let mut cur: Vec<Anchor> = Vec::new();
    let mut start = Point::ZERO;
    let mut last = Point::ZERO;
    let at = |a: Point| Anchor {
        anchor: p2(a),
        left: p2(a),
        right: p2(a),
    };
    fn flush(out: &mut Vec<Contour>, cur: &mut Vec<Anchor>, closed: bool) {
        let mut anchors = std::mem::take(cur);
        // A contour that ends where it began without `h` (how Illustrator
        // writes an ellipse) is the closed shape it draws.
        let ends_at_start = anchors.len() > 2 && {
            let (f, l) = (anchors[0].anchor, anchors[anchors.len() - 1].anchor);
            (f[0] - l[0]).abs() < 1e-4 && (f[1] - l[1]).abs() < 1e-4
        };
        let closed = closed || ends_at_start;
        if closed && anchors.len() > 1 {
            let (f, l) = (anchors[0].anchor, anchors[anchors.len() - 1].anchor);
            if (f[0] - l[0]).abs() < 1e-4 && (f[1] - l[1]).abs() < 1e-4 {
                let end = anchors.pop().expect("len > 1");
                anchors[0].left = end.left;
            }
        }
        if anchors.len() >= 2 || (closed && !anchors.is_empty()) {
            out.push(Contour { anchors, closed });
        }
    }
    for el in p.elements() {
        match *el {
            PathEl::MoveTo(a) => {
                flush(&mut out, &mut cur, false);
                cur.push(at(a));
                start = a;
                last = a;
            }
            PathEl::LineTo(a) => {
                if cur.is_empty() {
                    cur.push(at(last));
                }
                // A line of no length (PDF writers round a curve's end and
                // join it to the next with one) is no anchor.
                if (a - last).hypot() > 1e-3 {
                    cur.push(at(a));
                }
                last = a;
            }
            PathEl::QuadTo(q, a) => {
                if cur.is_empty() {
                    cur.push(at(last));
                }
                let c1 = last + (q - last) * (2.0 / 3.0);
                let c2 = a + (q - a) * (2.0 / 3.0);
                if let Some(prev) = cur.last_mut() {
                    prev.right = p2(c1);
                }
                cur.push(Anchor {
                    anchor: p2(a),
                    left: p2(c2),
                    right: p2(a),
                });
                last = a;
            }
            PathEl::CurveTo(c1, c2, a) => {
                if cur.is_empty() {
                    cur.push(at(last));
                }
                if let Some(prev) = cur.last_mut() {
                    prev.right = p2(c1);
                }
                cur.push(Anchor {
                    anchor: p2(a),
                    left: p2(c2),
                    right: p2(a),
                });
                last = a;
            }
            PathEl::ClosePath => {
                flush(&mut out, &mut cur, true);
                last = start;
            }
        }
    }
    flush(&mut out, &mut cur, false);
    out
}

/// A decoded image as tightly packed RGBA8, its alpha from `alpha` when
/// that matches the image's size (the engine's placed-PDF decode,
/// `paged-renderer`'s `pipeline/placed_pdf.rs`).
fn rgba8(data: ImageData, alpha: Option<LumaData>) -> Option<(u32, u32, Vec<u8>)> {
    let (w, h) = (data.width(), data.height());
    let n = (w as usize) * (h as usize);
    let mut out = Vec::with_capacity(n * 4);
    match &data {
        ImageData::Rgb(rgb) if rgb.data.len() >= n * 3 => {
            for px in rgb.data.as_chunks::<3>().0.iter().take(n) {
                out.extend_from_slice(&[px[0], px[1], px[2], 255]);
            }
        }
        ImageData::Luma(l) if l.data.len() >= n => {
            for &v in l.data.iter().take(n) {
                out.extend_from_slice(&[v, v, v, 255]);
            }
        }
        _ => return None,
    }
    if let Some(a) = alpha.filter(|a| a.width == w && a.height == h && a.data.len() >= n) {
        for (px, &v) in out.as_chunks_mut::<4>().0.iter_mut().zip(a.data.iter()) {
            px[3] = v;
        }
    }
    Some((w, h, out))
}

/// The raw stream of an image the engine decodes as it stands: a plain
/// 8-bit RGB or grey JPEG with no mask and no decode array.
fn passthrough_jpeg(
    stream: &hayro_interpret::hayro_syntax::object::Stream<'_>,
) -> Option<(u32, u32, Vec<u8>)> {
    let filters = stream.filters();
    if filters.len() != 1 || !matches!(filters[0], Filter::DctDecode) {
        return None;
    }
    let dict = stream.dict();
    if dict.contains_key(b"SMask") || dict.contains_key(b"Mask") || dict.contains_key(b"Decode") {
        return None;
    }
    let cs = dict.get::<Name<'_>>(b"ColorSpace")?;
    if !matches!(&*cs, b"DeviceRGB" | b"DeviceGray") {
        return None;
    }
    if dict.get::<u8>(b"BitsPerComponent").is_some_and(|b| b != 8) {
        return None;
    }
    let w = dict.get::<u32>(b"Width")?;
    let h = dict.get::<u32>(b"Height")?;
    Some((w, h, stream.raw_data().into_owned()))
}

impl<'a> Device<'a> for Collector {
    fn draw_path(&mut self, path: &BezPath, props: DrawProps<'a>, mode: &DrawMode) {
        let dev = props.transform * path.clone();
        match mode {
            DrawMode::Invisible => {}
            DrawMode::Fill(rule) => self.fill(&dev, rule, &props),
            DrawMode::Stroke(sp) => self.stroke(&dev, sp, &props),
            DrawMode::FillAndStroke(rule, sp) => {
                self.fill(&dev, rule, &props);
                self.stroke(&dev, sp, &props);
            }
        }
    }

    fn push_clip_path(&mut self, clip: &ClipPath) {
        self.stack.push(Open {
            kind: OpenKind::Clip(ClipIr {
                contours: contours_of(&clip.path),
                fill_rule: rule_name(&clip.fill),
            }),
            items: Vec::new(),
        });
    }

    fn push_transparency_group(
        &mut self,
        opacity: f32,
        mask: Option<SoftMask<'a>>,
        blend_mode: BlendMode,
    ) {
        let mask = mask.and_then(|m| self.mask(&m));
        self.stack.push(Open {
            kind: OpenKind::Group {
                opacity,
                blend: blend_name(blend_mode),
                mask,
            },
            items: Vec::new(),
        });
    }

    fn draw_glyph_run(&mut self, run: &GlyphRun<'_, 'a>, props: DrawProps<'a>, mode: &DrawMode) {
        let stroke_only = match mode {
            DrawMode::Invisible => {
                self.loss("text.invisible");
                return;
            }
            DrawMode::Fill(_) => false,
            DrawMode::Stroke(_) => {
                self.loss("text.stroked");
                true
            }
            DrawMode::FillAndStroke(..) => {
                self.loss("text.stroked");
                false
            }
        };
        let _ = stroke_only;
        let mut outlines = Vec::new();
        let mut text = String::new();
        let mut font_name = None;
        let mut size = 0.0f32;
        let mut rotated = false;
        let mut origins = Vec::new();
        for g in run.glyphs() {
            let m = props.transform * g.transform();
            let [a, b, c, d, e, f] = m.as_coeffs();
            if size == 0.0 {
                size = ((a * d - b * c).abs().sqrt() * 1000.0) as f32;
                // Upright in a y-down page: x right, the glyph's y up.
                rotated = b.abs() > 1e-6 || c.abs() > 1e-6 || a <= 0.0 || d >= 0.0;
            }
            origins.push(Point::new(e, f));
            if let Some(u) = g.as_unicode() {
                match u {
                    hayro_interpret::hayro_cmap::BfString::Char(ch) => text.push(ch),
                    hayro_interpret::hayro_cmap::BfString::String(s) => text.push_str(&s),
                }
            }
            match &**g {
                Glyph::Outline(o) => {
                    if font_name.is_none() {
                        font_name = o.font_data().and_then(|d| d.postscript_name);
                    }
                    outlines.extend(contours_of(&(m * o.outline())));
                }
                Glyph::Type3(t3) => {
                    // A Type 3 glyph is drawing operations: they arrive
                    // as paths, not as text.
                    self.loss("text.type3_as_paths");
                    t3.interpret(self, props.transform, g.transform(), &props.paint);
                }
            }
        }
        if origins.is_empty() {
            return;
        }
        let bbox = bounds_of_contours(&outlines).unwrap_or_else(|| {
            let mut r = Rect::from_points(origins[0], origins[0]);
            for p in &origins {
                r = r.union_pt(*p);
            }
            Rect::new(
                r.x0,
                r.y0 - size as f64 * 0.8,
                r.x1,
                r.y1 + size as f64 * 0.2,
            )
        });
        let fill = match &props.paint {
            HPaint::Color(c) => Some(paint::solid(c)),
            HPaint::Pattern(_) => {
                self.loss("text.pattern_fill");
                None
            }
        };
        let item = Item::Text(TextItem {
            bbox: [
                bbox.x0 as f32,
                bbox.y0 as f32,
                bbox.width() as f32,
                bbox.height() as f32,
            ],
            text,
            font_name,
            font_size_pt: size,
            fill,
            outlines,
            rotated,
            opacity: 1.0,
            blend: None,
        });
        self.emit(item, props.soft_mask.as_ref(), props.blend_mode);
    }

    fn draw_image(&mut self, image: Image<'a, '_>, props: ImageDrawProps<'a>) {
        let decoded: Option<(u32, u32, Vec<u8>, &'static str)> = match &image {
            Image::Raster(raster) => match passthrough_jpeg(raster.stream()) {
                Some((w, h, jpeg)) => Some((w, h, jpeg, "image/jpeg")),
                None => {
                    let mut out = None;
                    raster.with_rgba(|data, alpha| out = rgba8(data, alpha), None);
                    out.and_then(|(w, h, rgba)| {
                        encode::png(w, h, &rgba).map(|png| (w, h, png, "image/png"))
                    })
                }
            },
            Image::Stencil(stencil) => {
                let mut out = None;
                let mut pattern = false;
                stencil.with_stencil(
                    |luma, paint| {
                        let rgb = match paint {
                            HPaint::Color(c) => {
                                let [r, g, b, _] = c.to_rgba().to_rgba8();
                                [r, g, b]
                            }
                            HPaint::Pattern(_) => {
                                pattern = true;
                                [128, 128, 128]
                            }
                        };
                        let n = luma.width as usize * luma.height as usize;
                        let mut rgba = Vec::with_capacity(n * 4);
                        for &v in luma.data.iter().take(n) {
                            rgba.extend_from_slice(&[rgb[0], rgb[1], rgb[2], v]);
                        }
                        out = encode::png(luma.width, luma.height, &rgba)
                            .map(|png| (luma.width, luma.height, png, "image/png"));
                    },
                    None,
                );
                if pattern {
                    self.loss("image.stencil_pattern");
                }
                out
            }
        };
        let Some((w, h, bytes, mime)) = decoded else {
            self.loss("image.undecodable");
            return;
        };
        let unit = props.transform * Affine::scale_non_uniform(w as f64, h as f64);
        let item = Item::Image(ImageItem {
            transform: unit.as_coeffs().map(|v| v as f32),
            width_px: w,
            height_px: h,
            data_b64: encode::b64(&bytes),
            mime,
            opacity: 1.0,
            blend: None,
        });
        self.emit(item, props.soft_mask.as_ref(), props.blend_mode);
    }

    fn pop_clip(&mut self) {
        self.close_through(|k| matches!(k, OpenKind::Clip(_)));
    }

    fn pop_transparency_group(&mut self) {
        self.close_through(|k| matches!(k, OpenKind::Group { .. }));
    }
}

/// The bounds of `contours`, handles included (a curve lies inside its
/// control polygon).
pub(super) fn bounds_of_contours(contours: &[Contour]) -> Option<Rect> {
    let mut r: Option<Rect> = None;
    for c in contours {
        for a in &c.anchors {
            for p in [a.anchor, a.left, a.right] {
                let p = Point::new(p[0] as f64, p[1] as f64);
                r = Some(match r {
                    None => Rect::from_points(p, p),
                    Some(r) => r.union_pt(p),
                });
            }
        }
    }
    r
}
