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

//! Text back to DrawingML (ADR 704, ADR 711): a story's paragraphs as
//! `a:p` elements. A paragraph that is the one the slide had keeps its
//! original XML; a changed or new one is written with only what differs
//! from the text's inherited defaults (see `probe`): its list level from
//! the `Body Ln` style, alignment, indents, spacing, bullets; each run's
//! size, typeface, weight and slant, underline, strike, caps, tracking,
//! baseline, colour (a theme swatch as `a:schemeClr` while it still is the
//! theme's colour) and hyperlink.

use std::collections::BTreeMap;

use paged_model::{CharacterRun, Justification, Paragraph, AUTO_PAGE_NUMBER_MARKER};
use paged_scene::Document;
use pptx_core::EMU_PER_PT;
use slide_resolve::model::{Bullet, Para};

use crate::native::swatch_rgb;
use crate::probe::Defaults;
use crate::xml::{esc, text as esc_text, El};

/// How swatches become DrawingML colours.
pub struct Colors<'a> {
    pub doc: &'a Document,
    /// Theme colour slots (`dk1`, `accent1`, …) and their colours.
    pub theme: &'a [(String, [u8; 3])],
    /// Theme slot → the logical name a slide writes (`dk1` → `tx1`).
    pub logical: BTreeMap<String, String>,
}

