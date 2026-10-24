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

//! Engine ADR 1016 — Photoshop's blend modes through the canvas model: a
//! frame set to Linear Burn draws differently from Normal and undoes; the
//! IDML export writes the nearest InDesign mode and reports it; `.paged`
//! keeps the mode; the PDF export rasterises the group and says so.

use std::io::Write;

use paged_canvas::{channel::Mutation, CanvasModel, CanvasOptions, PageId};
use paged_compose::{BlendMode, DisplayCommand};
use paged_mutate::Value;
use paged_wire::{ElementId, VirtualTarget};

/// A red square under a half-overlapping blue square (`top`).
fn build_idml() -> Vec<u8> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let spread = r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 200 200"/>
    <Rectangle Self="under" GeometricBounds="20 20 120 120" FillColor="Color/Red" StrokeWeight="0"/>
    <Rectangle Self="top" GeometricBounds="70 70 170 170" FillColor="Color/Blue" StrokeWeight="0"/>
  </Spread>
</idPkg:Spread>"#;
    let buf = std::io::Cursor::new(Vec::new());
    let mut zip = ZipWriter::new(buf);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/vnd.adobe.indesign-idml-package")
        .unwrap();
    zip.start_file("designmap.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <idPkg:Graphic src="Resources/Graphic.xml"/>
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
</Document>"#,
    )
    .unwrap();
    zip.start_file("Resources/Graphic.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Color Self="Color/Red" Model="Process" Space="RGB" ColorValue="230 60 40" Name="Red"/>
  <Color Self="Color/Blue" Model="Process" Space="RGB" ColorValue="60 120 220" Name="Blue"/>
</idPkg:Graphic>"#,
    )
    .unwrap();
    zip.start_file("Spreads/Spread_sp1.xml", deflated).unwrap();
    zip.write_all(spread.as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

fn top() -> VirtualTarget {
    VirtualTarget::Element {
        element_id: ElementId::Rectangle("top".into()),
    }
}

fn set(m: &mut CanvasModel, path: &str, mode: &str) {
    m.apply_mutation(&Mutation::Set {
        address: top().into(),
        path: path.to_string(),
        value: Value::Text(mode.into()),
    })
    .expect(path);
}

fn load() -> CanvasModel {
    CanvasModel::load("blend-27", &build_idml(), CanvasOptions::default()).expect("load")
}

fn page_list(m: &CanvasModel) -> &paged_compose::DisplayList {
    let page = PageId(m.pages()[0].self_id.clone());
    m.display_list_for_page(&page).expect("display list")
}

fn render(m: &CanvasModel) -> Vec<u8> {
    let mut opts = paged_gpu::RasterOptions::new(200.0, 200.0);
    opts.dpi = 36.0;
    paged_gpu::vcpu::rasterize(page_list(m), &opts).into_raw()
}

fn group_modes(m: &CanvasModel) -> Vec<BlendMode> {
    page_list(m)
        .commands
        .iter()
        .filter_map(|c| match c {
            DisplayCommand::BeginBlendGroup { blend_mode, .. } => Some(*blend_mode),
            DisplayCommand::FillPathBlend { blend_mode, .. } => Some(*blend_mode),
            _ => None,
        })
        .filter(|m| *m != BlendMode::Normal)
        .collect()
}

#[test]
#[allow(non_snake_case)]
fn a_photoshop_mode_is_set_drawn_and_undone__feat__effects_transparency_blend_modes_27() {
    let mut m = load();
    let normal = render(&m);
    for (path, mode) in [
        ("frameBlendMode", "LinearBurn"),
        ("frameFillBlendMode", "Divide"),
    ] {
        set(&mut m, path, mode);
        assert_eq!(
            m.get_property(&top(), path),
            Ok(Value::Text(mode.into())),
            "{path}"
        );
        let want = BlendMode::from_name(mode).unwrap();
        assert!(
            group_modes(&m).contains(&want),
            "{path}: {:?}",
            group_modes(&m)
        );
        // Photoshop modes never reach the rasterizer as a fill blend.
        assert!(!page_list(&m).commands.iter().any(|c| matches!(
            c,
            DisplayCommand::FillPathBlend { blend_mode, .. } if !blend_mode.is_native()
        )));
        assert_ne!(render(&m), normal, "{mode} draws differently");
        m.undo().expect("undo");
        assert_eq!(render(&m), normal, "undo restores the picture");
        assert!(group_modes(&m).is_empty());
    }
}

#[test]
#[allow(non_snake_case)]
fn the_idml_export_writes_the_nearest_mode_and_reports__feat__effects_transparency_blend_modes_27()
{
    let mut m = load();
    let clean = m.idml_export_losses();
    set(&mut m, "frameBlendMode", "LinearBurn");
    let losses: Vec<String> = m
        .idml_export_losses()
        .into_iter()
        .filter(|l| !clean.contains(l))
        .collect();
    assert_eq!(losses.len(), 1, "{losses:?}");
    for want in ["LinearBurn", "`top`", "Multiply", ".paged"] {
        assert!(losses[0].contains(want), "{want}: {}", losses[0]);
    }
    // The written file never carries a mode InDesign cannot read (the
    // writer's mapping is pinned in idml-export's tests).
    let bytes = m.export_idml().expect("export");
    let twin = idml_import::import_idml_doc(&bytes).expect("re-import");
    let r = twin.spreads[0]
        .spread
        .rectangles
        .iter()
        .find(|r| r.self_id.as_deref() == Some("top"))
        .expect("top");
    assert_ne!(r.blend_mode.as_deref(), Some("LinearBurn"));
    // A native mode is written as itself and is no loss.
    set(&mut m, "frameBlendMode", "Screen");
    assert_eq!(m.idml_export_losses(), clean);
}

#[test]
#[allow(non_snake_case)]
fn paged_keeps_a_photoshop_mode__feat__effects_transparency_blend_modes_27() {
    let mut m = load();
    set(&mut m, "frameBlendMode", "HardMix");
    m.refresh_model_part().expect("refresh model part");
    let bytes = m
        .export_paged(paged_canvas::channel::PROTOCOL_VERSION.0)
        .expect("export .paged");
    let reloaded =
        CanvasModel::load("blend-27-reloaded", &bytes, CanvasOptions::default()).expect("reload");
    assert_eq!(
        reloaded.get_property(&top(), "frameBlendMode"),
        Ok(Value::Text("HardMix".into()))
    );
}
