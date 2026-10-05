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

//! # pptx-import — `.pptx` bytes → [`pptx_core::Presentation`]
//!
//! Walks the package the way PowerPoint does: `_rels/.rels` names the main
//! part, `ppt/presentation.xml` lists masters and slides by relationship id,
//! each master names its theme and layouts, each slide its layout and notes.
//! Parts are read with `paged-ooxml` (OPC + rels) and a small element tree
//! ([`xml`]); nothing is resolved here — see `slide-resolve`.
//!
//! Errors are reserved for a package that is not a presentation at all (no
//! main part, unreadable zip). Anything inside that cannot be read becomes a
//! line in [`Presentation::diagnostics`] and the rest of the deck still loads.

use std::cell::RefCell;
use std::collections::BTreeMap;

use paged_ooxml::{part_dir, rels_part_name, resolve_target, OpcPackage, Relationships};
use pptx_core::{
    Background, ColorMap, EmbeddedFont, FontSet, Layout, Master, Presentation, Section, Slide,
    Theme, Transition,
};

pub mod paint;
pub mod shapes;
pub mod text;
pub mod xml;

use xml::{alternate, El, Ns};

/// The deck could not be read at all.
#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("not an OPC package: {0}")]
    Package(String),
    #[error("no presentation part (is this a .pptx?)")]
    NoPresentation,
    #[error("{part}: {detail}")]
    Part { part: String, detail: String },
}

/// Per-part reading context: where relative targets resolve from, the part's
/// relationships, and the shared diagnostics list.
pub struct Ctx<'a> {
    part: String,
    dir: String,
    pub rels: Relationships,
    diagnostics: &'a RefCell<Vec<String>>,
}

impl<'a> Ctx<'a> {
    fn new(pkg: &OpcPackage, part: &str, diagnostics: &'a RefCell<Vec<String>>) -> Self {
        let rels = pkg
            .part(&rels_part_name(part))
            .map(Relationships::parse)
            .unwrap_or_default();
        Ctx {
            part: part.to_string(),
            dir: part_dir(part).to_string(),
            rels,
            diagnostics,
        }
    }
    /// A relationship target, as an absolute part name.
    pub fn resolve(&self, target: &str) -> String {
        resolve_target(&self.dir, target)
    }
    /// The part a relationship id points at (internal targets only).
    pub fn target(&self, id: &str) -> Option<String> {
        let r = self.rels.by_id(id)?;
        (r.target_mode.as_deref() != Some("External")).then(|| self.resolve(&r.target))
    }
    /// The first internal target whose relationship type ends with `suffix`.
    pub fn target_of_type(&self, suffix: &str) -> Option<String> {
        self.rels
            .items
            .iter()
            .find(|r| r.rel_type.ends_with(suffix) && r.target_mode.as_deref() != Some("External"))
            .map(|r| self.resolve(&r.target))
    }
    /// Record something this reader does not model.
    pub fn note(&self, what: String) {
        self.diagnostics
            .borrow_mut()
            .push(format!("{}: {what}", self.part));
    }
}

fn read_part(pkg: &OpcPackage, part: &str) -> Result<El, ImportError> {
    let bytes = pkg.part(part).ok_or_else(|| ImportError::Part {
        part: part.to_string(),
        detail: "missing".into(),
    })?;
    xml::parse(bytes).map_err(|detail| ImportError::Part {
        part: part.to_string(),
        detail,
    })
}

