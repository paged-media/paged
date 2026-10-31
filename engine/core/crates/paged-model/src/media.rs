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

//! Engine ADR 1027 — movie and sound items.
//!
//! A movie or a sound is a frame that names a medium: a rectangle whose
//! placed picture is the poster (what print, PDF, thumbnails and the
//! canvas show) and whose [`MediaItem`] says where the medium is and how it
//! plays. InDesign's `<Movie>` and `<Sound>` and PowerPoint's video and
//! audio pictures are both this shape.
//!
//! The engine never plays a medium. It draws the poster, keeps the
//! description, carries it on the wire and through `.paged`, and writes it
//! into IDML as a label ([`MEDIA_LABEL`]) the import reads back. A host
//! that presents the document (a slide show) reads the description and the
//! medium's bytes and plays it in its own media element over the frame.
//!
//! The medium itself is not in the model: it is either a link (a URL) or a
//! part of the document's container (`paged/…`), which travels with the
//! `.paged` file as every other part does, so a slide duplicated with its
//! movie shares the part and an edit to the frame never copies the bytes.

use serde::{Deserialize, Serialize};

/// The `<KeyValuePair>` label key an IDML export writes a frame's medium
/// under (its JSON form), and the import reads it back from.
pub const MEDIA_LABEL: &str = "paged:media";

/// The container folder the engine's own media parts live in: any caller
/// may add a part here, none may change one (engine ADR 1027).
pub const MEDIA_PART_PREFIX: &str = "paged/core/media/";

/// Whether the medium has pictures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wire", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wire", tsify(into_wasm_abi, from_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    /// A video (InDesign's `<Movie>`, PowerPoint's `a:videoFile`).
    #[default]
    Movie,
    /// Audio only (InDesign's `<Sound>`, PowerPoint's `a:audioFile`).
    Sound,
}

/// Where the medium's bytes are.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "wire", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wire", tsify(into_wasm_abi, from_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MediaSource {
    /// A part of the document's container, by its full path (`paged/…`):
    /// it travels with the `.paged` file.
    Part { path: String },
    /// A URL outside the document (PowerPoint's linked media, InDesign's
    /// movie link).
    Link { uri: String },
}

/// When the medium starts in a presentation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "wire", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wire", tsify(into_wasm_abi, from_wasm_abi))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum MediaPlay {
    /// When it is clicked, or on the click of the slide's sequence that
    /// plays it (PowerPoint's "On Click", InDesign's default).
    #[default]
    OnClick,
    /// As soon as its page is shown (PowerPoint's "Automatically",
    /// InDesign's `PlayOnPageTurn`).
    Auto,
}

fn one() -> f32 {
    1.0
}

fn is_one(v: &f32) -> bool {
    *v == 1.0
}

fn is_zero(v: &u32) -> bool {
    *v == 0
}

fn is_false(v: &bool) -> bool {
    !*v
}

/// A frame's medium and how it plays (engine ADR 1027). Times are in
/// milliseconds of the medium's own timeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "wire", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wire", tsify(into_wasm_abi, from_wasm_abi, missing_as_null))]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    /// Movie or sound.
    #[serde(default)]
    pub kind: MediaKind,
    /// Where the bytes are.
    pub source: MediaSource,
    /// The medium's type (`video/mp4`, `audio/mpeg`, …), when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    /// The medium's file name, as the user or the source document named it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The medium's length, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u32>,
    /// Trimmed off the start: playing starts here.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub trim_start_ms: u32,
    /// Trimmed off the end: playing stops this long before the end.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub trim_end_ms: u32,
    /// Fade in from silence over this long (PowerPoint's `p14:fade`).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub fade_in_ms: u32,
    /// Fade out to silence over this long.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub fade_out_ms: u32,
    /// When it starts.
    #[serde(default)]
    pub play: MediaPlay,
    /// Plays again from the start until it is stopped.
    #[serde(default, rename = "loop", skip_serializing_if = "is_false")]
    pub looped: bool,
    /// Its volume, 0 (muted) to 1 (as recorded).
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub volume: f32,
    /// The frame is not shown in a presentation while the medium is not
    /// playing (PowerPoint's "Hide While Not Playing"). Print and PDF show
    /// the poster all the same.
    #[serde(default, skip_serializing_if = "is_false")]
    pub hide_while_not_playing: bool,
    /// Goes back to its first frame once it has played.
    #[serde(default, skip_serializing_if = "is_false")]
    pub rewind: bool,
    /// Plays filling the screen.
    #[serde(default, skip_serializing_if = "is_false")]
    pub full_screen: bool,
    /// Shows the player's controls while it plays.
    #[serde(default, skip_serializing_if = "is_false")]
    pub show_controls: bool,
}

