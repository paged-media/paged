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

//! `paged_color::cms` against lcms2, the oracle: every intent with and
//! without black-point compensation, the black-point detection itself,
//! soft proofing and the gamut check.
//!
//! The profiles are synthesised with lcms2 so the suite is hermetic:
//! sRGB, an RGB and a gray profile whose black is LIFTED (their TRC never
//! reaches zero, so BPC has something to do), and a narrow-gamut RGB
//! "press" for the proof and gamut tests. A real CMYK LUT profile joins
//! when one is available (`PAGED_CMYK_PROFILE`, `corpus/profiles/`, an
//! installed Coated FOGRA39); without one those cases report
//! `unavailable` rather than pass.

#![cfg(not(target_arch = "wasm32"))]
// Test names carry the cockpit feature tag (`__feat__<id>`).
#![allow(non_snake_case)]

use lcms2::{
    CIExyY, CIExyYTRIPLE, Flags, Intent as LIntent, PixelFormat, Profile, ToneCurve, Transform,
};
use paged_color::cms::{
    delta_e76, detect_destination_black_point, detect_source_black_point, xyz_to_lab, Backend,
    BpcApplied, BpcMode, GamutCheck, Intent, Layout, ProfileRef, ProofOptions, Rendering,
    SoftProof, Space,
};
use paged_test_resources::{skip, Resource};

const INTENTS: [Intent; 4] = [
    Intent::Perceptual,
    Intent::RelativeColorimetric,
    Intent::Saturation,
    Intent::AbsoluteColorimetric,
];

fn l_intent(i: Intent) -> LIntent {
    match i {
        Intent::Perceptual => LIntent::Perceptual,
        Intent::RelativeColorimetric => LIntent::RelativeColorimetric,
        Intent::Saturation => LIntent::Saturation,
        Intent::AbsoluteColorimetric => LIntent::AbsoluteColorimetric,
    }
}

const D50_XYY: CIExyY = CIExyY {
    x: 0.3457,
    y: 0.3585,
    Y: 1.0,
};

/// `Y = (1 − e)·X^2.2 + e`: the black sits at `e`, never at zero.
fn lifted_curve(e: f64) -> ToneCurve {
    let g = 2.2;
    // Type 5: Y = (aX + b)^g + e for X ≥ d, Y = cX + f below (d = 0).
    ToneCurve::new_parametric(5, &[g, (1.0 - e).powf(1.0 / g), 0.0, 0.0, 0.0, e, 0.0])
        .expect("parametric curve")
}

fn rgb_profile(primaries: CIExyYTRIPLE, curve: &ToneCurve) -> Vec<u8> {
    let d65 = CIExyY {
        x: 0.3127,
        y: 0.3290,
        Y: 1.0,
    };
    Profile::new_rgb(&d65, &primaries, &[curve, curve, curve])
        .expect("rgb profile")
        .icc()
        .expect("encode")
}

fn srgb_primaries() -> CIExyYTRIPLE {
    let p = |x, y| CIExyY { x, y, Y: 1.0 };
    CIExyYTRIPLE {
        Red: p(0.64, 0.33),
        Green: p(0.30, 0.60),
        Blue: p(0.15, 0.06),
    }
}

/// An sRGB-primaried display whose black is lifted to Y = 0.04 (L* ≈ 24).
fn lifted_rgb() -> Vec<u8> {
    rgb_profile(srgb_primaries(), &lifted_curve(0.04))
}

fn lifted_gray() -> Vec<u8> {
    Profile::new_gray(&D50_XYY, &lifted_curve(0.03))
        .expect("gray")
        .icc()
        .expect("encode")
}

/// A narrow-gamut "press": sRGB's primaries pulled halfway to the white
/// point, with a lifted black.
fn narrow_rgb() -> Vec<u8> {
    let (wx, wy) = (0.3127, 0.3290);
    let p = |x: f64, y: f64| CIExyY {
        x: (x + wx) / 2.0,
        y: (y + wy) / 2.0,
        Y: 1.0,
    };
    rgb_profile(
        CIExyYTRIPLE {
            Red: p(0.64, 0.33),
            Green: p(0.30, 0.60),
            Blue: p(0.15, 0.06),
        },
        &lifted_curve(0.02),
    )
}

/// The same profile re-tagged as ICC v2, where lcms2 does not force BPC
/// into the perceptual and saturation intents.
fn v2(bytes: &[u8]) -> Vec<u8> {
    let mut p = Profile::new_icc(bytes).expect("profile");
    p.set_version(2.1);
    p.icc().expect("encode")
}

fn cmyk_profile() -> Option<Vec<u8>> {
    paged_color::test_profiles::read_cmyk_profile(env!("CARGO_MANIFEST_DIR"))
}

