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

//! BRUSH DYNAMICS — the panes of Brush Settings as a deterministic dab
//! PLANNER.
//!
//! A stroke is still a list of pointer samples walked at a spacing
//! ([`plan_pen_segment`], the pen-aware twin of `dab::plan_segment`).
//! Each dab the walk emits is handed to the [`DabPlanner`], which turns
//! it into zero or more [`PlannedStamp`]s: the Shape Dynamics jitter its
//! size, angle and roundness; Scattering offsets and multiplies it;
//! Transfer sets its flow and opacity ceiling; Color Dynamics its colour;
//! the texture depth jitter its depth; Brush Pose overrides the pen;
//! Symmetry mirrors or rotates the result. The stamps then go through
//! the ordinary accumulator.
//!
//! # Determinism (spec §6.3)
//!
//! Every stroke carries a SEED. The planner draws from a SplitMix64
//! stream in a FIXED order per dab — the same draws whether or not a pane
//! is enabled — so a stroke replays bit-identically from (params,
//! dynamics, samples), and switching one pane on does not reshuffle the
//! jitter of another. The dual tip draws from its own stream.
//!
//! # Conventions (this engine's; each is stated where it is applied)
//!
//! * Angles are degrees, counter-clockwise on screen (image y is down).
//! * A CONTROL scales a dynamic between its minimum and 1 (`off` = 1,
//!   `fade` = linear over the fade steps, pressure, tilt = `1 −
//!   |tilt|/90`, the wheel, rotation / 360). For the ANGLE the control
//!   instead SETS an angle (the direction, the pen's rotation, the tilt's
//!   azimuth, …).
//! * With Shape Dynamics on, the tip size comes from it alone (the
//!   options bar's pressure-to-size is not applied a second time); with
//!   Transfer on, the flow likewise.

use crate::dab::{PressureTarget, MAX_DABS_PER_SEGMENT, MIN_SPACING_PX};

// ── randomness ───────────────────────────────────────────────────────

/// SplitMix64 — tiny, fast and good enough for jitter; a stroke is a
/// seed, so a failing tape names its seed.
#[derive(Debug, Clone, Copy)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed)
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in `[0, 1)`.
    pub fn unit(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }
}

// ── controls and jitter ──────────────────────────────────────────────

/// What drives a dynamic. The ordinal is the `.abr` `bVTy` table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Control {
    #[default]
    Off,
    Fade,
    PenPressure,
    PenTilt,
    StylusWheel,
    InitialDirection,
    Direction,
    InitialRotation,
    Rotation,
}

impl Control {
    pub fn from_ordinal(o: f32) -> Control {
        match if o.is_finite() { o.round() as i64 } else { 0 } {
            1 => Control::Fade,
            2 => Control::PenPressure,
            3 => Control::PenTilt,
            4 => Control::StylusWheel,
            5 => Control::InitialDirection,
            6 => Control::Direction,
            7 => Control::InitialRotation,
            8 => Control::Rotation,
            _ => Control::Off,
        }
    }
}

/// One dynamic.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Jitter {
    /// A fraction (scatter may exceed 1).
    pub jitter: f32,
    pub control: Control,
    pub fade_steps: u32,
    /// The controlled range's floor, `0..1`.
    pub minimum: f32,
}

impl Jitter {
    /// Does it do anything at all?
    pub fn active(&self) -> bool {
        self.jitter > 0.0 || self.control != Control::Off
    }

    /// The control's scale for dab `index` at `pen`, in `[minimum, 1]`.
    pub fn scale(&self, index: u64, pen: &PenDab, tilt_scale: f32) -> f32 {
        let s = match self.control {
            Control::Off | Control::InitialDirection | Control::Direction => 1.0,
            Control::Fade => {
                if self.fade_steps == 0 {
                    1.0
                } else {
                    (1.0 - index as f32 / self.fade_steps as f32).max(0.0)
                }
            }
            Control::PenPressure => pen.pressure,
            Control::PenTilt => 1.0 - (tilt_scale.max(0.0) * pen.tilt_magnitude() / 90.0),
            Control::StylusWheel => pen.wheel,
            Control::InitialRotation | Control::Rotation => pen.rotation.rem_euclid(360.0) / 360.0,
        };
        let m = self.minimum.clamp(0.0, 1.0);
        m + (1.0 - m) * s.clamp(0.0, 1.0)
    }

    /// `scale · (1 − jitter·u)`, floored at the minimum — the shape of
    /// every scalar dynamic (size, roundness, opacity, flow, depth).
    pub fn apply(&self, index: u64, pen: &PenDab, tilt_scale: f32, u: f32) -> f32 {
        if !self.active() {
            return 1.0;
        }
        let v = self.scale(index, pen, tilt_scale) * (1.0 - self.jitter.clamp(0.0, 1.0) * u);
        v.max(self.minimum.clamp(0.0, 1.0)).clamp(0.0, 1.0)
    }
}

// ── the pen walk ─────────────────────────────────────────────────────

/// One pointer sample with everything a pen reports.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PenSample {
    pub x: f32,
    pub y: f32,
    pub pressure: f32,
    /// Degrees, −90..90 (Pointer Events).
    pub tilt_x: f32,
    pub tilt_y: f32,
    /// Barrel rotation, degrees 0..360.
    pub rotation: f32,
    /// Airbrush wheel, 0..1.
    pub wheel: f32,
}

impl PenSample {
    /// A mouse-like sample: no tilt, no rotation, wheel at full.
    pub fn at(x: f32, y: f32, pressure: f32) -> PenSample {
        PenSample {
            x,
            y,
            pressure,
            tilt_x: 0.0,
            tilt_y: 0.0,
            rotation: 0.0,
            wheel: 1.0,
        }
    }
}

/// One dab the walk emits: an interpolated pen state plus the stroke
/// DIRECTION there (degrees, counter-clockwise on screen; 0 before the
/// pointer has moved).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PenDab {
    pub x: f32,
    pub y: f32,
    pub pressure: f32,
    pub tilt_x: f32,
    pub tilt_y: f32,
    pub rotation: f32,
    pub wheel: f32,
    pub direction: f32,
}

impl PenDab {
    pub fn of(s: PenSample, direction: f32) -> PenDab {
        PenDab {
            x: s.x,
            y: s.y,
            pressure: s.pressure,
            tilt_x: s.tilt_x,
            tilt_y: s.tilt_y,
            rotation: s.rotation,
            wheel: s.wheel,
            direction,
        }
    }

    pub fn tilt_magnitude(&self) -> f32 {
        (self.tilt_x * self.tilt_x + self.tilt_y * self.tilt_y)
            .sqrt()
            .min(90.0)
    }
}

/// Screen-CCW direction of `from → to`, degrees.
pub fn direction_deg(dx: f32, dy: f32) -> f32 {
    (-dy).atan2(dx).to_degrees()
}

