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

//! `.abr` brush presets, projected onto the parameters the paint engine
//! actually has — the bundle door over `image_psd::abr`.
//!
//! WHY THIS FILE EXISTS. The `.abr` reader is a large, corpus-gated,
//! spec-cited parser (3,215 presets across the analyst corpus), and until
//! now NOTHING called it. A wasm32 release build therefore eliminated it
//! wholesale: the capability existed in the repository and not in the
//! shipped artifact, which is the worst of both — the cost of carrying it
//! with none of the benefit, and a registry row that reads shipped.
//!
//! WHAT IT DELIBERATELY DOES NOT DO. The reader models far more than the
//! paint engine consumes: bristle physics, erodible height maps, dual
//! brushes, every jitter axis, the `phry` folder tree. Projecting all of
//! that would invent a UI for parameters no kernel reads. This door
//! surfaces exactly the four the brush machine takes — **size**,
//! **hardness**, **roundness/angle** (recorded, see below) and
//! **spacing** — plus the honest shape of what was skipped.
//!
//! Three honesty rules, each of which the corpus forced:
//!
//! * **Hardness is not universal.** Only a `computedBrush` carries
//!   `Hrdn`; a sampled (bitmap) tip has no such parameter, and an
//!   erodible tip's is optional. `null` means "the file does not say",
//!   never a substituted default — a preset that silently applied 0.5
//!   hardness to a bitmap tip would be fabricating.
//! * **Diameter is not always pixels.** `Dmtr` carries its own unit, and
//!   the reader keeps a non-`#Pxl` unit verbatim rather than rejecting
//!   it. The unit rides along so the panel can refuse to apply rather
//!   than apply a wrong number confidently.
//! * **An unsupported tip is still a preset.** `Unsupported`/`Missing`
//!   tips are LISTED, with `kind` saying so and no parameters — the
//!   reader's own §5 rule ("one exotic brush must not take out a
//!   500-brush library") carried through to the surface.
//!
//! The projection is a pure function over parsed bytes so it is testable
//! on the host; `mod wasm` is `#[cfg(target_arch = "wasm32")]` and never
//! type-checks there.

use image_psd::abr::{
    AbrBrush, AbrFile, AbrTip, BlendMode, ControlSource, Dynamics, OptionSource, ToolKind,
};
use image_psd::Result;

/// One preset, reduced to what the paint engine can act on.
#[derive(Debug, Clone, PartialEq)]
pub struct BrushPreset {
    /// Position in the file's `Brsh` list. **Load-bearing** — the folder
    /// tree refers to presets positionally, so this is the id.
    pub index: usize,
    pub name: String,
    /// `computed` | `sampled` | `bristle` | `erodible` | `unsupported` |
    /// `missing`. The panel shows it because the parameters available
    /// differ by kind, and a missing slider should be explicable.
    pub kind: &'static str,
    /// `Dmtr` as stored, in `diameter_unit`.
    pub diameter: Option<f64>,
    /// The four-byte unit tag, e.g. `#Pxl`. `None` when the tip carries
    /// no common block at all.
    pub diameter_unit: Option<String>,
    /// `Hrdn` as a 0..1 fraction where the tip has one.
    pub hardness: Option<f64>,
    /// `Spcn` as a fraction of the diameter.
    pub spacing: Option<f64>,
    /// `Intr` — when false, Photoshop spaces by cursor movement and
    /// `spacing` is inert. Surfaced so the panel does not apply a
    /// spacing the source disabled.
    pub spacing_enabled: Option<bool>,
    /// `Rndn` — minor/major axis ratio; 1.0 is circular.
    pub roundness: Option<f64>,
    pub angle_deg: Option<f64>,
    /// Index into the file's sampled tips for a `sampled` tip whose
    /// reference resolved — what `abr_tip` takes to fetch the bitmap.
    pub sample_index: Option<usize>,
}

impl BrushPreset {
    /// Whether the diameter can be read as pixels. A non-`#Pxl` unit is
    /// rare-to-unobserved but is not the same as absent, and the panel
    /// must not apply it as if it were px.
    pub fn diameter_is_pixels(&self) -> bool {
        self.diameter_unit.as_deref() == Some("#Pxl")
    }
}

/// Project a parsed `.abr` onto the paint engine's parameters.
pub fn presets_of(file: &AbrFile) -> Vec<BrushPreset> {
    file.brushes.iter().map(preset_of).collect()
}

fn preset_of(brush: &AbrBrush) -> BrushPreset {
    let kind = match &brush.tip {
        AbrTip::Computed(_) => "computed",
        AbrTip::Sampled(_) => "sampled",
        AbrTip::Bristle(_) => "bristle",
        AbrTip::Erodible(_) => "erodible",
        AbrTip::Unsupported { .. } => "unsupported",
        AbrTip::Missing => "missing",
    };
    // Hardness lives on two variants only, and on one of them it is
    // optional. Everything else reports `None` rather than a default.
    let hardness = match &brush.tip {
        AbrTip::Computed(t) => Some(t.hardness),
        AbrTip::Erodible(t) => t.hardness,
        _ => None,
    };
    let roundness = match &brush.tip {
        AbrTip::Computed(t) => Some(t.roundness),
        AbrTip::Sampled(t) => Some(t.roundness),
        _ => None,
    };
    let common = brush.tip.common();
    BrushPreset {
        index: brush.index,
        name: brush.name.clone(),
        kind,
        diameter: common.map(|c| c.diameter),
        diameter_unit: common.map(|c| unit_tag(&c.diameter_unit)),
        hardness,
        spacing: common.map(|c| c.spacing),
        spacing_enabled: common.map(|c| c.spacing_enabled),
        roundness,
        angle_deg: common.map(|c| c.angle_deg),
        sample_index: brush.tip.as_sampled().and_then(|t| t.sample_index),
    }
}

/// A four-byte unit tag as text. Non-ASCII bytes are hex-escaped rather
/// than lossily replaced — the tag is diagnostic, and `#Pxl` is the only
/// value the panel acts on anyway.
fn unit_tag(raw: &[u8; 4]) -> String {
    if raw.iter().all(|b| b.is_ascii_graphic()) {
        String::from_utf8_lossy(raw).into_owned()
    } else {
        raw.iter().map(|b| format!("{b:02x}")).collect()
    }
}

