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

//! # sheet-calc — the calculation engine (spec §6.2/§6.3)
//!
//! The salsa-shaped core that joins the parser, the function library, and the
//! [`SheetModel`]: a dependency graph ([`graph`]), dirty propagation
//! ([`dirty`]), a deterministic topological scheduler ([`topo`]), the
//! tree-walk evaluator ([`eval`]), range-argument materialization
//! ([`argview`]), and volatile-pass support ([`volatile`]).
//!
//! External-workbook references resolve to CACHED values only ([`external`],
//! spec §13 M3; the no-network ruling §1.1) — links are NEVER followed.
//!
//! ## The public surface (FROZEN — `sheet-js` builds against exactly this)
//!
//! [`Engine`] owns the model + graph + dirty set + config. The cell-entry
//! door is [`Engine::enter`] (Excel-like literal/formula detection lives HERE,
//! in Rust); [`Engine::set_cell`] is the structured door; the recalc family is
//! [`Engine::recalc_all`] / [`Engine::recalc_dirty`]; structural edits go
//! through [`Engine::apply_edit`].
//!
//! ## Circular references (registry `sheet.calc.circular`, sheet ADR 514)
//!
//! [`CellError`] has no `Circular` variant: circularity is a diagnostic. When
//! the scheduler detects a cycle AND iterative calculation is OFF (the
//! default), the cycle members are not calculated — as in Excel, each keeps
//! its LAST value, and one never calculated shows `0` — and the full cycle set
//! is reported on [`RecalcResult::circular`] (the glue's circular WARNING).
//! Cells downstream of the cycle compute from those values. Breaking the cycle
//! (re-entering one member as a non-cyclic formula or a literal) recalculates
//! normally. (Until 2026-10-22 every member stored `#REF!`.)
//!
//! ## Iterative calculation (registry `sheet.calc.iterative.*`, D-7)
//!
//! When iterative calculation is ON ([`Engine::set_iterative`] /
//! [`sheet_core::CalcSettings::iterative`]), a detected cycle is instead
//! evaluated to a fixed point: the members are seeded at `0` and recomputed in a
//! stable order up to `max_iter` passes, stopping early when the largest
//! per-cell change falls to/below `max_change` (see [`iterate`]). On convergence
//! [`RecalcResult::circular`] is EMPTY; a system that exhausts `max_iter` is
//! reported on [`RecalcResult::non_converged`] (its last-iterate values kept).
//! This SUPERSEDES the keep-the-last-value ruling for that cycle only while the flag is on.
//!
//! ## Determinism
//!
//! Recalc order is independent of hash iteration order: the scheduler drains a
//! stable frontier ([`topo`]). The volatile RNG seed is derived from the
//! config seed mixed with a monotonic pass counter and the cell address
//! ([`volatile::cell_seed`]) — so `RAND` varies across passes yet is
//! reproducible under a fixed seed.

/// Bump a work counter (`perf.rs`). Expands to NOTHING without the
/// `perf-counters` feature — the argument is not even evaluated.
macro_rules! perf_count {
    ($field:ident, $n:expr) => {{
        #[cfg(feature = "perf-counters")]
        $crate::perf::bump(|c| c.$field += ($n) as u64);
    }};
}

mod accel;
pub mod argview;
pub mod dirty;
pub mod eval;
pub mod external;
pub mod graph;
pub mod iterate;
pub mod layout;
pub mod names;
#[cfg(feature = "perf-counters")]
pub mod perf;
pub mod spill;
pub mod topo;
pub mod volatile;

use sheet_core::ast::Formula;
use sheet_core::{Cell, CellError, CellRef, CellValue, NameId, SheetId, SheetModel};
use sheet_fn::FnResult;
use sheet_format::entry::{is_text_format, parse_entry_for_format, Entry, EntryCtx, FormatHint};
use sheet_parser::{Edit, ParseCtx};

use crate::dirty::Dirty;
use crate::graph::DepGraph;
use crate::spill::{SpillRect, SpillState};

/// Per-engine configuration. `now_serial` feeds `NOW`/`TODAY`; `rng_seed`
/// seeds the deterministic volatile RNG. Defaults: `0.0` / `0x5EED`.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct EngineConfig {
    pub now_serial: f64,
    pub rng_seed: u64,
}

impl Default for EngineConfig {
    fn default() -> Self {
        EngineConfig {
            now_serial: 0.0,
            rng_seed: 0x5EED,
        }
    }
}

/// The outcome of a recalc: the cells whose stored value CHANGED in this pass,
/// the cells found on a cycle (the `sheet.calc.circular` set), and — when
/// iterative calculation is enabled — the cycle cells that did NOT converge
/// within `max_iter` (the `sheet.calc.iterative.*` set).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RecalcResult {
    /// Formula cells whose stored value changed during this recalc.
    pub changed: Vec<CellRef>,
    /// Formula cells on a circular reference (iteration OFF): not calculated,
    /// they keep their last value (0 when never calculated) — sheet ADR 514.
    /// EMPTY when iterative calculation is enabled — a cycle then iterates to a
    /// fixed point (its members move to `non_converged` only if they fail to
    /// settle within `max_iter`).
    pub circular: Vec<CellRef>,
    /// Cycle cells that did NOT converge within `max_iter` while iterative
    /// calculation was enabled (their last-iterate values are kept in the
    /// model). Always EMPTY with iteration off, and empty for a cycle that
    /// converged. Sorted [`CellRef`] for determinism.
    pub non_converged: Vec<CellRef>,
}

/// The cell-entry payload for [`Engine::set_cell`] — the structured door
/// (`enter` is the Excel-like raw-text door above it).
pub enum SetInput {
    /// Clear the cell (blank).
    Empty,
    /// A literal value.
    Value(CellValue),
    /// A parsed formula.
    Formula(Formula),
}

/// A typed cell entry, parsed but not committed ([`Engine::parse_entry_at`]):
/// the input plus the number format the text implies and whether a leading
/// `'` forced text (the cell then carries the quote-prefix attribute).
pub struct TypedInput {
    pub input: SetInput,
    pub hint: Option<FormatHint>,
    pub quote_prefix: bool,
}

/// The calculation engine. Owns the [`SheetModel`], the dependency
/// [`DepGraph`], the [`Dirty`] cut, the [`EngineConfig`], and a monotonic
/// pass counter that seeds volatile RNG.
pub struct Engine {
    model: SheetModel,
    graph: DepGraph,
    dirty: Dirty,
    config: EngineConfig,
    /// Monotonic recalc-pass counter (mixed into the volatile RNG seed so
    /// `RAND` changes each pass but stays deterministic under a fixed seed).
    pass: u64,
    /// The dynamic-array spill ledger (spec §6.4, M1 spill track): anchor →
    /// owned region + every owned cell → its anchor. Off-model bookkeeping; the
    /// spilled cells themselves are plain value cells in [`Engine::model`].
    spills: SpillState,
    /// Whether recalcs use the range accelerators (`accel`, sheet ADR 512).
    /// On by default; off only to prove the fast paths equal the kernels.
    accelerate: bool,
    /// Formula cells staged since the last recalc — what manual calculation
    /// evaluates on entry.
    entered: Vec<CellRef>,
}

impl Engine {
    /// Build from an existing model (e.g. an xlsx load): registers every cell
    /// that has a [`sheet_core::FormulaId`], marks everything dirty. Does NOT
    /// recalc — the caller chooses `recalc_all`/`recalc_dirty`.
    pub fn new(mut model: SheetModel, config: EngineConfig) -> Engine {
        names::compile_names(&mut model);
        names::resolve_unknowns(&mut model);
        let mut graph = DepGraph::new();
        graph.rebuild(&model);
        let mut dirty = Dirty::new();
        dirty.mark_all(&graph);
        // Seed volatility from each formula's extracted refs.
        seed_volatility(&model, &graph, &mut dirty);
        Engine {
            model,
            graph,
            dirty,
            config,
            pass: 0,
            spills: SpillState::new(),
            accelerate: true,
            entered: Vec::new(),
        }
    }

    /// Turn the range accelerators (column snapshots, anchored prefix
    /// aggregates, exact-match indexes — sheet ADR 512) on or off for later
    /// recalcs. They are on by default and never change a result; the switch
    /// exists so tests can compare the accelerated and the plain kernel
    /// paths bit for bit.
    pub fn set_accelerators(&mut self, on: bool) {
        self.accelerate = on;
    }

