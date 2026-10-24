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

//! # Excel named styles → document styles (sheet ADR 524)
//!
//! A workbook placed in a layout document can take the document's look: the
//! workbook-level "Use document styles" switch and a table from Excel named
//! cell styles (`Normal`, `Heading 1`, `Good`, a custom style, …) to the
//! document's paragraph style, optionally a character style and a cell
//! style. `Normal` maps the cells that name no style.
//!
//! [`apply_doc_map`] folds one cell's mapping into its resolved
//! [`VisualAttrs`] — the one place the page lowering, the live grid and the
//! charts get it from (they all read the same resolved style table). The
//! precedence (highest first):
//!
//! 1. conditional formatting (folded on top later by the styler);
//! 2. direct cell formatting — a document reference of the cell's own
//!    (ADR 518 `doc` fields) disables the mapping for that cell, and a font
//!    facet that differs from the named style's stays an override;
//! 3. the named style's document mapping — its font facets give way to the
//!    paragraph / character style (the workbook's concrete values remain
//!    the xlsx fallback);
//! 4. table style regions (`table_band::under` fills only what is unset,
//!    and leaves a mapped cell's text alone);
//! 5. `Normal`'s mapping (also the fallback of a named style without an
//!    entry, whose own look then stays concrete);
//! 6. Excel's defaults.

use crate::style::VisualAttrs;
use std::collections::{BTreeMap, BTreeSet};

/// The name of the style the un-named cells use.
pub const NORMAL: &str = "Normal";

/// The document styles one Excel named style maps to.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocStyleTarget {
    /// The document paragraph style id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub para: Option<String>,
    /// The document character style id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub char: Option<String>,
    /// The document cell style id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell: Option<String>,
}

impl DocStyleTarget {
    /// True when the target names no document style (an entry to drop).
    pub fn is_empty(&self) -> bool {
        self.para.is_none() && self.char.is_none() && self.cell.is_none()
    }
}

/// The workbook's switch and mapping table, keyed by the Excel style name.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocStyleMap {
    /// "Use document styles".
    pub enabled: bool,
    /// Excel style name → document styles (empty targets are never stored).
    pub entries: BTreeMap<String, DocStyleTarget>,
}

impl DocStyleMap {
    /// The entry for an Excel style name (names compare case-insensitively,
    /// as Excel's do).
    pub fn get(&self, name: &str) -> Option<&DocStyleTarget> {
        self.entries.get(name).or_else(|| {
            self.entries
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v)
        })
    }

    /// Set (or, with an empty target, clear) the entry for `name`, replacing
    /// an entry spelled with different case.
    pub fn set(&mut self, name: &str, target: DocStyleTarget) {
        self.entries.retain(|k, _| !k.eq_ignore_ascii_case(name));
        if !target.is_empty() {
            self.entries.insert(name.to_string(), target);
        }
    }

    /// True when the map changes nothing (off, or on without entries).
    pub fn is_inert(&self) -> bool {
        !self.enabled || self.entries.is_empty()
    }
}

/// Fold a cell's document-style mapping into its resolved attributes.
///
/// `style_name` is the cell's Excel named style (`None` = Normal);
/// `inherited` is that named style's own resolved look — the facets the
/// cell took from it rather than from direct formatting. See the module
/// docs for the precedence.
///
/// `available` is the set of style ids the document has (`None` = not
/// known: every id counts as present). A mapped id the document no longer
/// has is left out, and an entry left with none falls through as if it were
/// absent — the cell then shows the workbook's concrete look.
pub fn apply_doc_map(
    a: &mut VisualAttrs,
    style_name: Option<&str>,
    inherited: Option<&VisualAttrs>,
    map: &DocStyleMap,
    available: Option<&BTreeSet<String>>,
) {
    if map.is_inert() {
        return;
    }
    // A document reference of the cell's own is direct formatting.
    if a.doc_para_style.is_some() || a.doc_char_style.is_some() || a.doc_cell_style.is_some() {
        return;
    }
    let name = style_name.unwrap_or(NORMAL);
    let present = |t: &DocStyleTarget| {
        let keep = |id: &Option<String>| {
            id.clone()
                .filter(|id| available.is_none_or(|set| set.contains(id)))
        };
        let t = DocStyleTarget {
            para: keep(&t.para),
            char: keep(&t.char),
            cell: keep(&t.cell),
        };
        (!t.is_empty()).then_some(t)
    };
    let (target, own) = match map.get(name).and_then(present) {
        Some(t) => (t, true),
        None if !name.eq_ignore_ascii_case(NORMAL) => match map.get(NORMAL).and_then(present) {
            Some(t) => (t, false),
            None => return,
        },
        None => return,
    };
    if own {
        if let Some(inh) = inherited {
            strip_inherited_font(a, inh);
            if target.cell.is_some() {
                strip_inherited_box(a, inh);
            }
        }
        // Above table regions: only a named style's own mapping, never
        // Normal's.
        a.doc_style_mapped = !name.eq_ignore_ascii_case(NORMAL);
    }
    a.doc_para_style = target.para;
    a.doc_char_style = target.char;
    a.doc_cell_style = target.cell;
}

