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

//! Write a deck from an original and a plan, for checking the result in
//! PowerPoint: `export_plan <original.pptx> <plan.json> <out.pptx>`.

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 4 {
        eprintln!("usage: export_plan <original.pptx> <plan.json> <out.pptx>");
        std::process::exit(2);
    }
    let original = std::fs::read(&a[1]).expect("read the deck");
    let plan: pptx_export::ExportPlan =
        serde_json::from_slice(&std::fs::read(&a[2]).expect("read the plan")).expect("a plan");
    let out = pptx_export::export(&original, &plan).expect("export");
    for d in &out.diagnostics {
        eprintln!("diagnostic: {d}");
    }
    std::fs::write(&a[3], out.bytes).expect("write");
}
