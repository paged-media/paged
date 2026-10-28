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

//! Write a `.pptx` back (ADR 704, ADR 711). The original package is the
//! base: its masters, layouts, themes and media are carried over byte for
//! byte, and so is every slide the document did not change: identity holds
//! per slide, not only for an unedited deck. What the document changed is
//! written:
//!
//! * **which slides, in what order** — a slide the document no longer has is
//!   dropped with its relationships and notes; a slide the document holds
//!   twice (a duplicate) becomes a second slide part; `presentation.xml`'s
//!   slide list follows the document's page order, and its sections stay
//!   contiguous; a slide made in the editor becomes a new slide part on its
//!   layout;
//! * **each slide's hidden flag and speaker notes**;
//! * **what is on a slide** (given the document's native model, see
//!   [`native`]): an edited shape is its original XML with the edited parts
//!   rewritten, a new shape is written whole, a deleted one is dropped
//!   (see [`slide`]).
//!
//! A slide that cannot be written faithfully is written as the deck had it,
//! and the export says so ([`Exported::not_exported`]): it never writes a
//! package PowerPoint would have to repair.

use std::collections::{BTreeMap, BTreeSet};

use paged_ooxml::opc::OpcPackage;
use paged_ooxml::rels::{part_dir, rels_part_name, resolve_target, Relationship, Relationships};
use paged_ooxml::xml::{escape_attr as escape, unescape};
use serde::Deserialize;

pub mod comments;
pub mod geom;
pub mod native;
pub mod outline;
pub mod presentation;
pub mod probe;
pub mod slide;
pub mod text;
pub mod timing;
pub mod xml;

use slide::relative;

const REL_SLIDE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const REL_NOTES: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";
const REL_NOTES_MASTER: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster";
const CT_SLIDE: &str = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const CT_NOTES: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml";

/// One slide of the document, in page order.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlidePlan {
    /// The slide part of the original deck the page came from
    /// (`ppt/slides/slide3.xml`); a duplicate names its source's; empty for
    /// a slide made in the editor.
    #[serde(default)]
    pub source_part: String,
    #[serde(default)]
    pub hidden: bool,
    /// The speaker notes as plain lines (`None`: none).
    #[serde(default)]
    pub notes: Option<String>,
    /// The document changed what is on the slide. Without the document's
    /// model the slide is still written as the deck had it, and reported.
    #[serde(default)]
    pub content_edited: bool,
    /// The page's id in the document (its content, its links).
    #[serde(default)]
    pub page_id: Option<String>,
    /// The master spread of the layout a slide made in the editor uses.
    #[serde(default)]
    pub layout: Option<String>,
    /// The slide's review comments (`None`: as the deck had them, byte for
    /// byte). A list the same as the source slide's keeps its bytes too.
    #[serde(default)]
    pub comments: Option<Vec<pptx_core::Comment>>,
    /// The slide's animation timing as the document holds it (slide ADR
    /// 714), its shapes named by page element and shape key (`None`: as
    /// the deck had it; an empty timing: none). A timing that names the
    /// deck's shapes as the deck did keeps its bytes.
    #[serde(default)]
    pub timing: Option<pptx_core::anim::Timing>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    pub slides: Vec<SlidePlan>,
    /// The package kind to write (slide ADR 720): `pptx`, `potx` (Save as
    /// template) or `ppsx`. Absent: the deck's own.
    #[serde(default)]
    pub format: Option<presentation::Format>,
    /// The document's sections, by the page each starts at (absent: as the
    /// deck had them, kept contiguous over the written slides).
    #[serde(default)]
    pub sections: Option<Vec<presentation::SectionPlan>>,
    /// The document's custom shows, by page (absent: as the deck had them).
    #[serde(default)]
    pub custom_shows: Option<Vec<presentation::CustomShowPlan>>,
    /// The charts whose data the document changed (ADR 715); every other
    /// chart part keeps its bytes.
    #[serde(default)]
    pub charts: Vec<ChartPlan>,
}

/// A chart whose workbook the document edited.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartPlan {
    /// The chart part (`ppt/charts/chart1.xml`).
    pub part: String,
    /// Where the workbook came from: the chart's embedded one, or one made
    /// from its cached values.
    pub origin: slide_sheet::Origin,
    /// The workbook as the document holds it (`.xlsx`, base64).
    pub workbook: String,
}

/// The written package and what it could not carry.
#[derive(Debug, Clone)]
pub struct Exported {
    pub bytes: Vec<u8>,
    /// What the package could not carry (notes without a notes master, a
    /// page from another deck, …).
    pub diagnostics: Vec<String>,
    /// What is on the slides that could not round-trip, one line each
    /// (`slide 3: Title 1: …`).
    pub not_exported: Vec<String>,
}

struct Original {
    presentation: String,
    /// Slide parts in `sldIdLst` order, with their `p:sldId` id and r:id.
    slides: Vec<(String, u32, String)>,
    hidden: BTreeMap<String, bool>,
    notes: BTreeMap<String, Option<String>>,
    comments: BTreeMap<String, Vec<pptx_core::Comment>>,
    timings: BTreeMap<String, Option<pptx_core::anim::Timing>>,
}

fn rels(pkg: &OpcPackage, part: &str) -> Relationships {
    pkg.part(&rels_part_name(part))
        .map(Relationships::parse)
        .unwrap_or_default()
}

fn text(pkg: &OpcPackage, part: &str) -> Result<String, String> {
    let b = pkg.part(part).ok_or_else(|| format!("{part} is missing"))?;
    String::from_utf8(b.to_vec()).map_err(|_| format!("{part} is not UTF-8"))
}

fn read_original(pkg: &OpcPackage, bytes: &[u8]) -> Result<Original, String> {
    let root = rels(pkg, "");
    let presentation = root
        .items
        .iter()
        .find(|r| r.rel_type.ends_with("/officeDocument"))
        .map(|r| resolve_target("", &r.target))
        .ok_or("the package has no presentation part")?;
    let prels = rels(pkg, &presentation);
    let xml = text(pkg, &presentation)?;
    let mut slides = Vec::new();
    for tag in tags(&xml, "p:sldId") {
        let id = attr(tag, "id").and_then(|v| v.parse().ok()).unwrap_or(0);
        let rid = attr(tag, "r:id").unwrap_or_default();
        if let Some(r) = prels.by_id(&rid) {
            slides.push((resolve_target(part_dir(&presentation), &r.target), id, rid));
        }
    }
    let ir = pptx_import::import_pptx(bytes).map_err(|e| e.to_string())?;
    let mut hidden = BTreeMap::new();
    let mut notes = BTreeMap::new();
    let mut comments = BTreeMap::new();
    let mut timings = BTreeMap::new();
    for s in &ir.slides {
        timings.insert(s.part.clone(), s.timing.clone());
        hidden.insert(s.part.clone(), s.hidden);
        comments.insert(s.part.clone(), s.comments.clone());
        notes.insert(
            s.part.clone(),
            s.notes
                .as_ref()
                .map(slide_resolve::text::plain)
                .filter(|n| !n.trim().is_empty()),
        );
    }
    Ok(Original {
        presentation,
        slides,
        hidden,
        notes,
        comments,
        timings,
    })
}