/// Read a `.pptx`.
pub fn import_pptx(bytes: &[u8]) -> Result<Presentation, ImportError> {
    let pkg = OpcPackage::read(bytes).map_err(|e| ImportError::Package(e.to_string()))?;
    let diagnostics = RefCell::new(Vec::new());
    let root = Ctx::new(&pkg, "", &diagnostics);
    let main = root
        .target_of_type("/officeDocument")
        .ok_or(ImportError::NoPresentation)?;
    let pres_el = read_part(&pkg, &main)?;
    if !pres_el.is(Ns::P, "presentation") {
        return Err(ImportError::NoPresentation);
    }
    let ctx = Ctx::new(&pkg, &main, &diagnostics);

    let size = |name: &str| {
        pres_el
            .child(Ns::P, name)
            .map(|s| (s.attr_i64("cx").unwrap_or(0), s.attr_i64("cy").unwrap_or(0)))
    };
    let mut deck = Presentation {
        slide_size: size("sldSz").unwrap_or((12_192_000, 6_858_000)),
        notes_size: size("notesSz").unwrap_or((6_858_000, 9_144_000)),
        default_text_style: pres_el
            .child(Ns::P, "defaultTextStyle")
            .map(|d| text::list_style(d, &ctx)),
        embedded_fonts: embedded_fonts(&pres_el, &ctx),
        sections: sections(&pres_el),
        ..Default::default()
    };

    // Masters, their themes and layouts.
    let mut theme_parts: Vec<String> = Vec::new();
    if let Some(list) = pres_el.child(Ns::P, "sldMasterIdLst") {
        for m in list.children_named(Ns::P, "sldMasterId") {
            let Some(part) = m.attr_ns(Ns::R, "id").and_then(|id| ctx.target(id)) else {
                ctx.note("a slide master relationship does not resolve".into());
                continue;
            };
            match master(&pkg, &part, &diagnostics) {
                Ok((mst, layouts)) => {
                    if let Some(t) = &mst.theme_part {
                        if !theme_parts.contains(t) {
                            theme_parts.push(t.clone());
                        }
                    }
                    deck.layouts.extend(layouts);
                    deck.masters.push(mst);
                }
                Err(e) => diagnostics.borrow_mut().push(e.to_string()),
            }
        }
    }
    for t in theme_parts {
        match read_part(&pkg, &t) {
            Ok(el) => deck
                .themes
                .push(theme(&el, &Ctx::new(&pkg, &t, &diagnostics))),
            Err(e) => diagnostics.borrow_mut().push(e.to_string()),
        }
    }

    // Slides, in presentation order.
    if let Some(list) = pres_el.child(Ns::P, "sldIdLst") {
        for s in list.children_named(Ns::P, "sldId") {
            let slide_id = s.attr_u32("id").unwrap_or(0);
            let Some(part) = s.attr_ns(Ns::R, "id").and_then(|id| ctx.target(id)) else {
                ctx.note(format!("slide {slide_id}: relationship does not resolve"));
                continue;
            };
            match slide(&pkg, &part, slide_id, &diagnostics) {
                Ok(sl) => deck.slides.push(sl),
                Err(e) => diagnostics.borrow_mut().push(e.to_string()),
            }
        }
    }

    deck.diagnostics = summarise(diagnostics.into_inner());
    Ok(deck)
}

/// Collapse repeated lines into "line (×n)" so a deck with 300 unmodelled
/// effects reports one line, not 300.
fn summarise(lines: Vec<String>) -> Vec<String> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for l in lines {
        *counts.entry(l).or_default() += 1;
    }
    counts
        .into_iter()
        .map(|(l, n)| if n > 1 { format!("{l} (×{n})") } else { l })
        .collect()
}

fn color_map(el: &El) -> ColorMap {
    ColorMap {
        entries: el
            .attrs
            .iter()
            .filter(|a| a.ns == Ns::Other)
            .map(|a| (a.local.clone(), a.value.clone()))
            .collect(),
    }
}

fn background(csld: &El, ctx: &Ctx) -> Option<Background> {
    let bg = csld.child(Ns::P, "bg")?;
    if let Some(pr) = bg.child(Ns::P, "bgPr") {
        return paint::fill_in(pr, ctx).map(Background::Fill);
    }
    let r = bg.child(Ns::P, "bgRef")?;
    Some(Background::StyleRef {
        idx: r.attr_u32("idx").unwrap_or(0),
        color: paint::color_in(r),
    })
}

fn shapes_of(csld: &El, ctx: &Ctx) -> Vec<pptx_core::Shape> {
    csld.child(Ns::P, "spTree")
        .map(|t| shapes::shape_tree(t, ctx))
        .unwrap_or_default()
}

fn master(
    pkg: &OpcPackage,
    part: &str,
    diagnostics: &RefCell<Vec<String>>,
) -> Result<(Master, Vec<Layout>), ImportError> {
    let el = read_part(pkg, part)?;
    let ctx = Ctx::new(pkg, part, diagnostics);
    let csld = el.child(Ns::P, "cSld");
    let styles = el.child(Ns::P, "txStyles");
    let style = |name: &str| {
        styles
            .and_then(|s| s.child(Ns::P, name))
            .map(|s| text::list_style(s, &ctx))
    };
    let mut layouts = Vec::new();
    let mut layout_parts = Vec::new();
    if let Some(list) = el.child(Ns::P, "sldLayoutIdLst") {
        for l in list.children_named(Ns::P, "sldLayoutId") {
            let Some(lp) = l.attr_ns(Ns::R, "id").and_then(|id| ctx.target(id)) else {
                continue;
            };
            match layout(pkg, &lp, part, diagnostics) {
                Ok(lay) => {
                    layout_parts.push(lp);
                    layouts.push(lay);
                }
                Err(e) => diagnostics.borrow_mut().push(e.to_string()),
            }
        }
    }
    Ok((
        Master {
            part: part.to_string(),
            theme_part: ctx.target_of_type("/theme"),
            background: csld.and_then(|c| background(c, &ctx)),
            shapes: csld.map(|c| shapes_of(c, &ctx)).unwrap_or_default(),
            color_map: el.child(Ns::P, "clrMap").map(color_map).unwrap_or_default(),
            title_style: style("titleStyle"),
            body_style: style("bodyStyle"),
            other_style: style("otherStyle"),
            layouts: layout_parts,
        },
        layouts,
    ))
}

