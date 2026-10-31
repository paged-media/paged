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

//! Engine ADR 1039 — symbol instances.
//!
//! A definition is built ONCE into a display list of its own (a one-page
//! document holding the definition's items and stories, with the host
//! document's palette, styles and fonts), cached per definition revision,
//! and every instance REPLAYS that list into its page under the instance
//! transform: the paths, gradients, images and inks are appended to the
//! page's pools, the commands copied with their ids moved and their
//! transforms composed. The copy is bracketed by `BeginSymbol` /
//! `EndSymbol`, which the rasterizers ignore and the PDF exporter turns into
//! one form XObject per definition.
//!
//! 9-slice: with guides set, the definition is replayed nine times, each
//! copy clipped to one of the nine regions and mapped so the corners keep
//! their size, the edges stretch along their axis and the centre in both.

use std::cell::RefCell;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use paged_compose::{
    DisplayCommand, DisplayList, GradientId, Paint, PathData, PathSegment, Rect, SymbolForm,
    Transform,
};
use paged_model::{Bounds, NineSlice, SymbolDefinition, SymbolInstance, SymbolTint};
use paged_scene::{Document, ParsedSpread, ParsedStory};

use super::{BuiltPage, FontTable, PipelineOptions};

/// One definition, built.
#[derive(Debug)]
pub struct BuiltSymbol {
    /// The definition's display list. Its space is definition space moved
    /// so the definition's bounds' top-left is the origin.
    pub list: DisplayList,
    /// Identifies the definition revision (and tint): one PDF form per key.
    pub key: u64,
    /// The definition's bounds, definition space.
    pub bounds: Bounds,
}

/// Engine ADR 1039 — the cross-build cache of built definitions, keyed by
/// `(id, revision, environment)`: the environment is everything outside
/// the definition its look depends on (the palette, the styles, the
/// layers, the render scale). A caller that builds repeatedly (the canvas)
/// keeps one and passes it in `PipelineOptions::symbol_cache`.
#[derive(Debug, Default)]
pub struct SymbolCache {
    built: RefCell<HashMap<(String, u64, u64), Arc<BuiltSymbol>>>,
}

impl SymbolCache {
    /// How many built definitions the cache holds.
    pub fn len(&self) -> usize {
        self.built.borrow().len()
    }

    pub fn is_empty(&self) -> bool {
        self.built.borrow().is_empty()
    }
}

/// A definition id and a tint's bits.
type TintKey = (String, [u32; 4]);

/// The definitions one build replays, by id, and their tinted variants.
#[derive(Debug, Default)]
pub(crate) struct SymbolLists {
    by_id: HashMap<String, Arc<BuiltSymbol>>,
    tinted: RefCell<HashMap<TintKey, Arc<BuiltSymbol>>>,
    /// How many definitions this build compiled (not served from a cache).
    pub(crate) compiled: usize,
}

fn fnv() -> std::collections::hash_map::DefaultHasher {
    std::collections::hash_map::DefaultHasher::new()
}

/// The environment hash a definition's look depends on.
fn environment(document: &Document, options: &PipelineOptions) -> u64 {
    let mut h = fnv();
    serde_json::to_string(&document.palette)
        .unwrap_or_default()
        .hash(&mut h);
    serde_json::to_string(&document.styles)
        .unwrap_or_default()
        .hash(&mut h);
    serde_json::to_string(&document.designmap.layers)
        .unwrap_or_default()
        .hash(&mut h);
    options.render_scale.to_bits().hash(&mut h);
    options.collect_glyph_runs.hash(&mut h);
    // The colour context: a proof and the working space resolve inks
    // differently. The profile by identity (the caller's bytes live for the
    // session), not by content.
    options
        .cmyk_icc_profile
        .map(|b| (b.as_ptr() as usize, b.len()))
        .hash(&mut h);
    options.cmyk_intent.hash(&mut h);
    options.cmyk_bpc.hash(&mut h);
    options.use_standard_lab_for_spots.hash(&mut h);
    h.finish()
}

fn form_key(def: &SymbolDefinition, env: u64) -> u64 {
    let mut h = fnv();
    def.id.hash(&mut h);
    def.revision.hash(&mut h);
    env.hash(&mut h);
    h.finish()
}