    /// Read-only access to the spill ledger (test/introspection seam — the
    /// `sheet-js` surface reports spill regions through this).
    pub fn spills(&self) -> &SpillState {
        &self.spills
    }

    /// Read-only access to the underlying model.
    pub fn model(&self) -> &SheetModel {
        &self.model
    }

    /// Replace a sheet's filter VIEW state (Wave 7): its filter views and the
    /// rows they hide. View state only — no cell, value or dependency
    /// changes, so nothing recalculates. `false` for an unknown sheet.
    pub fn set_filter_view(
        &mut self,
        sheet: sheet_core::SheetId,
        filters: Vec<sheet_core::FilterView>,
        filtered_rows: std::collections::BTreeSet<u32>,
    ) -> bool {
        match self.model.sheet_mut(sheet) {
            Some(ws) => {
                ws.filters = filters;
                ws.filtered_rows = filtered_rows;
                true
            }
            None => false,
        }
    }

    /// Escape hatch for structural consumers (the `sheet-js` save path).
    ///
    /// MUTATING cells through the returned model WITHOUT going back through
    /// [`Engine::set_cell`]/[`Engine::enter`] DESYNCS the dependency graph and
    /// dirty set — the engine cannot observe edits made directly on the model.
    /// Only use this when you are DONE with the engine (e.g. to serialize).
    pub fn into_model(self) -> SheetModel {
        self.model
    }

    /// Update the `NOW`/`TODAY` serial. Marks volatile cells for recompute on
    /// the next recalc (they are already reseeded each pass, but this makes the
    /// new clock visible without a separate write).
    pub fn set_now(&mut self, now_serial: f64) {
        self.config.now_serial = now_serial;
    }

    /// Toggle iterative (circular) calculation (spec §6.2, D-7; registry
    /// `sheet.calc.iterative.*`). Writes the three knobs into the workbook's
    /// [`CalcSettings`] (`iterative` / `max_iter` / `max_change`, the OOXML
    /// `<calcPr>` `iterate` / `iterateCount` / `iterateDelta`) and triggers a
    /// full recalc so cycle members switch policy immediately:
    ///
    /// - `on == false`: a cycle keeps the `sheet.calc.circular` ruling (each
    ///   member keeps its last value, reported on [`RecalcResult::circular`]).
    /// - `on == true`: a cycle iterates to a fixed point (seeded at `0`,
    ///   recomputed in stable order up to `max_iter` passes, stopping early at
    ///   `max_change`). [`RecalcResult::circular`] is then empty; cells that do
    ///   not settle land on [`RecalcResult::non_converged`].
    ///
    /// `max_iter` / `max_change` are honored even when `on == false` (they are
    /// stored for the next time iteration is enabled); Excel's defaults are
    /// `100` / `0.001` ([`CalcSettings::default`]).
    ///
    /// [`CalcSettings`]: sheet_core::CalcSettings
    /// [`CalcSettings::default`]: sheet_core::CalcSettings
    pub fn set_iterative(&mut self, on: bool, max_iter: u32, max_change: f64) -> RecalcResult {
        self.model.calc.iterative = on;
        self.model.calc.max_iter = max_iter;
        self.model.calc.max_change = max_change;
        self.recalc_all()
    }

    /// THE cell-entry door (Excel-like semantics live HERE, in Rust).
    ///
    /// - `raw` starting with `'='` parses as a formula (a [`ParseError`]
    ///   surfaces as `Err`).
    /// - Otherwise the typed-entry parser runs ([`sheet_format::entry`],
    ///   ruling `sheet.edit.typed-entry`): numbers (groups, `%`, currency,
    ///   fractions, scientific; 15 significant digits), dates and times as
    ///   serials, `TRUE`/`FALSE`, error literals, a leading `'` for text,
    ///   the empty string → [`CellValue::Empty`], anything else →
    ///   [`CellValue::Text`]. The workbook locale reads separators and date
    ///   order; the session clock completes a date typed without a year.
    ///
    /// The number format the text implies is NOT applied here (styles are
    /// the session's): callers that want it use [`Engine::parse_entry_at`].
    ///
    /// Commits the cell and recalcs the resulting dirty cut.
    ///
    /// [`ParseError`]: sheet_parser::ParseError
    pub fn enter(
        &mut self,
        sheet: SheetId,
        row: u32,
        col: u32,
        raw: &str,
    ) -> Result<RecalcResult, sheet_parser::ParseError> {
        let input = self.parse_input(sheet, raw)?;
        Ok(self.set_cell(sheet, row, col, input))
    }

    /// Parse raw cell text the way [`Engine::enter`] does — `'='` starts a
    /// formula, anything else is literal-detected — WITHOUT committing it.
    /// Bulk callers parse every input first, so a parse error rejects (or
    /// skips) a cell before anything in the batch is mutated, then commit
    /// the survivors with one [`Engine::set_cells`].
    pub fn parse_input(
        &self,
        sheet: SheetId,
        raw: &str,
    ) -> Result<SetInput, sheet_parser::ParseError> {
        Ok(if let Some(body) = raw.strip_prefix('=') {
            let ctx = ModelParseCtx {
                model: &self.model,
                current: sheet,
            };
            SetInput::Formula(sheet_parser::parse(body, &ctx)?)
        } else {
            SetInput::Value(self.typed(raw, "General").value)
        })
    }

    /// The typed-entry context of this engine: the workbook locale and date
    /// system, the session clock.
    pub fn entry_ctx(&self) -> EntryCtx {
        EntryCtx::new(
            self.model.calc.locale,
            self.model.calc.date_system,
            self.config.now_serial,
        )
    }

    fn typed(&self, raw: &str, current_fmt: &str) -> Entry {
        parse_entry_for_format(raw, current_fmt, &self.entry_ctx())
    }

    /// Parse raw cell text for the cell at `(sheet, row, col)` exactly as a
    /// person typing it there: a formula as [`Engine::parse_input`] does
    /// (unless the cell is Text-formatted, `@` — then everything, `=…`
    /// included, is stored verbatim, as Excel does), else the typed-entry
    /// value plus the number format it implies and the quote-prefix flag
    /// (ruling `sheet.edit.typed-entry`). Nothing is committed.
    pub fn parse_entry_at(
        &self,
        sheet: SheetId,
        row: u32,
        col: u32,
        raw: &str,
    ) -> Result<TypedInput, sheet_parser::ParseError> {
        let fmt = self
            .model
            .sheet(sheet)
            .and_then(|ws| ws.cell(row, col))
            .map(|c| self.model.styles.num_fmt_of(c.style))
            .unwrap_or("General");
        if raw.starts_with('=') && !is_text_format(fmt) {
            return Ok(TypedInput {
                input: self.parse_input(sheet, raw)?,
                hint: None,
                quote_prefix: false,
            });
        }
        let e = self.typed(raw, fmt);
        Ok(TypedInput {
            input: SetInput::Value(e.value),
            hint: e.hint,
            quote_prefix: e.quote_prefix,
        })
    }

    /// The structured cell-entry door. Commits the input, updates the graph
    /// and dirty set, then recalcs the dirty cut.
    pub fn set_cell(
        &mut self,
        sheet: SheetId,
        row: u32,
        col: u32,
        input: SetInput,
    ) -> RecalcResult {
        self.stage_cell(sheet, row, col, input);
        self.redirty_blocked_spills();
        self.recalc_if_automatic()
    }

    /// The batch door: commit every input in order (exactly as a sequence of
    /// [`Engine::set_cell`] calls would leave the model and graph), then run
    /// ONE recalc over the union of their dirty cuts. A formula read by many
    /// of the written cells evaluates once, not once per write — what sort,
    /// replace-all, paste and dataset seeding need. A later input for the
    /// same cell wins.
    pub fn set_cells(
        &mut self,
        inputs: impl IntoIterator<Item = (SheetId, u32, u32, SetInput)>,
    ) -> RecalcResult {
        for (sheet, row, col, input) in inputs {
            self.stage_cell(sheet, row, col, input);
        }
        self.redirty_blocked_spills();
        self.recalc_if_automatic()
    }

