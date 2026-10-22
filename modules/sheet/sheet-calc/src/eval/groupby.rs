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

//! `GROUPBY` and `PIVOTBY` (W3; approved as worksheet functions — the
//! interactive pivot table stays preserve-only, ADR 504). Special forms: the
//! function argument is a LAMBDA, an eta-reduced function name (`SUM`) or an
//! `HSTACK`/`VSTACK` of them, applied once per group. Excel-recorded
//! (`corpus/fn-corpus/array3/groupby.golden.tsv`, `pivotby.golden.tsv`).
//!
//! ## Rulings
//!
//! - **Headers.** `field_headers` 0 none, 1 present but not shown, 2 none but
//!   generated (`Row Field 1`, `Value 1`, `Column Field 1`), 3 present and shown;
//!   omitted, the first row is a header when every value cell in it is text
//!   and the second row holds a number.
//! - **Groups** are the distinct row-field tuples (text compared
//!   case-insensitively), sorted ascending by the fields unless
//!   `sort_order` names columns (1-based over the row fields, then the value
//!   columns; negative descends). With several row fields the grouping is a
//!   hierarchy (`field_relationship` 0): `total_depth` 2 adds a subtotal row
//!   per first-level group (its other key cells `""`) and labels the grand
//!   total `Grand Total`; a negative depth puts totals above their rows. A
//!   flat table (`field_relationship` 1) has no subtotals (`#VALUE!`).
//! - **Aggregation.** The function receives the group's values as a column;
//!   a two-parameter function (`PERCENTOF`) also receives the comparison set
//!   — all values for GROUPBY, the `relative_to` total for PIVOTBY (0 column
//!   total, 1 row total, 2 grand total, 3 parent column total, 4 parent row
//!   total). Totals aggregate the raw values, not the subtotals. A function
//!   list adds a row of function names.
//! - **PIVOTBY** lays the column keys across (a `Total` column unless
//!   `col_total_depth` is 0; first when negative); an empty combination is
//!   `""`; one function over several value columns leaves the total
//!   columns `""` (as Excel).
//! - Mismatched row counts, a non-function `function`, or nothing left after
//!   `filter_array` are `#VALUE!`.

use std::cmp::Ordering;

use sheet_core::ast::Expr;
use sheet_core::{CellError, CellValue, SheetModel};
use sheet_fn::{coerce, EvalCtx, FnResult};

use super::{eval, lambda, lift};
use crate::spill::SpillState;

type Grid = Vec<Vec<CellValue>>;

fn fail(e: CellError) -> FnResult {
    FnResult::Scalar(CellValue::Error(e))
}

macro_rules! tri {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return fail(e),
        }
    };
}

fn grid_of(
    model: &SheetModel,
    e: &Expr,
    ctx: &EvalCtx,
    spills: &SpillState,
) -> Result<Grid, CellError> {
    match lift::eval_array(model, e, ctx, spills) {
        FnResult::Array(g) => Ok(g),
        FnResult::Scalar(CellValue::Error(e)) => Err(e),
        FnResult::Scalar(v) => Ok(vec![vec![v]]),
    }
}

/// An optional integer argument (absent / omitted = `default`).
fn int_arg(
    model: &SheetModel,
    args: &[Expr],
    i: usize,
    default: i64,
    ctx: &EvalCtx,
    spills: &SpillState,
) -> Result<i64, CellError> {
    match args.get(i) {
        None | Some(Expr::Missing) => Ok(default),
        Some(e) => match eval(model, e, ctx, spills) {
            CellValue::Empty => Ok(default),
            v => Ok(coerce::to_number(&v)?.trunc() as i64),
        },
    }
}

/// A list of sort indices (a scalar or an array), `None` when omitted.
fn sort_arg(
    model: &SheetModel,
    args: &[Expr],
    i: usize,
    ctx: &EvalCtx,
    spills: &SpillState,
) -> Result<Option<Vec<i64>>, CellError> {
    match args.get(i) {
        None | Some(Expr::Missing) => Ok(None),
        Some(e) => {
            let g = grid_of(model, e, ctx, spills)?;
            let mut out = Vec::new();
            for v in g.iter().flatten() {
                if matches!(v, CellValue::Empty) {
                    continue;
                }
                let k = coerce::to_number(v)?.trunc() as i64;
                if k == 0 {
                    return Err(CellError::Value);
                }
                out.push(k);
            }
            Ok((!out.is_empty()).then_some(out))
        }
    }
}

