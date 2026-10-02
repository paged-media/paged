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

// TRENDED, NOT GATED. The budgets beside this file count door calls and
// assert on the count; this prints how long the same walks take, and
// asserts nothing — a duration moves with the machine.
//
// READ THESE WITH ONE CAVEAT IN FRONT: this is the HEADLESS host, where
// a door call is a synchronous wasm call in the same thread. In the
// editor every one of them is a message to the engine worker and a
// reply back. So the numbers here are the FLOOR of what a walk costs —
// the engine's share — and the count in the budget is what multiplies
// the part this cannot see.
//
// It also gives this package's `bench` script something to run:
// `vitest bench` exits 1 on a package with no bench file, which took
// the root `pnpm bench` down with it.

import { bench, describe } from "vitest";

import { blendLinks, leafIdsOf, selectSameMatches } from "../../src";
import { buildLinkedWorkload } from "./workload";

// Built once, at module load. With the build in a `beforeAll`, every
// bench came back with ZERO samples (vitest 2.1.9) — and a table of
// zeroes exits 0, so it would have passed for a result.
const w = await buildLinkedWorkload();

describe("the document walks, over the 1 403-leaf linked workload", () => {
  bench("document.tree() — one read of the whole scene tree", async () => {
    leafIdsOf(await w.h.host.document.tree());
  });

  bench("link discovery — blendLinks: 1 tree + 1 403 getMetadata", async () => {
    await blendLinks(w.h.host, w.linked.blend!.records[24]);
  });

  bench("select same fill — 1 tree + 1 404 elementProperties", async () => {
    await selectSameMatches(w.h.host, w.plain[0]!, "fill");
  });
});
