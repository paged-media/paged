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

//! `cargo run -p slide-native --example pptx2paged -- deck.pptx out.paged`
//! reads, resolves and builds a deck (the native import path, minus the
//! host). `paged-inspect` renders the package.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let bytes = std::fs::read(&args[1]).unwrap();
    let deck = pptx_import::import_pptx(&bytes).unwrap();
    let resolved = slide_resolve::resolve(&deck);
    let pkg = paged_ooxml::OpcPackage::read(&bytes).unwrap();
    let images = |part: &str| pkg.part(part).map(|b| b.to_vec());
    let w = slide_native::write(&resolved, &images, "deck").unwrap();
    std::fs::write(&args[2], &w.paged).unwrap();
    eprintln!(
        "{} bytes; {} masters, {} slides, {} stories; fonts {:?}",
        w.paged.len(),
        resolved.masters.len(),
        resolved.slides.len(),
        w.stories.len(),
        resolved.fonts
    );
    for d in resolved.diagnostics.iter().chain(&w.diagnostics) {
        eprintln!("  ! {d}");
    }
}