/// The longest trim or fade the engine keeps: a day.
const MAX_MS: u32 = 24 * 60 * 60 * 1000;

impl MediaItem {
    /// A medium of `kind` at `source`, playing on click at full volume.
    pub fn new(kind: MediaKind, source: MediaSource) -> Self {
        MediaItem {
            kind,
            source,
            mime: None,
            name: None,
            duration_ms: None,
            trim_start_ms: 0,
            trim_end_ms: 0,
            fade_in_ms: 0,
            fade_out_ms: 0,
            play: MediaPlay::OnClick,
            looped: false,
            volume: 1.0,
            hide_while_not_playing: false,
            rewind: false,
            full_screen: false,
            show_controls: false,
        }
    }

    /// Whether every value is in range: a part path under `paged/` without
    /// `..`, a link that is not empty, a volume in 0..=1, trims and fades
    /// up to a day, short names. The wire refuses a medium that is not.
    pub fn is_valid(&self) -> bool {
        let source_ok = match &self.source {
            MediaSource::Part { path } => {
                path.starts_with("paged/")
                    && !path.split('/').any(|s| s == ".." || s.is_empty())
                    && path.len() <= 512
            }
            MediaSource::Link { uri } => !uri.trim().is_empty() && uri.len() <= 4096,
        };
        let short = |s: &Option<String>| s.as_ref().is_none_or(|s| s.len() <= 512);
        source_ok
            && short(&self.mime)
            && short(&self.name)
            && self.volume.is_finite()
            && (0.0..=1.0).contains(&self.volume)
            && [
                self.trim_start_ms,
                self.trim_end_ms,
                self.fade_in_ms,
                self.fade_out_ms,
            ]
            .iter()
            .all(|&t| t <= MAX_MS)
    }

    /// The JSON form the IDML label and the wire carry.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// Reads a medium from its JSON form; `None` for text that is not one
    /// or is out of range.
    pub fn from_json(text: &str) -> Option<Self> {
        let m: MediaItem = serde_json::from_str(text).ok()?;
        m.is_valid().then_some(m)
    }

    /// The container part this medium's bytes are in, if it is a part.
    pub fn part(&self) -> Option<&str> {
        match &self.source {
            MediaSource::Part { path } => Some(path),
            MediaSource::Link { .. } => None,
        }
    }
}

/// The file extension a part of media type `mime` is named with (`mp4`
/// for an unknown video, `m4a` for an unknown sound).
pub fn extension_for(mime: &str, kind: MediaKind) -> &'static str {
    match mime.to_ascii_lowercase().as_str() {
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "video/ogg" => "ogv",
        "video/x-msvideo" | "video/avi" => "avi",
        "video/x-ms-wmv" => "wmv",
        "video/x-m4v" => "m4v",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/mp4" | "audio/x-m4a" | "audio/m4a" => "m4a",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        "audio/ogg" => "ogg",
        "audio/webm" => "weba",
        "audio/aac" => "aac",
        "audio/flac" | "audio/x-flac" => "flac",
        "audio/x-ms-wma" => "wma",
        _ => match kind {
            MediaKind::Movie => "mp4",
            MediaKind::Sound => "m4a",
        },
    }
}

/// Every rectangle of `spread` that names a medium, as `(Self, medium)`.
fn media(spread: &crate::Spread) -> Vec<(&str, &MediaItem)> {
    spread
        .rectangles
        .iter()
        .filter_map(|r| Some((r.self_id.as_deref()?, r.media.as_ref()?)))
        .collect()
}

/// Whether any frame of `spread` names a medium.
pub fn has_any(spread: &crate::Spread) -> bool {
    spread.rectangles.iter().any(|r| r.media.is_some())
}

/// IDML export: writes each frame's medium into the spread's label side
/// map under [`MEDIA_LABEL`] (and drops a stale key from a frame without
/// one), so a paged → IDML → paged round trip keeps it. Returns whether
/// the spread names any medium.
pub fn write_labels(spread: &mut crate::Spread) -> bool {
    let entries: Vec<(String, String)> = media(spread)
        .into_iter()
        .map(|(id, m)| (id.to_string(), m.to_json()))
        .collect();
    for labels in spread.labels.values_mut() {
        labels.retain(|(k, _)| k != MEDIA_LABEL);
    }
    spread.labels.retain(|_, v| !v.is_empty());
    let any = !entries.is_empty();
    for (id, json) in entries {
        spread
            .labels
            .entry(id)
            .or_default()
            .push((MEDIA_LABEL.to_string(), json));
    }
    any
}

