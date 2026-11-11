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
//! Office's automatic series colours: the one table paged.sheet and
//! paged.slide (and paged.doc's charts, through slide's layout) paint a
//! series or a varied point with when the chart part names no paint for it.
//!
//! Measured in PowerPoint 16 for macOS (2026-11-11) on charts with no paint
//! on any series, `c:style 2` and no chart colour-style part, for 5 to 60
//! series: series `i` of `n` takes accent `i mod 6 + 1`; the series fall in
//! `T = n / 6 + 1` (integer division) evenly spaced tiers of that accent,
//! series `i` in tier `t = i / 6`. Tier `t` sits at `x = (2t + 1 − T) / (T + 1)`
//! on −1..1: below 0 a DrawingML `a:shade` (linear light), above 0 an
//! `a:tint`, of `1 − 0.7·|x|` in whole percent (the shade rounded down, the
//! tint rounded up), and the plain accent at 0. So five series are the
//! plain accents, but six are all shaded to 76 % (T = 2), and twelve are a
//! dark tier and the plain accents. PowerPoint draws Excel's chart engine,
//! so Excel's automatic colours follow the same rule.

/// How an automatic colour departs from its accent: DrawingML's colour
/// transform value in 1000ths of a percent (`76000` is 76 %).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variation {
    Plain,
    /// `a:shade`: toward black in linear light.
    Shade(i32),
    /// `a:tint`: toward white in linear light.
    Tint(i32),
}

impl Variation {
    /// The transform as DrawingML names it, with its value; `None` for the
    /// plain accent.
    pub fn transform(self) -> Option<(&'static str, i32)> {
        match self {
            Variation::Plain => None,
            Variation::Shade(v) => Some(("shade", v)),
            Variation::Tint(v) => Some(("tint", v)),
        }
    }
}

/// The automatic colour of series (or varied point) `i` of `n`: the accent
/// (0 = `accent1` … 5 = `accent6`) and its variation.
pub fn automatic(i: usize, n: usize) -> (usize, Variation) {
    let n = n.max(i + 1);
    let tiers = (n / 6 + 1) as i64;
    let tier = (i / 6) as i64;
    let a = 2 * tier + 1 - tiers;
    let accent = i % 6;
    if a == 0 {
        return (accent, Variation::Plain);
    }
    // 0.7·|x| in whole percent: 70·|a| / (T + 1), rounded up for a shade
    // (so the kept share rounds down) and down for a tint.
    let (num, den) = (70 * a.abs(), tiers + 1);
    if a < 0 {
        let off = (num + den - 1) / den;
        (accent, Variation::Shade(((100 - off) * 1000) as i32))
    } else {
        let off = num / den;
        (accent, Variation::Tint(((100 - off) * 1000) as i32))
    }
}

/// [`automatic`] applied to a theme's accent (sRGB `0xRRGGBB`).
pub fn automatic_rgb(accents: &[u32; 6], i: usize, n: usize) -> u32 {
    let (k, v) = automatic(i, n);
    let rgb = accents[k];
    let f: fn(f64, f64) -> f64 = match v {
        Variation::Plain => return rgb & 0xFF_FFFF,
        Variation::Shade(_) => paged_ooxml::colour::dml_shade,
        Variation::Tint(_) => paged_ooxml::colour::dml_tint,
    };
    let val = match v {
        Variation::Shade(x) | Variation::Tint(x) => x as f64 / 100_000.0,
        Variation::Plain => 1.0,
    };
    let c = |sh: u32| f(((rgb >> sh) & 0xFF) as f64 / 255.0, val);
    let q = |v: f64| (v * 255.0).round().clamp(0.0, 255.0) as u32;
    (q(c(16)) << 16) | (q(c(8)) << 8) | q(c(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tiers PowerPoint drew (shade or tint in whole percent).
    #[test]
    fn the_tiers_powerpoint_draws() {
        let tiers =
            |n: usize| -> Vec<Variation> { (0..n).step_by(6).map(|i| automatic(i, n).1).collect() };
        use Variation::*;
        assert_eq!(tiers(5), vec![Plain]);
        assert_eq!(tiers(6), vec![Shade(76000)]);
        assert_eq!(tiers(8), vec![Shade(76000), Tint(77000)]);
        assert_eq!(tiers(12), vec![Shade(65000), Plain]);
        assert_eq!(tiers(13), vec![Shade(65000), Plain, Tint(65000)]);
        assert_eq!(tiers(18), vec![Shade(58000), Shade(86000), Tint(86000)]);
        assert_eq!(
            tiers(42),
            vec![
                Shade(45000),
                Shade(61000),
                Shade(76000),
                Shade(92000),
                Tint(93000),
                Tint(77000),
                Tint(62000)
            ]
        );
        assert_eq!(
            tiers(60),
            vec![
                Shade(41000),
                Shade(53000),
                Shade(65000),
                Shade(76000),
                Shade(88000),
                Plain,
                Tint(89000),
                Tint(77000),
                Tint(65000),
                Tint(54000)
            ]
        );
    }

    /// The colours PowerPoint drew for the 2023 Office theme's accents.
    #[test]
    fn the_colours_powerpoint_draws() {
        let acc = [0x156082, 0xE97132, 0x196B24, 0x0F9ED5, 0xA02B93, 0x4EA72E];
        assert_eq!(automatic_rgb(&acc, 0, 6), 0x115472);
        assert_eq!(automatic_rgb(&acc, 1, 6), 0xCE632B);
        assert_eq!(automatic_rgb(&acc, 6, 8), 0x8599AA);
        assert_eq!(automatic_rgb(&acc, 0, 60), 0x0A3E55);
        assert_eq!(automatic_rgb(&acc, 54, 60), 0xB5BFC8);
        assert_eq!(automatic_rgb(&acc, 3, 4), 0x0F9ED5);
    }
}