    /// After an edit: recalculate the dirty cut, unless the workbook
    /// calculates manually (`<calcPr calcMode="manual">`, sheet ADR 513) —
    /// then the edit only marks its dependents dirty and they wait for
    /// [`Engine::calculate_now`] / [`Engine::calculate_sheet`].
    fn recalc_if_automatic(&mut self) -> RecalcResult {
        let entered = std::mem::take(&mut self.entered);
        if self.model.calc.calc_mode != sheet_core::CalcMode::Manual {
            return self.recalc_dirty();
        }
        // Manual: as in Excel, a formula just entered is calculated (from
        // whatever its precedents hold); nothing else is.
        let mut changed = Vec::new();
        let _accel = accel::Scope::enter(&self.model, false);
        for cref in entered {
            if self.graph.is_formula(cref) {
                self.evaluate_in_order(cref, &mut changed);
                self.dirty.unmark(cref);
            }
        }
        changed.sort();
        changed.dedup();
        RecalcResult {
            changed,
            ..RecalcResult::default()
        }
    }

    /// Whether edits are waiting for a calculation (manual mode; in
    /// automatic mode this is false between edits).
    pub fn is_calc_pending(&self) -> bool {
        !self.dirty.is_empty()
    }

    /// Excel's Calculate Now (F9): recalculate every pending cell, and the
    /// volatile ones, in every sheet.
    pub fn calculate_now(&mut self) -> RecalcResult {
        self.recalc_dirty()
    }

    /// Excel's Calculate Sheet (Shift+F9): recalculate the pending cells of
    /// `sheet` (and the volatile ones); pending cells of other sheets stay
    /// pending.
    pub fn calculate_sheet(&mut self, sheet: SheetId) -> RecalcResult {
        let pending = self.dirty.drain_set();
        let mut later = Vec::new();
        for c in pending {
            if c.sheet == sheet {
                self.dirty.mark(c);
            } else {
                later.push(c);
            }
        }
        let r = self.recalc_dirty();
        for c in later {
            self.dirty.mark(c);
        }
        r
    }

    /// Set the calculation mode (`<calcPr calcMode>`, written back on save).
    /// Switching to an automatic mode calculates what is pending.
    /// `AutoNoTable` calculates like `Auto`: the engine has no data tables.
    pub fn set_calc_mode(&mut self, mode: sheet_core::CalcMode) -> RecalcResult {
        self.model.calc.calc_mode = mode;
        self.recalc_if_automatic()
    }

    /// Set precision as displayed (`<calcPr fullPrecision>`): with `false`
    /// a constant entered is stored rounded to its number format (the
    /// rounding is the session's, which knows the formats).
    pub fn set_full_precision(&mut self, full: bool) {
        self.model.calc.full_precision = full;
    }

    /// Commit one input to the model, graph and dirty set — no recalc.
    fn stage_cell(&mut self, sheet: SheetId, row: u32, col: u32, input: SetInput) {
        let cref = CellRef {
            sheet,
            row,
            col,
            row_abs: false,
            col_abs: false,
        };
        self.ensure_sheet(sheet);

        // Spill bookkeeping (spec §6.4). If this cell IS a live spill anchor,
        // release its region first (a user edit replaces the anchor entirely;
        // a clear must not leave the old spilled cells behind). If this cell is
        // an interior (non-anchor) spilled cell, dirty its owning anchor so the
        // anchor re-evaluates and surfaces `#SPILL!` for the now-blocked region.
        if self.spills.region_of(cref).is_some() {
            let mut sink: Vec<CellRef> = Vec::new();
            self.clear_spill_region(cref, &mut sink);
        } else if let Some(anchor) = self.spills.owner_of(cref) {
            self.dirty.mark(anchor);
            self.dirty.propagate_from(anchor, &self.graph);
        }

        // Drop any prior formula registration for this cell. A new input on a
        // legacy array-formula anchor replaces the array formula too.
        self.graph.unregister(cref);
        self.dirty.forget(cref);
        if let Some(ws) = self.model.sheet_mut(sheet) {
            ws.array_formulas.remove(&(row, col));
            ws.dynamic_arrays.remove(&(row, col));
        }

        match input {
            SetInput::Empty => {
                if let Some(ws) = self.model.sheet_mut(sheet) {
                    ws.remove_cell(row, col);
                }
            }
            SetInput::Value(v) => {
                let style = self.style_of(cref);
                if let Some(ws) = self.model.sheet_mut(sheet) {
                    ws.set_cell(
                        row,
                        col,
                        Cell {
                            value: v,
                            formula: None,
                            style,
                        },
                    );
                }
            }
            SetInput::Formula(f) => {
                let refs = names::refs_with_names(&self.model, &f, cref);
                let volatile = refs.has_volatile;
                // A formula entered here is a dynamic-array formula, as in
                // Excel 365: one that can produce an array spills by its
                // result's shape (sheet ADR 513).
                let dynamic = eval::root_may_spill(&self.model, &f.root);
                let fid = self.model.intern_formula(f);
                let style = self.style_of(cref);
                if let Some(ws) = self.model.sheet_mut(sheet) {
                    ws.set_cell(
                        row,
                        col,
                        Cell {
                            value: CellValue::Empty,
                            formula: Some(fid),
                            style,
                        },
                    );
                }
                if dynamic {
                    if let Some(ws) = self.model.sheet_mut(sheet) {
                        ws.dynamic_arrays.insert((row, col));
                    }
                }
                self.graph.register(cref, &refs, &self.model);
                self.dirty.set_volatile(cref, volatile);
                self.entered.push(cref);
                // The formula cell itself is dirty.
                self.dirty.mark(cref);
            }
        }

        // A write at this cell dirties its transitive dependents.
        self.dirty.propagate_from(cref, &self.graph);
    }

    /// Any blocked spill anchor re-evaluates: removing/altering a cell may
    /// free its rectangle so it can finally spill
    /// (`sheet.calc.spill.collision`).
    fn redirty_blocked_spills(&mut self) {
        for blocked in self.spills.blocked_sorted() {
            if self.graph.is_formula(blocked) {
                self.dirty.mark(blocked);
            } else {
                // No longer a formula — drop it from the blocked set.
                self.spills.unmark_blocked(blocked);
            }
        }
    }

    /// Recalculate EVERY formula cell (marks all dirty, then runs a pass).
    pub fn recalc_all(&mut self) -> RecalcResult {
        self.dirty.mark_all(&self.graph);
        self.recalc_dirty()
    }

    /// Recalculate the current dirty cut (volatiles reseeded). The heart of
    /// the engine.
    ///
    /// ## Spill re-passes (spec §6.4)
    ///
    /// Materializing a spill writes engine-owned cells into the model and dirties
    /// their dependents (a formula reading the spill range/`A1#` must reflow).
    /// Those dependents were not in the pass's initial topo order, so after the
    /// main drain we re-run while new cells remain dirty — a bounded fixpoint
    /// (capped so a pathological spill chain cannot loop forever). Cycle
    /// reporting from the FIRST pass is the authoritative `circular` set.
    pub fn recalc_dirty(&mut self) -> RecalcResult {
        let mut changed: Vec<CellRef> = Vec::new();
        let mut circular: Vec<CellRef> = Vec::new();
        let mut non_converged: Vec<CellRef> = Vec::new();

        // Volatile cells reseed ONCE per recalc (not per spill sub-pass — that
        // would keep the fixpoint alive forever whenever any volatile exists).
        self.dirty.reseed_volatile(&self.graph);
        perf_count!(recalcs, 1);
        // Column snapshots and their indexes live for this recalc only; every
        // write below keeps them exact (`accel::note_write`).
        let _accel = accel::Scope::enter(&self.model, self.accelerate);

        // Bounded fixpoint: each iteration drains the current dirty cut; spill
        // materialization writes engine-owned cells and dirties their
        // dependents, which the next iteration drains. Capped so a pathological
        // spill chain cannot loop forever.
        const MAX_PASSES: u32 = 64;
        for pass_n in 0..MAX_PASSES {
            let cut = self.dirty.drain_set();
            if cut.is_empty() {
                break;
            }
            self.pass = self.pass.wrapping_add(1);
            perf_count!(recalc_passes, 1);

            let to = topo::order(&cut, &self.graph);

            // Evaluate the orderable cells in dependency order; each write is
            // immediately visible to later cells (topo guarantees freshness).
            // A cell whose formula ROOT spills (a `returns_array` call or an
            // array literal) takes the spill path: clear its prior region,
            // evaluate rich, materialize the 2-D block (or `#SPILL!` on
            // collision). Every other cell stays on the scalar path.
            for cref in &to.order {
                self.evaluate_in_order(*cref, &mut changed);
            }

            // Cycle members. Two policies (registry `sheet.calc.iterative.*`,
            // D-7): with iteration OFF (default) store #REF! (the wire encoding
            // of the Circular diagnostic) and report on `circular`; with
            // iteration ON, drive the convergence loop to a fixed point and
            // report only the non-converged remainder. The first pass's cycle
            // set is the authoritative one (later passes only chase spill reflow).
            if self.model.calc.iterative {
                let (nc_changed, nc) = self.iterate_cycle(&to.cycle);
                changed.extend(nc_changed);
                if pass_n == 0 {
                    non_converged = nc;
                }
            } else {
                // Excel with iteration off: a cycle member is not calculated
                // — it keeps its last value, and one never calculated shows 0
                // (sheet ADR 514). The cycle is reported on `circular`.
                for cref in &to.cycle {
                    if self.stored_value(*cref) == CellValue::Empty
                        && self.commit_value(*cref, CellValue::Number(0.0))
                    {
                        changed.push(*cref);
                    }
                }
                if pass_n == 0 {
                    circular = to.cycle;
                }
            }
            // Cells downstream of a cycle read its settled values.
            for cref in &to.after {
                self.evaluate_in_order(*cref, &mut changed);
            }
        }

        self.dirty.clear();

        // Dedup + stabilize the changed set (a cell may be touched across
        // passes — clear then refill, or anchor then reflow).
        changed.sort();
        changed.dedup();
        RecalcResult {
            changed,
            circular,
            non_converged,
        }
    }

