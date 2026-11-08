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

//! The shared Office Math (OMML) reader (engine ADR 1090).
//!
//! `m:oMath` / `m:oMathPara` appear in WordprocessingML (inside `w:p`) and in
//! DrawingML text (`a14:m` inside `mc:AlternateContent`, PowerPoint). One
//! reader turns an element into the engine's neutral math tree
//! ([`paged_math::Math`]) for both; the engine sets it.
//!
//! The reader is read-only and tolerant: an element it does not know is
//! skipped, a missing operand reads as empty. It never rewrites the markup, so
//! the part keeps its bytes on save (an equation nobody edited is carried
//! through verbatim by [`crate::splice`]/[`crate::opc`]).

use paged_math::{FracKind, Limits, Math, Node, Row, Run, Variant};

use crate::tree::{El, Ns};

/// Every equation under `root`, in document order: each `m:oMath` of an
/// `m:oMathPara` as a display equation, a bare `m:oMath` as inline.
pub fn read_all(root: &El) -> Vec<Math> {
    let mut out = Vec::new();
    collect(root, &mut out);
    out
}

fn collect(el: &El, out: &mut Vec<Math>) {
    if el.is(Ns::M, "oMathPara") {
        out.extend(read_para(el));
    } else if el.is(Ns::M, "oMath") {
        out.push(read_math(el, false));
    } else {
        for c in &el.children {
            collect(c, out);
        }
    }
}

/// Parse an XML fragment (it must bind the `m:` prefix) and read its equations.
pub fn parse_all(xml: &str) -> Result<Vec<Math>, String> {
    Ok(read_all(&crate::tree::parse(xml.as_bytes())?))
}

/// An `m:oMathPara`: one display equation per `m:oMath` child.
pub fn read_para(el: &El) -> Vec<Math> {
    el.children_named(Ns::M, "oMath")
        .map(|m| read_math(m, true))
        .collect()
}

/// An `m:oMath`.
pub fn read_math(el: &El, display: bool) -> Math {
    Math {
        display,
        body: row(el),
    }
}

fn val(el: &El) -> Option<&str> {
    el.attr_ns(Ns::M, "val").or_else(|| el.attr("val"))
}

/// `m:xxPr/m:yy@m:val`.
fn prop<'a>(el: &'a El, pr: &str, name: &str) -> Option<&'a str> {
    el.child(Ns::M, pr)?.child(Ns::M, name).and_then(val)
}

/// A `CT_OnOff` property: absent is `None`, present without a value is true.
fn on_off(el: &El, pr: &str, name: &str) -> Option<bool> {
    let p = el.child(Ns::M, pr)?.child(Ns::M, name)?;
    Some(!matches!(val(p), Some("0" | "false" | "off")))
}

fn arg(el: &El, name: &str) -> Row {
    el.child(Ns::M, name).map(row).unwrap_or_default()
}

fn opt_arg(el: &El, name: &str) -> Option<Row> {
    el.child(Ns::M, name).map(row)
}

fn ch(s: Option<&str>) -> Option<char> {
    s.and_then(|s| s.chars().next())
}

/// The content of a slot: its child elements as nodes.
fn row(el: &El) -> Row {
    let mut out = Vec::new();
    for c in &el.children {
        if c.ns != Ns::M {
            continue;
        }
        if let Some(n) = node(c) {
            out.push(n);
        }
    }
    out
}

