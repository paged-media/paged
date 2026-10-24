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

//! Writing charts back into the package (W4.3, sheet ADR 519; the ADR 503
//! amendment: existing parts are patched, parts Paged creates are
//! generated).
//!
//! - An EDITED chart read from the workbook is SPLICED: its part is read
//!   back, compared with the edited model role by role, and only what
//!   changed is replaced in the element tree (a series' `c:f` and caches,
//!   its fill, labels, marker, trendlines and error bars; the title; the
//!   legend; an axis' scaling, title, number format and gridlines; a plot
//!   element when its kind changes, the whole plot area when the axis
//!   family changes; a series added by copying the last one's subtree, a
//!   series removed by dropping its element). Everything else keeps its
//!   bytes' meaning (the tree is re-serialised as read).
//! - A chart AUTHORED in Paged is GENERATED: a complete `c:chartSpace` (or
//!   `cx:chartSpace` for the Office 2016 kinds), an anchor in the host
//!   sheet's drawing (a new drawing part, its relationship and the
//!   worksheet's `<drawing>` when the sheet had none), the relationships and
//!   the content-type overrides.
//! - A DELETED chart is removed: its anchor, relationship, part and
//!   override. (A chartsheet's chart stays: the tab is the chart.)
//! - Colours are written as their concrete value: sRGB, or the theme slot
//!   with `lumMod`/`lumOff` when the role was theme-sourced; a document
//!   swatch on an automatic colour writes the swatch's sRGB. Text roles
//!   write `a:latin`, size, bold and italic. The document references and the
//!   chart's session index ride in Paged's `c:extLst` extension; the index
//!   keeps every chart's handle stable across a save and reload.

use std::collections::BTreeSet;

use dml_chart::write::{self as w, ChartExOut, ChartOut, ColorOut, DataOut, ExtOut};
use paged_ooxml::tree::{El, Ns};
use sheet_chart::model::*;
use sheet_core::{CellValue, RangeRef, SheetId, SheetModel};

use crate::error::XlsxError;
use crate::opc::PartEntry;
use crate::parts::chart::{
    color_roles, concrete_rgb, parse, text_roles, ParsedChart, SheetResolver, PAGED_EXT_NS,
    PAGED_EXT_URI,
};
use crate::preserve::{Anchor, CapturedSubtree};
use crate::rels::{parse_rels, part_dir, rels_part_name, resolve_target, REL_DRAWING};
use crate::splice::{render_tag, root_children, splice};
use crate::XlsxDocument;

const CT_CHART: &str = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
const CT_CHART_EX: &str = "application/vnd.ms-office.chartex+xml";
const CT_DRAWING: &str = "application/vnd.openxmlformats-officedocument.drawing+xml";
const RT_CHART: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";
const RT_CHART_EX: &str = "http://schemas.microsoft.com/office/2014/relationships/chartEx";
const RT_DRAWING: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";
const NS_XDR: &str = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";

/// Resolves sheet names against the live model.
struct LiveNames<'a>(&'a SheetModel);
impl SheetResolver for LiveNames<'_> {
    fn resolve(&self, name: &str) -> Option<SheetId> {
        self.0.sheet_id(name)
    }
    fn defined(&self, name: &str) -> Option<String> {
        crate::parts::chart::defined_reference(self.0, name)
    }
}

impl XlsxDocument {
    /// Write the session's charts into the package before a save: splice
    /// the edited ones, generate the authored ones, remove the deleted
    /// ones (`removed` holds their indexes). `model` is the live model (the
    /// caches are written from its values, the references from its names).
    pub fn write_charts(
        &mut self,
        model: &SheetModel,
        removed: &BTreeSet<u32>,
    ) -> Result<(), XlsxError> {
        // Deletes first: a removed part's name may be reused by a new chart.
        for i in 0..self.charts.len() {
            let gone = removed.contains(&(i as u32));
            if gone && self.charts[i].part.is_some() && !self.charts[i].chartsheet {
                self.remove_chart_part(i)?;
            }
        }
        // A chart written by Paged records its index; when one was removed,
        // the charts after it record theirs too, so a reload finds every
        // handle where it was.
        let tomb: Vec<u32> = removed.iter().copied().collect();
        for i in 0..self.charts.len() {
            if removed.contains(&(i as u32)) {
                continue;
            }
            let c = &self.charts[i];
            if c.part.is_none() {
                self.generate_chart(i, model, &tomb)?;
            } else if c.dirty {
                self.splice_chart(i, model, &tomb)?;
            }
        }
        Ok(())
    }

    fn remove_chart_part(&mut self, i: usize) -> Result<(), XlsxError> {
        let (Some(part), Some(drawing)) =
            (self.charts[i].part.clone(), self.charts[i].drawing.clone())
        else {
            return Ok(());
        };
        let drels = rels_part_name(&drawing);
        let base = part_dir(&drawing).to_string();
        if let Some(raw) = self.part_bytes(&drels) {
            let rels = parse_rels(&raw)?;
            if let Some(rel) = rels
                .items
                .iter()
                .find(|r| resolve_target(&base, &r.target) == part)
            {
                let id = rel.id.clone();
                self.remove_anchor(&drawing, &id)?;
                self.remove_rel(&drels, &id)?;
            }
        }
        // The chart's own relationships (style, colours, user shapes) and
        // the style parts only it uses.
        let crels = rels_part_name(&part);
        let mut gone = vec![part.clone(), crels.clone()];
        if let Some(raw) = self.part_bytes(&crels) {
            let dir = part_dir(&part).to_string();
            for r in parse_rels(&raw)?.items {
                if r.is_type("/chartStyle") || r.is_type("/chartColorStyle") {
                    gone.push(resolve_target(&dir, &r.target));
                }
            }
        }
        for g in &gone[2..] {
            self.remove_override(g)?;
        }
        self.container
            .parts
            .retain(|p| !gone.iter().any(|g| g == p.name()));
        self.remove_override(&part)?;
        self.container.dirty = true;
        let c = &mut self.charts[i];
        c.part = None;
        c.drawing = None;
        c.removed = true;
        Ok(())
    }

    /// Drop the drawing anchor whose graphic frame names relationship `id`.
    fn remove_anchor(&mut self, drawing: &str, id: &str) -> Result<(), XlsxError> {
        let Some(raw) = self.part_bytes(drawing) else {
            return Ok(());
        };
        let (kids, _) = root_children(&raw)?;
        for k in kids.iter().rev() {
            let body = &raw[k.start..k.end];
            let needle = format!("\"{id}\"");
            let s = String::from_utf8_lossy(body);
            if (s.contains(":chart ") || s.contains("<chart ")) && s.contains(&needle) {
                let out = splice(&raw, k.start, k.end, b"");
                self.set_part_bytes(drawing, out);
                break;
            }
        }
        Ok(())
    }

