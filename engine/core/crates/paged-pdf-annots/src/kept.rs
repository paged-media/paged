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

//! Reading back what a comment kept (engine ADR 1055, amendment "Re-emitting a
//! kept annotation"): the `pdf-annot` source of one comment, one dictionary per
//! line, the annotation first and then the state annotations that name it.
//!
//! [`read_kept`] parses each line and reads it the way [`crate::read_pdf_comments`]
//! read the file it came from, so a writer can tell whether the comment in the
//! model still says what the annotation says (then it writes the dictionary
//! back) or was edited (then it writes the model).

use hayro_syntax::object::{Dict, FromBytes, Object};
use paged_model::{Comment, ReviewState};

use crate::source::ROTATE_KEY;
use crate::{Annot, Frame};

/// A PDF object of a kept dictionary. Strings are their bytes; a dictionary
/// keeps the order it was written in.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(Vec<u8>),
    Name(Vec<u8>),
    Array(Vec<Value>),
    Dict(Vec<(Vec<u8>, Value)>),
}

impl Value {
    /// The numbers of an array of numbers, else `None`.
    pub fn numbers(&self) -> Option<Vec<f64>> {
        let Value::Array(items) = self else {
            return None;
        };
        items
            .iter()
            .map(|v| match v {
                Value::Number(n) => Some(*n),
                _ => None,
            })
            .collect()
    }
}

/// One kept annotation dictionary.
#[derive(Debug, Clone, PartialEq)]
pub struct KeptAnnot {
    /// Its entries, without the reader's own rotation key.
    pub entries: Vec<(Vec<u8>, Value)>,
    /// `/Subtype`.
    pub subtype: String,
    /// The comment the reader makes of it (its `id` empty): text, author, dates.
    pub comment: Comment,
    /// The clockwise `/Rotate` of the page it was read from (0, 90, 180, 270).
    pub rotate: u32,
    /// `(/StateModel, /State)` of a state annotation.
    pub state: Option<(String, String)>,
    /// The sort instant of `/M`.
    pub when: Option<i64>,
}

impl KeptAnnot {
    /// The entry under `key`.
    pub fn get(&self, key: &[u8]) -> Option<&Value> {
        self.entries
            .iter()
            .find(|(k, _)| k.as_slice() == key)
            .map(|(_, v)| v)
    }
}

/// A comment's kept source: its annotation and the state annotations of it.
#[derive(Debug, Clone, PartialEq)]
pub struct Kept {
    pub annot: KeptAnnot,
    pub states: Vec<KeptAnnot>,
}

impl Kept {
    /// The review state the kept states give, as the reader decides it (the
    /// latest `/Review` state wins; `None` when there is none or it is `None`).
    pub fn review_state(&self) -> Option<ReviewState> {
        let latest = self
            .states
            .iter()
            .enumerate()
            .filter(|(_, s)| s.state.as_ref().is_some_and(|(m, _)| m == "Review"))
            .max_by_key(|(i, s)| (s.when, *i))?
            .1;
        match latest.state.as_ref()?.1.as_str() {
            "Accepted" => Some(ReviewState::Accepted),
            "Rejected" => Some(ReviewState::Rejected),
            "Cancelled" => Some(ReviewState::Cancelled),
            "Completed" => Some(ReviewState::Completed),
            _ => None,
        }
    }
}

/// The kept source `data` of a comment (format [`crate::SOURCE_FORMAT`]), or
/// `None` when a line is not a dictionary or the first line is a state.
pub fn read_kept(data: &str) -> Option<Kept> {
    let mut lines = data.lines().filter(|l| !l.trim().is_empty());
    let annot = read_one(lines.next()?)?;
    if annot.state.is_some() {
        return None;
    }
    let states = lines.map(read_one).collect::<Option<Vec<_>>>()?;
    states
        .iter()
        .all(|s| s.state.is_some())
        .then_some(Kept { annot, states })
}

fn read_one(line: &str) -> Option<KeptAnnot> {
    let dict = Dict::from_bytes(line.trim().as_bytes())?;
    let rotate = dict
        .get::<hayro_syntax::object::Number>(ROTATE_KEY)
        .map(|n| n.as_f64() as u32)
        .unwrap_or(0);
    let mut entries = Vec::new();
    for key in dict.keys() {
        if key.as_ref() == ROTATE_KEY {
            continue;
        }
        if let Some(v) = dict.get::<Object<'_>>(key.as_ref()) {
            entries.push((key.as_ref().to_vec(), value(&v)));
        }
    }
    let frame = Frame {
        x0: 0.0,
        y0: 0.0,
        w: 0.0,
        h: 0.0,
        rotate,
    };
    let a = Annot::new(dict.clone(), 0, frame);
    let state = (dict.contains_key(b"State") && dict.contains_key(b"StateModel")).then(|| {
        (
            a.string(b"StateModel").unwrap_or_default(),
            a.string(b"State").unwrap_or_default(),
        )
    });
    Some(KeptAnnot {
        entries,
        subtype: a.subtype.clone(),
        comment: a.comment(String::new(), None),
        rotate,
        state,
        when: a.when(),
    })
}

fn value(o: &Object<'_>) -> Value {
    match o {
        Object::Null(_) | Object::Stream(_) => Value::Null,
        Object::Boolean(b) => Value::Bool(*b),
        Object::Number(n) => Value::Number(n.as_f64()),
        Object::String(s) => Value::String(s.as_bytes().to_vec()),
        Object::Name(n) => Value::Name(n.as_ref().to_vec()),
        Object::Array(a) => Value::Array(a.iter::<Object<'_>>().map(|v| value(&v)).collect()),
        Object::Dict(d) => Value::Dict(
            d.keys()
                .filter_map(|k| {
                    d.get::<Object<'_>>(k.as_ref())
                        .map(|v| (k.as_ref().to_vec(), value(&v)))
                })
                .collect(),
        ),
    }
}
