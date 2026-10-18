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

//! `paged render` — a page to a PNG, the way the editor rasterises it.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use paged_canvas::channel::{MainToWorkerKind, WorkerToMainKind};

use crate::engine::Session;
use crate::expect_reply;
use crate::options::DocumentOptions;

/// Resolve `--page` — a 1-based number or a literal page id — against
/// the loaded document.
fn resolve_page(ids: &[paged_canvas::PageId], spec: &str) -> Result<paged_canvas::PageId> {
    if let Ok(n) = spec.parse::<usize>() {
        return ids
            .get(n.checked_sub(1).context("--page is 1-based")?)
            .cloned()
            .with_context(|| format!("page {n} of {}", ids.len()));
    }
    ids.iter()
        .find(|id| id.0 == spec)
        .cloned()
        .with_context(|| format!("no page with id {spec:?}"))
}

#[allow(clippy::too_many_arguments)]
pub fn run(
    doc: &Path,
    opts: &DocumentOptions,
    page: Option<String>,
    all: bool,
    dpi: f32,
    out: &Path,
) -> Result<()> {
    let mut session = Session::new();
    let handle = opts.open(&mut session, doc)?;
    render_pages(&mut session, &handle, page, all, dpi, out)
}

/// Rasterise from an already-open session, so `paged script` can render
/// what it just authored without reloading (and without the reload
/// silently discarding the script's work).
pub fn render_pages(
    session: &mut Session,
    handle: &paged_canvas::DocumentHandle,
    page: Option<String>,
    all: bool,
    dpi: f32,
    out: &Path,
) -> Result<()> {
    let targets: Vec<paged_canvas::PageId> = if all {
        handle.page_ids.clone()
    } else {
        let spec = page.unwrap_or_else(|| "1".to_string());
        vec![resolve_page(&handle.page_ids, &spec)?]
    };
    if targets.len() > 1 && !out.is_dir() {
        bail!(
            "--all writes one file per page, so -o must be a directory ({} is not)",
            out.display()
        );
    }

    for (n, page_id) in targets.iter().enumerate() {
        let index = handle
            .page_ids
            .iter()
            .position(|p| p == page_id)
            .unwrap_or(n);
        let width_pt = handle
            .page_sizes_pt
            .get(index)
            .map(|s| s.0)
            .context("page size")?;
        // Match `pdftoppm -r DPI`, which is what every reference
        // rasterisation in this workspace is produced with.
        let target_width_px = (width_pt * dpi / 72.0).round().max(1.0) as u32;

        let reply = session.send(MainToWorkerKind::RequestSnapshot {
            page_id: page_id.clone(),
            target_width_px,
            dpi: Some(dpi),
            hide_items: Vec::new(),
        })?;
        let png = expect_reply!(reply, WorkerToMainKind::SnapshotReady(p) => p,
            format!("render page {}", index + 1))?;

        let path: PathBuf = if targets.len() > 1 {
            out.join(format!("page-{:03}.png", index + 1))
        } else {
            out.to_path_buf()
        };
        std::fs::write(&path, &png.png_bytes)
            .with_context(|| format!("write {}", path.display()))?;
        println!(
            "{} — page {} at {} dpi, {}×{} px",
            path.display(),
            index + 1,
            dpi,
            png.width_px,
            png.height_px
        );
    }
    Ok(())
}