    /// Splice an edited chart into its part.
    fn splice_chart(
        &mut self,
        i: usize,
        model: &SheetModel,
        tomb: &[u32],
    ) -> Result<(), XlsxError> {
        let part = self.charts[i].part.clone().expect("a parsed chart");
        let Some(orig) = self.part_bytes(&part) else {
            return Ok(());
        };
        let host = self.charts[i].host_sheet;
        let names = LiveNames(model);
        let before = parse(&orig, host, &names)?.model;
        // The extension records the chart's OWN references; the part shows
        // the colours the chart draws, the workbook default chart style
        // applied (sheet ADR 525), so another application sees them too.
        let own = self.charts[i].model.clone();
        let after = sheet_chart::style::effective(&own, &self.chart_style);
        let mut root = paged_ooxml::tree::parse(&orig).map_err(XlsxError::Structure)?;
        let ext = Some(ext_of(&own, i as u32, tomb));
        if root.is(Ns::Cx, "chartSpace") {
            // A chartEx part: only the extension and the title are spliced
            // (its data dimensions name the same cells); a structural edit
            // regenerates it.
            if before.plots != after.plots || before.title != after.title {
                let out = chart_ex_out(&after, model, i as u32, tomb).map(|mut o| {
                    o.ext = ext.clone();
                    o
                });
                if let Some(out) = out {
                    self.set_part_bytes(&part, w::generate_ex(&out).into_bytes());
                    self.charts[i].dirty = false;
                    return Ok(());
                }
            }
            w::put_ext(&mut root, ext.as_ref(), PAGED_EXT_URI).map_err(XlsxError::Structure)?;
            self.set_part_bytes(&part, w::serialise(&orig, &root));
            self.charts[i].dirty = false;
            return Ok(());
        }
        w::ensure_prefixes(&mut root);
        let mut out = chart_out(&after, model, i as u32, tomb);
        out.ext = ext.clone();
        splice_tree(&mut root, &before, &after, &out).map_err(XlsxError::Structure)?;
        w::put_ext(&mut root, ext.as_ref(), PAGED_EXT_URI).map_err(XlsxError::Structure)?;
        self.set_part_bytes(&part, w::serialise(&orig, &root));
        self.charts[i].dirty = false;
        Ok(())
    }

    /// Generate an authored chart's part, anchor and relationships.
    fn generate_chart(
        &mut self,
        i: usize,
        model: &SheetModel,
        tomb: &[u32],
    ) -> Result<(), XlsxError> {
        let chart = self.charts[i].clone();
        let ex = chart.model.kind().is_chart_ex();
        // Drawn colours with the workbook default applied; the extension
        // keeps the chart's own references (ADR 525).
        let shown = sheet_chart::style::effective(&chart.model, &self.chart_style);
        let own_ext = Some(ext_of(&chart.model, i as u32, tomb));
        let bytes = if ex {
            match chart_ex_out(&shown, model, i as u32, tomb) {
                Some(mut out) => {
                    out.ext = own_ext;
                    w::generate_ex(&out).into_bytes()
                }
                None => return Ok(()),
            }
        } else if chart.model.kind() == ChartKind::Unsupported {
            return Ok(());
        } else {
            let mut out = chart_out(&shown, model, i as u32, tomb);
            out.ext = own_ext;
            w::generate(&out).into_bytes()
        };
        // The part.
        let stem = if ex { "chartEx" } else { "chart" };
        let mut n = 1;
        let part = loop {
            let p = format!("xl/charts/{stem}{n}.xml");
            if self.container.part(&p).is_none() {
                break p;
            }
            n += 1;
        };
        self.container.parts.push(PartEntry::Opaque {
            name: part.clone(),
            bytes,
        });
        self.add_override(&part, if ex { CT_CHART_EX } else { CT_CHART })?;
        if ex {
            // Excel opens a chartEx part only with its style and colour parts.
            let mut k = 1;
            let (style, colors) = loop {
                let st = format!("xl/charts/style{k}.xml");
                let co = format!("xl/charts/colors{k}.xml");
                if self.container.part(&st).is_none() && self.container.part(&co).is_none() {
                    break (st, co);
                }
                k += 1;
            };
            self.container.parts.push(PartEntry::Opaque {
                name: style.clone(),
                bytes: w::chart_style_xml(410).into_bytes(),
            });
            self.container.parts.push(PartEntry::Opaque {
                name: colors.clone(),
                bytes: w::chart_colors_xml().into_bytes(),
            });
            self.add_override(&style, w::CT_CHART_STYLE)?;
            self.add_override(&colors, w::CT_CHART_COLORS)?;
            let crels = rels_part_name(&part);
            let dir = part_dir(&part).to_string();
            self.add_rel(&crels, w::RT_CHART_STYLE, &relative(&dir, &style))?;
            self.add_rel(&crels, w::RT_CHART_COLORS, &relative(&dir, &colors))?;
        }
        // The drawing (the host's first, or a new one).
        let drawing = self.drawing_of(chart.host_sheet)?;
        let drels = rels_part_name(&drawing);
        let target = relative(part_dir(&drawing), &part);
        let rid = self.add_rel(&drels, if ex { RT_CHART_EX } else { RT_CHART }, &target)?;
        let anchor = chart.anchor.unwrap_or_else(|| default_anchor(&chart.model));
        self.add_anchor(&drawing, &rid, anchor, ex, n)?;
        let c = &mut self.charts[i];
        c.part = Some(part);
        c.drawing = Some(drawing);
        c.chart_ex = ex;
        c.dirty = false;
        Ok(())
    }

    /// The host sheet's drawing part, created (with its relationship and the
    /// worksheet's `<drawing>`) when the sheet has none.
    fn drawing_of(&mut self, sheet: SheetId) -> Result<String, XlsxError> {
        let Some(bi) = self.bindings.iter().position(|b| b.sheet_id == sheet) else {
            return Err(XlsxError::Structure(format!(
                "no sheet {sheet} to anchor a chart on"
            )));
        };
        let ws = self.bindings[bi].part_name.clone();
        let wrels = rels_part_name(&ws);
        let base = part_dir(&ws).to_string();
        if let Some(raw) = self.part_bytes(&wrels) {
            let rels = parse_rels(&raw)?;
            let first = rels
                .all_of_type(REL_DRAWING)
                .next()
                .map(|r| resolve_target(&base, &r.target));
            if let Some(d) = first {
                return Ok(d);
            }
        }
        let mut n = 1;
        let drawing = loop {
            let p = format!("xl/drawings/drawing{n}.xml");
            if self.container.part(&p).is_none() {
                break p;
            }
            n += 1;
        };
        let xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="{NS_XDR}" xmlns:a="{}"></xdr:wsDr>"#,
            w::NS_A
        );
        self.container.parts.push(PartEntry::Opaque {
            name: drawing.clone(),
            bytes: xml.into_bytes(),
        });
        self.add_override(&drawing, CT_DRAWING)?;
        let rid = self.add_rel(&wrels, RT_DRAWING, &relative(&base, &drawing))?;
        // `<drawing r:id>` among the worksheet's children, in schema order.
        let el = format!(r#"<drawing xmlns:r="{}" r:id="{rid}"/>"#, w::NS_R);
        let binding = &mut self.bindings[bi];
        const AFTER_DRAWING: &[&str] = &[
            "legacyDrawing",
            "legacyDrawingHF",
            "drawingHF",
            "picture",
            "oleObjects",
            "controls",
            "webPublishItems",
            "tableParts",
            "extLst",
        ];
        let pos = binding
            .captured
            .items
            .iter()
            .position(|c| {
                c.anchor == Anchor::AfterSheetData
                    && AFTER_DRAWING.contains(&crate::write::captured_local(&c.bytes).as_str())
            })
            .unwrap_or(binding.captured.items.len());
        binding.captured.items.insert(
            pos,
            CapturedSubtree {
                anchor: Anchor::AfterSheetData,
                bytes: el.into_bytes(),
                span: None,
            },
        );
        self.mark_sheet_dirty(sheet);
        Ok(drawing)
    }

    /// Splice a `<Relationship>` into a `.rels` part (created if absent);
    /// returns its id.
    pub(crate) fn add_rel(
        &mut self,
        rels_part: &str,
        rel_type: &str,
        target: &str,
    ) -> Result<String, XlsxError> {
        let raw = self.part_bytes(rels_part).unwrap_or_else(|| {
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>"#
                .to_vec()
        });
        let rels = parse_rels(&raw)?;
        let used: BTreeSet<&str> = rels.items.iter().map(|r| r.id.as_str()).collect();
        let mut n = rels.items.len() + 1;
        let id = loop {
            let cand = format!("rId{n}");
            if !used.contains(cand.as_str()) {
                break cand;
            }
            n += 1;
        };
        let (_, close) = root_children(&raw)?;
        let tag = render_tag(
            "Relationship",
            &[
                ("Id".into(), id.clone()),
                ("Type".into(), rel_type.into()),
                ("Target".into(), target.into()),
            ],
            true,
        );
        let out = splice(&raw, close, close, tag.as_bytes());
        if self.container.part(rels_part).is_some() {
            self.set_part_bytes(rels_part, out);
        } else {
            self.container.parts.push(PartEntry::Opaque {
                name: rels_part.to_string(),
                bytes: out,
            });
            self.container.dirty = true;
        }
        Ok(id)
    }

