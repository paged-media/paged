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

//! The descriptor WRITER — the inverse of [`crate::descriptor`]'s reader,
//! for blocks the layer model constructs (a type layer's `TySh`, written
//! back after an edit; WP5.10). A block read from a file and left alone
//! is still re-emitted from its source bytes (the lazy-verbatim guard);
//! this is the canonical encoding of a constructed or edited tree.
//!
//! Conventions, as the reader expects them (Adobe Photoshop File Formats
//! Specification, "Descriptor structure"): a key or class id of exactly
//! four bytes that was read in the legacy form is written with a zero
//! length; any other key with its byte length. Unicode strings carry
//! their trailing NUL in the count, as Photoshop writes them.

use crate::descriptor::{Descriptor, DescriptorValue, Key, RefItem, DESCRIPTOR_VERSION};
use crate::writer::ByteWriter;

/// The `version + descriptor` wrapper (version 16).
pub fn write_versioned_descriptor(w: &mut ByteWriter, d: &Descriptor) {
    w.u32(DESCRIPTOR_VERSION);
    write_descriptor(w, d);
}

/// Class name, class id, item count, items.
pub fn write_descriptor(w: &mut ByteWriter, d: &Descriptor) {
    write_unicode_string(w, &d.class_name);
    write_key(w, &d.class_id);
    w.u32(d.items.len() as u32);
    for (k, v) in &d.items {
        write_key(w, k);
        write_value(w, v);
    }
}

/// A `key-or-4cc`.
pub fn write_key(w: &mut ByteWriter, k: &Key) {
    let raw = k.as_bytes();
    if raw.len() == 4 && !k.is_long_form() {
        w.u32(0);
    } else {
        w.u32(raw.len() as u32);
    }
    w.bytes(raw);
}

/// A `u32` count of UTF-16 code units (the trailing NUL included), then
/// the big-endian units.
pub fn write_unicode_string(w: &mut ByteWriter, s: &str) {
    let units: Vec<u16> = s.encode_utf16().chain(std::iter::once(0)).collect();
    w.u32(units.len() as u32);
    for u in units {
        w.u16(u);
    }
}

/// One OSType-tagged value.
pub fn write_value(w: &mut ByteWriter, v: &DescriptorValue) {
    w.fourcc(v.ostype());
    match v {
        DescriptorValue::Descriptor(d) | DescriptorValue::GlobalObject(d) => write_descriptor(w, d),
        DescriptorValue::List(items) => {
            w.u32(items.len() as u32);
            for item in items {
                write_value(w, item);
            }
        }
        DescriptorValue::Double(x) => w.u64(x.to_bits()),
        DescriptorValue::UnitFloat { unit, value } => {
            w.fourcc(*unit);
            w.u64(value.to_bits());
        }
        DescriptorValue::Text(s) => write_unicode_string(w, s),
        DescriptorValue::Enum { type_key, value } => {
            write_key(w, type_key);
            write_key(w, value);
        }
        DescriptorValue::Integer(i) => w.i32(*i),
        DescriptorValue::LargeInteger(i) => w.u64(*i as u64),
        DescriptorValue::Bool(b) => w.u8(u8::from(*b)),
        DescriptorValue::Class { name, id } => {
            write_unicode_string(w, name);
            write_key(w, id);
        }
        DescriptorValue::Alias(b) | DescriptorValue::RawData(b) | DescriptorValue::Path(b) => {
            w.u32(b.len() as u32);
            w.bytes(b);
        }
        DescriptorValue::Reference(items) => {
            w.u32(items.len() as u32);
            for item in items {
                write_ref_item(w, item);
            }
        }
        DescriptorValue::ObjectArray(d) => {
            w.u32(DESCRIPTOR_VERSION);
            write_descriptor(w, d);
        }
        DescriptorValue::UnitFloats { unit, values } => {
            w.fourcc(*unit);
            w.u32(values.len() as u32);
            for x in values {
                w.u64(x.to_bits());
            }
        }
    }
}

fn write_ref_item(w: &mut ByteWriter, item: &RefItem) {
    match item {
        RefItem::Property { name, class, key } => {
            w.fourcc(*b"prop");
            write_unicode_string(w, name);
            write_key(w, class);
            write_key(w, key);
        }
        RefItem::Class { name, class } => {
            w.fourcc(*b"Clss");
            write_unicode_string(w, name);
            write_key(w, class);
        }
        RefItem::Enumerated {
            name,
            class,
            type_key,
            value,
        } => {
            w.fourcc(*b"Enmr");
            write_unicode_string(w, name);
            write_key(w, class);
            write_key(w, type_key);
            write_key(w, value);
        }
        RefItem::Offset {
            name,
            class,
            offset,
        } => {
            w.fourcc(*b"rele");
            write_unicode_string(w, name);
            write_key(w, class);
            w.u32(*offset);
        }
        RefItem::Identifier(id) => {
            w.fourcc(*b"Idnt");
            w.u32(*id);
        }
        RefItem::Index(i) => {
            w.fourcc(*b"indx");
            w.u32(*i);
        }
        RefItem::Name { name, class, value } => {
            w.fourcc(*b"name");
            write_unicode_string(w, name);
            write_key(w, class);
            write_unicode_string(w, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::descriptor::read_versioned_descriptor;
    use crate::reader::ByteReader;

    #[test]
    fn a_written_descriptor_reads_back_as_the_same_tree() {
        let inner = Descriptor {
            class_name: String::new(),
            class_id: Key::four(b"RGBC"),
            items: vec![
                (Key::four(b"Rd  "), DescriptorValue::Double(12.5)),
                (
                    Key::long("warpStyle"),
                    DescriptorValue::Enum {
                        type_key: Key::long("warpStyle"),
                        value: Key::long("warpArc"),
                    },
                ),
            ],
        };
        let d = Descriptor {
            class_name: "Ünïcode".into(),
            class_id: Key::long("TxLr"),
            items: vec![
                (Key::four(b"Txt "), DescriptorValue::Text("Hi\rthere".into())),
                (Key::long("TextIndex"), DescriptorValue::Integer(-3)),
                (Key::four(b"TxMP"), DescriptorValue::Bool(true)),
                (
                    Key::four(b"Top "),
                    DescriptorValue::UnitFloat {
                        unit: *b"#Pnt",
                        value: -18.25,
                    },
                ),
                (
                    Key::long("EngineData"),
                    DescriptorValue::RawData(b"<< >>".to_vec()),
                ),
                (
                    Key::four(b"list"),
                    DescriptorValue::List(vec![
                        DescriptorValue::Descriptor(inner.clone()),
                        DescriptorValue::LargeInteger(1 << 40),
                    ]),
                ),
                (
                    Key::four(b"mesh"),
                    DescriptorValue::UnitFloats {
                        unit: *b"#Pxl",
                        values: vec![1.0, 2.5],
                    },
                ),
                (
                    Key::four(b"ref "),
                    DescriptorValue::Reference(vec![
                        RefItem::Index(4),
                        RefItem::Name {
                            name: String::new(),
                            class: Key::four(b"Lyr "),
                            value: "Type".into(),
                        },
                    ]),
                ),
            ],
        };
        let mut w = ByteWriter::new();
        write_versioned_descriptor(&mut w, &d);
        let bytes = w.into_bytes();
        let mut r = ByteReader::new(&bytes);
        let (version, back) = read_versioned_descriptor(&mut r).expect("reads");
        assert_eq!(version, DESCRIPTOR_VERSION);
        assert_eq!(back, d);
        assert_eq!(r.remaining(), 0);
    }
}
