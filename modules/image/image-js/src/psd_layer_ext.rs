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

//! The parts of a PSD layer record the plate does not carry, read for the
//! layer stack and written back: fill opacity (`iOpa`), knockout (`knko`),
//! the locks (`lspf`), the colour label (`lclr`), the BLENDING RANGES
//! (Blend If, the record's own section) and the content of a FILL LAYER
//! (`SoCo` solid colour, `GdFl` gradient).
//!
//! Reading a block this module does not understand leaves the layer as
//! the import made it — a pattern fill (`PtFl`, whose pixels live in the
//! document's pattern block) stays a pixel layer of its stored render, a
//! gradient with transparency or noise stays pixels — so nothing is
//! approximated.
//!
//! Provenance: Adobe Photoshop File Formats specification — Layer records
//! (blending ranges: per channel 2 black then 2 white values of the
//! source, then of the destination), Additional Layer Information (`iOpa`
//! fill opacity, `knko` knockout, `lspf` protection flags — transparency,
//! composite and position in bits 0–2 —, `lclr` sheet colour, `SoCo`,
//! `GdFl` and `PtFl` fill content, each a version-16 descriptor), and the
//! descriptor structure [PUB]. The gradient descriptor's keys (`Grad`,
//! `Clrs`, `Clrt`, `Lctn` on 0–4096, `Trns`, `Type`, `Angl`, `Scl `,
//! `Rvrs`, `Ofst`) follow the specification's descriptor key list [PUB].

use image_psd::descriptor::{
    build, read_versioned_descriptor, versioned_descriptor_bytes, Descriptor, DescriptorValue,
};
use image_psd::model::{AdditionalLayerInfo, AddlBody, LayerRecord};
use image_psd::reader::ByteReader;

use crate::fill::GradientKind;
use crate::layers::{
    BlendIf, BlendIfChannel, ColorStop, FillSource, GradientFill, Knockout, LayerExt, LayerLocks,
};

/// A block's data: after the signature, key and 4-byte length (the
/// length bounds it; the pad is left out).
fn payload(a: &AdditionalLayerInfo) -> &[u8] {
    let Some(raw) = a.raw_block.as_deref() else {
        return &[];
    };
    let Some(len) = raw.get(8..12) else {
        return &[];
    };
    let n = u32::from_be_bytes(len.try_into().expect("4 bytes")) as usize;
    raw.get(12..12 + n).unwrap_or(&[])
}

fn block<'a>(rec: &'a LayerRecord, key: &[u8; 4]) -> Option<&'a [u8]> {
    rec.addl.iter().find(|a| &a.key == key).map(payload)
}

/// The record's blending ranges as Blend If (gray, then red, green, blue:
/// This Layer's black pair and white pair, then the Underlying's), or
/// `None` when they pass everything.
pub fn blend_if(rec: &LayerRecord) -> Option<BlendIf> {
    let raw = &rec.blend_ranges.raw;
    if raw.len() < 8 {
        return None;
    }
    let mut bi = BlendIf::default();
    for (ch, c) in bi.channels.iter_mut().enumerate() {
        let Some(r) = raw.get(ch * 8..ch * 8 + 8) else {
            break;
        };
        let pair = |s: &[u8]| {
            let (b0, b1) = (s[0].min(s[1]), s[0].max(s[1]));
            let (w0, w1) = (s[2].min(s[3]), s[2].max(s[3]));
            [b0, b1, w0, w1]
        };
        *c = BlendIfChannel {
            this: pair(&r[0..4]),
            under: pair(&r[4..8]),
        };
    }
    (!bi.is_open()).then_some(bi)
}

/// The record's blending-ranges section for `bi`: gray, red, green, blue,
/// each This Layer's four values then the Underlying's (`None` = all
/// open, the defaults Photoshop writes).
pub fn blend_ranges_bytes(bi: Option<&BlendIf>) -> Vec<u8> {
    bi.copied().unwrap_or_default().to_bytes().to_vec()
}