/// Parse `.abr` bytes and render the presets as JSON for the panel.
///
/// Shape: `{version, minorVersion, presetCount, sampleCount, warnings,
/// presets: [...]}`. `warnings` is the reader's own diagnostic list,
/// carried through rather than swallowed — a file that parsed WITH
/// complaints is a different state from one that parsed cleanly.
pub fn presets_json(bytes: &[u8]) -> Result<String> {
    let file = AbrFile::parse(bytes)?;
    Ok(render_json(&file))
}

fn render_json(file: &AbrFile) -> String {
    let presets = presets_of(file);
    let rows: Vec<String> = presets
        .iter()
        .zip(&file.brushes)
        .map(|(p, b)| row_json(p, &dynamics_json(b)))
        .collect();
    // `AbrWarning` is a structured enum with no `Display` — its `Debug`
    // form carries the fields (which id, which counts) that make a
    // warning actionable, so it is what the panel shows.
    let warnings: Vec<String> = file
        .warnings
        .iter()
        .map(|w| json_string(&format!("{w:?}")))
        .collect();
    format!(
        "{{\"version\":{},\"minorVersion\":{},\"presetCount\":{},\"sampleCount\":{},\
         \"warnings\":[{}],\"presets\":[{}]}}",
        file.version,
        file.minor_version,
        presets.len(),
        file.samples.len(),
        warnings.join(","),
        rows.join(",")
    )
}

fn row_json(p: &BrushPreset, dynamics: &str) -> String {
    format!(
        "{{\"index\":{},\"name\":{},\"kind\":\"{}\",\"diameter\":{},\"diameterUnit\":{},\
         \"hardness\":{},\"spacing\":{},\"spacingEnabled\":{},\"roundness\":{},\"angle\":{},\
         \"sampleIndex\":{},\"dynamics\":{}}}",
        p.index,
        json_string(&p.name),
        p.kind,
        json_num(p.diameter),
        p.diameter_unit
            .as_deref()
            .map_or_else(|| "null".to_string(), json_string),
        json_num(p.hardness),
        json_num(p.spacing),
        p.spacing_enabled
            .map_or_else(|| "null".to_string(), |b| b.to_string()),
        json_num(p.roundness),
        json_num(p.angle_deg),
        p.sample_index
            .map_or_else(|| "null".to_string(), |i| i.to_string()),
        dynamics,
    )
}

// ── the dynamics projection: EVERY parsed field ──────────────────────
//
// Nothing here is converted beyond what the reader already did (percents
// are fractions, angles degrees, counts numbers): the glue maps these onto
// its own brush settings and reports what it cannot apply. A group the
// file's gate switched off is `null`, never a block of defaults.

/// A JSON object under construction (keys in insertion order).
struct Obj(Vec<String>);

impl Obj {
    fn new() -> Obj {
        Obj(Vec::new())
    }
    fn raw(mut self, k: &str, v: String) -> Obj {
        self.0.push(format!("{}:{v}", json_string(k)));
        self
    }
    fn num(self, k: &str, v: Option<f64>) -> Obj {
        self.raw(k, json_num(v))
    }
    fn int(self, k: &str, v: Option<i32>) -> Obj {
        self.raw(k, v.map_or_else(|| "null".into(), |i| i.to_string()))
    }
    fn bool(self, k: &str, v: Option<bool>) -> Obj {
        self.raw(k, v.map_or_else(|| "null".into(), |b| b.to_string()))
    }
    fn str(self, k: &str, v: Option<&str>) -> Obj {
        self.raw(k, v.map_or_else(|| "null".into(), json_string))
    }
    fn done(self) -> String {
        format!("{{{}}}", self.0.join(","))
    }
}

fn opt<T>(v: Option<&T>, f: impl FnOnce(&T) -> String) -> String {
    v.map_or_else(|| "null".to_string(), f)
}

/// The control's name in the glue's vocabulary (`BrushControl`).
pub fn control_name(c: ControlSource) -> &'static str {
    match c {
        ControlSource::Off => "off",
        ControlSource::Fade => "fade",
        ControlSource::PenPressure => "pressure",
        ControlSource::PenTilt => "tilt",
        ControlSource::StylusWheel => "wheel",
        ControlSource::InitialDirection => "initialDirection",
        ControlSource::Direction => "direction",
        ControlSource::InitialRotation => "initialRotation",
        ControlSource::Rotation => "rotation",
    }
}

fn dyn_json(d: Option<&Dynamics>) -> String {
    opt(d, |d| {
        Obj::new()
            .int("control", Some(d.control_ordinal))
            .str("controlName", Some(control_name(d.control)))
            .int("fade", Some(d.fade_steps))
            .num("jitter", Some(d.jitter))
            .num("minimum", d.minimum)
            .done()
    })
}

fn blend_name(m: Option<BlendMode>) -> Option<&'static str> {
    m.map(BlendMode::name)
}

fn source_name(s: OptionSource) -> &'static str {
    match s {
        OptionSource::Absent => "absent",
        OptionSource::Brush => "brush",
        OptionSource::ToolOptions => "toolOptions",
    }
}

fn tip_kind(t: &AbrTip) -> &'static str {
    match t {
        AbrTip::Computed(_) => "computed",
        AbrTip::Sampled(_) => "sampled",
        AbrTip::Bristle(_) => "bristle",
        AbrTip::Erodible(_) => "erodible",
        AbrTip::Unsupported { .. } => "unsupported",
        AbrTip::Missing => "missing",
    }
}

