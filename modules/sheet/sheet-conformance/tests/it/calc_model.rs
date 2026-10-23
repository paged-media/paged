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

// Test names end in `__feat__<cockpit id>` (the cockpit linking convention).
#![allow(non_snake_case)]

//! The calculation model (sheet ADRs 513 and 514): the W1.0 amendment's
//! error codes, unknown names and functions, `@`, 3D references and
//! `cached_only` functions, and the Excel-recorded `calcmodel` lane.
//!
//! ## The Excel lane
//!
//! `corpus/calc-model/cases.tsv` describes small workbooks (cells, legacy
//! formulas, extra sheets, defined names, probed cells);
//! `oracle/excel/calcmodel.py` wrote them into one workbook, desktop Excel
//! recalculated it, and the probed cells are committed as
//! `oracle/excel/recorded/calcmodel.tsv`. This lane rebuilds each case the way
//! the xlsx loader would (a formula Excel stores as a dynamic array is marked
//! dynamic, a legacy one is not), recalculates it and compares every probed
//! cell. Disagreements are listed in `oracle/excel/calcmodel-divergences.tsv`
//! and the list is checked both ways, as in the fn-corpus lane.

use std::collections::BTreeMap;

use sheet_calc::{Engine, EngineConfig};
use sheet_core::names::{NameDef, NameScope, NameTarget};
use sheet_core::{CellError, CellValue, SheetId, SheetModel};

// ---- helpers ------------------------------------------------------------------

fn addr(a: &str) -> (u32, u32) {
    let a = a.trim().to_ascii_uppercase();
    let split = a.find(|ch: char| ch.is_ascii_digit()).expect("row");
    let col = sheet_core::a1_to_col(&a[..split]).expect("col");
    let row: u32 = a[split..].parse().expect("row number");
    (row - 1, col)
}

struct Ctx<'a> {
    model: &'a SheetModel,
    sheet: SheetId,
}

impl sheet_parser::ParseCtx for Ctx<'_> {
    fn sheet_id(&self, name: &str) -> Option<SheetId> {
        self.model.sheet_id(name)
    }
    fn name_id(&self, name: &str) -> Option<sheet_core::NameId> {
        self.model.names.resolve(name, self.sheet)
    }
    fn current_sheet(&self) -> SheetId {
        self.sheet
    }
}

impl sheet_parser::SheetNames for Ctx<'_> {
    fn sheet_name(&self, id: SheetId) -> Option<&str> {
        self.model.sheet(id).map(|s| s.name.as_str())
    }
}

/// A typed input in the oracle's setup grammar (`oracle_cases.typed_setup`).
fn typed(raw: &str) -> CellValue {
    if raw.is_empty() || raw == "empty" {
        return CellValue::Empty;
    }
    if let Some(t) = raw.strip_prefix("text:") {
        return CellValue::from(t);
    }
    if let Some(b) = raw.strip_prefix("bool:") {
        return CellValue::Bool(b.trim().eq_ignore_ascii_case("TRUE"));
    }
    if raw.eq_ignore_ascii_case("TRUE") || raw.eq_ignore_ascii_case("FALSE") {
        return CellValue::Bool(raw.eq_ignore_ascii_case("TRUE"));
    }
    if let Some(e) = CellError::parse(raw) {
        return CellValue::Error(e);
    }
    match raw.parse::<f64>() {
        Ok(n) if n.is_finite() && !raw.contains('_') => CellValue::Number(n),
        _ => CellValue::from(raw),
    }
}

fn engine_on(sheets: &[&str]) -> Engine {
    let mut m = SheetModel::new();
    for s in sheets {
        m.add_sheet(*s);
    }
    Engine::new(m, EngineConfig::default())
}

fn value(e: &Engine, sheet: SheetId, a: &str) -> CellValue {
    let (r, c) = addr(a);
    e.model()
        .sheet(sheet)
        .and_then(|ws| ws.cell(r, c))
        .map(|c| c.value.clone())
        .unwrap_or(CellValue::Empty)
}

fn enter(e: &mut Engine, sheet: SheetId, a: &str, raw: &str) {
    let (r, c) = addr(a);
    e.enter(sheet, r, c, raw)
        .unwrap_or_else(|err| panic!("{a} {raw:?}: {err}"));
}

fn n(x: f64) -> CellValue {
    CellValue::Number(x)
}

fn er(e: CellError) -> CellValue {
    CellValue::Error(e)
}

