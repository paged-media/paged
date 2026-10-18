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

//! Opt-in probe: `PAGED_DIFF_PACKAGE=<path>.idml` — open the package,
//! export it unmutated, and report the first entry that is not
//! byte-identical with 300 bytes of context. A developer's diff tool for
//! "which part churns on an unmutated save", nothing more; skipped
//! unless the variable is set.

#[path = "support/pkg.rs"]
mod pkg;

#[test]
fn unmutated_export_of_the_named_package_is_entry_identical() {
    let Some(path) = std::env::var_os("PAGED_DIFF_PACKAGE") else {
        eprintln!("SKIP: PAGED_DIFF_PACKAGE unset");
        return;
    };
    let source = std::fs::read(&path).expect("read package");
    let doc = pkg::open(&source);
    let out = idml_export::write_idml(&doc, &source).expect("write");
    pkg::assert_same_entries(&source, &out);
}