fn lcms_profile(bytes: &[u8]) -> Profile {
    Profile::new_icc(bytes).expect("lcms2 opens it")
}

/// A spread of RGB patches: the cube's corners and edges, grays and a
/// few mid-tones.
fn rgb_patches() -> Vec<u8> {
    let mut v = Vec::new();
    let steps = [0u8, 32, 64, 128, 192, 255];
    for &r in &steps {
        for &g in &steps {
            for &b in &steps {
                v.extend_from_slice(&[r, g, b]);
            }
        }
    }
    v
}

fn cmyk_patches() -> Vec<u8> {
    let mut v = Vec::new();
    let steps = [0u8, 64, 128, 191, 255];
    for &c in &steps {
        for &m in &steps {
            for &y in &steps {
                for &k in &[0u8, 128, 255] {
                    v.extend_from_slice(&[c, m, y, k]);
                }
            }
        }
    }
    v
}

/// The lcms2 oracle: an 8-bit transform with lcms2's own BPC.
fn oracle(
    src: &[u8],
    sf: PixelFormat,
    dst: &[u8],
    df: PixelFormat,
    intent: Intent,
    bpc: bool,
    input: &[u8],
    out_channels: usize,
) -> Vec<u8> {
    let flags = if bpc {
        Flags::BLACKPOINT_COMPENSATION
    } else {
        Flags::default()
    };
    let t: Transform<u8, u8> = Transform::new_flags(
        &lcms_profile(src),
        sf,
        &lcms_profile(dst),
        df,
        l_intent(intent),
        flags,
    )
    .expect("oracle transform");
    let n = input.len() / sf.bytes_per_pixel();
    let mut out = vec![0u8; n * out_channels];
    t.transform_pixels(input, &mut out);
    out
}

fn ours(
    backend: Backend,
    mode: BpcMode,
    src: &[u8],
    sl: Layout,
    dst: &[u8],
    dl: Layout,
    intent: Intent,
    bpc: bool,
    input: &[u8],
) -> (Vec<u8>, BpcApplied) {
    let t = paged_color::cms::Transform::with_mode(
        backend,
        ProfileRef::Icc(src),
        sl,
        ProfileRef::Icc(dst),
        dl,
        Rendering::new(intent, bpc),
        mode,
    )
    .unwrap_or_else(|e| panic!("{backend} {intent:?} bpc={bpc}: {e}"));
    let n = input.len() / sl.channels();
    let mut out = vec![0u8; n * dl.channels()];
    t.apply_u8(input, &mut out);
    (out, t.bpc())
}

fn max_diff(a: &[u8], b: &[u8]) -> u8 {
    a.iter()
        .zip(b)
        .map(|(x, y)| x.abs_diff(*y))
        .max()
        .unwrap_or(0)
}

/// RGB bytes of a profile to Lab, through lcms2 (for ΔE comparisons).
fn to_lab(profile: &[u8], format: PixelFormat, px: &[u8]) -> Vec<[f32; 3]> {
    let lab = Profile::new_lab4_context(lcms2::GlobalContext::new(), &D50_XYY).expect("lab");
    let t: Transform<u8, [f64; 3]> = Transform::new(
        &lcms_profile(profile),
        format,
        &lab,
        PixelFormat::Lab_DBL,
        LIntent::RelativeColorimetric,
    )
    .expect("to lab");
    let n = px.len() / format.bytes_per_pixel();
    let mut out = vec![[0f64; 3]; n];
    t.transform_pixels(px, &mut out);
    out.iter()
        .map(|l| [l[0] as f32, l[1] as f32, l[2] as f32])
        .collect()
}

fn max_delta_e(a: &[[f32; 3]], b: &[[f32; 3]]) -> f32 {
    a.iter()
        .zip(b)
        .map(|(x, y)| delta_e76(*x, *y))
        .fold(0.0, f32::max)
}

// ─────────────────────────── black-point detection ───────────────────

fn assert_black_points(name: &str, bytes: &[u8], space: Space, backends: &[(Backend, f32)]) {
    let p = lcms_profile(bytes);
    for intent in [
        Intent::Perceptual,
        Intent::RelativeColorimetric,
        Intent::Saturation,
    ] {
        let want_src = p
            .detect_black_point(l_intent(intent))
            .map(|x| xyz_to_lab([x.X as f32, x.Y as f32, x.Z as f32]));
        let want_dst = p
            .detect_destination_black_point(l_intent(intent))
            .map(|x| xyz_to_lab([x.X as f32, x.Y as f32, x.Z as f32]));
        for &(backend, tol) in backends {
            let got_src = xyz_to_lab(
                detect_source_black_point(backend, ProfileRef::Icc(bytes), space, intent)
                    .expect("source black point"),
            );
            let got_dst = xyz_to_lab(
                detect_destination_black_point(backend, ProfileRef::Icc(bytes), space, intent)
                    .expect("destination black point"),
            );
            if let Some(w) = want_src {
                let de = delta_e76(w, got_src);
                assert!(
                    de <= tol,
                    "{name} {intent:?} source black on {backend}: {got_src:?} vs lcms2 {w:?} (ΔE {de:.2})"
                );
            }
            if let Some(w) = want_dst {
                let de = delta_e76(w, got_dst);
                eprintln!("{name} {intent:?} destination black on {backend}: ΔE {de:.2}");
                assert!(
                    de <= tol,
                    "{name} {intent:?} destination black on {backend}: {got_dst:?} vs lcms2 {w:?} (ΔE {de:.2})"
                );
            }
        }
    }
}

