//! The shared OMML reader (engine ADR 1090): fixtures to the neutral tree.

use paged_math::{FracKind, Limits, Node, Variant};
use paged_ooxml::omml::parse_all;

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!(
        "{}/tests/fixtures/omml/{name}.xml",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn text(r: &[Node]) -> String {
    r.iter()
        .map(|n| match n {
            Node::Run(r) => r.text.clone(),
            _ => "?".into(),
        })
        .collect()
}

#[test]
fn the_quadratic_formula_is_a_display_fraction_over_a_radical() {
    let m = parse_all(&fixture("quadratic")).unwrap();
    assert_eq!(m.len(), 1);
    assert!(m[0].display, "m:oMathPara is display");
    let Node::Run(x) = &m[0].body[0] else {
        panic!()
    };
    assert_eq!(x.text, "x=");
    assert_eq!(x.variant, Variant::Italic);
    let Node::Frac { num, den, kind } = &m[0].body[1] else {
        panic!("{:?}", m[0].body)
    };
    assert_eq!(*kind, FracKind::Bar);
    assert_eq!(text(den), "2a");
    let Node::Rad { degree, body } = &num[1] else {
        panic!("{num:?}")
    };
    assert!(degree.is_none(), "degHide drops the degree");
    assert!(
        matches!(&body[0], Node::Script { sup: Some(s), sub: None, pre: false, .. } if text(s) == "2")
    );
}

#[test]
fn an_inline_sum_keeps_limits_under_and_over() {
    let m = parse_all(&fixture("sum-limits")).unwrap();
    assert_eq!(m.len(), 1);
    assert!(!m[0].display, "a bare m:oMath is inline");
    let Node::Nary {
        op,
        sub,
        sup,
        limits,
        body,
    } = &m[0].body[0]
    else {
        panic!()
    };
    assert_eq!(*op, '\u{2211}');
    assert_eq!(text(sub.as_ref().unwrap()), "i=1");
    assert_eq!(text(sup.as_ref().unwrap()), "n");
    assert_eq!(*limits, Some(Limits::UnderOver));
    assert!(matches!(&body[0], Node::Script { sub: Some(_), .. }));
}

#[test]
fn a_matrix_in_square_brackets() {
    let m = parse_all(&fixture("matrix")).unwrap();
    let Node::Delim {
        open, close, items, ..
    } = &m[0].body[0]
    else {
        panic!()
    };
    assert_eq!((*open, *close), (Some('['), Some(']')));
    let Node::Matrix { rows } = &items[0][0] else {
        panic!()
    };
    assert_eq!(rows.len(), 2);
    assert_eq!(text(&rows[1][0]), "c");
    assert_eq!(text(&rows[1][1]), "d");
}

#[test]
fn an_integral_defaults_its_operator_and_a_function_name_is_upright() {
    let m = parse_all(&fixture("integral")).unwrap();
    let Node::Nary {
        op, limits, body, ..
    } = &m[0].body[0]
    else {
        panic!()
    };
    assert_eq!(*op, '\u{222b}', "the default operator is the integral");
    assert_eq!(*limits, None);
    let Node::Func { name, .. } = &body[0] else {
        panic!()
    };
    let Node::Run(r) = &name[0] else { panic!() };
    assert_eq!((r.text.as_str(), r.variant), ("sin", Variant::Plain));
}

#[test]
fn delimiters_default_and_empty_means_none() {
    let ns = r#"xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math""#;
    let d = |pr: &str| {
        parse_all(&format!(
            "<m:oMath {ns}><m:d>{pr}<m:e><m:r><m:t>x</m:t></m:r></m:e><m:e><m:r><m:t>y</m:t></m:r></m:e></m:d></m:oMath>"
        ))
        .unwrap()
        .remove(0)
    };
    let Node::Delim {
        open,
        close,
        sep,
        items,
    } = &d("").body[0]
    else {
        panic!()
    };
    assert_eq!(
        (*open, *close, *sep, items.len()),
        (Some('('), Some(')'), '|', 2)
    );
    let Node::Delim { open, close, .. } =
        &d(r#"<m:dPr><m:begChr m:val=""/><m:endChr m:val="|"/></m:dPr>"#).body[0]
    else {
        panic!()
    };
    assert_eq!((*open, *close), (None, Some('|')));
}

#[test]
fn run_styles_and_unknown_elements() {
    let ns = r#"xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math""#;
    let m = parse_all(&format!(
        r#"<m:oMath {ns}><m:r><m:rPr><m:sty m:val="b"/></m:rPr><m:t>B</m:t></m:r><m:r><m:rPr><m:scr m:val="double-struck"/></m:rPr><m:t>R</m:t></m:r><m:r><m:rPr><m:nor/></m:rPr><m:t>if</m:t></m:r><m:future><m:e/></m:future><m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e><m:r><m:t>z</m:t></m:r></m:e></m:bar><m:bar><m:e><m:r><m:t>w</m:t></m:r></m:e></m:bar></m:oMath>"#
    ))
    .unwrap();
    let v: Vec<_> = m[0]
        .body
        .iter()
        .map(|n| match n {
            Node::Run(r) => format!("{:?}", r.variant),
            Node::Bar { top, .. } => format!("bar:{top}"),
            _ => "?".into(),
        })
        .collect();
    assert_eq!(
        v,
        ["Bold", "DoubleStruck", "Plain", "bar:true", "bar:false"]
    );
}

#[test]
fn several_equations_read_in_document_order() {
    let ns = r#"xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math""#;
    let m = parse_all(&format!(
        r#"<root {ns}><m:oMath><m:r><m:t>a</m:t></m:r></m:oMath><m:oMathPara><m:oMath><m:r><m:t>b</m:t></m:r></m:oMath><m:oMath><m:r><m:t>c</m:t></m:r></m:oMath></m:oMathPara></root>"#
    ))
    .unwrap();
    let flags: Vec<_> = m.iter().map(|m| (text(&m.body), m.display)).collect();
    assert_eq!(
        flags,
        [("a".into(), false), ("b".into(), true), ("c".into(), true)]
    );
}

#[test]
fn the_strict_namespace_reads_too() {
    let m = parse_all(
        r#"<m:oMath xmlns:m="http://purl.oclc.org/ooxml/officeDocument/math"><m:r><m:t>q</m:t></m:r></m:oMath>"#,
    )
    .unwrap();
    assert_eq!(text(&m[0].body), "q");
}

#[test]
fn a_fixture_lays_out_end_to_end() {
    struct Half;
    impl paged_math::MathMetrics for Half {
        fn advance(&self, t: &str, size: f32, _: Variant) -> f32 {
            t.chars().count() as f32 * 0.5 * size
        }
    }
    for name in ["quadratic", "sum-limits", "matrix", "integral"] {
        for m in parse_all(&fixture(name)).unwrap() {
            let l = paged_math::layout(&m, &Half, 11.0);
            assert!(l.width > 0.0 && l.ascent > 0.0, "{name} is set");
            assert!(!l.items.is_empty());
        }
    }
}