// ---- W1.0: the amendment's types ---------------------------------------------

#[test]
fn excel_365_error_codes_are_values__feat__sheet_calc_model() {
    for (tok, err, num) in [
        ("#CALC!", CellError::Calc, 14.0),
        ("#FIELD!", CellError::Field, 13.0),
        ("#BUSY!", CellError::Busy, 15.0),
        ("#CONNECT!", CellError::Connect, 10.0),
        ("#BLOCKED!", CellError::Blocked, 11.0),
        ("#UNKNOWN!", CellError::Unknown, 12.0),
        ("#SPILL!", CellError::Spill, 9.0),
    ] {
        assert_eq!(CellError::parse(tok), Some(err));
        assert_eq!(err.as_str(), tok);
        let mut e = engine_on(&["S"]);
        enter(&mut e, 0, "A1", &format!("={tok}"));
        enter(&mut e, 0, "B1", "=ERROR.TYPE(A1)");
        enter(&mut e, 0, "C1", "=ISERROR(A1)");
        assert_eq!(value(&e, 0, "A1"), er(err), "{tok}");
        assert_eq!(value(&e, 0, "B1"), n(num), "{tok}");
        assert_eq!(value(&e, 0, "C1"), CellValue::Bool(true), "{tok}");
    }
}

#[test]
fn unknown_names_and_functions_are_name_errors__feat__sheet_calc_model() {
    let mut e = engine_on(&["S"]);
    enter(&mut e, 0, "A1", "=NoSuchFn(1)+1");
    enter(&mut e, 0, "A2", "=NoSuchName*2");
    enter(&mut e, 0, "A3", "=IFERROR(NoSuchFn(1),\"caught\")");
    enter(&mut e, 0, "A4", "=ERROR.TYPE(NoSuchName)");
    assert_eq!(value(&e, 0, "A1"), er(CellError::Name));
    assert_eq!(value(&e, 0, "A2"), er(CellError::Name));
    assert_eq!(value(&e, 0, "A3"), CellValue::from("caught"));
    assert_eq!(value(&e, 0, "A4"), n(5.0));
}

#[test]
fn defining_a_name_resolves_formulas_that_used_it__feat__sheet_calc_model() {
    let mut e = engine_on(&["S"]);
    enter(&mut e, 0, "A1", "=AddOne(41)");
    enter(&mut e, 0, "A2", "=Rate*100");
    assert_eq!(value(&e, 0, "A1"), er(CellError::Name));
    // Define both names and rebuild the engine (what a name definition does).
    let mut m = e.into_model();
    m.names.define(NameDef {
        name: "AddOne".into(),
        scope: NameScope::Workbook,
        target: NameTarget::Formula("LAMBDA(x,x+1)".into()),
    });
    m.names.define(NameDef {
        name: "Rate".into(),
        scope: NameScope::Workbook,
        target: NameTarget::Formula("0.25".into()),
    });
    let mut e = Engine::new(m, EngineConfig::default());
    e.recalc_all();
    assert_eq!(value(&e, 0, "A1"), n(42.0));
    assert_eq!(value(&e, 0, "A2"), n(25.0));
}

#[test]
fn implicit_intersection_operator__feat__sheet_calc_model() {
    let mut e = engine_on(&["S"]);
    for (a, v) in [("A1", "1"), ("A2", "2"), ("A3", "3")] {
        enter(&mut e, 0, a, v);
    }
    enter(&mut e, 0, "B2", "=@A1:A3*10");
    enter(&mut e, 0, "B5", "=@A1:A3");
    enter(&mut e, 0, "C1", "=@SEQUENCE(3)");
    enter(&mut e, 0, "D1", "=@{7,8,9}");
    assert_eq!(value(&e, 0, "B2"), n(20.0));
    assert_eq!(value(&e, 0, "B3"), CellValue::Empty, "@ does not spill");
    assert_eq!(value(&e, 0, "B5"), er(CellError::Value));
    assert_eq!(value(&e, 0, "C1"), n(1.0));
    assert_eq!(value(&e, 0, "C2"), CellValue::Empty);
    assert_eq!(value(&e, 0, "D1"), n(7.0));
}

