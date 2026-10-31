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

//! Black-point compensation for the backends that lack it.
//!
//! The algorithm is Adobe's, as published in "Adobe Systems'
//! Implementation of Black Point Compensation" (2006), which ISO 18619
//! later standardised. It has two halves.
//!
//! **Detection.** A profile's black point is the darkest neutral it can
//! reproduce, in XYZ under the PCS white:
//!
//! - *Source* (the paper's §5): ICC v4 profiles under the perceptual or
//!   saturation intent have a fixed black, the v4 perceptual reference
//!   medium black (ICC.1 §6.3.4.3) — unless they are matrix-shaper, which
//!   have no perceptual table and take the colorimetric route below. A
//!   CMYK output profile under relative colorimetric takes the black its
//!   *perceptual* table reaches: Lab 0/0/0 goes to the device through
//!   the perceptual table and back through the colorimetric one, so ink
//!   limits are honoured. Everything else converts the device's darkest
//!   colorant (RGB 0/0/0, gray 0, CMYK all inks full) to Lab with the
//!   intent. The result is clipped to L\* ≤ 50; the perceptual-black
//!   route also makes it neutral (a\* = b\* = 0).
//! - *Destination* (§6): a matrix-shaper, non-LUT, or v4
//!   perceptual/saturation profile uses the source method. A LUT profile
//!   is measured: a ramp of neutral L\* from 0 to 100 goes into the
//!   device under the intent and comes back colorimetrically. Under
//!   relative colorimetric, where that round trip is straight through the
//!   mid-tones (within 4 L\* above L\* 20), the colorimetric source
//!   estimate stands. Otherwise (and always under perceptual and
//!   saturation, whose first estimate is the PCS black) the paper fits a quadratic, by least squares, to the shadow section of
//!   the normalised round-trip curve (between 0.1 and 0.5 for relative
//!   colorimetric, 0.03 and 0.25 for the others) and takes its root as
//!   the black's L\*.
//!
//! **Compensation** (§4). In XYZ, each component is scaled linearly so
//! the source black lands on the destination black and the PCS white
//! stays fixed: `Y' = a·Y + b` with `a = (bp_out − W) / (bp_in − W)` and
//! `b = −W·(bp_out − bp_in) / (bp_in − W)`, per component.
//!
//! lcms2 implements the same paper; `tests/bpc.rs` holds this module's
//! detection and its transforms to lcms2's on every profile it has.

use super::icc::{Class, Facts};
use super::pcs::{lab_to_xyz, xyz_to_lab, D50};
use super::{build_leg, Backend, CmsError, End, Intent, ProfileRef, Space};

/// ICC v4's perceptual reference medium black (ICC.1:2022 §6.3.4.3), in
/// XYZ under D50.
pub const V4_PERCEPTUAL_BLACK: [f32; 3] = [0.00336, 0.003_473_1, 0.00287];

/// The darkest colorant of a device space, in the float convention.
fn darkest(space: Space) -> Option<&'static [f32]> {
    match space {
        Space::Gray => Some(&[0.0]),
        Space::Rgb => Some(&[0.0, 0.0, 0.0]),
        Space::Cmyk => Some(&[1.0, 1.0, 1.0, 1.0]),
        Space::Lab => None,
    }
}

/// Make a Lab black neutral, clip it to L* ≤ 50, and return its XYZ.
fn neutral_black(lab: [f32; 3]) -> [f32; 3] {
    lab_to_xyz([lab[0].clamp(0.0, 50.0), 0.0, 0.0])
}

/// One colour through a leg, float.
fn one(leg: &dyn super::Leg, src: &[f32], channels: usize) -> Vec<f32> {
    let mut out = vec![0f32; channels];
    leg.run_f32(src, &mut out);
    out
}

/// The darkest colorant converted to Lab with `intent`.
fn darker_colorant(
    backend: Backend,
    p: ProfileRef<'_>,
    facts: &Facts,
    intent: Intent,
) -> Result<[f32; 3], CmsError> {
    let Some(black) = darkest(facts.space) else {
        return Ok([0.0; 3]);
    };
    if !facts.supports_input(intent) {
        return Ok([0.0; 3]);
    }
    let leg = build_leg(
        backend,
        End::Device(p, facts.space),
        End::Xyz,
        intent,
        false,
    )?;
    let xyz = one(leg.as_ref(), black, 3);
    // The colorant's own black, chroma kept (lcms2 keeps it too), L*
    // clipped to 50.
    let lab = xyz_to_lab([xyz[0], xyz[1], xyz[2]]);
    Ok(lab_to_xyz([lab[0].clamp(0.0, 50.0), lab[1], lab[2]]))
}

/// Lab → device under `intent` → Lab colorimetrically, for every input.
struct RoundTrip {
    into: Box<dyn super::Leg>,
    back: Box<dyn super::Leg>,
    channels: usize,
}

