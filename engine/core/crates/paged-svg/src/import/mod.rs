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

//! SVG → native page items, as one wire batch (engine ADR 1018).
//!
//! [`plan_import`] parses the file with `usvg` and walks the resolved
//! tree into ONE [`Mutation::Batch`]. Every item it creates is named with
//! a batch handle (`bindCreated`, `$h:<n>`) right after its creating
//! child, so later children paint, group, clip and mask it, and the whole
//! file is one undo step.
//!
//! The lowering, construct by construct:
//!
//! - **Paths** — `insertPath` with the first contour (page-local), then,
//!   for a shape of several contours, the whole table through
//!   `framePath` and its box through `frameBounds` (spread space): one
//!   compound element, holes included. A stroke-only shape with open
//!   contours is one element per contour instead (`framePath` carries no
//!   open flags), which draws the same. Transforms are baked into the
//!   anchors.
//! - **Paint** — a swatch per distinct colour (`createSwatch`, named with
//!   its hex, reused across imports), fill and stroke opacity, the fill
//!   rule, stroke weight, caps, joins, miter limit and dashes. A stroke
//!   under a non-uniform scale is drawn at the mean width.
//! - **Gradients** — `createGradient` (linear or radial) with a swatch per
//!   stop, and the axis written exactly: a linear axis is solved in page
//!   space, so a skewed gradient keeps its isolines; a radial one is
//!   centred and sized. Stop opacity that differs between stops becomes a
//!   gradient feather on the same axis.
//! - **Groups** keep their structure (`createGroup`), opacity, blend mode
//!   and isolation; a group of one item folds into the item.
//! - **Clip paths** — the clipped content is lowered to leaves and each
//!   leaf is pasted into its own frame of the clip shape (`pasteInto`):
//!   the same pixels as one clip over the group, in the model the engine
//!   has today.
//! - **Masks** — `applyOpacityMask` (luminance or alpha) when the mask is
//!   one shape; each masked leaf takes its own copy.
//! - **Images** — a frame with the picture as a `data:` URI, its
//!   transform kept; a nested SVG image is imported as vectors.
//! - **Text** — a text frame per text chunk, with the family, style, size,
//!   fill, tracking and alignment, when the font is one the caller hands
//!   in (a document font) and the text is plain; otherwise its outlines.
//!
//! What cannot be said natively is reported in the [`SvgReport`] — never
//! dropped silently.

mod geom;
mod text;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use paged_mutate::operation::{GradientFeatherSpec, GradientFeatherStopSpec, PathAnchorSpec};
use paged_mutate::{GradientSpec, GradientStopSpec, PropertyPath, SwatchSpec, Value};
use paged_wire::{ElementId, Mutation, PageId};
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

pub use geom::Affine;
use geom::Contour;

use crate::report::SvgReport;

/// What text becomes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub enum SvgImportText {
    /// Text frames where the font is a document font and the text is
    /// plain; outlines otherwise.
    #[default]
    Auto,
    /// Outlines always.
    Outlines,
}

/// How an SVG lands on the page. Every field is optional.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct SvgImportOptions {
    /// The page-local point (pt) the SVG's top-left corner lands on.
    /// Absent: the drawing is centred on the page.
    #[serde(default)]
    pub origin: Option<[f32; 2]>,
    /// Points per SVG user unit (a CSS pixel). Absent: 1, the convention
    /// Illustrator and paged.draw read SVG by.
    #[serde(default)]
    pub scale: Option<f32>,
    /// What text becomes. Absent: [`SvgImportText::Auto`].
    #[serde(default)]
    pub text: Option<SvgImportText>,
    /// Wrap the import in one group when it makes more than one item.
    /// Absent: true.
    #[serde(default)]
    pub group: Option<bool>,
}

/// The page an import lands on.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportTarget {
    pub page_id: PageId,
    /// The page's top-left corner in its spread: spread space is
    /// page-local plus this.
    pub page_origin: [f32; 2],
    /// The page's width and height (pt).
    pub page_size: [f32; 2],
}

/// A font the import may lay text out with — the document's registered
/// faces. No system font is ever read.
#[derive(Debug, Clone, Copy)]
pub struct ImportFont<'a> {
    pub family: &'a str,
    pub bytes: &'a [u8],
}

/// What the import needs to know about the document it lands in, so a
/// second import of the same colours reuses the swatches the first made.
pub trait ImportDocument {
    /// The RGB value (0–255 per channel) of the swatch `id`, if the
    /// document has one by that id.
    fn swatch_rgb(&self, id: &str) -> Option<[f32; 3]>;
    /// Whether the document has a gradient swatch `id`.
    fn has_gradient(&self, id: &str) -> bool;
}

/// An empty document: every swatch and gradient is created.
impl ImportDocument for () {
    fn swatch_rgb(&self, _: &str) -> Option<[f32; 3]> {
        None
    }
    fn has_gradient(&self, _: &str) -> bool {
        false
    }
}

/// The answer of [`plan_import`].
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct SvgImportPlan {
    /// The one batch to apply (one undo step), or `None` when the file
    /// draws nothing or could not be read.
    pub mutation: Option<Mutation>,
    pub report: SvgReport,
    /// The drawing's size on the page (pt).
    pub width: f32,
    pub height: f32,
    /// Why the file could not be read, when it could not.
    pub error: Option<String>,
}

