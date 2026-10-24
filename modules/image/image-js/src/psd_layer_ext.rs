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

use image_psd::descriptor::{read_versioned_descriptor, Descriptor, DescriptorValue, Key};
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
    }
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

/// The record's FILL content, when it is a fill layer this model renders:
/// a solid colour or a gradient without transparency stops, on a layer
/// that is not a shape (no vector mask or stroke content beside it).
pub fn fill_source(rec: &LayerRecord) -> Option<FillSource> {
    let shape = rec
        .addl
        .iter()
        .any(|a| matches!(&a.key, b"vmsk" | b"vsms" | b"vscg" | b"vstk"));
    if shape {
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

/// A descriptor writer for the value kinds the fill blocks use.
struct D(Vec<u8>);

impl D {
    fn key(&mut self, k: &[u8]) {
        if k.len() == 4 {
            self.0.extend_from_slice(&0u32.to_be_bytes());
        } else {
            self.0.extend_from_slice(&(k.len() as u32).to_be_bytes());
        }
        self.0.extend_from_slice(k);
    }
    fn unicode(&mut self, s: &str) {
        let units: Vec<u16> = s.encode_utf16().chain(std::iter::once(0)).collect();
        self.0
            .extend_from_slice(&(units.len() as u32).to_be_bytes());
        for u in units {
            self.0.extend_from_slice(&u.to_be_bytes());
        }
    }
    fn descriptor(&mut self, class_name: &str, class: &[u8], items: &[(&[u8], DescriptorValue)]) {
        self.unicode(class_name);
        self.key(class);
        self.0
            .extend_from_slice(&(items.len() as u32).to_be_bytes());
        for (k, v) in items {
            self.key(k);
            self.value(v);
        }
    }
    fn value(&mut self, v: &DescriptorValue) {
        self.0.extend_from_slice(&v.ostype());
        self.body(v);
    }
    fn body(&mut self, v: &DescriptorValue) {
        match v {
            DescriptorValue::Descriptor(d) => {
                self.unicode(&d.class_name);
                self.key(d.class_id.as_bytes());
                self.0
                    .extend_from_slice(&(d.items.len() as u32).to_be_bytes());
                for (k, v) in &d.items {
                    self.key(k.as_bytes());
                    self.value(v);
                }
            }
            DescriptorValue::List(items) => {
                self.0
                    .extend_from_slice(&(items.len() as u32).to_be_bytes());
                for v in items {
                    self.value(v);
                }
            }
            DescriptorValue::Double(x) => self.0.extend_from_slice(&x.to_be_bytes()),
            DescriptorValue::UnitFloat { unit, value } => {
                self.0.extend_from_slice(unit);
                self.0.extend_from_slice(&value.to_be_bytes());
            }
            DescriptorValue::Text(s) => self.unicode(s),
            DescriptorValue::Enum { type_key, value } => {
                self.key(type_key.as_bytes());
                self.key(value.as_bytes());
            }
            DescriptorValue::Integer(i) => self.0.extend_from_slice(&i.to_be_bytes()),
            DescriptorValue::Bool(b) => self.0.push(u8::from(*b)),
            // Not used by the fill blocks.
            _ => {}
        }
    }
}

fn obj(class: &[u8; 4], items: Vec<(&[u8], DescriptorValue)>) -> DescriptorValue {
    DescriptorValue::Descriptor(Descriptor {
        class_name: String::new(),
        class_id: Key::four(class),
        items: items.into_iter().map(|(k, v)| (key_of(k), v)).collect(),
    })
}

fn key_of(k: &[u8]) -> Key {
    match <[u8; 4]>::try_from(k) {
        Ok(four) => Key::four(&four),
        Err(_) => Key::long(&String::from_utf8_lossy(k)),
    }
}

fn rgb_obj(c: [u8; 3]) -> DescriptorValue {
    obj(
        b"RGBC",
        vec![
            (b"Rd  ", DescriptorValue::Double(f64::from(c[0]))),
            (b"Grn ", DescriptorValue::Double(f64::from(c[1]))),
            (b"Bl  ", DescriptorValue::Double(f64::from(c[2]))),
        ],
    )
}

fn en(t: &[u8; 4], v: &[u8; 4]) -> DescriptorValue {
    DescriptorValue::Enum {
        type_key: Key::four(t),
        value: Key::four(v),
    }
}

fn unit(u: &[u8; 4], v: f64) -> DescriptorValue {
    DescriptorValue::UnitFloat { unit: *u, value: v }
}

/// The fill block (`SoCo` or `GdFl`) for `src`, or `None` for a pattern
/// (its pixels would have to go into the document's pattern block, which
/// is not written: the layer is saved as its render).
pub fn fill_block(src: &FillSource) -> Option<AdditionalLayerInfo> {
    let mut d = D(16u32.to_be_bytes().to_vec());
    match src {
        FillSource::Solid { rgb } => {
            d.descriptor("", b"null", &[(b"Clr ", rgb_obj(*rgb))]);
            Some(raw_block(*b"SoCo", &d.0))
        }
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
            d.descriptor(
                "",
                b"null",
                &[
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
            );
            Some(raw_block(*b"GdFl", &d.0))
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
        // A shape (vector mask beside the content) is not a fill layer.
        let rec = record(
            vec![
                fill_block(&FillSource::Solid { rgb: [1, 2, 3] }).expect("SoCo"),
                raw_block(*b"vmsk", &[0; 8]),
            ],
            Vec::new(),
        );
        assert_eq!(fill_source(&rec), None);
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
