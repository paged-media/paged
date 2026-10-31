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

//! Document chart styles (sheet ADR 525): the roles of a chart bound to the
//! layout document's swatches, paragraph and character styles and colour
//! groups — per chart, and as a workbook default every chart follows where
//! it does not say otherwise.
//!
//! ROLES. Colour roles: `chartArea` and `plotArea` (their fills),
//! `axisLine` (every axis line) and `gridlines` (every axis' gridlines).
//! Text roles: `text` (the chart's default text, which every other text
//! inherits), `title`, `axisTitle`, `tickLabels`, `legend` and
//! `dataLabels`, each a paragraph style, a character style and a colour.
//! A role names a slot kind, not one slot: `axisLine` is the line of every
//! axis the chart has, `dataLabels` every series' labels.
//!
//! OVERRIDE = A DOCUMENT REFERENCE. A chart overrides a role where the
//! model holds a document reference there (a swatch on the colour, a
//! paragraph or character style on the text) — exactly what the per-chart
//! door writes and what the xlsx `pg:refs` extension restores. Everywhere
//! else the workbook default applies ([`ChartStyle::apply`]), over the
//! concrete value the workbook stores. Each part of a text role is its own
//! override: a chart that names only a paragraph style takes the default's
//! character style and colour.
//!
//! SERIES PALETTE. A document colour group as the series colours: series
//! `i` (in drawing order) takes the group's swatch `i mod n`; a one-series
//! plot with one colour per point (a pie) takes them per point. A series
//! whose own colour names a swatch keeps it. A chart's own palette
//! ([`ChartModel::palette`]) wins over the workbook's.
//!
//! The defaults are applied to a COPY of the model ([`effective`]) at every
//! geometry call — the stored chart keeps only its own overrides, so a
//! changed default reaches every chart without touching any of them.

use std::collections::BTreeMap;

use crate::model::{
    Axis, ChartKind, ChartModel, ColorRef, ConcreteColor, DmlFx, DocSwatchRef, LineStyle,
    TextStyleRef,
};

/// The colour roles, in panel order.
pub const COLOR_ROLES: &[&str] = &["chartArea", "plotArea", "axisLine", "gridlines"];
/// The text roles, in panel order.
pub const TEXT_ROLES: &[&str] = &[
    "text",
    "title",
    "axisTitle",
    "tickLabels",
    "legend",
    "dataLabels",
];

/// A role tag paged.sheet knows.
pub fn is_role(tag: &str) -> bool {
    COLOR_ROLES.contains(&tag) || TEXT_ROLES.contains(&tag)
}

/// A colour role (vs a text role).
pub fn is_color_role(tag: &str) -> bool {
    COLOR_ROLES.contains(&tag)
}

/// One role's document references. A colour role uses `swatch` only; a
/// text role all three (`swatch` is its text colour).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RoleStyle {
    pub swatch: Option<DocSwatchRef>,
    pub paragraph: Option<String>,
    pub character: Option<String>,
}

impl RoleStyle {
    pub fn is_empty(&self) -> bool {
        self.swatch.is_none() && self.paragraph.is_none() && self.character.is_none()
    }
}

/// A document colour group as series colours.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SeriesPalette {
    /// The colour group's id in the layout document.
    pub group: String,
    /// Its swatches in group order (each with its model and fallback).
    pub swatches: Vec<DocSwatchRef>,
}

/// A set of role references plus an optional series palette: the
/// workbook default, or one chart's overrides as [`overrides`] reads them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChartStyle {
    /// Role tag → its references; roles without any are absent.
    pub roles: BTreeMap<String, RoleStyle>,
    pub palette: Option<SeriesPalette>,
}

impl ChartStyle {
    pub fn is_empty(&self) -> bool {
        self.roles.values().all(RoleStyle::is_empty) && self.palette.is_none()
    }

