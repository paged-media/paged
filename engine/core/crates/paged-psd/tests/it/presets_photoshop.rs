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

//! The preset files a Photoshop installation ships (`.grd`, `.pat`,
//! `.asl`), read and written back. They are Adobe's and are never
//! committed: point `PAGED_PHOTOSHOP_PRESETS` at a directory holding them
//! (an installation's `Presets` folder and the application bundle's
//! `Contents/Required`, say). Without it the test reports `unavailable`;
//! `PAGED_REQUIRE_TOOLS=1` turns that into a failure.

use std::path::{Path, PathBuf};

use paged_psd::presets::{read_asl, read_grd, read_pat, write_asl, write_grd, write_pat};
use paged_test_resources::{skip, Resource};

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, out);
        } else if matches!(
            p.extension().and_then(|x| x.to_str()),
            Some("grd" | "pat" | "asl")
        ) {
            out.push(p);
        }
    }
}

#[test]
#[allow(non_snake_case)]
fn photoshop_preset_files_read_whole_and_round_trip__feat__image_editor_snapshots_presets() {
    let Some(dir) = std::env::var_os("PAGED_PHOTOSHOP_PRESETS") else {
        skip!(Resource::Tools, "PAGED_PHOTOSHOP_PRESETS is not set");
    };
    let mut files = Vec::new();
    walk(Path::new(&dir), &mut files);
    if files.is_empty() {
        skip!(
            Resource::Tools,
            "no .grd/.pat/.asl under PAGED_PHOTOSHOP_PRESETS"
        );
    }
    for f in files {
        let bytes = std::fs::read(&f).expect("read");
        let name = f.display();
        match f.extension().and_then(|x| x.to_str()) {
            Some("grd") => {
                let g = read_grd(&bytes).unwrap_or_else(|e| panic!("{name}: {e}"));
                assert!(!g.gradients.is_empty(), "{name}: no gradients");
                let back = read_grd(&write_grd(&g.gradients)).expect("re-read");
                assert_eq!(back.gradients.len(), g.gradients.len(), "{name}");
                for (a, b) in back.gradients.iter().zip(&g.gradients) {
                    assert_eq!(
                        (&a.name, &a.stops, &a.opacity_stops),
                        (&b.name, &b.stops, &b.opacity_stops),
                        "{name}"
                    );
                }
            }
            Some("pat") => {
                let p = read_pat(&bytes).unwrap_or_else(|e| panic!("{name}: {e}"));
                assert!(p.skipped.is_empty(), "{name}: {:?}", p.skipped);
                let back = read_pat(&write_pat(&p.patterns)).expect("re-read");
                assert_eq!(back.patterns, p.patterns, "{name}");
            }
            _ => {
                let s = read_asl(&bytes).unwrap_or_else(|e| panic!("{name}: {e}"));
                assert!(s.skipped.is_empty(), "{name}: {:?}", s.skipped);
                let back = read_asl(&write_asl(&s.styles, &s.patterns)).expect("re-read");
                assert_eq!(back.patterns, s.patterns, "{name}");
                assert_eq!(back.styles.len(), s.styles.len(), "{name}");
                for (a, b) in back.styles.iter().zip(&s.styles) {
                    assert_eq!(a.name, b.name, "{name}");
                    assert_eq!(
                        a.style.enabled_keys(),
                        b.style.enabled_keys(),
                        "{name}: {}",
                        a.name
                    );
                }
            }
        }
    }
}