    /// Append a two-cell anchor holding the chart to a drawing part.
    fn add_anchor(
        &mut self,
        drawing: &str,
        rid: &str,
        (c0, r0, c1, r1): (u32, u32, u32, u32),
        ex: bool,
        n: usize,
    ) -> Result<(), XlsxError> {
        let raw = self
            .part_bytes(drawing)
            .ok_or_else(|| XlsxError::Structure(format!("missing {drawing}")))?;
        // A drawing-unique shape id.
        let text = String::from_utf8_lossy(&raw);
        let mut id = 1u32;
        for (at, _) in text.match_indices(" id=\"") {
            let rest = &text[at + 5..];
            if let Some(end) = rest.find('"') {
                if let Ok(v) = rest[..end].parse::<u32>() {
                    id = id.max(v + 1);
                }
            }
        }
        let frame = |inner: &str| {
            format!(
                r#"<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="{id}" name="Chart {n}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic>{inner}</a:graphic></xdr:graphicFrame>"#
            )
        };
        let body = if ex {
            let inner = format!(
                r#"<a:graphicData uri="{}"><cx:chart xmlns:cx="{}" xmlns:r="{}" r:id="{rid}"/></a:graphicData>"#,
                w::NS_CX,
                w::NS_CX,
                w::NS_R
            );
            format!(
                r#"<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:cx1="http://schemas.microsoft.com/office/drawing/2015/9/8/chartex" Requires="cx1">{}</mc:Choice><mc:Fallback><xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="{}" name="Chart {n}"/><xdr:cNvSpPr><a:spLocks noTextEdit="1"/></xdr:cNvSpPr></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="4572000" cy="2743200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr><xdr:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1100"/><a:t>This chart is not available in your version of Excel.</a:t></a:r></a:p></xdr:txBody></xdr:sp></mc:Fallback></mc:AlternateContent>"#,
                frame(&inner),
                id + 1
            )
        } else {
            frame(&format!(
                r#"<a:graphicData uri="{}"><c:chart xmlns:c="{}" xmlns:r="{}" r:id="{rid}"/></a:graphicData>"#,
                w::NS_C,
                w::NS_C,
                w::NS_R
            ))
        };
        let anchor = format!(
            r#"<xdr:twoCellAnchor xmlns:xdr="{NS_XDR}" xmlns:a="{}" editAs="oneCell"><xdr:from><xdr:col>{c0}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>{r0}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>{c1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>{r1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>{body}<xdr:clientData/></xdr:twoCellAnchor>"#,
            w::NS_A
        );
        let (_, close) = root_children(&raw)?;
        let out = splice(&raw, close, close, anchor.as_bytes());
        self.set_part_bytes(drawing, out);
        Ok(())
    }
}

/// A part's target relative to a base directory (`../charts/chart1.xml`).
fn relative(base_dir: &str, part: &str) -> String {
    let base: Vec<&str> = base_dir.split('/').filter(|s| !s.is_empty()).collect();
    let target: Vec<&str> = part.split('/').filter(|s| !s.is_empty()).collect();
    let common = base.iter().zip(&target).take_while(|(a, b)| a == b).count();
    let mut out: Vec<String> = Vec::new();
    for _ in common..base.len() {
        out.push("..".into());
    }
    for t in &target[common..] {
        out.push((*t).to_string());
    }
    out.join("/")
}

/// Where an authored chart goes: right of its data, 8 columns × 15 rows.
fn default_anchor(m: &ChartModel) -> (u32, u32, u32, u32) {
    let (mut right, mut top) = (0u32, u32::MAX);
    for s in m.series() {
        let n = s.values.normalized();
        right = right.max(n.end.col);
        top = top.min(n.start.row);
        if let Some(c) = s.categories.or(s.x_values) {
            right = right.max(c.normalized().end.col);
        }
    }
    let top = if top == u32::MAX {
        0
    } else {
        top.saturating_sub(1)
    };
    let c0 = right + 2;
    (c0, top, c0 + 8, top + 15)
}

// ── the model as written ────────────────────────────────────────────────────

fn color_out(c: &ColorRef) -> Option<ColorOut> {
    match c.concrete {
        ConcreteColor::Rgb { .. } => rgb_of(c).map(ColorOut::Srgb),
        ConcreteColor::Theme { index, tint } => {
            const SLOTS: [&str; 12] = [
                "tx1", "bg1", "tx2", "bg2", "accent1", "accent2", "accent3", "accent4", "accent5",
                "accent6", "hlink", "folHlink",
            ];
            let dml = dml_to_sheet_index(index.min(11) as u8) as usize;
            let (lum_mod, lum_off) = if tint < 0.0 {
                (Some(((1.0 + tint) * 100_000.0).round() as i64), None)
            } else if tint > 0.0 {
                (
                    Some(((1.0 - tint) * 100_000.0).round() as i64),
                    Some((tint * 100_000.0).round() as i64),
                )
            } else {
                (None, None)
            };
            Some(ColorOut::Scheme {
                slot: SLOTS[dml].to_string(),
                lum_mod,
                lum_off,
            })
        }
        ConcreteColor::Indexed { index } => Some(ColorOut::Srgb(sheet_chart::colors::indexed(
            index.min(255) as u8,
        ))),
        ConcreteColor::Auto => c.doc.as_ref().map(|d| {
            let (r, g, b) = d.fallback_rgb;
            ColorOut::Srgb((u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b))
        }),
    }
}

fn line_out(l: &LineStyle) -> w::LineOut {
    w::LineOut {
        color: l.color.as_ref().and_then(color_out),
        width_pt: l.width_pt,
        dash: l.dash.as_ref().map(|d| d.to_string()),
        none: l.none,
    }
}

fn run_out(t: &TextStyleRef) -> w::RunOut {
    let f = &t.font;
    w::RunOut {
        font: f.name.clone(),
        size: f.size,
        bold: f.bold.then_some(true),
        italic: f.italic.then_some(true),
        color: f.color.as_ref().and_then(color_out),
    }
}

fn area_out(a: &AreaStyle) -> w::ShapeOut {
    w::ShapeOut {
        fill: a.fill.as_ref().and_then(color_out),
        no_fill: a.no_fill,
        line: a.line.as_ref().map(line_out),
    }
}

/// A range as a `c:f` body (`Sheet1!$B$2:$B$4`, the sheet quoted when it
/// must be).
fn range_f(model: &SheetModel, r: &RangeRef) -> String {
    let n = r.normalized();
    let sheet = model
        .sheet(n.start.sheet)
        .map(|w| crate::structure::quote_sheet(&w.name))
        .unwrap_or_else(|| "#REF".into());
    let at = |row: u32, col: u32| format!("${}${}", sheet_core::col_to_a1(col), row + 1);
    if n.start == n.end || (n.start.row == n.end.row && n.start.col == n.end.col) {
        format!("{sheet}!{}", at(n.start.row, n.start.col))
    } else {
        format!(
            "{sheet}!{}:{}",
            at(n.start.row, n.start.col),
            at(n.end.row, n.end.col)
        )
    }
}

fn cells<'a>(model: &'a SheetModel, r: &RangeRef) -> Vec<Option<&'a CellValue>> {
    let n = r.normalized();
    let ws = model.sheet(n.start.sheet);
    let mut out = Vec::new();
    for row in n.start.row..=n.end.row {
        for col in n.start.col..=n.end.col {
            out.push(ws.and_then(|w| w.cell(row, col)).map(|c| &c.value));
        }
    }
    out
}