/// Build every definition an instance of `document` names, from the
/// caller's cache when it holds the revision.
pub(crate) fn prepare(
    document: &Document,
    options: &PipelineOptions,
    font_table: &FontTable,
) -> SymbolLists {
    let mut lists = SymbolLists::default();
    let named: std::collections::BTreeSet<&str> = document
        .spreads
        .iter()
        .flat_map(|p| p.spread.instances.iter().map(|i| i.symbol.as_str()))
        .collect();
    if named.is_empty() {
        return lists;
    }
    let env = environment(document, options);
    for id in named {
        let Some(def) = document.symbol(id) else {
            continue;
        };
        let key = (def.id.clone(), def.revision, env);
        let cached = options
            .symbol_cache
            .and_then(|c| c.built.borrow().get(&key).cloned());
        let built = match cached {
            Some(b) => b,
            None => {
                let Some(b) = build_definition(document, def, options, font_table, env) else {
                    continue;
                };
                lists.compiled += 1;
                let b = Arc::new(b);
                if let Some(c) = options.symbol_cache {
                    let mut map = c.built.borrow_mut();
                    // Older revisions of this definition are dead.
                    map.retain(|(i, _, _), _| *i != def.id);
                    map.insert(key, b.clone());
                }
                b
            }
        };
        lists.by_id.insert(def.id.clone(), built);
    }
    lists
}

/// A one-page document holding the definition, built like any other.
fn build_definition(
    document: &Document,
    def: &SymbolDefinition,
    options: &PipelineOptions,
    font_table: &FontTable,
    env: u64,
) -> Option<BuiltSymbol> {
    let b = def.bounds;
    if !(b.width() > 0.0 || b.height() > 0.0) {
        return None;
    }
    let mut items = def.items.clone();
    items.pages = vec![paged_model::Page {
        self_id: Some(format!("symbol/{}", def.id)),
        bounds: b,
        applied_master: None,
        item_transform: None,
        master_page_transform: None,
        override_list: Vec::new(),
        name: None,
        show_master_items: Some(false),
        canvas_origin: None,
    }];
    let mut doc = Document {
        designmap: document.designmap.clone(),
        palette: document.palette.clone(),
        spreads: vec![ParsedSpread {
            src: String::new(),
            spread: items,
        }],
        stories: def
            .stories
            .iter()
            .map(|s| ParsedStory {
                src: String::new(),
                self_id: s.self_id.clone(),
                story: s.story.clone(),
            })
            .collect(),
        styles: document.styles.clone(),
        ..Default::default()
    };
    // The definition is not numbered, sectioned or linked.
    doc.designmap.sections.clear();
    doc.rebuild_indexes();
    let mut sub = options.clone();
    sub.pre_built_font_table = Some(font_table);
    sub.collect_link_regions = false;
    sub.grow_hint = None;
    sub.collect_breaks = false;
    sub.break_story_filter = None;
    sub.break_page_range = None;
    sub.master_text_emit_cache = None;
    sub.body_story_emit_cache = None;
    sub.keep_seeds = None;
    sub.keep_seed_hints = None;
    sub.story_resume = None;
    sub.edit_spans = None;
    sub.emission_prints = None;
    sub.previous_pages = None;
    sub.keep_carry = None;
    sub.scene_layers = None;
    sub.resource_providers = None;
    sub.symbol_cache = None;
    let built = super::build_document(&doc, &sub).ok()?;
    let page = built.pages.into_iter().next()?;
    Some(BuiltSymbol {
        list: page.list,
        key: form_key(def, env),
        bounds: b,
    })
}

impl SymbolLists {
    pub(crate) fn get(&self, id: &str) -> Option<Arc<BuiltSymbol>> {
        self.by_id.get(id).cloned()
    }

    /// `id`'s list under `tint` (built once per build and tint).
    pub(crate) fn tinted(&self, id: &str, tint: SymbolTint) -> Option<Arc<BuiltSymbol>> {
        let base = self.get(id)?;
        let bits = [
            tint.color[0].to_bits(),
            tint.color[1].to_bits(),
            tint.color[2].to_bits(),
            tint.amount.to_bits(),
        ];
        let k = (id.to_string(), bits);
        if let Some(t) = self.tinted.borrow().get(&k) {
            return Some(t.clone());
        }
        let mut h = fnv();
        base.key.hash(&mut h);
        bits.hash(&mut h);
        let t = Arc::new(BuiltSymbol {
            list: tint_list(&base.list, tint),
            key: h.finish(),
            bounds: base.bounds,
        });
        self.tinted.borrow_mut().insert(k, t.clone());
        Some(t)
    }
}