/// One aggregation: a name for the function-name row and the lambda.
struct Agg {
    name: String,
    params: Vec<String>,
    body: Expr,
}

fn aggregators(
    model: &SheetModel,
    e: &Expr,
    ctx: &EvalCtx,
    spills: &SpillState,
) -> Result<Vec<Agg>, CellError> {
    let items: Vec<&Expr> = match e {
        Expr::Func(fid, items)
            if matches!(sheet_core::funcs::meta(*fid).name, "HSTACK" | "VSTACK") =>
        {
            items.iter().collect()
        }
        other => vec![other],
    };
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let name = match item {
            Expr::UnknownName(n) => n.to_uppercase().to_string(),
            Expr::Local(n) => n.to_string(),
            Expr::Name(nid) => model
                .names
                .get(*nid)
                .map(|d| d.name.to_string())
                .unwrap_or_default(),
            _ => String::new(),
        };
        let (params, body) = lambda::as_lambda(model, item, ctx, spills)?;
        if params.is_empty() || params.len() > 2 {
            return Err(CellError::Value);
        }
        out.push(Agg { name, params, body });
    }
    Ok(out)
}

fn column(values: &[CellValue]) -> FnResult {
    if values.is_empty() {
        return FnResult::Scalar(CellValue::Empty);
    }
    FnResult::Array(values.iter().map(|v| vec![v.clone()]).collect())
}

/// Apply one aggregation to a group's values (and the comparison set).
fn apply(
    model: &SheetModel,
    agg: &Agg,
    group: &[CellValue],
    all: &[CellValue],
    ctx: &EvalCtx,
    spills: &SpillState,
) -> CellValue {
    let mut vals = vec![column(group)];
    if agg.params.len() == 2 {
        vals.push(column(all));
    }
    match lambda::apply_to_values(model, &agg.params, &agg.body, vals, ctx, spills) {
        FnResult::Scalar(v) => v,
        FnResult::Array(g) if g.len() == 1 && g[0].len() == 1 => g[0][0].clone(),
        FnResult::Array(_) => CellValue::Error(CellError::Calc),
    }
}

/// Excel's ordering for keys (numbers < text < logicals, text folded).
fn key_cmp(a: &CellValue, b: &CellValue) -> Ordering {
    if let (CellValue::Text(x), CellValue::Text(y)) = (a, b) {
        return x.to_lowercase().cmp(&y.to_lowercase());
    }
    coerce::compare(a, b)
}

fn keys_cmp(a: &[CellValue], b: &[CellValue]) -> Ordering {
    for (x, y) in a.iter().zip(b) {
        let o = key_cmp(x, y);
        if o != Ordering::Equal {
            return o;
        }
    }
    Ordering::Equal
}

/// Whether the first row of `values` reads as a header row.
fn auto_header(values: &Grid) -> bool {
    values.len() > 1
        && values[0].iter().all(|v| matches!(v, CellValue::Text(_)))
        && values[1].iter().any(|v| matches!(v, CellValue::Number(_)))
}

/// The shared front matter of both functions: headers split off, filter
/// applied, rows checked. Returns (header names, data rows of each grid).
struct Prepared {
    names: Vec<Vec<CellValue>>,
    data: Vec<Grid>,
    show: bool,
    generated: bool,
}

fn prepare(
    grids: Vec<Grid>,
    header_mode: i64,
    filter: Option<Grid>,
    values_index: usize,
) -> Result<Prepared, CellError> {
    let n = grids[0].len();
    if grids.iter().any(|g| g.len() != n) || n == 0 {
        return Err(CellError::Value);
    }
    let has_header = match header_mode {
        -1 => auto_header(&grids[values_index]),
        0 | 2 => false,
        1 | 3 => true,
        _ => return Err(CellError::Value),
    };
    let mut names = Vec::new();
    let mut data = Vec::new();
    for g in grids {
        let mut g = g;
        if has_header {
            names.push(g.remove(0));
        } else {
            names.push(Vec::new());
        }
        data.push(g);
    }
    if let Some(f) = filter {
        let flat: Vec<CellValue> = f.into_iter().flatten().collect();
        let rows = data[0].len();
        let flat = if flat.len() == rows + 1 && has_header {
            flat[1..].to_vec()
        } else {
            flat
        };
        if flat.len() != rows {
            return Err(CellError::Value);
        }
        let keep: Vec<bool> = flat
            .iter()
            .map(|v| match v {
                CellValue::Error(e) => Err(*e),
                v => Ok(coerce::to_bool(v).unwrap_or(false)),
            })
            .collect::<Result<_, _>>()?;
        for g in &mut data {
            let mut i = 0;
            g.retain(|_| {
                let k = keep[i];
                i += 1;
                k
            });
        }
    }
    if data[0].is_empty() {
        return Err(CellError::Value);
    }
    Ok(Prepared {
        names,
        data,
        show: header_mode == 3 || header_mode == 2,
        generated: header_mode == 2,
    })
}

