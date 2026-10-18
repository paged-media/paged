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

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A 32-byte BLAKE3 address, written as 64 lowercase hex characters.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Hash(pub [u8; 32]);

/// The kind of an object. The kind is the BLAKE3 derive-key context, so equal
/// bytes of two kinds never share an address.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    Blob,
    Chunks,
    Tree,
    Commit,
    Evidence,
    Recipe,
}

impl Kind {
    pub fn context(self) -> &'static str {
        match self {
            Kind::Blob => "paged:blob:v1",
            Kind::Chunks => "paged:chunks:v1",
            Kind::Tree => "paged:tree:v1",
            Kind::Commit => "paged:commit:v1",
            Kind::Evidence => "paged:evidence:v1",
            Kind::Recipe => "paged:recipe:v1",
        }
    }

    /// The one-byte tag a history bundle writes before each object.
    pub fn tag(self) -> u8 {
        match self {
            Kind::Blob => 1,
            Kind::Chunks => 2,
            Kind::Tree => 3,
            Kind::Commit => 4,
            Kind::Evidence => 5,
            Kind::Recipe => 6,
        }
    }

    pub fn from_tag(tag: u8) -> Option<Kind> {
        Some(match tag {
            1 => Kind::Blob,
            2 => Kind::Chunks,
            3 => Kind::Tree,
            4 => Kind::Commit,
            5 => Kind::Evidence,
            6 => Kind::Recipe,
            _ => return None,
        })
    }
}

/// The address of `bytes` as an object of `kind`.
pub fn address(kind: Kind, bytes: &[u8]) -> Hash {
    let mut h = blake3::Hasher::new_derive_key(kind.context());
    h.update(bytes);
    Hash(*h.finalize().as_bytes())
}

impl Hash {
    pub fn to_hex(&self) -> String {
        let mut s = String::with_capacity(64);
        for b in self.0 {
            s.push_str(&format!("{b:02x}"));
        }
        s
    }

    /// Parses exactly 64 lowercase hex characters.
    pub fn from_hex(s: &str) -> Option<Hash> {
        let b = s.as_bytes();
        if b.len() != 64 {
            return None;
        }
        let nib = |c: u8| match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            _ => None,
        };
        let mut out = [0u8; 32];
        for (i, pair) in b.chunks(2).enumerate() {
            out[i] = nib(pair[0])? << 4 | nib(pair[1])?;
        }
        Some(Hash(out))
    }
}

impl fmt::Display for Hash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl fmt::Debug for Hash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Hash({})", &self.to_hex()[..12])
    }
}

impl Serialize for Hash {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for Hash {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Hash, D::Error> {
        let s = String::deserialize(d)?;
        Hash::from_hex(&s).ok_or_else(|| serde::de::Error::custom("not a 64-hex address"))
    }
}
