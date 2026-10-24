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

//! A hand-rolled TIFF writer for layouts no encoder produces: each page's
//! tags and chunks (strips or tiles) as given, uncompressed or whatever
//! the caller compressed them with.

/// A tag value.
#[derive(Clone)]
pub enum V {
    Short(Vec<u16>),
    Long(Vec<u32>),
    Rational(Vec<(u32, u32)>),
    SRational(Vec<(i32, i32)>),
    Byte(Vec<u8>),
    Undefined(Vec<u8>),
}

/// One page: its tags (offsets and byte counts are added) and chunks.
pub struct Page {
    pub tags: Vec<(u16, V)>,
    pub chunks: Vec<Vec<u8>>,
    pub tiled: bool,
}

impl Page {
    pub fn strips(tags: Vec<(u16, V)>, chunks: Vec<Vec<u8>>) -> Page {
        Page {
            tags,
            chunks,
            tiled: false,
        }
    }

    pub fn tiles(tags: Vec<(u16, V)>, chunks: Vec<Vec<u8>>) -> Page {
        Page {
            tags,
            chunks,
            tiled: true,
        }
    }
}

/// The usual tags of a `w` x `h` page.
pub fn base(w: u32, h: u32, bits: &[u16], photometric: u16) -> Vec<(u16, V)> {
    vec![
        (256, V::Long(vec![w])),
        (257, V::Long(vec![h])),
        (258, V::Short(bits.to_vec())),
        (259, V::Short(vec![1])),
        (262, V::Short(vec![photometric])),
        (277, V::Short(vec![bits.len() as u16])),
        (278, V::Long(vec![h])),
    ]
}

/// Replace or add a tag.
pub fn set(tags: &mut Vec<(u16, V)>, tag: u16, v: V) {
    tags.retain(|(t, _)| *t != tag);
    tags.push((tag, v));
}

pub fn write(pages: &[Page], le: bool) -> Vec<u8> {
    let u16b = |v: u16| if le { v.to_le_bytes() } else { v.to_be_bytes() };
    let u32b = |v: u32| if le { v.to_le_bytes() } else { v.to_be_bytes() };
    let mut b: Vec<u8> = if le {
        b"II*\0".to_vec()
    } else {
        b"MM\0*".to_vec()
    };
    b.extend([0; 4]);
    let mut link_at = 4usize;
    for p in pages {
        let mut offsets = Vec::new();
        let mut counts = Vec::new();
        for c in &p.chunks {
            offsets.push(b.len() as u32);
            counts.push(c.len() as u32);
            b.extend(c);
            if b.len() % 2 == 1 {
                b.push(0);
            }
        }
        let mut tags = p.tags.clone();
        let (o, c) = if p.tiled { (324, 325) } else { (273, 279) };
        if p.tiled {
            tags.retain(|(t, _)| *t != 278);
        }
        tags.push((o, V::Long(offsets)));
        tags.push((c, V::Long(counts)));
        tags.sort_by_key(|(t, _)| *t);
        let mut fields = Vec::new();
        for (tag, v) in &tags {
            let (ty, count, data): (u16, u32, Vec<u8>) = match v {
                V::Short(s) => (3, s.len() as u32, s.iter().flat_map(|x| u16b(*x)).collect()),
                V::Long(s) => (4, s.len() as u32, s.iter().flat_map(|x| u32b(*x)).collect()),
                V::Rational(s) => (
                    5,
                    s.len() as u32,
                    s.iter()
                        .flat_map(|(n, d)| u32b(*n).into_iter().chain(u32b(*d)))
                        .collect(),
                ),
                V::SRational(s) => (
                    10,
                    s.len() as u32,
                    s.iter()
                        .flat_map(|(n, d)| u32b(*n as u32).into_iter().chain(u32b(*d as u32)))
                        .collect(),
                ),
                V::Byte(s) => (1, s.len() as u32, s.clone()),
                V::Undefined(s) => (7, s.len() as u32, s.clone()),
            };
            let field = if data.len() <= 4 {
                let mut f = data.clone();
                f.resize(4, 0);
                f
            } else {
                let at = b.len() as u32;
                b.extend(&data);
                if b.len() % 2 == 1 {
                    b.push(0);
                }
                u32b(at).to_vec()
            };
            fields.push((*tag, ty, count, field));
        }
        let ifd = b.len() as u32;
        b[link_at..link_at + 4].copy_from_slice(&u32b(ifd));
        b.extend(u16b(fields.len() as u16));
        for (tag, ty, count, field) in fields {
            b.extend(u16b(tag));
            b.extend(u16b(ty));
            b.extend(u32b(count));
            b.extend(field);
        }
        link_at = b.len();
        b.extend([0; 4]);
    }
    b
}
