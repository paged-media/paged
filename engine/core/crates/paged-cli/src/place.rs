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

//! `paged place` — put an image file into a graphic frame.
//!
//! **Why a verb for one mutation.** Through the `WorkerCore::dispatch`
//! door this CLI drives, a document has exactly one image lane:
//! INLINE BYTES. `build_font_resolver` (`paged-canvas/src/model.rs`)
//! installs a font resolver and nothing else, so the
//! `BytesResolver::link_dirs` lane that would serve a
//! `placeImage(uri)` link is never populated — only the standalone
//! `paged-inspect` binary sets it, from its own `--links-dir`. A
//! `placeImage` link therefore resolves to nothing and the frame
//! renders exactly as before, which is documented behaviour
//! (`apply/place_image.rs`: "a uri the resolver can't serve leaves the
//! frame rendering exactly as before") and a `KNOWN` entry in the
//! render sweep, not a defect.
//!
//! That left `paged.replaceImageBytes(frame, number[])` as the only
//! door, and from a script a photo is a JS array literal of a quarter
//! of a million integers. Recreating a 47-photo brochure that way is
//! ~35 MB of generated JavaScript to say "this JPEG goes in that
//! frame".
//!
//! So: a command that reads the file and sends the SAME mutation. No
//! new wire kind, no new resolver, no protocol change — the engine's
//! vocabulary is unchanged and `Session::send` is still the only door
//! this crate mutates through.
//!
//! An `.svg` is not a picture for a frame but drawing: it goes through
//! the engine's SVG import (`RequestSvgImport`) as native, editable page
//! items fitted into the frame's box, and replaces the frame. `paged
//! script` does the same for every link `paged.placeImage` names
//! (`crate::link`).

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use paged_wire::ElementId;

use crate::engine::Session;
use crate::export::PdfOptions;
use crate::link::{check_placeable, is_svg, place_bytes, place_psd_layers, place_svg};
use crate::options::DocumentOptions;

/// `a,b,c,d,tx,ty` — the placed image's own transform, in the same
/// order IDML writes an `ItemTransform`.
fn parse_transform(spec: &str) -> Result<[f32; 6]> {
    let parts: Vec<&str> = spec.split(',').map(str::trim).collect();
    if parts.len() != 6 {
        bail!("--transform wants six comma-separated numbers a,b,c,d,tx,ty, got {spec:?}");
    }
    let mut out = [0.0f32; 6];
    for (slot, text) in out.iter_mut().zip(parts) {
        *slot = text
            .parse::<f32>()
            .with_context(|| format!("--transform component {text:?}"))?;
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
pub fn run(
    doc: &Path,
    assets: &DocumentOptions,
    frame: &str,
    image: &Path,
    fit: Option<&str>,
    transform: Option<&str>,
    layers: bool,
    out: Option<&PathBuf>,
    pdf: &PdfOptions,
) -> Result<()> {
    if !layers {
        check_placeable(image)?;
    }
    let bytes = std::fs::read(image).with_context(|| format!("read {}", image.display()))?;
    // Parsed before the session opens: a typo in the address should
    // cost a message, not a document load.
    ElementId::parse(frame)
        .ok_or_else(|| anyhow!("{frame:?} is not an element address — try `rectangle:<id>`"))?;
    let transform = transform.map(parse_transform).transpose()?;

    let mut session = Session::new();
    assets.open(&mut session, doc)?;

    let n = bytes.len();
    let what = if layers {
        // A PSD's layers become frames; the frame they stood in for goes
        // (`link::place_psd_layers`).
        let done = place_psd_layers(&mut session, frame, bytes)?;
        for note in &done.notes {
            eprintln!("psd: {note}");
        }
        format!("PSD, {} layers", done.items)
    } else if is_svg(image) {
        // An SVG becomes native page items in the frame's box; the
        // frame it stood in for goes (`link::place_svg`).
        let done = place_svg(&mut session, frame, bytes)?;
        for note in &done.notes {
            eprintln!("svg: {note}");
        }
        format!("SVG, {} items", done.items)
    } else {
        place_bytes(&mut session, frame, bytes, fit, transform)?;
        format!("{n} bytes")
    };

    match out {
        // The mutation landed in the loaded model and the process is
        // about to end, which would throw it away. Say so rather than
        // reporting a success the file will not show.
        None => {
            eprintln!(
                "{frame}: {what} placed in the loaded document. \
                 Nothing saved — pass -o to write the result."
            );
            Ok(())
        }
        Some(dest) => {
            let format = crate::export::format_for(dest)?;
            let out_bytes = crate::export::export_bytes(&mut session, format, pdf)?;
            std::fs::write(dest, &out_bytes)
                .with_context(|| format!("write {}", dest.display()))?;
            println!(
                "{frame} ← {} ({what}) → {} — {format}, {} bytes",
                image.display(),
                dest.display(),
                out_bytes.len()
            );
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_transform_is_six_numbers() {
        assert_eq!(
            parse_transform("0.48, 0, 0, 0.48, -1.01, 91.13").expect("parses"),
            [0.48, 0.0, 0.0, 0.48, -1.01, 91.13]
        );
        assert!(parse_transform("1,0,0,1,0").is_err());
        assert!(parse_transform("1,0,0,1,0,x").is_err());
    }
}
