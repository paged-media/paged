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

//! The effected-geometry cache: one computation per distinct (source
//! outline, vector entries, context). The key is a 64-bit hash of all
//! three; the store is per thread (the renderer, the canvas worker and
//! export each build on one) and bounded.

use std::cell::RefCell;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use paged_model::effect_stack::EffectEntry;

use crate::{Context, Effected, Shape};

/// Entries kept before the store is emptied and refilled.
const CAPACITY: usize = 1024;

thread_local! {
    static STORE: RefCell<HashMap<u64, Arc<Effected>>> = RefCell::new(HashMap::new());
    static STATS: RefCell<(u64, u64)> = const { RefCell::new((0, 0)) };
}

fn hash_f64(h: &mut impl Hasher, v: f64) {
    v.to_bits().hash(h);
}

/// The key for `sources` under `entries` and `ctx`.
pub fn key(sources: &[&Shape], entries: &[&EffectEntry], ctx: &Context) -> u64 {
    // FNV-style determinism: `DefaultHasher::new()` is keyed with fixed
    // keys, so one input hashes alike in every run.
    let mut h = std::collections::hash_map::DefaultHasher::new();
    sources.len().hash(&mut h);
    for s in sources {
        s.contours.len().hash(&mut h);
        for c in &s.contours {
            c.closed.hash(&mut h);
            c.nodes.len().hash(&mut h);
            for n in &c.nodes {
                for p in [n.p, n.l, n.r] {
                    hash_f64(&mut h, p.x);
                    hash_f64(&mut h, p.y);
                }
            }
        }
    }
    for e in entries {
        // The parameters' Debug form names every field and value.
        format!("{:?}", e.effect).hash(&mut h);
    }
    format!("{:?}", ctx.stroke).hash(&mut h);
    h.finish()
}

/// The cached value for `key`, computing it with `make` on a miss.
pub fn get_or_insert(key: u64, make: impl FnOnce() -> Effected) -> Arc<Effected> {
    if let Some(hit) = STORE.with(|s| s.borrow().get(&key).cloned()) {
        STATS.with(|s| s.borrow_mut().0 += 1);
        return hit;
    }
    STATS.with(|s| s.borrow_mut().1 += 1);
    let value = Arc::new(make());
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        if s.len() >= CAPACITY {
            s.clear();
        }
        s.insert(key, value.clone());
    });
    value
}

/// `(hits, misses)` on this thread since it started.
pub fn stats() -> (u64, u64) {
    STATS.with(|s| *s.borrow())
}

/// Empty this thread's store.
pub fn clear() {
    STORE.with(|s| s.borrow_mut().clear());
}