/// Every start or empty tag named `name` in `xml`, as its text.
pub(crate) fn tags<'a>(xml: &'a str, name: &str) -> Vec<&'a str> {
    let open = format!("<{name}");
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(i) = xml[at..].find(&open) {
        let start = at + i;
        let after = xml.as_bytes().get(start + open.len()).copied();
        let end = match xml[start..].find('>') {
            Some(e) => start + e + 1,
            None => break,
        };
        if matches!(
            after,
            Some(b' ') | Some(b'/') | Some(b'>') | Some(b'\t') | Some(b'\n') | Some(b'\r')
        ) {
            out.push(&xml[start..end]);
        }
        at = end;
    }
    out
}

/// An attribute's raw value in one tag.
pub(crate) fn attr(tag: &str, name: &str) -> Option<String> {
    let key = format!(" {name}=\"");
    let i = tag.find(&key)? + key.len();
    let j = tag[i..].find('"')? + i;
    Some(unescape(&tag[i..j]))
}

fn write_rels(r: &Relationships) -> Vec<u8> {
    let mut out = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
    );
    for i in &r.items {
        out.push_str(&format!(
            r#"<Relationship Id="{}" Type="{}" Target="{}"{}/>"#,
            escape(&i.id),
            escape(&i.rel_type),
            escape(&i.target),
            i.target_mode
                .as_ref()
                .map(|m| format!(r#" TargetMode="{}""#, escape(m)))
                .unwrap_or_default()
        ));
    }
    out.push_str("</Relationships>");
    out.into_bytes()
}

/// Set or clear the slide root's `show="0"`.
fn set_hidden(slide_xml: &str, hidden: bool) -> String {
    let Some(start) = slide_xml
        .find("<p:sld ")
        .or_else(|| slide_xml.find("<p:sld>"))
    else {
        return slide_xml.to_string();
    };
    let end = start + slide_xml[start..].find('>').unwrap_or(0);
    let tag = &slide_xml[start..end];
    let cleaned = tag
        .replace(r#" show="0""#, "")
        .replace(r#" show="false""#, "")
        .replace(r#" show="1""#, "")
        .replace(r#" show="true""#, "");
    let tag = if hidden {
        format!(r#"{cleaned} show="0""#)
    } else {
        cleaned
    };
    format!("{}{}{}", &slide_xml[..start], tag, &slide_xml[end..])
}

/// Notes as DrawingML paragraphs: one per line.
fn notes_paragraphs(notes: &str) -> String {
    notes
        .split('\n')
        .map(|line| {
            if line.is_empty() {
                r#"<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>"#.to_string()
            } else {
                format!(
                    r#"<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>{}</a:t></a:r></a:p>"#,
                    escape(line)
                )
            }
        })
        .collect()
}

/// Replace the paragraphs of the notes slide's body placeholder.
fn set_notes_body(notes_xml: &str, notes: &str) -> Option<String> {
    // The body placeholder: the `p:sp` whose `p:ph` has type="body".
    let mut at = 0;
    while let Some(i) = notes_xml[at..]
        .find("<p:sp>")
        .or_else(|| notes_xml[at..].find("<p:sp "))
    {
        let sp_start = at + i;
        let sp_end = sp_start + notes_xml[sp_start..].find("</p:sp>")? + "</p:sp>".len();
        let sp = &notes_xml[sp_start..sp_end];
        if sp.contains(r#"<p:ph type="body""#) {
            let body_start = sp.find("<p:txBody>")?;
            let body_end = sp.find("</p:txBody>")?;
            let body = &sp[body_start..body_end];
            // Keep bodyPr and lstStyle, replace the paragraphs.
            let first_p = body
                .find("<a:p>")
                .or_else(|| body.find("<a:p/>"))
                .unwrap_or(body.len());
            let head = &body[..first_p];
            let new_sp = format!(
                "{}{}{}{}",
                &sp[..body_start],
                head,
                notes_paragraphs(notes),
                &sp[body_end..]
            );
            return Some(format!(
                "{}{}{}",
                &notes_xml[..sp_start],
                new_sp,
                &notes_xml[sp_end..]
            ));
        }
        at = sp_end;
    }
    None
}

/// A notes slide for a slide that had none: the slide image and the body,
/// from the notes master's placeholders.
fn new_notes_xml(notes: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>{}</p:txBody></p:sp></p:spTree></p:cNvSpPr></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>"#,
        notes_paragraphs(notes)
    )
    .replace("</p:spTree></p:cNvSpPr></p:cSld>", "</p:spTree></p:cSld>")
}

/// The number in a part name: `ppt/slides/slide12.xml` → 12.
fn part_number(part: &str, stem: &str) -> Option<u32> {
    let name = part.rsplit('/').next()?;
    name.strip_prefix(stem)?.strip_suffix(".xml")?.parse().ok()
}

/// Rewrite `[Content_Types].xml`: drop the overrides of `removed`, add
/// `added` (part, content type).
fn patch_content_types(xml: &str, removed: &BTreeSet<String>, added: &[(String, &str)]) -> String {
    let mut out = xml.to_string();
    for part in removed {
        let tag_start = format!(r#"<Override PartName="/{part}""#);
        if let Some(i) = out.find(&tag_start) {
            if let Some(j) = out[i..].find("/>") {
                out.replace_range(i..i + j + 2, "");
            }
        }
    }
    let adds: String = added
        .iter()
        .filter(|(p, _)| !out.contains(&format!(r#"PartName="/{p}""#)))
        .map(|(p, ct)| format!(r#"<Override PartName="/{p}" ContentType="{ct}"/>"#))
        .collect();
    out.replace("</Types>", &format!("{adds}</Types>"))
}

/// Add `Default` content types for the extensions of `parts` the types do
/// not cover.
fn add_defaults(xml: &str, parts: &[String]) -> String {
    let mut out = xml.to_string();
    for p in parts {
        let Some(ext) = p.rsplit('.').next() else {
            continue;
        };
        let ct = match ext {
            "png" => "image/png",
            "jpeg" | "jpg" => "image/jpeg",
            "gif" => "image/gif",
            "xlsx" => slide_sheet::CT_XLSX,
            _ => continue,
        };
        let has = out
            .to_ascii_lowercase()
            .contains(&format!(r#"extension="{ext}""#));
        if !has {
            out = out.replacen(
                "<Default ",
                &format!(r#"<Default Extension="{ext}" ContentType="{ct}"/><Default "#),
                1,
            );
        }
    }
    out
}

/// A slide part for a slide made in the editor: its layout's placeholders
/// as the page holds them, the rest of the page as new shapes.
struct NewSlide {
    xml: String,
    shapes: Vec<pptx_core::Shape>,
    probed: probe::Probed,
    base: paged_scene::Document,
    cur: Vec<native::NShape>,
    layout: String,
}

const PROBE_PART: &str = "ppt/slides/probe.xml";

fn new_slide(
    ir: &pptx_core::Presentation,
    deck: &slide_resolve::model::Deck,
    images: &dyn Fn(&str) -> Option<Vec<u8>>,
    layout_spread: &str,
    mut cur: Vec<native::NShape>,
) -> Result<NewSlide, String> {
    let layout_part = deck
        .masters
        .iter()
        .find(|m| m.id == layout_spread)
        .map(|m| m.layout_part.clone())
        .ok_or("its layout is not one of the deck's")?;
    let layout = ir
        .layout(&layout_part)
        .ok_or("its layout part is missing")?;
    let mut shapes = Vec::new();
    let mut body = String::new();
    let mut used: BTreeSet<(String, Option<u32>)> = BTreeSet::new();
    let mut id = 1u32;
    for c in &mut cur {
        let ph = c.label.placeholder.clone();
        c.key = None;
        clear_keys(&mut c.children);
        let Some((kind, idx)) = ph else { continue };
        if c.group.is_some() || c.text_frame().is_none() {
            continue;
        }
        // The layout's placeholder the page's one fills.
        let lph = layout.shapes.iter().find_map(|s| match s {
            pptx_core::Shape::Sp(sp) => sp.nv.placeholder.as_ref().filter(|p| {
                probe::canonical(p.kind.as_deref()) == kind && (idx.is_none() || p.idx == idx)
            }),
            _ => None,
        });
        let Some(lph) = lph.cloned() else { continue };
        if !used.insert((kind.clone(), lph.idx)) {
            continue;
        }
        id += 1;
        let name = c
            .name
            .clone()
            .unwrap_or_else(|| format!("Placeholder {}", id - 1));
        c.key = Some(format!("{PROBE_PART}#{id}"));
        let mut ph_attrs = String::new();
        if let Some(k) = lph.kind.as_deref() {
            ph_attrs.push_str(&format!(r#" type="{}""#, escape(k)));
        }
        if let Some(o) = lph.orient.as_deref() {
            ph_attrs.push_str(&format!(r#" orient="{}""#, escape(o)));
        }
        if let Some(s) = lph.size.as_deref() {
            ph_attrs.push_str(&format!(r#" sz="{}""#, escape(s)));
        }
        if let Some(i) = lph.idx {
            ph_attrs.push_str(&format!(r#" idx="{i}""#));
        }
        body.push_str(&format!(
            r#"<p:sp><p:nvSpPr><p:cNvPr id="{id}" name="{}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph{ph_attrs}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p></p:txBody></p:sp>"#,
            escape(&name)
        ));
        shapes.push(pptx_core::Shape::Sp(pptx_core::Sp {
            nv: pptx_core::NvProps {
                id,
                name,
                placeholder: Some(lph),
                ..Default::default()
            },
            // One run, so the resolver draws the placeholder: an empty
            // one is no item, and the page's would have nothing to match.
            text: Some(pptx_core::TextBody {
                paragraphs: vec![pptx_core::Paragraph {
                    runs: vec![pptx_core::Run {
                        kind: pptx_core::RunKind::Text("x".into()),
                        props: pptx_core::RunProps::default(),
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        }));
    }
    let xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>{body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"#
    );
    let probed = probe::probe(ir, Some(&layout_part), shapes.clone());
    // What import would make of the empty placeholders: the base the
    // page's are compared with.
    let mut pdeck = probed.deck.clone();
    for s in &mut pdeck.slides {
        s.part = PROBE_PART.into();
    }
    let base = slide_native::build(&pdeck, images, "probe").document;
    Ok(NewSlide {
        xml,
        shapes,
        probed,
        base,
        cur,
        layout: layout_part,
    })
}

fn clear_keys(shapes: &mut [native::NShape]) {
    for s in shapes {
        s.key = None;
        clear_keys(&mut s.children);
    }
}

/// Write the deck the document describes. `original` is the deck the
/// document was imported from. Without the document's model what is on
/// each slide is written as the deck had it.
pub fn export(original: &[u8], plan: &ExportPlan) -> Result<Exported, String> {
    export_with(original, plan, None)
}

/// [`export`] with the document's `.paged` serialization: what is on the
/// slides is written from it.
pub fn export_with(
    original: &[u8],
    plan: &ExportPlan,
    document: Option<&[u8]>,
) -> Result<Exported, String> {
    let pkg = OpcPackage::read(original).map_err(|e| e.to_string())?;
    let orig = read_original(&pkg, original)?;
    let mut diagnostics = Vec::new();
    let mut not_exported = Vec::new();

    // The document's model, and what import made of the deck.
    let model = match document {
        Some(d) => match native::read(d) {
            Ok(doc) => Some(doc),
            Err(e) => {
                diagnostics.push(format!(
                    "the document could not be read ({e}); slides are written as the deck had them"
                ));
                None
            }
        },
        None => None,
    };
    let ir = pptx_import::import_pptx(original).map_err(|e| e.to_string())?;
    let images = |part: &str| pkg.part(part).map(|b| b.to_vec());
    let (deck, base) = match &model {
        Some(_) => {
            // Charts are drawn as import drew them: a live chart that
            // slide-chart does not lay out by paged.sheet (ADR 715).
            let (charts, _) = slide_sheet::DeckCharts::open(&pkg, &ir);
            let deck = slide_resolve::resolve_with(&ir, &|p, w, h| charts.draw(p, w, h));
            let base = slide_native::build(&deck, &images, "deck").document;
            (Some(deck), Some(base))
        }
        None => (None, None),
    };

    let known: BTreeSet<&str> = orig.slides.iter().map(|(p, _, _)| p.as_str()).collect();
    // Which plan slides are written: the deck's own, and (with the model)
    // the ones made in the editor.
    let mut slides: Vec<&SlidePlan> = Vec::new();
    for (i, s) in plan.slides.iter().enumerate() {
        let editor_made = s.source_part.is_empty() && model.is_some() && s.page_id.is_some();
        if known.contains(s.source_part.as_str()) || editor_made {
            slides.push(s);
        } else if s.source_part.is_empty() {
            diagnostics.push(format!(
                "page {}: a slide made in the editor; not exported (the export needs the document)",
                i + 1
            ));
        } else {
            diagnostics.push(format!(
                "page {}: its slide ({}) is not in this deck; not exported",
                i + 1,
                s.source_part
            ));
        }
    }
    if model.is_none() {
        for (i, s) in slides.iter().enumerate() {
            if s.content_edited {
                not_exported.push(format!(
                    "slide {}: edits to what is on the slide are not exported; it is written as the deck had it",
                    i + 1
                ));
            }
        }
    }

    // Unchanged: same slides in the same order, same hidden flags and
    // notes, and (without the model) no content edit.
    let same_plan = slides.len() == orig.slides.len()
        && slides.iter().zip(&orig.slides).all(|(s, (part, _, _))| {
            s.source_part == *part
                && orig.hidden.get(part).copied().unwrap_or(false) == s.hidden
                && orig.notes.get(part).cloned().flatten()
                    == s.notes.clone().filter(|n| !n.trim().is_empty())
                && s.comments.as_ref().is_none_or(|c| {
                    pptx_core::same_comments(
                        c,
                        orig.comments.get(part).map(Vec::as_slice).unwrap_or(&[]),
                    )
                })
                && s.timing.as_ref().is_none_or(|t| {
                    let deck = orig.timings.get(part).cloned().flatten();
                    let t = t.without_document_names();
                    deck.as_ref() == Some(&t) || (deck.is_none() && t.nodes.is_empty())
                })
        });
    let pres_orig = text(&pkg, &orig.presentation)?;
    let ct_orig = text(&pkg, "[Content_Types].xml")?;
    // The deck-wide parts the plan names: unchanged when the deck's own.
    let deck_wide_same = plan.format.is_none_or(|f| {
        ct_orig.contains(&format!(
            r#"PartName="/{}" ContentType="{}""#,
            orig.presentation,
            f.content_type()
        ))
    }) && plan.sections.is_none()
        && plan.custom_shows.is_none()
        && plan.charts.is_empty();
    if same_plan && deck_wide_same && model.is_none() && !slides.iter().any(|s| s.content_edited) {
        return Ok(Exported {
            bytes: original.to_vec(),
            diagnostics,
            not_exported,
        });
    }

    let pres_dir = part_dir(&orig.presentation).to_string();
    let mut prels = rels(&pkg, &orig.presentation);
    let notes_master = prels
        .items
        .iter()
        .find(|r| r.rel_type == REL_NOTES_MASTER)
        .map(|r| resolve_target(&pres_dir, &r.target));

    let mut next_slide = pkg
        .file_names()
        .filter_map(|n| part_number(n, "slide"))
        .max()
        .unwrap_or(0);
    let mut next_notes = pkg
        .file_names()
        .filter_map(|n| part_number(n, "notesSlide"))
        .max()
        .unwrap_or(0);
    let mut next_id = orig
        .slides
        .iter()
        .map(|(_, id, _)| *id)
        .max()
        .unwrap_or(255)
        .max(255);
    let mut next_rid = prels
        .items
        .iter()
        .filter_map(|r| r.id.strip_prefix("rId")?.parse::<u32>().ok())
        .max()
        .unwrap_or(0);
    let next_media = pkg
        .file_names()
        .filter_map(|n| {
            let f = n.strip_prefix("ppt/media/image")?;
            f.split('.').next()?.parse::<u32>().ok()
        })
        .max()
        .unwrap_or(0);

    // First pass: the part, slide id and relationship each slide is
    // written as (links between slides need them all).
    struct Target {
        part: String,
        id: u32,
        rid: String,
        first: bool,
    }
    let mut targets: Vec<Target> = Vec::new();
    let mut used: BTreeSet<&str> = BTreeSet::new();
    let mut added_types: Vec<(String, &str)> = Vec::new();
    for s in &slides {
        let src = s.source_part.as_str();
        let found = orig.slides.iter().find(|(p, _, _)| p == src);
        let t = match found {
            Some((p, id, rid)) if used.insert(src) => Target {
                part: p.clone(),
                id: *id,
                rid: rid.clone(),
                first: true,
            },
            _ => {
                next_slide += 1;
                next_id += 1;
                next_rid += 1;
                let dir = if src.is_empty() {
                    format!("{pres_dir}/slides")
                } else {
                    part_dir(src).to_string()
                };
                let part = format!("{dir}/slide{next_slide}.xml");
                let rid = format!("rId{next_rid}");
                prels.items.push(Relationship {
                    id: rid.clone(),
                    rel_type: REL_SLIDE.to_string(),
                    target: relative(&pres_dir, &part),
                    target_mode: None,
                });
                added_types.push((part.clone(), CT_SLIDE));
                Target {
                    part,
                    id: next_id,
                    rid,
                    first: false,
                }
            }
        };
        targets.push(t);
    }
    let theme = deck
        .as_ref()
        .map(|d| d.theme_colors.clone())
        .unwrap_or_default();
    let shared = model.as_ref().map(|cur| slide::Shared {
        ir: &ir,
        cur,
        theme: &theme,
        page_part: slides
            .iter()
            .zip(&targets)
            .filter_map(|(s, t)| Some((s.page_id.clone()?, t.part.clone())))
            .collect(),
        source_part: slides
            .iter()
            .zip(&targets)
            .filter(|(s, t)| t.first && !s.source_part.is_empty())
            .map(|(s, t)| (s.source_part.clone(), t.part.clone()))
            .collect(),
        media: std::cell::RefCell::new((BTreeMap::new(), next_media)),
        live_charts: plan.charts.iter().map(|c| c.part.clone()).collect(),
    });

    let mut out_parts: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut media_parts: Vec<String> = Vec::new();
    // The authors the written comments name.
    let mut comment_authors: Vec<comments::AuthorRef> = Vec::new();
    // The written slides: (part, sldId id, r:id, source part).
    let mut written: Vec<(String, u32, String, String)> = Vec::new();

    for (n, (s, t)) in slides.iter().zip(&targets).enumerate() {
        let src = s.source_part.as_str();
        let part = t.part.clone();
        let dir = part_dir(&part).to_string();
        let new = src.is_empty();

        // The slide's XML and relationships to start from.
        let (mut slide_xml, mut srels) = if new {
            (String::new(), Relationships::default())
        } else {
            (text(&pkg, src)?, rels(&pkg, src))
        };
        let mut srels_changed = !t.first;
        if !new && orig.hidden.get(src).copied().unwrap_or(false) != s.hidden {
            slide_xml = set_hidden(&slide_xml, s.hidden);
        }

        // The page's shapes and the ids the writer gave them (animation
        // targets follow them, slide ADR 714).
        let mut page_shapes: Vec<native::NShape> = Vec::new();
        let mut written_ids: BTreeMap<String, u32> = BTreeMap::new();
        // What is on the slide, from the document.
        if let (Some(sh), Some(deck), Some(base), Some(pid)) =
            (&shared, &deck, &base, s.page_id.as_deref())
        {
            let cur_spread = native::spread_of(sh.cur, pid);
            if let Some(cur_spread) = cur_spread {
                let cur = native::page_shapes(cur_spread);
                page_shapes = cur.clone();
                if new {
                    let layout = s.layout.as_deref().unwrap_or("");
                    match new_slide(&ir, deck, &images, layout, cur) {
                        Ok(ns) => {
                            let mut r = slide::rels_for(&part, Relationships::default());
                            let lp = relative(&dir, &ns.layout);
                            r.add(slide::REL_LAYOUT, &lp, false);
                            let base_spread = native::spread_of(&ns.base, "p1");
                            let items = ns
                                .probed
                                .deck
                                .slides
                                .first()
                                .map(|s| s.items.as_slice())
                                .unwrap_or(&[]);
                            let job = slide::Job {
                                part: part.clone(),
                                slide_no: n + 1,
                                xml: ns.xml.clone(),
                                shapes: &ns.shapes,
                                items,
                                prefix: format!("{PROBE_PART}#"),
                                base: base_spread,
                                base_doc: &ns.base,
                                cur: ns.cur.clone(),
                                layout: Some(ns.layout.clone()),
                            };
                            match slide::write(sh, &job, &mut r) {
                                Ok(out) => {
                                    let out = out.unwrap_or(slide::Out {
                                        xml: ns.xml.clone(),
                                        media: Vec::new(),
                                        lost: Vec::new(),
                                        ids: BTreeMap::new(),
                                    });
                                    written_ids = out.ids.clone();
                                    slide_xml = set_hidden(&out.xml, s.hidden);
                                    for (p, b) in out.media {
                                        media_parts.push(p.clone());
                                        out_parts.insert(p, b);
                                    }
                                    not_exported.extend(out.lost);
                                    srels = r.rels;
                                    srels_changed = true;
                                }
                                Err(e) => {
                                    diagnostics.push(format!(
                                        "slide {}: a slide made in the editor could not be written ({e}); not exported",
                                        n + 1
                                    ));
                                    continue;
                                }
                            }
                        }
                        Err(e) => {
                            diagnostics.push(format!(
                                "slide {}: a slide made in the editor: {e}; not exported",
                                n + 1
                            ));
                            continue;
                        }
                    }
                } else {
                    let ir_slide = ir.slides.iter().find(|x| x.part == src);
                    let rs = deck.slides.iter().find(|x| x.part == src);
                    if let (Some(ir_slide), Some(rs)) = (ir_slide, rs) {
                        let mut r = slide::rels_for(&part, srels.clone());
                        let job = slide::Job {
                            part: part.clone(),
                            slide_no: n + 1,
                            xml: slide_xml.clone(),
                            shapes: &ir_slide.shapes,
                            items: &rs.items,
                            prefix: format!("{src}#"),
                            base: native::spread_of(base, &rs.id),
                            base_doc: base,
                            cur,
                            layout: ir_slide.layout_part.clone(),
                        };
                        match slide::write(sh, &job, &mut r) {
                            Ok(Some(out)) => {
                                written_ids = out.ids.clone();
                                slide_xml = out.xml;
                                for (p, b) in out.media {
                                    media_parts.push(p.clone());
                                    out_parts.insert(p, b);
                                }
                                not_exported.extend(out.lost);
                                if r.changed {
                                    srels = r.rels;
                                    srels_changed = true;
                                }
                            }
                            Ok(None) => {}
                            Err(e) => not_exported.push(format!(
                                "slide {}: {e}; it is written as the deck had it",
                                n + 1
                            )),
                        }
                    }
                }
            } else if new {
                continue;
            }
        } else if new {
            continue;
        }

        // Notes: the source slide's notes slide, copied for a duplicate,
        // rewritten when the text changed, created when the slide gains notes.
        let want = s.notes.clone().filter(|n| !n.trim().is_empty());
        let had = if new {
            None
        } else {
            orig.notes.get(src).cloned().flatten()
        };
        let src_dir = part_dir(src).to_string();
        let notes_rel = srels.items.iter().position(|r| r.rel_type == REL_NOTES);
        match notes_rel {
            Some(i) if !new => {
                let notes_src = resolve_target(&src_dir, &srels.items[i].target);
                let mut notes_xml = text(&pkg, &notes_src)?;
                if want != had {
                    match set_notes_body(&notes_xml, want.as_deref().unwrap_or("")) {
                        Some(x) => notes_xml = x,
                        None => diagnostics.push(format!(
                            "{part}: its notes slide has no body placeholder; the notes are not written"
                        )),
                    }
                }
                let notes_part = if t.first {
                    notes_src.clone()
                } else {
                    next_notes += 1;
                    let p = format!("{}/notesSlide{next_notes}.xml", part_dir(&notes_src));
                    added_types.push((p.clone(), CT_NOTES));
                    srels.items[i].target = relative(&dir, &p);
                    srels_changed = true;
                    p
                };
                // The notes slide points back at its slide; a notes slide
                // whose slide kept its part keeps its relationships' bytes.
                if t.first {
                    if let Some(b) = pkg.part(&rels_part_name(&notes_src)) {
                        out_parts.insert(rels_part_name(&notes_part), b.to_vec());
                    }
                } else {
                    let mut nrels = rels(&pkg, &notes_src);
                    for r in &mut nrels.items {
                        if r.rel_type == REL_SLIDE {
                            r.target = relative(part_dir(&notes_part), &part);
                        }
                    }
                    out_parts.insert(rels_part_name(&notes_part), write_rels(&nrels));
                }
                out_parts.insert(notes_part, notes_xml.into_bytes());
            }
            _ if want.is_some() => match &notes_master {
                Some(master) => {
                    next_notes += 1;
                    let p = format!("{pres_dir}/notesSlides/notesSlide{next_notes}.xml");
                    added_types.push((p.clone(), CT_NOTES));
                    let nrels = Relationships {
                        items: vec![
                            Relationship {
                                id: "rId1".into(),
                                rel_type: REL_NOTES_MASTER.into(),
                                target: relative(part_dir(&p), master),
                                target_mode: None,
                            },
                            Relationship {
                                id: "rId2".into(),
                                rel_type: REL_SLIDE.into(),
                                target: relative(part_dir(&p), &part),
                                target_mode: None,
                            },
                        ],
                    };
                    let rid = (1..)
                        .map(|n| format!("rId{n}"))
                        .find(|id| srels.by_id(id).is_none())
                        .expect("an unused id");
                    srels.items.push(Relationship {
                        id: rid,
                        rel_type: REL_NOTES.into(),
                        target: relative(&dir, &p),
                        target_mode: None,
                    });
                    srels_changed = true;
                    out_parts.insert(rels_part_name(&p), write_rels(&nrels));
                    out_parts.insert(p, new_notes_xml(want.as_deref().unwrap_or("")).into_bytes());
                }
                None => diagnostics.push(format!(
                    "{part}: the deck has no notes master, so its new notes are not written"
                )),
            },
            _ => {}
        }
        // Comments: kept while the document has the slide's own, written
        // as one modern part when they changed. A duplicate never shares
        // its source's part.
        let orig_comments: &[pptx_core::Comment] = if new {
            &[]
        } else {
            orig.comments.get(src).map(Vec::as_slice).unwrap_or(&[])
        };
        let has_comment_rel = srels
            .items
            .iter()
            .any(|r| comments::is_comment_rel(&r.rel_type));
        let want_comments = match &s.comments {
            Some(list) => Some(list.clone()),
            None if !t.first && has_comment_rel => Some(orig_comments.to_vec()),
            None => None,
        };
        if let Some(list) = want_comments {
            if !(t.first && pptx_core::same_comments(&list, orig_comments)) {
                let root_attrs = srels
                    .items
                    .iter()
                    .filter(|r| r.rel_type == comments::REL_MODERN)
                    .find_map(|r| {
                        let p = resolve_target(&src_dir, &r.target);
                        paged_ooxml::tree::parse(pkg.part(&p)?).ok()
                    })
                    .map(|el| el.raw_attrs)
                    .unwrap_or_default();
                srels
                    .items
                    .retain(|r| !comments::is_comment_rel(&r.rel_type));
                slide_xml = comments::strip_comment_ext(&slide_xml);
                if !list.is_empty() {
                    let (xml, authors) = comments::write_part(
                        &list,
                        orig_comments,
                        t.first,
                        &root_attrs,
                        &slide_xml,
                        t.id,
                    );
                    let stem = format!(
                        "{pres_dir}/comments/modernComment_{:X}_{}",
                        t.id,
                        comments::short_hash(&format!("{part}{xml}"))
                    );
                    let mut name = format!("{stem}.xml");
                    let mut k = 1;
                    while pkg.part(&name).is_some() || out_parts.contains_key(&name) {
                        k += 1;
                        name = format!("{stem}_{k}.xml");
                    }
                    let rid = (1..)
                        .map(|n| format!("rId{n}"))
                        .find(|id| srels.by_id(id).is_none())
                        .expect("an unused id");
                    srels.items.push(Relationship {
                        id: rid.clone(),
                        rel_type: comments::REL_MODERN.into(),
                        target: relative(&dir, &name),
                        target_mode: None,
                    });
                    slide_xml = comments::add_comment_ext(&slide_xml, &rid);
                    added_types.push((name.clone(), comments::CT_COMMENTS));
                    out_parts.insert(name, xml.into_bytes());
                    for a in authors {
                        if !comment_authors.contains(&a) {
                            comment_authors.push(a);
                        }
                    }
                }
                srels_changed = true;
            }
        }

        // A duplicate's own relationships resolve from its own folder; its
        // folder is its source's, so targets stay as they are.
        let srels_bytes = match pkg.part(&rels_part_name(src)) {
            Some(b) if !srels_changed && !new => b.to_vec(),
            _ => write_rels(&srels),
        };
        out_parts.insert(rels_part_name(&part), srels_bytes);

        // Animations (slide ADR 714): the document's timing, or the deck's,
        // with its shapes named as this part names them; an effect whose
        // shape is gone is dropped. Unchanged, the part keeps its bytes.
        let deck_timing = if new {
            None
        } else {
            ir.slides
                .iter()
                .find(|x| x.part == src)
                .and_then(|x| x.timing.clone())
        };
        if let Some(want) = s.timing.as_ref().or(deck_timing.as_ref()) {
            let names = timing::Names::new(&page_shapes, written_ids, &slide_xml);
            let (resolved, dropped) = timing::resolve(want, &names);
            for d in &dropped {
                not_exported.push(format!(
                    "slide {}: {d} of a shape that is no longer on the slide was dropped",
                    n + 1
                ));
            }
            let changed = match &s.timing {
                Some(_) => resolved != deck_timing,
                None => !dropped.is_empty(),
            };
            if changed {
                slide_xml = timing::splice(&slide_xml, resolved.as_ref());
            }
        }
        out_parts.insert(part.clone(), slide_xml.into_bytes());
        written.push((part, t.id, t.rid.clone(), src.to_string()));
    }
    // A new slide that was not written takes its presentation relationship
    // and content type back.
    let written_parts: BTreeSet<&str> = written.iter().map(|w| w.0.as_str()).collect();
    prels.items.retain(|r| {
        r.rel_type != REL_SLIDE
            || written_parts.contains(resolve_target(&pres_dir, &r.target).as_str())
            || orig.slides.iter().any(|(_, _, rid)| *rid == r.id)
    });
    added_types.retain(|(p, ct)| *ct != CT_SLIDE || written_parts.contains(p.as_str()));

    // Slides the document no longer has, and their notes.
    let mut removed: BTreeSet<String> = BTreeSet::new();
    for (part, _, rid) in &orig.slides {
        if written_parts.contains(part.as_str()) {
            continue;
        }
        removed.insert(part.clone());
        removed.insert(rels_part_name(part));
        if let Some(n) = rels(&pkg, part)
            .items
            .iter()
            .find(|r| r.rel_type == REL_NOTES)
        {
            let notes = resolve_target(part_dir(part), &n.target);
            removed.insert(rels_part_name(&notes));
            removed.insert(notes);
        }
        prels.items.retain(|r| &r.id != rid);
    }

    // Comment parts no written slide names any more go, with their
    // content types.
    let mut referenced: BTreeSet<String> = BTreeSet::new();
    for (part, _, _, _) in &written {
        if let Some(b) = out_parts.get(&rels_part_name(part)) {
            for r in Relationships::parse(b).items {
                if comments::is_comment_rel(&r.rel_type) {
                    referenced.insert(resolve_target(part_dir(part), &r.target));
                }
            }
        }
    }
    for (part, _, _) in &orig.slides {
        for r in rels(&pkg, part).items {
            if comments::is_comment_rel(&r.rel_type) {
                let p = resolve_target(part_dir(part), &r.target);
                if !referenced.contains(&p) {
                    removed.insert(p);
                }
            }
        }
    }

    // The authors the new comments name: added to the deck's authors list,
    // or a new one.
    let mut prels_changed = false;
    if !comment_authors.is_empty() {
        let existing = prels
            .items
            .iter()
            .find(|r| r.rel_type == comments::REL_AUTHORS)
            .map(|r| resolve_target(&pres_dir, &r.target));
        let current = existing.as_deref().and_then(|p| text(&pkg, p).ok());
        if let Some(xml) = comments::authors_xml(current.as_deref(), &comment_authors) {
            match existing {
                Some(p) if current.is_some() => {
                    out_parts.insert(p, xml.into_bytes());
                }
                _ => {
                    let p = format!("{pres_dir}/authors.xml");
                    let rid = (next_rid + 1..)
                        .map(|n| format!("rId{n}"))
                        .find(|id| prels.by_id(id).is_none())
                        .expect("an unused id");
                    prels.items.retain(|r| r.rel_type != comments::REL_AUTHORS);
                    prels.items.push(Relationship {
                        id: rid,
                        rel_type: comments::REL_AUTHORS.into(),
                        target: relative(&pres_dir, &p),
                        target_mode: None,
                    });
                    prels_changed = true;
                    added_types.push((p.clone(), comments::CT_AUTHORS));
                    out_parts.insert(p, xml.into_bytes());
                }
            }
        }
    }

    // Links to a slide that is gone: the relationship and the links that
    // use it go, on every written slide.
    for (part, _, _, _) in &written {
        let rp = rels_part_name(part);
        let rbytes = match out_parts.get(&rp) {
            Some(b) => b.clone(),
            None => continue,
        };
        let mut r = Relationships::parse(&rbytes);
        let dead: Vec<String> = r
            .items
            .iter()
            .filter(|x| {
                x.rel_type == REL_SLIDE
                    && removed.contains(&resolve_target(part_dir(part), &x.target))
            })
            .map(|x| x.id.clone())
            .collect();
        if dead.is_empty() {
            continue;
        }
        let mut sx = String::from_utf8(out_parts.get(part).cloned().unwrap_or_default())
            .map_err(|_| format!("{part} is not UTF-8"))?;
        for id in &dead {
            sx = slide::drop_links(&sx, id);
        }
        r.items.retain(|x| !dead.contains(&x.id));
        out_parts.insert(rp, write_rels(&r));
        out_parts.insert(part.clone(), sx.into_bytes());
        not_exported.push(format!(
            "{part}: {} link(s) to a deleted slide removed",
            dead.len()
        ));
    }

    // presentation.xml: the slide list in document order, sections kept
    // contiguous. The same slides in the same order keep its bytes.
    let same_list = written.len() == orig.slides.len()
        && written
            .iter()
            .zip(&orig.slides)
            .all(|((p, id, rid, _), (op, oid, orid))| p == op && id == oid && rid == orid);
    let mut pres = pres_orig.clone();
    let list: String = written
        .iter()
        .map(|(_, id, rid, _)| format!(r#"<p:sldId id="{id}" r:id="{rid}"/>"#))
        .collect();
    if !same_list {
        if let (Some(a), Some(b)) = (pres.find("<p:sldIdLst>"), pres.find("</p:sldIdLst>")) {
            pres.replace_range(a + "<p:sldIdLst>".len()..b, &list);
        } else if let Some(a) = pres.find("<p:sldIdLst/>") {
            pres.replace_range(
                a..a + "<p:sldIdLst/>".len(),
                &format!("<p:sldIdLst>{list}</p:sldIdLst>"),
            );
        }
        if plan.sections.is_none() {
            pres = rewrite_sections(&pres, &orig, &written);
        }
    }
    // Sections and custom shows as the document holds them (slide ADR 720),
    // written when they differ from what the list above leaves.
    let page_of: BTreeMap<&str, &str> = slides
        .iter()
        .zip(&targets)
        .filter_map(|(s, t)| Some((t.part.as_str(), s.page_id.as_deref()?)))
        .collect();
    if let Some(plan_sections) = &plan.sections {
        let over: Vec<(Option<&str>, u32)> = written
            .iter()
            .map(|(p, id, _, _)| (page_of.get(p.as_str()).copied(), *id))
            .collect();
        let want = presentation::plan_sections(plan_sections, &over);
        if want != presentation::read_sections(&pres) {
            pres = presentation::write_sections(&pres, &want);
        }
    }
    if let Some(plan_shows) = &plan.custom_shows {
        let over: Vec<(Option<&str>, &str)> = written
            .iter()
            .map(|(p, _, rid, _)| (page_of.get(p.as_str()).copied(), rid.as_str()))
            .collect();
        let want = presentation::plan_custom_shows(plan_shows, &over);
        if want != presentation::read_custom_shows(&pres) {
            pres = presentation::write_custom_shows(&pres, &want);
        }
    } else if !same_list {
        // The deck's own shows: a slide that is gone leaves them.
        let kept: BTreeSet<&str> = written.iter().map(|w| w.2.as_str()).collect();
        let shows = presentation::read_custom_shows(&pres);
        let pruned: Vec<_> = shows
            .iter()
            .map(|(n, i, r)| {
                (
                    n.clone(),
                    *i,
                    r.iter()
                        .filter(|x| kept.contains(x.as_str()))
                        .cloned()
                        .collect(),
                )
            })
            .collect();
        if pruned != shows {
            pres = presentation::write_custom_shows(&pres, &pruned);
        }
    }

    // Charts whose data changed (ADR 715): the chart part with its caches
    // written from the workbook, and the workbook itself; a made workbook
    // becomes the chart's embedded one.
    for c in &plan.charts {
        if pkg.part(&c.part).is_none() {
            diagnostics.push(format!("chart {}: not in this deck; not exported", c.part));
            continue;
        }
        match write_chart(&pkg, c, &mut out_parts) {
            Ok(Some(new_part)) => media_parts.push(new_part),
            Ok(None) => {}
            Err(e) => not_exported.push(format!(
                "chart {}: its data is written as the deck had it ({e})",
                c.part
            )),
        }
    }

    let mut ct = ct_orig.clone();
    if let Some(f) = plan.format {
        ct = presentation::set_main_content_type(&ct, &orig.presentation, f.content_type());
    }
    let removed_parts: BTreeSet<String> = removed
        .iter()
        .filter(|p| !p.contains("/_rels/"))
        .cloned()
        .collect();
    ct = patch_content_types(&ct, &removed_parts, &added_types);
    ct = add_defaults(&ct, &media_parts);

    // Nothing changed at all: the original bytes.
    if same_list
        && pres == pres_orig
        && ct == ct_orig
        && added_types.is_empty()
        && removed.is_empty()
        && media_parts.is_empty()
    {
        let identical = out_parts
            .iter()
            .all(|(n, b)| pkg.part(n).is_some_and(|o| o == b.as_slice()));
        if identical {
            return Ok(Exported {
                bytes: original.to_vec(),
                diagnostics,
                not_exported,
            });
        }
    }

    // The new package: every part that stays, in the original's order,
    // then the new ones.
    let mut outpkg = OpcPackage::default();
    outpkg.set_part("[Content_Types].xml", ct.into_bytes());
    let pres_rels = rels_part_name(&orig.presentation);
    for name in pkg.file_names() {
        if name == "[Content_Types].xml" || removed.contains(name) {
            continue;
        }
        let bytes = if name == orig.presentation {
            pres.clone().into_bytes()
        } else if name == pres_rels && (!same_list || prels_changed) {
            write_rels(&prels)
        } else if let Some(b) = out_parts.remove(name) {
            b
        } else if name == "docProps/app.xml" {
            set_slide_count(&text(&pkg, name)?, written.len()).into_bytes()
        } else {
            pkg.part(name).unwrap_or_default().to_vec()
        };
        outpkg.set_part(name, bytes);
    }
    for (name, bytes) in out_parts {
        outpkg.set_part(&name, bytes);
    }
    let bytes = outpkg.write().map_err(|e| e.to_string())?;
    Ok(Exported {
        bytes,
        diagnostics,
        not_exported,
    })
}

/// Write an edited chart (ADR 715) into `out`: its part with the caches
/// from the workbook, the workbook (an embedded one in place; a made one as
/// a new embedding with its relationship). Answers the new workbook part.
fn write_chart(
    pkg: &OpcPackage,
    c: &ChartPlan,
    out: &mut BTreeMap<String, Vec<u8>>,
) -> Result<Option<String>, String> {
    use base64::Engine as _;
    let xlsx = base64::engine::general_purpose::STANDARD
        .decode(&c.workbook)
        .map_err(|e| format!("workbook: {e}"))?;
    let chart_xml = pkg
        .part(&c.part)
        .ok_or_else(|| format!("no part {}", c.part))?;
    let book = slide_sheet::ChartBook::reopen(&xlsx, chart_xml, c.origin)?;
    match slide_sheet::embedded_part(pkg, &c.part) {
        Some((embedding, _)) => {
            out.insert(c.part.clone(), book.chart_part(None)?);
            out.insert(embedding, xlsx);
            Ok(None)
        }
        None => {
            let n = (1..)
                .find(|n| {
                    let p = format!("ppt/embeddings/Microsoft_Excel_Worksheet{n}.xlsx");
                    pkg.part(&p).is_none() && !out.contains_key(&p)
                })
                .unwrap_or(1);
            let embedding = format!("ppt/embeddings/Microsoft_Excel_Worksheet{n}.xlsx");
            let rp = rels_part_name(&c.part);
            let mut r = out
                .get(&rp)
                .map(|b| Relationships::parse(b))
                .unwrap_or_else(|| rels(pkg, &c.part));
            let rid = (1..)
                .map(|i| format!("rId{i}"))
                .find(|id| r.by_id(id).is_none())
                .unwrap_or_else(|| "rId1".into());
            r.items.push(paged_ooxml::Relationship {
                id: rid.clone(),
                rel_type: slide_sheet::REL_PACKAGE.into(),
                target: format!("../embeddings/Microsoft_Excel_Worksheet{n}.xlsx"),
                target_mode: None,
            });
            out.insert(c.part.clone(), book.chart_part(Some(&rid))?);
            out.insert(rp, write_rels(&r));
            out.insert(embedding.clone(), xlsx);
            Ok(Some(embedding))
        }
    }
}

fn set_slide_count(xml: &str, n: usize) -> String {
    match (xml.find("<Slides>"), xml.find("</Slides>")) {
        (Some(a), Some(b)) => format!("{}<Slides>{n}{}", &xml[..a], &xml[b..]),
        _ => xml.to_string(),
    }
}

/// `p14:sectionLst`: each section lists the written slides it holds. A
/// slide belongs to the section its source slide was in; a section starts
/// where its first original slide first appears, so sections stay
/// contiguous (a slide moved past a section boundary joins the section it
/// landed in).
fn rewrite_sections(
    pres: &str,
    orig: &Original,
    written: &[(String, u32, String, String)],
) -> String {
    let Some(lst_start) = pres.find("<p14:sectionLst") else {
        return pres.to_string();
    };
    let Some(lst_end) = pres[lst_start..]
        .find("</p14:sectionLst>")
        .map(|i| lst_start + i)
    else {
        return pres.to_string();
    };
    let lst = &pres[lst_start..lst_end];
    // Each section: its opening tag and the original slide ids it held.
    let mut sections: Vec<(String, Vec<u32>)> = Vec::new();
    let mut at = 0;
    while let Some(i) = lst[at..].find("<p14:section ") {
        let s = at + i;
        let open_end = s + lst[s..].find('>').unwrap_or(0) + 1;
        let open = lst[s..open_end].to_string();
        let close = lst[open_end..]
            .find("</p14:section>")
            .map(|j| open_end + j)
            .unwrap_or(open_end);
        let ids = tags(&lst[open_end..close], "p14:sldId")
            .iter()
            .filter_map(|t| attr(t, "id")?.parse().ok())
            .collect();
        let self_closed = open.ends_with("/>");
        sections.push((open, ids));
        at = if self_closed {
            open_end
        } else {
            close + "</p14:section>".len()
        };
    }
    if sections.is_empty() {
        return pres.to_string();
    }
    let section_of = |src: &str| -> usize {
        let id = orig
            .slides
            .iter()
            .find(|(p, _, _)| p == src)
            .map(|(_, id, _)| *id);
        sections
            .iter()
            .position(|(_, ids)| id.is_some_and(|i| ids.contains(&i)))
            .unwrap_or(0)
    };
    let mut members: Vec<Vec<u32>> = vec![Vec::new(); sections.len()];
    let mut current = 0usize;
    for (_, id, _, src) in written {
        let s = section_of(src);
        if s > current && members[s].is_empty() {
            current = s;
        }
        members[current].push(*id);
    }
    let mut body = String::new();
    for ((open, _), ids) in sections.iter().zip(&members) {
        let open = open.trim_end_matches("/>").trim_end_matches('>');
        body.push_str(open);
        body.push_str("><p14:sldIdLst>");
        for id in ids {
            body.push_str(&format!(r#"<p14:sldId id="{id}"/>"#));
        }
        body.push_str("</p14:sldIdLst></p14:section>");
    }
    let open_end = lst_start + lst.find('>').unwrap_or(0) + 1;
    format!("{}{}{}", &pres[..open_end], body, &pres[lst_end..])
}