impl RoundTrip {
    fn new(
        backend: Backend,
        p: ProfileRef<'_>,
        space: Space,
        intent: Intent,
    ) -> Result<Self, CmsError> {
        Ok(RoundTrip {
            into: build_leg(backend, End::Xyz, End::Device(p, space), intent, false)?,
            back: build_leg(
                backend,
                End::Device(p, space),
                End::Xyz,
                Intent::RelativeColorimetric,
                false,
            )?,
            channels: space.channels(),
        })
    }

    fn run(&self, labs: &[[f32; 3]]) -> Vec<[f32; 3]> {
        let xyz: Vec<f32> = labs.iter().flat_map(|l| lab_to_xyz(*l)).collect();
        let mut dev = vec![0f32; labs.len() * self.channels];
        self.into.run_f32(&xyz, &mut dev);
        let mut out = vec![0f32; labs.len() * 3];
        self.back.run_f32(&dev, &mut out);
        out.as_chunks::<3>()
            .0
            .iter()
            .map(|x| xyz_to_lab([x[0], x[1], x[2]]))
            .collect()
    }
}

/// The black a CMYK output profile's perceptual table reaches.
fn perceptual_black(
    backend: Backend,
    p: ProfileRef<'_>,
    facts: &Facts,
) -> Result<[f32; 3], CmsError> {
    if !facts.supports_input(Intent::Perceptual) {
        return Ok([0.0; 3]);
    }
    // A profile without output tables cannot take the round trip; like
    // lcms2, it then has no detectable black (zero).
    let Ok(rt) = RoundTrip::new(backend, p, facts.space, Intent::Perceptual) else {
        return Ok([0.0; 3]);
    };
    Ok(neutral_black(rt.run(&[[0.0, 0.0, 0.0]])[0]))
}

/// The black point of `profile` used as a conversion's source, in XYZ
/// (D50, Y = 1 white). See the module docs for the method.
pub fn detect_source_black_point(
    backend: Backend,
    profile: ProfileRef<'_>,
    space: Space,
    intent: Intent,
) -> Result<[f32; 3], CmsError> {
    let facts = Facts::of(profile)?;
    if facts.space != space {
        return Err(CmsError::SpaceMismatch {
            profile: facts.space,
            layout: space,
        });
    }
    source_black(backend, profile, &facts, intent)
}

fn source_black(
    backend: Backend,
    p: ProfileRef<'_>,
    facts: &Facts,
    intent: Intent,
) -> Result<[f32; 3], CmsError> {
    if facts.space == Space::Lab {
        return Ok([0.0; 3]);
    }
    if facts.is_v4() && matches!(intent, Intent::Perceptual | Intent::Saturation) {
        return if facts.matrix_shaper {
            darker_colorant(backend, p, facts, Intent::RelativeColorimetric)
        } else {
            Ok(V4_PERCEPTUAL_BLACK)
        };
    }
    if intent == Intent::RelativeColorimetric
        && facts.class == Class::Output
        && facts.space == Space::Cmyk
    {
        return perceptual_black(backend, p, facts);
    }
    darker_colorant(backend, p, facts, intent)
}

/// The black point of `profile` used as a conversion's destination, in
/// XYZ (D50, Y = 1 white). See the module docs for the method.
pub fn detect_destination_black_point(
    backend: Backend,
    profile: ProfileRef<'_>,
    space: Space,
    intent: Intent,
) -> Result<[f32; 3], CmsError> {
    let facts = Facts::of(profile)?;
    if facts.space != space {
        return Err(CmsError::SpaceMismatch {
            profile: facts.space,
            layout: space,
        });
    }
    if facts.space == Space::Lab {
        return Ok([0.0; 3]);
    }
    if (facts.is_v4() && matches!(intent, Intent::Perceptual | Intent::Saturation))
        || !facts.is_clut_output(intent)
    {
        return source_black(backend, profile, &facts, intent);
    }
    let initial = if intent == Intent::RelativeColorimetric {
        xyz_to_lab(source_black(
            backend,
            profile,
            &facts,
            Intent::RelativeColorimetric,
        )?)
    } else {
        [0.0; 3]
    };
    let Ok(rt) = RoundTrip::new(backend, profile, space, intent) else {
        return Ok([0.0; 3]);
    };
    const STEPS: usize = 256;
    let ramp: Vec<[f32; 3]> = (0..STEPS)
        .map(|i| {
            [
                i as f32 * 100.0 / (STEPS - 1) as f32,
                initial[1],
                initial[2],
            ]
        })
        .collect();
    let back: Vec<f32> = rt.run(&ramp).iter().map(|l| l[0]).collect();
    let straight = ramp
        .iter()
        .zip(&back)
        .all(|(x, y)| x[0] <= 20.0 || (y - x[0]).abs() < 4.0);
    // The colorimetric estimate stands only for relative colorimetric:
    // under perceptual and saturation (whose estimate is the PCS black)
    // the curve is always fitted.
    if straight && intent == Intent::RelativeColorimetric {
        return Ok(lab_to_xyz(initial));
    }
    let (min_l, max_l) = (back[0], back[STEPS - 1]);
    if max_l - min_l <= f32::EPSILON {
        return Ok([0.0; 3]);
    }
    let (lo, hi) = if intent == Intent::RelativeColorimetric {
        (0.1, 0.5)
    } else {
        (0.03, 0.25)
    };
    let (mut xs, mut ys) = (Vec::new(), Vec::new());
    for (x, y) in ramp.iter().zip(&back) {
        let norm = (y - min_l) / (max_l - min_l);
        if norm >= lo && norm < hi {
            xs.push(f64::from(x[0]));
            ys.push(f64::from(norm));
        }
    }
    if xs.len() < 3 {
        return Ok([0.0; 3]);
    }
    let l = quadratic_root(&xs, &ys).max(0.0) as f32;
    Ok(lab_to_xyz([l, initial[1], initial[2]]))
}

