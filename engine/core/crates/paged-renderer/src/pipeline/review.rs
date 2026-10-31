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

//! Engine ADR 1040 — tracked changes and comments as the markup view shows
//! them (Word's Display for Review), applied to a paragraph before it is
//! set:
//!
//! - All Markup: an insertion is underlined in its author's colour, a
//!   deletion struck through in it, commented text shaded.
//! - Simple and No Markup: the text as if every change were accepted
//!   (deletions are hidden by the hide pass, `conditions::HideRule`).
//! - Original: as if every change were rejected: insertions hidden, the
//!   formatting before each formatting change.

use paged_model::{review_color_id, review_highlight_id, ChangeKind, MarkupView, Paragraph};

/// Whether `paragraph` carries anything the markup view draws or hides.
pub(super) fn has_review(paragraph: &Paragraph) -> bool {
    paragraph.props_change.is_some()
        || paragraph
            .runs
            .iter()
            .any(|r| r.revision.is_some() || r.format_change.is_some() || !r.comments.is_empty())
}

/// `paragraph` as `view` shows it, or `None` when it shows it unchanged
/// (hiding is the hide pass's).
pub(super) fn reviewed(paragraph: &Paragraph, view: MarkupView) -> Option<Paragraph> {
    if !has_review(paragraph) {
        return None;
    }
    match view {
        MarkupView::All => {
            let mut p = paragraph.clone();
            for r in p.runs.iter_mut() {
                if let Some(c) = r.revision.as_ref() {
                    let color = review_color_id(c.author.as_deref());
                    match c.kind {
                        ChangeKind::Insert => {
                            r.underline = Some(true);
                            r.decorations.underline_color = Some(color.clone());
                        }
                        ChangeKind::Delete => r.strikethru = Some(true),
                        _ => {}
                    }
                    r.fill_color = Some(color);
                    r.fill_tint = None;
                }
                if let Some(first) = r.comments.first() {
                    r.decorations.highlight_color = Some(review_highlight_id(Some(first)));
                }
            }
            Some(p)
        }
        MarkupView::Original => {
            let mut p = paragraph.clone();
            if let Some(pc) = p.props_change.clone() {
                p.restore_props(&pc.before);
            }
            for r in p.runs.iter_mut() {
                if let Some(fc) = r.format_change.clone() {
                    *r = r.with_props_of(&fc.before);
                }
            }
            Some(p)
        }
        MarkupView::Simple | MarkupView::None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use paged_model::{Change, CharacterRun};

    fn para() -> Paragraph {
        let change = |kind| Change {
            id: "1".into(),
            kind,
            author: Some("Author A".into()),
            date: None,
        };
        Paragraph {
            runs: vec![
                CharacterRun {
                    text: "kept ".into(),
                    ..Default::default()
                },
                CharacterRun {
                    text: "new ".into(),
                    revision: Some(change(ChangeKind::Insert)),
                    ..Default::default()
                },
                CharacterRun {
                    text: "old".into(),
                    revision: Some(change(ChangeKind::Delete)),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn all_markup_underlines_insertions_and_strikes_deletions() {
        let p = reviewed(&para(), MarkupView::All).unwrap();
        assert_eq!(p.runs[0].underline, None);
        assert_eq!(p.runs[1].underline, Some(true));
        assert_eq!(p.runs[2].strikethru, Some(true));
        let color = p.runs[1].fill_color.clone().unwrap();
        assert!(paged_model::review_color(&color).is_some());
    }

    #[test]
    fn the_views_hide_what_they_leave_out() {
        let p = para();
        assert!(MarkupView::None.hides(p.runs[2].revision.as_ref()));
        assert!(!MarkupView::None.hides(p.runs[1].revision.as_ref()));
        assert!(MarkupView::Original.hides(p.runs[1].revision.as_ref()));
        assert!(!MarkupView::All.hides(p.runs[2].revision.as_ref()));
    }
}
