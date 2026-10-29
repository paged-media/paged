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

//! The solid colours an SVG document declares, read and rewritten where
//! they are written (engine ADR 1031 amendment 1, draw ADR 364).
//!
//! A recolour of an SVG asset (paged.draw's `recolor` action) has to
//! change colours and nothing else. Reading the file into a tree and
//! writing a new one would lose what the writer does not model —
//! gradients, text, `<use>`, filters, the author's structure — so this
//! works on the SOURCE: every place a colour is declared is found with its
//! byte range, and a rewrite replaces those ranges and copies every other
//! byte through. The places are the presentation attributes `fill`,
//! `stroke`, `stop-color`, `flood-color`, `lighting-color` and `color`,
//! the same properties inside a `style` attribute, and inside a `<style>`
//! element's rules. A paint that is `none`, `currentColor` or a bare
//! `url(#…)` is not a colour; a `url(#…)` with a colour fallback has one.
//!
//! An element that declares no fill paints black by SVG's default; that
//! black is not declared anywhere and is left alone.

use std::ops::Range;

/// One place a colour is declared.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColorSite {
    /// The bytes the rewrite replaces (the value, trimmed).
    pub range: Range<usize>,
    /// The colour, straight RGB 0–255.
    pub rgb: [u8; 3],
    /// Its alpha, 0–255 (255 for an opaque colour).
    pub alpha: u8,
    /// The property: `fill`, `stroke`, `stop-color`, …
    pub property: String,
    /// `url(#id)` when the colour is a paint server's fallback.
    pub link: Option<String>,
}

/// The properties whose value is (or may be) a colour.
const PAINTS: [&str; 2] = ["fill", "stroke"];
const COLORS: [&str; 4] = ["stop-color", "flood-color", "lighting-color", "color"];

/// Every colour `svg` declares, in source order. Fails when the text is
/// not well-formed XML.
pub fn color_sites(svg: &str) -> Result<Vec<ColorSite>, String> {
    let doc = roxmltree::Document::parse_with_options(
        svg,
        roxmltree::ParsingOptions {
            allow_dtd: true,
            ..Default::default()
        },
    )
    .map_err(|e| format!("not a readable SVG: {e}"))?;
    if doc.root_element().tag_name().name() != "svg" {
        return Err("not an SVG document: its root element is not <svg>".into());
    }
    let mut out = Vec::new();
    for node in doc.descendants() {
        if node.is_element() {
            for attr in node.attributes() {
                let name = attr.name();
                if attr.namespace().is_some() {
                    continue;
                }
                let range = attr.range_value();
                if name == "style" {
                    declarations(svg, range, &mut out);
                } else if let Some(site) = site(name, svg, range) {
                    out.push(site);
                }
            }
            if node.tag_name().name() == "style" {
                for child in node.children() {
                    if child.is_text() {
                        stylesheet(svg, child.range(), &mut out);
                    }
                }
            }
        }
    }
    out.sort_by_key(|s| s.range.start);
    Ok(out)
}

/// The distinct colours of `svg`, each with how many places declare it,
/// in order of first appearance.
pub fn color_counts(svg: &str) -> Result<Vec<([u8; 3], u32)>, String> {
    let mut counts: Vec<([u8; 3], u32)> = Vec::new();
    for s in color_sites(svg)? {
        match counts.iter_mut().find(|(c, _)| *c == s.rgb) {
            Some((_, n)) => *n += 1,
            None => counts.push((s.rgb, 1)),
        }
    }
    Ok(counts)
}

/// `svg` with each declared colour `map` answers for replaced (its alpha
/// kept), every other byte as it was.
pub fn recolor(svg: &str, map: &dyn Fn([u8; 3]) -> Option<[u8; 3]>) -> Result<String, String> {
    let sites = color_sites(svg)?;
    let mut out = String::with_capacity(svg.len());
    let mut at = 0;
    for s in sites {
        let Some(rgb) = map(s.rgb) else { continue };
        if s.range.start < at {
            // Two readings of one range (a malformed nesting): keep the first.
            continue;
        }
        out.push_str(&svg[at..s.range.start]);
        let color = css_color(rgb, s.alpha);
        match &s.link {
            Some(link) => {
                out.push_str(link);
                out.push(' ');
                out.push_str(&color);
            }
            None => out.push_str(&color),
        }
        at = s.range.end;
    }
    out.push_str(&svg[at..]);
    Ok(out)
}

/// `#rrggbb`, or `rgba(…)` when the colour is not opaque.
fn css_color([r, g, b]: [u8; 3], alpha: u8) -> String {
    if alpha == 255 {
        format!("#{r:02x}{g:02x}{b:02x}")
    } else {
        let a = (f32::from(alpha) / 255.0 * 1000.0).round() / 1000.0;
        format!("rgba({r},{g},{b},{a})")
    }
}

/// The value at `range` of `svg`, trimmed, with its trimmed range.
fn trimmed(svg: &str, range: Range<usize>) -> (&str, Range<usize>) {
    let raw = &svg[range.clone()];
    let lead = raw.len() - raw.trim_start().len();
    let value = raw.trim();
    let start = range.start + lead;
    (value, start..start + value.len())
}

