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

//! Limits and robustness: a program over a limit is refused with the
//! limit's name; random token streams and bytes never panic.

use crate::eps;
use paged_ps::{Error, LimitKind, Limits, Options};

fn with(limits: Limits) -> Options<'static> {
    Options {
        limits,
        fonts: None,
    }
}

#[test]
fn limits_are_enforced_by_name__feat__images_graphics_eps_postscript() {
    let small = Limits {
        max_operations: 100_000,
        ..Limits::default()
    };
    assert_eq!(
        paged_ps::interpret(&eps("{} loop"), &with(small.clone())),
        Err(Error::Limit(LimitKind::Operations))
    );
    // stopped does not catch a limit.
    assert_eq!(
        paged_ps::interpret(&eps("{ {} loop } stopped"), &with(small)),
        Err(Error::Limit(LimitKind::Operations))
    );
    let mem = Limits {
        max_memory: 1 << 20,
        ..Limits::default()
    };
    assert_eq!(
        paged_ps::interpret(&eps("10000000 string"), &with(mem.clone())),
        Err(Error::Limit(LimitKind::Memory))
    );
    assert_eq!(
        paged_ps::interpret(&eps("{ 1000 array pop } loop"), &with(mem)),
        Err(Error::Limit(LimitKind::Memory))
    );
    assert_eq!(
        paged_ps::interpret(&eps("/f { 1 f } def f"), &Options::default()),
        Err(Error::Limit(LimitKind::Stack))
    );
    assert_eq!(
        paged_ps::interpret(&eps("/f { f 1 } def f"), &Options::default()),
        Err(Error::Limit(LimitKind::Stack))
    );
    let glyphs = "8 dict begin /FontType 3 def /FontMatrix [1 0 0 1 0 0] def /Encoding StandardEncoding def
                  /BuildChar { pop pop 0 0 moveto (A) show } def currentdict end /R exch definefont setfont 0 0 moveto (A) show";
    assert_eq!(
        paged_ps::interpret(&eps(glyphs), &Options::default()),
        Err(Error::Limit(LimitKind::Nesting))
    );
    let elements = Limits {
        max_elements: 10,
        ..Limits::default()
    };
    assert_eq!(
        paged_ps::interpret(&eps("100 { 0 0 1 1 rectfill } repeat"), &with(elements)),
        Err(Error::Limit(LimitKind::Elements))
    );
    #[cfg(not(target_arch = "wasm32"))]
    {
        let quick = Limits {
            max_time: Some(std::time::Duration::from_millis(50)),
            ..Limits::default()
        };
        assert_eq!(
            paged_ps::interpret(&eps("{ 1 pop } loop"), &with(quick)),
            Err(Error::Limit(LimitKind::Time))
        );
    }
    let msg = Error::Limit(LimitKind::Memory).to_string();
    assert!(
        msg.contains("limitcheck") && msg.contains("memory"),
        "{msg}"
    );
}

/// A deterministic generator (xorshift).
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn pick<'a>(&mut self, v: &[&'a str]) -> &'a str {
        v[(self.next() % v.len() as u64) as usize]
    }
}

const VOCAB: &[&str] = &[
    "{",
    "}",
    "[",
    "]",
    "<<",
    ">>",
    "(s)",
    "<0a>",
    "/n",
    "n",
    "1",
    "-2",
    "0.5",
    "1e3",
    "16#ff",
    "add",
    "sub",
    "mul",
    "div",
    "idiv",
    "mod",
    "exch",
    "dup",
    "pop",
    "roll",
    "index",
    "copy",
    "if",
    "ifelse",
    "for",
    "repeat",
    "loop",
    "exit",
    "stop",
    "stopped",
    "exec",
    "def",
    "begin",
    "end",
    "dict",
    "array",
    "string",
    "get",
    "put",
    "getinterval",
    "putinterval",
    "forall",
    "load",
    "where",
    "known",
    "cvx",
    "cvi",
    "cvs",
    "cvn",
    "token",
    "search",
    "bind",
    "save",
    "restore",
    "gsave",
    "grestore",
    "moveto",
    "lineto",
    "curveto",
    "arc",
    "arct",
    "closepath",
    "fill",
    "eofill",
    "stroke",
    "clip",
    "rectfill",
    "rectclip",
    "translate",
    "scale",
    "rotate",
    "concat",
    "setgray",
    "setrgbcolor",
    "setcmykcolor",
    "setcolorspace",
    "setcolor",
    "image",
    "imagemask",
    "colorimage",
    "shfill",
    "findfont",
    "scalefont",
    "setfont",
    "show",
    "stringwidth",
    "charpath",
    "definefont",
    "makepattern",
    "setpattern",
    "execform",
    "filter",
    "currentfile",
    "readstring",
    "eexec",
    "pathforall",
    "strokepath",
    "flattenpath",
    "reversepath",
    "pathbbox",
    "setdash",
    "setlinewidth",
    "matrix",
    "currentmatrix",
    "setmatrix",
    "invertmatrix",
    "packedarray",
    "cleartomark",
    "mark",
    "counttomark",
    "aload",
    "astore",
    "quit",
    "/DeviceRGB",
    "/Separation",
    "/Indexed",
    "/Helvetica",
    "/ASCII85Decode",
    "/FlateDecode",
    "/DCTDecode",
    "true",
    "false",
    "null",
    "kshow",
    "cshow",
    "xshow",
    "widthshow",
    "glyphshow",
];

fn limits() -> Options<'static> {
    with(Limits {
        max_operations: 20_000,
        max_memory: 8 << 20,
        max_time: Some(std::time::Duration::from_secs(2)),
        max_elements: 2_000,
        ..Limits::default()
    })
}

#[test]
fn random_token_streams_never_panic() {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    for _ in 0..3000 {
        let n = 1 + rng.next() % 60;
        let body: Vec<&str> = (0..n).map(|_| rng.pick(VOCAB)).collect();
        let _ = paged_ps::interpret(&eps(&body.join(" ")), &limits());
    }
}

#[test]
fn random_bytes_and_truncations_never_panic() {
    let mut rng = Rng(42);
    for _ in 0..500 {
        let n = (rng.next() % 400) as usize;
        let mut body = b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n".to_vec();
        body.extend((0..n).map(|_| rng.next() as u8));
        let _ = paged_ps::interpret(&body, &limits());
    }
    // Every prefix of a real program (font, image, shading) is safe.
    let full = eps("/DeviceRGB setcolorspace << /ImageType 1 /Width 2 /Height 2 /BitsPerComponent 8
        /ImageMatrix [2 0 0 -2 0 2] /DataSource currentfile /ASCIIHexDecode filter >> image 00ff00ff00ff00ff00ff00ff>
        << /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 1 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >> >> shfill
        currentfile eexec 0123456789abcdef");
    for k in 0..full.len() {
        let _ = paged_ps::interpret(&full[..k], &limits());
    }
}
