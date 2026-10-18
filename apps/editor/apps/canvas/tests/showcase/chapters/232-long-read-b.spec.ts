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

// Ch.17 The Long Read — p107–108, the bake spread. The live-versus-
// baked asymmetry closes the chapter: the bake's receipt is printed as
// reported and its registry row deliberately unclaimed.

import { annualChapter } from "../chapter";
import { p } from "../names-annual";

import { build as bake } from "../pages/230-long-read/05-bake";

// Continuation of 230-long-read — split for the in-chain per-op cost.
// The bake keeps its own spec because it must meet a HEALTHY web engine:
// the fragments page's card chain leaves a scene-layer refusal behind it,
// and a fresh browser per chapter is the cleanest way to guarantee the
// order that matters.
annualChapter({
  id: "232-long-read-b",
  title: "Ch.17 The Long Read - the bake",
  modules: [{ id: "lr-bake", pages: [p(107), p(108)], build: bake }],
});