fn node(el: &El) -> Option<Node> {
    Some(match el.local.as_str() {
        "r" => {
            let text: String = el.children_named(Ns::M, "t").map(El::deep_text).collect();
            if text.is_empty() {
                return None;
            }
            Node::Run(Run {
                text,
                variant: variant(el),
            })
        }
        "f" => Node::Frac {
            num: arg(el, "num"),
            den: arg(el, "den"),
            kind: match prop(el, "fPr", "type") {
                Some("noBar") => FracKind::NoBar,
                Some("skw") => FracKind::Skewed,
                Some("lin") => FracKind::Linear,
                _ => FracKind::Bar,
            },
        },
        "sSub" => scripts(el, true, false, false),
        "sSup" => scripts(el, false, true, false),
        "sSubSup" => scripts(el, true, true, false),
        "sPre" => scripts(el, true, true, true),
        "rad" => {
            let hide = on_off(el, "radPr", "degHide").unwrap_or(false);
            let degree = if hide { None } else { opt_arg(el, "deg") };
            Node::Rad {
                degree: degree.filter(|d| !d.is_empty()),
                body: arg(el, "e"),
            }
        }
        "nary" => {
            let sub_hide = on_off(el, "naryPr", "subHide").unwrap_or(false);
            let sup_hide = on_off(el, "naryPr", "supHide").unwrap_or(false);
            let non_empty = |r: Option<Row>, hide: bool| r.filter(|r| !hide && !r.is_empty());
            Node::Nary {
                // Word's default operator is the integral.
                op: ch(prop(el, "naryPr", "chr")).unwrap_or('\u{222b}'),
                sub: non_empty(opt_arg(el, "sub"), sub_hide),
                sup: non_empty(opt_arg(el, "sup"), sup_hide),
                limits: match prop(el, "naryPr", "limLoc") {
                    Some("undOvr") => Some(Limits::UnderOver),
                    Some("subSup") => Some(Limits::SideScripts),
                    _ => None,
                },
                body: arg(el, "e"),
            }
        }
        "d" => {
            // An empty `m:val` means "no delimiter"; an absent property is
            // the default ( | ).
            let chr = |name: &str, default: char| -> Option<char> {
                match el.child(Ns::M, "dPr").and_then(|p| p.child(Ns::M, name)) {
                    Some(e) => ch(val(e)),
                    None => Some(default),
                }
            };
            Node::Delim {
                open: chr("begChr", '('),
                close: chr("endChr", ')'),
                sep: chr("sepChr", '|').unwrap_or('|'),
                items: el.children_named(Ns::M, "e").map(row).collect(),
            }
        }
        "m" => Node::Matrix {
            rows: el
                .children_named(Ns::M, "mr")
                .map(|r| r.children_named(Ns::M, "e").map(row).collect())
                .collect(),
        },
        "func" => Node::Func {
            name: arg(el, "fName"),
            body: arg(el, "e"),
        },
        "acc" => Node::Accent {
            chr: ch(prop(el, "accPr", "chr")).unwrap_or('\u{0302}'),
            base: arg(el, "e"),
        },
        "bar" => Node::Bar {
            // The default position is the bottom.
            top: prop(el, "barPr", "pos") == Some("top"),
            base: arg(el, "e"),
        },
        "limLow" | "limUpp" => Node::Limit {
            base: arg(el, "e"),
            lim: arg(el, "lim"),
            upper: el.local == "limUpp",
        },
        "eqArr" => Node::EqArr {
            rows: el.children_named(Ns::M, "e").map(row).collect(),
        },
        "box" | "borderBox" | "groupChr" => Node::Group { body: arg(el, "e") },
        "phantom" => {
            // Shown only when `m:show` says so; an invisible phantom still
            // takes room in Word, which the engine does not model yet.
            if on_off(el, "phantPr", "show") == Some(true) {
                Node::Group { body: arg(el, "e") }
            } else {
                return None;
            }
        }
        // `m:oMath` nested in a slot (rare), the properties and anything new.
        "oMath" => Node::Group { body: row(el) },
        _ => return None,
    })
}

fn scripts(el: &El, sub: bool, sup: bool, pre: bool) -> Node {
    Node::Script {
        base: arg(el, "e"),
        sub: if sub { opt_arg(el, "sub") } else { None },
        sup: if sup { opt_arg(el, "sup") } else { None },
        pre,
    }
}

/// The run's typeface variant from `m:rPr` (`m:sty`, `m:scr`, `m:nor`).
fn variant(r: &El) -> Variant {
    let Some(pr) = r.child(Ns::M, "rPr") else {
        return Variant::Italic;
    };
    if pr.child(Ns::M, "nor").is_some_and(|n| val(n) != Some("0")) {
        return Variant::Plain;
    }
    let sty = pr.child(Ns::M, "sty").and_then(val);
    match pr.child(Ns::M, "scr").and_then(val) {
        Some("script") => return Variant::Script,
        Some("fraktur") => return Variant::Fraktur,
        Some("double-struck") => return Variant::DoubleStruck,
        Some("sans-serif") => return Variant::SansSerif,
        Some("monospace") => return Variant::Monospace,
        _ => {}
    }
    match sty {
        Some("p") => Variant::Plain,
        Some("b") => Variant::Bold,
        Some("bi") => Variant::BoldItalic,
        _ => Variant::Italic,
    }
}