fn layout(
    pkg: &OpcPackage,
    part: &str,
    master_part: &str,
    diagnostics: &RefCell<Vec<String>>,
) -> Result<Layout, ImportError> {
    let el = read_part(pkg, part)?;
    let ctx = Ctx::new(pkg, part, diagnostics);
    let csld = el.child(Ns::P, "cSld");
    Ok(Layout {
        part: part.to_string(),
        name: csld.and_then(|c| c.attr("name")).map(str::to_string),
        layout_type: el.attr("type").map(str::to_string),
        master_part: master_part.to_string(),
        show_master_shapes: el.attr_bool("showMasterSp").unwrap_or(true),
        background: csld.and_then(|c| background(c, &ctx)),
        shapes: csld.map(|c| shapes_of(c, &ctx)).unwrap_or_default(),
        color_map_override: color_map_override(&el),
    })
}

fn color_map_override(el: &El) -> Option<ColorMap> {
    el.child(Ns::P, "clrMapOvr")
        .and_then(|o| o.child(Ns::A, "overrideClrMapping"))
        .map(color_map)
}

fn slide(
    pkg: &OpcPackage,
    part: &str,
    slide_id: u32,
    diagnostics: &RefCell<Vec<String>>,
) -> Result<Slide, ImportError> {
    let el = read_part(pkg, part)?;
    let ctx = Ctx::new(pkg, part, diagnostics);
    let csld = el.child(Ns::P, "cSld");
    let mut transition = None;
    let mut timing_xml = None;
    for c in &el.children {
        if c.is(Ns::P, "transition") {
            transition = Some(read_transition(c, c));
        } else if c.is(Ns::Mc, "AlternateContent") {
            let (choice, fallback) = alternate(c);
            let t = choice
                .and_then(|ch| ch.child(Ns::P, "transition"))
                .or_else(|| fallback.and_then(|f| f.child(Ns::P, "transition")));
            if let Some(t) = t {
                transition = Some(read_transition(c, t));
            }
        } else if c.is(Ns::P, "timing") {
            timing_xml = Some(c.to_xml());
        }
    }
    Ok(Slide {
        part: part.to_string(),
        slide_id,
        layout_part: ctx.target_of_type("/slideLayout"),
        name: csld.and_then(|c| c.attr("name")).map(str::to_string),
        hidden: el.attr_bool("show").map(|s| !s).unwrap_or(false),
        show_master_shapes: el.attr_bool("showMasterSp").unwrap_or(true),
        background: csld.and_then(|c| background(c, &ctx)),
        shapes: csld.map(|c| shapes_of(c, &ctx)).unwrap_or_default(),
        color_map_override: color_map_override(&el),
        notes: ctx
            .target_of_type("/notesSlide")
            .and_then(|n| notes(pkg, &n, diagnostics)),
        transition,
        timing_xml,
    })
}

/// `outer` is what export writes back (the `p:transition` or its
/// `mc:AlternateContent` wrapper); `t` is the transition element read for
/// its effect.
fn read_transition(outer: &El, t: &El) -> Transition {
    let effect = t
        .children
        .iter()
        .find(|c| !matches!(c.local.as_str(), "sndAc" | "extLst"));
    let speed_ms = |s: &str| match s {
        "slow" => 1000,
        "med" => 750,
        _ => 500,
    };
    let duration_ms = t
        .attrs
        .iter()
        .find(|a| a.local == "dur")
        .and_then(|a| a.value.parse().ok())
        .or_else(|| t.attr("spd").map(speed_ms));
    Transition {
        xml: outer.to_xml(),
        kind: effect.map(|e| e.local.clone()),
        dir: effect.and_then(|e| e.attr("dir")).map(str::to_string),
        speed: t.attr("spd").map(str::to_string),
        duration_ms,
        advance_on_click: t.attr_bool("advClick").unwrap_or(true),
        advance_after_ms: t.attr_u32("advTm"),
    }
}

