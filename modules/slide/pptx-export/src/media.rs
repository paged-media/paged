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

//! Video and audio written back (slide ADR 718).
//!
//! A movie or sound frame of the document (engine ADR 1027) is a `p:pic`
//! whose `p:nvPr` names the medium as PowerPoint does: `a:videoFile` /
//! `a:audioFile` with an `r:link` (to `NULL`, external, for an embedded
//! medium; to the URL for a linked one) and the `p14:media` extension with
//! the part (`r:embed`), its trim and its fade. A slide's timing plays it:
//! a `p:video` / `p:audio` node (volume, loop, hide while not playing) and,
//! for a medium that starts with the slide or on a click, a `mediacall`
//! effect. A media part is written byte for byte as the document holds it.

use paged_model::{MediaItem, MediaKind, MediaPlay, MediaSource};

/// `a:videoFile`'s relationship.
pub const REL_VIDEO: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/video";
/// `a:audioFile`'s relationship.
pub const REL_AUDIO: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio";
/// `p14:media`'s relationship.
pub const REL_MEDIA: &str = "http://schemas.microsoft.com/office/2007/relationships/media";
/// The `p:ext` that holds `p14:media`.
pub const MEDIA_EXT: &str = "{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}";
const NS_P14: &str = "http://schemas.microsoft.com/office/powerpoint/2010/main";

/// A frame's medium, as the native read model holds it (`media`).
pub fn of(v: &serde_json::Value) -> Option<MediaItem> {
    let m: MediaItem = serde_json::from_value(v.get("media")?.clone()).ok()?;
    m.is_valid().then_some(m)
}

/// The element names of a medium's `p:nvPr` child and its timing node.
pub fn tags(kind: MediaKind) -> (&'static str, &'static str) {
    match kind {
        MediaKind::Movie => ("a:videoFile", "p:video"),
        MediaKind::Sound => ("a:audioFile", "p:audio"),
    }
}