/// A numeric data reference with its cache.
fn num_data(model: &SheetModel, r: &RangeRef) -> DataOut {
    let n = r.normalized();
    let format = model
        .sheet(n.start.sheet)
        .and_then(|w| w.cell(n.start.row, n.start.col))
        .map(|c| model.styles.num_fmt_of(c.style).to_string());
    DataOut {
        formula: Some(range_f(model, r)),
        numbers: Some(
            cells(model, r)
                .into_iter()
                .map(|v| match v {
                    Some(CellValue::Number(x)) => Some(*x),
                    Some(CellValue::Bool(b)) => Some(f64::from(u8::from(*b))),
                    _ => None,
                })
                .collect(),
        ),
        strings: None,
        format,
    }
}

/// A category / name reference with its string cache (the cells' text).
fn str_data(model: &SheetModel, r: &RangeRef) -> DataOut {
    DataOut {
        formula: Some(range_f(model, r)),
        numbers: None,
        strings: Some(
            cells(model, r)
                .into_iter()
                .map(|v| match v {
                    Some(CellValue::Text(t)) => t.to_string(),
                    Some(CellValue::Number(x)) => {
                        sheet_format::format_general(&CellValue::Number(*x))
                    }
                    Some(CellValue::Bool(b)) => if *b { "TRUE" } else { "FALSE" }.to_string(),
                    _ => String::new(),
                })
                .collect(),
        ),
        format: None,
    }
}

/// Categories are a number reference when every cell is a number (Excel
/// writes `c:numRef` for numeric or date categories).
fn cat_data(model: &SheetModel, r: &RangeRef) -> DataOut {
    let all_numbers = cells(model, r)
        .iter()
        .all(|v| matches!(v, Some(CellValue::Number(_))));
    if all_numbers {
        num_data(model, r)
    } else {
        str_data(model, r)
    }
}

fn labels_out(d: &DataLabels) -> w::LabelsOut {
    w::LabelsOut {
        show_value: d.show_value,
        show_category: d.show_category,
        show_series: d.show_series,
        show_percent: d.show_percent,
        show_bubble_size: d.show_bubble_size,
        position: d.position.map(|p| p.tag().to_string()),
        format: d.format.as_ref().map(|f| f.to_string()),
        separator: d.separator.as_ref().map(|s| s.to_string()),
        run: run_out(&d.style),
    }
}

fn series_out(model: &SheetModel, s: &Series, idx: u32, plot: &Plot) -> w::SeriesOut {
    let xy = plot.kind.is_xy();
    let name = match (&s.name_ref, &s.name) {
        (Some(r), n) => Some(w::TextOut {
            text: n.as_ref().map(|n| n.to_string()).unwrap_or_else(|| {
                str_data(model, r)
                    .strings
                    .and_then(|v| v.into_iter().next())
                    .unwrap_or_default()
            }),
            formula: Some(range_f(model, r)),
            ..w::TextOut::default()
        }),
        (None, Some(n)) => Some(w::TextOut {
            text: n.to_string(),
            ..w::TextOut::default()
        }),
        (None, None) => None,
    };
    let lineish = matches!(
        plot.kind,
        ChartKind::Line | ChartKind::Scatter | ChartKind::Radar | ChartKind::Stock
    );
    let shape = w::ShapeOut {
        fill: if lineish {
            None
        } else {
            s.fill.as_ref().and_then(color_out)
        },
        no_fill: false,
        line: match (&s.line, lineish, &s.fill) {
            (Some(l), _, _) => Some(line_out(l)),
            (None, true, Some(f)) => Some(w::LineOut {
                color: color_out(f),
                width_pt: Some(2.25),
                ..w::LineOut::default()
            }),
            _ => None,
        },
    };
    let marker = s.marker.as_ref().map(|m| w::MarkerOut {
        symbol: m.symbol.tag().to_string(),
        size: Some(m.size.round().clamp(2.0, 72.0) as u32),
        shape: w::ShapeOut {
            fill: m.fill.as_ref().and_then(color_out),
            line: m.line.as_ref().map(|c| w::LineOut {
                color: color_out(c),
                ..w::LineOut::default()
            }),
            ..w::ShapeOut::default()
        },
    });
    w::SeriesOut {
        idx,
        order: idx,
        name,
        shape,
        marker,
        points: s
            .points
            .iter()
            .filter_map(|(i, c)| {
                color_out(c).map(|col| {
                    (
                        *i,
                        w::ShapeOut {
                            fill: Some(col),
                            ..w::ShapeOut::default()
                        },
                    )
                })
            })
            .collect(),
        labels: s.labels.as_ref().map(labels_out),
        trendlines: s
            .trendlines
            .iter()
            .map(|t| {
                let (kind, order, period) = match t.kind {
                    TrendKind::Linear => ("linear", None, None),
                    TrendKind::Exponential => ("exp", None, None),
                    TrendKind::Logarithmic => ("log", None, None),
                    TrendKind::Polynomial(o) => ("poly", Some(u32::from(o)), None),
                    TrendKind::Power => ("power", None, None),
                    TrendKind::MovingAverage(p) => ("movingAvg", None, Some(p)),
                };
                w::TrendOut {
                    name: t.name.as_ref().map(|n| n.to_string()),
                    kind: kind.into(),
                    order,
                    period,
                    forward: Some(t.forward),
                    backward: Some(t.backward),
                    intercept: t.intercept,
                    display_r2: t.display_r2,
                    display_equation: t.display_equation,
                    line: t.line.as_ref().map(line_out),
                }
            })
            .collect(),
        error_bars: s
            .error_bars
            .iter()
            .map(|e| {
                let (vt, v, plus, minus) = match &e.value {
                    ErrorValue::Fixed(v) => ("fixedVal", Some(*v), None, None),
                    ErrorValue::Percentage(v) => ("percentage", Some(*v), None, None),
                    ErrorValue::StdDev(v) => ("stdDev", Some(*v), None, None),
                    ErrorValue::StdErr => ("stdErr", None, None, None),
                    ErrorValue::Custom { plus, minus } => (
                        "cust",
                        None,
                        plus.as_ref().map(|r| num_data(model, r)),
                        minus.as_ref().map(|r| num_data(model, r)),
                    ),
                };
                w::ErrOut {
                    direction: xy.then(|| if e.along_x { "x" } else { "y" }.to_string()),
                    bar_type: match e.bar_type {
                        ErrorBarType::Both => "both",
                        ErrorBarType::Plus => "plus",
                        ErrorBarType::Minus => "minus",
                    }
                    .into(),
                    value_type: vt.into(),
                    value: v,
                    no_end_cap: e.no_end_cap,
                    plus,
                    minus,
                    line: e.line.as_ref().map(line_out),
                }
            })
            .collect(),
        categories: if xy {
            s.x_values.as_ref().map(|r| num_data(model, r))
        } else {
            s.categories.as_ref().map(|r| cat_data(model, r))
        },
        values: num_data(model, &s.values),
        sizes: s.sizes.as_ref().map(|r| num_data(model, r)),
        smooth: Some(s.smooth),
        explosion: (s.explosion > 0).then_some(s.explosion),
        invert_if_negative: s.invert_if_negative,
    }
}

/// The plot element a kind is written as.
fn element_of(kind: ChartKind) -> &'static str {
    match kind {
        ChartKind::Bar | ChartKind::Column => "barChart",
        ChartKind::Line => "lineChart",
        ChartKind::Area => "areaChart",
        ChartKind::Pie => "pieChart",
        ChartKind::Donut => "doughnutChart",
        ChartKind::PieOfPie | ChartKind::BarOfPie => "ofPieChart",
        ChartKind::Scatter => "scatterChart",
        ChartKind::Bubble => "bubbleChart",
        ChartKind::Radar | ChartKind::FilledRadar => "radarChart",
        ChartKind::Stock => "stockChart",
        ChartKind::Surface => "surfaceChart",
        _ => "barChart",
    }
}

