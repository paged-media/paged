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

//! MULTI-RESOLUTION PATCHMATCH INPAINTING — the engine behind Content-Aware
//! Fill, Content-Aware Move, the Remove tool and content-aware spot healing.
//!
//! # What it replaces, and why
//!
//! The first content-aware fill (`crate::inpaint`, Criminisi et al. 2004)
//! grew the hole inward patch by patch and searched a 96-px window around
//! each patch. That window was its stated limit: a hole whose best
//! material sat further away could not find it, and the single
//! deterministic order could not revise an early bad choice. This module
//! has neither limit.
//!
//! # The algorithm
//!
//! Wexler, Shechtman & Irani's completion (*Space-Time Completion of
//! Video*, IEEE TPAMI 2007) as an EM over a nearest-neighbour field (NNF),
//! with the field found by PatchMatch (Barnes, Shechtman, Finkelstein &
//! Goldman, *PatchMatch: A Randomized Correspondence Algorithm for
//! Structural Image Editing*, SIGGRAPH 2009) and its generalisation to
//! rotations, scales and reflections (Barnes et al., *The Generalized
//! PatchMatch Correspondence Algorithm*, ECCV 2010):
//!
//! ```text
//! for each pyramid level, coarse → fine:
//!     repeat (EM):
//!         SEARCH  for every target patch overlapping the hole, the source
//!                 patch in the sampling area minimising the patch
//!                 distance — propagation from the scan neighbours, then a
//!                 random search whose radius starts at the WHOLE level and
//!                 halves, then one global random restart
//!         VOTE    every hole pixel := the weighted mean of what each
//!                 overlapping target patch's match says it is
//!     upsample the field (offsets double) and vote the finer level
//! ```
//!
//! * **Unbounded.** The random search starts at the level's full extent,
//!   so any part of the sampling area can be found; the coarse levels see
//!   the large-scale structure and hand it down.
//! * **Deterministic.** Every random draw comes from one SplitMix64 stream
//!   seeded by [`FillOptions::seed`] and consumed in scan order, so the same
//!   input and seed give byte-identical output; a different seed is a
//!   different (equally valid) answer.
//! * **Adaptation.** A source patch may be rotated, scaled and mirrored
//!   within the ranges [`RotationAdaptation`], `scale` and `mirror` allow,
//!   and may carry a per-channel brightness bias up to the bound
//!   [`ColourAdaptation`] sets. `High` and `VeryHigh` also blend the fill's
//!   boundary in the gradient domain (the membrane solve of `crate::heal`
//!   over the mismatch between the original ring and the voted ring).
//! * **Only real pixels.** The search compares against, and the vote reads
//!   from, pixels of the sampling area — never the hole — so a fill is a
//!   (weighted) mix of copies, not an invented colour.
//!
//! # CPU search, GPU vote
//!
//! The search is sequential by construction (propagation reads the
//! neighbour updated a moment earlier) and stays on the CPU, like the
//! membrane solve and the histogram reductions: it is input preparation,
//! not a kernel path. The final full-resolution VOTE is a gather and is a
//! registered kernel, `geom.patch_vote`; [`Search::packed`] packs the field
//! for it and [`vote_packed`] is its CPU twin (same decode, same taps),
//! which the device parity test holds the kernel to. Without a device the
//! twin runs, so the fill works in a GPU-less realm too.

use image_core::Region;

/// Patch half-width: 7×7 patches (Wexler et al. use 7×7 throughout).
pub const RADIUS: i32 = 3;

/// The scale range a `scale`-adapting patch may take (log-symmetric).
const SCALE_MAX: f32 = 1.25;

/// Colour adaptation: how far a source patch's brightness may shift to
/// match its target (Photoshop's None / Default / High / Very High).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ColourAdaptation {
    None,
    #[default]
    Default,
    High,
    VeryHigh,
}

impl ColourAdaptation {
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "none" => Self::None,
            "default" => Self::Default,
            "high" => Self::High,
            "very-high" | "veryHigh" => Self::VeryHigh,
            _ => return None,
        })
    }

    /// The largest per-channel bias (working range 0–1) a patch may carry.
    pub fn bias_limit(self) -> f32 {
        match self {
            Self::None => 0.0,
            Self::Default => 0.04,
            Self::High => 0.10,
            Self::VeryHigh => 0.25,
        }
    }

    /// Strength of the gradient-domain boundary blend (0 = none).
    pub fn boundary_blend(self) -> f32 {
        match self {
            Self::None | Self::Default => 0.0,
            Self::High => 0.5,
            Self::VeryHigh => 1.0,
        }
    }
}

/// Rotation adaptation: how far a source patch may be rotated (None,
/// Low ±15°, Medium ±45°, High ±90°, Full ±180°).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RotationAdaptation {
    #[default]
    None,
    Low,
    Medium,
    High,
    Full,
}

impl RotationAdaptation {
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "none" => Self::None,
            "low" => Self::Low,
            "medium" => Self::Medium,
            "high" => Self::High,
            "full" => Self::Full,
            _ => return None,
        })
    }

    /// The largest rotation, in radians.
    pub fn max_angle(self) -> f32 {
        use std::f32::consts::PI;
        match self {
            Self::None => 0.0,
            Self::Low => PI / 12.0,
            Self::Medium => PI / 4.0,
            Self::High => PI / 2.0,
            Self::Full => PI,
        }
    }
}

/// Everything a fill is asked for besides the pixels and the masks.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FillOptions {
    pub colour: ColourAdaptation,
    pub rotation: RotationAdaptation,
    /// Allow source patches scaled within 0.8–1.25.
    pub scale: bool,
    /// Allow horizontally mirrored source patches.
    pub mirror: bool,
    /// The random stream's seed; the same seed gives the same fill.
    pub seed: u64,
}

impl Default for FillOptions {
    fn default() -> Self {
        Self {
            colour: ColourAdaptation::Default,
            rotation: RotationAdaptation::None,
            scale: false,
            mirror: false,
            seed: 0x5EED_CAFE,
        }
    }
}

impl FillOptions {
    fn transforms(&self) -> bool {
        self.rotation != RotationAdaptation::None || self.scale || self.mirror
    }
}

// ───────────────────────────── random ─────────────────────────────

/// SplitMix64 (Steele, Lea & Flood, *Fast Splittable Pseudorandom Number
/// Generators*, OOPSLA 2014): tiny, fast, and fully determined by its seed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in [0, 1).
    fn unit(&mut self) -> f32 {
        (self.next() >> 40) as f32 / (1u64 << 24) as f32
    }

    /// Uniform in [-1, 1).
    fn signed(&mut self) -> f32 {
        self.unit() * 2.0 - 1.0
    }

    fn below(&mut self, n: u32) -> u32 {
        (((self.next() >> 32) * u64::from(n)) >> 32) as u32
    }
}

// ───────────────────────────── field ──────────────────────────────

/// One NNF entry: where a target patch's best source patch sits (its
/// centre, in the level's pixels), how it is transformed, what it costs,
/// and the colour bias it carries.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Cand {
    sx: f32,
    sy: f32,
    angle: f32,
    scale: f32,
    mirror: bool,
    /// Mean squared error per pixel (all four channels), after the bias.
    cost: f32,
    bias: [f32; 3],
}

impl Cand {
    fn at(sx: f32, sy: f32) -> Self {
        Self {
            sx,
            sy,
            angle: 0.0,
            scale: 1.0,
            mirror: false,
            cost: f32::INFINITY,
            bias: [0.0; 3],
        }
    }

    fn identity(&self) -> bool {
        self.angle == 0.0 && self.scale == 1.0 && !self.mirror
    }

    /// The patch transform `M = R(angle) · S(scale) · F(mirror)`, row-major:
    /// a target offset `d` reads the source at `centre + M·d`.
    fn matrix(&self) -> [f32; 4] {
        if self.identity() {
            return [1.0, 0.0, 0.0, 1.0];
        }
        let (s, c) = self.angle.sin_cos();
        let k = self.scale;
        let mx = if self.mirror { -1.0 } else { 1.0 };
        [k * c * mx, -k * s, k * s * mx, k * c]
    }
}

fn apply(m: &[f32; 4], dx: f32, dy: f32) -> (f32, f32) {
    (m[0] * dx + m[1] * dy, m[2] * dx + m[3] * dy)
}

// ───────────────────────────── levels ─────────────────────────────

/// One pyramid level over the fill's DOMAIN (a crop of the canvas).
struct Level {
    w: i32,
    h: i32,
    /// Straight RGBA8; hole pixels hold whatever was there (never read as
    /// source, and as target only through `est`).
    px: Vec<u8>,
    hole: Vec<u8>,
    /// Non-zero where a source patch may be CENTRED: its whole (enlarged)
    /// window lies in the sampling area, inside the level, off the hole.
    ok: Vec<u8>,
    /// Bounding box of `ok` (for global random draws), if any.
    ok_box: Option<(i32, i32, i32, i32)>,
}

impl Level {
    fn idx(&self, x: i32, y: i32) -> usize {
        (y * self.w + x) as usize
    }

    fn px4(&self, i: usize) -> [f32; 4] {
        let p = &self.px[i * 4..i * 4 + 4];
        [
            f32::from(p[0]) / 255.0,
            f32::from(p[1]) / 255.0,
            f32::from(p[2]) / 255.0,
            f32::from(p[3]) / 255.0,
        ]
    }