/// The arc-length walk ([`crate::dab::StrokeWalk`]'s rule, with every
/// pen field interpolated): dabs every `step` px, the leftover carried
/// in `residual`. Returns nothing for a zero-length segment.
pub fn plan_pen_segment(
    residual: &mut f32,
    from: PenSample,
    to: PenSample,
    step: f32,
    out: &mut Vec<PenDab>,
) {
    let step = if step.is_finite() {
        step.max(MIN_SPACING_PX)
    } else {
        MIN_SPACING_PX
    };
    let (dx, dy) = (to.x - from.x, to.y - from.y);
    let len = (dx * dx + dy * dy).sqrt();
    if !len.is_finite() || len <= 0.0 {
        return;
    }
    let dir = direction_deg(dx, dy);
    let inv = 1.0 / len;
    let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
    let mut travelled = (step - *residual).max(0.0);
    let mut last: Option<f32> = None;
    let mut emitted = 0usize;
    while travelled <= len && emitted < MAX_DABS_PER_SEGMENT {
        let t = travelled * inv;
        out.push(PenDab {
            x: from.x + dx * t,
            y: from.y + dy * t,
            pressure: lerp(from.pressure, to.pressure, t),
            tilt_x: lerp(from.tilt_x, to.tilt_x, t),
            tilt_y: lerp(from.tilt_y, to.tilt_y, t),
            rotation: lerp(from.rotation, to.rotation, t),
            wheel: lerp(from.wheel, to.wheel, t),
            direction: dir,
        });
        last = Some(travelled);
        emitted += 1;
        travelled += step;
    }
    *residual = match last {
        Some(_) if emitted == MAX_DABS_PER_SEGMENT => 0.0,
        Some(d) => len - d,
        None => *residual + len,
    };
}

// ── the settings ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TipShape {
    pub angle: f32,
    pub roundness: f32,
    pub flip_x: bool,
    pub flip_y: bool,
    /// Off: one dab per pointer sample (Photoshop's unchecked Spacing).
    pub spacing_enabled: bool,
}

