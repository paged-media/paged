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

//! Conditional formatting for the lowerings (W2.4, sheet ADR 523): the
//! session's evaluator (`sheet_calc::cf`) behind the lowering's
//! [`CellCfSource`], with its statistics cache kept per sheet until the
//! next change to the engine (every write goes through `engine_mut`, which
//! drops the caches).

use std::cell::RefCell;
use std::collections::HashMap;

use sheet_calc::cf::{cell_outcome, CfCache, CfContext, CfOutcome};
use sheet_core::condfmt::SheetCf;
use sheet_core::{CellValue, SheetId};
use sheet_format::resolve::{hex, ColorPalette};
use sheet_lower::{BarDraw, CellCf, CellCfSource, IconDraw};

use super::SheetSession;

/// Per-sheet evaluation caches (dropped on every engine write).
#[derive(Debug, Default)]
pub(crate) struct CfCaches(RefCell<HashMap<SheetId, CfCache>>);

impl CfCaches {
    pub(crate) fn clear(&self) {
        self.0.borrow_mut().clear();
    }
}

/// The lowering's view of the evaluator for one sheet.
pub(crate) struct EvalCf<'a> {
    ctx: CfContext<'a>,
    caches: &'a CfCaches,
}

/// An evaluator outcome as the lowering draws it.
pub(crate) fn to_cell_cf(o: CfOutcome, palette: &ColorPalette) -> CellCf {
    CellCf {
        num_fmt: o.dxf.as_ref().and_then(|d| d.num_fmt.clone()),
        delta: o
            .dxf
            .as_ref()
            .map(|d| sheet_lower::resolve_dxf_delta(d, palette)),
        scale: o.scale.map(hex),
        bar: o.bar.map(|b| BarDraw {
            start: b.start,
            end: b.end,
            negative: b.negative,
            color: b.color,
            color_swatch: b.color_swatch,
            border: b.border,
            gradient: b.gradient,
            axis: b.axis,
            axis_color: b.axis_color,
            show_value: b.show_value,
        }),
        icon: o.icon.map(|i| IconDraw {
            set: i.set,
            index: i.index,
            show_value: i.show_value,
        }),
    }
}

impl CellCfSource for EvalCf<'_> {
    fn is_empty(&self) -> bool {
        self.ctx.cf.is_empty()
    }

    fn cell_cf(&self, row: u32, col: u32, _value: &CellValue) -> Option<CellCf> {
        let mut caches = self.caches.0.borrow_mut();
        let cache = caches.entry(self.ctx.sheet).or_default();
        cell_outcome(&self.ctx, cache, row, col).map(|o| to_cell_cf(o, self.ctx.palette))
    }
}

impl SheetSession {
    /// The evaluator a lowering of `sheet` asks (`None`: no conditional
    /// formatting on the sheet).
    pub(crate) fn eval_cf(&self, sheet: SheetId) -> Option<EvalCf<'_>> {
        let cf: &SheetCf = self.doc.cf_models.get(&sheet)?;
        if cf.is_empty() {
            return None;
        }
        Some(EvalCf {
            ctx: CfContext {
                engine: self.engine(),
                sheet,
                cf,
                palette: self.doc.visual_styles.palette(),
            },
            caches: &self.cf_caches,
        })
    }
}