/// Fill opacity, knockout, the extra locks and the colour label of a
/// record; the image-pixels lock is [`pixels_locked`].
pub fn record_ext(rec: &LayerRecord) -> LayerExt {
    let fill = block(rec, b"iOpa")
        .and_then(|b| b.first().copied())
        .unwrap_or(255);
    let knockout = match block(rec, b"knko").and_then(|b| b.first().copied()) {
        Some(1) => Knockout::Shallow,
        Some(2) => Knockout::Deep,
        _ => Knockout::None,
    };
    let lspf = protection(rec);
    let color = block(rec, b"lclr")
        .and_then(|b| b.get(0..2))
        .map(|b| u16::from_be_bytes([b[0], b[1]]).min(7) as u8)
        .unwrap_or(0);
    LayerExt {
        fill_opacity: f32::from(fill) / 255.0,
        blend_if: blend_if(rec).map(Box::new),
        knockout,
        locks: LayerLocks {
            transparency: lspf & 1 != 0,
            position: lspf & 4 != 0,
            all: lspf & 0x8000_0000 != 0,
        },
        color,
        link: None,
        style: style_of(rec).map(std::sync::Arc::new),
        style_options: style_options(rec),
        vector_mask: None,
        source: None,
    }
}

/// The record's layer STYLE (`lmfx`, else `lfx2`), when it has one.
pub fn style_of(rec: &LayerRecord) -> Option<image_psd::effects::LayerStyle> {
    // The engine's reader (paged-psd), which the page items' effect
    // mapping (paged-psd-fx, engine ADR 1044) reads the same blocks with.
    image_psd::effects::layer_style(rec)
}

/// Blending Options ▸ Advanced Blending: `infx` (Blend Interior Effects
/// as Group), `clbl` (Blend Clipped Layers as Group), `tsly`
/// (Transparency Shapes Layer), `lmgm` / `vmgm` (Layer / Vector Mask
/// Hides Effects) — each one flag byte [PUB].
pub fn style_options(rec: &LayerRecord) -> crate::layers::StyleOptions {
    let flag = |k: &[u8; 4], default: bool| {
        block(rec, k)
            .and_then(|b| b.first().copied())
            .map_or(default, |b| b != 0)
    };
    crate::layers::StyleOptions {
        blend_interior: flag(b"infx", false),
        blend_clipped: flag(b"clbl", true),
        transparency_shapes: flag(b"tsly", true),
        mask_hides_effects: flag(b"lmgm", false),
        vector_mask_hides_effects: flag(b"vmgm", false),
    }
}

/// The blocks a layer's STYLE needs on save: the style (`lfx2`, or `lmfx`
/// with several instances of an effect, written by `paged-psd`'s
/// descriptor writer) and the blending options that differ from
/// Photoshop's defaults.
pub fn style_blocks(ext: &LayerExt) -> Vec<AdditionalLayerInfo> {
    let mut out = Vec::new();
    if let Some(style) = &ext.style {
        out.push(raw_block(style.block_key(), &style.to_payload()));
    }
    let o = ext.style_options;
    let d = crate::layers::StyleOptions::default();
    for (key, on, default) in [
        (*b"infx", o.blend_interior, d.blend_interior),
        (*b"clbl", o.blend_clipped, d.blend_clipped),
        (*b"tsly", o.transparency_shapes, d.transparency_shapes),
        (*b"lmgm", o.mask_hides_effects, d.mask_hides_effects),
        (
            *b"vmgm",
            o.vector_mask_hides_effects,
            d.vector_mask_hides_effects,
        ),
    ] {
        if on != default {
            out.push(raw_block(key, &[u8::from(on), 0, 0, 0]));
        }
    }
    out
}

fn protection(rec: &LayerRecord) -> u32 {
    block(rec, b"lspf")
        .and_then(|b| b.get(0..4))
        .map(|b| u32::from_be_bytes(b.try_into().expect("4 bytes")))
        .unwrap_or(0)
}

/// The record's image-pixels lock (`lspf` bit 1, "composite").
pub fn pixels_locked(rec: &LayerRecord) -> bool {
    protection(rec) & 2 != 0
}

/// A colour descriptor (`RGBC`, or `Grsc` grey) as RGB8.
fn color_of(d: &Descriptor) -> Option<[u8; 3]> {
    let c = |v: f64| v.round().clamp(0.0, 255.0) as u8;
    if let (Some(r), Some(g), Some(b)) = (d.number(b"Rd  "), d.number(b"Grn "), d.number(b"Bl  ")) {
        return Some([c(r), c(g), c(b)]);
    }
    // Grey is ink percent: 0 white, 100 black.
    let k = d.number(b"Gry ")?;
    let v = c(255.0 * (1.0 - k / 100.0));
    Some([v, v, v])
}

/// Is the record a STROKED shape — stroke content (`vscg`), or a vector
/// stroke (`vstk`) that is switched on or hides the fill? Its pixels
/// carry a stroke this model does not draw, so it stays pixels.
fn stroked(rec: &LayerRecord) -> bool {
    if block(rec, b"vscg").is_some() {
        return true;
    }
    let Some(p) = block(rec, b"vstk") else {
        return false;
    };
    match read_versioned_descriptor(&mut ByteReader::new(p)) {
        Ok((_, d)) => {
            d.bool(b"strokeEnabled").unwrap_or(true) || !d.bool(b"fillEnabled").unwrap_or(true)
        }
        Err(_) => true,
    }
}

