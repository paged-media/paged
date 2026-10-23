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

//! Special functions shared by the kernels: the error function and the Bessel
//! functions. Pure `f64 -> f64` numerics, no cell types.
//!
//! - **erf / erfc** — the all-positive power series for small arguments and
//!   the classical continued fraction for the tail (Abramowitz & Stegun
//!   7.1.5 / 7.1.14), accurate to a few ulps across the real line.
//! - **Bessel I, J, K, Y of integer order.** Excel's values are the classic
//!   polynomial and rational approximations, not the exact functions (its
//!   `BESSELJ(0,0)` is `1.00000000283141`, its `BESSELK(2,1)` the 8-digit
//!   `0.13986588`). This module reproduces those published approximations so
//!   the engine agrees with Excel to the last digit:
//!   - `I0`, `I1`, `K0`, `K1`: Abramowitz & Stegun 9.8.1–9.8.8 polynomials;
//!   - `J0`, `J1`, `Y0`, `Y1`: Hart's rational approximations for `|x| < 8`
//!     and the asymptotic Hankel form with fitted `P`/`Q` polynomials beyond
//!     (J. F. Hart et al., *Computer Approximations*, 1968);
//!   - higher orders: Miller's backward recurrence for `J` and `I` (normalised
//!     by the Neumann sum resp. `I0`), forward recurrence for `Y` and `K`
//!     (A&S 9.1.27 / 9.6.26), which are stable in those directions.

// ---- the error function ------------------------------------------------------

const FRAC_2_SQRT_PI: f64 = std::f64::consts::FRAC_2_SQRT_PI;

/// `erf(x)` by the all-positive series
/// `2/√π · e^{−x²} · Σ 2ⁿ x^{2n+1} / (1·3·…·(2n+1))` (no cancellation;
/// A&S 7.1.6). Used for `|x| <= 3`.
pub(crate) fn erf_series(x: f64) -> f64 {
    let x2 = x * x;
    let mut term = x;
    let mut sum = x;
    let mut k = 1.0;
    for _ in 0..200 {
        term *= 2.0 * x2 / (2.0 * k + 1.0);
        sum += term;
        if term.abs() <= sum.abs() * 1e-17 {
            break;
        }
        k += 1.0;
    }
    FRAC_2_SQRT_PI * (-x2).exp() * sum
}

/// `erfc(x)` for `x > 0` by the continued fraction (A&S 7.1.14, modified
/// Lentz evaluation).
fn erfc_cf(x: f64) -> f64 {
    // erfc(x) = e^{-x²}/√π · 1/(x + (1/2)/(x + 1/(x + (3/2)/(x + 2/(x + …)))))
    let tiny = 1e-300;
    let mut f = x;
    if f == 0.0 {
        f = tiny;
    }
    let mut c = f;
    let mut d = 0.0;
    for i in 1..5000 {
        let a = i as f64 / 2.0;
        d = x + a * d;
        if d == 0.0 {
            d = tiny;
        }
        c = x + a / c;
        if c == 0.0 {
            c = tiny;
        }
        d = 1.0 / d;
        let delta = c * d;
        f *= delta;
        if (delta - 1.0).abs() < 1e-16 {
            break;
        }
    }
    (-x * x).exp() / std::f64::consts::PI.sqrt() / f
}

/// `erfc(x)` for any real `x`.
pub(crate) fn erfc(x: f64) -> f64 {
    if x < 0.0 {
        2.0 - erfc(-x)
    } else if x < 1.0 {
        1.0 - erf_series(x)
    } else {
        erfc_cf(x)
    }
}

/// `erf(x)` for any real `x`.
pub(crate) fn erf(x: f64) -> f64 {
    if x.abs() <= 3.0 {
        erf_series(x)
    } else if x > 0.0 {
        1.0 - erfc_cf(x)
    } else {
        erfc_cf(-x) - 1.0
    }
}

// ---- Bessel functions --------------------------------------------------------

/// Horner evaluation of `c[0] + c[1]·t + c[2]·t² + …`.
fn poly(c: &[f64], t: f64) -> f64 {
    c.iter().rev().fold(0.0, |acc, &k| acc * t + k)
}

/// `I0(x)` — A&S 9.8.1 (`|x| <= 3.75`) and 9.8.2.
pub(crate) fn bessel_i0(x: f64) -> f64 {
    let ax = x.abs();
    if ax < 3.75 {
        let t = (x / 3.75).powi(2);
        poly(
            &[
                1.0, 3.5156229, 3.0899424, 1.2067492, 0.2659732, 0.0360768, 0.0045813,
            ],
            t,
        )
    } else {
        let t = 3.75 / ax;
        (ax.exp() / ax.sqrt())
            * poly(
                &[
                    0.39894228,
                    0.01328592,
                    0.00225319,
                    -0.00157565,
                    0.00916281,
                    -0.02057706,
                    0.02635537,
                    -0.01647633,
                    0.00392377,
                ],
                t,
            )
    }
}