    /// A source sample at a real position: exact at integer positions,
    /// bilinear (clamped) otherwise.
    fn sample(&self, x: f32, y: f32) -> [f32; 4] {
        let fx = x.floor();
        let fy = y.floor();
        let (tx, ty) = (x - fx, y - fy);
        let (ix, iy) = (fx as i32, fy as i32);
        let tap = |xx: i32, yy: i32| {
            let cx = xx.clamp(0, self.w - 1);
            let cy = yy.clamp(0, self.h - 1);
            self.px4(self.idx(cx, cy))
        };
        if tx == 0.0 && ty == 0.0 {
            return tap(ix, iy);
        }
        let p00 = tap(ix, iy);
        let p10 = tap(ix + 1, iy);
        let p01 = tap(ix, iy + 1);
        let p11 = tap(ix + 1, iy + 1);
        let mut o = [0f32; 4];
        for c in 0..4 {
            let top = p00[c] + (p10[c] - p00[c]) * tx;
            let bot = p01[c] + (p11[c] - p01[c]) * tx;
            o[c] = top + (bot - top) * ty;
        }
        o
    }

    fn valid(&self, c: &Cand) -> bool {
        let (x, y) = (c.sx.round() as i32, c.sy.round() as i32);
        x >= 0 && y >= 0 && x < self.w && y < self.h && self.ok[self.idx(x, y)] != 0
    }
}

/// Erode `valid` (non-zero = allowed) by a `(2r+1)²` square: a pixel
/// survives only if its whole window is allowed and inside the image.
fn erode(valid: &[u8], w: i32, h: i32, r: i32) -> Vec<u8> {
    let (wu, hu) = (w as usize, h as usize);
    let mut horiz = vec![0u8; wu * hu];
    let mut run = vec![0i32; wu];
    for y in 0..hu {
        // run[x] = length of the allowed run ending at x.
        let mut n = 0i32;
        for x in 0..wu {
            n = if valid[y * wu + x] != 0 { n + 1 } else { 0 };
            run[x] = n;
        }
        for x in 0..w {
            let right = x + r;
            if x - r < 0 || right >= w {
                continue;
            }
            if run[right as usize] > 2 * r {
                horiz[y * wu + x as usize] = 1;
            }
        }
    }
    let mut out = vec![0u8; wu * hu];
    for x in 0..wu {
        let mut n = 0i32;
        let mut col = vec![0i32; hu];
        for y in 0..hu {
            n = if horiz[y * wu + x] != 0 { n + 1 } else { 0 };
            col[y] = n;
        }
        for y in 0..h {
            let bottom = y + r;
            if y - r < 0 || bottom >= h {
                continue;
            }
            if col[bottom as usize] > 2 * r {
                out[y as usize * wu + x] = 1;
            }
        }
    }
    out
}

fn bbox_of(mask: &[u8], w: i32, h: i32) -> Option<(i32, i32, i32, i32)> {
    let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for y in 0..h {
        for x in 0..w {
            if mask[(y * w + x) as usize] != 0 {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    (x1 >= x0).then_some((x0, y0, x1, y1))
}

/// A level before its source-validity map: pixels, hole, sampling area,
/// width, height.
type RawLevel = (Vec<u8>, Vec<u8>, Vec<u8>, i32, i32);

/// Halve a level: colour from the KNOWN pixels of each 2×2 block (a block
/// that is all hole keeps a plain mean — it is never read as source); a
/// coarse pixel is hole when ANY of its four is (the safe direction), and
/// sampling area only when ALL four are.
fn halve(px: &[u8], hole: &[u8], sample: &[u8], w: i32, h: i32) -> RawLevel {
    let (cw, ch) = (w / 2, h / 2);
    let n = (cw * ch) as usize;
    let mut cpx = vec![0u8; n * 4];
    let mut chole = vec![0u8; n];
    let mut csample = vec![0u8; n];
    for y in 0..ch {
        for x in 0..cw {
            let mut sum = [0u32; 4];
            let mut all = [0u32; 4];
            let mut known = 0u32;
            let mut any_hole = false;
            let mut all_sample = true;
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let i = ((y * 2 + dy) * w + x * 2 + dx) as usize;
                let is_hole = hole[i] != 0;
                any_hole |= is_hole;
                all_sample &= sample[i] != 0;
                for c in 0..4 {
                    all[c] += u32::from(px[i * 4 + c]);
                    if !is_hole {
                        sum[c] += u32::from(px[i * 4 + c]);
                    }
                }
                if !is_hole {
                    known += 1;
                }
            }
            let o = (y * cw + x) as usize;
            for c in 0..4 {
                cpx[o * 4 + c] = if let Some(v) = (sum[c] + known / 2).checked_div(known) {
                    v as u8
                } else {
                    ((all[c] + 2) / 4) as u8
                };
            }
            chole[o] = u8::from(any_hole);
            csample[o] = u8::from(all_sample && !any_hole);
        }
    }
    (cpx, chole, csample, cw, ch)
}

// ──────────────────────────── the solver ──────────────────────────

/// The working state at one level: the work rectangle (the hole's box
/// grown by the radius), the target patch centres in scan order, their
/// field entries, and the current estimate of the hole's pixels.
struct Work {
    /// Work rectangle in level pixels: x0, y0, width, height.
    x0: i32,
    y0: i32,
    ww: i32,
    wh: i32,
    targets: Vec<(i32, i32)>,
    /// Over the work rect: index into `targets`, or -1.
    tidx: Vec<i32>,
    nnf: Vec<Cand>,
    /// Over the work rect: the hole's current estimate (straight RGBA,
    /// 0–1); meaningful only at hole pixels.
    est: Vec<[f32; 4]>,
}

impl Work {
    fn new(l: &Level, r: i32) -> Option<Work> {
        let (hx0, hy0, hx1, hy1) = bbox_of(&l.hole, l.w, l.h)?;
        let x0 = (hx0 - r).max(0);
        let y0 = (hy0 - r).max(0);
        let x1 = (hx1 + r).min(l.w - 1);
        let y1 = (hy1 + r).min(l.h - 1);
        let (ww, wh) = (x1 - x0 + 1, y1 - y0 + 1);
        // A target is any centre whose patch touches the hole: the hole
        // dilated by r, inside the work rect.
        let mut near = vec![0u8; (ww * wh) as usize];
        for y in hy0..=hy1 {
            for x in hx0..=hx1 {
                if l.hole[l.idx(x, y)] == 0 {
                    continue;
                }
                for yy in (y - r).max(y0)..=(y + r).min(y1) {
                    for xx in (x - r).max(x0)..=(x + r).min(x1) {
                        near[((yy - y0) * ww + (xx - x0)) as usize] = 1;
                    }
                }
            }
        }
        let mut targets = Vec::new();
        let mut tidx = vec![-1i32; (ww * wh) as usize];
        for y in 0..wh {
            for x in 0..ww {
                let i = (y * ww + x) as usize;
                if near[i] != 0 {
                    tidx[i] = targets.len() as i32;
                    targets.push((x0 + x, y0 + y));
                }
            }
        }
        let mut est = vec![[0f32; 4]; (ww * wh) as usize];
        for y in 0..wh {
            for x in 0..ww {
                est[(y * ww + x) as usize] = l.px4(l.idx(x0 + x, y0 + y));
            }
        }
        Some(Work {
            x0,
            y0,
            ww,
            wh,
            nnf: vec![Cand::at(0.0, 0.0); targets.len()],
            targets,
            tidx,
            est,
        })
    }

    fn tid(&self, x: i32, y: i32) -> Option<usize> {
        let (lx, ly) = (x - self.x0, y - self.y0);
        if lx < 0 || ly < 0 || lx >= self.ww || ly >= self.wh {
            return None;
        }
        let t = self.tidx[(ly * self.ww + lx) as usize];
        (t >= 0).then_some(t as usize)
    }

    fn widx(&self, x: i32, y: i32) -> usize {
        ((y - self.y0) * self.ww + (x - self.x0)) as usize
    }

    /// The TARGET's value at a level pixel: the estimate in the hole, the
    /// pixel itself elsewhere.
    fn target(&self, l: &Level, x: i32, y: i32) -> [f32; 4] {
        let i = l.idx(x, y);
        if l.hole[i] != 0 {
            self.est[self.widx(x, y)]
        } else {
            l.px4(i)
        }
    }
}

struct Solver<'a> {
    l: &'a Level,
    r: i32,
    opts: FillOptions,
    rng: Rng,
    max_angle: f32,
    log_scale: f32,
}

impl Solver<'_> {
    /// Score `c` as the match of the target patch centred at `(qx, qy)`,
    /// giving up once it cannot beat `beat`. Fills `c.cost` / `c.bias`.
    fn score(&self, wk: &Work, qx: i32, qy: i32, c: &mut Cand, beat: f32) -> bool {
        let l = self.l;
        let r = self.r;
        let m = c.matrix();
        let ident = c.identity() && c.sx.fract() == 0.0 && c.sy.fract() == 0.0;
        let limit = self.opts.colour.bias_limit();
        let mut sum_d = [0f32; 3];
        let mut sum_d2 = [0f32; 4];
        let mut n = 0f32;
        // Expected terms, for the early exit (only sound without a bias,
        // whose closed form needs the whole patch).
        let mut expected = 0f32;
        for dy in -r..=r {
            for dx in -r..=r {
                let (tx, ty) = (qx + dx, qy + dy);
                if tx >= 0 && ty >= 0 && tx < l.w && ty < l.h {
                    expected += 1.0;
                }
            }
        }
        if expected == 0.0 {
            return false;
        }
        let bound = beat * expected;
        for dy in -r..=r {
            for dx in -r..=r {
                let (tx, ty) = (qx + dx, qy + dy);
                if tx < 0 || ty < 0 || tx >= l.w || ty >= l.h {
                    continue;
                }
                let t = wk.target(l, tx, ty);
                let s = if ident {
                    l.px4(l.idx(c.sx as i32 + dx, c.sy as i32 + dy))
                } else {
                    let (ox, oy) = apply(&m, dx as f32, dy as f32);
                    l.sample(c.sx + ox, c.sy + oy)
                };
                for ch in 0..4 {
                    let d = t[ch] - s[ch];
                    if ch < 3 {
                        sum_d[ch] += d;
                    }
                    sum_d2[ch] += d * d;
                }
                n += 1.0;
                if limit == 0.0 && sum_d2.iter().sum::<f32>() >= bound {
                    return false;
                }
            }
        }
        let mut total = sum_d2[3];
        let mut bias = [0f32; 3];
        for ch in 0..3 {
            let b = (sum_d[ch] / n).clamp(-limit, limit);
            bias[ch] = b;
            // Σ(d − b)² = Σd² − 2bΣd + n b²
            total += sum_d2[ch] - 2.0 * b * sum_d[ch] + n * b * b;
        }
        let cost = (total / n).max(0.0);
        if cost >= beat {
            return false;
        }
        c.cost = cost;
        c.bias = bias;
        true
    }

    fn try_cand(&self, wk: &Work, qx: i32, qy: i32, best: &mut Cand, mut c: Cand) {
        if !self.l.valid(&c) {
            return;
        }
        if self.score(wk, qx, qy, &mut c, best.cost) {
            *best = c;
        }
    }

    /// A random source centre anywhere in the sampling area, with a random
    /// transform in range. `None` after a bounded number of misses.
    fn random_cand(&mut self) -> Option<Cand> {
        let (x0, y0, x1, y1) = self.l.ok_box?;
        for _ in 0..32 {
            let x = x0 + self.rng.below((x1 - x0 + 1) as u32) as i32;
            let y = y0 + self.rng.below((y1 - y0 + 1) as u32) as i32;
            if self.l.ok[self.l.idx(x, y)] == 0 {
                continue;
            }
            let mut c = Cand::at(x as f32, y as f32);
            if self.max_angle > 0.0 {
                c.angle = self.rng.signed() * self.max_angle;
            }
            if self.log_scale > 0.0 {
                c.scale = (self.rng.signed() * self.log_scale).exp();
            }
            if self.opts.mirror {
                c.mirror = self.rng.unit() < 0.5;
            }
            return Some(c);
        }
        None
    }

    /// One PatchMatch sweep over every target, forward or backward.
    fn sweep(&mut self, wk: &mut Work, forward: bool) {
        let n = wk.targets.len();
        let step: i32 = if forward { 1 } else { -1 };
        let rmax = self.l.w.max(self.l.h) as f32;
        for k in 0..n {
            let i = if forward { k } else { n - 1 - k };
            let (qx, qy) = wk.targets[i];
            let mut best = wk.nnf[i];
            // PROPAGATION: the scan neighbours' matches, shifted by the
            // step under their own transforms.
            for (ox, oy) in [(-step, 0), (0, -step)] {
                if let Some(j) = wk.tid(qx + ox, qy + oy) {
                    let nb = wk.nnf[j];
                    let m = nb.matrix();
                    let (sx, sy) = apply(&m, -ox as f32, -oy as f32);
                    let mut c = nb;
                    c.sx += sx;
                    c.sy += sy;
                    self.try_cand(wk, qx, qy, &mut best, c);
                }
            }
            // RANDOM SEARCH: from the whole level down to one pixel.
            let mut radius = rmax;
            while radius >= 1.0 {
                let frac = radius / rmax;
                let mut c = best;
                c.sx = (best.sx + self.rng.signed() * radius).round();
                c.sy = (best.sy + self.rng.signed() * radius).round();
                if self.max_angle > 0.0 {
                    c.angle = (best.angle + self.rng.signed() * self.max_angle * frac)
                        .clamp(-self.max_angle, self.max_angle);
                }
                if self.log_scale > 0.0 {
                    let ls = (best.scale.ln() + self.rng.signed() * self.log_scale * frac)
                        .clamp(-self.log_scale, self.log_scale);
                    c.scale = ls.exp();
                }
                if self.opts.mirror && radius == rmax {
                    c.mirror = self.rng.unit() < 0.5;
                }
                self.try_cand(wk, qx, qy, &mut best, c);
                radius *= 0.5;
            }
            // GLOBAL RESTART: one fresh draw from the whole sampling area.
            if let Some(c) = self.random_cand() {
                self.try_cand(wk, qx, qy, &mut best, c);
            }
            wk.nnf[i] = best;
        }
    }

    /// Re-score every entry against the current estimate (after a vote or
    /// an upsample changed what the targets look like).
    fn rescore(&self, wk: &mut Work) {
        for i in 0..wk.targets.len() {
            let (qx, qy) = wk.targets[i];
            let mut c = wk.nnf[i];
            c.cost = f32::INFINITY;
            if self.score(wk, qx, qy, &mut c, f32::INFINITY) {
                wk.nnf[i] = c;
            } else {
                wk.nnf[i].cost = f32::INFINITY;
            }
        }
    }
}