/// A SHAPE layer's vector mask (`vmsk`, or `vsms`), parsed for a
/// `width × height` document — the shape the fill is cut by (image ADR
/// 476). `None` when the record has none or it cannot be drawn.
pub fn shape_vector_mask(
    rec: &LayerRecord,
    width: u32,
    height: u32,
) -> Option<image_psd::vector_mask::VectorMask> {
    let p = block(rec, b"vmsk").or_else(|| block(rec, b"vsms"))?;
    image_psd::vector_mask::VectorMask::parse(p, width, height).ok()
}

/// The record's FILL content, when it is a fill layer this model renders:
/// a solid colour or a gradient without transparency stops — on a plain
/// fill layer, or on a SHAPE layer (a vector mask beside it, image ADR
/// 476) that is not stroked.
pub fn fill_source(rec: &LayerRecord) -> Option<FillSource> {
    if stroked(rec) {
        return None;
    }
    if let Some(p) = block(rec, b"SoCo") {
        let (_, d) = read_versioned_descriptor(&mut ByteReader::new(p)).ok()?;
        return Some(FillSource::Solid {
            rgb: color_of(d.descriptor(b"Clr ")?)?,
        });
    }
    let p = block(rec, b"GdFl")?;
    let (_, d) = read_versioned_descriptor(&mut ByteReader::new(p)).ok()?;
    let grad = d.descriptor(b"Grad")?;
    // A noise gradient is a different generator.
    if grad
        .enum_value(b"GrdF")
        .is_some_and(|(_, v)| v.matches(b"ClNs"))
    {
        return None;
    }
    let interval = grad.number(b"Intr").unwrap_or(4096.0).max(1.0);
    let mut stops = Vec::new();
    for c in grad.list(b"Clrs")? {
        let c = c.as_descriptor()?;
        let at = f64::from(c.i32(b"Lctn")?) / 4096.0;
        let rgb = match c.descriptor(b"Clr ") {
            Some(col) => color_of(col)?,
            // Foreground / background stops: Photoshop's defaults.
            None => {
                if c.enum_value(b"Type")
                    .is_some_and(|(_, v)| v.matches(b"BckC"))
                {
                    [255, 255, 255]
                } else {
                    [0, 0, 0]
                }
            }
        };
        stops.push(ColorStop {
            at: at.clamp(0.0, 1.0) as f32,
            rgb,
        });
    }
    let _ = interval;
    if stops.len() < 2 {
        return None;
    }
    // Transparency stops other than opaque are not modelled.
    if let Some(t) = grad.list(b"Trns") {
        for s in t {
            let op = s.as_descriptor()?.unit(b"Opct", *b"#Prc")?;
            if op < 99.5 {
                return None;
            }
        }
    }
    let style = match d.enum_value(b"Type").map(|(_, v)| v.as_bytes().to_vec()) {
        Some(v) if v == b"Rdl " => GradientKind::Radial,
        Some(v) if v == b"Angl" => GradientKind::Angular,
        Some(v) if v == b"Rflc" => GradientKind::Reflected,
        Some(v) if v == b"Dmnd" => GradientKind::Diamond,
        _ => GradientKind::Linear,
    };
    let off = d.descriptor(b"Ofst");
    Some(FillSource::Gradient(GradientFill {
        style,
        angle: d.unit(b"Angl", *b"#Ang").unwrap_or(90.0) as f32,
        scale: d.unit(b"Scl ", *b"#Prc").unwrap_or(100.0) as f32,
        reverse: d.bool(b"Rvrs").unwrap_or(false),
        offset: (
            off.and_then(|o| o.unit(b"Hrzn", *b"#Prc")).unwrap_or(0.0) as f32,
            off.and_then(|o| o.unit(b"Vrtc", *b"#Prc")).unwrap_or(0.0) as f32,
        ),
        stops,
    }))
}

// ─────────────────────────────── writing ───────────────────────────────

/// A constructed block for a layer record: signature, key, length, data,
/// padded to even (the layer-record boundary).
pub fn raw_block(key: [u8; 4], data: &[u8]) -> AdditionalLayerInfo {
    let mut raw = Vec::with_capacity(data.len() + 13);
    raw.extend_from_slice(b"8BIM");
    raw.extend_from_slice(&key);
    raw.extend_from_slice(&(data.len() as u32).to_be_bytes());
    raw.extend_from_slice(data);
    if data.len() % 2 == 1 {
        raw.push(0);
    }
    AdditionalLayerInfo {
        sig: *b"8BIM",
        key,
        body: AddlBody::Opaque,
        raw_block: Some(raw),
    }
}

