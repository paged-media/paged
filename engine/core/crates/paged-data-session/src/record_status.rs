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

//! Per-record status (editor ADR 291, the Data panel's row colours): for one
//! query, which records are new in the data, which changed and how many of
//! the placed ones are gone, all since the document was last written from
//! the query (the applied snapshot of [`crate::core::DataSession`]), and
//! which records the document shows.
//!
//! Every index here is a ROW of a result as delivered (the order the Data
//! panel's grid and a Data Merge number records in).
//!
//! Record identity is the row diff's ([`crate::review`]): the key fields the
//! caller names (the Sync panel's choice), else the first column whose
//! values are present and unique in both the snapshot and the current
//! result (an `id`, a `sku`, …), else the whole row. With the whole row as
//! the key a record that changed is a different record: it shows as one
//! removed and one added, and `changed` stays empty.
//!
//! Which records are placed: every record of a query a TABLE binding reads
//! (a table shows one row per record); the record a lower resolves a
//! single-record binding at (variable, image, barcode, visibility, property:
//! the first record, which is the first row of a result whose order is
//! defined and the first row in the stabilized order otherwise, as
//! `ResolutionEngine::record_row` numbers it, unless the host names it as
//! filled at a record of its own); and the per-record instances the host
//! reports (a merged record's frames, a record-flow frame's records, read
//! from the labels of the page items that show them; a design a record was
//! dropped on). Instances are rows of the snapshot; each is carried to its
//! row in the current result by its key, so a placed record keeps its
//! identity across a refresh that added, removed or reordered rows.
//!
//! The comparison runs on [`AppliedSnapshot`]s, hashes of each record's key
//! and content, which is also the form a document saves (the payload's
//! `applied`): a reopened document compares as the session that wrote it
//! did. A document also saves the values of that result
//! ([`AppliedValues`], the payload's `applied_values`): reopened, the session
//! holds the result again and keys it as asked, as before the save, and the
//! row diff shows the values before. A document saved without them (before
//! they were saved) keeps only the hashes, which cannot be keyed again: read
//! with another key than its own they match by the whole row.

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use data_core::{Binding, BindingDef, QueryId, RecordSet, Schema, Value};

use crate::review::default_key;

/// What the caller adds to the session's own knowledge.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordStatusOptions {
    /// The key fields records are matched by; `None` (or empty) is the
    /// default key (see the module docs).
    #[serde(default)]
    pub key: Option<Vec<String>>,
    /// Records the document shows one by one, as indices into the result
    /// the document was written from (merged records, record-flow frames).
    #[serde(default)]
    pub instances: Vec<usize>,
    /// Single-record bindings resolved at a record of their own (a record
    /// dropped on a design), not at the first: the host reports that record
    /// among the `instances`.
    #[serde(default)]
    pub own_record: Vec<String>,
}

/// One query's per-record status. Every index is into the CURRENT result.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordStatus {
    pub query: String,
    /// The key fields used (empty = the whole row is its identity).
    pub key: Vec<String>,
    /// Nothing was written from this query yet in this session: no record
    /// is new, changed or removed (there is nothing to compare with), and
    /// instances are taken as indices into the current result.
    pub baseline: bool,
    /// Records new in the data, ascending.
    pub added: Vec<usize>,
    /// Records whose values changed, ascending (never with the whole row as
    /// the key).
    pub changed: Vec<usize>,
    /// How many placed records are gone from the data.
    pub removed: usize,
    /// Records whose content is in the document, ascending.
    pub placed: Vec<usize>,
    /// The record the single-record bindings over the query show (record 0
    /// as a lower resolves them), when one reads the query and it exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first: Option<usize>,
    /// Each of the options' `instances`, in order: the record's index in the
    /// current result, or `None` when it is gone.
    pub instances: Vec<Option<usize>>,
}

/// A query's result as the document was last written from it, in the form
/// a document stores (the session payload's `applied`): no values, only
/// what the status compares. Per record, in result order, a 64-bit FNV-1a
/// hash of its key and one of its content (every cell, typed: `1` and `"1"`
/// differ), as one string of 32 hex digits; with the whole row as the key
/// the two are the same and the string is the 16 digits of the content.
/// About 35 bytes per record in the saved JSON, whatever the row's width.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppliedSnapshot {
    /// The key fields the records were identified by (empty = the whole
    /// row).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key: Vec<String>,
    /// Each record's key and content hashes (see the type's docs).
    #[serde(default)]
    pub rows: Vec<String>,
    /// The record a single-record binding shows in the stabilized order (a
    /// query that does not define its row order), when there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first: Option<usize>,
}

