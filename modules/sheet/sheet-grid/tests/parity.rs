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
use sheet_core::{Cell, CellValue, SheetModel, StyleId};
use sheet_grid::{grid_scene_styled, FrameWindowSpec};
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
