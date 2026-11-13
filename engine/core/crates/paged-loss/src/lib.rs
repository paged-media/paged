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

//! The loss report every importer, exporter and mapper answers with
//! (capability register C18): what a source carried that the target could
//! not keep, one entry per kind, counted. One shape in Rust and one in the
//! extension contract (`LossReport` / `LossEntry` in `@paged-media/plugin-api`),
//! so a consumer reads any producer's report with the same code.
//!
//! An entry is a stable `code` (what kind of thing, in the format's own
//! vocabulary: an annotation type, a mapper code, a Photoshop effect), how
//! often (`count`), how it fared (`severity`), optionally the 0-based `pages`
//! it stood on, and a worded `message`. A producer that leaves the wording to
//! its host (the PDF place-as-vectors mapper words its codes in the bundle)
//! leaves `message` empty; the empty `message` and `pages` stay off the wire.
//!
//! Adobe-versus-Microsoft differences stay in the adapters: each adapter
//! keeps its own codes, and only the shape is shared. This crate depends on
//! nothing in the workspace, so a format crate that sits below the engine
//! model (a DOCX lowering, a DXF reader) can still answer with it.

use std::fmt;

use serde::{Deserialize, Serialize};

/// How a construct fared.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[cfg_attr(feature = "wire", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wire", tsify(into_wasm_abi, from_wasm_abi))]
#[serde(rename_all = "camelCase")]
pub enum LossSeverity {
    /// Worth knowing, nothing visible changed (a break that adds nothing, a
    /// rule an older reader cannot apply).
    Info,
    /// Carried over with a visible difference (a focal point moved to the
    /// centre, a skewed stroke drawn at one width).
    Approximated,
    /// Not carried over at all (a filter, an external image). The default:
    /// an entry that says nothing else is a loss.
    #[default]
    Dropped,
}

impl LossSeverity {
    /// The lower-case word (`info`, `approximated`, `dropped`), as on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            LossSeverity::Info => "info",
            LossSeverity::Approximated => "approximated",
            LossSeverity::Dropped => "dropped",
        }
    }
}

/// One kind of loss.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "wire", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wire", tsify(into_wasm_abi, from_wasm_abi))]
#[serde(rename_all = "camelCase")]
pub struct LossEntry {
    /// Stable code, in the producer's own vocabulary: an annotation type
    /// (`Link`, `Stamp`, `state:Marked`), a mapper code (`shading.sampled`),
    /// an SVG construct (`filter`), a Photoshop effect (`Drop Shadow`).
    pub code: String,
    /// How many times it happened.
    pub count: usize,
    /// How it fared; `dropped` when the producer says nothing else.
    #[serde(default)]
    pub severity: LossSeverity,
    /// The 0-based pages it stood on, when the source has pages.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pages: Vec<usize>,
    /// The items it stood on, by the producer's own reference (a page
    /// item's or a story's id, a section, a swatch), when it can name them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<String>,
    /// Why or what, worded; empty when the consumer words the code.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub message: String,
}

impl LossEntry {
    /// One occurrence of `code`, with `severity` and `message`.
    pub fn new(
        code: impl Into<String>,
        severity: LossSeverity,
        message: impl Into<String>,
    ) -> Self {
        LossEntry {
            code: code.into(),
            count: 1,
            severity,
            pages: Vec::new(),
            items: Vec::new(),
            message: message.into(),
        }
    }

    /// The same entry, standing on the item `id` (added to [`Self::items`];
    /// an empty id names nothing and is left out).
    pub fn on(mut self, id: impl Into<String>) -> Self {
        let id = id.into();
        if !id.is_empty() && !self.items.contains(&id) {
            self.items.push(id);
        }
        self
    }

    /// `n` occurrences of `code`, dropped, left for the consumer to word.
    pub fn counted(code: impl Into<String>, n: usize) -> Self {
        LossEntry {
            code: code.into(),
            count: n,
            severity: LossSeverity::Dropped,
            pages: Vec::new(),
            items: Vec::new(),
            message: String::new(),
        }
    }
}

