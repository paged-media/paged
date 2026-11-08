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

//! A self-contained serialisation of an annotation dictionary.
//!
//! The thread keeps the annotation it was read from (`source`, format
//! `pdf-annot`) so a later export can write it back untouched. The raw bytes
//! of a dictionary are not enough: its indirect references point into a file
//! that is not the destination, its strings may be encrypted, and its key order
//! is arbitrary. So the dictionary is written out again in plain PDF syntax:
//! keys sorted, strings as hex, indirect values resolved and inlined, the
//! keys that only make sense inside the source file (`/P`, `/Parent`, `/Popup`,
//! `/IRT`, `/AP`) and streams left out. A page with a `/Rotate` adds its angle
//! under [`ROTATE_KEY`], which a writer needs to map the rectangles onto an
//! unrotated page and never writes into a PDF.

use hayro_syntax::object::{Dict, Object};

/// Keys that name other objects of the source file, or render appearance.
const FILE_LOCAL: &[&[u8]] = &[b"P", b"Parent", b"Popup", b"IRT", b"AP", b"Next", b"Prev"];
const MAX_DEPTH: usize = 6;

/// The key the clockwise `/Rotate` of the source page is kept under, when it
/// is not 0.
pub(crate) const ROTATE_KEY: &[u8] = b"PagedSourceRotate";

/// The dictionary as PDF syntax (ASCII only), with the page's `rotate`.
pub(crate) fn dict_to_string(dict: &Dict<'_>, rotate: u32) -> String {
    let mut out = String::new();
    write_dict(dict, &mut out, 0);
    if rotate != 0 {
        out.truncate(out.len() - " >>".len());
        out.push_str(&format!(
            " /{} {rotate} >>",
            std::str::from_utf8(ROTATE_KEY).unwrap_or("")
        ));
    }
    out
}

fn write_dict(dict: &Dict<'_>, out: &mut String, depth: usize) {
    let mut keys: Vec<_> = dict
        .keys()
        .filter(|k| !FILE_LOCAL.contains(&k.as_ref()) && k.as_ref() != ROTATE_KEY)
        .collect();
    keys.sort();
    out.push_str("<<");
    for key in keys {
        if let Some(value) = dict.get::<Object<'_>>(key.as_ref()) {
            if matches!(value, Object::Stream(_)) || (depth >= MAX_DEPTH && is_nested(&value)) {
                continue;
            }
            out.push(' ');
            write_name(key.as_ref(), out);
            out.push(' ');
            write_object(&value, out, depth + 1);
        }
    }
    out.push_str(" >>");
}

fn is_nested(o: &Object<'_>) -> bool {
    matches!(o, Object::Dict(_) | Object::Array(_))
}

fn write_object(o: &Object<'_>, out: &mut String, depth: usize) {
    match o {
        Object::Null(_) | Object::Stream(_) => out.push_str("null"),
        Object::Boolean(b) => out.push_str(if *b { "true" } else { "false" }),
        Object::Number(n) => {
            let v = n.as_f64();
            if v.fract() == 0.0 && v.abs() < 1e15 {
                out.push_str(&format!("{}", v as i64));
            } else {
                out.push_str(&format!("{v}"));
            }
        }
        Object::String(s) => {
            out.push('<');
            for b in s.as_bytes() {
                out.push_str(&format!("{b:02X}"));
            }
            out.push('>');
        }
        Object::Name(n) => write_name(n.as_ref(), out),
        Object::Dict(d) => {
            if depth > MAX_DEPTH {
                out.push_str("null");
            } else {
                write_dict(d, out, depth);
            }
        }
        Object::Array(a) => {
            out.push('[');
            if depth <= MAX_DEPTH {
                for item in a.iter::<Object<'_>>() {
                    if matches!(item, Object::Stream(_)) {
                        continue;
                    }
                    out.push(' ');
                    write_object(&item, out, depth + 1);
                }
            }
            out.push_str(" ]");
        }
    }
}

fn write_name(name: &[u8], out: &mut String) {
    out.push('/');
    for &b in name {
        let regular = b.is_ascii_graphic()
            && !matches!(
                b,
                b'#' | b'/' | b'%' | b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}'
            );
        if regular {
            out.push(b as char);
        } else {
            out.push_str(&format!("#{b:02X}"));
        }
    }
}
