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

// Compile-time proof that the machines' output feeds the engine wire
// types directly — the reason `@paged-media/plugin-api` is a real
// (type-only) dependency of this package. If a protocol change breaks
// structural compatibility, `pnpm typecheck` fails HERE, in the
// plugin repo, hours after the change — the §12.3 "loud during
// dogfooding" property.

import type { PathAnchorSpec } from "@paged-media/plugin-api";
import type { AnchorTriple } from "@paged-media/draw-geometry";

type Extends<A, B> = A extends B ? true : false;
type Assert<T extends true> = T;

/** `AnchorTriple` assigns directly to `PathAnchorSpec` (insertPath,
 *  pathPointInsert anchors). */
export type AnchorTripleFeedsWire = Assert<Extends<AnchorTriple, PathAnchorSpec>>;