    /// Apply a structural edit (insert/delete rows or cols): physically shift
    /// the cells, column widths, row heights, and merges; rewrite every
    /// formula's references (`sheet_parser::rewrite`, `#REF!` for deleted
    /// spans); rebuild the dependency graph; then recalc everything.
    pub fn apply_edit(&mut self, edit: &Edit) -> RecalcResult {
        // Spill ledger (spec §6.4): clear every live spill region from the model
        // BEFORE the structural shift, so no stale engine-owned spilled cells get
        // physically moved (they would become spurious blockers). The anchors are
        // formulas — they survive the edit and re-materialize on the recalc below.
        let mut sink: Vec<CellRef> = Vec::new();
        for anchor in self.spills.anchors_sorted() {
            self.clear_spill_region(anchor, &mut sink);
        }
        self.spills.clear();

        self.apply_edit_structural(edit);
        self.rewrite_all_formulas(edit);
        // Rebuild the graph + dirty set from the mutated model.
        self.graph.rebuild(&self.model);
        self.dirty = Dirty::new();
        self.dirty.mark_all(&self.graph);
        seed_volatility(&self.model, &self.graph, &mut self.dirty);
        self.recalc_dirty()
    }

    // ---- internals ----

    /// Evaluate one ordered cell: the spill path for a spilling root, the
    /// scalar path otherwise (a former anchor releases its old region).
    fn evaluate_in_order(&mut self, cref: CellRef, changed: &mut Vec<CellRef>) {
        // One cell lookup decides the path and feeds the evaluation.
        let fid = self.formula_id(cref);
        if fid.is_some_and(|f| self.formula_spills(cref, f)) {
            self.recompute_spill_anchor(cref, changed);
        } else {
            // A non-spilling formula that USED to be a spill anchor must
            // release its old region (e.g. edited from SEQUENCE to a scalar
            // formula).
            self.clear_spill_region(cref, changed);
            let new_value = match fid {
                Some(f) => self.evaluate_formula(cref, f),
                None => self.evaluate_cell(cref),
            };
            if self.commit_value(cref, new_value) {
                changed.push(cref);
            }
        }
    }

    /// The formula id stored at `cref`, if it holds a formula.
    fn formula_id(&self, cref: CellRef) -> Option<sheet_core::FormulaId> {
        self.model
            .sheet(cref.sheet)?
            .cell(cref.row, cref.col)?
            .formula
    }

    /// Evaluate a single formula cell's expression (a literal cell evaluates
    /// to its stored value — it is never in the dirty cut as a formula, but
    /// stay total).
    fn evaluate_cell(&self, cref: CellRef) -> CellValue {
        let Some(ws) = self.model.sheet(cref.sheet) else {
            return CellValue::Empty;
        };
        let Some(cell) = ws.cell(cref.row, cref.col) else {
            return CellValue::Empty;
        };
        let Some(fid) = cell.formula else {
            return cell.value.clone();
        };
        self.evaluate_formula(cref, fid)
    }

    /// Evaluate the formula `fid` stored at `cref`.
    fn evaluate_formula(&self, cref: CellRef, fid: sheet_core::FormulaId) -> CellValue {
        let Some(f) = self.model.formula(fid) else {
            return CellValue::Error(CellError::Ref);
        };
        if let Some(v) = self.kept_cached_value(cref, &f.root) {
            return v;
        }
        let seed = volatile::cell_seed(self.config.rng_seed, self.pass, cref);
        let ctx = eval::ctx_for(&self.model, cref, self.config.now_serial, seed);
        perf_count!(evaluations, 1);
        if self.array_area(cref).is_some() {
            // A one-cell legacy array formula: evaluated element-wise, the
            // cell shows the block's top-left (Excel's CSE rule).
            return match eval::eval_array(&self.model, &f.root, &ctx, &self.spills) {
                FnResult::Scalar(v) => v,
                FnResult::Array(g) => g
                    .into_iter()
                    .next()
                    .and_then(|r| r.into_iter().next())
                    .unwrap_or(CellValue::Empty),
            }
            .into_shown();
        }
        // Not marked dynamic: a legacy formula (or one whose root cannot
        // produce an array, where the two read the same).
        eval::with_legacy(true, || {
            eval::eval_root(&self.model, &f.root, &ctx, &self.spills)
        })
        .into_shown()
    }

    /// The value a formula this engine cannot compute keeps
    /// ([`eval::keeps_cached_value`]): the cell's stored value, when it has
    /// one. `None` = evaluate.
    fn kept_cached_value(&self, cref: CellRef, root: &sheet_core::Expr) -> Option<CellValue> {
        if !eval::keeps_cached_value(root) {
            return None;
        }
        let v = self.stored_value(cref);
        (v != CellValue::Empty).then_some(v)
    }

    /// The `(rows, cols)` area of the legacy array formula anchored at
    /// `cref`, if it is one.
    fn array_area(&self, cref: CellRef) -> Option<(u32, u32)> {
        self.model
            .sheet(cref.sheet)?
            .array_formulas
            .get(&(cref.row, cref.col))
            .copied()
    }

    /// Drive iterative (circular) calculation over one cycle (spec §6.2, D-7;
    /// registry `sheet.calc.iterative.*`). `members` is the cycle set from
    /// [`topo::order`]; it is sorted here so the evaluation order — and thus the
    /// converged values — are reproducible run-to-run (the §6.2 determinism
    /// property).
    ///
    /// Algorithm (Excel-style): seed every member at `0`, then for up to
    /// `model.calc.max_iter` passes recompute each member in sorted order,
    /// committing immediately (Gauss–Seidel — a later member in the same pass
    /// reads the freshly written value of an earlier one). Stop early when the
    /// largest per-cell change ([`iterate::cell_delta`]) across the whole cycle
    /// is `<= model.calc.max_change`.
    ///
    /// Returns `(changed, non_converged)`: the members whose stored value
    /// differs from before the loop, and (empty on convergence) the members
    /// still in the cycle if `max_iter` ran out — their last-iterate values are
    /// kept in the model (matching Excel, which leaves the partial result).
    fn iterate_cycle(&mut self, members: &[CellRef]) -> (Vec<CellRef>, Vec<CellRef>) {
        let mut ordered: Vec<CellRef> = members.to_vec();
        ordered.sort();

        let max_iter = self.model.calc.max_iter;
        let max_change = self.model.calc.max_change;

        // Snapshot the pre-iteration stored values so we can report which cells
        // actually changed (a cell already at its fixed point may not move).
        let before: Vec<CellValue> = ordered.iter().map(|c| self.stored_value(*c)).collect();

        // Seed every cycle cell at 0 (Excel's documented initial value) so the
        // first pass reads a defined precedent rather than the stale value
        // (#REF!, or a prior unrelated result).
        for &m in &ordered {
            self.commit_value(m, CellValue::Number(0.0));
        }

        let mut converged = ordered.is_empty();
        for _ in 0..max_iter {
            let mut max_delta = 0.0_f64;
            for &m in &ordered {
                let old = self.stored_value(m);
                let new = self.evaluate_cell(m);
                let delta = iterate::cell_delta(&old, &new);
                if delta > max_delta {
                    max_delta = delta;
                }
                self.commit_value(m, new);
            }
            if max_delta <= max_change {
                converged = true;
                break;
            }
        }

        // Report changes against the PRE-iteration snapshot.
        let mut changed: Vec<CellRef> = Vec::new();
        for (m, prev) in ordered.iter().zip(before.iter()) {
            if self.stored_value(*m) != *prev {
                changed.push(*m);
            }
        }

        let non_converged = if converged { Vec::new() } else { ordered };
        (changed, non_converged)
    }

