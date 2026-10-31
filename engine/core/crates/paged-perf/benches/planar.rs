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

//! Wall-clock of the planar arrangement (engine ADR 1019): Divide over
//! 20, 50 and 100 shapes (the `divide-many` oracle's inputs). Trended,
//! not gated; the gate is `tests/planar_budgets.rs`.

use criterion::{criterion_group, criterion_main, Criterion};
use paged_mutate::planar::build_arrangement;
use paged_perf::planar::divide;

fn bench_divide(c: &mut Criterion) {
    let mut group = c.benchmark_group("planar");
    group.sample_size(10);
    for n in [20, 50, 100] {
        let inputs = divide(n);
        group.bench_function(format!("divide_{n}"), |b| {
            b.iter(|| build_arrangement(&inputs).expect("arrangement"))
        });
    }
    group.finish();
}

criterion_group!(benches, bench_divide);
criterion_main!(benches);
