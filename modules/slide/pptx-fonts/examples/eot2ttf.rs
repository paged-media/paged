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

//! Decode embedded faces: `cargo run -p pptx-fonts --example eot2ttf --
//! <out dir> <file.fntdata | deck.pptx>...`. Each face is written as
//! `<out dir>/<name>.ttf`; one line per face reports its header and size.

use std::io::Read;

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(out) = args.next() else {
        eprintln!("usage: eot2ttf <out dir> <file.fntdata | deck.pptx>...");
        std::process::exit(2);
    };
    std::fs::create_dir_all(&out).expect("out dir");
    let (mut ok, mut failed) = (0, 0);
    for path in args {
        let bytes = std::fs::read(&path).expect("read");
        let mut parts: Vec<(String, Vec<u8>)> = Vec::new();
        if bytes.starts_with(b"PK") {
            let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).expect("zip");
            for i in 0..zip.len() {
                let mut f = zip.by_index(i).expect("entry");
                if f.name().ends_with(".fntdata") {
                    let mut b = Vec::new();
                    f.read_to_end(&mut b).expect("entry bytes");
                    parts.push((f.name().to_string(), b));
                }
            }
        } else {
            parts.push((path.clone(), bytes));
        }
        for (name, b) in parts {
            let stem = name
                .rsplit('/')
                .next()
                .unwrap_or(&name)
                .trim_end_matches(".fntdata");
            match pptx_fonts::decode(&b) {
                Ok(face) => {
                    ok += 1;
                    let (family, style, flags) = face
                        .header
                        .as_ref()
                        .map(|h| (h.family.as_str(), h.style.as_str(), h.flags))
                        .unwrap_or(("(bare OpenType)", "", 0));
                    println!(
                        "ok   {name}: {family} / {style} flags {flags:#x} fsType {:#06x} {:?} -> {} bytes{}",
                        face.permissions.fs_type,
                        face.permissions.embedding(),
                        face.sfnt.len(),
                        if face.notes.is_empty() { String::new() } else { format!(" notes: {:?}", face.notes) }
                    );
                    std::fs::write(format!("{out}/{stem}.ttf"), &face.sfnt).expect("write");
                }
                Err(e) => {
                    failed += 1;
                    println!("FAIL {name}: {e}");
                }
            }
        }
    }
    println!("{ok} decoded, {failed} failed");
}