/// IDML import: moves each rectangle's [`MEDIA_LABEL`] off the label side
/// map onto the frame. A label that does not read as a medium stays where
/// it is, an ordinary label.
pub fn adopt_labels(spread: &mut crate::Spread) {
    if spread.labels.is_empty() {
        return;
    }
    for r in &mut spread.rectangles {
        let Some(labels) = r
            .self_id
            .as_deref()
            .and_then(|id| spread.labels.get_mut(id))
        else {
            continue;
        };
        let Some(i) = labels.iter().position(|(k, _)| k == MEDIA_LABEL) else {
            continue;
        };
        if let Some(m) = MediaItem::from_json(&labels[i].1) {
            r.media = Some(m);
            labels.remove(i);
        }
    }
    spread.labels.retain(|_, v| !v.is_empty());
}

#[cfg(test)]
#[allow(non_snake_case)] // `__feat__` suffixes link the cockpit feature row.
mod tests {
    use super::*;
    use crate::{Bounds, Rectangle, Spread};

    fn movie() -> MediaItem {
        MediaItem {
            mime: Some("video/mp4".into()),
            trim_start_ms: 1500,
            looped: true,
            volume: 0.5,
            play: MediaPlay::Auto,
            ..MediaItem::new(
                MediaKind::Movie,
                MediaSource::Part {
                    path: "paged/core/media/abc.mp4".into(),
                },
            )
        }
    }

    #[test]
    fn a_medium_round_trips_through_its_json__feat__plugin_slide_media() {
        let m = movie();
        let json = m.to_json();
        assert!(json.contains(r#""loop":true"#), "{json}");
        assert!(json.contains(r#""type":"part""#), "{json}");
        assert!(json.contains(r#""play":"auto""#), "{json}");
        assert!(!json.contains("rewind"), "defaults are left out: {json}");
        assert_eq!(MediaItem::from_json(&json), Some(m));
        // The smallest form reads with every default.
        let min = MediaItem::from_json(r#"{"source":{"type":"link","uri":"https://x/y.mp3"}}"#)
            .expect("minimal");
        assert_eq!(min.kind, MediaKind::Movie);
        assert_eq!(min.volume, 1.0);
        assert_eq!(min.play, MediaPlay::OnClick);
    }

    #[test]
    fn a_medium_out_of_range_is_refused__feat__plugin_slide_media() {
        let bad = |f: &dyn Fn(&mut MediaItem)| {
            let mut m = movie();
            f(&mut m);
            !m.is_valid()
        };
        assert!(bad(&|m| m.volume = 1.5));
        assert!(bad(&|m| m.volume = f32::NAN));
        assert!(bad(&|m| m.trim_end_ms = MAX_MS + 1));
        assert!(bad(&|m| m.source = MediaSource::Part {
            path: "Spreads/x.xml".into()
        }));
        assert!(bad(&|m| m.source = MediaSource::Part {
            path: "paged/../designmap.xml".into()
        }));
        assert!(bad(&|m| m.source = MediaSource::Link { uri: " ".into() }));
        assert!(movie().is_valid());
    }

    #[test]
    fn the_label_carries_the_medium_through_idml__feat__plugin_slide_media() {
        let mut spread = Spread::default();
        let mut r = Rectangle::new("r1", Bounds::ZERO);
        r.media = Some(movie());
        spread.rectangles.push(r);
        spread.rectangles.push(Rectangle::new("r2", Bounds::ZERO));
        spread
            .labels
            .insert("r2".into(), vec![("other".into(), "x".into())]);
        assert!(write_labels(&mut spread));
        assert_eq!(spread.labels["r1"][0].0, MEDIA_LABEL);
        spread.rectangles[0].media = None;
        adopt_labels(&mut spread);
        assert_eq!(spread.rectangles[0].media, Some(movie()));
        assert!(
            !spread.labels.contains_key("r1"),
            "the label is the frame's now"
        );
        assert_eq!(spread.labels["r2"].len(), 1, "others stay");
        // A frame that lost its medium drops a stale label.
        spread.rectangles[0].media = None;
        spread
            .labels
            .insert("r1".into(), vec![(MEDIA_LABEL.into(), movie().to_json())]);
        assert!(!write_labels(&mut spread));
        assert!(!spread.labels.contains_key("r1"));
    }

    #[test]
    fn a_part_is_named_by_its_type__feat__plugin_slide_media() {
        assert_eq!(extension_for("video/mp4", MediaKind::Movie), "mp4");
        assert_eq!(extension_for("audio/mpeg", MediaKind::Sound), "mp3");
        assert_eq!(extension_for("application/x-what", MediaKind::Sound), "m4a");
    }
}
