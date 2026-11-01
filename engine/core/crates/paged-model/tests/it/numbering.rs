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

//! The one roman-numeral and alphabetic numbering (page, list and footnote
//! numbers all call it): InDesign's forms, past 3999 too.

use paged_model::{alpha, roman};

#[test]
fn roman_numerals_follow_indesign_past_3999() {
    assert_eq!(roman(0, false), "");
    assert_eq!(roman(4, true), "iv");
    assert_eq!(roman(1994, false), "MCMXCIV");
    assert_eq!(roman(3999, false), "MMMCMXCIX");
    // Up to 4999, as many M as thousands.
    assert_eq!(roman(4000, false), "MMMM");
    // Above it, the thousands in Roman followed by M.
    assert_eq!(roman(5001, false), "VMI");
    assert_eq!(roman(10000, false), "XM");
    assert_eq!(roman(5001, true), "vmi");
}

#[test]
fn alphabetic_numbering_is_spreadsheet_style() {
    assert_eq!(alpha(0, false), "");
    assert_eq!(alpha(1, false), "A");
    assert_eq!(alpha(26, false), "Z");
    assert_eq!(alpha(27, true), "aa");
    assert_eq!(alpha(199, false), "GQ");
    assert_eq!(alpha(703, false), "AAA");
}
