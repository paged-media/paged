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

//! Legacy formulas (sheet ADR 513). A formula stored WITHOUT Excel's
//! dynamic-array mark was written by an Excel that evaluated it with implicit
//! intersection: a range where one value is expected reads the cell in the
//! formula's row or column. Excel 365 opens such a formula with an explicit
//! `@` wherever that can happen, and computes it as a dynamic-array formula
//! from then on. [`mark_implicit_intersections`] is that step: the loader
//! runs it over every legacy formula, so evaluation has one set of rules and
//! the formula prints the way Excel 365 shows it (`=@A1:A3*2`).
//!
//! Where the `@` goes (Excel-recorded, corpus/calc-model `legacy-*`):
//! - a range (a reference, a range name, a structured reference) in a VALUE
//!   position: the formula's root, an operand of an operator, an argument of
//!   a function of scalar parameters (`ABS(A1:A3)`), a scalar parameter of a
//!   lookup (`VLOOKUP(A1:A3,…)`'s key);
//! - inside an array EXPRESSION handed to any function whose parameters are
//!   not of Excel's array class (`SUM(A1:A3*2)` is `SUM(@A1:A3*2)`); a plain
//!   range argument of `SUM` stays a range, and an array-class function
//!   (`SUMPRODUCT`, `INDEX`, `LARGE`, …) keeps its array arguments.

use sheet_core::ast::{BinOp, Expr, UnOp};
use sheet_core::names::NameTarget;
use sheet_core::SheetModel;

use crate::eval::lift;

/// Insert the `@` a legacy formula's evaluation implies (see the module
/// docs). Returns whether anything changed.
pub fn mark_implicit_intersections(model: &SheetModel, root: &mut Expr) -> bool {
    // A root that spills by itself (a `returns_array` call, an array
    // literal, `A1#`) was not written by a legacy Excel: the engine's own
    // files before 2026-10 stored spills without the mark. Left alone.
    if crate::eval::expr_spills(root) {
        return false;
    }
    let mut changed = false;
    value(model, root, &mut changed);
    changed
}

/// Whether `e` names more than one cell (or might, for a formula name).
fn multi_area(model: &SheetModel, e: &Expr) -> bool {
    match e {
        Expr::Range(r) => {
            let n = r.normalized();
            n.rows() > 1 || n.cols() > 1
        }
        Expr::StructuredRef(_) => true,
        Expr::Name(id) => match model.names.get(*id).map(|d| &d.target) {
            Some(NameTarget::Range(r)) => {
                let n = r.normalized();
                n.rows() > 1 || n.cols() > 1
            }
            _ => false,
        },
        _ => false,
    }
}

fn wrap(e: &mut Expr, changed: &mut bool) {
    let inner = std::mem::replace(e, Expr::Missing);
    *e = Expr::Unary(UnOp::ImplicitIntersect, Box::new(inner));
    *changed = true;
}

/// `e` sits where one value is expected.
fn value(model: &SheetModel, e: &mut Expr, changed: &mut bool) {
    if multi_area(model, e) {
        wrap(e, changed);
        return;
    }
    match e {
        Expr::Unary(UnOp::ImplicitIntersect, _) => {}
        Expr::Unary(_, a) => value(model, a, changed),
        Expr::Binary(op, a, b) if !matches!(op, BinOp::Range | BinOp::Union | BinOp::Isect) => {
            value(model, a, changed);
            value(model, b, changed);
        }
        Expr::Func(fid, args) => call(model, *fid, args, changed),
        _ => {}
    }
}

/// The arguments of a call in a legacy formula.
fn call(model: &SheetModel, fid: sheet_core::FuncId, args: &mut [Expr], changed: &mut bool) {
    if lift::liftable(fid) {
        for a in args.iter_mut() {
            value(model, a, changed);
        }
        return;
    }
    let scalar = lift::scalar_params(fid);
    let array_class = crate::eval::array_class(fid);
    for (i, a) in args.iter_mut().enumerate() {
        if scalar.contains(&i) {
            value(model, a, changed);
        } else if !array_class && lift::needs_lift(model, a) {
            // An array expression in a reference/value parameter.
            value(model, a, changed);
        } else if let (false, Expr::Func(inner, inner_args)) = (array_class, a) {
            // A nested call keeps its own rules; under an array-class
            // parameter everything is evaluated as an array.
            call(model, *inner, inner_args, changed);
        }
    }
}
