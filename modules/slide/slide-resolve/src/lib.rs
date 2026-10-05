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

//! # slide-resolve — PowerPoint's inheritance rules, applied
//!
//! Turns the as-authored [`pptx_core::Presentation`] into a [`model::Deck`]:
//! every item in page points with absolute colours, resolved fonts and
//! evaluated outlines, and no inheritance left.
//!
//! * **Masters.** The engine has one master level, so each USED layout
//!   becomes one master page: the slide master's background and shapes
//!   (when the layout shows master shapes), then the layout's own background
//!   and shapes (ADR 700). Placeholders on masters and layouts are prompts,
//!   not art, and are not drawn.
//! * **Placeholders.** A slide placeholder finds its layout placeholder by
//!   `idx`, else by type, and the layout's finds the master's by type;
//!   position, body properties, list styles and shape properties inherit
//!   along that chain.
//! * **Groups** are flattened into page transforms: a child's centre maps
//!   through the group's child space, its size scales with the group, and
//!   rotations and flips compose.

use std::collections::BTreeMap;

use pptx_core::{
    Background, BodyProps, ColorMap, Fill, FrameContent, Geometry, Layout, Line, ListStyle, Master,
    Placeholder, Presentation, Shape, ShapeProps, ShapeStyle, Sp, Theme, Xfrm, EMU_PER_PT,
};

pub mod color;
pub mod model;
pub mod text;

use color::{resolve as resolve_color, ColorCtx, Rgba};
use model::*;

// ─── transforms ─────────────────────────────────────────────────────

/// `[a, b, c, d, tx, ty]`: x' = a·x + c·y + tx, y' = b·x + d·y + ty.
pub type Affine = [f64; 6];

const IDENTITY: Affine = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

fn mul(m: &Affine, n: &Affine) -> Affine {
    [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ]
}

fn apply(m: &Affine, p: (f64, f64)) -> (f64, f64) {
    (
        m[0] * p.0 + m[2] * p.1 + m[4],
        m[1] * p.0 + m[3] * p.1 + m[5],
    )
}

fn translate(x: f64, y: f64) -> Affine {
    [1.0, 0.0, 0.0, 1.0, x, y]
}

/// Rotation (degrees, clockwise on a y-down page) and flips about the origin.
fn orient(rot_deg: f64, flip_h: bool, flip_v: bool) -> Affine {
    let (s, c) = rot_deg.to_radians().sin_cos();
    let r = [c, s, -s, c, 0.0, 0.0];
    let f = [
        if flip_h { -1.0 } else { 1.0 },
        0.0,
        0.0,
        if flip_v { -1.0 } else { 1.0 },
        0.0,
        0.0,
    ];
    mul(&r, &f)
}

/// Where a shape tree's coordinates land: `map` takes a point of the
/// current coordinate space to the page, `scale` is how much a length in it
/// is stretched (group child spaces scale), `orient` is the accumulated
/// rotation / flip.
#[derive(Clone, Copy)]
struct Space {
    map: Affine,
    scale: (f64, f64),
    orient: Affine,
}

impl Space {
    const PAGE: Space = Space {
        map: IDENTITY,
        scale: (1.0, 1.0),
        orient: IDENTITY,
    };

    /// The page transform and size of a box placed by `x` in this space.
    fn place(&self, x: &Xfrm) -> (Affine, f64, f64) {
        let (ox, oy) = (x.off.0 as f64 / EMU_PER_PT, x.off.1 as f64 / EMU_PER_PT);
        let (w, h) = (x.ext.0 as f64 / EMU_PER_PT, x.ext.1 as f64 / EMU_PER_PT);
        let centre = apply(&self.map, (ox + w / 2.0, oy + h / 2.0));
        let (w, h) = (w * self.scale.0, h * self.scale.1);
        let o = mul(
            &self.orient,
            &orient(x.rot as f64 / 60_000.0, x.flip_h, x.flip_v),
        );
        let t = mul(
            &translate(centre.0, centre.1),
            &mul(&o, &translate(-w / 2.0, -h / 2.0)),
        );
        (t, w, h)
    }

    /// The space of a group's children.
    fn child(&self, x: &Xfrm) -> Space {
        let (t, w, h) = self.place(x);
        let ext = (x.ext.0 as f64 / EMU_PER_PT, x.ext.1 as f64 / EMU_PER_PT);
        let ch_off = x
            .ch_off
            .map(|o| (o.0 as f64 / EMU_PER_PT, o.1 as f64 / EMU_PER_PT))
            .unwrap_or((0.0, 0.0));
        let ch_ext = x
            .ch_ext
            .map(|e| (e.0 as f64 / EMU_PER_PT, e.1 as f64 / EMU_PER_PT))
            .unwrap_or(ext);
        let sx = if ch_ext.0 > 0.0 { w / ch_ext.0 } else { 1.0 };
        let sy = if ch_ext.1 > 0.0 { h / ch_ext.1 } else { 1.0 };
        // child space → the group's box (0..w, 0..h) → page.
        let to_box = [sx, 0.0, 0.0, sy, -ch_off.0 * sx, -ch_off.1 * sy];
        Space {
            map: mul(&t, &to_box),
            // A child-space length lands on the page stretched by the
            // group's (already page-scaled) box over its child extent.
            scale: (sx, sy),
            orient: mul(
                &self.orient,
                &orient(x.rot as f64 / 60_000.0, x.flip_h, x.flip_v),
            ),
        }
    }
}

