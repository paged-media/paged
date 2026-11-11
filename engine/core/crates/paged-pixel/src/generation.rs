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

//! Cache-key newtypes (spec §5.3 / §7.1). Salsa-style dependency
//! tracking hangs off these: downstream caches key on
//! `(node id, ParamsHash, input ContentHash/GenerationId)`.
//!
//! Param identity is BYTE identity: `ParamsHash` is computed over
//! `bytemuck::bytes_of(&params)` (param structs carry f32 fields and
//! therefore never derive `Hash`). NaN/-0.0 normalization for op-log
//! stability is a documented post-M0 follow-up.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct GenerationId(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ContentHash(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ParamsHash(pub u64);

/// FNV-1a 64 offset basis: the seed of [`fnv1a_64`] and [`fnv1a_64_update`].
pub const FNV1A_64_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;

/// FNV-1a 64 prime.
pub const FNV1A_64_PRIME: u64 = 0x0000_0100_0000_01b3;

/// FNV-1a 64 — the one hash used for content/params identity in M0, and the
/// engine's single owner of the 64-bit FNV (a cache key, a stable id).
/// Deliberately dependency-free; stable across platforms.
pub fn fnv1a_64(bytes: &[u8]) -> u64 {
    fnv1a_64_update(FNV1A_64_OFFSET, bytes)
}

/// Continue an FNV-1a 64 hash `h` (start from [`FNV1A_64_OFFSET`]) over
/// `bytes`: hashing in pieces gives the hash of the concatenation.
pub fn fnv1a_64_update(mut h: u64, bytes: &[u8]) -> u64 {
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(FNV1A_64_PRIME);
    }
    h
}

/// FNV-1a 64 as a [`std::fmt::Write`] sink: `write!` a value's `Debug`
/// form straight into the hash without building the string (the display
/// list's digest and prints, pattern tiles).
#[derive(Debug, Clone, Copy)]
pub struct Fnv1a64(pub u64);

impl Default for Fnv1a64 {
    fn default() -> Self {
        Fnv1a64(FNV1A_64_OFFSET)
    }
}

impl Fnv1a64 {
    /// Fold `bytes` in.
    pub fn bytes(&mut self, bytes: &[u8]) {
        self.0 = fnv1a_64_update(self.0, bytes);
    }
}

impl std::fmt::Write for Fnv1a64 {
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        self.bytes(s.as_bytes());
        Ok(())
    }
}

/// FNV-1a 32 offset basis.
pub const FNV1A_32_OFFSET: u32 = 0x811c_9dc5;

/// FNV-1a 32 prime.
pub const FNV1A_32_PRIME: u32 = 0x0100_0193;

/// FNV-1a 32: the short ids (a font face's id, a PDF resource name, a
/// review author's colour slot). The same hash as `fnv1a32` of
/// `@paged-media/helpers`.
pub fn fnv1a_32(bytes: &[u8]) -> u32 {
    fnv1a_32_update(FNV1A_32_OFFSET, bytes)
}

/// Continue an FNV-1a 32 hash `h` over `bytes`.
pub fn fnv1a_32_update(mut h: u32, bytes: &[u8]) -> u32 {
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(FNV1A_32_PRIME);
    }
    h
}

impl ContentHash {
    pub fn of(bytes: &[u8]) -> Self {
        ContentHash(fnv1a_64(bytes))
    }
}

impl ParamsHash {
    pub fn of(bytes: &[u8]) -> Self {
        ParamsHash(fnv1a_64(bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv_is_stable() {
        // Known FNV-1a 64 vector.
        assert_eq!(fnv1a_64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a_64(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(fnv1a_64_update(fnv1a_64(b"ab"), b"cd"), fnv1a_64(b"abcd"));
        assert_eq!(fnv1a_32(b""), 0x811c_9dc5);
        assert_eq!(fnv1a_32(b"a"), 0xe40c_292c);
        let mut w = Fnv1a64::default();
        std::fmt::Write::write_str(&mut w, "abcd").unwrap();
        assert_eq!(w.0, fnv1a_64(b"abcd"));
    }
}
