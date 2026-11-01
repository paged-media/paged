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

//! The blend functions `B(Cb, Cs)`, on unpremultiplied colours in
//! `[0, 1]`.
//!
//! Moved from paged.image's `image_conformance::compose_ref` (which now
//! calls them) without a change to a branch or a constant: these are
//! the scalar goldens of the image module's `compose.*` WGSL, and its
//! Photoshop 2026 oracle cases measured the tie rules recorded on
//! [`b_color_burn`], [`b_hard_mix`], [`b_divide`] and [`COLOR_TIE`].

// ---------------------------------------------------------------------
// Separable — W3C Compositing and Blending Level 1, §9.
// ---------------------------------------------------------------------

/// W3C: `B(Cb, Cs) = Cs`.
pub fn b_normal(_cb: f32, cs: f32) -> f32 {
    cs
}

/// W3C "multiply": `B = Cb · Cs`.
pub fn b_multiply(cb: f32, cs: f32) -> f32 {
    cb * cs
}

/// W3C "screen": `B = Cb + Cs − Cb·Cs`.
pub fn b_screen(cb: f32, cs: f32) -> f32 {
    cb + cs - cb * cs
}

/// W3C "hard-light": multiply(Cb, 2·Cs) for Cs ≤ 0.5, else
/// screen(Cb, 2·Cs − 1).
pub fn b_hard_light(cb: f32, cs: f32) -> f32 {
    if cs <= 0.5 {
        b_multiply(cb, 2.0 * cs)
    } else {
        b_screen(cb, 2.0 * cs - 1.0)
    }
}

/// W3C "overlay": `HardLight(Cs, Cb)` (roles swapped).
pub fn b_overlay(cb: f32, cs: f32) -> f32 {
    b_hard_light(cs, cb)
}

/// W3C "darken": `min(Cb, Cs)`.
pub fn b_darken(cb: f32, cs: f32) -> f32 {
    cb.min(cs)
}

/// W3C "lighten": `max(Cb, Cs)`.
pub fn b_lighten(cb: f32, cs: f32) -> f32 {
    cb.max(cs)
}

/// W3C "color-dodge": Cb = 0 → 0; Cs = 1 → 1; else `min(1, Cb/(1 − Cs))`.
pub fn b_color_dodge(cb: f32, cs: f32) -> f32 {
    // The singular points as ranges, not equalities: an unpremultiplied
    // colour is a division and may land an ulp past 1 (a source "at
    // full" a hair over it on some GPUs), where `1 − Cs` turns negative
    // and the quotient with it. Photoshop's dodge by full brightness is
    // full brightness (image ADR 481).
    if cb <= 0.0 {
        0.0
    } else if cs >= 1.0 {
        1.0
    } else {
        1.0_f32.min(cb / (1.0 - cs))
    }
}

/// Colour burn: Cs = 0 → 0; Cb = 1 → 1; else `1 − min(1, (1 − Cb)/Cs)`.
/// W3C tests Cb = 1 first; Photoshop tests Cs = 0 first (white over a
/// black source is black), measured against Photoshop 2026 — the only
/// point where the two orders differ.
pub fn b_color_burn(cb: f32, cs: f32) -> f32 {
    // As the dodge: the singular points as ranges (a backdrop an ulp past
    // full would make `1 − Cb` negative).
    if cs <= 0.0 {
        0.0
    } else if cb >= 1.0 {
        1.0
    } else {
        1.0 - 1.0_f32.min((1.0 - cb) / cs)
    }
}

/// W3C "soft-light" (the Photoshop formula): for Cs ≤ 0.5
/// `Cb − (1 − 2·Cs)·Cb·(1 − Cb)`, else `Cb + (2·Cs − 1)·(D(Cb) − Cb)`
/// with `D(Cb) = ((16·Cb − 12)·Cb + 4)·Cb` for Cb ≤ 0.25, else √Cb.
pub fn b_soft_light(cb: f32, cs: f32) -> f32 {
    if cs <= 0.5 {
        cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb)
    } else {
        let d = if cb <= 0.25 {
            ((16.0 * cb - 12.0) * cb + 4.0) * cb
        } else {
            cb.sqrt()
        };
        cb + (2.0 * cs - 1.0) * (d - cb)
    }
}