fn grouping_tag(kind: ChartKind, g: Grouping) -> String {
    match (kind, g) {
        (ChartKind::Bar | ChartKind::Column, Grouping::Standard) => "clustered",
        (_, Grouping::Standard) => "standard",
        (_, Grouping::Stacked) => "stacked",
        (_, Grouping::PercentStacked) => "percentStacked",
    }
    .to_string()
}

const PRIMARY: (u32, u32) = (500_000_001, 500_000_002);
const SECONDARY: (u32, u32) = (500_000_003, 500_000_004);
const SERIES_AXIS: u32 = 500_000_005;

fn plot_out(model: &SheetModel, p: &Plot, first_idx: u32) -> w::PlotOut {
    let k = p.kind;
    let ids = if p.secondary { SECONDARY } else { PRIMARY };
    let axis_ids = if k.is_radial() {
        Vec::new()
    } else if k == ChartKind::Surface {
        vec![ids.0, ids.1, SERIES_AXIS]
    } else {
        vec![ids.0, ids.1]
    };
    w::PlotOut {
        element: element_of(k).into(),
        bar_dir: matches!(k, ChartKind::Bar | ChartKind::Column)
            .then(|| if k == ChartKind::Bar { "bar" } else { "col" }.to_string()),
        grouping: matches!(
            k,
            ChartKind::Bar | ChartKind::Column | ChartKind::Line | ChartKind::Area
        )
        .then(|| grouping_tag(k, p.grouping)),
        vary_colors: p.vary_colors,
        series: p
            .series
            .iter()
            .enumerate()
            .map(|(j, s)| series_out(model, s, first_idx + j as u32, p))
            .collect(),
        labels: p.labels.as_ref().map(labels_out),
        gap_width: matches!(
            k,
            ChartKind::Bar | ChartKind::Column | ChartKind::PieOfPie | ChartKind::BarOfPie
        )
        .then_some(p.gap_width),
        overlap: (matches!(k, ChartKind::Bar | ChartKind::Column)
            && (p.overlap != 0 || p.grouping.is_stacked()))
        .then_some(if p.grouping.is_stacked() {
            100
        } else {
            p.overlap
        }),
        first_slice_angle: Some(p.first_slice_angle),
        hole_size: Some(p.hole_size),
        scatter_style: (k == ChartKind::Scatter).then(|| "lineMarker".to_string()),
        radar_style: matches!(k, ChartKind::Radar | ChartKind::FilledRadar).then(|| {
            if k == ChartKind::FilledRadar {
                "filled"
            } else {
                "marker"
            }
            .to_string()
        }),
        bubble_scale: Some(p.bubble_scale),
        size_represents: p.bubble_size_is_width.then(|| "w".to_string()),
        of_pie_type: matches!(k, ChartKind::PieOfPie | ChartKind::BarOfPie).then(|| {
            if k == ChartKind::BarOfPie {
                "bar"
            } else {
                "pie"
            }
            .to_string()
        }),
        split_type: matches!(k, ChartKind::PieOfPie | ChartKind::BarOfPie).then(|| {
            match p.of_pie.split {
                SplitType::Position => "pos",
                SplitType::Value => "val",
                SplitType::Percent => "percent",
                SplitType::Custom => "cust",
            }
            .to_string()
        }),
        split_pos: p.of_pie.split_pos,
        cust_split: p.of_pie.custom.clone(),
        second_pie_size: Some(p.of_pie.second_size),
        hi_low_lines: p.hi_low_lines,
        up_down_bars: p.up_down_bars,
        drop_lines: p.drop_lines,
        marker: (k == ChartKind::Line).then_some(true),
        axis_ids,
    }
}

fn axis_out(a: &Axis, element: &str, id: u32, cross: u32, pos: &str) -> w::AxisOut {
    w::AxisOut {
        element: element.into(),
        id,
        cross_ax: cross,
        position: pos.into(),
        deleted: a.deleted,
        log_base: a.log_base,
        reversed: a.reversed,
        min: a.min,
        max: a.max,
        major_unit: a.major_unit,
        minor_unit: a.minor_unit,
        crosses: match a.crosses {
            Crosses::AutoZero => None,
            Crosses::Min => Some("min".into()),
            Crosses::Max => Some("max".into()),
            Crosses::At(_) => None,
        },
        crosses_at: match a.crosses {
            Crosses::At(v) => Some(v),
            _ => None,
        },
        title: a.title.as_ref().map(|t| w::TextOut {
            text: t.to_string(),
            run: run_out(&a.title_style),
            ..w::TextOut::default()
        }),
        format: a.format.as_ref().map(|f| f.to_string()),
        major_gridlines: a.major_gridlines.as_ref().map(line_out),
        minor_gridlines: a.minor_gridlines.as_ref().map(line_out),
        line: a.line.as_ref().map(line_out),
        labels: run_out(&a.labels),
        tick_labels: Some(
            match a.tick_labels {
                TickLabels::NextTo => "nextTo",
                TickLabels::Low => "low",
                TickLabels::High => "high",
                TickLabels::None => "none",
            }
            .into(),
        ),
        base_time_unit: a.base_unit.map(|u| {
            match u {
                TimeUnit::Days => "days",
                TimeUnit::Months => "months",
                TimeUnit::Years => "years",
            }
            .into()
        }),
        cross_between: None,
    }
}

/// The axes of a chart as written.
fn axes_out(m: &ChartModel) -> Vec<w::AxisOut> {
    let kind = m.kind();
    if kind.is_radial() {
        return Vec::new();
    }
    let xy = m.plots.iter().any(|p| p.kind.is_xy());
    let horizontal = kind == ChartKind::Bar;
    let (cat_pos, val_pos) = if horizontal { ("l", "b") } else { ("b", "l") };
    let cat_el = if xy {
        "valAx"
    } else if m.cat_axis.kind == AxisKind::Date {
        "dateAx"
    } else {
        "catAx"
    };
    let mut out = vec![
        axis_out(&m.cat_axis, cat_el, PRIMARY.0, PRIMARY.1, cat_pos),
        axis_out(&m.val_axis, "valAx", PRIMARY.1, PRIMARY.0, val_pos),
    ];
    if m.plots.iter().any(|p| p.kind == ChartKind::Area) && !xy {
        out[1].cross_between = Some("midCat".into());
    }
    if m.plots.iter().any(|p| p.secondary) {
        let sec_cat = m.sec_cat_axis.clone().unwrap_or(Axis {
            deleted: true,
            ..m.cat_axis.clone()
        });
        let mut sec_val = m.sec_val_axis.clone().unwrap_or_default();
        sec_val.crosses = Crosses::Max;
        let sec_pos = if horizontal { "t" } else { "r" };
        out.push(axis_out(
            &sec_cat,
            cat_el,
            SECONDARY.0,
            SECONDARY.1,
            cat_pos,
        ));
        out.push(axis_out(
            &sec_val,
            "valAx",
            SECONDARY.1,
            SECONDARY.0,
            sec_pos,
        ));
    }
    if kind == ChartKind::Surface {
        out.push(w::AxisOut {
            element: "serAx".into(),
            id: SERIES_AXIS,
            cross_ax: PRIMARY.1,
            position: "b".into(),
            ..w::AxisOut::default()
        });
    }
    out
}