#[test]
fn three_d_references__feat__sheet_calc_model() {
    let mut e = engine_on(&["Main", "Jan", "Feb", "Mar"]);
    for (s, v) in [(1, "1"), (2, "2"), (3, "4")] {
        enter(&mut e, s, "A1", v);
        enter(&mut e, s, "A2", "10");
    }
    enter(&mut e, 0, "B1", "=SUM(Jan:Mar!A1)");
    enter(&mut e, 0, "B2", "=SUM(Jan:Mar!A1:A2)");
    enter(&mut e, 0, "B3", "=AVERAGE(Feb:Mar!A1)");
    enter(&mut e, 0, "B4", "=Jan:Mar!A1");
    enter(&mut e, 0, "B5", "=COUNTIF(Jan:Mar!A1,\">0\")");
    enter(&mut e, 0, "B6", "=ISREF(Jan:Mar!A1)");
    assert_eq!(value(&e, 0, "B1"), n(7.0));
    assert_eq!(value(&e, 0, "B2"), n(37.0));
    assert_eq!(value(&e, 0, "B3"), n(3.0));
    assert_eq!(value(&e, 0, "B4"), er(CellError::Ref));
    assert_eq!(value(&e, 0, "B5"), er(CellError::Value));
    assert_eq!(value(&e, 0, "B6"), CellValue::Bool(false));
    // Every sheet of the span is a dependency.
    enter(&mut e, 2, "A1", "100");
    assert_eq!(value(&e, 0, "B1"), n(105.0));
}

#[test]
fn deleting_a_sheet_shrinks_a_3d_span__feat__sheet_calc_model() {
    use sheet_js::core::SheetSession;
    let mut s = SheetSession::new();
    for name in ["Jan", "Feb", "Mar"] {
        s.add_sheet(name).unwrap();
    }
    for (sheet, v) in [(1, "1"), (2, "2"), (3, "4")] {
        s.set_cell(sheet, 0, 0, v).unwrap();
    }
    s.set_cell(0, 0, 1, "=SUM(Jan:Mar!A1)").unwrap();
    s.set_cell(0, 1, 1, "=SUM(Feb:Feb!A1)").unwrap();
    assert_eq!(s.get_cell_display(0, 0, 1), "7");
    // An inner sheet goes: the span keeps its ends.
    s.delete_sheet(2).unwrap();
    assert_eq!(s.get_cell_input(0, 0, 1), "=SUM(Jan:Mar!A1)");
    assert_eq!(s.get_cell_display(0, 0, 1), "5");
    assert_eq!(s.get_cell_input(0, 1, 1), "=SUM(#REF!)");
    // An end goes: the span moves inward.
    s.delete_sheet(2).unwrap();
    assert_eq!(s.get_cell_input(0, 0, 1), "=SUM(Jan:Jan!A1)");
    assert_eq!(s.get_cell_display(0, 0, 1), "1");
}

#[test]
fn cached_only_functions_keep_the_cached_value__feat__sheet_calc_model() {
    // Typed fresh: no cached value, so the row's error.
    let mut e = engine_on(&["S"]);
    enter(&mut e, 0, "A1", "=WEBSERVICE(\"https://example.com\")");
    enter(&mut e, 0, "A2", "=CUBEVALUE(\"conn\",\"[m]\")");
    enter(&mut e, 0, "A3", "=NoSuchFn(1)");
    assert_eq!(value(&e, 0, "A1"), er(CellError::Blocked));
    assert_eq!(value(&e, 0, "A2"), er(CellError::Connect));
    assert_eq!(value(&e, 0, "A3"), er(CellError::Name));
    // From a workbook that cached values: they are kept, recalc or not.
    let mut m = e.into_model();
    let ws = m.sheet_mut(0).unwrap();
    for (r, v) in [(0, "fetched"), (1, "42"), (2, "computed elsewhere")] {
        ws.cells.get_mut(&(r, 0)).unwrap().value = CellValue::from(v);
    }
    let mut e = Engine::new(m, EngineConfig::default());
    e.recalc_all();
    assert_eq!(value(&e, 0, "A1"), CellValue::from("fetched"));
    assert_eq!(value(&e, 0, "A2"), CellValue::from("42"));
    assert_eq!(value(&e, 0, "A3"), CellValue::from("computed elsewhere"));
}

// ---- the Excel-recorded lane ------------------------------------------------------

#[derive(Default)]
struct Case {
    lines: Vec<String>,
    /// (kind, sheet name or "" for the case sheet, address, value)
    cells: Vec<(String, String, String, String)>,
    sheets: Vec<String>,
    names: Vec<(String, String)>,
}

fn fnv1a(text: &str) -> String {
    let mut h: u64 = 0xCBF2_9CE4_8422_2325;
    for b in text.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01B3);
    }
    format!("{h:016x}")
}

