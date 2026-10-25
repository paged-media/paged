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

//! Review comments written back (slide ADR 711). A slide whose comments the
//! document did not change keeps its comment part and its relationship byte
//! for byte. A slide whose comments changed gets one modern comment part
//! (`ppt/comments/modernComment_<sldId>_<hash>.xml`, the form PowerPoint 365
//! writes), with:
//!
//! * each unchanged comment re-emitted as the deck wrote it (while the slide
//!   keeps its slide id, which the comment's markers name);
//! * each edited or new one generated: its slide (and shape) markers, its
//!   position in EMU, its replies, its text one paragraph per line, its
//!   status;
//! * legacy comments converted to modern ones (their legacy relationship is
//!   dropped);
//! * the slide's relationship and its `p188:commentRel` extension;
//! * the authors the comments name added to `ppt/authors.xml`.

use pptx_core::Comment;

use paged_ooxml::xml::escape_attr as escape;

pub use pptx_import::comments::{REL_AUTHORS, REL_LEGACY, REL_MODERN};

pub const CT_COMMENTS: &str = "application/vnd.ms-powerpoint.comments+xml";
pub const CT_AUTHORS: &str = "application/vnd.ms-powerpoint.authors+xml";
const NS_P188: &str = "http://schemas.microsoft.com/office/powerpoint/2018/8/main";
const NS_PC: &str = "http://schemas.microsoft.com/office/powerpoint/2013/main/command";
const NS_AC: &str = "http://schemas.microsoft.com/office/drawing/2013/main/command";
const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/// The slide extension that names the slide's comment part.
const EXT_COMMENT_REL: &str = "{6950BFC3-D8DA-4A85-94F7-54DA5524770B}";
const EMU_PER_PT: f64 = 12_700.0;
/// What a comment without a creation time is written with (the attribute
/// is required).
const NO_DATE: &str = "1970-01-01T00:00:00.000";

/// A relationship type that names a slide's comments (modern or legacy).
pub fn is_comment_rel(rel_type: &str) -> bool {
    rel_type == REL_MODERN || rel_type == REL_LEGACY
}

/// `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`?
pub fn is_guid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 38
        && b[0] == b'{'
        && b[37] == b'}'
        && s[1..37].char_indices().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