/// The paged extension: the chart's index and its document references.
pub(crate) fn ext_of(m: &ChartModel, index: u32, removed: &[u32]) -> ExtOut {
    let mut m = m.clone();
    let mut refs = Vec::new();
    for (role, slot) in color_roles(&mut m) {
        if let Some(c) = slot.as_ref() {
            if let Some(d) = &c.doc {
                refs.push(w::RefOut {
                    role,
                    rgb: concrete_rgb(c).or_else(|| {
                        let (r, g, b) = d.fallback_rgb;
                        Some((u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b))
                    }),
                    swatch: Some(d.id.clone()),
                    model: Some(d.model.as_str().to_string()),
                    ..w::RefOut::default()
                });
            }
        }
    }
    for (role, t) in text_roles(&mut m) {
        if t.doc_para_style.is_some() || t.doc_char_style.is_some() {
            refs.push(w::RefOut {
                role,
                rgb: t.font.color.as_ref().and_then(concrete_rgb),
                paragraph: t.doc_para_style.clone(),
                character: t.doc_char_style.clone(),
                ..w::RefOut::default()
            });
        }
    }
    ExtOut {
        uri: PAGED_EXT_URI.into(),
        ns: PAGED_EXT_NS.into(),
        refs,
        index: Some(index),
        removed: removed.to_vec(),
        // Sheet ADR 525 — the chart's own colour-group palette.
        palette: m.palette.as_ref().map(|p| {
            (
                p.group.clone(),
                p.swatches
                    .iter()
                    .map(crate::parts::chart_style::encode_swatch)
                    .collect(),
            )
        }),
    }
}

/// The whole chart as written.
pub(crate) fn chart_out(
    m: &ChartModel,
    model: &SheetModel,
    index: u32,
    removed: &[u32],
) -> ChartOut {
    let mut first = 0u32;
    let plots = m
        .plots
        .iter()
        .map(|p| {
            let out = plot_out(model, p, first);
            first += p.series.len() as u32;
            out
        })
        .collect();
    ChartOut {
        title: m.title.as_ref().map(|t| w::TextOut {
            text: t.to_string(),
            run: run_out(&m.title_style),
            overlay: m.title_overlay,
            ..w::TextOut::default()
        }),
        plots,
        axes: axes_out(m),
        legend: m.legend.as_ref().map(|l| w::LegendOut {
            position: l.position.tag().into(),
            overlay: l.overlay,
            run: run_out(&l.style),
        }),
        blanks: Some(
            match m.blanks {
                Blanks::Gap => "gap",
                Blanks::Zero => "zero",
                Blanks::Span => "span",
            }
            .into(),
        ),
        style: m.style,
        chart_area: area_out(&m.chart_area),
        plot_area: area_out(&m.plot_area),
        text: run_out(&m.text),
        date1904: model.calc.date_system == sheet_core::DateSystem::Date1904,
        contour: m.kind() == ChartKind::Surface,
        ext: Some(ext_of(m, index, removed)),
    }
}

/// An Office 2016 chart as written (`None` for a kind without a chartEx
/// layout).
pub(crate) fn chart_ex_out(
    m: &ChartModel,
    model: &SheetModel,
    index: u32,
    removed: &[u32],
) -> Option<ChartExOut> {
    let p = m.plots.first()?;
    let layout = match p.kind {
        ChartKind::Waterfall => "waterfall",
        ChartKind::Funnel => "funnel",
        ChartKind::Treemap => "treemap",
        ChartKind::Sunburst => "sunburst",
        ChartKind::Histogram | ChartKind::Pareto => "clusteredColumn",
        ChartKind::BoxWhisker => "boxWhisker",
        _ => return None,
    };
    // Box & whisker draws every series; the other layouts one.
    let all: Vec<&Series> = m.series().collect();
    let take = if p.kind == ChartKind::BoxWhisker {
        all.len()
    } else {
        1
    };
    let first = *all.first()?;
    Some(ChartExOut {
        title: m.title.as_ref().map(|t| t.to_string()),
        layout: layout.into(),
        categories: first.categories.as_ref().map(|r| str_data(model, r)),
        series: all
            .iter()
            .take(take)
            .map(|s| w::ExSeriesOut {
                name: s.name.as_ref().map(|n| w::TextOut {
                    text: n.to_string(),
                    formula: s.name_ref.as_ref().map(|r| range_f(model, r)),
                    ..w::TextOut::default()
                }),
                values: num_data(model, &s.values),
                fill: s.fill.as_ref().and_then(color_out),
            })
            .collect(),
        subtotals: p.ex.subtotals.clone(),
        bin_count: p.ex.bins.count,
        bin_size: p.ex.bins.width,
        closed_left: p.ex.bins.closed_left,
        aggregation: p.ex.bins.by_category,
        pareto: p.kind == ChartKind::Pareto,
        legend: m.legend.as_ref().map(|l| l.position.tag().to_string()),
        show_values: first.labels.as_ref().is_some_and(DataLabels::any),
        ext: Some(ext_of(m, index, removed)),
    })
}

// ── the splice ──────────────────────────────────────────────────────────────

fn frag(xml: &str) -> Result<El, String> {
    w::fragment(xml)
}

fn opt_frag(xml: String) -> Result<Option<El>, String> {
    if xml.is_empty() {
        Ok(None)
    } else {
        frag(&xml).map(Some)
    }
}

/// The axis family a chart's plots need.
fn family(m: &ChartModel) -> (u8, bool) {
    let k = m.kind();
    let f = if k.is_radial() {
        0
    } else if k.is_xy() {
        1
    } else if k == ChartKind::Surface {
        2
    } else {
        3
    };
    (f, m.has_secondary())
}

