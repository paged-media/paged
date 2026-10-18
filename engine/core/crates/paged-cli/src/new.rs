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

//! `paged new` — a blank document, through the same door File ▸ New
//! uses.

use std::path::Path;

use anyhow::{bail, Result};
use paged_canvas::channel::{MainToWorkerKind, WorkerToMainKind};

use crate::engine::Session;
use crate::expect_reply;

/// Page sizes worth not making the caller look up, in points.
fn named_size(name: &str) -> Option<(f32, f32)> {
    Some(match name.to_ascii_lowercase().as_str() {
        "letter" => (612.0, 792.0),
        "legal" => (612.0, 1008.0),
        "tabloid" => (792.0, 1224.0),
        "a3" => (841.89, 1190.55),
        "a4" => (595.28, 841.89),
        "a5" => (419.53, 595.28),
        _ => return None,
    })
}

/// `letter` / `a4` / … or `WIDTHxHEIGHT` in points.
pub fn parse_size(spec: &str) -> Result<(f32, f32)> {
    if let Some(size) = named_size(spec) {
        return Ok(size);
    }
    if let Some((w, h)) = spec.split_once(['x', 'X', '\u{d7}']) {
        if let (Ok(w), Ok(h)) = (w.trim().parse::<f32>(), h.trim().parse::<f32>()) {
            if w > 0.0 && h > 0.0 {
                return Ok((w, h));
            }
        }
    }
    bail!("--size wants a name (letter, legal, tabloid, a3, a4, a5) or WxH in points, got {spec:?}")
}

pub fn run(size: &str, out: &Path, format: &str) -> Result<()> {
    let (width_pt, height_pt) = parse_size(size)?;
    let mut session = Session::new();
    let reply = session.send(MainToWorkerKind::NewBlankDocument {
        width_pt,
        height_pt,
        font: None,
    })?;
    expect_reply!(reply, WorkerToMainKind::DocumentLoaded(h) => h, "new blank document")?;

    let reply = match format {
        "paged" => session.send(MainToWorkerKind::ExportPaged {})?,
        "idml" => session.send(MainToWorkerKind::ExportIdml { link_base: None })?,
        other => bail!("unsupported format {other:?} (idml|paged)"),
    };
    let bytes = match reply {
        WorkerToMainKind::PagedExported { bytes } => bytes.into_vec(),
        WorkerToMainKind::IdmlExported { idml_bytes, .. } => idml_bytes.into_vec(),
        other => bail!("write the new document: the engine answered {other:?}"),
    };
    std::fs::write(out, &bytes)?;
    println!(
        "{} — one {width_pt:.0} × {height_pt:.0} pt page, {format}, {} bytes",
        out.display(),
        bytes.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_size;

    #[test]
    fn a_size_is_a_name_or_a_measurement() {
        assert_eq!(parse_size("letter").unwrap(), (612.0, 792.0));
        assert_eq!(parse_size("A4").unwrap().0.round(), 595.0);
        assert_eq!(parse_size("300x400").unwrap(), (300.0, 400.0));
        assert_eq!(parse_size("300 × 400").unwrap(), (300.0, 400.0));
        assert!(parse_size("huge").is_err());
        assert!(parse_size("0x400").is_err(), "a page has area");
    }
}
