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

//! Layout rules of engine ADR 1090, checked on a fixed-advance metrics
//! (every character half an em wide) so the numbers are the rules', not a font's.

use paged_math::*;

struct Half;
impl MathMetrics for Half {
    fn advance(&self, text: &str, size: f32, _v: Variant) -> f32 {
        text.chars().count() as f32 * 0.5 * size
    }
}

fn run(t: &str) -> Row {
    vec![Node::run(t)]
}
fn eq(display: bool, body: Row) -> Layout {
    layout(&Math { display, body }, &Half, 10.0)
}
fn rules(l: &Layout) -> Vec<(f32, f32, f32, f32)> {
    l.items
        .iter()
        .filter_map(|i| match i {
            Item::Rule { x, y, w, h } => Some((*x, *y, *w, *h)),
            _ => None,
        })
        .collect()
}
fn glyph(l: &Layout, t: &str) -> (f32, f32, f32) {
    l.items
        .iter()
        .find_map(|i| match i {
            Item::Glyphs {
                text, x, y, size, ..
            } if text == t => Some((*x, *y, *size)),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no glyph run {t:?} in {:?}", l.items))
}

#[test]
fn a_run_is_its_advance() {
    let l = eq(false, run("xy"));
    assert_eq!(l.width, 10.0);
    assert_eq!(glyph(&l, "xy"), (0.0, 0.0, 10.0));
}

#[test]
fn a_fraction_stacks_numerator_over_bar_over_denominator() {
    let l = eq(
        false,
        vec![Node::Frac {
            num: run("a"),
            den: run("bb"),
            kind: FracKind::Bar,
        }],
    );
    let (_, ny, nsize) = glyph(&l, "a");
    let (_, dy, _) = glyph(&l, "bb");
    let bar = rules(&l);
    assert_eq!(bar.len(), 1);
    let (bx, by, bw, bh) = bar[0];
    // Parts are set one style down.
    assert!((nsize - 7.0).abs() < 1e-4);
    // numerator baseline above the bar, denominator baseline below it
    assert!(ny < by, "numerator {ny} above bar {by}");
    assert!(dy > by + bh, "denominator {dy} below bar {}", by + bh);
    // the bar is centred on the axis (0.25 em above the baseline)
    assert!(
        (by + bh / 2.0 + 2.5).abs() < 1e-3,
        "bar centre {}",
        by + bh / 2.0
    );
    // width = the wider part (+ pad); the bar spans it
    assert_eq!(bx, 0.0);
    assert!((bw - l.width).abs() < 1e-4);
    assert!(bw >= 2.0 * 0.5 * 7.0);
    assert!(l.ascent > 0.0 && l.descent > 0.0);
}

#[test]
fn a_display_fraction_is_taller_than_an_inline_one() {
    let f = |display| {
        eq(
            display,
            vec![Node::Frac {
                num: run("a"),
                den: run("b"),
                kind: FracKind::Bar,
            }],
        )
    };
    let (d, t) = (f(true), f(false));
    assert!(d.ascent + d.descent > t.ascent + t.descent);
    // display parts are text size, inline parts script size
    assert_eq!(glyph(&d, "a").2, 10.0);
    assert_eq!(glyph(&t, "a").2, 7.0);
}

#[test]
fn a_binomial_has_no_bar() {
    let l = eq(
        false,
        vec![Node::Frac {
            num: run("n"),
            den: run("k"),
            kind: FracKind::NoBar,
        }],
    );
    assert!(rules(&l).is_empty());
    assert!(glyph(&l, "n").1 < glyph(&l, "k").1);
}

#[test]
fn a_superscript_rises_and_a_subscript_drops_in_script_size() {
    let l = eq(
        false,
        vec![Node::Script {
            base: run("x"),
            sub: Some(run("i")),
            sup: Some(run("2")),
            pre: false,
        }],
    );
    let (bx, by, bs) = glyph(&l, "x");
    let (sx, sy, ss) = glyph(&l, "2");
    let (ix, iy, _) = glyph(&l, "i");
    assert_eq!((bx, by, bs), (0.0, 0.0, 10.0));
    assert!((ss - 7.0).abs() < 1e-4);
    assert!(sy < 0.0 && iy > 0.0, "sup {sy} sub {iy}");
    assert_eq!(sx, 5.0); // right after the base
    assert_eq!(ix, 5.0);
    assert!(l.width > 5.0 + 3.5);
    // the scripts do not touch: gap of at least 4 rule thicknesses
    let gap = (iy - 7.0 * 0.7) - sy; // sub top (approx) vs sup baseline
    assert!(gap > 0.0);
}

#[test]
fn prescripts_stand_before_the_base() {
    let l = eq(
        false,
        vec![Node::Script {
            base: run("C"),
            sub: Some(run("6")),
            sup: None,
            pre: true,
        }],
    );
    assert!(glyph(&l, "6").0 < glyph(&l, "C").0);
}

#[test]
fn a_radical_encloses_its_body_with_a_bar() {
    let l = eq(
        false,
        vec![Node::Rad {
            degree: None,
            body: run("ab"),
        }],
    );
    let (bx, _, _) = glyph(&l, "ab");
    let r = rules(&l);
    assert_eq!(r.len(), 1);
    let (rx, ry, rw, _) = r[0];
    assert!((rx - bx).abs() < 1e-4, "bar starts where the body starts");
    assert!((rw - 10.0).abs() < 1e-4, "bar as wide as the body");
    assert!(ry < -7.0, "bar above the body's top");
    assert!(l.ascent > 7.0);
    assert!(l
        .items
        .iter()
        .any(|i| matches!(i, Item::Stroke { points, .. } if points.len() == 4)));
}

#[test]
fn a_radical_degree_sits_left_and_above() {
    let l = eq(
        false,
        vec![Node::Rad {
            degree: Some(run("3")),
            body: run("x"),
        }],
    );
    let (dx, dy, dsize) = glyph(&l, "3");
    let (bx, _, _) = glyph(&l, "x");
    assert!(dx < bx);
    assert!((dsize - 5.0).abs() < 1e-4, "script-script size");
    assert!(dy < 0.0);
}

#[test]
fn display_sum_puts_limits_over_and_under_and_inline_beside() {
    let sum = |display| {
        eq(
            display,
            vec![Node::Nary {
                op: '\u{2211}',
                sub: Some(run("i")),
                sup: Some(run("n")),
                limits: None,
                body: run("a"),
            }],
        )
    };
    let d = sum(true);
    let (ox, _, _) = glyph(&d, "\u{2211}");
    let (ux, uy, _) = glyph(&d, "n");
    let (lx, ly, _) = glyph(&d, "i");
    assert!(uy < ly, "upper limit above lower");
    // both limits are centred over the operator, not beside it
    let opw = 0.5 * 14.0;
    assert!((ux + 3.5 / 2.0 - (ox + opw / 2.0)).abs() < 1e-3);
    assert!((lx + 3.5 / 2.0 - (ox + opw / 2.0)).abs() < 1e-3);
    let t = sum(false);
    let (ox2, _, _) = glyph(&t, "\u{2211}");
    let (ux2, _, _) = glyph(&t, "n");
    assert!(ux2 >= ox2 + 5.0, "beside the operator");
    // the operator is larger in display style
    assert!(glyph(&d, "\u{2211}").2 > glyph(&t, "\u{2211}").2);
}

#[test]
fn an_integral_keeps_its_bounds_beside_it_in_display() {
    let l = eq(
        true,
        vec![Node::Nary {
            op: '\u{222b}',
            sub: Some(run("0")),
            sup: Some(run("1")),
            limits: None,
            body: run("f"),
        }],
    );
    let (ox, _, _) = glyph(&l, "\u{222b}");
    let (ux, _, _) = glyph(&l, "1");
    assert!(ux > ox);
}

#[test]
fn delimiters_stretch_to_their_content() {
    let tall = vec![Node::Frac {
        num: run("a"),
        den: run("b"),
        kind: FracKind::Bar,
    }];
    let d = |body: Row| {
        eq(
            true,
            vec![Node::Delim {
                open: Some('('),
                close: Some(')'),
                sep: ',',
                items: vec![body],
            }],
        )
    };
    let small = d(run("x"));
    let big = d(tall);
    let scale = |l: &Layout| {
        l.items
            .iter()
            .find_map(|i| match i {
                Item::Glyphs { text, scale_y, .. } if text == "(" => Some(*scale_y),
                _ => None,
            })
            .unwrap()
    };
    assert_eq!(scale(&small), 1.0);
    assert!(scale(&big) > 1.2, "scale {}", scale(&big));
}

#[test]
fn delimiter_items_are_separated() {
    let l = eq(
        false,
        vec![Node::Delim {
            open: Some('('),
            close: Some(')'),
            sep: ',',
            items: vec![run("a"), run("b")],
        }],
    );
    let (ax, _, _) = glyph(&l, "a");
    let (cx, _, _) = glyph(&l, ",");
    let (bx, _, _) = glyph(&l, "b");
    assert!(ax < cx && cx < bx);
}

#[test]
fn a_matrix_is_a_centred_grid() {
    let cell = |t: &str| run(t);
    let l = eq(
        true,
        vec![Node::Matrix {
            rows: vec![vec![cell("a"), cell("bbb")], vec![cell("cc"), cell("d")]],
        }],
    );
    let (ax, ay, _) = glyph(&l, "a");
    let (bx, by, _) = glyph(&l, "bbb");
    let (cx, cy, _) = glyph(&l, "cc");
    let (dx, dy, _) = glyph(&l, "d");
    assert_eq!(ay, by);
    assert_eq!(cy, dy);
    assert!(cy > ay, "second row below the first");
    // column 1 is two chars wide: `a` is centred in it, `cc` fills it
    assert!(ax > cx);
    // column 2 is three chars wide, `d` is centred in it
    assert!(dx > bx);
    // the grid straddles the axis
    // the grid's box (row 1 top .. row 2 bottom; glyphs here are 7 above, 0 below
    // the baseline) is centred on the axis, 2.5 above the baseline
    let centre = ((ay - 7.0) + cy) / 2.0;
    assert!((centre + 2.5).abs() < 1e-3, "grid centre {centre}");
}

#[test]
fn binary_operators_and_relations_are_spaced() {
    let l = eq(false, run("a+b=c"));
    let (px, _, _) = glyph(&l, "+");
    let (bx, _, _) = glyph(&l, "b");
    assert!(bx - px > 5.0, "space after +");
    let (ex, _, _) = glyph(&l, "=");
    let (cx, _, _) = glyph(&l, "c");
    assert!(cx - ex > 5.0);
    // a leading minus is a sign, not a binary operator
    let sign = eq(false, run("\u{2212}a"));
    let (sx, _, _) = glyph(&sign, "\u{2212}");
    let (ax, _, _) = glyph(&sign, "a");
    assert!((ax - sx - 5.0).abs() < 1e-3, "no space after a sign");
}

#[test]
fn accents_and_bars_sit_above_their_base() {
    let acc = eq(
        false,
        vec![Node::Accent {
            chr: '\u{0302}',
            base: run("x"),
        }],
    );
    let (_, ay, _) = glyph(&acc, "\u{0302}");
    assert!(ay <= 0.0);
    let bar = eq(
        false,
        vec![Node::Bar {
            top: true,
            base: run("x"),
        }],
    );
    let r = rules(&bar);
    assert_eq!(r.len(), 1);
    assert!(r[0].1 < -4.0);
    assert!(bar.ascent > 4.3);
}

#[test]
fn a_function_name_is_followed_by_a_thin_space() {
    let l = eq(
        false,
        vec![Node::Func {
            name: vec![Node::Run(Run {
                text: "sin".into(),
                variant: Variant::Plain,
            })],
            body: run("x"),
        }],
    );
    let (xx, _, _) = glyph(&l, "x");
    assert!(xx > 15.0);
}

#[test]
fn layout_is_deterministic() {
    let m = Math {
        display: true,
        body: vec![Node::Frac {
            num: run("a"),
            den: run("b"),
            kind: FracKind::Bar,
        }],
    };
    assert_eq!(layout(&m, &Half, 12.0), layout(&m, &Half, 12.0));
}

#[test]
fn empty_math_is_empty() {
    let l = layout(&Math::default(), &Half, 10.0);
    assert_eq!((l.width, l.ascent, l.descent), (0.0, 0.0, 0.0));
    assert!(l.items.is_empty());
}
