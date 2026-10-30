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
//! * **Masters** (ADR 712). Each slide master is a master page (its
//!   background and shapes, placeholders included), and each of its layouts,
//!   used or not, a master page based on it (the engine's two-level
//!   masters, engine ADR 1026). A layout hides the master's placeholders
//!   (it has its own) and, when it hides master shapes, the master's art; a
//!   layout with a background of its own draws the master's art again over
//!   it. A slide hides every placeholder of its layout: its own placeholders
//!   stand in for them.
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

mod chart;
pub mod color;
pub mod model;
mod table;
pub mod table_styles;
pub mod text;
pub mod theme;

use color::{resolve as resolve_color, ColorCtx, Rgba};
use model::*;
use paged_ooxml::drawingml::resolved;

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
    draw: &'a ChartDrawer<'a>,
    /// The theme's prefix in theme colour keys, when it is not the deck's
    /// first theme (slide ADR 713).
    theme_tag: Option<String>,
}

/// A style reference's colour (`phClr`): its value and its theme key.
pub(crate) type Ph = (Rgba, Option<String>);

/// Draws a chart frame: the chart part, the frame's width and height (pt)
/// → the chart's primitives in the frame's points, or `None` for
/// `slide-chart`'s layout of the deck's chart model (ADR 715: a live chart
/// the deck's layout does not draw is drawn by paged.sheet).
pub type ChartDrawer<'a> = dyn Fn(&str, f64, f64) -> Option<Vec<slide_chart::Prim>> + 'a;

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
    fn colors(&self, placeholder: Option<Ph>) -> ColorCtx<'_> {
        let (placeholder, placeholder_key) = match placeholder {
            Some((c, k)) => (Some(c), k),
            None => (None, None),
        };
        ColorCtx {
            theme: self.theme,
            map: &self.map,
            placeholder,
            placeholder_key,
            theme_tag: self.theme_tag.as_deref(),
        }
    }
    /// A style reference's colour as `phClr`.
    fn ph(&self, c: &pptx_core::Color) -> Ph {
        let cc = self.colors(None);
        (resolve_color(c, &cc), cc.key(c))
    }
}

// ─── paint ──────────────────────────────────────────────────────────

fn style_color(ctx: &Ctx, r: &Option<pptx_core::StyleRef>) -> Option<Ph> {
    r.as_ref().and_then(|r| r.color.as_ref()).map(|c| ctx.ph(c))
}

fn paint(fill: &Fill, ctx: &Ctx, ph: Option<Ph>) -> Paint {
    resolved::paint(fill, &ctx.colors(ph), &mut |n| ctx.note(n))
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
    // The shape's own line over the theme's line style, field by field;
    // the line ends are the shape's own.
    fn pick<T: Clone>(
        own: Option<&Line>,
        base: Option<&Line>,
        f: fn(&Line) -> Option<T>,
    ) -> Option<T> {
        own.and_then(f).or_else(|| base.and_then(f))
    }
    let merged = Line {
        width: pick(own, base, |l| l.width),
        fill: pick(own, base, |l| l.fill.clone()),
        dash: pick(own, base, |l| l.dash.clone()),
        custom_dash: pick(own, base, |l| {
            (!l.custom_dash.is_empty()).then(|| l.custom_dash.clone())
        })
        .unwrap_or_default(),
        cap: pick(own, base, |l| l.cap.clone()),
        join: pick(own, base, |l| l.join.clone()),
        miter_limit: pick(own, base, |l| l.miter_limit),
        compound: pick(own, base, |l| l.compound.clone()),
        align: pick(own, base, |l| l.align.clone()),
        head: own.and_then(|l| l.head.clone()),
        tail: own.and_then(|l| l.tail.clone()),
    };
    let ph = style_color(ctx, &style.and_then(|s| s.line_ref.clone()));
    resolved::stroke(&merged, &ctx.colors(ph), 9525, &mut |n| ctx.note(n))
}

/// The effects a shape draws: its own `a:effectLst`, else the theme's
/// effect style its `a:effectRef` names (whose `phClr` is the reference's
/// colour).
fn effects(props: &ShapeProps, style: Option<&ShapeStyle>, ctx: &Ctx) -> Effects {
    let (fx, ph) = match &props.effects {
        Some(fx) => (Some(fx.clone()), None),
        None => {
            let r = style
                .and_then(|s| s.effect_ref.as_ref())
                .filter(|r| r.idx > 0);
            let fx = r.and_then(|r| {
                ctx.theme?
                    .effect_styles
                    .get(r.idx as usize - 1)
                    .cloned()
                    .flatten()
            });
            (
                fx,
                style_color(ctx, &style.and_then(|s| s.effect_ref.clone())),
            )
        }
    };
    fx.map(|fx| resolved::effects(&fx, &ctx.colors(ph), &mut |n| ctx.note(n)))
        .unwrap_or_default()
}