/// Least-squares fit of `y = a·x² + b·x + c`, and the x where it reaches
/// zero (its larger root), clipped to 0..=50. A degenerate fit falls back
/// to the line's root; no real root means the black is at L* 0.
fn quadratic_root(xs: &[f64], ys: &[f64]) -> f64 {
    // Normal equations: [Σx⁴ Σx³ Σx²; Σx³ Σx² Σx; Σx² Σx n] · [a b c]ᵀ
    // = [Σx²y Σxy Σy]ᵀ.
    let mut s = [0f64; 5];
    let mut t = [0f64; 3];
    for (&x, &y) in xs.iter().zip(ys) {
        let mut p = 1.0;
        for v in &mut s {
            *v += p;
            p *= x;
        }
        t[0] += x * x * y;
        t[1] += x * y;
        t[2] += y;
    }
    let m = [[s[4], s[3], s[2]], [s[3], s[2], s[1]], [s[2], s[1], s[0]]];
    let det = |m: &[[f64; 3]; 3]| {
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    };
    let d = det(&m);
    if d.abs() < 1e-12 {
        return 0.0;
    }
    let col = |i: usize| {
        let mut c = m;
        for (r, row) in c.iter_mut().enumerate() {
            row[i] = t[r];
        }
        det(&c) / d
    };
    let (a, b, c) = (col(0), col(1), col(2));
    let root = if a.abs() < 1e-10 {
        if b.abs() < 1e-12 {
            0.0
        } else {
            -c / b
        }
    } else {
        let disc = b * b - 4.0 * a * c;
        if disc <= 0.0 {
            0.0
        } else {
            (-b + disc.sqrt()) / (2.0 * a)
        }
    };
    root.clamp(0.0, 50.0)
}

/// The XYZ scale that maps one black point onto another, white fixed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Scale {
    a: [f32; 3],
    b: [f32; 3],
}

impl Scale {
    /// `None` when the two black points are the same (nothing to do).
    pub fn between(source: [f32; 3], destination: [f32; 3]) -> Option<Scale> {
        if source
            .iter()
            .zip(&destination)
            .all(|(s, d)| (s - d).abs() < 1e-6)
        {
            return None;
        }
        let mut a = [1f32; 3];
        let mut b = [0f32; 3];
        for i in 0..3 {
            let t = source[i] - D50[i];
            a[i] = (destination[i] - D50[i]) / t;
            b[i] = -D50[i] * (destination[i] - source[i]) / t;
        }
        Some(Scale { a, b })
    }

    pub fn apply(&self, xyz: [f32; 3]) -> [f32; 3] {
        [
            self.a[0] * xyz[0] + self.b[0],
            self.a[1] * xyz[1] + self.b[1],
            self.a[2] * xyz[2] + self.b[2],
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scale_moves_black_and_keeps_white() {
        let src = [0.02, 0.021, 0.017];
        let dst = [0.004, 0.0042, 0.0035];
        let s = Scale::between(src, dst).expect("differs");
        let b = s.apply(src);
        let w = s.apply(D50);
        for i in 0..3 {
            assert!((b[i] - dst[i]).abs() < 1e-6, "black {b:?}");
            assert!((w[i] - D50[i]).abs() < 1e-6, "white {w:?}");
        }
        assert!(Scale::between(src, src).is_none());
    }

    #[test]
    fn the_quadratic_fit_finds_a_known_root() {
        // y = 0.001·(x − 6)·(x + 40) over the shadows: root at x = 6.
        let xs: Vec<f64> = (8..30).map(f64::from).collect();
        let ys: Vec<f64> = xs.iter().map(|x| 0.001 * (x - 6.0) * (x + 40.0)).collect();
        assert!((quadratic_root(&xs, &ys) - 6.0).abs() < 1e-6);
        // A straight line through x = 3.
        let ys: Vec<f64> = xs.iter().map(|x| 0.02 * (x - 3.0)).collect();
        assert!((quadratic_root(&xs, &ys) - 3.0).abs() < 1e-6);
    }

    #[test]
    fn the_neutral_black_is_clipped_to_l50() {
        let xyz = neutral_black([70.0, 5.0, -5.0]);
        let lab = xyz_to_lab(xyz);
        assert!((lab[0] - 50.0).abs() < 1e-3 && lab[1].abs() < 1e-3 && lab[2].abs() < 1e-3);
    }
}