fn obj(class: &[u8; 4], items: Vec<(&[u8], DescriptorValue)>) -> DescriptorValue {
    build::obj(class, items)
}

fn rgb_obj(c: [u8; 3]) -> DescriptorValue {
    build::rgb(c)
}

fn en(t: &[u8; 4], v: &[u8; 4]) -> DescriptorValue {
    build::en(t, v)
}

fn unit(u: &[u8; 4], v: f64) -> DescriptorValue {
    build::unit(u, v)
}

/// The fill block (`SoCo` or `GdFl`) for `src`, or `None` for a pattern
/// (its pixels would have to go into the document's pattern block, which
/// is not written: the layer is saved as its render).
pub fn fill_block(src: &FillSource) -> Option<AdditionalLayerInfo> {
    // Written by paged-psd's one descriptor writer.
    let block = |key: [u8; 4], items: Vec<(&[u8], DescriptorValue)>| {
        raw_block(
            key,
            &versioned_descriptor_bytes(&build::desc(b"null", items)),
        )
    };
    match src {
        FillSource::Solid { rgb } => Some(block(*b"SoCo", vec![(b"Clr ", rgb_obj(*rgb))])),
        FillSource::Gradient(g) => {
            let colors = g
                .stops
                .iter()
                .map(|s| {
                    obj(
                        b"Clrt",
                        vec![
                            (b"Clr ", rgb_obj(s.rgb)),
                            (b"Type", en(b"Clry", b"UsrS")),
                            (
                                b"Lctn",
                                DescriptorValue::Integer((s.at * 4096.0).round() as i32),
                            ),
                            (b"Mdpn", DescriptorValue::Integer(50)),
                        ],
                    )
                })
                .collect();
            let opaque = |at: i32| {
                obj(
                    b"TrnS",
                    vec![
                        (b"Opct", unit(b"#Prc", 100.0)),
                        (b"Lctn", DescriptorValue::Integer(at)),
                        (b"Mdpn", DescriptorValue::Integer(50)),
                    ],
                )
            };
            let grad = obj(
                b"Grdn",
                vec![
                    (b"Nm  ", DescriptorValue::Text("Custom".into())),
                    (b"GrdF", en(b"GrdF", b"CstS")),
                    (b"Intr", DescriptorValue::Double(4096.0)),
                    (b"Clrs", DescriptorValue::List(colors)),
                    (
                        b"Trns",
                        DescriptorValue::List(vec![opaque(0), opaque(4096)]),
                    ),
                ],
            );
            let style: &[u8; 4] = match g.style {
                GradientKind::Linear => b"Lnr ",
                GradientKind::Radial => b"Rdl ",
                GradientKind::Angular => b"Angl",
                GradientKind::Reflected => b"Rflc",
                GradientKind::Diamond => b"Dmnd",
            };
            Some(block(
                *b"GdFl",
                vec![
                    (b"Grad", grad),
                    (b"Type", en(b"GrdT", style)),
                    (b"Angl", unit(b"#Ang", f64::from(g.angle))),
                    (b"Scl ", unit(b"#Prc", f64::from(g.scale))),
                    (b"Rvrs", DescriptorValue::Bool(g.reverse)),
                    (b"Algn", DescriptorValue::Bool(true)),
                    (
                        b"Ofst",
                        obj(
                            b"Pnt ",
                            vec![
                                (b"Hrzn", unit(b"#Prc", f64::from(g.offset.0))),
                                (b"Vrtc", unit(b"#Prc", f64::from(g.offset.1))),
                            ],
                        ),
                    ),
                ],
            ))
        }
        FillSource::Pattern(_) => None,
    }
}

