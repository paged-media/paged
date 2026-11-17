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

//! Paragraph and character styles from the paragraphs as recovered.
//!
//! Paragraphs that look the same — face, size, colour, leading, alignment,
//! tracking, indent — share one paragraph style; a run that differs from
//! its paragraph's style takes a character style. Names come from the
//! role a style plays: the style with the most text is the body, larger
//! ones are headings by size, smaller ones captions and notes. The recipe
//! renames them.

use std::collections::BTreeMap;

use super::text::{Align, Para, Run};

/// What makes two paragraphs one style.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ParaKey {
    pub font: u32,
    /// Tenths of a point.
    pub size: i32,
    pub color: [u8; 3],
    /// Tenths of a point; 0 = auto.
    pub leading: i32,
    pub align: u8,
    /// Per mille of the em, in steps of 5.
    pub tracking: i32,
    /// Tenths of a point.
    pub first_indent: i32,
    pub left_indent: i32,
    /// Most of its letters are set in All Caps.
    pub caps: bool,
}

impl ParaKey {
    pub fn of(p: &Para) -> ParaKey {
        let (font, size, color) = p.dominant;
        ParaKey {
            font,
            size: (size * 10.0).round() as i32,
            color,
            leading: p.leading.map_or(0, |l| (l * 10.0).round() as i32),
            align: match p.align {
                Align::Left => 0,
                Align::Center => 1,
                Align::Right => 2,
                Align::Justify => 3,
            },
            // Tracking is measured, and the measure is noisy (kerning
            // pairs ride in it): it is the style's mean, not its key.
            tracking: 0,
            first_indent: (p.first_indent * 2.0).round() as i32 * 5,
            left_indent: (p.left_indent * 2.0).round() as i32 * 5,
            caps: {
                let (mut up, mut n) = (0usize, 0usize);
                for r in &p.runs {
                    let len = r.text.chars().filter(|c| c.is_alphabetic()).count();
                    n += len;
                    if r.caps == Some(true) {
                        up += len;
                    }
                }
                n > 0 && up * 2 > n
            },
        }
    }
    pub fn size_pt(&self) -> f32 {
        self.size as f32 / 10.0
    }
}

/// What makes two runs one character style: what differs from the
/// paragraph style.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CharKey {
    pub font: Option<u32>,
    pub size: Option<i32>,
    pub color: Option<[u8; 3]>,
    /// Tenths of a point raised.
    pub shift: Option<i32>,
    /// Percent.
    pub hscale: Option<i32>,
    /// All Caps on (`Some(true)`) or off (`Some(false)`) against the
    /// paragraph style.
    pub caps: Option<bool>,
}

impl CharKey {
    pub fn of(r: &Run, para: &ParaKey) -> Option<CharKey> {
        let size = (r.size * 10.0).round() as i32;
        let k = CharKey {
            font: (r.font != para.font).then_some(r.font),
            size: ((size - para.size).abs() > 1).then_some(size),
            color: (r.color != para.color).then_some(r.color),
            shift: (r.shift.abs() > 0.05).then(|| (r.shift * 10.0).round() as i32),
            hscale: ((r.hscale - 1.0).abs() > 0.01).then(|| (r.hscale * 100.0).round() as i32),
            caps: r.caps.filter(|c| *c != para.caps),
        };
        (k != CharKey::default()).then_some(k)
    }
}

/// The styles of a document.
#[derive(Debug, Default)]
pub struct Styles {
    /// Key → (name, total characters, space before median).
    pub paragraph: BTreeMap<ParaKey, ParaStyle>,
    pub character: BTreeMap<CharKey, String>,
}

#[derive(Debug, Clone)]
pub struct ParaStyle {
    pub name: String,
    pub space_before: f32,
    /// Space after: what a style leaves below itself before a paragraph of
    /// another style (a heading's air).
    pub space_after: f32,
    /// Leading for paragraphs of one line: the style's own, or 120 %.
    pub leading: f32,
    /// Tracking, per mille of the em (set by the metric fit).
    pub tracking: f32,
}