/// Patch the element tree of a parsed chart where `after` differs from
/// `before`.
fn splice_tree(
    root: &mut El,
    before: &ChartModel,
    after: &ChartModel,
    out: &ChartOut,
) -> Result<(), String> {
    let Some(chart) = root.children.iter_mut().find(|c| c.is(Ns::C, "chart")) else {
        return Err("no c:chart".into());
    };
    if before.title != after.title || before.title_style != after.title_style {
        let t = out
            .title
            .as_ref()
            .map(|t| frag(&w::title_xml(t)))
            .transpose()?;
        let deleted = t.is_none();
        w::put_child(chart, Ns::C, "title", t, w::ORDER_CHART);
        w::put_child(
            chart,
            Ns::C,
            "autoTitleDeleted",
            Some(frag(&format!(
                r#"<c:autoTitleDeleted val="{}"/>"#,
                u8::from(deleted)
            ))?),
            w::ORDER_CHART,
        );
    }
    if before.legend != after.legend {
        let l = out
            .legend
            .as_ref()
            .map(|l| frag(&w::legend_xml(l)))
            .transpose()?;
        w::put_child(chart, Ns::C, "legend", l, w::ORDER_CHART);
    }
    let Some(pa) = chart.children.iter_mut().find(|c| c.is(Ns::C, "plotArea")) else {
        return Err("no c:plotArea".into());
    };
    if before.plot_area != after.plot_area {
        let sp = opt_frag(w::shape_xml(&out.plot_area))?;
        put_last(pa, "spPr", sp);
    }
    let structural = family(before) != family(after) || before.plots.len() != after.plots.len();
    if structural {
        // The plot area's plots and axes, regenerated.
        pa.children.retain(|c| {
            !(c.ns == Ns::C && (c.local.ends_with("Chart") || c.local.ends_with("Ax")))
        });
        let at = pa
            .children
            .iter()
            .position(|c| c.is(Ns::C, "layout"))
            .map_or(0, |i| i + 1);
        let mut new: Vec<El> = Vec::new();
        for p in &out.plots {
            new.push(frag(&w::plot_xml(p))?);
        }
        for a in &out.axes {
            new.push(frag(&w::axis_xml(a))?);
        }
        for (k, el) in new.into_iter().enumerate() {
            pa.children.insert(at + k, el);
        }
        return Ok(());
    }
    // Plot by plot.
    let plot_idx: Vec<usize> = pa
        .children
        .iter()
        .enumerate()
        .filter(|(_, c)| c.ns == Ns::C && c.local.ends_with("Chart"))
        .map(|(i, _)| i)
        .collect();
    let mut next_idx = before.series_count() as u32 + 100;
    for (pi, (bp, ap)) in before.plots.iter().zip(&after.plots).enumerate() {
        let Some(&ci) = plot_idx.get(pi) else { break };
        let op = &out.plots[pi];
        if bp.kind != ap.kind || bp.grouping != ap.grouping || bp.secondary != ap.secondary {
            // The plot element, replaced; it keeps its axes.
            let ax: Vec<u32> = pa.children[ci]
                .children_named(Ns::C, "axId")
                .filter_map(|a| a.attr_u32("val"))
                .collect();
            let mut p = op.clone();
            if !ax.is_empty() {
                p.axis_ids = ax;
            }
            pa.children[ci] = frag(&w::plot_xml(&p))?;
            continue;
        }
        let plot_el = &mut pa.children[ci];
        if bp.labels != ap.labels {
            let d = op
                .labels
                .as_ref()
                .map(|d| frag(&w::labels_xml(d)))
                .transpose()?;
            // Plot-level dLbls sit after the series.
            plot_el.children.retain(|c| !c.is(Ns::C, "dLbls"));
            if let Some(d) = d {
                let at = plot_el
                    .children
                    .iter()
                    .rposition(|c| c.is(Ns::C, "ser"))
                    .map_or(plot_el.children.len(), |i| i + 1);
                plot_el.children.insert(at, d);
            }
        }
        let ser_pos: Vec<usize> = plot_el
            .children
            .iter()
            .enumerate()
            .filter(|(_, c)| c.is(Ns::C, "ser"))
            .map(|(i, _)| i)
            .collect();
        // Remove series beyond the new count (from the back).
        for &i in ser_pos.iter().skip(ap.series.len()).rev() {
            plot_el.children.remove(i);
        }
        for (j, s_after) in ap.series.iter().enumerate() {
            let so = &op.series[j];
            let positions: Vec<usize> = plot_el
                .children
                .iter()
                .enumerate()
                .filter(|(_, c)| c.is(Ns::C, "ser"))
                .map(|(i, _)| i)
                .collect();
            let s_before = bp.series.get(j);
            let at = match positions.get(j) {
                Some(&i) => i,
                None => {
                    // A new series: a copy of the last one's subtree.
                    let Some(&last) = positions.last() else {
                        let el = frag(&w::series_xml(&op.element, so))?;
                        let at = plot_el
                            .children
                            .iter()
                            .position(|c| {
                                !matches!(
                                    c.local.as_str(),
                                    "barDir"
                                        | "grouping"
                                        | "varyColors"
                                        | "scatterStyle"
                                        | "radarStyle"
                                        | "ofPieType"
                                        | "wireframe"
                                )
                            })
                            .unwrap_or(plot_el.children.len());
                        plot_el.children.insert(at, el);
                        continue;
                    };
                    let mut copy = plot_el.children[last].clone();
                    for (tag, v) in [("idx", next_idx), ("order", next_idx)] {
                        if let Some(e) = copy.children.iter_mut().find(|c| c.is(Ns::C, tag)) {
                            set_val(e, &v.to_string());
                        }
                    }
                    next_idx += 1;
                    plot_el.children.insert(last + 1, copy);
                    last + 1
                }
            };
            let ser = &mut plot_el.children[at];
            patch_series(ser, &op.element, s_before, s_after, so)?;
        }
    }
    // Axes.
    patch_axes(pa, before, after, out)?;
    Ok(())
}

fn set_val(el: &mut El, v: &str) {
    for (k, val) in el.raw_attrs.iter_mut() {
        if k == "val" {
            *val = v.to_string();
        }
    }
    for a in el.attrs.iter_mut() {
        if a.local == "val" {
            a.value = v.to_string();
        }
    }
}

/// `spPr` of the plot area sits last (before `extLst`).
fn put_last(parent: &mut El, local: &str, new: Option<El>) {
    parent.children.retain(|c| !c.is(Ns::C, local));
    if let Some(n) = new {
        let at = parent
            .children
            .iter()
            .position(|c| c.is(Ns::C, "extLst"))
            .unwrap_or(parent.children.len());
        parent.children.insert(at, n);
    }
}

