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

//! Write a `.pptx` back (ADR 704). The original package is the base: its
//! masters, layouts, themes, media and every slide are carried over byte for
//! byte, and only what the document changed about the deck is rewritten:
//!
//! * **which slides, in what order** — a slide the document no longer has is
//!   dropped with its relationships and notes; a slide the document holds
//!   twice (a duplicate) becomes a second slide part with copies of its
//!   relationships and notes; `presentation.xml`'s slide list follows the
//!   document's page order, and its sections stay contiguous;
//! * **each slide's hidden flag and speaker notes** — written into the slide
//!   root and the notes slide's body (a notes slide is created from the
//!   notes master when a slide gains notes).
//!
//! What is on a slide is not regenerated here: a slide is written as the
//! deck had it. The caller passes which slides' content the document
//! changed, and those are reported, not silently lost.
//!
//! An export that changes nothing returns the original bytes.

use std::collections::{BTreeMap, BTreeSet};

use paged_ooxml::opc::OpcPackage;
use paged_ooxml::rels::{part_dir, rels_part_name, resolve_target, Relationship, Relationships};
use serde::Deserialize;

const REL_SLIDE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const REL_NOTES: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";
const REL_NOTES_MASTER: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster";
const CT_SLIDE: &str = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const CT_NOTES: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml";

/// One slide of the document, in page order.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlidePlan {
    /// The slide part of the original deck the page came from
    /// (`ppt/slides/slide3.xml`); a duplicate names its source's.
    pub source_part: String,
    #[serde(default)]
    pub hidden: bool,
    /// The speaker notes as plain lines (`None`: none).
    #[serde(default)]
    pub notes: Option<String>,
    /// The document changed what is on the slide; it is still written as
    /// the deck had it, and reported.
    #[serde(default)]
    pub content_edited: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    pub slides: Vec<SlidePlan>,
}

/// The written package and what it could not carry.
#[derive(Debug, Clone)]
pub struct Exported {
    pub bytes: Vec<u8>,
    pub diagnostics: Vec<String>,
}

/// The original deck's own view of a slide: order, hidden flag, notes.
struct Original {
    presentation: String,
    /// Slide parts in `sldIdLst` order, with their `p:sldId` id and r:id.
    slides: Vec<(String, u32, String)>,
    hidden: BTreeMap<String, bool>,
    notes: BTreeMap<String, Option<String>>,
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
    for s in &ir.slides {
        hidden.insert(s.part.clone(), s.hidden);
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
    })
}

/// Every start or empty tag named `name` in `xml`, as its text.
fn tags<'a>(xml: &'a str, name: &str) -> Vec<&'a str> {
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
fn attr(tag: &str, name: &str) -> Option<String> {
    let key = format!(" {name}=\"");
    let i = tag.find(&key)? + key.len();
    let j = tag[i..].find('"')? + i;
    Some(unescape(&tag[i..j]))
}

