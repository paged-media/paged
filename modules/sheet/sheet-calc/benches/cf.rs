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

//! Conditional-format evaluation (W2.4, sheet ADR 523): a 1,000,000-cell
//! sheet (100,000 rows × 10 columns) under 20 rules of every kind, the
//! grid's viewport (40 rows × 15 columns) asked cell by cell — once with
//! the statistics cache warm (what a scroll costs; budget < 5 ms native),
//! once cold (the first frame after a recalc computes each rule's
//! whole-range statistics once).

use criterion::{criterion_group, criterion_main, Criterion};
use sheet_calc::cf::{cell_outcome, CfCache, CfContext};
use sheet_calc::{Engine, EngineConfig};
use sheet_core::condfmt::*;
use sheet_core::visual::{CellFill, ColorRef, DifferentialFormat, PatternKind};
use sheet_core::{Cell, CellValue, SheetModel};
use sheet_format::ColorPalette;

const ROWS: u32 = 100_000;
const COLS: u32 = 10;

fn engine() -> Engine {
    let mut m = SheetModel::new();
    let s = m.add_sheet("S");
    let ws = m.sheet_mut(s).unwrap();
    for r in 0..ROWS {
        for c in 0..COLS {
            let v = ((r * 7919 + c * 104729) % 1000) as f64;
            ws.set_cell(
                r,
                c,
                Cell {
                    value: CellValue::Number(v),
                    ..Default::default()
                },
            );
        }
    }
    Engine::new(m, EngineConfig::default())
}

fn rules() -> SheetCf {
    let fill = DifferentialFormat {
        fill: Some(CellFill::Pattern {
            pattern: PatternKind::Solid,
            fg: Some(ColorRef::rgb(255, 199, 206)),
            bg: None,
        }),
        ..Default::default()
    };
    let num = |v: &str| Cfvo::new(CfvoKind::Num, Some(v));
    let kinds = vec![
        CfKind::CellIs {
            op: CfOp::GreaterThan,
            formulas: vec!["900".into()],
        },
        CfKind::CellIs {
            op: CfOp::Between,
            formulas: vec!["100".into(), "$K$1".into()],
        },
        CfKind::Expression {
            formula: "MOD(A1,7)=0".into(),
        },
        CfKind::Expression {
            formula: "A1>B1".into(),
        },
        CfKind::Top10 {
            rank: 10,
            percent: false,
            bottom: false,
        },
        CfKind::Top10 {
            rank: 5,
            percent: true,
            bottom: true,
        },
        CfKind::AboveAverage {
            above: true,
            equal: false,
            std_dev: 1,
        },
        CfKind::AboveAverage {
            above: false,
            equal: true,
            std_dev: 0,
        },
        CfKind::Duplicates { unique: true },
        CfKind::Text {
            op: CfTextOp::Contains,
            text: "9".into(),
        },
        CfKind::Blanks { blank: false },
        CfKind::Errors { error: true },
        CfKind::TimePeriod {
            period: CfTimePeriod::ThisMonth,
        },
        CfKind::ColorScale {
            cfvos: vec![
                Cfvo::new(CfvoKind::Min, None),
                Cfvo::new(CfvoKind::Percentile, Some("50")),
                Cfvo::new(CfvoKind::Max, None),
            ],
            colors: vec![
                ColorRef::rgb(248, 105, 107),
                ColorRef::rgb(255, 235, 132),
                ColorRef::rgb(99, 190, 123),
            ],
        },
        CfKind::ColorScale {
            cfvos: vec![num("0"), num("1000")],
            colors: vec![ColorRef::rgb(255, 255, 255), ColorRef::rgb(90, 138, 198)],
        },
        CfKind::DataBar(DataBarRule::new(
            Cfvo::new(CfvoKind::Min, None),
            Cfvo::new(CfvoKind::Max, None),
            ColorRef::rgb(99, 142, 198),
        )),
        CfKind::DataBar(DataBarRule::new(
            Cfvo::new(CfvoKind::Percent, Some("10")),
            Cfvo::new(CfvoKind::Percentile, Some("90")),
            ColorRef::rgb(255, 0, 0),
        )),
        CfKind::IconSet(IconSetRule {
            set: "3Arrows".into(),
            cfvos: vec![
                Cfvo::new(CfvoKind::Percent, Some("0")),
                Cfvo::new(CfvoKind::Percent, Some("33")),
                Cfvo::new(CfvoKind::Percent, Some("67")),
            ],
            reverse: false,
            show_value: true,
            custom: vec![],
        }),
        CfKind::IconSet(IconSetRule {
            set: "5Quarters".into(),
            cfvos: vec![num("0"), num("200"), num("400"), num("600"), num("800")],
            reverse: false,
            show_value: true,
            custom: vec![],
        }),
        CfKind::CellIs {
            op: CfOp::Equal,
            formulas: vec!["500".into()],
        },
    ];
    SheetCf {
        blocks: kinds
            .into_iter()
            .enumerate()
            .map(|(i, kind)| CfBlock {
                ranges: vec![(0, 0, ROWS - 1, COLS - 1)],
                rules: vec![CfRule {
                    dxf: Some(fill.clone()),
                    ..CfRule::new(kind, i as i64 + 1)
                }],
                x14_only: false,
            })
            .collect(),
    }
}

fn viewport(ctx: &CfContext<'_>, cache: &mut CfCache) -> usize {
    let mut n = 0;
    for r in 5000..5040 {
        for c in 0..COLS.min(15) {
            if cell_outcome(ctx, cache, r, c).is_some() {
                n += 1;
            }
        }
    }
    n
}

fn bench(c: &mut Criterion) {
    let e = engine();
    let cf = rules();
    let pal = ColorPalette::default();
    let ctx = CfContext {
        engine: &e,
        sheet: 0,
        cf: &cf,
        palette: &pal,
    };
    let mut warm = CfCache::new();
    viewport(&ctx, &mut warm);
    c.bench_function("cf_viewport_1m_cells_20_rules_warm", |b| {
        b.iter(|| viewport(&ctx, &mut warm))
    });
    let mut g = c.benchmark_group("cold");
    g.sample_size(10);
    g.bench_function("cf_viewport_1m_cells_20_rules_cold", |b| {
        b.iter(|| viewport(&ctx, &mut CfCache::new()))
    });
    g.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
