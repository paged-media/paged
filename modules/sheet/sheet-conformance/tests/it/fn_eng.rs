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

//! Golden replays for the `eng` family, one test per function (generated
//! from the registry rows; each test replays its function's
//! `corpus/fn-corpus/eng/<fn>.golden.tsv` through the full engine).

use super::w3_golden::replay;

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_bin2dec__feat__sheet_fn_engineering() {
    replay("eng", "bin2dec");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_bin2hex__feat__sheet_fn_engineering() {
    replay("eng", "bin2hex");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_bin2oct__feat__sheet_fn_engineering() {
    replay("eng", "bin2oct");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_dec2bin__feat__sheet_fn_engineering() {
    replay("eng", "dec2bin");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_dec2hex__feat__sheet_fn_engineering() {
    replay("eng", "dec2hex");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_dec2oct__feat__sheet_fn_engineering() {
    replay("eng", "dec2oct");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_hex2bin__feat__sheet_fn_engineering() {
    replay("eng", "hex2bin");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_hex2dec__feat__sheet_fn_engineering() {
    replay("eng", "hex2dec");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_hex2oct__feat__sheet_fn_engineering() {
    replay("eng", "hex2oct");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_oct2bin__feat__sheet_fn_engineering() {
    replay("eng", "oct2bin");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_oct2dec__feat__sheet_fn_engineering() {
    replay("eng", "oct2dec");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_oct2hex__feat__sheet_fn_engineering() {
    replay("eng", "oct2hex");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_bitand__feat__sheet_fn_engineering() {
    replay("eng", "bitand");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_bitor__feat__sheet_fn_engineering() {
    replay("eng", "bitor");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_bitxor__feat__sheet_fn_engineering() {
    replay("eng", "bitxor");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_bitlshift__feat__sheet_fn_engineering() {
    replay("eng", "bitlshift");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_bitrshift__feat__sheet_fn_engineering() {
    replay("eng", "bitrshift");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_delta__feat__sheet_fn_engineering() {
    replay("eng", "delta");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_gestep__feat__sheet_fn_engineering() {
    replay("eng", "gestep");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_erf__feat__sheet_fn_engineering() {
    replay("eng", "erf");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_erf_precise__feat__sheet_fn_engineering() {
    replay("eng", "erf_precise");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_erfc__feat__sheet_fn_engineering() {
    replay("eng", "erfc");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_erfc_precise__feat__sheet_fn_engineering() {
    replay("eng", "erfc_precise");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_complex__feat__sheet_fn_engineering() {
    replay("eng", "complex");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imabs__feat__sheet_fn_engineering() {
    replay("eng", "imabs");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imaginary__feat__sheet_fn_engineering() {
    replay("eng", "imaginary");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imreal__feat__sheet_fn_engineering() {
    replay("eng", "imreal");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imargument__feat__sheet_fn_engineering() {
    replay("eng", "imargument");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imconjugate__feat__sheet_fn_engineering() {
    replay("eng", "imconjugate");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imcos__feat__sheet_fn_engineering() {
    replay("eng", "imcos");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imcosh__feat__sheet_fn_engineering() {
    replay("eng", "imcosh");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imcot__feat__sheet_fn_engineering() {
    replay("eng", "imcot");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imcsc__feat__sheet_fn_engineering() {
    replay("eng", "imcsc");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imcsch__feat__sheet_fn_engineering() {
    replay("eng", "imcsch");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imsec__feat__sheet_fn_engineering() {
    replay("eng", "imsec");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imsech__feat__sheet_fn_engineering() {
    replay("eng", "imsech");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imsin__feat__sheet_fn_engineering() {
    replay("eng", "imsin");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imsinh__feat__sheet_fn_engineering() {
    replay("eng", "imsinh");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imtan__feat__sheet_fn_engineering() {
    replay("eng", "imtan");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imexp__feat__sheet_fn_engineering() {
    replay("eng", "imexp");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imln__feat__sheet_fn_engineering() {
    replay("eng", "imln");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imlog10__feat__sheet_fn_engineering() {
    replay("eng", "imlog10");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imlog2__feat__sheet_fn_engineering() {
    replay("eng", "imlog2");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imsqrt__feat__sheet_fn_engineering() {
    replay("eng", "imsqrt");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_impower__feat__sheet_fn_engineering() {
    replay("eng", "impower");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imdiv__feat__sheet_fn_engineering() {
    replay("eng", "imdiv");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imsub__feat__sheet_fn_engineering() {
    replay("eng", "imsub");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_imsum__feat__sheet_fn_engineering() {
    replay("eng", "imsum");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_improduct__feat__sheet_fn_engineering() {
    replay("eng", "improduct");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_besseli__feat__sheet_fn_engineering() {
    replay("eng", "besseli");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_besselj__feat__sheet_fn_engineering() {
    replay("eng", "besselj");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_besselk__feat__sheet_fn_engineering() {
    replay("eng", "besselk");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_eng_bessely__feat__sheet_fn_engineering() {
    replay("eng", "bessely");
}