/// `I1(x)` — A&S 9.8.3 and 9.8.4 (odd in `x`).
pub(crate) fn bessel_i1(x: f64) -> f64 {
    let ax = x.abs();
    let v = if ax < 3.75 {
        let t = (x / 3.75).powi(2);
        ax * poly(
            &[
                0.5, 0.87890594, 0.51498869, 0.15084934, 0.02658733, 0.00301532, 0.00032411,
            ],
            t,
        )
    } else {
        let t = 3.75 / ax;
        (ax.exp() / ax.sqrt())
            * poly(
                &[
                    0.39894228,
                    -0.03988024,
                    -0.00362018,
                    0.00163801,
                    -0.01031555,
                    0.02282967,
                    -0.02895312,
                    0.01787654,
                    -0.00420059,
                ],
                t,
            )
    };
    if x < 0.0 {
        -v
    } else {
        v
    }
}

// The A&S coefficients are the published 8-digit values (−0.57721566 is
// the approximation's own γ), not the library constants.
#[allow(clippy::approx_constant)]
/// `K0(x)`, `x > 0` — A&S 9.8.5 (`x <= 2`) and 9.8.6.
pub(crate) fn bessel_k0(x: f64) -> f64 {
    if x <= 2.0 {
        let t = x * x / 4.0;
        -(x / 2.0).ln() * bessel_i0(x)
            + poly(
                &[
                    -0.57721566,
                    0.42278420,
                    0.23069756,
                    0.03488590,
                    0.00262698,
                    0.00010750,
                    0.00000740,
                ],
                t,
            )
    } else {
        let t = 2.0 / x;
        ((-x).exp() / x.sqrt())
            * poly(
                &[
                    1.25331414,
                    -0.07832358,
                    0.02189568,
                    -0.01062446,
                    0.00587872,
                    -0.00251540,
                    0.00053208,
                ],
                t,
            )
    }
}

/// `K1(x)`, `x > 0` — A&S 9.8.7 (`x <= 2`) and 9.8.8.
pub(crate) fn bessel_k1(x: f64) -> f64 {
    if x <= 2.0 {
        let t = x * x / 4.0;
        (x / 2.0).ln() * bessel_i1(x)
            + (1.0 / x)
                * poly(
                    &[
                        1.0,
                        0.15443144,
                        -0.67278579,
                        -0.18156897,
                        -0.01919402,
                        -0.00110404,
                        -0.00004686,
                    ],
                    t,
                )
    } else {
        let t = 2.0 / x;
        ((-x).exp() / x.sqrt())
            * poly(
                &[
                    1.25331414,
                    0.23498619,
                    -0.03655620,
                    0.01504268,
                    -0.00780353,
                    0.00325614,
                    -0.00068245,
                ],
                t,
            )
    }
}

/// `2/π` as the approximations state it (eight digits).
#[allow(clippy::approx_constant)]
const TWO_OVER_PI_8: f64 = 0.636619772;

/// The asymptotic `P`/`Q` factors of `J0`/`Y0` for `|x| >= 8`. `p1` is the
/// first `P` coefficient: `Y0` uses Hart's `-0.1098628627e-2`, while Excel's
/// `J0` evidently carries `-0.1098628267e-2` (two digits transposed —
/// recovered by a least-squares fit against 76 Excel-recorded values, which
/// it then reproduces to the last digit).
fn pq0(y: f64, p1: f64, q_last: f64) -> (f64, f64) {
    let p = poly(
        &[1.0, p1, 0.2734510407e-4, -0.2073370639e-5, 0.2093887211e-6],
        y,
    );
    let q = poly(
        &[
            -0.1562499995e-1,
            0.1430488765e-3,
            -0.6911147651e-5,
            0.7621095161e-6,
            q_last,
        ],
        y,
    );
    (p, q)
}

/// The asymptotic `P`/`Q` factors of `J1`/`Y1` for `|x| >= 8`. Excel's
/// `J1` evaluates its `P` with the `y²` coefficient repeated at `y³` (a
/// polynomial one degree longer — recovered from the recorded values the
/// same way, and reproduced here); `Y1` uses the plain polynomial.
fn pq1(y: f64, excel_j1: bool) -> (f64, f64) {
    let p = if excel_j1 {
        poly(
            &[
                1.0,
                0.183105e-2,
                -0.3516396496e-4,
                -0.3516396496e-4,
                0.2457520174e-5,
                -0.240337019e-6,
            ],
            y,
        )
    } else {
        poly(
            &[
                1.0,
                0.183105e-2,
                -0.3516396496e-4,
                0.2457520174e-5,
                -0.240337019e-6,
            ],
            y,
        )
    };
    let q = poly(
        &[
            0.04687499995,
            -0.2002690873e-3,
            0.8449199096e-5,
            -0.88228987e-6,
            0.105787412e-6,
        ],
        y,
    );
    (p, q)
}