/// A node of the grouping hierarchy.
struct Node {
    key: Vec<CellValue>,
    rows: Vec<usize>,
    children: Vec<Node>,
}

/// Group `rows` by key columns `level..` hierarchically (or flat when
/// `flat`), preserving first-occurrence labels.
fn group(keys: &Grid, rows: &[usize], level: usize, depth: usize, flat: bool) -> Vec<Node> {
    let width = if flat { depth } else { level + 1 };
    let mut out: Vec<Node> = Vec::new();
    for &r in rows {
        let k: Vec<CellValue> = keys[r][..width].to_vec();
        match out
            .iter_mut()
            .find(|n| keys_cmp(&n.key, &k) == Ordering::Equal)
        {
            Some(n) => n.rows.push(r),
            None => out.push(Node {
                key: k,
                rows: vec![r],
                children: Vec::new(),
            }),
        }
    }
    if !flat && level + 1 < depth {
        for n in &mut out {
            let rows = n.rows.clone();
            n.children = group(keys, &rows, level + 1, depth, false);
        }
    }
    out
}

/// `GROUPBY(row_fields, values, function, [field_headers], [total_depth],
/// [sort_order], [filter_array], [field_relationship])`.
pub(super) fn groupby(
    model: &SheetModel,
    args: &[Expr],
    ctx: &EvalCtx,
    spills: &SpillState,
) -> FnResult {
    let rf = tri!(grid_of(model, &args[0], ctx, spills));
    let vf = tri!(grid_of(model, &args[1], ctx, spills));
    let aggs = tri!(aggregators(model, &args[2], ctx, spills));
    let header_mode = tri!(int_arg(model, args, 3, -1, ctx, spills));
    let depth = tri!(int_arg(model, args, 4, 1, ctx, spills));
    let sort = tri!(sort_arg(model, args, 5, ctx, spills));
    let filter = match args.get(6) {
        None | Some(Expr::Missing) => None,
        Some(e) => Some(tri!(grid_of(model, e, ctx, spills))),
    };
    let relationship = tri!(int_arg(model, args, 7, 0, ctx, spills));
    if !(0..=1).contains(&relationship)
        || depth.abs() > 2 && depth.unsigned_abs() as usize > rf[0].len()
    {
        return fail(CellError::Value);
    }
    let flat = relationship == 1;
    if flat && depth.abs() >= 2 {
        return fail(CellError::Value);
    }
    let p = tri!(prepare(vec![rf, vf], header_mode, filter, 1));
    let (keys, vals) = (&p.data[0], &p.data[1]);
    let kr = keys[0].len();
    let kv = vals[0].len();
    let all_rows: Vec<usize> = (0..keys.len()).collect();
    let column_of = |c: usize, rows: &[usize]| -> Vec<CellValue> {
        rows.iter().map(|&r| vals[r][c].clone()).collect()
    };
    let all_cols: Vec<Vec<CellValue>> = (0..kv).map(|c| column_of(c, &all_rows)).collect();
    // The aggregate cells of a row set: as many functions as value columns
    // pair up (function i on column i, Excel-recorded); otherwise every
    // function over every value column, function by function.
    let pairs = agg_pairs(aggs.len(), kv);
    let agg_cells = |rows: &[usize]| -> Vec<CellValue> {
        pairs
            .iter()
            .map(|&(f, c)| {
                apply(
                    model,
                    &aggs[f],
                    &column_of(c, rows),
                    &all_cols[c],
                    ctx,
                    spills,
                )
            })
            .collect()
    };
    let mut tree = group(keys, &all_rows, 0, kr, flat);
    let order = sort.unwrap_or_else(|| (1..=kr as i64).collect());
    sort_tree(&mut tree, &order, kr, &agg_cells);
    let subtotals = depth.unsigned_abs() as usize;
    let top = depth < 0;
    let mut out: Grid = Vec::new();
    if aggs.len() > 1 {
        let mut row = vec![CellValue::Text("".into()); kr];
        for &(f, _) in &pairs {
            row.push(CellValue::Text(aggs[f].name.as_str().into()));
        }
        out.push(row);
    }
    if p.show {
        let mut row: Vec<CellValue> = (0..kr)
            .map(|i| {
                if p.generated {
                    CellValue::Text(format!("Row Field {}", i + 1).into())
                } else {
                    p.names[0].get(i).cloned().unwrap_or(CellValue::Empty)
                }
            })
            .collect();
        for &(_, c) in &pairs {
            row.push(if p.generated {
                CellValue::Text(format!("Value {}", c + 1).into())
            } else {
                p.names[1].get(c).cloned().unwrap_or(CellValue::Empty)
            });
        }
        out.push(row);
    }
    let grand_label = if subtotals >= 2 && kr > 1 {
        "Grand Total"
    } else {
        "Total"
    };
    let grand = |out: &mut Grid| {
        let mut row = vec![CellValue::Text(grand_label.into())];
        row.extend(std::iter::repeat_n(CellValue::Text("".into()), kr - 1));
        row.extend(agg_cells(&all_rows));
        out.push(row);
    };
    if subtotals >= 1 && top {
        grand(&mut out);
    }
    emit_groupby(&tree, kr, subtotals, top, &agg_cells, &mut out);
    if subtotals >= 1 && !top {
        grand(&mut out);
    }
    FnResult::Array(out)
}