impl AppliedSnapshot {
    /// The snapshot of `rs`, its records identified by `key` (empty = the
    /// whole row).
    pub fn of(rs: &RecordSet, key: &[String]) -> Self {
        let cols: Vec<Option<usize>> = key.iter().map(|k| rs.schema.index_of(k)).collect();
        let rows = (0..rs.row_count)
            .map(|r| {
                let content = row_hash(rs, r, (0..rs.columns.len()).map(Some));
                if key.is_empty() {
                    format!("{content:016x}")
                } else {
                    let k = row_hash(rs, r, cols.iter().copied());
                    format!("{k:016x}{content:016x}")
                }
            })
            .collect();
        AppliedSnapshot {
            key: key.to_vec(),
            rows,
            first: data_query::first_stable_row(rs),
        }
    }

    /// The snapshot a document saves of `rs`: keyed by the first column
    /// whose values are present and unique in it, else the whole row.
    pub fn saved(rs: &RecordSet) -> Self {
        Self::of(rs, &default_key(rs, rs))
    }

    /// The snapshot as [`record_status`] reads it with `key`: itself when
    /// that is the key it was made with, else with the whole row as the key
    /// (a saved snapshot cannot be keyed again: it holds no values).
    fn keyed(&self, key: &[String]) -> AppliedSnapshot {
        if key == self.key.as_slice() || self.key.is_empty() {
            return self.clone();
        }
        AppliedSnapshot {
            key: Vec::new(),
            rows: self
                .rows
                .iter()
                .map(|r| r.get(16..).unwrap_or(r).to_string())
                .collect(),
            first: self.first,
        }
    }

    /// Each record's (key, content) hashes; a malformed entry reads as 0.
    fn hashes(&self) -> Vec<(u64, u64)> {
        let hex = |s: &str| u64::from_str_radix(s, 16).unwrap_or(0);
        self.rows
            .iter()
            .map(|r| match (r.get(..16), r.get(16..)) {
                (Some(k), Some(c)) if !c.is_empty() => (hex(k), hex(c)),
                _ => (hex(r), hex(r)),
            })
            .collect()
    }
}

/// A query's result as the document was last written from it, WITH its
/// values: the "before" of the Sync panel's row diff
/// ([`crate::review::row_diffs`]) after a reopen (the payload's
/// `applied_values`). Columnar like [`RecordSet`]: the schema, then per field
/// one array of cells, each cell in a compact JSON form that reads back to
/// the same typed value (so a reopened document hashes as the session that
/// wrote it): `null`, a boolean, a finite number, a string for text, and an
/// object for the rest: `{"d": days}` a date, `{"ms": millis}` a date-time,
/// `{"n": "NaN" | "inf" | "-inf" | "-0"}` a number JSON cannot spell,
/// `{"x": hex}` bytes, `{"e": code}` an error value.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AppliedValues {
    pub schema: Schema,
    #[serde(default)]
    pub columns: Vec<Vec<serde_json::Value>>,
}

impl AppliedValues {
    /// The saved form of `rs`.
    pub fn of(rs: &RecordSet) -> Self {
        AppliedValues {
            schema: rs.schema.clone(),
            columns: rs
                .columns
                .iter()
                .map(|c| c.iter().map(cell_json).collect())
                .collect(),
        }
    }

    /// The result back, or `None` when the saved form is malformed (a
    /// column of another length, a cell that is no cell): the document then
    /// keeps only the hash snapshot, as one written before values were.
    pub fn to_record_set(&self) -> Option<RecordSet> {
        let columns: Option<Vec<Vec<Value>>> = self
            .columns
            .iter()
            .map(|c| c.iter().map(json_cell).collect())
            .collect();
        RecordSet::new(self.schema.clone(), columns?).ok()
    }
}

fn cell_json(v: &Value) -> serde_json::Value {
    use serde_json::{json, Value as J};
    match v {
        Value::Null => J::Null,
        Value::Bool(b) => J::Bool(*b),
        Value::Number(n) => {
            if n.is_nan() {
                json!({ "n": "NaN" })
            } else if n.is_infinite() {
                json!({ "n": if *n > 0.0 { "inf" } else { "-inf" } })
            } else if *n == 0.0 && n.is_sign_negative() {
                json!({ "n": "-0" })
            } else {
                serde_json::Number::from_f64(*n).map_or(J::Null, J::Number)
            }
        }
        Value::Text(t) => J::String(t.to_string()),
        Value::Date(d) => json!({ "d": d }),
        Value::DateTime(ms) => json!({ "ms": ms }),
        Value::Bytes(b) => {
            let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
            json!({ "x": hex })
        }
        Value::Error(e) => json!({ "e": e }),
    }
}