/// Plan the import of `svg` (an SVG or SVGZ file) onto `target`.
pub fn plan_import(
    svg: &[u8],
    target: &ImportTarget,
    options: &SvgImportOptions,
    fonts: &[ImportFont<'_>],
    doc: &dyn ImportDocument,
) -> SvgImportPlan {
    let external = Arc::new(AtomicU32::new(0));
    let mut opt = usvg::Options {
        // A relative or absolute href never reaches the file system: an
        // import reads nothing but the file it is given.
        resources_dir: None,
        // A user unit (a CSS pixel) is a point, so absolute units must
        // resolve at 72 per inch for `width="612pt"` to be 612 of them:
        // what the export writes comes back the size it was.
        dpi: 72.0,
        ..usvg::Options::default()
    };
    {
        let external = external.clone();
        opt.image_href_resolver = usvg::ImageHrefResolver {
            resolve_data: usvg::ImageHrefResolver::default_data_resolver(),
            resolve_string: Box::new(move |_, _| {
                external.fetch_add(1, Ordering::Relaxed);
                None
            }),
        };
    }
    {
        let db = opt.fontdb_mut();
        for f in fonts {
            db.load_font_data(f.bytes.to_vec());
        }
        // Generic families (serif, sans-serif, …) resolve to a face the
        // caller handed in, never to a system name nobody has.
        if let Some(first) = fonts.first() {
            db.set_serif_family(first.family);
            db.set_sans_serif_family(first.family);
            db.set_cursive_family(first.family);
            db.set_fantasy_family(first.family);
            db.set_monospace_family(first.family);
        }
    }
    if let Some(first) = fonts.first() {
        opt.font_family = first.family.to_string();
    }
    let tree = match usvg::Tree::from_data(svg, &opt) {
        Ok(t) => t,
        Err(e) => {
            return SvgImportPlan {
                mutation: None,
                report: SvgReport::default(),
                width: 0.0,
                height: 0.0,
                error: Some(format!("not a readable SVG: {e}")),
            }
        }
    };
    let scale = options
        .scale
        .filter(|s| s.is_finite() && *s > 0.0)
        .unwrap_or(1.0);
    let (w, h) = (tree.size().width() * scale, tree.size().height() * scale);
    let origin = options.origin.unwrap_or([
        (target.page_size[0] - w) / 2.0,
        (target.page_size[1] - h) / 2.0,
    ]);
    let placement = Affine::translate(origin[0], origin[1]).compose(Affine::scale(scale));

    let mut low = Lower {
        target,
        doc,
        fonts,
        text_mode: options.text.unwrap_or_default(),
        ops: Vec::new(),
        paint_ops: Vec::new(),
        report: SvgReport::default(),
        next: 0,
        swatches: HashMap::new(),
        gradients: HashMap::new(),
        items: 0,
        text_nodes: 0,
        frames: Vec::new(),
        flat: 0,
    };
    let root = tree.root();
    let mut items =
        low.lower_children(root, placement.compose(Affine::from_usvg(root.transform())));
    if options.group.unwrap_or(true) && items.len() > 1 {
        items = vec![low.make_group(&items)];
    }

    let n = external.load(Ordering::Relaxed);
    for _ in 0..n {
        low.report.dropped(
            "image.external",
            "an image that links to a file outside the SVG is left out (only embedded data: images import)",
        );
    }
    // Text usvg could not lay out (no font at all) leaves no node behind:
    // count the source's text elements against the ones that arrived.
    let source_texts = text::count_text_elements(svg);
    for _ in low.text_nodes..source_texts {
        low.report.dropped(
            "text.noFont",
            "text is left out: no font is available to lay it out (register a document font)",
        );
    }

    let mut ops = std::mem::take(&mut low.paint_ops);
    ops.append(&mut low.ops);
    low.report.items = low.items;
    let _ = items;
    SvgImportPlan {
        mutation: (low.items > 0).then_some(Mutation::Batch { ops }),
        report: low.report,
        width: w,
        height: h,
        error: None,
    }
}

/// The kind of item a handle names (the `ElementId` kind it is addressed by).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Polygon,
    Rectangle,
    TextFrame,
    Group,
}

/// An item the batch created.
#[derive(Debug, Clone)]
struct Item {
    handle: String,
    kind: Kind,
    /// Its own opacity (0–1), as written so far.
    opacity: f32,
    /// Whether a blend mode other than Normal was written.
    blended: bool,
}

impl Item {
    fn id(&self) -> ElementId {
        let h = format!("$h:{}", self.handle);
        match self.kind {
            Kind::Polygon => ElementId::Polygon(h),
            Kind::Rectangle => ElementId::Rectangle(h),
            Kind::TextFrame => ElementId::TextFrame(h),
            Kind::Group => ElementId::Group(h),
        }
    }

    fn is_leaf(&self) -> bool {
        self.kind != Kind::Group
    }
}

/// A snapshot to roll a speculative lowering back to.
struct Mark {
    ops: usize,
    paint_ops: usize,
    swatches: HashMap<[u8; 3], String>,
    gradients: HashMap<String, String>,
    items: u32,
}

struct Lower<'a> {
    target: &'a ImportTarget,
    doc: &'a dyn ImportDocument,
    fonts: &'a [ImportFont<'a>],
    text_mode: SvgImportText,
    /// Element children, in paint order.
    ops: Vec<Mutation>,
    /// Swatch and gradient creations, which go first.
    paint_ops: Vec<Mutation>,
    report: SvgReport,
    next: u32,
    swatches: HashMap<[u8; 3], String>,
    gradients: HashMap<String, String>,
    items: u32,
    text_nodes: u32,
    /// The items of each group being walked, innermost last.
    frames: Vec<Vec<Item>>,
    /// How many clips and masks the walk is inside (their content must
    /// stay leaves).
    flat: u32,
}

fn set(id: &ElementId, path: PropertyPath, value: Value) -> Mutation {
    Mutation::SetElementProperty {
        element_id: id.clone(),
        path,
        value,
    }
}

fn pct(v: f32) -> Value {
    Value::Length(Some((v * 100.0).clamp(0.0, 100.0)))
}

fn text(v: &str) -> Value {
    Value::Text(v.to_string())
}

fn blend_name(b: usvg::BlendMode) -> &'static str {
    use usvg::BlendMode as B;
    match b {
        B::Normal => "Normal",
        B::Multiply => "Multiply",
        B::Screen => "Screen",
        B::Overlay => "Overlay",
        B::Darken => "Darken",
        B::Lighten => "Lighten",
        B::ColorDodge => "ColorDodge",
        B::ColorBurn => "ColorBurn",
        B::HardLight => "HardLight",
        B::SoftLight => "SoftLight",
        B::Difference => "Difference",
        B::Exclusion => "Exclusion",
        B::Hue => "Hue",
        B::Saturation => "Saturation",
        B::Color => "Color",
        B::Luminosity => "Luminosity",
    }
}