// ─── context ────────────────────────────────────────────────────────

/// Where shapes are being resolved.
#[derive(Clone, Copy, PartialEq)]
enum Level {
    Master,
    Layout,
    Slide,
}

struct Ctx<'a> {
    deck: &'a Presentation,
    master: &'a Master,
    layout: Option<&'a Layout>,
    theme: Option<&'a Theme>,
    map: ColorMap,
    level: Level,
    next_id: &'a std::cell::Cell<u32>,
    diagnostics: &'a std::cell::RefCell<Vec<String>>,
    part: &'a str,
}

impl Ctx<'_> {
    fn id(&self) -> String {
        let n = self.next_id.get() + 1;
        self.next_id.set(n);
        format!("u{n:x}")
    }
    fn note(&self, what: impl Into<String>) {
        self.diagnostics
            .borrow_mut()
            .push(format!("{}: {}", self.part, what.into()));
    }
    fn colors(&self, placeholder: Option<Rgba>) -> ColorCtx<'_> {
        ColorCtx {
            theme: self.theme,
            map: &self.map,
            placeholder,
        }
    }
}

// ─── paint ──────────────────────────────────────────────────────────

fn style_color(ctx: &Ctx, r: &Option<pptx_core::StyleRef>) -> Option<Rgba> {
    r.as_ref()
        .and_then(|r| r.color.as_ref())
        .map(|c| resolve_color(c, &ctx.colors(None)))
}

fn paint(fill: &Fill, ctx: &Ctx, ph: Option<Rgba>) -> Paint {
    let colors = ctx.colors(ph);
    match fill {
        Fill::None | Fill::Group => Paint::None,
        Fill::Solid(c) => {
            let rgba = resolve_color(c, &colors);
            let theme = match &c.base {
                pptx_core::ColorBase::Scheme(s) if c.transforms.is_empty() => Some(s.clone()),
                _ => None,
            };
            Paint::Solid {
                rgb: rgba.bytes(),
                alpha: rgba.a,
                theme,
            }
        }
        Fill::Gradient(g) => {
            let mut stops: Vec<Stop> = g
                .stops
                .iter()
                .map(|(pos, c)| {
                    let rgba = resolve_color(c, &colors);
                    Stop {
                        pos: *pos as f64 / 1000.0,
                        rgb: rgba.bytes(),
                        alpha: rgba.a,
                    }
                })
                .collect();
            // `a:gsLst` need not be in position order; a gradient swatch's
            // stops are.
            stops.sort_by(|a, b| a.pos.total_cmp(&b.pos));
            if stops.is_empty() {
                return Paint::None;
            }
            if g.path.is_some() {
                Paint::Radial { stops }
            } else {
                Paint::Linear {
                    stops,
                    angle: g.linear.map(|(a, _)| a as f64 / 60_000.0).unwrap_or(0.0),
                }
            }
        }
        Fill::Blip(b) => match &b.part {
            Some(p) => Paint::Image { part: p.clone() },
            None => Paint::None,
        },
        Fill::Pattern { fg, .. } => {
            ctx.note("pattern fill drawn as its foreground colour");
            fg.as_ref()
                .map(|c| {
                    let rgba = resolve_color(c, &colors);
                    Paint::Solid {
                        rgb: rgba.bytes(),
                        alpha: rgba.a,
                        theme: None,
                    }
                })
                .unwrap_or(Paint::None)
        }
    }
}

/// `a:grpFill` means "the enclosing group's fill": substitute it into the
/// direct children that ask for it (a nested group passes it on the same way
/// when its own children resolve). Without a group fill they draw no fill.
fn inherit_group_fill<'a>(
    children: &'a [Shape],
    fill: Option<&Fill>,
) -> std::borrow::Cow<'a, [Shape]> {
    let asks = |p: &ShapeProps| matches!(p.fill, Some(Fill::Group));
    let any = children.iter().any(|c| match c {
        Shape::Sp(sp) => asks(&sp.props),
        Shape::Group(g) => asks(&g.props),
        _ => false,
    });
    if !any {
        return std::borrow::Cow::Borrowed(children);
    }
    let with = fill
        .filter(|f| !matches!(f, Fill::Group))
        .cloned()
        .unwrap_or(Fill::None);
    std::borrow::Cow::Owned(
        children
            .iter()
            .map(|c| {
                let mut c = c.clone();
                match &mut c {
                    Shape::Sp(sp) if asks(&sp.props) => sp.props.fill = Some(with.clone()),
                    Shape::Group(g) if asks(&g.props) => g.props.fill = Some(with.clone()),
                    _ => {}
                }
                c
            })
            .collect(),
    )
}