    /// The currently stored value of a cell (defaulting to `Empty`), used by the
    /// iterative loop to snapshot precedents and measure convergence deltas.
    fn stored_value(&self, cref: CellRef) -> CellValue {
        self.model
            .sheet(cref.sheet)
            .and_then(|ws| ws.cell(cref.row, cref.col))
            .map(|c| c.value.clone())
            .unwrap_or(CellValue::Empty)
    }

    /// Whether the formula at `cref` has a *spilling* root (a `returns_array`
    /// function call or an array literal — the T1 ruling
    /// `sheet.calc.spill.materialize`). A literal/non-formula cell never spills.
    /// `cref` is known to hold the formula `fid`.
    fn formula_spills(&self, cref: CellRef, fid: sheet_core::FormulaId) -> bool {
        let Some(ws) = self.model.sheet(cref.sheet) else {
            return false;
        };
        // A legacy array formula over more than one cell fills its area
        // through the spill machinery; over one cell it is a scalar.
        if let Some((rows, cols)) = self.array_area(cref) {
            return rows * cols > 1;
        }
        // A dynamic array from a workbook spills whatever its root is.
        if ws.dynamic_arrays.contains(&(cref.row, cref.col)) {
            return true;
        }
        self.model
            .formula(fid)
            .map(|f| eval::expr_spills(&f.root))
            .unwrap_or(false)
    }

    /// Recompute a spill anchor (spec §6.4): clear its prior region, evaluate
    /// the formula through the rich (array) door, then materialize the result.
    /// A `FnResult::Scalar` (the kernel grounded to an error, or a 1×1 array)
    /// commits a single value; a `FnResult::Array` materializes the rectangle
    /// (or stores `#SPILL!` and claims no region on a collision). Cells whose
    /// stored value changes are pushed onto `changed`.
    fn recompute_spill_anchor(&mut self, anchor: CellRef, changed: &mut Vec<CellRef>) {
        // 1. Release the prior region so a shrinking array leaves no stale cells.
        self.clear_spill_region(anchor, changed);

        // 2. Evaluate through the rich door.
        let result = self.evaluate_cell_rich(anchor);
        match result {
            FnResult::Scalar(v) => {
                if self.commit_value(anchor, v) {
                    changed.push(anchor);
                }
            }
            FnResult::Array(grid) => {
                self.materialize_spill(anchor, grid, changed);
            }
        }
    }

    /// Evaluate a formula cell through the rich (array) door, returning the
    /// [`FnResult`]. Mirrors [`Engine::evaluate_cell`] but keeps array blocks.
    fn evaluate_cell_rich(&self, cref: CellRef) -> FnResult {
        let Some(ws) = self.model.sheet(cref.sheet) else {
            return FnResult::Scalar(CellValue::Empty);
        };
        let Some(cell) = ws.cell(cref.row, cref.col) else {
            return FnResult::Scalar(CellValue::Empty);
        };
        let Some(fid) = cell.formula else {
            return FnResult::Scalar(cell.value.clone());
        };
        let Some(f) = self.model.formula(fid) else {
            return FnResult::Scalar(CellValue::Error(CellError::Ref));
        };
        if let Some(v) = self.kept_cached_value(cref, &f.root) {
            return FnResult::Scalar(v);
        }
        let seed = volatile::cell_seed(self.config.rng_seed, self.pass, cref);
        let ctx = eval::ctx_for(&self.model, cref, self.config.now_serial, seed);
        perf_count!(evaluations, 1);
        if let Some((rows, cols)) = self.array_area(cref) {
            let r = eval::eval_array(&self.model, &f.root, &ctx, &self.spills);
            return shown_result(FnResult::Array(fit_to_area(r, rows, cols)));
        }
        // A dynamic array (`H1:H6*2` stored with the dynamic-array marker)
        // evaluates as an array and spills its natural size, as in Excel.
        if ws.dynamic_arrays.contains(&(cref.row, cref.col)) {
            return shown_result(eval::eval_root_array(
                &self.model,
                &f.root,
                &ctx,
                &self.spills,
            ));
        }
        shown_result(eval::eval_expr_rich(
            &self.model,
            &f.root,
            &ctx,
            &self.spills,
        ))
    }

    /// Materialize a `rows × cols` array block anchored at `anchor` (spec §6.4).
    /// Tests the target rectangle for a collision first: every non-anchor cell
    /// must be blank OR already owned by THIS anchor. A blocker → store
    /// `#SPILL!` at the anchor and claim no region (`sheet.calc.spill.collision`).
    /// Otherwise write the top-left into the anchor and the rest as engine-owned
    /// spilled value cells, and record the region in the ledger.
    fn materialize_spill(
        &mut self,
        anchor: CellRef,
        grid: Vec<Vec<CellValue>>,
        changed: &mut Vec<CellRef>,
    ) {
        let rows = grid.len() as u32;
        let cols = grid.first().map(|r| r.len()).unwrap_or(0) as u32;
        // An empty array is Excel's #CALC! (kernels return it themselves;
        // this catches an empty block from anywhere else).
        if rows == 0 || cols == 0 {
            if self.commit_value(anchor, CellValue::Error(CellError::Calc)) {
                changed.push(anchor);
            }
            return;
        }
        let rect = SpillRect::for_array(anchor, rows, cols);

        // Collision test: every cell of the rect EXCEPT the anchor must be free
        // (blank or already owned by this anchor — the latter cannot happen now
        // since we cleared the region, but stays defensive).
        for c in rect.cells() {
            if c == anchor {
                continue;
            }
            if self.cell_is_blocker(c, anchor) {
                // Blocked — store #SPILL! at the anchor, claim no region, and
                // remember it so removing the blocker re-triggers the spill.
                self.spills.mark_blocked(anchor);
                if self.commit_value(anchor, CellValue::Error(CellError::Spill)) {
                    changed.push(anchor);
                }
                return;
            }
        }

        // Free — this anchor is no longer blocked.
        self.spills.unmark_blocked(anchor);

        // Free — write the block. The anchor keeps its formula; the spilled
        // cells are plain value cells (engine-owned, recorded in the ledger).
        for (r, row) in grid.into_iter().enumerate() {
            for (c, value) in row.into_iter().enumerate() {
                let cell = CellRef {
                    sheet: anchor.sheet,
                    row: anchor.row + r as u32,
                    col: anchor.col + c as u32,
                    row_abs: false,
                    col_abs: false,
                };
                if cell == anchor {
                    if self.commit_value(anchor, value) {
                        changed.push(anchor);
                    }
                } else {
                    self.write_spilled_cell(cell, value, changed);
                }
            }
        }

        // Record the region and dirty any dependents of the freshly written
        // spilled cells (a formula reading the spill range reflows).
        self.spills.insert(rect);
        for c in rect.cells() {
            self.dirty.propagate_from(c, &self.graph);
        }
    }

    /// Whether `cell` blocks a spill anchored at `anchor`: it holds a non-empty
    /// value or a formula AND is not already owned by `anchor`. A blank cell, or
    /// a cell this anchor owns, is not a blocker.
    fn cell_is_blocker(&self, cell: CellRef, anchor: CellRef) -> bool {
        if self.spills.owner_of(cell) == Some(anchor) {
            return false;
        }
        match self
            .model
            .sheet(cell.sheet)
            .and_then(|ws| ws.cell(cell.row, cell.col))
        {
            Some(c) => c.formula.is_some() || c.value != CellValue::Empty,
            None => false,
        }
    }

    /// Write an engine-owned spilled value cell (no formula, preserving any
    /// existing style). Pushes onto `changed` if the stored value changed.
    fn write_spilled_cell(&mut self, cell: CellRef, value: CellValue, changed: &mut Vec<CellRef>) {
        let style = self.style_of(cell);
        let Some(ws) = self.model.sheet_mut(cell.sheet) else {
            return;
        };
        let prior = ws.cell(cell.row, cell.col).map(|c| c.value.clone());
        if prior.as_ref() == Some(&value) {
            return;
        }
        accel::note_write(cell, &value);
        ws.set_cell(
            cell.row,
            cell.col,
            Cell {
                value,
                formula: None,
                style,
            },
        );
        changed.push(cell);
    }

