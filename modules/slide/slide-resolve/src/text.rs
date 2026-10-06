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

//! Text: list-style inheritance per level, run properties, theme fonts,
//! bullets, spacing in points.
//!
//! A paragraph at level n takes, lowest priority first: the chain's
//! `lvl(n+1)pPr` from every list style (presentation default, master text
//! style, master / layout placeholder, the shape's own `a:lstStyle`), then
//! its own `a:pPr`. A run takes the same chain's `defRPr`, then the shape
//! style's font reference, then its own `a:rPr`.

use pptx_core::{
    Bullet as PBullet, BulletColor, BulletSize, FontSet, ListStyle, Paragraph, ParagraphProps,
    RunKind, RunProps, Spacing, TextBody, EMU_PER_PT,
};

use crate::color::{resolve as resolve_color, ColorCtx, Rgba};
use crate::model::{Bullet, Para, TextRun};

/// What text resolves against.
pub struct TextCtx<'a> {
    /// List styles, lowest priority first.
    pub lists: Vec<&'a ListStyle>,
    /// How many of `lists` (from the front) the shape inherits from the
    /// presentation and its master rather than defines itself. A style
    /// `fontRef` colour overrides their text colour (a default shape's white
    /// text over the master's dark one), not the shape's own.
    pub inherited: usize,
    pub colors: &'a ColorCtx<'a>,
    pub major: &'a FontSet,
    pub minor: &'a FontSet,
    /// The shape style's `a:fontRef` (font slot, colour).
    pub font_ref: Option<(String, Option<Rgba>)>,
    /// Paragraph style name prefix (`Title`, `Body`, `Other`).
    pub style_prefix: Option<&'static str>,
    /// `normAutofit` scales (font, line spacing) PowerPoint applied.
    pub shrink: Option<(f64, f64)>,
}

macro_rules! take {
    ($dst:ident, $src:ident, $($f:ident),*) => { $( if $src.$f.is_some() { $dst.$f = $src.$f.clone(); } )* };
}

fn merge_para(dst: &mut ParagraphProps, src: &ParagraphProps) {
    take!(
        dst,
        src,
        margin_left,
        indent,
        align,
        line_spacing,
        space_before,
        space_after,
        bullet,
        bullet_color,
        bullet_size,
        bullet_font,
        rtl
    );
    if let Some(r) = &src.default_run {
        let mut base = dst.default_run.clone().unwrap_or_default();
        merge_run(&mut base, r);
        dst.default_run = Some(base);
    }
    if !src.tab_stops.is_empty() {
        dst.tab_stops = src.tab_stops.clone();
    }
}

fn merge_run(dst: &mut RunProps, src: &RunProps) {
    take!(
        dst, src, size, bold, italic, underline, strike, caps, spacing, baseline, latin,
        east_asian, complex, fill, highlight, hyperlink, lang
    );
}

/// The effective paragraph properties of level `lvl` with the paragraph's
/// own on top.
fn paragraph_props(ctx: &TextCtx, lvl: usize, own: &ParagraphProps) -> ParagraphProps {
    let mut p = ParagraphProps::default();
    for (k, ls) in ctx.lists.iter().enumerate() {
        if k == ctx.inherited && ctx.font_ref.as_ref().is_some_and(|(_, c)| c.is_some()) {
            if let Some(run) = &mut p.default_run {
                run.fill = None;
            }
        }
        if let Some(d) = &ls.default {
            merge_para(&mut p, d);
        }
        if let Some(l) = &ls.levels[lvl] {
            merge_para(&mut p, l);
        }
    }
    if ctx.inherited >= ctx.lists.len() && ctx.font_ref.as_ref().is_some_and(|(_, c)| c.is_some()) {
        if let Some(run) = &mut p.default_run {
            run.fill = None;
        }
    }
    merge_para(&mut p, own);
    p
}

/// A typeface name with theme tokens resolved (`+mn-lt` → the minor latin font).
pub fn font_name(face: Option<&str>, ctx: &TextCtx) -> String {
    let theme = |set: &FontSet| set.latin.clone();
    let resolved = match face {
        Some("+mj-lt") | Some("+mj-ea") | Some("+mj-cs") => theme(ctx.major),
        Some("+mn-lt") | Some("+mn-ea") | Some("+mn-cs") | None => theme(ctx.minor),
        Some("") => theme(ctx.minor),
        Some(f) => Some(f.to_string()),
    };
    resolved.unwrap_or_else(|| "Calibri".to_string())
}

fn solid(fill: &Option<pptx_core::Fill>, ctx: &TextCtx) -> Option<Rgba> {
    match fill {
        Some(pptx_core::Fill::Solid(c)) => Some(resolve_color(c, ctx.colors)),
        Some(pptx_core::Fill::Gradient(g)) => {
            g.stops.first().map(|(_, c)| resolve_color(c, ctx.colors))
        }
        _ => None,
    }
}