    /// Fill every role `model` does not override with this style's
    /// references (and its palette, unless the chart has its own).
    pub fn apply(&self, model: &mut ChartModel) {
        if model.palette.is_none() {
            if let Some(p) = &self.palette {
                apply_palette(model, p);
            }
        }
        for (role, r) in &self.roles {
            if is_color_role(role) {
                let Some(sw) = &r.swatch else { continue };
                for slot in color_slots(model, role, true) {
                    if slot.as_ref().is_some_and(|c| c.doc.is_some()) {
                        continue;
                    }
                    *slot = Some(swatch_color(sw));
                }
                clear_no_fill(model, role);
            } else {
                for t in text_slots(model, role) {
                    if t.doc_para_style.is_none() {
                        t.doc_para_style = r.paragraph.clone();
                    }
                    if t.doc_char_style.is_none() {
                        t.doc_char_style = r.character.clone();
                    }
                    if let Some(sw) = &r.swatch {
                        if !t.font.color.as_ref().is_some_and(|c| c.doc.is_some()) {
                            t.font.color = Some(swatch_color(sw));
                        }
                    }
                }
            }
        }
    }
}

/// The chart as it is drawn: its own palette, then `default` where it does
/// not override a role.
pub fn effective(model: &ChartModel, default: &ChartStyle) -> ChartModel {
    let mut m = model.clone();
    if let Some(p) = &model.palette {
        apply_palette(&mut m, p);
    }
    default.apply(&mut m);
    doc_colour_wins(&mut m);
    m
}

/// A document colour wins over the file's gradient or pattern (sheet ADR
/// 527): a role painted by a swatch drops the DrawingML fill it was read
/// with; its translucency stays with the fill it went with, its effects
/// stay.
fn doc_colour_wins(m: &mut ChartModel) {
    fn drop_fill(fx: &mut Option<Box<DmlFx>>) {
        if let Some(f) = fx.as_mut() {
            f.fill = None;
            if f.is_empty() {
                *fx = None;
            }
        }
    }
    let doc = |c: &Option<ColorRef>| c.as_ref().is_some_and(|c| c.doc.is_some());
    for a in [&mut m.chart_area, &mut m.plot_area] {
        if doc(&a.fill) {
            drop_fill(&mut a.fx);
        }
    }
    for plot in &mut m.plots {
        for s in &mut plot.series {
            if doc(&s.fill) {
                drop_fill(&mut s.fx);
            }
            for (i, c) in &s.points {
                if c.doc.is_none() {
                    continue;
                }
                match s.point_fx.iter_mut().find(|(p, _)| p == i) {
                    Some((_, fx)) => fx.fill = None,
                    // The point would draw the series' gradient: it takes
                    // the series' effects alone.
                    None => {
                        if let Some(sfx) = s.fx.as_deref() {
                            s.point_fx.push((
                                *i,
                                DmlFx {
                                    fill: None,
                                    ..sfx.clone()
                                },
                            ));
                        }
                    }
                }
            }
        }
    }
}

/// The colour a swatch reference paints where the document is absent.
pub fn swatch_color(sw: &DocSwatchRef) -> ColorRef {
    let (r, g, b) = sw.fallback_rgb;
    ColorRef::rgb(r, g, b).with_doc(sw.clone())
}

/// A chart's own references for `role` (the first slot that has any).
pub fn role_of(model: &ChartModel, role: &str) -> RoleStyle {
    let mut m = model.clone();
    if is_color_role(role) {
        let swatch = color_slots(&mut m, role, false)
            .into_iter()
            .find_map(|s| s.as_ref().and_then(|c| c.doc.clone()));
        return RoleStyle {
            swatch,
            ..RoleStyle::default()
        };
    }
    let mut out = RoleStyle::default();
    for t in text_slots(&mut m, role) {
        out.paragraph = out.paragraph.or_else(|| t.doc_para_style.clone());
        out.character = out.character.or_else(|| t.doc_char_style.clone());
        out.swatch = out
            .swatch
            .or_else(|| t.font.color.as_ref().and_then(|c| c.doc.clone()));
    }
    out
}

