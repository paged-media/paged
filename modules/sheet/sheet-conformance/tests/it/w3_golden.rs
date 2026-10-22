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

//! The shared replay behind the per-function W3 golden tests (`fn_eng.rs`,
//! `fn_math3.rs`, …): load one function's golden file and replay every case
//! through the full parse → calc → function → General-projection path, the
//! same door `corpus_runner.rs` drives for whole families.

use sheet_conformance::load_corpus;
use sheet_conformance::runner::{project, projection_matches, run_case};

/// Replay `corpus/fn-corpus/<family>/<file>.golden.tsv`, reporting every
/// mismatch at once.
pub fn replay(family: &str, file: &str) {
    let rel = format!("corpus/fn-corpus/{family}/{file}.golden.tsv");
    let cases = load_corpus(&rel);
    assert!(!cases.is_empty(), "{rel}: no cases");
    let mut failures = Vec::new();
    for case in &cases {
        match run_case(case) {
            Ok(v) => {
                let got = project(&v);
                if !projection_matches(&got, &case.expected) {
                    failures.push(format!(
                        "[{}] {} (setup {:?}) -> got {got:?}, want {:?}",
                        case.id, case.formula, case.setup, case.expected
                    ));
                }
            }
            Err(e) => failures.push(format!("[{}] {} {e}", case.id, case.formula)),
        }
    }
    assert!(
        failures.is_empty(),
        "{rel}: {}/{} case(s) failed:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}
