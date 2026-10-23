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

//! Cross-surface parity (ADR 510): for random sheets — values, styles,
//! hidden rows and columns, conditional formats — the live grid scene of a
//! window and the page lowering of the range that window covers agree cell
//! by cell on text, alignment, style key and style.

#![allow(non_snake_case)] // test names end in `__feat__<cockpit id>`

use proptest::prelude::*;
use sheet_core::{Cell, CellRef, CellValue, RangeRef, SheetModel, StyleId};
use sheet_grid::{frame_page, grid_scene_styled, FrameWindowSpec, PagePrint};
use sheet_lower::condfmt::{
    CfBlock, CfOperator, CfRule, CfRuleKind, ColorScale, ScaleStop, SheetCondFmt,
};
use sheet_lower::{lower_range_condfmt, CellRange, ViewOptions, VisualAttrs};

fn visual(id: StyleId) -> Option<VisualAttrs> {
    match id.0 % 5 {
        1 => Some(VisualAttrs {
            bold: true,
            fill_rgb: Some("#FFCC00".into()),
            ..Default::default()
        }),
        2 => Some(VisualAttrs {
            italic: true,
            text_rgb: Some("#336699".into()),
            wrap: true,
            ..Default::default()
        }),
        3 => Some(VisualAttrs {
            border_top: true,
            v_align: Some("center".into()),
            ..Default::default()
        }),
        4 => Some(VisualAttrs {
            bold: true,
            fill_rgb: Some("#FFCC00".into()),
            ..Default::default()
        }),
        _ => None,
    }
}

#[derive(Debug, Clone)]
struct Seed {
    cells: Vec<(u32, u32, u8, u32)>,
    hidden: Vec<u32>,
    hidden_cols: Vec<u32>,
    cf: bool,
    top: u32,
    left: u32,
    w: f64,
    h: f64,
}

fn seed() -> impl Strategy<Value = Seed> {
    (
        prop::collection::vec((0u32..40, 0u32..12, 0u8..4, 0u32..7), 0..160),
        prop::collection::vec(0u32..40, 0..6),
        prop::collection::vec(1u32..12, 0..3),
        any::<bool>(),
        0u32..20,
        0u32..6,
        60.0f64..400.0,
        20.0f64..300.0,
    )
        .prop_map(|(cells, hidden, hidden_cols, cf, top, left, w, h)| Seed {
            cells,
            hidden,
            hidden_cols,
            cf,
            top,
            left,
            w,
            h,
        })
}