fn fnv(seed: &str, basis: u64) -> u64 {
    let mut h = basis;
    for b in seed.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// A stable `{GUID}` for `seed` (an id that is not one: a legacy comment's,
/// or an author known only by name).
pub fn guid(seed: &str) -> String {
    let a = fnv(seed, 0xcbf2_9ce4_8422_2325);
    let b = fnv(seed, 0x8422_2325_cbf2_9ce4);
    let h = format!("{a:016X}{b:016X}");
    format!(
        "{{{}-{}-{}-{}-{}}}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

/// A short hash for a part name.
pub fn short_hash(seed: &str) -> String {
    format!("{:08X}", fnv(seed, 0xcbf2_9ce4_8422_2325) as u32)
}

/// The modern id an author is written with.
pub fn author_guid(author_id: &str, name: &str) -> String {
    if is_guid(author_id) {
        author_id.to_string()
    } else if !name.is_empty() {
        guid(&format!("author:{name}"))
    } else {
        guid(&format!("author-id:{author_id}"))
    }
}

/// An author a written comment names: id, name, initials.
#[derive(Debug, Clone, PartialEq)]
pub struct AuthorRef {
    pub id: String,
    pub name: String,
    pub initials: String,
}

/// The value of `attr` in the first `<tag ...>` of `xml`.
fn attr_of(xml: &str, tag: &str, attr: &str) -> Option<String> {
    let i = xml.find(&format!("<{tag} "))?;
    let end = i + xml[i..].find('>')?;
    let t = &xml[i..end];
    let key = format!(" {attr}=\"");
    let a = t.find(&key)? + key.len();
    let b = t[a..].find('"')? + a;
    Some(t[a..b].to_string())
}

/// The slide's `p14:creationId` (the `cId` its comment markers carry).
pub fn creation_id(slide_xml: &str) -> String {
    attr_of(slide_xml, "p14:creationId", "val").unwrap_or_else(|| "0".into())
}

/// The `a16:creationId` of the shape whose `cNvPr id` is `id`.
fn shape_creation_id(slide_xml: &str, id: u32) -> Option<Option<String>> {
    let key = format!("<p:cNvPr id=\"{id}\"");
    let i = slide_xml.find(&key)?;
    let rest = &slide_xml[i..];
    let open_end = rest.find('>')?;
    if rest[..open_end].ends_with('/') {
        return Some(None);
    }
    let close = rest.find("</p:cNvPr>").unwrap_or(rest.len());
    let inner = &rest[..close];
    Some(attr_of(inner, "a16:creationId", "id"))
}

fn txbody(text: &str) -> String {
    let paras: String = text
        .split('\n')
        .map(|line| {
            if line.is_empty() {
                r#"<a:p><a:endParaRPr lang="en-US"/></a:p>"#.to_string()
            } else {
                format!(
                    r#"<a:p><a:r><a:rPr lang="en-US"/><a:t>{}</a:t></a:r></a:p>"#,
                    escape(line)
                )
            }
        })
        .collect();
    format!("<p188:txBody><a:bodyPr/><a:lstStyle/>{paras}</p188:txBody>")
}

fn markers(c: &Comment, slide_xml: &str, sld_id: u32) -> String {
    let cid = creation_id(slide_xml);
    let sld = format!(r#"<pc:docMk/><pc:sldMk cId="{cid}" sldId="{sld_id}"/>"#);
    if let Some(id) = c.shape_id {
        if let Some(creation) = shape_creation_id(slide_xml, id) {
            let creation = creation
                .map(|g| format!(r#" creationId="{}""#, escape(&g)))
                .unwrap_or_default();
            return format!(
                r#"<ac:deMkLst xmlns:ac="{NS_AC}" xmlns:pc="{NS_PC}">{sld}<ac:spMk id="{id}"{creation}/></ac:deMkLst>"#
            );
        }
    }
    format!(r#"<pc:sldMkLst xmlns:pc="{NS_PC}">{sld}</pc:sldMkLst>"#)
}

fn emu(pt: f64) -> i64 {
    (pt * EMU_PER_PT).round() as i64
}

/// One generated `p188:cm`, and the authors it names.
fn comment_xml(
    c: &Comment,
    marker: Option<&str>,
    slide_xml: &str,
    sld_id: u32,
    authors: &mut Vec<AuthorRef>,
) -> String {
    let mut name = |id: &str, n: &str, i: &str| {
        let id = author_guid(id, n);
        if !authors.iter().any(|a| a.id == id) {
            authors.push(AuthorRef {
                id: id.clone(),
                name: n.to_string(),
                initials: i.to_string(),
            });
        }
        id
    };
    let id = if is_guid(&c.id) {
        c.id.clone()
    } else {
        guid(&format!("comment:{}", c.id))
    };
    let author = name(&c.author_id, &c.author, &c.initials);
    let status = c
        .status
        .as_deref()
        .filter(|s| *s != "active" && !s.is_empty())
        .map(|s| format!(r#" status="{}""#, escape(s)))
        .unwrap_or_default();
    let mut out = format!(
        r#"<p188:cm id="{}" authorId="{}"{status} created="{}">"#,
        escape(&id),
        escape(&author),
        escape(c.created.as_deref().unwrap_or(NO_DATE))
    );
    match marker {
        Some(m) => out.push_str(m),
        None => out.push_str(&markers(c, slide_xml, sld_id)),
    }
    if let (Some(x), Some(y)) = (c.x, c.y) {
        out.push_str(&format!(r#"<p188:pos x="{}" y="{}"/>"#, emu(x), emu(y)));
    }
    if !c.replies.is_empty() {
        out.push_str("<p188:replyLst>");
        for r in &c.replies {
            let rid = if is_guid(&r.id) {
                r.id.clone()
            } else {
                guid(&format!("reply:{}:{}", c.id, r.id))
            };
            let ra = name(&r.author_id, &r.author, &r.initials);
            out.push_str(&format!(
                r#"<p188:reply id="{}" authorId="{}" created="{}">{}</p188:reply>"#,
                escape(&rid),
                escape(&ra),
                escape(r.created.as_deref().unwrap_or(NO_DATE)),
                txbody(&r.text)
            ));
        }
        out.push_str("</p188:replyLst>");
    }
    out.push_str(&txbody(&c.text));
    out.push_str("</p188:cm>");
    out
}

/// A slide's comments as one modern comment part.
///
/// `originals` are the comments the deck had on the slide's source part;
/// `same_slide` says the slide keeps its slide id, so an unchanged comment is
/// re-emitted as written and an edited one keeps its markers. `root_attrs` are
/// the original part's root attributes (its namespace declarations). Returns
/// the part and the authors of the comments it generated.
pub fn write_part(
    list: &[Comment],
    originals: &[Comment],
    same_slide: bool,
    root_attrs: &[(String, String)],
    slide_xml: &str,
    sld_id: u32,
) -> (String, Vec<AuthorRef>) {
    let mut authors = Vec::new();
    let mut body = String::new();
    for c in list {
        let orig = originals.iter().find(|o| o.id == c.id && !o.legacy);
        match orig {
            Some(o) if same_slide && o.same_as(c) && o.raw.is_some() => {
                body.push_str(o.raw.as_deref().unwrap_or_default());
            }
            _ => {
                // Keep the deck's markers while they still say the same:
                // the same slide id and the same anchor shape.
                let marker = orig
                    .filter(|o| same_slide && o.shape_id == c.shape_id)
                    .and_then(|o| o.marker_xml.as_deref());
                body.push_str(&comment_xml(c, marker, slide_xml, sld_id, &mut authors));
            }
        }
    }
    let mut root = String::new();
    let mut declared: Vec<&str> = Vec::new();
    for (k, v) in root_attrs {
        if k.starts_with("xmlns") {
            declared.push(k.as_str());
            root.push_str(&format!(r#" {k}="{}""#, escape(v)));
        }
    }
    for (k, v) in [
        ("xmlns:a", NS_A),
        ("xmlns:r", NS_R),
        ("xmlns:p188", NS_P188),
    ] {
        if !declared.contains(&k) {
            root.push_str(&format!(r#" {k}="{v}""#));
        }
    }
    (
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<p188:cmLst{root}>{body}</p188:cmLst>"
        ),
        authors,
    )
}

/// `ppt/authors.xml` naming `needed` as well: the deck's own entries kept as
/// written, the missing authors added. `None` when nothing is missing.
pub fn authors_xml(existing: Option<&str>, needed: &[AuthorRef]) -> Option<String> {
    let has = |id: &str| existing.is_some_and(|x| x.contains(&format!(r#"id="{}""#, escape(id))));
    let missing: String = needed
        .iter()
        .filter(|a| !has(&a.id))
        .map(|a| {
            format!(
                r#"<p188:author id="{}" name="{}" initials="{}" userId="{}" providerId="None"/>"#,
                escape(&a.id),
                escape(&a.name),
                escape(&a.initials),
                escape(&a.name)
            )
        })
        .collect();
    if missing.is_empty() {
        return None;
    }
    match existing {
        Some(x) if x.contains("</p188:authorLst>") => {
            Some(x.replacen("</p188:authorLst>", &format!("{missing}</p188:authorLst>"), 1))
        }
        Some(x) if x.contains("<p188:authorLst") && x.trim_end().ends_with("/>") => {
            let i = x.rfind("/>").unwrap_or(x.len());
            Some(format!("{}>{missing}</p188:authorLst>", &x[..i]))
        }
        _ => Some(format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<p188:authorLst xmlns:a=\"{NS_A}\" xmlns:r=\"{NS_R}\" xmlns:p188=\"{NS_P188}\">{missing}</p188:authorLst>"
        )),
    }
}

/// The slide without its `p188:commentRel` extension (and without a
/// slide-level extension list that held nothing else).
pub fn strip_comment_ext(slide_xml: &str) -> String {
    let open = format!(r#"<p:ext uri="{EXT_COMMENT_REL}">"#);
    let Some(i) = slide_xml.find(&open) else {
        return slide_xml.to_string();
    };
    let Some(j) = slide_xml[i..]
        .find("</p:ext>")
        .map(|j| i + j + "</p:ext>".len())
    else {
        return slide_xml.to_string();
    };
    let mut out = format!("{}{}", &slide_xml[..i], &slide_xml[j..]);
    out = out.replace("<p:extLst></p:extLst></p:sld>", "</p:sld>");
    out
}

/// The slide with a `p188:commentRel` extension naming relationship `rid`,
/// in its slide-level extension list (the last child of `p:sld`).
pub fn add_comment_ext(slide_xml: &str, rid: &str) -> String {
    let ext = format!(
        r#"<p:ext uri="{EXT_COMMENT_REL}"><p188:commentRel xmlns:p188="{NS_P188}" r:id="{}"/></p:ext>"#,
        escape(rid)
    );
    let Some(end) = slide_xml.rfind("</p:sld>") else {
        return slide_xml.to_string();
    };
    let head = &slide_xml[..end];
    if head.trim_end().ends_with("</p:extLst>") {
        let close = head.rfind("</p:extLst>").unwrap_or(end);
        return format!("{}{ext}{}", &slide_xml[..close], &slide_xml[close..]);
    }
    format!(
        "{}<p:extLst>{ext}</p:extLst>{}",
        &slide_xml[..end],
        &slide_xml[end..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guids_are_stable_and_well_formed() {
        let g = guid("legacy-0-1");
        assert!(is_guid(&g), "{g}");
        assert_eq!(g, guid("legacy-0-1"));
        assert_ne!(g, guid("legacy-0-2"));
        assert!(!is_guid("legacy-0-1"));
    }

    #[test]
    fn the_comment_extension_goes_in_and_out_of_the_slide_extension_list() {
        let bare = "<p:sld><p:cSld/><p:clrMapOvr/></p:sld>";
        let with = add_comment_ext(bare, "rId9");
        assert!(
            with.ends_with(r#"r:id="rId9"/></p:ext></p:extLst></p:sld>"#),
            "{with}"
        );
        assert_eq!(strip_comment_ext(&with), bare);
        let other = r#"<p:sld><p:cSld/><p:extLst><p:ext uri="{X}"/></p:extLst></p:sld>"#;
        let both = add_comment_ext(other, "rId2");
        assert!(
            both.contains(r#"<p:ext uri="{X}"/><p:ext uri="{6950"#),
            "{both}"
        );
        assert_eq!(strip_comment_ext(&both), other);
    }

    #[test]
    fn authors_are_added_and_known_ones_kept() {
        let a = AuthorRef {
            id: guid("author:Ada"),
            name: "Ada".into(),
            initials: "A".into(),
        };
        let x = authors_xml(None, std::slice::from_ref(&a)).unwrap();
        assert!(x.contains(r#"name="Ada" initials="A""#), "{x}");
        assert_eq!(authors_xml(Some(&x), &[a]), None);
    }
}