/// Every dynamics group of `b`, as the nested `dynamics` object.
pub fn dynamics_json(b: &AbrBrush) -> String {
    let common = b.tip.common();
    let tip = Obj::new()
        .bool("flipX", common.map(|c| c.flip_x))
        .bool("flipY", common.map(|c| c.flip_y))
        .done();
    let shape = opt(b.shape_dynamics.as_ref(), |s| {
        Obj::new()
            .raw("size", dyn_json(s.size.as_ref()))
            .raw("angle", dyn_json(s.angle.as_ref()))
            .raw("roundness", dyn_json(s.roundness.as_ref()))
            .num("minimumDiameter", s.minimum_diameter)
            .num("minimumRoundness", s.minimum_roundness)
            .num("tiltScale", s.tilt_scale)
            .bool("flipXJitter", s.flip_x_jitter)
            .bool("flipYJitter", s.flip_y_jitter)
            .bool("projection", s.brush_projection)
            .done()
    });
    let scatter = opt(b.scatter.as_ref(), |s| {
        Obj::new()
            .raw("scatter", dyn_json(s.scatter.as_ref()))
            .num("count", s.count)
            .raw("countJitter", dyn_json(s.count_dynamics.as_ref()))
            .bool("bothAxes", s.both_axes)
            .done()
    });
    let texture = opt(b.texture.as_ref(), |t| {
        Obj::new()
            .str("patternId", t.pattern_id.as_deref())
            .str("patternName", t.pattern_name.as_deref())
            .str("mode", blend_name(t.blend_mode))
            .num("scale", t.scale)
            .num("depth", t.depth)
            .num("minimumDepth", t.minimum_depth)
            .raw("depthJitter", dyn_json(t.depth_dynamics.as_ref()))
            .bool("invert", t.invert)
            .int("brightness", t.brightness)
            .int("contrast", t.contrast)
            .bool("eachTip", t.per_tip)
            .done()
    });
    let dual = opt(b.dual_brush.as_ref(), |d| {
        let t = d.tip.as_deref();
        let c = t.and_then(AbrTip::common);
        let (roundness, hardness) = match t {
            Some(AbrTip::Computed(x)) => (Some(x.roundness), Some(x.hardness)),
            Some(AbrTip::Sampled(x)) => (Some(x.roundness), None),
            _ => (None, None),
        };
        Obj::new()
            .bool("enabled", Some(d.enabled))
            .str("kind", t.map(tip_kind))
            .num("diameter", c.map(|c| c.diameter))
            .str(
                "diameterUnit",
                c.map(|c| unit_tag(&c.diameter_unit)).as_deref(),
            )
            .num("roundness", roundness)
            .num("hardness", hardness)
            .num("tipSpacing", c.map(|c| c.spacing))
            .num("angle", c.map(|c| c.angle_deg))
            .raw(
                "sampleIndex",
                t.and_then(AbrTip::as_sampled)
                    .and_then(|s| s.sample_index)
                    .map_or_else(|| "null".into(), |i| i.to_string()),
            )
            .bool("flip", d.flip)
            .str("mode", blend_name(d.blend_mode))
            .bool("useScatter", d.use_scatter)
            .num("spacing", d.spacing)
            .num("count", d.count)
            .bool("bothAxes", d.both_axes)
            .raw("countJitter", dyn_json(d.count_dynamics.as_ref()))
            .raw("scatter", dyn_json(d.scatter_dynamics.as_ref()))
            .done()
    });
    let color = opt(b.color_dynamics.as_ref(), |c| {
        Obj::new()
            .raw("fgBg", dyn_json(c.foreground_background.as_ref()))
            .num("hue", c.hue)
            .num("saturation", c.saturation)
            .num("brightness", c.brightness)
            .num("purity", c.purity)
            .bool("perTip", c.per_tip)
            .done()
    });
    let transfer = opt(b.transfer.as_ref(), |t| {
        Obj::new()
            .raw("flow", dyn_json(t.flow.as_ref()))
            .raw("opacity", dyn_json(t.opacity.as_ref()))
            .raw("wetness", dyn_json(t.wetness.as_ref()))
            .raw("mix", dyn_json(t.mix.as_ref()))
            .done()
    });
    let pose = opt(b.brush_pose.as_ref(), |p| {
        Obj::new()
            .bool("overrideAngle", p.override_angle)
            .bool("overrideTiltX", p.override_tilt_x)
            .bool("overrideTiltY", p.override_tilt_y)
            .bool("overridePressure", p.override_pressure)
            .num("pressure", p.pressure)
            .int("tiltX", p.tilt_x)
            .int("tiltY", p.tilt_y)
            .int("angle", p.angle)
            .done()
    });
    let o = &b.options;
    let smoothing = opt(o.smoothing.as_ref(), |s| {
        Obj::new()
            .bool("enabled", s.enabled)
            .num("amount", s.amount())
            .bool("radiusMode", s.radius_mode)
            .bool("catchUp", s.catch_up)
            .bool("catchUpAtEnd", s.catch_up_at_end)
            .bool("zoomCompensation", s.zoom_compensation)
            .bool("pressureSmoothing", s.pressure_smoothing)
            .str("source", Some(source_name(s.source)))
            .done()
    });
    let tool = opt(b.tool_options.as_ref(), |t| {
        Obj::new()
            .str(
                "kind",
                Some(match t.kind {
                    ToolKind::Mixer => "mixer",
                    ToolKind::Smudge => "smudge",
                    ToolKind::PlainBrush => "brush",
                }),
            )
            .str("classId", Some(&t.class_id))
            // 0..100 plain numbers on the wire, fractions here.
            .num("flow", Some(t.flow / 100.0))
            .num("opacity", Some(t.opacity / 100.0))
            .str("blend", Some(t.blend_mode.name()))
            .done()
    });
    Obj::new()
        .raw("tip", tip)
        .raw("shape", shape)
        .raw("scatter", scatter)
        .raw("texture", texture)
        .raw("dual", dual)
        .raw("color", color)
        .raw("transfer", transfer)
        .raw("pose", pose)
        .bool("wetEdges", b.wet_edges)
        .bool("noise", b.noise)
        .bool("buildUp", o.build_up)
        .bool("protectTexture", o.protect_texture)
        .bool("pressureOverridesSize", o.pressure_overrides_size)
        .bool("pressureOverridesOpacity", o.pressure_overrides_opacity)
        .raw("smoothing", smoothing)
        .raw("toolOptions", tool)
        .done()
}

