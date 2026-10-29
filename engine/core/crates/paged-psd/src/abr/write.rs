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

//! The `.abr` WRITER — a v6.2 brush library from the typed model.
//!
//! The reader's typed view ([`AbrBrush`], [`AbrSample`]) is the input:
//! every group is emitted from its typed fields, under its gate, with
//! the units and scales the reader decodes (percent per key, the
//! fraction-scale bristle keys, bare `long` angles on the pose, `doub`
//! counts). So the round trip `write → AbrFile::parse` reproduces the
//! typed view field for field, which is what the tests pin.
//!
//! What it writes, and what it deliberately does not:
//!
//! * `samp`: one record per sample, an UNCOMPRESSED virtual memory array
//!   list in the shape real files have (56 slots, the plane in slot 55,
//!   the two trailing empty slots after the pixel data) — the exact
//!   layout `vm_array::read_vm_array_list` parses.
//! * `desc`: descriptor version 16, a `null` root with the `Brsh` list.
//!   Keys of four bytes are written as 4-character codes, longer ones in
//!   the long form — the split the corpus shows.
//! * The `toolOptions` sub-descriptor, when a preset has one, is written
//!   back VERBATIM from [`super::ToolOptions::descriptor`]: it is the one
//!   group the typed view models only partly, and the generic tree is
//!   authoritative for the rest.
//! * No `patt` (patterns are retained opaquely by the reader and never
//!   decoded, so a texture's `Idnt` is written as it was read and
//!   dangles the same way) and no `phry` folder tree.
//!
//! The descriptor tree is written by the crate's one descriptor writer
//! (`crate::descriptor`), in its `.abr` style (class names without a
//! trailing NUL).

use crate::descriptor::{
    units, write_versioned_descriptor_styled, Descriptor, DescriptorValue, Key, WriteStyle,
};
use crate::vm_array::{VmRect, VmSamples, COMPRESSION_RAW, VM_VERSION};
use crate::writer::ByteWriter;

use super::model::{
    percent_to_fraction, AbrBrush, AbrTip, BrushOptions, Dynamics, OptionSource, TipCommon,
};
use super::{AbrSample, BlendMode, SECTION_SIGNATURE};

/// The array slots a sampled-tip record declares — what every real file
/// writes (spec §2.2).
const ARRAY_COUNT: u32 = 56;
/// The slot that carries the plane.
const PLANE_SLOT: u32 = 55;
/// The container's leading word (opaque to the reader; what real files
/// carry).
const VM_LEADING: u32 = 0x0001_0000;

/// Write a v6.2 `.abr` holding `brushes` (in order) and `samples`.
///
/// A sampled tip's `sampled_id` must name one of `samples` for the file
/// to join on read; the writer does not check it (the reader reports an
/// unresolved reference by name).
pub fn write_abr(brushes: &[AbrBrush], samples: &[AbrSample]) -> Vec<u8> {
    let mut w = ByteWriter::new();
    w.i16(6);
    w.i16(2);

    let mut samp = ByteWriter::new();
    for s in samples {
        let body = sample_record(s);
        samp.u32(body.len() as u32);
        samp.bytes(&body);
        let pad = (4 - body.len() % 4) % 4;
        samp.bytes(&[0u8; 3][..pad]);
    }
    section(&mut w, b"samp", &samp.into_bytes());

    let list: Vec<DescriptorValue> = brushes
        .iter()
        .map(|b| DescriptorValue::Descriptor(brush_descriptor(b)))
        .collect();
    let root = Descriptor {
        class_name: String::new(),
        class_id: Key::four(b"null"),
        items: vec![(Key::four(b"Brsh"), DescriptorValue::List(list))],
    };
    let mut desc = Vec::new();
    write_versioned_descriptor_styled(&mut desc, &root, WriteStyle::ABR);
    section(&mut w, b"desc", &desc);
    w.into_bytes()
}

fn section(w: &mut ByteWriter, kind: &[u8; 4], body: &[u8]) {
    w.fourcc(SECTION_SIGNATURE);
    w.fourcc(*kind);
    w.u32(body.len() as u32);
    w.bytes(body);
    let pad = (4 - body.len() % 4) % 4;
    w.bytes(&[0u8; 3][..pad]);
}

