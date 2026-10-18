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

//! The private corpus for the opt-in corpus lanes (`#[ignore = "corpus: …"]`).
//!
//! The corpus root comes from `PAGED_CORPUS_DIR` (else the gitignored
//! `<repo root>/corpus` link), through `paged-test-resources`, the one
//! convention every workspace shares (docs/development/testing.md). A lane
//! without its corpus prints `unavailable: private corpus: …` and returns;
//! `PAGED_REQUIRE_CORPUS=1` turns that into a failure. Each lane's old
//! `PAGED_<LANE>_CORPUS` variable is still read for one deprecation
//! period, with a warning. Run the lanes with:
//!
//! ```text
//! PAGED_CORPUS_DIR=<corpus root> cargo nextest run --profile corpus --run-ignored only
//! ```

use std::fmt;
use std::path::PathBuf;

use paged_test_resources::Resource;

/// The corpus root for `lane`, or `None` after reporting the corpus as
/// unavailable. `legacy` is the lane's old switch variable.
///
/// # Panics
///
/// When there is no corpus and `PAGED_REQUIRE_CORPUS=1` is set.
#[track_caller]
pub fn root(lane: &str, legacy: &str) -> Option<PathBuf> {
    match paged_test_resources::corpus_root(&[legacy]) {
        Ok(root) => Some(root),
        Err(why) => {
            missing(lane, why);
            None
        }
    }
}

/// Reports that the corpus lacks what `lane` needs (`what`). The caller
/// returns early.
///
/// # Panics
///
/// When `PAGED_REQUIRE_CORPUS=1` is set.
#[track_caller]
pub fn missing(lane: &str, what: impl fmt::Display) {
    paged_test_resources::unavailable(Resource::Corpus, format_args!("{lane} lane: {what}"));
}