/// Vote weights (Wexler et al. §3.2): `exp(−cost / 2σ²)` with σ² the 75th
/// percentile of the level's costs, floored so f16 can carry them.
fn weights(nnf: &[Cand]) -> Vec<f32> {
    let mut costs: Vec<f32> = nnf
        .iter()
        .map(|c| c.cost)
        .filter(|c| c.is_finite())
        .collect();
    if costs.is_empty() {
        return vec![1.0; nnf.len()];
    }
    costs.sort_by(f32::total_cmp);
    let sigma2 = costs[(costs.len() * 3) / 4].max(1e-5);
    nnf.iter()
        .map(|c| {
            if c.cost.is_finite() {
                (-c.cost / (2.0 * sigma2)).exp().max(1e-3)
            } else {
                1e-3
            }
        })
        .collect()
}

/// The vote at one pixel: the weighted mean of what every overlapping
/// target says it is. `None` when no target reaches it.
fn vote_at(l: &Level, wk: &Work, w: &[f32], x: i32, y: i32, r: i32) -> Option<[f32; 4]> {
    let mut acc = [0f32; 4];
    let mut wsum = 0f32;
    for dy in -r..=r {
        for dx in -r..=r {
            let (qx, qy) = (x + dx, y + dy);
            let Some(j) = wk.tid(qx, qy) else { continue };
            let e = &wk.nnf[j];
            let m = e.matrix();
            let (ox, oy) = apply(&m, -dx as f32, -dy as f32);
            let s = l.sample(e.sx + ox, e.sy + oy);
            let wt = w[j];
            for c in 0..3 {
                acc[c] += wt * (s[c] + e.bias[c]);
            }
            acc[3] += wt * s[3];
            wsum += wt;
        }
    }
    (wsum > 0.0).then(|| [acc[0] / wsum, acc[1] / wsum, acc[2] / wsum, acc[3] / wsum])
}

fn vote(l: &Level, wk: &mut Work, r: i32) {
    let w = weights(&wk.nnf);
    let mut next = wk.est.clone();
    for y in wk.y0..wk.y0 + wk.wh {
        for x in wk.x0..wk.x0 + wk.ww {
            if l.hole[l.idx(x, y)] == 0 {
                continue;
            }
            if let Some(v) = vote_at(l, wk, &w, x, y, r) {
                next[wk.widx(x, y)] = v;
            }
        }
    }
    wk.est = next;
}

/// The coarsest level's starting estimate: onion-peel the hole, each pass
/// giving every hole pixel next to a known one the mean of its known
/// neighbours.
fn onion_fill(l: &Level, wk: &mut Work) {
    let mut known: Vec<bool> = (0..wk.ww * wk.wh)
        .map(|i| {
            let (x, y) = (wk.x0 + i % wk.ww, wk.y0 + i / wk.ww);
            l.hole[l.idx(x, y)] == 0
        })
        .collect();
    let mut remaining = known.iter().filter(|k| !**k).count();
    let mut guard = (wk.ww + wk.wh) as usize * 2 + 4;
    while remaining > 0 && guard > 0 {
        guard -= 1;
        let mut fill = Vec::new();
        for y in 0..wk.wh {
            for x in 0..wk.ww {
                let i = (y * wk.ww + x) as usize;
                if known[i] {
                    continue;
                }
                let mut sum = [0f32; 4];
                let mut n = 0f32;
                for (dx, dy) in [
                    (1, 0),
                    (-1, 0),
                    (0, 1),
                    (0, -1),
                    (1, 1),
                    (-1, -1),
                    (1, -1),
                    (-1, 1),
                ] {
                    let (nx, ny) = (x + dx, y + dy);
                    if nx < 0 || ny < 0 || nx >= wk.ww || ny >= wk.wh {
                        continue;
                    }
                    let j = (ny * wk.ww + nx) as usize;
                    if known[j] {
                        for (acc, v) in sum.iter_mut().zip(wk.est[j]) {
                            *acc += v;
                        }
                        n += 1.0;
                    }
                }
                if n > 0.0 {
                    fill.push((i, [sum[0] / n, sum[1] / n, sum[2] / n, sum[3] / n]));
                }
            }
        }
        if fill.is_empty() {
            break;
        }
        for (i, v) in fill {
            wk.est[i] = v;
            known[i] = true;
            remaining -= 1;
        }
    }
}

