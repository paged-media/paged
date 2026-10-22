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

//! Golden replays for the `text3` family, one test per function (generated
//! from the registry rows; each test replays its function's
//! `corpus/fn-corpus/text3/<fn>.golden.tsv` through the full engine).

use super::w3_golden::replay;

#[allow(non_snake_case)]
#[test]
fn sheet_fn_text3_regextest__feat__sheet_fn_text_regex() {
    replay("text3", "regextest");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_text3_regexextract__feat__sheet_fn_text_regex() {
    replay("text3", "regexextract");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_text3_regexreplace__feat__sheet_fn_text_regex() {
    replay("text3", "regexreplace");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_text3_arraytotext__feat__sheet_fn_text_regex() {
    replay("text3", "arraytotext");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_text3_valuetotext__feat__sheet_fn_text_regex() {
    replay("text3", "valuetotext");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_text3_bahttext__feat__sheet_fn_text_regex() {
    replay("text3", "bahttext");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_text3_asc__feat__sheet_fn_text_regex() {
    replay("text3", "asc");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_text3_dbcs__feat__sheet_fn_text_regex() {
    replay("text3", "dbcs");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_text3_jis__feat__sheet_fn_text_regex() {
    replay("text3", "jis");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_text3_findb__feat__sheet_fn_text_regex() {
    replay("text3", "bytes");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_text3_leftb__feat__sheet_fn_text_regex() {
    replay("text3", "bytes");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_text3_lenb__feat__sheet_fn_text_regex() {
    replay("text3", "bytes");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_text3_midb__feat__sheet_fn_text_regex() {
    replay("text3", "bytes");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_text3_replaceb__feat__sheet_fn_text_regex() {
    replay("text3", "bytes");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_text3_rightb__feat__sheet_fn_text_regex() {
    replay("text3", "bytes");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_text3_searchb__feat__sheet_fn_text_regex() {
    replay("text3", "bytes");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_text3_phonetic__feat__sheet_fn_text_regex() {
    replay("text3", "phonetic");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_text3_encodeurl__feat__sheet_fn_text_regex() {
    replay("text3", "encodeurl");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_text3_filterxml__feat__sheet_fn_text_regex() {
    replay("text3", "filterxml");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_text3_euroconvert__feat__sheet_fn_text_regex() {
    replay("text3", "euroconvert");
}