fn shape_fill(props: &ShapeProps, style: Option<&ShapeStyle>, ctx: &Ctx) -> Paint {
    if let Some(f) = &props.fill {
        return paint(f, ctx, None);
    }
    let Some(r) = style.and_then(|s| s.fill_ref.as_ref()) else {
        return Paint::None;
    };
    if r.idx == 0 {
        return Paint::None;
    }
    let theme = ctx.theme;
    let list = if r.idx >= 1001 {
        theme.map(|t| &t.background_fill_styles)
    } else {
        theme.map(|t| &t.fill_styles)
    };
    let i = if r.idx >= 1001 {
        r.idx - 1001
    } else {
        r.idx - 1
    } as usize;
    match list.and_then(|l| l.get(i)) {
        Some(f) => paint(f, ctx, style_color(ctx, &style.unwrap().fill_ref)),
        None => Paint::None,
    }
}

fn shape_stroke(props: &ShapeProps, style: Option<&ShapeStyle>, ctx: &Ctx) -> Option<Stroke> {
    let r = style
        .and_then(|s| s.line_ref.as_ref())
        .filter(|r| r.idx > 0);
    let base: Option<&Line> = r.and_then(|r| {
        ctx.theme
            .and_then(|t| t.line_styles.get(r.idx as usize - 1))
    });
    let own = props.line.as_ref();
    if base.is_none() && own.is_none() {
        return None;
    }
    let pick = |f: fn(&Line) -> Option<String>| own.and_then(f).or_else(|| base.and_then(f));
    let fill = own
        .and_then(|l| l.fill.clone())
        .or_else(|| base.and_then(|l| l.fill.clone()));
    let ph = style_color(ctx, &style.and_then(|s| s.line_ref.clone()));
    let p = match &fill {
        Some(f) => paint(f, ctx, ph),
        None => return None,
    };
    if matches!(p, Paint::None) {
        return None;
    }
    let width = own
        .and_then(|l| l.width)
        .or_else(|| base.and_then(|l| l.width))
        .unwrap_or(9525) as f64
        / EMU_PER_PT;
    Some(Stroke {
        width,
        paint: p,
        dash: pick(|l| l.dash.clone()).filter(|d| d != "solid"),
        cap: pick(|l| l.cap.clone()),
        join: pick(|l| l.join.clone()),
        head: own
            .and_then(|l| l.head.as_ref())
            .map(|e| e.kind.clone())
            .filter(|k| k != "none"),
        tail: own
            .and_then(|l| l.tail.as_ref())
            .map(|e| e.kind.clone())
            .filter(|k| k != "none"),
    })
}

fn shadow(props: &ShapeProps, style: Option<&ShapeStyle>, ctx: &Ctx) -> Option<Shadow> {
    let fx = props.effects.clone().or_else(|| {
        let r = style
            .and_then(|s| s.effect_ref.as_ref())
            .filter(|r| r.idx > 0)?;
        ctx.theme?
            .effect_styles
            .get(r.idx as usize - 1)
            .cloned()
            .flatten()
    })?;
    let s = fx.outer_shadow?;
    let dist = s.dist as f64 / EMU_PER_PT;
    let dir = (s.dir as f64 / 60_000.0).to_radians();
    let rgba = resolve_color(&s.color, &ctx.colors(None));
    Some(Shadow {
        dx: dist * dir.cos(),
        dy: dist * dir.sin(),
        blur: s.blur as f64 / EMU_PER_PT,
        rgb: rgba.bytes(),
        alpha: rgba.a,
    })
}

// ─── placeholders ───────────────────────────────────────────────────

fn canonical(kind: Option<&str>) -> &str {
    match kind {
        None | Some("obj") => "body",
        Some("ctrTitle") => "title",
        Some(k) => k,
    }
}

/// The placeholder shape in `shapes` that `ph` inherits from.
fn find_placeholder<'a>(
    shapes: &'a [Shape],
    ph: &pptx_core::Placeholder,
    by_idx: bool,
) -> Option<&'a Sp> {
    let sps = shapes.iter().filter_map(|s| match s {
        Shape::Sp(sp) if sp.nv.placeholder.is_some() => Some(sp),
        _ => None,
    });
    let cands: Vec<&Sp> = sps.collect();
    if by_idx {
        if let Some(idx) = ph.idx {
            if let Some(sp) = cands
                .iter()
                .find(|s| s.nv.placeholder.as_ref().unwrap().idx == Some(idx))
            {
                return Some(sp);
            }
        }
    }
    let want = canonical(ph.kind.as_deref());
    cands
        .iter()
        .find(|s| s.nv.placeholder.as_ref().unwrap().kind.as_deref() == ph.kind.as_deref())
        .or_else(|| {
            cands
                .iter()
                .find(|s| canonical(s.nv.placeholder.as_ref().unwrap().kind.as_deref()) == want)
        })
        .copied()
}

