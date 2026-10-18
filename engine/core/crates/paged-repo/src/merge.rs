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

use std::collections::{BTreeSet, VecDeque};

use crate::store::read;
use crate::{decode, Commit, Error, Hash, Kind, Store, Tree, TreeEntry};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    Added,
    Removed,
    Modified,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    pub path: String,
    pub kind: ChangeKind,
}

pub(crate) fn read_commit(store: &impl Store, hash: &Hash) -> Result<Commit, Error> {
    decode(&read(store, Kind::Commit, hash)?)
}

/// The parts that differ between two trees, in path order.
pub fn diff_trees(a: &Tree, b: &Tree) -> Vec<Change> {
    let paths: BTreeSet<&str> = a
        .entries
        .iter()
        .chain(&b.entries)
        .map(|e| e.path.as_str())
        .collect();
    paths
        .into_iter()
        .filter_map(|p| {
            let kind = match (a.get(p), b.get(p)) {
                (None, Some(_)) => ChangeKind::Added,
                (Some(_), None) => ChangeKind::Removed,
                (Some(x), Some(y)) if x != y => ChangeKind::Modified,
                _ => return None,
            };
            Some(Change {
                path: p.to_string(),
                kind,
            })
        })
        .collect()
}

fn ancestors(store: &impl Store, head: Hash) -> Result<BTreeSet<Hash>, Error> {
    let mut seen = BTreeSet::new();
    let mut queue = VecDeque::from([head]);
    while let Some(h) = queue.pop_front() {
        if seen.insert(h) {
            queue.extend(read_commit(store, &h)?.parents);
        }
    }
    Ok(seen)
}

/// Is `a` reachable from `b` (or equal to it)?
pub(crate) fn is_ancestor(store: &impl Store, a: Hash, b: Hash) -> Result<bool, Error> {
    Ok(ancestors(store, b)?.contains(&a))
}

/// The nearest commit both heads descend from, found breadth-first from `b`.
pub fn merge_base(store: &impl Store, a: Hash, b: Hash) -> Result<Option<Hash>, Error> {
    let of_a = ancestors(store, a)?;
    let mut seen = BTreeSet::new();
    let mut queue = VecDeque::from([b]);
    while let Some(h) = queue.pop_front() {
        if of_a.contains(&h) {
            return Ok(Some(h));
        }
        if seen.insert(h) {
            queue.extend(read_commit(store, &h)?.parents);
        }
    }
    Ok(None)
}

/// A part-level three-way merge. A part changed on one side takes that side; a
/// part changed differently on both sides is a conflict, returned by path.
pub fn merge_trees(base: &Tree, ours: &Tree, theirs: &Tree) -> Result<Tree, Vec<String>> {
    let paths: BTreeSet<&str> = base
        .entries
        .iter()
        .chain(&ours.entries)
        .chain(&theirs.entries)
        .map(|e| e.path.as_str())
        .collect();
    let mut entries: Vec<TreeEntry> = Vec::new();
    let mut conflicts = Vec::new();
    for p in paths {
        let (b, o, t) = (base.get(p), ours.get(p), theirs.get(p));
        let pick = if o == t || t == b {
            o
        } else if o == b {
            t
        } else {
            conflicts.push(p.to_string());
            continue;
        };
        entries.extend(pick.cloned());
    }
    if conflicts.is_empty() {
        Ok(Tree { v: 1, entries })
    } else {
        Err(conflicts)
    }
}