// ───────────────────────────── search ─────────────────────────────

/// A finished search: the domain it ran over and the full-resolution field
/// (pre-vote), ready to be voted on the CPU ([`Search::vote_cpu`]) or on
/// the device (`geom.patch_vote` over [`Search::packed`]).
pub struct Search {
    /// The domain (a crop of the canvas) the fill ran over.
    pub domain: Region,
    base: Level,
    work: Work,
    weights: Vec<f32>,
    radius: i32,
    colour: ColourAdaptation,
}

/// Run the search. `rgba` is canvas-extent straight RGBA8; `hole` and
/// `sample` are one byte per pixel (non-zero = in). The sampling area
/// never includes the hole, whatever `sample` says. Returns `None` when
/// there is nothing to fill or nothing to fill FROM.
pub fn search(
    rgba: &[u8],
    width: u32,
    height: u32,
    hole: &[u8],
    sample: &[u8],
    opts: &FillOptions,
) -> Option<Search> {
    let (w, h) = (width as i32, height as i32);
    let n = (width as usize) * (height as usize);
    if n == 0 || rgba.len() < n * 4 || hole.len() < n || sample.len() < n {
        return None;
    }
    let r = RADIUS;
    // The DOMAIN: everything the fill can touch or read, grown by a margin
    // so a patch at its rim is whole.
    let mut union = vec![0u8; n];
    for i in 0..n {
        union[i] = u8::from(hole[i] != 0 || sample[i] != 0);
    }
    let (ux0, uy0, ux1, uy1) = bbox_of(&union, w, h)?;
    let pad = r * 3 + 2;
    let dx0 = (ux0 - pad).max(0);
    let dy0 = (uy0 - pad).max(0);
    let dx1 = (ux1 + pad).min(w - 1);
    let dy1 = (uy1 + pad).min(h - 1);
    let (dw, dh) = (dx1 - dx0 + 1, dy1 - dy0 + 1);
    let mut px = Vec::with_capacity((dw * dh) as usize * 4);
    let mut dhole = Vec::with_capacity((dw * dh) as usize);
    let mut dsample = Vec::with_capacity((dw * dh) as usize);
    for y in dy0..=dy1 {
        let row = (y * w) as usize;
        px.extend_from_slice(&rgba[(row + dx0 as usize) * 4..(row + dx1 as usize + 1) * 4]);
        for x in dx0..=dx1 {
            let i = row + x as usize;
            dhole.push(u8::from(hole[i] != 0));
            dsample.push(u8::from(sample[i] != 0 && hole[i] == 0));
        }
    }
    if !dhole.iter().any(|&b| b != 0) || !dsample.iter().any(|&b| b != 0) {
        return None;
    }

    // THE PYRAMID: halve while the hole is still wider than a patch and
    // the level can still hold one.
    let mut raw: Vec<RawLevel> = vec![(px, dhole, dsample, dw, dh)];
    loop {
        let (lpx, lh, ls, lw, lhh) = raw.last().expect("a level");
        let (hx0, hy0, hx1, hy1) = bbox_of(lh, *lw, *lhh)?;
        let extent = (hx1 - hx0 + 1).max(hy1 - hy0 + 1);
        if extent <= 2 * r + 1 || lw / 2 < 4 * r + 4 || lhh / 2 < 4 * r + 4 || raw.len() >= 10 {
            break;
        }
        let next = halve(lpx, lh, ls, *lw, *lhh);
        if !next.2.iter().any(|&b| b != 0) {
            break;
        }
        raw.push(next);
    }

    let transforms = opts.transforms();
    let max_angle = opts.rotation.max_angle();
    let log_scale = if opts.scale { SCALE_MAX.ln() } else { 0.0 };
    // A transformed patch reaches further than its radius; the centre's
    // window is checked at that reach (+1 for the bilinear footprint).
    let reach = if transforms {
        ((r as f32) * if opts.scale { SCALE_MAX } else { 1.0 } * std::f32::consts::SQRT_2).ceil()
            as i32
            + 1
    } else {
        r
    };
    let levels: Vec<Level> = raw
        .into_iter()
        .map(|(px, hole, sample, lw, lh)| {
            let ok = erode(&sample, lw, lh, reach);
            let ok_box = bbox_of(&ok, lw, lh);
            Level {
                w: lw,
                h: lh,
                px,
                hole,
                ok,
                ok_box,
            }
        })
        .collect();
    // A coarse level whose sampling area cannot hold one whole patch has
    // nothing to say; the pyramid starts below it.
    let mut levels = levels;
    while levels.len() > 1 && levels.last().is_some_and(|l| l.ok_box.is_none()) {
        levels.pop();
    }
    levels[0].ok_box?;
    let top = levels.len() - 1;

    let mut prev: Option<(Work, usize)> = None;
    let mut out: Option<Work> = None;
    for li in (0..=top).rev() {
        let l = &levels[li];
        let mut solver = Solver {
            l,
            r,
            opts: *opts,
            rng: Rng(opts.seed ^ (li as u64).wrapping_mul(0xA24B_AED4_963E_E407)),
            max_angle,
            log_scale,
        };
        let Some(mut wk) = Work::new(l, r) else {
            continue;
        };
        match prev.take() {
            None => {
                onion_fill(l, &mut wk);
                for i in 0..wk.targets.len() {
                    let (qx, qy) = wk.targets[i];
                    let mut best = Cand::at(0.0, 0.0);
                    for _ in 0..4 {
                        if let Some(c) = solver.random_cand() {
                            solver.try_cand(&wk, qx, qy, &mut best, c);
                        }
                    }
                    if !best.cost.is_finite() {
                        if let Some(c) = solver.random_cand() {
                            best = c;
                        }
                    }
                    wk.nnf[i] = best;
                }
            }
            Some((coarse, ci)) => {
                let cl = &levels[ci];
                // UPSAMPLE: each target inherits its parent's match, the
                // offset doubled and shifted by the child's position under
                // the parent's transform.
                for i in 0..wk.targets.len() {
                    let (qx, qy) = wk.targets[i];
                    let (px, py) = ((qx / 2).min(cl.w - 1), (qy / 2).min(cl.h - 1));
                    let parent = coarse
                        .tid(px, py)
                        .or_else(|| nearest_target(&coarse, px, py))
                        .map(|j| coarse.nnf[j]);
                    let mut c = match parent {
                        Some(p) => {
                            let m = p.matrix();
                            let (ox, oy) = apply(&m, (qx - 2 * px) as f32, (qy - 2 * py) as f32);
                            let mut c = p;
                            c.sx = p.sx * 2.0 + ox;
                            c.sy = p.sy * 2.0 + oy;
                            if c.identity() {
                                c.sx = c.sx.round();
                                c.sy = c.sy.round();
                            }
                            c
                        }
                        None => Cand::at(-1.0, -1.0),
                    };
                    if !l.valid(&c) {
                        c = solver.random_cand().unwrap_or(c);
                    }
                    c.cost = 1.0;
                    wk.nnf[i] = c;
                }
                // The finer estimate is the vote of the inherited field.
                let uniform = vec![1.0f32; wk.nnf.len()];
                let mut next = wk.est.clone();
                for y in wk.y0..wk.y0 + wk.wh {
                    for x in wk.x0..wk.x0 + wk.ww {
                        if l.hole[l.idx(x, y)] == 0 {
                            continue;
                        }
                        if let Some(v) = vote_at(l, &wk, &uniform, x, y, r) {
                            next[wk.widx(x, y)] = v;
                        }
                    }
                }
                wk.est = next;
                solver.rescore(&mut wk);
            }
        }
        // EM: coarse levels decide structure and iterate more; the finest
        // only refines texture.
        let (em, pm) = if li == 0 {
            (2, 2)
        } else if li == top {
            (5, 4)
        } else {
            (3, 3)
        };
        for e in 0..em {
            for p in 0..pm {
                solver.sweep(&mut wk, (e * pm + p) % 2 == 0);
            }
            let last = li == 0 && e + 1 == em;
            if !last {
                vote(l, &mut wk, r);
                solver.rescore(&mut wk);
            }
        }
        if li == 0 {
            out = Some(wk);
        } else {
            prev = Some((wk, li));
        }
    }
    let work = out?;
    let weights = weights(&work.nnf);
    let base = levels.into_iter().next().expect("level 0");
    Some(Search {
        domain: Region::new(dx0, dy0, dw as u32, dh as u32),
        base,
        work,
        weights,
        radius: r,
        colour: opts.colour,
    })
}

