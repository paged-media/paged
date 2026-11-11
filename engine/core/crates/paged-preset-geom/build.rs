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
//! Compiles ECMA-376 Annex D (`data/presetShapeDefinitions.xml`) into a
//! static Rust table (`$OUT_DIR/presets.rs`), so the 187 preset programs
//! ship as data and no XML reader or XML text is in the binary (engine
//! ADR 1096).
//!
//! The file is a fixed shape: elements with double-quoted attributes, no
//! text, entities or comments. The reader here takes exactly that and
//! panics on anything else, so a changed file fails the build rather than
//! a preset silently. It reads the elements `dml_geom::read` reads, with
//! the same defaults; `dml-geom`'s `the_table_is_annex_d` test compares
//! the two for every preset.

use std::fmt::Write as _;
use std::path::PathBuf;

struct El {
    name: String,
    attrs: Vec<(String, String)>,
    children: Vec<El>,
}

impl El {
    fn attr(&self, k: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.as_str())
    }
    fn child(&self, name: &str) -> Option<&El> {
        self.children.iter().find(|c| c.name == name)
    }
    fn named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a El> + 'a {
        self.children.iter().filter(move |c| c.name == name)
    }
}

struct Reader<'a> {
    s: &'a [u8],
    i: usize,
}

impl Reader<'_> {
    fn skip_ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }
    fn starts(&self, p: &str) -> bool {
        self.s[self.i..].starts_with(p.as_bytes())
    }
    fn name(&mut self) -> String {
        let st = self.i;
        while self.i < self.s.len() {
            let c = self.s[self.i];
            if c.is_ascii_whitespace() || c == b'/' || c == b'>' || c == b'=' {
                break;
            }
            self.i += 1;
        }
        let raw = std::str::from_utf8(&self.s[st..self.i]).unwrap();
        // Local name (the file uses the default namespace only).
        raw.rsplit(':').next().unwrap().to_string()
    }
    fn element(&mut self) -> El {
        self.skip_ws();
        assert!(self.starts("<"), "element expected at byte {}", self.i);
        self.i += 1;
        let name = self.name();
        let mut attrs = Vec::new();
        loop {
            self.skip_ws();
            if self.starts("/>") {
                self.i += 2;
                return El {
                    name,
                    attrs,
                    children: Vec::new(),
                };
            }
            if self.starts(">") {
                self.i += 1;
                break;
            }
            let k = self.name();
            self.skip_ws();
            assert!(self.starts("=\""), "attribute value expected at {}", self.i);
            self.i += 2;
            let st = self.i;
            while self.s[self.i] != b'"' {
                self.i += 1;
            }
            let v = std::str::from_utf8(&self.s[st..self.i]).unwrap();
            assert!(!v.contains('&'), "entities are not expected: {v}");
            self.i += 1;
            if k != "xmlns" {
                attrs.push((k, v.to_string()));
            }
        }
        let mut children = Vec::new();
        loop {
            self.skip_ws();
            if self.starts("</") {
                self.i += 2;
                let end = self.name();
                assert_eq!(end, name, "mismatched end tag");
                self.skip_ws();
                assert!(self.starts(">"));
                self.i += 1;
                return El {
                    name,
                    attrs,
                    children,
                };
            }
            children.push(self.element());
        }
    }
}

fn lit(out: &mut String, s: &str) {
    write!(out, "{s:?}").unwrap();
}

fn pair(out: &mut String, a: &str, b: &str) {
    out.push('(');
    lit(out, a);
    out.push(',');
    lit(out, b);
    out.push(')');
}

fn point(p: &El) -> (String, String) {
    (
        p.attr("x").unwrap_or("0").to_string(),
        p.attr("y").unwrap_or("0").to_string(),
    )
}

fn guides(out: &mut String, el: Option<&El>) {
    out.push('&');
    out.push('[');
    if let Some(l) = el {
        for g in l.named("gd") {
            pair(
                out,
                g.attr("name").unwrap_or(""),
                g.attr("fmla").unwrap_or(""),
            );
            out.push(',');
        }
    }
    out.push(']');
}

fn handle_ref(out: &mut String, h: &El, guide: &str, min: &str, max: &str) {
    match h.attr(guide) {
        None => out.push_str("None"),
        Some(g) => {
            out.push_str("Some(R(");
            lit(out, g);
            out.push(',');
            lit(out, h.attr(min).unwrap_or("-2147483647"));
            out.push(',');
            lit(out, h.attr(max).unwrap_or("2147483647"));
            out.push_str("))");
        }
    }
}