fn split_sheet(a: &str) -> (String, String) {
    match a.rsplit_once('!') {
        Some((s, c)) => (s.trim_matches('\'').to_string(), c.to_string()),
        None => (String::new(), a.to_string()),
    }
}

fn load_cases() -> Vec<(String, Case)> {
    let path = sheet_conformance::corpus_root().join("calc-model/cases.tsv");
    let text = std::fs::read_to_string(&path).expect("calc-model cases");
    let mut order: Vec<(String, Case)> = Vec::new();
    for raw in text.lines() {
        if raw.trim().is_empty() || raw.trim_start().starts_with('#') {
            continue;
        }
        let cols: Vec<&str> = raw.split('\t').collect();
        let get = |i: usize| cols.get(i).copied().unwrap_or("").to_string();
        let id = get(0);
        if order.last().is_none_or(|(l, _)| *l != id) {
            assert!(
                !order.iter().any(|(l, _)| *l == id),
                "case {id} is not contiguous"
            );
            order.push((id.clone(), Case::default()));
        }
        let case = &mut order.last_mut().unwrap().1;
        case.lines.push(raw.to_string());
        match get(1).as_str() {
            "sheet" => case.sheets.push(get(2)),
            "name" => case.names.push((get(2), get(3))),
            "cell" | "legacy" => {
                let (s, a) = split_sheet(&get(2));
                case.cells.push((get(1), s, a, get(3)));
            }
            "probe" => {}
            other => panic!("unknown kind {other:?} in {raw:?}"),
        }
    }
    order
}

/// Build and recalculate one case as the xlsx loader would.
fn run_case(n: usize, case: &Case) -> Engine {
    let mut m = SheetModel::new();
    m.add_sheet(format!("c{n}"));
    for s in &case.sheets {
        m.add_sheet(s.as_str());
    }
    for (name, f) in &case.names {
        m.names.define(NameDef {
            name: name.as_str().into(),
            scope: NameScope::Workbook,
            target: NameTarget::Formula(f.trim_start_matches('=').into()),
        });
    }
    for (kind, s, a, v) in &case.cells {
        let sheet = if s.is_empty() {
            0
        } else {
            m.sheet_id(s).unwrap_or_else(|| panic!("sheet {s}"))
        };
        let (r, c) = addr(a);
        let cell = if let Some(body) = v.strip_prefix('=') {
            let f = {
                let ctx = Ctx { model: &m, sheet };
                sheet_parser::parse(body, &ctx).unwrap_or_else(|e| panic!("{body}: {e}"))
            };
            let mut f = f;
            if kind == "cell" {
                m.sheet_mut(sheet).unwrap().dynamic_arrays.insert((r, c));
            } else {
                // What the loader does with a legacy formula.
                sheet_calc::legacy::mark_implicit_intersections(&m, &mut f.root);
            }
            let fid = m.intern_formula(f);
            sheet_core::Cell {
                value: CellValue::Empty,
                formula: Some(fid),
                ..Default::default()
            }
        } else {
            sheet_core::Cell {
                value: typed(v),
                ..Default::default()
            }
        };
        m.sheet_mut(sheet).unwrap().set_cell(r, c, cell);
    }
    let mut e = Engine::new(m, EngineConfig::default());
    e.recalc_all();
    e
}

fn token(v: &CellValue) -> String {
    match v {
        CellValue::Empty => "blank".into(),
        CellValue::Number(x) => format!("n:{x}"),
        CellValue::Text(t) => format!("s:{t}"),
        CellValue::Bool(b) => format!("b:{}", if *b { "TRUE" } else { "FALSE" }),
        CellValue::Error(e) => format!("e:{}", e.as_str()),
    }
}

fn excel_token(kind: &str, v: &str) -> String {
    match kind {
        "blank" => "blank".into(),
        "n" => format!("n:{}", v.parse::<f64>().expect("recorded number")),
        "b" => format!("b:{}", if v == "1" { "TRUE" } else { "FALSE" }),
        k => format!("{k}:{v}"),
    }
}

fn agree(engine: &CellValue, kind: &str, v: &str) -> bool {
    match (engine, kind) {
        (CellValue::Number(a), "n") => {
            sheet_conformance::recalc::numbers_agree(*a, v.parse().expect("number"))
        }
        (CellValue::Empty, "blank") => true,
        _ => token(engine) == excel_token(kind, v),
    }
}

