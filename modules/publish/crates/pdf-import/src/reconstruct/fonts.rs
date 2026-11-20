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

//! The fonts the document will be set in, as far as the structure reader
//! needs them: each face's advance widths, so a style's tracking can make
//! a substitute face set the PDF's lines at the PDF's widths (the metric
//! fit), and its character coverage.
//!
//! A family is one upright file and, optionally, one italic file — the
//! shape the engine's font registry takes (`font_registry_from_paths`):
//! a variable face answers for every weight through its named instances
//! or its `wght` axis.

use skrifa::instance::{Location, Size};
use skrifa::raw::TableProvider;
use skrifa::string::StringId;
use skrifa::{FontRef, MetadataProvider};

/// One font file the book holds.
struct Face {
    family: String,
    italic: bool,
    data: Vec<u8>,
}

/// The faces the document is set in.
#[derive(Default)]
pub struct FontBook {
    faces: Vec<Face>,
}

/// One face at one style: the advance of a character in ems.
pub struct Metrics {
    advances: std::collections::HashMap<char, f32>,
    /// The family has no glyph for these.
    pub missing: std::collections::BTreeSet<char>,
}

impl Metrics {
    /// The advance of `ch` in ems, `None` when the face lacks it.
    pub fn advance(&self, ch: char) -> Option<f32> {
        self.advances.get(&ch).copied()
    }
}

impl FontBook {
    /// The faces in `files` (font bytes); anything that is not a font, or
    /// names no family, is skipped.
    pub fn from_bytes(files: Vec<Vec<u8>>) -> FontBook {
        let mut faces = Vec::new();
        for data in files {
            let Ok(font) = FontRef::new(&data) else {
                continue;
            };
            let family = name(&font, StringId::TYPOGRAPHIC_FAMILY_NAME)
                .or_else(|| name(&font, StringId::FAMILY_NAME));
            let Some(family) = family else { continue };
            let sub = name(&font, StringId::TYPOGRAPHIC_SUBFAMILY_NAME)
                .or_else(|| name(&font, StringId::SUBFAMILY_NAME))
                .unwrap_or_default();
            let italic = sub.to_ascii_lowercase().contains("italic")
                || sub.to_ascii_lowercase().contains("oblique");
            faces.push(Face {
                family,
                italic,
                data,
            });
        }
        FontBook { faces }
    }

    /// The faces in the font files under `dirs` (one level deep).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn load(dirs: &[std::path::PathBuf]) -> FontBook {
        let mut files = Vec::new();
        for d in dirs {
            let mut paths: Vec<std::path::PathBuf> = if d.is_dir() {
                std::fs::read_dir(d)
                    .map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())).collect())
                    .unwrap_or_default()
            } else {
                vec![d.clone()]
            };
            paths.sort();
            for p in paths {
                let ext = p
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if matches!(ext.as_str(), "ttf" | "otf") {
                    if let Ok(b) = std::fs::read(&p) {
                        files.push(b);
                    }
                }
            }
        }
        FontBook::from_bytes(files)
    }

    /// The families with a glyph for `ch`, sorted.
    pub fn families_with(&self, ch: char) -> Vec<String> {
        let mut out: Vec<String> = self
            .faces
            .iter()
            .filter(|f| FontRef::new(&f.data).is_ok_and(|font| font.charmap().map(ch).is_some()))
            .map(|f| f.family.clone())
            .collect();
        out.sort();
        out.dedup();
        out
    }

    pub fn has_family(&self, family: &str) -> bool {
        self.faces
            .iter()
            .any(|f| f.family.eq_ignore_ascii_case(family))
    }

    /// `family` at `style` (`"Bold Italic"`, `"Light"`, …), measured over
    /// `chars`.
    pub fn metrics(
        &self,
        family: &str,
        style: &str,
        chars: impl IntoIterator<Item = char>,
    ) -> Option<Metrics> {
        let want_italic = {
            let s = style.to_ascii_lowercase();
            s.contains("italic") || s.contains("oblique")
        };
        let face = self
            .faces
            .iter()
            .filter(|f| f.family.eq_ignore_ascii_case(family))
            .min_by_key(|f| (f.italic != want_italic) as u8)?;
        let font = FontRef::new(&face.data).ok()?;
        let location = location_for(&font, style);
        let upem = font.head().ok()?.units_per_em() as f32;
        let gm = font.glyph_metrics(Size::unscaled(), &location);
        let cmap = font.charmap();
        let mut advances = std::collections::HashMap::new();
        let mut missing = std::collections::BTreeSet::new();
        for ch in chars {
            if advances.contains_key(&ch) || missing.contains(&ch) {
                continue;
            }
            match cmap.map(ch) {
                Some(gid) => {
                    let a = gm.advance_width(gid).unwrap_or(0.0) / upem;
                    advances.insert(ch, a);
                }
                None => {
                    if !ch.is_control() {
                        missing.insert(ch);
                    }
                }
            }
        }
        Some(Metrics { advances, missing })
    }
}

fn name(font: &FontRef<'_>, id: StringId) -> Option<String> {
    font.localized_strings(id)
        .english_or_first()
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
}

/// The weight a style name says: `"Semibold Italic"` → 600.
pub fn weight_of(style: &str) -> f32 {
    let s = style.to_ascii_lowercase().replace([' ', '-', '_'], "");
    let table: [(&str, f32); 14] = [
        ("hairline", 100.0),
        ("thin", 100.0),
        ("extralight", 200.0),
        ("ultralight", 200.0),
        ("light", 300.0),
        ("book", 400.0),
        ("medium", 500.0),
        ("semibold", 600.0),
        ("demibold", 600.0),
        ("extrabold", 800.0),
        ("ultrabold", 800.0),
        ("bold", 700.0),
        ("black", 900.0),
        ("heavy", 900.0),
    ];
    for (k, w) in table {
        if s.contains(k) {
            return w;
        }
    }
    400.0
}

/// The design-space location `style` names on a variable face: a named
/// instance whose subfamily is the style, else the `wght` axis at the
/// style's weight. A static face has no axes and the default location.
fn location_for(font: &FontRef<'_>, style: &str) -> Location {
    let axes = font.axes();
    if axes.is_empty() {
        return Location::default();
    }
    for inst in font.named_instances().iter() {
        let sub = font
            .localized_strings(inst.subfamily_name_id())
            .english_or_first()
            .map(|s| s.to_string())
            .unwrap_or_default();
        if sub.eq_ignore_ascii_case(style) {
            return inst.location();
        }
    }
    axes.location([("wght", weight_of(style))])
}