/// W3C "difference": `|Cb − Cs|`.
pub fn b_difference(cb: f32, cs: f32) -> f32 {
    (cb - cs).abs()
}

/// W3C "exclusion": `Cb + Cs − 2·Cb·Cs`.
pub fn b_exclusion(cb: f32, cs: f32) -> f32 {
    cb + cs - 2.0 * cb * cs
}

// ---------------------------------------------------------------------
// Separable — Photoshop's modes beyond W3C Level 1.
// ---------------------------------------------------------------------

/// Linear burn: `max(Cb + Cs − 1, 0)`.
pub fn b_linear_burn(cb: f32, cs: f32) -> f32 {
    (cb + cs - 1.0).max(0.0)
}

/// Linear dodge (add): `min(Cb + Cs, 1)`.
pub fn b_linear_dodge(cb: f32, cs: f32) -> f32 {
    (cb + cs).min(1.0)
}

/// Vivid light: color_burn(Cb, 2·Cs) for Cs ≤ 0.5, else
/// color_dodge(Cb, 2·Cs − 1). Continuous at Cs = 0.5.
pub fn b_vivid_light(cb: f32, cs: f32) -> f32 {
    if cs <= 0.5 {
        b_color_burn(cb, 2.0 * cs)
    } else {
        b_color_dodge(cb, 2.0 * cs - 1.0)
    }
}

/// Linear light: linear burn below Cs = 0.5, linear dodge above, both
/// `clamp(Cb + 2·Cs − 1, 0, 1)`.
pub fn b_linear_light(cb: f32, cs: f32) -> f32 {
    (cb + 2.0 * cs - 1.0).clamp(0.0, 1.0)
}

/// Pin light: `min(Cb, 2·Cs)` for Cs ≤ 0.5, else `max(Cb, 2·Cs − 1)`.
pub fn b_pin_light(cb: f32, cs: f32) -> f32 {
    if cs <= 0.5 {
        cb.min(2.0 * cs)
    } else {
        cb.max(2.0 * cs - 1.0)
    }
}

/// Hard mix: 1 only when `Cb + Cs > 1` STRICTLY (the anti-diagonal is
/// black, measured against Photoshop 2026). The comparison allows half
/// an 8-bit step, so a sum that is 1 in 8-bit levels stays a tie after
/// f16 storage.
pub fn b_hard_mix(cb: f32, cs: f32) -> f32 {
    if cb + cs > 1.0 + 1.0 / 512.0 {
        1.0
    } else {
        0.0
    }
}

/// Subtract: `max(Cb − Cs, 0)`.
pub fn b_subtract(cb: f32, cs: f32) -> f32 {
    (cb - cs).max(0.0)
}

/// Divide: `min(Cb/Cs, 1)`; Cs = 0 → 1, except 0/0 → 0 (measured
/// against Photoshop 2026).
pub fn b_divide(cb: f32, cs: f32) -> f32 {
    if cs == 0.0 {
        if cb == 0.0 {
            0.0
        } else {
            1.0
        }
    } else {
        (cb / cs).min(1.0)
    }
}

// ---------------------------------------------------------------------
// Non-separable — W3C §10.3 pseudo-code, plus Photoshop's darker and
// lighter colour.
// ---------------------------------------------------------------------

/// W3C §10.3 `Lum(C) = 0.3·R + 0.59·G + 0.11·B`.
pub fn lum(c: [f32; 3]) -> f32 {
    0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
}

