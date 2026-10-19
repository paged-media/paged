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

//! A serde `Serializer` that feeds a value straight into a BLAKE3 hasher,
//! for [`Document::canonical_hash`](crate::Document::canonical_hash).
//!
//! The hash covers every serialized field of the document (finding CLI-6:
//! the hand-picked hash it replaces missed fills, ovals, swatches and
//! more), without building a JSON copy of it: an embedded image is hashed
//! as its bytes, not as a JSON array of numbers.
//!
//! A map is hashed independent of its iteration order: the model keeps
//! several `HashMap`s, whose order differs between two loads of the same
//! bytes. Each entry is hashed on its own, and the map folds the sorted
//! entry digests. Everything else streams in declaration order, every
//! value behind a tag byte and every variable-length item behind its
//! length, so two different values cannot hash alike by concatenation.

use serde::ser::{self, Serialize};

/// Hash `value` canonically into `h`.
pub(crate) fn hash_into<T: Serialize + ?Sized>(h: &mut blake3::Hasher, value: &T) {
    // The hasher never fails; a value whose `Serialize` reports a custom
    // error still hashes what it wrote, plus the error's text.
    let mut out = Hasher::new(h);
    if let Err(Error(msg)) = value.serialize(&mut out) {
        out.bytes(b"\0err\0");
        out.bytes(msg.as_bytes());
    }
    out.flush();
}

/// One map entry's digest (its own hasher, so the map can sort them).
fn digest_of<T: Serialize + ?Sized>(key: &mut blake3::Hasher, value: &T) -> Result<(), Error> {
    let mut out = Hasher::new(key);
    let r = value.serialize(&mut out);
    out.flush();
    r
}

#[derive(Debug)]
pub(crate) struct Error(String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Error {}
impl ser::Error for Error {
    fn custom<T: std::fmt::Display>(msg: T) -> Self {
        Error(msg.to_string())
    }
}

/// The serializer's sink: small writes collect in a buffer and reach the
/// hasher in large blocks (BLAKE3's per-call overhead dominates a stream of
/// one-byte tags otherwise).
struct Hasher<'a> {
    h: &'a mut blake3::Hasher,
    buf: Vec<u8>,
}

const BLOCK: usize = 64 * 1024;

impl<'a> Hasher<'a> {
    fn new(h: &'a mut blake3::Hasher) -> Self {
        Hasher { h, buf: Vec::new() }
    }
    fn bytes(&mut self, b: &[u8]) {
        if b.len() >= BLOCK {
            self.flush();
            self.h.update(b);
            return;
        }
        if self.buf.len() + b.len() > BLOCK {
            self.flush();
        }
        self.buf.extend_from_slice(b);
    }
    fn flush(&mut self) {
        if !self.buf.is_empty() {
            self.h.update(&self.buf);
            self.buf.clear();
        }
    }
    fn tag(&mut self, t: u8) {
        self.bytes(&[t]);
    }
    fn len(&mut self, n: usize) {
        self.bytes(&(n as u64).to_le_bytes());
    }
    fn str(&mut self, s: &str) {
        self.len(s.len());
        self.bytes(s.as_bytes());
    }
}

type R = Result<(), Error>;

impl<'a, 'b> ser::Serializer for &'a mut Hasher<'b> {
    type Ok = ();
    type Error = Error;
    type SerializeSeq = Seq<'a, 'b>;
    type SerializeTuple = Seq<'a, 'b>;
    type SerializeTupleStruct = Seq<'a, 'b>;
    type SerializeTupleVariant = Seq<'a, 'b>;
    type SerializeMap = Map<'a, 'b>;
    type SerializeStruct = Seq<'a, 'b>;
    type SerializeStructVariant = Seq<'a, 'b>;

