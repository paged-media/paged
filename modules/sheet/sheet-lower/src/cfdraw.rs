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

//! What conditional formatting does to a cell, as the surfaces draw it
//! (W2.4, sheet ADR 523). The rules are evaluated elsewhere
//! (`sheet_calc::cf`, through the session's [`CellCfSource`]); this module
//! holds the drawable outcome — a style change, a number format, a data bar,
//! an icon — and the icon geometry both surfaces draw from (vector
//! primitives in a unit box, so the page and the grid draw the same icon).

use crate::style::{BorderLines, VisualAttrs};
use sheet_core::CellValue;

/// A resolved differential format: each `Some` facet replaces the cell's
/// (an explicit `false` turns bold / italic / underline / strike off).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct VisualDelta {
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    pub strike: Option<bool>,
    pub font_size_pt: Option<f64>,
    pub font_name: Option<String>,
    /// The text colour and its document swatch.
    pub text: Option<(String, Option<String>)>,
    /// The fill (its `fill_*` facets carried in a [`VisualAttrs`]).
    pub fill: Option<Box<VisualAttrs>>,
    /// The border edges the format draws (`None` edges stay the cell's).
    pub border: Option<BorderLines>,
}

/// Apply a delta to a cell's style.
pub fn apply_delta(base: &VisualAttrs, d: &VisualDelta) -> VisualAttrs {
    let mut a = base.clone();
    if let Some(b) = d.bold {
        a.bold = b;
    }
    if let Some(i) = d.italic {
        a.italic = i;
    }
    if let Some(u) = d.underline {
        a.underline = u;
        if !u {
            a.underline_style = None;
        }
    }
    if let Some(s) = d.strike {
        a.strike = s;
    }
    if d.font_size_pt.is_some() {
        a.font_size_pt = d.font_size_pt;
    }
    if d.font_name.is_some() {
        a.font_name = d.font_name.clone();
    }
    if let Some((rgb, swatch)) = &d.text {
        a.text_rgb = Some(rgb.clone());
        a.text_swatch = swatch.clone();
    }
    if let Some(f) = &d.fill {
        a.fill_rgb = f.fill_rgb.clone();
        a.fill_swatch = f.fill_swatch.clone();
        a.fill_pattern = f.fill_pattern.clone();
        a.fill_gradient = f.fill_gradient.clone();
    }
    if let Some(b) = &d.border {
        let set = |slot: &mut Option<crate::BorderLine>,
                   flag: &mut bool,
                   edge: &Option<crate::BorderLine>| {
            if let Some(l) = edge {
                *slot = Some(l.clone());
                *flag = true;
            }
        };
        set(&mut a.border_lines.top, &mut a.border_top, &b.top);
        set(&mut a.border_lines.right, &mut a.border_right, &b.right);
        set(&mut a.border_lines.bottom, &mut a.border_bottom, &b.bottom);
        set(&mut a.border_lines.left, &mut a.border_left, &b.left);
    }
    a
}

/// A data bar as a cell draws it: its extent across the cell's inner width
/// (`start..end`, fractions), its colours, the axis.
#[derive(Clone, Debug, PartialEq)]
pub struct BarDraw {
    pub start: f64,
    pub end: f64,
    pub negative: bool,
    pub color: (u8, u8, u8),
    pub color_swatch: Option<String>,
    pub border: Option<(u8, u8, u8)>,
    pub gradient: bool,
    pub axis: Option<f64>,
    pub axis_color: (u8, u8, u8),
    pub show_value: bool,
}

/// An icon as a cell draws it: its set and position in the set.
#[derive(Clone, Debug, PartialEq)]
pub struct IconDraw {
    pub set: String,
    pub index: u32,
    pub show_value: bool,
}

