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

//! What `presentation.xml` says about the deck as a whole (slide ADR 720):
//! its sections (`p14:sectionLst`), its custom shows (`p:custShowLst`) and
//! the package kind its content type names (a deck, a template or a show).
//!
//! Each is written only when the document's differs from the deck's, so an
//! unedited deck keeps its bytes.

use paged_ooxml::xml::escape_attr as escape;
use serde::Deserialize;

use crate::{attr, tags};

/// The `p14` section list's extension URI.
pub const SECTION_EXT_URI: &str = "{521415D9-36F7-43E2-AB2F-B90AF26B5E84}";
const P14_NS: &str = "http://schemas.microsoft.com/office/powerpoint/2010/main";

/// The main part's content type for each package kind.
pub const CT_PRESENTATION: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
pub const CT_TEMPLATE: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml";
pub const CT_SHOW: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml";

/// The package kind a written file is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    /// `.pptx`.
    Pptx,
    /// `.potx`: a template; opening it makes a new presentation.
    Potx,
    /// `.ppsx`: opens straight into the slide show.
    Ppsx,
}

impl Format {
    pub fn content_type(self) -> &'static str {
        match self {
            Format::Pptx => CT_PRESENTATION,
            Format::Potx => CT_TEMPLATE,
            Format::Ppsx => CT_SHOW,
        }
    }
}

/// A section as the document holds it: the page its first slide is.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SectionPlan {
    /// Its `{GUID}`; a section made in the editor has none and is given one.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    /// The page of its first slide.
    pub first_page: String,
}

/// A custom show as the document holds it.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomShowPlan {
    /// Its id; a show made in the editor has none and is given one.
    #[serde(default)]
    pub id: Option<u32>,
    pub name: String,
    /// The pages it plays, in order.
    pub pages: Vec<String>,
}