impl Default for TipShape {
    fn default() -> Self {
        TipShape {
            angle: 0.0,
            roundness: 1.0,
            flip_x: false,
            flip_y: false,
            spacing_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ShapeDynamics {
    pub size: Jitter,
    pub min_diameter: f32,
    pub tilt_scale: f32,
    pub angle: Jitter,
    pub roundness: Jitter,
    pub min_roundness: f32,
    pub flip_x_jitter: bool,
    pub flip_y_jitter: bool,
    pub projection: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Scatter {
    pub amount: Jitter,
    pub both_axes: bool,
    pub count: u32,
    pub count_jitter: Jitter,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct TexturePane {
    pub scale: f32,
    pub brightness: f32,
    pub contrast: f32,
    pub mode: crate::brush::CombineKind,
    pub depth: f32,
    pub min_depth: f32,
    pub depth_jitter: Jitter,
    pub invert: bool,
    pub each_tip: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct DualPane {
    pub mode: crate::brush::CombineKind,
    pub diameter: f32,
    pub spacing: f32,
    pub scatter: f32,
    pub both_axes: bool,
    pub count: u32,
    pub roundness: f32,
    pub flip: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ColorPane {
    pub fg_bg: Jitter,
    pub hue: f32,
    pub saturation: f32,
    pub brightness: f32,
    pub purity: f32,
    pub per_tip: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct TransferPane {
    pub opacity: Jitter,
    pub flow: Jitter,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct PosePane {
    pub tilt_x: f32,
    pub tilt_y: f32,
    pub rotation: f32,
    pub pressure: f32,
    pub override_tilt: bool,
    pub override_rotation: bool,
    pub override_pressure: bool,
}

/// The pulled-string smoothing: `radius` image px of slack.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Smoothing {
    pub radius: f32,
    pub catch_up: bool,
    pub catch_up_end: bool,
}

/// Symmetry painting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SymmetryKind {
    #[default]
    Off,
    Vertical,
    Horizontal,
    Dual,
    Diagonal,
    Wavy,
    Circle,
    Spiral,
    Radial,
    Mandala,
}

impl SymmetryKind {
    pub fn from_ordinal(o: f32) -> SymmetryKind {
        match if o.is_finite() { o.round() as i64 } else { 0 } {
            1 => SymmetryKind::Vertical,
            2 => SymmetryKind::Horizontal,
            3 => SymmetryKind::Dual,
            4 => SymmetryKind::Diagonal,
            5 => SymmetryKind::Wavy,
            6 => SymmetryKind::Circle,
            7 => SymmetryKind::Spiral,
            8 => SymmetryKind::Radial,
            9 => SymmetryKind::Mandala,
            _ => SymmetryKind::Off,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Symmetry {
    pub kind: SymmetryKind,
    /// Centre as fractions of the canvas.
    pub cx: f32,
    pub cy: f32,
    /// Axis angle, degrees.
    pub angle: f32,
    pub segments: u32,
}

/// The options of the tools that paint through the stroke session
/// beyond the brush (read by `image-js`'s stroke session; carried here
/// so one key list feeds one struct).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ToolOptions {
    pub smudge_strength: f32,
    pub smudge_finger: bool,
    pub smudge_sample_all: bool,
    pub mixer_wet: f32,
    pub mixer_load: f32,
    pub mixer_mix: f32,
    pub mixer_flow: f32,
    pub mixer_sample_all: bool,
    pub art_style: u32,
    pub art_area: f32,
    pub art_tolerance: f32,
    pub art_fidelity: f32,
    pub erase_sampling: u32,
    pub erase_limits: u32,
    pub erase_tolerance: f32,
    pub erase_protect_fg: bool,
    pub replace_sampling: u32,
    pub replace_limits: u32,
    pub replace_tolerance: f32,
}

/// Every Brush Settings pane, frozen with the stroke.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct BrushDynamics {
    pub seed: u32,
    pub tip: TipShape,
    pub shape: Option<ShapeDynamics>,
    pub scatter: Option<Scatter>,
    pub texture: Option<TexturePane>,
    pub dual: Option<DualPane>,
    pub color: Option<ColorPane>,
    pub transfer: Option<TransferPane>,
    pub pose: Option<PosePane>,
    pub noise: bool,
    pub wet_edges: bool,
    pub build_up: bool,
    pub smoothing: Smoothing,
    pub symmetry: Symmetry,
    pub lock_alpha: bool,
    /// The background colour (colour dynamics' second end, the swatch
    /// the background eraser samples, what a locked eraser paints).
    pub background: [f32; 3],
    pub tools: ToolOptions,
}

/// The wire's key list, in order — `brush_dynamics_keys`. The bundle
/// packs its values BY NAME against this list (glue
/// `brush-dynamics.ts` `DYNAMICS_FIELDS`), so adding a key here never
/// shifts another.
pub const DYNAMICS_KEYS: &[&str] = &[
    "seed",
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
    "texture.enabled",
    "texture.scale",
    "texture.brightness",
    "texture.contrast",
    "texture.mode",
    "texture.depth",
    "texture.minDepth",
    "texture.depthJitter.jitter",
    "texture.depthJitter.control",
    "texture.depthJitter.fade",
    "texture.depthJitter.min",
    "texture.invert",
    "texture.eachTip",
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
    "smoothing.radius",
    "smoothing.catchUp",
    "smoothing.catchUpEnd",
    "symmetry.kind",
    "symmetry.cx",
    "symmetry.cy",
    "symmetry.angle",
    "symmetry.segments",
    "lockAlpha",
    "background.r",
    "background.g",
    "background.b",
    "smudge.strength",
    "smudge.finger",
    "smudge.sampleAll",
    "mixer.wet",
    "mixer.load",
    "mixer.mix",
    "mixer.flow",
    "mixer.sampleAll",
    "art.style",
    "art.area",
    "art.tolerance",
    "art.fidelity",
    "erase.sampling",
    "erase.limits",
    "erase.tolerance",
    "erase.protectFg",
    "replace.sampling",
    "replace.limits",
    "replace.tolerance",
];

impl BrushDynamics {
    /// Decode the wire array (`values[i]` is `DYNAMICS_KEYS[i]`). A short
    /// array leaves the missing keys at their defaults; non-finite values
    /// read as 0.
    pub fn from_values(values: &[f32]) -> BrushDynamics {
        let get = |k: &str| -> f32 {
            DYNAMICS_KEYS
                .iter()
                .position(|x| *x == k)
                .and_then(|i| values.get(i).copied())
                .filter(|v| v.is_finite())
                .unwrap_or(0.0)
        };
        let on = |k: &str| get(k) >= 0.5;
        let jit = |p: &str| Jitter {
            jitter: get(&format!("{p}.jitter")).max(0.0),
            control: Control::from_ordinal(get(&format!("{p}.control"))),
            fade_steps: get(&format!("{p}.fade")).max(0.0) as u32,
            minimum: get(&format!("{p}.min")).clamp(0.0, 1.0),
        };
        let count = |k: &str| (get(k).round().max(1.0) as u32).min(16);
        BrushDynamics {
            seed: get("seed").max(0.0) as u32,
            tip: TipShape {
                angle: get("tip.angle"),
                roundness: {
                    let r = get("tip.roundness");
                    if r > 0.0 {
                        r.min(1.0)
                    } else {
                        1.0
                    }
                },
                flip_x: on("tip.flipX"),
                flip_y: on("tip.flipY"),
                spacing_enabled: values.is_empty() || on("tip.spacingEnabled"),
            },
            shape: on("shape.enabled").then(|| ShapeDynamics {
                size: jit("shape.size"),
                min_diameter: get("shape.minDiameter").clamp(0.0, 1.0),
                tilt_scale: get("shape.tiltScale").clamp(0.0, 2.0),
                angle: jit("shape.angle"),
                roundness: jit("shape.roundness"),
                min_roundness: get("shape.minRoundness").clamp(0.0, 1.0),
                flip_x_jitter: on("shape.flipXJitter"),
                flip_y_jitter: on("shape.flipYJitter"),
                projection: on("shape.projection"),
            }),
            scatter: on("scatter.enabled").then(|| Scatter {
                amount: jit("scatter.amount"),
                both_axes: on("scatter.bothAxes"),
                count: count("scatter.count"),
                count_jitter: jit("scatter.countJitter"),
            }),
            texture: on("texture.enabled").then(|| TexturePane {
                scale: get("texture.scale"),
                brightness: get("texture.brightness"),
                contrast: get("texture.contrast"),
                mode: crate::brush::CombineKind::from_ordinal(get("texture.mode")),
                depth: get("texture.depth").clamp(0.0, 1.0),
                min_depth: get("texture.minDepth").clamp(0.0, 1.0),
                depth_jitter: jit("texture.depthJitter"),
                invert: on("texture.invert"),
                each_tip: on("texture.eachTip"),
            }),
            dual: on("dual.enabled").then(|| DualPane {
                mode: crate::brush::CombineKind::from_ordinal(get("dual.mode")),
                diameter: get("dual.diameter").max(0.5),
                spacing: get("dual.spacing").clamp(0.01, 10.0),
                scatter: get("dual.scatter").max(0.0),
                both_axes: on("dual.bothAxes"),
                count: count("dual.count"),
                roundness: {
                    let r = get("dual.roundness");
                    if r > 0.0 {
                        r.min(1.0)
                    } else {
                        1.0
                    }
                },
                flip: on("dual.flip"),
            }),
            color: on("color.enabled").then(|| ColorPane {
                fg_bg: jit("color.fgBg"),
                hue: get("color.hue").clamp(0.0, 1.0),
                saturation: get("color.saturation").clamp(0.0, 1.0),
                brightness: get("color.brightness").clamp(0.0, 1.0),
                purity: get("color.purity").clamp(-1.0, 1.0),
                per_tip: on("color.perTip"),
            }),
            transfer: on("transfer.enabled").then(|| TransferPane {
                opacity: jit("transfer.opacity"),
                flow: jit("transfer.flow"),
            }),
            pose: on("pose.enabled").then(|| PosePane {
                tilt_x: get("pose.tiltX").clamp(-90.0, 90.0),
                tilt_y: get("pose.tiltY").clamp(-90.0, 90.0),
                rotation: get("pose.rotation"),
                pressure: get("pose.pressure").clamp(0.0, 1.0),
                override_tilt: on("pose.overrideTilt"),
                override_rotation: on("pose.overrideRotation"),
                override_pressure: on("pose.overridePressure"),
            }),
            noise: on("noise"),
            wet_edges: on("wetEdges"),
            build_up: on("buildUp"),
            smoothing: Smoothing {
                radius: get("smoothing.radius").max(0.0),
                catch_up: on("smoothing.catchUp"),
                catch_up_end: on("smoothing.catchUpEnd"),
            },
            symmetry: Symmetry {
                kind: SymmetryKind::from_ordinal(get("symmetry.kind")),
                cx: get("symmetry.cx"),
                cy: get("symmetry.cy"),
                angle: get("symmetry.angle"),
                segments: (get("symmetry.segments").round().max(2.0) as u32).min(24),
            },
            lock_alpha: on("lockAlpha"),
            background: [
                get("background.r").clamp(0.0, 1.0),
                get("background.g").clamp(0.0, 1.0),
                get("background.b").clamp(0.0, 1.0),
            ],
            tools: ToolOptions {
                smudge_strength: get("smudge.strength").clamp(0.0, 1.0),
                smudge_finger: on("smudge.finger"),
                smudge_sample_all: on("smudge.sampleAll"),
                mixer_wet: get("mixer.wet").clamp(0.0, 1.0),
                mixer_load: get("mixer.load").clamp(0.0, 1.0),
                mixer_mix: get("mixer.mix").clamp(0.0, 1.0),
                mixer_flow: get("mixer.flow").clamp(0.0, 1.0),
                mixer_sample_all: on("mixer.sampleAll"),
                art_style: get("art.style").round().clamp(0.0, 9.0) as u32,
                art_area: get("art.area").max(0.0),
                art_tolerance: get("art.tolerance").clamp(0.0, 1.0),
                art_fidelity: get("art.fidelity").clamp(0.0, 1.0),
                erase_sampling: get("erase.sampling").round().clamp(0.0, 2.0) as u32,
                erase_limits: get("erase.limits").round().clamp(0.0, 2.0) as u32,
                erase_tolerance: get("erase.tolerance").clamp(0.0, 1.0),
                erase_protect_fg: on("erase.protectFg"),
                replace_sampling: get("replace.sampling").round().clamp(0.0, 2.0) as u32,
                replace_limits: get("replace.limits").round().clamp(0.0, 2.0) as u32,
                replace_tolerance: get("replace.tolerance").clamp(0.0, 1.0),
            },
        }
    }

    /// Plain round brush: nothing a dab planner would change.
    pub fn is_plain(&self) -> bool {
        self.tip == TipShape::default()
            && self.shape.is_none()
            && self.scatter.is_none()
            && self.texture.is_none()
            && self.dual.is_none()
            && self.color.is_none()
            && self.transfer.is_none()
            && self.pose.is_none()
            && !self.noise
            && !self.wet_edges
            && !self.build_up
            && self.smoothing.radius <= 0.0
            && self.symmetry.kind == SymmetryKind::Off
            && !self.lock_alpha
    }
}

// ── colour ───────────────────────────────────────────────────────────

/// RGB `0..1` → HSB (hue `0..1`).
pub fn rgb_to_hsb([r, g, b]: [f32; 3]) -> [f32; 3] {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let d = max - min;
    let h = if d <= 0.0 {
        0.0
    } else if max == r {
        ((g - b) / d).rem_euclid(6.0) / 6.0
    } else if max == g {
        ((b - r) / d + 2.0) / 6.0
    } else {
        ((r - g) / d + 4.0) / 6.0
    };
    let s = if max <= 0.0 { 0.0 } else { d / max };
    [h, s, max]
}

/// HSB → RGB.
pub fn hsb_to_rgb([h, s, v]: [f32; 3]) -> [f32; 3] {
    let h6 = h.rem_euclid(1.0) * 6.0;
    let c = v * s;
    let x = c * (1.0 - (h6.rem_euclid(2.0) - 1.0).abs());
    let (r, g, b) = match h6 as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = v - c;
    [r + m, g + m, b + m]
}

// ── symmetry ─────────────────────────────────────────────────────────

/// A stamp's placement: position, angle, mirror, a size factor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    pub x: f32,
    pub y: f32,
    pub angle: f32,
    pub mirrored: bool,
    pub size: f32,
}

/// Reflect `p` across the line through `(cx, cy)` at `theta` degrees
/// (screen CCW). The tip's angle reflects to `2θ − a` and it mirrors.
fn reflect(p: Placement, cx: f32, cy: f32, theta: f32) -> Placement {
    let t = theta.to_radians();
    // Direction of the axis in image px (y down).
    let (ux, uy) = (t.cos(), -t.sin());
    let (dx, dy) = (p.x - cx, p.y - cy);
    let along = dx * ux + dy * uy;
    let (px, py) = (cx + along * ux, cy + along * uy);
    Placement {
        x: 2.0 * px - p.x,
        y: 2.0 * py - p.y,
        angle: 2.0 * theta - p.angle,
        mirrored: !p.mirrored,
        size: p.size,
    }
}

/// Rotate `p` about `(cx, cy)` by `phi` degrees counter-clockwise on
/// screen, scaling its distance (and size) by `k`.
fn rotate(p: Placement, cx: f32, cy: f32, phi: f32, k: f32) -> Placement {
    let f = phi.to_radians();
    let (s, c) = f.sin_cos();
    let (dx, dy) = (p.x - cx, p.y - cy);
    Placement {
        x: cx + k * (dx * c + dy * s),
        y: cy + k * (-dx * s + dy * c),
        angle: p.angle + phi,
        mirrored: p.mirrored,
        size: p.size * k,
    }
}

impl Symmetry {
    /// Every placement a stamp at `p` paints on a `w`×`h` canvas — the
    /// original first. This engine's definitions:
    ///
    /// * VERTICAL / HORIZONTAL: one mirror across the vertical /
    ///   horizontal axis through the centre (turned by `angle`).
    /// * DUAL: both mirrors and the point reflection (4 placements).
    /// * DIAGONAL: one mirror across the 45° axis (turned by `angle`).
    /// * WAVY: a mirror across a sine-wave axis through the centre
    ///   (amplitude 5% of the height, wavelength 25% of the width).
    /// * CIRCLE: a mirror across the circle of radius ¼·min(w, h) about
    ///   the centre (the distance `d` maps to `2R − d`).
    /// * RADIAL: `segments` rotations. MANDALA: the radial copies and
    ///   each one's mirror. SPIRAL: `segments` rotations, each step's
    ///   distance and size scaled by 0.8.
    pub fn placements(&self, p: Placement, w: u32, h: u32, out: &mut Vec<Placement>) {
        out.push(p);
        let (cx, cy) = (self.cx * w as f32, self.cy * h as f32);
        let a = self.angle;
        let n = self.segments.max(2);
        match self.kind {
            SymmetryKind::Off => {}
            SymmetryKind::Vertical => out.push(reflect(p, cx, cy, 90.0 + a)),
            SymmetryKind::Horizontal => out.push(reflect(p, cx, cy, a)),
            SymmetryKind::Dual => {
                out.push(reflect(p, cx, cy, 90.0 + a));
                out.push(reflect(p, cx, cy, a));
                out.push(rotate(p, cx, cy, 180.0, 1.0));
            }
            SymmetryKind::Diagonal => out.push(reflect(p, cx, cy, 45.0 + a)),
            SymmetryKind::Wavy => {
                let amp = 0.05 * h as f32;
                let len = (0.25 * w as f32).max(1.0);
                let axis = cy + amp * (std::f32::consts::TAU * (p.x - cx) / len).sin();
                out.push(Placement {
                    x: p.x,
                    y: 2.0 * axis - p.y,
                    angle: -p.angle,
                    mirrored: !p.mirrored,
                    size: p.size,
                });
            }
            SymmetryKind::Circle => {
                let r = 0.25 * w.min(h) as f32;
                let (dx, dy) = (p.x - cx, p.y - cy);
                let d = (dx * dx + dy * dy).sqrt();
                if d > 0.0 {
                    let k = (2.0 * r - d).max(0.0) / d;
                    let ray = direction_deg(dx, dy);
                    out.push(Placement {
                        x: cx + dx * k,
                        y: cy + dy * k,
                        angle: 2.0 * (ray + 90.0) - p.angle,
                        mirrored: !p.mirrored,
                        size: p.size,
                    });
                }
            }
            SymmetryKind::Radial | SymmetryKind::Mandala => {
                for i in 1..n {
                    out.push(rotate(p, cx, cy, i as f32 * 360.0 / n as f32, 1.0));
                }
                if self.kind == SymmetryKind::Mandala {
                    let copies: Vec<Placement> = out.clone();
                    for q in copies {
                        out.push(reflect(q, cx, cy, 90.0 + a));
                    }
                }
            }
            SymmetryKind::Spiral => {
                let mut k = 1.0;
                for i in 1..n {
                    k *= 0.8;
                    out.push(rotate(p, cx, cy, i as f32 * 360.0 / n as f32, k));
                }
            }
        }
    }
}

// ── smoothing ────────────────────────────────────────────────────────

/// PULLED-STRING smoothing: the brush trails the pointer on a string of
/// `radius` px and moves only when the string is taut. With `catch_up`
/// a REPEATED sample (the pointer held still — the bundle sends one per
/// tick) pulls the brush half-way to the pointer; `finish` (catch-up at
/// end) lands it on the pointer.
#[derive(Debug, Clone, Copy)]
pub struct PulledString {
    pub radius: f32,
    pub catch_up: bool,
    brush: Option<PenSample>,
    last_raw: Option<PenSample>,
}

impl PulledString {
    pub fn new(s: Smoothing) -> PulledString {
        PulledString {
            radius: s.radius,
            catch_up: s.catch_up,
            brush: None,
            last_raw: None,
        }
    }

    /// Where the brush is after `raw`, or `None` when it did not move.
    pub fn pull(&mut self, raw: PenSample) -> Option<PenSample> {
        let repeated = self.last_raw.is_some_and(|l| l.x == raw.x && l.y == raw.y);
        self.last_raw = Some(raw);
        let Some(b) = self.brush else {
            self.brush = Some(raw);
            return Some(raw);
        };
        let (dx, dy) = (raw.x - b.x, raw.y - b.y);
        let d = (dx * dx + dy * dy).sqrt();
        let moved = if d > self.radius && d > 0.0 {
            let k = (d - self.radius) / d;
            Some(PenSample {
                x: b.x + dx * k,
                y: b.y + dy * k,
                ..raw
            })
        } else if repeated && self.catch_up && d > 0.25 {
            Some(PenSample {
                x: b.x + dx * 0.5,
                y: b.y + dy * 0.5,
                ..raw
            })
        } else {
            None
        };
        if let Some(m) = moved {
            self.brush = Some(m);
        }
        moved
    }

    /// Catch-up at end: the brush lands on the last pointer position.
    pub fn finish(&mut self) -> Option<PenSample> {
        let raw = self.last_raw?;
        let b = self.brush?;
        if b.x == raw.x && b.y == raw.y {
            return None;
        }
        self.brush = Some(raw);
        Some(raw)
    }
}

// ── the planner ──────────────────────────────────────────────────────

/// What a stroke's base tip is before dynamics.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BaseBrush {
    pub diameter: f32,
    pub flow: f32,
    pub pressure: PressureTarget,
    pub color: [f32; 3],
}

/// One stamp to deposit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlannedStamp {
    pub x: f32,
    pub y: f32,
    pub diameter: f32,
    pub angle: f32,
    pub roundness: f32,
    pub flip_x: bool,
    pub flip_y: bool,
    pub flow: f32,
    /// The dab's own opacity ceiling (Transfer), `0..1`.
    pub ceiling: f32,
    /// `Some` when colour dynamics are on.
    pub color: Option<[f32; 3]>,
    /// The texture depth for texture-each-tip, `0..1`.
    pub depth: f32,
}

/// Turns the walk's dabs into stamps (see the module docs).
#[derive(Debug, Clone)]
pub struct DabPlanner {
    d: BrushDynamics,
    base: BaseBrush,
    width: u32,
    height: u32,
    rng: Rng,
    dual_rng: Rng,
    index: u64,
    initial_direction: Option<f32>,
    initial_rotation: Option<f32>,
    stroke_color: Option<[f32; 3]>,
    dual_residual: f32,
}

impl DabPlanner {
    pub fn new(d: BrushDynamics, base: BaseBrush, width: u32, height: u32) -> DabPlanner {
        let seed = d.seed as u64;
        DabPlanner {
            d,
            base,
            width,
            height,
            rng: Rng::new(seed.wrapping_mul(0x2545_F491_4F6C_DD1D) ^ 0xB1E5_5ED0),
            dual_rng: Rng::new(seed.wrapping_mul(0x9E37_79B9) ^ 0xD0A1_7175),
            index: 0,
            initial_direction: None,
            initial_rotation: None,
            stroke_color: None,
            dual_residual: 0.0,
        }
    }

    pub fn dynamics(&self) -> &BrushDynamics {
        &self.d
    }

    /// The spacing the primary walk uses, px of arc length.
    pub fn step(&self, spacing_fraction: f32) -> f32 {
        self.base.diameter * spacing_fraction
    }

    /// Apply Brush Pose to the pen.
    fn posed(&self, mut pen: PenDab) -> PenDab {
        if let Some(p) = &self.d.pose {
            if p.override_tilt {
                pen.tilt_x = p.tilt_x;
                pen.tilt_y = p.tilt_y;
            }
            if p.override_rotation {
                pen.rotation = p.rotation;
            }
            if p.override_pressure {
                pen.pressure = p.pressure;
            }
        }
        pen
    }

    /// Plan the stamps for one walked dab.
    pub fn plan(&mut self, pen: PenDab, out: &mut Vec<PlannedStamp>) {
        let pen = self.posed(pen);
        let i = self.index;
        self.index += 1;
        if pen.direction != 0.0 && self.initial_direction.is_none() {
            self.initial_direction = Some(pen.direction);
        }
        if self.initial_rotation.is_none() {
            self.initial_rotation = Some(pen.rotation);
        }
        // THE FIXED DRAW ORDER — every dab draws the same six, enabled
        // or not, so one pane's toggle never reshuffles another's jitter.
        let u_size = self.rng.unit();
        let u_angle = self.rng.unit();
        let u_round = self.rng.unit();
        let u_fx = self.rng.unit();
        let u_fy = self.rng.unit();
        let u_count = self.rng.unit();

        let d = self.d;
        let ts = d.shape.map_or(1.0, |s| s.tilt_scale);
        // Size.
        let mut diameter = self.base.diameter;
        let mut flow = self.base.flow;
        match &d.shape {
            Some(s) => {
                if s.size.active() {
                    let f =
                        s.size.scale(i, &pen, ts) * (1.0 - s.size.jitter.clamp(0.0, 1.0) * u_size);
                    diameter *= f.max(s.min_diameter).clamp(0.0, 1.0);
                }
            }
            None => diameter *= self.base.pressure.size_scale(pen.pressure),
        }
        if d.transfer.is_none() {
            flow *= self.base.pressure.flow_scale(pen.pressure);
        }
        // Angle.
        let mut angle = d.tip.angle;
        let mut roundness = d.tip.roundness;
        let (mut flip_x, mut flip_y) = (d.tip.flip_x, d.tip.flip_y);
        if let Some(s) = &d.shape {
            angle += match s.angle.control {
                Control::Off => 0.0,
                Control::Fade => {
                    if s.angle.fade_steps == 0 {
                        0.0
                    } else {
                        360.0 * (i as f32 / s.angle.fade_steps as f32).min(1.0)
                    }
                }
                Control::PenPressure => 360.0 * pen.pressure,
                Control::PenTilt => direction_deg(pen.tilt_x, pen.tilt_y),
                Control::StylusWheel => 360.0 * pen.wheel,
                // Pointer Events' twist turns clockwise; screen CCW is −.
                Control::Rotation => -pen.rotation,
                Control::InitialRotation => -self.initial_rotation.unwrap_or(0.0),
                Control::InitialDirection => self.initial_direction.unwrap_or(pen.direction),
                Control::Direction => pen.direction,
            };
            angle += s.angle.jitter.clamp(0.0, 1.0) * (2.0 * u_angle - 1.0) * 180.0;
            if s.roundness.active() {
                let f = s.roundness.scale(i, &pen, ts)
                    * (1.0 - s.roundness.jitter.clamp(0.0, 1.0) * u_round);
                roundness *= f.max(s.min_roundness).clamp(0.01, 1.0);
            }
            if s.flip_x_jitter && u_fx < 0.5 {
                flip_x = !flip_x;
            }
            if s.flip_y_jitter && u_fy < 0.5 {
                flip_y = !flip_y;
            }
            if s.projection {
                // Brush projection: the pen's tilt foreshortens the tip
                // along the tilt's azimuth, and its rotation turns it.
                roundness *= pen.tilt_magnitude().to_radians().cos().max(0.05);
                angle -= pen.rotation;
                if pen.tilt_magnitude() > 0.0 {
                    angle += direction_deg(pen.tilt_x, pen.tilt_y);
                }
            }
        }
        // Count.
        let count = match &d.scatter {
            Some(s) => {
                let n = s.count.max(1) as f32;
                let f = if s.count_jitter.active() {
                    s.count_jitter.scale(i, &pen, ts)
                        * (1.0 - s.count_jitter.jitter.clamp(0.0, 1.0) * u_count)
                } else {
                    1.0
                };
                ((n * f).round() as u32).clamp(1, 16)
            }
            None => 1,
        };
        let mut placements = Vec::with_capacity(4);
        for _ in 0..count {
            // Per-copy draws, again in a fixed order.
            let u_perp = self.rng.unit();
            let u_along = self.rng.unit();
            let u_depth = self.rng.unit();
            let u_op = self.rng.unit();
            let u_fl = self.rng.unit();
            let u_fgbg = self.rng.unit();
            let u_h = self.rng.unit();
            let u_s = self.rng.unit();
            let u_b = self.rng.unit();

            let (mut x, mut y) = (pen.x, pen.y);
            if let Some(s) = &d.scatter {
                // Amplitude: jitter × the base diameter, scaled by its
                // control; perpendicular to the stroke (both axes: along
                // it too).
                let amp =
                    s.amount.jitter.max(0.0) * s.amount.scale(i, &pen, ts) * self.base.diameter;
                let dir = pen.direction.to_radians();
                let (ux, uy) = (dir.cos(), -dir.sin());
                let (nx, ny) = (-uy, ux);
                let perp = amp * (2.0 * u_perp - 1.0);
                x += nx * perp;
                y += ny * perp;
                if s.both_axes {
                    let along = amp * (2.0 * u_along - 1.0);
                    x += ux * along;
                    y += uy * along;
                }
            }
            let depth = match &d.texture {
                Some(t) => {
                    let f = if t.depth_jitter.active() {
                        (t.depth_jitter.scale(i, &pen, ts)
                            * (1.0 - t.depth_jitter.jitter.clamp(0.0, 1.0) * u_depth))
                            .max(t.min_depth)
                    } else {
                        1.0
                    };
                    t.depth * f.clamp(0.0, 1.0)
                }
                None => 0.0,
            };
            let (ceiling, dab_flow) = match &d.transfer {
                Some(t) => (
                    t.opacity.apply(i, &pen, ts, u_op),
                    flow * t.flow.apply(i, &pen, ts, u_fl),
                ),
                None => (1.0, flow),
            };
            let color = d.color.map(|c| {
                if !c.per_tip {
                    if let Some(sc) = self.stroke_color {
                        return sc;
                    }
                }
                let s = c.fg_bg.scale(i, &pen, ts);
                let t = ((1.0 - s) + c.fg_bg.jitter.clamp(0.0, 1.0) * u_fgbg).clamp(0.0, 1.0);
                let fg = self.base.color;
                let bg = d.background;
                let mix = [
                    fg[0] + (bg[0] - fg[0]) * t,
                    fg[1] + (bg[1] - fg[1]) * t,
                    fg[2] + (bg[2] - fg[2]) * t,
                ];
                let [mut hh, mut ss, mut bb] = rgb_to_hsb(mix);
                hh += c.hue * (2.0 * u_h - 1.0) * 0.5;
                ss = (ss + c.saturation * (2.0 * u_s - 1.0)).clamp(0.0, 1.0);
                bb = (bb + c.brightness * (2.0 * u_b - 1.0)).clamp(0.0, 1.0);
                ss = if c.purity < 0.0 {
                    ss * (1.0 + c.purity)
                } else {
                    ss + c.purity * (1.0 - ss)
                };
                let rgb = hsb_to_rgb([hh, ss.clamp(0.0, 1.0), bb]);
                if !c.per_tip {
                    self.stroke_color = Some(rgb);
                }
                rgb
            });
            placements.clear();
            d.symmetry.placements(
                Placement {
                    x,
                    y,
                    angle,
                    mirrored: false,
                    size: 1.0,
                },
                self.width,
                self.height,
                &mut placements,
            );
            for p in &placements {
                out.push(PlannedStamp {
                    x: p.x,
                    y: p.y,
                    diameter: diameter * p.size,
                    angle: p.angle,
                    roundness,
                    flip_x,
                    // A mirrored copy is the tip flipped in its own y
                    // (the reflection's angle already turned the axis).
                    flip_y: flip_y ^ p.mirrored,
                    flow: dab_flow,
                    ceiling,
                    color,
                    depth,
                });
            }
        }
    }

    /// The DUAL tip's stamps along `from → to`, on its own spacing walk
    /// and its own random stream. Empty without a dual pane.
    pub fn plan_dual(
        &mut self,
        from: Option<PenSample>,
        to: PenSample,
        out: &mut Vec<PlannedStamp>,
    ) {
        let Some(dual) = self.d.dual else { return };
        let mut walked = Vec::new();
        match from {
            None => walked.push(PenDab::of(to, 0.0)),
            Some(f) => plan_pen_segment(
                &mut self.dual_residual,
                f,
                to,
                (dual.diameter * dual.spacing).max(MIN_SPACING_PX),
                &mut walked,
            ),
        }
        let mut placements = Vec::with_capacity(4);
        for pen in walked {
            for _ in 0..dual.count.max(1) {
                let u_perp = self.dual_rng.unit();
                let u_along = self.dual_rng.unit();
                let u_flip = self.dual_rng.unit();
                let amp = dual.scatter * dual.diameter;
                let dir = pen.direction.to_radians();
                let (ux, uy) = (dir.cos(), -dir.sin());
                let (nx, ny) = (-uy, ux);
                let perp = amp * (2.0 * u_perp - 1.0);
                let (mut x, mut y) = (pen.x + nx * perp, pen.y + ny * perp);
                if dual.both_axes {
                    let along = amp * (2.0 * u_along - 1.0);
                    x += ux * along;
                    y += uy * along;
                }
                placements.clear();
                self.d.symmetry.placements(
                    Placement {
                        x,
                        y,
                        angle: 0.0,
                        mirrored: false,
                        size: 1.0,
                    },
                    self.width,
                    self.height,
                    &mut placements,
                );
                for p in &placements {
                    out.push(PlannedStamp {
                        x: p.x,
                        y: p.y,
                        diameter: dual.diameter * p.size,
                        angle: p.angle,
                        roundness: dual.roundness,
                        flip_x: dual.flip && u_flip < 0.5,
                        flip_y: p.mirrored,
                        flow: 1.0,
                        ceiling: 1.0,
                        color: None,
                        depth: 0.0,
                    });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> BaseBrush {
        BaseBrush {
            diameter: 20.0,
            flow: 1.0,
            pressure: PressureTarget::None,
            color: [1.0, 0.0, 0.0],
        }
    }

    fn pen(x: f32, y: f32) -> PenDab {
        PenDab::of(PenSample::at(x, y, 1.0), 0.0)
    }

    fn plan_all(d: BrushDynamics, dabs: &[PenDab]) -> Vec<PlannedStamp> {
        let mut p = DabPlanner::new(d, base(), 100, 100);
        let mut out = Vec::new();
        for &x in dabs {
            p.plan(x, &mut out);
        }
        out
    }

    #[test]
    fn image_editor_brush_engine_the_key_list_has_no_duplicates_and_decodes_its_own_defaults() {
        let mut seen = std::collections::HashSet::new();
        for k in DYNAMICS_KEYS {
            assert!(seen.insert(*k), "duplicate key {k}");
        }
        let d = BrushDynamics::from_values(&[]);
        assert!(d.is_plain(), "an empty array is the plain brush");
        assert!(d.tip.spacing_enabled);
    }

    #[test]
    fn image_editor_brush_engine_values_decode_by_key() {
        let mut v = vec![0.0f32; DYNAMICS_KEYS.len()];
        let set = |v: &mut Vec<f32>, k: &str, x: f32| {
            let i = DYNAMICS_KEYS.iter().position(|y| *y == k).unwrap();
            v[i] = x;
        };
        set(&mut v, "tip.spacingEnabled", 1.0);
        set(&mut v, "tip.roundness", 1.0);
        set(&mut v, "shape.enabled", 1.0);
        set(&mut v, "shape.size.jitter", 0.5);
        set(&mut v, "shape.size.control", 2.0);
        set(&mut v, "scatter.enabled", 1.0);
        set(&mut v, "scatter.count", 3.0);
        set(&mut v, "symmetry.kind", 8.0);
        set(&mut v, "symmetry.segments", 5.0);
        let d = BrushDynamics::from_values(&v);
        let s = d.shape.unwrap();
        assert_eq!(s.size.jitter, 0.5);
        assert_eq!(s.size.control, Control::PenPressure);
        assert_eq!(d.scatter.unwrap().count, 3);
        assert_eq!(d.symmetry.kind, SymmetryKind::Radial);
        assert_eq!(d.symmetry.segments, 5);
        assert!(d.texture.is_none(), "a pane whose gate is off is absent");
    }

    #[test]
    fn image_editor_brush_engine_a_plain_planner_is_the_base_brush() {
        let out = plan_all(
            BrushDynamics::from_values(&[]),
            &[pen(10.0, 10.0), pen(15.0, 10.0)],
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].diameter, 20.0);
        assert_eq!((out[0].x, out[0].y), (10.0, 10.0));
        assert_eq!(out[0].ceiling, 1.0);
        assert_eq!(out[0].flow, 1.0);
        assert!(out[0].color.is_none());
    }

    fn jittery(seed: u32) -> BrushDynamics {
        BrushDynamics {
            seed,
            shape: Some(ShapeDynamics {
                size: Jitter {
                    jitter: 1.0,
                    ..Jitter::default()
                },
                min_diameter: 0.1,
                angle: Jitter {
                    jitter: 0.5,
                    ..Jitter::default()
                },
                ..ShapeDynamics::default()
            }),
            scatter: Some(Scatter {
                amount: Jitter {
                    jitter: 2.0,
                    ..Jitter::default()
                },
                both_axes: true,
                count: 3,
                count_jitter: Jitter::default(),
            }),
            ..BrushDynamics::from_values(&[])
        }
    }

    #[test]
    fn image_editor_brush_engine_jitter_is_seeded_and_replays_bit_identically() {
        let dabs: Vec<PenDab> = (0..20).map(|i| pen(10.0 + i as f32, 50.0)).collect();
        let a = plan_all(jittery(7), &dabs);
        let b = plan_all(jittery(7), &dabs);
        assert_eq!(a, b, "same seed, same stamps");
        let c = plan_all(jittery(8), &dabs);
        assert_ne!(a, c, "another seed jitters differently");
        assert_eq!(a.len(), 60, "count 3 per dab");
        assert!(
            a.iter().all(|s| s.diameter >= 2.0 && s.diameter <= 20.0),
            "min diameter floor"
        );
        assert!(a.iter().any(|s| (s.y - 50.0).abs() > 5.0), "scattered");
    }

    #[test]
    fn image_editor_brush_engine_enabling_a_pane_does_not_reshuffle_another() {
        // Size jitter alone, then size jitter + colour dynamics: the sizes
        // must be the same, because every dab draws the same numbers.
        let dabs: Vec<PenDab> = (0..12).map(|i| pen(5.0 * i as f32, 20.0)).collect();
        let mut one = jittery(3);
        one.scatter = None;
        let mut two = one;
        two.color = Some(ColorPane {
            hue: 0.5,
            per_tip: true,
            ..ColorPane::default()
        });
        let a: Vec<f32> = plan_all(one, &dabs).iter().map(|s| s.diameter).collect();
        let b: Vec<f32> = plan_all(two, &dabs).iter().map(|s| s.diameter).collect();
        assert_eq!(a, b);
    }

    #[test]
    fn image_editor_brush_engine_pressure_control_scales_size_down_to_the_minimum() {
        let d = BrushDynamics {
            shape: Some(ShapeDynamics {
                size: Jitter {
                    control: Control::PenPressure,
                    ..Jitter::default()
                },
                min_diameter: 0.25,
                ..ShapeDynamics::default()
            }),
            ..BrushDynamics::from_values(&[])
        };
        let mut light = pen(1.0, 1.0);
        light.pressure = 0.0;
        let out = plan_all(d, &[pen(1.0, 1.0), light]);
        assert_eq!(out[0].diameter, 20.0);
        assert_eq!(out[1].diameter, 5.0, "pressure 0 = the minimum diameter");
    }

    #[test]
    fn image_editor_brush_engine_fade_runs_over_its_steps() {
        let d = BrushDynamics {
            transfer: Some(TransferPane {
                opacity: Jitter {
                    control: Control::Fade,
                    fade_steps: 4,
                    ..Jitter::default()
                },
                flow: Jitter::default(),
            }),
            ..BrushDynamics::from_values(&[])
        };
        let dabs: Vec<PenDab> = (0..6).map(|i| pen(i as f32, 0.0)).collect();
        let c: Vec<f32> = plan_all(d, &dabs).iter().map(|s| s.ceiling).collect();
        assert_eq!(c, vec![1.0, 0.75, 0.5, 0.25, 0.0, 0.0]);
    }

    #[test]
    fn image_editor_brush_engine_the_direction_control_turns_the_tip_with_the_stroke() {
        let d = BrushDynamics {
            shape: Some(ShapeDynamics {
                angle: Jitter {
                    control: Control::Direction,
                    ..Jitter::default()
                },
                ..ShapeDynamics::default()
            }),
            ..BrushDynamics::from_values(&[])
        };
        let mut up = pen(0.0, 0.0);
        up.direction = direction_deg(0.0, -1.0);
        let out = plan_all(d, &[up]);
        assert!((out[0].angle - 90.0).abs() < 1e-4, "moving up = 90° CCW");
    }

    #[test]
    fn image_editor_brush_engine_brush_pose_overrides_the_pen() {
        let d = BrushDynamics {
            pose: Some(PosePane {
                pressure: 0.5,
                override_pressure: true,
                ..PosePane::default()
            }),
            ..BrushDynamics::from_values(&[])
        };
        let mut p = DabPlanner::new(
            d,
            BaseBrush {
                pressure: PressureTarget::Size,
                ..base()
            },
            100,
            100,
        );
        let mut out = Vec::new();
        p.plan(pen(1.0, 1.0), &mut out);
        assert_eq!(out[0].diameter, 10.0, "the pose's pressure, not the pen's");
    }

    #[test]
    fn image_editor_brush_engine_colour_dynamics_mix_toward_the_background() {
        let d = BrushDynamics {
            color: Some(ColorPane {
                fg_bg: Jitter {
                    control: Control::PenPressure,
                    ..Jitter::default()
                },
                per_tip: true,
                ..ColorPane::default()
            }),
            background: [0.0, 0.0, 1.0],
            ..BrushDynamics::from_values(&[])
        };
        let mut light = pen(1.0, 1.0);
        light.pressure = 0.0;
        let out = plan_all(d, &[pen(1.0, 1.0), light]);
        let c0 = out[0].color.unwrap();
        let c1 = out[1].color.unwrap();
        assert!(
            (c0[0] - 1.0).abs() < 1e-4 && c0[2] < 1e-4,
            "full pressure = FG"
        );
        assert!(
            c1[0] < 1e-4 && (c1[2] - 1.0).abs() < 1e-4,
            "no pressure = BG"
        );
    }

    #[test]
    fn image_editor_brush_engine_colour_per_stroke_is_drawn_once() {
        let d = BrushDynamics {
            seed: 5,
            color: Some(ColorPane {
                hue: 1.0,
                per_tip: false,
                ..ColorPane::default()
            }),
            ..BrushDynamics::from_values(&[])
        };
        let dabs: Vec<PenDab> = (0..5).map(|i| pen(i as f32, 0.0)).collect();
        let out = plan_all(d, &dabs);
        assert!(out.windows(2).all(|w| w[0].color == w[1].color));
    }

    #[test]
    fn image_editor_brush_engine_hsb_round_trips() {
        for rgb in [
            [1.0, 0.0, 0.0],
            [0.2, 0.6, 0.3],
            [0.5, 0.5, 0.5],
            [0.1, 0.2, 0.9],
        ] {
            let back = hsb_to_rgb(rgb_to_hsb(rgb));
            for c in 0..3 {
                assert!((back[c] - rgb[c]).abs() < 1e-5, "{rgb:?} → {back:?}");
            }
        }
    }

    fn sym(kind: SymmetryKind, segments: u32) -> Vec<Placement> {
        let s = Symmetry {
            kind,
            cx: 0.5,
            cy: 0.5,
            angle: 0.0,
            segments,
        };
        let mut out = Vec::new();
        s.placements(
            Placement {
                x: 70.0,
                y: 40.0,
                angle: 10.0,
                mirrored: false,
                size: 1.0,
            },
            100,
            100,
            &mut out,
        );
        out
    }

    fn near(p: &Placement, x: f32, y: f32) -> bool {
        (p.x - x).abs() < 1e-3 && (p.y - y).abs() < 1e-3
    }

    #[test]
    fn image_editor_brush_engine_symmetry_places_every_copy() {
        let v = sym(SymmetryKind::Vertical, 2);
        assert_eq!(v.len(), 2);
        assert!(near(&v[1], 30.0, 40.0), "{:?}", v[1]);
        assert!(v[1].mirrored);
        assert!((v[1].angle - 170.0).abs() < 1e-3, "the tip mirrors too");
        let h = sym(SymmetryKind::Horizontal, 2);
        assert!(near(&h[1], 70.0, 60.0), "{:?}", h[1]);
        let d = sym(SymmetryKind::Dual, 2);
        assert_eq!(d.len(), 4);
        assert!(near(&d[3], 30.0, 60.0), "point reflection {:?}", d[3]);
        let diag = sym(SymmetryKind::Diagonal, 2);
        // The 45° axis through (50,50) maps (70,40) to (60,30).
        assert!(near(&diag[1], 60.0, 30.0), "{:?}", diag[1]);
        let r = sym(SymmetryKind::Radial, 4);
        assert_eq!(r.len(), 4);
        // A quarter turn CCW on screen: (+20, −10) → (−10, −20).
        assert!(near(&r[1], 40.0, 30.0), "{:?}", r[1]);
        let m = sym(SymmetryKind::Mandala, 4);
        assert_eq!(m.len(), 8);
        let sp = sym(SymmetryKind::Spiral, 3);
        assert_eq!(sp.len(), 3);
        assert!(
            sp[1].size < 1.0 && sp[2].size < sp[1].size,
            "the spiral winds inward"
        );
        let c = sym(SymmetryKind::Circle, 2);
        assert_eq!(c.len(), 2);
        let w = sym(SymmetryKind::Wavy, 2);
        assert_eq!(w.len(), 2);
        assert_eq!(w[1].x, 70.0);
        assert_eq!(sym(SymmetryKind::Off, 2).len(), 1);
    }

    #[test]
    fn image_editor_brush_engine_the_pulled_string_trails_and_catches_up() {
        let mut s = PulledString::new(Smoothing {
            radius: 10.0,
            catch_up: true,
            catch_up_end: true,
        });
        assert_eq!(s.pull(PenSample::at(0.0, 0.0, 1.0)).map(|p| p.x), Some(0.0));
        assert!(s.pull(PenSample::at(5.0, 0.0, 1.0)).is_none(), "slack");
        let p = s.pull(PenSample::at(25.0, 0.0, 1.0)).unwrap();
        assert!((p.x - 15.0).abs() < 1e-4, "taut: trails by the radius");
        // Held still: each repeated sample halves the gap.
        let q = s.pull(PenSample::at(25.0, 0.0, 1.0)).unwrap();
        assert!((q.x - 20.0).abs() < 1e-4);
        let end = s.finish().unwrap();
        assert_eq!(end.x, 25.0, "catch-up at end lands on the pointer");
        assert!(s.finish().is_none());
    }

    #[test]
    fn image_editor_brush_engine_the_pen_walk_matches_the_plain_walk() {
        let mut residual = 0.0;
        let mut pens = Vec::new();
        plan_pen_segment(
            &mut residual,
            PenSample::at(0.0, 0.0, 0.2),
            PenSample::at(30.0, 0.0, 1.0),
            6.0,
            &mut pens,
        );
        let mut walk = crate::dab::StrokeWalk::new();
        let mut plain = Vec::new();
        crate::dab::plan_segment(
            &mut walk,
            crate::dab::StrokeSample::new(0.0, 0.0, 0.2),
            crate::dab::StrokeSample::new(30.0, 0.0, 1.0),
            6.0,
            &mut plain,
        );
        assert_eq!(pens.len(), plain.len());
        for (a, b) in pens.iter().zip(&plain) {
            assert_eq!((a.x, a.y, a.pressure), (b.x, b.y, b.pressure));
        }
        assert_eq!(residual, walk.residual());
    }

    #[test]
    fn image_editor_brush_engine_the_dual_tip_walks_its_own_spacing() {
        let d = BrushDynamics {
            dual: Some(DualPane {
                diameter: 10.0,
                spacing: 1.0,
                count: 1,
                roundness: 1.0,
                ..DualPane::default()
            }),
            ..BrushDynamics::from_values(&[])
        };
        let mut p = DabPlanner::new(d, base(), 100, 100);
        let mut out = Vec::new();
        p.plan_dual(None, PenSample::at(0.0, 0.0, 1.0), &mut out);
        p.plan_dual(
            Some(PenSample::at(0.0, 0.0, 1.0)),
            PenSample::at(35.0, 0.0, 1.0),
            &mut out,
        );
        let xs: Vec<f32> = out.iter().map(|s| s.x).collect();
        assert_eq!(xs, vec![0.0, 10.0, 20.0, 30.0]);
    }
}