/// What conditional formatting does to one cell.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CellCf {
    pub delta: Option<VisualDelta>,
    /// A differential number format (the cell's text renders through it).
    pub num_fmt: Option<String>,
    /// A colour scale's fill (`#RRGGBB`).
    pub scale: Option<String>,
    pub bar: Option<BarDraw>,
    pub icon: Option<IconDraw>,
}

impl CellCf {
    /// The cell's value is hidden (a bar or icon with "show icon/bar only").
    pub fn hides_value(&self) -> bool {
        self.bar.as_ref().is_some_and(|b| !b.show_value)
            || self.icon.as_ref().is_some_and(|i| !i.show_value)
    }

    /// The style change: the delta, then a scale's fill.
    pub fn apply(&self, base: &VisualAttrs) -> VisualAttrs {
        let mut a = match &self.delta {
            Some(d) => apply_delta(base, d),
            None => base.clone(),
        };
        if let Some(rgb) = &self.scale {
            if self.delta.as_ref().is_none_or(|d| d.fill.is_none()) {
                a.fill_rgb = Some(rgb.clone());
                a.fill_swatch = None;
                a.fill_pattern = None;
                a.fill_gradient = None;
            }
        }
        a
    }
}

/// Where a lowering asks for a cell's conditional formatting: the session's
/// evaluator (`sheet_calc::cf` with its cache), or a static rule list.
pub trait CellCfSource {
    /// No rule on the sheet: the lowering skips the per-cell question.
    fn is_empty(&self) -> bool;
    /// The cell's outcome (`value` is its current value).
    fn cell_cf(&self, row: u32, col: u32, value: &CellValue) -> Option<CellCf>;
}

/// No conditional formatting.
pub struct NoCf;

impl CellCfSource for NoCf {
    fn is_empty(&self) -> bool {
        true
    }
    fn cell_cf(&self, _row: u32, _col: u32, _value: &CellValue) -> Option<CellCf> {
        None
    }
}

/// One drawn icon in content space: its cell, its box and the shapes to
/// fill (polygons in content-space pt, each with its colour).
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IconRect {
    pub row: u32,
    pub col: u32,
    pub x: f64,
    pub y: f64,
    pub size: f64,
    pub set: String,
    pub index: u32,
    pub shapes: Vec<IconShape>,
}

/// One filled polygon of an icon.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IconShape {
    pub points: Vec<[f64; 2]>,
    pub fill: String,
}

const RED: &str = "#D9363E";
const YELLOW: &str = "#F2BA02";
const GREEN: &str = "#3E9E47";
const GRAY: &str = "#808080";
const BLACK: &str = "#404040";
const PINK: &str = "#F2A0A0";
const BLUE: &str = "#3B78C3";
const WHITE: &str = "#FFFFFF";

fn circle(cx: f64, cy: f64, r: f64) -> Vec<[f64; 2]> {
    (0..20)
        .map(|i| {
            let a = std::f64::consts::TAU * f64::from(i) / 20.0;
            [cx + r * a.cos(), cy + r * a.sin()]
        })
        .collect()
}

fn shape(points: Vec<[f64; 2]>, fill: &str) -> IconShape {
    IconShape {
        points,
        fill: fill.to_string(),
    }
}

/// An arrow pointing `dir` (0 up, 1 up-right, 2 right, 3 down-right, 4 down).
fn arrow(dir: u32, fill: &str) -> Vec<IconShape> {
    let up = vec![
        [0.5, 0.05],
        [0.92, 0.5],
        [0.66, 0.5],
        [0.66, 0.95],
        [0.34, 0.95],
        [0.34, 0.5],
        [0.08, 0.5],
    ];
    let angle = f64::from(dir) * std::f64::consts::FRAC_PI_4;
    let (s, c) = angle.sin_cos();
    let pts = up
        .into_iter()
        .map(|[x, y]| {
            let (dx, dy) = (x - 0.5, y - 0.5);
            [0.5 + dx * c - dy * s, 0.5 + dx * s + dy * c]
        })
        .collect();
    vec![shape(pts, fill)]
}

