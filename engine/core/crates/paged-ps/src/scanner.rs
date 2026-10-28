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

//! The scanner (PLRM 3.2): bytes of a file to objects. Procedures are
//! scanned whole; `//name` is looked up as it is read.

use crate::file::{hexval, PsFile};
use crate::object::Obj;
#[cfg(test)]
use crate::object::V;

#[derive(Debug)]
pub enum ScanError {
    Syntax,
    /// `//name` named nothing.
    Undefined(String),
    /// Procedures nested past the limit.
    Nesting,
}

const MAX_PROC_DEPTH: usize = 256;

pub fn is_white(c: u8) -> bool {
    matches!(c, 0 | b'\t' | b'\n' | 0x0c | b'\r' | b' ')
}

pub fn is_delim(c: u8) -> bool {
    matches!(
        c,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
    )
}

/// The next object of `f`, or `None` at its end.
pub fn next(
    f: &mut PsFile,
    lookup: &mut dyn FnMut(&str) -> Option<Obj>,
) -> Result<Option<Obj>, ScanError> {
    match token(f, lookup, 0)? {
        Some(Tok::Obj(o)) => Ok(Some(o)),
        Some(Tok::ProcEnd) => Err(ScanError::Syntax),
        None => Ok(None),
    }
}

enum Tok {
    Obj(Obj),
    ProcEnd,
}

fn skip_white_and_comments(f: &mut PsFile) {
    while let Some(c) = f.peek() {
        if is_white(c) {
            f.read();
        } else if c == b'%' {
            while let Some(c) = f.read() {
                if c == b'\n' || c == b'\r' || c == 0x0c {
                    break;
                }
            }
        } else {
            break;
        }
    }
}

/// After a token ended by whitespace, that one character is consumed
/// (a CR LF pair counts as one), so `readstring` starts right after it.
fn eat_one_white(f: &mut PsFile) {
    if let Some(c) = f.peek() {
        if is_white(c) {
            f.read();
            if c == b'\r' && f.peek() == Some(b'\n') {
                f.read();
            }
        }
    }
}

fn token(
    f: &mut PsFile,
    lookup: &mut dyn FnMut(&str) -> Option<Obj>,
    depth: usize,
) -> Result<Option<Tok>, ScanError> {
    skip_white_and_comments(f);
    let Some(c) = f.read() else {
        return Ok(None);
    };
    let obj = match c {
        b'(' => Obj::string(literal_string(f)?),
        b'<' => match f.peek() {
            Some(b'<') => {
                f.read();
                Obj::xname("<<")
            }
            Some(b'~') => {
                f.read();
                Obj::string(ascii85_string(f)?)
            }
            _ => Obj::string(hex_string(f)?),
        },
        b'>' => {
            if f.peek() == Some(b'>') {
                f.read();
                Obj::xname(">>")
            } else {
                return Err(ScanError::Syntax);
            }
        }
        b'[' => Obj::xname("["),
        b']' => Obj::xname("]"),
        b'{' => {
            if depth >= MAX_PROC_DEPTH {
                return Err(ScanError::Nesting);
            }
            let mut items = Vec::new();
            loop {
                match token(f, lookup, depth + 1)? {
                    Some(Tok::Obj(o)) => items.push(o),
                    Some(Tok::ProcEnd) => break,
                    None => return Err(ScanError::Syntax),
                }
            }
            Obj::proc(items)
        }
        b'}' => return Ok(Some(Tok::ProcEnd)),
        b')' => return Err(ScanError::Syntax),
        b'/' => {
            let immediate = f.peek() == Some(b'/');
            if immediate {
                f.read();
            }
            let name = regular(f, Vec::new());
            let name = String::from_utf8_lossy(&name).into_owned();
            if immediate {
                lookup(&name).ok_or(ScanError::Undefined(name))?
            } else {
                Obj::name(&name)
            }
        }
        128..=159 => binary_token(f, c)?,
        _ => {
            let text = regular(f, vec![c]);
            match number(&text) {
                Some(n) => n,
                None => Obj::xname(&String::from_utf8_lossy(&text)),
            }
        }
    };
    Ok(Some(Tok::Obj(obj)))
}

/// Regular characters up to a delimiter or whitespace.
fn regular(f: &mut PsFile, mut out: Vec<u8>) -> Vec<u8> {
    while let Some(c) = f.peek() {
        if is_white(c) || is_delim(c) {
            break;
        }
        out.push(c);
        f.read();
    }
    eat_one_white(f);
    out
}