fn sample_record(s: &AbrSample) -> Vec<u8> {
    let mut e = ByteWriter::new();
    let id = s.id.as_bytes();
    let n = id.len().min(255);
    e.u8(n as u8);
    e.bytes(&id[..n]);

    let (depth, payload) = match &s.coverage {
        VmSamples::Eight(v) => (8u16, v.clone()),
        VmSamples::Sixteen(v) => (16u16, v.iter().flat_map(|x| x.to_be_bytes()).collect()),
    };
    // The plane carries its own rectangle; the container's is the same.
    let r = if s.bounds.width() == Some(s.width) && s.bounds.height() == Some(s.height) {
        s.bounds
    } else {
        VmRect {
            top: 0,
            left: 0,
            bottom: s.height as i32,
            right: s.width as i32,
        }
    };
    let slots = ARRAY_COUNT + 2;
    let array_len = 4 + 16 + 2 + 1 + payload.len();
    let vm_len = 16 + 4 + slots as usize * 4 + 4 + array_len;
    e.u32(VM_LEADING);
    e.u32(VM_VERSION);
    e.u32(vm_len as u32);
    rect(&mut e, r);
    e.u32(ARRAY_COUNT);
    for slot in 0..slots {
        if slot != PLANE_SLOT {
            e.u32(0);
            continue;
        }
        e.u32(1);
        e.u32(array_len as u32);
        e.u32(depth as u32);
        rect(&mut e, r);
        e.u16(depth);
        e.u8(COMPRESSION_RAW);
        e.bytes(&payload);
    }
    e.into_bytes()
}

fn rect(e: &mut ByteWriter, r: VmRect) {
    e.i32(r.top);
    e.i32(r.left);
    e.i32(r.bottom);
    e.i32(r.right);
}

// ── the typed model → a descriptor tree ──────────────────────────────

/// Four bytes ⇒ a 4-character code, anything else ⇒ the long form.
fn key(k: &str) -> Key {
    if k.len() == 4 {
        let b = k.as_bytes();
        Key::four(&[b[0], b[1], b[2], b[3]])
    } else {
        Key::long(k)
    }
}

/// A descriptor under construction.
struct D(Descriptor);

impl D {
    fn new(class_id: &str) -> D {
        D(Descriptor {
            class_name: String::new(),
            class_id: key(class_id),
            items: Vec::new(),
        })
    }
    fn put(&mut self, k: &str, v: DescriptorValue) {
        self.0.items.push((key(k), v));
    }
    fn bool(&mut self, k: &str, v: bool) {
        self.put(k, DescriptorValue::Bool(v));
    }
    fn opt_bool(&mut self, k: &str, v: Option<bool>) {
        if let Some(v) = v {
            self.bool(k, v);
        }
    }
    fn long(&mut self, k: &str, v: i32) {
        self.put(k, DescriptorValue::Integer(v));
    }
    fn opt_long(&mut self, k: &str, v: Option<i32>) {
        if let Some(v) = v {
            self.long(k, v);
        }
    }
    fn doub(&mut self, k: &str, v: f64) {
        self.put(k, DescriptorValue::Double(v));
    }
    fn unit(&mut self, k: &str, unit: [u8; 4], v: f64) {
        self.put(k, DescriptorValue::UnitFloat { unit, value: v });
    }
    /// A fraction written back as a `#Prc` on the key's own scale.
    fn pct(&mut self, k: &str, fraction: f64) {
        self.unit(
            k,
            units::PERCENT,
            fraction_to_percent(k.as_bytes(), fraction),
        );
    }
    fn opt_pct(&mut self, k: &str, v: Option<f64>) {
        if let Some(v) = v {
            self.pct(k, v);
        }
    }
    fn text(&mut self, k: &str, v: &str) {
        self.put(k, DescriptorValue::Text(v.to_string()));
    }
    fn obj(&mut self, k: &str, d: D) {
        self.put(k, DescriptorValue::Descriptor(d.0));
    }
    fn blend(&mut self, k: &str, m: Option<BlendMode>) {
        if let Some(m) = m {
            let value = match m.legacy_code() {
                Some(c) => Key::four(c),
                None => Key::long(m.name()),
            };
            self.put(
                k,
                DescriptorValue::Enum {
                    type_key: Key::four(b"BlnM"),
                    value,
                },
            );
        }
    }
    fn dynamics(&mut self, k: &str, d: &Option<Dynamics>) {
        if let Some(d) = d {
            let mut v = D::new("brVr");
            v.long("bVTy", d.control_ordinal);
            v.long("fStp", d.fade_steps);
            v.pct("jitter", d.jitter);
            v.opt_pct("Mnm ", d.minimum);
            self.obj(k, v);
        }
    }
}