impl fmt::Display for LossEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} x {}", self.count, self.code)?;
        if !self.pages.is_empty() {
            let pages: Vec<String> = self.pages.iter().map(|p| (p + 1).to_string()).collect();
            write!(f, " (page {})", pages.join(", "))?;
        }
        if !self.message.is_empty() {
            write!(f, ": {}", self.message)?;
        }
        Ok(())
    }
}

/// The counting rules every producer shares, over a plain list of entries:
/// one entry per `(code, message)`, in the order each first happened. A
/// report that carries more than its losses (an SVG import's item count)
/// holds a `Vec<LossEntry>` and counts through this trait.
pub trait LossLog {
    /// Count `n` occurrences of `code`: added to the entry with the same
    /// code and message, else a new entry (the first severity stands).
    fn note_n(&mut self, code: &str, severity: LossSeverity, message: &str, n: usize);

    /// Add `entry`, merged into the entry with its code and message.
    fn push_loss(&mut self, entry: LossEntry);

    /// The first entry of `code`, if it happened.
    fn loss(&self, code: &str) -> Option<&LossEntry>;

    /// Count one occurrence of `code`.
    fn note(&mut self, code: &str, severity: LossSeverity, message: &str) {
        self.note_n(code, severity, message, 1);
    }

    /// One construct carried with a visible difference.
    fn approximated(&mut self, code: &str, message: &str) {
        self.note(code, LossSeverity::Approximated, message);
    }

    /// One construct left out.
    fn dropped(&mut self, code: &str, message: &str) {
        self.note(code, LossSeverity::Dropped, message);
    }

    /// Every entry of `other`, merged.
    fn extend_losses(&mut self, other: impl IntoIterator<Item = LossEntry>) {
        for e in other {
            self.push_loss(e);
        }
    }
}

impl LossLog for Vec<LossEntry> {
    fn note_n(&mut self, code: &str, severity: LossSeverity, message: &str, n: usize) {
        if let Some(e) = self
            .iter_mut()
            .find(|e| e.code == code && e.message == message)
        {
            e.count += n;
            return;
        }
        self.push(LossEntry {
            code: code.to_string(),
            count: n,
            severity,
            pages: Vec::new(),
            items: Vec::new(),
            message: message.to_string(),
        });
    }

    fn push_loss(&mut self, entry: LossEntry) {
        match self
            .iter_mut()
            .find(|e| e.code == entry.code && e.message == entry.message)
        {
            Some(e) => {
                e.count += entry.count;
                for p in entry.pages {
                    if !e.pages.contains(&p) {
                        e.pages.push(p);
                    }
                }
                for i in entry.items {
                    if !e.items.contains(&i) {
                        e.items.push(i);
                    }
                }
            }
            None => self.push(entry),
        }
    }

    fn loss(&self, code: &str) -> Option<&LossEntry> {
        self.iter().find(|e| e.code == code)
    }
}

/// What a conversion left behind: one entry per `(code, message)`, in the
/// order each first happened ([`LossLog`]).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LossReport {
    pub losses: Vec<LossEntry>,
}

impl LossReport {
    /// Whether nothing was lost.
    pub fn is_empty(&self) -> bool {
        self.losses.is_empty()
    }

    /// The first entry of `code`, if it happened.
    pub fn get(&self, code: &str) -> Option<&LossEntry> {
        self.losses.loss(code)
    }

    /// The entries, sorted by code (then message): a stable order for a
    /// producer whose walk order is not meaningful.
    pub fn sorted(mut self) -> Self {
        self.losses
            .sort_by(|a, b| a.code.cmp(&b.code).then_with(|| a.message.cmp(&b.message)));
        self
    }
}