fn nearest_target(wk: &Work, x: i32, y: i32) -> Option<usize> {
    for d in 1..=4 {
        for dy in -d..=d {
            for dx in -d..=d {
                if let Some(j) = wk.tid(x + dx, y + dy) {
                    return Some(j);
                }
            }
        }
    }
    None
}

/// The field packed for `geom.patch_vote`, plus everything the dispatch
/// needs: the source window (the domain) and the output box.
pub struct PackedVote {
    /// The domain as rgba16float (straight, as the CPU twin reads it).
    pub source_f16: Vec<u8>,
    pub source_w: u32,
    pub source_h: u32,
    /// Three texels per entry over the output box grown by the radius.
    pub nnf_f16: Vec<u8>,
    pub nnf_w: u32,
    pub nnf_h: u32,
    /// The hole over the output box, r16float.
    pub mask_f16: Vec<u8>,
    /// The output box, in DOMAIN pixels.
    pub out: Region,
    pub radius: u32,
}

fn f16b(v: f32) -> [u8; 2] {
    half::f16::from_f32(v).to_le_bytes()
}

impl Search {
    /// The work rectangle (hole box grown by the radius) in DOMAIN pixels —
    /// the vote's output box.
    pub fn out_box(&self) -> Region {
        Region::new(
            self.work.x0,
            self.work.y0,
            self.work.ww as u32,
            self.work.wh as u32,
        )
    }

    /// Pack the field for the device vote. `None` when it does not fit the
    /// kernel's addressing (a domain over 8192 px, or an output box whose
    /// field would be wider than 8192 texels) — the CPU vote then runs.
    pub fn packed(&self) -> Option<PackedVote> {
        let l = &self.base;
        if l.w > 8192 || l.h > 8192 {
            return None;
        }
        let r = self.radius;
        let ob = self.out_box();
        let (nw, nh) = (ob.w as i32 + 2 * r, ob.h as i32 + 2 * r);
        if nw * 3 > 8192 || nh > 8192 {
            return None;
        }
        let mut source_f16 = Vec::with_capacity(l.px.len() * 2);
        for &b in &l.px {
            source_f16.extend_from_slice(&f16b(f32::from(b) / 255.0));
        }
        let mut nnf_f16 = vec![0u8; (nw * 3 * nh) as usize * 8];
        for ny in 0..nh {
            for nx in 0..nw {
                // NNF texel (nx, ny) is target centre (out.x - r + nx, …).
                let (qx, qy) = (ob.x - r + nx, ob.y - r + ny);
                let Some(j) = self.work.tid(qx, qy) else {
                    continue;
                };
                let e = &self.work.nnf[j];
                let m = e.matrix();
                let (sx, sy) = (e.sx.max(0.0), e.sy.max(0.0));
                let (hx, hy) = ((sx / 64.0).floor(), (sy / 64.0).floor());
                let texels = [
                    [hx, sx - hx * 64.0, hy, sy - hy * 64.0],
                    m,
                    [self.weights[j], e.bias[0], e.bias[1], e.bias[2]],
                ];
                for (k, t) in texels.iter().enumerate() {
                    let o = ((ny * nw * 3 + nx * 3 + k as i32) as usize) * 8;
                    for c in 0..4 {
                        nnf_f16[o + c * 2..o + c * 2 + 2].copy_from_slice(&f16b(t[c]));
                    }
                }
            }
        }
        let mut mask_f16 = Vec::with_capacity((ob.w * ob.h) as usize * 2);
        for y in 0..ob.h as i32 {
            for x in 0..ob.w as i32 {
                let hole = l.hole[l.idx(ob.x + x, ob.y + y)] != 0;
                mask_f16.extend_from_slice(&f16b(if hole { 1.0 } else { 0.0 }));
            }
        }
        Some(PackedVote {
            source_f16,
            source_w: l.w as u32,
            source_h: l.h as u32,
            nnf_f16,
            nnf_w: (nw * 3) as u32,
            nnf_h: nh as u32,
            mask_f16,
            out: ob,
            radius: r as u32,
        })
    }

    /// The vote on the CPU over the output box: straight RGBA in 0–1 per
    /// texel (hole pixels voted, the rest as they are).
    pub fn vote_cpu(&self) -> Vec<[f32; 4]> {
        let l = &self.base;
        let ob = self.out_box();
        let mut out = Vec::with_capacity((ob.w * ob.h) as usize);
        for y in ob.y..ob.y + ob.h as i32 {
            for x in ob.x..ob.x + ob.w as i32 {
                let i = l.idx(x, y);
                let v = if l.hole[i] != 0 {
                    vote_at(l, &self.work, &self.weights, x, y, self.radius)
                        .unwrap_or(self.work.est[self.work.widx(x, y)])
                } else {
                    l.px4(i)
                };
                out.push(v);
            }
        }
        out
    }

    /// Land a voted output box (from [`Self::vote_cpu`] or the device) in
    /// a copy of the canvas: hole pixels take the vote, then — for High and
    /// Very High colour adaptation — the membrane correction of the
    /// mismatch between the original ring and the voted ring around the
    /// hole. Nothing outside the hole changes.
    pub fn finish(&self, rgba: &[u8], width: u32, voted: &[[f32; 4]]) -> Vec<u8> {
        let l = &self.base;
        let ob = self.out_box();
        let (ow, oh) = (ob.w as usize, ob.h as usize);
        let to8 = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        let mut fill8 = vec![0u8; ow * oh * 4];
        let mut inside = vec![0u8; ow * oh];
        for y in 0..oh {
            for x in 0..ow {
                let i = y * ow + x;
                let li = l.idx(ob.x + x as i32, ob.y + y as i32);
                if l.hole[li] != 0 {
                    inside[i] = 255;
                }
                for c in 0..4 {
                    fill8[i * 4 + c] = to8(voted[i][c]);
                }
            }
        }
        let blend = self.colour.boundary_blend();
        let mut correction: Option<Vec<f32>> = None;
        if blend > 0.0 {
            // The voted RING: what the matches say the known pixels next to
            // the hole should be. Its mismatch with the original is what
            // the membrane spreads across the hole.
            let mut source = vec![0u8; ow * oh * 4];
            let mut dest = vec![0u8; ow * oh * 4];
            for y in 0..oh {
                for x in 0..ow {
                    let i = y * ow + x;
                    let (lx, ly) = (ob.x + x as i32, ob.y + y as i32);
                    let li = l.idx(lx, ly);
                    dest[i * 4..i * 4 + 4].copy_from_slice(&l.px[li * 4..li * 4 + 4]);
                    let v = if l.hole[li] != 0 {
                        voted[i]
                    } else {
                        vote_at(l, &self.work, &self.weights, lx, ly, self.radius)
                            .unwrap_or(l.px4(li))
                    };
                    for c in 0..4 {
                        source[i * 4 + c] = to8(v[c]);
                    }
                }
            }
            correction = crate::heal::correction_field(&dest, &source, &inside, ow, oh);
        }
        let mut out = rgba.to_vec();
        for y in 0..oh {
            for x in 0..ow {
                let i = y * ow + x;
                if inside[i] == 0 {
                    continue;
                }
                let cx = self.domain.x + ob.x + x as i32;
                let cy = self.domain.y + ob.y + y as i32;
                let d = (cy as usize * width as usize + cx as usize) * 4;
                for c in 0..4 {
                    let mut v = voted[i][c];
                    if c < 3 {
                        if let Some(f) = &correction {
                            v += f[i * 3 + c] * blend;
                        }
                    }
                    out[d + c] = to8(v);
                }
            }
        }
        out
    }
}

/// The CPU TWIN of `geom.patch_vote`: the same decode of the packed field,
/// the same taps in the same order, f32 throughout. Returns rgba16float
/// bytes of the output box, as the kernel's readback is.
pub fn vote_packed(p: &PackedVote) -> Vec<u8> {
    vote_packed_with(p, 1.0, 0.0)
}

