/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// Ch.8 — The Object (p47–p52): the page-item chapter. The z-order
// ladder on the opener, the transform matrix and corner sampler on the
// p48/49 spread, stroke anatomy, path topology + every planar verb,
// and grouping/nesting with the object-style battery.

// Ch.8 splits across TWO chapter specs on purpose: its ~400 wire ops
// at the measured in-chain cost (~3.8 s/op against the grown document)
// legitimately exceed one chapter budget, and the checkpoint chain
// absorbs a split with zero logic change. This half: opener + the
// transforms/corners spread.

import { annualChapter } from "../chapter";
import { p } from "../names-annual";

import { build as opener } from "../pages/150-object/01-opener";
import { build as transforms } from "../pages/150-object/02-transforms";

annualChapter({
  id: "150-object",
  title: "Ch.8 The Object — z-order, transforms, corners",
  modules: [
    { id: "ob-opener", pages: [p(47)], build: opener },
    { id: "ob-transforms", pages: [p(48), p(49)], build: transforms },
  ],
});