/// A number token (PLRM 3.2.2): an integer, a radix number or a real;
/// an integer too large for 32 bits becomes a real.
pub fn number(t: &[u8]) -> Option<Obj> {
    let s = std::str::from_utf8(t).ok()?;
    if s.is_empty() {
        return None;
    }
    if let Some((base, digits)) = s.split_once('#') {
        let base: u32 = base.parse().ok()?;
        if !(2..=36).contains(&base) || digits.is_empty() {
            return None;
        }
        let v = u64::from_str_radix(digits, base).ok()?;
        if v > u32::MAX as u64 {
            return None;
        }
        return Some(Obj::int(v as u32 as i32));
    }
    let bytes = s.as_bytes();
    let body = bytes
        .strip_prefix(b"+")
        .or_else(|| bytes.strip_prefix(b"-"))
        .unwrap_or(bytes);
    if body.is_empty() {
        return None;
    }
    if body.iter().all(u8::is_ascii_digit) {
        return Some(match s.parse::<i32>() {
            Ok(i) => Obj::int(i),
            Err(_) => Obj::real(s.parse::<f64>().ok()?),
        });
    }
    // A real: digits with one point and/or an exponent.
    let (mant, exp) = match body.iter().position(|&c| c == b'e' || c == b'E') {
        Some(i) => (&body[..i], Some(&body[i + 1..])),
        None => (body, None),
    };
    let points = mant.iter().filter(|&&c| c == b'.').count();
    if points > 1 || mant.iter().any(|&c| c != b'.' && !c.is_ascii_digit()) {
        return None;
    }
    if !mant.iter().any(u8::is_ascii_digit) {
        return None;
    }
    if let Some(e) = exp {
        let e = e
            .strip_prefix(b"+")
            .or_else(|| e.strip_prefix(b"-"))
            .unwrap_or(e);
        if e.is_empty() || !e.iter().all(u8::is_ascii_digit) {
            return None;
        }
    }
    s.parse::<f64>().ok().map(Obj::real)
}

fn literal_string(f: &mut PsFile) -> Result<Vec<u8>, ScanError> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    loop {
        let Some(c) = f.read() else {
            return Err(ScanError::Syntax);
        };
        match c {
            b'(' => {
                depth += 1;
                out.push(c);
            }
            b')' => {
                if depth == 0 {
                    return Ok(out);
                }
                depth -= 1;
                out.push(c);
            }
            b'\\' => {
                let Some(e) = f.read() else {
                    return Err(ScanError::Syntax);
                };
                match e {
                    b'n' => out.push(b'\n'),
                    b'r' => out.push(b'\r'),
                    b't' => out.push(b'\t'),
                    b'b' => out.push(8),
                    b'f' => out.push(0x0c),
                    b'\\' | b'(' | b')' => out.push(e),
                    b'\r' => {
                        if f.peek() == Some(b'\n') {
                            f.read();
                        }
                    }
                    b'\n' => {}
                    b'0'..=b'7' => {
                        let mut v = (e - b'0') as u32;
                        for _ in 0..2 {
                            match f.peek() {
                                Some(d @ b'0'..=b'7') => {
                                    f.read();
                                    v = v * 8 + (d - b'0') as u32;
                                }
                                _ => break,
                            }
                        }
                        out.push(v as u8);
                    }
                    _ => out.push(e),
                }
            }
            // An end of line inside a string is a newline (PLRM 3.2.2).
            b'\r' => {
                if f.peek() == Some(b'\n') {
                    f.read();
                }
                out.push(b'\n');
            }
            _ => out.push(c),
        }
    }
}

fn hex_string(f: &mut PsFile) -> Result<Vec<u8>, ScanError> {
    let mut out = Vec::new();
    let mut hi: Option<u8> = None;
    loop {
        let Some(c) = f.read() else {
            return Err(ScanError::Syntax);
        };
        if c == b'>' {
            break;
        }
        if is_white(c) {
            continue;
        }
        let v = hexval(c).ok_or(ScanError::Syntax)?;
        match hi.take() {
            None => hi = Some(v),
            Some(h) => out.push((h << 4) | v),
        }
    }
    if let Some(h) = hi {
        out.push(h << 4);
    }
    Ok(out)
}

fn ascii85_string(f: &mut PsFile) -> Result<Vec<u8>, ScanError> {
    let mut raw = Vec::new();
    loop {
        let Some(c) = f.read() else {
            return Err(ScanError::Syntax);
        };
        if c == b'~' {
            if f.read() != Some(b'>') {
                return Err(ScanError::Syntax);
            }
            break;
        }
        raw.push(c);
    }
    raw.extend_from_slice(b"~>");
    paged_raster::filters::decode("ASCII85Decode", &raw, &Default::default())
        .map(|(d, _)| d)
        .map_err(|_| ScanError::Syntax)
}

