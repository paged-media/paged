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

//! The pixel the shipped CPU twins and the test-only references compute
//! on (moved from paged.image's `image-kernels::reference_prelude`, engine
//! ADR 1013's first step).

/// A pixel: rgba in the working space, f32 (reference precision; f16
/// quantization is the FINAL step before diffing, spec §5.2).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Px(pub [f32; 4]);

impl Px {
    pub fn map(self, f: impl Fn(f32) -> f32) -> Px {
        Px([f(self.0[0]), f(self.0[1]), f(self.0[2]), f(self.0[3])])
    }

    pub fn zip(self, o: Px, f: impl Fn(f32, f32) -> f32) -> Px {
        Px([
            f(self.0[0], o.0[0]),
            f(self.0[1], o.0[1]),
            f(self.0[2], o.0[2]),
            f(self.0[3], o.0[3]),
        ])
    }
}

impl core::ops::Add for Px {
    type Output = Px;
    fn add(self, o: Px) -> Px {
        self.zip(o, |x, y| x + y)
    }
}

impl core::ops::Sub for Px {
    type Output = Px;
    fn sub(self, o: Px) -> Px {
        self.zip(o, |x, y| x - y)
    }
}

impl core::ops::Mul for Px {
    type Output = Px;
    fn mul(self, o: Px) -> Px {
        self.zip(o, |x, y| x * y)
    }
}

impl core::ops::Div for Px {
    type Output = Px;
    fn div(self, o: Px) -> Px {
        self.zip(o, |x, y| x / y)
    }
}

impl core::ops::Neg for Px {
    type Output = Px;
    fn neg(self) -> Px {
        self.map(|x| -x)
    }
}

impl core::ops::Index<usize> for Px {
    type Output = f32;
    fn index(&self, i: usize) -> &f32 {
        &self.0[i]
    }
}

/// Dynamic channel indexing (`a[p.channel]`) — WGSL indexes vectors
/// with u32 natively; the Rust lane mirrors it.
impl core::ops::Index<u32> for Px {
    type Output = f32;
    fn index(&self, i: u32) -> &f32 {
        &self.0[i as usize]
    }
}

/// Literal channel indexing (`a[0]`, `a[3]`): a bare Rust integer
/// literal is i32, and with multiple Index impls in scope it will NOT
/// coerce — this impl is what lets the DSL form stay identical in both
/// languages (WGSL accepts the literal natively).
impl core::ops::Index<i32> for Px {
    type Output = f32;
    fn index(&self, i: i32) -> &f32 {
        &self.0[i as usize]
    }
}
