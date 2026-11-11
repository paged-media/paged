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

//! The four-point homography is solved once in Rust (`from_quads`) and once
//! in TypeScript (the extension SDK's `transform-box`, which the editor's
//! `@paged-media/vector-geometry` delegates to). Both are held to the same
//! numbers: here and in
//! `platform/shared/vector-geometry/test/warp/homography-parity.spec.ts`.

const RECT: [(f64, f64); 4] = [(0.0, 0.0), (64.0, 0.0), (64.0, 48.0), (0.0, 48.0)];

fn assert_near(got: paged_warp::Homography, want: [f64; 9]) {
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        assert!((g - w).abs() < 1e-12, "h[{i}]: {g} != {w}");
    }
}

#[test]
fn from_quads_matches_the_typescript_solve() {
    let h = paged_warp::from_quads(RECT, [(3.0, 2.0), (70.0, -4.0), (58.0, 52.0), (-6.0, 44.0)])
        .unwrap();
    assert_near(
        h,
        [
            0.7734375,
            -0.1875,
            3.0,
            -0.078125,
            0.875,
            2.0,
            -0.00390625,
            0.0,
            1.0,
        ],
    );
    let h = paged_warp::from_quads(RECT, [(1.0, 1.0), (50.0, 5.0), (61.0, 47.0), (-3.0, 40.0)])
        .unwrap();
    assert_near(
        h,
        [
            0.7395933071620069,
            -0.06904283160985573,
            1.0,
            0.05989683071620069,
            0.6219599770202987,
            1.0,
            -0.0005206338567598621,
            -0.004763500574492531,
            1.0,
        ],
    );
}