/// [`vote_packed`] with the kernel's `bias_scale` and `min_weight`.
pub fn vote_packed_with(p: &PackedVote, bias_scale: f32, min_weight: f32) -> Vec<u8> {
    let rd = |buf: &[u8], i: usize| half::f16::from_le_bytes([buf[i], buf[i + 1]]).to_f32();
    let (sw, sh) = (p.source_w as i32, p.source_h as i32);
    let (nw, nh) = (p.nnf_w as i32, p.nnf_h as i32);
    let tap = |x: i32, y: i32| -> [f32; 4] {
        let (cx, cy) = (x.clamp(0, sw - 1), y.clamp(0, sh - 1));
        let o = ((cy * sw + cx) as usize) * 8;
        [
            rd(&p.source_f16, o),
            rd(&p.source_f16, o + 2),
            rd(&p.source_f16, o + 4),
            rd(&p.source_f16, o + 6),
        ]
    };
    let bil = |sx: f32, sy: f32| -> [f32; 4] {
        let (fx, fy) = (sx.floor(), sy.floor());
        let (tx, ty) = (sx - fx, sy - fy);
        let (ix, iy) = (fx as i32, fy as i32);
        let (p00, p10, p01, p11) = (
            tap(ix, iy),
            tap(ix + 1, iy),
            tap(ix, iy + 1),
            tap(ix + 1, iy + 1),
        );
        let mut o = [0f32; 4];
        for c in 0..4 {
            let top = p00[c] + (p10[c] - p00[c]) * tx;
            let bot = p01[c] + (p11[c] - p01[c]) * tx;
            o[c] = top + (bot - top) * ty;
        }
        o
    };
    let nnf = |cx: i32, cy: i32, k: i32| -> [f32; 4] {
        let x = (cx * 3 + k).clamp(0, nw - 1);
        let y = cy.clamp(0, nh - 1);
        let o = ((y * nw + x) as usize) * 8;
        [
            rd(&p.nnf_f16, o),
            rd(&p.nnf_f16, o + 2),
            rd(&p.nnf_f16, o + 4),
            rd(&p.nnf_f16, o + 6),
        ]
    };
    let r = p.radius.min(16) as i32;
    let (ow, oh) = (p.out.w as i32, p.out.h as i32);
    let mut out = Vec::with_capacity((ow * oh) as usize * 8);
    for y in 0..oh {
        for x in 0..ow {
            let a = tap(x + p.out.x, y + p.out.y);
            let mut acc = [0f32; 4];
            let mut wsum = 0f32;
            for dy in -r..=r {
                for dx in -r..=r {
                    let (cx, cy) = (x + dx + r, y + dy + r);
                    let wb = nnf(cx, cy, 2);
                    if wb[0] > min_weight {
                        let t0 = nnf(cx, cy, 0);
                        let m = nnf(cx, cy, 1);
                        let (ox, oy) = (-dx as f32, -dy as f32);
                        let sx = t0[0] * 64.0 + t0[1] + m[0] * ox + m[1] * oy;
                        let sy = t0[2] * 64.0 + t0[3] + m[2] * ox + m[3] * oy;
                        let v = bil(sx, sy);
                        let b = [
                            wb[1] * bias_scale,
                            wb[2] * bias_scale,
                            wb[3] * bias_scale,
                            0.0,
                        ];
                        for c in 0..4 {
                            acc[c] += wb[0] * (v[c] + b[c]);
                        }
                        wsum += wb[0];
                    }
                }
            }
            let mut res = a;
            if wsum > 0.0 {
                for c in 0..4 {
                    res[c] = acc[c] / wsum;
                }
            }
            let mi = ((y * ow + x) as usize) * 2;
            let mval = rd(&p.mask_f16, mi);
            for c in 0..4 {
                let v = a[c] + (res[c] - a[c]) * mval;
                out.extend_from_slice(&f16b(v));
            }
        }
    }
    out
}

/// Decode a voted rgba16float box into straight 0–1 texels.
pub fn f16_box(bytes: &[u8]) -> Vec<[f32; 4]> {
    bytes
        .as_chunks::<8>()
        .0
        .iter()
        .map(|t| {
            let g = |i: usize| half::f16::from_le_bytes([t[i], t[i + 1]]).to_f32();
            [g(0), g(2), g(4), g(6)]
        })
        .collect()
}

/// FILL on the CPU: search, vote, finish. `None` when there is nothing to
/// fill or nothing to fill from.
pub fn fill_cpu(
    rgba: &[u8],
    width: u32,
    height: u32,
    hole: &[u8],
    sample: &[u8],
    opts: &FillOptions,
) -> Option<Vec<u8>> {
    let s = search(rgba, width, height, hole, sample, opts)?;
    let voted = s.vote_cpu();
    Some(s.finish(rgba, width, &voted))
}

/// FILL with the device vote when a context is given and the field fits
/// the kernel, else the CPU twin. Same search either way.
pub async fn fill(
    ctx: Option<&image_gpu::GpuContext>,
    rgba: &[u8],
    width: u32,
    height: u32,
    hole: &[u8],
    sample: &[u8],
    opts: &FillOptions,
) -> Option<Vec<u8>> {
    let s = search(rgba, width, height, hole, sample, opts)?;
    let voted = match (ctx, s.packed()) {
        (Some(ctx), Some(p)) => match vote_gpu(ctx, &p).await {
            Ok(bytes) => f16_box(&bytes),
            Err(_) => s.vote_cpu(),
        },
        _ => s.vote_cpu(),
    };
    Some(s.finish(rgba, width, &voted))
}

/// Dispatch `geom.patch_vote` over a packed field.
pub async fn vote_gpu(
    ctx: &image_gpu::GpuContext,
    p: &PackedVote,
) -> Result<Vec<u8>, image_gpu::GpuError> {
    use image_kernels::families::geom::{PatchVoteParams, GEOM_PATCH_VOTE};
    let params = PatchVoteParams::new(p.radius, p.out.x, p.out.y);
    image_gpu::execute_gather_once_async(
        ctx,
        &GEOM_PATCH_VOTE,
        &[
            image_gpu::SizedInput {
                f16_bytes: &p.source_f16,
                w: p.source_w,
                h: p.source_h,
            },
            image_gpu::SizedInput {
                f16_bytes: &p.nnf_f16,
                w: p.nnf_w,
                h: p.nnf_h,
            },
        ],
        params.as_bytes(),
        Some(&p.mask_f16),
        p.out.w,
        p.out.h,
    )
    .await
}

// ───────────────────────── sampling areas ─────────────────────────

/// How the sampling area is chosen (Photoshop's Content-Aware Fill
/// workspace): around the hole, a rectangle around it, or painted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SamplingArea {
    /// A band around the hole whose width follows the hole's size — where
    /// plausible material usually is — minus fully transparent pixels.
    Auto,
    /// The hole's bounding box grown by the same margin.
    Rectangular,
}

impl SamplingArea {
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "auto" => Self::Auto,
            "rect" | "rectangular" => Self::Rectangular,
            _ => return None,
        })
    }
}

/// The margin the automatic areas extend around the hole: twice the
/// hole's larger side, at least 32 px.
fn auto_margin(bx: (i32, i32, i32, i32)) -> i32 {
    let (x0, y0, x1, y1) = bx;
    (2 * (x1 - x0 + 1).max(y1 - y0 + 1)).max(32)
}