/// Set the content type of the main part `/{part}`.
pub fn set_main_content_type(ct_xml: &str, part: &str, ct: &str) -> String {
    let key = format!(r#"<Override PartName="/{part}""#);
    let Some(i) = ct_xml.find(&key) else {
        return ct_xml.replace(
            "</Types>",
            &format!(r#"<Override PartName="/{part}" ContentType="{ct}"/></Types>"#),
        );
    };
    let Some(j) = ct_xml[i..].find("/>").map(|j| i + j + 2) else {
        return ct_xml.to_string();
    };
    format!(
        r#"{}<Override PartName="/{part}" ContentType="{ct}"/>{}"#,
        &ct_xml[..i],
        &ct_xml[j..]
    )
}

/// A written section: name, id and the `p:sldId` ids it holds.
pub type WrittenSection = (String, String, Vec<u32>);

/// The deck's sections as `presentation.xml` holds them.
pub fn read_sections(pres: &str) -> Vec<WrittenSection> {
    let Some(a) = pres.find("<p14:sectionLst") else {
        return Vec::new();
    };
    let b = pres[a..]
        .find("</p14:sectionLst>")
        .map(|i| a + i)
        .unwrap_or(pres.len());
    let lst = &pres[a..b];
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(i) = lst[at..].find("<p14:section ") {
        let s = at + i;
        let open_end = s + lst[s..].find('>').unwrap_or(0) + 1;
        let open = &lst[s..open_end];
        let self_closed = open.ends_with("/>");
        let close = if self_closed {
            open_end
        } else {
            lst[open_end..]
                .find("</p14:section>")
                .map(|j| open_end + j)
                .unwrap_or(open_end)
        };
        let ids = tags(&lst[open_end..close], "p14:sldId")
            .iter()
            .filter_map(|t| attr(t, "id")?.parse().ok())
            .collect();
        out.push((
            attr(open, "name").unwrap_or_default(),
            attr(open, "id").unwrap_or_default(),
            ids,
        ));
        at = close.max(open_end);
    }
    out
}

/// The sections the document asks for, over the written slides
/// (`(page id, sldId id)` in order). A slide before the first section
/// start opens a "Default Section", as PowerPoint names it. A section whose
/// first page was not written is dropped; a repeated id (a duplicated first
/// slide) does not start a second section.
pub fn plan_sections(plan: &[SectionPlan], written: &[(Option<&str>, u32)]) -> Vec<WrittenSection> {
    if plan.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<WrittenSection> = Vec::new();
    let mut seen_ids: Vec<String> = Vec::new();
    for (page, id) in written {
        let start = page.and_then(|p| plan.iter().find(|s| s.first_page == p));
        let start = start.filter(|s| {
            let gid = s.id.clone().unwrap_or_default();
            gid.is_empty() || !seen_ids.contains(&gid)
        });
        match start {
            Some(s) => {
                let gid =
                    s.id.clone()
                        .filter(|g| crate::comments::is_guid(g))
                        .unwrap_or_else(|| {
                            crate::comments::guid(&format!("section:{}:{}", s.name, s.first_page))
                        });
                seen_ids.push(s.id.clone().unwrap_or_else(|| gid.clone()));
                out.push((s.name.clone(), gid, vec![*id]));
            }
            None if out.is_empty() => {
                out.push((
                    "Default Section".into(),
                    crate::comments::guid("section:default"),
                    vec![*id],
                ));
            }
            None => out.last_mut().expect("a section").2.push(*id),
        }
    }
    out
}

/// `presentation.xml` with `sections` as its section list: the list
/// replaced, added in a new `p:ext`, or removed (with its `p:ext`) when
/// empty.
pub fn write_sections(pres: &str, sections: &[WrittenSection]) -> String {
    let body: String = sections
        .iter()
        .map(|(name, id, ids)| {
            let list: String = ids
                .iter()
                .map(|i| format!(r#"<p14:sldId id="{i}"/>"#))
                .collect();
            format!(
                r#"<p14:section name="{}" id="{}"><p14:sldIdLst>{list}</p14:sldIdLst></p14:section>"#,
                escape(name),
                escape(id)
            )
        })
        .collect();
    // Replace an existing list (keeping its own namespace declaration).
    if let Some(a) = pres.find("<p14:sectionLst") {
        let open_end = a + pres[a..].find('>').unwrap_or(0) + 1;
        let self_closed = pres[a..open_end].ends_with("/>");
        let end = if self_closed {
            open_end
        } else {
            pres[open_end..]
                .find("</p14:sectionLst>")
                .map(|i| open_end + i + "</p14:sectionLst>".len())
                .unwrap_or(open_end)
        };
        if sections.is_empty() {
            // Drop the whole p:ext that carried it.
            let ext_start = pres[..a].rfind("<p:ext ");
            let ext_end = pres[end..]
                .find("</p:ext>")
                .map(|i| end + i + "</p:ext>".len());
            if let (Some(s), Some(e)) = (ext_start, ext_end) {
                let out = format!("{}{}", &pres[..s], &pres[e..]);
                return out.replace("<p:extLst></p:extLst>", "");
            }
            return format!("{}{}", &pres[..a], &pres[end..]);
        }
        let open = pres[a..open_end]
            .trim_end_matches("/>")
            .trim_end_matches('>');
        return format!(
            "{}{open}>{body}</p14:sectionLst>{}",
            &pres[..a],
            &pres[end..]
        );
    }
    if sections.is_empty() {
        return pres.to_string();
    }
    let ext = format!(
        r#"<p:ext uri="{SECTION_EXT_URI}"><p14:sectionLst xmlns:p14="{P14_NS}">{body}</p14:sectionLst></p:ext>"#
    );
    if let Some(i) = pres.find("<p:extLst>") {
        let at = i + "<p:extLst>".len();
        return format!("{}{ext}{}", &pres[..at], &pres[at..]);
    }
    if let Some(i) = pres.find("<p:extLst/>") {
        return format!(
            "{}<p:extLst>{ext}</p:extLst>{}",
            &pres[..i],
            &pres[i + "<p:extLst/>".len()..]
        );
    }
    match pres.rfind("</p:presentation>") {
        Some(i) => format!("{}<p:extLst>{ext}</p:extLst>{}", &pres[..i], &pres[i..]),
        None => pres.to_string(),
    }
}

/// A written custom show: name, id and the `r:id`s of its slides.
pub type WrittenShow = (String, u32, Vec<String>);

/// The deck's custom shows as `presentation.xml` holds them.
pub fn read_custom_shows(pres: &str) -> Vec<WrittenShow> {
    let Some(a) = pres.find("<p:custShowLst") else {
        return Vec::new();
    };
    let b = pres[a..]
        .find("</p:custShowLst>")
        .map(|i| a + i)
        .unwrap_or(pres.len());
    let lst = &pres[a..b];
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(i) = lst[at..].find("<p:custShow ") {
        let s = at + i;
        let open_end = s + lst[s..].find('>').unwrap_or(0) + 1;
        let open = &lst[s..open_end];
        let close = lst[open_end..]
            .find("</p:custShow>")
            .map(|j| open_end + j)
            .unwrap_or(open_end);
        let rids = tags(&lst[open_end..close], "p:sld")
            .iter()
            .filter_map(|t| attr(t, "r:id"))
            .collect();
        out.push((
            attr(open, "name").unwrap_or_default(),
            attr(open, "id").and_then(|v| v.parse().ok()).unwrap_or(0),
            rids,
        ));
        at = close.max(open_end);
    }
    out
}

/// The custom shows the document asks for, over the written slides
/// (`(page id, r:id)`): a page that was not written is left out of a show.
/// Ids are kept where given and unique, else the next free one.
pub fn plan_custom_shows(
    plan: &[CustomShowPlan],
    written: &[(Option<&str>, &str)],
) -> Vec<WrittenShow> {
    let given: Vec<u32> = plan.iter().filter_map(|c| c.id).collect();
    let mut used: Vec<u32> = Vec::new();
    let mut out = Vec::new();
    for c in plan {
        let id = match c.id {
            Some(i) if !used.contains(&i) => i,
            _ => (0..)
                .find(|i| !used.contains(i) && !given.contains(i))
                .unwrap_or(0),
        };
        used.push(id);
        let rids = c
            .pages
            .iter()
            .filter_map(|p| {
                written
                    .iter()
                    .find(|(page, _)| *page == Some(p.as_str()))
                    .map(|(_, rid)| rid.to_string())
            })
            .collect();
        out.push((c.name.clone(), id, rids));
    }
    out
}

/// Where `p:custShowLst` goes: before the first of the elements that follow
/// it in `CT_Presentation`'s sequence.
const AFTER_CUST_SHOWS: &[&str] = &[
    "<p:photoAlbum",
    "<p:custDataLst",
    "<p:kinsoku",
    "<p:defaultTextStyle",
    "<p:modifyVerifier",
    "<p:extLst",
];

/// `presentation.xml` with `shows` as its custom show list.
pub fn write_custom_shows(pres: &str, shows: &[WrittenShow]) -> String {
    let body: String = shows
        .iter()
        .map(|(name, id, rids)| {
            let list: String = rids
                .iter()
                .map(|r| format!(r#"<p:sld r:id="{}"/>"#, escape(r)))
                .collect();
            format!(
                r#"<p:custShow name="{}" id="{id}"><p:sldLst>{list}</p:sldLst></p:custShow>"#,
                escape(name)
            )
        })
        .collect();
    let new = if shows.is_empty() {
        String::new()
    } else {
        format!("<p:custShowLst>{body}</p:custShowLst>")
    };
    if let Some(a) = pres.find("<p:custShowLst") {
        let open_end = a + pres[a..].find('>').unwrap_or(0) + 1;
        let end = if pres[a..open_end].ends_with("/>") {
            open_end
        } else {
            pres[open_end..]
                .find("</p:custShowLst>")
                .map(|i| open_end + i + "</p:custShowLst>".len())
                .unwrap_or(open_end)
        };
        return format!("{}{new}{}", &pres[..a], &pres[end..]);
    }
    if new.is_empty() {
        return pres.to_string();
    }
    let at = AFTER_CUST_SHOWS
        .iter()
        .filter_map(|t| pres.find(t))
        .min()
        .or_else(|| pres.rfind("</p:presentation>"));
    match at {
        Some(i) => format!("{}{new}{}", &pres[..i], &pres[i..]),
        None => pres.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRES: &str = r#"<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="1" cy="1"/><p:defaultTextStyle/></p:presentation>"#;

    #[test]
    fn sections_are_added_read_back_and_removed() {
        let plan = vec![
            SectionPlan {
                id: None,
                name: "Intro & more".into(),
                first_page: "p1".into(),
            },
            SectionPlan {
                id: Some("{11111111-2222-3333-4444-555555555555}".into()),
                name: "Body".into(),
                first_page: "p2".into(),
            },
        ];
        let w = plan_sections(&plan, &[(Some("p1"), 256), (Some("p2"), 257)]);
        assert_eq!(w.len(), 2);
        assert!(crate::comments::is_guid(&w[0].1));
        assert_eq!(w[1].1, "{11111111-2222-3333-4444-555555555555}");
        let x = write_sections(PRES, &w);
        assert!(x.contains(SECTION_EXT_URI));
        assert_eq!(read_sections(&x), w);
        assert_eq!(read_sections(&x)[0].0, "Intro & more");
        // Renamed in place.
        let mut w2 = w.clone();
        w2[1].0 = "Renamed".into();
        let y = write_sections(&x, &w2);
        assert_eq!(read_sections(&y), w2);
        assert_eq!(y.matches("<p:ext ").count(), 1);
        // Removed with its extension.
        let z = write_sections(&y, &[]);
        assert!(!z.contains("sectionLst"));
        assert!(!z.contains("<p:extLst"));
    }

    #[test]
    fn slides_before_the_first_section_get_a_default_section() {
        let plan = vec![SectionPlan {
            id: None,
            name: "B".into(),
            first_page: "p2".into(),
        }];
        let w = plan_sections(&plan, &[(Some("p1"), 256), (Some("p2"), 257), (None, 258)]);
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].0, "Default Section");
        assert_eq!(w[0].2, vec![256]);
        assert_eq!(w[1].2, vec![257, 258]);
    }

    #[test]
    fn custom_shows_go_before_the_default_text_style() {
        let plan = vec![
            CustomShowPlan {
                id: None,
                name: "Short".into(),
                pages: vec!["p2".into(), "gone".into(), "p1".into()],
            },
            CustomShowPlan {
                id: Some(0),
                name: "Kept".into(),
                pages: vec!["p1".into()],
            },
        ];
        let w = plan_custom_shows(&plan, &[(Some("p1"), "rId2"), (Some("p2"), "rId3")]);
        assert_eq!(w[0].2, vec!["rId3".to_string(), "rId2".to_string()]);
        // The given id is kept; the new show takes another.
        assert_eq!(w[1].1, 0);
        assert_ne!(w[0].1, 0);
        let x = write_custom_shows(PRES, &w);
        let i = x.find("<p:custShowLst>").unwrap();
        assert!(i < x.find("<p:defaultTextStyle").unwrap());
        assert!(i > x.find("<p:sldSz").unwrap());
        assert_eq!(read_custom_shows(&x), w);
        assert!(!write_custom_shows(&x, &[]).contains("custShow"));
    }

    #[test]
    fn the_main_content_type_is_switched() {
        let ct = r#"<Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/a" ContentType="b"/></Types>"#;
        let t = set_main_content_type(ct, "ppt/presentation.xml", CT_TEMPLATE);
        assert!(t.contains(CT_TEMPLATE));
        assert!(!t.contains(CT_PRESENTATION));
        assert!(t.contains(r#"<Override PartName="/a" ContentType="b"/>"#));
        assert_eq!(
            set_main_content_type(&t, "ppt/presentation.xml", CT_PRESENTATION),
            ct
        );
    }
}