/// Binary tokens (PLRM 3.14.1) for numbers, booleans and strings. The
/// encoded system names and number arrays are refused.
fn binary_token(f: &mut PsFile, t: u8) -> Result<Obj, ScanError> {
    let mut take = |n: usize| -> Result<Vec<u8>, ScanError> {
        let mut v = Vec::with_capacity(n);
        for _ in 0..n {
            v.push(f.read().ok_or(ScanError::Syntax)?);
        }
        Ok(v)
    };
    Ok(match t {
        132 => Obj::int(i32::from_be_bytes(take(4)?.try_into().unwrap_or([0; 4]))),
        133 => Obj::int(i32::from_le_bytes(take(4)?.try_into().unwrap_or([0; 4]))),
        134 => Obj::int(i16::from_be_bytes(take(2)?.try_into().unwrap_or([0; 2])) as i32),
        135 => Obj::int(i16::from_le_bytes(take(2)?.try_into().unwrap_or([0; 2])) as i32),
        136 => Obj::int(take(1)?[0] as i8 as i32),
        137 => {
            let r = take(1)?[0];
            let (big, scale) = if r < 128 { (true, r) } else { (false, r - 128) };
            let v = if scale < 32 {
                let b: [u8; 4] = take(4)?.try_into().unwrap_or([0; 4]);
                if big {
                    i32::from_be_bytes(b)
                } else {
                    i32::from_le_bytes(b)
                }
            } else {
                let b: [u8; 2] = take(2)?.try_into().unwrap_or([0; 2]);
                (if big {
                    i16::from_be_bytes(b)
                } else {
                    i16::from_le_bytes(b)
                }) as i32
            };
            let s = scale % 32;
            if s == 0 {
                Obj::int(v)
            } else {
                Obj::real(v as f64 / (1u64 << s) as f64)
            }
        }
        138 => Obj::real(f32::from_be_bytes(take(4)?.try_into().unwrap_or([0; 4])) as f64),
        139 | 140 => Obj::real(f32::from_le_bytes(take(4)?.try_into().unwrap_or([0; 4])) as f64),
        141 => Obj::bool(take(1)?[0] != 0),
        142 => {
            let n = take(1)?[0] as usize;
            Obj::string(take(n)?)
        }
        143 => {
            let b: [u8; 2] = take(2)?.try_into().unwrap_or([0; 2]);
            Obj::string(take(u16::from_be_bytes(b) as usize)?)
        }
        144 => {
            let b: [u8; 2] = take(2)?.try_into().unwrap_or([0; 2]);
            Obj::string(take(u16::from_le_bytes(b) as usize)?)
        }
        _ => return Err(ScanError::Syntax),
    })
}

/// The bytes of `o` as it would be written back as a token, for `cvs`
/// and `==` of names and numbers (no strings or composites).
pub fn real_text(r: f64) -> String {
    if r.fract() == 0.0 && r.abs() < 1e15 {
        format!("{:.1}", r)
    } else {
        let s = format!("{}", r as f32);
        if s.contains('.') || s.contains('e') {
            s
        } else {
            format!("{s}.0")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(src: &str) -> Vec<Obj> {
        let mut f = PsFile::from_vec(src.as_bytes().to_vec());
        let mut out = Vec::new();
        while let Some(o) = next(&mut f, &mut |_| Some(Obj::int(7))).unwrap() {
            out.push(o);
        }
        out
    }

    #[test]
    fn numbers_names_and_strings() {
        let t = all("12 -3.5 1e2 16#FF 8#777 2#1010 .5 -.5e1 abc /lit (a\\(b\\)\\101) <48 69> <~9jqo^~> 99999999999");
        assert_eq!(t[0].as_int(), Some(12));
        assert_eq!(t[1].as_num(), Some(-3.5));
        assert_eq!(t[2].as_num(), Some(100.0));
        assert_eq!(t[3].as_int(), Some(255));
        assert_eq!(t[4].as_int(), Some(511));
        assert_eq!(t[5].as_int(), Some(10));
        assert_eq!(t[6].as_num(), Some(0.5));
        assert_eq!(t[7].as_num(), Some(-5.0));
        assert!(t[8].exec && t[8].as_name().is_some_and(|n| &**n == "abc"));
        assert!(!t[9].exec && t[9].as_name().is_some_and(|n| &**n == "lit"));
        assert_eq!(t[10].as_str().unwrap().bytes(), b"a(b)A");
        assert_eq!(t[11].as_str().unwrap().bytes(), b"Hi");
        assert_eq!(t[12].as_str().unwrap().bytes(), b"Man ");
        assert!(matches!(t[13].v, V::Real(_)));
    }

    #[test]
    fn procedures_nest_and_immediate_names_resolve() {
        let t = all("{ 1 { 2 } //x } [ ] << >>");
        let p = t[0].as_array().unwrap();
        assert!(t[0].exec);
        assert_eq!(p.len, 3);
        let inner = p.get(1).unwrap();
        assert!(inner.exec && inner.as_array().is_some());
        assert_eq!(p.get(2).unwrap().as_int(), Some(7));
        assert_eq!(t.len(), 5);
    }

    #[test]
    fn one_whitespace_after_a_token_is_consumed() {
        let mut f = PsFile::from_vec(b"RD  xyz".to_vec());
        let _ = next(&mut f, &mut |_| None).unwrap();
        assert_eq!(f.read(), Some(b' '));
        let mut f = PsFile::from_vec(b"RD\r\nxyz".to_vec());
        let _ = next(&mut f, &mut |_| None).unwrap();
        assert_eq!(f.read(), Some(b'x'));
    }

    #[test]
    fn malformed_input_is_a_syntax_error_not_a_panic() {
        let bad: [&[u8]; 7] = [b"(abc", b"<4", b"{ 1 2", b"}", b")", b"<~ab", b"\x95"];
        for b in bad {
            let mut f = PsFile::from_vec(b.to_vec());
            assert!(next(&mut f, &mut |_| None).is_err(), "{b:?}");
        }
    }
}