/// `(function, value column)` per aggregate column.
fn agg_pairs(nf: usize, kv: usize) -> Vec<(usize, usize)> {
    if nf == kv && nf > 1 {
        (0..nf).map(|i| (i, i)).collect()
    } else {
        (0..nf).flat_map(|f| (0..kv).map(move |c| (f, c))).collect()
    }
}

fn sort_tree(
    nodes: &mut [Node],
    order: &[i64],
    kr: usize,
    agg_cells: &dyn Fn(&[usize]) -> Vec<CellValue>,
) {
    let cache: Vec<Vec<CellValue>> = nodes
        .iter()
        .map(|n| {
            if order.iter().any(|k| k.unsigned_abs() as usize > kr) {
                agg_cells(&n.rows)
            } else {
                Vec::new()
            }
        })
        .collect();
    let mut idx: Vec<usize> = (0..nodes.len()).collect();
    idx.sort_by(|&a, &b| {
        for &k in order {
            let col = k.unsigned_abs() as usize - 1;
            let (x, y) = if col < kr {
                // A node keys only its own level and those above.
                if col >= nodes[a].key.len() {
                    continue;
                }
                (&nodes[a].key[col], &nodes[b].key[col])
            } else {
                match (cache[a].get(col - kr), cache[b].get(col - kr)) {
                    (Some(x), Some(y)) => (x, y),
                    _ => continue,
                }
            };
            let o = key_cmp(x, y);
            let o = if k < 0 { o.reverse() } else { o };
            if o != Ordering::Equal {
                return o;
            }
        }
        Ordering::Equal
    });
    let mut taken: Vec<Option<Node>> = nodes
        .iter_mut()
        .map(|n| {
            Some(std::mem::replace(
                n,
                Node {
                    key: Vec::new(),
                    rows: Vec::new(),
                    children: Vec::new(),
                },
            ))
        })
        .collect();
    for (slot, i) in idx.into_iter().enumerate() {
        nodes[slot] = taken[i].take().expect("each node once");
    }
    for n in nodes.iter_mut() {
        sort_tree(&mut n.children, order, kr, agg_cells);
    }
}