/// The sampled tip `index` of `bytes` as `[w u32 LE, h u32 LE, alpha…]`
/// — 8-bit coverage, a 16-bit tip reduced by the explicit lossy call.
pub fn tip_bitmap(bytes: &[u8], index: usize) -> Result<Vec<u8>> {
    let file = AbrFile::parse(bytes)?;
    let s = file.samples.get(index).ok_or_else(|| {
        image_psd::PsdError::Unsupported(format!(
            "no sampled tip {index} (the file has {})",
            file.samples.len()
        ))
    })?;
    let mut out = Vec::with_capacity(8 + (s.width * s.height) as usize);
    out.extend_from_slice(&s.width.to_le_bytes());
    out.extend_from_slice(&s.height.to_le_bytes());
    out.extend_from_slice(&s.coverage8());
    Ok(out)
}

/// `f64` as JSON, with the non-finite trap closed: `NaN`/`Infinity` are
/// not JSON and would make `JSON.parse` throw on the panel side, turning
/// one odd preset into a whole-file failure. They render as `null`,
/// which is the same "the file does not say" the panel already handles.
fn json_num(v: Option<f64>) -> String {
    match v {
        Some(f) if f.is_finite() => format!("{f}"),
        _ => "null".to_string(),
    }
}

/// Minimal JSON string escape. `mod wasm` has its own copy for the PSD
/// doors; this one is host-testable, which is the point of the module.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// ── the writer's door: a preset from the glue's brush settings ───────
//
// The glue holds its presets as its own brush settings; exporting them
// as `.abr` goes through `image_psd::abr::write_abr`. The values cross
// as an f32 array IN THE ORDER OF [`EXPORT_KEYS`] — the glue packs by
// name from this list (`abr_export_keys`), as it does for the stroke's
// dynamics, and the names are the glue's own dynamics keys wherever the
// concept is the same.
//
// NOT EXPORTED, and why: the texture (an `.abr` pattern is a `patt`
// record, and this crate keeps patterns opaque — a texture whose `Idnt`
// names no pattern would load as a broken preset), the bitmap of a dual
// tip (the dual tip is written as a computed round tip), and the
// symmetry / smoothing radius / lock-transparency settings, which are
// tool state in Photoshop rather than preset fields. Smoothing's AMOUNT
// and its two catch-up flags ARE preset fields and are written.

/// The per-preset values `abr_export_add` takes, in order.
pub const EXPORT_KEYS: &[&str] = &[
    "diameter",
    "hardness",
    "spacing",
    "opacity",
    "flow",
    "tip.angle",
    "tip.roundness",
    "tip.flipX",
    "tip.flipY",
    "tip.spacingEnabled",
    "shape.enabled",
    "shape.size.jitter",
    "shape.size.control",
    "shape.size.fade",
    "shape.size.min",
    "shape.minDiameter",
    "shape.tiltScale",
    "shape.angle.jitter",
    "shape.angle.control",
    "shape.angle.fade",
    "shape.angle.min",
    "shape.roundness.jitter",
    "shape.roundness.control",
    "shape.roundness.fade",
    "shape.roundness.min",
    "shape.minRoundness",
    "shape.flipXJitter",
    "shape.flipYJitter",
    "shape.projection",
    "scatter.enabled",
    "scatter.amount.jitter",
    "scatter.amount.control",
    "scatter.amount.fade",
    "scatter.amount.min",
    "scatter.bothAxes",
    "scatter.count",
    "scatter.countJitter.jitter",
    "scatter.countJitter.control",
    "scatter.countJitter.fade",
    "scatter.countJitter.min",
    "dual.enabled",
    "dual.mode",
    "dual.diameter",
    "dual.spacing",
    "dual.scatter",
    "dual.bothAxes",
    "dual.count",
    "dual.roundness",
    "dual.flip",
    "color.enabled",
    "color.fgBg.jitter",
    "color.fgBg.control",
    "color.fgBg.fade",
    "color.fgBg.min",
    "color.hue",
    "color.saturation",
    "color.brightness",
    "color.purity",
    "color.perTip",
    "transfer.enabled",
    "transfer.opacity.jitter",
    "transfer.opacity.control",
    "transfer.opacity.fade",
    "transfer.opacity.min",
    "transfer.flow.jitter",
    "transfer.flow.control",
    "transfer.flow.fade",
    "transfer.flow.min",
    "pose.enabled",
    "pose.tiltX",
    "pose.tiltY",
    "pose.rotation",
    "pose.pressure",
    "pose.overrideTilt",
    "pose.overrideRotation",
    "pose.overridePressure",
    "noise",
    "wetEdges",
    "buildUp",
    "smoothing.amount",
    "smoothing.catchUp",
    "smoothing.catchUpEnd",
    "smoothing.zoomCompensation",
    "protectTexture",
];

/// The dual tip's combine modes, in the glue's `COMBINE_MODES` order.
const COMBINE_MODES: [BlendMode; 10] = [
    BlendMode::Multiply,
    BlendMode::SubtractionTexture,
    BlendMode::Darken,
    BlendMode::Overlay,
    BlendMode::ColorDodge,
    BlendMode::ColorBurn,
    BlendMode::LinearBurn,
    BlendMode::HardMix,
    BlendMode::LinearHeight,
    BlendMode::Height,
];

/// A deterministic, UUID-shaped sample id (Photoshop writes 36-char
/// UUIDs; the join is plain string equality, so any unique id works —
/// this one keeps an export byte-reproducible).
fn sample_id(n: usize, name: &str) -> String {
    // The workspace's one stateless mix (`image_gpu::brush::hash3`),
    // folded over the name, seeded by the position.
    let h = name.bytes().fold(n as u64, |h, b| {
        image_gpu::brush::hash3(h, b as u64, 0xAB12)
    });
    let g = h.rotate_left(29) ^ 0x9e37_79b9_7f4a_7c15;
    format!(
        "{:08x}-{:04x}-4{:03x}-8{:03x}-{:012x}",
        (h >> 32) as u32,
        (h >> 16) as u16,
        (h & 0xfff) as u16,
        (g >> 52) as u16 & 0xfff,
        g & 0xffff_ffff_ffff
    )
}

