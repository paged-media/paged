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

//! The facts black-point detection needs from a profile, read from its
//! header and tag table (ICC.1:2022 §7.2, §7.3) so every backend decides
//! the same way.

use super::{CmsError, Intent, ProfileRef, Space};

/// The profile/device class (header bytes 12..16).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Class {
    Input,
    Display,
    Output,
    Other,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Facts {
    /// Major version (2 or 4).
    pub major: u8,
    pub class: Class,
    pub space: Space,
    /// TRC (and, for RGB, colorant) tags: the profile can convert without
    /// a LUT.
    pub matrix_shaper: bool,
    /// A2B0, A2B1, A2B2.
    pub a2b: [bool; 3],
    /// B2A0, B2A1, B2A2.
    pub b2a: [bool; 3],
}

fn sig(bytes: &[u8], at: usize) -> Option<[u8; 4]> {
    bytes.get(at..at + 4)?.try_into().ok()
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    sig(bytes, at).map(u32::from_be_bytes)
}

/// The tag-table index of an intent (absolute uses the colorimetric
/// tables, ICC.1 §8.10).
fn slot(intent: Intent) -> usize {
    match intent {
        Intent::Perceptual => 0,
        Intent::RelativeColorimetric | Intent::AbsoluteColorimetric => 1,
        Intent::Saturation => 2,
    }
}

impl Facts {
    pub fn parse(bytes: &[u8]) -> Result<Facts, CmsError> {
        let bad = |what: &str| CmsError::BadProfile(format!("ICC header: {what}"));
        if bytes.len() < 132 || sig(bytes, 36) != Some(*b"acsp") {
            return Err(bad("no 'acsp' signature"));
        }
        let class = match &sig(bytes, 12).ok_or_else(|| bad("class"))? {
            b"scnr" => Class::Input,
            b"mntr" => Class::Display,
            b"prtr" => Class::Output,
            _ => Class::Other,
        };
        let space = match &sig(bytes, 16).ok_or_else(|| bad("colour space"))? {
            b"GRAY" => Space::Gray,
            b"RGB " => Space::Rgb,
            b"CMYK" => Space::Cmyk,
            b"Lab " => Space::Lab,
            other => {
                return Err(CmsError::Unsupported(format!(
                    "profile colour space {:?}",
                    String::from_utf8_lossy(other)
                )))
            }
        };
        let count = u32_at(bytes, 128).ok_or_else(|| bad("tag count"))? as usize;
        let mut tags: Vec<[u8; 4]> = Vec::with_capacity(count.min(256));
        for i in 0..count.min(1024) {
            match sig(bytes, 132 + i * 12) {
                Some(s) => tags.push(s),
                None => break,
            }
        }
        let has = |t: &[u8; 4]| tags.contains(t);
        let matrix_shaper = match space {
            Space::Gray => has(b"kTRC"),
            Space::Rgb => [b"rXYZ", b"gXYZ", b"bXYZ", b"rTRC", b"gTRC", b"bTRC"]
                .iter()
                .all(|t| has(t)),
            _ => false,
        };
        Ok(Facts {
            major: bytes[8],
            class,
            space,
            matrix_shaper,
            a2b: [has(b"A2B0"), has(b"A2B1"), has(b"A2B2")],
            b2a: [has(b"B2A0"), has(b"B2A1"), has(b"B2A2")],
        })
    }

    pub fn of(profile: ProfileRef<'_>) -> Result<Facts, CmsError> {
        let builtin = |space| Facts {
            major: 4,
            class: Class::Display,
            space,
            matrix_shaper: true,
            a2b: [false; 3],
            b2a: [false; 3],
        };
        match profile {
            ProfileRef::Icc(bytes) => Facts::parse(bytes),
            ProfileRef::Srgb => Ok(builtin(Space::Rgb)),
            ProfileRef::Gray(_) => Ok(builtin(Space::Gray)),
            ProfileRef::Lab => Ok(Facts {
                matrix_shaper: false,
                ..builtin(Space::Lab)
            }),
        }
    }

    pub fn is_v4(&self) -> bool {
        self.major >= 4
    }

    /// The device-to-PCS direction can render `intent`.
    pub fn supports_input(&self, intent: Intent) -> bool {
        self.matrix_shaper || self.a2b[slot(intent)]
    }

    /// The PCS-to-device direction renders `intent` through a LUT.
    pub fn is_clut_output(&self, intent: Intent) -> bool {
        self.b2a[slot(intent)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal header plus a tag table naming `tags` (offsets unused).
    fn header(class: &[u8; 4], space: &[u8; 4], major: u8, tags: &[&[u8; 4]]) -> Vec<u8> {
        let mut b = vec![0u8; 132 + tags.len() * 12];
        b[8] = major;
        b[12..16].copy_from_slice(class);
        b[16..20].copy_from_slice(space);
        b[36..40].copy_from_slice(b"acsp");
        b[128..132].copy_from_slice(&(tags.len() as u32).to_be_bytes());
        for (i, t) in tags.iter().enumerate() {
            b[132 + i * 12..136 + i * 12].copy_from_slice(*t);
        }
        b
    }

    #[test]
    fn reads_class_space_version_and_tables() {
        let b = header(b"prtr", b"CMYK", 2, &[b"A2B0", b"A2B1", b"B2A1"]);
        let f = Facts::parse(&b).expect("parses");
        assert_eq!(f.class, Class::Output);
        assert_eq!(f.space, Space::Cmyk);
        assert!(!f.is_v4() && !f.matrix_shaper);
        assert!(f.supports_input(Intent::Perceptual));
        assert!(!f.supports_input(Intent::Saturation));
        assert!(f.is_clut_output(Intent::AbsoluteColorimetric));
        assert!(!f.is_clut_output(Intent::Perceptual));
    }

    #[test]
    fn an_rgb_matrix_shaper_is_recognised() {
        let tags: [&[u8; 4]; 6] = [b"rXYZ", b"gXYZ", b"bXYZ", b"rTRC", b"gTRC", b"bTRC"];
        let f = Facts::parse(&header(b"mntr", b"RGB ", 4, &tags)).expect("parses");
        assert!(f.matrix_shaper && f.is_v4());
        assert!(f.supports_input(Intent::Saturation));
    }

    #[test]
    fn junk_is_refused() {
        assert!(Facts::parse(&[0u8; 200]).is_err());
        assert!(Facts::parse(b"short").is_err());
    }
}
