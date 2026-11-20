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
    Anchor, ClipIr, Contour, FontFace, GlyphPos, GroupItem, ImageItem, Item, Loss, MaskIr, Paint,
    PathItem, StrokeIr, TextItem,
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
    losses: BTreeMap<String, u32>,
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
            .map(|(code, count)| Loss::counted(code, count as usize))
            .collect();
        (root, losses)
    }

    fn loss(&mut self, code: &'static str) {
        *self.losses.entry(code.to_string()).or_default() += 1;
    }

    fn absorb(&mut self, losses: Vec<Loss>) {
        for l in losses {
            *self.losses.entry(l.code).or_default() += l.count as u32;
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
    match paged_pdf_page::blend(b) {
        paged_blend::BlendMode::Normal => None,
        m => Some(m.idml_name()),
    }
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
/// 8-bit RGB or grey JPEG with no mask and no decode array, its colour
/// device RGB or grey, or an ICC profile that is sRGB (what the engine
/// reads RGB as): the PDF's own bytes, not a second compression.
fn passthrough_jpeg(
    stream: &hayro_interpret::hayro_syntax::object::Stream<'_>,
) -> Option<(u32, u32, Vec<u8>)> {
    use hayro_interpret::hayro_syntax::object::{Array, Stream};
    let filters = stream.filters();
    if filters.len() != 1 || !matches!(filters[0], Filter::DctDecode) {
        return None;
    }
    let dict = stream.dict();
    if dict.contains_key(b"SMask") || dict.contains_key(b"Mask") || dict.contains_key(b"Decode") {
        return None;
    }
    let device = dict
        .get::<Name<'_>>(b"ColorSpace")
        .is_some_and(|cs| matches!(&*cs, b"DeviceRGB" | b"DeviceGray"));
    let srgb = || {
        let arr = dict.get::<Array<'_>>(b"ColorSpace")?;
        let mut it = arr.flex_iter();
        let kind = it.next::<Name<'_>>()?;
        let profile = it.next::<Stream<'_>>()?;
        (&*kind == b"ICCBased").then_some(())?;
        icc_is_srgb(&profile.decoded().ok()?).then_some(())
    };
    if !device && srgb().is_none() {
        return None;
    }
    if dict.get::<u8>(b"BitsPerComponent").is_some_and(|b| b != 8) {
        return None;
    }
    let w = dict.get::<u32>(b"Width")?;
    let h = dict.get::<u32>(b"Height")?;
    Some((w, h, stream.raw_data().into_owned()))
}

/// An RGB ICC profile that names itself sRGB (its `desc` tag, ASCII in a
/// version 2 profile, UTF-16 in a version 4 one).
fn icc_is_srgb(icc: &[u8]) -> bool {
    if icc.len() < 132 || &icc[16..20] != b"RGB " {
        return false;
    }
    let be = |at: usize| -> Option<usize> {
        icc.get(at..at + 4)
            .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize)
    };
    let Some(count) = be(128) else { return false };
    for i in 0..count.min(64) {
        let at = 132 + i * 12;
        if icc.get(at..at + 4) != Some(b"desc") {
            continue;
        }
        let (Some(off), Some(len)) = (be(at + 4), be(at + 8)) else {
            return false;
        };
        let Some(tag) = icc.get(off..off.saturating_add(len)) else {
            return false;
        };
        let utf16: Vec<u8> = "sRGB".bytes().flat_map(|b| [0, b]).collect();
        return tag.windows(4).any(|w| w == b"sRGB") || tag.windows(8).any(|w| w == utf16);
    }
    false
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
        let mut glyphs = Vec::new();
        let mut face: Option<FontFace> = None;
        let mut font_key: Option<u128> = None;
        let mut turn: Option<f32> = None;
        // A turn whose glyphs are also scaled across (a line set narrower
        // or wider): a reading direction too where the run is a line of
        // glyphs, not one letter placed on a curve.
        let mut scaled_turn: Option<f32> = None;
        for g in run.glyphs() {
            let m = props.transform * g.transform();
            let [a, b, c, d, e, f] = m.as_coeffs();
            if size == 0.0 {
                size = ((a * d - b * c).abs().sqrt() * 1000.0) as f32;
                // Upright in a y-down page: x right, the glyph's y up.
                rotated = b.abs() > 1e-6 || c.abs() > 1e-6 || a <= 0.0 || d >= 0.0;
                // A turn without shear or mirror (the glyph's axes stay
                // square and the y-down page keeps its flip) is a reading
                // direction a frame can be turned to.
                let square = (a * c + b * d).abs() <= 1e-3 * (a * a + b * b).max(1e-12);
                let same = ((a.hypot(b)) - (c.hypot(d))).abs() <= 1e-3 * a.hypot(b).max(1e-12);
                if rotated && square && a * d - b * c < 0.0 {
                    if same {
                        turn = Some(b.atan2(a) as f32);
                    } else {
                        scaled_turn = Some(b.atan2(a) as f32);
                    }
                }
            }
            origins.push(Point::new(e, f));
            let mut glyph_text = String::new();
            if let Some(u) = g.as_unicode() {
                match u {
                    hayro_interpret::hayro_cmap::BfString::Char(ch) => glyph_text.push(ch),
                    hayro_interpret::hayro_cmap::BfString::String(s) => glyph_text.push_str(&s),
                }
            }
            // A code the PDF passes through as text (a font without a
            // usable ToUnicode, its codes mapped to themselves): a control
            // character is no glyph's text, so the program's name for the
            // glyph is read instead.
            // The code itself is kept beside the glyph: a font whose codes
            // are its glyph ids in TrueType's standard order reads from it.
            let mut passed_code = None;
            if glyph_text.chars().all(char::is_control) {
                let mut cs = glyph_text.chars();
                passed_code = cs.next().filter(|_| cs.next().is_none());
                glyph_text.clear();
            }
            // The glyph's id, for the program's name for it (the structure
            // reader looks it up where the PDF's text is missing or not
            // text at all).
            let gid = match &**g {
                Glyph::Outline(o) => Some(o.glyph_id().to_u32()),
                _ => None,
            };
            text.push_str(&glyph_text);
            // The glyph's x and y scales in points per em: its matrix
            // maps the font's 1000-unit em onto the page.
            let sx = (a.hypot(b) * 1000.0) as f32;
            let sy = (c.hypot(d) * 1000.0) as f32;
            let mut advance = None;
            let mut ink_top: Option<f32> = None;
            let mut ink_bottom: Option<f32> = None;
            match &**g {
                Glyph::Outline(o) => {
                    if font_name.is_none() {
                        font_name = o.font_data().and_then(|d| d.postscript_name);
                    }
                    if face.is_none() {
                        face = o.font_data().map(|d| FontFace {
                            postscript_name: strip_subset(
                                d.postscript_name.as_deref().unwrap_or(""),
                            ),
                            weight: d.weight,
                            italic: d.is_italic,
                            serif: d.is_serif,
                        });
                    }
                    advance = o.advance_width().map(|w| w * sx / 1000.0);
                    if font_key.is_none() {
                        font_key = Some(o.font_cache_key());
                    }
                    let glyph_path = m * o.outline();
                    // The ink's height above the baseline, in ems: a
                    // lowercase letter drawn at cap height is All Caps.
                    let bb = glyph_path.bounding_box();
                    if bb.height() > 0.0 && sy > 0.0 {
                        ink_top = Some(((f - bb.y0) as f32 / sy).max(0.0));
                        ink_bottom = Some((f - bb.y1) as f32 / sy);
                    }
                    outlines.extend(contours_of(&glyph_path));
                }
                Glyph::Type3(t3) => {
                    // A Type 3 glyph is drawing operations: they arrive
                    // as paths, not as text.
                    self.loss("text.type3_as_paths");
                    t3.interpret(self, props.transform, g.transform(), &props.paint);
                }
            }
            glyphs.push(GlyphPos {
                text: glyph_text,
                x: e as f32,
                y: f as f32,
                advance,
                size: sy,
                hscale: if sy > 0.0 { sx / sy } else { 1.0 },
                ink_top,
                ink_bottom,
                gid,
                passed_code,
            });
        }
        if turn.is_none() && origins.len() >= 2 {
            turn = scaled_turn;
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
            glyphs,
            face,
            font_key,
            outline: false,
            turn,
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

/// A PostScript name without its subset prefix: `ABCDEF+Name` → `Name`.
pub(crate) fn strip_subset(name: &str) -> String {
    match name.split_once('+') {
        Some((tag, rest)) if tag.len() == 6 && tag.chars().all(|c| c.is_ascii_uppercase()) => {
            rest.to_string()
        }
        _ => name.to_string(),
    }
}

/// The text a glyph's name in its font program spells, read the Adobe
/// Glyph List's way: a suffix after the first period is dropped, ligature
/// parts join with `_`, `uniXXXX` and `uXXXX` name code points. A small
/// capital (`s.sc`, `s.smcp`, an expert set's `Ssmall`) is drawn as a
/// capital and reads as one, like the capitals a layout program maps
/// beside it. `None` when the font names nothing (a synthesized `gid12`)
/// or the name is not one of these.
pub(crate) fn glyph_name_text(font: &[u8], gid: u32) -> Option<String> {
    use skrifa::{raw::FontRef, GlyphId, GlyphNames};
    // A bare CFF program (a PDF's FontFile3) is wrapped as an OpenType
    // font with one table so the name reader can open it.
    let wrapped;
    let bytes: &[u8] = if matches!(
        font.get(..4),
        Some(b"OTTO" | b"true" | b"ttcf" | [0, 1, 0, 0])
    ) {
        font
    } else {
        let mut w = Vec::with_capacity(font.len() + 28);
        w.extend_from_slice(b"OTTO");
        w.extend_from_slice(&[0, 1, 0, 16, 0, 0, 0, 0]);
        w.extend_from_slice(b"CFF ");
        w.extend_from_slice(&[0, 0, 0, 0]);
        w.extend_from_slice(&28u32.to_be_bytes());
        w.extend_from_slice(&(font.len() as u32).to_be_bytes());
        w.extend_from_slice(font);
        wrapped = w;
        &wrapped
    };
    let face = FontRef::new(bytes).ok()?;
    let name = GlyphNames::new(&face).get(GlyphId::new(gid))?;
    name_text(name.as_str())
}

fn name_text(name: &str) -> Option<String> {
    let mut parts = name.split('.');
    let base = parts.next()?;
    if base.is_empty() {
        return None;
    }
    let small_cap = parts.any(|s| s == "sc" || s == "smcp" || s == "c2sc");
    let mut out = String::new();
    for part in base.split('_') {
        if let Some(letter) = part.strip_suffix("small") {
            if letter.len() == 1 && letter.chars().all(|c| c.is_ascii_alphabetic()) {
                out.push_str(&letter.to_ascii_uppercase());
                continue;
            }
        }
        out.push_str(&part_text(part)?);
    }
    Some(if small_cap { out.to_uppercase() } else { out })
}

fn part_text(part: &str) -> Option<String> {
    let hex = |h: &str| u32::from_str_radix(h, 16).ok().and_then(char::from_u32);
    if let Some(h) = part.strip_prefix("uni") {
        if h.len() >= 4 && h.len() % 4 == 0 && h.chars().all(|c| c.is_ascii_hexdigit()) {
            return (0..h.len() / 4)
                .map(|i| hex(&h[4 * i..4 * i + 4]))
                .collect();
        }
    }
    if let Some(h) = part.strip_prefix('u') {
        if (4..=6).contains(&h.len()) && h.chars().all(|c| c.is_ascii_hexdigit()) {
            return hex(h).map(String::from);
        }
    }
    if part.len() == 1 && part.chars().all(|c| c.is_ascii_alphabetic()) {
        return Some(part.to_string());
    }
    const NAMES: &[(&str, &str)] = &[
        ("zero", "0"),
        ("one", "1"),
        ("two", "2"),
        ("three", "3"),
        ("four", "4"),
        ("five", "5"),
        ("six", "6"),
        ("seven", "7"),
        ("eight", "8"),
        ("nine", "9"),
        ("space", " "),
        ("period", "."),
        ("comma", ","),
        ("colon", ":"),
        ("semicolon", ";"),
        ("hyphen", "-"),
        ("endash", "\u{2013}"),
        ("emdash", "\u{2014}"),
        ("quoteleft", "\u{2018}"),
        ("quoteright", "\u{2019}"),
        ("quotedblleft", "\u{201C}"),
        ("quotedblright", "\u{201D}"),
        ("quotesingle", "'"),
        ("quotedbl", "\""),
        ("exclam", "!"),
        ("question", "?"),
        ("parenleft", "("),
        ("parenright", ")"),
        ("bracketleft", "["),
        ("bracketright", "]"),
        ("ampersand", "&"),
        ("slash", "/"),
        ("at", "@"),
        ("numbersign", "#"),
        ("dollar", "$"),
        ("percent", "%"),
        ("asterisk", "*"),
        ("plus", "+"),
        ("equal", "="),
        ("bullet", "\u{2022}"),
        ("ellipsis", "\u{2026}"),
        ("copyright", "\u{00A9}"),
        ("registered", "\u{00AE}"),
        ("trademark", "\u{2122}"),
        ("degree", "\u{00B0}"),
        ("sterling", "\u{00A3}"),
        ("Euro", "\u{20AC}"),
        ("fi", "fi"),
        ("fl", "fl"),
        ("ff", "ff"),
        ("ffi", "ffi"),
        ("ffl", "ffl"),
    ];
    NAMES
        .iter()
        .find(|(n, _)| *n == part)
        .map(|(_, t)| t.to_string())
}

#[cfg(test)]
mod glyph_name_tests {
    use super::name_text;

    #[test]
    fn names_read_the_glyph_list_way() {
        assert_eq!(name_text("s.sc").as_deref(), Some("S"));
        assert_eq!(name_text("a.alt").as_deref(), Some("a"));
        assert_eq!(name_text("S").as_deref(), Some("S"));
        assert_eq!(name_text("Ssmall").as_deref(), Some("S"));
        assert_eq!(name_text("f_f_i").as_deref(), Some("ffi"));
        assert_eq!(name_text("uni00E9").as_deref(), Some("\u{e9}"));
        assert_eq!(name_text("u1F600").as_deref(), Some("\u{1F600}"));
        assert_eq!(name_text("three.onum").as_deref(), Some("3"));
        assert_eq!(name_text("gid12"), None);
    }
}

#[cfg(test)]
mod icc_tests {
    use super::icc_is_srgb;

    /// A profile of `space` with one `desc` tag holding `text`.
    fn profile(space: &[u8; 4], text: &[u8]) -> Vec<u8> {
        let mut p = vec![0u8; 128];
        p[16..20].copy_from_slice(space);
        p.extend_from_slice(&1u32.to_be_bytes());
        p.extend_from_slice(b"desc");
        p.extend_from_slice(&144u32.to_be_bytes());
        p.extend_from_slice(&(text.len() as u32).to_be_bytes());
        p.extend_from_slice(text);
        p
    }

    #[test]
    fn an_srgb_profile_is_read_as_the_engine_reads_rgb() {
        assert!(icc_is_srgb(&profile(
            b"RGB ",
            b"desc\0\0\0\0\0\0\0\x12sRGB IEC61966-2.1"
        )));
        let v4: Vec<u8> = "sRGB v4".bytes().flat_map(|b| [0, b]).collect();
        assert!(icc_is_srgb(&profile(b"RGB ", &v4)));
    }

    #[test]
    fn another_rgb_profile_or_a_cmyk_one_is_not() {
        assert!(!icc_is_srgb(&profile(b"RGB ", b"desc Adobe RGB (1998)")));
        assert!(!icc_is_srgb(&profile(b"CMYK", b"desc sRGB")));
        assert!(!icc_is_srgb(&[0u8; 40]));
    }
}