/// `J0(x)` (even).
pub(crate) fn bessel_j0(x: f64) -> f64 {
    let ax = x.abs();
    if ax < 8.0 {
        let y = x * x;
        let a = poly(
            &[
                57568490574.0,
                -13362590354.0,
                651619640.7,
                -11214424.18,
                77392.33017,
                -184.9052456,
            ],
            y,
        );
        let b = poly(
            &[
                57568490411.0,
                1029532985.0,
                9494680.718,
                59272.64853,
                267.8532712,
                1.0,
            ],
            y,
        );
        a / b
    } else {
        let z = 8.0 / ax;
        let y = z * z;
        let xx = ax - 0.785398164;
        let (p, q) = pq0(y, -0.1098628267e-2, -0.934935152e-7);
        (TWO_OVER_PI_8 / ax).sqrt() * (xx.cos() * p - z * xx.sin() * q)
    }
}

/// `J1(x)` (odd).
pub(crate) fn bessel_j1(x: f64) -> f64 {
    let ax = x.abs();
    if ax < 8.0 {
        let y = x * x;
        let a = x * poly(
            &[
                72362614232.0,
                -7895059235.0,
                242396853.1,
                -2972611.439,
                15704.48260,
                -30.16036606,
            ],
            y,
        );
        let b = poly(
            &[
                144725228442.0,
                2300535178.0,
                18583304.74,
                99447.43394,
                376.9991397,
                1.0,
            ],
            y,
        );
        a / b
    } else {
        let z = 8.0 / ax;
        let y = z * z;
        let xx = ax - 2.356194491;
        let (p, q) = pq1(y, true);
        let v = (TWO_OVER_PI_8 / ax).sqrt() * (xx.cos() * p - z * xx.sin() * q);
        if x < 0.0 {
            -v
        } else {
            v
        }
    }
}

/// `Y0(x)`, `x > 0`.
pub(crate) fn bessel_y0(x: f64) -> f64 {
    if x < 8.0 {
        let y = x * x;
        let a = poly(
            &[
                -2957821389.0,
                7062834065.0,
                -512359803.6,
                10879881.29,
                -86327.92757,
                228.4622733,
            ],
            y,
        );
        let b = poly(
            &[
                40076544269.0,
                745249964.8,
                7189466.438,
                47447.26470,
                226.1030244,
                1.0,
            ],
            y,
        );
        a / b + TWO_OVER_PI_8 * bessel_j0(x) * x.ln()
    } else {
        let z = 8.0 / x;
        let y = z * z;
        let xx = x - 0.785398164;
        let (p, q) = pq0(y, -0.1098628627e-2, -0.934945152e-7);
        (TWO_OVER_PI_8 / x).sqrt() * (xx.sin() * p + z * xx.cos() * q)
    }
}

/// `Y1(x)`, `x > 0`.
pub(crate) fn bessel_y1(x: f64) -> f64 {
    if x < 8.0 {
        let y = x * x;
        let a = x * poly(
            &[
                -0.4900604943e13,
                0.1275274390e13,
                -0.5153438139e11,
                0.7349264551e9,
                -0.4237922726e7,
                0.8511937935e4,
            ],
            y,
        );
        let b = poly(
            &[
                0.2499580570e14,
                0.4244419664e12,
                0.3733650367e10,
                0.2245904002e8,
                0.1020426050e6,
                0.3549632885e3,
                1.0,
            ],
            y,
        );
        a / b + TWO_OVER_PI_8 * (bessel_j1(x) * x.ln() - 1.0 / x)
    } else {
        let z = 8.0 / x;
        let y = z * z;
        let xx = x - 2.356194491;
        let (p, q) = pq1(y, false);
        (TWO_OVER_PI_8 / x).sqrt() * (xx.sin() * p + z * xx.cos() * q)
    }
}

/// Miller's recurrence depth constant and the rescaling bounds.
const MILLER_ACC: f64 = 40.0;
const BIG: f64 = 1.0e10;
const BIG_INV: f64 = 1.0e-10;

/// `Jn(x)` for integer `n >= 0`.
pub(crate) fn bessel_jn(n: u32, x: f64) -> f64 {
    match n {
        0 => return bessel_j0(x),
        1 => return bessel_j1(x),
        _ => {}
    }
    let ax = x.abs();
    if ax == 0.0 {
        return 0.0;
    }
    let nf = f64::from(n);
    let tox = 2.0 / ax;
    let ans = if ax > nf {
        // Forward recurrence is stable above the order.
        let mut bjm = bessel_j0(ax);
        let mut bj = bessel_j1(ax);
        for j in 1..n {
            let bjp = f64::from(j) * tox * bj - bjm;
            bjm = bj;
            bj = bjp;
        }
        bj
    } else {
        // Miller: recur downward from an even start far above n, normalise by
        // the Neumann identity J0 + 2(J2 + J4 + …) = 1.
        let m = 2 * ((n + (MILLER_ACC * nf).sqrt() as u32) / 2);
        let mut jsum = false;
        let (mut bjp, mut ans, mut sum, mut bj) = (0.0, 0.0, 0.0, 1.0);
        let mut j = m;
        while j > 0 {
            let bjm = f64::from(j) * tox * bj - bjp;
            bjp = bj;
            bj = bjm;
            if bj.abs() > BIG {
                bj *= BIG_INV;
                bjp *= BIG_INV;
                ans *= BIG_INV;
                sum *= BIG_INV;
            }
            if jsum {
                sum += bj;
            }
            jsum = !jsum;
            if j == n {
                ans = bjp;
            }
            j -= 1;
        }
        sum = 2.0 * sum - bj;
        ans / sum
    };
    if x < 0.0 && n % 2 == 1 {
        -ans
    } else {
        ans
    }
}

