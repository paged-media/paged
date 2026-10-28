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

//! PostScript objects (PLRM 3.3): simple values, and the composite
//! objects (strings, arrays, dictionaries, files) that share their value
//! between copies, as the language requires: `getinterval` and `dup`
//! alias, they never copy.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::file::PsFile;
use crate::graphics::GState;
use crate::interp::OpDef;

pub type Name = Rc<str>;

/// A string value: a window onto a shared, mutable byte buffer.
#[derive(Clone)]
pub struct PsString {
    pub buf: Rc<RefCell<Vec<u8>>>,
    pub start: usize,
    pub len: usize,
}

impl PsString {
    pub fn new(bytes: Vec<u8>) -> PsString {
        let len = bytes.len();
        PsString {
            buf: Rc::new(RefCell::new(bytes)),
            start: 0,
            len,
        }
    }
    pub fn bytes(&self) -> Vec<u8> {
        self.buf.borrow()[self.start..self.start + self.len].to_vec()
    }
    pub fn with<R>(&self, f: impl FnOnce(&[u8]) -> R) -> R {
        f(&self.buf.borrow()[self.start..self.start + self.len])
    }
    pub fn get(&self, i: usize) -> Option<u8> {
        (i < self.len).then(|| self.buf.borrow()[self.start + i])
    }
    pub fn set(&self, i: usize, v: u8) -> bool {
        if i >= self.len {
            return false;
        }
        self.buf.borrow_mut()[self.start + i] = v;
        true
    }
    pub fn interval(&self, start: usize, len: usize) -> Option<PsString> {
        (start.checked_add(len)? <= self.len).then(|| PsString {
            buf: self.buf.clone(),
            start: self.start + start,
            len,
        })
    }
    pub fn text(&self) -> String {
        self.with(|b| String::from_utf8_lossy(b).into_owned())
    }
}

/// An array (or packed array) value: a window onto a shared vector.
#[derive(Clone)]
pub struct PsArray {
    pub buf: Rc<RefCell<Vec<Obj>>>,
    pub start: usize,
    pub len: usize,
    pub packed: bool,
}

impl PsArray {
    pub fn new(items: Vec<Obj>) -> PsArray {
        let len = items.len();
        PsArray {
            buf: Rc::new(RefCell::new(items)),
            start: 0,
            len,
            packed: false,
        }
    }
    pub fn get(&self, i: usize) -> Option<Obj> {
        (i < self.len).then(|| self.buf.borrow()[self.start + i].clone())
    }
    pub fn set(&self, i: usize, v: Obj) -> bool {
        if i >= self.len {
            return false;
        }
        self.buf.borrow_mut()[self.start + i] = v;
        true
    }
    pub fn items(&self) -> Vec<Obj> {
        self.buf.borrow()[self.start..self.start + self.len].to_vec()
    }
    pub fn interval(&self, start: usize, len: usize) -> Option<PsArray> {
        (start.checked_add(len)? <= self.len).then(|| PsArray {
            buf: self.buf.clone(),
            start: self.start + start,
            len,
            packed: self.packed,
        })
    }
    pub fn same(&self, other: &PsArray) -> bool {
        Rc::ptr_eq(&self.buf, &other.buf) && self.start == other.start && self.len == other.len
    }
}

/// A dictionary key: PLRM 3.3.9 compares keys by value for simple
/// objects (an integer and an equal real are one key; a string key is
/// its name) and by identity for composite ones.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub enum Key {
    Name(Name),
    Int(i64),
    Real(u64),
    Bool(bool),
    Mark,
    Ptr(usize),
    Op(&'static str),
    Font(u32),
}

pub struct DictInner {
    pub map: HashMap<Key, (Obj, Obj)>,
    pub cap: usize,
}

#[derive(Clone)]
pub struct PsDict(pub Rc<RefCell<DictInner>>);

