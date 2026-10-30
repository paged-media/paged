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

//! Engine ADR 1051 — a paragraph's stated direction, as the emitters set
//! it: the composer lays the paragraph out left to right in logical order
//! (start-edge alignment, indents and tabs), and once every pass that reads
//! logical positions is done the lines are put in visual order and, right
//! to left, mirrored in their measure (`paged_text::set_stated_bidi`).

use paged_model::{CharacterDirection, ResolvedDirection};
use paged_text::BidiLayout;

/// The direction the composer sets a paragraph in: `None` when neither
/// the paragraph nor any of its runs states one (the older reordering then
/// applies). `runs` are the shaped runs' texts in order, each with its
/// resolved direction.
pub(super) fn stated_bidi<'a>(
    direction: Option<paged_model::ParagraphDirection>,
    runs: impl Iterator<Item = (&'a str, Option<CharacterDirection>)>,
) -> Option<BidiLayout> {
    let mut text = String::new();
    let mut ranges = Vec::new();
    for (t, d) in runs {
        let start = text.len() as u32;
        text.push_str(t);
        if let Some(d) = d {
            ranges.push((
                start..text.len() as u32,
                d == CharacterDirection::RightToLeft,
            ));
        }
    }
    // Left to right is every IDML paragraph style's spelling
    // (`ParagraphDirection="LeftToRightDirection"`): it states nothing the
    // older pass does not already do, so it keeps that pass (and every
    // IDML document draws exactly as before) unless a run states its own
    // direction.
    let rtl = match direction {
        Some(paged_model::ParagraphDirection::LeftToRight) | None if ranges.is_empty() => {
            return None
        }
        Some(d) => d.resolve(&text) == ResolvedDirection::RightToLeft,
        None => false,
    };
    Some(BidiLayout { rtl, runs: ranges })
}

#[cfg(test)]
mod tests {
    use super::*;
    use paged_model::ParagraphDirection;

    #[test]
    fn stated_only_when_something_states_it() {
        assert!(stated_bidi(None, [("abc", None)].into_iter()).is_none());
        assert!(stated_bidi(
            Some(ParagraphDirection::LeftToRight),
            [("abc", None)].into_iter()
        )
        .is_none());
        let rtl = stated_bidi(
            Some(ParagraphDirection::RightToLeft),
            [("abc", None)].into_iter(),
        )
        .unwrap();
        assert!(rtl.rtl);
        let auto = stated_bidi(
            Some(ParagraphDirection::Auto),
            [
                ("12 ", None),
                ("שלום", Some(CharacterDirection::RightToLeft)),
            ]
            .into_iter(),
        )
        .unwrap();
        assert!(auto.rtl);
        assert_eq!(auto.runs, vec![(3..11, true)]);
        let runs_only = stated_bidi(
            None,
            [("ab", None), ("12", Some(CharacterDirection::RightToLeft))].into_iter(),
        )
        .unwrap();
        assert!(!runs_only.rtl);
    }
}
