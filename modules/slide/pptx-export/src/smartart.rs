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

//! SmartArt text edits written back (slide W4, the text pane). There is no
//! layout engine: the diagram keeps the shapes PowerPoint laid out, and an
//! edit changes the text of points they already show. The data part's
//! points (`dgm:pt/dgm:t`) and the drawing part's shapes (`dsp:txBody`) get
//! the new text; each new paragraph keeps the paragraph and run properties
//! of the first paragraph the point had there.

use std::collections::BTreeMap;

use crate::xml::{self, El};

/// The data part's content type.
pub const CT_DATA: &str = "application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml";
/// The drawing part's content type (Office 2007's diagram drawing).
pub const CT_DRAWING: &str = "application/vnd.ms-office.drawingml.diagramDrawing+xml";

fn local(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

fn child(xml: &str, el: &El, name: &str) -> Option<El> {
    el.children(xml)
        .into_iter()
        .find(|c| local(&c.name) == name)
}

/// A paragraph like `template` (an `a:p`) holding `text`: its `a:pPr`, and
/// its first run's `a:rPr` (or its `a:endParaRPr`) on every run. A line
/// break (`\u{b}` or U+2028) becomes an `a:br`.
pub fn paragraph_like(template: Option<&str>, text: &str) -> String {
    let (ppr, rpr) = match template.and_then(|t| xml::root(t).map(|r| (t, r))) {
        Some((t, p)) => {
            let kids = p.children(t);
            let ppr = kids
                .iter()
                .find(|c| local(&c.name) == "pPr")
                .map(|c| c.text(t).to_string())
                .unwrap_or_default();
            let run_pr = kids
                .iter()
                .filter(|c| matches!(local(&c.name), "r" | "fld"))
                .find_map(|r| {
                    r.children(t)
                        .into_iter()
                        .find(|c| local(&c.name) == "rPr")
                        .map(|c| c.text(t).to_string())
                });
            let end_pr = kids
                .iter()
                .find(|c| local(&c.name) == "endParaRPr")
                .map(|c| {
                    c.text(t)
                        .replacen("<a:endParaRPr", "<a:rPr", 1)
                        .replace("</a:endParaRPr>", "</a:rPr>")
                });
            (ppr, run_pr.or(end_pr).unwrap_or_default())
        }
        None => (String::new(), String::new()),
    };
    let rpr = if rpr.is_empty() {
        r#"<a:rPr lang="en-US"/>"#.to_string()
    } else {
        rpr
    };
    if text.is_empty() {
        let end = rpr
            .replacen("<a:rPr", "<a:endParaRPr", 1)
            .replace("</a:rPr>", "</a:endParaRPr>");
        return format!("<a:p>{ppr}{end}</a:p>");
    }
    let mut body = String::new();
    for (i, line) in text.split(['\u{b}', '\u{2028}']).enumerate() {
        if i > 0 {
            let br = rpr.replacen("<a:rPr", "<a:br><a:rPr", 1);
            body.push_str(&format!("{br}</a:br>"));
        }
        if !line.is_empty() {
            body.push_str(&format!("<a:r>{rpr}<a:t>{}</a:t></a:r>", xml::esc(line)));
        }
    }
    format!("<a:p>{ppr}{body}</a:p>")
}

/// The data part with the points of `edits` holding their new paragraphs.
/// A point that was an empty placeholder (`phldr="1"`) stops being one.
pub fn rewrite_data(data: &str, edits: &BTreeMap<String, Vec<String>>) -> Result<String, String> {
    let root = xml::root(data).ok_or("the diagram's data part does not read")?;
    let list = child(data, &root, "ptLst").ok_or("the diagram's data has no points")?;
    // Back to front, so earlier offsets stay valid.
    let mut out = data.to_string();
    let mut points: Vec<El> = list
        .children(data)
        .into_iter()
        .filter(|p| local(&p.name) == "pt")
        .collect();
    points.reverse();
    for pt in points {
        let Some(id) = pt.attr(data, "modelId") else {
            continue;
        };
        let Some(paras) = edits.get(&id) else {
            continue;
        };
        let t = child(data, &pt, "t");
        let new_body = |tx: Option<&El>| -> String {
            let old: Vec<String> = tx
                .map(|t| {
                    t.children(data)
                        .into_iter()
                        .filter(|c| local(&c.name) == "p")
                        .map(|c| c.text(data).to_string())
                        .collect()
                })
                .unwrap_or_default();
            paras
                .iter()
                .enumerate()
                .map(|(i, p)| paragraph_like(old.get(i).or(old.first()).map(String::as_str), p))
                .collect()
        };
        match &t {
            Some(tx) => {
                let kids = tx.children(data);
                let first_p = kids.iter().position(|c| local(&c.name) == "p");
                let head: String = kids
                    .iter()
                    .take(first_p.unwrap_or(kids.len()))
                    .map(|c| c.text(data))
                    .collect();
                let open = tx.open(data).trim_end_matches("/>").trim_end_matches('>');
                let close = format!("</{}>", tx.name);
                let replaced = format!("{open}>{head}{}{close}", new_body(Some(tx)));
                out = xml::splice(&out, tx.start, tx.end, &replaced);
            }
            None => {
                let at = child(data, &pt, "spPr")
                    .map(|s| s.end)
                    .unwrap_or(pt.inner.1);
                let body = format!("<dgm:t><a:bodyPr/><a:lstStyle/>{}</dgm:t>", new_body(None));
                out = xml::splice(&out, at, at, &body);
            }
        }
        // `phldr="1"` draws the prompt text in place of the point's own.
        if paras.iter().any(|p| !p.is_empty()) {
            if let Some(pr) = child(data, &pt, "prSet") {
                if pr.attr(data, "phldr").is_some() {
                    let open = pr.open(data);
                    let tag = xml::set_attr(open, "phldr", None);
                    out = xml::splice(&out, pr.start, pr.start + open.len(), &tag);
                }
            }
        }
    }
    Ok(out)
}

/// One drawing shape's text as the document holds it now: the points it
/// shows (each with the paragraph count it had) and the new paragraphs of
/// the ones that changed.
pub struct ShapeText {
    pub points: Vec<(String, u32)>,
    pub edits: BTreeMap<String, Vec<String>>,
}

/// The drawing part with each shape of `shapes` (by `modelId`) showing its
/// points' new paragraphs; its other paragraphs keep their XML.
pub fn rewrite_drawing(
    drawing: &str,
    shapes: &BTreeMap<String, ShapeText>,
) -> Result<String, String> {
    let root = xml::root(drawing).ok_or("the diagram's drawing part does not read")?;
    let tree = child(drawing, &root, "spTree").ok_or("the diagram's drawing has no shapes")?;
    let mut all = Vec::new();
    fn walk(xml: &str, el: &El, out: &mut Vec<El>) {
        for c in el.children(xml) {
            match local(&c.name) {
                "sp" => out.push(c),
                "grpSp" => walk(xml, &c, out),
                _ => {}
            }
        }
    }
    walk(drawing, &tree, &mut all);
    all.sort_by_key(|e| std::cmp::Reverse(e.start));
    let mut out = drawing.to_string();
    for sp in all {
        let Some(id) = sp.attr(drawing, "modelId") else {
            continue;
        };
        let Some(st) = shapes.get(&id) else { continue };
        let Some(body) = child(drawing, &sp, "txBody") else {
            continue;
        };
        let kids = body.children(drawing);
        let paras: Vec<&El> = kids.iter().filter(|c| local(&c.name) == "p").collect();
        let (Some(first), Some(last)) = (paras.first(), paras.last()) else {
            continue;
        };
        let mut text = String::new();
        let mut at = 0usize;
        for (pt, n) in &st.points {
            let old: Vec<&str> = paras
                .iter()
                .skip(at)
                .take(*n as usize)
                .map(|p| p.text(drawing))
                .collect();
            at += *n as usize;
            match st.edits.get(pt) {
                Some(new) => {
                    for (i, p) in new.iter().enumerate() {
                        text.push_str(&paragraph_like(old.get(i).or(old.first()).copied(), p));
                    }
                }
                None => old.iter().for_each(|p| text.push_str(p)),
            }
        }
        // Paragraphs past the points' (none, when the labels hold).
        for p in paras.iter().skip(at) {
            text.push_str(p.text(drawing));
        }
        out = xml::splice(&out, first.start, last.end, &text);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_paragraph_keeps_its_properties() {
        let t = r#"<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="5500"/><a:t>Alpha</a:t></a:r></a:p>"#;
        assert_eq!(
            paragraph_like(Some(t), "Omega & co"),
            r#"<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="5500"/><a:t>Omega &amp; co</a:t></a:r></a:p>"#
        );
        assert_eq!(
            paragraph_like(Some(t), ""),
            r#"<a:p><a:pPr algn="ctr"/><a:endParaRPr lang="en-US" sz="5500"/></a:p>"#
        );
        let empty = r#"<a:p><a:endParaRPr lang="de-DE"/></a:p>"#;
        assert_eq!(
            paragraph_like(Some(empty), "a\u{b}b"),
            r#"<a:p><a:r><a:rPr lang="de-DE"/><a:t>a</a:t></a:r><a:br><a:rPr lang="de-DE"/></a:br><a:r><a:rPr lang="de-DE"/><a:t>b</a:t></a:r></a:p>"#
        );
    }

    #[test]
    fn data_and_drawing_take_the_new_text() {
        let data = r#"<dgm:dataModel xmlns:dgm="d" xmlns:a="a"><dgm:ptLst><dgm:pt modelId="{A}"><dgm:prSet phldr="1" phldrT="[Text]"/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Alpha</a:t></a:r></a:p></dgm:t></dgm:pt><dgm:pt modelId="{B}"><dgm:prSet/><dgm:spPr/></dgm:pt></dgm:ptLst></dgm:dataModel>"#;
        let edits = BTreeMap::from([
            ("{A}".to_string(), vec!["Omega".to_string()]),
            (
                "{B}".to_string(),
                vec!["Beta".to_string(), "two".to_string()],
            ),
        ]);
        let out = rewrite_data(data, &edits).unwrap();
        assert!(out.contains(r#"<dgm:prSet phldrT="[Text]"/>"#), "{out}");
        assert!(out.contains(r#"<a:t>Omega</a:t>"#) && !out.contains("Alpha"));
        assert!(out.contains(r#"<dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Beta</a:t></a:r></a:p><a:p><a:r><a:rPr lang="en-US"/><a:t>two</a:t></a:r></a:p></dgm:t>"#), "{out}");
        crate::slide::check_well_formed(&out).unwrap();

        let drawing = r#"<dsp:drawing xmlns:dsp="s" xmlns:a="a"><dsp:spTree><dsp:nvGrpSpPr/><dsp:sp modelId="{P}"><dsp:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="900"/><a:t>One</a:t></a:r></a:p><a:p><a:r><a:rPr sz="900"/><a:t>Two</a:t></a:r></a:p></dsp:txBody></dsp:sp></dsp:spTree></dsp:drawing>"#;
        let shapes = BTreeMap::from([(
            "{P}".to_string(),
            ShapeText {
                points: vec![("{A}".into(), 1), ("{B}".into(), 1)],
                edits: BTreeMap::from([("{B}".to_string(), vec!["Deux".to_string()])]),
            },
        )]);
        let out = rewrite_drawing(drawing, &shapes).unwrap();
        assert!(
            out.contains(r#"<a:t>One</a:t>"#)
                && out.contains(r#"<a:rPr sz="900"/><a:t>Deux</a:t>"#),
            "{out}"
        );
        crate::slide::check_well_formed(&out).unwrap();
    }
}