/// Every role the chart overrides, with its palette.
pub fn overrides(model: &ChartModel) -> ChartStyle {
    let mut roles = BTreeMap::new();
    for role in COLOR_ROLES.iter().chain(TEXT_ROLES) {
        let r = role_of(model, role);
        if !r.is_empty() {
            roles.insert((*role).to_string(), r);
        }
    }
    ChartStyle {
        roles,
        palette: model.palette.clone(),
    }
}

/// Set (or with `None` clear) the chart's override of `role`. A text
/// role's parts are set together: a part the style leaves `None` is
/// cleared. Unknown roles are ignored (the door validates them).
pub fn set_role(model: &mut ChartModel, role: &str, style: Option<&RoleStyle>) {
    let empty = RoleStyle::default();
    let r = style.unwrap_or(&empty);
    if is_color_role(role) {
        let create = r.swatch.is_some();
        for slot in color_slots(model, role, create) {
            match &r.swatch {
                Some(sw) => *slot = Some(swatch_color(sw)),
                None => clear_doc(slot),
            }
        }
        if create {
            clear_no_fill(model, role);
        }
        return;
    }
    for t in text_slots(model, role) {
        t.doc_para_style = r.paragraph.clone();
        t.doc_char_style = r.character.clone();
        match &r.swatch {
            Some(sw) => t.font.color = Some(swatch_color(sw)),
            None => clear_doc(&mut t.font.color),
        }
    }
}

/// Clear every document reference of the chart's roles, its series and
/// point colours and its palette: the chart follows the workbook default
/// again.
pub fn clear_overrides(model: &mut ChartModel) {
    for role in COLOR_ROLES.iter().chain(TEXT_ROLES) {
        set_role(model, role, None);
    }
    for p in &mut model.plots {
        for s in &mut p.series {
            clear_doc(&mut s.fill);
            if let Some(l) = s.line.as_mut() {
                clear_doc(&mut l.color);
            }
            s.points.retain(|(_, c)| c.doc.is_none());
        }
    }
    model.palette = None;
}

/// Drop a colour's document reference. A colour that is only the
/// reference's fallback (what the door wrote) goes back to automatic;
/// another concrete value stays.
fn clear_doc(slot: &mut Option<ColorRef>) {
    let Some(c) = slot.as_mut() else { return };
    let Some(d) = c.doc.take() else { return };
    let (r, g, b) = d.fallback_rgb;
    if c.concrete == (ConcreteColor::Rgb { r, g, b }) {
        *slot = None;
    }
}

/// A filled role painted by a swatch has a fill.
fn clear_no_fill(model: &mut ChartModel, role: &str) {
    match role {
        "chartArea" => model.chart_area.no_fill = false,
        "plotArea" => model.plot_area.no_fill = false,
        _ => {}
    }
}

fn axes_mut(model: &mut ChartModel) -> Vec<&mut Axis> {
    let mut out = vec![&mut model.cat_axis, &mut model.val_axis];
    if let Some(a) = model.sec_cat_axis.as_mut() {
        out.push(a);
    }
    if let Some(a) = model.sec_val_axis.as_mut() {
        out.push(a);
    }
    out
}

