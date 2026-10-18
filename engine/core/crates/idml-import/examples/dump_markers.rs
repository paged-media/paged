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

//! Tiny debug helper: scan stories in an IDML and print any auto-page-
//! number markers that surface from the parser. Used to verify the
//! ACE 18 / ACE 19 PI handler reaches downstream consumers.
use std::path::PathBuf;

fn main() {
    let path: PathBuf = std::env::args()
        .nth(1)
        .expect("usage: dump_markers <idml>")
        .into();
    let bytes = std::fs::read(&path).unwrap();
    let container = idml_import::open_source_archive(&bytes).unwrap();
    for (name, raw) in container.entries.iter() {
        if !name.starts_with("Stories/") || !name.ends_with(".xml") {
            continue;
        }
        let story = idml_import::parse_story(raw).unwrap();
        for p in &story.paragraphs {
            for r in &p.runs {
                if r.text.contains(idml_import::AUTO_PAGE_NUMBER_MARKER)
                    || r.text.contains(idml_import::NEXT_PAGE_NUMBER_MARKER)
                {
                    println!("{name}  text={:?}", r.text);
                }
            }
        }
    }
}
