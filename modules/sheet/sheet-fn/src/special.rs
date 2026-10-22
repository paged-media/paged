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
