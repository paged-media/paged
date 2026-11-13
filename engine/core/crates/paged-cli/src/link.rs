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

//! Files into frames, shared by `paged place` and `paged script`.
//!
//! **Raster images** go in as inline bytes (`ReplaceImageBytes`), the one
//! image lane this CLI's documents have: the canvas installs no link
//! resolver, so a `placeImage(uri)` link alone renders nothing.
//!
//! **SVG** goes in as native page items: the engine's own SVG import
//! (`RequestSvgImport`, engine ADR 1031) plans the batch, fitted
//! proportionally and centred in the frame's box, and the frame it
//! stood in for is removed — an SVG has no place *inside* a graphic
//! frame, it becomes the paths, groups and swatches it draws.
//!
//! **After a script**, every link `paged.placeImage` left unresolved is
//! looked up on disk (absolute, `file://`, or relative to the script's
//! folder, the document's folder, then the working directory) and
//! embedded the same way, so a script can say `placeImage(frame,
//! "photo.jpg")` and the saved document carries the picture.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use paged_canvas::channel::{MainToWorkerKind, Mutation, WorkerToMainKind};
use paged_mutate::{PropertyPath, Value};
use paged_wire::{ElementId, PageId};

use crate::engine::Session;

/// Raster formats the engine decodes, from the workspace `image`
/// features. JPEG 2000 is deliberately absent — it is not in that
/// feature list, so a `.jp2` would place and render nothing.
pub const DECODABLE: &[&str] = &["png", "jpg", "jpeg", "webp", "tif", "tiff", "gif", "bmp"];

/// The lower-case extension of `path`, or "".
pub fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default()
}

/// Whether `path` is an SVG (or gzipped SVGZ) file.
pub fn is_svg(path: &Path) -> bool {
    matches!(extension(path).as_str(), "svg" | "svgz")
}

pub fn check_placeable(image: &Path) -> Result<()> {
    let ext = extension(image);
    if DECODABLE.contains(&ext.as_str()) || is_svg(image) {
        return Ok(());
    }
    bail!(
        "the engine decodes {} and imports .svg — {} is {}. Transcode it first; \
         placing bytes it cannot decode leaves the frame blank.",
        DECODABLE.join(" / "),
        image.display(),
        if ext.is_empty() {
            "unnamed".to_string()
        } else {
            format!("a .{ext}")
        }
    )
}