    /// Clear `anchor`'s spill region from the model + ledger (if it owns one):
    /// every spilled NON-anchor cell becomes blank, and dependents of those
    /// cleared cells are dirtied so they recompute. The anchor cell itself is
    /// left for the recompute to overwrite. No-op if `anchor` owns no region.
    fn clear_spill_region(&mut self, anchor: CellRef, changed: &mut Vec<CellRef>) {
        let Some(rect) = self.spills.remove(anchor) else {
            return;
        };
        for c in rect.cells() {
            if c == anchor {
                continue;
            }
            if let Some(ws) = self.model.sheet_mut(c.sheet) {
                if ws.cell(c.row, c.col).is_some() {
                    accel::note_write(c, &CellValue::Empty);
                    ws.remove_cell(c.row, c.col);
                    changed.push(c);
                }
            }
            // Anything that read the now-blank cell must recompute.
            self.dirty.propagate_from(c, &self.graph);
        }
    }

    /// Write a computed value into the cell, returning whether it changed.
    fn commit_value(&mut self, cref: CellRef, value: CellValue) -> bool {
        let Some(ws) = self.model.sheet_mut(cref.sheet) else {
            return false;
        };
        // One tree descent: compare and overwrite the value in place.
        match ws.cells.get_mut(&(cref.row, cref.col)) {
            Some(existing) => {
                if existing.value == value {
                    return false;
                }
                accel::note_write(cref, &value);
                existing.value = value;
                true
            }
            None => {
                accel::note_write(cref, &value);
                // A cycle/eval result for a cell that lost its record — store a
                // bare value cell (rare; keeps the engine total).
                ws.set_cell(
                    cref.row,
                    cref.col,
                    Cell {
                        value,
                        ..Default::default()
                    },
                );
                true
            }
        }
    }

    /// The current style id of a cell (preserved across re-entry), defaulting
    /// to `StyleId(0)`.
    fn style_of(&self, cref: CellRef) -> sheet_core::StyleId {
        self.model
            .sheet(cref.sheet)
            .and_then(|ws| ws.cell(cref.row, cref.col))
            .map(|c| c.style)
            .unwrap_or_default()
    }

    /// Ensure the target sheet exists (auto-create up to `sheet` so a write to
    /// a fresh single-sheet engine just works).
    fn ensure_sheet(&mut self, sheet: SheetId) {
        while (self.model.sheets.len() as u32) <= sheet as u32 {
            let n = self.model.sheets.len();
            self.model.add_sheet(format!("Sheet{}", n + 1));
        }
    }

    /// Physically shift the cell grid, col widths, row heights, and merges for
    /// a structural edit on its sheet.
    fn apply_edit_structural(&mut self, edit: &Edit) {
        let (sheet, axis, kind, at, n) = decompose(edit);
        let Some(ws) = self.model.sheet_mut(sheet) else {
            return;
        };

        // Shift cells.
        let old_cells = std::mem::take(&mut ws.cells);
        for ((row, col), cell) in old_cells {
            let coord = if axis == EditAxis::Row { row } else { col };
            match shift_coord(coord, kind, at, n) {
                Some(nc) => {
                    let (nr, ncc) = if axis == EditAxis::Row {
                        (nc, col)
                    } else {
                        (row, nc)
                    };
                    ws.cells.insert((nr, ncc), cell);
                }
                None => { /* deleted — drop the cell */ }
            }
        }

        // Shift the sizing maps (col_widths keyed by col, row_heights by row).
        match axis {
            EditAxis::Row => {
                ws.row_heights = shift_map(std::mem::take(&mut ws.row_heights), kind, at, n);
            }
            EditAxis::Col => {
                ws.col_widths = shift_map(std::mem::take(&mut ws.col_widths), kind, at, n);
            }
        }

        // Shift legacy array-formula anchors with their cells (an anchor
        // whose row/column is deleted goes with it).
        let old_arrays = std::mem::take(&mut ws.array_formulas);
        for ((row, col), area) in old_arrays {
            let coord = if axis == EditAxis::Row { row } else { col };
            if let Some(nc) = shift_coord(coord, kind, at, n) {
                let key = if axis == EditAxis::Row {
                    (nc, col)
                } else {
                    (row, nc)
                };
                ws.array_formulas.insert(key, area);
            }
        }
        // …and the dynamic-array marks with them.
        let old_dynamic = std::mem::take(&mut ws.dynamic_arrays);
        for (row, col) in old_dynamic {
            let coord = if axis == EditAxis::Row { row } else { col };
            if let Some(nc) = shift_coord(coord, kind, at, n) {
                ws.dynamic_arrays.insert(if axis == EditAxis::Row {
                    (nc, col)
                } else {
                    (row, nc)
                });
            }
        }

        // Shift merges (drop any that collapse).
        let old_merges = std::mem::take(&mut ws.merges);
        for m in old_merges {
            if let Some(nm) = shift_merge(m, axis, kind, at, n) {
                ws.merges.push(nm);
            }
        }

        // Row and column attributes go with their rows/columns (W1.2).
        match axis {
            EditAxis::Row => {
                ws.hidden_rows = std::mem::take(&mut ws.hidden_rows)
                    .into_iter()
                    .filter_map(|r| shift_coord(r, kind, at, n))
                    .collect();
                ws.row_meta = std::mem::take(&mut ws.row_meta)
                    .into_iter()
                    .filter_map(|(r, m)| shift_coord(r, kind, at, n).map(|r| (r, m)))
                    .collect();
            }
            EditAxis::Col => {
                ws.col_meta = std::mem::take(&mut ws.col_meta)
                    .into_iter()
                    .filter_map(|mut m| {
                        let (a, b) = shift_span(m.min, m.max, kind, at, n)?;
                        m.min = a;
                        m.max = b.min(sheet_core::MAX_COL);
                        Some(m)
                    })
                    .collect();
            }
        }

        // Tables move and grow with the edit; a column inserted inside one
        // becomes a `ColumnN` column with its header cell written, as Excel
        // does. A table the edit deletes whole goes.
        let mut headers: Vec<(u32, u32, _)> = Vec::new();
        ws.tables = std::mem::take(&mut ws.tables)
            .into_iter()
            .filter_map(|mut t| {
                let sh = sheet_parser::shift_table(t.range, &t.columns, edit);
                let range = sh.range?;
                for off in sh.removed.iter().rev() {
                    if (*off as usize) < t.columns.len() {
                        t.columns.remove(*off as usize);
                    }
                }
                for (off, name) in &sh.inserted {
                    let i = (*off as usize).min(t.columns.len());
                    t.columns.insert(i, name.clone());
                    if t.header_row {
                        let r = range.normalized();
                        headers.push((r.start.row, r.start.col + off, name.clone()));
                    }
                }
                t.range = range;
                Some(t)
            })
            .collect();
        for (r, c, name) in headers {
            ws.cells.insert(
                (r, c),
                sheet_core::Cell {
                    value: CellValue::Text(name),
                    formula: None,
                    style: ws
                        .cells
                        .get(&(r, c.saturating_sub(1)))
                        .map(|c| c.style)
                        .unwrap_or_default(),
                },
            );
        }

        // Filter views follow their range; a column criterion follows its
        // column (and goes with it).
        ws.filters = std::mem::take(&mut ws.filters)
            .into_iter()
            .filter_map(|mut f| {
                let old = f.range.normalized();
                let new = sheet_parser::shift_range_ref(old, edit)?;
                if axis == EditAxis::Col {
                    f.columns = std::mem::take(&mut f.columns)
                        .into_iter()
                        .filter_map(|mut cf| {
                            let c = shift_coord(old.start.col + cf.col, kind, at, n)?;
                            cf.col = c.checked_sub(new.start.col)?;
                            Some(cf)
                        })
                        .collect();
                }
                f.range = new;
                Some(f)
            })
            .collect();
    }