fn detection_backends() -> Vec<(Backend, f32)> {
    let mut b = vec![(Backend::Lcms2, 0.5)];
    if Backend::Moxcms.is_available() {
        b.push((Backend::Moxcms, 1.0));
    }
    b
}

#[test]
fn black_point_detection_matches_lcms2_on_synthetic_profiles__feat__color_swatches_cms_unified() {
    let srgb = Profile::new_srgb().icc().expect("srgb");
    assert_black_points("sRGB", &srgb, Space::Rgb, &detection_backends());
    assert_black_points(
        "lifted RGB",
        &lifted_rgb(),
        Space::Rgb,
        &detection_backends(),
    );
    assert_black_points(
        "lifted gray",
        &lifted_gray(),
        Space::Gray,
        &detection_backends(),
    );
    // The lifted black is what the detection must find: L* ≈ 24, neutral.
    let bp = xyz_to_lab(
        detect_source_black_point(
            Backend::Lcms2,
            ProfileRef::Icc(&lifted_rgb()),
            Space::Rgb,
            Intent::RelativeColorimetric,
        )
        .expect("bp"),
    );
    assert!((bp[0] - 23.7).abs() < 0.5 && bp[1].abs() < 0.01, "{bp:?}");
}

#[test]
fn black_point_detection_matches_lcms2_on_a_cmyk_lut_profile__feat__color_swatches_cms_unified() {
    let Some(cmyk) = cmyk_profile() else {
        skip!(
            Resource::Icc,
            "{}",
            paged_color::test_profiles::NO_PROFILE_HINT
        );
    };
    // A LUT profile's destination black is the curve fit of the paper's
    // §6; the two CMMs evaluate the tables differently, so the bound is
    // looser than on matrix profiles.
    let mut b = vec![(Backend::Lcms2, 1.0)];
    if Backend::Moxcms.is_available() {
        // The Ghostscript profile's perceptual fit: ΔE 2.9 (FOGRA39: 0.0).
        b.push((Backend::Moxcms, 3.0));
    }
    assert_black_points("CMYK", &cmyk, Space::Cmyk, &b);
}

// ───────────────────────── intent × BPC vs lcms2 ──────────────────────

/// Our software BPC on lcms2's own legs reproduces lcms2's BPC: the
/// algorithm, isolated from any CMM difference.
#[test]
fn software_bpc_on_lcms2_legs_matches_lcms2s_bpc__feat__color_swatches_cms_unified() {
    // v2 profiles: on v4 ones lcms2 compensates inside each leg of the
    // software path too (see `Transform::with_mode`), which is not the
    // algorithm under test.
    let srgb = v2(&Profile::new_srgb().icc().expect("srgb"));
    let lifted = v2(&lifted_rgb());
    let patches = rgb_patches();
    for (name, src, dst) in [
        ("lifted→sRGB", &lifted, &srgb),
        ("sRGB→lifted", &srgb, &lifted),
    ] {
        for intent in INTENTS {
            for bpc in [false, true] {
                let want = oracle(
                    src,
                    PixelFormat::RGB_8,
                    dst,
                    PixelFormat::RGB_8,
                    intent,
                    bpc,
                    &patches,
                    3,
                );
                let (got, applied) = ours(
                    Backend::Lcms2,
                    BpcMode::Software,
                    src,
                    Layout::RGB,
                    dst,
                    Layout::RGB,
                    intent,
                    bpc,
                    &patches,
                );
                let d = max_diff(&want, &got);
                assert!(d <= 2, "{name} {intent:?} bpc={bpc}: {d} levels from lcms2");
                if bpc && intent != Intent::AbsoluteColorimetric {
                    assert!(
                        matches!(applied, BpcApplied::Software { .. }),
                        "{name} {intent:?}: {applied:?}"
                    );
                }
            }
        }
    }
}