/// The blocks a layer's parity properties need: fill opacity, knockout,
/// the protection flags and the colour label — each only when it is not
/// Photoshop's default, so a plain layer is written as before.
pub fn ext_blocks(ext: &LayerExt, pixels_locked: bool) -> Vec<AdditionalLayerInfo> {
    let mut out = Vec::new();
    if ext.fill_opacity < 1.0 {
        let v = (ext.fill_opacity.clamp(0.0, 1.0) * 255.0).round() as u8;
        out.push(raw_block(*b"iOpa", &[v, 0, 0, 0]));
    }
    if ext.knockout != Knockout::None {
        out.push(raw_block(*b"knko", &[ext.knockout.code(), 0, 0, 0]));
    }
    let bits = u32::from(ext.locks.transparency)
        | u32::from(pixels_locked) << 1
        | u32::from(ext.locks.position) << 2
        | if ext.locks.all { 0x8000_0000 | 7 } else { 0 };
    if bits != 0 {
        out.push(raw_block(*b"lspf", &bits.to_be_bytes()));
    }
    if ext.color != 0 {
        out.push(raw_block(*b"lclr", &[0, ext.color, 0, 0, 0, 0, 0, 0]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use image_psd::model::{BlendRanges, PascalString};

    fn record(addl: Vec<AdditionalLayerInfo>, ranges: Vec<u8>) -> LayerRecord {
        LayerRecord {
            top: 0,
            left: 0,
            bottom: 1,
            right: 1,
            channels: Vec::new(),
            blend_sig: *b"8BIM",
            blend_key: *b"norm",
            opacity: 255,
            clipping: 0,
            flags: 0,
            filler: 0,
            mask: None,
            blend_ranges: BlendRanges { raw: ranges },
            name_legacy: PascalString::new("x"),
            addl,
            extra_raw: None,
            channel_data: Vec::new(),
        }
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_solid_and_a_gradient_fill_block_read_back__feat__image_layers_photoshop_parity() {
        let solid = FillSource::Solid { rgb: [12, 34, 56] };
        let rec = record(vec![fill_block(&solid).expect("SoCo")], Vec::new());
        assert_eq!(fill_source(&rec), Some(solid));
        let grad = FillSource::Gradient(GradientFill {
            style: GradientKind::Radial,
            angle: 30.0,
            scale: 80.0,
            reverse: true,
            offset: (10.0, -5.0),
            stops: vec![
                ColorStop {
                    at: 0.0,
                    rgb: [255, 0, 0],
                },
                ColorStop {
                    at: 0.5,
                    rgb: [0, 255, 0],
                },
                ColorStop {
                    at: 1.0,
                    rgb: [0, 0, 255],
                },
            ],
        });
        let rec = record(vec![fill_block(&grad).expect("GdFl")], Vec::new());
        assert_eq!(fill_source(&rec), Some(grad));
        // A SHAPE (a vector mask beside the content) is a fill layer cut by
        // its path (ADR 476); its path is read by `shape_vector_mask`, which
        // refuses one it cannot draw (here: version 0).
        let rec = record(
            vec![
                fill_block(&FillSource::Solid { rgb: [1, 2, 3] }).expect("SoCo"),
                raw_block(*b"vmsk", &[0; 8]),
            ],
            Vec::new(),
        );
        assert_eq!(
            fill_source(&rec),
            Some(FillSource::Solid { rgb: [1, 2, 3] })
        );
        assert!(shape_vector_mask(&rec, 4, 4).is_none());
        // A STROKED shape stays pixels: stroke content, or a vector stroke
        // that is switched on.
        let stroked = record(
            vec![
                fill_block(&FillSource::Solid { rgb: [1, 2, 3] }).expect("SoCo"),
                raw_block(*b"vscg", &[0; 8]),
            ],
            Vec::new(),
        );
        assert_eq!(fill_source(&stroked), None);
    }

    #[test]
    #[allow(non_snake_case)]
    fn blending_ranges_and_the_flags_round_trip__feat__image_layers_photoshop_parity() {
        let mut bi = BlendIf::default();
        bi.channels[0].this = [20, 40, 200, 230];
        bi.channels[3].under = [0, 0, 128, 128];
        let rec = record(Vec::new(), blend_ranges_bytes(Some(&bi)));
        assert_eq!(blend_if(&rec), Some(bi));
        let open = record(Vec::new(), blend_ranges_bytes(None));
        assert_eq!(blend_if(&open), None);
        let ext = LayerExt {
            fill_opacity: 0.4,
            knockout: Knockout::Deep,
            locks: LayerLocks {
                transparency: true,
                position: true,
                all: false,
            },
            color: 5,
            blend_if: Some(Box::new(bi)),
            link: None,
            ..LayerExt::default()
        };
        let rec = record(ext_blocks(&ext, true), blend_ranges_bytes(Some(&bi)));
        let back = record_ext(&rec);
        assert!((back.fill_opacity - 0.4).abs() < 0.003);
        assert_eq!(back.knockout, Knockout::Deep);
        assert_eq!(back.locks, ext.locks);
        assert_eq!(back.color, 5);
        assert_eq!(back.blend_if.as_deref(), Some(&bi));
        assert!(pixels_locked(&rec));
    }
}