impl PsDict {
    pub fn new(cap: usize) -> PsDict {
        PsDict(Rc::new(RefCell::new(DictInner {
            map: HashMap::new(),
            cap,
        })))
    }
    pub fn get(&self, k: &Key) -> Option<Obj> {
        self.0.borrow().map.get(k).map(|(_, v)| v.clone())
    }
    pub fn get_name(&self, n: &str) -> Option<Obj> {
        self.get(&Key::Name(Rc::from(n)))
    }
    pub fn put(&self, key: Obj, v: Obj) {
        if let Some(k) = key.key() {
            let mut inner = self.0.borrow_mut();
            inner.map.insert(k, (key.literal(), v));
            if inner.map.len() > inner.cap {
                inner.cap = inner.map.len();
            }
        }
    }
    pub fn put_name(&self, n: &str, v: Obj) {
        self.put(Obj::name(n), v);
    }
    pub fn remove(&self, k: &Key) -> bool {
        self.0.borrow_mut().map.remove(k).is_some()
    }
    pub fn len(&self) -> usize {
        self.0.borrow().map.len()
    }
    pub fn entries(&self) -> Vec<(Obj, Obj)> {
        self.0.borrow().map.values().cloned().collect()
    }
    pub fn same(&self, other: &PsDict) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

pub type FileRef = Rc<RefCell<PsFile>>;

#[derive(Clone)]
pub enum V {
    Null,
    Bool(bool),
    Int(i32),
    Real(f64),
    Mark,
    Name(Name),
    Str(PsString),
    Array(PsArray),
    Dict(PsDict),
    Op(&'static OpDef),
    File(FileRef),
    Save(u32),
    FontId(u32),
    GState(Rc<RefCell<GState>>),
}

/// An object: a value and its literal/executable attribute.
#[derive(Clone)]
pub struct Obj {
    pub v: V,
    pub exec: bool,
}

impl Obj {
    pub const NULL: Obj = Obj {
        v: V::Null,
        exec: false,
    };
    pub fn lit(v: V) -> Obj {
        Obj { v, exec: false }
    }
    pub fn int(i: i32) -> Obj {
        Obj::lit(V::Int(i))
    }
    pub fn real(r: f64) -> Obj {
        Obj::lit(V::Real(r))
    }
    pub fn bool(b: bool) -> Obj {
        Obj::lit(V::Bool(b))
    }
    pub fn name(n: &str) -> Obj {
        Obj::lit(V::Name(Rc::from(n)))
    }
    pub fn xname(n: &str) -> Obj {
        Obj {
            v: V::Name(Rc::from(n)),
            exec: true,
        }
    }
    pub fn string(b: Vec<u8>) -> Obj {
        Obj::lit(V::Str(PsString::new(b)))
    }
    pub fn array(items: Vec<Obj>) -> Obj {
        Obj::lit(V::Array(PsArray::new(items)))
    }
    pub fn proc(items: Vec<Obj>) -> Obj {
        Obj {
            v: V::Array(PsArray::new(items)),
            exec: true,
        }
    }
    pub fn dict(d: PsDict) -> Obj {
        Obj::lit(V::Dict(d))
    }
    pub fn literal(&self) -> Obj {
        Obj {
            v: self.v.clone(),
            exec: false,
        }
    }
    pub fn as_num(&self) -> Option<f64> {
        match self.v {
            V::Int(i) => Some(i as f64),
            V::Real(r) => Some(r),
            _ => None,
        }
    }
    pub fn as_int(&self) -> Option<i32> {
        match self.v {
            V::Int(i) => Some(i),
            _ => None,
        }
    }
    pub fn as_dict(&self) -> Option<&PsDict> {
        match &self.v {
            V::Dict(d) => Some(d),
            _ => None,
        }
    }
    pub fn as_array(&self) -> Option<&PsArray> {
        match &self.v {
            V::Array(a) => Some(a),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&PsString> {
        match &self.v {
            V::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_name(&self) -> Option<&Name> {
        match &self.v {
            V::Name(n) => Some(n),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self.v {
            V::Bool(b) => Some(b),
            _ => None,
        }
    }
    /// The name of this object's type (`type`).
    pub fn type_name(&self) -> &'static str {
        match &self.v {
            V::Null => "nulltype",
            V::Bool(_) => "booleantype",
            V::Int(_) => "integertype",
            V::Real(_) => "realtype",
            V::Mark => "marktype",
            V::Name(_) => "nametype",
            V::Str(_) => "stringtype",
            V::Array(a) if a.packed => "packedarraytype",
            V::Array(_) => "arraytype",
            V::Dict(_) => "dicttype",
            V::Op(_) => "operatortype",
            V::File(_) => "filetype",
            V::Save(_) => "savetype",
            V::FontId(_) => "fonttype",
            V::GState(_) => "gstatetype",
        }
    }
    /// This object as a dictionary key, or `None` for null-like values
    /// that cannot be one.
    pub fn key(&self) -> Option<Key> {
        Some(match &self.v {
            V::Name(n) => Key::Name(n.clone()),
            V::Str(s) => Key::Name(Rc::from(s.text().as_str())),
            V::Int(i) => Key::Int(*i as i64),
            V::Real(r) => {
                if r.fract() == 0.0 && r.abs() < 9.0e15 {
                    Key::Int(*r as i64)
                } else {
                    Key::Real(r.to_bits())
                }
            }
            V::Bool(b) => Key::Bool(*b),
            V::Null => return None,
            V::Mark => Key::Mark,
            V::Array(a) => Key::Ptr(Rc::as_ptr(&a.buf) as *const u8 as usize + a.start),
            V::Dict(d) => Key::Ptr(Rc::as_ptr(&d.0) as *const u8 as usize),
            V::File(f) => Key::Ptr(Rc::as_ptr(f) as *const u8 as usize),
            V::GState(g) => Key::Ptr(Rc::as_ptr(g) as *const u8 as usize),
            V::Op(o) => Key::Op(o.name),
            V::Save(s) => Key::Int(-(*s as i64) - 1_000_000),
            V::FontId(f) => Key::Font(*f),
        })
    }
    /// PLRM `eq`: numbers by value, strings and names by content,
    /// composites by identity.
    pub fn ps_eq(&self, other: &Obj) -> bool {
        match (&self.v, &other.v) {
            (V::Int(_) | V::Real(_), V::Int(_) | V::Real(_)) => self.as_num() == other.as_num(),
            (V::Str(a), V::Str(b)) => a.bytes() == b.bytes(),
            (V::Name(a), V::Str(b)) | (V::Str(b), V::Name(a)) => a.as_bytes() == b.bytes(),
            (V::Name(a), V::Name(b)) => a == b,
            (V::Bool(a), V::Bool(b)) => a == b,
            (V::Null, V::Null) | (V::Mark, V::Mark) => true,
            (V::Array(a), V::Array(b)) => a.same(b),
            (V::Dict(a), V::Dict(b)) => a.same(b),
            (V::File(a), V::File(b)) => Rc::ptr_eq(a, b),
            (V::GState(a), V::GState(b)) => Rc::ptr_eq(a, b),
            (V::Op(a), V::Op(b)) => std::ptr::eq(*a, *b),
            (V::Save(a), V::Save(b)) => a == b,
            (V::FontId(a), V::FontId(b)) => a == b,
            _ => false,
        }
    }
}