/// A shape style as an object style (slide ADR 719): its references as
/// text, a name, and the fill and line it gives a shape with no fill or
/// line of its own.
fn shape_style_look(st: &ShapeStyle, ctx: &Ctx) -> ShapeStyleLook {
    let key = |c: Option<&pptx_core::Color>| -> String {
        match c {
            Some(c) => ctx
                .colors(None)
                .key(c)
                .unwrap_or_else(|| format!("#{:06X}", resolve_color(c, &ctx.colors(None)).hex())),
            None => "-".into(),
        }
    };
    let r = |name: &str, r: &Option<pptx_core::StyleRef>| match r {
        Some(r) => format!("{name}{}:{}", r.idx, key(r.color.as_ref())),
        None => format!("{name}-"),
    };
    let font = match &st.font_ref {
        Some((idx, c)) => format!("font:{idx}:{}", key(c.as_ref())),
        None => "font-".into(),
    };
    let refs = format!(
        "{} {} {} {font}",
        r("line", &st.line_ref),
        r("fill", &st.fill_ref),
        r("effect", &st.effect_ref)
    );
    // Named by the fill's colour, as PowerPoint's Shape Styles gallery
    // names its rows (`Colored Fill - Accent 1`).
    let colour = st
        .fill_ref
        .as_ref()
        .and_then(|f| f.color.as_ref())
        .or(st.line_ref.as_ref().and_then(|l| l.color.as_ref()))
        .and_then(|c| ctx.colors(None).key(c))
        .and_then(|k| theme::Key::parse(&k))
        .map(|k| k.name())
        .unwrap_or_else(|| "Custom".into());
    let n = |r: &Option<pptx_core::StyleRef>| r.as_ref().map(|r| r.idx).unwrap_or(0);
    let name = format!(
        "Shape Style: {colour} (fill {}, line {}, effect {})",
        n(&st.fill_ref),
        n(&st.line_ref),
        n(&st.effect_ref)
    );
    let bare = ShapeProps::default();
    ShapeStyleLook {
        refs,
        name,
        fill: shape_fill(&bare, Some(st), ctx),
        stroke: shape_stroke(&bare, Some(st), ctx),
    }
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
    let inherited = lists.len();
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
        .map(|(idx, c)| (idx, c.map(|c| ctx.ph(&c))));
    let tctx = text::TextCtx {
        lists,
        inherited,
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
            // On masters and layouts a placeholder is a prompt: an item of
            // the layout (slide ADR 712) that every slide hides, as its own
            // placeholder overrides it or it has none.
            let prompt = sp.nv.placeholder.is_some() && ctx.level != Level::Slide;
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
            // A SmartArt shape's text box (`txXfrm`) is its own rectangle
            // in the shape's coordinate space.
            let text_rect = match (&sp.text_xfrm, &sp.props.xfrm) {
                (Some(tx), Some(x)) => {
                    let l = (tx.off.0 - x.off.0) as f64 / EMU_PER_PT;
                    let t = (tx.off.1 - x.off.1) as f64 / EMU_PER_PT;
                    (
                        l,
                        t,
                        l + tx.ext.0 as f64 / EMU_PER_PT,
                        t + tx.ext.1 as f64 / EMU_PER_PT,
                    )
                }
                _ => o.text_rect,
            };
            let text = text_frame(&chain, text_rect, w, h, ctx);
            if matches!(fill, Paint::None) && stroke.is_none() && text.is_none() && !prompt {
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
                effects: effects(&sp.props, style, ctx),
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
                    frame: None,
                    chart: None,
                    link: sp.nv.hyperlink.clone(),
                    flip: (x.flip_h, x.flip_v),
                    connector: (sp.st_cxn.is_some() || sp.end_cxn.is_some()).then(|| {
                        let end = |c: &pptx_core::CxnRef| CxnEnd {
                            id: c.id,
                            idx: c.idx,
                            at: None,
                        };
                        Connector {
                            st: sp.st_cxn.as_ref().map(end),
                            end: sp.end_cxn.as_ref().map(end),
                        }
                    }),
                    model_id: sp.model_id.clone(),
                    shape_style: style
                        .filter(|_| sp.nv.placeholder.is_none())
                        .map(|st| shape_style_look(st, ctx)),
                    ..Default::default()
                },
            })
        }
        Shape::Pic(p) => {
            if p.nv.hidden {
                return None;
            }
            // An SVG picture (Office 2016's `asvg:svgBlip`) is drawn from
            // its SVG, as vectors; the raster beside it is PowerPoint's
            // fallback for readers without SVG.
            let Some(part) = p.blip.svg.clone().or_else(|| p.blip.part.clone()) else {
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
            let look = resolved::picture(&p.blip, &ctx.colors(None));
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
                    image_effects: look.effects,
                },
                opacity: look.opacity,
                effects: effects(&p.props, p.style.as_ref(), ctx),
                meta: ItemMeta {
                    shape_id: p.nv.id,
                    link: p.nv.hyperlink.clone(),
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
                effects: Effects::default(),
                meta: ItemMeta {
                    shape_id: g.nv.id,
                    link: g.nv.hyperlink.clone(),
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
                    kind: ItemKind::Table(table::table(tbl, ctx)),
                    opacity: 1.0,
                    effects: Effects::default(),
                    meta: ItemMeta {
                        shape_id: f.nv.id,
                        ..Default::default()
                    },
                })
            }
            FrameContent::Chart { part } => {
                let Some(c) = part.as_ref().and_then(|p| ctx.deck.charts.get(p)) else {
                    ctx.note(format!("chart {:?}: part missing", f.nv.name));
                    return None;
                };
                let x = f.xfrm.clone()?;
                let (t, w, h) = space.place(&x);
                let prims = part
                    .as_deref()
                    .and_then(|p| (ctx.draw)(p, w, h))
                    .unwrap_or_else(|| slide_chart::layout(c, w, h));
                let children = chart::items(prims, t, w, h, ctx);
                Some(Item {
                    id: ctx.id(),
                    name: f.nv.name.clone(),
                    transform: t,
                    w,
                    h,
                    kind: ItemKind::Group { children },
                    opacity: 1.0,
                    effects: Effects::default(),
                    meta: ItemMeta {
                        shape_id: f.nv.id,
                        frame: Some("chart".into()),
                        chart: part.clone(),
                        link: f.nv.hyperlink.clone(),
                        ..Default::default()
                    },
                })
            }
            FrameContent::Diagram { drawing_part, .. } => {
                // The shapes PowerPoint drew for the diagram, in the frame's
                // own coordinates (its top-left is the drawing's origin).
                let Some(shapes) = drawing_part.as_ref().and_then(|p| ctx.deck.diagrams.get(p))
                else {
                    ctx.note(format!(
                        "SmartArt {:?} has no drawing; not drawn",
                        f.nv.name
                    ));
                    return None;
                };
                let x = f.xfrm.clone()?;
                let inner = space.child(&Xfrm {
                    ch_off: Some((0, 0)),
                    ch_ext: Some(x.ext),
                    ..x.clone()
                });
                let mut children = ordered(shapes, &inner, ctx);
                // The text pane (slide W4): each drawing shape names the
                // points it shows, when its paragraphs are theirs.
                let model = drawing_part
                    .as_ref()
                    .and_then(|p| ctx.deck.diagram_models.get(p));
                if let Some(m) = model {
                    label_diagram_text(&mut children, m);
                }
                let (t, w, h) = space.place(&x);
                Some(Item {
                    id: ctx.id(),
                    name: f.nv.name.clone(),
                    transform: t,
                    w,
                    h,
                    kind: ItemKind::Group { children },
                    opacity: 1.0,
                    effects: Effects::default(),
                    meta: ItemMeta {
                        shape_id: f.nv.id,
                        frame: Some("diagram".into()),
                        link: f.nv.hyperlink.clone(),
                        smartart: model.cloned(),
                        ..Default::default()
                    },
                })
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

/// Name on each SmartArt drawing shape the data points it shows (slide
/// W4): the `presOf` sources of its presentation point, when their
/// paragraphs add up to the shape's.
fn label_diagram_text(items: &mut [Item], model: &pptx_core::DiagramModel) {
    for it in items {
        match &mut it.kind {
            ItemKind::Group { children } => label_diagram_text(children, model),
            ItemKind::Shape { text: Some(tf), .. } => {
                let Some(srcs) = it.meta.model_id.as_ref().and_then(|m| model.shapes.get(m)) else {
                    continue;
                };
                let n: u32 = srcs.iter().map(|(_, n)| n).sum();
                if !srcs.is_empty() && n as usize == tf.paragraphs.len() {
                    it.meta.dgm = Some(srcs.clone());
                }
            }
            _ => {}
        }
    }
}

/// Where each glued connector end's site is on the page (slide ADR 717):
/// the site of the shape it names, on that shape's box. The editor routes a
/// connector again when a site it is glued to moves away from this point.
fn link_connectors(items: &mut [Item]) {
    // Every drawn shape's box by shape id: its preset (a rectangle's sites
    // for any other outline), size and placement. Groups and the members
    // of a drawn chart or diagram are left out.
    type Placed = (Option<(String, Vec<(String, String)>)>, f64, f64, [f64; 6]);
    fn boxes(items: &[Item], out: &mut std::collections::HashMap<u32, Placed>) {
        for it in items {
            match &it.kind {
                ItemKind::Group { children } => {
                    if it.meta.frame.is_none() {
                        boxes(children, out);
                    }
                }
                _ => {
                    out.insert(
                        it.meta.shape_id,
                        (it.meta.preset.clone(), it.w, it.h, it.transform),
                    );
                }
            }
        }
    }
    fn fill(items: &mut [Item], at: &std::collections::HashMap<u32, Placed>) {
        for it in items {
            if let ItemKind::Group { children } = &mut it.kind {
                fill(children, at);
            }
            let Some(c) = it.meta.connector.as_mut() else {
                continue;
            };
            for e in [c.st.as_mut(), c.end.as_mut()].into_iter().flatten() {
                e.at = at.get(&e.id).and_then(|(preset, w, h, t)| {
                    let (name, adj) = preset
                        .as_ref()
                        .map(|(n, a)| (n.as_str(), a.as_slice()))
                        .unwrap_or(("rect", &[]));
                    let sites = slide_geom::live::sites_on_page(name, adj, *w, *h, t);
                    sites.get(e.idx as usize).map(|s| s.pos)
                });
            }
        }
    }
    let mut placed = std::collections::HashMap::new();
    boxes(items, &mut placed);
    fill(items, &placed);
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

fn background(bg: &Background, ctx: &Ctx, w: f64, h: f64) -> Option<Item> {
    let fill = match bg {
        Background::Fill(f) => paint(f, ctx, None),
        Background::StyleRef { idx, color } => {
            let ph = color.as_ref().map(|c| ctx.ph(c));
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
        effects: Effects::default(),
        meta: ItemMeta::default(),
    })
}

fn overlay(base: &ColorMap, over: Option<&ColorMap>) -> ColorMap {
    match over {
        Some(o) if !o.entries.is_empty() => o.clone(),
        _ => base.clone(),
    }
}

/// The paragraph styles placeholders map to (slide ADR 719), from the
/// master whose theme is the deck's first: `Title` and `Body` (the roots,
/// with the theme's major and minor fonts), `Title`'s look, and `Body L1`–
/// `L9` and `Other L1`–`L9` based on `Body`, each with its level's look.
fn paragraph_styles(
    deck: &Presentation,
    primary_theme: &Option<String>,
    next_id: &std::cell::Cell<u32>,
    diagnostics: &std::cell::RefCell<Vec<String>>,
    draw: &ChartDrawer,
) -> Vec<ParagraphStyle> {
    let Some(master) = deck
        .masters
        .iter()
        .find(|m| m.theme_part == *primary_theme)
        .or(deck.masters.first())
    else {
        return Vec::new();
    };
    let theme = master.theme_part.as_deref().and_then(|t| deck.theme(t));
    let ctx = Ctx {
        deck,
        master,
        layout: None,
        theme,
        map: master.color_map.clone(),
        level: Level::Master,
        next_id,
        diagnostics,
        part: &master.part,
        draw,
        theme_tag: None,
    };
    let colors = ctx.colors(None);
    let (major, minor) = match theme {
        Some(t) => (&t.major_font, &t.minor_font),
        None => (&EMPTY_FONTS, &EMPTY_FONTS),
    };
    let look = |prefix: &'static str, list: Option<&ListStyle>, lvl: u8| -> Para {
        let mut lists: Vec<&ListStyle> = Vec::new();
        match list {
            Some(l) => lists.push(l),
            None => lists.extend(deck.default_text_style.as_ref()),
        }
        let tctx = text::TextCtx {
            inherited: lists.len(),
            lists,
            colors: &colors,
            major,
            minor,
            font_ref: None,
            style_prefix: Some(prefix),
            shrink: None,
        };
        let p = pptx_core::Paragraph {
            props: pptx_core::ParagraphProps {
                level: Some(lvl),
                ..Default::default()
            },
            runs: vec![pptx_core::Run {
                kind: pptx_core::RunKind::Text("x".into()),
                props: Default::default(),
            }],
            ..Default::default()
        };
        text::paragraph(&p, &tctx)
    };
    let mut out = vec![
        ParagraphStyle {
            name: "Body".into(),
            based_on: None,
            theme_font: Some("minor".into()),
            level: None,
        },
        ParagraphStyle {
            name: "Title".into(),
            based_on: None,
            theme_font: Some("major".into()),
            level: Some(look("Title", master.title_style.as_ref(), 0)),
        },
    ];
    for (prefix, list) in [
        ("Body", master.body_style.as_ref()),
        ("Other", master.other_style.as_ref()),
    ] {
        for lvl in 0..9u8 {
            out.push(ParagraphStyle {
                name: format!("{prefix} L{}", lvl + 1),
                based_on: Some("Body".into()),
                theme_font: None,
                level: Some(look(prefix, list, lvl)),
            });
        }
    }
    out
}

/// Resolve a deck.
pub fn resolve(deck: &Presentation) -> Deck {
    resolve_with(deck, &|_, _, _| None)
}

/// [`resolve`] with a drawer for chart frames (see [`ChartDrawer`]).
pub fn resolve_with(deck: &Presentation, draw: &ChartDrawer) -> Deck {
    let (w, h) = (
        deck.slide_size.0 as f64 / EMU_PER_PT,
        deck.slide_size.1 as f64 / EMU_PER_PT,
    );
    let next_id = std::cell::Cell::new(0u32);
    let diagnostics = std::cell::RefCell::new(Vec::new());
    // The deck's first theme (the first used layout's master's): its
    // colours' keys carry no prefix; another theme's are prefixed with its
    // part's name (slide ADR 713).
    let primary_theme = deck
        .slides
        .iter()
        .filter_map(|s| s.layout_part.as_deref())
        .find_map(|lp| deck.layout(lp))
        .and_then(|l| deck.master(&l.master_part))
        .and_then(|m| m.theme_part.clone());
    let theme_tag = |m: &Master| -> Option<String> {
        let part = m.theme_part.as_deref()?;
        if Some(part) == primary_theme.as_deref() {
            return None;
        }
        let stem = part.rsplit('/').next()?.trim_end_matches(".xml");
        Some(stem.to_string())
    };
    let mut out = Deck {
        width: w,
        height: h,
        ..Default::default()
    };

    // Slide ADR 712: one master spread per slide master, and one per
    // layout based on it (every layout, used or not), in the deck's order.
    let mut master_ids: BTreeMap<String, String> = BTreeMap::new();
    // Each layout's placeholder items: what a slide made from it hides.
    let mut layout_placeholders: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut layout_no = 0usize;
    for (mi, master) in deck.masters.iter().enumerate() {
        let theme = master.theme_part.as_deref().and_then(|t| deck.theme(t));
        let mid = format!("M{}", mi + 1);
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
            draw,
            theme_tag: theme_tag(master),
        };
        let mut items = Vec::new();
        let bg = master
            .background
            .as_ref()
            .and_then(|b| background(b, &mctx, w, h));
        let bg_id = bg.as_ref().map(|b| b.id.clone());
        items.extend(bg);
        let shapes = ordered(&master.shapes, &Space::PAGE, &mctx);
        let master_placeholders: Vec<String> = shapes
            .iter()
            .filter(|it| it.meta.placeholder.is_some())
            .map(|it| it.id.clone())
            .collect();
        let master_art: Vec<String> = shapes
            .iter()
            .filter(|it| it.meta.placeholder.is_none())
            .map(|it| it.id.clone())
            .collect();
        items.extend(shapes);
        out.masters.push(MasterPage {
            id: mid.clone(),
            name: format!("Slide Master {}", mi + 1),
            layout_part: String::new(),
            master_part: master.part.clone(),
            items,
            is_master: true,
            parent: None,
            overrides: Vec::new(),
            layout_type: None,
            preserve: master.preserve,
        });
        if out.theme_colors.is_empty() {
            if let Some(t) = theme {
                let cc = ColorCtx {
                    theme: Some(t),
                    map: &master.color_map,
                    placeholder: None,
                    placeholder_key: None,
                    theme_tag: None,
                };
                out.theme = Some(theme::ThemeIr::of(t));
                out.theme_part = master.theme_part.clone();
                out.theme_colors = t
                    .colors
                    .iter()
                    .map(|(k, c)| (k.clone(), resolve_color(c, &cc).bytes()))
                    .collect();
            }
        }
        for lp in &master.layouts {
            let Some(layout) = deck.layout(lp) else {
                continue;
            };
            layout_no += 1;
            let id = format!("m{layout_no}");
            let lctx = Ctx {
                theme_tag: theme_tag(master),
                layout: Some(layout),
                map: overlay(&master.color_map, layout.color_map_override.as_ref()),
                level: Level::Layout,
                part: &layout.part,
                ..mctx
            };
            let mut items = Vec::new();
            // The master's placeholders are prompts the layout's own stand
            // in for; its art goes where the layout hides master shapes.
            let mut overrides = master_placeholders.clone();
            if !layout.show_master_shapes {
                overrides.extend(master_art.iter().cloned());
            }
            if let Some(b) = layout.background.as_ref() {
                // The layout's background replaces the master's, under the
                // master's art. The engine paints a master's items under
                // the layout's, so that art is drawn again on the layout,
                // over its background (a copy: an edit of the master's art
                // does not reach it).
                items.extend(background(b, &lctx, w, h));
                overrides.extend(bg_id.iter().cloned());
                if layout.show_master_shapes && !master_art.is_empty() {
                    overrides.extend(master_art.iter().cloned());
                    items.extend(
                        ordered(&master.shapes, &Space::PAGE, &mctx)
                            .into_iter()
                            .filter(|it| it.meta.placeholder.is_none()),
                    );
                }
            }
            let own = ordered(&layout.shapes, &Space::PAGE, &lctx);
            layout_placeholders.insert(
                lp.to_string(),
                own.iter()
                    .filter(|it| it.meta.placeholder.is_some())
                    .map(|it| it.id.clone())
                    .collect(),
            );
            items.extend(own);
            master_ids.insert(lp.to_string(), id.clone());
            out.masters.push(MasterPage {
                id,
                name: layout
                    .name
                    .clone()
                    .unwrap_or_else(|| format!("Layout {layout_no}")),
                layout_part: lp.to_string(),
                master_part: master.part.clone(),
                items,
                is_master: false,
                parent: Some(mid.clone()),
                overrides,
                layout_type: layout.layout_type.clone(),
                preserve: layout.preserve,
            });
        }
    }

    out.paragraph_styles = paragraph_styles(deck, &primary_theme, &next_id, &diagnostics, draw);

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
            draw,
            theme_tag: theme_tag(master),
        };
        let mut items = Vec::new();
        if let Some(b) = &s.background {
            items.extend(background(b, &ctx, w, h));
        }
        items.extend(ordered(&s.shapes, &Space::PAGE, &ctx));
        link_connectors(&mut items);
        out.slides.push(SlidePage {
            id: format!("p{}", i + 1),
            index: i,
            part: s.part.clone(),
            master: s
                .layout_part
                .as_ref()
                .and_then(|lp| master_ids.get(lp).cloned()),
            // Every placeholder of the layout: the slide's own stand in
            // for some, and the others are not shown on a slide.
            overrides: s
                .layout_part
                .as_ref()
                .and_then(|lp| layout_placeholders.get(lp).cloned())
                .unwrap_or_default(),
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
            timing: s.timing.clone(),
            section: deck
                .sections
                .iter()
                .find(|sec| sec.slide_ids.first() == Some(&s.slide_id))
                .map(|sec| SectionStart {
                    id: sec.id.clone(),
                    name: sec.name.clone(),
                }),
        });
    }
    // Custom shows name slide parts; the document knows pages.
    out.custom_shows = deck
        .custom_shows
        .iter()
        .map(|c| CustomShowPages {
            id: c.id,
            name: c.name.clone(),
            pages: c
                .slides
                .iter()
                .filter_map(|part| out.slides.iter().find(|p| &p.part == part))
                .map(|p| p.id.clone())
                .collect(),
        })
        .collect();

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
