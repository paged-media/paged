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

//! The Excel CONDITIONAL-FORMAT display lane replayed
//! (`oracle/excel/cfdisplay.py`): for every cell of the fixture
//! `20-condfmt-all.xlsx` (one rule kind per column), what Excel 16 shows —
//! text, font colour, interior colour — against the page lowering through
//! the session (the evaluator in `sheet_calc::cf`, the styles through the
//! shared styler). Disagreements are rulings in `cf-display-divergences.tsv`.

use sheet_js::core::{LowerOptions, SheetSession};
use std::collections::BTreeMap;
use std::path::PathBuf;

fn here() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn triplet(hex: Option<&str>, default: &str) -> String {
    let h = hex.unwrap_or(default).trim_start_matches('#');
    let p = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).unwrap_or(0);
    format!("{},{},{}", p(0), p(2), p(4))
}

#[test]
#[allow(non_snake_case)]
fn excel_cf_display_lane__feat__sheet_lower_condfmt() {
    let bytes = std::fs::read(here().join("../corpus/xlsx-corpus/20-condfmt-all.xlsx")).unwrap();
    let s = SheetSession::load_xlsx(&bytes).unwrap();
    let page = s
        .get_range_page(0, "A1:T10", LowerOptions::default())
        .unwrap();
    let recorded =
        std::fs::read_to_string(here().join("oracle/excel/recorded/cf-display.tsv")).unwrap();
    let divergences: BTreeMap<String, String> =
        std::fs::read_to_string(here().join("oracle/excel/cf-display-divergences.tsv"))
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
            .filter_map(|l| {
                l.split_once('\t')
                    .map(|(a, b)| (a.to_string(), b.to_string()))
            })
            .collect();
    let (mut agree, mut ruled, mut fail) = (0, 0, Vec::new());
    for line in recorded.lines().filter(|l| !l.starts_with('#')) {
        let f: Vec<&str> = line.split('\t').collect();
        let [addr, shown, font, interior] = f[..] else {
            panic!("malformed row {line}");
        };
        let (r, c, _, _) = sheet_core::parse_a1(addr).unwrap();
        let row = page.rows.iter().find(|x| x.index == r).unwrap();
        let cell = row.cells.iter().find(|x| x.col == c).unwrap();
        let st = &page.styles[cell.style_key as usize];
        let ours = (
            cell.text.as_str(),
            triplet(st.text_rgb.as_deref(), "#000000"),
            triplet(st.fill_rgb.as_deref(), "#FFFFFF"),
        );
        let ok = ours.0 == shown && ours.1 == font && ours.2 == interior;
        if ok {
            agree += 1;
            assert!(
                !divergences.contains_key(addr),
                "{addr}: agrees now — drop its divergence row"
            );
        } else if divergences.contains_key(addr) {
            ruled += 1;
        } else {
            fail.push(format!(
                "{addr}: engine {:?} font {} fill {} / Excel {shown:?} font {font} fill {interior}",
                ours.0, ours.1, ours.2
            ));
        }
    }
    eprintln!("cf display lane: {agree} agree, {ruled} ruled");
    assert!(agree >= 150, "{agree}");
    assert!(
        fail.is_empty(),
        "{} disagreements:\n{}",
        fail.len(),
        fail.join("\n")
    );
}