fn build(seed: &Seed) -> (SheetModel, SheetCondFmt) {
    let mut m = SheetModel::new();
    let s = m.add_sheet("S");
    let ws = m.sheet_mut(s).unwrap();
    for &(r, c, kind, style) in &seed.cells {
        let value = match kind {
            0 => CellValue::Number(f64::from(r * 13 + c)),
            1 => CellValue::from("text"),
            2 => CellValue::Bool(r % 2 == 0),
            _ => CellValue::Empty,
        };
        ws.set_cell(
            r,
            c,
            Cell {
                value,
                style: StyleId(style),
                ..Default::default()
            },
        );
    }
    for &r in &seed.hidden {
        ws.hidden_rows.insert(r);
    }
    for &c in &seed.hidden_cols {
        ws.col_meta.push(sheet_core::ColMeta {
            min: c,
            max: c,
            hidden: true,
            ..Default::default()
        });
    }
    let cf = if seed.cf {
        SheetCondFmt {
            blocks: vec![
                CfBlock {
                    ranges: vec![(0, 0, 39, 3)],
                    rules: vec![CfRule {
                        kind: CfRuleKind::CellIs {
                            op: CfOperator::GreaterThan,
                            operands: vec![200.0],
                        },
                        priority: 1,
                        dxf: VisualAttrs {
                            fill_rgb: Some("#FF0000".into()),
                            ..Default::default()
                        },
                    }],
                },
                CfBlock {
                    ranges: vec![(0, 4, 39, 8)],
                    rules: vec![CfRule {
                        kind: CfRuleKind::ColorScale(ColorScale {
                            stops: vec![
                                ScaleStop {
                                    value: None,
                                    rgb: (255, 255, 255),
                                },
                                ScaleStop {
                                    value: None,
                                    rgb: (0, 0, 255),
                                },
                            ],
                        }),
                        priority: 2,
                        dxf: VisualAttrs::default(),
                    }],
                },
            ],
        }
    } else {
        SheetCondFmt::default()
    };
    (m, cf)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    #[test]
    fn grid_scene_cells_equal_the_page_lowering__feat__sheet_style_mapping(seed in seed()) {
        let (m, cf) = build(&seed);
        let spec = FrameWindowSpec {
            top_row: seed.top,
            left_col: seed.left,
            width_pt: seed.w,
            height_pt: seed.h,
            freeze_rows: 0,
            freeze_cols: 0,
        };
        let scene = grid_scene_styled(&m, 0, &spec, true, &[], &cf, &visual);
        let vp = &scene.viewport;
        let (r0, c0) = (vp.row_indices[0], vp.col_indices[0]);
        let range = CellRange {
            r0,
            c0,
            r1: *vp.row_indices.last().unwrap(),
            c1: *vp.col_indices.last().unwrap(),
        };
        let page = lower_range_condfmt(&m, 0, range, &ViewOptions::default(), &visual, &cf);
        // Same tracks: the page skips the same hidden rows and columns.
        let page_rows: Vec<u32> = page.rows.iter().map(|r| r.index + r0).collect();
        prop_assert_eq!(&page_rows, &vp.row_indices);
        let page_cols: Vec<u32> = page.cols.iter().map(|c| c.index + c0).collect();
        prop_assert_eq!(&page_cols, &vp.col_indices);
        // Same styles table, same per-cell text / align / key.
        prop_assert_eq!(&scene.styles, &page.styles);
        for cell in &scene.cells {
            let row = page.rows.iter().find(|r| r.index + r0 == cell.row).unwrap();
            let pc = row.cells.iter().find(|pc| pc.col == cell.col - c0).unwrap();
            prop_assert_eq!(&cell.text, &pc.text);
            prop_assert_eq!(cell.align, pc.align);
            prop_assert_eq!(cell.style_key, pc.style_key);
        }
        for row in &page.rows {
            for pc in &row.cells {
                if pc.style_key != 0 || !pc.text.is_empty() {
                    let (r, c) = (row.index + r0, pc.col + c0);
                    prop_assert!(scene.cells.iter().any(|g| g.row == r && g.col == c));
                }
            }
        }
    }
}

fn at(row: u32, col: u32) -> CellRef {
    CellRef {
        sheet: 0,
        row,
        col,
        row_abs: false,
        col_abs: false,
    }
}