/// The inheritance chain of a shape: itself first, then its layout and
/// master placeholders.
fn chain<'a>(sp: &'a Sp, ctx: &Ctx<'a>) -> Vec<&'a Sp> {
    let mut out = vec![sp];
    out.extend(ancestors(sp.nv.placeholder.as_ref(), ctx));
    out
}

/// The layout and master placeholders a placeholder inherits from, nearest
/// first (by `idx`, then by type).
fn ancestors<'a>(ph: Option<&Placeholder>, ctx: &Ctx<'a>) -> Vec<&'a Sp> {
    let mut out = Vec::new();
    let Some(ph) = ph else {
        return out;
    };
    if ctx.level == Level::Slide {
        if let Some(l) = ctx
            .layout
            .and_then(|l| find_placeholder(&l.shapes, ph, true))
        {
            out.push(l);
            if let Some(m) =
                l.nv.placeholder
                    .as_ref()
                    .and_then(|lp| find_placeholder(&ctx.master.shapes, lp, false))
            {
                out.push(m);
            }
            return out;
        }
    }
    if ctx.level != Level::Master {
        if let Some(m) = find_placeholder(&ctx.master.shapes, ph, false) {
            out.push(m);
        }
    }
    out
}

fn merge_body(chain: &[&Sp]) -> BodyProps {
    let mut b = BodyProps::default();
    for sp in chain.iter().rev() {
        let Some(t) = &sp.text else { continue };
        let s = &t.body;
        macro_rules! take { ($($f:ident),*) => { $( if s.$f.is_some() { b.$f = s.$f.clone(); } )* }; }
        take!(
            anchor,
            anchor_center,
            wrap,
            vert,
            rot,
            columns,
            column_spacing,
            autofit
        );
        if s.insets.0.is_some() {
            b.insets.0 = s.insets.0;
        }
        if s.insets.1.is_some() {
            b.insets.1 = s.insets.1;
        }
        if s.insets.2.is_some() {
            b.insets.2 = s.insets.2;
        }
        if s.insets.3.is_some() {
            b.insets.3 = s.insets.3;
        }
    }
    b
}

// ─── shapes ─────────────────────────────────────────────────────────

fn outline(geometry: Option<&Geometry>, w: f64, h: f64) -> slide_geom::Outline {
    match geometry {
        Some(Geometry::Preset { name, adjust }) => slide_geom::preset(name, adjust, w, h)
            .unwrap_or_else(|| slide_geom::preset("rect", &[], w, h).unwrap()),
        Some(Geometry::Custom(c)) => slide_geom::custom(c, w, h),
        None => slide_geom::preset("rect", &[], w, h).unwrap(),
    }
}

fn text_frame(
    chain: &[&Sp],
    rect: (f64, f64, f64, f64),
    w: f64,
    h: f64,
    ctx: &Ctx,
) -> Option<TextFrame> {
    let own = chain[0].text.as_ref()?;
    if own.paragraphs.iter().all(|p| p.runs.is_empty()) {
        return None;
    }
    let body = merge_body(chain);
    let emu = |v: Option<i64>, d: i64| v.unwrap_or(d) as f64 / EMU_PER_PT;
    let inset = (
        emu(body.insets.0, 91_440),
        emu(body.insets.1, 45_720),
        emu(body.insets.2, 91_440),
        emu(body.insets.3, 45_720),
    );
    let shrink = match &body.autofit {
        Some(pptx_core::Autofit::Normal {
            font_scale,
            line_spacing_reduction,
        }) => Some((
            font_scale.unwrap_or(100_000) as f64 / 100_000.0,
            line_spacing_reduction.unwrap_or(0) as f64 / 100_000.0,
        )),
        _ => None,
    };
    // List styles, lowest priority first.
    let ph_kind = chain[0]
        .nv
        .placeholder
        .as_ref()
        .map(|p| canonical(p.kind.as_deref()).to_string());
    let mut lists: Vec<&ListStyle> = Vec::new();
    let (prefix, txstyle) = match ph_kind.as_deref() {
        Some("title") => (Some("Title"), ctx.master.title_style.as_ref()),
        Some("body") | Some("subTitle") => (Some("Body"), ctx.master.body_style.as_ref()),
        Some(_) => (Some("Other"), ctx.master.other_style.as_ref()),
        None => (None, None),
    };
    if txstyle.is_none() {
        if let Some(d) = &ctx.deck.default_text_style {
            lists.push(d);
        }
    }
    if let Some(t) = txstyle {
        lists.push(t);
    }
    for sp in chain.iter().rev() {
        if let Some(ls) = sp.text.as_ref().and_then(|t| t.list_style.as_ref()) {
            lists.push(ls);
        }
    }
    let colors = ctx.colors(None);
    let (major, minor) = match ctx.theme {
        Some(t) => (&t.major_font, &t.minor_font),
        None => (&EMPTY_FONTS, &EMPTY_FONTS),
    };
    let font_ref = chain
        .iter()
        .find_map(|sp| sp.style.as_ref().and_then(|s| s.font_ref.clone()))
        .map(|(idx, c)| (idx, c.map(|c| resolve_color(&c, &colors))));
    let tctx = text::TextCtx {
        lists,
        colors: &colors,
        major,
        minor,
        font_ref,
        style_prefix: prefix,
        shrink,
    };
    let anchor = match body.anchor.as_deref() {
        Some("ctr") => "middle",
        Some("b") => "bottom",
        _ => "top",
    };
    let rotation = match body.vert.as_deref() {
        Some("vert") | Some("eaVert") => 90.0,
        Some("vert270") => 270.0,
        _ => 0.0,
    };
    let _ = (w, h);
    Some(TextFrame {
        inset,
        rect,
        anchor: anchor.to_string(),
        wrap: body.wrap.unwrap_or(true),
        columns: body.columns.unwrap_or(1).max(1),
        column_gap: emu(body.column_spacing, 0),
        grow: matches!(body.autofit, Some(pptx_core::Autofit::Shape)),
        shrink,
        rotation,
        paragraphs: text::body(own, &tctx),
    })
}