fn hex(rgb: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])
}

/// A short stable hash (FNV-1a) for gradient ids.
fn fnv(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// A resolved paint for one side (fill or stroke) of a shape.
struct SidePaint {
    /// The swatch or gradient id (`None`: no paint).
    color: Option<String>,
    /// The side's own opacity (0–1).
    opacity: f32,
    /// The gradient's geometry, when the paint is one.
    gradient: Option<GradientAxis>,
}

/// Where a gradient's axis lies, in page-local points.
#[derive(Debug, Clone)]
struct GradientAxis {
    radial: bool,
    start: [f32; 2],
    /// Angle in the engine's convention: the axis runs from `start` in
    /// the direction `(cos θ, −sin θ)`.
    angle_deg: f32,
    length: f32,
    /// Per-stop opacity, when the stops differ in it: `(offset, alpha)`.
    alpha_stops: Option<Vec<(f32, f32)>>,
}

impl<'a> Lower<'a> {
    fn mark(&self) -> Mark {
        Mark {
            ops: self.ops.len(),
            paint_ops: self.paint_ops.len(),
            swatches: self.swatches.clone(),
            gradients: self.gradients.clone(),
            items: self.items,
        }
    }

    fn rollback(&mut self, m: Mark) {
        self.ops.truncate(m.ops);
        self.paint_ops.truncate(m.paint_ops);
        self.swatches = m.swatches;
        self.gradients = m.gradients;
        self.items = m.items;
    }

    fn page(&self) -> PageId {
        self.target.page_id.clone()
    }

    fn origin(&self) -> [f32; 2] {
        self.target.page_origin
    }

    /// Bind what the preceding child created and return its item.
    fn bind(&mut self, kind: Kind) -> Item {
        self.next += 1;
        let handle = format!("svg{}", self.next);
        self.ops.push(Mutation::BindCreated {
            handle: handle.clone(),
        });
        self.items += 1;
        Item {
            handle,
            kind,
            opacity: 1.0,
            blended: false,
        }
    }

    // ------------------------------------------------------------ paint

    fn swatch(&mut self, c: usvg::Color) -> String {
        let rgb = [c.red, c.green, c.blue];
        if let Some(id) = self.swatches.get(&rgb) {
            return id.clone();
        }
        let want = [rgb[0] as f32, rgb[1] as f32, rgb[2] as f32];
        let base = format!("Color/svg-{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2]);
        let mut id = base.clone();
        let mut n = 1;
        loop {
            match self.doc.swatch_rgb(&id) {
                // The document already has this colour by this id: reuse it.
                Some(v) if v.iter().zip(want.iter()).all(|(a, b)| (a - b).abs() < 0.5) => break,
                // The id is taken by something else (an edited swatch).
                Some(_) => {
                    n += 1;
                    id = format!("{base}-{n}");
                }
                None => {
                    self.paint_ops.push(Mutation::CreateSwatch {
                        spec: SwatchSpec {
                            self_id: Some(id.clone()),
                            name: Some(hex(rgb)),
                            space: "RGB".into(),
                            value: want.to_vec(),
                            model: None,
                            alternate_space: None,
                            alternate_value: Vec::new(),
                            tint: None,
                            alpha: None,
                        },
                    });
                    break;
                }
            }
        }
        self.swatches.insert(rgb, id.clone());
        id
    }

    fn gradient_swatch(&mut self, radial: bool, stops: &[usvg::Stop]) -> String {
        let specs: Vec<GradientStopSpec> = stops
            .iter()
            .map(|s| GradientStopSpec {
                stop_color: self.swatch(s.color()),
                location_pct: (s.offset().get() * 100.0).clamp(0.0, 100.0),
                midpoint_pct: None,
            })
            .collect();
        let key = format!(
            "{}|{}",
            if radial { "R" } else { "L" },
            specs
                .iter()
                .map(|s| format!("{}@{:.2}", s.stop_color, s.location_pct))
                .collect::<Vec<_>>()
                .join(",")
        );
        if let Some(id) = self.gradients.get(&key) {
            return id.clone();
        }
        let id = format!("Gradient/svg-{:016x}", fnv(&key));
        if !self.doc.has_gradient(&id) {
            self.paint_ops.push(Mutation::CreateGradient {
                spec: GradientSpec {
                    self_id: Some(id.clone()),
                    name: Some(format!(
                        "SVG {} gradient {:04x}",
                        if radial { "radial" } else { "linear" },
                        fnv(&key) & 0xffff
                    )),
                    kind: if radial { "Radial" } else { "Linear" }.into(),
                    stops: specs,
                },
            });
        }
        self.gradients.insert(key, id.clone());
        id
    }

    /// Resolve `paint` under `ts` (the shape's map to page-local points).
    fn side_paint(&mut self, paint: &usvg::Paint, opacity: f32, ts: Affine) -> SidePaint {
        match paint {
            usvg::Paint::Color(c) => SidePaint {
                color: Some(self.swatch(*c)),
                opacity,
                gradient: None,
            },
            usvg::Paint::LinearGradient(g) => {
                if g.spread_method() != usvg::SpreadMethod::Pad {
                    self.report.approximated(
                        "gradient.spread",
                        "a gradient that reflects or repeats is drawn padded",
                    );
                }
                let m = ts.compose(Affine::from_usvg(g.transform()));
                let axis = linear_axis(m, [g.x1(), g.y1()], [g.x2(), g.y2()]);
                let (alpha_stops, opacity) = stop_alpha(g.stops(), opacity);
                let color = self.gradient_swatch(false, g.stops());
                SidePaint {
                    color: Some(color),
                    opacity,
                    gradient: axis.map(|(start, angle_deg, length)| GradientAxis {
                        radial: false,
                        start,
                        angle_deg,
                        length,
                        alpha_stops,
                    }),
                }
            }
            usvg::Paint::RadialGradient(g) => {
                if g.spread_method() != usvg::SpreadMethod::Pad {
                    self.report.approximated(
                        "gradient.spread",
                        "a gradient that reflects or repeats is drawn padded",
                    );
                }
                let m = ts.compose(Affine::from_usvg(g.transform()));
                if (g.fx() - g.cx()).abs() > 1e-4
                    || (g.fy() - g.cy()).abs() > 1e-4
                    || g.fr().get() > 1e-4
                {
                    self.report.approximated(
                        "gradient.focal",
                        "a radial gradient's focal point is moved to its centre",
                    );
                }
                if !m.is_similarity() {
                    self.report.approximated(
                        "gradient.radialSkew",
                        "a radial gradient under a skew or an uneven scale is drawn as a circle",
                    );
                }
                let (alpha_stops, opacity) = stop_alpha(g.stops(), opacity);
                let color = self.gradient_swatch(true, g.stops());
                SidePaint {
                    color: Some(color),
                    opacity,
                    gradient: Some(GradientAxis {
                        radial: true,
                        start: m.apply([g.cx(), g.cy()]),
                        angle_deg: 0.0,
                        length: g.r().get() * m.mean_scale(),
                        alpha_stops,
                    }),
                }
            }
            usvg::Paint::Pattern(_) => {
                self.report.dropped(
                    "pattern",
                    "a pattern paint is left out (the engine has no pattern paint yet)",
                );
                SidePaint {
                    color: None,
                    opacity,
                    gradient: None,
                }
            }
        }
    }

    // ------------------------------------------------------------ walk

    /// Lower the children of `g`, `ts` mapping its own space (its
    /// transform applied), through the shared walk (`crate::walk`).
    fn lower_children(&mut self, g: &usvg::Group, ts: Affine) -> Vec<Item> {
        self.frames.push(Vec::new());
        crate::walk::walk_children(g, ts, self);
        self.frames.pop().unwrap_or_default()
    }

    /// Whether the items being lowered must stay leaves: inside a clip or
    /// a mask, no group is made.
    fn flat(&self) -> bool {
        self.flat > 0
    }

    /// Hand `items` to the group being lowered.
    fn emit(&mut self, items: Vec<Item>) {
        if let Some(top) = self.frames.last_mut() {
            top.extend(items);
        }
    }

    /// A group's lowered children, finished: masked, clipped, grouped
    /// (or its opacity and blend folded into its items).
    fn finish_group(&mut self, g: &usvg::Group, ts: Affine, mut items: Vec<Item>) -> Vec<Item> {
        let flat = self.flat();
        if let Some(mask) = g.mask() {
            items = self.mask(mask, ts, items);
        }
        if let Some(clip) = g.clip_path() {
            items = self.clip(clip, ts, items);
        }
        if items.is_empty() {
            return items;
        }
        let opacity = g.opacity().get();
        let blend = g.blend_mode();
        if items.len() > 1 && !flat {
            let mut group = self.make_group(&items);
            let id = group.id();
            if opacity < 1.0 {
                self.ops
                    .push(set(&id, PropertyPath::FrameOpacity, pct(opacity)));
                group.opacity = opacity;
            }
            if blend != usvg::BlendMode::Normal {
                self.ops.push(set(
                    &id,
                    PropertyPath::FrameBlendMode,
                    text(blend_name(blend)),
                ));
                group.blended = true;
            }
            if g.isolate() {
                self.ops.push(set(
                    &id,
                    PropertyPath::GroupIsolateBlending,
                    Value::Bool(true),
                ));
            }
            return vec![group];
        }
        // One item, or leaves the caller needs: the group's opacity and
        // blend mode go onto each item.
        if items.len() > 1 && opacity < 1.0 {
            self.report.approximated(
                "opacity.group",
                "a clipped or masked group's opacity is applied to each of its items (overlaps show through)",
            );
        }
        if items.len() > 1 && blend != usvg::BlendMode::Normal {
            self.report.approximated(
                "blend.group",
                "a clipped or masked group's blend mode is applied to each of its items",
            );
        }
        for item in items.iter_mut() {
            if opacity < 1.0 {
                item.opacity *= opacity;
                self.ops.push(set(
                    &item.id(),
                    PropertyPath::FrameOpacity,
                    pct(item.opacity),
                ));
            }
            if blend != usvg::BlendMode::Normal {
                if item.blended {
                    self.report.approximated(
                        "blend.nested",
                        "a blend mode over an item that blends itself keeps the inner one",
                    );
                } else {
                    self.ops.push(set(
                        &item.id(),
                        PropertyPath::FrameBlendMode,
                        text(blend_name(blend)),
                    ));
                    item.blended = true;
                }
            }
        }
        items
    }

    fn make_group(&mut self, items: &[Item]) -> Item {
        self.ops.push(Mutation::CreateGroup {
            member_ids: items.iter().map(Item::id).collect(),
        });
        self.bind(Kind::Group)
    }

    /// The contours of a clip path's content, in page-local points, each
    /// with whether it fills even-odd.
    fn clip_contours(&mut self, g: &usvg::Group, ts: Affine) -> Vec<(Contour, bool)> {
        let mut out = Vec::new();
        let mut nested = false;
        crate::walk::clip_nodes(g, ts, &compose_affine, &mut |node| match node {
            crate::walk::ClipNode::Shape { path, ts, rule } => {
                let even_odd = rule == usvg::FillRule::EvenOdd;
                for c in geom::contours(path.data(), ts) {
                    out.push((c, even_odd));
                }
                crate::walk::Enter::Skip
            }
            crate::walk::ClipNode::ClippedGroup { .. } => {
                nested = true;
                crate::walk::Enter::Children
            }
        });
        if nested {
            self.report
                .approximated("clip.nested", "a clip path inside a clip path is ignored");
        }
        out
    }

    fn clip(&mut self, clip: &usvg::ClipPath, ts: Affine, items: Vec<Item>) -> Vec<Item> {
        if clip.clip_path().is_some() {
            self.report
                .approximated("clip.nested", "a clip path inside a clip path is ignored");
        }
        let space = crate::walk::clip_space(clip, ts, &compose_affine);
        let shapes = self.clip_contours(clip.root(), space);
        if shapes.is_empty()
            || !geom::finite(&shapes.iter().map(|s| s.0.clone()).collect::<Vec<_>>())
        {
            self.report.approximated(
                "clip.empty",
                "a clip path with no shape is ignored (the content shows unclipped)",
            );
            return items;
        }
        let even_odd = shapes.iter().any(|s| s.1);
        if even_odd && shapes.len() > 1 {
            self.report.approximated(
                "clip.compound",
                "a clip path of several even-odd shapes clips by their non-zero union",
            );
        }
        let contours: Vec<Contour> = shapes.into_iter().map(|s| s.0).collect();
        let mut out = Vec::new();
        for item in items {
            if !item.is_leaf() {
                self.report.dropped(
                    "clip.group",
                    "a clip over a group could not be applied; the group shows unclipped",
                );
                out.push(item);
                continue;
            }
            let Some(container) = self.insert_contours(&contours) else {
                out.push(item);
                continue;
            };
            let cid = container.id();
            self.ops.push(set(
                &cid,
                PropertyPath::FrameFillColor,
                Value::ColorRef(None),
            ));
            self.ops.push(set(
                &cid,
                PropertyPath::FrameStrokeColor,
                Value::ColorRef(None),
            ));
            self.ops.push(set(
                &cid,
                PropertyPath::FrameStrokeWeight,
                Value::Length(Some(0.0)),
            ));
            if even_odd {
                self.ops
                    .push(set(&cid, PropertyPath::FrameFillRule, text("EvenOdd")));
            }
            self.ops.push(Mutation::PasteInto {
                container_id: cid,
                child_id: item.id(),
            });
            out.push(container);
        }
        out
    }

    fn mask(&mut self, mask: &usvg::Mask, ts: Affine, items: Vec<Item>) -> Vec<Item> {
        if mask.mask().is_some() {
            self.report
                .approximated("mask.nested", "a mask on a mask is ignored");
        }
        let kind = match mask.kind() {
            usvg::MaskType::Luminance => "luminosity",
            usvg::MaskType::Alpha => "alpha",
        };
        let root = mask.root();
        let mts = ts.compose(Affine::from_usvg(root.transform()));
        if items.len() > 1 {
            self.report.approximated(
                "mask.perItem",
                "a mask over several items masks each item on its own (overlaps differ where the mask is partial)",
            );
        }
        let mut out = Vec::new();
        for item in items {
            if item.kind == Kind::TextFrame || !item.is_leaf() {
                self.report.dropped(
                    "mask.target",
                    "a mask over text or a group could not be applied; the content shows unmasked",
                );
                out.push(item);
                continue;
            }
            let mark = self.mark();
            self.flat += 1;
            let shapes = self.lower_children(root, mts);
            self.flat -= 1;
            match shapes.as_slice() {
                [one] if one.kind != Kind::TextFrame && one.is_leaf() => {
                    self.ops.push(Mutation::ApplyOpacityMask {
                        target_id: item.id(),
                        mask_id: one.id(),
                        mask_type: Some(kind.to_string()),
                        invert: None,
                    });
                    // The mask artwork is no page item of its own any more.
                    self.items -= 1;
                }
                [] => {
                    self.rollback(mark);
                    self.report.approximated(
                        "mask.empty",
                        "an empty mask is ignored (the content shows unmasked)",
                    );
                }
                _ => {
                    self.rollback(mark);
                    self.report.dropped(
                        "mask.complex",
                        "a mask of several shapes or of text is left out; the content shows unmasked",
                    );
                }
            }
            out.push(item);
        }
        out
    }

    /// `insertPath` the first contour, then the whole table when there
    /// are more. Returns the polygon.
    fn insert_contours(&mut self, contours: &[Contour]) -> Option<Item> {
        let first = contours.first()?;
        self.ops.push(Mutation::InsertPath {
            page_id: self.page(),
            anchors: first.anchors.clone(),
            open: !first.closed,
            smooth: false,
        });
        let item = self.bind(Kind::Polygon);
        if contours.len() > 1 {
            let [ox, oy] = self.origin();
            let mut anchors: Vec<PathAnchorSpec> = Vec::new();
            let mut starts = Vec::new();
            for c in contours {
                starts.push(anchors.len());
                anchors.extend(geom::shifted(&c.anchors, ox, oy));
            }
            let id = item.id();
            self.ops.push(set(
                &id,
                PropertyPath::FramePath,
                Value::FramePath {
                    anchors,
                    subpath_starts: starts,
                },
            ));
            if let Some([t, l, b, r]) = geom::bounds(contours) {
                self.ops.push(set(
                    &id,
                    PropertyPath::FrameBounds,
                    Value::Bounds([t + oy, l + ox, b + oy, r + ox]),
                ));
            }
        }
        Some(item)
    }

    fn path(&mut self, p: &usvg::Path, ts: Affine) -> Vec<Item> {
        let flat = self.flat();
        if !p.is_visible() || (p.fill().is_none() && p.stroke().is_none()) {
            return Vec::new();
        }
        let contours = geom::contours(p.data(), ts);
        if contours.is_empty() {
            return Vec::new();
        }
        if !geom::finite(&contours) {
            self.report.dropped(
                "path.nonFinite",
                "a path with a coordinate that is not a number is left out",
            );
            return Vec::new();
        }
        let fill = p
            .fill()
            .map(|f| (self.side_paint(f.paint(), f.opacity().get(), ts), f.rule()));
        let stroke = p
            .stroke()
            .map(|s| (self.side_paint(s.paint(), s.opacity().get(), ts), s));
        if p.paint_order() == usvg::PaintOrder::StrokeAndFill && fill.is_some() && stroke.is_some()
        {
            self.report.approximated(
                "paintOrder",
                "a stroke painted under its fill (paint-order) is drawn over it",
            );
        }
        let any_open = contours.iter().any(|c| !c.closed);
        // `framePath` carries no open flags: a compound with open
        // contours is split when that draws the same (no fill), and kept
        // whole (its open contours drawn closed) when it is filled.
        let pieces: Vec<Vec<Contour>> = if any_open && contours.len() > 1 {
            if fill.is_none() {
                contours.into_iter().map(|c| vec![c]).collect()
            } else {
                self.report.approximated(
                    "path.openCompound",
                    "a filled shape with several contours, some open, draws its open contours closed",
                );
                vec![contours]
            }
        } else {
            vec![contours]
        };
        let mut items = Vec::new();
        for piece in &pieces {
            let Some(item) = self.insert_contours(piece) else {
                continue;
            };
            self.paint_shape(&item, piece, fill.as_ref(), stroke.as_ref(), ts);
            items.push(item);
        }
        if items.len() > 1 && !flat {
            return vec![self.make_group(&items)];
        }
        items
    }

    fn paint_shape(
        &mut self,
        item: &Item,
        contours: &[Contour],
        fill: Option<&(SidePaint, usvg::FillRule)>,
        stroke: Option<&(SidePaint, &usvg::Stroke)>,
        ts: Affine,
    ) {
        let id = item.id();
        let [ox, oy] = self.origin();
        // Fill.
        let fill_color = fill.and_then(|(p, _)| p.color.clone());
        self.ops.push(set(
            &id,
            PropertyPath::FrameFillColor,
            Value::ColorRef(fill_color.clone()),
        ));
        if let Some((paint, rule)) = fill {
            if *rule == usvg::FillRule::EvenOdd {
                self.ops
                    .push(set(&id, PropertyPath::FrameFillRule, text("EvenOdd")));
            }
            if paint.opacity < 1.0 {
                self.ops
                    .push(set(&id, PropertyPath::FrameFillOpacity, pct(paint.opacity)));
            }
            if let Some(axis) = &paint.gradient {
                let start = [axis.start[0] + ox, axis.start[1] + oy];
                self.ops.push(set(
                    &id,
                    PropertyPath::FrameGradientFillStart,
                    Value::Lengths(start.to_vec()),
                ));
                self.ops.push(set(
                    &id,
                    PropertyPath::FrameGradientFillAngle,
                    Value::Length(Some(axis.angle_deg)),
                ));
                self.ops.push(set(
                    &id,
                    PropertyPath::FrameGradientFillLength,
                    Value::Length(Some(axis.length.max(1e-3))),
                ));
                if let Some(alpha) = &axis.alpha_stops {
                    if stroke.is_some() {
                        self.report.approximated(
                            "gradient.stopOpacity",
                            "a gradient's stop opacity is drawn as a gradient feather, which fades the stroke too",
                        );
                    }
                    let (sx, sy) = (start[0], start[1]);
                    let rad = axis.angle_deg.to_radians();
                    let end = if axis.radial {
                        [sx + axis.length, sy]
                    } else {
                        [sx + axis.length * rad.cos(), sy - axis.length * rad.sin()]
                    };
                    self.ops.push(set(
                        &id,
                        PropertyPath::FrameGradientFeather,
                        Value::GradientFeather(Some(GradientFeatherSpec {
                            gradient_type: Some(
                                if axis.radial { "Radial" } else { "Linear" }.into(),
                            ),
                            start_point: Some([sx, sy]),
                            end_point: Some(end),
                            angle_deg: None,
                            stops: alpha
                                .iter()
                                .map(|(o, a)| GradientFeatherStopSpec {
                                    stop_color: None,
                                    location_pct: o * 100.0,
                                    alpha_pct: a * 100.0,
                                    midpoint_pct: 50.0,
                                })
                                .collect(),
                        })),
                    ));
                }
            }
        }
        // Stroke.
        let stroke_color = stroke.and_then(|(p, _)| p.color.clone());
        self.ops.push(set(
            &id,
            PropertyPath::FrameStrokeColor,
            Value::ColorRef(stroke_color.clone()),
        ));
        let Some((paint, s)) = stroke.filter(|_| stroke_color.is_some()) else {
            self.ops.push(set(
                &id,
                PropertyPath::FrameStrokeWeight,
                Value::Length(Some(0.0)),
            ));
            return;
        };
        if !ts.is_similarity() {
            self.report.approximated(
                "stroke.nonUniform",
                "a stroke under a skew or an uneven scale is drawn at its mean width",
            );
        }
        let k = ts.mean_scale();
        self.ops.push(set(
            &id,
            PropertyPath::FrameStrokeWeight,
            Value::Length(Some(s.width().get() * k)),
        ));
        if paint.opacity < 1.0 {
            self.ops.push(set(
                &id,
                PropertyPath::FrameStrokeOpacity,
                pct(paint.opacity),
            ));
        }
        if let Some(axis) = &paint.gradient {
            self.report.approximated(
                "gradient.stroke",
                "a stroke gradient keeps its angle and length; its start is the shape's default",
            );
            self.ops.push(set(
                &id,
                PropertyPath::FrameGradientStrokeAngle,
                Value::Length(Some(axis.angle_deg)),
            ));
            self.ops.push(set(
                &id,
                PropertyPath::FrameGradientStrokeLength,
                Value::Length(Some(axis.length.max(1e-3))),
            ));
        }
        let cap = match s.linecap() {
            usvg::LineCap::Butt => None,
            usvg::LineCap::Round => Some("RoundEndCap"),
            usvg::LineCap::Square => Some("ProjectingEndCap"),
        };
        if let Some(cap) = cap {
            self.ops
                .push(set(&id, PropertyPath::FrameStrokeEndCap, text(cap)));
        }
        let join = match s.linejoin() {
            usvg::LineJoin::Miter => None,
            usvg::LineJoin::MiterClip => {
                self.report.approximated(
                    "stroke.miterClip",
                    "a miter-clip join is drawn as a miter join",
                );
                None
            }
            usvg::LineJoin::Round => Some("RoundEndJoin"),
            usvg::LineJoin::Bevel => Some("BevelEndJoin"),
        };
        if let Some(join) = join {
            self.ops
                .push(set(&id, PropertyPath::FrameStrokeJoin, text(join)));
        }
        let miter = s.miterlimit().get();
        if (miter - 4.0).abs() > 1e-3 {
            self.ops.push(set(
                &id,
                PropertyPath::FrameStrokeMiterLimit,
                Value::Number(miter.clamp(1.0, 500.0) as f64),
            ));
        }
        if let Some(dashes) = s.dasharray() {
            let period: f32 = dashes.iter().sum();
            if period > 0.0 {
                let mut pattern: Vec<f32> = dashes.iter().map(|d| d * k).collect();
                if pattern.len() % 2 == 1 {
                    pattern.extend_from_slice(&pattern.clone());
                }
                if (s.dashoffset() % period).abs() > 1e-4 {
                    self.report.approximated(
                        "stroke.dashOffset",
                        "a dash offset is dropped: the dashes start at the path's start",
                    );
                }
                self.ops.push(set(
                    &id,
                    PropertyPath::FrameStrokeDashArray,
                    Value::Lengths(pattern),
                ));
            }
        }
        let _ = contours;
    }

    fn image(&mut self, img: &usvg::Image, ts: Affine) -> Vec<Item> {
        if !img.is_visible() {
            return Vec::new();
        }
        let size = img.size();
        let (mime, data) = match img.kind() {
            // A nested SVG image is walked in place (`crate::walk`).
            usvg::ImageKind::SVG(_) => return Vec::new(),
            usvg::ImageKind::JPEG(d) => ("image/jpeg", d),
            usvg::ImageKind::PNG(d) => ("image/png", d),
            usvg::ImageKind::GIF(d) => ("image/gif", d),
            usvg::ImageKind::WEBP(d) => ("image/webp", d),
        };
        use base64::Engine as _;
        let uri = format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(data.as_slice())
        );
        let (w, h) = (size.width(), size.height());
        if !ts.is_finite() {
            return Vec::new();
        }
        let item = if ts.is_axis_aligned() {
            let [l, t] = ts.apply([0.0, 0.0]);
            let [r, b] = ts.apply([w, h]);
            self.ops.push(Mutation::InsertFrame {
                page_id: self.page(),
                bounds: (t, l, b, r),
            });
            let item = self.bind(Kind::Rectangle);
            self.place(&item, uri);
            item
        } else {
            // The frame's own box is the image's (0, 0, w, h), and the
            // transform places it: page-local bounds offset by the page's
            // origin land the box at spread (0, 0).
            let [ox, oy] = self.origin();
            self.ops.push(Mutation::InsertFrame {
                page_id: self.page(),
                bounds: (-oy, -ox, h - oy, w - ox),
            });
            let item = self.bind(Kind::Rectangle);
            self.place(&item, uri);
            self.ops.push(Mutation::MoveFrame {
                frame_id: format!("$h:{}", item.handle),
                transform: ts.0,
            });
            item
        };
        vec![item]
    }

    fn place(&mut self, item: &Item, uri: String) {
        let id = item.id();
        self.ops.push(set(
            &id,
            PropertyPath::FrameFillColor,
            Value::ColorRef(None),
        ));
        self.ops.push(set(
            &id,
            PropertyPath::FrameStrokeColor,
            Value::ColorRef(None),
        ));
        self.ops.push(set(
            &id,
            PropertyPath::FrameStrokeWeight,
            Value::Length(Some(0.0)),
        ));
        self.ops.push(Mutation::PlaceImage {
            element_id: format!("$h:{}", item.handle),
            uri,
            fit: Some("ContentToFrame".into()),
        });
    }

    /// Text as text frames, or `None` when it is to be its outlines
    /// (which the walk then lowers as a group).
    fn text_items(&mut self, t: &usvg::Text, ts: Affine) -> Option<Vec<Item>> {
        self.text_nodes += 1;
        if self.text_mode == SvgImportText::Auto {
            match text::plain_text(t, ts, self.fonts) {
                Ok(lines) => return Some(self.text_frames(lines)),
                Err(why) => self.report.approximated("text.outlined", why),
            }
        }
        None
    }

    fn text_frames(&mut self, lines: Vec<text::Line>) -> Vec<Item> {
        let mut out = Vec::new();
        for line in lines {
            self.ops.push(Mutation::InsertTextFrame {
                page_id: self.page(),
                bounds: (line.top, line.left, line.bottom, line.right),
            });
            let item = self.bind(Kind::TextFrame);
            let id = item.id();
            self.ops.push(set(
                &id,
                PropertyPath::FrameFillColor,
                Value::ColorRef(None),
            ));
            self.ops.push(set(
                &id,
                PropertyPath::FrameStrokeColor,
                Value::ColorRef(None),
            ));
            let story = format!("$h:{}", item.handle);
            self.ops.push(Mutation::InsertText {
                story_id: story.clone(),
                offset: 0,
                text: line.text.clone(),
                cell: None,
            });
            let n = line.text.chars().count() as u32;
            let whole = ElementId::StoryRange {
                story_id: story.clone(),
                start: 0,
                end: n,
            };
            if let Some(j) = line.justification {
                self.ops
                    .push(set(&whole, PropertyPath::ParagraphJustification, text(j)));
            }
            for run in &line.runs {
                let range = ElementId::StoryRange {
                    story_id: story.clone(),
                    start: run.start,
                    end: run.end,
                };
                let fill = run.fill.map(|c| self.swatch(c));
                self.ops.push(set(
                    &range,
                    PropertyPath::CharacterFontFamily,
                    text(&run.family),
                ));
                self.ops.push(set(
                    &range,
                    PropertyPath::CharacterFontStyle,
                    text(&run.style),
                ));
                self.ops.push(set(
                    &range,
                    PropertyPath::CharacterFontSize,
                    Value::Length(Some(run.size)),
                ));
                self.ops.push(set(
                    &range,
                    PropertyPath::CharacterFillColor,
                    Value::ColorRef(fill),
                ));
                if run.tracking.abs() > 1e-3 {
                    self.ops.push(set(
                        &range,
                        PropertyPath::CharacterTracking,
                        Value::Length(Some(run.tracking)),
                    ));
                }
                if run.underline {
                    self.ops.push(set(
                        &range,
                        PropertyPath::CharacterUnderline,
                        Value::Bool(true),
                    ));
                }
                if run.strike {
                    self.ops.push(set(
                        &range,
                        PropertyPath::CharacterStrikethru,
                        Value::Bool(true),
                    ));
                }
            }
            out.push(item);
        }
        out
    }
}

fn compose_affine(parent: Affine, local: usvg::Transform) -> Affine {
    parent.compose(Affine::from_usvg(local))
}

/// The import's half of the shared walk: each node lowers into the items
/// of the group being walked, and a group is finished (masked, clipped,
/// grouped) when the walk leaves it.
impl crate::walk::Visitor for Lower<'_> {
    type Ts = Affine;

    fn compose(&self, parent: Affine, local: usvg::Transform) -> Affine {
        parent.compose(Affine::from_usvg(local))
    }

    fn enter_group(&mut self, g: &usvg::Group, _: Affine) -> crate::walk::Enter {
        if !g.filters().is_empty() {
            self.report.dropped(
                "filter",
                "a filter effect (blur, shadow, colour matrix, …) is left out; the content is kept",
            );
        }
        if g.clip_path().is_some() || g.mask().is_some() {
            self.flat += 1;
        }
        self.frames.push(Vec::new());
        crate::walk::Enter::Children
    }

    fn leave_group(&mut self, g: &usvg::Group, ts: Affine) {
        let items = self.frames.pop().unwrap_or_default();
        if g.clip_path().is_some() || g.mask().is_some() {
            self.flat -= 1;
        }
        let items = self.finish_group(g, ts, items);
        self.emit(items);
    }

    fn path(&mut self, p: &usvg::Path, ts: Affine) {
        let items = Lower::path(self, p, ts);
        self.emit(items);
    }

    fn image(&mut self, img: &usvg::Image, ts: Affine) {
        let items = Lower::image(self, img, ts);
        self.emit(items);
    }

    fn text(&mut self, t: &usvg::Text, ts: Affine) -> crate::walk::Enter {
        match self.text_items(t, ts) {
            Some(items) => {
                self.emit(items);
                crate::walk::Enter::Skip
            }
            None => crate::walk::Enter::Children,
        }
    }
}