/// `In(x)` for integer `n >= 0`.
pub(crate) fn bessel_in(n: u32, x: f64) -> f64 {
    match n {
        0 => return bessel_i0(x),
        1 => return bessel_i1(x),
        _ => {}
    }
    if x == 0.0 {
        return 0.0;
    }
    let nf = f64::from(n);
    let tox = 2.0 / x.abs();
    let (mut bip, mut ans, mut bi) = (0.0, 0.0, 1.0);
    let mut j = 2 * (n + (MILLER_ACC * nf).sqrt() as u32);
    while j > 0 {
        let bim = bip + f64::from(j) * tox * bi;
        bip = bi;
        bi = bim;
        if bi.abs() > BIG {
            ans *= BIG_INV;
            bi *= BIG_INV;
            bip *= BIG_INV;
        }
        if j == n {
            ans = bip;
        }
        j -= 1;
    }
    let ans = ans * bessel_i0(x) / bi;
    if x < 0.0 && n % 2 == 1 {
        -ans
    } else {
        ans
    }
}

/// `Kn(x)`, `x > 0`, by forward recurrence from `K0`, `K1`.
pub(crate) fn bessel_kn(n: u32, x: f64) -> f64 {
    let (mut bkm, mut bk) = (bessel_k0(x), bessel_k1(x));
    if n == 0 {
        return bkm;
    }
    let tox = 2.0 / x;
    for j in 1..n {
        let bkp = bkm + f64::from(j) * tox * bk;
        bkm = bk;
        bk = bkp;
    }
    bk
}

/// `Yn(x)`, `x > 0`, by forward recurrence from `Y0`, `Y1`.
pub(crate) fn bessel_yn(n: u32, x: f64) -> f64 {
    let (mut bym, mut by) = (bessel_y0(x), bessel_y1(x));
    if n == 0 {
        return bym;
    }
    let tox = 2.0 / x;
    for j in 1..n {
        let byp = f64::from(j) * tox * by - bym;
        bym = by;
        by = byp;
    }
    by
}

// ---- gamma and beta functions (W3 statistics) ---------------------------------
//
// The distributions of the statistical family rest on four functions, all
// from the published mathematics (Abramowitz & Stegun ch. 6 and 26, the
// Lanczos approximation, Lentz's evaluation of continued fractions, and
// Loader's saddle-point form of the discrete densities):
//
// - `ln_gamma`: the Lanczos approximation (g = 7, nine terms) on (0.5, 10),
//   the Stirling series beyond, the Taylor series of ln Γ(1+z) in ζ values
//   around the zeros at 1 and 2, the reflection formula below 0.5;
// - `gamma_p_q`: the regularised incomplete gamma functions P and Q, by the
//   series below `a + 1` and the continued fraction above, with the prefactor
//   `x^a e^-x / Γ(a)` taken in a form that keeps its relative accuracy for a
//   large shape;
// - `beta_i`: the regularised incomplete beta function by its continued
//   fraction, on the side of the symmetry `I_x(a,b) = 1 − I_{1−x}(b,a)` where
//   it converges fast, returning both tails;
// - `dbinom_raw` / `dpois_raw`: Loader's binomial and Poisson densities
//   (Stirling-error and deviance terms), accurate in the far tails.
//
// The inverses solve on whichever tail is smaller with a safeguarded root
// finder (bracketing, secant and bisection steps, Brent's method) to a few
// ulps.

const LN_SQRT_2PI: f64 = 0.918_938_533_204_672_8;

/// ζ(k) for an integer `k >= 2`.
fn zeta(k: u32) -> f64 {
    use std::f64::consts::PI;
    match k {
        2 => PI * PI / 6.0,
        3 => 1.202_056_903_159_594_2,
        4 => PI.powi(4) / 90.0,
        5 => 1.036_927_755_143_37,
        6 => PI.powi(6) / 945.0,
        7 => 1.008_349_277_381_922_8,
        _ => {
            // 1 + 2^-k + 3^-k + …: from k = 8 the terms past 60 are below
            // 1e-14 of the sum.
            let mut s = 0.0;
            for n in (2..=60u32).rev() {
                s += f64::from(n).powi(-(k as i32));
            }
            1.0 + s
        }
    }
}

/// `ln Γ(1 + z)` for `|z| <= 0.25`: `−γz + Σ (−1)^k ζ(k) z^k / k`.
fn ln_gamma_1p(z: f64) -> f64 {
    const EULER: f64 = std::f64::consts::EULER_GAMMA;
    let mut sum = -EULER * z;
    // (−z)^k, so the term is (−1)^k ζ(k) z^k / k.
    let mut zk = -z;
    for k in 2..80u32 {
        zk *= -z;
        let term = zeta(k) * zk / f64::from(k);
        sum += term;
        if term.abs() <= 1e-18 * sum.abs().max(1e-300) {
            break;
        }
    }
    sum
}