fn emit_groupby(
    nodes: &[Node],
    kr: usize,
    subtotals: usize,
    top: bool,
    agg_cells: &dyn Fn(&[usize]) -> Vec<CellValue>,
    out: &mut Grid,
) {
    for n in nodes {
        if n.children.is_empty() {
            let mut row = n.key.clone();
            row.extend(std::iter::repeat_n(
                CellValue::Text("".into()),
                kr - row.len(),
            ));
            row.extend(agg_cells(&n.rows));
            out.push(row);
            continue;
        }
        let level = n.key.len();
        let sub = subtotals > level;
        let subtotal_row = || {
            let mut row = n.key.clone();
            row.extend(std::iter::repeat_n(
                CellValue::Text("".into()),
                kr - row.len(),
            ));
            row.extend(agg_cells(&n.rows));
            row
        };
        if sub && top {
            out.push(subtotal_row());
        }
        emit_groupby(&n.children, kr, subtotals, top, agg_cells, out);
        if sub && !top {
            out.push(subtotal_row());
        }
    }
}

/// `PIVOTBY(row_fields, col_fields, values, function, [field_headers],
/// [row_total_depth], [row_sort_order], [col_total_depth], [col_sort_order],
/// [filter_array], [relative_to])`.
pub(super) fn pivotby(
    model: &SheetModel,
    args: &[Expr],
    ctx: &EvalCtx,
    spills: &SpillState,
) -> FnResult {
    let rf = tri!(grid_of(model, &args[0], ctx, spills));
    let cf = tri!(grid_of(model, &args[1], ctx, spills));
    let vf = tri!(grid_of(model, &args[2], ctx, spills));
    let aggs = tri!(aggregators(model, &args[3], ctx, spills));
    let header_mode = tri!(int_arg(model, args, 4, -1, ctx, spills));
    let rdepth = tri!(int_arg(model, args, 5, 1, ctx, spills));
    let rsort = tri!(sort_arg(model, args, 6, ctx, spills));
    let cdepth = tri!(int_arg(model, args, 7, 1, ctx, spills));
    let csort = tri!(sort_arg(model, args, 8, ctx, spills));
    let filter = match args.get(9) {
        None | Some(Expr::Missing) => None,
        Some(e) => Some(tri!(grid_of(model, e, ctx, spills))),
    };
    let relative = tri!(int_arg(model, args, 10, 0, ctx, spills));
    if !(0..=4).contains(&relative) {
        return fail(CellError::Value);
    }
    let p = tri!(prepare(vec![rf, cf, vf], header_mode, filter, 2));
    let (rkeys, ckeys, vals) = (&p.data[0], &p.data[1], &p.data[2]);
    let (kr, kc, kv) = (rkeys[0].len(), ckeys[0].len(), vals[0].len());
    let all_rows: Vec<usize> = (0..rkeys.len()).collect();
    let mut rtree = group(rkeys, &all_rows, 0, kr, false);
    let mut ctree = group(ckeys, &all_rows, 0, kc, false);
    let rorder = rsort.unwrap_or_else(|| (1..=kr as i64).collect());
    let corder = csort.unwrap_or_else(|| (1..=kc as i64).collect());
    let none = |_: &[usize]| Vec::new();
    sort_tree(&mut rtree, &rorder, kr, &none);
    sort_tree(&mut ctree, &corder, kc, &none);
    // Flatten both hierarchies into display lines: (key, rows, is_total).
    let rlines = lines(&rtree, kr, rdepth, &all_rows);
    let clines = lines(&ctree, kc, cdepth, &all_rows);
    let blank = || CellValue::Text("".into());
    let intersect = |a: &[usize], b: &[usize]| -> Vec<usize> {
        a.iter().copied().filter(|r| b.contains(r)).collect()
    };
    let column_of = |c: usize, rows: &[usize]| -> Vec<CellValue> {
        rows.iter().map(|&r| vals[r][c].clone()).collect()
    };
    let parent = |key: &[CellValue], keys: &Grid, drop: usize| -> Vec<usize> {
        let keep = key.len().saturating_sub(drop);
        all_rows
            .iter()
            .copied()
            .filter(|&r| keys_cmp(&keys[r][..keep], &key[..keep]) == Ordering::Equal)
            .collect()
    };
    let mut out: Grid = Vec::new();
    // Header rows.
    let pairs = agg_pairs(aggs.len(), kv);
    let per_key = pairs.len();
    if p.show && kc > 0 {
        let mut row = vec![blank(); kr];
        for (j, _) in clines.iter().enumerate() {
            for m in 0..per_key {
                row.push(if j == 0 && m == 0 {
                    if p.generated {
                        CellValue::Text("Column Field 1".into())
                    } else {
                        p.names[1].first().cloned().unwrap_or_else(blank)
                    }
                } else {
                    blank()
                });
            }
        }
        out.push(row);
    }
    for level in 0..kc {
        let mut row = vec![blank(); kr];
        for l in &clines {
            for _ in 0..per_key {
                row.push(if l.total {
                    if level == 0 {
                        CellValue::Text(l.label.as_str().into())
                    } else {
                        blank()
                    }
                } else {
                    l.key.get(level).cloned().unwrap_or_else(blank)
                });
            }
        }
        out.push(row);
    }
    if aggs.len() > 1 {
        let mut row = vec![blank(); kr];
        for _ in &clines {
            for &(f, _) in &pairs {
                row.push(CellValue::Text(aggs[f].name.as_str().into()));
            }
        }
        out.push(row);
    }
    if p.show {
        let mut row: Vec<CellValue> = (0..kr)
            .map(|i| {
                if p.generated {
                    CellValue::Text(format!("Row Field {}", i + 1).into())
                } else {
                    p.names[0].get(i).cloned().unwrap_or_else(blank)
                }
            })
            .collect();
        for _ in &clines {
            for &(_, c) in &pairs {
                row.push(if p.generated {
                    CellValue::Text(format!("Value {}", c + 1).into())
                } else {
                    p.names[2].get(c).cloned().unwrap_or_else(blank)
                });
            }
        }
        out.push(row);
    }
    for rl in &rlines {
        let mut row: Vec<CellValue> = if rl.total {
            let mut r = vec![CellValue::Text(rl.label.as_str().into())];
            r.extend(std::iter::repeat_n(blank(), kr - 1));
            r
        } else {
            let mut r = rl.key.clone();
            r.extend(std::iter::repeat_n(blank(), kr - r.len()));
            r
        };
        for cl in &clines {
            let cells = intersect(&rl.rows, &cl.rows);
            for &(f, c) in &pairs {
                let a = &aggs[f];
                if cl.total && kv > 1 && aggs.len() == 1 {
                    row.push(blank());
                    continue;
                }
                if cells.is_empty() {
                    row.push(blank());
                    continue;
                }
                let all: Vec<usize> = match relative {
                    0 => cl.rows.clone(),
                    1 => rl.rows.clone(),
                    2 => all_rows.clone(),
                    3 => {
                        let base = if cl.total {
                            all_rows.clone()
                        } else {
                            parent(&cl.key, ckeys, 1)
                        };
                        intersect(&rl.rows, &base)
                    }
                    _ => {
                        let base = if rl.total {
                            all_rows.clone()
                        } else {
                            parent(&rl.key, rkeys, 1)
                        };
                        intersect(&cl.rows, &base)
                    }
                };
                row.push(apply(
                    model,
                    a,
                    &column_of(c, &cells),
                    &column_of(c, &all),
                    ctx,
                    spills,
                ));
            }
        }
        out.push(row);
    }
    FnResult::Array(out)
}