/// The sampling area for `hole` (one byte per pixel), one byte per pixel
/// (255 = sample here). Never includes the hole; excludes fully
/// transparent pixels (there is nothing there to copy).
pub fn sampling_area(
    rgba: &[u8],
    width: u32,
    height: u32,
    hole: &[u8],
    kind: SamplingArea,
) -> Vec<u8> {
    let (w, h) = (width as i32, height as i32);
    let n = (width as usize) * (height as usize);
    let mut out = vec![0u8; n];
    let Some(bx) = bbox_of(hole, w, h) else {
        return out;
    };
    let m = auto_margin(bx);
    let (x0, y0, x1, y1) = (
        (bx.0 - m).max(0),
        (bx.1 - m).max(0),
        (bx.2 + m).min(w - 1),
        (bx.3 + m).min(h - 1),
    );
    match kind {
        SamplingArea::Rectangular => {
            for y in y0..=y1 {
                for x in x0..=x1 {
                    let i = (y * w + x) as usize;
                    if hole[i] == 0 && rgba[i * 4 + 3] != 0 {
                        out[i] = 255;
                    }
                }
            }
        }
        SamplingArea::Auto => {
            // Distance to the hole by a two-pass chamfer over the box: a
            // band rather than a rectangle, so the corners far from the
            // hole do not dominate.
            let (bw, bh) = (x1 - x0 + 1, y1 - y0 + 1);
            let big = i32::MAX / 4;
            let mut d = vec![big; (bw * bh) as usize];
            for y in 0..bh {
                for x in 0..bw {
                    if hole[((y + y0) * w + x + x0) as usize] != 0 {
                        d[(y * bw + x) as usize] = 0;
                    }
                }
            }
            for y in 0..bh {
                for x in 0..bw {
                    let i = (y * bw + x) as usize;
                    let mut v = d[i];
                    if x > 0 {
                        v = v.min(d[i - 1] + 2);
                    }
                    if y > 0 {
                        v = v.min(d[i - bw as usize] + 2);
                        if x > 0 {
                            v = v.min(d[i - bw as usize - 1] + 3);
                        }
                        if x + 1 < bw {
                            v = v.min(d[i - bw as usize + 1] + 3);
                        }
                    }
                    d[i] = v;
                }
            }
            for y in (0..bh).rev() {
                for x in (0..bw).rev() {
                    let i = (y * bw + x) as usize;
                    let mut v = d[i];
                    if x + 1 < bw {
                        v = v.min(d[i + 1] + 2);
                    }
                    if y + 1 < bh {
                        v = v.min(d[i + bw as usize] + 2);
                        if x + 1 < bw {
                            v = v.min(d[i + bw as usize + 1] + 3);
                        }
                        if x > 0 {
                            v = v.min(d[i + bw as usize - 1] + 3);
                        }
                    }
                    d[i] = v;
                }
            }
            for y in 0..bh {
                for x in 0..bw {
                    let gi = ((y + y0) * w + x + x0) as usize;
                    let dist = d[(y * bw + x) as usize];
                    if dist > 0 && dist <= 2 * m && rgba[gi * 4 + 3] != 0 {
                        out[gi] = 255;
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `w × h` RGBA8 from a per-pixel colour.
    fn img(w: u32, h: u32, f: impl Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                let c = f(x, y);
                v.extend_from_slice(&[c[0], c[1], c[2], 255]);
            }
        }
        v
    }

    fn rect(w: u32, h: u32, x0: u32, y0: u32, x1: u32, y1: u32) -> Vec<u8> {
        let mut d = vec![0u8; (w * h) as usize];
        for y in y0..y1 {
            for x in x0..x1 {
                d[(y * w + x) as usize] = 255;
            }
        }
        d
    }

    fn everything_but(hole: &[u8]) -> Vec<u8> {
        hole.iter().map(|&b| if b == 0 { 255 } else { 0 }).collect()
    }

    /// A deterministic pseudo-random texture: what "a known background"
    /// looks like to a quality metric.
    fn noise_texture(w: u32, h: u32, seed: u32) -> Vec<u8> {
        img(w, h, |x, y| {
            let mut z = (x.wrapping_mul(73_856_093) ^ y.wrapping_mul(19_349_663) ^ seed)
                .wrapping_mul(2_654_435_761);
            z ^= z >> 13;
            let v = 96 + (z % 64) as u8;
            [v, v.wrapping_add(10), v.wrapping_sub(20)]
        })
    }

    /// Mean absolute error over the hole against the ground truth (0–255).
    fn mae(a: &[u8], b: &[u8], hole: &[u8]) -> f64 {
        let mut sum = 0f64;
        let mut n = 0f64;
        for (i, &m) in hole.iter().enumerate() {
            if m == 0 {
                continue;
            }
            for c in 0..3 {
                sum += (f64::from(a[i * 4 + c]) - f64::from(b[i * 4 + c])).abs();
            }
            n += 3.0;
        }
        sum / n
    }

    /// SEAM error: the mean absolute step across the hole's boundary
    /// (hole pixel vs its outside neighbour) minus the same statistic on
    /// the ground truth — how much MORE visible the edge is than the
    /// texture's own variation.
    fn seam(out: &[u8], truth: &[u8], hole: &[u8], w: u32, h: u32) -> f64 {
        let step = |px: &[u8]| {
            let mut s = 0f64;
            let mut n = 0f64;
            for y in 0..h as i32 {
                for x in 0..w as i32 {
                    let i = (y * w as i32 + x) as usize;
                    if hole[i] == 0 {
                        continue;
                    }
                    for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                        let (nx, ny) = (x + dx, y + dy);
                        if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                            continue;
                        }
                        let j = (ny * w as i32 + nx) as usize;
                        if hole[j] != 0 {
                            continue;
                        }
                        for c in 0..3 {
                            s += (f64::from(px[i * 4 + c]) - f64::from(px[j * 4 + c])).abs();
                        }
                        n += 3.0;
                    }
                }
            }
            s / n.max(1.0)
        };
        step(out) - step(truth)
    }

    #[test]
    #[allow(non_snake_case)]
    fn fills_every_hole_pixel_from_real_pixels__feat__image_editor_content_aware_move() {
        // Two-valued stripes: a fill made of copies stays two-valued; any
        // averaging would show as an intermediate grey.
        let (w, h) = (64u32, 64u32);
        let src = img(w, h, |x, _| {
            let v = if (x / 4) % 2 == 0 { 30 } else { 220 };
            [v, v, v]
        });
        let hole = rect(w, h, 26, 26, 38, 38);
        let opts = FillOptions {
            colour: ColourAdaptation::None,
            ..FillOptions::default()
        };
        let out = fill_cpu(&src, w, h, &hole, &everything_but(&hole), &opts).expect("filled");
        let mut off = 0;
        for y in 26..38 {
            for x in 26..38 {
                let v = out[((y * w + x) * 4) as usize];
                if v > 40 && v < 210 {
                    off += 1;
                }
            }
        }
        assert!(off <= 4, "{off} hole pixels are blends, not copies");
        // The stripe period continues through the hole.
        let truth = src.clone();
        assert!(
            mae(&out, &truth, &hole) < 10.0,
            "stripes continue: mae {}",
            mae(&out, &truth, &hole)
        );
    }

    #[test]
    #[allow(non_snake_case)]
    fn leaves_everything_outside_the_hole_alone__feat__image_editor_content_aware_move() {
        let (w, h) = (48u32, 48u32);
        let src = img(w, h, |x, y| [(x * 5) as u8, (y * 5) as u8, 77]);
        let hole = rect(w, h, 18, 18, 26, 26);
        let out = fill_cpu(
            &src,
            w,
            h,
            &hole,
            &everything_but(&hole),
            &FillOptions::default(),
        )
        .expect("filled");
        for (i, &m) in hole.iter().enumerate() {
            if m == 0 {
                assert_eq!(&out[i * 4..i * 4 + 4], &src[i * 4..i * 4 + 4], "pixel {i}");
            }
        }
    }

    #[test]
    #[allow(non_snake_case)]
    fn the_same_seed_gives_the_same_fill_and_another_seed_a_valid_one__feat__image_editor_content_aware_move(
    ) {
        let (w, h) = (80u32, 80u32);
        let src = noise_texture(w, h, 7);
        let hole = rect(w, h, 30, 30, 50, 50);
        let sample = everything_but(&hole);
        let a = fill_cpu(&src, w, h, &hole, &sample, &FillOptions::default()).unwrap();
        let b = fill_cpu(&src, w, h, &hole, &sample, &FillOptions::default()).unwrap();
        assert_eq!(a, b, "deterministic for one seed");
        let c = fill_cpu(
            &src,
            w,
            h,
            &hole,
            &sample,
            &FillOptions {
                seed: 99,
                ..FillOptions::default()
            },
        )
        .unwrap();
        assert_ne!(a, c, "the seed is consumed");
    }

    #[test]
    #[allow(non_snake_case)]
    fn nothing_to_fill_or_nothing_to_fill_from_is_none__feat__image_editor_content_aware_move() {
        let (w, h) = (32u32, 32u32);
        let src = img(w, h, |_, _| [100, 100, 100]);
        let none = vec![0u8; (w * h) as usize];
        assert!(fill_cpu(
            &src,
            w,
            h,
            &none,
            &everything_but(&none),
            &FillOptions::default()
        )
        .is_none());
        let all = vec![255u8; (w * h) as usize];
        assert!(fill_cpu(&src, w, h, &all, &all, &FillOptions::default()).is_none());
        // A sampling area with no room for a single patch.
        let hole = rect(w, h, 10, 10, 20, 20);
        let tiny = rect(w, h, 0, 0, 3, 3);
        assert!(fill_cpu(&src, w, h, &hole, &tiny, &FillOptions::default()).is_none());
    }

    /// THE QUALITY GATE on a known background: an object (a flat dark
    /// square) on a periodic texture is removed, and the fill is measured
    /// against the texture that was under it.
    #[test]
    #[allow(non_snake_case)]
    fn removes_an_object_from_a_periodic_background_within_quality_bounds__feat__image_editor_content_aware_move(
    ) {
        let (w, h) = (96u32, 96u32);
        let truth = img(w, h, |x, y| {
            let v = 60 + ((x % 8) * 18 + (y % 6) * 9) as u8;
            [v, 255 - v, (v / 2).wrapping_add(40)]
        });
        let mut src = truth.clone();
        let hole = rect(w, h, 36, 40, 60, 62);
        for (i, &m) in hole.iter().enumerate() {
            if m != 0 {
                src[i * 4..i * 4 + 3].copy_from_slice(&[10, 10, 10]);
            }
        }
        let out = fill_cpu(
            &src,
            w,
            h,
            &hole,
            &everything_but(&hole),
            &FillOptions::default(),
        )
        .expect("filled");
        let err = mae(&out, &truth, &hole);
        let s = seam(&out, &truth, &hole, w, h);
        eprintln!("periodic background: mean colour error {err:.2}, seam excess {s:.2}");
        assert!(err < 6.0, "mean colour error {err:.2} vs ground truth");
        assert!(s < 6.0, "seam excess {s:.2}");
    }

    /// The UNBOUNDED search: the only material that continues the hole's
    /// surroundings sits ~250 px away (far beyond the old 96-px window).
    #[test]
    #[allow(non_snake_case)]
    fn finds_material_beyond_the_old_search_window__feat__image_editor_content_aware_move() {
        let (w, h) = (360u32, 64u32);
        let red = noise_texture(w, h, 5);
        // Left and far right: a red noise texture; between them a neutral
        // grey noise. The hole leaves only a 4-px red frame on the left —
        // too thin to hold a 7×7 patch — so the far right is the only red
        // source there is.
        let truth = img(w, h, |x, y| {
            let i = ((y * w + x) * 4) as usize;
            let v = red[i];
            if !(40..320).contains(&x) {
                [v.saturating_add(90), v / 3, v / 3]
            } else {
                [v, v, v]
            }
        });
        let hole = rect(w, h, 4, 4, 36, 60);
        let mut src = truth.clone();
        for (i, &m) in hole.iter().enumerate() {
            if m != 0 {
                src[i * 4..i * 4 + 3].copy_from_slice(&[0, 0, 0]);
            }
        }
        let out = fill_cpu(
            &src,
            w,
            h,
            &hole,
            &everything_but(&hole),
            &FillOptions::default(),
        )
        .expect("filled");
        let mut reddish = 0;
        let mut total = 0;
        for (i, &m) in hole.iter().enumerate() {
            if m == 0 {
                continue;
            }
            total += 1;
            if i32::from(out[i * 4]) > i32::from(out[i * 4 + 1]) + 60 {
                reddish += 1;
            }
        }
        assert!(
            reddish * 10 > total * 8,
            "only {reddish}/{total} hole pixels are red: the fill did not reach the far texture"
        );
    }

    #[test]
    #[allow(non_snake_case)]
    fn colour_adaptation_matches_a_brightness_shift__feat__image_editor_content_aware_move() {
        // The only texture source is 30 levels brighter than the hole's
        // surroundings: with adaptation the fill lands nearer the
        // surroundings' brightness than without.
        let (w, h) = (96u32, 64u32);
        let tex = |x: u32, y: u32, base: u8| base + (((x * 7 + y * 3) % 5) * 6) as u8;
        let src = img(w, h, |x, y| {
            let base = if x < 48 { 80 } else { 110 };
            let v = tex(x, y, base);
            [v, v, v]
        });
        let hole = rect(w, h, 14, 20, 34, 44);
        // Sample only the brighter right half.
        let sample = rect(w, h, 52, 0, 96, 64);
        let mean = |px: &[u8]| {
            let mut s = 0f64;
            let mut n = 0f64;
            for (i, &m) in hole.iter().enumerate() {
                if m != 0 {
                    s += f64::from(px[i * 4]);
                    n += 1.0;
                }
            }
            s / n
        };
        let plain = fill_cpu(
            &src,
            w,
            h,
            &hole,
            &sample,
            &FillOptions {
                colour: ColourAdaptation::None,
                ..FillOptions::default()
            },
        )
        .unwrap();
        let adapted = fill_cpu(
            &src,
            w,
            h,
            &hole,
            &sample,
            &FillOptions {
                colour: ColourAdaptation::VeryHigh,
                ..FillOptions::default()
            },
        )
        .unwrap();
        let want = 80.0 + 12.0;
        let (p, a) = (mean(&plain), mean(&adapted));
        eprintln!("colour adaptation: none {p:.1}, very high {a:.1}, surroundings ~{want}");
        assert!(
            (a - want).abs() + 5.0 < (p - want).abs(),
            "adaptation pulls toward the surroundings"
        );
    }

    #[test]
    #[allow(non_snake_case)]
    fn rotation_adaptation_finds_rotated_structure__feat__image_editor_content_aware_move() {
        // Horizontal stripes around the hole; the only sampling area holds
        // VERTICAL stripes. Without rotation the fill cannot continue the
        // stripes; with full rotation it can.
        let (w, h) = (120u32, 64u32);
        let src = img(w, h, |x, y| {
            let on = if x < 60 {
                (y / 3) % 2 == 0
            } else {
                (x / 3) % 2 == 0
            };
            let v = if on { 40 } else { 210 };
            [v, v, v]
        });
        let hole = rect(w, h, 18, 20, 42, 44);
        let sample = rect(w, h, 64, 0, 120, 64);
        // Orientation inside the hole: the mean horizontal step over the
        // mean vertical step. Horizontal stripes make it small.
        let anisotropy = |px: &[u8]| {
            let at = |x: u32, y: u32| f64::from(px[((y * w + x) * 4) as usize]);
            let (mut gx, mut gy) = (0f64, 0f64);
            for y in 21..43 {
                for x in 19..41 {
                    gx += (at(x + 1, y) - at(x, y)).abs();
                    gy += (at(x, y + 1) - at(x, y)).abs();
                }
            }
            gx / gy.max(1.0)
        };
        let none = fill_cpu(&src, w, h, &hole, &sample, &FillOptions::default()).unwrap();
        let full = fill_cpu(
            &src,
            w,
            h,
            &hole,
            &sample,
            &FillOptions {
                rotation: RotationAdaptation::Full,
                ..FillOptions::default()
            },
        )
        .unwrap();
        let (an, af) = (anisotropy(&none), anisotropy(&full));
        eprintln!("rotation adaptation: horizontal/vertical step none {an:.2}, full {af:.2}");
        assert!(
            an > 1.0,
            "without rotation only vertical stripes exist to copy ({an:.2})"
        );
        assert!(
            af < 0.5,
            "with full rotation the stripes turn to continue the surroundings ({af:.2})"
        );
    }

    #[test]
    #[allow(non_snake_case)]
    fn the_packed_twin_agrees_with_the_cpu_vote__feat__image_editor_content_aware_move() {
        let (w, h) = (64u32, 64u32);
        let src = noise_texture(w, h, 3);
        let hole = rect(w, h, 24, 24, 40, 40);
        let opts = FillOptions {
            rotation: RotationAdaptation::Medium,
            ..FillOptions::default()
        };
        let s = search(&src, w, h, &hole, &everything_but(&hole), &opts).expect("search");
        let cpu = s.vote_cpu();
        let packed = s.packed().expect("fits");
        let twin = f16_box(&vote_packed(&packed));
        assert_eq!(cpu.len(), twin.len());
        let worst = cpu
            .iter()
            .zip(&twin)
            .flat_map(|(a, b)| (0..4).map(move |c| (a[c] - b[c]).abs()))
            .fold(0f32, f32::max);
        // f16 quantisation of the field (centre to 1/32 px, the matrix and
        // weights to ~1e-3) and of the result.
        assert!(
            worst < 0.02,
            "packed twin vs CPU vote: worst channel {worst}"
        );
    }

    #[test]
    #[allow(non_snake_case)]
    fn device_vote_matches_its_cpu_twin__feat__image_editor_content_aware_move() {
        let Some(ctx) = image_gpu::test_support::device_or_skip("patch vote") else {
            return;
        };
        let (w, h) = (96u32, 80u32);
        let src = noise_texture(w, h, 11);
        let hole = rect(w, h, 30, 28, 62, 54);
        for opts in [
            FillOptions::default(),
            FillOptions {
                rotation: RotationAdaptation::Full,
                scale: true,
                mirror: true,
                ..FillOptions::default()
            },
        ] {
            let s = search(&src, w, h, &hole, &everything_but(&hole), &opts).expect("search");
            let p = s.packed().expect("fits");
            let gpu = pollster::block_on(vote_gpu(ctx, &p)).expect("dispatch");
            let twin = vote_packed(&p);
            assert_eq!(gpu.len(), twin.len());
            let mut worst = 0u32;
            for (g, t) in gpu
                .as_chunks::<2>()
                .0
                .iter()
                .zip(twin.as_chunks::<2>().0.iter())
            {
                let (a, b) = (
                    u16::from_le_bytes([g[0], g[1]]),
                    u16::from_le_bytes([t[0], t[1]]),
                );
                let d = (i32::from(a) - i32::from(b)).unsigned_abs();
                worst = worst.max(d);
            }
            assert!(
                worst <= 8,
                "geom.patch_vote vs its twin: {worst} f16 ULPs (tolerance 8)"
            );
        }
    }

    #[test]
    #[allow(non_snake_case)]
    fn the_automatic_sampling_areas_surround_the_hole_and_skip_transparency__feat__image_editor_content_aware_move(
    ) {
        let (w, h) = (200u32, 200u32);
        let mut src = img(w, h, |_, _| [90, 90, 90]);
        // A transparent column far left.
        for y in 0..h {
            for x in 0..10 {
                src[((y * w + x) * 4 + 3) as usize] = 0;
            }
        }
        let hole = rect(w, h, 90, 90, 110, 110);
        let auto = sampling_area(&src, w, h, &hole, SamplingArea::Auto);
        let rectangular = sampling_area(&src, w, h, &hole, SamplingArea::Rectangular);
        for (i, &m) in hole.iter().enumerate() {
            if m != 0 {
                assert_eq!(auto[i], 0);
                assert_eq!(rectangular[i], 0);
            }
        }
        let at = |v: &[u8], x: u32, y: u32| v[(y * w + x) as usize];
        // Next to the hole: both sample.
        assert_eq!(at(&auto, 85, 100), 255);
        assert_eq!(at(&rectangular, 85, 100), 255);
        // The rectangle's corner is in the rectangle but beyond the band.
        assert_eq!(at(&rectangular, 51, 51), 255);
        assert_eq!(at(&auto, 51, 51), 0);
        // Transparency is never material.
        assert_eq!(at(&rectangular, 5, 100), 0);
    }

    #[test]
    fn erosion_keeps_only_whole_windows() {
        let (w, h) = (10, 10);
        let mut v = vec![0u8; 100];
        for y in 2..8 {
            for x in 2..8 {
                v[y * 10 + x] = 1;
            }
        }
        let e = erode(&v, w, h, 1);
        assert_eq!(e[5 * 10 + 5], 1);
        assert_eq!(e[3 * 10 + 3], 1);
        assert_eq!(e[2 * 10 + 2], 0, "its window leaves the allowed square");
        assert_eq!(e[0], 0, "the border never holds a whole window");
    }

    #[test]
    fn the_transform_matrix_is_rotation_scale_mirror() {
        let mut c = Cand::at(0.0, 0.0);
        assert_eq!(c.matrix(), [1.0, 0.0, 0.0, 1.0]);
        c.mirror = true;
        let m = c.matrix();
        assert_eq!(apply(&m, 1.0, 0.0), (-1.0, 0.0));
        c.mirror = false;
        c.angle = std::f32::consts::FRAC_PI_2;
        let (x, y) = apply(&c.matrix(), 1.0, 0.0);
        assert!(x.abs() < 1e-6 && (y - 1.0).abs() < 1e-6);
    }
}
