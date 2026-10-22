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

//! Wall-clock bench for the live grid scene — TRENDED, never gated (the
//! gate is the work-count test `sheet_grid_scene_work_is_visible_cells_only`).
//!
//! `cargo bench -p sheet-grid` (add `-- --quick` for a fast pass).

use criterion::{criterion_group, criterion_main, Criterion};
use sheet_core::{Cell, CellValue, SheetModel, StyleId};
use sheet_grid::{grid_scene_styled, FrameWindowSpec};
use sheet_lower::condfmt::SheetCondFmt;
use sheet_lower::VisualAttrs;

fn visual(id: StyleId) -> Option<VisualAttrs> {
    (id.0 % 3 == 1).then(|| VisualAttrs {
        bold: true,
        fill_rgb: Some("#EEEEEE".into()),
        ..Default::default()
    })
}

/// A 50-column × 200-row window over a 20 000 × 100 populated sheet, with a
/// frozen header row and column, scrolled into the middle.
fn bench_window(c: &mut Criterion) {
    let mut m = SheetModel::new();
    let s = m.add_sheet("Data");
    {
        let ws = m.sheet_mut(s).unwrap();
        for r in 0..20_000u32 {
            for col in 0..100u32 {
                let value = if col % 4 == 0 {
                    CellValue::from("label text")
                } else {
                    CellValue::Number(f64::from(r * 100 + col))
                };
                ws.set_cell(
                    r,
                    col,
                    Cell {
                        value,
                        style: StyleId(col % 3),
                        ..Default::default()
                    },
                );
            }
        }
    }
    let spec = FrameWindowSpec {
        top_row: 10_000,
        left_col: 30,
        width_pt: 50.0 * 44.2575 + 1.0,
        height_pt: 200.0 * 15.0 + 1.0,
        freeze_rows: 1,
        freeze_cols: 1,
    };
    let cf = SheetCondFmt::default();
    c.bench_function("grid_scene_50x200_window", |b| {
        b.iter(|| grid_scene_styled(&m, s, &spec, true, &[], &cf, &visual))
    });
}

criterion_group!(benches, bench_window);
criterion_main!(benches);
