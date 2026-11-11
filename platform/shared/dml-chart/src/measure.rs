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
//! A chart label's width before it is set: the estimate each chart layout
//! reserves room with (axis label bands, legend entries, data label boxes).
//! The text itself is set by the engine later; this is only the layout's
//! guess, so it needs no font.
//!
//! The two Office applications are measured apart on purpose, as their chart
//! profiles are (the capability register's allowed difference): Excel's
//! curated layout (`sheet-chart`) reserves one average advance per
//! character, PowerPoint's (`slide-chart`, and Word's charts through it)
//! weighs digits, separators and letters apart.

/// Excel's profile: one advance per character, as a fraction of the em.
pub const EXCEL_ADVANCE_EM: f64 = 0.55;

/// PowerPoint's profile: a digit's advance, as a fraction of the em.
pub const POWERPOINT_DIGIT_EM: f64 = 0.6;
/// PowerPoint's profile: a letter's advance.
pub const POWERPOINT_CHAR_EM: f64 = 0.52;
/// PowerPoint's profile: a separator's advance (`.`, `,`, space, `-`).
pub const POWERPOINT_SEPARATOR_EM: f64 = 0.3;

/// The width of `text` at `size` pt in Excel's chart profile.
pub fn excel_text_width(text: &str, size: f64) -> f64 {
    text.chars().count() as f64 * EXCEL_ADVANCE_EM * size
}

/// The width of `text` at `size` pt in PowerPoint's chart profile.
pub fn powerpoint_text_width(text: &str, size: f64) -> f64 {
    text.chars()
        .map(|c| {
            if c.is_ascii_digit() {
                POWERPOINT_DIGIT_EM
            } else if matches!(c, '.' | ',' | ' ' | '-') {
                POWERPOINT_SEPARATOR_EM
            } else {
                POWERPOINT_CHAR_EM
            }
        })
        .sum::<f64>()
        * size
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_profiles_measure_apart() {
        assert!((excel_text_width("1,5", 10.0) - 16.5).abs() < 1e-9);
        assert!((powerpoint_text_width("1,5", 10.0) - 15.0).abs() < 1e-9);
    }
}