impl Colors<'_> {
    /// A swatch's colour.
    pub fn rgb(&self, swatch: &str) -> Option<[u8; 3]> {
        swatch_rgb(self.doc, swatch)
    }

    /// A colour element (`a:schemeClr` / `a:srgbClr`) for `swatch`, with
    /// `alpha` (0–1) when below one. `None` for no colour.
    pub fn color(&self, swatch: &str, alpha: Option<f64>) -> Option<String> {
        let rgb = self.rgb(swatch)?;
        let alpha = alpha
            .filter(|a| *a < 0.999)
            .map(|a| format!(r#"<a:alpha val="{}"/>"#, (a * 100_000.0).round() as i64))
            .unwrap_or_default();
        // A theme colour's swatch (slide ADR 713) is the theme colour,
        // whatever the theme now is: its slot as the slide names it, with
        // its transforms.
        if let Some(k) = slide_resolve::theme::Key::of_swatch(swatch) {
            let slot = self.logical.get(&k.slot).cloned().unwrap_or(k.slot.clone());
            let mut kids: String = k
                .transforms
                .iter()
                .map(|(op, v)| match op.as_str() {
                    "comp" | "inv" | "gray" | "gamma" | "invGamma" => format!("<a:{op}/>"),
                    _ => format!(r#"<a:{op} val="{v}"/>"#),
                })
                .collect();
            kids.push_str(&alpha);
            return Some(if kids.is_empty() {
                format!(r#"<a:schemeClr val="{slot}"/>"#)
            } else {
                format!(r#"<a:schemeClr val="{slot}">{kids}</a:schemeClr>"#)
            });
        }
        let name = swatch.strip_prefix("Color/").unwrap_or("");
        let theme = self
            .theme
            .iter()
            .find(|(n, c)| n == name && *c == rgb)
            .map(|(n, _)| self.logical.get(n).cloned().unwrap_or_else(|| n.clone()));
        Some(match theme {
            Some(slot) if alpha.is_empty() => format!(r#"<a:schemeClr val="{slot}"/>"#),
            Some(slot) => format!(r#"<a:schemeClr val="{slot}">{alpha}</a:schemeClr>"#),
            None if alpha.is_empty() => format!(
                r#"<a:srgbClr val="{:02X}{:02X}{:02X}"/>"#,
                rgb[0], rgb[1], rgb[2]
            ),
            None => format!(
                r#"<a:srgbClr val="{:02X}{:02X}{:02X}">{alpha}</a:srgbClr>"#,
                rgb[0], rgb[1], rgb[2]
            ),
        })
    }

    /// A colour element for `rgb` and `alpha`: `a:schemeClr` when it is a
    /// theme colour, else `a:srgbClr`.
    pub fn rgb_color(&self, rgb: [u8; 3], alpha: f64) -> String {
        let alpha_xml = if alpha < 0.999 {
            format!(r#"<a:alpha val="{}"/>"#, (alpha * 100_000.0).round() as i64)
        } else {
            String::new()
        };
        match self.theme.iter().find(|(_, c)| *c == rgb) {
            Some((n, _)) => {
                let slot = self.logical.get(n).cloned().unwrap_or_else(|| n.clone());
                if alpha_xml.is_empty() {
                    format!(r#"<a:schemeClr val="{slot}"/>"#)
                } else {
                    format!(r#"<a:schemeClr val="{slot}">{alpha_xml}</a:schemeClr>"#)
                }
            }
            None => paged_ooxml::drawingml::write::srgb(rgb, alpha),
        }
    }

    /// A fill for `swatch`: `a:noFill` for None, `a:solidFill`, or
    /// `a:gradFill` for a gradient swatch (`angle` in the engine's
    /// counter-clockwise degrees).
    pub fn fill(&self, swatch: Option<&str>, alpha: Option<f64>, angle: Option<f64>) -> String {
        let Some(swatch) = swatch.filter(|s| *s != "Swatch/None") else {
            return "<a:noFill/>".into();
        };
        if let Some(g) = self.doc.palette.gradients.get(swatch) {
            let stops: String = g
                .stops
                .iter()
                .filter_map(|s| {
                    Some(format!(
                        r#"<a:gs pos="{}">{}</a:gs>"#,
                        (s.location_pct as f64 * 1000.0).round() as i64,
                        self.color(&s.stop_color, alpha)?
                    ))
                })
                .collect();
            let shade = match g.kind {
                paged_model::GradientKind::Radial => {
                    r#"<a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path>"#.to_string()
                }
                _ => {
                    // DrawingML runs clockwise; the engine counter-clockwise.
                    let a = (-angle.unwrap_or(0.0)).rem_euclid(360.0);
                    format!(r#"<a:lin ang="{}" scaled="0"/>"#, (a * 60_000.0).round() as i64)
                }
            };
            return format!(
                r#"<a:gradFill rotWithShape="1"><a:gsLst>{stops}</a:gsLst>{shade}</a:gradFill>"#
            );
        }
        match self.color(swatch, alpha) {
            Some(c) => format!("<a:solidFill>{c}</a:solidFill>"),
            None => "<a:noFill/>".into(),
        }
    }
}

/// What a text is written with besides its paragraphs.
pub struct TextCtx<'a, 'b> {
    pub colors: &'a Colors<'b>,
    /// `lang` for new runs (the shape's own, else `en-US`).
    pub lang: String,
    /// The slide's number, for a slide-number field's last value.
    pub slide_no: usize,
}

/// The paragraphs a text had (model and XML), for reuse.
pub struct Reuse<'a> {
    pub base: &'a [Paragraph],
    pub xml: &'a str,
    pub els: Vec<El>,
}

/// The list level a paragraph style names (`Body L3` → 2).
pub fn level_of(p: &Paragraph) -> usize {
    p.paragraph_style
        .as_deref()
        .and_then(|s| s.rsplit_once(" L"))
        .and_then(|(_, n)| n.parse::<usize>().ok())
        .map(|n| n.clamp(1, 9) - 1)
        .unwrap_or(0)
}

fn differs(a: f64, b: f64, eps: f64) -> bool {
    (a - b).abs() > eps
}

fn emu(pt: f64) -> i64 {
    (pt * EMU_PER_PT).round() as i64
}

fn algn(j: &Justification) -> &'static str {
    match j {
        Justification::LeftAlign => "l",
        Justification::CenterAlign => "ctr",
        Justification::RightAlign => "r",
        Justification::FullyJustified => "dist",
        _ => "just",
    }
}

/// The paragraphs of `cur` as `a:p` elements.
pub fn paragraphs(
    cur: &[Paragraph],
    defaults: &Defaults,
    reuse: Option<&Reuse>,
    ctx: &TextCtx,
    link: &mut dyn FnMut(&str) -> Option<String>,
    lost: &mut Vec<String>,
) -> String {
    // Which current paragraphs are a paragraph the text had: the longest
    // common run of equal paragraphs, in order.
    let mut keep: BTreeMap<usize, usize> = BTreeMap::new();
    if let Some(r) = reuse.filter(|r| r.base.len() == r.els.len()) {
        let key = |p: &Paragraph| serde_json::to_string(p).unwrap_or_default();
        let a: Vec<String> = cur.iter().map(key).collect();
        let b: Vec<String> = r.base.iter().map(key).collect();
        let (n, m) = (a.len(), b.len());
        let mut t = vec![vec![0u32; m + 1]; n + 1];
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                t[i][j] = if a[i] == b[j] {
                    t[i + 1][j + 1] + 1
                } else {
                    t[i + 1][j].max(t[i][j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < n && j < m {
            if a[i] == b[j] {
                keep.insert(i, j);
                i += 1;
                j += 1;
            } else if t[i + 1][j] >= t[i][j + 1] {
                i += 1;
            } else {
                j += 1;
            }
        }
    }
    let mut out = String::new();
    for (i, p) in cur.iter().enumerate() {
        if let (Some(j), Some(r)) = (keep.get(&i), reuse) {
            out.push_str(r.els[*j].text(r.xml));
            continue;
        }
        out.push_str(&paragraph(p, defaults, ctx, link, lost));
    }
    if out.is_empty() {
        out = format!(
            r#"<a:p><a:endParaRPr lang="{}" dirty="0"/></a:p>"#,
            esc(&ctx.lang)
        );
    }
    out
}

/// One paragraph, written as differences from its level's defaults.
pub fn paragraph(
    p: &Paragraph,
    defaults: &Defaults,
    ctx: &TextCtx,
    link: &mut dyn FnMut(&str) -> Option<String>,
    lost: &mut Vec<String>,
) -> String {
    let lvl = level_of(p);
    let empty = Para::default();
    let d = defaults.level(lvl).unwrap_or(&empty);
    let mut attrs = String::new();
    if let Some(v) = p.left_indent {
        if differs(v as f64, d.margin_left, 0.05) {
            attrs.push_str(&format!(r#" marL="{}""#, emu(v as f64)));
        }
    }
    if lvl > 0 {
        attrs.push_str(&format!(r#" lvl="{lvl}""#));
    }
    if let Some(v) = p.first_line_indent {
        if differs(v as f64, d.indent, 0.05) {
            attrs.push_str(&format!(r#" indent="{}""#, emu(v as f64)));
        }
    }
    if let Some(j) = &p.justification {
        let a = algn(j);
        if a != d.align {
            attrs.push_str(&format!(r#" algn="{a}""#));
        }
    }
    let mut kids = String::new();
    // Line spacing: a fixed leading when it is not what the level's
    // percentage gives the paragraph's largest run.
    let size = p
        .runs
        .iter()
        .filter_map(|r| r.point_size)
        .fold(None, |m: Option<f64>, s| {
            Some(m.map_or(s as f64, |m| m.max(s as f64)))
        });
    let leading = p.runs.iter().find_map(|r| r.leading).map(|v| v as f64);
    let expected = match (d.line_percent, size) {
        (Some(pct), Some(s)) => Some(s * 1.2 * pct),
        _ => d.leading,
    };
    match (leading, expected) {
        (Some(v), Some(e)) if differs(v, e, 0.05) => kids.push_str(&format!(
            r#"<a:lnSpc><a:spcPts val="{}"/></a:lnSpc>"#,
            (v * 100.0).round() as i64
        )),
        (Some(v), None) => kids.push_str(&format!(
            r#"<a:lnSpc><a:spcPts val="{}"/></a:lnSpc>"#,
            (v * 100.0).round() as i64
        )),
        (None, Some(_)) => kids.push_str(r#"<a:lnSpc><a:spcPct val="100000"/></a:lnSpc>"#),
        _ => {}
    }
    for (v, dv, tag) in [
        (p.space_before, d.space_before, "spcBef"),
        (p.space_after, d.space_after, "spcAft"),
    ] {
        if let Some(v) = v {
            if differs(v as f64, dv, 0.05) {
                kids.push_str(&format!(
                    r#"<a:{tag}><a:spcPts val="{}"/></a:{tag}>"#,
                    (v as f64 * 100.0).round() as i64
                ));
            }
        }
    }
    match p.bullets_list_type.as_deref() {
        Some("BulletList") => {
            let ch = p
                .bullet_character
                .and_then(char::from_u32)
                .unwrap_or('\u{2022}')
                .to_string();
            if !matches!(&d.bullet, Some(Bullet::Char { ch: dc, .. }) if *dc == ch) {
                kids.push_str(&format!(r#"<a:buChar char="{}"/>"#, esc(&ch)));
            }
        }
        Some("NumberedList") => {
            if !matches!(&d.bullet, Some(Bullet::Number { .. })) {
                kids.push_str(r#"<a:buAutoNum type="arabicPeriod"/>"#);
            }
        }
        _ => {
            if d.bullet.is_some() {
                kids.push_str("<a:buNone/>");
            }
        }
    }
    let mut out = String::from("<a:p>");
    if !attrs.is_empty() || !kids.is_empty() {
        if kids.is_empty() {
            out.push_str(&format!("<a:pPr{attrs}/>"));
        } else {
            out.push_str(&format!("<a:pPr{attrs}>{kids}</a:pPr>"));
        }
    }
    let mut wrote = false;
    for r in &p.runs {
        if r.text.is_empty() {
            continue;
        }
        let rpr = run_props(r, d, defaults.font_scale, ctx, link, lost);
        for (k, piece) in r.text.split('\u{2028}').enumerate() {
            if k > 0 {
                out.push_str(&format!("<a:br>{}</a:br>", rpr("a:rPr")));
            }
            let mut rest = piece;
            while !rest.is_empty() {
                match rest.find(AUTO_PAGE_NUMBER_MARKER) {
                    Some(0) => {
                        out.push_str(&format!(
                            r#"<a:fld id="{{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}}" type="slidenum">{}<a:t>{}</a:t></a:fld>"#,
                            rpr("a:rPr"),
                            ctx.slide_no
                        ));
                        rest = &rest[AUTO_PAGE_NUMBER_MARKER.len_utf8()..];
                    }
                    found => {
                        let end = found.unwrap_or(rest.len());
                        out.push_str(&format!(
                            "<a:r>{}<a:t>{}</a:t></a:r>",
                            rpr("a:rPr"),
                            esc_text(&clean(&rest[..end]))
                        ));
                        rest = &rest[end..];
                    }
                }
            }
            wrote = true;
        }
    }
    // The end of the paragraph carries the size of an empty one.
    let end_size = p
        .runs
        .last()
        .and_then(|r| r.point_size)
        .map(|s| s as f64)
        .filter(|s| !wrote && differs(*s, d.empty_size, 0.01))
        .map(|s| {
            format!(
                r#" sz="{}""#,
                (s / defaults.font_scale * 100.0).round() as i64
            )
        })
        .unwrap_or_default();
    out.push_str(&format!(
        r#"<a:endParaRPr lang="{}"{end_size} dirty="0"/>"#,
        esc(&ctx.lang)
    ));
    out.push_str("</a:p>");
    out
}

/// Text as `a:t` holds it: a paragraph break the model kept inside a run
/// is a space, other control characters but tab are dropped.
fn clean(s: &str) -> String {
    s.chars()
        .filter_map(|c| match c {
            '\n' | '\r' => Some(' '),
            '\t' => Some('\t'),
            c if (c as u32) < 0x20 => None,
            c => Some(c),
        })
        .collect()
}

/// A run's properties as differences from its level's default run; the
/// returned closure writes them under a given element name.
fn run_props(
    r: &CharacterRun,
    d: &Para,
    scale: f64,
    ctx: &TextCtx,
    link: &mut dyn FnMut(&str) -> Option<String>,
    lost: &mut Vec<String>,
) -> impl Fn(&str) -> String {
    let dr = d.runs.first().cloned().unwrap_or_default();
    let mut attrs = format!(r#" lang="{}""#, esc(&ctx.lang));
    if let Some(s) = r.point_size {
        if differs(s as f64, dr.size, 0.01) {
            attrs.push_str(&format!(
                r#" sz="{}""#,
                (s as f64 / scale * 100.0).round() as i64
            ));
        }
    }
    let style = r.font_style.as_deref().unwrap_or("Regular");
    let bold = style.contains("Bold");
    let italic = style.contains("Italic") || style.contains("Oblique");
    if !matches!(style, "Regular" | "Bold" | "Italic" | "Bold Italic") {
        lost.push(format!(
            "font style {style:?} is written as bold/italic only"
        ));
    }
    if bold != dr.bold {
        attrs.push_str(if bold { r#" b="1""# } else { r#" b="0""# });
    }
    if italic != dr.italic {
        attrs.push_str(if italic { r#" i="1""# } else { r#" i="0""# });
    }
    let u = r.underline.unwrap_or(false);
    if u != dr.underline {
        attrs.push_str(if u { r#" u="sng""# } else { r#" u="none""# });
    }
    let st = r.strikethru.unwrap_or(false);
    if st != dr.strike {
        attrs.push_str(if st {
            r#" strike="sngStrike""#
        } else {
            r#" strike="noStrike""#
        });
    }
    let cap = match r.capitalization.as_deref() {
        Some("AllCaps") => Some("all"),
        Some("SmallCaps") => Some("small"),
        _ => None,
    };
    if cap != dr.caps.as_deref() {
        attrs.push_str(&format!(r#" cap="{}""#, cap.unwrap_or("none")));
    }
    let size = r.point_size.map(|s| s as f64).unwrap_or(dr.size);
    // Tracking: thousandths of an em → hundredths of a point.
    let tracking = r.tracking.map(|t| t as f64 / 1000.0 * size).unwrap_or(0.0);
    if differs(tracking, dr.tracking, 0.01) {
        attrs.push_str(&format!(r#" spc="{}""#, (tracking * 100.0).round() as i64));
    }
    let baseline = r
        .baseline_shift
        .map(|b| {
            if size > 0.0 {
                b as f64 / size * 100.0
            } else {
                0.0
            }
        })
        .unwrap_or(0.0);
    if differs(baseline, dr.baseline, 0.5) {
        attrs.push_str(&format!(
            r#" baseline="{}""#,
            (baseline * 1000.0).round() as i64
        ));
    }
    attrs.push_str(r#" dirty="0""#);
    let mut kids = String::new();
    if let Some(sw) = r.fill_color.as_deref() {
        if let Some(rgb) = ctx.colors.rgb(sw) {
            if rgb != dr.rgb {
                if let Some(c) = ctx.colors.color(sw, None) {
                    kids.push_str(&format!("<a:solidFill>{c}</a:solidFill>"));
                }
            }
        }
    }
    if let Some(f) = r.font.as_deref().filter(|f| !f.is_empty()) {
        if f != dr.font {
            kids.push_str(&format!(r#"<a:latin typeface="{}"/>"#, esc(f)));
        }
    } else {
        // A run in a theme font by its character style (slide ADR 713)
        // writes the theme font's token where its level's font is another.
        let token = match r.character_style.as_deref() {
            Some(slide_native::HEADINGS_FONT_STYLE) => Some("+mj-lt"),
            Some(slide_native::BODY_FONT_STYLE) => Some("+mn-lt"),
            _ => None,
        };
        if let Some(token) = token {
            let face = r
                .character_style
                .as_deref()
                .and_then(|id| ctx.colors.doc.styles.character_styles.get(id))
                .and_then(|c| c.font.clone());
            if face.as_deref() != Some(dr.font.as_str()) {
                kids.push_str(&format!(r#"<a:latin typeface="{token}"/>"#));
            }
        }
    }
    if let Some(src) = &r.hyperlink_source {
        if let Some(h) = link(src) {
            kids.push_str(&h);
        }
    }
    move |name: &str| {
        if kids.is_empty() {
            format!("<{name}{attrs}/>")
        } else {
            format!("<{name}{attrs}>{kids}</{name}>")
        }
    }
}