#[test]
fn excel_calcmodel_lane__feat__sheet_calc_model() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("oracle/excel");
    let recorded = std::fs::read_to_string(dir.join("recorded/calcmodel.tsv")).expect("recorded");
    let mut listed: BTreeMap<(String, String), (String, String, String)> = BTreeMap::new();
    for line in std::fs::read_to_string(dir.join("calcmodel-divergences.tsv"))
        .expect("divergences")
        .lines()
    {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let c: Vec<&str> = line.split('\t').collect();
        assert_eq!(c.len(), 6, "bad divergence row {line:?}");
        let prev = listed.insert(
            (c[0].into(), c[1].into()),
            (c[3].into(), c[4].into(), c[5].into()),
        );
        assert!(prev.is_none(), "duplicate divergence {line:?}");
        assert!(
            matches!(c[2], "defect" | "diverges"),
            "kind must be defect|diverges: {line:?}"
        );
    }
    let cases = load_cases();
    let mut engines: BTreeMap<String, (usize, Engine)> = BTreeMap::new();
    let mut problems = Vec::new();
    let (mut agreed, mut total) = (0, 0);
    let mut seen = Vec::new();
    for line in recorded.lines() {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let c: Vec<&str> = line.split('\t').collect();
        assert_eq!(c.len(), 5, "bad recorded row {line:?}");
        let (id, fp, cell, kind, v) = (c[0], c[1], c[2], c[3], c[4]);
        let Some(pos) = cases.iter().position(|(cid, _)| cid == id) else {
            problems.push(format!("{id}: recorded but no longer a case"));
            continue;
        };
        let case = &cases[pos].1;
        if fnv1a(&case.lines.join("\n")) != fp {
            problems.push(format!(
                "{id}: STALE — the case changed since it was recorded"
            ));
            continue;
        }
        let entry = engines
            .entry(id.to_string())
            .or_insert_with(|| (pos, run_case(pos + 1, case)));
        let (sheet_name, a) = split_sheet(cell);
        let model = entry.1.model();
        let sheet = if sheet_name.is_empty() {
            0
        } else {
            model.sheet_id(&sheet_name).expect("probe sheet")
        };
        let got = value(&entry.1, sheet, &a);
        total += 1;
        seen.push((id.to_string(), cell.to_string()));
        let key = (id.to_string(), cell.to_string());
        let ok = agree(&got, kind, v);
        match (ok, listed.get(&key)) {
            (true, None) => agreed += 1,
            (true, Some(_)) => problems.push(format!(
                "{id} {cell}: listed as a divergence but now AGREES ({}) — delete the row",
                token(&got)
            )),
            (false, None) => problems.push(format!(
                "{id}\t{cell}\t<kind>\t{}\t{}\t<reason>  (UNLISTED disagreement)",
                token(&got),
                excel_token(kind, v)
            )),
            (false, Some((eng, exc, _))) => {
                if *eng != token(&got) || *exc != excel_token(kind, v) {
                    problems.push(format!(
                        "{id} {cell}: listed values are stale — engine {} Excel {}",
                        token(&got),
                        excel_token(kind, v)
                    ));
                }
            }
        }
    }
    for key in listed.keys() {
        if !seen.contains(key) {
            problems.push(format!("{key:?}: listed but not recorded"));
        }
    }
    println!(
        "calcmodel lane: {agreed}/{total} cells agree with Excel, {} listed divergence(s)",
        listed.len()
    );
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

// ---- manual calculation and precision as displayed ----------------------------

#[test]
fn manual_calculation_waits_for_calculate__feat__sheet_calc_model() {
    let mut e = engine_on(&["S", "T"]);
    enter(&mut e, 0, "A1", "1");
    enter(&mut e, 0, "B1", "=A1*2");
    enter(&mut e, 1, "B1", "=S!A1*3");
    e.set_calc_mode(sheet_core::CalcMode::Manual);
    assert!(!e.is_calc_pending());
    enter(&mut e, 0, "A1", "5");
    // Nothing recalculated: the dependents are pending.
    assert_eq!(value(&e, 0, "B1"), n(2.0));
    assert_eq!(value(&e, 1, "B1"), n(3.0));
    assert!(e.is_calc_pending());
    // A formula entered in manual mode is calculated itself (Excel).
    enter(&mut e, 0, "C1", "=A1+1");
    assert_eq!(value(&e, 0, "C1"), n(6.0));
    // Calculate Sheet: this sheet only.
    e.calculate_sheet(0);
    assert_eq!(value(&e, 0, "B1"), n(10.0));
    assert_eq!(value(&e, 1, "B1"), n(3.0));
    assert!(e.is_calc_pending());
    // Calculate Now: everything.
    e.calculate_now();
    assert_eq!(value(&e, 1, "B1"), n(15.0));
    assert!(!e.is_calc_pending());
    // Back to automatic: what is pending calculates.
    enter(&mut e, 0, "A1", "7");
    e.set_calc_mode(sheet_core::CalcMode::Auto);
    assert_eq!(value(&e, 0, "B1"), n(14.0));
    assert!(!e.is_calc_pending());
}