fn triangle(up: bool, fill: &str) -> Vec<IconShape> {
    let pts = if up {
        vec![[0.5, 0.15], [0.9, 0.85], [0.1, 0.85]]
    } else {
        vec![[0.1, 0.15], [0.9, 0.15], [0.5, 0.85]]
    };
    vec![shape(pts, fill)]
}

fn dash(fill: &str) -> Vec<IconShape> {
    vec![shape(
        vec![[0.15, 0.4], [0.85, 0.4], [0.85, 0.6], [0.15, 0.6]],
        fill,
    )]
}

fn flag(fill: &str) -> Vec<IconShape> {
    vec![
        shape(
            vec![[0.2, 0.1], [0.28, 0.1], [0.28, 0.95], [0.2, 0.95]],
            BLACK,
        ),
        shape(vec![[0.28, 0.1], [0.85, 0.3], [0.28, 0.5]], fill),
    ]
}

fn dot(fill: &str) -> Vec<IconShape> {
    vec![shape(circle(0.5, 0.5, 0.42), fill)]
}

fn star(fill_share: f64) -> Vec<IconShape> {
    let pts: Vec<[f64; 2]> = (0..10)
        .map(|i| {
            let r = if i % 2 == 0 { 0.46 } else { 0.19 };
            let a = -std::f64::consts::FRAC_PI_2 + std::f64::consts::PI * f64::from(i) / 5.0;
            [0.5 + r * a.cos(), 0.52 + r * a.sin()]
        })
        .collect();
    let mut out = vec![shape(pts.clone(), "#D9D9D9")];
    if fill_share >= 1.0 {
        out.push(shape(pts, YELLOW));
    } else if fill_share > 0.0 {
        // The left half: the points with x left of the middle, closed on it.
        let mut half: Vec<[f64; 2]> = pts.iter().filter(|p| p[0] <= 0.5).copied().collect();
        half.push([0.5, 0.06]);
        half.insert(0, [0.5, 0.72]);
        out.push(shape(half, YELLOW));
    }
    out
}

fn bars(level: u32, of: u32) -> Vec<IconShape> {
    (0..of)
        .map(|i| {
            let x0 = 0.1 + 0.8 * f64::from(i) / f64::from(of);
            let w = 0.8 / f64::from(of) * 0.7;
            let h = 0.2 + 0.7 * f64::from(i + 1) / f64::from(of);
            shape(
                vec![
                    [x0, 0.95 - h],
                    [x0 + w, 0.95 - h],
                    [x0 + w, 0.95],
                    [x0, 0.95],
                ],
                if i < level { BLUE } else { "#D9D9D9" },
            )
        })
        .collect()
}

fn quarters(level: u32) -> Vec<IconShape> {
    let mut out = vec![shape(circle(0.5, 0.5, 0.42), WHITE)];
    out.push(shape(
        {
            let mut ring = circle(0.5, 0.5, 0.42);
            ring.extend(circle(0.5, 0.5, 0.36).into_iter().rev());
            ring
        },
        BLACK,
    ));
    if level > 0 {
        let steps = 5 * level;
        let mut pie = vec![[0.5, 0.5]];
        for i in 0..=steps {
            let a = -std::f64::consts::FRAC_PI_2
                + std::f64::consts::TAU * (f64::from(level) / 4.0) * f64::from(i)
                    / f64::from(steps);
            pie.push([0.5 + 0.36 * a.cos(), 0.5 + 0.36 * a.sin()]);
        }
        out.push(shape(pie, BLACK));
    }
    out
}

fn boxes(level: u32) -> Vec<IconShape> {
    let mut out = Vec::new();
    for i in 0..4 {
        let (x, y) = (0.12 + 0.4 * f64::from(i % 2), 0.12 + 0.4 * f64::from(i / 2));
        out.push(shape(
            vec![[x, y], [x + 0.34, y], [x + 0.34, y + 0.34], [x, y + 0.34]],
            if i < level { BLUE } else { "#D9D9D9" },
        ));
    }
    out
}

