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

//! `cargo run -p pptx-import --example pptx-dump -- deck.pptx [--json]`
//! prints a summary of the IR (or the whole IR as JSON).

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).expect("usage: pptx-dump <deck.pptx> [--json]");
    let bytes = std::fs::read(path).expect("read deck");
    let deck = pptx_import::import_pptx(&bytes).expect("import");
    if args.iter().any(|a| a == "--json") {
        println!("{}", serde_json::to_string_pretty(&deck).unwrap());
        return;
    }
    println!(
        "slide size {:?} pt; {} slides, {} layouts, {} masters, {} themes, {} embedded fonts, {} sections",
        (deck.slide_size.0 as f64 / 12700.0, deck.slide_size.1 as f64 / 12700.0),
        deck.slides.len(),
        deck.layouts.len(),
        deck.masters.len(),
        deck.themes.len(),
        deck.embedded_fonts.len(),
        deck.sections.len()
    );
    for d in &deck.diagnostics {
        println!("  ! {d}");
    }
}
