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

// ── Authoring (W2.5) ─────────────────────────────────────────────────────

use sheet_core::condfmt::{CfBlock, CfKind, CfRule};
use sheet_core::visual::DifferentialFormat;

use super::SessionError;

/// One rule as the authoring API lists it: its position in priority order
/// (the handle the other calls take until the next change), its ranges in
/// A1 and the rule itself (kind, priority, stop-if-true, differential
/// format, in the model's JSON shape).
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CfRuleInfo {
    pub index: u32,
    pub ranges: Vec<String>,
    pub rule: CfRule,
}

/// A rule to add or replace: its ranges (A1, several allowed), what it
/// tests and paints, whether it stops lower rules, its differential format.
#[derive(serde::Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CfRuleSpec {
    pub ranges: Vec<String>,
    pub kind: CfKind,
    #[serde(default)]
    pub stop_if_true: bool,
    #[serde(default)]
    pub dxf: Option<DifferentialFormat>,
}

impl SheetSession {
    /// The sheet's rules, by position in priority order: `(block, rule)`.
    fn cf_order(cf: &SheetCf) -> Vec<(usize, usize)> {
        let mut v: Vec<(i64, usize, usize)> = cf
            .blocks
            .iter()
            .enumerate()
            .flat_map(|(b, block)| {
                block
                    .rules
                    .iter()
                    .enumerate()
                    .map(move |(r, rule)| (rule.priority, b, r))
            })
            .collect();
        v.sort();
        v.into_iter().map(|(_, b, r)| (b, r)).collect()
    }

    /// The conditional-format rules of `sheet`, highest priority first.
    pub fn cf_rules(&self, sheet: u16) -> Result<Vec<CfRuleInfo>, SessionError> {
        self.validate_sheet(sheet)?;
        let Some(cf) = self.doc.cf_models.get(&sheet) else {
            return Ok(Vec::new());
        };
        Ok(Self::cf_order(cf)
            .into_iter()
            .enumerate()
            .map(|(i, (b, r))| CfRuleInfo {
                index: i as u32,
                ranges: cf.blocks[b]
                    .ranges
                    .iter()
                    .map(sheet_xlsx::cf_edit::range_a1)
                    .collect(),
                rule: cf.blocks[b].rules[r].clone(),
            })
            .collect())
    }

    fn cf_ranges(
        &self,
        ranges: &[String],
    ) -> Result<Vec<sheet_core::condfmt::CfRange>, SessionError> {
        if ranges.is_empty() {
            return Err(SessionError("a conditional format needs a range".into()));
        }
        ranges
            .iter()
            .map(|t| {
                let r = super::parse_range(t.trim())?;
                Ok((
                    r.r0.min(r.r1),
                    r.c0.min(r.c1),
                    r.r0.max(r.r1),
                    r.c0.max(r.c1),
                ))
            })
            .collect()
    }

    /// Apply `edit` to the sheet's rules (in priority order), renumber the
    /// priorities 1..n in that order and write the result.
    fn cf_apply(
        &mut self,
        sheet: u16,
        edit: impl FnOnce(&mut SheetCf, &mut Vec<(usize, usize)>) -> Result<(), SessionError>,
    ) -> Result<(), SessionError> {
        self.validate_sheet(sheet)?;
        let mut cf = self.doc.cf_models.get(&sheet).cloned().unwrap_or_default();
        let mut order = Self::cf_order(&cf);
        edit(&mut cf, &mut order)?;
        for (i, &(b, r)) in order.iter().enumerate() {
            if let Some(rule) = cf.blocks.get_mut(b).and_then(|bl| bl.rules.get_mut(r)) {
                rule.priority = i as i64 + 1;
            }
        }
        cf.blocks.retain(|b| !b.rules.is_empty());
        self.doc
            .write_conditional_formats(sheet, &cf)
            .map_err(|e| SessionError(e.to_string()))?;
        self.extra_dirty.insert(sheet);
        self.cf_caches.clear();
        Ok(())
    }

    /// Add a rule at the top of the priority order (as Excel's New Rule
    /// does). Returns its index (0).
    pub fn add_cf_rule(&mut self, sheet: u16, spec: CfRuleSpec) -> Result<u32, SessionError> {
        let ranges = self.cf_ranges(&spec.ranges)?;
        self.cf_apply(sheet, move |cf, order| {
            let rule = CfRule {
                stop_if_true: spec.stop_if_true,
                dxf: spec.dxf,
                ..CfRule::new(spec.kind, 0)
            };
            cf.blocks.push(CfBlock {
                ranges,
                rules: vec![rule],
                x14_only: false,
            });
            order.insert(0, (cf.blocks.len() - 1, 0));
            Ok(())
        })?;
        Ok(0)
    }