/// W3C §10.3 `ClipColor(C)`.
pub fn clip_color(mut c: [f32; 3]) -> [f32; 3] {
    let l = lum(c);
    let n = c[0].min(c[1]).min(c[2]);
    let x = c[0].max(c[1]).max(c[2]);
    // A FLAT colour out of range has no spread to scale: it clips to the
    // limit the formula tends to (0 or 1), not 0/0 (the WGSL lane alike).
    if n < 0.0 {
        if l > n {
            for ch in c.iter_mut() {
                *ch = l + (*ch - l) * l / (l - n);
            }
        } else {
            c = [0.0; 3];
        }
    }
    if x > 1.0 {
        if x > l {
            for ch in c.iter_mut() {
                *ch = l + (*ch - l) * (1.0 - l) / (x - l);
            }
        } else {
            c = [1.0; 3];
        }
    }
    c
}

/// W3C §10.3 `SetLum(C, l)`.
pub fn set_lum(c: [f32; 3], l: f32) -> [f32; 3] {
    let d = l - lum(c);
    clip_color([c[0] + d, c[1] + d, c[2] + d])
}

/// W3C §10.3 `Sat(C) = max − min`.
pub fn sat(c: [f32; 3]) -> f32 {
    c[0].max(c[1]).max(c[2]) - c[0].min(c[1]).min(c[2])
}

/// W3C §10.3 `SetSat(C, s)`, ranking the channels into distinct
/// min/mid/max indices with ties broken by index (the image module's
/// WGSL uses the identical ladder).
pub fn set_sat(c: [f32; 3], s: f32) -> [f32; 3] {
    let ge = |i: usize, j: usize| c[i] > c[j] || (c[i] == c[j] && i >= j);
    let imax = if ge(0, 1) && ge(0, 2) {
        0
    } else if ge(1, 0) && ge(1, 2) {
        1
    } else {
        2
    };
    let imin = if ge(1, 0) && ge(2, 0) {
        0
    } else if ge(0, 1) && ge(2, 1) {
        1
    } else {
        2
    };
    let imid = 3 - imax - imin;
    let mut out = [0.0f32; 3];
    let cmax = c[imax];
    let cmin = c[imin];
    if cmax > cmin {
        out[imid] = (c[imid] - cmin) * s / (cmax - cmin);
        out[imax] = s;
    } else {
        out[imid] = 0.0;
        out[imax] = 0.0;
    }
    out[imin] = 0.0;
    out
}

/// W3C "hue": `SetLum(SetSat(Cs, Sat(Cb)), Lum(Cb))`.
pub fn b_hue(cb: [f32; 3], cs: [f32; 3]) -> [f32; 3] {
    set_lum(set_sat(cs, sat(cb)), lum(cb))
}

/// W3C "saturation": `SetLum(SetSat(Cb, Sat(Cs)), Lum(Cb))`.
pub fn b_saturation(cb: [f32; 3], cs: [f32; 3]) -> [f32; 3] {
    set_lum(set_sat(cb, sat(cs)), lum(cb))
}

/// W3C "color": `SetLum(Cs, Lum(Cb))`.
pub fn b_color(cb: [f32; 3], cs: [f32; 3]) -> [f32; 3] {
    set_lum(cs, lum(cb))
}

/// W3C "luminosity": `SetLum(Cb, Lum(Cs))`.
pub fn b_luminosity(cb: [f32; 3], cs: [f32; 3]) -> [f32; 3] {
    set_lum(cb, lum(cs))
}

/// Luminosities closer than this are a TIE for darker/lighter colour,
/// and a tie keeps the backdrop: Photoshop 2026 keeps it at 0.0016
/// levels apart and takes the source at 0.02 (its 16-bit precision is
/// 1/32768).
pub const COLOR_TIE: f32 = 1.0 / 32768.0;

/// Darker color: the whole triple with the lower `Lum`; ties keep the
/// backdrop.
pub fn b_darker_color(cb: [f32; 3], cs: [f32; 3]) -> [f32; 3] {
    if lum(cs) < lum(cb) - COLOR_TIE {
        cs
    } else {
        cb
    }
}

/// Lighter color: the whole triple with the higher `Lum`; ties keep the
/// backdrop.
pub fn b_lighter_color(cb: [f32; 3], cs: [f32; 3]) -> [f32; 3] {
    if lum(cs) > lum(cb) + COLOR_TIE {
        cs
    } else {
        cb
    }
}
