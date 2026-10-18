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

//! `cargo run -p slide-resolve --example resolve -- deck.pptx [--json]`

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let deck = pptx_import::import_pptx(&std::fs::read(&args[1]).unwrap()).unwrap();
    let r = slide_resolve::resolve(&deck);
    if args.iter().any(|a| a == "--json") {
        println!("{}", serde_json::to_string_pretty(&r).unwrap());
        return;
    }
    println!(
        "{} x {} pt; {} masters, {} slides; fonts {:?}",
        r.width,
        r.height,
        r.masters.len(),
        r.slides.len(),
        r.fonts
    );
    for s in &r.slides {
        println!("  {} master {:?}: {} items", s.id, s.master, s.items.len());
    }
    for d in &r.diagnostics {
        println!("  ! {d}");
    }
}