impl LossLog for LossReport {
    fn note_n(&mut self, code: &str, severity: LossSeverity, message: &str, n: usize) {
        self.losses.note_n(code, severity, message, n);
    }
    fn push_loss(&mut self, entry: LossEntry) {
        self.losses.push_loss(entry);
    }
    fn loss(&self, code: &str) -> Option<&LossEntry> {
        self.losses.loss(code)
    }
}

impl From<Vec<LossEntry>> for LossReport {
    fn from(entries: Vec<LossEntry>) -> Self {
        let mut r = LossReport::default();
        r.extend_losses(entries);
        r
    }
}

impl IntoIterator for LossReport {
    type Item = LossEntry;
    type IntoIter = std::vec::IntoIter<LossEntry>;
    fn into_iter(self) -> Self::IntoIter {
        self.losses.into_iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_prints_and_serialises_without_its_empty_parts() {
        let full = LossEntry {
            code: "Link".into(),
            count: 2,
            severity: LossSeverity::Dropped,
            pages: vec![0, 2],
            items: Vec::new(),
            message: "a hyperlink".into(),
        };
        assert_eq!(full.to_string(), "2 x Link (page 1, 3): a hyperlink");
        assert_eq!(
            serde_json::to_string(&full).unwrap(),
            r#"{"code":"Link","count":2,"severity":"dropped","pages":[0,2],"message":"a hyperlink"}"#
        );
        let bare = LossEntry::counted("shading.sampled", 1);
        assert_eq!(bare.to_string(), "1 x shading.sampled");
        assert_eq!(
            serde_json::to_string(&bare).unwrap(),
            r#"{"code":"shading.sampled","count":1,"severity":"dropped"}"#
        );
        let back: LossEntry = serde_json::from_str(r#"{"code":"x","count":3}"#).unwrap();
        assert_eq!(
            (
                back.count,
                back.severity,
                back.pages.len(),
                back.message.len()
            ),
            (3, LossSeverity::Dropped, 0, 0)
        );
    }

    #[test]
    fn a_report_counts_per_code_and_message_in_first_use_order() {
        let mut r = LossReport::default();
        r.dropped("filter", "a filter is not drawn");
        r.approximated("gradient.focal", "the focal point moves to the centre");
        r.dropped("filter", "a filter is not drawn");
        r.note_n("text.outlined", LossSeverity::Approximated, "", 3);
        let codes: Vec<(&str, usize)> = r
            .losses
            .iter()
            .map(|e| (e.code.as_str(), e.count))
            .collect();
        assert_eq!(
            codes,
            [("filter", 2), ("gradient.focal", 1), ("text.outlined", 3)]
        );
        assert_eq!(r.get("filter").unwrap().severity, LossSeverity::Dropped);

        // One effect with two different losses stays two entries.
        let mut s = LossReport::default();
        s.dropped("Drop Shadow", "noise");
        s.dropped("Drop Shadow", "contour");
        assert_eq!(s.losses.len(), 2);

        let mut m = LossReport::default();
        m.push_loss(LossEntry {
            pages: vec![1],
            ..LossEntry::counted("Link", 1)
        });
        m.push_loss(LossEntry {
            pages: vec![1, 4],
            ..LossEntry::counted("Link", 2)
        });
        assert_eq!(
            (m.losses[0].count, m.losses[0].pages.clone()),
            (3, vec![1, 4])
        );
        let mut on = LossReport::default();
        on.push_loss(LossEntry::new("idml.x", LossSeverity::Dropped, "m").on("r1"));
        on.push_loss(LossEntry::new("idml.x", LossSeverity::Dropped, "m").on("r2"));
        assert_eq!(on.losses[0].items, ["r1", "r2"]);
        assert_eq!(
            serde_json::to_string(&on.losses[0]).unwrap(),
            r#"{"code":"idml.x","count":2,"severity":"dropped","items":["r1","r2"],"message":"m"}"#
        );
        assert_eq!(
            LossReport::from(vec![LossEntry::counted("b", 1), LossEntry::counted("a", 1)])
                .sorted()
                .losses[0]
                .code,
            "a"
        );
    }
}