/// BPC does what it is for: the lifted black of the source lands on
/// sRGB's black instead of staying gray.
#[test]
fn bpc_maps_a_lifted_black_to_the_destination_black__feat__color_swatches_cms_unified() {
    let srgb = Profile::new_srgb().icc().expect("srgb");
    let lifted = lifted_rgb();
    let black = [0u8, 0, 0];
    let mut backends = vec![
        (Backend::Lcms2, BpcMode::Auto),
        (Backend::Lcms2, BpcMode::Software),
    ];
    if Backend::Moxcms.is_available() {
        backends.push((Backend::Moxcms, BpcMode::Auto));
    }
    for (backend, mode) in backends {
        let (off, _) = ours(
            backend,
            mode,
            &lifted,
            Layout::RGB,
            &srgb,
            Layout::RGB,
            Intent::RelativeColorimetric,
            false,
            &black,
        );
        let (on, applied) = ours(
            backend,
            mode,
            &lifted,
            Layout::RGB,
            &srgb,
            Layout::RGB,
            Intent::RelativeColorimetric,
            true,
            &black,
        );
        assert!(
            off.iter().all(|&v| v > 40),
            "{backend} without BPC: {off:?}"
        );
        assert!(
            on.iter().all(|&v| v <= 1),
            "{backend} with BPC: {on:?} ({applied:?})"
        );
    }
}

#[cfg(feature = "moxcms")]
#[test]
fn moxcms_matches_lcms2_per_intent_with_and_without_bpc__feat__color_swatches_cms_unified() {
    let srgb = Profile::new_srgb().icc().expect("srgb");
    let lifted = lifted_rgb();
    let narrow = narrow_rgb();
    let patches = rgb_patches();
    for (name, src, dst) in [
        ("lifted→sRGB", &lifted, &srgb),
        ("sRGB→lifted", &srgb, &lifted),
        ("sRGB→narrow", &srgb, &narrow),
    ] {
        for intent in INTENTS {
            for bpc in [false, true] {
                let want = oracle(
                    src,
                    PixelFormat::RGB_8,
                    dst,
                    PixelFormat::RGB_8,
                    intent,
                    bpc,
                    &patches,
                    3,
                );
                let (got, _) = ours(
                    Backend::Moxcms,
                    BpcMode::Auto,
                    src,
                    Layout::RGB,
                    dst,
                    Layout::RGB,
                    intent,
                    bpc,
                    &patches,
                );
                let de = max_delta_e(
                    &to_lab(dst, PixelFormat::RGB_8, &want),
                    &to_lab(dst, PixelFormat::RGB_8, &got),
                );
                assert!(
                    de <= 1.5,
                    "{name} {intent:?} bpc={bpc}: ΔE {de:.2} from lcms2"
                );
            }
        }
    }
}

#[test]
fn gray_and_lab_transforms_match_lcms2__feat__color_swatches_cms_unified() {
    let srgb = Profile::new_srgb().icc().expect("srgb");
    let gray = lifted_gray();
    let ramp: Vec<u8> = (0..=255).collect();
    let mut backends = vec![Backend::Lcms2];
    if Backend::Moxcms.is_available() {
        backends.push(Backend::Moxcms);
    }
    for bpc in [false, true] {
        let want = oracle(
            &gray,
            PixelFormat::GRAY_8,
            &srgb,
            PixelFormat::RGB_8,
            Intent::RelativeColorimetric,
            bpc,
            &ramp,
            3,
        );
        for &backend in &backends {
            let (got, _) = ours(
                backend,
                BpcMode::Auto,
                &gray,
                Layout::GRAY,
                &srgb,
                Layout::RGB,
                Intent::RelativeColorimetric,
                bpc,
                &ramp,
            );
            let d = max_diff(&want, &got);
            assert!(d <= 3, "gray→sRGB on {backend} bpc={bpc}: {d} levels");
        }
    }
    // Lab ↔ sRGB: our Lab end against lcms2's Lab profile.
    let labs: Vec<f32> = [
        [50.0f32, 0.0, 0.0],
        [75.0, 20.0, -30.0],
        [35.0, 15.0, 25.0],
        [90.0, 5.0, 5.0],
    ]
    .concat();
    let lab_profile =
        Profile::new_lab4_context(lcms2::GlobalContext::new(), &D50_XYY).expect("lab");
    let t: Transform<[f64; 3], [u8; 3]> = Transform::new(
        &lab_profile,
        PixelFormat::Lab_DBL,
        &Profile::new_srgb(),
        PixelFormat::RGB_8,
        LIntent::RelativeColorimetric,
    )
    .expect("lab→srgb");
    let input: Vec<[f64; 3]> = labs
        .as_chunks::<3>()
        .0
        .iter()
        .map(|l| [f64::from(l[0]), f64::from(l[1]), f64::from(l[2])])
        .collect();
    let mut want = vec![[0u8; 3]; input.len()];
    t.transform_pixels(&input, &mut want);
    let want: Vec<u8> = want.concat();
    for &backend in &backends {
        let ours = paged_color::cms::Transform::new(
            backend,
            ProfileRef::Lab,
            Layout::LAB,
            ProfileRef::Srgb,
            Layout::RGB,
            Rendering::new(Intent::RelativeColorimetric, false),
        )
        .expect("lab→srgb");
        let mut out = vec![0f32; labs.len()];
        ours.apply_f32(&labs, &mut out);
        let got: Vec<u8> = out.iter().map(|v| (v * 255.0).round() as u8).collect();
        assert!(
            max_diff(&want, &got) <= 2,
            "Lab→sRGB on {backend}: {got:?} vs {want:?}"
        );
        // And back.
        let back = paged_color::cms::Transform::new(
            backend,
            ProfileRef::Srgb,
            Layout::RGB,
            ProfileRef::Lab,
            Layout::LAB,
            Rendering::new(Intent::RelativeColorimetric, false),
        )
        .expect("srgb→lab");
        let mut lab_back = vec![0f32; out.len()];
        back.apply_f32(&out, &mut lab_back);
        for (a, b) in labs
            .as_chunks::<3>()
            .0
            .iter()
            .zip(lab_back.as_chunks::<3>().0)
        {
            let de = delta_e76([a[0], a[1], a[2]], [b[0], b[1], b[2]]);
            assert!(de < 1.0, "{backend} Lab round trip {a:?} → {b:?}");
        }
    }
}

