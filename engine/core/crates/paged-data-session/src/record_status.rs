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

use std::collections::{BTreeSet, HashMap, VecDeque};

use serde::{Deserialize, Serialize};

use data_bind::diff;
use data_core::{Binding, BindingDef, QueryId, RecordSet};

use crate::review::{default_key, key_index};

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

/// The per-record status of `query`: `applied` is the result the document
/// was written from (none before the first write), `current` the result now;
/// `order_defined`: the query defines its row order (see the module docs).
pub fn record_status(
    query: &QueryId,
    order_defined: bool,
    applied: Option<&RecordSet>,
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

    let key = match &opts.key {
        Some(k) if !k.is_empty() => k.clone(),
        _ => default_key(old, current),
    };
    let delta = diff(old, current, &key);

    // Old index → new index by key. Rows sharing a key (possible only with
    // the whole row as the key) pair up in order.
    let new_keys = key_index(current, &key);
    let mut by_key: HashMap<&str, VecDeque<usize>> = HashMap::new();
    for (i, k) in new_keys.iter().enumerate() {
        by_key.entry(k.as_str()).or_default().push_back(i);
    }
    let to_new: Vec<Option<usize>> = key_index(old, &key)
        .iter()
        .map(|k| by_key.get_mut(k.as_str()).and_then(VecDeque::pop_front))
        .collect();
    let carry = |i: usize| to_new.get(i).copied().flatten();

    let mut placed_old: BTreeSet<usize> = BTreeSet::new();
    if table {
        placed_old.extend(0..old.row_count);
    }
    let first_old = single.then(|| first_row(old, order_defined)).flatten();
    placed_old.extend(first_old);
    placed_old.extend(opts.instances.iter().filter(|&&i| i < old.row_count));

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

    let mut added = delta.inserted;
    added.sort_unstable();
    let mut changed = delta.updated;
    changed.sort_unstable();
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
