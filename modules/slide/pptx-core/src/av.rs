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

//! Video and audio on a slide (slide ADR 718): how a slide's timing plays
//! each medium.
//!
//! PowerPoint plays a video or audio picture through two kinds of time
//! nodes. A `p:video` / `p:audio` node (kept as XML by the timing model)
//! holds the medium's volume (`p:cMediaNode vol`, 1 000ths of a percent),
//! mute, "Hide While Not Playing" (`display="0"` on its `p:cTn`), "Loop
//! until Stopped" (`repeatCount="indefinite"`) and full screen
//! (`fullScrn`). A `p:cmd type="call" cmd="playFrom(…)"` behaviour in an
//! effect of preset class `mediacall` starts it: in the main sequence (on
//! the slide's start or on a click) or in an interactive sequence (a
//! trigger, a click on a shape).

use std::collections::BTreeMap;

use crate::anim::{CondTarget, Condition, TargetEl, TimeNode, Timing};

/// When a slide's timing starts a medium.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaStart {
    /// With the slide (the main sequence's first group, before any click).
    Auto,
    /// On a click of the main sequence.
    OnClick,
    /// When a shape is clicked (an interactive sequence).
    Trigger,
}

/// What a slide's timing says about one medium.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MediaTiming {
    /// 0–1; `None` when the timing does not say.
    pub volume: Option<f64>,
    pub muted: bool,
    pub hide_while_not_playing: bool,
    pub looped: bool,
    pub full_screen: bool,
    /// How a `playFrom` starts it; `None` when nothing does.
    pub start: Option<MediaStart>,
}

const NS: &str = r#"xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main""#;

/// Every medium `timing` plays, by the deck's `spid`.
pub fn media_timing(timing: &Timing) -> BTreeMap<String, MediaTiming> {
    let mut out: BTreeMap<String, MediaTiming> = BTreeMap::new();
    for root in &timing.nodes {
        root.walk(&mut |n| {
            if let TimeNode::Raw { xml } = n {
                if let Some((spid, m)) = media_node(xml) {
                    let e = out.entry(spid).or_default();
                    e.volume = m.volume;
                    e.muted = m.muted;
                    e.hide_while_not_playing = m.hide_while_not_playing;
                    e.looped = m.looped;
                    e.full_screen = m.full_screen;
                }
            }
        });
        walk_starts(root, None, false, &mut out);
    }
    out
}

/// The `playFrom` commands under `n`: `seq` names the sequence they are
/// in (`mainSeq` / `interactiveSeq`), `clicked` whether the main
/// sequence's group they are in starts on a click.
fn walk_starts(
    n: &TimeNode,
    seq: Option<&str>,
    clicked: bool,
    out: &mut BTreeMap<String, MediaTiming>,
) {
    if let TimeNode::Cmd { bhvr, cmd, .. } = n {
        let plays = cmd.as_deref().is_some_and(|c| c.starts_with("playFrom"));
        if let (true, TargetEl::Sp(t)) = (plays, &bhvr.target) {
            let start = match seq {
                Some("interactiveSeq") => MediaStart::Trigger,
                _ if clicked => MediaStart::OnClick,
                _ => MediaStart::Auto,
            };
            let e = out.entry(t.spid.clone()).or_default();
            // The first that starts it wins (a later `playFrom` is a
            // seek of one already started).
            e.start.get_or_insert(start);
        }
        return;
    }
    let Some(ctn) = n.container_ctn() else {
        return;
    };
    let kind = ctn.node_type.as_deref();
    let seq = match kind {
        Some("mainSeq") | Some("interactiveSeq") => kind,
        _ => seq,
    };
    // A group of the main sequence (a `par` directly under it) starts on
    // a click when its start condition waits (`delay="indefinite"`).
    let main = seq == Some("mainSeq") && matches!(kind, Some("mainSeq"));
    for c in ctn.children.iter().chain(ctn.sub.iter()) {
        let clicked = if main {
            c.container_ctn()
                .is_some_and(|g| waits(g.st_conds.as_deref()))
        } else {
            clicked
        };
        walk_starts(c, seq, clicked, out);
    }
}