#[test]
fn cmyk_transforms_match_lcms2_per_intent_and_bpc__feat__color_swatches_cms_unified() {
    let Some(cmyk) = cmyk_profile() else {
        skip!(
            Resource::Icc,
            "{}",
            paged_color::test_profiles::NO_PROFILE_HINT
        );
    };
    let srgb = Profile::new_srgb().icc().expect("srgb");
    let inks = cmyk_patches();
    let rgbs = rgb_patches();
    // (backend, BPC mode, max ΔE*ab CMYK→sRGB, max ΔE*ab sRGB→CMYK), both
    // measured in Lab (two CMMs may separate one colour differently, and
    // 8-bit levels overstate shadow differences). lcms2 on its own BPC is
    // exact. Measured (2026-10) on Coated FOGRA39 and on Ghostscript's
    // default_cmyk.icc (the profile CI fetches):
    // * lcms2 with our BPC: ΔE 0.0–0.7 both ways;
    // * moxcms: ΔE 2.3 / 2.6 without BPC; with BPC 3.2 / 3.7 on FOGRA39 and
    //   9.1 / 6.6 on default_cmyk, whose rich shadows (C25 M100 K100) are
    //   darker than its detected black point: the compensation takes them
    //   below zero in X, which the moxcms PCS proxy clips (lcms2 carries
    //   the negative through its float matrix);
    // * moxcms absolute colorimetric: ΔE 6.3 / 10.8 (FOGRA39) and 12.2 /
    //   17.5 (default_cmyk), with or without BPC — moxcms adapts the media
    //   white differently.
    let mut cases = vec![
        (Backend::Lcms2, BpcMode::Auto, 0.0f32, 0.0f32),
        (Backend::Lcms2, BpcMode::Software, 1.0, 1.0),
    ];
    if Backend::Moxcms.is_available() {
        cases.push((Backend::Moxcms, BpcMode::Auto, 9.5, 7.0));
    }
    for intent in INTENTS {
        for bpc in [false, true] {
            // CMYK → sRGB, compared per channel.
            let want = oracle(
                &cmyk,
                PixelFormat::CMYK_8,
                &srgb,
                PixelFormat::RGB_8,
                intent,
                bpc,
                &inks,
                3,
            );
            // sRGB → CMYK, compared in Lab (two CMMs may separate the
            // same colour differently).
            let want_sep = oracle(
                &srgb,
                PixelFormat::RGB_8,
                &cmyk,
                PixelFormat::CMYK_8,
                intent,
                bpc,
                &rgbs,
                4,
            );
            let want_lab = to_lab(&cmyk, PixelFormat::CMYK_8, &want_sep);
            for &(backend, mode, de_rgb_bound, de_bound) in &cases {
                let (de_rgb_bound, de_bound) =
                    if backend == Backend::Moxcms && intent == Intent::AbsoluteColorimetric {
                        (12.5, 18.0)
                    } else {
                        (de_rgb_bound, de_bound)
                    };
                let (got, _) = ours(
                    backend,
                    mode,
                    &cmyk,
                    Layout::CMYK,
                    &srgb,
                    Layout::RGB,
                    intent,
                    bpc,
                    &inks,
                );
                if mode == BpcMode::Auto && backend == Backend::Lcms2 {
                    assert_eq!(want, got, "lcms2 {intent:?} bpc={bpc}: bit-identical");
                }
                let de_rgb = max_delta_e(
                    &to_lab(&srgb, PixelFormat::RGB_8, &want),
                    &to_lab(&srgb, PixelFormat::RGB_8, &got),
                );
                eprintln!("CMYK→sRGB {backend} {mode:?} {intent:?} bpc={bpc}: ΔE {de_rgb:.2}");
                assert!(
                    de_rgb <= de_rgb_bound,
                    "CMYK→sRGB {backend} {mode:?} {intent:?} bpc={bpc}: ΔE {de_rgb:.2} from lcms2"
                );
                let (sep, _) = ours(
                    backend,
                    mode,
                    &srgb,
                    Layout::RGB,
                    &cmyk,
                    Layout::CMYK,
                    intent,
                    bpc,
                    &rgbs,
                );
                let de = max_delta_e(&want_lab, &to_lab(&cmyk, PixelFormat::CMYK_8, &sep));
                eprintln!("sRGB→CMYK {backend} {mode:?} {intent:?} bpc={bpc}: ΔE {de:.2}");
                assert!(
                    de <= de_bound.max(0.5),
                    "sRGB→CMYK {backend} {mode:?} {intent:?} bpc={bpc}: ΔE {de:.2} from lcms2"
                );
            }
        }
    }
}