static EMPTY_FONTS: pptx_core::FontSet = pptx_core::FontSet {
    latin: None,
    east_asian: None,
    complex: None,
};

fn shape(s: &Shape, space: &Space, ctx: &Ctx) -> Option<Item> {
    match s {
        Shape::Sp(sp) | Shape::Connector(sp) => {
            if sp.nv.hidden {
                return None;
            }
            // On masters and layouts a placeholder is a prompt, not art.
            if sp.nv.placeholder.is_some() && ctx.level != Level::Slide {
                return None;
            }
            let chain = chain(sp, ctx);
            let x = chain.iter().find_map(|s| s.props.xfrm.clone())?;
            let (t, w, h) = space.place(&x);
            let geometry = chain.iter().find_map(|s| s.props.geometry.as_ref());
            let o = outline(geometry, w, h);
            // Fill / line / effects: the shape's own, else the placeholder chain's.
            let props = chain
                .iter()
                .find(|s| s.props.fill.is_some())
                .map(|s| &s.props)
                .unwrap_or(&sp.props);
            let style = chain.iter().find_map(|s| s.style.as_ref());
            let fill = if sp.use_bg_fill {
                Paint::None
            } else {
                shape_fill(props, style, ctx)
            };
            let line_props = chain
                .iter()
                .find(|s| s.props.line.is_some())
                .map(|s| &s.props)
                .unwrap_or(&sp.props);
            let stroke = shape_stroke(line_props, style, ctx);
            let text = text_frame(&chain, o.text_rect, w, h, ctx);
            if matches!(fill, Paint::None) && stroke.is_none() && text.is_none() {
                return None;
            }
            // The engine has no per-colour alpha, so a translucent colour
            // becomes item opacity: the fill's, or the stroke's when the
            // shape has no fill (or both carry the same alpha).
            // The engine has no per-colour alpha, so a translucent paint
            // becomes item opacity: the fill's, or the stroke's when the
            // shape has no fill (or both carry the same alpha). A gradient
            // whose stops differ in alpha is written as a gradient feather
            // instead (slide-idml).
            let alpha_of = |p: &Paint| p.uniform_alpha().unwrap_or(1.0);
            let stroke_alpha = stroke.as_ref().map(|s| alpha_of(&s.paint));
            let opacity = if text.is_some() {
                1.0
            } else {
                match (&fill, stroke_alpha) {
                    (Paint::None, Some(a)) => a,
                    (f, Some(a)) if (alpha_of(f) - a).abs() < 1e-3 => a,
                    (f, None) => alpha_of(f),
                    (f, Some(_)) => alpha_of(f),
                }
            };
            Some(Item {
                id: ctx.id(),
                name: sp.nv.name.clone(),
                transform: t,
                w,
                h,
                kind: ItemKind::Shape {
                    outline: o.subpaths,
                    fill,
                    stroke,
                    text,
                },
                opacity,
                shadow: shadow(&sp.props, style, ctx),
                meta: ItemMeta {
                    shape_id: sp.nv.id,
                    order: 0,
                    placeholder: sp
                        .nv
                        .placeholder
                        .as_ref()
                        .map(|p| (canonical(p.kind.as_deref()).to_string(), p.idx)),
                    preset: match geometry {
                        Some(Geometry::Preset { name, adjust }) => {
                            Some((name.clone(), adjust.clone()))
                        }
                        _ => None,
                    },
                },
            })
        }
        Shape::Pic(p) => {
            if p.nv.hidden {
                return None;
            }
            let Some(part) = p.blip.part.clone() else {
                ctx.note(format!("picture {:?} has no embedded image", p.nv.name));
                return None;
            };
            // A picture placeholder may leave its box, outline and line
            // to the layout's (or master's) placeholder.
            let up = ancestors(p.nv.placeholder.as_ref(), ctx);
            let x = p
                .props
                .xfrm
                .clone()
                .or_else(|| up.iter().find_map(|a| a.props.xfrm.clone()))?;
            let (t, w, h) = space.place(&x);
            let geometry = p
                .props
                .geometry
                .as_ref()
                .or_else(|| up.iter().find_map(|a| a.props.geometry.as_ref()));
            let o = outline(geometry, w, h);
            let line_props = std::iter::once(&p.props)
                .chain(up.iter().map(|a| &a.props))
                .find(|pr| pr.line.is_some())
                .unwrap_or(&p.props);
            let crop = p
                .blip
                .src_rect
                .map(|(l, t, r, b)| {
                    (
                        l as f64 / 100_000.0,
                        t as f64 / 100_000.0,
                        r as f64 / 100_000.0,
                        b as f64 / 100_000.0,
                    )
                })
                .unwrap_or((0.0, 0.0, 0.0, 0.0));
            Some(Item {
                id: ctx.id(),
                name: p.nv.name.clone(),
                transform: t,
                w,
                h,
                kind: ItemKind::Picture {
                    outline: o.subpaths,
                    stroke: shape_stroke(line_props, p.style.as_ref(), ctx),
                    image_part: part,
                    crop,
                },
                opacity: p.blip.alpha.map(|a| a as f64 / 100_000.0).unwrap_or(1.0),
                shadow: shadow(&p.props, p.style.as_ref(), ctx),
                meta: ItemMeta {
                    shape_id: p.nv.id,
                    ..Default::default()
                },
            })
        }
        Shape::Group(g) => {
            if g.nv.hidden {
                return None;
            }
            let x = g.props.xfrm.clone().unwrap_or_default();
            let inner = space.child(&x);
            let children = inherit_group_fill(&g.children, g.props.fill.as_ref());
            let children: Vec<Item> = ordered(&children, &inner, ctx);
            if children.is_empty() {
                return None;
            }
            let (t, w, h) = space.place(&x);
            Some(Item {
                id: ctx.id(),
                name: g.nv.name.clone(),
                transform: t,
                w,
                h,
                kind: ItemKind::Group { children },
                opacity: 1.0,
                shadow: None,
                meta: ItemMeta {
                    shape_id: g.nv.id,
                    ..Default::default()
                },
            })
        }
        Shape::Frame(f) => match &f.content {
            FrameContent::Table(tbl) => {
                let x = f.xfrm.clone()?;
                let (t, w, h) = space.place(&x);
                Some(Item {
                    id: ctx.id(),
                    name: f.nv.name.clone(),
                    transform: t,
                    w,
                    h,
                    kind: ItemKind::Table(table(tbl, ctx)),
                    opacity: 1.0,
                    shadow: None,
                    meta: ItemMeta {
                        shape_id: f.nv.id,
                        ..Default::default()
                    },
                })
            }
            FrameContent::Chart { .. } => {
                ctx.note(format!("chart {:?} not drawn yet", f.nv.name));
                None
            }
            FrameContent::Diagram { .. } => {
                ctx.note(format!("SmartArt {:?} not drawn yet", f.nv.name));
                None
            }
            FrameContent::Other { uri } => {
                ctx.note(format!("graphic frame {uri:?} not drawn"));
                None
            }
        },
        Shape::Unknown { name, .. } => {
            ctx.note(format!("p:{name} not drawn"));
            None
        }
    }
}