fn run(props: &RunProps, text: String, line_break: bool, ctx: &TextCtx) -> TextRun {
    let scale = ctx.shrink.map(|s| s.0).unwrap_or(1.0);
    let rgba = solid(&props.fill, ctx)
        .or_else(|| ctx.font_ref.as_ref().and_then(|(_, c)| *c))
        .unwrap_or(Rgba::BLACK);
    let face = props
        .latin
        .as_deref()
        .or(match ctx.font_ref.as_ref().map(|(i, _)| i.as_str()) {
            Some("major") => Some("+mj-lt"),
            Some("minor") => Some("+mn-lt"),
            _ => None,
        });
    let size = props.size.unwrap_or(1800) as f64 / 100.0 * scale;
    TextRun {
        text,
        line_break,
        size,
        font: font_name(face, ctx),
        bold: props.bold.unwrap_or(false),
        italic: props.italic.unwrap_or(false),
        underline: props.underline.as_deref().is_some_and(|u| u != "none"),
        strike: props.strike.as_deref().is_some_and(|s| s != "noStrike"),
        caps: props.caps.clone().filter(|c| c != "none"),
        tracking: props.spacing.unwrap_or(0) as f64 / 100.0,
        baseline: props.baseline.unwrap_or(0) as f64 / 1000.0,
        rgb: rgba.bytes(),
        alpha: rgba.a,
        link: props.hyperlink.as_ref().and_then(|h| h.url.clone()),
        field: None,
    }
}

/// One paragraph.
pub fn paragraph(p: &Paragraph, ctx: &TextCtx) -> Para {
    let lvl = p.props.level.unwrap_or(0) as usize;
    let props = paragraph_props(ctx, lvl, &p.props);
    let base_run = props.default_run.clone().unwrap_or_default();
    let mut runs = Vec::new();
    for r in &p.runs {
        let mut rp = base_run.clone();
        merge_run(&mut rp, &r.props);
        match &r.kind {
            RunKind::Text(t) => runs.push(run(&rp, t.clone(), false, ctx)),
            RunKind::Break => runs.push(run(&rp, String::new(), true, ctx)),
            RunKind::Field { text, kind } => runs.push(TextRun {
                field: kind.clone(),
                ..run(&rp, text.clone(), false, ctx)
            }),
        }
    }
    let mut end = base_run.clone();
    if let Some(e) = &p.end_props {
        merge_run(&mut end, e);
    }
    let empty_size = run(&end, String::new(), false, ctx).size;
    // The paragraph's line height follows its largest run; an empty
    // paragraph takes its end-of-paragraph size.
    let size = runs
        .iter()
        .filter(|r| !r.line_break)
        .map(|r| r.size)
        .fold(None, |m: Option<f64>, s| Some(m.map_or(s, |m| m.max(s))))
        .unwrap_or(empty_size);
    let line_scale = 1.0 - ctx.shrink.map(|s| s.1).unwrap_or(0.0);
    let (leading, line_percent) = match props.line_spacing {
        Some(Spacing::Points(v)) => (Some(v as f64 / 100.0), None),
        Some(Spacing::Percent(v)) => {
            let pct = v as f64 / 100_000.0 * line_scale;
            if (pct - 1.0).abs() > 1e-6 {
                (Some(size * 1.2 * pct), Some(pct))
            } else {
                (None, None)
            }
        }
        None if line_scale < 1.0 => (Some(size * 1.2 * line_scale), Some(line_scale)),
        None => (None, None),
    };
    let spacing_pt = |s: Option<Spacing>| match s {
        Some(Spacing::Points(v)) => v as f64 / 100.0,
        Some(Spacing::Percent(v)) => v as f64 / 100_000.0 * size * 1.2,
        None => 0.0,
    };
    let bullet_rgb = match &props.bullet_color {
        Some(BulletColor::Color(c)) => Some(resolve_color(c, ctx.colors).bytes()),
        _ => None,
    };
    let size_percent = match props.bullet_size {
        Some(BulletSize::Percent(v)) => v as f64 / 1000.0,
        Some(BulletSize::Points(v)) if size > 0.0 => v as f64 / 100.0 / size * 100.0,
        _ => 100.0,
    };
    let bullet = match &props.bullet {
        Some(PBullet::Char(ch)) if !p.runs.is_empty() => Some(Bullet::Char {
            ch: ch.clone(),
            font: props.bullet_font.clone().flatten(),
            rgb: bullet_rgb,
            size_percent,
        }),
        Some(PBullet::AutoNumber { scheme, start_at }) if !p.runs.is_empty() => {
            Some(Bullet::Number {
                scheme: scheme.clone(),
                start: start_at.unwrap_or(1),
                rgb: bullet_rgb,
                size_percent,
            })
        }
        _ => None,
    };
    Para {
        style: ctx.style_prefix.map(|pfx| {
            if pfx == "Title" {
                pfx.to_string()
            } else {
                format!("{pfx} L{}", lvl + 1)
            }
        }),
        level: lvl as u8,
        align: props.align.clone().unwrap_or_else(|| "l".to_string()),
        margin_left: props.margin_left.unwrap_or(0) as f64 / EMU_PER_PT,
        indent: props.indent.unwrap_or(0) as f64 / EMU_PER_PT,
        leading,
        line_percent,
        space_before: spacing_pt(props.space_before),
        space_after: spacing_pt(props.space_after),
        bullet,
        runs,
        empty_size,
    }
}

/// Every paragraph of a body.
pub fn body(tb: &TextBody, ctx: &TextCtx) -> Vec<Para> {
    tb.paragraphs.iter().map(|p| paragraph(p, ctx)).collect()
}

/// The text of a body as plain lines (speaker notes).
pub fn plain(tb: &TextBody) -> String {
    tb.paragraphs
        .iter()
        .map(|p| {
            p.runs
                .iter()
                .map(|r| match &r.kind {
                    RunKind::Text(t) => t.as_str(),
                    RunKind::Break => "\n",
                    RunKind::Field { text, .. } => text.as_str(),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}