    /// Rewrite every formula in the model for the structural edit. Re-interns
    /// the rewritten formula and repoints the cell's `FormulaId`.
    fn rewrite_all_formulas(&mut self, edit: &Edit) {
        // Collect (cref, old_fid) for every formula cell.
        let mut targets: Vec<(CellRef, sheet_core::FormulaId)> = Vec::new();
        for (sheet_idx, ws) in self.model.sheets.iter().enumerate() {
            for (&(row, col), cell) in ws.iter_cells() {
                if let Some(fid) = cell.formula {
                    targets.push((
                        CellRef {
                            sheet: sheet_idx as SheetId,
                            row,
                            col,
                            row_abs: false,
                            col_abs: false,
                        },
                        fid,
                    ));
                }
            }
        }
        for (cref, fid) in targets {
            let Some(old) = self.model.formula(fid).cloned() else {
                continue;
            };
            let rewritten = sheet_parser::rewrite(&old, edit);
            let new_fid = self.model.intern_formula(rewritten);
            if let Some(ws) = self.model.sheet_mut(cref.sheet) {
                if let Some(existing) = ws.cell(cref.row, cref.col) {
                    let mut updated = existing.clone();
                    updated.formula = Some(new_fid);
                    ws.set_cell(cref.row, cref.col, updated);
                }
            }
        }
    }
}

/// Shape an array-formula result to its fixed `rows × cols` area (Excel's
/// legacy array rule): a scalar fills every cell; a one-row or one-column
/// block repeats along that axis; positions past a larger block's edge are
/// `#N/A`; a bigger block is clipped.
fn fit_to_area(r: FnResult, rows: u32, cols: u32) -> Vec<Vec<CellValue>> {
    let g = match r {
        FnResult::Scalar(v) => vec![vec![v]],
        FnResult::Array(g) => g,
    };
    let (gr, gc) = (g.len(), g.first().map_or(0, Vec::len));
    (0..rows as usize)
        .map(|i| {
            (0..cols as usize)
                .map(|j| {
                    let ii = if gr == 1 { 0 } else { i };
                    let jj = if gc == 1 { 0 } else { j };
                    g.get(ii)
                        .and_then(|row| row.get(jj))
                        .cloned()
                        .unwrap_or(CellValue::Error(CellError::Na))
                })
                .collect()
        })
        .collect()
}

/// Seed the dirty tracker's volatile set from each formula's extracted refs.
fn seed_volatility(model: &SheetModel, graph: &DepGraph, dirty: &mut Dirty) {
    for cref in graph.formula_cells_sorted() {
        if let Some(ws) = model.sheet(cref.sheet) {
            if let Some(cell) = ws.cell(cref.row, cref.col) {
                if let Some(fid) = cell.formula {
                    if let Some(f) = model.formula(fid) {
                        let refs = names::refs_with_names(model, f, cref);
                        dirty.set_volatile(cref, refs.has_volatile);
                    }
                }
            }
        }
    }
}

// ---- structural-edit geometry helpers ----

#[derive(Copy, Clone, PartialEq, Eq)]
enum EditAxis {
    Row,
    Col,
}

#[derive(Copy, Clone, PartialEq, Eq)]
enum EditKind {
    Insert,
    Delete,
}

/// Pull the `(sheet, axis, kind, at, n)` tuple out of an [`Edit`].
fn decompose(edit: &Edit) -> (SheetId, EditAxis, EditKind, u32, u32) {
    match *edit {
        Edit::InsertRows { sheet, at, n } => (sheet, EditAxis::Row, EditKind::Insert, at, n),
        Edit::DeleteRows { sheet, at, n } => (sheet, EditAxis::Row, EditKind::Delete, at, n),
        Edit::InsertCols { sheet, at, n } => (sheet, EditAxis::Col, EditKind::Insert, at, n),
        Edit::DeleteCols { sheet, at, n } => (sheet, EditAxis::Col, EditKind::Delete, at, n),
    }
}

/// Shift one coordinate physically (the data analogue of the parser's
/// reference shift). `None` = the row/col was deleted.
fn shift_coord(c: u32, kind: EditKind, at: u32, n: u32) -> Option<u32> {
    match kind {
        EditKind::Insert => {
            if c >= at {
                let nc = c as u64 + n as u64;
                let max = sheet_core::MAX_ROW.max(sheet_core::MAX_COL) as u64;
                if nc > max {
                    None
                } else {
                    Some(nc as u32)
                }
            } else {
                Some(c)
            }
        }
        EditKind::Delete => {
            let end = at as u64 + n as u64;
            if (c as u64) < at as u64 {
                Some(c)
            } else if (c as u64) < end {
                None
            } else {
                Some((c as u64 - n as u64) as u32)
            }
        }
    }
}

/// Shift a `BTreeMap<u32, f64>` (col widths or row heights) by a structural
/// edit on its own axis. Deleted keys are dropped.
fn shift_map(
    map: std::collections::BTreeMap<u32, f64>,
    kind: EditKind,
    at: u32,
    n: u32,
) -> std::collections::BTreeMap<u32, f64> {
    let mut out = std::collections::BTreeMap::new();
    for (k, v) in map {
        if let Some(nk) = shift_coord(k, kind, at, n) {
            out.insert(nk, v);
        }
    }
    out
}

/// Shift an inclusive span `min..=max` on the edit's axis: an insert inside
/// grows it, a delete clips it; `None` when it is deleted whole.
fn shift_span(min: u32, max: u32, kind: EditKind, at: u32, n: u32) -> Option<(u32, u32)> {
    match kind {
        EditKind::Insert => {
            let a = if min >= at {
                shift_coord(min, kind, at, n)?
            } else {
                min
            };
            let b = if max >= at {
                shift_coord(max, kind, at, n)?
            } else {
                max
            };
            Some((a, b))
        }
        EditKind::Delete => {
            let end = at as u64 + n as u64;
            if (min as u64) >= at as u64 && (max as u64) < end {
                return None;
            }
            let a = if min < at {
                min
            } else if (min as u64) < end {
                at
            } else {
                min - n
            };
            let b = if max < at {
                max
            } else if (max as u64) < end {
                at.saturating_sub(1)
            } else {
                max - n
            };
            Some((a, b))
        }
    }
}

/// Shift a merge box along `axis`; `None` if it fully collapses (both
/// endpoints deleted).
fn shift_merge(
    m: sheet_core::RangeRef,
    axis: EditAxis,
    kind: EditKind,
    at: u32,
    n: u32,
) -> Option<sheet_core::RangeRef> {
    let norm = m.normalized();
    let (s, e) = match axis {
        EditAxis::Row => (norm.start.row, norm.end.row),
        EditAxis::Col => (norm.start.col, norm.end.col),
    };

    // Reuse the parser's range-shift semantics: clip to the survivor.
    let (ns, ne) = match kind {
        EditKind::Insert => match (shift_coord(s, kind, at, n), shift_coord(e, kind, at, n)) {
            (Some(a), Some(b)) => (a, b),
            _ => return None,
        },
        EditKind::Delete => {
            let span_end = at as u64 + n as u64;
            if (s as u64) >= at as u64 && (e as u64) < span_end {
                return None; // fully inside the deleted span
            }
            let ns = if (s as u64) < at as u64 {
                s
            } else if (s as u64) < span_end {
                at
            } else {
                (s as u64 - n as u64) as u32
            };
            let ne = if (e as u64) < at as u64 {
                e
            } else if (e as u64) < span_end {
                at.saturating_sub(1)
            } else {
                (e as u64 - n as u64) as u32
            };
            (ns, ne)
        }
    };

    let mut start = norm.start;
    let mut end = norm.end;
    match axis {
        EditAxis::Row => {
            start.row = ns;
            end.row = ne;
        }
        EditAxis::Col => {
            start.col = ns;
            end.col = ne;
        }
    }
    Some(sheet_core::RangeRef { start, end })
}

/// A [`ParseCtx`] over the engine's [`SheetModel`]: resolves sheet names and
/// defined names for the parser, with the entered cell's sheet as home.
pub(crate) struct ModelParseCtx<'a> {
    pub(crate) model: &'a SheetModel,
    pub(crate) current: SheetId,
}

impl ParseCtx for ModelParseCtx<'_> {
    fn sheet_id(&self, name: &str) -> Option<SheetId> {
        self.model.sheet_id(name)
    }
    fn name_id(&self, name: &str) -> Option<NameId> {
        self.model.names.resolve(name, self.current)
    }
    fn current_sheet(&self) -> SheetId {
        self.current
    }
}

/// What a FORMULA cell shows for a blank result (Excel): a formula never
/// yields a blank cell — `=A1` over an empty `A1`, `IF(TRUE,,1)`, or a blank
/// element of a spilled block is `0` (round 2, omitted arguments; the corpus
/// had 37 `=D41`-shaped cells caching `0` where the engine stored a blank).
/// Inside an expression the value stays blank (`ISBLANK(CHOOSE(1,))` is
/// TRUE); only the stored cell result is grounded.
trait IntoShown {
    fn into_shown(self) -> CellValue;
}