/// Resolve a shape tree, numbering each item by its place in the tree.
fn ordered(shapes: &[Shape], space: &Space, ctx: &Ctx) -> Vec<Item> {
    shapes
        .iter()
        .enumerate()
        .filter_map(|(i, s)| {
            let mut it = shape(s, space, ctx)?;
            it.meta.order = i + 1;
            Some(it)
        })
        .collect()
}

fn table(t: &pptx_core::Table, ctx: &Ctx) -> Table {
    if let Some(id) = &t.style_id {
        ctx.note(format!(
            "table style {id} not applied (explicit cell formatting only)"
        ));
    }
    let colors = ctx.colors(None);
    let (major, minor) = match ctx.theme {
        Some(t) => (&t.major_font, &t.minor_font),
        None => (&EMPTY_FONTS, &EMPTY_FONTS),
    };
    let lists: Vec<&ListStyle> = ctx.deck.default_text_style.iter().collect();
    let tctx = text::TextCtx {
        lists,
        colors: &colors,
        major,
        minor,
        font_ref: None,
        style_prefix: None,
        shrink: None,
    };
    Table {
        columns: t.columns.iter().map(|w| *w as f64 / EMU_PER_PT).collect(),
        rows: t
            .rows
            .iter()
            .map(|r| {
                (
                    r.height as f64 / EMU_PER_PT,
                    r.cells
                        .iter()
                        .map(|c| Cell {
                            span: (c.row_span.max(1), c.grid_span.max(1)),
                            merged: c.h_merge || c.v_merge,
                            fill: c
                                .fill
                                .as_ref()
                                .map(|f| paint(f, ctx, None))
                                .unwrap_or(Paint::None),
                            borders: c.borders.clone().map(|b| {
                                b.and_then(|l| {
                                    let props = ShapeProps {
                                        line: Some(l),
                                        ..Default::default()
                                    };
                                    shape_stroke(&props, None, ctx)
                                })
                            }),
                            text: c.text.as_ref().map(|tb| TextFrame {
                                inset: (
                                    c.margins.0.unwrap_or(91_440) as f64 / EMU_PER_PT,
                                    c.margins.2.unwrap_or(45_720) as f64 / EMU_PER_PT,
                                    c.margins.1.unwrap_or(91_440) as f64 / EMU_PER_PT,
                                    c.margins.3.unwrap_or(45_720) as f64 / EMU_PER_PT,
                                ),
                                rect: (0.0, 0.0, 0.0, 0.0),
                                anchor: match c.anchor.as_deref() {
                                    Some("ctr") => "middle",
                                    Some("b") => "bottom",
                                    _ => "top",
                                }
                                .to_string(),
                                wrap: true,
                                columns: 1,
                                column_gap: 0.0,
                                grow: false,
                                shrink: None,
                                rotation: 0.0,
                                paragraphs: text::body(tb, &tctx),
                            }),
                        })
                        .collect(),
                )
            })
            .collect(),
    }
}