/// The colour site of property `name` whose value is at `range`, if it
/// declares a colour.
fn site(name: &str, svg: &str, range: Range<usize>) -> Option<ColorSite> {
    let (value, range) = trimmed(svg, range);
    let value = value
        .strip_suffix("!important")
        .map_or(value, str::trim_end);
    let range = range.start..range.start + value.len();
    let make = |c: svgtypes::Color, link: Option<String>| ColorSite {
        range: range.clone(),
        rgb: [c.red, c.green, c.blue],
        alpha: c.alpha,
        property: name.to_string(),
        link,
    };
    if PAINTS.contains(&name) {
        match svgtypes::Paint::from_str(value).ok()? {
            svgtypes::Paint::Color(c) => Some(make(c, None)),
            svgtypes::Paint::FuncIRI(link, Some(svgtypes::PaintFallback::Color(c))) => {
                Some(make(c, Some(format!("url(#{link})"))))
            }
            _ => None,
        }
    } else if COLORS.contains(&name) {
        value.parse::<svgtypes::Color>().ok().map(|c| make(c, None))
    } else {
        None
    }
}

/// The colour declarations of a `style` attribute's value at `range`.
fn declarations(svg: &str, range: Range<usize>, out: &mut Vec<ColorSite>) {
    let text = &svg[range.clone()];
    for d in simplecss::DeclarationTokenizer::from(text) {
        if let Some(r) = sub_range(text, d.value) {
            if let Some(s) = site(d.name, svg, range.start + r.start..range.start + r.end) {
                out.push(s);
            }
        }
    }
}

/// The colour declarations of a `<style>` element's text at `range`.
fn stylesheet(svg: &str, range: Range<usize>, out: &mut Vec<ColorSite>) {
    let text = &svg[range.clone()];
    let sheet = simplecss::StyleSheet::parse(text);
    for rule in &sheet.rules {
        for d in &rule.declarations {
            if let Some(r) = sub_range(text, d.value) {
                if let Some(s) = site(d.name, svg, range.start + r.start..range.start + r.end) {
                    out.push(s);
                }
            }
        }
    }
}

/// Where `part`, a slice of `whole`, lies in it.
fn sub_range(whole: &str, part: &str) -> Option<Range<usize>> {
    let start = (part.as_ptr() as usize).checked_sub(whole.as_ptr() as usize)?;
    (start + part.len() <= whole.len()).then(|| start..start + part.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
  <style>.a { fill: #ff0000; stroke: blue }</style>
  <linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" style="stop-color: rgb(0, 255, 0)"/></linearGradient>
  <rect class="a" width="5" height="5"/>
  <rect width="5" height="5" fill="url(#g)" stroke="url(#missing) #00f"/>
  <circle r="2" style="fill:#ff000080; stroke:none"/>
  <path d="M0 0 L1 1" fill="none" stroke="currentColor"/>
</svg>"##;

    #[test]
    fn every_declared_colour_is_found_where_it_is_written() {
        let sites = color_sites(SVG).unwrap();
        let props: Vec<_> = sites.iter().map(|s| s.property.as_str()).collect();
        assert_eq!(
            props,
            [
                "fill",
                "stroke",
                "stop-color",
                "stop-color",
                "stroke",
                "fill"
            ]
        );
        for s in &sites {
            // The range is the value as written, nothing around it.
            let v = &SVG[s.range.clone()];
            assert!(
                !v.starts_with(' ') && !v.ends_with(' ') && !v.ends_with(';'),
                "{v:?}"
            );
        }
        assert_eq!(sites[4].link.as_deref(), Some("url(#missing)"));
        assert_eq!(sites[5].alpha, 0x80);
    }

    #[test]
    fn counts_merge_the_spellings_of_one_colour() {
        let counts = color_counts(SVG).unwrap();
        assert_eq!(
            counts,
            vec![([255, 0, 0], 3), ([0, 0, 255], 2), ([0, 255, 0], 1)]
        );
    }

    #[test]
    fn a_recolour_changes_the_colours_and_copies_every_other_byte() {
        let out = recolor(SVG, &|c| (c == [255, 0, 0]).then_some([1, 2, 3])).unwrap();
        assert!(out.contains(".a { fill: #010203; stroke: blue }"), "{out}");
        assert!(out.contains(r##"stop-color="#010203""##), "{out}");
        // Alpha is kept.
        assert!(out.contains("fill:rgba(1,2,3,0.502); stroke:none"), "{out}");
        // A fallback keeps its link.
        let out = recolor(SVG, &|c| (c == [0, 0, 255]).then_some([9, 9, 9])).unwrap();
        assert!(out.contains(r##"stroke="url(#missing) #090909""##), "{out}");
        // Nothing mapped: the file is the same file.
        assert_eq!(recolor(SVG, &|_| None).unwrap(), SVG);
    }

    #[test]
    fn a_file_that_is_not_svg_is_refused() {
        assert!(color_sites("<html/>").is_err());
        assert!(color_sites("not xml").is_err());
    }
}