    fn serialize_bool(self, v: bool) -> R {
        self.tag(1);
        self.bytes(&[v as u8]);
        Ok(())
    }
    fn serialize_i8(self, v: i8) -> R {
        self.serialize_i64(v.into())
    }
    fn serialize_i16(self, v: i16) -> R {
        self.serialize_i64(v.into())
    }
    fn serialize_i32(self, v: i32) -> R {
        self.serialize_i64(v.into())
    }
    fn serialize_i64(self, v: i64) -> R {
        self.tag(2);
        self.bytes(&v.to_le_bytes());
        Ok(())
    }
    fn serialize_u8(self, v: u8) -> R {
        self.serialize_u64(v.into())
    }
    fn serialize_u16(self, v: u16) -> R {
        self.serialize_u64(v.into())
    }
    fn serialize_u32(self, v: u32) -> R {
        self.serialize_u64(v.into())
    }
    fn serialize_u64(self, v: u64) -> R {
        self.tag(3);
        self.bytes(&v.to_le_bytes());
        Ok(())
    }
    fn serialize_f32(self, v: f32) -> R {
        self.tag(4);
        self.bytes(&v.to_bits().to_le_bytes());
        Ok(())
    }
    fn serialize_f64(self, v: f64) -> R {
        self.tag(5);
        self.bytes(&v.to_bits().to_le_bytes());
        Ok(())
    }
    fn serialize_char(self, v: char) -> R {
        self.tag(6);
        self.bytes(&u32::from(v).to_le_bytes());
        Ok(())
    }
    fn serialize_str(self, v: &str) -> R {
        self.tag(7);
        self.str(v);
        Ok(())
    }
    fn serialize_bytes(self, v: &[u8]) -> R {
        self.tag(8);
        self.len(v.len());
        self.bytes(v);
        Ok(())
    }
    fn serialize_none(self) -> R {
        self.tag(9);
        Ok(())
    }
    fn serialize_some<T: Serialize + ?Sized>(self, value: &T) -> R {
        self.tag(10);
        value.serialize(self)
    }
    fn serialize_unit(self) -> R {
        self.tag(11);
        Ok(())
    }
    fn serialize_unit_struct(self, _name: &'static str) -> R {
        self.serialize_unit()
    }
    fn serialize_unit_variant(self, _name: &'static str, _index: u32, variant: &'static str) -> R {
        self.tag(12);
        self.str(variant);
        Ok(())
    }
    fn serialize_newtype_struct<T: Serialize + ?Sized>(self, _name: &'static str, value: &T) -> R {
        value.serialize(self)
    }
    fn serialize_newtype_variant<T: Serialize + ?Sized>(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        value: &T,
    ) -> R {
        self.tag(13);
        self.str(variant);
        value.serialize(self)
    }
    fn serialize_seq(self, len: Option<usize>) -> Result<Seq<'a, 'b>, Error> {
        self.tag(14);
        Ok(Seq::open(self, len))
    }
    fn serialize_tuple(self, len: usize) -> Result<Seq<'a, 'b>, Error> {
        self.serialize_seq(Some(len))
    }
    fn serialize_tuple_struct(self, _name: &'static str, len: usize) -> Result<Seq<'a, 'b>, Error> {
        self.serialize_seq(Some(len))
    }
    fn serialize_tuple_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        len: usize,
    ) -> Result<Seq<'a, 'b>, Error> {
        self.tag(15);
        self.str(variant);
        self.serialize_seq(Some(len))
    }
    fn serialize_map(self, _len: Option<usize>) -> Result<Map<'a, 'b>, Error> {
        self.tag(16);
        Ok(Map {
            out: self,
            entries: Vec::new(),
            key: None,
        })
    }
    fn serialize_struct(self, _name: &'static str, _len: usize) -> Result<Seq<'a, 'b>, Error> {
        self.tag(17);
        Ok(Seq::open(self, None))
    }
    fn serialize_struct_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        _len: usize,
    ) -> Result<Seq<'a, 'b>, Error> {
        self.tag(18);
        self.str(variant);
        Ok(Seq::open(self, None))
    }
}

/// A sequence, tuple or struct: elements in order, closed by their count
/// (a struct's skipped fields make its length unknown up front).
pub(crate) struct Seq<'a, 'b> {
    out: &'a mut Hasher<'b>,
    count: usize,
}

impl<'a, 'b> Seq<'a, 'b> {
    fn open(out: &'a mut Hasher<'b>, _len: Option<usize>) -> Self {
        Seq { out, count: 0 }
    }
    fn element<T: Serialize + ?Sized>(&mut self, value: &T) -> R {
        self.count += 1;
        value.serialize(&mut *self.out)
    }
    fn close(self) -> R {
        self.out.tag(19);
        self.out.len(self.count);
        Ok(())
    }
}

impl ser::SerializeSeq for Seq<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> R {
        self.element(value)
    }
    fn end(self) -> R {
        self.close()
    }
}
impl ser::SerializeTuple for Seq<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> R {
        self.element(value)
    }
    fn end(self) -> R {
        self.close()
    }
}
impl ser::SerializeTupleStruct for Seq<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> R {
        self.element(value)
    }
    fn end(self) -> R {
        self.close()
    }
}
impl ser::SerializeTupleVariant for Seq<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> R {
        self.element(value)
    }
    fn end(self) -> R {
        self.close()
    }
}
impl ser::SerializeStruct for Seq<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, key: &'static str, value: &T) -> R {
        self.out.str(key);
        self.element(value)
    }
    fn skip_field(&mut self, key: &'static str) -> R {
        // A skipped field and an absent one hash alike, so a
        // `skip_serializing_if` default equals the field left out.
        let _ = key;
        Ok(())
    }
    fn end(self) -> R {
        self.close()
    }
}
impl ser::SerializeStructVariant for Seq<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, key: &'static str, value: &T) -> R {
        self.out.str(key);
        self.element(value)
    }
    fn end(self) -> R {
        self.close()
    }
}

/// A map: each entry hashed on its own, the sorted entry digests folded
/// on `end`, so the map's iteration order does not reach the hash.
pub(crate) struct Map<'a, 'b> {
    out: &'a mut Hasher<'b>,
    entries: Vec<[u8; 32]>,
    key: Option<blake3::Hasher>,
}

impl ser::SerializeMap for Map<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_key<T: Serialize + ?Sized>(&mut self, key: &T) -> R {
        let mut h = blake3::Hasher::new();
        digest_of(&mut h, key)?;
        h.update(b"\0=");
        self.key = Some(h);
        Ok(())
    }
    fn serialize_value<T: Serialize + ?Sized>(&mut self, value: &T) -> R {
        let mut h = self
            .key
            .take()
            .ok_or_else(|| Error("a map value without its key".into()))?;
        digest_of(&mut h, value)?;
        self.entries.push(*h.finalize().as_bytes());
        Ok(())
    }
    fn end(mut self) -> R {
        self.entries.sort_unstable();
        self.out.len(self.entries.len());
        for e in &self.entries {
            self.out.bytes(e);
        }
        Ok(())
    }
}
