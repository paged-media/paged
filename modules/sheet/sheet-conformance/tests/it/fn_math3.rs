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

//! Golden replays for the `math3` family, one test per function (generated
//! from the registry rows; each test replays its function's
//! `corpus/fn-corpus/math3/<fn>.golden.tsv` through the full engine).

use super::w3_golden::replay;

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_ceiling_math__feat__sheet_fn_math_trig() {
    replay("math3", "ceiling_math");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_ceiling_precise__feat__sheet_fn_math_trig() {
    replay("math3", "ceiling_precise");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_iso_ceiling__feat__sheet_fn_math_trig() {
    replay("math3", "iso_ceiling");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_floor_math__feat__sheet_fn_math_trig() {
    replay("math3", "floor_math");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_floor_precise__feat__sheet_fn_math_trig() {
    replay("math3", "floor_precise");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_quotient__feat__sheet_fn_math_trig() {
    replay("math3", "quotient");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_mdeterm__feat__sheet_fn_math_trig() {
    replay("math3", "mdeterm");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_minverse__feat__sheet_fn_math_trig() {
    replay("math3", "minverse");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_munit__feat__sheet_fn_math_trig() {
    replay("math3", "munit");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_multinomial__feat__sheet_fn_math_trig() {
    replay("math3", "multinomial");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_combina__feat__sheet_fn_math_trig() {
    replay("math3", "combina");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_acot__feat__sheet_fn_math_trig() {
    replay("math3", "acot");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_acoth__feat__sheet_fn_math_trig() {
    replay("math3", "acoth");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_cot__feat__sheet_fn_math_trig() {
    replay("math3", "cot");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_coth__feat__sheet_fn_math_trig() {
    replay("math3", "coth");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_csc__feat__sheet_fn_math_trig() {
    replay("math3", "csc");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_csch__feat__sheet_fn_math_trig() {
    replay("math3", "csch");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_sec__feat__sheet_fn_math_trig() {
    replay("math3", "sec");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_sech__feat__sheet_fn_math_trig() {
    replay("math3", "sech");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_seriessum__feat__sheet_fn_math_trig() {
    replay("math3", "seriessum");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_sumx2my2__feat__sheet_fn_math_trig() {
    replay("math3", "sumx2my2");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_sumx2py2__feat__sheet_fn_math_trig() {
    replay("math3", "sumx2py2");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_sumxmy2__feat__sheet_fn_math_trig() {
    replay("math3", "sumxmy2");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_math3_percentof__feat__sheet_fn_math_trig() {
    replay("math3", "percentof");
}
