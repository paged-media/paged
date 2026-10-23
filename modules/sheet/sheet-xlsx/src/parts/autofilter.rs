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

//! `<autoFilter>` — the filter criteria of a worksheet or a table (ECMA-376
//! §18.3.2), read into a [`FilterView`] and written back from one (sheet ADR
//! 517). Every criterion Excel's dropdown writes is understood: value lists
//! (`<filters>`, with `<dateGroupItem>`s), custom operator pairs
//! (`<customFilters>`), top/bottom n or n% (`<top10>`), dynamic filters
//! (`<dynamicFilter>`), colour (`<colorFilter>`) and icon (`<iconFilter>`)
//! filters. A zero-edit save keeps the element as read; an authored filter
//! is written by [`autofilter_node`], which keeps what it does not model.

use compact_str::CompactString;
use sheet_core::{
    parse_a1, CellRef, ColumnFilter, CustomCondition, DateGroup, FilterCriterion, FilterOp,
    FilterView, RangeRef, SheetId,
};

use crate::xtree::XNode;

/// Parse the first `<autoFilter>` in `xml` (a worksheet child fragment or a
/// whole table part) into a [`FilterView`] on `sheet`. `None` when there is no
/// `autoFilter` element or its `ref` does not parse.
pub fn parse(xml: &[u8], sheet: SheetId) -> Option<FilterView> {
    let root = XNode::parse(xml).ok()?;
    let af = if root.local() == "autoFilter" {
        &root
    } else {
        root.child("autoFilter")?
    };
    let range = parse_ref(&af.attr("ref")?, sheet)?;
    let columns = af
        .children_named("filterColumn")
        .map(|fc| ColumnFilter {
            col: fc
                .attr("colId")
                .and_then(|s| s.trim().parse::<u32>().ok())
                .unwrap_or(0),
            criterion: criterion_of(fc),
        })
        .collect();
    Some(FilterView {
        range,
        columns,
        from_file: true,
    })
}

fn num(n: &XNode, k: &str) -> Option<f64> {
    n.attr(k).and_then(|v| v.trim().parse::<f64>().ok())
}

fn uint(n: &XNode, k: &str) -> Option<u32> {
    n.attr(k).and_then(|v| v.trim().parse::<u32>().ok())
}

/// The criterion of one `<filterColumn>`.
fn criterion_of(fc: &XNode) -> FilterCriterion {
    let Some(c) = fc.children.iter().find(|c| c.local() != "extLst") else {
        return FilterCriterion::Unsupported;
    };
    match c.local() {
        "filters" => {
            let values: Vec<CompactString> = c
                .children_named("filter")
                .filter_map(|f| f.attr("val"))
                .map(|v| CompactString::new(&v))
                .collect();
            let blanks = c.flag("blank", false);
            let dates: Vec<DateGroup> = c
                .children_named("dateGroupItem")
                .filter_map(|d| {
                    let depth = match d.attr("dateTimeGrouping").as_deref() {
                        Some("year") => 0,
                        Some("month") => 1,
                        Some("day") => 2,
                        Some("hour") => 3,
                        Some("minute") => 4,
                        Some("second") => 5,
                        _ => return None,
                    };
                    let at = |k: &str, lvl: u32| if depth >= lvl { uint(d, k) } else { None };
                    Some(DateGroup {
                        year: uint(d, "year")?,
                        month: at("month", 1),
                        day: at("day", 2),
                        hour: at("hour", 3),
                        minute: at("minute", 4),
                        second: at("second", 5),
                    })
                })
                .collect();
            if dates.is_empty() {
                FilterCriterion::Values { values, blanks }
            } else {
                FilterCriterion::DateGroups {
                    values,
                    blanks,
                    dates,
                }
            }
        }
        "top10" => match num(c, "val") {
            Some(n) => FilterCriterion::Top {
                n,
                percent: c.flag("percent", false),
                top: c.flag("top", true),
            },
            None => FilterCriterion::Unsupported,
        },
        "customFilters" => {
            let conditions: Option<Vec<CustomCondition>> = c
                .children_named("customFilter")
                .map(|f| {
                    let op = match f.attr("operator") {
                        Some(o) => FilterOp::parse(&o)?,
                        None => FilterOp::Equal,
                    };
                    Some(CustomCondition {
                        op,
                        val: CompactString::new(f.attr("val").unwrap_or_default()),
                    })
                })
                .collect();
            let Some(conditions) = conditions.filter(|c| !c.is_empty() && c.len() <= 2) else {
                return FilterCriterion::Unsupported;
            };
            let and = c.flag("and", false);
            if conditions.len() == 1 && conditions[0].op == FilterOp::Equal {
                let v = conditions[0].val.as_str();
                if let Some(t) = v.strip_prefix('*').and_then(|v| v.strip_suffix('*')) {
                    if !t.is_empty() && !t.contains(['*', '?', '~']) {
                        return FilterCriterion::Contains(CompactString::new(t));
                    }
                }
            }
            FilterCriterion::Custom { and, conditions }
        }
        "dynamicFilter" => match c.attr("type") {
            Some(kind) => FilterCriterion::Dynamic {
                kind: CompactString::new(kind),
                val: num(c, "val"),
                max_val: num(c, "maxVal"),
            },
            None => FilterCriterion::Unsupported,
        },
        "colorFilter" => FilterCriterion::Color {
            cell_color: c.flag("cellColor", true),
            dxf_id: uint(c, "dxfId"),
        },
        "iconFilter" => match c.attr("iconSet") {
            Some(set) => FilterCriterion::Icon {
                set: CompactString::new(set),
                id: uint(c, "iconId"),
            },
            None => FilterCriterion::Unsupported,
        },
        _ => FilterCriterion::Unsupported,
    }
}