/// Drop the font facets the cell shares with its named style (they give way
/// to the document's paragraph / character style).
fn strip_inherited_font(a: &mut VisualAttrs, inh: &VisualAttrs) {
    if a.bold == inh.bold {
        a.bold = false;
    }
    if a.italic == inh.italic {
        a.italic = false;
    }
    if a.font_size_pt == inh.font_size_pt {
        a.font_size_pt = None;
    }
    if a.font_name == inh.font_name {
        a.font_name = None;
    }
    if a.text_rgb == inh.text_rgb && a.text_swatch == inh.text_swatch {
        a.text_rgb = None;
        a.text_swatch = None;
    }
    if a.underline == inh.underline && a.underline_style == inh.underline_style {
        a.underline = false;
        a.underline_style = None;
    }
    if a.strike == inh.strike {
        a.strike = false;
    }
    if a.vert_align == inh.vert_align {
        a.vert_align = None;
    }
}

/// Drop the fill and borders the cell shares with its named style (a mapped
/// document cell style draws them).
fn strip_inherited_box(a: &mut VisualAttrs, inh: &VisualAttrs) {
    if a.fill_rgb == inh.fill_rgb
        && a.fill_swatch == inh.fill_swatch
        && a.fill_pattern == inh.fill_pattern
        && a.fill_gradient == inh.fill_gradient
    {
        a.fill_rgb = None;
        a.fill_swatch = None;
        a.fill_pattern = None;
        a.fill_gradient = None;
    }
    if a.border_lines == inh.border_lines {
        a.border_lines = Default::default();
        a.border_top = false;
        a.border_right = false;
        a.border_bottom = false;
        a.border_left = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(para: &str) -> DocStyleTarget {
        DocStyleTarget {
            para: Some(para.into()),
            ..Default::default()
        }
    }

    fn map(entries: &[(&str, DocStyleTarget)]) -> DocStyleMap {
        let mut m = DocStyleMap {
            enabled: true,
            ..Default::default()
        };
        for (k, v) in entries {
            m.set(k, v.clone());
        }
        m
    }

    fn heading_look() -> VisualAttrs {
        VisualAttrs {
            bold: true,
            font_size_pt: Some(15.0),
            text_rgb: Some("#44546A".into()),
            border_bottom: true,
            ..Default::default()
        }
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_named_style_mapping_replaces_the_inherited_font__feat__sheet_format_doc_style_map() {
        let mut a = heading_look();
        a.named_style = Some("Heading 1".into());
        let m = map(&[("Heading 1", target("ParagraphStyle/H1"))]);
        apply_doc_map(&mut a, Some("Heading 1"), Some(&heading_look()), &m, None);
        assert_eq!(a.doc_para_style.as_deref(), Some("ParagraphStyle/H1"));
        assert!(!a.bold);
        assert_eq!(a.font_size_pt, None);
        assert_eq!(a.text_rgb, None);
        // No cell style mapped: the box stays the workbook's.
        assert!(a.border_bottom);
        assert!(a.doc_style_mapped);
    }

    #[test]
    fn direct_formatting_beats_the_mapping() {
        // Italic and a red colour the named style does not have: direct.
        let mut a = heading_look();
        a.italic = true;
        a.text_rgb = Some("#FF0000".into());
        let m = map(&[("Heading 1", target("ParagraphStyle/H1"))]);
        apply_doc_map(&mut a, Some("Heading 1"), Some(&heading_look()), &m, None);
        assert!(a.italic);
        assert_eq!(a.text_rgb.as_deref(), Some("#FF0000"));
        assert!(!a.bold, "the inherited bold gives way");
        // A document reference of the cell's own disables the mapping.
        let mut own = heading_look();
        own.doc_para_style = Some("ParagraphStyle/Own".into());
        apply_doc_map(&mut own, Some("Heading 1"), Some(&heading_look()), &m, None);
        assert_eq!(own.doc_para_style.as_deref(), Some("ParagraphStyle/Own"));
        assert!(own.bold);
    }

    #[test]
    fn normal_maps_unnamed_cells_and_unmapped_named_styles() {
        let m = map(&[(NORMAL, target("ParagraphStyle/Body"))]);
        let mut plain = VisualAttrs {
            text_rgb: Some("#000000".into()),
            ..Default::default()
        };
        let normal = plain.clone();
        apply_doc_map(&mut plain, None, Some(&normal), &m, None);
        assert_eq!(plain.doc_para_style.as_deref(), Some("ParagraphStyle/Body"));
        assert_eq!(plain.text_rgb, None, "Normal's own colour gives way");
        assert!(!plain.doc_style_mapped, "Normal sits under table regions");
        // `Good` without an entry: Normal's paragraph, Good's look concrete.
        let good = VisualAttrs {
            fill_rgb: Some("#C6EFCE".into()),
            text_rgb: Some("#006100".into()),
            ..Default::default()
        };
        let mut a = good.clone();
        apply_doc_map(&mut a, Some("Good"), Some(&good), &m, None);
        assert_eq!(a.doc_para_style.as_deref(), Some("ParagraphStyle/Body"));
        assert_eq!(a.text_rgb.as_deref(), Some("#006100"));
        assert_eq!(a.fill_rgb.as_deref(), Some("#C6EFCE"));
    }

    #[test]
    fn a_cell_style_takes_the_named_fill_and_borders() {
        let note = VisualAttrs {
            fill_rgb: Some("#FFFFCC".into()),
            border_top: true,
            ..Default::default()
        };
        let mut a = note.clone();
        let m = map(&[(
            "note",
            DocStyleTarget {
                para: Some("P".into()),
                char: Some("C".into()),
                cell: Some("CellStyle/Note".into()),
            },
        )]);
        apply_doc_map(&mut a, Some("Note"), Some(&note), &m, None);
        assert_eq!(a.fill_rgb, None);
        assert!(!a.border_top);
        assert_eq!(a.doc_cell_style.as_deref(), Some("CellStyle/Note"));
        assert_eq!(a.doc_char_style.as_deref(), Some("C"));
    }

    #[test]
    fn off_or_empty_changes_nothing() {
        let mut m = map(&[("Heading 1", target("P"))]);
        m.enabled = false;
        let mut a = heading_look();
        apply_doc_map(&mut a, Some("Heading 1"), Some(&heading_look()), &m, None);
        assert_eq!(a, heading_look());
        let empty = map(&[]);
        apply_doc_map(&mut a, None, None, &empty, None);
        assert_eq!(a, heading_look());
    }

    #[test]
    fn a_style_the_document_lacks_falls_back_to_the_workbook_look() {
        let m = map(&[
            ("Heading 1", target("ParagraphStyle/Gone")),
            (NORMAL, target("ParagraphStyle/Body")),
        ]);
        let have: BTreeSet<String> = ["ParagraphStyle/Body".to_string()].into();
        let mut a = heading_look();
        apply_doc_map(
            &mut a,
            Some("Heading 1"),
            Some(&heading_look()),
            &m,
            Some(&have),
        );
        // Normal's paragraph, the heading's own look kept concrete.
        assert_eq!(a.doc_para_style.as_deref(), Some("ParagraphStyle/Body"));
        assert!(a.bold);
        assert_eq!(a.font_size_pt, Some(15.0));
        let none = BTreeSet::new();
        let mut b = heading_look();
        apply_doc_map(
            &mut b,
            Some("Heading 1"),
            Some(&heading_look()),
            &m,
            Some(&none),
        );
        assert_eq!(b, heading_look());
    }

    #[test]
    fn set_replaces_case_insensitively_and_clears() {
        let mut m = map(&[("heading 1", target("A"))]);
        m.set("Heading 1", target("B"));
        assert_eq!(m.entries.len(), 1);
        assert_eq!(m.get("HEADING 1").unwrap().para.as_deref(), Some("B"));
        m.set("Heading 1", DocStyleTarget::default());
        assert!(m.entries.is_empty());
    }

    mod props {
        use super::*;
        use proptest::prelude::*;

        fn attrs() -> impl Strategy<Value = VisualAttrs> {
            (
                any::<bool>(),
                any::<bool>(),
                prop::option::of(prop::sample::select(vec![9.0, 11.0, 15.0])),
                prop::option::of(prop::sample::select(vec!["Calibri", "Arial"])),
                prop::option::of(prop::sample::select(vec!["#000000", "#FF0000"])),
                prop::option::of(prop::sample::select(vec!["#FFFF00", "#C6EFCE"])),
            )
                .prop_map(|(bold, italic, size, name, text, fill)| VisualAttrs {
                    bold,
                    italic,
                    font_size_pt: size,
                    font_name: name.map(str::to_string),
                    text_rgb: text.map(str::to_string),
                    fill_rgb: fill.map(str::to_string),
                    ..Default::default()
                })
        }

        proptest! {
            /// Direct formatting always survives: every facet that differs
            /// from the named style's is kept; facets equal to it give way;
            /// the mapped styles are set; an inert map changes nothing.
            #[test]
            fn direct_facets_survive_the_mapping(cell in attrs(), inh in attrs(), on in any::<bool>()) {
                let mut m = map(&[("Heading 1", target("P"))]);
                m.enabled = on;
                let mut a = cell.clone();
                apply_doc_map(&mut a, Some("Heading 1"), Some(&inh), &m, None);
                if !on {
                    prop_assert_eq!(&a, &cell);
                } else {
                    prop_assert_eq!(a.doc_para_style.as_deref(), Some("P"));
                    prop_assert_eq!(a.bold, cell.bold && cell.bold != inh.bold);
                    prop_assert_eq!(a.italic, cell.italic && cell.italic != inh.italic);
                    if cell.font_size_pt != inh.font_size_pt {
                        prop_assert_eq!(a.font_size_pt, cell.font_size_pt);
                    } else {
                        prop_assert_eq!(a.font_size_pt, None);
                    }
                    if cell.text_rgb != inh.text_rgb {
                        prop_assert_eq!(&a.text_rgb, &cell.text_rgb);
                    }
                    // No cell style mapped: the fill is untouched.
                    prop_assert_eq!(&a.fill_rgb, &cell.fill_rgb);
                }
            }
        }
    }
}
