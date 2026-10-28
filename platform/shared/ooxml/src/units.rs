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

//! The units ECMA-376 writes, and their conversions to points.
//!
//! One table for the three formats, so no module keeps its own constant:
//!
//! - **EMU** (English Metric Units), DrawingML's lengths: 914 400 per inch,
//!   12 700 per point, 360 000 per centimetre.
//! - **Twips** (twentieths of a point), WordprocessingML's page and
//!   paragraph lengths; **half-points**, its font sizes; **eighths of a
//!   point**, its border widths.
//! - **Angles** in 60 000ths of a degree (`ST_Angle`, `ST_PositiveFixedAngle`).
//! - **Percentages** in 1 000ths of a percent (`ST_Percentage`,
//!   `ST_PositivePercentage`, `ST_FixedPercentage`): 100 000 is 100 %.

/// EMU per inch.
pub const EMU_PER_INCH: i64 = 914_400;
/// EMU per point (`EMU_PER_INCH / 72`).
pub const EMU_PER_PT: f64 = 12_700.0;
/// EMU per centimetre.
pub const EMU_PER_CM: i64 = 360_000;
/// Twips per point.
pub const TWIPS_PER_PT: f64 = 20.0;
/// Twips per inch.
pub const TWIPS_PER_INCH: i64 = 1_440;
/// Points per inch.
pub const PT_PER_INCH: f64 = 72.0;
/// An angle unit per degree (`ST_Angle` is 60 000ths of a degree).
pub const ANGLE_PER_DEGREE: f64 = 60_000.0;
/// A percentage unit per whole (`ST_Percentage` is 1 000ths of a percent).
pub const PERCENT_PER_WHOLE: f64 = 100_000.0;

/// EMU to points.
pub fn emu_to_pt(emu: i64) -> f64 {
    emu as f64 / EMU_PER_PT
}

/// Points to EMU, rounded to the nearest unit.
pub fn pt_to_emu(pt: f64) -> i64 {
    (pt * EMU_PER_PT).round() as i64
}

/// Twips to points.
pub fn twips_to_pt(twips: i64) -> f64 {
    twips as f64 / TWIPS_PER_PT
}

/// Points to twips, rounded to the nearest unit.
pub fn pt_to_twips(pt: f64) -> i64 {
    (pt * TWIPS_PER_PT).round() as i64
}

/// Half-points (`w:sz`) to points.
pub fn half_pt_to_pt(half: i64) -> f64 {
    half as f64 / 2.0
}

/// Eighths of a point (`w:bdr w:sz`) to points.
pub fn eighth_pt_to_pt(eighths: i64) -> f64 {
    eighths as f64 / 8.0
}

/// A DrawingML angle (60 000ths of a degree) in degrees.
pub fn angle_to_deg(angle: i64) -> f64 {
    angle as f64 / ANGLE_PER_DEGREE
}

/// Degrees as a DrawingML angle, rounded to the nearest unit.
pub fn deg_to_angle(deg: f64) -> i64 {
    (deg * ANGLE_PER_DEGREE).round() as i64
}

/// A DrawingML percentage (1 000ths of a percent) as a fraction: 100 000
/// is 1.0.
pub fn pct_to_fraction(pct: i64) -> f64 {
    pct as f64 / PERCENT_PER_WHOLE
}

/// A fraction as a DrawingML percentage, rounded to the nearest unit.
pub fn fraction_to_pct(f: f64) -> i64 {
    (f * PERCENT_PER_WHOLE).round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_convert_through_points() {
        assert_eq!(emu_to_pt(EMU_PER_INCH), PT_PER_INCH);
        assert_eq!(emu_to_pt(12_700), 1.0);
        assert_eq!(pt_to_emu(72.0), EMU_PER_INCH);
        assert_eq!(emu_to_pt(EMU_PER_CM * 254 / 100), 72.0);
        assert_eq!(twips_to_pt(TWIPS_PER_INCH), 72.0);
        assert_eq!(pt_to_twips(12.5), 250);
        assert_eq!(half_pt_to_pt(23), 11.5);
        assert_eq!(eighth_pt_to_pt(12), 1.5);
    }

    #[test]
    fn angles_and_percentages() {
        assert_eq!(angle_to_deg(5_400_000), 90.0);
        assert_eq!(deg_to_angle(-45.0), -2_700_000);
        assert_eq!(pct_to_fraction(50_000), 0.5);
        assert_eq!(fraction_to_pct(0.333_334), 33_333);
    }
}