/// A link's file on disk: `file://` and `file:` stripped, percent
/// escapes decoded, then the path itself when absolute, else the first
/// of `bases` that holds it.
pub fn resolve_link(uri: &str, bases: &[PathBuf]) -> Option<PathBuf> {
    let raw = uri
        .strip_prefix("file://")
        .or_else(|| uri.strip_prefix("file:"))
        .unwrap_or(uri);
    let decoded = percent_decode(raw);
    let path = PathBuf::from(&decoded);
    if path.is_absolute() {
        return path.is_file().then_some(path);
    }
    bases.iter().map(|b| b.join(&path)).find(|p| p.is_file())
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn applied(reply: WorkerToMainKind, what: &str) -> Result<()> {
    match reply {
        WorkerToMainKind::MutationApplied { .. } => Ok(()),
        WorkerToMainKind::MutationFailed { error } => Err(anyhow!("{what}: {error}")),
        other => Err(anyhow!("{what}: the engine answered {other:?}")),
    }
}

/// The inner image transform `fit` resolves to for the Rectangle
/// `self_id` holding `bytes`, per [`paged_model::fitting`]. `None` when
/// `fit` names no content fit (`None`, `FrameToContent`) or the frame is
/// not a Rectangle (only Rectangles carry a fitting).
fn fitted_transform(
    session: &Session,
    self_id: &str,
    fit: &str,
    bytes: &[u8],
) -> Result<Option<[f32; 6]>> {
    use paged_model::fitting::{fit_transform, FitMode};
    let Some(mode) = FitMode::from_idml(fit) else {
        return Ok(None);
    };
    let info = paged_raster::probe(bytes).context("read the image's pixel size")?;
    let (w, h) = (info.width, info.height);
    let model = session.model()?;
    let rect = model
        .scene()
        .spreads
        .iter()
        .flat_map(|parsed| &parsed.spread.rectangles)
        .find(|r| r.self_id.as_deref() == Some(self_id));
    Ok(rect.and_then(|r| {
        let reference = r
            .frame_fitting
            .as_ref()
            .and_then(|f| f.reference_point.as_deref());
        fit_transform(mode, reference, r.bounds, w as f32, h as f32)
    }))
}

/// Put raster `bytes` into the graphic frame `frame` (`rectangle:<id>`,
/// also `oval:` / `polygon:`), with an optional fitting and an optional
/// explicit image transform (which wins over the fitting's).
pub fn place_bytes(
    session: &mut Session,
    frame: &str,
    bytes: Vec<u8>,
    fit: Option<&str>,
    transform: Option<[f32; 6]>,
) -> Result<()> {
    let element_id = ElementId::parse(frame)
        .ok_or_else(|| anyhow!("{frame:?} is not an element address — try `rectangle:<id>`"))?;
    let reply = session.send(MainToWorkerKind::Mutate(Mutation::ReplaceImageBytes {
        element_id: frame.to_string(),
        bytes: Some(bytes.clone().into()),
    }))?;
    applied(reply, "place the image")?;
    // Fit and transform are ordinary properties; they ride the same
    // `SetElementProperty` a script would use.
    if let Some(fit) = fit {
        let reply = session.send(MainToWorkerKind::Mutate(Mutation::SetElementProperty {
            element_id: element_id.clone(),
            path: PropertyPath::FrameFittingType,
            value: Value::Text(fit.to_string()),
        }))?;
        applied(reply, "set the fitting")?;
    }
    // A fit is not a flag the picture remembers: InDesign RESOLVES it on
    // place, into the inner `<Image>`'s `ItemTransform`, and writes that
    // transform out. Do the same, so the model, the render and the
    // exported IDML all carry the fitted placement.
    let transform = match (transform, fit) {
        (Some(t), _) => Some(t),
        (None, Some(fit)) => fitted_transform(session, element_id.raw_id(), fit, &bytes)?,
        (None, None) => None,
    };
    if let Some(t) = transform {
        let reply = session.send(MainToWorkerKind::Mutate(Mutation::SetElementProperty {
            element_id,
            path: PropertyPath::ImageContentTransform,
            value: Value::Transform(Some(t)),
        }))?;
        applied(reply, "set the image transform")?;
    }
    Ok(())
}

/// The page a frame stands on and its box there (page-local pt, `[top,
/// left, bottom, right]`): the frame's bounds carried through its
/// transform into its spread, then onto the spread page that holds the
/// box's centre.
pub fn frame_box(session: &Session, self_id: &str) -> Result<(PageId, [f32; 4])> {
    let model = session.model()?;
    let apply = |t: Option<[f32; 6]>, x: f32, y: f32| match t {
        Some([a, b, c, d, e, f]) => (a * x + c * y + e, b * x + d * y + f),
        None => (x, y),
    };
    let spread_box = |bounds: &paged_model::Bounds, t: Option<[f32; 6]>| {
        let corners = [
            apply(t, bounds.left, bounds.top),
            apply(t, bounds.right, bounds.top),
            apply(t, bounds.left, bounds.bottom),
            apply(t, bounds.right, bounds.bottom),
        ];
        let xs = corners.map(|c| c.0);
        let ys = corners.map(|c| c.1);
        let min = |v: [f32; 4]| v.into_iter().fold(f32::INFINITY, f32::min);
        let max = |v: [f32; 4]| v.into_iter().fold(f32::NEG_INFINITY, f32::max);
        [min(ys), min(xs), max(ys), max(xs)]
    };
    for parsed in &model.scene().spreads {
        let s = &parsed.spread;
        let found = s
            .rectangles
            .iter()
            .find(|r| r.self_id.as_deref() == Some(self_id))
            .map(|r| spread_box(&r.bounds, r.item_transform))
            .or_else(|| {
                s.ovals
                    .iter()
                    .find(|o| o.self_id.as_deref() == Some(self_id))
                    .map(|o| spread_box(&o.bounds, o.item_transform))
            })
            .or_else(|| {
                s.polygons
                    .iter()
                    .find(|p| p.self_id.as_deref() == Some(self_id))
                    .map(|p| spread_box(&p.bounds, p.item_transform))
            });
        let Some([t, l, b, r]) = found else { continue };
        let (cx, cy) = ((l + r) / 2.0, (t + b) / 2.0);
        let pages: Vec<(String, [f32; 4])> = s
            .pages
            .iter()
            .filter_map(|p| Some((p.self_id.clone()?, spread_box(&p.bounds, p.item_transform))))
            .collect();
        let (id, [pt, pl, _, _]) = pages
            .iter()
            .find(|(_, [pt, pl, pb, pr])| cx >= *pl && cx <= *pr && cy >= *pt && cy <= *pb)
            .or(pages.first())
            .ok_or_else(|| anyhow!("{self_id} stands on a spread with no page"))?;
        return Ok((PageId(id.clone()), [t - pt, l - pl, b - pt, r - pl]));
    }
    bail!("no graphic frame {self_id} in the document")
}

/// What an SVG import made, for the report line.
pub struct SvgPlaced {
    pub items: u32,
    pub notes: Vec<String>,
}

/// Import the SVG `bytes` as native page items fitted proportionally and
/// centred in the box of the frame `frame`, then remove that frame.
pub fn place_svg(session: &mut Session, frame: &str, bytes: Vec<u8>) -> Result<SvgPlaced> {
    let element_id = ElementId::parse(frame)
        .ok_or_else(|| anyhow!("{frame:?} is not an element address — try `rectangle:<id>`"))?;
    let self_id = element_id.raw_id().to_string();
    let (page_id, [t, l, b, r]) = frame_box(session, &self_id)?;
    let mut plan = |options: paged_svg::SvgImportOptions| -> Result<paged_svg::SvgImportPlan> {
        match session.send(MainToWorkerKind::RequestSvgImport {
            page_id: page_id.clone(),
            bytes: bytes.clone().into(),
            options,
        })? {
            WorkerToMainKind::SvgImportPlanned(plan) => Ok(plan),
            other => bail!("import the SVG: the engine answered {other:?}"),
        }
    };
    // First at its own size, to learn it; then at the scale that fits.
    let natural = plan(paged_svg::SvgImportOptions::default())?;
    if let Some(error) = natural.error {
        bail!("import the SVG: {error}");
    }
    if !(natural.width > 0.0 && natural.height > 0.0) {
        bail!("import the SVG: it draws nothing");
    }
    let (bw, bh) = (r - l, b - t);
    let scale = (bw / natural.width).min(bh / natural.height);
    let (w, h) = (natural.width * scale, natural.height * scale);
    let fitted = plan(paged_svg::SvgImportOptions {
        origin: Some([l + (bw - w) / 2.0, t + (bh - h) / 2.0]),
        scale: Some(scale),
        ..Default::default()
    })?;
    let mutation = fitted.mutation.ok_or_else(|| {
        anyhow!(
            "import the SVG: {}",
            fitted.error.unwrap_or_else(|| "it draws nothing".into())
        )
    })?;
    applied(
        session.send(MainToWorkerKind::Mutate(mutation))?,
        "import the SVG",
    )?;
    applied(
        session.send(MainToWorkerKind::Mutate(Mutation::DeleteFrame {
            frame_id: self_id,
        }))?,
        "remove the frame the SVG replaced",
    )?;
    Ok(SvgPlaced {
        items: fitted.report.items,
        notes: fitted
            .report
            .losses
            .iter()
            .map(ToString::to_string)
            .collect(),
    })
}

/// Engine ADR 1099 — place the PSD `bytes`' layers as frames, the
/// canvas's top-left at the frame `frame`'s, then remove that frame.
pub fn place_psd_layers(session: &mut Session, frame: &str, bytes: Vec<u8>) -> Result<SvgPlaced> {
    let element_id = ElementId::parse(frame)
        .ok_or_else(|| anyhow!("{frame:?} is not an element address — try `rectangle:<id>`"))?;
    let self_id = element_id.raw_id().to_string();
    let (page_id, [t, l, _, _]) = frame_box(session, &self_id)?;
    let plan = match session.send(MainToWorkerKind::RequestPsdLayersPlace {
        page_id,
        bytes: bytes.into(),
        options: paged_canvas::psd_io::PsdPlaceOptions {
            origin: Some([l, t]),
            group: None,
        },
    })? {
        WorkerToMainKind::PsdLayersPlanned(plan) => plan,
        other => bail!("place the PSD's layers: the engine answered {other:?}"),
    };
    let mutation = plan.mutation.ok_or_else(|| {
        anyhow!(
            "place the PSD's layers: {}",
            plan.error.unwrap_or_else(|| "nothing to place".into())
        )
    })?;
    applied(
        session.send(MainToWorkerKind::Mutate(mutation))?,
        "place the PSD's layers",
    )?;
    applied(
        session.send(MainToWorkerKind::Mutate(Mutation::DeleteFrame {
            frame_id: self_id,
        }))?,
        "remove the frame the layers replaced",
    )?;
    Ok(SvgPlaced {
        items: plan.layers,
        notes: plan.losses.iter().map(ToString::to_string).collect(),
    })
}

/// Embed every image link the document cannot resolve but the disk can:
/// `bases` in order (the script's folder, the document's, the working
/// directory). Returns one report line per placed file, and the links
/// still missing.
pub fn embed_links(session: &mut Session, bases: &[PathBuf]) -> Result<(Vec<String>, Vec<String>)> {
    let missing: Vec<_> = session
        .model()?
        .links()
        .into_iter()
        .filter(|l| l.status == "missing")
        .collect();
    let (mut placed, mut unresolved) = (Vec::new(), Vec::new());
    for link in missing {
        let frame = format!(
            "{}:{}",
            link.host_kind.to_ascii_lowercase(),
            link.host_self_id
        );
        let Some(path) = resolve_link(&link.uri, bases) else {
            unresolved.push(format!("{frame} → {} (no such file)", link.uri));
            continue;
        };
        if let Err(e) = check_placeable(&path) {
            unresolved.push(format!("{frame} → {e}"));
            continue;
        }
        let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
        if is_svg(&path) {
            let done = place_svg(session, &frame, bytes)?;
            placed.push(format!(
                "{frame} ← {} (SVG, {} items)",
                path.display(),
                done.items
            ));
        } else {
            let fit = fitting_of(session, &frame);
            let n = bytes.len();
            place_bytes(session, &frame, bytes, fit.as_deref(), None)?;
            placed.push(format!("{frame} ← {} ({n} bytes)", path.display()));
        }
    }
    Ok((placed, unresolved))
}

/// The fitting a frame asks for (`placeImage`'s `fit`), if any.
fn fitting_of(session: &mut Session, frame: &str) -> Option<String> {
    match session.send(MainToWorkerKind::RequestGet {
        address: frame.to_string(),
        path: "frameFittingType".to_string(),
    }) {
        Ok(WorkerToMainKind::PropertyValue { value: Some(v), .. }) => match v {
            Value::Text(s) if !s.is_empty() && s != "None" => Some(s),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jpeg_2000_is_refused_and_svg_is_taken() {
        let err = check_placeable(Path::new("/tmp/photo.jp2")).expect_err("refused");
        assert!(err.to_string().contains("Transcode"), "{err}");
        check_placeable(Path::new("/tmp/photo.JPG")).expect("case-insensitive");
        check_placeable(Path::new("/tmp/logo.svg")).expect("svg");
    }

    #[test]
    fn a_link_resolves_absolute_file_uri_and_relative() {
        let dir = std::env::temp_dir().join(format!("paged-link-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("my photo.png");
        std::fs::write(&file, b"x").unwrap();
        let abs = file.to_string_lossy().to_string();
        assert_eq!(resolve_link(&abs, &[]), Some(file.clone()));
        assert_eq!(
            resolve_link(&format!("file://{abs}"), &[]),
            Some(file.clone())
        );
        assert_eq!(
            resolve_link("my%20photo.png", &[PathBuf::from("/nowhere"), dir.clone()]),
            Some(file.clone())
        );
        assert_eq!(resolve_link("absent.png", std::slice::from_ref(&dir)), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
