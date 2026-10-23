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

//! Golden replays for the `info3` family, one test per function (generated
//! from the registry rows; each test replays its function's
//! `corpus/fn-corpus/info3/<fn>.golden.tsv` through the full engine).

use super::w3_golden::replay;

#[allow(non_snake_case)]
#[test]
fn sheet_fn_info3_cell__feat__sheet_fn_information() {
    replay("info3", "cell");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_info3_info__feat__sheet_fn_information() {
    replay("info3", "info");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_info3_isnontext__feat__sheet_fn_information() {
    replay("info3", "isnontext");
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_info3_isomitted__feat__sheet_fn_information() {
    replay("info3", "isomitted");
}