fn patch_series(
    ser: &mut El,
    element: &str,
    before: Option<&Series>,
    after: &Series,
    so: &w::SeriesOut,
) -> Result<(), String> {
    let changed = |f: &dyn Fn(&Series) -> bool| before.is_none_or(f);
    let xy = matches!(element, "scatterChart" | "bubbleChart");
    if changed(&|b| b.name != after.name || b.name_ref != after.name_ref) {
        let tx = match &so.name {
            Some(n) => {
                // The `c:tx` element alone, from a generated series.
                let tmp = frag(&w::series_xml(
                    element,
                    &w::SeriesOut {
                        name: Some(n.clone()),
                        ..w::SeriesOut::default()
                    },
                ))?;
                tmp.children.into_iter().find(|c| c.is(Ns::C, "tx"))
            }
            None => None,
        };
        w::put_child(ser, Ns::C, "tx", tx, w::ORDER_SER);
    }
    let refs_changed = changed(&|b| {
        b.values != after.values
            || b.categories != after.categories
            || b.x_values != after.x_values
            || b.sizes != after.sizes
    });
    if refs_changed {
        let (cat_tag, val_tag) = if xy { ("xVal", "yVal") } else { ("cat", "val") };
        let cat = so
            .categories
            .as_ref()
            .map(|c| frag(&w::data_xml(cat_tag, c)))
            .transpose()?;
        w::put_child(ser, Ns::C, cat_tag, cat, w::ORDER_SER);
        let val = frag(&w::data_xml(val_tag, &so.values))?;
        w::put_child(ser, Ns::C, val_tag, Some(val), w::ORDER_SER);
        if element == "bubbleChart" {
            let z = so
                .sizes
                .as_ref()
                .map(|z| frag(&w::data_xml("bubbleSize", z)))
                .transpose()?;
            w::put_child(ser, Ns::C, "bubbleSize", z, w::ORDER_SER);
        }
    }
    if changed(&|b| b.fill != after.fill || b.line != after.line) {
        let sp = opt_frag(w::shape_xml(&so.shape))?;
        w::put_child(ser, Ns::C, "spPr", sp, w::ORDER_SER);
    }
    if changed(&|b| b.labels != after.labels) {
        let d = so
            .labels
            .as_ref()
            .map(|d| frag(&w::labels_xml(d)))
            .transpose()?;
        w::put_child(ser, Ns::C, "dLbls", d, w::ORDER_SER);
    }
    let regenerated = || -> Result<El, String> { frag(&w::series_xml(element, so)) };
    if changed(&|b| b.marker != after.marker) {
        let g = regenerated()?;
        let m = g.children.into_iter().find(|c| c.is(Ns::C, "marker"));
        w::put_child(ser, Ns::C, "marker", m, w::ORDER_SER);
    }
    if changed(&|b| b.trendlines != after.trendlines || b.error_bars != after.error_bars) {
        let g = regenerated()?;
        ser.children
            .retain(|c| !(c.is(Ns::C, "trendline") || c.is(Ns::C, "errBars")));
        let new: Vec<El> = g
            .children
            .into_iter()
            .filter(|c| c.is(Ns::C, "trendline") || c.is(Ns::C, "errBars"))
            .collect();
        let rank = |l: &str| {
            w::ORDER_SER
                .iter()
                .position(|o| *o == l)
                .unwrap_or(usize::MAX)
        };
        let at = ser
            .children
            .iter()
            .position(|c| rank(&c.local) > rank("errBars"))
            .unwrap_or(ser.children.len());
        for (k, el) in new.into_iter().enumerate() {
            ser.children.insert(at + k, el);
        }
    }
    if changed(&|b| b.smooth != after.smooth) && matches!(element, "lineChart" | "scatterChart") {
        let s = frag(&format!(r#"<c:smooth val="{}"/>"#, u8::from(after.smooth)))?;
        w::put_child(ser, Ns::C, "smooth", Some(s), w::ORDER_SER);
    }
    Ok(())
}

fn patch_axes(
    pa: &mut El,
    before: &ChartModel,
    after: &ChartModel,
    out: &ChartOut,
) -> Result<(), String> {
    // The primary axes as the first plot names them.
    let ids: Vec<u32> = pa
        .children
        .iter()
        .find(|c| c.ns == Ns::C && c.local.ends_with("Chart"))
        .map(|p| {
            p.children_named(Ns::C, "axId")
                .filter_map(|a| a.attr_u32("val"))
                .collect()
        })
        .unwrap_or_default();
    // A plot naming axes the part does not define (a hand-written part):
    // the axes are written, so the chart is valid.
    if !after.kind().is_radial() && ids.len() >= 2 {
        for (k, id) in ids.iter().take(2).enumerate() {
            let present = pa.children.iter().any(|c| {
                c.ns == Ns::C
                    && c.local.ends_with("Ax")
                    && c.child(Ns::C, "axId").and_then(|x| x.attr_u32("val")) == Some(*id)
            });
            if present {
                continue;
            }
            if let Some(ao) = out.axes.get(k) {
                let mut a = ao.clone();
                a.id = *id;
                a.cross_ax = ids[1 - k];
                let el = frag(&w::axis_xml(&a))?;
                let at = pa
                    .children
                    .iter()
                    .position(|c| {
                        c.is(Ns::C, "spPr") || c.is(Ns::C, "dTable") || c.is(Ns::C, "extLst")
                    })
                    .unwrap_or(pa.children.len());
                pa.children.insert(at, el);
            }
        }
    }
    let pairs = [
        (
            &before.cat_axis,
            &after.cat_axis,
            ids.first().copied(),
            0usize,
        ),
        (
            &before.val_axis,
            &after.val_axis,
            ids.get(1).copied(),
            1usize,
        ),
    ];
    for (b, a, id, k) in pairs {
        let (Some(id), true) = (id, b != a) else {
            continue;
        };
        let Some(ax) = pa.children.iter_mut().find(|c| {
            c.ns == Ns::C
                && c.local.ends_with("Ax")
                && c.child(Ns::C, "axId").and_then(|x| x.attr_u32("val")) == Some(id)
        }) else {
            continue;
        };
        let Some(ao) = out.axes.get(k) else { continue };
        if b.min != a.min || b.max != a.max || b.log_base != a.log_base || b.reversed != a.reversed
        {
            w::put_child(
                ax,
                Ns::C,
                "scaling",
                Some(frag(&w::scaling_xml(ao))?),
                w::ORDER_AXIS,
            );
        }
        if b.title != a.title || b.title_style != a.title_style {
            let t = ao
                .title
                .as_ref()
                .map(|t| frag(&w::title_xml(t)))
                .transpose()?;
            w::put_child(ax, Ns::C, "title", t, w::ORDER_AXIS);
        }
        if b.format != a.format {
            let f = match &a.format {
                Some(f) => Some(frag(&format!(
                    r#"<c:numFmt formatCode="{}" sourceLinked="0"/>"#,
                    w::esc(f)
                ))?),
                None => Some(frag(
                    r#"<c:numFmt formatCode="General" sourceLinked="1"/>"#,
                )?),
            };
            w::put_child(ax, Ns::C, "numFmt", f, w::ORDER_AXIS);
        }
        if b.major_gridlines != a.major_gridlines {
            let g = ao
                .major_gridlines
                .as_ref()
                .map(|g| frag(&w::gridlines_xml("majorGridlines", g)))
                .transpose()?;
            w::put_child(ax, Ns::C, "majorGridlines", g, w::ORDER_AXIS);
        }
        if b.minor_gridlines != a.minor_gridlines {
            let g = ao
                .minor_gridlines
                .as_ref()
                .map(|g| frag(&w::gridlines_xml("minorGridlines", g)))
                .transpose()?;
            w::put_child(ax, Ns::C, "minorGridlines", g, w::ORDER_AXIS);
        }
        if b.deleted != a.deleted {
            let d = frag(&format!(r#"<c:delete val="{}"/>"#, u8::from(a.deleted)))?;
            w::put_child(ax, Ns::C, "delete", Some(d), w::ORDER_AXIS);
        }
        if b.major_unit != a.major_unit {
            let u = a
                .major_unit
                .map(|v| frag(&format!(r#"<c:majorUnit val="{v}"/>"#)))
                .transpose()?;
            w::put_child(ax, Ns::C, "majorUnit", u, w::ORDER_AXIS);
        }
    }
    Ok(())
}

/// What a written chart records: its session index and the deleted slots.
pub type Recorded = (Option<u32>, Vec<u32>);

/// A chart's recorded session index and the deleted slots recorded with
/// it, read back on load (the paged extension), for
/// [`order_by_recorded_index`].
pub fn recorded_index(xml: &[u8]) -> Recorded {
    let Ok(root) = paged_ooxml::tree::parse(xml) else {
        return (None, Vec::new());
    };
    let ns = if root.ns == Ns::Cx { Ns::Cx } else { Ns::C };
    let refs = root
        .child(ns, "extLst")
        .and_then(|l| {
            l.children
                .iter()
                .find(|e| e.attr("uri") == Some(PAGED_EXT_URI))
        })
        .and_then(|e| e.children.iter().find(|c| c.local == "refs"));
    let Some(refs) = refs else {
        return (None, Vec::new());
    };
    let removed = refs
        .attr("removed")
        .map(|r| {
            r.split_whitespace()
                .filter_map(|v| v.parse().ok())
                .collect()
        })
        .unwrap_or_default();
    (refs.attr_u32("index"), removed)
}

/// Put charts with a recorded index at that index; a recorded deleted slot
/// is a placeholder marked `removed` (read from the file); the other charts
/// fill the remaining slots in discovery order.
pub fn order_by_recorded_index(charts: Vec<(ParsedChart, Recorded)>) -> Vec<ParsedChart> {
    if charts.iter().all(|(_, (i, _))| i.is_none()) {
        return charts.into_iter().map(|(c, _)| c).collect();
    }
    let removed: BTreeSet<u32> = charts
        .iter()
        .flat_map(|(_, (_, r))| r.iter().copied())
        .collect();
    let max_recorded = charts
        .iter()
        .filter_map(|(_, (i, _))| *i)
        .chain(removed.iter().copied())
        .max()
        .unwrap_or(0) as usize;
    let len = (charts.len() + removed.len()).max(max_recorded + 1);
    let mut slots: Vec<Option<ParsedChart>> = vec![None; len];
    let placeholder = || {
        let mut gone = ParsedChart::authored(0, ChartModel::default());
        gone.dirty = false;
        gone.removed = true;
        gone.from_file = true;
        gone
    };
    for &r in &removed {
        if (r as usize) < len {
            slots[r as usize] = Some(placeholder());
        }
    }
    let mut rest = Vec::new();
    for (c, (i, _)) in charts {
        match i {
            Some(i) if (i as usize) < len && slots[i as usize].is_none() => {
                slots[i as usize] = Some(c)
            }
            _ => rest.push(c),
        }
    }
    let mut rest = rest.into_iter();
    let mut out = Vec::with_capacity(len);
    for s in slots {
        match s {
            Some(c) => out.push(c),
            None => match rest.next() {
                Some(c) => out.push(c),
                None => out.push(placeholder()),
            },
        }
    }
    out.extend(rest);
    while out.last().is_some_and(|c| c.removed) {
        out.pop();
    }
    out
}

#[cfg(test)]
#[path = "chart_write_tests.rs"]
mod tests;