/// The native default is lcms2 with its own BPC, built as `IccTransform`
/// builds the renderer's CMYK transform: bit-identical.
#[test]
fn the_default_cmyk_transform_is_the_renderers__feat__color_swatches_cms_unified() {
    let Some(cmyk) = cmyk_profile() else {
        skip!(
            Resource::Icc,
            "{}",
            paged_color::test_profiles::NO_PROFILE_HINT
        );
    };
    let legacy = paged_color::IccTransform::cmyk_to_linear_rgb(&cmyk).expect("legacy");
    let inks = cmyk_patches();
    let px: Vec<[u8; 4]> = inks
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| [c[0], c[1], c[2], c[3]])
        .collect();
    let mut want = vec![[0u8; 3]; px.len()];
    legacy.cmyk_bytes_to_rgb_bytes(&px, &mut want);
    let t = paged_color::cms::Transform::new(
        Backend::preferred(),
        ProfileRef::Icc(&cmyk),
        Layout::CMYK,
        ProfileRef::Srgb,
        Layout::RGB,
        Rendering::default(),
    )
    .expect("transform");
    assert_eq!(t.bpc(), BpcApplied::Native);
    let mut got = vec![0u8; px.len() * 3];
    t.apply_u8(&inks, &mut got);
    assert_eq!(want.concat(), got);
}

// ─────────────────────────── soft proof, gamut ────────────────────────