/// Whether a main-sequence group waits for a click: an `indefinite` start,
/// and no `onBegin` (PowerPoint's first group that plays with the slide
/// carries both).
fn waits(conds: Option<&[Condition]>) -> bool {
    conds.is_some_and(|cs| {
        cs.iter().any(|c| {
            c.delay.as_deref() == Some("indefinite")
                && c.evt.is_none()
                && !matches!(c.target, Some(CondTarget::El { .. }))
        }) && !cs.iter().any(|c| c.evt.as_deref() == Some("onBegin"))
    })
}

/// A `p:video` / `p:audio` node's medium: `(spid, what it says)`.
fn media_node(xml: &str) -> Option<(String, MediaTiming)> {
    let t = xml.trim_start();
    if !(t.starts_with("<p:video") || t.starts_with("<p:audio")) {
        return None;
    }
    let root = paged_ooxml::tree::parse(format!("<w {NS}>{xml}</w>").as_bytes()).ok()?;
    let node = root.children.first()?;
    let media = node.children.iter().find(|c| c.local == "cMediaNode")?;
    let ctn = media.children.iter().find(|c| c.local == "cTn");
    let spid = media
        .children
        .iter()
        .find(|c| c.local == "tgtEl")?
        .children
        .iter()
        .find(|c| c.local == "spTgt")?
        .attr("spid")?
        .to_string();
    let flag = |v: Option<&str>| matches!(v, Some("1") | Some("true"));
    Some((
        spid,
        MediaTiming {
            volume: media
                .attr("vol")
                .and_then(|v| v.parse::<f64>().ok())
                .map(|v| (v / 100_000.0).clamp(0.0, 1.0)),
            muted: flag(media.attr("mute")),
            hide_while_not_playing: ctn.and_then(|c| c.attr("display")) == Some("0"),
            looped: ctn.and_then(|c| c.attr("repeatCount")) == Some("indefinite"),
            full_screen: flag(node.attr("fullScrn")),
            start: None,
        },
    ))
}

/// The media type of a medium by its file extension (PowerPoint names its
/// media parts `media1.mp4`, `media2.m4a`, …); `None` when unknown.
pub fn mime_for_extension(ext: &str, kind: crate::PicMediaKind) -> Option<&'static str> {
    Some(match ext.to_ascii_lowercase().as_str() {
        "mp4" if kind == crate::PicMediaKind::Audio => "audio/mp4",
        "mp4" | "mpg4" => "video/mp4",
        "m4v" => "video/x-m4v",
        "mov" | "qt" => "video/quicktime",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "wmv" => "video/x-ms-wmv",
        "mpg" | "mpeg" => "video/mpeg",
        "m4a" => "audio/mp4",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "wma" => "audio/x-ms-wma",
        "aac" => "audio/aac",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "aif" | "aiff" => "audio/aiff",
        "mid" | "midi" => "audio/midi",
        _ => return None,
    })
}

/// The file extension a part of media type `mime` is written with.
pub fn extension_for_mime(mime: &str) -> Option<&'static str> {
    Some(match mime.to_ascii_lowercase().as_str() {
        "video/mp4" => "mp4",
        "video/x-m4v" => "m4v",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "video/x-msvideo" => "avi",
        "video/x-ms-wmv" => "wmv",
        "video/mpeg" => "mpg",
        "audio/mp4" | "audio/x-m4a" => "m4a",
        "audio/mpeg" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/x-ms-wma" => "wma",
        "audio/aac" => "aac",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        "audio/aiff" => "aiff",
        "audio/midi" => "mid",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_media_node_says_volume_hide_and_loop() {
        let xml = r#"<p:video fullScrn="1"><p:cMediaNode vol="40000"><p:cTn id="7" repeatCount="indefinite" fill="hold" display="0"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="4"/></p:tgtEl></p:cMediaNode></p:video>"#;
        let (spid, m) = media_node(xml).expect("a media node");
        assert_eq!(spid, "4");
        assert_eq!(m.volume, Some(0.4));
        assert!(m.hide_while_not_playing && m.looped && m.full_screen && !m.muted);
        assert!(media_node("<p:par/>").is_none());
    }
}