/// The colour slots of a role. `create` adds the line an axis lacks (an
/// axis line drawn in the default grey has no `LineStyle` yet); gridlines
/// are never created — a chart without them keeps none.
fn color_slots<'a>(
    model: &'a mut ChartModel,
    role: &str,
    create: bool,
) -> Vec<&'a mut Option<ColorRef>> {
    match role {
        "chartArea" => vec![&mut model.chart_area.fill],
        "plotArea" => vec![&mut model.plot_area.fill],
        "axisLine" => {
            let radial = model.kind().is_radial();
            axes_mut(model)
                .into_iter()
                .filter(|a| !a.deleted && !radial)
                .filter_map(|a| {
                    if create && a.line.is_none() {
                        a.line = Some(LineStyle::default());
                    }
                    a.line.as_mut().map(|l| &mut l.color)
                })
                .collect()
        }
        "gridlines" => axes_mut(model)
            .into_iter()
            .flat_map(|a| {
                let Axis {
                    major_gridlines,
                    minor_gridlines,
                    ..
                } = a;
                [major_gridlines.as_mut(), minor_gridlines.as_mut()]
                    .into_iter()
                    .flatten()
                    .map(|l| &mut l.color)
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// The text slots of a role (only the ones the chart shows: a chart
/// without a legend has no legend slot).
fn text_slots<'a>(model: &'a mut ChartModel, role: &str) -> Vec<&'a mut TextStyleRef> {
    match role {
        "text" => vec![&mut model.text],
        "title" => vec![&mut model.title_style],
        "axisTitle" => axes_mut(model)
            .into_iter()
            .map(|a| &mut a.title_style)
            .collect(),
        "tickLabels" => axes_mut(model).into_iter().map(|a| &mut a.labels).collect(),
        "legend" => model
            .legend
            .as_mut()
            .map(|l| &mut l.style)
            .into_iter()
            .collect(),
        "dataLabels" => {
            let mut out = Vec::new();
            for p in &mut model.plots {
                if let Some(l) = p.labels.as_mut() {
                    out.push(&mut l.style);
                }
                for s in &mut p.series {
                    if let Some(l) = s.labels.as_mut() {
                        out.push(&mut l.style);
                    }
                }
            }
            out
        }
        _ => Vec::new(),
    }
}

/// The most points one series is given palette colours for.
const MAX_POINTS: u64 = 4096;

/// Colour the series (or a pie's points) from `p`, keeping every colour
/// that already names a swatch.
fn apply_palette(model: &mut ChartModel, p: &SeriesPalette) {
    let n = p.swatches.len();
    if n == 0 {
        return;
    }
    let total = model.series_count();
    let mut gi = 0usize;
    for plot in &mut model.plots {
        let lineish = matches!(
            plot.kind,
            ChartKind::Line | ChartKind::Scatter | ChartKind::Radar | ChartKind::Stock
        );
        let per_point = total == 1 && (plot.vary_colors || plot.kind.is_radial());
        for s in &mut plot.series {
            let c = swatch_color(&p.swatches[gi % n]);
            if per_point {
                let cells = (u64::from(s.values.rows()) * u64::from(s.values.cols()))
                    .min(MAX_POINTS) as u32;
                for i in 0..cells {
                    let pc = swatch_color(&p.swatches[i as usize % n]);
                    match s.points.iter_mut().find(|(pi, _)| *pi == i) {
                        Some((_, existing)) if existing.doc.is_some() => {}
                        Some((_, existing)) => *existing = pc,
                        None => s.points.push((i, pc)),
                    }
                }
            }
            if !s.fill.as_ref().is_some_and(|f| f.doc.is_some()) {
                s.fill = Some(c.clone());
            }
            if lineish {
                if let Some(l) = s.line.as_mut() {
                    if l.color.as_ref().is_some_and(|x| x.doc.is_none()) {
                        l.color = Some(c);
                    }
                }
            }
            gi += 1;
        }
    }
}

#[cfg(test)]
#[allow(non_snake_case)] // `__feat__<id>` test-name links (cockpit rule)
mod tests {
    use super::*;
    use crate::model::{
        color_rgb, DocColorModel, Grouping, Legend, LineStyle as Ls, Series, TextStyleRef,
    };
    use sheet_core::{CellRef, RangeRef};

    fn rr(c: u32) -> RangeRef {
        let cr = |row| CellRef {
            sheet: 0,
            row,
            col: c,
            row_abs: false,
            col_abs: false,
        };
        RangeRef {
            start: cr(0),
            end: cr(2),
        }
    }

    fn sw(id: &str, model: DocColorModel, rgb: (u8, u8, u8)) -> DocSwatchRef {
        DocSwatchRef {
            id: id.into(),
            model,
            fallback_rgb: rgb,
        }
    }

    fn chart() -> ChartModel {
        let mut m = ChartModel::single(
            ChartKind::Column,
            Grouping::Standard,
            vec![Series::of(rr(1)), Series::of(rr(2)), Series::of(rr(3))],
        );
        m.legend = Some(Legend::default());
        m.val_axis.major_gridlines = Some(Ls::default());
        m
    }

    fn brand() -> ChartStyle {
        let mut roles = BTreeMap::new();
        roles.insert(
            "plotArea".into(),
            RoleStyle {
                swatch: Some(sw("Color/Paper", DocColorModel::Cmyk, (240, 238, 230))),
                ..RoleStyle::default()
            },
        );
        roles.insert(
            "gridlines".into(),
            RoleStyle {
                swatch: Some(sw("Color/Rule", DocColorModel::Spot, (200, 0, 0))),
                ..RoleStyle::default()
            },
        );
        roles.insert(
            "legend".into(),
            RoleStyle {
                paragraph: Some("ParagraphStyle/Caption".into()),
                character: Some("CharacterStyle/Small".into()),
                swatch: Some(sw("Color/Ink", DocColorModel::Lab, (20, 20, 20))),
            },
        );
        ChartStyle {
            roles,
            palette: Some(SeriesPalette {
                group: "ColorGroup/Brand".into(),
                swatches: vec![
                    sw("Color/A", DocColorModel::Cmyk, (10, 20, 30)),
                    sw("Color/B", DocColorModel::Spot, (40, 50, 60)),
                ],
            }),
        }
    }

    #[test]
    fn the_default_fills_every_role_the_chart_leaves__feat__sheet_chart_style_roles() {
        let m = effective(&chart(), &brand());
        let plot = m.plot_area.fill.as_ref().unwrap();
        assert_eq!(plot.doc.as_ref().unwrap().id, "Color/Paper");
        assert_eq!(plot.doc.as_ref().unwrap().model, DocColorModel::Cmyk);
        assert_eq!(
            plot.concrete,
            ConcreteColor::Rgb {
                r: 240,
                g: 238,
                b: 230
            }
        );
        let grid = m.val_axis.major_gridlines.as_ref().unwrap();
        assert_eq!(
            grid.color.as_ref().unwrap().doc.as_ref().unwrap().id,
            "Color/Rule"
        );
        // A chart without category gridlines gets none.
        assert!(m.cat_axis.major_gridlines.is_none());
        let legend = &m.legend.as_ref().unwrap().style;
        assert_eq!(
            legend.doc_para_style.as_deref(),
            Some("ParagraphStyle/Caption")
        );
        assert_eq!(
            legend.doc_char_style.as_deref(),
            Some("CharacterStyle/Small")
        );
        assert_eq!(
            legend
                .font
                .color
                .as_ref()
                .unwrap()
                .doc
                .as_ref()
                .unwrap()
                .model,
            DocColorModel::Lab
        );
        // The palette cycles: A, B, A.
        let ids: Vec<_> = m
            .series()
            .map(|s| s.fill.as_ref().unwrap().doc.as_ref().unwrap().id.clone())
            .collect();
        assert_eq!(ids, ["Color/A", "Color/B", "Color/A"]);
    }

    #[test]
    fn a_chart_override_wins_part_by_part__feat__sheet_chart_style_roles() {
        let mut c = chart();
        set_role(
            &mut c,
            "plotArea",
            Some(&RoleStyle {
                swatch: Some(sw("Color/Mine", DocColorModel::Rgb, (1, 2, 3))),
                ..RoleStyle::default()
            }),
        );
        // Only the paragraph style: the default's character style and
        // colour still apply.
        set_role(
            &mut c,
            "legend",
            Some(&RoleStyle {
                paragraph: Some("ParagraphStyle/Mine".into()),
                ..RoleStyle::default()
            }),
        );
        c.plots[0].series[1].fill =
            Some(swatch_color(&sw("Color/S", DocColorModel::Rgb, (9, 9, 9))));
        let m = effective(&c, &brand());
        assert_eq!(
            m.plot_area.fill.as_ref().unwrap().doc.as_ref().unwrap().id,
            "Color/Mine"
        );
        let legend = &m.legend.as_ref().unwrap().style;
        assert_eq!(
            legend.doc_para_style.as_deref(),
            Some("ParagraphStyle/Mine")
        );
        assert_eq!(
            legend.doc_char_style.as_deref(),
            Some("CharacterStyle/Small")
        );
        let ids: Vec<_> = m
            .series()
            .map(|s| s.fill.as_ref().unwrap().doc.as_ref().unwrap().id.clone())
            .collect();
        assert_eq!(ids, ["Color/A", "Color/S", "Color/A"]);
        // The stored chart is untouched by the default.
        assert!(c.val_axis.major_gridlines.as_ref().unwrap().color.is_none());
    }

    #[test]
    fn a_chart_palette_wins_and_pies_take_it_per_point__feat__sheet_chart_style_roles() {
        let mut pie =
            ChartModel::single(ChartKind::Pie, Grouping::Standard, vec![Series::of(rr(1))]);
        pie.plots[0].vary_colors = true;
        pie.palette = Some(SeriesPalette {
            group: "ColorGroup/Own".into(),
            swatches: vec![
                sw("Color/X", DocColorModel::Rgb, (1, 1, 1)),
                sw("Color/Y", DocColorModel::Rgb, (2, 2, 2)),
            ],
        });
        let m = effective(&pie, &brand());
        let pts: Vec<_> = m.plots[0].series[0]
            .points
            .iter()
            .map(|(i, c)| (*i, c.doc.as_ref().unwrap().id.clone()))
            .collect();
        assert_eq!(
            pts,
            [
                (0, "Color/X".to_string()),
                (1, "Color/Y".into()),
                (2, "Color/X".into())
            ]
        );
    }

    #[test]
    fn overrides_read_back_and_clear__feat__sheet_chart_style_roles() {
        let mut c = chart();
        let style = brand();
        for (role, r) in &style.roles {
            set_role(&mut c, role, Some(r));
        }
        c.palette = style.palette.clone();
        assert_eq!(overrides(&c), style);
        clear_overrides(&mut c);
        assert!(overrides(&c).is_empty());
        // What the door wrote goes back to automatic.
        assert!(c.plot_area.fill.is_none());
        assert!(c.legend.as_ref().unwrap().style.font.color.is_none());
    }

    #[test]
    fn clearing_keeps_a_concrete_colour_that_is_not_the_fallback__feat__sheet_chart_style_roles() {
        let mut c = chart();
        c.chart_area.fill =
            Some(color_rgb(0x112233).with_doc(sw("Color/Old", DocColorModel::Rgb, (0, 0, 0))));
        set_role(&mut c, "chartArea", None);
        assert_eq!(c.chart_area.fill, Some(color_rgb(0x112233)));
        c.title_style = TextStyleRef {
            doc_para_style: Some("P".into()),
            ..TextStyleRef::default()
        };
        set_role(&mut c, "title", None);
        assert!(c.title_style.doc_para_style.is_none());
    }

    #[test]
    fn an_axis_line_role_creates_the_line_and_a_fill_drops_no_fill__feat__sheet_chart_style_roles()
    {
        let mut c = chart();
        c.plot_area.no_fill = true;
        let mut style = ChartStyle::default();
        style.roles.insert(
            "axisLine".into(),
            RoleStyle {
                swatch: Some(sw("Color/Axis", DocColorModel::Rgb, (5, 5, 5))),
                ..RoleStyle::default()
            },
        );
        style.roles.insert(
            "plotArea".into(),
            RoleStyle {
                swatch: Some(sw("Color/P", DocColorModel::Rgb, (6, 6, 6))),
                ..RoleStyle::default()
            },
        );
        let m = effective(&c, &style);
        for a in [&m.cat_axis, &m.val_axis] {
            assert_eq!(
                a.line
                    .as_ref()
                    .unwrap()
                    .color
                    .as_ref()
                    .unwrap()
                    .doc
                    .as_ref()
                    .unwrap()
                    .id,
                "Color/Axis"
            );
        }
        assert!(!m.plot_area.no_fill);
        assert!(is_role("axisLine") && is_role("dataLabels") && !is_role("series"));
    }
}