/// The Lanczos sum `A(x)` (g = 7, nine coefficients), with
/// `Γ(x) = √(2π) · t^(x−½) · e^(−t) · A(x)`, `t = x + 6.5`.
fn lanczos_sum(x: f64) -> f64 {
    const P: [f64; 9] = [
        0.999_999_999_999_809_9,
        676.520_368_121_885_1,
        -1_259.139_216_722_402_8,
        771.323_428_777_653_1,
        -176.615_029_162_140_6,
        12.507_343_278_686_905,
        -0.138_571_095_265_720_12,
        9.984_369_578_019_572e-6,
        1.505_632_735_149_311_6e-7,
    ];
    let xm = x - 1.0;
    let mut a = P[0];
    for (i, &p) in P.iter().enumerate().skip(1) {
        a += p / (xm + i as f64);
    }
    a
}

/// The Stirling series `ln Γ(x) − ((x−½) ln x − x + ln √(2π))`, `x >= 10`.
fn stirling_correction(x: f64) -> f64 {
    let r = 1.0 / x;
    let r2 = r * r;
    r * (1.0 / 12.0
        - r2 * (1.0 / 360.0
            - r2 * (1.0 / 1260.0
                - r2 * (1.0 / 1680.0 - r2 * (1.0 / 1188.0 - r2 * 691.0 / 360_360.0)))))
}

/// `ln Γ(x)` for `x > 0` (NaN otherwise).
pub(crate) fn ln_gamma(x: f64) -> f64 {
    if x.is_nan() || x <= 0.0 {
        return f64::NAN;
    }
    if x < 0.5 {
        if x < 0.25 {
            // ln Γ(x) = ln Γ(1+x) − ln x.
            return ln_gamma_1p(x) - x.ln();
        }
        // Reflection: Γ(x) Γ(1−x) = π / sin(πx).
        return (std::f64::consts::PI / sin_pi(x)).ln() - ln_gamma(1.0 - x);
    }
    if (0.75..=1.25).contains(&x) {
        return ln_gamma_1p(x - 1.0);
    }
    if (1.75..=2.25).contains(&x) {
        let z = x - 2.0;
        return z.ln_1p() + ln_gamma_1p(z);
    }
    if x >= 10.0 {
        return (x - 0.5) * x.ln() - x + LN_SQRT_2PI + stirling_correction(x);
    }
    let t = x + 6.5;
    LN_SQRT_2PI + (x - 0.5) * t.ln() - t + lanczos_sum(x).ln()
}

/// `sin(πx)` with the argument reduced exactly first.
fn sin_pi(x: f64) -> f64 {
    let r = x - 2.0 * (x / 2.0).round(); // [-1, 1]
    if r == 0.0 || r.abs() == 1.0 {
        return 0.0;
    }
    if r.abs() == 0.5 {
        return r.signum();
    }
    (std::f64::consts::PI * r).sin()
}

/// `Γ(x)` for real `x`; NaN at 0 and the negative integers.
pub(crate) fn gamma(x: f64) -> f64 {
    if x.is_nan() || (x <= 0.0 && x == x.floor()) {
        return f64::NAN;
    }
    if x == x.floor() && x <= 171.0 {
        let mut p = 1.0;
        let mut k = 2.0;
        while k < x {
            p *= k;
            k += 1.0;
        }
        return p;
    }
    if x < 0.5 {
        return std::f64::consts::PI / (sin_pi(x) * gamma(1.0 - x));
    }
    if x > 171.7 {
        return f64::INFINITY;
    }
    // Γ(x) = √(2π) t^(x−½) e^(−t) A(x), the power split so it cannot
    // overflow before the exponential brings it back.
    let t = x + 6.5;
    let h = t.powf((x - 0.5) / 2.0);
    (2.0 * std::f64::consts::PI).sqrt() * h * ((-t).exp() * h) * lanczos_sum(x)
}

/// `x^a e^(−x) / Γ(a)`, the prefactor of the incomplete gamma functions,
/// keeping its relative accuracy for a large `a` (the exponent is formed as
/// `a·(ln(1+t) − t)` with `x = a(1+t)` instead of `a ln x − x`).
fn gamma_prefactor(a: f64, x: f64) -> f64 {
    if a < 10.0 {
        return (a * x.ln() - x - ln_gamma(a)).exp();
    }
    let t = (x - a) / a;
    let l = if t.abs() < 0.3 {
        // ln(1+t) − t = −t²/2 + t³/3 − …
        let mut s = 0.0;
        let mut tk = t * t;
        let mut k = 2.0;
        loop {
            let term = tk / k;
            s += if (k as i64) % 2 == 0 { -term } else { term };
            if term.abs() <= 1e-18 * s.abs() {
                break;
            }
            tk *= t;
            k += 1.0;
            if k > 200.0 {
                break;
            }
        }
        s
    } else {
        t.ln_1p() - t
    };
    // x^a e^−x / Γ(a) = e^{a(ln(1+t) − t)} · a^a e^−a / Γ(a)
    //                 = e^{a(...)} · √(a / 2π) · e^{−stirling(a)}.
    (a * l - stirling_correction(a)).exp() * (a / (2.0 * std::f64::consts::PI)).sqrt()
}

