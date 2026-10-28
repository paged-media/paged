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

//! The profile connection space: CIE XYZ and CIELAB under the ICC's D50
//! white (ICC.1:2022 §6.3.4), and the CIE76 colour difference.

/// The PCS white, ICC.1 §7.2.16 (X = 0.9642, Y = 1, Z = 0.8249).
pub const D50: [f32; 3] = [0.9642, 1.0, 0.8249];

const EPSILON: f32 = 216.0 / 24389.0;
const KAPPA: f32 = 24389.0 / 27.0;

/// XYZ (D50, Y = 1 white) to CIELAB.
pub fn xyz_to_lab(xyz: [f32; 3]) -> [f32; 3] {
    let f = |t: f32| {
        if t > EPSILON {
            t.cbrt()
        } else {
            (KAPPA * t + 16.0) / 116.0
        }
    };
    let fx = f(xyz[0] / D50[0]);
    let fy = f(xyz[1] / D50[1]);
    let fz = f(xyz[2] / D50[2]);
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

/// CIELAB to XYZ (D50, Y = 1 white).
pub fn lab_to_xyz(lab: [f32; 3]) -> [f32; 3] {
    let fy = (lab[0] + 16.0) / 116.0;
    let fx = fy + lab[1] / 500.0;
    let fz = fy - lab[2] / 200.0;
    let inv = |t: f32| {
        let t3 = t * t * t;
        if t3 > EPSILON {
            t3
        } else {
            (116.0 * t - 16.0) / KAPPA
        }
    };
    let yr = if lab[0] > KAPPA * EPSILON {
        fy * fy * fy
    } else {
        lab[0] / KAPPA
    };
    [inv(fx) * D50[0], yr * D50[1], inv(fz) * D50[2]]
}

/// CIE76 ΔE*ab.
pub fn delta_e76(a: [f32; 3], b: [f32; 3]) -> f32 {
    let d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn white_and_black_map_to_the_lab_extremes() {
        let w = xyz_to_lab(D50);
        assert!((w[0] - 100.0).abs() < 1e-3 && w[1].abs() < 1e-3 && w[2].abs() < 1e-3);
        assert_eq!(xyz_to_lab([0.0; 3]), [0.0, 0.0, 0.0]);
    }

    #[test]
    fn lab_round_trips_through_xyz() {
        for lab in [[50.0, 20.0, -30.0], [5.0, 1.0, -1.0], [95.0, -80.0, 90.0]] {
            let back = xyz_to_lab(lab_to_xyz(lab));
            assert!(delta_e76(lab, back) < 1e-3, "{lab:?} → {back:?}");
        }
    }
}
