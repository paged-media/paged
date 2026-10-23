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

//! Sparklines (`x14:sparklineGroups` in a worksheet's `<extLst>`, Excel
//! 2010): each group's type, colours and options, and each sparkline's data
//! range and cell. READ-ONLY: the `<extLst>` is a captured worksheet child
//! and round-trips byte-identical; the groups are drawn in the grid and on
//! the page.
//!
//! Colours: `rgb` (ARGB) or `theme` + `tint`. A SpreadsheetML theme index
//! counts lt1, dk1, lt2, dk2 first; the chart model counts DrawingML's dk1,
//! lt1, dk2, lt2, so the first four are swapped in pairs.

use paged_ooxml::tree::El;
use sheet_chart::model::{Blanks, ColorRef, SparklineGroup, SparklineKind};
use sheet_core::{CellRef, SheetId};

use super::chart::{parse_f_ref, SheetResolver};

fn color(el: Option<&El>) -> Option<ColorRef> {
    let el = el?;
    if let Some(rgb) = el.attr("rgb") {
        let v = u32::from_str_radix(rgb.trim(), 16).ok()?;
        return Some(ColorRef::rgb(v & 0xFF_FFFF));
    }
    if let Some(t) = el.attr("theme").and_then(|t| t.parse::<u8>().ok()) {
        const MAP: [u8; 4] = [1, 0, 3, 2];
        let idx = MAP.get(t as usize).copied().unwrap_or(t);
        let tint = el
            .attr("tint")
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.0);
        return Some(ColorRef::theme(idx, tint));
    }
    if let Some(i) = el.attr("indexed").and_then(|t| t.parse::<u8>().ok()) {
        return Some(ColorRef {
            concrete: sheet_chart::model::ColorValue::Indexed(i),
            doc: None,
        });
    }
    None
}

fn child<'a>(el: &'a El, local: &str) -> Option<&'a El> {
    el.children.iter().find(|c| c.local == local)
}

fn find_all<'a>(el: &'a El, local: &str, out: &mut Vec<&'a El>) {
    if el.local == local {
        out.push(el);
        return;
    }
    for c in &el.children {
        find_all(c, local, out);
    }
}

/// The sparkline groups in captured worksheet children (`<extLst>`).
pub fn parse_all<'a>(
    captured: impl Iterator<Item = &'a [u8]>,
    sheet: SheetId,
    resolver: &impl SheetResolver,
) -> Vec<SparklineGroup> {
    let mut out = Vec::new();
    for bytes in captured {
        if !bytes.windows(14).any(|w| w == b"sparklineGroup") {
            continue;
        }
        let Ok(root) = paged_ooxml::tree::parse(bytes) else {
            continue;
        };
        let mut groups = Vec::new();
        find_all(&root, "sparklineGroup", &mut groups);
        for g in groups {
            let b = |name: &str| g.attr_bool(name).unwrap_or(false);
            let mut group = SparklineGroup {
                kind: match g.attr("type") {
                    Some("column") => SparklineKind::Column,
                    Some("stacked") => SparklineKind::WinLoss,
                    _ => SparklineKind::Line,
                },
                show_markers: b("markers"),
                show_first: b("first"),
                show_last: b("last"),
                show_high: b("high"),
                show_low: b("low"),
                show_negative: b("negative"),
                show_axis: b("displayXAxis"),
                right_to_left: b("rightToLeft"),
                line_weight: g
                    .attr("lineWeight")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0.75),
                blanks: match g.attr("displayEmptyCellsAs") {
                    Some("zero") => Blanks::Zero,
                    Some("span") => Blanks::Span,
                    _ => Blanks::Gap,
                },
                min: (g.attr("minAxisType") == Some("custom"))
                    .then(|| g.attr("manualMin").and_then(|v| v.parse().ok()))
                    .flatten(),
                max: (g.attr("maxAxisType") == Some("custom"))
                    .then(|| g.attr("manualMax").and_then(|v| v.parse().ok()))
                    .flatten(),
                ..SparklineGroup::default()
            };
            if let Some(c) = color(child(g, "colorSeries")) {
                group.series = c;
            }
            group.negative = color(child(g, "colorNegative"));
            group.axis = color(child(g, "colorAxis"));
            group.markers = color(child(g, "colorMarkers"));
            group.first = color(child(g, "colorFirst"));
            group.last = color(child(g, "colorLast"));
            group.high = color(child(g, "colorHigh"));
            group.low = color(child(g, "colorLow"));
            if let Some(list) = child(g, "sparklines") {
                for s in list.children.iter().filter(|c| c.local == "sparkline") {
                    let f = child(s, "f").map(El::deep_text);
                    let at = child(s, "sqref").map(El::deep_text);
                    let (Some(f), Some(at)) = (f, at) else {
                        continue;
                    };
                    let Some(data) = parse_f_ref(&f, sheet, resolver) else {
                        continue;
                    };
                    let Some((r, c, _, _)) = sheet_core::parse_a1(at.trim()) else {
                        continue;
                    };
                    group.sparklines.push((
                        data,
                        CellRef {
                            sheet,
                            row: r,
                            col: c,
                            row_abs: false,
                            col_abs: false,
                        },
                    ));
                }
            }
            if !group.sparklines.is_empty() {
                out.push(group);
            }
        }
    }
    out
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    struct One;
    impl SheetResolver for One {
        fn resolve(&self, name: &str) -> Option<SheetId> {
            (name == "Sheet1").then_some(0)
        }
    }

    #[test]
    fn reads_groups_colours_and_cells__feat__sheet_chart_sparklines() {
        let x = br#"<extLst><ext uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">
<x14:sparklineGroup type="column" displayEmptyCellsAs="zero" high="1" negative="1" manualMax="10" maxAxisType="custom"><x14:colorSeries rgb="FF376092"/><x14:colorNegative theme="5" tint="-0.25"/><x14:colorHigh rgb="FFFF0000"/>
<x14:sparklines><x14:sparkline><xm:f>Sheet1!A2:E2</xm:f><xm:sqref>F2</xm:sqref></x14:sparkline><x14:sparkline><xm:f>Sheet1!A3:E3</xm:f><xm:sqref>F3</xm:sqref></x14:sparkline></x14:sparklines></x14:sparklineGroup>
<x14:sparklineGroup type="stacked"><x14:colorSeries theme="1"/><x14:sparklines><x14:sparkline><xm:f>Sheet1!A4:E4</xm:f><xm:sqref>F4</xm:sqref></x14:sparkline></x14:sparklines></x14:sparklineGroup>
</x14:sparklineGroups></ext></extLst>"#;
        let gs = parse_all(std::iter::once(&x[..]), 0, &One);
        assert_eq!(gs.len(), 2);
        let g = &gs[0];
        assert_eq!(g.kind, SparklineKind::Column);
        assert_eq!(g.blanks, Blanks::Zero);
        assert!(g.show_high && g.show_negative);
        assert_eq!(g.max, Some(10.0));
        assert_eq!(g.series, ColorRef::rgb(0x376092));
        assert_eq!(g.negative, Some(ColorRef::theme(5, -0.25)));
        assert_eq!(g.sparklines.len(), 2);
        assert_eq!((g.sparklines[1].1.row, g.sparklines[1].1.col), (2, 5));
        assert_eq!(g.sparklines[0].0.end.col, 4);
        assert_eq!(gs[1].kind, SparklineKind::WinLoss);
        assert_eq!(gs[1].series, ColorRef::theme(0, 0.0), "theme 1 is dk1");
    }
}