fn json_cell(j: &serde_json::Value) -> Option<Value> {
    use serde_json::Value as J;
    // A number from a JS host may arrive as an integer or a float.
    let int = |j: &J| j.as_i64().or_else(|| j.as_f64().map(|f| f as i64));
    Some(match j {
        J::Null => Value::Null,
        J::Bool(b) => Value::Bool(*b),
        J::Number(n) => Value::Number(n.as_f64()?),
        J::String(s) => Value::text(s.as_str()),
        J::Object(o) => {
            if let Some(n) = o.get("n") {
                Value::Number(match n.as_str()? {
                    "NaN" => f64::NAN,
                    "inf" => f64::INFINITY,
                    "-inf" => f64::NEG_INFINITY,
                    "-0" => -0.0,
                    _ => return None,
                })
            } else if let Some(d) = o.get("d") {
                Value::Date(i32::try_from(int(d)?).ok()?)
            } else if let Some(ms) = o.get("ms") {
                Value::DateTime(int(ms)?)
            } else if let Some(x) = o.get("x") {
                let x = x.as_str()?;
                if x.len() % 2 != 0 {
                    return None;
                }
                let bytes: Option<Vec<u8>> = (0..x.len())
                    .step_by(2)
                    .map(|i| u8::from_str_radix(x.get(i..i + 2)?, 16).ok())
                    .collect();
                Value::Bytes(bytes?)
            } else {
                Value::Error(serde_json::from_value(o.get("e")?.clone()).ok()?)
            }
        }
        J::Array(_) => return None,
    })
}

/// The key a saved snapshot is read with against `current`: the caller's,
/// else the saved one while it still identifies `current`'s records (every
/// key field present and, together, unique), else the whole row.
fn saved_key(
    saved: &AppliedSnapshot,
    current: &RecordSet,
    asked: Option<&[String]>,
) -> Vec<String> {
    if let Some(k) = asked.filter(|k| !k.is_empty()) {
        return k.to_vec();
    }
    let cols: Option<Vec<usize>> = saved
        .key
        .iter()
        .map(|k| current.schema.index_of(k))
        .collect();
    let Some(cols) = cols.filter(|c| !c.is_empty()) else {
        return Vec::new();
    };
    let mut seen = HashSet::with_capacity(current.row_count);
    let unique = (0..current.row_count).all(|r| {
        cols.iter()
            .all(|&c| !matches!(current.value(r, c), None | Some(Value::Null)))
            && seen.insert(row_hash(current, r, cols.iter().copied().map(Some)))
    });
    if unique {
        saved.key.clone()
    } else {
        Vec::new()
    }
}

/// The snapshot [`record_status`] reads for a query: the applied result held
/// in memory (keyed by the caller's key, else the default key over it and
/// `current`), else the one a document saved, read with the caller's key,
/// else its own while it still identifies `current`'s records, else the
/// whole row.
pub fn applied_for(
    in_memory: Option<&RecordSet>,
    saved: Option<&AppliedSnapshot>,
    current: &RecordSet,
    asked: Option<&[String]>,
) -> Option<AppliedSnapshot> {
    if let Some(old) = in_memory {
        let key = match asked {
            Some(k) if !k.is_empty() => k.to_vec(),
            _ => default_key(old, current),
        };
        return Some(AppliedSnapshot::of(old, &key));
    }
    let saved = saved?;
    Some(saved.keyed(&saved_key(saved, current, asked)))
}

/// FNV-1a over the typed cells `cols` of row `r` (a missing column is an
/// empty cell). Stable across builds and platforms: documents store it.
fn row_hash(rs: &RecordSet, r: usize, cols: impl Iterator<Item = Option<usize>>) -> u64 {
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |bytes: &[u8]| {
        for &b in bytes {
            h ^= u64::from(b);
            h = h.wrapping_mul(PRIME);
        }
    };
    for c in cols {
        match c.and_then(|c| rs.value(r, c)) {
            None => eat(b"-"),
            Some(Value::Null) => eat(b"0"),
            Some(Value::Bool(b)) => eat(if *b { b"1t" } else { b"1f" }),
            Some(Value::Number(n)) => {
                eat(b"2");
                eat(&n.to_bits().to_le_bytes());
            }
            Some(Value::Text(t)) => {
                eat(b"3");
                eat(&(t.len() as u64).to_le_bytes());
                eat(t.as_bytes());
            }
            Some(Value::Date(d)) => {
                eat(b"4");
                eat(&d.to_le_bytes());
            }
            Some(Value::DateTime(ms)) => {
                eat(b"5");
                eat(&ms.to_le_bytes());
            }
            Some(Value::Bytes(b)) => {
                eat(b"6");
                eat(&(b.len() as u64).to_le_bytes());
                eat(b);
            }
            Some(Value::Error(e)) => {
                eat(b"7");
                eat(e.code().as_bytes());
            }
        }
        eat(&[0x1f]);
    }
    h
}

