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

//! Engine ADR 1057 — a theme in an IDML document.
//!
//! InDesign has no theme: its swatches are plain values and its styles name
//! one face. [`flatten_theme_for_interchange`] therefore leaves the swatches
//! and styles as they are (a following swatch already holds its resolved
//! colour) and writes the theme, which swatches follow which slot and which
//! styles follow which font into one document label, [`THEME_LABEL`], that
//! InDesign keeps through an open and a save and does not read.
//! [`restore_theme_from_labels`] undoes it on reopen: a link whose swatch
//! (or style face) still has the value recorded is restored; one that
//! changed outside paged is dropped and reported.

use paged_model::{ColorSpace, Theme, ThemeFontRef, ThemeRef};
use paged_scene::Document;
use serde::{Deserialize, Serialize};

/// The document label that carries the theme through IDML.
pub const THEME_LABEL: &str = "x-paged:core.theme";

/// The label's format version.
const VERSION: u32 = 1;

/// A theme source part over this many bytes is not written into the label.
pub const MAX_SOURCE_BYTES: usize = 64 * 1024;

#[derive(Debug, Serialize, Deserialize)]
struct Link {
    swatch: String,
    #[serde(rename = "ref")]
    reference: String,
    value: String,
    space: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct FontLink {
    style: String,
    kind: String,
    which: String,
    font: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Payload {
    v: u32,
    theme: Theme,
    #[serde(default)]
    links: Vec<Link>,
    #[serde(default)]
    fonts: Vec<FontLink>,
}

fn ref_text(r: &ThemeRef) -> String {
    let mut out = r.slot.clone();
    for (n, v) in &r.transforms {
        out.push_str(&format!(" {n}{v}"));
    }
    out
}

fn parse_ref(text: &str) -> Option<ThemeRef> {
    let mut parts = text.split(' ');
    let slot = parts.next()?.to_string();
    let mut transforms = Vec::new();
    for p in parts {
        let at = p.find(|c: char| c == '-' || c.is_ascii_digit())?;
        transforms.push((p[..at].to_string(), p[at..].parse().ok()?));
    }
    Some(ThemeRef { slot, transforms })
}

fn hex(v: &[f32]) -> Option<String> {
    if v.len() < 3 {
        return None;
    }
    let b = |x: f32| x.round().clamp(0.0, 255.0) as u8;
    Some(format!("{:02X}{:02X}{:02X}", b(v[0]), b(v[1]), b(v[2])))
}

/// Write `doc`'s theme into [`THEME_LABEL`] (the IDML export runs this on its
/// copy). Returns the lines for the export's loss report; empty without a
/// theme, which leaves the document untouched.
pub fn flatten_theme_for_interchange(doc: &mut Document) -> Vec<String> {
    let Some(theme) = doc.theme.clone() else {
        return Vec::new();
    };
    let mut lines = Vec::new();
    let mut theme = theme;
    if theme
        .source
        .as_ref()
        .is_some_and(|s| s.data.len() > MAX_SOURCE_BYTES)
    {
        theme.source = None;
        lines.push(
            "the theme's original part is over 64 KiB and is not kept in the IDML (the format \
             scheme it holds is lost on a round trip through IDML)"
                .to_string(),
        );
    }
    let mut links = Vec::new();
    let mut unlinked = 0usize;
    for c in doc.palette.colors.values() {
        let Some(r) = &c.theme_ref else {
            continue;
        };
        let value = if c.space == ColorSpace::Rgb {
            hex(&c.value)
        } else {
            None
        };
        match value {
            Some(value) => links.push(Link {
                swatch: c.name.clone().unwrap_or_else(|| c.self_id.clone()),
                reference: ref_text(r),
                value,
                space: "RGB".into(),
            }),
            None => unlinked += 1,
        }
    }
    let mut fonts = Vec::new();
    let styles = doc
        .styles
        .paragraph_styles
        .values()
        .map(|d| ("paragraph", &d.self_id, &d.name, &d.font, d.font_ref))
        .chain(
            doc.styles
                .character_styles
                .values()
                .map(|d| ("character", &d.self_id, &d.name, &d.font, d.font_ref)),
        );
    for (kind, id, name, font, r) in styles {
        if let (Some(r), Some(font)) = (r, font) {
            fonts.push(FontLink {
                style: name.clone().unwrap_or_else(|| id.clone()),
                kind: kind.into(),
                which: r.as_str().into(),
                font: font.clone(),
            });
        }
    }
    let n_links = links.len();
    let n_fonts = fonts.len();
    let payload = Payload {
        v: VERSION,
        theme,
        links,
        fonts,
    };
    doc.designmap.labels.retain(|(k, _)| k != THEME_LABEL);
    doc.designmap.labels.push((
        THEME_LABEL.to_string(),
        serde_json::to_string(&payload).unwrap_or_default(),
    ));
    lines.push(format!(
        "theme \"{}\" is written as plain swatches — IDML has no theme; the link of {n_links} \
         swatch(es) and {n_fonts} style(s) to it is kept in the document label {THEME_LABEL} \
         and comes back when paged reopens the file",
        payload_name(&doc.theme)
    ));
    if unlinked > 0 {
        lines.push(format!(
            "{unlinked} swatch(es) follow a theme slot but are not plain RGB; IDML cannot keep \
             that link"
        ));
    }
    lines.sort();
    lines
}

fn payload_name(t: &Option<Theme>) -> String {
    t.as_ref().map(|t| t.name.clone()).unwrap_or_default()
}

/// The inverse of [`flatten_theme_for_interchange`] on an opened IDML: the
/// theme comes back from [`THEME_LABEL`] (which is removed), with the links
/// that still hold. Returns one note per link that does not (edited, renamed
/// or deleted outside paged) and for a label that cannot be read.
pub fn restore_theme_from_labels(doc: &mut Document) -> Vec<String> {
    let Some(pos) = doc
        .designmap
        .labels
        .iter()
        .position(|(k, _)| k == THEME_LABEL)
    else {
        return Vec::new();
    };
    let (_, json) = doc.designmap.labels.remove(pos);
    if doc.theme.is_some() {
        return Vec::new();
    }
    let payload: Payload = match serde_json::from_str(&json) {
        Ok(p) => p,
        Err(e) => return vec![format!("the theme label could not be read ({e}); ignored")],
    };
    if payload.v != VERSION {
        return vec![format!(
            "the theme label is of format version {} (this paged reads {VERSION}); ignored",
            payload.v
        )];
    }
    let mut notes = Vec::new();
    for l in &payload.links {
        let found = doc
            .palette
            .colors
            .iter_mut()
            .find(|(id, c)| c.name.as_deref() == Some(l.swatch.as_str()) || **id == l.swatch);
        let Some((_, c)) = found else {
            notes.push(format!(
                "swatch \"{}\" followed theme slot `{}` but is gone (renamed or deleted outside \
                 paged); its link is dropped",
                l.swatch, l.reference
            ));
            continue;
        };
        let same = c.space == ColorSpace::Rgb && hex(&c.value).as_deref() == Some(&l.value);
        match (same, parse_ref(&l.reference)) {
            (true, Some(r)) => c.theme_ref = Some(r),
            _ => notes.push(format!(
                "swatch \"{}\" was edited outside paged; its link to theme slot `{}` is dropped",
                l.swatch, l.reference
            )),
        }
    }
    for f in &payload.fonts {
        let Some(which) = ThemeFontRef::parse(&f.which) else {
            continue;
        };
        let (font, font_ref) = match f.kind.as_str() {
            "paragraph" => doc
                .styles
                .paragraph_styles
                .iter_mut()
                .find(|(id, d)| d.name.as_deref() == Some(f.style.as_str()) || **id == f.style)
                .map(|(_, d)| (&d.font, &mut d.font_ref))
                .unzip(),
            _ => doc
                .styles
                .character_styles
                .iter_mut()
                .find(|(id, d)| d.name.as_deref() == Some(f.style.as_str()) || **id == f.style)
                .map(|(_, d)| (&d.font, &mut d.font_ref))
                .unzip(),
        };
        match (font, font_ref) {
            (Some(font), Some(font_ref)) if font.as_deref() == Some(f.font.as_str()) => {
                *font_ref = Some(which);
            }
            (Some(_), Some(_)) => notes.push(format!(
                "style \"{}\" followed the theme's {} font but its face was changed outside \
                 paged; its link is dropped",
                f.style, f.which
            )),
            _ => notes.push(format!(
                "style \"{}\" followed the theme's {} font but is gone; its link is dropped",
                f.style, f.which
            )),
        }
    }
    doc.theme = Some(payload.theme);
    notes
}

#[cfg(test)]
mod tests {
    use super::*;
    use paged_model::{CharacterStyleDef, ColorEntry, ColorModel, ThemeColor};

    fn doc() -> Document {
        let mut d = Document {
            theme: Some(Theme {
                name: "Mine".into(),
                colors: vec![ThemeColor {
                    slot: "accent1".into(),
                    value: "156082".into(),
                    system: None,
                }],
                ..Theme::default()
            }),
            ..Document::default()
        };
        d.palette.colors.insert(
            "Color/Brand".into(),
            ColorEntry {
                self_id: "Color/Brand".into(),
                name: Some("Brand".into()),
                space: ColorSpace::Rgb,
                value: vec![21.0, 96.0, 130.0],
                model: ColorModel::Process,
                alternate_space: None,
                alternate_value: Vec::new(),
                tint: None,
                alpha: None,
                theme_ref: Some(ThemeRef {
                    slot: "accent1".into(),
                    transforms: vec![("lumMod".into(), 60_000), ("lumOff".into(), 40_000)],
                }),
            },
        );
        d.styles.character_styles.insert(
            "CharacterStyle/Head".into(),
            CharacterStyleDef {
                self_id: "CharacterStyle/Head".into(),
                name: Some("Head".into()),
                font: Some("Georgia".into()),
                font_ref: Some(ThemeFontRef::Major),
                ..Default::default()
            },
        );
        d
    }

    #[test]
    fn a_document_without_a_theme_gets_no_label() {
        let mut d = Document::default();
        assert!(flatten_theme_for_interchange(&mut d).is_empty());
        assert!(d.designmap.labels.is_empty());
        assert!(restore_theme_from_labels(&mut d).is_empty());
    }

    #[test]
    fn the_theme_and_its_links_round_trip_through_the_label() {
        let mut written = doc();
        let lines = flatten_theme_for_interchange(&mut written);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("1 swatch(es) and 1 style(s)"));
        // A reopened IDML has the swatches and styles, without the model's
        // references.
        let mut back = Document::default();
        back.designmap.labels = written.designmap.labels.clone();
        back.palette = written.palette.clone();
        back.styles = written.styles.clone();
        back.palette
            .colors
            .get_mut("Color/Brand")
            .unwrap()
            .theme_ref = None;
        back.styles
            .character_styles
            .get_mut("CharacterStyle/Head")
            .unwrap()
            .font_ref = None;
        let notes = restore_theme_from_labels(&mut back);
        assert!(notes.is_empty(), "{notes:?}");
        assert_eq!(back.theme.as_ref().unwrap().name, "Mine");
        assert!(back.designmap.labels.is_empty());
        assert_eq!(
            back.palette.colors["Color/Brand"].theme_ref,
            doc().palette.colors["Color/Brand"].theme_ref
        );
        assert_eq!(
            back.styles.character_styles["CharacterStyle/Head"].font_ref,
            Some(ThemeFontRef::Major)
        );
    }

    #[test]
    fn a_swatch_or_face_edited_outside_paged_is_detached_and_reported() {
        let mut written = doc();
        flatten_theme_for_interchange(&mut written);
        let mut back = Document::default();
        back.designmap.labels = written.designmap.labels.clone();
        back.palette = written.palette.clone();
        back.styles = written.styles.clone();
        back.palette
            .colors
            .get_mut("Color/Brand")
            .unwrap()
            .theme_ref = None;
        back.styles
            .character_styles
            .get_mut("CharacterStyle/Head")
            .unwrap()
            .font_ref = None;
        back.palette.colors.get_mut("Color/Brand").unwrap().value = vec![1.0, 2.0, 3.0];
        back.styles
            .character_styles
            .get_mut("CharacterStyle/Head")
            .unwrap()
            .font = Some("Verdana".into());
        let notes = restore_theme_from_labels(&mut back);
        assert_eq!(notes.len(), 2, "{notes:?}");
        assert!(notes[0].contains("edited outside paged"));
        assert!(back.theme.is_some());
        assert!(back.palette.colors["Color/Brand"].theme_ref.is_none());
        assert!(back.styles.character_styles["CharacterStyle/Head"]
            .font_ref
            .is_none());
        // A deleted swatch is reported as gone.
        let mut gone = Document::default();
        gone.designmap.labels = written.designmap.labels.clone();
        let notes = restore_theme_from_labels(&mut gone);
        assert!(notes.iter().any(|n| n.contains("is gone")));
    }

    #[test]
    fn an_unreadable_or_newer_label_is_ignored_with_a_note() {
        let mut d = Document::default();
        d.designmap.labels.push((THEME_LABEL.into(), "{".into()));
        assert_eq!(restore_theme_from_labels(&mut d).len(), 1);
        assert!(d.theme.is_none());
        d.designmap.labels.push((
            THEME_LABEL.into(),
            r#"{"v":9,"theme":{"name":"x","colors":[]}}"#.into(),
        ));
        assert_eq!(restore_theme_from_labels(&mut d).len(), 1);
        assert!(d.theme.is_none());
    }

    #[test]
    fn ref_text_parses_back() {
        let r = ThemeRef {
            slot: "accent1".into(),
            transforms: vec![("lumMod".into(), 60_000), ("lumOff".into(), -5)],
        };
        assert_eq!(parse_ref(&ref_text(&r)), Some(r));
    }
}
