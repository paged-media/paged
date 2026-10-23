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

//! Defined names whose target is a FORMULA (a constant `0.5`, an expression
//! `SUM(Sheet1!$A$1:$A$3)`, a reference-valued `OFFSET(…)`, an array
//! constant `{1,2,3}`). Plain-reference names are `NameTarget::Range`; these
//! keep their text in the model and are compiled here when the engine is
//! built, then evaluated in the REFERRING cell's context (Excel's rule).
//!
//! A RELATIVE reference inside a stored name is relative to A1 and re-based
//! on the referring cell, wrapping around the grid: `Calc!$I1048576` read from
//! row 10 is `Calc!$I9` (the row above) — Excel's own encoding.

use std::borrow::Cow;

use sheet_core::ast::{Expr, NameId};
use sheet_core::names::NameTarget;
use sheet_core::{CellRef, NameScope, RangeRef, SheetModel, MAX_COL, MAX_ROW};
use sheet_parser::{parse, strip_storage_prefixes, RefSet};

/// How deep a name may refer to other names before evaluation gives up
/// (`#NAME?`) — guards a name defined in terms of itself.
pub(crate) const MAX_NAME_DEPTH: u32 = 32;

/// Parse every `Formula` target into the name table's compiled slot.
pub fn compile_names(model: &mut SheetModel) {
    let mut out = Vec::new();
    for (id, def) in model.names.iter() {
        let NameTarget::Formula(text) = &def.target else {
            continue;
        };
        let current = match def.scope {
            NameScope::Sheet(s) => s,
            NameScope::Workbook => 0,
        };
        let ctx = crate::ModelParseCtx { model, current };
        let text = text.trim_start_matches('=');
        out.push((id, parse(&strip_storage_prefixes(text), &ctx).ok()));
    }
    for (id, f) in out {
        model.names.set_compiled(id, f);
    }
}

/// The compiled expression of a formula-target name.
pub(crate) fn name_expr(model: &SheetModel, id: NameId) -> Option<&Expr> {
    match &model.names.get(id)?.target {
        NameTarget::Formula(_) => model.names.compiled(id).map(|f| &f.root),
        NameTarget::Range(_) => None,
    }
}

/// Whether an expression holds a relative row or column anywhere.
fn has_relative(e: &Expr) -> bool {
    let rel = |c: &CellRef| !c.row_abs || !c.col_abs;
    match e {
        Expr::Ref(c) => rel(c),
        Expr::Range(r) => rel(&r.start) || rel(&r.end),
        Expr::Unary(_, a) | Expr::SpillRef(a) => has_relative(a),
        Expr::Binary(_, a, b) => has_relative(a) || has_relative(b),
        Expr::Func(_, args) => args.iter().any(has_relative),
        Expr::Call(c, args) => has_relative(c) || args.iter().any(has_relative),
        Expr::Array(rows) => rows.iter().flatten().any(has_relative),
        Expr::Ref3D(r) => rel(&r.cell),
        Expr::Range3D(r) => rel(&r.range.start) || rel(&r.range.end),
        Expr::UnknownFunc(_, args) => args.iter().any(has_relative),
        Expr::Lit(_)
        | Expr::Name(_)
        | Expr::StructuredRef(_)
        | Expr::Local(_)
        | Expr::Missing
        | Expr::UnknownName(_) => false,
    }
}

fn rebase_cell(c: CellRef, at: CellRef) -> CellRef {
    let wrap = |v: u32, d: u32, max: u32| ((v as u64 + d as u64) % (max as u64 + 1)) as u32;
    CellRef {
        row: if c.row_abs {
            c.row
        } else {
            wrap(c.row, at.row, MAX_ROW)
        },
        col: if c.col_abs {
            c.col
        } else {
            wrap(c.col, at.col, MAX_COL)
        },
        ..c
    }
}

fn rebase(e: &Expr, at: CellRef) -> Expr {
    let f = |x: &Expr| rebase(x, at);
    match e {
        Expr::Ref(c) => Expr::Ref(rebase_cell(*c, at)),
        Expr::Range(r) => Expr::Range(RangeRef {
            start: rebase_cell(r.start, at),
            end: rebase_cell(r.end, at),
        }),
        Expr::Unary(op, a) => Expr::Unary(*op, Box::new(f(a))),
        Expr::Binary(op, a, b) => Expr::Binary(*op, Box::new(f(a)), Box::new(f(b))),
        Expr::Func(fid, args) => Expr::Func(*fid, args.iter().map(f).collect()),
        Expr::Array(rows) => Expr::Array(rows.iter().map(|r| r.iter().map(f).collect()).collect()),
        Expr::SpillRef(a) => Expr::SpillRef(Box::new(f(a))),
        Expr::Call(c, args) => Expr::Call(Box::new(f(c)), args.iter().map(f).collect()),
        Expr::Ref3D(r) => Expr::Ref3D(sheet_core::ast::Ref3D {
            cell: rebase_cell(r.cell, at),
            ..*r
        }),
        Expr::Range3D(r) => Expr::Range3D(sheet_core::ast::Range3D {
            range: RangeRef {
                start: rebase_cell(r.range.start, at),
                end: rebase_cell(r.range.end, at),
            },
            ..*r
        }),
        Expr::UnknownFunc(n, args) => Expr::UnknownFunc(n.clone(), args.iter().map(f).collect()),
        Expr::Lit(_)
        | Expr::Name(_)
        | Expr::StructuredRef(_)
        | Expr::Local(_)
        | Expr::Missing
        | Expr::UnknownName(_) => e.clone(),
    }
}

