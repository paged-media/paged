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

//! The Excel DISPLAY lane replayed (`oracle/excel/display.py`): what a cell
//! shows in Excel 16 — its text and its font colour — against what the
//! lowering shows for the same value and number format. The text goes through
//! `sheet_lower::lower_cell_display` (the path the page table and the live
//! grid share) and the colour through the shared `CellStyler`. A repeat fill
//! (`*x`) is compared with its run collapsed: Excel repeats the character to
//! the column width, the engine marks where it stands (`LoweredCell::fill`).
//! Disagreements are rulings in `display-divergences.tsv`.

use sheet_core::{Cell, CellStyle, CellValue, SheetModel};
use sheet_format::{FormatCache, FormatCtx};
use sheet_lower::{lower_cell_display, CellStyler, NoStyles, SheetCondFmt, VisualStyleSource};
use std::collections::BTreeMap;
use std::path::PathBuf;

fn oracle() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("oracle/excel")
}

fn rgb_triplet(hex: Option<&str>) -> String {
    let h = hex.unwrap_or("#000000").trim_start_matches('#');
    let p = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).unwrap_or(0);
    format!("{},{},{}", p(0), p(2), p(4))
}

/// Does Excel's `shown` equal the engine's text once the fill run (Excel's
/// repeated `ch` where the engine has a TAB) is collapsed?
fn same_with_fill(engine: &str, fill: Option<char>, shown: &str) -> bool {
    let Some(ch) = fill else {
        return engine == shown;
    };
    let Some((head, tail)) = engine.split_once('\t') else {
        return engine == shown;
    };
    shown.len() >= head.len() + tail.len()
        && shown.starts_with(head)
        && shown.ends_with(tail)
        && shown[head.len()..shown.len() - tail.len()]
            .chars()
            .all(|c| c == ch)
}

#[test]
#[allow(non_snake_case)]
fn excel_display_lane__feat__sheet_format_engine() {
    let recorded = std::fs::read_to_string(oracle().join("recorded/display.tsv"))
        .expect("recorded/display.tsv");
    let divergences: BTreeMap<String, String> =
        std::fs::read_to_string(oracle().join("display-divergences.tsv"))
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
            .filter_map(|l| {
                let mut it = l.splitn(2, '\t');
                Some((it.next()?.to_string(), it.next().unwrap_or("").to_string()))
            })
            .collect();
    let ctx = FormatCtx::default();
    let (mut agree, mut ruled, mut fail) = (0, 0, Vec::new());
    for line in recorded.lines().filter(|l| !l.starts_with('#')) {
        let cols: Vec<&str> = line.split('\t').collect();
        let [id, code, value, shown, font, _interior] = cols[..] else {
            panic!("malformed display row: {line}");
        };
        let mut m = SheetModel::new();
        let s = m.add_sheet("S");
        let num_fmt = m.styles.intern_num_fmt(code);
        let style = m.styles.intern_style(CellStyle {
            num_fmt,
            ..Default::default()
        });
        let v = value
            .parse::<f64>()
            .map(CellValue::Number)
            .unwrap_or_else(|_| CellValue::from(value));
        let cell = Cell {
            value: v,
            style,
            ..Default::default()
        };
        m.sheet_mut(s).unwrap().set_cell(0, 0, cell.clone());
        let mut cache = FormatCache::default();
        let d = lower_cell_display(&m, &cell, &mut cache, &ctx);
        let cf = SheetCondFmt::default();
        let mut styler = CellStyler::new(&NoStyles, &cf, m.sheet(s));
        let key = styler.key_for_display(0, 0, &cell, d.color);
        let styles = styler.into_styles();
        let engine_rgb = rgb_triplet(styles[key as usize].text_rgb.as_deref());
        let _ = NoStyles.format_color_rgb(sheet_format::FormatColor::Red);
        let text_ok = same_with_fill(&d.text, d.fill, shown);
        let color_ok = engine_rgb == font;
        if text_ok && color_ok {
            agree += 1;
            assert!(
                !divergences.contains_key(id),
                "{id}: agrees with Excel now — drop its divergence row"
            );
        } else if divergences.contains_key(id) {
            ruled += 1;
        } else {
            fail.push(format!(
                "{id} [{code}] {value}: engine {:?} {engine_rgb} / Excel {shown:?} {font}",
                d.text
            ));
        }
    }
    eprintln!("display lane: {agree} agree, {ruled} ruled");
    assert!(
        fail.is_empty(),
        "{} disagreements:\n{}",
        fail.len(),
        fail.join("\n")
    );
}