fn fmt_num(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

/// The element a criterion writes inside `<filterColumn>` (`None` for
/// [`FilterCriterion::Unsupported`], which has nothing to write).
pub fn criterion_node(c: &FilterCriterion, prefix: &str) -> Option<XNode> {
    let el = |l: &str| XNode::new(format!("{prefix}{l}"));
    let filters = |values: &[CompactString], blanks: bool, dates: &[DateGroup]| {
        let mut n = el("filters");
        if blanks {
            n.set("blank", Some("1".into()));
        }
        for v in values {
            n.children.push(el("filter").with_attr("val", v.as_str()));
        }
        for d in dates {
            let mut g = el("dateGroupItem").with_attr("year", d.year.to_string());
            let mut depth = "year";
            for (k, v, name) in [
                ("month", d.month, "month"),
                ("day", d.day, "day"),
                ("hour", d.hour, "hour"),
                ("minute", d.minute, "minute"),
                ("second", d.second, "second"),
            ] {
                match v {
                    Some(v) => {
                        g.attrs.push((k.into(), v.to_string()));
                        depth = name;
                    }
                    None => break,
                }
            }
            g.attrs.push(("dateTimeGrouping".into(), depth.into()));
            n.children.push(g);
        }
        n
    };
    Some(match c {
        FilterCriterion::Values { values, blanks } => filters(values, *blanks, &[]),
        FilterCriterion::DateGroups {
            values,
            blanks,
            dates,
        } => filters(values, *blanks, dates),
        FilterCriterion::Contains(t) => {
            el("customFilters").with_child(el("customFilter").with_attr("val", format!("*{t}*")))
        }
        FilterCriterion::Custom { and, conditions } => {
            let mut n = el("customFilters");
            if *and {
                n.set("and", Some("1".into()));
            }
            for k in conditions {
                let mut f = el("customFilter");
                if k.op != FilterOp::Equal {
                    f.set("operator", Some(k.op.as_str().into()));
                }
                f.set("val", Some(k.val.to_string()));
                n.children.push(f);
            }
            n
        }
        FilterCriterion::Top { n, percent, top } => {
            let mut t = el("top10");
            if !*top {
                t.set("top", Some("0".into()));
            }
            if *percent {
                t.set("percent", Some("1".into()));
            }
            t.set("val", Some(fmt_num(*n)));
            t
        }
        FilterCriterion::Dynamic { kind, val, max_val } => {
            let mut d = el("dynamicFilter").with_attr("type", kind.as_str());
            if let Some(v) = val {
                d.set("val", Some(fmt_num(*v)));
            }
            if let Some(v) = max_val {
                d.set("maxVal", Some(fmt_num(*v)));
            }
            d
        }
        FilterCriterion::Color { cell_color, dxf_id } => {
            let mut n = el("colorFilter");
            if let Some(d) = dxf_id {
                n.set("dxfId", Some(d.to_string()));
            }
            if !*cell_color {
                n.set("cellColor", Some("0".into()));
            }
            n
        }
        FilterCriterion::Icon { set, id } => {
            let mut n = el("iconFilter").with_attr("iconSet", set.as_str());
            if let Some(i) = id {
                n.set("iconId", Some(i.to_string()));
            }
            n
        }
        FilterCriterion::Unsupported => return None,
    })
}

/// Write `view` as an `<autoFilter>`, starting from the element as read
/// (`base`): its attributes, its `sortState` and the attributes of each
/// `filterColumn` that stays (`hiddenButton`, `showButton`) are kept; a
/// column whose criterion is [`FilterCriterion::Unsupported`] keeps its
/// element as it was.
pub fn autofilter_node(view: &FilterView, base: Option<&XNode>, prefix: &str) -> XNode {
    let p = base.map_or(prefix.to_string(), |b| b.prefix().to_string());
    let mut n = base
        .cloned()
        .unwrap_or_else(|| XNode::new(format!("{p}autoFilter")));
    let r = view.range.normalized();
    n.set(
        "ref",
        Some(format!(
            "{}{}:{}{}",
            sheet_core::col_to_a1(r.start.col),
            r.start.row + 1,
            sheet_core::col_to_a1(r.end.col),
            r.end.row + 1
        )),
    );
    let old: Vec<XNode> = n.children_named("filterColumn").cloned().collect();
    n.remove_children("filterColumn");
    let mut cols: Vec<&ColumnFilter> = view.columns.iter().collect();
    cols.sort_by_key(|c| c.col);
    let mut kids = Vec::new();
    for c in cols {
        let was = old
            .iter()
            .find(|o| o.attr("colId").and_then(|v| v.parse::<u32>().ok()) == Some(c.col));
        match criterion_node(&c.criterion, &p) {
            Some(body) => {
                let mut fc = was
                    .cloned()
                    .unwrap_or_else(|| XNode::new(format!("{p}filterColumn")));
                fc.set("colId", Some(c.col.to_string()));
                fc.children.retain(|k| k.local() == "extLst");
                fc.children.insert(0, body);
                kids.push(fc);
            }
            None => {
                if let Some(w) = was {
                    kids.push(w.clone());
                }
            }
        }
    }
    // CT_AutoFilter: filterColumn*, sortState?, extLst?
    n.children.splice(0..0, kids);
    n
}

fn parse_ref(s: &str, sheet: SheetId) -> Option<RangeRef> {
    let mk = |row, col| CellRef {
        sheet,
        row,
        col,
        row_abs: false,
        col_abs: false,
    };
    let (a, b) = s.split_once(':').unwrap_or((s, s));
    let (r0, c0, _, _) = parse_a1(a)?;
    let (r1, c1, _, _) = parse_a1(b)?;
    Some(RangeRef {
        start: mk(r0, c0),
        end: mk(r1, c1),
    })
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    #[test]
    fn every_criterion_round_trips__feat__sheet_filter_criteria() {
        let xml = br#"<autoFilter ref="A1:F20"><filterColumn colId="0"><filters blank="1"><filter val="x"/><dateGroupItem year="2026" month="3" dateTimeGrouping="month"/></filters></filterColumn><filterColumn colId="1"><customFilters and="1"><customFilter operator="greaterThan" val="5"/><customFilter operator="lessThanOrEqual" val="9"/></customFilters></filterColumn><filterColumn colId="2"><top10 top="0" percent="1" val="10"/></filterColumn><filterColumn colId="3"><dynamicFilter type="aboveAverage" val="4.5"/></filterColumn><filterColumn colId="4"><colorFilter dxfId="2" cellColor="0"/></filterColumn><filterColumn colId="5" hiddenButton="1"><iconFilter iconSet="3Arrows" iconId="1"/></filterColumn></autoFilter>"#;
        let f = parse(xml, 0).unwrap();
        assert!(
            matches!(&f.columns[0].criterion, FilterCriterion::DateGroups { dates, .. } if dates[0].month == Some(3) && dates[0].day.is_none())
        );
        assert!(
            matches!(&f.columns[1].criterion, FilterCriterion::Custom { and: true, conditions } if conditions.len() == 2)
        );
        let base = XNode::parse(xml).unwrap();
        let out = autofilter_node(&f, Some(&base), "").to_xml();
        assert_eq!(out.as_bytes(), &xml[..]);
        assert_eq!(parse(out.as_bytes(), 0).unwrap(), f);
    }

    #[test]
    fn values_contains_top_and_unsupported() {
        let xml = br#"<autoFilter ref="A1:D9">
            <filterColumn colId="0"><filters blank="1"><filter val="East"/><filter val="West"/></filters></filterColumn>
            <filterColumn colId="1"><customFilters><customFilter val="*cap*"/></customFilters></filterColumn>
            <filterColumn colId="2"><top10 val="3"/></filterColumn>
            <filterColumn colId="3"><dynamicFilter type="today"/></filterColumn>
        </autoFilter>"#;
        let f = parse(xml, 0).expect("autoFilter");
        assert_eq!(f.range.start.row, 0);
        assert_eq!(f.range.end.row, 8);
        assert_eq!(f.range.end.col, 3);
        assert!(f.from_file);
        assert_eq!(
            f.columns[0].criterion,
            FilterCriterion::Values {
                values: vec!["East".into(), "West".into()],
                blanks: true
            }
        );
        assert_eq!(
            f.columns[1].criterion,
            FilterCriterion::Contains("cap".into())
        );
        assert_eq!(
            f.columns[2].criterion,
            FilterCriterion::Top {
                n: 3.0,
                percent: false,
                top: true
            }
        );
        assert_eq!(
            f.columns[3].criterion,
            FilterCriterion::Dynamic {
                kind: "today".into(),
                val: None,
                max_val: None
            }
        );
    }

    #[test]
    fn table_part_and_bare_element() {
        let table = br#"<table xmlns="x" name="T" ref="A1:B4"><autoFilter ref="A1:B4"/><tableColumns count="2"/></table>"#;
        let f = parse(table, 2).expect("table autoFilter");
        assert_eq!(f.range.start.sheet, 2);
        assert!(f.columns.is_empty());
        assert!(parse(b"<table name=\"T\"/>", 0).is_none());
    }
}