/// `p14:media`'s children: the trim and the fade, when there are any.
pub fn p14_children(m: &MediaItem) -> String {
    let mut out = String::new();
    if m.trim_start_ms > 0 || m.trim_end_ms > 0 {
        out.push_str("<p14:trim");
        if m.trim_start_ms > 0 {
            out.push_str(&format!(r#" st="{}""#, m.trim_start_ms));
        }
        if m.trim_end_ms > 0 {
            out.push_str(&format!(r#" end="{}""#, m.trim_end_ms));
        }
        out.push_str("/>");
    }
    if m.fade_in_ms > 0 || m.fade_out_ms > 0 {
        out.push_str("<p14:fade");
        if m.fade_in_ms > 0 {
            out.push_str(&format!(r#" in="{}""#, m.fade_in_ms));
        }
        if m.fade_out_ms > 0 {
            out.push_str(&format!(r#" out="{}""#, m.fade_out_ms));
        }
        out.push_str("/>");
    }
    out
}

/// A new picture's `p:nvPr` for medium `m`: `file_rid` the `a:videoFile` /
/// `a:audioFile` relationship, `media_rid` the `p14:media` one (none for
/// a linked medium).
pub fn nv_pr(m: &MediaItem, file_rid: &str, media_rid: Option<&str>) -> String {
    let (file, _) = tags(m.kind);
    let ext = match media_rid {
        Some(rid) => format!(
            r#"<p:extLst><p:ext uri="{MEDIA_EXT}"><p14:media xmlns:p14="{NS_P14}" r:embed="{rid}">{}</p14:media></p:ext></p:extLst>"#,
            p14_children(m)
        ),
        None => format!(
            r#"<p:extLst><p:ext uri="{MEDIA_EXT}"><p14:media xmlns:p14="{NS_P14}" r:link="{file_rid}">{}</p14:media></p:ext></p:extLst>"#,
            p14_children(m)
        ),
    };
    format!(r#"<p:nvPr><{file} r:link="{file_rid}"/>{ext}</p:nvPr>"#)
}

/// `xml` (a `p:pic`) with its `p14:media`'s trim and fade those of `m`.
/// Unchanged when the picture has no `p14:media`.
pub fn patch_p14(xml: &str, m: &MediaItem) -> String {
    let Some(i) = xml.find("<p14:media") else {
        return xml.to_string();
    };
    let Some(open_end) = xml[i..].find('>').map(|j| i + j) else {
        return xml.to_string();
    };
    let kids = p14_children(m);
    if xml[..open_end].ends_with('/') {
        // `<p14:media …/>`: open it.
        let head = &xml[i..open_end];
        return format!(
            "{}{head}>{kids}</p14:media>{}",
            &xml[..i],
            &xml[open_end + 1..]
        );
    }
    let Some(close) = xml[open_end..].find("</p14:media>").map(|j| open_end + j) else {
        return xml.to_string();
    };
    // Keep what the medium does not say (`p14:bmkLst`, its own extensions).
    let inner = &xml[open_end + 1..close];
    let mut kept = String::new();
    if let Ok(root) =
        paged_ooxml::tree::parse(format!(r#"<w xmlns:p14="{NS_P14}">{inner}</w>"#).as_bytes())
    {
        for c in &root.children {
            if c.local != "trim" && c.local != "fade" {
                kept.push_str(&c.to_xml());
            }
        }
    }
    format!("{}{kids}{kept}{}", &xml[..open_end + 1], &xml[close..])
}

/// One medium the slide's timing must say, after the shapes are written.
#[derive(Debug, Clone)]
pub struct TimingEdit {
    /// The picture's `cNvPr id` in the written part.
    pub spid: u32,
    pub media: MediaItem,
    /// A picture made in the editor (its start must be written too).
    pub new: bool,
}

/// `xml` (a slide part) with each medium of `edits` played as it says:
/// its `p:video` / `p:audio` node's volume, loop and hide, added when the
/// timing has none. A new medium that starts with the slide or on a click
/// gets its `mediacall` effect when the slide has no timing of its own;
/// one that cannot is reported in `lost`.
pub fn apply_timing(xml: &str, edits: &[TimingEdit], lost: &mut Vec<String>) -> String {
    let mut out = xml.to_string();
    for e in edits {
        let node = media_node(e.spid, &e.media, 100 + e.spid * 2);
        match find_media_node(&out, e.spid) {
            Some((a, b)) => {
                // Keep its own `p:cTn id`: conditions may name it.
                let id = attr_in(&out[a..b], "p:cTn", "id").unwrap_or(100 + e.spid * 2);
                out = format!(
                    "{}{}{}",
                    &out[..a],
                    media_node(e.spid, &e.media, id),
                    &out[b..]
                );
            }
            None if !out.contains("<p:timing") => {
                out = insert_timing(&out, &whole_timing(e));
            }
            None => match root_children_end(&out) {
                Some(at) => {
                    out.insert_str(at, &node);
                    if e.new && e.media.play == MediaPlay::Auto {
                        lost.push(format!(
                            "a {} that plays automatically on a slide with animations plays when it is clicked",
                            kind_word(e.media.kind)
                        ));
                    }
                }
                None => lost.push(format!(
                    "the timing of a {} could not be written",
                    kind_word(e.media.kind)
                )),
            },
        }
    }
    out
}

fn kind_word(k: MediaKind) -> &'static str {
    match k {
        MediaKind::Movie => "video",
        MediaKind::Sound => "sound",
    }
}

/// A `p:video` / `p:audio` node for medium `m` on shape `spid`.
fn media_node(spid: u32, m: &MediaItem, ctn_id: u32) -> String {
    let (_, tag) = tags(m.kind);
    let full = if m.full_screen && m.kind == MediaKind::Movie {
        r#" fullScrn="1""#
    } else {
        ""
    };
    let vol = (m.volume.clamp(0.0, 1.0) * 100_000.0).round() as u32;
    let mute = if vol == 0 { r#" mute="1""# } else { "" };
    let rep = if m.looped {
        r#" repeatCount="indefinite""#
    } else {
        ""
    };
    let disp = if m.hide_while_not_playing {
        r#" display="0""#
    } else {
        ""
    };
    format!(
        r#"<{tag}{full}><p:cMediaNode vol="{vol}"{mute}><p:cTn id="{ctn_id}"{rep} fill="hold"{disp}><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cMediaNode></{tag}>"#
    )
}

/// The whole `p:timing` of a slide whose only timing is medium `e`: the
/// medium's node and, unless it plays when it is clicked, the main
/// sequence that starts it (with the slide, or on the first click), as
/// PowerPoint writes it.
fn whole_timing(e: &TimingEdit) -> String {
    let node = media_node(e.spid, &e.media, 7);
    let seq = if e.new || e.media.play == MediaPlay::Auto {
        let auto = e.media.play == MediaPlay::Auto;
        let group = if auto {
            r#"<p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>"#
        } else {
            r#"<p:cond delay="indefinite"/>"#
        };
        let node_type = if auto { "afterEffect" } else { "clickEffect" };
        format!(
            r#"<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="3" fill="hold"><p:stCondLst>{group}</p:stCondLst><p:childTnLst><p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="5" presetID="1" presetClass="mediacall" presetSubtype="0" fill="hold" nodeType="{node_type}"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:cmd type="call" cmd="playFrom({:.1})"><p:cBhvr><p:cTn id="6" dur="{}" fill="hold"/><p:tgtEl><p:spTgt spid="{}"/></p:tgtEl></p:cBhvr></p:cmd></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>"#,
            0.0,
            e.media.duration_ms.unwrap_or(1).max(1),
            e.spid
        )
    } else {
        String::new()
    };
    format!(
        r#"<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>{seq}{node}</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>"#
    )
}

/// Where the `p:video` / `p:audio` node of shape `spid` is, as a range of
/// `xml`.
fn find_media_node(xml: &str, spid: u32) -> Option<(usize, usize)> {
    let needle = format!(r#"<p:spTgt spid="{spid}"/></p:tgtEl></p:cMediaNode>"#);
    let at = xml.find(&needle)?;
    let (open, close) = ["<p:video", "<p:audio"]
        .iter()
        .filter_map(|t| xml[..at].rfind(t).map(|i| (i, *t)))
        .max_by_key(|(i, _)| *i)
        .map(|(i, t)| {
            (
                i,
                if t == "<p:video" {
                    "</p:video>"
                } else {
                    "</p:audio>"
                },
            )
        })?;
    let end = xml[at..].find(close).map(|j| at + j + close.len())?;
    Some((open, end))
}

/// The value of `attr` on the first `tag` element in `xml`.
fn attr_in(xml: &str, tag: &str, attr: &str) -> Option<u32> {
    let i = xml.find(&format!("<{tag} "))?;
    let el = &xml[i..i + xml[i..].find('>')?];
    let a = el.find(&format!(r#" {attr}=""#))? + attr.len() + 3;
    el[a..a + el[a..].find('"')?].parse().ok()
}

/// Where a new node goes in the timing's root: the end of the `tmRoot`'s
/// `p:childTnLst`.
fn root_children_end(xml: &str) -> Option<usize> {
    let root = xml.find(r#"nodeType="tmRoot""#)?;
    let tn = xml[..root].rfind("<p:par>")?;
    // The root par's own closing childTnLst: the last one before `</p:tnLst>`.
    let end = xml[tn..].find("</p:tnLst>").map(|j| tn + j)?;
    xml[tn..end].rfind("</p:childTnLst>").map(|j| tn + j)
}

/// `xml` with `timing` in its place: after `p:transition`, else after
/// `p:clrMapOvr`, else after `p:cSld` (PresentationML's order).
fn insert_timing(xml: &str, timing: &str) -> String {
    for anchor in ["</p:transition>", "</p:clrMapOvr>", "</p:cSld>"] {
        if let Some(i) = xml.find(anchor) {
            let at = i + anchor.len();
            return format!("{}{timing}{}", &xml[..at], &xml[at..]);
        }
    }
    // `<p:transition …/>` written empty.
    if let Some(i) = xml.find("<p:transition") {
        if let Some(j) = xml[i..].find("/>") {
            let at = i + j + 2;
            return format!("{}{timing}{}", &xml[..at], &xml[at..]);
        }
    }
    xml.to_string()
}

/// The part and relationship target a new medium is written as.
pub fn source_part(m: &MediaItem) -> Option<&str> {
    match &m.source {
        MediaSource::Part { path } => Some(path),
        MediaSource::Link { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn movie() -> MediaItem {
        MediaItem {
            volume: 0.4,
            looped: true,
            hide_while_not_playing: true,
            trim_start_ms: 250,
            ..MediaItem::new(
                MediaKind::Movie,
                MediaSource::Part {
                    path: "paged/core/media/a.mp4".into(),
                },
            )
        }
    }

    #[test]
    fn a_media_node_is_patched_in_place() {
        let xml = r#"<p:timing><p:tnLst><p:par><p:cTn id="1" nodeType="tmRoot"><p:childTnLst><p:video><p:cMediaNode vol="80000"><p:cTn id="7" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="4"/></p:tgtEl></p:cMediaNode></p:video></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>"#;
        let mut lost = Vec::new();
        let out = apply_timing(
            xml,
            &[TimingEdit {
                spid: 4,
                media: movie(),
                new: false,
            }],
            &mut lost,
        );
        assert!(out.contains(r#"vol="40000""#), "{out}");
        assert!(
            out.contains(r#"<p:cTn id="7" repeatCount="indefinite" fill="hold" display="0">"#),
            "{out}"
        );
        assert_eq!(out.matches("<p:video").count(), 1);
        assert!(lost.is_empty());
    }

    #[test]
    fn a_new_medium_gets_a_timing() {
        let xml = r#"<p:sld><p:cSld><p:spTree/></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"#;
        let mut lost = Vec::new();
        let m = MediaItem {
            play: MediaPlay::Auto,
            ..movie()
        };
        let out = apply_timing(
            xml,
            &[TimingEdit {
                spid: 9,
                media: m,
                new: true,
            }],
            &mut lost,
        );
        assert!(out.contains(r#"</p:clrMapOvr><p:timing>"#), "{out}");
        assert!(out.contains(r#"presetClass="mediacall""#), "{out}");
        assert!(
            out.contains(r#"<p:spTgt spid="9"/></p:tgtEl></p:cBhvr>"#),
            "{out}"
        );
        assert!(out.contains(r#"evt="onBegin""#), "{out}");
        crate::slide::check_well_formed(&out).expect("well formed");
    }

    #[test]
    fn the_trim_is_patched_and_bookmarks_stay() {
        let pic = r#"<p:pic><p14:media xmlns:p14="x" r:embed="rId2"><p14:trim st="10"/><p14:bmkLst><p14:bmk name="a" time="5"/></p14:bmkLst></p14:media></p:pic>"#;
        let out = patch_p14(pic, &movie());
        assert!(out.contains(r#"<p14:trim st="250"/>"#), "{out}");
        assert!(out.contains("bmkLst"), "{out}");
        assert!(!out.contains(r#"st="10""#), "{out}");
    }
}