/// A display line of one pivot axis.
struct Line {
    key: Vec<CellValue>,
    rows: Vec<usize>,
    total: bool,
    label: String,
}

fn lines(tree: &[Node], k: usize, depth: i64, all: &[usize]) -> Vec<Line> {
    let subtotals = depth.unsigned_abs() as usize;
    let top = depth < 0;
    let label = if subtotals >= 2 && k > 1 {
        "Grand Total"
    } else {
        "Total"
    };
    let mut out = Vec::new();
    let grand = Line {
        key: Vec::new(),
        rows: all.to_vec(),
        total: true,
        label: label.to_string(),
    };
    fn walk(nodes: &[Node], subtotals: usize, top: bool, out: &mut Vec<Line>) {
        for n in nodes {
            if n.children.is_empty() {
                out.push(Line {
                    key: n.key.clone(),
                    rows: n.rows.clone(),
                    total: false,
                    label: String::new(),
                });
                continue;
            }
            let sub = subtotals > n.key.len();
            let line = || Line {
                key: n.key.clone(),
                rows: n.rows.clone(),
                total: false,
                label: String::new(),
            };
            if sub && top {
                out.push(line());
            }
            walk(&n.children, subtotals, top, out);
            if sub && !top {
                out.push(line());
            }
        }
    }
    if subtotals >= 1 && top {
        out.push(grand);
        walk(tree, subtotals, top, &mut out);
    } else {
        walk(tree, subtotals, top, &mut out);
        if subtotals >= 1 {
            out.push(grand);
        }
    }
    out
}
