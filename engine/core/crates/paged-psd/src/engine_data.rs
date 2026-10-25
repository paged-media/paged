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

//! The TEXT ENGINE's data (`EngineData`, the `tdta` inside a type layer's
//! `TySh` descriptor): a PostScript-like tree of dictionaries
//! (`<< /Key value … >>`), arrays (`[ … ]`), numbers, booleans, `/Names`
//! and strings in parentheses whose bytes are UTF-16BE after a `FE FF`
//! byte-order mark, with `(`, `)` and `\` escaped by a backslash.
//!
//! Provenance: the format is not in Adobe's published PSD specification;
//! its grammar here is established by OBSERVATION of Photoshop-written
//! files (the image module's recorded `text-layers` fixtures), as
//! `registry/psd-blocks.yaml` records. [`parse`] reads it into
//! [`EdValue`]; [`emit`] writes a tree back in Photoshop's own layout
//! (one entry per line, tab-indented), which [`parse`] reads back
//! unchanged.

use crate::{PsdError, Result};

/// One EngineData value.
#[derive(Debug, Clone, PartialEq)]
pub enum EdValue {
    /// `<< /Key value … >>`, in file order.
    Dict(Vec<(String, EdValue)>),
    Array(Vec<EdValue>),
    /// A number written without a decimal point.
    Int(i64),
    /// A number written with one (`1.0`, `.8`, `-18.41`).
    Float(f64),
    Bool(bool),
    /// A `( … )` string, decoded (UTF-16 after a BOM, else Latin-1).
    Str(String),
    /// A bare `/Name` in value position.
    Name(String),
}