/// The regularised incomplete gamma functions `(P(a,x), Q(a,x))`, `a > 0`,
/// `x >= 0`.
pub(crate) fn gamma_p_q(a: f64, x: f64) -> (f64, f64) {
    if x <= 0.0 {
        return (0.0, 1.0);
    }
    if x.is_infinite() {
        return (1.0, 0.0);
    }
    let pre = gamma_prefactor(a, x);
    if x < a + 1.0 {
        // P = pre/a · (1 + x/(a+1) + x²/((a+1)(a+2)) + …)
        let mut term = 1.0;
        let mut sum = 1.0;
        let mut ap = a;
        for _ in 0..100_000 {
            ap += 1.0;
            term *= x / ap;
            sum += term;
            if term <= sum * 1e-17 {
                break;
            }
        }
        let p = (pre / a * sum).min(1.0);
        (p, 1.0 - p)
    } else {
        // Q = pre · 1/(x+1−a− 1(1−a)/(x+3−a− 2(2−a)/(x+5−a− …))) (Lentz).
        let tiny = 1e-300;
        let mut b = x + 1.0 - a;
        let mut c = 1.0 / tiny;
        let mut d = 1.0 / b;
        let mut h = d;
        for i in 1..100_000 {
            let an = -(i as f64) * (i as f64 - a);
            b += 2.0;
            d = an * d + b;
            if d.abs() < tiny {
                d = tiny;
            }
            c = b + an / c;
            if c.abs() < tiny {
                c = tiny;
            }
            d = 1.0 / d;
            let del = d * c;
            h *= del;
            if (del - 1.0).abs() < 1e-16 {
                break;
            }
        }
        let q = (pre * h).min(1.0);
        (1.0 - q, q)
    }
}

/// `ln B(a, b)`.
pub(crate) fn ln_beta(a: f64, b: f64) -> f64 {
    let (a, b) = if a <= b { (a, b) } else { (b, a) };
    if b < 10.0 {
        return ln_gamma(a) + ln_gamma(b) - ln_gamma(a + b);
    }
    // ln Γ(b) − ln Γ(a+b) by the Stirling form, without the cancellation of
    // two large logarithms: −(b−½) ln(1 + a/b) − a ln(a+b) + a + the series
    // corrections.
    ln_gamma(a) - (b - 0.5) * (a / b).ln_1p() - a * (a + b).ln() + a + stirling_correction(b)
        - stirling_correction(a + b)
}

/// The continued fraction of the incomplete beta function (Lentz).
fn beta_cf(a: f64, b: f64, x: f64) -> f64 {
    let tiny = 1e-300;
    let (qab, qap, qam) = (a + b, a + 1.0, a - 1.0);
    let mut c = 1.0;
    let mut d = 1.0 - qab * x / qap;
    if d.abs() < tiny {
        d = tiny;
    }
    d = 1.0 / d;
    let mut h = d;
    for m in 1..100_000 {
        let m = m as f64;
        let m2 = 2.0 * m;
        let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1.0 + aa * d;
        if d.abs() < tiny {
            d = tiny;
        }
        c = 1.0 + aa / c;
        if c.abs() < tiny {
            c = tiny;
        }
        d = 1.0 / d;
        h *= d * c;
        let aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1.0 + aa * d;
        if d.abs() < tiny {
            d = tiny;
        }
        c = 1.0 + aa / c;
        if c.abs() < tiny {
            c = tiny;
        }
        d = 1.0 / d;
        let del = d * c;
        h *= del;
        if (del - 1.0).abs() < 1e-16 {
            break;
        }
    }
    h
}

/// The regularised incomplete beta function, both tails:
/// `(I_x(a,b), 1 − I_x(a,b))` for `a, b > 0`, `0 <= x <= 1`. `y` is `1 − x`,
/// passed separately so a caller that has it exactly keeps the precision.
pub(crate) fn beta_i(a: f64, b: f64, x: f64, y: f64) -> (f64, f64) {
    if x <= 0.0 {
        return (0.0, 1.0);
    }
    if y <= 0.0 {
        return (1.0, 0.0);
    }
    // ln x and ln y from whichever of x, y is the accurate small one.
    let ln_x = if x < 0.5 { x.ln() } else { (-y).ln_1p() };
    let ln_y = if y < 0.5 { y.ln() } else { (-x).ln_1p() };
    let lbt = a * ln_x + b * ln_y - ln_beta(a, b);
    if x < (a + 1.0) / (a + b + 2.0) {
        let lo = ((lbt).exp() * beta_cf(a, b, x) / a).min(1.0);
        (lo, 1.0 - lo)
    } else if x < 0.1 && b * x <= 500.0 {
        // Near the mean of a very large b the continued fraction converges
        // slowly; the all-positive hypergeometric series
        // I_x(a,b) = x^a y^b / (a B(a,b)) · 2F1(a+b, 1; a+1; x)
        // (DLMF 8.17.8) does not.
        let mut term = 1.0;
        let mut sum = 1.0;
        let mut n = 0.0;
        while n < 1e6 {
            term *= (a + b + n) * x / (a + 1.0 + n);
            sum += term;
            if term <= sum * 1e-17 {
                break;
            }
            n += 1.0;
        }
        let lo = (lbt.exp() * sum / a).min(1.0);
        (lo, 1.0 - lo)
    } else {
        let hi = ((lbt).exp() * beta_cf(b, a, y) / b).min(1.0);
        (1.0 - hi, hi)
    }
}