/// The inverse of [`percent_to_fraction`], per key.
fn fraction_to_percent(key: &[u8], fraction: f64) -> f64 {
    if percent_to_fraction(key, 1.0) == 1.0 {
        fraction
    } else {
        fraction * 100.0
    }
}

fn common(d: &mut D, c: &TipCommon) {
    d.unit("Dmtr", c.diameter_unit, c.diameter);
    d.unit("Angl", units::ANGLE, c.angle_deg);
    d.pct("Spcn", c.spacing);
    d.bool("Intr", c.spacing_enabled);
    d.bool("flipX", c.flip_x);
    d.bool("flipY", c.flip_y);
}

fn tip_descriptor(tip: &AbrTip) -> Option<D> {
    Some(match tip {
        AbrTip::Computed(t) => {
            let mut d = D::new("computedBrush");
            common(&mut d, &t.common);
            d.pct("Rndn", t.roundness);
            d.pct("Hrdn", t.hardness);
            d
        }
        AbrTip::Sampled(t) => {
            let mut d = D::new("sampledBrush");
            common(&mut d, &t.common);
            d.pct("Rndn", t.roundness);
            if let Some(n) = &t.name {
                d.text("Nm  ", n);
            }
            d.text("sampledData", &t.sampled_id);
            d
        }
        AbrTip::Bristle(t) => {
            let mut d = D::new("dBrush");
            common(&mut d, &t.common);
            d.long("Shp ", t.shape_ordinal);
            d.pct("Dnst", t.density);
            d.pct("Lngt", t.length);
            d.pct("clumping", t.clumping);
            d.pct("thickness", t.thickness);
            d.pct("stiffness", t.stiffness);
            d.bool("physics", t.physics);
            d
        }
        AbrTip::Erodible(t) => {
            let mut d = D::new("dTips");
            common(&mut d, &t.common);
            d.long("Shp ", t.shape_ordinal);
            d.opt_long("dtipsType", t.tips_type);
            d.opt_bool("physics", t.physics);
            d.opt_pct("dtipsLengthRatio", t.length_ratio);
            d.opt_pct("dtipsHardness", t.hardness);
            d.opt_long("dtipsGridSize", t.grid_size);
            if let Some(h) = &t.height_map {
                d.put(
                    "dtipsErodibleTipHeightMap",
                    DescriptorValue::RawData(h.raw.clone()),
                );
            }
            if let Some(v) = t.airbrush.cutoff_angle_deg {
                d.doub("dtipsAirbrushCutoffAngle", v);
            }
            // The four undetermined-scale percents go back RAW.
            for (k, v) in [
                ("dtipsAirbrushGranularity", t.airbrush.granularity_raw),
                ("dtipsAirbrushStreakiness", t.airbrush.streakiness_raw),
                ("dtipsAirbrushSplatSize", t.airbrush.splat_size_raw),
            ] {
                if let Some(v) = v {
                    d.unit(k, units::PERCENT, v);
                }
            }
            d.opt_long("dtipsAirbrushSplatCount", t.airbrush.splat_count);
            d
        }
        AbrTip::Unsupported { class_id } => D::new(class_id),
        AbrTip::Missing => return None,
    })
}

