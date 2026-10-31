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

//! PHOTOSHOP-WRITTEN RULER GUIDES, replayed in CI (image ADR 475).
//! `scripts/photoshop/probes/guides.jsx` had Photoshop place guides in
//! small documents — whole and fractional pixels, outside the canvas, one
//! placed in inches at 300 ppi, and none — and save each as a PSD; the
//! probe recorded the positions Photoshop reports for them.
//!
//! Per case: paged-psd's typed grid-and-guides record (id 1032) must read
//! exactly those positions, the workspace must adopt them, the record
//! re-encoded from the typed view must be Photoshop's own bytes, and the
//! untouched file must write back byte for byte.

use std::path::PathBuf;

use image_js::workspace::Workspace;
use image_psd::model::{ImageResources, ResourceBody};
use image_psd::PsdFile;

fn read(case: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/photoshop/guides")
        .join(format!("{case}.psd"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

/// What Photoshop 27.10 reported (`guides.photoshop.json`):
/// `(case, [(vertical, px)])`.
const EXPECT: &[(&str, &[(bool, f64)])] = &[
    (
        "whole-pixels",
        &[(true, 10.0), (false, 20.0), (true, 32.0), (false, 0.0)],
    ),
    (
        "fractional",
        &[(true, 12.5), (false, 0.25), (true, 33.03125)],
    ),
    ("outside", &[(true, -8.0), (false, 80.0)]),
    ("inches-300ppi", &[(true, 30.0)]),
    ("none", &[]),
];

/// The 1032 block as the file holds it, if any.
fn raw_1032(r: &ImageResources) -> Option<Vec<u8>> {
    r.blocks
        .iter()
        .find(|b| b.id == 1032)
        .and_then(|b| b.raw_block.clone())
}

#[test]
fn photoshop_guides_read_exactly_and_re_encode_to_photoshops_bytes() {
    for (case, want) in EXPECT {
        let bytes = read(case);
        let file = PsdFile::parse(&bytes).unwrap_or_else(|e| panic!("{case}: {e}"));
        let got: Vec<(bool, f64)> = file
            .resources
            .guides()
            .iter()
            .map(|g| (!g.horizontal, g.pixels()))
            .collect();
        assert_eq!(&got, want, "{case}: the typed guides");

        // The workspace adopts them as image-pixel guides.
        let ws = Workspace::guides_from_psd(file.resources.guides());
        assert_eq!(ws.len(), want.len(), "{case}");
        for (g, (vertical, px)) in ws.iter().zip(want.iter()) {
            assert_eq!(g.vertical, *vertical, "{case}");
            assert_eq!(f64::from(g.pos), *px, "{case}");
        }

        // Untouched: byte for byte.
        assert_eq!(file.write().unwrap(), bytes, "{case}: zero-edit write");

        // Re-encoded from the typed view: Photoshop's own block bytes.
        if let Some(raw) = raw_1032(&file.resources) {
            let mut edited = file.clone();
            for b in &mut edited.resources.blocks {
                if b.id == 1032 {
                    assert!(
                        matches!(b.body, ResourceBody::GridAndGuides(_)),
                        "{case}: 1032 is typed"
                    );
                    b.raw_block = None;
                }
            }
            assert_eq!(
                raw_1032(&PsdFile::parse(&edited.write().unwrap()).unwrap().resources),
                Some(raw),
                "{case}: the canonical re-encode is Photoshop's record"
            );
        }
    }
}

#[test]
fn guides_written_through_the_workspace_read_back_as_photoshop_placed_them() {
    // Drop the record from Photoshop's "none" file, write the guides of
    // "fractional" through the workspace, and read them back.
    let mut file = PsdFile::parse(&read("none")).unwrap();
    let source = PsdFile::parse(&read("fractional")).unwrap();
    let ws = Workspace {
        guides: Workspace::guides_from_psd(source.resources.guides()),
        ..Workspace::default()
    };
    file.resources.set_guides(&ws.psd_guides());
    let back = PsdFile::parse(&file.write().unwrap()).unwrap();
    assert_eq!(back.resources.guides(), source.resources.guides());
}