/// Our soft proof against lcms2's proofing transform (`SOFT_PROOFING`):
/// source → press under the proof intent, press → display relative
/// colorimetric (simulate black ink) or absolute (simulate paper).
///
/// lcms2 joins the two conversions into one float pipeline, so on a
/// matrix-shaper press a colour outside the press's gamut is carried
/// through unclipped; a press cannot print it, and ours clips the press
/// values. The comparison therefore covers the colours the press can
/// print (by the gamut check), and the rest must come out clipped.
#[test]
fn soft_proof_matches_lcms2s_proofing_transform__feat__color_swatches_cms_unified() {
    let srgb = Profile::new_srgb().icc().expect("srgb");
    let press = narrow_rgb();
    // The cube plus a dense set of the muted mid-tones a narrow press can
    // print.
    let mut patches = rgb_patches();
    for r in (88..=232).step_by(24) {
        for g in (88..=232).step_by(24) {
            for b in (88..=232).step_by(24) {
                patches.extend_from_slice(&[r as u8, g as u8, b as u8]);
            }
        }
    }
    let inside: Vec<bool> = GamutCheck::new(
        Backend::Lcms2,
        ProfileRef::Icc(&srgb),
        Layout::RGB,
        ProfileRef::Icc(&press),
        GamutCheck::DEFAULT_THRESHOLD,
    )
    .expect("gamut")
    .check_u8(&patches)
    .delta_e
    .iter()
    .map(|&d| d < 0.5)
    .collect();
    let printable = inside.iter().filter(|&&i| i).count();
    assert!(printable > 50, "enough printable patches: {printable}");
    let mut backends = vec![(Backend::Lcms2, 2u8)];
    if Backend::Moxcms.is_available() {
        backends.push((Backend::Moxcms, 4));
    }
    for (simulate_paper, proof_intent) in [
        (false, LIntent::RelativeColorimetric),
        (true, LIntent::AbsoluteColorimetric),
    ] {
        for intent in [Intent::Perceptual, Intent::RelativeColorimetric] {
            let t: Transform<u8, u8> = Transform::new_proofing(
                &lcms_profile(&srgb),
                PixelFormat::RGB_8,
                &lcms_profile(&srgb),
                PixelFormat::RGB_8,
                &lcms_profile(&press),
                l_intent(intent),
                proof_intent,
                Flags::SOFT_PROOFING,
            )
            .expect("lcms2 proofing");
            let mut want = vec![0u8; patches.len()];
            t.transform_pixels(&patches, &mut want);
            for &(backend, bound) in &backends {
                let options = ProofOptions {
                    rendering: Rendering::new(intent, false),
                    simulate_paper,
                    simulate_black_ink: true,
                };
                let proof = SoftProof::new(
                    backend,
                    ProfileRef::Icc(&srgb),
                    Layout::RGB,
                    ProfileRef::Icc(&press),
                    ProfileRef::Icc(&srgb),
                    Layout::RGB,
                    options,
                )
                .expect("soft proof");
                let mut got = vec![0u8; patches.len()];
                proof.apply_u8(&patches, &mut got);
                let mut d = 0u8;
                for (i, &ok) in inside.iter().enumerate() {
                    if ok {
                        d = d.max(max_diff(&want[i * 3..i * 3 + 3], &got[i * 3..i * 3 + 3]));
                    }
                }
                assert!(
                    d <= bound,
                    "{backend} proof {intent:?} paper={simulate_paper}: {d} levels from lcms2"
                );
                // Every patch is what the press values, clipped, look like.
                let to_press = paged_color::cms::Transform::new(
                    backend,
                    ProfileRef::Icc(&srgb),
                    Layout::RGB,
                    ProfileRef::Icc(&press),
                    Layout::RGB,
                    options.rendering,
                )
                .expect("to press");
                let to_display = paged_color::cms::Transform::new(
                    backend,
                    ProfileRef::Icc(&press),
                    Layout::RGB,
                    ProfileRef::Icc(&srgb),
                    Layout::RGB,
                    options.display_rendering(),
                )
                .expect("to display");
                let f: Vec<f32> = patches.iter().map(|&v| f32::from(v) / 255.0).collect();
                let mut dev = vec![0f32; f.len()];
                to_press.apply_f32(&f, &mut dev);
                assert!(
                    dev.iter().all(|v| (0.0..=1.0).contains(v)),
                    "press values clip"
                );
                let mut shown = vec![0f32; f.len()];
                to_display.apply_f32(&dev, &mut shown);
                let shown: Vec<u8> = shown.iter().map(|v| (v * 255.0).round() as u8).collect();
                assert!(
                    max_diff(&shown, &got) <= 1,
                    "{backend}: the proof is the two legs"
                );
            }
        }
    }
}

/// On a CMYK press (a LUT profile clips by construction) the whole patch
/// set agrees with lcms2's proofing transform, in ΔE on the display.
#[test]
fn soft_proof_on_a_cmyk_press_matches_lcms2__feat__color_swatches_cms_unified() {
    let Some(cmyk) = cmyk_profile() else {
        skip!(
            Resource::Icc,
            "{}",
            paged_color::test_profiles::NO_PROFILE_HINT
        );
    };
    let srgb = Profile::new_srgb().icc().expect("srgb");
    let patches = rgb_patches();
    // ΔE*ab on the display. Measured on Coated FOGRA39: lcms2 (two
    // legs vs one joined pipeline) 1.5, moxcms 2.0.
    let mut backends = vec![(Backend::Lcms2, 2.0f32)];
    if Backend::Moxcms.is_available() {
        backends.push((Backend::Moxcms, 3.0));
    }
    for intent in [Intent::Perceptual, Intent::RelativeColorimetric] {
        let t: Transform<u8, u8> = Transform::new_proofing(
            &lcms_profile(&srgb),
            PixelFormat::RGB_8,
            &lcms_profile(&srgb),
            PixelFormat::RGB_8,
            &lcms_profile(&cmyk),
            l_intent(intent),
            LIntent::RelativeColorimetric,
            Flags::SOFT_PROOFING,
        )
        .expect("lcms2 proofing");
        let mut want = vec![0u8; patches.len()];
        t.transform_pixels(&patches, &mut want);
        for &(backend, bound) in &backends {
            let proof = SoftProof::new(
                backend,
                ProfileRef::Icc(&srgb),
                Layout::RGB,
                ProfileRef::Icc(&cmyk),
                ProfileRef::Icc(&srgb),
                Layout::RGB,
                ProofOptions {
                    rendering: Rendering::new(intent, false),
                    simulate_paper: false,
                    simulate_black_ink: true,
                },
            )
            .expect("soft proof");
            let mut got = vec![0u8; patches.len()];
            proof.apply_u8(&patches, &mut got);
            let de = max_delta_e(
                &to_lab(&srgb, PixelFormat::RGB_8, &want),
                &to_lab(&srgb, PixelFormat::RGB_8, &got),
            );
            assert!(
                de <= bound,
                "{backend} CMYK proof {intent:?}: ΔE {de:.2} from lcms2"
            );
        }
    }
}