/// One exported preset, built from the glue's packed values. `bitmap`
/// is `(w, h, alpha)` for a sampled tip, `None` for the round tip.
/// `n` is the preset's position in the export (it names the sample).
pub fn export_brush(
    n: usize,
    name: &str,
    values: &[f32],
    bitmap: Option<(u32, u32, &[u8])>,
) -> std::result::Result<(AbrBrush, Option<image_psd::abr::AbrSample>), String> {
    use image_psd::abr::model::*;
    use image_psd::descriptor::{units, Descriptor};
    use image_psd::vm_array::{VmRect, VmSamples};

    if values.len() != EXPORT_KEYS.len() {
        return Err(format!(
            "abr_export_add takes {} values (abr_export_keys), got {}",
            EXPORT_KEYS.len(),
            values.len()
        ));
    }
    let v = |k: &str| -> f64 {
        let i = EXPORT_KEYS
            .iter()
            .position(|x| *x == k)
            .expect("a known key");
        let x = values[i] as f64;
        if x.is_finite() {
            x
        } else {
            0.0
        }
    };
    let on = |k: &str| v(k) != 0.0;
    let dynamics = |p: &str| -> Option<Dynamics> {
        let ordinal = v(&format!("{p}.control")).round() as i32;
        let min = v(&format!("{p}.min"));
        Some(Dynamics {
            control_ordinal: ordinal,
            control: ControlSource::from_ordinal(ordinal).unwrap_or(ControlSource::Off),
            fade_steps: v(&format!("{p}.fade")).round() as i32,
            jitter: v(&format!("{p}.jitter")),
            minimum: (min != 0.0).then_some(min),
        })
    };
    let common = TipCommon {
        diameter: v("diameter").max(1.0),
        diameter_unit: units::PIXELS,
        angle_deg: v("tip.angle"),
        spacing: v("spacing"),
        spacing_enabled: on("tip.spacingEnabled"),
        flip_x: on("tip.flipX"),
        flip_y: on("tip.flipY"),
    };
    let roundness = v("tip.roundness").clamp(0.01, 1.0);
    let mut sample = None;
    let tip = match bitmap {
        Some((w, h, alpha)) if w > 0 && h > 0 => {
            if alpha.len() != (w as usize) * (h as usize) {
                return Err(format!("tip bitmap is {} bytes for {w}x{h}", alpha.len()));
            }
            let id = sample_id(n, name);
            sample = Some(image_psd::abr::AbrSample {
                id: id.clone(),
                bounds: VmRect {
                    top: 0,
                    left: 0,
                    bottom: h as i32,
                    right: w as i32,
                },
                width: w,
                height: h,
                depth: 8,
                coverage: VmSamples::Eight(alpha.to_vec()),
            });
            AbrTip::Sampled(SampledTipRef {
                common,
                roundness,
                name: Some(name.to_string()),
                sampled_id: id,
                sample_index: Some(0),
            })
        }
        _ => AbrTip::Computed(ComputedTip {
            common,
            roundness,
            hardness: v("hardness").clamp(0.0, 1.0),
        }),
    };
    let mode = COMBINE_MODES
        .get(v("dual.mode").round().max(0.0) as usize)
        .copied()
        .unwrap_or(BlendMode::Multiply);
    let dual_diameter = v("dual.diameter").max(1.0);
    let scatter_jitter = v("dual.scatter");
    let opacity = v("opacity").clamp(0.0, 1.0);
    let flow = v("flow").clamp(0.0, 1.0);
    let brush = AbrBrush {
        index: n,
        name: name.to_string(),
        descriptor: Descriptor::default(),
        tip,
        wet_edges: Some(on("wetEdges")),
        noise: Some(on("noise")),
        use_brush_size: None,
        brush_spacing: None,
        shape_dynamics: on("shape.enabled").then(|| ShapeDynamics {
            size: dynamics("shape.size"),
            angle: dynamics("shape.angle"),
            roundness: dynamics("shape.roundness"),
            minimum_diameter: Some(v("shape.minDiameter")),
            minimum_roundness: Some(v("shape.minRoundness")),
            tilt_scale: Some(v("shape.tiltScale")),
            flip_x_jitter: Some(on("shape.flipXJitter")),
            flip_y_jitter: Some(on("shape.flipYJitter")),
            brush_projection: Some(on("shape.projection")),
        }),
        scatter: on("scatter.enabled").then(|| Scatter {
            scatter: dynamics("scatter.amount"),
            count_dynamics: dynamics("scatter.countJitter"),
            count: Some(v("scatter.count").round().max(1.0)),
            both_axes: Some(on("scatter.bothAxes")),
        }),
        texture: None,
        dual_brush: Some(DualBrush {
            enabled: on("dual.enabled"),
            tip: Some(Box::new(AbrTip::Computed(ComputedTip {
                common: TipCommon {
                    diameter: dual_diameter,
                    diameter_unit: units::PIXELS,
                    angle_deg: 0.0,
                    spacing: v("dual.spacing"),
                    spacing_enabled: true,
                    flip_x: false,
                    flip_y: false,
                },
                roundness: v("dual.roundness").clamp(0.01, 1.0),
                hardness: 1.0,
            }))),
            flip: Some(on("dual.flip")),
            blend_mode: Some(mode),
            use_scatter: Some(scatter_jitter > 0.0),
            spacing: Some(v("dual.spacing")),
            count: Some(v("dual.count").round().max(1.0)),
            both_axes: Some(on("dual.bothAxes")),
            count_dynamics: None,
            scatter_dynamics: Some(Dynamics {
                control_ordinal: 0,
                control: ControlSource::Off,
                fade_steps: 25,
                jitter: scatter_jitter,
                minimum: None,
            }),
        }),
        color_dynamics: on("color.enabled").then(|| ColorDynamics {
            foreground_background: dynamics("color.fgBg"),
            hue: Some(v("color.hue")),
            saturation: Some(v("color.saturation")),
            brightness: Some(v("color.brightness")),
            purity: Some(v("color.purity")),
            per_tip: Some(on("color.perTip")),
        }),
        transfer: on("transfer.enabled").then(|| Transfer {
            flow: dynamics("transfer.flow"),
            opacity: dynamics("transfer.opacity"),
            wetness: None,
            mix: None,
        }),
        brush_pose: on("pose.enabled").then(|| BrushPose {
            override_angle: Some(on("pose.overrideRotation")),
            override_tilt_x: Some(on("pose.overrideTilt")),
            override_tilt_y: Some(on("pose.overrideTilt")),
            override_pressure: Some(on("pose.overridePressure")),
            pressure: Some(v("pose.pressure")),
            tilt_x: Some(v("pose.tiltX").round() as i32),
            tilt_y: Some(v("pose.tiltY").round() as i32),
            angle: Some(v("pose.rotation").round() as i32),
        }),
        // Opacity and flow are tool state; they travel in the one
        // `toolOptions` shape the corpus pins (class `PbTl`, 0..100
        // plain numbers), and only when they are not full.
        tool_options: (opacity < 1.0 || flow < 1.0).then(|| {
            let mut d = Descriptor {
                class_name: String::new(),
                class_id: image_psd::descriptor::Key::four(b"PbTl"),
                items: Vec::new(),
            };
            use image_psd::descriptor::{DescriptorValue, Key};
            d.items.push((
                Key::long("flow"),
                DescriptorValue::Integer((flow * 100.0).round() as i32),
            ));
            d.items.push((
                Key::four(b"Opct"),
                DescriptorValue::Integer((opacity * 100.0).round() as i32),
            ));
            ToolOptions {
                kind: ToolKind::PlainBrush,
                class_id: "PbTl".into(),
                flow: (flow * 100.0).round(),
                opacity: (opacity * 100.0).round(),
                blend_mode: BlendMode::Normal,
                descriptor: d,
            }
        }),
        options: BrushOptions {
            build_up: Some(on("buildUp")),
            build_up_source: OptionSource::Brush,
            smoothing: Some(Smoothing {
                enabled: Some(v("smoothing.amount") > 0.0),
                value_raw: Some((v("smoothing.amount") * 100.0).round()),
                radius_mode: None,
                catch_up: Some(on("smoothing.catchUp")),
                catch_up_at_end: Some(on("smoothing.catchUpEnd")),
                zoom_compensation: Some(on("smoothing.zoomCompensation")),
                pressure_smoothing: None,
                smoo_raw: None,
                source: OptionSource::Brush,
            }),
            protect_texture: Some(on("protectTexture")),
            protect_texture_source: OptionSource::Brush,
            pressure_overrides_size: None,
            pressure_overrides_opacity: None,
            use_legacy: None,
            brush_group_present: true,
            use_brush_group: Some(false),
            interpretation: None,
        },
    };
    Ok((brush, sample))
}