fn brush_descriptor(b: &AbrBrush) -> Descriptor {
    let mut d = D::new("brushPreset");
    d.text("Nm  ", &b.name);
    if let Some(t) = tip_descriptor(&b.tip) {
        d.obj("Brsh", t);
    }
    d.opt_bool("Wtdg", b.wet_edges);
    d.opt_bool("Nose", b.noise);
    d.opt_bool("useBrushSize", b.use_brush_size);
    d.opt_pct("Spcn", b.brush_spacing);
    options(&mut d, &b.options, b.tool_options.is_some());

    d.bool("useTipDynamics", b.shape_dynamics.is_some());
    if let Some(s) = &b.shape_dynamics {
        d.dynamics("szVr", &s.size);
        d.dynamics("angleDynamics", &s.angle);
        d.dynamics("roundnessDynamics", &s.roundness);
        d.opt_pct("minimumDiameter", s.minimum_diameter);
        d.opt_pct("minimumRoundness", s.minimum_roundness);
        d.opt_pct("tiltScale", s.tilt_scale);
        d.opt_bool("flipX", s.flip_x_jitter);
        d.opt_bool("flipY", s.flip_y_jitter);
        d.opt_bool("brushProjection", s.brush_projection);
    }
    d.bool("useScatter", b.scatter.is_some());
    if let Some(s) = &b.scatter {
        d.dynamics("scatterDynamics", &s.scatter);
        d.dynamics("countDynamics", &s.count_dynamics);
        if let Some(c) = s.count {
            d.doub("Cnt ", c);
        }
        d.opt_bool("bothAxes", s.both_axes);
    }
    d.bool("useTexture", b.texture.is_some());
    if let Some(t) = &b.texture {
        if t.pattern_id.is_some() || t.pattern_name_raw.is_some() {
            let mut p = D::new("Ptrn");
            if let Some(n) = &t.pattern_name_raw {
                p.text("Nm  ", n);
            }
            if let Some(i) = &t.pattern_id {
                p.text("Idnt", i);
            }
            d.obj("Txtr", p);
        }
        d.blend("textureBlendMode", t.blend_mode);
        d.opt_pct("textureScale", t.scale);
        d.opt_pct("textureDepth", t.depth);
        d.opt_pct("minimumDepth", t.minimum_depth);
        d.dynamics("textureDepthDynamics", &t.depth_dynamics);
        d.opt_bool("InvT", t.invert);
        d.opt_long("textureBrightness", t.brightness);
        d.opt_long("textureContrast", t.contrast);
        d.opt_bool("TxtC", t.per_tip);
    }
    // The dual brush is on every real preset, its gate inside it.
    let mut dual = D::new("dualBrush");
    match &b.dual_brush {
        Some(db) => {
            dual.bool("useDualBrush", db.enabled);
            if let Some(t) = db.tip.as_deref().and_then(tip_descriptor) {
                dual.obj("Brsh", t);
            }
            dual.opt_bool("Flip", db.flip);
            dual.blend("BlnM", db.blend_mode);
            dual.opt_bool("useScatter", db.use_scatter);
            dual.opt_pct("Spcn", db.spacing);
            if let Some(c) = db.count {
                dual.doub("Cnt ", c);
            }
            dual.opt_bool("bothAxes", db.both_axes);
            dual.dynamics("countDynamics", &db.count_dynamics);
            dual.dynamics("scatterDynamics", &db.scatter_dynamics);
        }
        None => dual.bool("useDualBrush", false),
    }
    if b.dual_brush.is_some() {
        d.obj("dualBrush", dual);
    }
    d.bool("useColorDynamics", b.color_dynamics.is_some());
    if let Some(c) = &b.color_dynamics {
        d.dynamics("clVr", &c.foreground_background);
        d.opt_pct("H   ", c.hue);
        d.opt_pct("Strt", c.saturation);
        d.opt_pct("Brgh", c.brightness);
        d.opt_pct("purity", c.purity);
        d.opt_bool("colorDynamicsPerTip", c.per_tip);
    }
    d.bool("usePaintDynamics", b.transfer.is_some());
    if let Some(t) = &b.transfer {
        d.dynamics("prVr", &t.flow);
        d.dynamics("opVr", &t.opacity);
        d.dynamics("wtVr", &t.wetness);
        d.dynamics("mxVr", &t.mix);
    }
    d.bool("useBrushPose", b.brush_pose.is_some());
    if let Some(p) = &b.brush_pose {
        d.opt_bool("overridePoseAngle", p.override_angle);
        d.opt_bool("overridePoseTiltX", p.override_tilt_x);
        d.opt_bool("overridePoseTiltY", p.override_tilt_y);
        d.opt_bool("overridePosePressure", p.override_pressure);
        d.opt_pct("brushPosePressure", p.pressure);
        d.opt_long("brushPoseTiltX", p.tilt_x);
        d.opt_long("brushPoseTiltY", p.tilt_y);
        d.opt_long("brushPoseAngle", p.angle);
    }
    if let Some(t) = &b.tool_options {
        // Verbatim: the typed members are a view over this descriptor.
        d.put(
            "toolOptions",
            DescriptorValue::Descriptor(t.descriptor.clone()),
        );
    }
    d.0
}

