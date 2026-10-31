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

//! Engine ADR 1048 — gradient meshes and freeform gradients on IDML
//! export.
//!
//! IDML has neither. [`lower_for_idml`] moves each frame's fill into the
//! frame's label (`paged:fillMesh`, JSON), so InDesign shows — and keeps —
//! the frame's swatch and the label, and a paged import restores the
//! mesh from it (`idml_import`'s spread reader). [`mesh_fill_losses`]
//! reports every such frame, and checks against the re-imported twin
//! that the label made the trip.

use paged_model::{MeshFill, MESH_FILL_LABEL_KEY};
use paged_scene::Document;

/// `(kind, id, fill)` for every frame with a mesh fill.
fn mesh_frames(doc: &Document) -> Vec<(&'static str, String, &MeshFill)> {
    fn push<'a>(
        out: &mut Vec<(&'static str, String, &'a MeshFill)>,
        kind: &'static str,
        id: &Option<String>,
        fill: &'a Option<Box<MeshFill>>,
    ) {
        if let (Some(id), Some(fill)) = (id, fill.as_deref()) {
            out.push((kind, id.clone(), fill));
        }
    }
    let mut out = Vec::new();
    for parsed in &doc.spreads {
        let sp = &parsed.spread;
        for f in &sp.text_frames {
            push(&mut out, "text frame", &f.self_id, &f.fill_mesh);
        }
        for r in &sp.rectangles {
            push(&mut out, "rectangle", &r.self_id, &r.fill_mesh);
        }
        for o in &sp.ovals {
            push(&mut out, "oval", &o.self_id, &o.fill_mesh);
        }
        for p in &sp.polygons {
            push(&mut out, "polygon", &p.self_id, &p.fill_mesh);
        }
    }
    out
}

/// Move every frame's mesh fill into its label, in `scene` (the export's
/// own copy). The frame keeps its swatch, which is what InDesign shows.
pub(crate) fn lower_for_idml(scene: &mut Document) {
    for parsed in &mut scene.spreads {
        let sp = &mut parsed.spread;
        let mut moved: Vec<(String, String)> = Vec::new();
        let mut take = |id: &Option<String>, fill: &mut Option<Box<MeshFill>>| {
            if let (Some(id), Some(f)) = (id, fill.take()) {
                if let Ok(json) = serde_json::to_string(&*f) {
                    moved.push((id.clone(), json));
                }
            }
        };
        for f in &mut sp.text_frames {
            take(&f.self_id, &mut f.fill_mesh);
        }
        for r in &mut sp.rectangles {
            take(&r.self_id, &mut r.fill_mesh);
        }
        for o in &mut sp.ovals {
            take(&o.self_id, &mut o.fill_mesh);
        }
        for p in &mut sp.polygons {
            take(&p.self_id, &mut p.fill_mesh);
        }
        for (id, json) in moved {
            let entries = sp.labels.entry(id).or_default();
            match entries.iter_mut().find(|(k, _)| k == MESH_FILL_LABEL_KEY) {
                Some(slot) => slot.1 = json,
                None => entries.push((MESH_FILL_LABEL_KEY.to_string(), json)),
            }
        }
    }
}

fn what(fill: &MeshFill) -> &'static str {
    match fill {
        MeshFill::Mesh(_) => "gradient mesh",
        MeshFill::Freeform(_) => "freeform gradient",
    }
}

/// One line per frame whose mesh fill IDML cannot say, checked against
/// `twin` (the export re-imported, which restores the fill from its
/// label) where there is one.
pub(crate) fn mesh_fill_losses(scene: &Document, twin: Option<&Document>) -> Vec<String> {
    let twin_frames = twin.map(mesh_frames).unwrap_or_default();
    mesh_frames(scene)
        .into_iter()
        .map(|(kind, id, fill)| {
            let carried = twin.is_none()
                || twin_frames
                    .iter()
                    .any(|(_, tid, tf)| *tid == id && *tf == fill);
            if carried {
                format!(
                    "the {} of {kind} `{id}` is a paged-native paint — IDML has none, so \
                     InDesign shows the frame's swatch; the fill rides in the frame's label and \
                     a paged import restores it. Save as `.paged` to keep it everywhere.",
                    what(fill)
                )
            } else {
                format!(
                    "the {} of {kind} `{id}` is a paged-native paint — IDML has none, and the \
                     label meant to carry it did not survive the export. Save as `.paged` to \
                     keep it.",
                    what(fill)
                )
            }
        })
        .collect()
}