impl IntoShown for CellValue {
    fn into_shown(self) -> CellValue {
        match self {
            CellValue::Empty => CellValue::Number(0.0),
            v => v,
        }
    }
}

fn shown_result(r: FnResult) -> FnResult {
    match r {
        FnResult::Scalar(v) => FnResult::Scalar(v.into_shown()),
        FnResult::Array(g) => FnResult::Array(
            g.into_iter()
                .map(|row| row.into_iter().map(IntoShown::into_shown).collect())
                .collect(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> Engine {
        let mut m = SheetModel::new();
        m.add_sheet("Sheet1");
        Engine::new(m, EngineConfig::default())
    }

    fn cr(row: u32, col: u32) -> CellRef {
        CellRef {
            sheet: 0,
            row,
            col,
            row_abs: false,
            col_abs: false,
        }
    }

    fn value_at(e: &Engine, row: u32, col: u32) -> CellValue {
        e.model()
            .sheet(0)
            .unwrap()
            .cell(row, col)
            .map(|c| c.value.clone())
            .unwrap_or(CellValue::Empty)
    }

    #[test]
    fn enter_literal_kinds() {
        let mut e = engine();
        e.enter(0, 0, 0, "42").unwrap();
        assert_eq!(value_at(&e, 0, 0), CellValue::Number(42.0));
        e.enter(0, 1, 0, "-3.5").unwrap();
        assert_eq!(value_at(&e, 1, 0), CellValue::Number(-3.5));
        e.enter(0, 2, 0, "1e3").unwrap();
        assert_eq!(value_at(&e, 2, 0), CellValue::Number(1000.0));
        e.enter(0, 3, 0, "true").unwrap();
        assert_eq!(value_at(&e, 3, 0), CellValue::Bool(true));
        e.enter(0, 4, 0, "#REF!").unwrap();
        assert_eq!(value_at(&e, 4, 0), CellValue::Error(CellError::Ref));
        e.enter(0, 5, 0, "hello").unwrap();
        assert_eq!(value_at(&e, 5, 0), CellValue::from("hello"));
        e.enter(0, 6, 0, "").unwrap();
        assert_eq!(value_at(&e, 6, 0), CellValue::Empty);
        // " 1": Excel ignores the spaces around a number (recorded, the
        // oracle entry lane `num-10`); around TRUE they make it text.
        e.enter(0, 7, 0, " 1").unwrap();
        assert_eq!(value_at(&e, 7, 0), CellValue::Number(1.0));
        e.enter(0, 8, 0, " TRUE").unwrap();
        assert_eq!(value_at(&e, 8, 0), CellValue::from(" TRUE"));
    }

    #[test]
    fn enter_formula_recalcs() {
        let mut e = engine();
        e.enter(0, 0, 0, "2").unwrap();
        e.enter(0, 1, 0, "3").unwrap();
        let r = e.enter(0, 2, 0, "=A1+A2").unwrap();
        assert_eq!(value_at(&e, 2, 0), CellValue::Number(5.0));
        assert!(r.changed.contains(&cr(2, 0)));
        // Edit A1 -> the formula recalcs.
        e.enter(0, 0, 0, "10").unwrap();
        assert_eq!(value_at(&e, 2, 0), CellValue::Number(13.0));
    }

    #[test]
    fn enter_bad_formula_is_err() {
        let mut e = engine();
        assert!(e.enter(0, 0, 0, "=1+").is_err());
        // An unknown function is no syntax error: it is #NAME? (W1.0).
        e.enter(0, 0, 0, "=NOTAFUNC(1)").unwrap();
        assert_eq!(
            e.model().sheet(0).unwrap().cell(0, 0).unwrap().value,
            CellValue::Error(CellError::Name)
        );
    }

    #[test]
    fn circular_keeps_last_values_and_reports() {
        // ADR 514: a cycle member keeps its last value; never calculated, 0.
        let mut e = engine();
        e.enter(0, 0, 0, "=B1").unwrap();
        let r = e.enter(0, 0, 1, "=A1").unwrap();
        assert!(r.circular.contains(&cr(0, 0)) || r.circular.contains(&cr(0, 1)));
        assert_eq!(value_at(&e, 0, 0), CellValue::Number(0.0));
        assert_eq!(value_at(&e, 0, 1), CellValue::Number(0.0));
        // Break the cycle.
        let r2 = e.enter(0, 0, 1, "5").unwrap();
        assert!(r2.circular.is_empty());
        assert_eq!(value_at(&e, 0, 0), CellValue::Number(5.0));
    }

    #[test]
    fn into_model_returns_model() {
        let mut e = engine();
        e.enter(0, 0, 0, "7").unwrap();
        let m = e.into_model();
        assert_eq!(
            m.sheet(0).unwrap().cell(0, 0).unwrap().value,
            CellValue::Number(7.0)
        );
    }

    fn approx(v: CellValue, target: f64, tol: f64) {
        match v {
            CellValue::Number(n) => assert!(
                (n - target).abs() <= tol,
                "expected ~{target}, got {n} (tol {tol})"
            ),
            other => panic!("expected a number ~{target}, got {other:?}"),
        }
    }

    #[test]
    fn iterative_convergent_system_settles() {
        // A1 = B1*0.5 + 10 ; B1 = A1 + 5. Fixed point: A1 = 0.5*(A1+5)+10 ->
        // 0.5*A1 = 12.5 -> A1 = 25, B1 = 30.
        let mut e = engine();
        e.set_iterative(true, 1000, 1e-9);
        e.enter(0, 0, 0, "=B1*0.5+10").unwrap();
        let r = e.enter(0, 0, 1, "=A1+5").unwrap();
        // Converged: no #REF!, circular empty, non_converged empty.
        assert!(r.circular.is_empty());
        assert!(r.non_converged.is_empty());
        approx(value_at(&e, 0, 0), 25.0, 1e-6);
        approx(value_at(&e, 0, 1), 30.0, 1e-6);
    }

    #[test]
    fn iterative_off_keeps_last_values() {
        // Same system, iteration OFF (default): A1 keeps the 10 it had before
        // the cycle closed, B1 (never calculated) is 0; circular reported.
        let mut e = engine();
        e.enter(0, 0, 0, "=B1*0.5+10").unwrap();
        let r = e.enter(0, 0, 1, "=A1+5").unwrap();
        assert!(!r.circular.is_empty());
        assert!(r.non_converged.is_empty());
        assert_eq!(value_at(&e, 0, 0), CellValue::Number(10.0));
        assert_eq!(value_at(&e, 0, 1), CellValue::Number(0.0));
    }

    #[test]
    fn iterative_divergent_caps_at_max_iter() {
        // A1 = A1 + 1 diverges; it is reported non-converged and capped.
        let mut e = engine();
        e.set_iterative(true, 7, 1e-9);
        let r = e.enter(0, 0, 0, "=A1+1").unwrap();
        assert!(r.circular.is_empty());
        assert_eq!(r.non_converged, vec![cr(0, 0)]);
        // Seeded at 0, +1 per pass, 7 passes -> 7.
        approx(value_at(&e, 0, 0), 7.0, 0.0);
    }

    #[test]
    fn iterative_is_deterministic_across_runs() {
        let run = || {
            let mut e = engine();
            e.set_iterative(true, 1000, 1e-12);
            e.enter(0, 0, 0, "=B1*0.5+10").unwrap();
            e.enter(0, 0, 1, "=A1+5").unwrap();
            (value_at(&e, 0, 0), value_at(&e, 0, 1))
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn set_iterative_toggles_policy_live() {
        // Enter a cycle with iteration off (A1 keeps 10), then turn iteration
        // on and the SAME cells settle (set_iterative recalcs).
        let mut e = engine();
        e.enter(0, 0, 0, "=B1*0.5+10").unwrap();
        e.enter(0, 0, 1, "=A1+5").unwrap();
        assert_eq!(value_at(&e, 0, 0), CellValue::Number(10.0));
        let r = e.set_iterative(true, 1000, 1e-9);
        assert!(r.circular.is_empty());
        assert!(r.non_converged.is_empty());
        approx(value_at(&e, 0, 0), 25.0, 1e-6);
        // And back off: the cycle is no longer calculated and keeps the
        // converged values.
        let r = e.set_iterative(false, 100, 0.001);
        assert!(!r.circular.is_empty());
        approx(value_at(&e, 0, 0), 25.0, 1e-6);
    }
}