fn shape(out: &mut String, el: &El) {
    out.push_str("P{name:");
    lit(out, &el.name);
    out.push_str(",av:");
    guides(out, el.child("avLst"));
    out.push_str(",gd:");
    guides(out, el.child("gdLst"));
    out.push_str(",paths:&[");
    if let Some(l) = el.child("pathLst") {
        for p in l.named("path") {
            let num = |k: &str| {
                p.attr(k)
                    .and_then(|v| v.trim().parse::<i64>().ok())
                    .map_or("None".to_string(), |v| format!("Some({v})"))
            };
            write!(out, "Q{{w:{},h:{},fill:", num("w"), num("h")).unwrap();
            match p.attr("fill") {
                None => out.push_str("None"),
                Some(f) => {
                    out.push_str("Some(");
                    lit(out, f);
                    out.push(')');
                }
            }
            let stroke = p
                .attr("stroke")
                .map(|v| matches!(v.trim(), "1" | "true"))
                .unwrap_or(true);
            write!(out, ",stroke:{stroke},cmds:&[").unwrap();
            for c in &p.children {
                let ps: Vec<(String, String)> = c.named("pt").map(point).collect();
                match c.name.as_str() {
                    "moveTo" | "lnTo" => {
                        let Some((x, y)) = ps.first() else { continue };
                        out.push_str(if c.name == "moveTo" { "C::M" } else { "C::L" });
                        pair(out, x, y);
                    }
                    "arcTo" => {
                        out.push_str("C::A(");
                        for k in ["wR", "hR", "stAng", "swAng"] {
                            lit(out, c.attr(k).unwrap_or("0"));
                            out.push(',');
                        }
                        out.push(')');
                    }
                    "quadBezTo" if ps.len() >= 2 => {
                        out.push_str("C::Q([");
                        for (x, y) in &ps[..2] {
                            pair(out, x, y);
                            out.push(',');
                        }
                        out.push_str("])");
                    }
                    "cubicBezTo" if ps.len() >= 3 => {
                        out.push_str("C::B([");
                        for (x, y) in &ps[..3] {
                            pair(out, x, y);
                            out.push(',');
                        }
                        out.push_str("])");
                    }
                    "close" => out.push_str("C::Z"),
                    _ => continue,
                }
                out.push(',');
            }
            out.push_str("]},");
        }
    }
    out.push_str("],ah:&[");
    if let Some(l) = el.child("ahLst") {
        for h in &l.children {
            let Some(pos) = h.child("pos").map(point) else {
                continue;
            };
            match h.name.as_str() {
                "ahXY" => {
                    out.push_str("H::Xy(");
                    handle_ref(out, h, "gdRefX", "minX", "maxX");
                    out.push(',');
                    handle_ref(out, h, "gdRefY", "minY", "maxY");
                }
                "ahPolar" => {
                    out.push_str("H::Polar(");
                    handle_ref(out, h, "gdRefR", "minR", "maxR");
                    out.push(',');
                    handle_ref(out, h, "gdRefAng", "minAng", "maxAng");
                }
                _ => continue,
            }
            out.push(',');
            pair(out, &pos.0, &pos.1);
            out.push_str("),");
        }
    }
    out.push_str("],cxn:&[");
    if let Some(l) = el.child("cxnLst") {
        for c in l.named("cxn") {
            let Some(pos) = c.child("pos").map(point) else {
                continue;
            };
            out.push('(');
            lit(out, c.attr("ang").unwrap_or("0"));
            out.push(',');
            pair(out, &pos.0, &pos.1);
            out.push_str("),");
        }
    }
    out.push_str("],rect:");
    match el.child("rect") {
        None => out.push_str("None"),
        Some(r) => {
            out.push_str("Some([");
            for k in ["l", "t", "r", "b"] {
                lit(out, r.attr(k).unwrap_or("0"));
                out.push(',');
            }
            out.push_str("])");
        }
    }
    out.push_str("},\n");
}

fn main() {
    let src = "data/presetShapeDefinitions.xml";
    println!("cargo:rerun-if-changed={src}");
    println!("cargo:rerun-if-changed=build.rs");
    let xml = std::fs::read_to_string(src).expect("preset definitions");
    let mut body = xml.as_str();
    if let Some(i) = body.find("?>") {
        body = &body[i + 2..];
    }
    let root = Reader {
        s: body.as_bytes(),
        i: 0,
    }
    .element();
    let mut shapes: Vec<&El> = root.children.iter().collect();
    shapes.sort_by(|a, b| a.name.cmp(&b.name));
    let mut out = String::new();
    writeln!(
        out,
        "// Generated by build.rs from data/presetShapeDefinitions.xml. Do not edit.\n\
         pub(crate) static PRESETS: [P; {}] = [",
        shapes.len()
    )
    .unwrap();
    for s in shapes {
        shape(&mut out, s);
    }
    out.push_str("];\n");
    let dest = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("presets.rs");
    std::fs::write(dest, out).unwrap();
}