/// The shapes of icon `index` of `set` in the unit box (`[0,1]²`, y down).
/// Index 0 is the set's lowest icon. Unknown sets draw as 3 traffic lights.
pub fn icon_shapes(set: &str, index: u32) -> Vec<IconShape> {
    let tl = |i: u32| dot([RED, YELLOW, GREEN][i.min(2) as usize]);
    match set {
        "3Arrows" => match index {
            0 => arrow(4, RED),
            1 => arrow(2, YELLOW),
            _ => arrow(0, GREEN),
        },
        "3ArrowsGray" => arrow([4, 2, 0][index.min(2) as usize], GRAY),
        "4Arrows" => match index {
            0 => arrow(4, RED),
            1 => arrow(3, YELLOW),
            2 => arrow(1, YELLOW),
            _ => arrow(0, GREEN),
        },
        "4ArrowsGray" => arrow([4, 3, 1, 0][index.min(3) as usize], GRAY),
        "5Arrows" => match index {
            0 => arrow(4, RED),
            1 => arrow(3, YELLOW),
            2 => arrow(2, YELLOW),
            3 => arrow(1, YELLOW),
            _ => arrow(0, GREEN),
        },
        "5ArrowsGray" => arrow([4, 3, 2, 1, 0][index.min(4) as usize], GRAY),
        "3Flags" => flag([RED, YELLOW, GREEN][index.min(2) as usize]),
        "3TrafficLights1" | "3TrafficLights2" => {
            let mut s = Vec::new();
            if set == "3TrafficLights2" {
                s.push(shape(
                    vec![[0.12, 0.05], [0.88, 0.05], [0.88, 0.95], [0.12, 0.95]],
                    BLACK,
                ));
                s.push(shape(
                    circle(0.5, 0.5, 0.33),
                    [RED, YELLOW, GREEN][index.min(2) as usize],
                ));
                return s;
            }
            tl(index)
        }
        "3Signs" => match index {
            0 => vec![shape(
                vec![[0.5, 0.05], [0.95, 0.5], [0.5, 0.95], [0.05, 0.5]],
                RED,
            )],
            1 => triangle(true, YELLOW),
            _ => dot(GREEN),
        },
        "3Symbols" | "3Symbols2" => {
            let fill = [RED, YELLOW, GREEN][index.min(2) as usize];
            let mut s = if set == "3Symbols" {
                dot(fill)
            } else {
                Vec::new()
            };
            let ink = if set == "3Symbols" { WHITE } else { fill };
            s.extend(match index {
                0 => vec![
                    shape(
                        vec![[0.3, 0.25], [0.75, 0.7], [0.7, 0.75], [0.25, 0.3]],
                        ink,
                    ),
                    shape(
                        vec![[0.7, 0.25], [0.75, 0.3], [0.3, 0.75], [0.25, 0.7]],
                        ink,
                    ),
                ],
                1 => vec![
                    shape(
                        vec![[0.44, 0.2], [0.56, 0.2], [0.54, 0.62], [0.46, 0.62]],
                        ink,
                    ),
                    shape(circle(0.5, 0.75, 0.07), ink),
                ],
                _ => vec![shape(
                    vec![
                        [0.22, 0.5],
                        [0.3, 0.42],
                        [0.44, 0.56],
                        [0.72, 0.28],
                        [0.8, 0.36],
                        [0.44, 0.72],
                    ],
                    ink,
                )],
            });
            s
        }
        "3Stars" => star(f64::from(index.min(2)) / 2.0),
        "3Triangles" => match index {
            0 => triangle(false, RED),
            1 => dash(YELLOW),
            _ => triangle(true, GREEN),
        },
        "4RedToBlack" => dot([BLACK, GRAY, PINK, RED][index.min(3) as usize]),
        "4TrafficLights" => dot([BLACK, RED, YELLOW, GREEN][index.min(3) as usize]),
        "4Rating" => bars(index.min(3) + 1, 4),
        "5Rating" => bars(index.min(4), 4),
        "5Quarters" => quarters(index.min(4)),
        "5Boxes" => boxes(index.min(4)),
        _ => tl(index),
    }
}