/// The stops' opacity: `(per-stop alphas, side opacity)`. Stops of one
/// opacity fold it into the side's opacity; stops that differ keep their
/// alphas for a feather.
fn stop_alpha(stops: &[usvg::Stop], opacity: f32) -> (Option<Vec<(f32, f32)>>, f32) {
    let Some(first) = stops.first().map(|s| s.opacity().get()) else {
        return (None, opacity);
    };
    if stops
        .iter()
        .all(|s| (s.opacity().get() - first).abs() < 1e-4)
    {
        (None, opacity * first)
    } else {
        (
            Some(
                stops
                    .iter()
                    .map(|s| (s.offset().get(), s.opacity().get()))
                    .collect(),
            ),
            opacity,
        )
    }
}

/// A linear gradient from `p1` to `p2` in gradient space, mapped by `m`,
/// as the engine's `(start, angle, length)` in page space. Solved, not
/// mapped: under a skew the isolines stay where they were, so the axis is
/// the normal of the mapped isolines, `start` the mapped `p1`, and the
/// length the distance between the isolines of offsets 0 and 1.
fn linear_axis(m: Affine, p1: [f32; 2], p2: [f32; 2]) -> Option<([f32; 2], f32, f32)> {
    let [a, b, c, d, ..] = m.0;
    let det = a * d - b * c;
    if det.abs() < 1e-12 {
        return None;
    }
    let (dx, dy) = (p2[0] - p1[0], p2[1] - p1[1]);
    let len2 = dx * dx + dy * dy;
    if len2 < 1e-12 {
        return None;
    }
    // t(q') = dot(M⁻¹q' − p1, d) / |d|²: its gradient is M⁻ᵀ·d / |d|².
    // M⁻¹ = 1/det [d −c; −b a], so M⁻ᵀ·v = 1/det (d·vx − b·vy, −c·vx + a·vy).
    let wx = (d * dx - b * dy) / det / len2;
    let wy = (-c * dx + a * dy) / det / len2;
    let wn = (wx * wx + wy * wy).sqrt();
    if wn < 1e-12 {
        return None;
    }
    let length = 1.0 / wn;
    let angle = (-wy).atan2(wx).to_degrees();
    Some((m.apply(p1), angle, length))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_linear_axis_under_a_similarity_is_the_mapped_segment() {
        let m = Affine([2.0, 0.0, 0.0, 2.0, 10.0, 0.0]);
        let (s, a, l) = linear_axis(m, [0.0, 0.0], [10.0, 0.0]).unwrap();
        assert_eq!(s, [10.0, 0.0]);
        assert!(a.abs() < 1e-4);
        assert!((l - 20.0).abs() < 1e-3);
        // Pointing down the page is −90° in the engine's (cos θ, −sin θ).
        let (_, a, _) = linear_axis(Affine::IDENTITY, [0.0, 0.0], [0.0, 10.0]).unwrap();
        assert!((a + 90.0).abs() < 1e-3, "{a}");
    }

    #[test]
    fn a_skewed_linear_axis_keeps_its_isolines() {
        // skewX(45°): a horizontal gradient's vertical isolines lean, and
        // the page-space axis is their normal, shorter than the segment.
        let m = Affine([1.0, 0.0, 1.0, 1.0, 0.0, 0.0]);
        let (_, a, l) = linear_axis(m, [0.0, 0.0], [10.0, 0.0]).unwrap();
        // Isolines x − y = const: normal (1, −1)/√2 → 45° in (cos, −sin).
        assert!((a - 45.0).abs() < 1e-3, "{a}");
        assert!((l - 10.0 / 2f32.sqrt()).abs() < 1e-3, "{l}");
    }
}