/// Non-overlapping merges from seeds: each seed `(r, c, h, w)` becomes the
/// area `r..r+h × c..c+w` unless it overlaps one already placed.
fn add_merges(m: &mut SheetModel, seeds: &[(u32, u32, u32, u32)]) {
    let ws = m.sheet_mut(0).unwrap();
    let mut placed: Vec<(u32, u32, u32, u32)> = Vec::new();
    for &(r, c, h, w) in seeds {
        let a = (r, c, r + h, c + w);
        if (h, w) == (0, 0) {
            continue;
        }
        if placed
            .iter()
            .any(|p| a.0 <= p.2 && p.0 <= a.2 && a.1 <= p.3 && p.1 <= a.3)
        {
            continue;
        }
        placed.push(a);
        ws.merges.push(RangeRef {
            start: at(a.0, a.1),
            end: at(a.2, a.3),
        });
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(160))]

    /// The page table of a frame (`frame_page`, no printed headings) and the
    /// live grid of the same window (`grid_scene_styled`) show the same
    /// tracks with the same sizes, the same styles table, the same cells and
    /// the same merges and gridlines — with frozen splits, hidden tracks,
    /// merges clipped by the window and conditional formats (ADR 510).
    #[test]
    fn frame_page_equals_the_grid_track_by_track__feat__sheet_lower_page(
        seed in seed(),
        merges in prop::collection::vec((0u32..40, 0u32..12, 0u32..4, 0u32..3), 0..6),
        freeze_rows in 0u32..4,
        freeze_cols in 0u32..3,
    ) {
        let (mut m, cf) = build(&seed);
        add_merges(&mut m, &merges);
        let spec = FrameWindowSpec {
            top_row: seed.top,
            left_col: seed.left,
            width_pt: seed.w,
            height_pt: seed.h,
            freeze_rows,
            freeze_cols,
        };
        let scene = grid_scene_styled(&m, 0, &spec, true, &[], &cf, &visual);
        let page = frame_page(
            &m,
            0,
            &spec,
            PagePrint { headings: false, gridlines: true },
            &cf,
            &visual,
        );
        let vp = &scene.viewport;
        // Same tracks (sheet indices, display order) and sizes.
        let rows: Vec<u32> = page.rows.iter().map(|r| r.index).collect();
        prop_assert_eq!(&rows, &vp.row_indices);
        let cols: Vec<u32> = page.cols.iter().map(|c| c.index).collect();
        prop_assert_eq!(&cols, &vp.col_indices);
        for (i, c) in page.cols.iter().enumerate() {
            prop_assert!((c.width_pt - (vp.x_offsets[i + 1] - vp.x_offsets[i])).abs() < 1e-9);
        }
        for (i, r) in page.rows.iter().enumerate() {
            prop_assert!((r.height_pt - (vp.y_offsets[i + 1] - vp.y_offsets[i])).abs() < 1e-9);
        }
        prop_assert_eq!(page.header_rows, vp.frozen_rows);
        // Same styles table.
        prop_assert_eq!(&scene.styles, &page.styles);
        // The grid's cells are the page's.
        let cell_at = |r: u32, c: u32| {
            let dr = rows.iter().position(|&x| x == r).unwrap();
            let dc = cols.iter().position(|&x| x == c).unwrap();
            (&page.rows[dr].cells[dc], dr, dc)
        };
        for g in &scene.cells {
            let (pc, _, _) = cell_at(g.row, g.col);
            prop_assert_eq!(&g.text, &pc.text);
            prop_assert_eq!(g.align, pc.align);
            prop_assert_eq!(g.style_key, pc.style_key);
        }
        // Each merge rect's shown corner carries the anchor on the page, and
        // spans the same shown tracks.
        prop_assert_eq!(scene.merges.len(), page.merges.len());
        let mut corners = std::collections::HashSet::new();
        for (gm, pm) in scene.merges.iter().zip(&page.merges) {
            let dc = vp.x_offsets.iter().position(|&x| (x - gm.x).abs() < 1e-9).unwrap();
            let dr = vp.y_offsets.iter().position(|&y| (y - gm.y).abs() < 1e-9).unwrap();
            prop_assert_eq!((pm.row, pm.col), (rows[dr], cols[dc]));
            let shown_rows = rows.iter().filter(|&&r| r >= pm.row && r < pm.row + pm.row_span).count();
            let shown_cols = cols.iter().filter(|&&c| c >= pm.col && c < pm.col + pm.col_span).count();
            let dr1 = vp.y_offsets.iter().position(|&y| (y - (gm.y + gm.h)).abs() < 1e-9).unwrap();
            let dc1 = vp.x_offsets.iter().position(|&x| (x - (gm.x + gm.w)).abs() < 1e-9).unwrap();
            prop_assert_eq!(shown_rows, dr1 - dr);
            prop_assert_eq!(shown_cols, dc1 - dc);
            let pc = &page.rows[dr].cells[dc];
            prop_assert_eq!(&gm.text, &pc.text);
            prop_assert_eq!(gm.style_key, pc.style_key);
            corners.insert((dr, dc));
        }
        // Every other page cell with content is a grid cell.
        for (dr, row) in page.rows.iter().enumerate() {
            for (dc, pc) in row.cells.iter().enumerate() {
                if corners.contains(&(dr, dc)) || (pc.text.is_empty() && pc.style_key == 0) {
                    continue;
                }
                prop_assert!(scene.cells.iter().any(|g| g.row == row.index && g.col == pc.col));
            }
        }
        // Same gridlines (both broken across merges) and data bars.
        prop_assert_eq!(&scene.gridlines, &page.rules);
        prop_assert_eq!(scene.databars.len(), page.databars.len());
        for (g, p) in scene.databars.iter().zip(&page.databars) {
            prop_assert_eq!((g.row, g.col, &g.fill), (p.row, p.col, &p.fill));
            prop_assert!((g.x - p.x).abs() < 1e-9 && (g.w - p.w).abs() < 1e-9);
        }
    }
}