fn unescape(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
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

/// The target of `to` relative to the folder `from_dir` (both package
/// paths): `../notesSlides/notesSlide4.xml`.
fn relative(from_dir: &str, to: &str) -> String {
    let from: Vec<&str> = from_dir.split('/').filter(|s| !s.is_empty()).collect();
    let to_parts: Vec<&str> = to.split('/').collect();
    let common = from
        .iter()
        .zip(to_parts.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let mut out: Vec<&str> = vec![".."; from.len() - common];
    out.extend(&to_parts[common..]);
    out.join("/")
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

/// Write the deck the document describes. `original` is the deck the
/// document was imported from.
pub fn export(original: &[u8], plan: &ExportPlan) -> Result<Exported, String> {
    let pkg = OpcPackage::read(original).map_err(|e| e.to_string())?;
    let orig = read_original(&pkg, original)?;
    let mut diagnostics = Vec::new();

    let known: BTreeSet<&str> = orig.slides.iter().map(|(p, _, _)| p.as_str()).collect();
    let slides: Vec<&SlidePlan> = plan
        .slides
        .iter()
        .enumerate()
        .filter(|(i, s)| {
            let ok = known.contains(s.source_part.as_str());
            if !ok {
                diagnostics.push(if s.source_part.is_empty() {
                    format!(
                        "page {}: a slide made in the editor; not exported yet",
                        i + 1
                    )
                } else {
                    format!(
                        "page {}: its slide ({}) is not in this deck; not exported",
                        i + 1,
                        s.source_part
                    )
                });
            }
            ok
        })
        .map(|(_, s)| s)
        .collect();
    for (i, s) in slides.iter().enumerate() {
        if s.content_edited {
            diagnostics.push(format!(
                "slide {}: edits to what is on the slide are not exported yet; it is written as the deck had it",
                i + 1
            ));
        }
    }

    // Unchanged: same slides in the same order, same hidden flags and notes.
    let unchanged = slides.len() == orig.slides.len()
        && slides.iter().zip(&orig.slides).all(|(s, (part, _, _))| {
            s.source_part == *part
                && !s.content_edited
                && orig.hidden.get(part).copied().unwrap_or(false) == s.hidden
                && orig.notes.get(part).cloned().flatten()
                    == s.notes.clone().filter(|n| !n.trim().is_empty())
        });
    if unchanged {
        return Ok(Exported {
            bytes: original.to_vec(),
            diagnostics,
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

    // New parts, in the order they are written.
    let mut out_parts: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut added_types: Vec<(String, &str)> = Vec::new();
    // The written slides: (part, sldId id, r:id, source part).
    let mut written: Vec<(String, u32, String, String)> = Vec::new();
    let mut used: BTreeSet<&str> = BTreeSet::new();

    for s in &slides {
        let src = s.source_part.as_str();
        let (id, rid) = orig
            .slides
            .iter()
            .find(|(p, _, _)| p == src)
            .map(|(_, id, rid)| (*id, rid.clone()))
            .expect("filtered to known slides");
        let first = used.insert(src);
        let (part, id, rid) = if first {
            (src.to_string(), id, rid)
        } else {
            next_slide += 1;
            next_id += 1;
            next_rid += 1;
            let part = format!("{}/slide{next_slide}.xml", part_dir(src));
            let rid = format!("rId{next_rid}");
            prels.items.push(Relationship {
                id: rid.clone(),
                rel_type: REL_SLIDE.to_string(),
                target: relative(&pres_dir, &part),
                target_mode: None,
            });
            added_types.push((part.clone(), CT_SLIDE));
            (part, next_id, rid)
        };

        let mut slide_xml = text(&pkg, src)?;
        slide_xml = set_hidden(&slide_xml, s.hidden);
        let mut srels = rels(&pkg, src);
        let src_dir = part_dir(src).to_string();
        let dir = part_dir(&part).to_string();

        // Notes: the source slide's notes slide, copied for a duplicate,
        // rewritten when the text changed, created when the slide gains notes.
        let want = s.notes.clone().filter(|n| !n.trim().is_empty());
        let had = orig.notes.get(src).cloned().flatten();
        let notes_rel = srels.items.iter().position(|r| r.rel_type == REL_NOTES);
        match notes_rel {
            Some(i) => {
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
                let notes_part = if first {
                    notes_src.clone()
                } else {
                    next_notes += 1;
                    let p = format!("{}/notesSlide{next_notes}.xml", part_dir(&notes_src));
                    added_types.push((p.clone(), CT_NOTES));
                    srels.items[i].target = relative(&dir, &p);
                    p
                };
                // The notes slide points back at its slide.
                let mut nrels = rels(&pkg, &notes_src);
                for r in &mut nrels.items {
                    if r.rel_type == REL_SLIDE {
                        r.target = relative(part_dir(&notes_part), &part);
                    }
                }
                out_parts.insert(rels_part_name(&notes_part), write_rels(&nrels));
                out_parts.insert(notes_part, notes_xml.into_bytes());
            }
            None if want.is_some() => match &notes_master {
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
                    out_parts.insert(rels_part_name(&p), write_rels(&nrels));
                    out_parts.insert(p, new_notes_xml(want.as_deref().unwrap_or("")).into_bytes());
                }
                None => diagnostics.push(format!(
                    "{part}: the deck has no notes master, so its new notes are not written"
                )),
            },
            None => {}
        }
        // A duplicate's own relationships resolve from its own folder; its
        // folder is its source's, so targets stay as they are.
        out_parts.insert(rels_part_name(&part), write_rels(&srels));
        out_parts.insert(part.clone(), slide_xml.into_bytes());
        written.push((part, id, rid, src.to_string()));
    }

    // Slides the document no longer has, and their notes.
    let mut removed: BTreeSet<String> = BTreeSet::new();
    for (part, _, rid) in &orig.slides {
        if used.contains(part.as_str()) {
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

    // presentation.xml: the slide list in document order, sections kept
    // contiguous.
    let mut pres = text(&pkg, &orig.presentation)?;
    let list: String = written
        .iter()
        .map(|(_, id, rid, _)| format!(r#"<p:sldId id="{id}" r:id="{rid}"/>"#))
        .collect();
    if let (Some(a), Some(b)) = (pres.find("<p:sldIdLst>"), pres.find("</p:sldIdLst>")) {
        pres.replace_range(a + "<p:sldIdLst>".len()..b, &list);
    }
    pres = rewrite_sections(&pres, &orig, &written);

    let mut ct = text(&pkg, "[Content_Types].xml")?;
    let removed_parts: BTreeSet<String> = removed
        .iter()
        .filter(|p| !p.contains("/_rels/"))
        .cloned()
        .collect();
    ct = patch_content_types(&ct, &removed_parts, &added_types);

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
        } else if name == pres_rels {
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
    Ok(Exported { bytes, diagnostics })
}

/// `docProps/app.xml`'s slide count.
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