impl EdValue {
    /// The value under `key` of a dictionary.
    pub fn get(&self, key: &str) -> Option<&EdValue> {
        match self {
            EdValue::Dict(items) => items.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// Mutable [`get`](Self::get).
    pub fn get_mut(&mut self, key: &str) -> Option<&mut EdValue> {
        match self {
            EdValue::Dict(items) => items.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// Follow a path of dictionary keys.
    pub fn at(&self, path: &[&str]) -> Option<&EdValue> {
        path.iter().try_fold(self, |v, k| v.get(k))
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            EdValue::Int(i) => Some(*i as f64),
            EdValue::Float(f) => Some(*f),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            EdValue::Int(i) => Some(*i),
            EdValue::Float(f) if f.fract() == 0.0 => Some(*f as i64),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            EdValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            EdValue::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[EdValue]> {
        match self {
            EdValue::Array(a) => Some(a),
            _ => None,
        }
    }

    /// A dictionary from `(key, value)` pairs.
    pub fn dict<'a>(items: impl IntoIterator<Item = (&'a str, EdValue)>) -> EdValue {
        EdValue::Dict(items.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }

    /// An array of floats.
    pub fn floats(values: &[f64]) -> EdValue {
        EdValue::Array(values.iter().map(|v| EdValue::Float(*v)).collect())
    }
}

/// Deepest nesting accepted (real data nests about ten deep).
const MAX_DEPTH: usize = 64;

fn malformed(detail: impl Into<String>) -> PsdError {
    PsdError::Malformed {
        section: "text engine data",
        detail: detail.into(),
    }
}

/// Parse EngineData bytes into its root value (a dictionary).
pub fn parse(bytes: &[u8]) -> Result<EdValue> {
    let mut p = Parser { b: bytes, i: 0 };
    p.ws();
    let v = p.value(0)?;
    Ok(v)
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\r' | b'\n' | 0) {
            self.i += 1;
        }
    }

    fn peek(&self, s: &[u8]) -> bool {
        self.b[self.i..].starts_with(s)
    }

    fn value(&mut self, depth: usize) -> Result<EdValue> {
        if depth > MAX_DEPTH {
            return Err(malformed("nested deeper than 64"));
        }
        self.ws();
        if self.i >= self.b.len() {
            return Err(malformed("unexpected end"));
        }
        if self.peek(b"<<") {
            self.i += 2;
            let mut items = Vec::new();
            loop {
                self.ws();
                if self.peek(b">>") {
                    self.i += 2;
                    return Ok(EdValue::Dict(items));
                }
                if self.i >= self.b.len() || self.b[self.i] != b'/' {
                    return Err(malformed(format!("expected a /Key at byte {}", self.i)));
                }
                let key = self.name();
                let v = self.value(depth + 1)?;
                items.push((key, v));
            }
        }
        match self.b[self.i] {
            b'[' => {
                self.i += 1;
                let mut out = Vec::new();
                loop {
                    self.ws();
                    if self.i >= self.b.len() {
                        return Err(malformed("unterminated array"));
                    }
                    if self.b[self.i] == b']' {
                        self.i += 1;
                        return Ok(EdValue::Array(out));
                    }
                    out.push(self.value(depth + 1)?);
                }
            }
            b'(' => self.string(),
            b'/' => Ok(EdValue::Name(self.name())),
            _ if self.peek(b"true") => {
                self.i += 4;
                Ok(EdValue::Bool(true))
            }
            _ if self.peek(b"false") => {
                self.i += 5;
                Ok(EdValue::Bool(false))
            }
            _ => self.number(),
        }
    }

    /// `/Name` (the slash consumed, the name returned).
    fn name(&mut self) -> String {
        self.i += 1;
        let start = self.i;
        while self.i < self.b.len()
            && !matches!(
                self.b[self.i],
                b' ' | b'\t' | b'\r' | b'\n' | b'/' | b'(' | b'[' | b']' | b'<' | b'>'
            )
        {
            self.i += 1;
        }
        String::from_utf8_lossy(&self.b[start..self.i]).into_owned()
    }

    fn number(&mut self) -> Result<EdValue> {
        let start = self.i;
        while self.i < self.b.len() && matches!(self.b[self.i], b'0'..=b'9' | b'.' | b'-' | b'+')
        {
            self.i += 1;
        }
        let text = std::str::from_utf8(&self.b[start..self.i]).unwrap_or("");
        if text.is_empty() {
            return Err(malformed(format!(
                "unexpected byte {:#04x} at {start}",
                self.b[start]
            )));
        }
        if text.contains('.') {
            text.parse::<f64>()
                .map(EdValue::Float)
                .map_err(|_| malformed(format!("bad number {text:?}")))
        } else {
            text.parse::<i64>()
                .map(EdValue::Int)
                .map_err(|_| malformed(format!("bad number {text:?}")))
        }
    }

    fn string(&mut self) -> Result<EdValue> {
        self.i += 1;
        let mut raw = Vec::new();
        loop {
            let Some(&c) = self.b.get(self.i) else {
                return Err(malformed("unterminated string"));
            };
            match c {
                b'\\' => {
                    let Some(&n) = self.b.get(self.i + 1) else {
                        return Err(malformed("dangling escape"));
                    };
                    raw.push(n);
                    self.i += 2;
                }
                b')' => {
                    self.i += 1;
                    break;
                }
                _ => {
                    raw.push(c);
                    self.i += 1;
                }
            }
        }
        Ok(EdValue::Str(decode_string(&raw)))
    }
}

fn decode_string(raw: &[u8]) -> String {
    if raw.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> = raw[2..]
            .chunks(2)
            .map(|c| u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        raw.iter().map(|&b| b as char).collect()
    }
}

/// Write `root` as EngineData, in Photoshop's layout.
pub fn emit(root: &EdValue) -> Vec<u8> {
    let mut out = b"\n\n".to_vec();
    write_value(&mut out, root, 0);
    out
}

fn tabs(out: &mut Vec<u8>, n: usize) {
    out.extend(std::iter::repeat_n(b'\t', n));
}

fn is_block(v: &EdValue) -> bool {
    match v {
        EdValue::Dict(_) => true,
        EdValue::Array(a) => a.iter().any(is_block),
        _ => false,
    }
}

fn write_value(out: &mut Vec<u8>, v: &EdValue, depth: usize) {
    match v {
        EdValue::Dict(items) => {
            out.extend_from_slice(b"<<\n");
            for (k, v) in items {
                tabs(out, depth + 1);
                out.push(b'/');
                out.extend_from_slice(k.as_bytes());
                if matches!(v, EdValue::Dict(_)) {
                    out.push(b'\n');
                    tabs(out, depth + 1);
                } else {
                    out.push(b' ');
                }
                write_value(out, v, depth + 1);
                out.push(b'\n');
            }
            tabs(out, depth);
            out.extend_from_slice(b">>");
        }
        EdValue::Array(a) if is_block(v) => {
            out.extend_from_slice(b"[\n");
            for item in a {
                tabs(out, depth);
                write_value(out, item, depth);
                out.push(b'\n');
            }
            tabs(out, depth);
            out.push(b']');
        }
        EdValue::Array(a) => {
            out.push(b'[');
            for item in a {
                out.push(b' ');
                write_value(out, item, depth);
            }
            out.extend_from_slice(b" ]");
        }
        EdValue::Int(i) => out.extend_from_slice(i.to_string().as_bytes()),
        EdValue::Float(f) => out.extend_from_slice(float_text(*f).as_bytes()),
        EdValue::Bool(b) => out.extend_from_slice(if *b { b"true" } else { b"false" }),
        EdValue::Name(n) => {
            out.push(b'/');
            out.extend_from_slice(n.as_bytes());
        }
        EdValue::Str(s) => {
            out.push(b'(');
            let mut raw = vec![0xFE, 0xFF];
            for u in s.encode_utf16() {
                raw.extend_from_slice(&u.to_be_bytes());
            }
            for b in raw {
                if matches!(b, b'(' | b')' | b'\\') {
                    out.push(b'\\');
                }
                out.push(b);
            }
            out.push(b')');
        }
    }
}

/// A float as Photoshop writes one: always with a decimal point, the
/// leading zero of a fraction dropped (`.8`, `-.5`, `1.0`, `26.4`).
fn float_text(f: f64) -> String {
    if !f.is_finite() {
        return "0.0".into();
    }
    let s = if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{f:.1}")
    } else {
        // Shortest round-trip form, at most six decimals.
        let t = format!("{f:.6}");
        let t = t.trim_end_matches('0');
        if t.ends_with('.') {
            format!("{t}0")
        } else {
            t.to_string()
        }
    };
    if let Some(rest) = s.strip_prefix("0.") {
        if !rest.is_empty() && rest != "0" {
            return format!(".{rest}");
        }
    }
    if let Some(rest) = s.strip_prefix("-0.") {
        if !rest.is_empty() && rest != "0" {
            return format!("-.{rest}");
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &[u8] = b"\n\n<<\n\t/EngineDict\n\t<<\n\t\t/Editor\n\t\t<<\n\t\t\t/Text (\xfe\xff\x00H\x00i\x00\\(\x00\r)\n\t\t>>\n\t\t/Runs [ 12 3 ]\n\t\t/Scale [ .8 1.0 -18.5 ]\n\t\t/On true\n\t\t/Kind /Roman\n\t\t/List [\n\t\t<<\n\t\t\t/A 1\n\t\t>>\n\t\t]\n\t>>\n>>";

    #[test]
    fn parses_photoshop_engine_data() {
        let v = parse(SAMPLE).expect("parses");
        assert_eq!(
            v.at(&["EngineDict", "Editor", "Text"]).and_then(EdValue::as_str),
            Some("Hi(\r")
        );
        let d = v.get("EngineDict").unwrap();
        assert_eq!(
            d.get("Runs").and_then(EdValue::as_array).map(|a| a.len()),
            Some(2)
        );
        assert_eq!(
            d.get("Scale").unwrap().as_array().unwrap()[0].as_f64(),
            Some(0.8)
        );
        assert_eq!(d.get("On").and_then(EdValue::as_bool), Some(true));
        assert_eq!(d.get("Kind"), Some(&EdValue::Name("Roman".into())));
        assert_eq!(
            d.get("List").unwrap().as_array().unwrap()[0]
                .get("A")
                .and_then(EdValue::as_i64),
            Some(1)
        );
    }

    #[test]
    fn emit_reads_back_as_the_same_tree() {
        let v = parse(SAMPLE).expect("parses");
        let back = parse(&emit(&v)).expect("re-parses");
        assert_eq!(back, v);
        // A string with every escaped byte survives.
        let s = EdValue::dict([("T", EdValue::Str("a(b)c\\d \u{2028}ü".into()))]);
        assert_eq!(parse(&emit(&s)).unwrap(), s);
    }

    #[test]
    fn floats_are_written_as_photoshop_writes_them() {
        assert_eq!(float_text(0.8), ".8");
        assert_eq!(float_text(1.0), "1.0");
        assert_eq!(float_text(-0.5), "-.5");
        assert_eq!(float_text(26.4), "26.4");
        assert_eq!(float_text(0.0), "0.0");
        assert_eq!(float_text(0.583), ".583");
    }

    #[test]
    fn garbage_is_refused_not_guessed() {
        assert!(parse(b"<< /A ").is_err());
        assert!(parse(b"<< A 1 >>").is_err());
        assert!(parse(b"(unterminated").is_err());
    }
}