/// The brush-level options. A key the reader found inside `toolOptions`
/// is written back there (verbatim, with that descriptor) and not here.
fn options(d: &mut D, o: &BrushOptions, has_tool_options: bool) {
    let here = |s: OptionSource| !(has_tool_options && s == OptionSource::ToolOptions);
    if here(o.build_up_source) {
        d.opt_bool("Rpt ", o.build_up);
    }
    if o.brush_group_present || o.use_brush_group.is_some() {
        let mut g = D::new("brushGroup");
        g.opt_bool("useBrushGroup", o.use_brush_group);
        d.obj("brushGroup", g);
    }
    d.opt_bool("interpretation", o.interpretation);
    if here(o.protect_texture_source) {
        d.opt_bool("protectTexture", o.protect_texture);
    }
    if let Some(s) = &o.smoothing {
        if here(s.source) {
            d.opt_bool("smoothing", s.enabled);
            if let Some(v) = s.value_raw {
                d.doub("smoothingValue", v);
            }
            d.opt_bool("smoothingRadiusMode", s.radius_mode);
            d.opt_bool("smoothingCatchup", s.catch_up);
            d.opt_bool("smoothingCatchupAtEnd", s.catch_up_at_end);
            d.opt_bool("smoothingZoomCompensation", s.zoom_compensation);
            d.opt_bool("pressureSmoothing", s.pressure_smoothing);
            d.opt_long("Smoo", s.smoo_raw);
        }
    }
    // The three below carry no source of their own; they are written on
    // the brush unless a `toolOptions` descriptor (written verbatim)
    // already holds them.
    if !has_tool_options {
        d.opt_bool("usePressureOverridesSize", o.pressure_overrides_size);
        d.opt_bool("usePressureOverridesOpacity", o.pressure_overrides_opacity);
        d.opt_bool("useLegacy", o.use_legacy);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abr::model::*;
    use crate::abr::{AbrFile, ControlSource};

    fn dynamics(control: i32, jitter: f64, minimum: Option<f64>) -> Option<Dynamics> {
        Some(Dynamics {
            control_ordinal: control,
            control: ControlSource::from_ordinal(control).unwrap(),
            fade_steps: 25,
            jitter,
            minimum,
        })
    }

    fn tc(diameter: f64) -> TipCommon {
        TipCommon {
            diameter,
            diameter_unit: units::PIXELS,
            angle_deg: 30.0,
            spacing: 0.25,
            spacing_enabled: true,
            flip_x: true,
            flip_y: false,
        }
    }

    fn empty_descriptor() -> Descriptor {
        Descriptor::default()
    }

    /// A preset with EVERY group set, so the round trip covers them all.
    fn everything(index: usize, tip: AbrTip) -> AbrBrush {
        AbrBrush {
            index,
            name: format!("Every pane {index}"),
            descriptor: empty_descriptor(),
            tip,
            wet_edges: Some(true),
            noise: Some(true),
            use_brush_size: Some(true),
            brush_spacing: None,
            shape_dynamics: Some(ShapeDynamics {
                size: dynamics(2, 0.4, Some(0.1)),
                angle: dynamics(6, 0.25, None),
                roundness: dynamics(3, 0.5, None),
                minimum_diameter: Some(0.2),
                minimum_roundness: Some(0.3),
                tilt_scale: Some(2.0),
                flip_x_jitter: Some(true),
                flip_y_jitter: Some(false),
                brush_projection: Some(true),
            }),
            scatter: Some(Scatter {
                scatter: dynamics(0, 3.68, None),
                count_dynamics: dynamics(1, 0.5, None),
                count: Some(3.0),
                both_axes: Some(true),
            }),
            texture: Some(Texture {
                pattern_id: Some("pat-1".into()),
                pattern_name_raw: Some("$$$/Pattern/Name=Canvas".into()),
                pattern_name: Some("Canvas".into()),
                blend_mode: Some(BlendMode::LinearHeight),
                scale: Some(0.5),
                depth: Some(0.75),
                minimum_depth: Some(0.1),
                depth_dynamics: dynamics(2, 0.2, None),
                invert: Some(true),
                brightness: Some(-7),
                contrast: Some(14),
                per_tip: Some(true),
            }),
            dual_brush: Some(DualBrush {
                enabled: true,
                tip: Some(Box::new(AbrTip::Computed(ComputedTip {
                    common: tc(12.0),
                    roundness: 0.5,
                    hardness: 1.0,
                }))),
                flip: Some(true),
                blend_mode: Some(BlendMode::ColorBurn),
                use_scatter: Some(true),
                spacing: Some(0.4),
                count: Some(2.0),
                both_axes: Some(false),
                count_dynamics: dynamics(0, 0.1, None),
                scatter_dynamics: dynamics(0, 0.6, None),
            }),
            color_dynamics: Some(ColorDynamics {
                foreground_background: dynamics(2, 0.3, None),
                hue: Some(0.1),
                saturation: Some(0.2),
                brightness: Some(0.3),
                purity: Some(-0.4),
                per_tip: Some(true),
            }),
            transfer: Some(Transfer {
                flow: dynamics(2, 0.1, Some(0.2)),
                opacity: dynamics(1, 0.3, None),
                wetness: None,
                mix: None,
            }),
            brush_pose: Some(BrushPose {
                override_angle: Some(true),
                override_tilt_x: Some(true),
                override_tilt_y: Some(true),
                override_pressure: Some(false),
                pressure: Some(0.8),
                tilt_x: Some(-54),
                tilt_y: Some(23),
                angle: Some(90),
            }),
            tool_options: None,
            options: BrushOptions {
                build_up: Some(true),
                build_up_source: OptionSource::Brush,
                smoothing: Some(Smoothing {
                    enabled: Some(true),
                    value_raw: Some(35.0),
                    radius_mode: Some(true),
                    catch_up: Some(true),
                    catch_up_at_end: Some(false),
                    zoom_compensation: Some(true),
                    pressure_smoothing: Some(false),
                    smoo_raw: Some(2),
                    source: OptionSource::Brush,
                }),
                protect_texture: Some(true),
                protect_texture_source: OptionSource::Brush,
                pressure_overrides_size: Some(true),
                pressure_overrides_opacity: Some(false),
                use_legacy: Some(false),
                brush_group_present: true,
                use_brush_group: Some(false),
                interpretation: Some(true),
            },
        }
    }

    fn sample(id: &str) -> AbrSample {
        let (w, h) = (5u32, 3u32);
        AbrSample {
            id: id.into(),
            bounds: VmRect {
                top: 40,
                left: 100,
                bottom: 43,
                right: 105,
            },
            width: w,
            height: h,
            depth: 8,
            coverage: VmSamples::Eight((0..w * h).map(|i| (i * 17 % 256) as u8).collect()),
        }
    }

    /// Everything but the descriptor tree (which the writer rebuilds and
    /// the reader re-derives).
    fn typed(b: &AbrBrush) -> AbrBrush {
        AbrBrush {
            descriptor: empty_descriptor(),
            ..b.clone()
        }
    }

    #[test]
    fn image_abr_write_round_trips_every_typed_field() {
        let id = "0b0c4a97-2b53-4d3a-9b1f-6f2c9a1d5e70";
        let computed = everything(
            0,
            AbrTip::Computed(ComputedTip {
                common: tc(40.0),
                roundness: 0.6,
                hardness: 0.35,
            }),
        );
        let sampled = everything(
            1,
            AbrTip::Sampled(SampledTipRef {
                common: tc(64.0),
                roundness: 1.0,
                name: Some("tip".into()),
                sampled_id: id.into(),
                sample_index: Some(0),
            }),
        );
        let bytes = write_abr(&[computed.clone(), sampled.clone()], &[sample(id)]);
        let f = AbrFile::parse(&bytes).expect("the writer's output parses");
        assert_eq!((f.version, f.minor_version), (6, 2));
        // The only warning is the colour-dynamics one every true gate
        // raises (its vocabulary is [REF]-only), once per preset.
        assert_eq!(
            f.warnings,
            vec![
                crate::abr::AbrWarning::ColorDynamicsUnverified { brush_index: 0 },
                crate::abr::AbrWarning::ColorDynamicsUnverified { brush_index: 1 },
            ]
        );
        assert_eq!(f.brushes.len(), 2);
        assert_eq!(typed(&f.brushes[0]), typed(&computed));
        assert_eq!(typed(&f.brushes[1]), typed(&sampled));
        assert_eq!(f.samples, vec![sample(id)], "coverage byte-identical");
    }

    #[test]
    fn image_abr_write_a_plain_round_brush_parses_with_no_warnings() {
        let mut b = everything(
            0,
            AbrTip::Computed(ComputedTip {
                common: tc(20.0),
                roundness: 1.0,
                hardness: 1.0,
            }),
        );
        b.color_dynamics = None;
        b.dual_brush = None;
        let f = AbrFile::parse(&write_abr(&[b.clone()], &[])).unwrap();
        assert!(f.warnings.is_empty(), "{:?}", f.warnings);
        assert_eq!(typed(&f.brushes[0]), typed(&b));
    }

    #[test]
    fn image_abr_write_tool_options_go_back_verbatim_with_their_keys() {
        let mut tool = Descriptor {
            class_name: String::new(),
            class_id: Key::four(b"PbTl"),
            items: Vec::new(),
        };
        tool.items
            .push((Key::long("flow"), DescriptorValue::Integer(80)));
        tool.items
            .push((Key::four(b"Opct"), DescriptorValue::Integer(60)));
        tool.items
            .push((Key::long("smoothing"), DescriptorValue::Bool(true)));
        tool.items
            .push((Key::long("smoothingValue"), DescriptorValue::Double(10.0)));
        tool.items
            .push((Key::long("useLegacy"), DescriptorValue::Bool(true)));
        let mut b = everything(
            0,
            AbrTip::Computed(ComputedTip {
                common: tc(20.0),
                roundness: 1.0,
                hardness: 1.0,
            }),
        );
        b.options = BrushOptions::default();
        b.tool_options = Some(ToolOptions {
            kind: ToolKind::PlainBrush,
            class_id: "PbTl".into(),
            flow: 80.0,
            opacity: 60.0,
            blend_mode: BlendMode::Normal,
            descriptor: tool,
        });
        let f = AbrFile::parse(&write_abr(&[b.clone()], &[])).unwrap();
        let got = &f.brushes[0];
        assert_eq!(got.tool_options, b.tool_options);
        let s = got.options.smoothing.as_ref().expect("smoothing found");
        assert_eq!(s.source, OptionSource::ToolOptions);
        assert_eq!(s.amount(), Some(0.1));
        assert_eq!(got.options.use_legacy, Some(true));
    }

    #[test]
    fn image_abr_write_pads_every_section_to_four_bytes() {
        let f = write_abr(&[], &[sample("odd-length-id")]);
        // version words + two sections, each framed and padded.
        assert_eq!(f.len() % 4, 0);
        let parsed = AbrFile::parse(&f).unwrap();
        assert_eq!(parsed.samples.len(), 1);
    }
}