/// Find `x` in `[lo, hi]` with `f(x) = 0`, `f(lo)` and `f(hi)` of opposite
/// signs (Brent's method: inverse quadratic interpolation, secant and
/// bisection steps), to a few ulps of `x`.
pub(crate) fn solve_bracketed(f: impl Fn(f64) -> f64, mut a: f64, mut b: f64) -> f64 {
    let mut fa = f(a);
    let mut fb = f(b);
    if fa == 0.0 {
        return a;
    }
    if fb == 0.0 {
        return b;
    }
    if fa.abs() < fb.abs() {
        std::mem::swap(&mut a, &mut b);
        std::mem::swap(&mut fa, &mut fb);
    }
    let mut c = a;
    let mut fc = fa;
    let mut mflag = true;
    let mut d = 0.0;
    for _ in 0..400 {
        if fb == 0.0 || (b - a).abs() <= 2.0 * f64::EPSILON * b.abs().max(1e-300) {
            return b;
        }
        let mut s = if fa != fc && fb != fc {
            a * fb * fc / ((fa - fb) * (fa - fc))
                + b * fa * fc / ((fb - fa) * (fb - fc))
                + c * fa * fb / ((fc - fa) * (fc - fb))
        } else {
            b - fb * (b - a) / (fb - fa)
        };
        let q = (3.0 * a + b) / 4.0;
        let between = if q < b {
            s > q && s < b
        } else {
            s > b && s < q
        };
        if !between
            || (mflag && (s - b).abs() >= (b - c).abs() / 2.0)
            || (!mflag && (s - b).abs() >= (c - d).abs() / 2.0)
            || (mflag && (b - c).abs() < 1e-300)
            || (!mflag && (c - d).abs() < 1e-300)
        {
            s = (a + b) / 2.0;
            mflag = true;
        } else {
            mflag = false;
        }
        let fs = f(s);
        d = c;
        c = b;
        fc = fb;
        if fa * fs < 0.0 {
            b = s;
            fb = fs;
        } else {
            a = s;
            fa = fs;
        }
        if fa.abs() < fb.abs() {
            std::mem::swap(&mut a, &mut b);
            std::mem::swap(&mut fa, &mut fb);
        }
    }
    b
}

/// Invert an increasing tail pair on `[0, ∞)` (or `[0, 1]` when `upper` is
/// 1): `tails(x) = (lower, upper)`; the target lower-tail probability `p`
/// (`q = 1 − p` given exactly). Solves on the smaller tail.
pub(crate) fn invert_tails(
    tails: impl Fn(f64) -> (f64, f64),
    p: f64,
    q: f64,
    bound: Option<f64>,
) -> f64 {
    let use_lower = p <= q;
    let g = |x: f64| {
        let (lo, hi) = tails(x);
        if use_lower {
            lo - p
        } else {
            q - hi
        }
    };
    let (lo, hi) = match bound {
        Some(b) => (0.0, b),
        None => {
            let mut hi = 1.0;
            let mut n = 0;
            while g(hi) < 0.0 && n < 2000 {
                hi *= 2.0;
                n += 1;
            }
            (0.0, hi)
        }
    };
    solve_bracketed(g, lo, hi)
}

/// Invert the regularised incomplete beta function: the `(z, 1 − z)` with
/// `I_z(a, b) = p` (`q = 1 − p` given exactly). The smaller of `z` and `1 − z`
/// is the variable solved for, so both keep their relative precision.
pub(crate) fn invert_beta(a: f64, b: f64, p: f64, q: f64) -> (f64, f64) {
    let lower = || invert_tails(|z| beta_i(a, b, z, 1.0 - z), p, q, Some(1.0));
    let upper = || invert_tails(|w| beta_i(b, a, w, 1.0 - w), q, p, Some(1.0));
    // Solve once on the tail of the smaller probability, then once more for
    // the complement variable when the root lies past the middle.
    if p <= q {
        let z = lower();
        if z <= 0.5 {
            (z, 1.0 - z)
        } else {
            let w = upper();
            (1.0 - w, w)
        }
    } else {
        let w = upper();
        if w <= 0.5 {
            (1.0 - w, w)
        } else {
            let z = lower();
            (z, 1.0 - z)
        }
    }
}

/// Loader's Stirling error `ln Γ(n+1) − (n+½) ln n + n − ln √(2π)`.
fn stirlerr(n: f64) -> f64 {
    if n <= 15.0 {
        if n == 0.0 {
            return 1.0 - LN_SQRT_2PI;
        }
        return ln_gamma(n + 1.0) - (n + 0.5) * n.ln() + n - LN_SQRT_2PI;
    }
    stirling_correction(n)
}