fn background(bg: &Background, ctx: &Ctx, w: f64, h: f64) -> Option<Item> {
    let fill = match bg {
        Background::Fill(f) => paint(f, ctx, None),
        Background::StyleRef { idx, color } => {
            let ph = color.as_ref().map(|c| resolve_color(c, &ctx.colors(None)));
            let i = idx.checked_sub(1001)? as usize;
            let f = ctx.theme?.background_fill_styles.get(i)?;
            paint(f, ctx, ph)
        }
    };
    if matches!(fill, Paint::None) {
        return None;
    }
    let o = slide_geom::preset("rect", &[], w, h).unwrap();
    Some(Item {
        id: ctx.id(),
        name: "Background".into(),
        transform: IDENTITY,
        w,
        h,
        kind: ItemKind::Shape {
            outline: o.subpaths,
            fill,
            stroke: None,
            text: None,
        },
        opacity: 1.0,
        shadow: None,
        meta: ItemMeta::default(),
    })
}

fn overlay(base: &ColorMap, over: Option<&ColorMap>) -> ColorMap {
    match over {
        Some(o) if !o.entries.is_empty() => o.clone(),
        _ => base.clone(),
    }
}

/// Resolve a deck.
pub fn resolve(deck: &Presentation) -> Deck {
    let (w, h) = (
        deck.slide_size.0 as f64 / EMU_PER_PT,
        deck.slide_size.1 as f64 / EMU_PER_PT,
    );
    let next_id = std::cell::Cell::new(0u32);
    let diagnostics = std::cell::RefCell::new(Vec::new());
    let mut out = Deck {
        width: w,
        height: h,
        ..Default::default()
    };

    // One master page per used layout, in first-use order.
    let mut master_ids: BTreeMap<String, String> = BTreeMap::new();
    let mut order: Vec<&str> = Vec::new();
    for s in &deck.slides {
        if let Some(lp) = s.layout_part.as_deref() {
            if !order.contains(&lp) {
                order.push(lp);
            }
        }
    }
    for (i, lp) in order.iter().enumerate() {
        let Some(layout) = deck.layout(lp) else {
            continue;
        };
        let Some(master) = deck.master(&layout.master_part) else {
            continue;
        };
        let theme = master.theme_part.as_deref().and_then(|t| deck.theme(t));
        let id = format!("m{}", i + 1);
        let mut items = Vec::new();
        let mctx = Ctx {
            deck,
            master,
            layout: None,
            theme,
            map: master.color_map.clone(),
            level: Level::Master,
            next_id: &next_id,
            diagnostics: &diagnostics,
            part: &master.part,
        };
        let lctx = Ctx {
            layout: Some(layout),
            map: overlay(&master.color_map, layout.color_map_override.as_ref()),
            level: Level::Layout,
            part: &layout.part,
            ..mctx
        };
        let bg = layout
            .background
            .as_ref()
            .map(|b| (b, &lctx))
            .or(master.background.as_ref().map(|b| (b, &mctx)));
        if let Some((b, c)) = bg {
            items.extend(background(b, c, w, h));
        }
        if layout.show_master_shapes {
            items.extend(ordered(&master.shapes, &Space::PAGE, &mctx));
        }
        items.extend(ordered(&layout.shapes, &Space::PAGE, &lctx));
        master_ids.insert(lp.to_string(), id.clone());
        out.masters.push(MasterPage {
            id,
            name: layout
                .name
                .clone()
                .unwrap_or_else(|| format!("Layout {}", i + 1)),
            layout_part: lp.to_string(),
            master_part: master.part.clone(),
            items,
        });
        if out.theme_colors.is_empty() {
            if let Some(t) = theme {
                let cc = ColorCtx {
                    theme: Some(t),
                    map: &master.color_map,
                    placeholder: None,
                };
                out.theme_colors = t
                    .colors
                    .iter()
                    .map(|(k, c)| (k.clone(), resolve_color(c, &cc).bytes()))
                    .collect();
            }
        }
    }

    for (i, s) in deck.slides.iter().enumerate() {
        let layout = s.layout_part.as_deref().and_then(|lp| deck.layout(lp));
        let master = layout
            .and_then(|l| deck.master(&l.master_part))
            .or(deck.masters.first());
        let Some(master) = master else { continue };
        let theme = master.theme_part.as_deref().and_then(|t| deck.theme(t));
        let base_map = overlay(
            &master.color_map,
            layout.and_then(|l| l.color_map_override.as_ref()),
        );
        let ctx = Ctx {
            deck,
            master,
            layout,
            theme,
            map: overlay(&base_map, s.color_map_override.as_ref()),
            level: Level::Slide,
            next_id: &next_id,
            diagnostics: &diagnostics,
            part: &s.part,
        };
        let mut items = Vec::new();
        if let Some(b) = &s.background {
            items.extend(background(b, &ctx, w, h));
        }
        items.extend(ordered(&s.shapes, &Space::PAGE, &ctx));
        out.slides.push(SlidePage {
            id: format!("p{}", i + 1),
            index: i,
            part: s.part.clone(),
            master: s
                .layout_part
                .as_ref()
                .and_then(|lp| master_ids.get(lp).cloned()),
            show_master_items: s.show_master_shapes,
            items,
            hidden: s.hidden,
            notes: s
                .notes
                .as_ref()
                .map(text::plain)
                .filter(|n| !n.trim().is_empty()),
            transition: s.transition.clone(),
            timing_xml: s.timing_xml.clone(),
        });
    }

    let mut fonts = std::collections::BTreeSet::new();
    fn collect(items: &[Item], fonts: &mut std::collections::BTreeSet<String>) {
        for it in items {
            match &it.kind {
                ItemKind::Shape { text: Some(t), .. } => {
                    for p in &t.paragraphs {
                        for r in &p.runs {
                            fonts.insert(r.font.clone());
                        }
                    }
                }
                ItemKind::Group { children } => collect(children, fonts),
                ItemKind::Table(t) => {
                    for (_, cells) in &t.rows {
                        for c in cells {
                            for p in c.text.iter().flat_map(|t| &t.paragraphs) {
                                for r in &p.runs {
                                    fonts.insert(r.font.clone());
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    for m in &out.masters {
        collect(&m.items, &mut fonts);
    }
    for s in &out.slides {
        collect(&s.items, &mut fonts);
    }
    out.fonts = fonts.into_iter().collect();
    let mut d = deck.diagnostics.clone();
    d.extend(diagnostics.into_inner());
    d.sort();
    d.dedup();
    out.diagnostics = d;
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use pptx_core::{Color, ColorBase, Group, Sp};

    fn sp(fill: Option<Fill>) -> Shape {
        let mut s = Sp::default();
        s.props.fill = fill;
        Shape::Sp(s)
    }

    #[test]
    fn grp_fill_takes_the_enclosing_groups_fill() {
        let red = Fill::Solid(Color {
            base: ColorBase::Srgb(0xC01010),
            transforms: vec![],
        });
        let inner = Shape::Group(Group {
            nv: Default::default(),
            props: ShapeProps {
                fill: Some(Fill::Group),
                ..Default::default()
            },
            children: vec![sp(Some(Fill::Group))],
        });
        let kids = vec![sp(Some(Fill::Group)), sp(None), inner];
        let out = inherit_group_fill(&kids, Some(&red));
        let fill_of = |s: &Shape| match s {
            Shape::Sp(s) => s.props.fill.clone(),
            Shape::Group(g) => g.props.fill.clone(),
            _ => None,
        };
        assert_eq!(fill_of(&out[0]), Some(red.clone()));
        assert_eq!(fill_of(&out[1]), None);
        // The nested group takes the fill, and hands it on when its own
        // children resolve.
        assert_eq!(fill_of(&out[2]), Some(red.clone()));
        let Shape::Group(g) = &out[2] else { panic!() };
        let nested = inherit_group_fill(&g.children, g.props.fill.as_ref());
        assert_eq!(fill_of(&nested[0]), Some(red));
        // No group fill: a grpFill child draws nothing.
        let none = inherit_group_fill(&kids, None);
        assert_eq!(fill_of(&none[0]), Some(Fill::None));
    }
}