#[test]
fn calc_pr_round_trips_mode_and_precision__feat__sheet_calc_model() {
    use sheet_js::core::SheetSession;
    let mut s = SheetSession::new();
    s.set_cell(0, 0, 0, "1").unwrap();
    s.set_cell(0, 0, 1, "=A1*2").unwrap();
    s.set_calc_mode("manual").unwrap();
    s.set_full_precision(false);
    s.set_cell(0, 0, 0, "4").unwrap();
    assert_eq!(s.get_cell_display(0, 0, 1), "2", "manual: not recalculated");
    assert!(s.is_calc_pending());
    let info = s.calc_settings();
    assert_eq!(info.calc_mode, "manual");
    assert!(!info.full_precision);
    assert!(info.calc_pending);
    let bytes = s.save_xlsx().unwrap();
    let mut back = SheetSession::load_xlsx(&bytes).unwrap();
    let info = back.calc_settings();
    assert_eq!(info.calc_mode, "manual");
    assert!(!info.full_precision);
    // A load calculates whatever the mode; edits after it wait.
    assert_eq!(back.get_cell_display(0, 0, 1), "8");
    back.set_cell(0, 0, 0, "10").unwrap();
    assert_eq!(back.get_cell_display(0, 0, 1), "8");
    back.calculate_now();
    assert_eq!(back.get_cell_display(0, 0, 1), "20");
    assert!(back.set_calc_mode("sometimes").is_err());
}

#[test]
fn precision_as_displayed_rounds_entered_numbers__feat__sheet_calc_model() {
    use sheet_js::core::SheetSession;
    let mut s = SheetSession::new();
    s.set_full_precision(false);
    // A typed currency keeps 2 decimals: stored as shown.
    s.set_cell(0, 0, 0, "$1.2345").unwrap();
    assert_eq!(s.get_cell_input(0, 0, 0), "1.23");
    s.set_cell(0, 0, 1, "=A1*100").unwrap();
    assert_eq!(s.get_cell_display(0, 0, 1), "123");
    // General keeps the whole number.
    s.set_cell(0, 1, 0, "1.2345").unwrap();
    assert_eq!(s.get_cell_input(0, 1, 0), "1.2345");
}

#[test]
fn a_legacy_formula_reads_with_explicit_at__feat__sheet_calc_model() {
    // What Excel 365 shows when it opens a formula stored without the
    // dynamic-array mark: `@` wherever the old evaluation intersected.
    let mut m = SheetModel::new();
    m.add_sheet("S");
    for (text, shown) in [
        ("A1:A3", "@A1:A3"),
        ("A1:A3*2", "@A1:A3*2"),
        ("ABS(A1:A3)", "ABS(@A1:A3)"),
        ("SUM(A1:A3)", "SUM(A1:A3)"),
        ("SUM(A1:A3*2)", "SUM(@A1:A3*2)"),
        ("SUMPRODUCT(A1:A3*2)", "SUMPRODUCT(A1:A3*2)"),
        ("SUMPRODUCT(ABS(A1:A3))", "SUMPRODUCT(ABS(A1:A3))"),
        (
            "VLOOKUP(A1:A3,B1:C3,2,FALSE)",
            "VLOOKUP(@A1:A3,B1:C3,2,FALSE)",
        ),
        ("IF(A1:A3>1,\"y\",\"n\")", "IF(@A1:A3>1,\"y\",\"n\")"),
        ("SEQUENCE(3)", "SEQUENCE(3)"),
    ] {
        let ctx = Ctx {
            model: &m,
            sheet: 0,
        };
        let mut f = sheet_parser::parse(text, &ctx).unwrap();
        sheet_calc::legacy::mark_implicit_intersections(&m, &mut f.root);
        assert_eq!(sheet_parser::print(&f, 0, &ctx), shown, "{text}");
    }
}