/// Loader's deviance term `x ln(x/np) + np − x`, accurate when `x ≈ np`.
fn bd0(x: f64, np: f64) -> f64 {
    if (x - np).abs() < 0.1 * (x + np) {
        let v = (x - np) / (x + np);
        let mut s = (x - np) * v;
        let mut ej = 2.0 * x * v;
        let v2 = v * v;
        for j in 1..1000 {
            ej *= v2;
            let s1 = s + ej / f64::from(2 * j + 1);
            if s1 == s {
                return s1;
            }
            s = s1;
        }
        return s;
    }
    x * (x / np).ln() + np - x
}

/// The binomial density `C(n,x) p^x q^(n−x)` (Loader), `q = 1 − p`.
pub(crate) fn dbinom_raw(x: f64, n: f64, p: f64, q: f64) -> f64 {
    if p == 0.0 {
        return if x == 0.0 { 1.0 } else { 0.0 };
    }
    if q == 0.0 {
        return if x == n { 1.0 } else { 0.0 };
    }
    if x == 0.0 {
        if n == 0.0 {
            return 1.0;
        }
        let lc = if p < 0.1 {
            -bd0(n, n * q) - n * p
        } else {
            n * q.ln()
        };
        return lc.exp();
    }
    if x == n {
        let lc = if q < 0.1 {
            -bd0(n, n * p) - n * q
        } else {
            n * p.ln()
        };
        return lc.exp();
    }
    if x < 0.0 || x > n {
        return 0.0;
    }
    let lc = stirlerr(n) - stirlerr(x) - stirlerr(n - x) - bd0(x, n * p) - bd0(n - x, n * q);
    let lf = (2.0 * std::f64::consts::PI).ln() + x.ln() + (-x / n).ln_1p();
    (lc - 0.5 * lf).exp()
}

/// The Poisson density `λ^x e^−λ / x!` (Loader).
pub(crate) fn dpois_raw(x: f64, lambda: f64) -> f64 {
    if lambda == 0.0 {
        return if x == 0.0 { 1.0 } else { 0.0 };
    }
    if x == 0.0 {
        return (-lambda).exp();
    }
    if x < 0.0 {
        return 0.0;
    }
    (-stirlerr(x) - bd0(x, lambda)).exp() / (2.0 * std::f64::consts::PI * x).sqrt()
}

#[cfg(test)]
mod dist_tests {
    use super::*;

    fn close(a: f64, b: f64, tol: f64) -> bool {
        a == b || (a - b).abs() <= tol * a.abs().max(b.abs())
    }

    #[test]
    fn ln_gamma_and_gamma_reference_values() {
        assert_eq!(ln_gamma(1.0), 0.0);
        assert_eq!(ln_gamma(2.0), 0.0);
        assert!(close(ln_gamma(0.5), 0.572_364_942_924_700_1, 1e-15));
        assert!(close(ln_gamma(1.1), -0.049_872_441_259_839_53, 1e-14));
        assert!(close(ln_gamma(1.9), -0.038_984_275_923_083_44, 1e-14));
        assert!(close(ln_gamma(0.1), 2.252_712_651_734_205_5, 1e-14));
        assert!(close(ln_gamma(100.0), 359.134_205_369_575_4, 1e-15));
        assert!(close(ln_gamma(4.0), 6f64.ln(), 1e-15));
        assert!(close(gamma(0.5), std::f64::consts::PI.sqrt(), 1e-15));
        assert!(close(gamma(2.5), 1.329_340_388_179_137, 1e-14));
        assert!(close(gamma(-0.5), -3.544_907_701_811_032, 1e-14));
        assert!(gamma(-2.0).is_nan());
    }

    #[test]
    fn incomplete_functions_reference_values() {
        // P(1, x) = 1 − e^−x; I_x(1, 1) = x; I_x(a, 1) = x^a.
        let (p, q) = gamma_p_q(1.0, 2.0);
        assert!(close(p, 1.0 - (-2.0f64).exp(), 1e-15));
        assert!(close(q, (-2.0f64).exp(), 1e-14));
        let (p, _) = gamma_p_q(50.0, 45.0);
        assert!(close(p, 0.246_802_034_400_170_27, 1e-14), "{p}");
        let (lo, hi) = beta_i(1.0, 1.0, 0.3, 0.7);
        assert!(close(lo, 0.3, 1e-15) && close(hi, 0.7, 1e-15));
        let (lo, _) = beta_i(3.0, 1.0, 0.5, 0.5);
        assert!(close(lo, 0.125, 1e-14));
    }

    #[test]
    fn densities_match_closed_forms() {
        assert!(close(
            dbinom_raw(6.0, 10.0, 0.5, 0.5),
            210.0 / 1024.0,
            1e-14
        ));
        assert!(close(dpois_raw(2.0, 5.0), 12.5 * (-5.0f64).exp(), 1e-14));
        let x = invert_tails(|x| gamma_p_q(2.0, x), 0.5, 0.5, None);
        assert!(close(gamma_p_q(2.0, x).0, 0.5, 1e-14));
    }
}