/// The proof shows the press's limits: its lifted black and its duller
/// red, and without "simulate black ink" the black is compensated back.
#[test]
fn soft_proof_shows_the_press__feat__color_swatches_cms_unified() {
    let srgb = Profile::new_srgb().icc().expect("srgb");
    let press = narrow_rgb();
    let backend = Backend::preferred();
    let proof = |simulate_black_ink| {
        SoftProof::new(
            backend,
            ProfileRef::Srgb,
            Layout::RGBA,
            ProfileRef::Icc(&press),
            ProfileRef::Icc(&srgb),
            Layout::RGBA,
            ProofOptions {
                rendering: Rendering::new(Intent::RelativeColorimetric, false),
                simulate_paper: false,
                simulate_black_ink,
            },
        )
        .expect("proof")
    };
    let src = [0u8, 0, 0, 255, 255, 0, 0, 128];
    let mut out = [0u8; 8];
    proof(true).apply_u8(&src, &mut out);
    assert!(out[0] > 20, "the press's black shows: {out:?}");
    assert!(
        out[4] < 250 || out[5] > 20,
        "the press's red is duller: {out:?}"
    );
    assert_eq!(out[7], 128, "alpha carried");
    proof(false).apply_u8(&src, &mut out);
    assert!(out[0] <= 2, "BPC to the display restores black: {out:?}");
}

#[test]
fn gamut_check_flags_what_the_press_cannot_print__feat__color_swatches_cms_unified() {
    let press = narrow_rgb();
    let mut backends = vec![Backend::Lcms2];
    if Backend::Moxcms.is_available() {
        backends.push(Backend::Moxcms);
    }
    // Saturated primaries are out of the narrow press; neutrals above its
    // black and a pale tint are in.
    let src = [
        255u8, 0, 0, // red
        0, 255, 0, // green
        0, 0, 255, // blue
        128, 128, 128, // mid gray
        230, 225, 220, // pale warm tint
        255, 255, 255, // white
    ];
    let want = [true, true, true, false, false, false];
    for backend in backends {
        let check = GamutCheck::new(
            backend,
            ProfileRef::Srgb,
            Layout::RGB,
            ProfileRef::Icc(&press),
            GamutCheck::DEFAULT_THRESHOLD,
        )
        .expect("gamut check");
        let mask = check.check_u8(&src);
        assert_eq!(mask.out_of_gamut, want, "{backend}: ΔE {:?}", mask.delta_e);
        assert_eq!(mask.count(), 3);
        // The same source through the same profile is always in gamut.
        let same = GamutCheck::new(
            backend,
            ProfileRef::Srgb,
            Layout::RGB,
            ProfileRef::Srgb,
            GamutCheck::DEFAULT_THRESHOLD,
        )
        .expect("identity check");
        assert_eq!(same.check_u8(&src).count(), 0, "{backend}");
    }
    assert!(
        GamutCheck::new(
            Backend::Qcms,
            ProfileRef::Srgb,
            Layout::RGB,
            ProfileRef::Icc(&press),
            3.0
        )
        .is_err(),
        "qcms has no Lab end"
    );
}

#[test]
fn gamut_check_on_a_cmyk_press__feat__color_swatches_cms_unified() {
    let Some(cmyk) = cmyk_profile() else {
        skip!(
            Resource::Icc,
            "{}",
            paged_color::test_profiles::NO_PROFILE_HINT
        );
    };
    let mut backends = vec![Backend::Lcms2];
    if Backend::Moxcms.is_available() {
        backends.push(Backend::Moxcms);
    }
    // sRGB's blue and green are outside every offset press; a mid gray
    // and a skin tone are inside.
    let src = [0u8, 0, 255, 0, 255, 0, 128, 128, 128, 224, 172, 140];
    for backend in backends {
        let check = GamutCheck::new(
            backend,
            ProfileRef::Srgb,
            Layout::RGB,
            ProfileRef::Icc(&cmyk),
            GamutCheck::DEFAULT_THRESHOLD,
        )
        .expect("check");
        let mask = check.check_u8(&src);
        assert_eq!(
            mask.out_of_gamut,
            [true, true, false, false],
            "{backend}: ΔE {:?}",
            mask.delta_e
        );
    }
}
