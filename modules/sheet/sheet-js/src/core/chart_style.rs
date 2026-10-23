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

//! The document chart-style doors (sheet ADR 524).
//!
//! - [`SheetSession::chart_style`] / [`SheetSession::set_chart_style`] —
//!   the workbook default: role references (`chartArea`, `plotArea`,
//!   `axisLine`, `gridlines`; `text`, `title`, `axisTitle`, `tickLabels`,
//!   `legend`, `dataLabels`) and a series palette from a document colour
//!   group. Stored in `workbook.xml` (a paged extension, spliced).
//! - [`SheetSession::use_chart_style_as_default`] — a chart's overrides
//!   become the workbook default and the chart follows it.
//! - The per-chart overrides ride `update_chart` (`roles`, `resetRoles`,
//!   `seriesPalette`) and are read back by `chart_specs`.
//!
//! A swatch crosses the door as `{id, model, fallbackRgb}` (the bundle
//! reads model and display colour from the document); a bare id is taken
//! as an RGB swatch shown grey until the document resolves it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sheet_chart::style::{
    clear_overrides, is_color_role, is_role, overrides, ChartStyle, RoleStyle, SeriesPalette,
};
use sheet_core::visual::{DocColorModel, DocSwatchRef};

use super::format::DocSwatchArg;
use super::{SessionError, SheetSession};

/// A swatch argument: the full reference, or a bare id.
#[derive(Deserialize, Debug, Clone)]
#[serde(untagged)]
pub enum SwatchIn {
    Ref(DocSwatchArg),
    Id(String),
}

impl SwatchIn {
    pub(crate) fn to_ref(&self) -> Result<Option<DocSwatchRef>, SessionError> {
        match self {
            SwatchIn::Id(id) if id.trim().is_empty() => Ok(None),
            SwatchIn::Id(id) => Ok(Some(DocSwatchRef {
                id: id.trim().to_string(),
                model: DocColorModel::Rgb,
                fallback_rgb: (0x80, 0x80, 0x80),
            })),
            SwatchIn::Ref(a) if a.id.trim().is_empty() => Ok(None),
            SwatchIn::Ref(a) => a.to_ref().map(Some).ok_or_else(|| {
                SessionError(format!(
                    "bad swatch reference {:?} (model rgb|cmyk|spot|lab, fallbackRgb #RRGGBB)",
                    a.id
                ))
            }),
        }
    }
}

/// One role's references across the door; empty strings mean none.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RoleIn {
    pub swatch: Option<SwatchIn>,
    pub paragraph_style: Option<String>,
    pub character_style: Option<String>,
}

/// A document colour group as series colours.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PaletteIn {
    pub group: String,
    pub swatches: Vec<SwatchIn>,
}

/// The workbook chart style (or a chart's overrides) across the door.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ChartStyleIn {
    pub roles: BTreeMap<String, RoleIn>,
    pub palette: Option<PaletteIn>,
}

/// One role as read.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoleOut {
    pub swatch: Option<DocSwatchArg>,
    pub paragraph_style: Option<String>,
    pub character_style: Option<String>,
}

/// A palette as read.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PaletteOut {
    pub group: String,
    pub swatches: Vec<DocSwatchArg>,
}

/// The workbook chart style as read.
#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChartStyleOut {
    pub roles: BTreeMap<String, RoleOut>,
    pub palette: Option<PaletteOut>,
}

