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

//! Write the files the Photoshop oracle opens (ADR 1038): the layered
//! TIFF `paged-raster` writes from a synthetic layered PSD, and a
//! scene-linear OpenEXR and Radiance HDR file.
//!
//!     cargo run -p paged-raster --example oracle_files -- <dir>
//!
//! `modules/image/scripts/photoshop/probes/codecs-open.jsx` opens them;
//! the replay (`tests/it/oracle.rs`) regenerates every file, checks it is
//! byte-identical to the recorded copy, and holds this crate's reading of
//! it to Photoshop's.

#[path = "../tests/it/oracle_files.rs"]
mod oracle_files;

fn main() {
    let dir = std::env::args().nth(1).expect("usage: oracle_files <dir>");
    let dir = std::path::Path::new(&dir);
    std::fs::create_dir_all(dir).unwrap();
    for (name, bytes) in oracle_files::oracle_files() {
        std::fs::write(dir.join(name), bytes).unwrap();
        println!("{}", dir.join(name).display());
    }
}