    /// Replace rule `index` (its ranges, test, format and stop flag); its
    /// priority stays.
    pub fn update_cf_rule(
        &mut self,
        sheet: u16,
        index: u32,
        spec: CfRuleSpec,
    ) -> Result<(), SessionError> {
        let ranges = self.cf_ranges(&spec.ranges)?;
        self.cf_apply(sheet, move |cf, order| {
            let &(b, r) = order
                .get(index as usize)
                .ok_or_else(|| SessionError(format!("no conditional format {index}")))?;
            let old = cf.blocks[b].rules[r].clone();
            let rule = CfRule {
                kind: spec.kind,
                stop_if_true: spec.stop_if_true,
                dxf: spec.dxf,
                dxf_id: None,
                ext_id: old.ext_id,
                priority: old.priority,
            };
            if cf.blocks[b].ranges == ranges {
                cf.blocks[b].rules[r] = rule;
            } else if cf.blocks[b].rules.len() == 1 {
                cf.blocks[b].ranges = ranges;
                cf.blocks[b].rules[r] = rule;
            } else {
                // The rule moves to its own block; the others keep theirs.
                cf.blocks[b].rules.remove(r);
                for o in order.iter_mut() {
                    if o.0 == b && o.1 > r {
                        o.1 -= 1;
                    }
                }
                cf.blocks.push(CfBlock {
                    ranges,
                    rules: vec![rule],
                    x14_only: false,
                });
                order[index as usize] = (cf.blocks.len() - 1, 0);
            }
            Ok(())
        })
    }

    /// Delete rule `index`.
    pub fn delete_cf_rule(&mut self, sheet: u16, index: u32) -> Result<(), SessionError> {
        self.cf_apply(sheet, move |cf, order| {
            if index as usize >= order.len() {
                return Err(SessionError(format!("no conditional format {index}")));
            }
            let (b, r) = order.remove(index as usize);
            cf.blocks[b].rules.remove(r);
            for o in order.iter_mut() {
                if o.0 == b && o.1 > r {
                    o.1 -= 1;
                }
            }
            Ok(())
        })
    }

    /// Put the rules in a new priority order: `order` lists the current
    /// indices, highest priority first (every index once).
    pub fn reorder_cf_rules(
        &mut self,
        sheet: u16,
        new_order: Vec<u32>,
    ) -> Result<(), SessionError> {
        self.cf_apply(sheet, move |_, order| {
            let mut seen = vec![false; order.len()];
            if new_order.len() != order.len()
                || new_order.iter().any(|&i| {
                    (i as usize) >= seen.len() || std::mem::replace(&mut seen[i as usize], true)
                })
            {
                return Err(SessionError(
                    "the new order must list every rule once".into(),
                ));
            }
            *order = new_order.iter().map(|&i| order[i as usize]).collect();
            Ok(())
        })
    }

    /// Set rule `index`'s stop-if-true.
    pub fn set_cf_stop_if_true(
        &mut self,
        sheet: u16,
        index: u32,
        stop: bool,
    ) -> Result<(), SessionError> {
        self.cf_apply(sheet, move |cf, order| {
            let &(b, r) = order
                .get(index as usize)
                .ok_or_else(|| SessionError(format!("no conditional format {index}")))?;
            cf.blocks[b].rules[r].stop_if_true = stop;
            Ok(())
        })
    }
}

impl SheetSession {
    /// The sheet's whole conditional-format model (the undo snapshot).
    pub fn cf_snapshot(&self, sheet: u16) -> Result<SheetCf, SessionError> {
        self.validate_sheet(sheet)?;
        Ok(self.doc.cf_models.get(&sheet).cloned().unwrap_or_default())
    }

    /// Restore a [`cf_snapshot`](Self::cf_snapshot) (the undo of an
    /// authoring step).
    pub fn cf_restore(&mut self, sheet: u16, cf: SheetCf) -> Result<(), SessionError> {
        self.validate_sheet(sheet)?;
        self.doc
            .write_conditional_formats(sheet, &cf)
            .map_err(|e| SessionError(e.to_string()))?;
        self.extra_dirty.insert(sheet);
        self.cf_caches.clear();
        Ok(())
    }
}