fn non_empty(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

/// A role argument as the model's references, validated.
pub(crate) fn role_style(role: &str, r: &RoleIn) -> Result<RoleStyle, SessionError> {
    if !is_role(role) {
        return Err(SessionError(format!(
            "unknown chart style role {role:?} ({})",
            sheet_chart::style::COLOR_ROLES
                .iter()
                .chain(sheet_chart::style::TEXT_ROLES)
                .copied()
                .collect::<Vec<_>>()
                .join("|")
        )));
    }
    let swatch = match &r.swatch {
        None => None,
        Some(s) => s.to_ref()?,
    };
    let (paragraph, character) = (non_empty(&r.paragraph_style), non_empty(&r.character_style));
    if is_color_role(role) && (paragraph.is_some() || character.is_some()) {
        return Err(SessionError(format!(
            "{role} is a colour role: it takes a swatch, not a paragraph or character style"
        )));
    }
    Ok(RoleStyle {
        swatch,
        paragraph,
        character,
    })
}

/// A palette argument as the model's palette, validated (`None` for an
/// empty group id).
pub(crate) fn palette(p: &PaletteIn) -> Result<Option<SeriesPalette>, SessionError> {
    let group = p.group.trim();
    if group.is_empty() {
        return Ok(None);
    }
    let mut swatches = Vec::with_capacity(p.swatches.len());
    for s in &p.swatches {
        if let Some(r) = s.to_ref()? {
            swatches.push(r);
        }
    }
    if swatches.is_empty() {
        return Err(SessionError(format!(
            "colour group {group:?} has no swatches to colour series with"
        )));
    }
    Ok(Some(SeriesPalette {
        group: group.to_string(),
        swatches,
    }))
}

fn style_of(s: &ChartStyleIn) -> Result<ChartStyle, SessionError> {
    let mut out = ChartStyle::default();
    for (role, r) in &s.roles {
        let r = role_style(role, r)?;
        if !r.is_empty() {
            out.roles.insert(role.clone(), r);
        }
    }
    out.palette = match &s.palette {
        None => None,
        Some(p) => palette(p)?,
    };
    Ok(out)
}

pub(crate) fn role_out(r: &RoleStyle) -> RoleOut {
    RoleOut {
        swatch: r.swatch.as_ref().map(DocSwatchArg::of),
        paragraph_style: r.paragraph.clone(),
        character_style: r.character.clone(),
    }
}

pub(crate) fn palette_out(p: &SeriesPalette) -> PaletteOut {
    PaletteOut {
        group: p.group.clone(),
        swatches: p.swatches.iter().map(DocSwatchArg::of).collect(),
    }
}

pub(crate) fn style_out(s: &ChartStyle) -> ChartStyleOut {
    ChartStyleOut {
        roles: s
            .roles
            .iter()
            .map(|(k, r)| (k.clone(), role_out(r)))
            .collect(),
        palette: s.palette.as_ref().map(palette_out),
    }
}

impl SheetSession {
    /// The workbook's document chart style.
    pub fn chart_style(&self) -> ChartStyleOut {
        style_out(&self.doc.chart_style)
    }

    /// Replace the workbook's document chart style (an empty one clears
    /// it). Validated whole first; written into `workbook.xml` at once (a
    /// splice of the paged extension), so the next save carries it.
    pub fn set_chart_style(&mut self, style: ChartStyleIn) -> Result<(), SessionError> {
        let style = style_of(&style)?;
        if style == self.doc.chart_style {
            return Ok(());
        }
        self.doc
            .set_chart_style(style)
            .map_err(|e| SessionError(e.to_string()))?;
        self.structure_changed = true;
        Ok(())
    }

    /// "Use as default for this workbook": chart `index`'s overrides (roles
    /// and palette) become the workbook default, replacing it, and the chart
    /// gives them up — it follows the default from now on, so it looks the
    /// same.
    pub fn use_chart_style_as_default(&mut self, index: u32) -> Result<(), SessionError> {
        let count = self.doc.charts.len();
        if index as usize >= count {
            return Err(SessionError(format!(
                "chart index {index} out of range ({count} charts)"
            )));
        }
        self.live_chart(index)?;
        let style = overrides(&self.doc.charts[index as usize].model);
        self.doc
            .set_chart_style(style)
            .map_err(|e| SessionError(e.to_string()))?;
        let chart = &mut self.doc.charts[index as usize];
        clear_overrides(&mut chart.model);
        chart.dirty = true;
        self.structure_changed = true;
        Ok(())
    }

    /// Chart `index` as drawn: its model with its palette and the workbook
    /// default applied (what the geometry, and a writer that wants the
    /// colours Excel should show, read).
    pub fn effective_chart_model(&self, index: u32) -> Option<sheet_chart::ChartModel> {
        self.doc
            .charts
            .get(index as usize)
            .map(|c| sheet_chart::style::effective(&c.model, &self.doc.chart_style))
    }
}

#[cfg(test)]
#[allow(non_snake_case)] // `__feat__<id>` test-name links (cockpit rule)
mod tests {
    use super::*;
    use crate::core::ChartPatch;

    fn session() -> SheetSession {
        let mut s = SheetSession::new();
        let rows = [["", "X", "Y"], ["a", "1", "10"], ["b", "2", "20"]];
        for (r, row) in rows.iter().enumerate() {
            for (c, v) in row.iter().enumerate() {
                if !v.is_empty() {
                    s.set_cell(0, r as u32, c as u32, v).unwrap();
                }
            }
        }
        s
    }

    fn sw(id: &str, model: &str, rgb: &str) -> SwatchIn {
        SwatchIn::Ref(DocSwatchArg {
            id: id.into(),
            model: model.into(),
            fallback_rgb: rgb.into(),
        })
    }

    fn role(swatch: Option<SwatchIn>, para: Option<&str>, chr: Option<&str>) -> RoleIn {
        RoleIn {
            swatch,
            paragraph_style: para.map(Into::into),
            character_style: chr.map(Into::into),
        }
    }

    fn json<T: serde::de::DeserializeOwned>(v: serde_json::Value) -> T {
        serde_json::from_value(v).unwrap()
    }

    /// Every swatch id the geometry of chart `i` names.
    fn swatches(s: &SheetSession, i: u32) -> Vec<String> {
        let g = s.get_chart_geometry(i, 300.0, 200.0).unwrap();
        let v = serde_json::to_value(&g.prims).unwrap();
        let mut out = Vec::new();
        fn walk(v: &serde_json::Value, out: &mut Vec<String>) {
            match v {
                serde_json::Value::Object(m) => {
                    for (k, x) in m {
                        if k.ends_with("SwatchRef") {
                            if let Some(t) = x.as_str() {
                                out.push(t.to_string());
                            }
                        }
                        walk(x, out);
                    }
                }
                serde_json::Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
                _ => {}
            }
        }
        walk(&v, &mut out);
        out
    }

    #[test]
    fn every_role_has_a_door__feat__sheet_chart_style_roles() {
        let mut s = session();
        let i = s.add_chart(0, "B2:C3", "A2:A3", "column", "T", "").unwrap();
        s.update_chart(
            i,
            json(serde_json::json!({ "dataLabels": true, "legend": true })),
        )
        .unwrap();
        let mut roles = BTreeMap::new();
        for (k, id) in [
            ("chartArea", "Color/Area"),
            ("plotArea", "Color/Plot"),
            ("axisLine", "Color/Axis"),
            ("gridlines", "Color/Grid"),
        ] {
            roles.insert(
                k.to_string(),
                Some(role(Some(sw(id, "cmyk", "#102030")), None, None)),
            );
        }
        for k in [
            "text",
            "title",
            "axisTitle",
            "tickLabels",
            "legend",
            "dataLabels",
        ] {
            roles.insert(
                k.to_string(),
                Some(role(
                    Some(sw(&format!("Color/{k}"), "spot", "#405060")),
                    Some(&format!("ParagraphStyle/{k}")),
                    Some(&format!("CharacterStyle/{k}")),
                )),
            );
        }
        let patch = ChartPatch {
            roles: Some(roles),
            ..ChartPatch::default()
        };
        s.update_chart(i, patch).unwrap();
        let spec = &s.chart_specs()[i as usize];
        assert_eq!(spec.roles.len(), 10);
        let legend = &spec.roles["legend"];
        assert_eq!(
            legend.paragraph_style.as_deref(),
            Some("ParagraphStyle/legend")
        );
        assert_eq!(
            legend.character_style.as_deref(),
            Some("CharacterStyle/legend")
        );
        let sw_out = legend.swatch.as_ref().unwrap();
        assert_eq!(
            (sw_out.model.as_str(), sw_out.fallback_rgb.as_str()),
            ("spot", "#405060")
        );
        assert_eq!(
            spec.roles["plotArea"].swatch.as_ref().unwrap().model,
            "cmyk"
        );
        // The geometry names the swatches the page then references.
        let ids = swatches(&s, i);
        for id in [
            "Color/Area",
            "Color/Plot",
            "Color/Axis",
            "Color/Grid",
            "Color/legend",
        ] {
            assert!(ids.iter().any(|x| x == id), "{id} in {ids:?}");
        }
        // Clearing one role leaves the others.
        let clear = ChartPatch {
            roles: Some(BTreeMap::from([("plotArea".to_string(), None)])),
            ..ChartPatch::default()
        };
        s.update_chart(i, clear).unwrap();
        let spec = &s.chart_specs()[i as usize];
        assert!(!spec.roles.contains_key("plotArea"));
        assert_eq!(spec.roles.len(), 9);
        // Reset gives every override up.
        s.update_chart(i, json(serde_json::json!({ "resetRoles": true })))
            .unwrap();
        assert!(s.chart_specs()[i as usize].roles.is_empty());
    }

    #[test]
    fn a_bad_role_changes_nothing__feat__sheet_chart_style_roles() {
        let mut s = session();
        let i = s.add_chart(0, "B2:C3", "A2:A3", "column", "", "").unwrap();
        let before = s.chart_specs();
        for bad in [
            serde_json::json!({ "title": "X", "roles": { "frame": { "swatch": "Color/A" } } }),
            serde_json::json!({ "title": "X", "roles": { "plotArea": { "paragraphStyle": "P" } } }),
            serde_json::json!({ "title": "X", "roles": { "plotArea": { "swatch": { "id": "C", "model": "hsv", "fallbackRgb": "#000000" } } } }),
            serde_json::json!({ "title": "X", "seriesPalette": { "group": "ColorGroup/Empty", "swatches": [] } }),
        ] {
            assert!(s.update_chart(i, json(bad)).is_err());
            assert_eq!(s.chart_specs(), before);
        }
    }

    #[test]
    fn the_series_take_a_colour_group__feat__sheet_chart_style_roles() {
        let mut s = session();
        let i = s.add_chart(0, "B2:C3", "A2:A3", "column", "", "").unwrap();
        s.update_chart(
            i,
            json(
                serde_json::json!({ "seriesPalette": { "group": "ColorGroup/Brand", "swatches": [
                { "id": "Color/A", "model": "cmyk", "fallbackRgb": "#112233" },
                { "id": "Color/B", "model": "spot", "fallbackRgb": "#445566" }
            ] } }),
            ),
        )
        .unwrap();
        let spec = &s.chart_specs()[i as usize];
        let p = spec.series_palette.as_ref().unwrap();
        assert_eq!(p.group, "ColorGroup/Brand");
        let ids = swatches(&s, i);
        assert!(ids.contains(&"Color/A".to_string()) && ids.contains(&"Color/B".to_string()));
        s.update_chart(i, json(serde_json::json!({ "seriesPalette": null })))
            .unwrap();
        assert!(s.chart_specs()[i as usize].series_palette.is_none());
        assert!(swatches(&s, i).is_empty());
    }

    #[test]
    fn the_workbook_default_reaches_every_chart_and_round_trips__feat__sheet_chart_style_roles() {
        let mut s = session();
        let a = s.add_chart(0, "B2:C3", "A2:A3", "column", "", "").unwrap();
        let b = s.add_chart(0, "B2:C3", "A2:A3", "line", "", "").unwrap();
        let style: ChartStyleIn = json(serde_json::json!({
            "roles": {
                "plotArea": { "swatch": { "id": "Color/Paper", "model": "cmyk", "fallbackRgb": "#F0EEE6" } },
                "title": { "paragraphStyle": "ParagraphStyle/Head" }
            },
            "palette": { "group": "ColorGroup/Brand", "swatches": [
                { "id": "Color/A", "model": "lab", "fallbackRgb": "#112233" }
            ] }
        }));
        s.set_chart_style(style).unwrap();
        for i in [a, b] {
            let ids = swatches(&s, i);
            assert!(ids.contains(&"Color/Paper".to_string()), "{i}: {ids:?}");
            assert!(ids.contains(&"Color/A".to_string()), "{i}: {ids:?}");
        }
        // A chart override wins over the default.
        s.update_chart(
            b,
            json(serde_json::json!({ "roles": { "plotArea": { "swatch": { "id": "Color/Own", "model": "rgb", "fallbackRgb": "#010203" } } } })),
        )
        .unwrap();
        let ids = swatches(&s, b);
        assert!(
            ids.contains(&"Color/Own".to_string()) && !ids.contains(&"Color/Paper".to_string())
        );
        // The default rides workbook.xml through a save and a reload.
        let bytes = s.save_xlsx().unwrap();
        let back = SheetSession::load_xlsx(&bytes).unwrap();
        let out = back.chart_style();
        assert_eq!(out, s.chart_style());
        let paper = out.roles["plotArea"].swatch.as_ref().unwrap();
        assert_eq!(
            (paper.model.as_str(), paper.fallback_rgb.as_str()),
            ("cmyk", "#F0EEE6")
        );
        assert_eq!(
            out.roles["title"].paragraph_style.as_deref(),
            Some("ParagraphStyle/Head")
        );
        assert_eq!(out.palette.as_ref().unwrap().swatches[0].model, "lab");
        // Clearing takes it out again.
        s.set_chart_style(ChartStyleIn::default()).unwrap();
        assert_eq!(s.chart_style(), ChartStyleOut::default());
        assert!(!swatches(&s, a).contains(&"Color/Paper".to_string()));
    }

    #[test]
    fn a_chart_style_becomes_the_workbook_default__feat__sheet_chart_style_roles() {
        let mut s = session();
        let a = s.add_chart(0, "B2:C3", "A2:A3", "column", "", "").unwrap();
        let b = s.add_chart(0, "B2:C3", "A2:A3", "bar", "", "").unwrap();
        s.update_chart(
            a,
            json(serde_json::json!({ "roles": { "chartArea": { "swatch": { "id": "Color/Bg", "model": "spot", "fallbackRgb": "#ABCDEF" } } } })),
        )
        .unwrap();
        let before = swatches(&s, a);
        s.use_chart_style_as_default(a).unwrap();
        // The chart gave its override up and looks the same.
        assert!(s.chart_specs()[a as usize].roles.is_empty());
        assert_eq!(swatches(&s, a), before);
        // The other chart follows the new default.
        assert!(swatches(&s, b).contains(&"Color/Bg".to_string()));
        assert_eq!(
            s.chart_style().roles["chartArea"]
                .swatch
                .as_ref()
                .unwrap()
                .model,
            "spot"
        );
        assert!(s.use_chart_style_as_default(99).is_err());
    }

    #[test]
    fn a_series_colour_names_its_swatch_model__feat__sheet_chart_style_roles() {
        let mut s = session();
        let i = s.add_chart(0, "B2:C3", "A2:A3", "column", "", "").unwrap();
        s.update_chart(
            i,
            json(serde_json::json!({ "series": [
                { "values": "B2:B3", "colorSwatch": { "id": "Color/Spot", "model": "spot", "fallbackRgb": "#C00000" } },
                { "values": "C2:C3", "colorSwatch": "Color/Plain" }
            ] })),
        )
        .unwrap();
        let m = &s.doc.charts[i as usize].model;
        let fills: Vec<_> = m.series().map(|x| x.fill.clone().unwrap()).collect();
        assert_eq!(fills[0].doc.as_ref().unwrap().model, DocColorModel::Spot);
        assert_eq!(fills[0].doc.as_ref().unwrap().fallback_rgb, (0xC0, 0, 0));
        assert_eq!(fills[1].doc.as_ref().unwrap().id, "Color/Plain");
        assert_eq!(
            s.chart_specs()[i as usize].series[0].color.as_deref(),
            Some("#C00000")
        );
    }
}