/// An icon placed in a cell: at the cell's left, vertically centred, the
/// size of a line of text (at most the cell's inner height).
pub fn place_icon(
    row: u32,
    col: u32,
    icon: &IconDraw,
    cell_x: f64,
    cell_y: f64,
    cell_h: f64,
    inset: f64,
) -> IconRect {
    let size = (cell_h - 2.0 * inset).clamp(0.0, 11.0);
    let x = cell_x + inset;
    let y = cell_y + (cell_h - size) / 2.0;
    let shapes = icon_shapes(&icon.set, icon.index)
        .into_iter()
        .map(|s| IconShape {
            points: s
                .points
                .iter()
                .map(|[px, py]| [x + px * size, y + py * size])
                .collect(),
            fill: s.fill,
        })
        .collect();
    IconRect {
        row,
        col,
        x,
        y,
        size,
        set: icon.set.clone(),
        index: icon.index,
        shapes,
    }
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    #[test]
    fn every_icon_set_has_shapes_in_the_unit_box__feat__sheet_lower_condfmt() {
        for (set, n) in [
            ("3Arrows", 3),
            ("3ArrowsGray", 3),
            ("3Flags", 3),
            ("3TrafficLights1", 3),
            ("3TrafficLights2", 3),
            ("3Signs", 3),
            ("3Symbols", 3),
            ("3Symbols2", 3),
            ("3Stars", 3),
            ("3Triangles", 3),
            ("4Arrows", 4),
            ("4ArrowsGray", 4),
            ("4RedToBlack", 4),
            ("4Rating", 4),
            ("4TrafficLights", 4),
            ("5Arrows", 5),
            ("5ArrowsGray", 5),
            ("5Rating", 5),
            ("5Quarters", 5),
            ("5Boxes", 5),
        ] {
            for i in 0..n {
                let s = icon_shapes(set, i);
                assert!(!s.is_empty(), "{set} {i}");
                for sh in &s {
                    assert!(sh.points.len() >= 3, "{set} {i}");
                    for p in &sh.points {
                        assert!(
                            (-0.01..=1.01).contains(&p[0]) && (-0.01..=1.01).contains(&p[1]),
                            "{set} {i} {p:?}"
                        );
                    }
                }
            }
        }
        let placed = place_icon(
            0,
            0,
            &IconDraw {
                set: "3Arrows".into(),
                index: 2,
                show_value: true,
            },
            10.0,
            20.0,
            15.0,
            1.5,
        );
        assert_eq!((placed.x, placed.size), (11.5, 11.0));
        assert!(placed.shapes[0]
            .points
            .iter()
            .all(|p| p[0] >= 11.5 && p[0] <= 22.5));
    }

    #[test]
    fn a_delta_turns_facets_on_and_off__feat__sheet_lower_condfmt() {
        let base = VisualAttrs {
            bold: true,
            fill_rgb: Some("#FFFFFF".into()),
            ..Default::default()
        };
        let d = VisualDelta {
            bold: Some(false),
            text: Some(("#9C0006".into(), None)),
            ..Default::default()
        };
        let a = apply_delta(&base, &d);
        assert!(!a.bold);
        assert_eq!(a.text_rgb.as_deref(), Some("#9C0006"));
        assert_eq!(a.fill_rgb.as_deref(), Some("#FFFFFF"));
        let cf = CellCf {
            scale: Some("#63BE7B".into()),
            ..Default::default()
        };
        assert_eq!(cf.apply(&base).fill_rgb.as_deref(), Some("#63BE7B"));
    }
}