// ------------------------------------------------------------------ tint

/// `list` with every solid paint and gradient stop moved `tint.amount` of
/// the way to `tint.color` (linear light). Images keep their pixels.
pub(crate) fn tint_list(list: &DisplayList, tint: SymbolTint) -> DisplayList {
    let target = [
        paged_color::math::srgb_to_linear(tint.color[0]),
        paged_color::math::srgb_to_linear(tint.color[1]),
        paged_color::math::srgb_to_linear(tint.color[2]),
    ];
    let a = tint.amount.clamp(0.0, 1.0);
    let mix = |c: paged_compose::Color| paged_compose::Color {
        r: c.r + (target[0] - c.r) * a,
        g: c.g + (target[1] - c.g) * a,
        b: c.b + (target[2] - c.b) * a,
        a: c.a,
    };
    let paint = |p: Paint| match p {
        Paint::Solid(c) => Paint::Solid(mix(c)),
        // A tinted ink is no longer that ink: it draws as its colour.
        Paint::Cmyk { rgb, .. } => Paint::Solid(mix(rgb)),
        other => other,
    };
    let mut out = list.clone();
    for g in &mut out.gradients {
        g.stops.iter_mut().for_each(|s| s.color = mix(s.color));
    }
    for g in &mut out.radial_gradients {
        g.stops.iter_mut().for_each(|s| s.color = mix(s.color));
    }
    for g in &mut out.sweep_gradients {
        g.stops.iter_mut().for_each(|s| s.color = mix(s.color));
    }
    for cmd in &mut out.commands {
        match cmd {
            DisplayCommand::FillPath { paint: p, .. }
            | DisplayCommand::FillPathBlend { paint: p, .. }
            | DisplayCommand::StrokePath { paint: p, .. }
            | DisplayCommand::FillPathOverprint { paint: p, .. }
            | DisplayCommand::StrokePathOverprint { paint: p, .. } => *p = paint(*p),
            _ => {}
        }
    }
    if let Some(table) = out.glyph_runs.as_mut() {
        for e in &mut table.entries {
            e.paint = paint(e.paint);
        }
    }
    out
}

// ------------------------------------------------------------------ splice