/// A formula-target name's expression as seen from the referring cell `at`
/// (relative parts re-based), or `None` for a range / uncompiled name.
pub(crate) fn name_expr_at(model: &SheetModel, id: NameId, at: CellRef) -> Option<Cow<'_, Expr>> {
    let e = name_expr(model, id)?;
    Some(if has_relative(e) {
        Cow::Owned(rebase(e, at))
    } else {
        Cow::Borrowed(e)
    })
}

/// `extract_refs` of a formula PLUS the references of every formula-target
/// name it uses (transitively, re-based on `cell`), so the dependency graph
/// and the volatile set see through names.
pub fn refs_with_names(model: &SheetModel, f: &sheet_core::ast::Formula, cell: CellRef) -> RefSet {
    let mut refs = sheet_parser::extract_refs(f);
    let mut seen: Vec<NameId> = Vec::new();
    let mut todo: Vec<NameId> = refs.names.clone();
    while let Some(id) = todo.pop() {
        if seen.contains(&id) {
            continue;
        }
        seen.push(id);
        let Some(inner) = name_expr_at(model, id, cell) else {
            continue;
        };
        let r = sheet_parser::extract_refs(&sheet_core::ast::Formula {
            root: inner.into_owned(),
        });
        refs.cells.extend(r.cells);
        refs.ranges.extend(r.ranges);
        refs.tables.extend(r.tables);
        refs.structured.extend(r.structured);
        refs.has_self_table_ref |= r.has_self_table_ref;
        refs.has_volatile |= r.has_volatile;
        for n in r.names {
            if !refs.names.contains(&n) {
                refs.names.push(n);
            }
            todo.push(n);
        }
    }
    refs
}

/// Visit every node of `e`, children first.
fn walk_mut(e: &mut Expr, f: &mut impl FnMut(&mut Expr)) {
    match e {
        Expr::Unary(_, a) | Expr::SpillRef(a) => walk_mut(a, f),
        Expr::Binary(_, a, b) => {
            walk_mut(a, f);
            walk_mut(b, f);
        }
        Expr::Func(_, args) | Expr::UnknownFunc(_, args) => {
            args.iter_mut().for_each(|a| walk_mut(a, f));
        }
        Expr::Call(c, args) => {
            walk_mut(c, f);
            args.iter_mut().for_each(|a| walk_mut(a, f));
        }
        Expr::Array(rows) => rows.iter_mut().flatten().for_each(|a| walk_mut(a, f)),
        Expr::Lit(_)
        | Expr::Ref(_)
        | Expr::Range(_)
        | Expr::Name(_)
        | Expr::StructuredRef(_)
        | Expr::Local(_)
        | Expr::Missing
        | Expr::Ref3D(_)
        | Expr::Range3D(_)
        | Expr::UnknownName(_) => {}
    }
    f(e);
}

/// Resolve the unknown names and functions of `e` that a defined name now
/// spells, as seen from `sheet`: `Foo` becomes the name, `Foo(…)` a call of
/// it (a named LAMBDA). Returns whether anything changed.
fn resolve_in(e: &mut Expr, model: &SheetModel, sheet: sheet_core::SheetId) -> bool {
    let mut changed = false;
    walk_mut(e, &mut |node| match node {
        Expr::UnknownName(n) => {
            if let Some(id) = model.names.resolve(n, sheet) {
                *node = Expr::Name(id);
                changed = true;
            }
        }
        Expr::UnknownFunc(n, args) => {
            if let Some(id) = model.names.resolve(n, sheet) {
                *node = Expr::Call(Box::new(Expr::Name(id)), std::mem::take(args));
                changed = true;
            }
        }
        _ => {}
    });
    changed
}

/// Whether `e` holds an unknown name or function anywhere.
fn has_unknown(e: &Expr) -> bool {
    let any = |xs: &[Expr]| xs.iter().any(has_unknown);
    match e {
        Expr::UnknownName(_) | Expr::UnknownFunc(_, _) => true,
        Expr::Unary(_, a) | Expr::SpillRef(a) => has_unknown(a),
        Expr::Binary(_, a, b) => has_unknown(a) || has_unknown(b),
        Expr::Func(_, args) => any(args),
        Expr::Call(c, args) => has_unknown(c) || any(args),
        Expr::Array(rows) => rows.iter().any(|r| any(r)),
        _ => false,
    }
}

/// Re-resolve every formula's unknown names and functions against the names
/// the workbook defines now (sheet ADR 513): defining `Foo` turns a formula's
/// `#NAME?` from `=Foo(2)` into a call of the named LAMBDA. Run when the
/// engine is built — every name definition rebuilds it.
pub fn resolve_unknowns(model: &mut SheetModel) {
    let mut updates = Vec::new();
    for (si, ws) in model.sheets.iter().enumerate() {
        for (&(r, c), cell) in ws.iter_cells() {
            let Some(f) = cell.formula.and_then(|fid| model.formula(fid)) else {
                continue;
            };
            if !has_unknown(&f.root) {
                continue;
            }
            let mut root = f.root.clone();
            if resolve_in(&mut root, model, si as sheet_core::SheetId) {
                updates.push((si, r, c, root));
            }
        }
    }
    for (si, r, c, root) in updates {
        let fid = model.intern_formula(sheet_core::ast::Formula { root });
        if let Some(cell) = model.sheets[si].cells.get_mut(&(r, c)) {
            cell.formula = Some(fid);
        }
    }
}