/// An export in progress (the `abr_export_*` doors hold one).
#[derive(Default)]
pub struct AbrExport {
    brushes: Vec<AbrBrush>,
    samples: Vec<image_psd::abr::AbrSample>,
}

impl AbrExport {
    pub fn add(
        &mut self,
        name: &str,
        values: &[f32],
        bitmap: Option<(u32, u32, &[u8])>,
    ) -> std::result::Result<(), String> {
        let (mut b, s) = export_brush(self.brushes.len(), name, values, bitmap)?;
        if let Some(s) = s {
            if let AbrTip::Sampled(t) = &mut b.tip {
                t.sample_index = Some(self.samples.len());
            }
            self.samples.push(s);
        }
        self.brushes.push(b);
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.brushes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.brushes.is_empty()
    }

    pub fn finish(self) -> Vec<u8> {
        image_psd::abr::write_abr(&self.brushes, &self.samples)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image_psd::abr::model::{ComputedTip, SampledTipRef, TipCommon};
    use image_psd::descriptor::{Descriptor, Key};

    fn empty_descriptor() -> Descriptor {
        Descriptor {
            class_name: String::new(),
            class_id: Key::four(b"Brsh"),
            items: Vec::new(),
        }
    }

    fn common(diameter: f64, unit: [u8; 4]) -> TipCommon {
        TipCommon {
            diameter,
            diameter_unit: unit,
            angle_deg: 12.5,
            spacing: 0.25,
            spacing_enabled: true,
            flip_x: false,
            flip_y: false,
        }
    }

    fn brush(name: &str, index: usize, tip: AbrTip) -> AbrBrush {
        AbrBrush {
            index,
            name: name.to_string(),
            descriptor: empty_descriptor(),
            tip,
            wet_edges: None,
            noise: None,
            use_brush_size: None,
            brush_spacing: None,
            shape_dynamics: None,
            scatter: None,
            texture: None,
            dual_brush: None,
            color_dynamics: None,
            transfer: None,
            brush_pose: None,
            tool_options: None,
            options: Default::default(),
        }
    }

    fn file_of(brushes: Vec<AbrBrush>) -> AbrFile {
        AbrFile {
            version: 6,
            minor_version: 2,
            samples: Vec::new(),
            brushes,
            hierarchy: Vec::new(),
            patterns_raw: None,
            unknown_sections: Vec::new(),
            warnings: Vec::new(),
        }
    }

    /// The door must refuse a non-`.abr` by NAME, not by producing an
    /// empty preset list — "no brushes" and "not a brush file" are
    /// different answers and the panel shows different things for them.
    #[test]
    fn image_abr_engine_bridge_rejects_non_abr_bytes() {
        let err = presets_json(b"\x89PNG\r\n\x1a\n and then some").unwrap_err();
        let msg = err.to_string();
        assert!(
            !msg.is_empty(),
            "a rejection must carry a reason, got an empty message"
        );
    }

    /// An empty container is a legal file: version + minor + no sections.
    /// It must produce a parseable, EMPTY document rather than an error —
    /// otherwise the panel cannot distinguish "loaded, nothing in it"
    /// from "failed".
    #[test]
    fn image_abr_engine_bridge_empty_container_renders_empty_json() {
        let mut bytes = 6i16.to_be_bytes().to_vec();
        bytes.extend_from_slice(&2i16.to_be_bytes());
        let json = presets_json(&bytes).expect("an empty v6.2 container parses");
        assert!(json.contains("\"version\":6"), "{json}");
        assert!(json.contains("\"presetCount\":0"), "{json}");
        assert!(json.contains("\"presets\":[]"), "{json}");
    }

    /// Names come from an untrusted file and go straight into JSON. A
    /// quote or a newline in a preset name must not be able to break the
    /// document the panel parses.
    #[test]
    fn image_abr_engine_bridge_escapes_hostile_preset_names() {
        let escaped = json_string("he said \"hi\"\n\tand \\ left\u{1}");
        assert_eq!(escaped, "\"he said \\\"hi\\\"\\n\\tand \\\\ left\\u0001\"");
    }

    /// Non-finite parameters render as `null`, not as the literal `NaN`
    /// that would make `JSON.parse` throw for the whole file.
    #[test]
    fn image_abr_engine_bridge_non_finite_numbers_become_null() {
        assert_eq!(json_num(Some(f64::NAN)), "null");
        assert_eq!(json_num(Some(f64::INFINITY)), "null");
        assert_eq!(json_num(None), "null");
        assert_eq!(json_num(Some(30.0)), "30");
    }

    /// The unit tag decides whether the panel may treat the diameter as
    /// pixels at all.
    #[test]
    fn image_abr_engine_bridge_only_pxl_diameters_are_pixels() {
        let mut p = BrushPreset {
            index: 0,
            name: "t".into(),
            kind: "computed",
            diameter: Some(30.0),
            diameter_unit: Some("#Pxl".into()),
            hardness: Some(0.5),
            spacing: Some(0.25),
            spacing_enabled: Some(true),
            roundness: Some(1.0),
            angle_deg: Some(0.0),
            sample_index: None,
        };
        assert!(p.diameter_is_pixels());
        p.diameter_unit = Some("#Prc".into());
        assert!(!p.diameter_is_pixels(), "a percentage is not a pixel count");
        p.diameter_unit = None;
        assert!(!p.diameter_is_pixels());
    }

    /// A four-byte tag with non-printable bytes is hex-escaped rather
    /// than turned into replacement characters — it is diagnostic output.
    #[test]
    fn image_abr_engine_bridge_binary_unit_tags_are_hex() {
        assert_eq!(unit_tag(b"#Pxl"), "#Pxl");
        assert_eq!(unit_tag(&[0x00, 0xff, 0x10, 0x41]), "00ff1041");
    }

    /// The projection itself: a computed tip yields every parameter the
    /// brush machine takes, in the units it takes them.
    #[test]
    fn image_abr_engine_bridge_projects_a_computed_tip_onto_brush_params() {
        let tip = AbrTip::Computed(ComputedTip {
            common: common(30.0, *b"#Pxl"),
            roundness: 0.8,
            hardness: 0.25,
        });
        let file = file_of(vec![brush("Soft Round", 0, tip)]);
        let p = &presets_of(&file)[0];
        assert_eq!(p.kind, "computed");
        assert_eq!(p.name, "Soft Round");
        assert_eq!(p.diameter, Some(30.0));
        assert!(p.diameter_is_pixels());
        assert_eq!(p.hardness, Some(0.25));
        assert_eq!(p.roundness, Some(0.8));
        assert_eq!(p.spacing, Some(0.25));
        assert_eq!(p.spacing_enabled, Some(true));
        assert_eq!(p.angle_deg, Some(12.5));
    }

    /// A SAMPLED tip has no `Hrdn` at all, and the honest answer is
    /// `null` — not a substituted default. This is the rule the panel's
    /// disabled Hardness row is built on, so it is pinned here.
    #[test]
    fn image_abr_engine_bridge_a_sampled_tip_reports_no_hardness() {
        let tip = AbrTip::Sampled(SampledTipRef {
            common: common(64.0, *b"#Pxl"),
            roundness: 1.0,
            name: Some("tip".into()),
            sampled_id: "0b0c4a97".into(),
            sample_index: Some(0),
        });
        let file = file_of(vec![brush("Chalk 60", 0, tip)]);
        let p = &presets_of(&file)[0];
        assert_eq!(p.kind, "sampled");
        assert_eq!(
            p.hardness, None,
            "a bitmap tip carries no hardness; inventing one would fabricate"
        );
        assert_eq!(p.diameter, Some(64.0), "but it does carry a size");
    }

    /// One exotic preset must not cost the library: an unsupported tip
    /// is LISTED, with its kind saying why it has no parameters, and the
    /// presets around it are untouched.
    #[test]
    fn image_abr_engine_bridge_an_unsupported_tip_is_listed_not_dropped() {
        let file = file_of(vec![
            brush(
                "ok",
                0,
                AbrTip::Computed(ComputedTip {
                    common: common(10.0, *b"#Pxl"),
                    roundness: 1.0,
                    hardness: 1.0,
                }),
            ),
            brush(
                "exotic",
                1,
                AbrTip::Unsupported {
                    class_id: "someFutureBrush".into(),
                },
            ),
            brush("headless", 2, AbrTip::Missing),
        ]);
        let presets = presets_of(&file);
        assert_eq!(presets.len(), 3, "no preset is dropped");
        assert_eq!(presets[1].kind, "unsupported");
        assert_eq!(presets[1].name, "exotic");
        assert_eq!(presets[1].diameter, None);
        assert_eq!(presets[2].kind, "missing");
        assert_eq!(presets[0].diameter, Some(10.0), "the good one still works");
    }

    /// THE WIRE, byte for byte.
    ///
    /// This exact string is also pinned in the bundle's
    /// `glue/test/brushes.spec.ts`, which feeds it to a fake wasm module
    /// to test the JSON→`BrushParams` mapping without needing real
    /// `.abr` bytes in Node. That split only stays honest if the two
    /// halves cannot drift silently — so if you change the shape here,
    /// this test fails FIRST and points at the spec that must change
    /// with it.
    #[test]
    fn image_abr_engine_bridge_the_wire_shape_is_pinned_on_both_sides() {
        let tip = AbrTip::Computed(ComputedTip {
            common: TipCommon {
                diameter: 30.0,
                diameter_unit: *b"#Pxl",
                angle_deg: 0.0,
                spacing: 0.25,
                spacing_enabled: true,
                flip_x: false,
                flip_y: false,
            },
            roundness: 1.0,
            hardness: 0.5,
        });
        let json = render_json(&file_of(vec![brush("Soft Round 30", 0, tip)]));
        assert_eq!(
            json,
            "{\"version\":6,\"minorVersion\":2,\"presetCount\":1,\"sampleCount\":0,\
             \"warnings\":[],\"presets\":[{\"index\":0,\"name\":\"Soft Round 30\",\
             \"kind\":\"computed\",\"diameter\":30,\"diameterUnit\":\"#Pxl\",\
             \"hardness\":0.5,\"spacing\":0.25,\"spacingEnabled\":true,\
             \"roundness\":1,\"angle\":0,\"sampleIndex\":null,\
             \"dynamics\":{\"tip\":{\"flipX\":false,\"flipY\":false},\"shape\":null,\
             \"scatter\":null,\"texture\":null,\"dual\":null,\"color\":null,\
             \"transfer\":null,\"pose\":null,\"wetEdges\":null,\"noise\":null,\
             \"buildUp\":null,\"protectTexture\":null,\"pressureOverridesSize\":null,\
             \"pressureOverridesOpacity\":null,\"smoothing\":null,\"toolOptions\":null}}]}"
        );
    }

    /// Every parsed group reaches the JSON — here a brush the WRITER made
    /// from the glue's values, read back by the reader, so the dynamics a
    /// user exports are the dynamics the next import shows.
    #[test]
    fn image_abr_engine_bridge_exports_and_projects_every_dynamics_group() {
        let mut values = vec![0f32; EXPORT_KEYS.len()];
        let mut set = |k: &str, x: f32| {
            values[EXPORT_KEYS.iter().position(|e| *e == k).unwrap()] = x;
        };
        set("diameter", 30.0);
        set("hardness", 0.5);
        set("spacing", 0.25);
        set("opacity", 0.8);
        set("flow", 1.0);
        set("tip.angle", 30.0);
        set("tip.roundness", 0.5);
        set("tip.spacingEnabled", 1.0);
        set("shape.enabled", 1.0);
        set("shape.size.jitter", 0.25);
        set("shape.size.control", 2.0);
        set("shape.size.fade", 25.0);
        set("scatter.enabled", 1.0);
        set("scatter.amount.jitter", 1.5);
        set("scatter.count", 3.0);
        set("dual.enabled", 1.0);
        set("dual.mode", 5.0);
        set("dual.diameter", 12.0);
        set("dual.spacing", 0.5);
        set("color.enabled", 1.0);
        set("color.hue", 0.1);
        set("transfer.enabled", 1.0);
        set("transfer.opacity.control", 2.0);
        set("pose.enabled", 1.0);
        set("pose.tiltX", -30.0);
        set("pose.overrideTilt", 1.0);
        set("wetEdges", 1.0);
        set("buildUp", 1.0);
        set("smoothing.amount", 0.4);
        set("smoothing.catchUp", 1.0);
        set("protectTexture", 1.0);
        let mut export = AbrExport::default();
        export.add("Round", &values, None).unwrap();
        let tip: Vec<u8> = (0..6).map(|i| i * 40).collect();
        export.add("Bitmap", &values, Some((3, 2, &tip))).unwrap();
        let bytes = export.finish();

        let json = presets_json(&bytes).unwrap();
        for needle in [
            "\"presetCount\":2",
            "\"kind\":\"computed\"",
            "\"kind\":\"sampled\"",
            "\"sampleIndex\":0",
            "\"angle\":30",
            "\"roundness\":0.5",
            "\"size\":{\"control\":2,\"controlName\":\"pressure\",\"fade\":25,\"jitter\":0.25",
            "\"scatter\":{\"scatter\":{\"control\":0",
            "\"count\":3",
            "\"mode\":\"colorBurn\"",
            "\"hue\":0.1",
            "\"tiltX\":-30",
            "\"wetEdges\":true",
            "\"buildUp\":true",
            "\"protectTexture\":true",
            "\"amount\":0.4",
            "\"opacity\":0.8",
        ] {
            assert!(json.contains(needle), "missing {needle} in {json}");
        }
        // The bitmap comes back byte-identical through `abr_tip`.
        let b = tip_bitmap(&bytes, 0).unwrap();
        assert_eq!(&b[..8], &[3, 0, 0, 0, 2, 0, 0, 0]);
        assert_eq!(&b[8..], &tip[..]);
        assert!(tip_bitmap(&bytes, 1).is_err(), "only one sampled tip");
        // And the file raises nothing but the [REF] colour-dynamics note.
        let f = AbrFile::parse(&bytes).unwrap();
        assert!(
            f.warnings.iter().all(|w| matches!(
                w,
                image_psd::abr::AbrWarning::ColorDynamicsUnverified { .. }
            )),
            "{:?}",
            f.warnings
        );
    }

    #[test]
    fn image_abr_engine_bridge_export_refuses_a_mis_sized_value_list() {
        let mut export = AbrExport::default();
        assert!(export.add("x", &[1.0, 2.0], None).is_err());
        let ok = vec![0f32; EXPORT_KEYS.len()];
        assert!(export.add("x", &ok, Some((4, 4, &[0u8; 3]))).is_err());
        assert!(export.is_empty());
    }

    /// The JSON the panel parses: keys present, indices preserved, and a
    /// `null` where a parameter is genuinely absent.
    #[test]
    fn image_abr_engine_bridge_json_carries_indices_and_nulls() {
        let file = file_of(vec![
            brush(
                "A",
                0,
                AbrTip::Computed(ComputedTip {
                    common: common(30.0, *b"#Pxl"),
                    roundness: 1.0,
                    hardness: 0.5,
                }),
            ),
            brush("B", 1, AbrTip::Missing),
        ]);
        let json = render_json(&file);
        assert!(json.contains("\"presetCount\":2"), "{json}");
        assert!(json.contains("\"index\":0,\"name\":\"A\""), "{json}");
        assert!(json.contains("\"hardness\":0.5"), "{json}");
        // B has no tip, so every parameter is null — and `index` is still
        // its position, because the folder tree addresses presets by it.
        assert!(json.contains("\"index\":1,\"name\":\"B\""), "{json}");
        assert!(
            json.contains("\"kind\":\"missing\",\"diameter\":null"),
            "{json}"
        );
    }
}