fn rect_through(t: &Transform, r: Rect) -> Rect {
    let pts = [
        t.apply(r.x, r.y),
        t.apply(r.x + r.w, r.y),
        t.apply(r.x, r.y + r.h),
        t.apply(r.x + r.w, r.y + r.h),
    ];
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for (x, y) in pts {
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    Rect {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
    }
}

/// Replay `sym` into `page` under `place` (definition list space → page
/// list space), bracketed by `BeginSymbol` / `EndSymbol`.
pub(crate) fn splice(page: &mut BuiltPage, sym: &BuiltSymbol, place: Transform) {
    let dst = &mut page.list;
    let src = &sym.list;
    let form = match dst.symbol_forms.iter().position(|f| f.key == sym.key) {
        Some(i) => i,
        None => {
            dst.symbol_forms.push(SymbolForm {
                key: sym.key,
                list: Arc::new(src.clone()),
                bbox: [0.0, 0.0, sym.bounds.width(), sym.bounds.height()],
            });
            dst.symbol_forms.len() - 1
        }
    } as u32;
    let path_base = dst.paths.len() as i64;
    for i in 0..src.paths.len() {
        let p = src
            .paths
            .get(paged_compose::PathId(i as u32))
            .cloned()
            .unwrap_or_default();
        dst.paths.push_anon(p);
    }
    let lin = dst.gradients.len() as u32;
    let rad = dst.radial_gradients.len() as u32;
    let swp = dst.sweep_gradients.len() as u32;
    dst.gradients.extend(src.gradients.iter().cloned());
    dst.radial_gradients
        .extend(src.radial_gradients.iter().cloned());
    dst.sweep_gradients
        .extend(src.sweep_gradients.iter().cloned());
    let img = dst.images.len() as u32;
    dst.images.extend(src.images.iter().cloned());
    let spots: Vec<paged_compose::SpotInkId> = src
        .spot_inks
        .iter()
        .map(|ink| dst.push_spot_ink(ink.clone()))
        .collect();
    let remap = |p: Paint| match p {
        Paint::LinearGradient(GradientId(g)) => Paint::LinearGradient(GradientId(g + lin)),
        Paint::RadialGradient(GradientId(g)) => Paint::RadialGradient(GradientId(g + rad)),
        Paint::SweepGradient(GradientId(g)) => Paint::SweepGradient(GradientId(g + swp)),
        Paint::Cmyk {
            c,
            m,
            y,
            k,
            rgb,
            spot,
        } => Paint::Cmyk {
            c,
            m,
            y,
            k,
            rgb,
            spot: spot.and_then(|s| spots.get(s.0 as usize).copied()),
        },
        other => other,
    };
    // A stroke's width (and dash) is in the list's own units, applied after
    // the transform: an instance scaled up draws its strokes wider by the
    // placement's area scale, as a transformed group's do.
    let [pa, pb, pc, pd, _, _] = place.0;
    let k = (pa * pd - pb * pc).abs().sqrt();
    let widen = |stroke: &mut paged_compose::Stroke| {
        if (k - 1.0).abs() > 1e-6 && k.is_finite() {
            stroke.width *= k;
            let len = stroke.dash.len as usize;
            for v in &mut stroke.dash.pattern[..len.min(8)] {
                *v *= k;
            }
        }
    };
    dst.push(DisplayCommand::BeginSymbol {
        form,
        transform: place,
    });
    let cmd_base = dst.commands.len() as u32;
    for cmd in &src.commands {
        let mut c = cmd.clone();
        super::deltas::rebase_path_ids(&mut c, path_base);
        if let DisplayCommand::StrokePath { stroke, .. }
        | DisplayCommand::StrokePathOverprint { stroke, .. } = &mut c
        {
            widen(stroke);
        }
        match &mut c {
            DisplayCommand::FillPath { paint, .. }
            | DisplayCommand::FillPathBlend { paint, .. }
            | DisplayCommand::StrokePath { paint, .. }
            | DisplayCommand::FillPathOverprint { paint, .. }
            | DisplayCommand::StrokePathOverprint { paint, .. } => *paint = remap(*paint),
            DisplayCommand::Image { image_id, .. } => image_id.0 += img,
            DisplayCommand::BeginBlendGroup { bounds, .. }
            | DisplayCommand::PushLayer { bounds, .. } => *bounds = rect_through(&place, *bounds),
            _ => {}
        }
        let t = c.transform_mut();
        *t = place.compose(t);
        dst.commands.push(c);
    }
    if let (Some(dt), Some(st)) = (dst.glyph_runs.as_mut(), src.glyph_runs.as_ref()) {
        for e in &st.entries {
            let mut e = e.clone();
            e.command_index += cmd_base;
            e.transform = place.compose(&e.transform);
            e.paint = remap(e.paint);
            dt.entries.push(e);
        }
    }
    dst.push(DisplayCommand::EndSymbol(Transform::IDENTITY));
}

fn rect_path(x0: f32, y0: f32, x1: f32, y1: f32) -> PathData {
    PathData::new(vec![
        PathSegment::MoveTo { x: x0, y: y0 },
        PathSegment::LineTo { x: x1, y: y0 },
        PathSegment::LineTo { x: x1, y: y1 },
        PathSegment::LineTo { x: x0, y: y1 },
        PathSegment::Close,
    ])
}

/// Emit one instance into `page`. `outer` maps spread space to the page's
/// list space (`frame_outer_transform` of the identity).
pub(crate) fn emit_instance(
    page: &mut BuiltPage,
    sym: &BuiltSymbol,
    inst: &SymbolInstance,
    nine: Option<NineSlice>,
    outer: Transform,
) {
    let b = sym.bounds;
    // Definition list space → definition space → spread → page.
    let list_to_def = Transform::translate(b.left, b.top);
    let m = inst.item_transform;
    let o = &inst.overrides;
    let opacity = o
        .opacity
        .map(|v| (v / 100.0).clamp(0.0, 1.0))
        .unwrap_or(1.0);
    let blend = super::shapes::blend_mode_from_idml(o.blend_mode.as_deref());
    let bracket = opacity < 1.0 || blend != paged_compose::BlendMode::Normal;
    if bracket {
        let full = Transform(m);
        let bounds = rect_through(
            &outer.compose(&full),
            Rect {
                x: b.left,
                y: b.top,
                w: b.width(),
                h: b.height(),
            },
        );
        page.list.push(DisplayCommand::BeginBlendGroup {
            bounds,
            blend_mode: blend,
            opacity,
            isolated: true,
            knockout: false,
            transform: Transform::IDENTITY,
        });
    }
    let (sx, sy) = (
        (m[0] * m[0] + m[1] * m[1]).sqrt(),
        (m[2] * m[2] + m[3] * m[3]).sqrt(),
    );
    // At its own size an instance needs no slicing.
    let nine = nine.filter(|_| (sx - 1.0).abs() > 1e-4 || (sy - 1.0).abs() > 1e-4);
    match nine {
        None => {
            let place = outer.compose(&Transform(m)).compose(&list_to_def);
            splice(page, sym, place);
        }
        Some(n) if sx > 1e-6 && sy > 1e-6 => {
            // The instance's frame without its scale: the 9-slice mapping
            // stretches in definition space, then this places it.
            let unscaled = Transform([m[0] / sx, m[1] / sx, m[2] / sy, m[3] / sy, m[4], m[5]]);
            let to_page = outer.compose(&unscaled);
            // Source cuts (definition space) and target cuts (the scaled
            // size, centred on the registration point as the scale is).
            let xs = [b.left, b.left + n.left, b.right - n.right, b.right];
            let ys = [b.top, b.top + n.top, b.bottom - n.bottom, b.bottom];
            let (tw, th) = (b.width() * sx, b.height() * sy);
            let (tl, tt) = (b.left * sx, b.top * sy);
            let mid_w = (tw - n.left - n.right).max(0.0);
            let mid_h = (th - n.top - n.bottom).max(0.0);
            let txs = [
                tl,
                tl + n.left,
                tl + n.left + mid_w,
                tl + n.left + mid_w + n.right,
            ];
            let tys = [
                tt,
                tt + n.top,
                tt + n.top + mid_h,
                tt + n.top + mid_h + n.bottom,
            ];
            for row in 0..3 {
                for col in 0..3 {
                    let (s0, s1) = (xs[col], xs[col + 1]);
                    let (r0, r1) = (ys[row], ys[row + 1]);
                    let (d0, d1) = (txs[col], txs[col + 1]);
                    let (e0, e1) = (tys[row], tys[row + 1]);
                    if s1 - s0 <= 1e-6 || r1 - r0 <= 1e-6 || d1 - d0 <= 1e-6 || e1 - e0 <= 1e-6 {
                        continue;
                    }
                    let kx = (d1 - d0) / (s1 - s0);
                    let ky = (e1 - e0) / (r1 - r0);
                    // source region → target region, in definition space.
                    let region = Transform([kx, 0.0, 0.0, ky, d0 - s0 * kx, e0 - r0 * ky]);
                    let clip_t = to_page;
                    // The outer regions reach past the bounds, so what draws
                    // outside them (a stroke's outer half, an effect) stays.
                    const FAR: f32 = 1.0e5;
                    let (c0, c1) = (
                        if col == 0 { d0 - FAR } else { d0 },
                        if col == 2 { d1 + FAR } else { d1 },
                    );
                    let (f0, f1) = (
                        if row == 0 { e0 - FAR } else { e0 },
                        if row == 2 { e1 + FAR } else { e1 },
                    );
                    let path_id = page.list.paths.push_anon(rect_path(c0, f0, c1, f1));
                    page.list.push(DisplayCommand::PushClip {
                        path_id,
                        transform: clip_t,
                    });
                    let place = to_page.compose(&region).compose(&list_to_def);
                    splice(page, sym, place);
                    page.list.push(DisplayCommand::PopClip(Transform::IDENTITY));
                }
            }
        }
        Some(_) => {}
    }
    if bracket {
        page.list
            .push(DisplayCommand::EndBlendGroup(Transform::IDENTITY));
    }
}