/// Name every style the paragraphs use. `font_role(font)` says whether a
/// face is bold/italic, for character style names.
pub fn infer(paras: &[&Para], font_style: &dyn Fn(u32) -> String) -> Styles {
    let mut acc: BTreeMap<ParaKey, (usize, Vec<f32>)> = BTreeMap::new();
    for p in paras {
        let k = ParaKey::of(p);
        let e = acc.entry(k).or_default();
        e.0 += p.chars.chars().count().max(1);
        // Space above a frame's first paragraph is the frame's place, not
        // the paragraph's.
        if !p.first_in_frame {
            e.1.push(p.space_before);
        }
    }
    // Merge one-line paragraphs (auto leading) into the multi-line style
    // they match in everything else, so a one-line paragraph of body text
    // is body text.
    let keys: Vec<ParaKey> = acc.keys().copied().collect();
    let mut alias: BTreeMap<ParaKey, ParaKey> = BTreeMap::new();
    for k in &keys {
        if k.leading != 0 {
            continue;
        }
        let best = keys
            .iter()
            .filter(|o| {
                o.leading != 0
                    && o.font == k.font
                    && o.size == k.size
                    && o.color == k.color
                    && o.caps == k.caps
                    && o.align == k.align
                    && o.first_indent == k.first_indent
                    && o.left_indent == k.left_indent
                    && (o.tracking - k.tracking).abs() <= 10
            })
            .max_by_key(|o| acc[o].0);
        if let Some(b) = best {
            alias.insert(*k, *b);
        }
    }
    for (from, to) in &alias {
        if let Some((n, sb)) = acc.remove(from) {
            let e = acc.entry(*to).or_default();
            e.0 += n;
            e.1.extend(sb);
        }
    }

    // Names say what a style is: its face, size and leading, and how it
    // differs from its siblings (All Caps, centred, indented) — honest
    // names a person renames (the recipe's `style_names`) to what the
    // style is for.
    let mut used: BTreeMap<String, usize> = BTreeMap::new();
    let mut uniq = |base: String| -> String {
        let n = used.entry(base.clone()).or_insert(0);
        *n += 1;
        if *n == 1 {
            base
        } else {
            format!("{base} {}", *n)
        }
    };
    let mut styles = Styles::default();
    let mut ranked: Vec<(ParaKey, usize)> = acc.iter().map(|(k, (n, _))| (*k, *n)).collect();
    ranked.sort_by_key(|b| std::cmp::Reverse(b.1));
    for (k, _n) in &ranked {
        let size = k.size_pt();
        let leading = if k.leading != 0 {
            k.leading as f32 / 10.0
        } else {
            (1.2 * size * 10.0).round() / 10.0
        };
        let mut name = format!("{} {}/{}", font_style(k.font), num(size), num(leading));
        if k.caps {
            name.push_str(" Caps");
        }
        let [r, g, b] = k.color;
        let lum = 0.2126 * r as f32 + 0.7152 * g as f32 + 0.0722 * b as f32;
        let chroma = r.max(g).max(b) as i32 - r.min(g).min(b) as i32;
        if chroma > 24 {
            name.push_str(&format!(" #{r:02X}{g:02X}{b:02X}"));
        } else if lum > 235.0 {
            name.push_str(" White");
        } else if lum > 40.0 {
            name.push_str(" Gray");
        }
        match k.align {
            1 => name.push_str(" Centered"),
            2 => name.push_str(" Right"),
            3 => name.push_str(" Justified"),
            _ => {}
        }
        if k.first_indent > 0 {
            name.push_str(" Indent");
        } else if k.first_indent < 0 {
            name.push_str(" Hanging");
        }
        if k.left_indent > 0 {
            name.push_str(" Inset");
        }
        let (_, sb) = &acc[k];
        let mut sb = sb.clone();
        sb.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let space_before = if sb.is_empty() { 0.0 } else { sb[sb.len() / 2] };
        styles.paragraph.insert(
            *k,
            ParaStyle {
                name: uniq(name),
                space_before,
                space_after: 0.0,
                leading,
                tracking: 0.0,
            },
        );
    }
    for (from, to) in alias {
        if let Some(s) = styles.paragraph.get(&to).cloned() {
            styles.paragraph.insert(from, s);
        }
    }
    styles
}

/// Name the character styles the runs need.
pub fn infer_chars(
    runs: &[(CharKey, usize)],
    font_style: &dyn Fn(u32) -> String,
) -> BTreeMap<CharKey, String> {
    let mut acc: BTreeMap<CharKey, usize> = BTreeMap::new();
    for (k, n) in runs {
        *acc.entry(*k).or_default() += n;
    }
    let mut ranked: Vec<(CharKey, usize)> = acc.into_iter().collect();
    ranked.sort_by_key(|b| std::cmp::Reverse(b.1));
    let mut used: BTreeMap<String, usize> = BTreeMap::new();
    let mut out = BTreeMap::new();
    for (k, _) in ranked {
        let mut parts: Vec<String> = Vec::new();
        if let Some(f) = k.font {
            let s = font_style(f);
            parts.push(if s.is_empty() { "Face".into() } else { s });
        }
        if k.shift.is_some_and(|s| s > 0) {
            parts.push("Superscript".into());
        } else if k.shift.is_some() {
            parts.push("Subscript".into());
        }
        if k.size.is_some() && k.shift.is_none() {
            parts.push("Size".into());
        }
        if k.color.is_some() {
            parts.push("Color".into());
        }
        if k.hscale.is_some() {
            parts.push("Scaled".into());
        }
        match k.caps {
            Some(true) => parts.push("All Caps".into()),
            Some(false) => parts.push("Lowercase".into()),
            None => {}
        }
        let base = parts.join(" ");
        let n = used.entry(base.clone()).or_insert(0);
        *n += 1;
        let name = if *n == 1 {
            base
        } else {
            format!("{base} {}", *n)
        };
        out.insert(k, name);
    }
    out
}

/// A number as a style name spells it: `12`, `14.4`.
fn num(v: f32) -> String {
    let r = (v * 10.0).round() / 10.0;
    if (r - r.round()).abs() < 1e-3 {
        format!("{}", r.round() as i32)
    } else {
        format!("{r:.1}")
    }
}