/// The per-record status of `query`: `applied` is the result the document
/// was written from (none before the first write), keyed by the key records
/// are matched with ([`applied_for`] chooses it), `current` the result now;
/// `order_defined`: the query defines its row order (see the module docs).
pub fn record_status(
    query: &QueryId,
    order_defined: bool,
    applied: Option<&AppliedSnapshot>,
    current: &RecordSet,
    bindings: &[BindingDef],
    opts: &RecordStatusOptions,
) -> RecordStatus {
    let mut table = false;
    let mut single = false;
    for b in bindings.iter().filter(|b| b.binding.query() == Some(query)) {
        match b.binding {
            Binding::Table { .. } => table = true,
            // A flow places what its frames hold: the host reports those.
            Binding::RecordFlow { .. } | Binding::Rule { .. } => {}
            _ if opts
                .own_record
                .iter()
                .any(|id| id.as_str() == b.id.as_str()) => {}
            _ => single = true,
        }
    }

    let Some(old) = applied else {
        // Nothing to compare with: the document shows the current result.
        let n = current.row_count;
        let mut placed: BTreeSet<usize> = BTreeSet::new();
        if table {
            placed.extend(0..n);
        }
        let first = single.then(|| first_row(current, order_defined)).flatten();
        placed.extend(first);
        let instances: Vec<Option<usize>> = opts
            .instances
            .iter()
            .map(|&i| (i < n).then_some(i))
            .collect();
        placed.extend(instances.iter().flatten());
        return RecordStatus {
            query: query.to_string(),
            baseline: true,
            placed: placed.into_iter().collect(),
            first,
            instances,
            ..RecordStatus::default()
        };
    };

    let key = old.key.clone();
    let old_rows = old.hashes();
    let new_rows = AppliedSnapshot::of(current, &key).hashes();
    let old_count = old_rows.len();

    // The diff: a record whose key the snapshot lacks is new; one whose key
    // it has, with another content fingerprint, changed.
    let old_content: HashMap<u64, u64> = old_rows.iter().copied().collect();
    let mut added = Vec::new();
    let mut changed = Vec::new();
    for (i, (k, c)) in new_rows.iter().enumerate() {
        match old_content.get(k) {
            None => added.push(i),
            Some(oc) if oc != c => changed.push(i),
            Some(_) => {}
        }
    }

    // Old index → new index by key. Rows sharing a key (possible only with
    // the whole row as the key) pair up in order.
    let mut by_key: HashMap<u64, VecDeque<usize>> = HashMap::new();
    for (i, (k, _)) in new_rows.iter().enumerate() {
        by_key.entry(*k).or_default().push_back(i);
    }
    let to_new: Vec<Option<usize>> = old_rows
        .iter()
        .map(|(k, _)| by_key.get_mut(k).and_then(VecDeque::pop_front))
        .collect();
    let carry = |i: usize| to_new.get(i).copied().flatten();

    let mut placed_old: BTreeSet<usize> = BTreeSet::new();
    if table {
        placed_old.extend(0..old_count);
    }
    let first_old = match (single, old_count, order_defined) {
        (false, _, _) | (_, 0, _) => None,
        (_, _, true) => Some(0),
        (_, _, false) => old.first,
    };
    placed_old.extend(first_old);
    placed_old.extend(opts.instances.iter().filter(|&&i| i < old_count));

    let mut placed: BTreeSet<usize> = BTreeSet::new();
    let mut removed = 0;
    for &i in &placed_old {
        match carry(i) {
            Some(n) => {
                placed.insert(n);
            }
            None => removed += 1,
        }
    }

    RecordStatus {
        query: query.to_string(),
        key,
        baseline: false,
        added,
        changed,
        removed,
        placed: placed.into_iter().collect(),
        first: first_old.and_then(carry),
        instances: opts.instances.iter().map(|&i| carry(i)).collect(),
    }
}

/// The row a single-record binding resolves at by default: record 0.
fn first_row(rs: &RecordSet, order_defined: bool) -> Option<usize> {
    if rs.row_count == 0 {
        None
    } else if order_defined {
        Some(0)
    } else {
        data_query::first_stable_row(rs)
    }
}