fn notes(
    pkg: &OpcPackage,
    part: &str,
    diagnostics: &RefCell<Vec<String>>,
) -> Option<pptx_core::TextBody> {
    let el = read_part(pkg, part).ok()?;
    let ctx = Ctx::new(pkg, part, diagnostics);
    let tree = el.path(&[(Ns::P, "cSld"), (Ns::P, "spTree")])?;
    let body = tree.children_named(Ns::P, "sp").find_map(|sp| {
        let ph = sp.path(&[(Ns::P, "nvSpPr"), (Ns::P, "nvPr"), (Ns::P, "ph")])?;
        (ph.attr("type") == Some("body"))
            .then(|| sp.child(Ns::P, "txBody").map(|t| text::text_body(t, &ctx)))
            .flatten()
    });
    body
}

fn theme(el: &El, ctx: &Ctx) -> Theme {
    let elements = el.child(Ns::A, "themeElements");
    let colors = elements
        .and_then(|e| e.child(Ns::A, "clrScheme"))
        .map(|s| {
            s.children
                .iter()
                .filter(|c| c.ns == Ns::A && c.local != "extLst")
                .filter_map(|c| Some((c.local.clone(), paint::color_in(c)?)))
                .collect()
        })
        .unwrap_or_default();
    let fonts = elements.and_then(|e| e.child(Ns::A, "fontScheme"));
    let font_set = |name: &str| {
        fonts
            .and_then(|f| f.child(Ns::A, name))
            .map(|f| {
                let face = |n: &str| {
                    f.child(Ns::A, n)
                        .and_then(|e| e.attr("typeface"))
                        .filter(|t| !t.is_empty())
                        .map(str::to_string)
                };
                FontSet {
                    latin: face("latin"),
                    east_asian: face("ea"),
                    complex: face("cs"),
                }
            })
            .unwrap_or_default()
    };
    let fmt = elements.and_then(|e| e.child(Ns::A, "fmtScheme"));
    let list = |name: &str| fmt.and_then(|f| f.child(Ns::A, name));
    Theme {
        part: ctx.part.clone(),
        name: el.attr("name").map(str::to_string),
        colors,
        major_font: font_set("majorFont"),
        minor_font: font_set("minorFont"),
        fill_styles: list("fillStyleLst")
            .map(|l| {
                l.children
                    .iter()
                    .filter_map(|c| paint::fill(c, ctx))
                    .collect()
            })
            .unwrap_or_default(),
        line_styles: list("lnStyleLst")
            .map(|l| {
                l.children_named(Ns::A, "ln")
                    .map(|c| paint::line(c, ctx))
                    .collect()
            })
            .unwrap_or_default(),
        effect_styles: list("effectStyleLst")
            .map(|l| {
                l.children_named(Ns::A, "effectStyle")
                    .map(|s| s.child(Ns::A, "effectLst").map(|e| paint::effects(e, ctx)))
                    .collect()
            })
            .unwrap_or_default(),
        background_fill_styles: list("bgFillStyleLst")
            .map(|l| {
                l.children
                    .iter()
                    .filter_map(|c| paint::fill(c, ctx))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn embedded_fonts(pres: &El, ctx: &Ctx) -> Vec<EmbeddedFont> {
    let Some(list) = pres.child(Ns::P, "embeddedFontLst") else {
        return Vec::new();
    };
    list.children_named(Ns::P, "embeddedFont")
        .map(|f| {
            let face = |n: &str| {
                f.child(Ns::P, n)
                    .and_then(|e| e.attr_ns(Ns::R, "id"))
                    .and_then(|id| ctx.target(id))
            };
            EmbeddedFont {
                typeface: f
                    .child(Ns::P, "font")
                    .and_then(|e| e.attr("typeface"))
                    .unwrap_or("")
                    .to_string(),
                regular: face("regular"),
                bold: face("bold"),
                italic: face("italic"),
                bold_italic: face("boldItalic"),
            }
        })
        .collect()
}

fn sections(pres: &El) -> Vec<Section> {
    let Some(ext) = pres.child(Ns::P, "extLst") else {
        return Vec::new();
    };
    ext.children
        .iter()
        .flat_map(|e| e.children.iter())
        .filter(|c| c.local == "sectionLst")
        .flat_map(|l| l.children.iter().filter(|c| c.local == "section"))
        .map(|s| Section {
            name: s.attr("name").unwrap_or("").to_string(),
            slide_ids: s
                .children
                .iter()
                .filter(|c| c.local == "sldIdLst")
                .flat_map(|l| l.children.iter().filter_map(|i| i.attr_u32("id")))
                .collect(),
        })
        .collect()
}
